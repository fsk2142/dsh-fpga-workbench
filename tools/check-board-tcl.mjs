#!/usr/bin/env node
/**
 * 用**真 Tcl 解释器**验证 `project-board-selftest.mjs` 生成的 Tcl（F-01 回归）。
 *
 * ## 为什么必须真跑
 *
 * 报告 F-01 的要求是「CI 中必须**真正执行**生成的 Tcl，而不是仅断言文件包含关键字符串」。
 * 上板自检生成的是 Tcl，只有 Tcl 解释器能判定它有没有语法错误、参数传错、转义写错。
 *
 * 实际踩过的三个坑，全都是「字符串包含断言」抓不到的：
 *
 * | 坑 | 现象 | 断言抓得到吗 |
 * |---|---|---|
 * | `check {表达式}` 传字符串字面量 | `expected boolean value but got ...` | ❌ |
 * | 模板里 `\[` 被 JS 当转义 | `invalid command name "INFO"` | ❌ |
 * | `stop_if_failed` 里同上的转义 | `invalid command name "P0"` | ❌ |
 *
 * ## 怎么做到真跑又不需要板子
 *
 * 把 Vivado 硬件命令**全部 mock 掉**（`get_hw_devices` / `get_property` 等返回可控值），
 * 然后 source 到 `stop_if_failed P0` 为止 —— 后面的 L0–L3 需要真硬件。
 * 注入不同 mock 值就能验证 P0 各分支的 PASS / FAIL 走向。
 *
 * ## 找不到 tclsh 时
 *
 * **明确跳过并退 0**，不假装通过。tclsh 通常随 Vivado 装在
 * `<Vivado>/bin/unwrapped/<平台>/tclsh*`，也可用 `DSH_TCLSH` 指定。
 *
 * ## 用法
 *
 * ```
 * node tools/check-board-tcl.mjs
 * DSH_TCLSH=/path/to/tclsh node tools/check-board-tcl.mjs
 * ```
 *
 * 退出码：0 = 全通过或跳过；1 = 有断言失败。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GEN = join(ROOT, "presets/fpga-workbench/tools/project/project-board-selftest.mjs");

/**
 * 找一个可用的 tclsh。
 *
 * 顺序：`DSH_TCLSH` 环境变量 → Vivado 常见安装位置。
 * 都不行就返回 undefined（调用方跳过，不报失败）。
 */
const findTclsh = () => {
  const explicit = process.env.DSH_TCLSH;
  if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit;

  const vivadoRoots = [
    "C:/AMDDesignTools/2025.2/Vivado/bin/unwrapped",
    "C:/Xilinx/Vivado/2024.2/bin/unwrapped",
    "C:/Xilinx/Vivado/2020.2/bin/unwrapped"
  ];
  for (const base of vivadoRoots) {
    if (!existsSync(base)) continue;
    // 形如 `win64.o` / `lnx64.o` / `lin64.o` 的子目录
    for (const sub of readdirSync(base)) {
      const dir = join(base, sub);
      try {
        for (const name of readdirSync(dir)) {
          if (/^tclsh[\w.]*$/u.test(name) || name === "tclsh") {
            const full = join(dir, name);
            if (existsSync(full)) return full;
          }
        }
      } catch {
        // 目录读不了就跳过
      }
    }
  }
  return undefined;
};

const TCLSH = findTclsh();
if (TCLSH === undefined) {
  console.log("SKIP：找不到 tclsh（可用 DSH_TCLSH 指定）。");
  console.log("      这不代表上板 Tcl 没问题 —— 只是本机没有 Tcl 解释器可跑。");
  process.exit(0);
}

console.log(`  tclsh：${TCLSH}`);
const BASE = join(tmpdir(), `board-tcl-verify-${String(Date.now())}`);

/** 生成一份 Tcl 并返回路径与内容。 */
const generate = (name) => {
  const root = join(BASE, name);
  mkdirSync(join(root, "prj"), { recursive: true });
  execFileSync(process.execPath, [GEN, root], { encoding: "utf8" });
  const tcl = join(root, "prj", "board_selftest.tcl");
  if (!existsSync(tcl)) throw new Error(`没生成 ${tcl}`);
  return { root, tcl, text: readFileSync(tcl, "utf8") };
};

/** 补丁：把 TODO 占位符换成测试值。 */
const patch = (text, part, top) =>
  text
    .replace('set EXPECTED_PART "TODO:EXPECTED_PART"', `set EXPECTED_PART "${part}"`)
    .replace("TODO_TOP.bit", `${top}.bit`);

