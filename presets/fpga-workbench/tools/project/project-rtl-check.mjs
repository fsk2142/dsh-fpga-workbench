#!/usr/bin/env node
// 工程 RTL / lint 环节:复用模块级机械规范规则，但入口严格服从工程目录树。
// 规则与宽容度照抄,不自己加严:
//
//   * 用户 2026-09-03 裁决:纯格式检查要宽容。文件头只要求"顶部有分隔条 + 前 15 行内
//     出现全部必填字段";九个小节块只要求名字作为 banner 存在(宽度容忍 84-86),不校验
//     列宽,也不校验顺序。
//   * 用户 2026-09-02 裁决:复位默认高有效。既抓 rst_n 命名,也抓在 rst 上用了
//     低有效(!rst / ~rst / negedge rst)。**例外**:AXI 接口按 AMBA 规范是低有效
//     (`ARESETn` / `aresetn`),照官方,不拦;用户明确要求低有效时也照办(对照 spec 确认)。
//   * Tab / 代码行非英文 / 行尾混用 这三条是**警告**,不阻塞门禁(与 run_checks.py 的
//     WARN_CHECKS 一致);其余是 FAIL。
//   * 三条判据来自实测事故,原来都只查"整个文件里有没有那个字样" —— 于是"看着有、其实没有":
//     ① 断言说明逐条齐全(删掉第一条断言的 Purpose 也照样报 ok);
//     ② 数据比对禁 `!=`(全 X 时 `X != y` 求值为 X,`if (X)` 为假 → 一条错都不报);
//     ③ 成功标记必须与 err_cnt 挂钩(无条件打印 ALL TESTS PASSED 与"成百条断言违例"可以同时成立)。
//
// 用法:node project-rtl-check.mjs [<用户指定工程目录>] [--json]
// 扫 src/rtl/ 的平铺 RTL、src/sim/ 的专用模块简单仿真，以及根 sim/ 的工程级仿真；
// 仿真目录里只有 `tb_*` 按测试平台规则查,helper/行为模型按普通 HDL 规则(F5-02)。
// 另外查工程根 ip/<ip>/timing.json(IP 时序卡)—— 那是**警告**(见 ipCardEntries)。
// 退出码:0 全部通过(可以只有警告) / 1 有 FAIL / 2 用法或环境错误。

import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { checkFile } from "../lib/rtl-check-rules.mjs";
import { VHDL, coverageVerdict, keepSimSupportOnly, uncheckedVhdl } from "../lib/rtl-coverage.mjs";
// 与 module-rtl-check 共用的**稳定 primitives**(SKIP_DIRS / MEASURED_FIELDS / collectHdl /
// isFailure / TESTBENCH 判据 / IP 时序卡校验 / 逐条打印)都在 ../lib/rtl-check-driver.mjs。
// **本入口自己的语义留在下面**:扫哪些目录、`sim-support` 角色、coverage 怎么算、JSON 顶层键
// (`project:`)、平铺 IP 文件提示(F7-03)、summary 文案与退出码。
import { TESTBENCH, collectHdl, ipCardEntries, isFailure, printEntryLines } from "../lib/rtl-check-driver.mjs";

export { collectHdl };

/**
 * F7-03:约定是 `ip/<ip-name>/` 目录;根下平铺的 .xci/.bd/.coe 对不上 timing 卡入口,点出来。
 * 工程特有,留在入口里(模块级的 `rtl/ip/` 不做这条)。
 * @param ipDir - `<工程根>/ip`。
 * @returns 平铺文件对应的检查项(形状与文件项一致)。
 */
