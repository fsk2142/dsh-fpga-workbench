#!/usr/bin/env node
/**
 * 用**真 ModelSim** 验证 TB 模板的三个判定分支。
 *
 * ## 为什么必须真跑
 *
 * TB 模板的收尾逻辑决定了「仿真通过」这四个字可不可信。而它有个容易忽略的性质：
 *
 * - `err_cnt == 0` 在**一条检查都没做**时同样成立
 * - 于是空 TB（stimulus 还是 TODO）会打印 `ALL TESTS PASSED`
 * - 那正是最危险的假绿：什么都没验，却报通过
 *
 * 实测过：生成的骨架 TB 未填 stimulus 时，`vsim` 立刻报
 * `ALL TESTS PASSED (err_cnt=0)`、`Time: 0 ps` —— 时钟都没跑。
 *
 * 所以模板改成用 `check_cnt` 判「**做过检查** 且 没有失败」，
 * 空 TB 直接 `$fatal` 报 `TB INCOMPLETE`。
 *
 * 这段逻辑只有真编译真仿真才能验，字符串断言抓不到。
 *
 * ## 什么时候跳过
 *
 * 找不到 ModelSim / QuestaSim 时**明确 SKIP 并退 0**，不假装通过。
 * 路径可用 `DSH_MODELSIM_DIR` 指定（指向 `win64`/`linux_x86_64` 那种目录）。
 *
 * ## 用法
 *
 * ```
 * node tools/check-tb-template.mjs
 * DSH_MODELSIM_DIR=C:/modeltech64_2020.4/win64 node tools/check-tb-template.mjs
 * ```
 *
 * 退出码：0 = 全通过或跳过；1 = 有断言失败。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 找 ModelSim 的 bin 目录。
 *
 * 顺序：`DSH_MODELSIM_DIR` → 常见安装位置。都找不到返回 undefined（调用方跳过）。
 */
const findModelSim = () => {
  const explicit = process.env.DSH_MODELSIM_DIR;
  if (explicit !== undefined && explicit !== "" && existsSync(join(explicit, "vlog.exe"))) return explicit;
  if (explicit !== undefined && explicit !== "" && existsSync(join(explicit, "vlog"))) return explicit;

  const roots = [
    "C:/modeltech64_2020.4/win64",
    "C:/modeltech64_2020.4/win32",
    "C:/intelFPGA/20.1/modelsim_ase/win32aloem",
    "/opt/mentor/modelsim/bin",
    "/usr/local/bin"
  ];
  for (const dir of roots) {
    if (existsSync(join(dir, "vlog.exe")) || existsSync(join(dir, "vlog"))) return dir;
  }
  return undefined;
};

const MS = findModelSim();
if (MS === undefined) {
  console.log("SKIP：找不到 ModelSim/QuestaSim（可用 DSH_MODELSIM_DIR 指定）。");
  console.log("      这不代表 TB 模板没问题 —— 只是本机没有仿真器可跑。");
  process.exit(0);
}

const exe = (name) => {
  const withExt = join(MS, `${name}.exe`);
  return existsSync(withExt) ? withExt : join(MS, name);
};

console.log(`  仿真器：${MS}`);
const BASE = mkdtempSync(join(tmpdir(), "tb-template-"));

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${String(detail).slice(-400)}`);
  if (ok) pass += 1;
  else fail += 1;
};

/** 跑一个外部命令，返回退出码与合并输出。 */
const run = (cmd, args, cwd) => {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${String(error.stdout ?? "")}${String(error.stderr ?? "")}` };
  }
};

/**
 * 造一个工位：一个计数器 RTL + 用**真实模板**生成的 TB，编译进 work。
 *
 * @param tag - 沙箱子目录名。
 * @param tbBody - 替换 TB 里 `TODO: stimulus + checks` 的内容；undefined 表示不填。
 * @param moduleLevel - 插在 `logic clk` 之后的模块级声明/例化。
 */
