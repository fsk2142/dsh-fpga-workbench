#!/usr/bin/env node
// 工程 RTL / lint 环节:复用模块级机械规范规则，但入口严格服从工程目录树。
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
// 用法:node project-rtl-check.mjs [<用户指定工程目录>] [--json]
// 扫 src/rtl/ 的平铺 RTL、src/sim/ 的专用模块简单仿真，以及根 sim/ 的工程级仿真；
// 仿真目录里只有 `tb_*` 按测试平台规则查,helper/行为模型按普通 HDL 规则(F5-02)。
// 另外查工程根 ip/<ip>/timing.json(IP 时序卡)—— 那是**警告**(见 ipCardEntries)。
// 退出码:0 全部通过(可以只有警告) / 1 有 FAIL / 2 用法或环境错误。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { evidenceFileInside } from "../lib/stamp.mjs";
import { WARN_ONLY, checkFile } from "../lib/rtl-check-rules.mjs";
import { coverageVerdict, keepSimSupportOnly, uncheckedVhdl } from "../lib/rtl-coverage.mjs";

/**
 * 与旧包一致的跳过目录:生成物、仿真库、版本控制等。
 *
 * `ip` 是刻意加的:外来代码(厂商 IP、他人提供的模块)放在 `ip/` 下,它们不按本工程的格式
 * 规范书写(文件头、九个小节块、断言都不是厂商的写法)。不跳过就会成片误报,而"为让检查过就
 * 重排厂商代码"是绝对不能做的事。检查器只管**本工程自有代码**。
 */
const SKIP_DIRS = new Set([
  "history", ".xil", ".git", "__pycache__", "work", "_synth_gate", "_ip_gen",
  "synth_gate.gen", ".srcs", ".runs", ".hw", ".ip_user_files", ".sim", ".cache",
  ".nano", "rerun", "node_modules", "ip"
]);


/**
 * 端口方向与类型的搭配(用户口径 2026-09-21):input 必须 wire、output 必须 logic、inout 必须 tri。
 *
 * 为什么只查**模块端口**:函数 / 任务的形参写成 `input logic x` 是正常的(那是变量)—— 所以按
 * `function` / `task` 到 `endfunction` / `endtask` 之间跳过(实测踩过:模板里的
 * `function automatic logic saturate (input logic …)` 会被这条误报)。
 */
/**
 * IP 时序卡里**可识别的测量字段**白名单(第四轮 Q4-12)。
 *
 * 为什么要有它:判据原来是"除 `config` 外存在任意 number" → `{"dummy": 1}` 也算过。那只能证明
 * **结构完整**,证明不了"测过"。这里按现役卡的实际字段收敛(延迟/占用拍/边界/跨口正确性几类),
 * 值还要合法(有限、非负)。脚本不假装懂物理意义 —— 最终"这个数是不是真测出来的"由 agent 查日志或重跑判定。
 */
const MEASURED_FIELDS = [
  "read_latency", "read_latency_a", "read_latency_b", "write_latency", "pop_latency", "push_latency",
  "addr_to_dout_edges", "addr_to_doutb_edges", "push_to_dout", "rd_en_to_next", "empty_lag",
  "rst_busy_cycles", "cross_port_correct", "underflow_seen", "overflow_seen", "fwft", "dout_reset_value"
];




/**
 * 工程根 `ip/` 下每个 IP 目录的时序卡(见 `fpga-project-rtl` 的「IP 时序卡」)。
 *
 * 卡是"给人看的前提"(实测出来的读/写延迟、复位占用拍、配置、探针),**缺了不拦门禁** ——
 * 所以它是警告;但它必须被看见:换实现/换器件时读的正是这张卡(实测踩过:FIFO 从厂商 IP 换成
 * XPM 宏,读延迟从 k+2 变 k+1,输出对齐器会少一拍)。只认 `timing.json` 这个名字。
 * @param ipDir - `<工程根>/ip`。
 * @param projectRoot - 工程根(probe 路径相对它核验)。
 * @returns 每个 IP 目录一条检查结果(形状与 {@link checkFile} 的文件项一致,便于一起打印)。
 */