/**
 * 用一个 mock 桩 source 生成的 Tcl，跑到 P0 结束就停。
 *
 * **插入点很关键**：生成文件的结构是
 *   ① 头部注释 + `set` 配置 → ② `proc lv/check/stop_if_failed` → ③ 连接硬件 → P0
 * mock 桩要插在 ① 之后、② 之前，否则 Vivado 命令会先被调用。
 */
const runWithMock = (tclText, mock) => {
  const marker = "stop_if_failed P0";
  const index = tclText.indexOf(marker);
  const p0Part = index < 0 ? tclText : tclText.slice(0, index + marker.length);

  const insertAt = p0Part.indexOf("# ── 帮助函数");
  if (insertAt < 0) throw new Error("找不到『帮助函数』小节，生成脚本结构变了");
  const before = p0Part.slice(0, insertAt);
  const after = p0Part.slice(insertAt);

  const stub = [
    "# ── Vivado 命令 mock（生成文件自己的 lv / check / stop_if_failed 保持原样）──",
    "proc open_hw_manager {} {}",
    "proc connect_hw_server {args} {}",
    "proc get_hw_targets {} { return {localhost:3121/xilinx_tcf/Digilent/210319B} }",
    "proc current_hw_target {args} {}",
    "proc open_hw_target {} {}",
    `proc get_hw_devices {} { return ${mock.devices} }`,
    "proc current_hw_device {args} {}",
    `proc get_property {prop dev} { return ${mock.part} }`,
    ""
  ].join("\n");

  const full = `${before}\n${stub}\n${after}\nputs "DONE fail_count=$fail_count"\n`;
  const file = join(BASE, `run-${String(Math.random()).slice(2, 8)}.tcl`);
  writeFileSync(file, full, "utf8");

  try {
    const out = execFileSync(TCLSH, [file], { encoding: "utf8", timeout: 30_000 });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${String(error.stdout ?? "")}${String(error.stderr ?? "")}` };
  }
};

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${String(detail).slice(-300)}`);
  if (ok) pass += 1;
  else fail += 1;
};

console.log("=== ① 生成的 Tcl 能被 Tcl 解释器解析（不抛语法错）===");
{
  const gen = generate("syntax");
  const result = runWithMock(patch(gen.text, "xc7a100t", "top"), {
    devices: "{xc7a100t_0}",
    part: "xc7a100t"
  });
  check(
    !/invalid command name|missing close-brace|unmatched open brace|expected boolean value/iu.test(result.out),
    "P0 段没有 Tcl 语法/求值错误",
    result.out
  );
  check(/DONE fail_count=|有 \d+ 项失败/u.test(result.out), "脚本跑到了 P0 结束位置", result.out);
}

console.log("\n=== ② F-01 回归：check 收到表达式不再抛 boolean 错 ===");
{
  const gen = generate("f01");
  const result = runWithMock(patch(gen.text, "xc7a100t", "top"), {
    devices: "{xc7a100t_0}",
    part: "xc7a100t"
  });
  check(!/expected boolean value/u.test(result.out), "check 的参数求值正常", result.out);
  check(/ok: P0-2/u.test(result.out), "型号一致 → P0-2 判 ok", result.out);
}

console.log("\n=== ③ P0-2 型号不一致必须 FAIL ===");
{
  const gen = generate("f02");
  const result = runWithMock(patch(gen.text, "xc7a100t", "top"), {
    devices: "{xc7a35t_0}",
    part: "xc7a35t"
  });
  check(/FAIL: P0-2/u.test(result.out), "型号不符 → P0-2 报 FAIL（不能 PASS）", result.out);
  check(/有 [1-9]\d* 项失败/u.test(result.out), "fail_count 被计入并触发 P0 停止", result.out);
}

console.log("\n=== ④ F-04 回归：源码目录为空不能跳过 ===");
{
  const gen = generate("f04");
  const result = runWithMock(patch(gen.text, "xc7a100t", "top"), {
    devices: "{xc7a100t_0}",
    part: "xc7a100t"
  });
  check(!/跳过：P0-4/u.test(result.out), "不再出现「跳过 P0-4」", result.out);
  check(/FAIL: P0-4/u.test(result.out), "源码不可读 → P0-4 报 FAIL", result.out);
}

console.log("");
console.log(`  ${String(pass)} 通过 / ${String(fail)} 失败`);
console.log(`  沙箱：${BASE}`);
if (fail > 0) process.exitCode = 1;
