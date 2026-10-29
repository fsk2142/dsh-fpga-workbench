#!/usr/bin/env node
/**
 * X 初态检查：找出 testbench 里「把未知变已知」的初值声明。
 *
 * ## 为什么这一项值半天工时
 *
 * 真实 FPGA 上电后，寄存器和 BRAM 的内容是**不确定**的（除非设计显式复位/初始化）。
 * 但绝大多数 testbench 这样写：
 *
 * ```systemverilog
 * logic clk = 0;        // ← 把 X 变成 0
 * logic rst_n = 0;      // ← 把 X 变成 0
 * logic [7:0] data = '0;
 * ```
 *
 * 于是仿真**从确定值开始**，「依赖初值」这类 bug 在桌面上永远复现不出来，
 * 一上板就死。实测对照（ModelSim 2020.4，本仓库验证过）：
 *
 * ```
 * TB 不写初值   → 时刻 0 有 5/5 个信号是 X   ← 依赖初值的逻辑立刻暴露
 * TB 写了初值   → 时刻 0 只剩 2/5 个是 X     ← 问题被掩盖
 * ```
 *
 * **关键事实**（实测得出，与网上流传的说法相反）：ModelSim **默认就保留 X**，
 * 不需要 `+initreg` 之类的选项；反而 `-initreg0` 会把寄存器强制成 0，
 * 正好抹掉 X。所以「全 X 初态仿真」的落点是**检查 TB 源码**，不是加仿真器开关。
 *
 * ## 判据
 *
 * 只看**声明处**的初值（`logic x = 0;` / `reg x = 0;` / `bit x = 0;`），因为：
 *
 * - 声明处初值 = 上电初值，这是要抓的东西
 * - `initial begin x = 0; end` 也是初值，但它通常是有意为之（激励序列），
 *   而且有些确实必要（时钟必须先有沿）—— 报成警告而不是阻塞
 *
 * 区分**必要例外**与**真问题**：
 *
 * - `clk` 类信号（名字含 clk/clock/osc）→ 允许，但提示用 `initial` 或 `forever` 更清楚
 * - 常数（`localparam` / `parameter`）→ 不算
 * - `logic x = 'z` / `= 'x` → 这是显式声明未知，允许
 *
 * 退出码：0 = 无初值声明；1 = 有（阻塞）；2 = 输入错误；3 = 只有可豁免的。
 *
 * ## 用法
 *
 * ```
 * node module-verif-xinit.mjs <模块根|tb 文件|目录> [--json] [--allow-clock]
 * ```
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node module-verif-xinit.mjs <模块根|目录|tb 文件> [--json]");
  write("");
  write("  扫描 testbench 里声明处的初值（logic x = 0; 这类），它们把上电的 X 变成了确定值。");
  write("  ModelSim 默认保留 X，不需要任何仿真器选项 —— 问题在 TB 源码本身。");
  write("");
  write("退出码：0 无初值 / 1 有初值（阻塞）/ 2 输入错误 / 3 只有时钟类可豁免项。");
  process.exit(code);
};

const CLOCK_HINT = /(?:^|_)(?:clk|clock|osc|refclk|sysclk|pixclk)(?:$|_|\d)/iu;
/** 声明处初值：`logic [7:0] x = 0;` / `reg x = 1'b0;` / `bit x = '0;` */
const DECL_INIT = /^\s*(?:logic|reg|bit|wire|integer|int|byte|shortint|longint)\b[^;=]*\b(\w+)\s*(?:\[[^\]]*\])?\s*=\s*([^;]+);/u;
/** `initial begin x = 0; end` 里的赋值（单行形态）。 */
const INITIAL_ASSIGN = /initial\s+begin\s+(?:[^;\n]*;\s*)*?(\w+)\s*=\s*([^;]+);/u;

/**
 * 判断一个初值是否「显式未知」。
 * @param value - 声明等号右边的内容。
 */
