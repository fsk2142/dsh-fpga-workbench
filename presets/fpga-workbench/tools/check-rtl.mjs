#!/usr/bin/env node
// 模块 RTL 的机械规范检查 —— 从 FPGAWorkFlowKit 的 check_rtl_compliance.py 移植,
// 规则与宽容度照抄,不自己加严:
//
//   * 用户 2026-09-03 裁决:纯格式检查要宽容。文件头只要求"顶部有分隔条 + 前 15 行内
//     出现全部必填字段";九个小节块只要求名字作为 banner 存在(宽度容忍 84-86),不校验
//     列宽,也不校验顺序。
//   * 用户 2026-09-02 裁决:rst / rst_* 一律高有效。既抓 rst_n 命名,也抓在 rst 上用了
//     低有效(!rst / ~rst / negedge rst)。
//   * Tab / 代码行非英文 / 行尾混用 这三条是**警告**,不阻塞门禁(与 run_checks.py 的
//     WARN_CHECKS 一致);其余是 FAIL。
//
// 用法:
//   node check-rtl.mjs [<模块目录>] [--json]
// 模块目录默认当前目录;扫 <模块>/rtl 下的 .v/.sv,并顺带检查 <模块>/sim/tb_*.sv。
// 退出码:0 全部通过(可以只有警告) / 1 有 FAIL / 2 用法或环境错误。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** 与旧包一致的跳过目录:生成物、仿真库、版本控制等。 */
const SKIP_DIRS = new Set([
  "history", ".xil", ".git", "__pycache__", "work", "_synth_gate", "_ip_gen",
  "synth_gate.gen", ".srcs", ".runs", ".hw", ".ip_user_files", ".sim", ".cache",
  ".nano", "rerun", "node_modules"
]);

/** 这三条只警告,不阻塞(照抄 run_checks.py 的 WARN_CHECKS)。 */
const WARN_ONLY = new Set(["Tab 字符", "代码行非英文", "行尾混用"]);

const NINE_SECTIONS = [
  "Local Parameters", "Types", "Registers", "Combinational Logic", "Sequential Logic",
  "Functions Module", "Task Module", "Module Instantiation", "Assertions"
];

const HEADER_FIELDS = [
  "file name", "module name", "created date", "updated date",
  "version", "author", "copyright", "open source", "proprietary"
];

/**
 * 递归收集 HDL 源文件。
 * @param dir - 起始目录。
 * @param pattern - 文件名匹配(默认 SystemVerilog / Verilog;另用它来找 VHDL)。
 * @returns 文件绝对路径列表(已排序)。
 */