const setup = (tag, tbBody, moduleLevel) => {
  const root = join(BASE, tag);
  mkdirSync(join(root, "rtl"), { recursive: true });
  mkdirSync(join(root, "verif"), { recursive: true });

  writeFileSync(
    join(root, "rtl", "counter.sv"),
    [
      "module counter (",
      "  input  logic clk,",
      "  input  logic rst_n,",
      "  output logic [7:0] q",
      ");",
      "  always_ff @(posedge clk or negedge rst_n)",
      "    if (!rst_n) q <= 8'h00;",
      "    else        q <= q + 8'h01;",
      "endmodule",
      ""
    ].join("\n"),
    "utf8"
  );

  const gen = run(process.execPath, [
    join(ROOT, "presets/fpga-workbench/tools/module/module-verif-new.mjs"),
    root,
    "counter",
    "--template",
    join(ROOT, "presets/fpga-workbench/templates/simulation/testbench/systemverilog_testbench.sv")
  ], root);
  if (gen.code !== 0) throw new Error(`生成 TB 失败：${gen.out}`);

  const tbPath = join(root, "verif", "tb_counter.sv");
  let tb = readFileSync(tbPath, "utf8");
  if (moduleLevel !== undefined) tb = tb.replace(/(\s*logic clk = 1'b0;)/u, `$1\n${moduleLevel}`);
  if (tbBody !== undefined) tb = tb.replace("    // TODO: stimulus + checks", tbBody);
  writeFileSync(tbPath, tb, "utf8");

  const vlib = run(exe("vlib"), ["work"], root);
  if (vlib.code !== 0) throw new Error(`vlib 失败：${vlib.out}`);

  const vlog = run(exe("vlog"), ["-sv", "rtl/counter.sv", "verif/tb_counter.sv"], root);
  if (vlog.code !== 0) throw new Error(`vlog 失败：${vlog.out}`);

  return root;
};

const simulate = (root) => run(exe("vsim"), ["-c", "-do", "run -all; quit -f", "tb_counter"], root);

try {
  // ── ① 空 TB 必须失败 ──
  console.log("=== ① 空 TB（没填 stimulus）→ 必须 FAIL ===");
  {
    const root = setup("empty", undefined, undefined);
    const result = simulate(root);
    check(/TB INCOMPLETE/u.test(result.out), "报 TB INCOMPLETE", result.out);
    // 这条是核心：空 TB 绝不能说通过。
    check(!/ALL TESTS PASSED/u.test(result.out), "**不再打印 ALL TESTS PASSED**", result.out);
    check(/check_cnt=0/u.test(result.out), "点明 check_cnt=0", result.out);
  }

  // ── ② 填了检查点且全过 → PASS ──
  console.log("\n=== ② 填了检查点且全过 → PASS ===");
  {
    const body = [
      "    rst_n = 1'b0;",
      "    repeat (2) @(posedge clk);",
      "    rst_n = 1'b1;",
      "    @(posedge clk); #1;",
      '    if (q !== 8\'h01) begin $error("q should be 1 after reset, got %0d", q); err_cnt++; end',
      "    check_cnt++;",
      "    @(posedge clk); #1;",
      '    if (q !== 8\'h02) begin $error("q should be 2, got %0d", q); err_cnt++; end',
      "    check_cnt++;"
    ].join("\n");
    const root = setup(
      "filled",
      body,
      ["  logic rst_n;", "  logic [7:0] q;", "  counter u_dut (.clk(clk), .rst_n(rst_n), .q(q));"].join("\n")
    );
    const result = simulate(root);
    check(/ALL TESTS PASSED/u.test(result.out), "打印 ALL TESTS PASSED", result.out);
    check(/check_cnt=2/u.test(result.out), "报出 check_cnt=2", result.out);
    check(!/TB INCOMPLETE/u.test(result.out), "没有误报 INCOMPLETE", result.out);
  }

  // ── ③ 检查不通过 → FAIL ──
  console.log("\n=== ③ 检查不通过 → FAIL ===");
  {
    const body = [
      "    rst_n = 1'b0;",
      "    repeat (2) @(posedge clk);",
      "    rst_n = 1'b1;",
      "    @(posedge clk); #1;",
      '    if (q !== 8\'hFF) begin $error("deliberately wrong expectation"); err_cnt++; end',
      "    check_cnt++;"
    ].join("\n");
    const root = setup(
      "failing",
      body,
      ["  logic rst_n;", "  logic [7:0] q;", "  counter u_dut (.clk(clk), .rst_n(rst_n), .q(q));"].join("\n")
    );
    const result = simulate(root);
    check(/TB FAILED/u.test(result.out), "报 TB FAILED", result.out);
    check(/err_cnt=1/u.test(result.out), "报出 err_cnt=1", result.out);
    check(!/ALL TESTS PASSED/u.test(result.out), "不打印 PASSED", result.out);
  }
} finally {
  rmSync(BASE, { recursive: true, force: true });
}

console.log("");
console.log(`  ${String(pass)} 通过 / ${String(fail)} 失败`);
if (fail > 0) process.exitCode = 1;