function looseIpFileEntries(ipDir) {
  let names;
  try {
    names = readdirSync(ipDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isFile() && /\.(xci|bd|coe)$/iu.test(entry.name))
    .map((entry) => ({
      file: `ip/${entry.name}`,
      issues: [{
        rule: "IP 卡",
        line: 0,
        message: `IP 文件平铺在 ip/ 根下 —— 约定是 ip/<ip-name>/ 一 IP 一目录(放 .xci/.bd/.coe 与 timing.json);请挪进子目录`
      }]
    }));
}

/** 入口。 */
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法:node project-rtl-check.mjs [<用户指定工程目录>] [--json]");
    return 0;
  }
  const asJson = args.includes("--json");
  const root = args.find((arg) => !arg.startsWith("-")) ?? process.cwd();
  const rtlDir = join(root, "src", "rtl");
  const simpleSimDir = join(root, "src", "sim");
  const projectSimDir = join(root, "sim");
  if (!existsSync(rtlDir)) {
    console.error("找不到 src/rtl/:", root);
    return 2;
  }
  // 仿真目录里**只有 `tb_*` 是测试平台**(F5-02):driver/helper/行为模型按普通 HDL 规则查,
  // 不强制成功标记与 err_cnt gate。
  const isTestbenchName = (file) => TESTBENCH.test(file.split(/[\\/]/u).pop() ?? "");
  // 角色三分(E8-05):`hdl` = 自身的综合 RTL(完整结构门禁);`testbench` = tb_*(TB gate);
  // `sim-support` = 仿真辅助代码(package / interface / BFM / 记分板),只查通用规则。
  const simRole = (file) => (isTestbenchName(file) ? "testbench" : "sim-support");
  const targets = [
    ...collectHdl(rtlDir).map((file) => [file, false, "hdl"]),
    ...(existsSync(simpleSimDir) ? collectHdl(simpleSimDir).map((file) => [file, isTestbenchName(file), simRole(file)]) : []),
    ...(existsSync(projectSimDir) ? collectHdl(projectSimDir).map((file) => [file, isTestbenchName(file), simRole(file)]) : [])
  ];
  if (targets.length === 0) {
    const vhdl = [rtlDir, simpleSimDir, projectSimDir].flatMap((dir) => existsSync(dir) ? collectHdl(dir, VHDL) : []);
    if (vhdl.length > 0) {
      console.error(`本检查器只覆盖 SystemVerilog / Verilog；检测到 ${vhdl.length} 个 VHDL 文件，未做机械检查。`);
      return 2;
    }
    console.error("src/rtl、src/sim 与 sim/ 下没有 .v/.sv 源码:", root);
    return 2;
  }
  // E8-06:有 SV 时同树 VHDL 也要报出来,不能写成全覆盖 PASS
  // 第九轮复审②:与模块级共用同一个统计/定性实现(tools/lib/rtl-coverage.mjs)。
  const skippedVhdlFiles = uncheckedVhdl([rtlDir, simpleSimDir, projectSimDir], collectHdl);
  const skippedVhdlRel = skippedVhdlFiles.map((file) => relative(root, file).split(sep).join("/"));
  const verdict = coverageVerdict(targets.length, skippedVhdlFiles);
  const report = [
    ...targets.map(([file, isTb, role]) => ({
      file: relative(root, file).split(sep).join("/"),
      role,
      // sim-support:**白名单**留通用规则(文件头 / Tab / 非英文 / 行尾 / 编译隔离),
      // 其余规则(九小节、设计断言、always_ff 形态、复位极性 …)一律不适用于仿真辅助代码。
      issues: role === "sim-support" ? keepSimSupportOnly(checkFile(file, isTb)) : checkFile(file, isTb)
    })),
    // IP 时序卡:工程根 ip/ 下每个 IP 一张(与文件项同形一起打印);F7-03 的平铺提示并进同一形状。
    ...[
      ...looseIpFileEntries(join(root, "ip")),
      ...ipCardEntries({
        ipDir: join(root, "ip"),
        shownPrefix: "ip",
        probeRoot: root,
        scope: "工程",
        skillHint: "fpga-project-rtl 的「IP 时序卡」,量法同 fpga-module-rtl"
      })
    ].map((entry) => ({ ...entry, role: "ip-card" }))
  ];
  const failures = report.flatMap((entry) => entry.issues.filter(isFailure));
  const warnings = report.flatMap((entry) => entry.issues.filter((issue) => !isFailure(issue)));
  if (asJson) {
    console.log(JSON.stringify({
      project: root,
      files: report,
      skippedVhdl: skippedVhdlRel,
      // 第八轮复审 E8-06 + 第九轮复审⑤:覆盖面要机器可判 —— 有未检查的 VHDL 时不能只报 PASS;
      // checkedFiles 只数 **HDL 文件**,IP 时序卡是虚拟检查项,单列 ipCards。
      checkedFiles: targets.map(([file]) => relative(root, file).split(sep).join("/")),
      skippedFiles: skippedVhdlRel,
      ipCards: report.filter((entry) => entry.role === "ip-card").map((entry) => entry.file),
      coverage: verdict === "full" ? "full" : "partial",
      failures: failures.length,
      warnings: warnings.length
    }, null, 2));
  } else {
    printEntryLines(report);
    if (skippedVhdlRel.length > 0) {
      console.log(`注意:另有 ${skippedVhdlRel.length} 个 VHDL 未做机械检查(${skippedVhdlRel.slice(0, 5).join("、")}${skippedVhdlRel.length > 5 ? " …" : ""}) —— 本检查器只覆盖 .sv/.v,不要把上面的结论当成全覆盖`);
    }
    // 第八轮复审 E8-06:有未检查的 VHDL 时**不能写 PASS** —— 那是"部分覆盖",机器调用会把 PASS
    // 当成"整个工程都过了"。按状态契约定成 PARTIAL(退 2),并写清覆盖了多少、漏了多少。
    const partial = skippedVhdlRel.length > 0;
    if (failures.length > 0) {
      console.log(`\nFAIL (${failures.length} 项阻塞，${warnings.length} 项警告)` + (partial ? `；另有 ${skippedVhdlRel.length} 个 VHDL 未检查` : ""));
    } else if (partial) {
      console.log(`\nPARTIAL: ${report.length} 个文件已检查、${warnings.length} 项警告；另有 ${skippedVhdlRel.length} 个 VHDL **未检查**(本检查器只覆盖 .sv/.v) —— 这**不是**全覆盖通过`);
    } else {
      console.log(`\nPASS: ${report.length} 个文件，${warnings.length} 项警告（不阻塞）`);
    }
  }
  if (failures.length > 0) return 1;
  return skippedVhdlRel.length > 0 ? 2 : 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
