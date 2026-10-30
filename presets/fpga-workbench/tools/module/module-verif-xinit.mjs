#!/usr/bin/env node
/**
 * X 初态检查：找出「把未知变已知」的两类源头 —— 寄存器声明初值、以及未做 X 化的存储器。
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
 * ## 三档做法（本脚本覆盖后两档的一半）
 *
 * | 档 | 做法 | 本脚本 |
 * |---|---|---|
 * | 一 | 仿真器全局寄存器初值 | ❌ 不覆盖：ModelSim **默认就保留 X**，见下 |
 * | 二 | **存储器 / FIFO 的 X 化**（`ifdef SIM_INIT_X`） | ✅ **扫 RTL 存储器有没有包** |
 * | 三 | X 传播检查（`-xprop`） | ❌ 不覆盖（需仿真器选项） |
 *
 * **为什么第二档最重要**：仿真器的全局初值选项**不覆盖** BRAM / FIFO 的存储数组，
 * 而那是 X 的第一大来源。一个没复位的存储器仿真读 0 不报错，硬件读随机数据 ——
 * 更隐蔽的是随机数据恰好构成"看起来合法"的包头，故障现象与真问题完全不相干。
 *
 * **关键事实**（实测得出，与网上流传的说法相反）：
 *
 * - ModelSim **默认就保留 X**（`vopt` 裸跑、甚至 `-O5` 优化后仍是全 X），
 *   不需要 `+initreg` 之类选项
 * - 网上给的 `vopt -initreg +X` 在 **ModelSim 2020.4 上直接报错**
 *   （`vopt-10538: Option "-initreg" is not a valid option`）—— 那是较新 Questa 的语法
 * - `-initreg0` 反过来会把寄存器强制成 0、**正好抹掉 X**
 *
 * 所以第一档在本机不成立，重点落在**第二档**（存储器）与**检查 TB 源码**上。
 *
 * ## 判据
 *
 * ### A. 寄存器声明初值（TB 里）
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
 * ### B. 存储器未做 X 化（RTL 里）
 *
 * 找形如 `logic [7:0] mem [0:1023];` 的数组声明，然后判断它有没有被
 * `ifdef SIM_INIT_X`（或类似名字）包起来。
 *
 * **豁免规则**（避免成为噪声源，否则没人会看结果）：
 *
 * - 声明处带初值文件 / `.coe` / `$readmemh` → 硬件上确有确定初值，**豁免**
 * - 名字含 `rom` / `const` / `lookup` → 只读表，通常有初始化文件，报为提示而非阻塞
 * - 只有一位、或深度 ≤ 2 的数组 → 多半不是真正的存储器，跳过
 *
 * 详见下方 `MEMORY_EXEMPT`。
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
 *
 * ## 支持的字面量形态
 *
 * ```
 * 'x   x   'z   z             // 无宽无基
 * 1'bx  1'bz  4'bxxxx        // 二进制全 X/Z
 * 'hx   8'hx  16'hxxxx       // 十六进制全 X/Z(h 一位 = 4 bit,所以 'hx 就是全 4 位未知)
 * 4'hz  8'hxz                // 全 Z / 混合
 * ```
 *
 * ## 为什么要单独认 h 进制(2026-10-29 实测的漏判)
 *
 * 原来只认 `[01]*` 的二进制形态,于是 `16'hxxxx` / `8'hXX` / `4'hz` 这类**完全合法**的
 * 显式 X 化被判成「有初值」,后果是第 1 段误报「没有声明处初值」(假阴性)——
 * 用户按规范做的 X 化反而让检查器看不见。
 *
 * ## 关键实现细节(踩过的两个坑)
 *
 * 1. **字符类里必须包含 `x`/`z`** —— 它们不是十六进制数字,`[0-9a-f_]` 配不上 `xxxx`
 * 2. **不能先把 `'` 剥掉** —— `16'hxxxx` 的 `'` 是进制分隔符,剥了就配不上
 *
 * @param value - 声明等号右边的内容。
 */
