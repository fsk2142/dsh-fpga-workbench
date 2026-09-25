#!/usr/bin/env node
// RTL 环节:模块 RTL 的机械规范检查 —— 从 FPGAWorkFlowKit 的 check_rtl_compliance.py 移植,
// 规则与宽容度照抄,不自己加严:
//
//   * 用户 2026-09-03 裁决:纯格式检查要宽容。文件头只要求"顶部有分隔条 + 前 15 行内
//     出现全部必填字段";九个小节块只要求名字作为 banner 存在(宽度容忍 84-86),不校验
//     列宽,也不校验顺序。
//   * 用户 2026-09-02 裁决:rst / rst_* 一律高有效。既抓 rst_n 命名,也抓在 rst 上用了
//     低有效(!rst / ~rst / negedge rst)。
//   * Tab / 代码行非英文 / 行尾混用 这三条是**警告**,不阻塞门禁(与 run_checks.py 的
//     WARN_CHECKS 一致);其余是 FAIL。
//   * 三条判据来自实测事故,原来都只查"整个文件里有没有那个字样" —— 于是"看着有、其实没有":
//     ① 断言说明逐条齐全(删掉第一条断言的 Purpose 也照样报 ok);
//     ② 数据比对禁 `!=`(全 X 时 `X != y` 求值为 X,`if (X)` 为假 → 一条错都不报);
//     ③ 成功标记必须与 err_cnt 挂钩(无条件打印 ALL TESTS PASSED 与"成百条断言违例"可以同时成立)。
//
// 用法:
//   node module-rtl-check.mjs [<模块目录>] [--json]
// 模块目录默认当前目录;扫 <模块>/rtl 下的 .v/.sv,并顺带检查 <模块>/verif/tb_*.sv。
// 另外查 `rtl/ip/<ip>/timing.json`(IP 时序卡)在不在、能不能解析 —— 那是**警告**(见 ipCardEntries)。
// 退出码:0 全部通过(可以只有警告) / 1 有 FAIL / 2 用法或环境错误。

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { checkFile } from "../lib/rtl-check-rules.mjs";
import { coverageVerdict, shortenList, uncheckedVhdl } from "../lib/rtl-coverage.mjs";
// 与 project-rtl-check 共用的**稳定 primitives**(SKIP_DIRS / MEASURED_FIELDS / collectHdl /
// isFailure / IP 时序卡校验 / 逐条打印)都在 ../lib/rtl-check-driver.mjs。
// **本入口自己的语义留在下面**:扫哪些目录、coverage 怎么算、JSON 怎么拼、summary 文案与退出码。
import { TESTBENCH, collectHdl, ipCardEntries, isFailure, printEntryLines } from "../lib/rtl-check-driver.mjs";

// 对外仍导出 collectHdl:tools/check-fpga-tools.mjs 从本文件取它(旧入口路径保持可用)。
export { collectHdl };

// VHDL 扩展名与覆盖判定统一在 ../lib/rtl-coverage.mjs(第九轮复审②:两个 checker 共用一份)。