export function collectHdl(dir, pattern = /\.(sv|v)$/iu) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        if (SKIP_DIRS.has(name) || name.endsWith("_prj") || name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** 测试平台文件名:扩展名跟着设置里选的仿真语言走(`.sv` / `.v` / `.vhd`),按语言过滤。 */
const TESTBENCH = /^tb_.*\.(sv|v)$/iu;

/** VHDL 源文件(本检查器不覆盖,但必须说出来,不能静默当通过)。 */
const VHDL = /\.(vhd|vhdl)$/iu;

/**
 * 跑一个文件上的全部规则。
 *
 * 导出给自检用:沙箱里 node 不能开管道抓子进程输出,所以自检直接 import 调这个函数,
 * 而不是 spawn 一个进程去读它的 stdout。
 * @param file - 文件绝对路径。
 * @param isTestbench - 是否按测试平台检查(多两条规则,少两条 RTL 规则)。
 * @returns 每条问题带级别、行号、说明。
 */
export function checkFile(file, isTestbench) {
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/u);
  const issues = [];
  const add = (rule, line, message) => issues.push({ rule, line, message });

  // ── 行尾统一:全 CRLF 或全 LF 都行,只有混用才报(警告) ──
  const crlf = (raw.match(/\r\n/gu) ?? []).length;
  const lf = (raw.match(/(?<!\r)\n/gu) ?? []).length;
  if (crlf > 0 && lf > 0) add("行尾混用", 0, `同一个文件里既有 CRLF(${crlf})又有 LF(${lf})`);

  // ── 文件头:顶部有分隔条(>=20 个 =) + 前 15 行内字段齐全 ──
  if (lines.length < 8) {
    add("文件头", 1, `文件只有 ${lines.length} 行,文件头至少需要 8 行`);
  } else {
    const banner = /^\s*\/\/={20,}\/\/\s*$/u;
    if (!lines.slice(0, 3).some((line) => banner.test(line))) {
      add("文件头", 1, "开头三行内没有 '//====…====//' 分隔条(至少 20 个 =)");
    }
    const head = lines.slice(0, 15).join("\n").toLowerCase();
    const missing = HEADER_FIELDS.filter((field) => !head.includes(field));
    if (missing.length > 0) add("文件头", 1, `前 15 行缺字段:${missing.join(", ")}`);
  }

  // ── 编译隔离:开头 `resetall + `default_nettype none,结尾收回 ──
  let start = 0;
  while (start < lines.length && (lines[start].trim() === "" || lines[start].trim().startsWith("//"))) start += 1;
  const opening = lines.slice(start, start + 10).join("\n");
  if (!opening.includes("`resetall")) add("编译隔离", start + 1, "文件头之后缺 `resetall");
  if (!opening.includes("`default_nettype none")) add("编译隔离", start + 1, "缺 `default_nettype none");
  const closing = lines.slice(-10).join("\n");
  if (!/`default_nettype\s+(?!none)\w+/u.test(closing)) {
    add("编译隔离", lines.length, "结尾没有把 `default_nettype 收回来(通常 `default_nettype wire)");
  }

  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const stripped = line.trim();

    // ── Tab(警告) ──
    if (line.includes("\t")) add("Tab 字符", number, "出现 Tab,用空格");

    // ── 代码行非英文(警告):去掉行内注释后仍有非 ASCII ──
    if (stripped !== "" && !stripped.startsWith("//")) {
      const code = line.split("//")[0];
      const bad = [...code].filter((ch) => ch.codePointAt(0) > 0x7f);
      if (bad.length > 0) add("代码行非英文", number, `代码里出现非英文字符:${bad.join("")}`);
    }

    // ── 端口类型要显式(input wire / output logic / inout tri;reg 视为显式) ──
    const port = /^\s*(input|output|inout)\s+(?!wire\b|logic\b|tri\b|reg\b)(\w+)/u.exec(line);
    if (port !== null && !["parameter", "localparam", "genvar"].includes(port[2])) {
      const want = port[1] === "input" ? "wire" : port[1] === "output" ? "logic" : "tri";
      add("端口类型", number, `端口类型要写全:${port[1]} ${port[2]} → ${port[1]} ${want}`);
    }

    // ── always_ff 只用 posedge ──
    if (line.includes("always_ff") && line.includes("negedge")) {
      add("always_ff", number, "always_ff 里用了 negedge(只允许 posedge)");
    }

    // ── 复位一律高有效(2026-09-02 裁决) ──
    const lowReset = /if\s*\(\s*[!~]\s*rst\w*\b|negedge\s+rst\w*\b|if\s*\(\s*~?\s*rst_n\b/u.exec(line);
    if (lowReset !== null) {
      add("复位极性", number, `低有效复位用法:「${lowReset[0]}」(本项目 rst/rst_* 一律高有效)`);
    }

    // ── end 与 else begin 同行 ──
    if (stripped === "end") {
      for (let j = index + 1; j < Math.min(index + 3, lines.length); j += 1) {
        const next = lines[j].trim();
        if (next === "") continue;
        if (next.startsWith("else") && next.includes("begin")) {
          add("end/else", number, "'end' 与 'else begin' 应写在同一行");
        }
        break;
      }
    }
  }

  // ── 九个小节块:只要求名字作为 banner 存在(宽度容忍 84-86) ──
  //
  // 测试平台跳过这一条:九个小节(Local Parameters / Combinational Logic / …)是 RTL 的
  // 结构,模板里的 tb.sv 本来就没有它们 —— 照旧包一律套用,会让我们自己发的模板过不了
  // 我们自己的检查器。旧包对 TB 也是跳过"设计断言"的,这里同理。
  if (!isTestbench) {
    const banners = lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith("//") && line.endsWith("//") && line.length >= 84 && line.length <= 86)
      .map((line) => line.slice(2, -2).trim());
    const absent = NINE_SECTIONS.filter((name) => !banners.includes(name));
    if (absent.length > 0) add("九个小节块", 0, `缺小节 banner:${absent.join(" / ")}`);
  }

  // ── 设计断言:代码里有 assert/assume/cover,且说明写清 Purpose/Trigger/Failure ──
  //     (测试平台不适用,与旧包一致)
  const text = lines.join("\n");
  if (!isTestbench) {
    if (!/\b(assert|assume|cover)\s*(property|\()/u.test(text)) {
      add("设计断言", 0, "没有设计断言(Assertions 小节里要有 assert/assume/cover)");
    }
    for (const field of ["Purpose", "Trigger", "Failure"]) {
      if (!new RegExp(`\\b${field}\\b`, "u").test(text)) {
        add("设计断言", 0, `断言说明缺 ${field}`);
      }
    }
  }

  // ── 测试平台额外两条:失败能自动抓住,且成功有固定标记 ──
  if (isTestbench) {
    if (!text.includes("$fatal") && !text.includes("$error")) {
      add("测试平台自检", 0, "没有 $fatal/$error:仿真失败不会让退出码非零");
    }
    if (!text.includes("ALL TESTS PASSED")) {
      add("测试平台自检", 0, "没有 'ALL TESTS PASSED' 成功标记,批量判据说不清");
    }
  }

  return issues;
}

/**
 * 一条问题是否阻塞门禁。
 * @param issue - {@link checkFile} 的产出。
 * @returns 是 FAIL 时为 true。
 */
const isFailure = (issue) => !WARN_ONLY.has(issue.rule);

/** 入口。 */
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法:node check-rtl.mjs [<模块目录>] [--json]");
    return 0;
  }
  const asJson = args.includes("--json");
  const moduleRoot = args.find((arg) => !arg.startsWith("-")) ?? process.cwd();

  const rtlDir = join(moduleRoot, "rtl");
  if (!existsSync(rtlDir)) {
    console.error(`找不到 rtl/ 目录:${rtlDir}`);
    console.error("用法:node check-rtl.mjs [<模块目录>] —— 模块目录下要有 rtl/。");
    return 2;
  }

  // 测试平台与仿真脚本放 <模块根>/sim/(与仿真结果同目录,按文件名区分)。
  // 扩展名跟设置里选的仿真语言走:.sv / .v 都能认,.vhd 不认(见下面的提示)。
  const simDir = join(moduleRoot, "sim");
  const testbenches = existsSync(simDir)
    ? readdirSync(simDir).filter((name) => TESTBENCH.test(name)).map((name) => join(simDir, name)).sort()
    : [];

  const targets = [...collectHdl(rtlDir).map((file) => [file, false]), ...testbenches.map((file) => [file, true])];
  if (targets.length === 0) {
    // 只有 VHDL 时不能说"没有源码"(那会让人以为目录是空的);说清本检查器不覆盖 VHDL
    const vhdl = [...collectHdl(rtlDir, VHDL), ...collectHdl(simDir, VHDL)];
    if (vhdl.length > 0) {
      console.error(`本检查器只覆盖 SystemVerilog / Verilog;检测到 ${vhdl.length} 个 VHDL 文件(rtl/ 或 sim/),未做机械检查。`);
      console.error("VHDL 项目请把这一环节记为 NOT_APPLICABLE 并说明原因 —— 不要当成通过。");
      return 2;
    }
    console.error(`rtl/ 下没有 .v/.sv 源码:${rtlDir}`);
    return 2;
  }

  // 已经检查了 SV/Verilog,但 sim/ 里还有 VHDL 测试平台 → 如实点名未检查的部分(走 stdout:这不是错误)
  const uncheckedTb = existsSync(simDir) ? readdirSync(simDir).filter((name) => VHDL.test(name)) : [];
  if (uncheckedTb.length > 0) {
    console.log(`注意:sim/ 下有 ${uncheckedTb.length} 个 VHDL 测试平台(${uncheckedTb.join("、")}),本检查器未检查。`);
  }

  const report = targets.map(([file, isTb]) => ({
    file: relative(moduleRoot, file).split(sep).join("/"),
    issues: checkFile(file, isTb)
  }));
  const failures = report.flatMap((entry) => entry.issues.filter(isFailure));
  const warnings = report.flatMap((entry) => entry.issues.filter((issue) => !isFailure(issue)));

  if (asJson) {
    console.log(JSON.stringify({ module: moduleRoot, files: report, failures: failures.length, warnings: warnings.length }, null, 2));
  } else {
    for (const entry of report) {
      const bad = entry.issues.filter(isFailure).length;
      console.log(`${bad === 0 ? "ok  " : "FAIL"}  ${entry.file}${entry.issues.length === 0 ? "" : `  (${bad} 项阻塞 / ${entry.issues.length - bad} 项警告)`}`);
      for (const issue of entry.issues) {
        console.log(`        ${isFailure(issue) ? "FAIL" : "warn"}  ${issue.line > 0 ? `第 ${issue.line} 行:` : ""}${issue.message}`);
      }
    }
    console.log(
      failures.length === 0
        ? `\nPASS: ${report.length} 个文件,${warnings.length} 项警告(不阻塞)`
        : `\nFAIL (${failures.length} 项阻塞,${warnings.length} 项警告)`
    );
    if (warnings.length > 0 && failures.length === 0) {
      console.log("警告不阻塞门禁,但建议顺手清掉。");
    }
  }
  return failures.length === 0 ? 0 : 1;
}

/** 直接跑本文件时才进 CLI;被 import 时只导出上面那些函数。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