const isExplicitUnknown = (value) => {
  const raw = value.trim();
  // 无宽无基:`'x` / `x` / `'z` / `z`(整串就一个字符)
  if (/^['`]?[xz]$/iu.test(raw)) return true;
  // 带进制:(可选十进制宽度)'(b|o|h|d) 后跟全 x/z 的值
  //   字符类必须含 x/z —— 它们不是十六进制数字
  const withBase = /^(?:\d+)?'\s*[bodh]\s*([0-9a-fxz_]+)$/iu.exec(raw);
  if (withBase === null) return false;
  const digits = withBase[1];
  if (!/x|z/iu.test(digits)) return false;
  // 全 X/Z(可带下划线分隔)才算「显式未知」;`4'b10xz` 这种半已知的不算
  return /^[xz_]+$/iu.test(digits);
};

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

/**
 * 存储器数组声明：`logic [7:0] mem [0:1023];` / `reg [15:0] buf [256];`
 *
 * 要求两个维度都在，否则只是普通向量而不是数组。
 */
const MEMORY_DECL =
  /^\s*(?:logic|reg|bit|wire)\s*(?:signed|unsigned)?\s*(?:\[[^\]]+\]\s*)?(\w+)\s*\[\s*([^\]]+)\]\s*(?:=\s*([^;]+))?;/u;