/** 入口。 */
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法:node module-rtl-check.mjs [<模块目录>] [--json]");
    return 0;
  }
  const asJson = args.includes("--json");
  const moduleRoot = args.find((arg) => !arg.startsWith("-")) ?? process.cwd();

  const rtlDir = join(moduleRoot, "rtl");
  if (!existsSync(rtlDir)) {
    console.error(`找不到 rtl/ 目录:${rtlDir}`);
    console.error("用法:node module-rtl-check.mjs [<模块目录>] —— 模块目录下要有 rtl/。");
    return 2;
  }

  // 测试平台与验证脚本放 <模块根>/verif/(与结果同目录,按文件名区分)。
  // 扩展名跟设置里选的仿真语言走:.sv / .v 都能认,.vhd 不认(见下面的提示)。
  const verifDir = join(moduleRoot, "verif");
  const testbenches = existsSync(verifDir)
    ? readdirSync(verifDir).filter((name) => TESTBENCH.test(name)).map((name) => join(verifDir, name)).sort()
    : [];

  const targets = [...collectHdl(rtlDir).map((file) => [file, false]), ...testbenches.map((file) => [file, true])];
  // 第九轮复审②:未检查的 VHDL **两个范围都要数**(原来只数 verif/ → `rtl/good.sv + rtl/broken.vhd`
  // 也能打印 PASS)。定性判据与工程级共用 tools/lib/rtl-coverage.mjs,避免两边再漂移。
  const skippedVhdl = uncheckedVhdl([rtlDir, verifDir], collectHdl);
  const verdict = coverageVerdict(targets.length, skippedVhdl);
  if (targets.length === 0) {
    // 只有 VHDL 时不能说"没有源码"(那会让人以为目录是空的);说清本检查器不覆盖 VHDL
    if (verdict === "none") {
      console.error(`本检查器只覆盖 SystemVerilog / Verilog;检测到 ${skippedVhdl.length} 个 VHDL 文件(rtl/ 或 verif/),未做机械检查。`);
      console.error("VHDL 项目请把这一环节记为 NOT_APPLICABLE 并说明原因 —— 不要当成通过。");
      return 2;
    }
    console.error(`rtl/ 下没有 .v/.sv 源码:${rtlDir}`);
    return 2;
  }
  // 那条"还有 VHDL 未检查"的提示**只在非 JSON 输出里打** —— 放这里会污染 `--json` 的 stdout,
  // 消费方就没法直接 parse 了(第九轮复审⑤:JSON 必须可区分未检查文件,那就得是干净的 JSON)。

  // IP 时序卡:与文件项同形一起打印(见 ipCardEntries),但 JSON 里单列 —— 它不是 HDL 文件。
  const ipCards = ipCardEntries({
    ipDir: join(rtlDir, "ip"),
    shownPrefix: "rtl/ip",
    probeRoot: resolve(join(rtlDir, "ip"), "..", ".."),
    scope: "模块",
    skillHint: "fpga-module-rtl 的「IP 时序卡」"
  });
  const report = [
    ...targets.map(([file, isTb]) => ({
      file: relative(moduleRoot, file).split(sep).join("/"),
      issues: checkFile(file, isTb)
    })),
    ...ipCards
  ];
  const failures = report.flatMap((entry) => entry.issues.filter(isFailure));
  const warnings = report.flatMap((entry) => entry.issues.filter((issue) => !isFailure(issue)));

  if (asJson) {
    console.log(JSON.stringify({
      module: moduleRoot,
      files: report,
      // 第九轮复审⑤:已检查文件数只数**HDL 文件**,IP 时序卡是虚拟项、单列出来。
      checkedFiles: targets.map(([file]) => relative(moduleRoot, file).split(sep).join("/")),
      ipCards: ipCards.map((entry) => entry.file),
      skippedFiles: skippedVhdl.map((file) => relative(moduleRoot, file).split(sep).join("/")),
      coverage: verdict === "full" ? "full" : "partial",
      failures: failures.length,
      warnings: warnings.length
    }, null, 2));
  } else {
    printEntryLines(report);
    if (verdict === "partial") {
      console.log(`注意:另有 ${skippedVhdl.length} 个 VHDL 未做机械检查(${shortenList(skippedVhdl)})—— 本检查器只覆盖 .sv/.v,不要把结论当成全覆盖`);
    }
    if (failures.length > 0) {
      console.log(`\nFAIL (${failures.length} 项阻塞,${warnings.length} 项警告)` + (verdict === "partial" ? `;另有 ${skippedVhdl.length} 个 VHDL 未检查` : ""));
    } else if (verdict === "partial") {
      console.log(`\nPARTIAL: ${report.length} 个文件已检查、${warnings.length} 项警告;另有 ${skippedVhdl.length} 个 VHDL **未检查**(本检查器只覆盖 .sv/.v) —— 这**不是**全覆盖通过`);
    } else {
      console.log(`\nPASS: ${report.length} 个文件,${warnings.length} 项警告(不阻塞)`);
    }
    if (warnings.length > 0 && failures.length === 0) {
      console.log("警告不阻塞门禁,但建议顺手清掉。");
    }
  }
  if (failures.length > 0) return 1;
  return verdict === "partial" ? 2 : 0;
}

/** 直接跑本文件时才进 CLI;被 import 时只导出上面那些函数。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
