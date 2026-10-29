#!/usr/bin/env node
/**
 * Verilator lint：拿 Verilator 做 ModelSim 编译查不出的静态检查。
 *
 * ## 为什么值得单独做
 *
 * ModelSim 的 `vlog` 只报语法与部分语义错。下面这些它**不报**，但 Verilator 报：
 *
 * - `UNUSEDSIGNAL` —— 信号声明了没用，**通常意味着拼写错或漏接**
 * - `UNDRIVEN` —— 信号没驱动源，仿真里恒为 X/Z，会静默传播
 * - `WIDTH` —— 位宽隐式截断 / 扩展，大多数溢出 bug 的源头
 * - `LATCH` —— `always_comb` 漏赋值推出锁存器
 * - `COMBDLY` / `MULTIDRIVEN` / `BLKANDNBLK` —— 组合环与多驱动
 *
 * 这些在仿真里可能「碰巧跑对」，但在换器件、改参数时就炸。
 *
 * ## 路径陷阱（实测，2026-10-28）
 *
 * 本机的 Verilator 是 **msys2 包**，它的 `VERILATOR_ROOT` 等环境是 **unix 路径**
 * （`/mingw64/share/verilator/...`）。因此：
 *
 * - 直接调 `verilator_bin.exe`：`--version` 能跑，但 lint 时找不到 `verilated_std.sv`
 * - 直接调 perl 包装脚本：`Can't exec "verilator_bin"`
 * - **只有** `msys2 bash -lc 'export PATH=/mingw64/bin:$PATH && verilator ...'` 可靠
 *
 * 所以本命令固定走 bash；找不到 bash 就明确报 BLOCKED，不猜。
 *
 * ## XPM / IP 的处理
 *
 * Vivado 的 XPM 宏（`xpm_fifo_*` / `xpm_cdc_*`）不在 Verilator 的库里，
 * 会报一堆 `MODMISSING`。默认加 `-Wno-MODMISSING` 忽略它们 —— 但**这会掩盖真的缺模块**，
 * 所以输出里明确提示「缺模块未检查」，并用 `--strict-modules` 可以关掉这个宽松。
 *
 * ## 用法
 *
 * ```
 * node module-rtl-lint.mjs <模块根> [--json] [--strict-modules] [--verilator <路径>]
 * ```
 *
 * 退出码：0 = 无 error 且无新增 warning；1 = 有 error 或 warning；
 *         2 = 用法错误；3 = 环境不满足（BLOCKED，如找不到 msys2 bash）。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_BASH = "C:\\msys64\\usr\\bin\\bash.exe";

/**
 * Verilator 报的这几类在仿真里可能不显形，但都是真问题。按严重度分组。
 *
 * `WIDTHTRUNC` / `WIDTHEXPAND` / `CASEINCOMPLETE` 也进这里：
 * 位宽截断是溢出 bug 的主要来源，`CASEINCOMPLETE` 则是 latch 的前兆。
 * 早期只收 `WIDTH`，把这两个当「风格类」忽略了 —— 那正是最该看的信号。
 */
const IMPORTANT = new Set([
  "UNUSEDSIGNAL",
  "UNDRIVEN",
  "WIDTH",
  "WIDTHTRUNC",
  "WIDTHEXPAND",
  "LATCH",
  "CASEINCOMPLETE",
  "COMBDLY",
  "MULTIDRIVEN",
  "BLKANDNBLK",
  "IMPLICIT",
  "SELRANGE",
  "ALWCOMBORDER"
]);

const usage = () => {
  console.error("用法：node module-rtl-lint.mjs <模块根> [--json] [--strict-modules] [--verilator <路径>]");
  console.error("");
  console.error("  <模块根>            含 rtl/ 的目录；扫 rtl/ 下所有 .v/.sv");
  console.error("  --json              输出机器可读 JSON");
  console.error("  --strict-modules    不忽略缺模块（默认忽略 Vivado XPM/IP，会提示）");
  console.error("  --verilator <路径>  显式指定 verilator（默认在 msys2 里找）");
  console.error("");
  console.error("前提：Windows 上 Verilator 由 msys2 提供，需要 C:\\msys64\\usr\\bin\\bash.exe。");
  console.error("查什么：UNUSEDSIGNAL / UNDRIVEN / WIDTH / LATCH 等 —— 这些 ModelSim 编译不报。");
  process.exit(2);
};

const parseArgs = (argv) => {
  const options = { moduleRoot: "", json: false, strictModules: false, verilator: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--strict-modules") options.strictModules = true;
    else if (arg === "--verilator") {
      options.verilator = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--")) {
      console.error(`未知选项：${arg}`);
      usage();
    } else if (options.moduleRoot === "") options.moduleRoot = arg;
  }
  if (options.moduleRoot === "") usage();
  return options;
};

/** 收集 rtl/ 下的 HDL 源（含子目录）。 */
const collectSources = (rtlDir) => {
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:sv|v)$/u.test(name)) found.push(full);
    }
  };
  if (existsSync(rtlDir)) walk(rtlDir);
  return found.sort();
};