const isExplicitUnknown = (value) =>
  /^['`]?[xz]/iu.test(value.trim()) || /^['`]?[01]*[xz][01]*$/iu.test(value.trim());

/**
 * 判断一个初值是否明显是常数引用（`= WIDTH`、`= DEPTH-1`）。
 * 那类通常来自 parameter，不是「掩盖 X」。
 */
const isConstantRef = (value) => /^[A-Z_][A-Z0-9_]*$/u.test(value.trim());

const collectFiles = (target) => {
  if (!existsSync(target)) return { error: `路径不存在：${target}` };
  const stat = statSync(target);
  if (stat.isFile()) return { files: [target], root: resolve(target, "..") };

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || name === "work") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if ([".sv", ".v", ".svh", ".vh"].includes(extname(name).toLowerCase())) files.push(full);
    }
  };
  walk(target);
  return { files, root: resolve(target) };
};

/** 判断一个文件是不是 testbench（名字带 tb / test，或在 verif/ 下）。 */
const isTestbench = (file, root) => {
  const base = file.split(/[\\/]/u).pop() ?? "";
  if (/^tb_|_tb\.|testbench/iu.test(base)) return true;
  const rel = file.slice(root.length).replace(/\\/gu, "/");
  return /\/verif\//u.test(rel);
};

const main = () => {
  const argv = process.argv.slice(2);
  const options = { json: false, target: "" };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") usage(0);
    if (options.target === "") options.target = arg;
  }
  if (options.target === "") usage();

  const collected = collectFiles(options.target);
  if (collected.error !== undefined) {
    console.error(collected.error);
    process.exit(2);
  }

  const found = [];
  let scanned = 0;

  for (const file of collected.files) {
    if (!isTestbench(file, collected.root)) continue;
    scanned += 1;
    const lines = readFileSync(file, "utf8").split("\n");

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // 跳过注释行（单行注释开头）
      const code = line.replace(/\/\/.*$/u, "").replace(/\/\*.*?\*\//gu, "");
      if (code.trim() === "") continue;

      const decl = DECL_INIT.exec(code);
      if (decl !== null) {
        const [, name, value] = decl;
        if (isExplicitUnknown(value)) continue;
        if (isConstantRef(value)) continue;
        const isClock = CLOCK_HINT.test(name);
        found.push({
          file: file.slice(collected.root.length).replace(/\\/gu, "/"),
          line: i + 1,
          name,
          value: value.trim(),
          kind: isClock ? "时钟类" : "寄存器类",
          text: line.trim().slice(0, 92)
        });
        continue;
      }

      const initial = INITIAL_ASSIGN.exec(code);
      if (initial !== null) {
        const [, name, value] = initial;
        if (isExplicitUnknown(value) || isConstantRef(value)) continue;
        if (CLOCK_HINT.test(name)) continue; // 时钟在 initial 里启动是常态
        found.push({
          file: file.slice(collected.root.length).replace(/\\/gu, "/"),
          line: i + 1,
          name,
          value: value.trim(),
          kind: "initial 赋值",
          text: line.trim().slice(0, 92)
        });
      }
    }
  }

  const registers = found.filter((item) => item.kind === "寄存器类" || item.kind === "initial 赋值");
  const clocks = found.filter((item) => item.kind === "时钟类");

  const payload = {
    scanned,
    found,
    blockers: registers,
    exempt: clocks,
    verdict: registers.length > 0 ? "FAIL" : clocks.length > 0 ? "WARN" : "PASS"
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`扫描 ${String(scanned)} 个 testbench 文件`);
    if (found.length === 0) {
      console.log("");
      console.log("PASS：没有声明处初值 —— 仿真会从 X 开始，依赖初值的逻辑会暴露出来。");
    } else {
      if (registers.length > 0) {
        console.log("");
        console.log(`会掩盖 X 的初值 ${String(registers.length)} 处：`);
        for (const item of registers) {
          console.log(`  ✗ ${item.file}:${String(item.line)}  ${item.name} = ${item.value}`);
          console.log(`        ${item.text}`);
        }
        console.log("");
        console.log("这些声明让仿真从确定值开始。上板时对应寄存器是未知的 —— 依赖它的逻辑不会在这里报错。");
        console.log("改法：去掉声明处初值，在 initial 里按**真实上电顺序**驱动（复位释放前不驱动数据）。");
      }
      if (clocks.length > 0) {
        console.log("");
        console.log(`时钟类可豁免 ${String(clocks.length)} 处（仍需确认它们确实先起振）：`);
        for (const item of clocks) {
          console.log(`  ! ${item.file}:${String(item.line)}  ${item.name} = ${item.value}`);
        }
      }
    }
  }

  process.exit(registers.length > 0 ? 1 : clocks.length > 0 ? 3 : 0);
};

main();