function ipCardEntries(ipDir, projectRoot) {
  let names;
  try {
    names = readdirSync(ipDir, { withFileTypes: true });
  } catch {
    return [];
  }
  // F7-03:约定是 ip/<ip-name>/ 目录;根下平铺的 .xci 对不上 timing 卡入口,点出来
  const loose = names
    .filter((entry) => entry.isFile() && /\.(xci|bd|coe)$/iu.test(entry.name))
    .map((entry) => ({
      file: `ip/${entry.name}`,
      issues: [{
        rule: "IP 卡",
        line: 0,
        message: `IP 文件平铺在 ip/ 根下 —— 约定是 ip/<ip-name>/ 一 IP 一目录(放 .xci/.bd/.coe 与 timing.json);请挪进子目录`
      }]
    }));
  return [
    ...loose,
    ...names
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const shown = `ip/${name}/timing.json`;
      const card = join(ipDir, name, "timing.json");
      const warn = (message) => ({ file: shown, issues: [{ rule: "IP 卡", line: 0, message }] });
      if (!existsSync(card)) {
        return warn(`ip/${name}/ 下没有 timing.json —— 这个 IP 的时序前提(读/写延迟、复位占用拍、配置)没有实测记录;测一份再往下走(格式见 fpga-project-rtl 的「IP 时序卡」,量法同 fpga-module-rtl)`);
      }
      try {
        const parsed = JSON.parse(readFileSync(card, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return warn("timing.json 的顶层要是一个对象(键值对);数组/标量读不出前提,等于没有卡");
        }
        // 卡里必须有这四栏 —— 缺哪一栏,这张卡就说不清"它是什么 / 什么时候测的 / 怎么复核 / 什么配置"(见 fpga-project-rtl)
        const missingFields = ["card", "measured", "probe", "config"].filter((key) => !(key in parsed));
        if (missingFields.length > 0) {
          return warn(`timing.json 缺栏目:${missingFields.join("、")} —— card(这是什么)/ measured(哪天测的)/ probe(拿什么测的)/ config(什么配置)都要有,否则别人没法复核`);
        }
        // 光"键在"还不够(第三轮复审 N-12):空串 / 空对象 / 指向不存在的探针,都是"有张卡但复核不了"。
        const problems = [];
        for (const key of ["card", "measured", "probe"]) {
          if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
            problems.push(`${key} 要是非空字符串(现在是 ${JSON.stringify(parsed[key])})`);
          }
        }
        if (typeof parsed.config !== "object" || parsed.config === null || Object.keys(parsed.config).length === 0) {
          problems.push("config 要是非空对象(不写配置,这卡就说不清是在什么配置下测的)");
        }
        // 探针必须真的在工程里(相对工程根):不然这张卡说的"谁测的"没法复核
        if (typeof parsed.probe === "string" && parsed.probe.trim() !== "") {
          const probeRel = parsed.probe.split(/\s+/u)[0];
          // F6-01/F7-04:词法 + realpath 不越根 + 必须是普通文件(目录/junction 不算探针)
          if (!evidenceFileInside(projectRoot, probeRel)) {
            problems.push(`probe 指的探针不可用:${probeRel}(要写工程根相对的**普通文件**,且真实落点仍在工程内)`);
          }
        }
        // "有实测数值"才是卡的意义 —— 而且要是**可识别的测量字段**(第四轮 Q4-12:光"有个数字"的话
        // `dummy: 1` 也能过,那只是**结构完整**,不是"测过"。脚本不假装懂物理意义,但至少要认得出
        // 它写的是哪一类量,并且值合法(有限、非负)。`config` 里的是配置值(几路、什么模式),不算数。
        const measuredOk = MEASURED_FIELDS.some(
          (key) => typeof parsed[key] === "number" && Number.isFinite(parsed[key]) && parsed[key] >= 0
        );
        if (!measuredOk) {
          problems.push(
            `没有任何**可识别的实测字段**(白名单:${MEASURED_FIELDS.slice(0, 8).join(" / ")} …)—— ` +
              "写个普通数字不算「测过」:结构完整 ≠ 测量已核验"
          );
        }
        if (problems.length > 0) return warn(`timing.json 不完整:${problems.join(";")}`);
      } catch (error) {
        return warn(`timing.json 解析不了(${String(error?.message ?? error)}) —— 卡读不出来等于没有卡`);
      }
      return { file: shown, issues: [] };
    })
  ];
}








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
 * 一条问题是否阻塞门禁。
 * @param issue - {@link checkFile} 的产出。
 * @returns 是 FAIL 时为 true。
 */
const isFailure = (issue) => !WARN_ONLY.has(issue.rule);

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
    // IP 时序卡:工程根 ip/ 下每个 IP 一张(与文件项同形一起打印)
    ...ipCardEntries(join(root, "ip"), root).map((entry) => ({ ...entry, role: "ip-card" }))
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
    for (const entry of report) {
      const bad = entry.issues.filter(isFailure).length;
      console.log(`${bad === 0 ? "ok  " : "FAIL"}  ${entry.file}${entry.issues.length === 0 ? "" : `  (${bad} 项阻塞 / ${entry.issues.length - bad} 项警告)`}`);
      for (const issue of entry.issues) {
        console.log(`        ${isFailure(issue) ? "FAIL" : "warn"}  ${issue.line > 0 ? `第 ${issue.line} 行:` : ""}${issue.message}`);
      }
    }
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