/** 找一个可用的 msys2 bash。 */
const findBash = () => (existsSync(DEFAULT_BASH) ? DEFAULT_BASH : "");

/**
 * 把 Windows 路径换成 msys2 的 `/c/...` 形式。
 * @param path - Windows 绝对路径。
 * @returns msys2 风格路径。
 */
const toMsysPath = (path) => {
  const normalized = path.replace(/\\/gu, "/");
  return normalized.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`);
};

/** 单引号转义，供 bash -lc 使用。 */
const shellQuote = (text) => `'${text.replace(/'/gu, "'\\''")}'`;

const runVerilator = (bash, sources, strictModules, verilatorPath) => {
  const dir = resolve(sources[0], "..");
  const files = sources.map((file) => shellQuote(toMsysPath(file))).join(" ");

  // `-Wno-MODMISSING`：Vivado XPM/IP 不在 Verilator 库里。严格模式下不加。
  const weaken = strictModules ? "" : "-Wno-MODMISSING -Wno-PINMISSING ";

  const binary = verilatorPath === "" ? "verilator" : shellQuote(toMsysPath(verilatorPath));

  // **`-Wall` 不含 WIDTH 系列，必须显式打开**（2026-10-29）。
  //
  // 位宽隐式截断/扩展是溢出 bug 的主要来源，也是「仿真对、上板错」的常见根因：
  // 仿真在赋值处截断，综合可能按不同宽度优化。
  //
  // 只加 `-Wwarn-WIDTH` 一个就够 —— 它是父类，打开后 trunc/expand 的细分都会报出来。
  // 不去分别试 WIDTHTRUNC / WIDTHEXPAND：那是更细的分类名，各版本支持不一致，
  // 逐个探测会让每条命令多跑几次进程、还要往用户目录写探针文件，得不偿失。
  const widthWarnings = "-Wwarn-WIDTH ";

  // 固定走 msys2 bash：Verilator 的 VERILATOR_ROOT 是 unix 路径，Windows 直调解析不到。
  const script = [
    "export PATH=/mingw64/bin:/usr/bin:$PATH",
    `cd ${shellQuote(toMsysPath(dir))}`,
    `${binary} --lint-only -Wall -Wno-fatal ${widthWarnings}${weaken}${files} 2>&1`
  ].join(" && ");

  const result = spawnSync(bash, ["-lc", script], { encoding: "utf8", timeout: 600_000 });
  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
};

/**
 * 把 Verilator 报的路径统一成「相对模块根 + 正斜杠」。
 *
 * Verilator 在 msys2 下会把 Windows 路径与 `/` 混着报（`C:/...\bad.sv`），
 * 直接打印很乱；而且绝对路径对用户没意义 —— 他只关心是哪个文件的哪一行。
 * @param file - 原始路径（可能为空）。
 * @param root - 模块根。
 * @returns 相对路径（正斜杠），无法相对化时返回原值。
 */