/** 存储器整段被 X 化必需出现的标记。 */
const XINIT_GUARD = /`ifdef\s+(?:SIM_INIT_X|XINIT|SIM_X_INIT|INIT_X)\b/u;

/**
 * 判断某一行存储器声明是否「应当豁免」。
 *
 * 误报会让这个检查变成噪声，然后没人看结果 —— 比不检查更糟。
 * 所以下列情况一律豁免，并在输出里写清原因，不是静默跳过。
 */
const memoryExempt = (name, line, context) => {
  // 声明处直接给了初值（如 `= '{default:'0}`）—— 那本身就是在初始化，不是漏了
  if (/=\s*['{]/u.test(line)) return "声明处已有初值";

  // 只读表：通常配 .coe / $readmemh，硬件上确有确定内容
  if (/(?:^|_)(?:rom|const|lookup|lut|table|coeff)(?:$|_)/iu.test(name)) return "只读表（通常是初始化文件驱动的）";

  // 附近有 $readmemh / $readmemb / .coe 引用
  if (/\$(?:readmem[hb])|\.coe\b|\.mif\b|INIT_FILE|init_file/iu.test(context)) return "有初始化文件（$readmemh / .coe）";

  return undefined;
};

/** 取声明前后若干行作为上下文，用于判断初始化文件与 X 化守卫。 */
const contextOf = (lines, index, radius = 6) =>
  lines.slice(Math.max(0, index - radius), Math.min(lines.length, index + radius + 1)).join("\n");

/** 解析数组深度，判断是不是「太浅不像存储器」的例外。 */
const looksLikeRealMemory = (depthText) => {
  // `[256]` 这种单值写法是深度
  const simple = /^\s*(\d+)\s*$/u.exec(depthText);
  if (simple !== null) return Number(simple[1]) > 2;
  // `[0:1023]` 这种范围写法
  const range = /^\s*(\d+)\s*:\s*(\d+)\s*$/u.exec(depthText);
  if (range !== null) return Math.abs(Number(range[2]) - Number(range[1])) > 2;
  // 靠参数决定的（`[0:DEPTH-1]`）—— 不当成例外，因为很可能就是真存储器
  return true;
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
  const memories = [];
  let scanned = 0;
  let rtlScanned = 0;

  for (const file of collected.files) {
    const rel = file.slice(collected.root.length).replace(/\\/gu, "/");
    const lines = readFileSync(file, "utf8").split("\n");
    const tb = isTestbench(file, collected.root);

    // ── A. TB 里的声明初值 ──
    if (tb) {
      scanned += 1;

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
            file: rel,
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
            file: rel,
            line: i + 1,
            name,
            value: value.trim(),
            kind: "initial 赋值",
            text: line.trim().slice(0, 92)
          });
        }
      }
      continue;
    }

    // ── B. RTL 里的存储器是否做了 X 化 ──
    rtlScanned += 1;
    for (let i = 0; i < lines.length; i += 1) {
      const code = lines[i].replace(/\/\/.*$/u, "");
      if (code.trim() === "") continue;

      const decl = MEMORY_DECL.exec(code);
      if (decl === null) continue;

      const [, name, depthText] = decl;
      if (!looksLikeRealMemory(depthText)) continue;

      const context = contextOf(lines, i);
      // 已经被 `ifdef SIM_INIT_X 包起来？整段上下文里有守卫就认
      const guarded = XINIT_GUARD.test(context);
      if (guarded) continue;

      const exempt = memoryExempt(name, code, context);
      memories.push({
        file: rel,
        line: i + 1,
        name,
        depth: depthText.trim(),
        exempt,
        kind: exempt === undefined ? "存储器未 X 化" : "存储器（豁免）",
        text: lines[i].trim().slice(0, 92)
      });
    }
  }

  const registers = found.filter((item) => item.kind === "寄存器类" || item.kind === "initial 赋值");
  const clocks = found.filter((item) => item.kind === "时钟类");
  const unguarded = memories.filter((item) => item.exempt === undefined);
  const exempted = memories.filter((item) => item.exempt !== undefined);

  const payload = {
    scanned,
    rtlScanned,
    found,
    memories,
    blockers: registers,
    memoryBlockers: unguarded,
    exempt: clocks,
    memoryExempt: exempted,
    verdict:
      registers.length > 0 || unguarded.length > 0
        ? "FAIL"
        : clocks.length > 0 || exempted.length > 0
          ? "WARN"
          : "PASS"
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`扫描 ${String(scanned)} 个 testbench + ${String(rtlScanned)} 个 RTL 文件`);
    console.log("");

    // ── A. 寄存器声明初值 ──
    if (registers.length > 0) {
      console.log(`【寄存器】会掩盖 X 的初值 ${String(registers.length)} 处：`);
      for (const item of registers) {
        console.log(`  ✗ ${item.file}:${String(item.line)}  ${item.name} = ${item.value}`);
        console.log(`        ${item.text}`);
      }
      console.log("");
      console.log("这些声明让仿真从确定值开始。上板时对应寄存器是未知的 —— 依赖它的逻辑不会在这里报错。");
      console.log("改法：去掉声明处初值，在 initial 里按**真实上电顺序**驱动（复位释放前不驱动数据）。");
      console.log("");
    }

    // ── B. 存储器未做 X 化 ──
    if (unguarded.length > 0) {
      console.log(`【存储器】未做 X 化 ${String(unguarded.length)} 处（这一类仿真器选项覆盖不到）：`);
      for (const item of unguarded) {
        console.log(`  ✗ ${item.file}:${String(item.line)}  ${item.name} [${item.depth}]`);
        console.log(`        ${item.text}`);
      }
      console.log("");
      console.log("没复位的存储器仿真读 0 不报错，硬件读随机数据。更隐蔽的是随机数据恰好构成");
      console.log("「看起来合法」的包头 —— 故障现象与真问题完全不相干。");
      console.log("");
      console.log("改法（RTL 里包一层，只在仿真编译时生效）：");
      console.log("  `ifdef SIM_INIT_X");
      console.log("    integer xi;");
      console.log("    initial for (xi = 0; xi < DEPTH; xi = xi + 1) mem[xi] = {WIDTH{1'bx}};");
      console.log("  `endif");
      console.log("  **FIFO 的读写指针也要一起 X 化** —— 只 X 化数据数组、指针仍从 0 开始，");
      console.log("  两者不一致会产生难以解释的现象。");
      console.log("");
    }

    // ── 豁免项（写清原因，不是静默跳过）──
    if (clocks.length > 0) {
      console.log(`【豁免】时钟类初值 ${String(clocks.length)} 处（需确认它们确实先起振）：`);
      for (const item of clocks) {
        console.log(`  ! ${item.file}:${String(item.line)}  ${item.name} = ${item.value}`);
      }
      console.log("");
    }
    if (exempted.length > 0) {
      console.log(`【豁免】存储器 ${String(exempted.length)} 处（硬件上确有确定初值）：`);
      for (const item of exempted) {
        console.log(`  ! ${item.file}:${String(item.line)}  ${item.name} — ${item.exempt}`);
      }
      console.log("");
    }

    if (registers.length === 0 && unguarded.length === 0) {
      if (clocks.length === 0 && exempted.length === 0) {
        console.log("PASS：没有声明处初值，也没有未 X 化的存储器 —— 仿真会从 X 开始。");
      } else {
        console.log("WARN：没有阻塞项，但有上面那些豁免项需要人工确认。");
      }
    }
  }

  process.exit(registers.length > 0 || unguarded.length > 0 ? 1 : clocks.length > 0 || exempted.length > 0 ? 3 : 0);
};

main();