const prettyPath = (file, root) => {
  if (file === "") return "";
  // Verilator 在 msys2 下会把 `/c/...` 与 `C:/...\` 混着报。
  // 先统一分隔符，再把 msys2 的 `/c/Users` 还原成 `C:/Users`。
  let unified = file.replace(/\\/gu, "/");
  unified = unified.replace(/^\/([a-z])\//u, (_, drive) => `${drive.toUpperCase()}:/`);

  const rootUnified = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (unified.toLowerCase().startsWith(`${rootUnified.toLowerCase()}/`)) {
    return unified.slice(rootUnified.length + 1);
  }
  // 只报了文件名（Verilator `cd` 进目录后常用相对名）：保留可读名即可。
  return unified;
};
/**
 * 解析 Verilator 输出。
 *
 * 形如：`%Warning-UNUSEDSIGNAL: eth_axis_sync_fifo.sv:32:69: Signal is not used: 's_axis_tdata'`
 * @param text - 完整输出。
 * @returns `{ errors, warnings }`。
 */
const parseOutput = (text) => {
  const errors = [];
  const warnings = [];

  /**
   * 从 `... <路径>:<行>[:<列>]: <消息>` 里拆出路径、行、消息。
   *
   * 不能简单用 `([^:]+):(\d+)` —— Windows 路径自带盘符冒号（`C:/x/y.sv:12:5`），
   * 那样会把 `C` 后面当成分隔符，路径变成 `:/x/y.sv`（实测踩过）。
   * 所以先贪心找到**最后一个**「:数字:数字:」或「:数字:」，再切。
   * @param rest - 冒号后面的剩余文本。
   * @returns `{ file, line, message }`，拆不出时 file 为空、整体当消息。
   */
  const splitWhere = (rest) => {
    const match = /^(.*?):(\d+)(?::\d+)?:\s*(.*)$/u.exec(rest);
    if (match === null) return { file: "", line: 0, message: rest.trim() };
    return { file: match[1].trim(), line: Number(match[2]), message: match[3].trim() };
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const errorMatch = /^%Error(?:-(\w+))?:\s*(.*)$/u.exec(line);
    if (errorMatch !== null) {
      const where = splitWhere(errorMatch[2]);
      errors.push({ kind: errorMatch[1] ?? "", ...where });
      continue;
    }
    const warningMatch = /^%Warning-(\w+):\s*(.*)$/u.exec(line);
    if (warningMatch !== null) {
      const where = splitWhere(warningMatch[2]);
      warnings.push({ kind: warningMatch[1], ...where });
    }
  }

  return { errors, warnings };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.moduleRoot);
  if (!existsSync(root)) {
    console.error(`模块根不存在：${root}`);
    process.exit(2);
  }

  const rtlDir = join(root, "rtl");
  if (!existsSync(rtlDir)) {
    console.error(`找不到 rtl/ 目录：${rtlDir}`);
    console.error("");
    console.error("先用 setup-scaffold 建骨架，或确认模块根给对了。");
    process.exit(2);
  }

  const sources = collectSources(rtlDir);
  if (sources.length === 0) {
    console.error(`rtl/ 下没有 .v/.sv 源文件：${rtlDir}`);
    process.exit(2);
  }

  const bash = findBash();
  if (bash === "") {
    const message = [
      "找不到 msys2 bash，Verilator 无法在 Windows 上可靠驱动。",
      "",
      "为什么：本机的 Verilator 由 msys2 提供，它的 VERILATOR_ROOT 是 unix 路径",
      "（/mingw64/share/verilator/...）。直接调 verilator_bin.exe 或 perl 包装脚本",
      "都会在 lint 阶段报找不到 verilated_std.sv（实测）。只有 msys2 bash 里能跑。",
      "",
      `期望路径：${DEFAULT_BASH}`,
      "装 msys2 后把 mingw64 的 verilator 包装上即可；或跳过这一步（Lint 是可选增强）。"
    ].join("\n");
    if (options.json) {
      console.log(JSON.stringify({ root, blocked: true, message }, null, 2));
    } else {
      console.error(message);
    }
    // 3 = BLOCKED（环境不满足），与「代码有问题」的 1 区分开。
    process.exit(3);
  }

  const result = runVerilator(bash, sources, options.strictModules, options.verilator);
  const { errors, warnings } = parseOutput(result.stdout);
  const important = warnings.filter((warning) => IMPORTANT.has(warning.kind));
  const others = warnings.filter((warning) => !IMPORTANT.has(warning.kind));

  const passed = errors.length === 0 && important.length === 0;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          root,
          sources: sources.map((file) => relative(root, file).replace(/\\/gu, "/")),
          strictModules: options.strictModules,
          errors: errors.map((item) => ({ ...item, file: prettyPath(item.file, root) })),
          importantWarnings: important.map((item) => ({ ...item, file: prettyPath(item.file, root) })),
          otherWarnings: others.map((item) => ({ ...item, file: prettyPath(item.file, root) })),
          passed
        },
        null,
        2
      )
    );
  } else {
    console.log(`Verilator lint  ${root}`);
    console.log(`  源文件：${String(sources.length)} 个`);
    if (!options.strictModules) {
      console.log("  缺模块：已忽略（Vivado XPM / IP 不在 Verilator 库里）—— 要查就用 --strict-modules");
    }
    console.log("");

    if (errors.length === 0 && warnings.length === 0) {
      console.log("  ✅ 无 error、无 warning。");
    }

    if (errors.length > 0) {
      console.log(`  ❌ ${String(errors.length)} 个 error：`);
      for (const error of errors.slice(0, 20)) {
        const where = error.file === "" ? "" : ` ${prettyPath(error.file, root)}${error.line === 0 ? "" : `:${String(error.line)}`}`;
        console.log(`    ·${where}  ${error.message.slice(0, 100)}`);
      }
      if (errors.length > 20) console.log(`    …（另有 ${String(errors.length - 20)} 条）`);
      console.log("");
    }

    if (important.length > 0) {
      console.log(`  ⚠️  ${String(important.length)} 条值得处理的 warning：`);
      for (const warning of important.slice(0, 20)) {
        const where = warning.file === "" ? "" : ` ${prettyPath(warning.file, root)}${warning.line === 0 ? "" : `:${String(warning.line)}`}`;
        console.log(`    · [${warning.kind}]${where}  ${warning.message.slice(0, 90)}`);
      }
      if (important.length > 20) console.log(`    …（另有 ${String(important.length - 20)} 条）`);
      console.log("");
    }

    if (others.length > 0) {
      console.log(`  （另有 ${String(others.length)} 条风格类 warning，未计入判定：${[...new Set(others.map((warning) => warning.kind))].slice(0, 6).join(", ")}）`);
      console.log("");
    }

    if (important.length > 0 && errors.length === 0) {
      console.log("  UNUSEDSIGNAL 常是拼写错 / 漏接，UNDRIVEN 会让信号恒为 X，");
      console.log("  WIDTH 是隐式截断（多数溢出 bug 的源头），LATCH 是 always_comb 漏赋值。");
      console.log("  这些 ModelSim 编译都不报 —— 值得逐条看，不要一律当噪声。");
    }
  }

  process.exit(passed ? 0 : 1);
};

main();
