// 自带工具脚本的功能自检(check-rtl.mjs / stage-status.mjs)。
//
// 为什么必须机器验:这两个脚本是"确定性检查",价值全在判得准。误报一次,人就再也不信它了。
// 所以这里用真文件跑,断言的是会真出错的性质:
//   · 合规的样本必须全过;违规的样本每类规则都要报出来(规则名对得上)
//   · **插件自带的模板必须过自己的检查器** —— 我们发的模板和检查器不能互相矛盾
//   · Tab / 代码行非英文 / 行尾混用 只算警告,不能阻塞门禁(与旧包 WARN_CHECKS 一致)
//   · 测试平台不要求九个小节块与设计断言(模板里的 tb.sv 本来就没有)
//   · 状态汇总要认得 结论 / spec_state,认得出"有产物没结论",找不到约定文件时退 2
//
// 沙箱限制:node 不能开管道抓子进程输出,所以内容断言直接 import 函数;退出码单独用
// spawnSync(stdio:"ignore") 验(不开管道,能拿到 status)。
import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkFile, collectHdl } from "../presets/fpga-workbench/tools/check-rtl.mjs";
import { applyScaffold, planScaffold } from "../presets/fpga-workbench/tools/init-scaffold.mjs";
import { collect, findConvention, readVerdict } from "../presets/fpga-workbench/tools/stage-status.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "presets", "fpga-workbench", "tools");
const TEMPLATES = join(ROOT, "presets", "fpga-workbench", "templates");
const SANDBOX = join(ROOT, ".tmp", "fpga-tools-check");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// ── 造样本 ──────────────────────────────────────────────────────────────────
const banner = (text) => `//${text.padEnd(80)}//`;
const rule = `//${"=".repeat(80)}//`;
const field = (text) => `// ${text}`.padEnd(82) + "//";

const header = (name) => [
  rule,
  field(`File Name    : ${name}.sv`),
  field(`Module Name  : ${name}`),
  field("Created Date : 2026-09-18"),
  field("Updated Date : 2026-09-18"),
  field("Version      : v1.0"),
  field("Author       : test"),
  field("Copyright    : Copyright (c) 2026 test. All rights reserved."),
  field("Open Source  : This file is proprietary and NOT open source."),
  rule,
  field(`${name} : self-check fixture`),
  rule
].join("\n");

const NINE = [
  banner("Local Parameters"), "    localparam int unsigned W = 8;", "",
  banner("Types"), "    typedef enum logic [0:0] { ST_IDLE, ST_RUN } state_t;", "",
  banner("Registers"), "    logic [7:0] dout_q;", "",
  banner("Combinational Logic"), "    always_comb begin", "        dout = dout_q;", "    end", "",
  banner("Sequential Logic"), "    always_ff @(posedge clk) begin", "        if (rst) begin",
  "            dout_q <= 8'h00;", "        end else begin", "            dout_q <= din;", "        end", "    end", "",
  banner("Functions Module"), banner("Task Module"), banner("Module Instantiation"), "",
  banner("Assertions"),
  "    // Purpose  : reset must clear the output",
  "    // Trigger  : posedge clk while rst is high",
  "    // Failure  : reset did not clear the register",
  "    a_reset_zero : assert property (@(posedge clk) rst |-> dout_q == 8'h00);"
].join("\n");

const goodRtl = [
  header("good"), "`resetall", "`timescale 1ns/1ps", "`default_nettype none", "",
  "module good (", "    input  wire        clk,", "    input  wire        rst,",
  "    input  wire [7:0]  din,", "    output logic [7:0] dout", ");", "", NINE, "",
  "endmodule", "`resetall", "`default_nettype wire", ""
].join("\n");

const goodTb = [
  header("tb_good"), "`resetall", "`timescale 1ns/1ps", "`default_nettype none", "",
  "module tb_good;", "    integer err_cnt = 0;", "    initial begin",
  "        if (err_cnt == 0) $display(\"ALL TESTS PASSED (err_cnt=0)\");",
  "        else $fatal(1, \"TB FAILED\");", "        $finish;", "    end", "endmodule",
  "`resetall", "`default_nettype wire", ""
].join("\n");

// 每类规则各踩一脚(行尾混用单独用 mixed.sv 测,行内中文注释不算违规)
const badRtl = [
  "// 故意违规的样本", "", "module bad (", "    input  clk,", "    input  rst,", "    output dout", ");", "",
  "    always_ff @(posedge clk or negedge rst) begin", "        if (!rst) begin", "            q <= 1'b0;",
  "\tend", "        end", "        else begin", "            q <= din;", "        end",
  "    end", "", "    logic [7:0] 数据;", "", "endmodule", ""
].join("\n");

for (const dir of ["good-mod/rtl", "good-mod/sim", "bad-mod/rtl", "bad-mod/ip", "status-demo/rtl", "status-demo/sim"]) {
  mkdirSync(join(SANDBOX, dir), { recursive: true });
}
writeFileSync(join(SANDBOX, "good-mod", "rtl", "good.sv"), goodRtl);
writeFileSync(join(SANDBOX, "good-mod", "sim", "tb_good.sv"), goodTb);
writeFileSync(join(SANDBOX, "bad-mod", "rtl", "bad.sv"), badRtl);
writeFileSync(join(SANDBOX, "bad-mod", "ip", "vendor.sv"), badRtl); // ip/ 不该被扫
writeFileSync(join(SANDBOX, ".fpga-workbench.json"), JSON.stringify({ kind: "module", spec: "spec/spec.md" }));
// 机械检查报告与 RTL 同目录;审查报告在模块根(按需,不占目录)
writeFileSync(join(SANDBOX, "status-demo", "rtl", "lint.md"), "# lint\n\n- 结论:PASS\n");
writeFileSync(join(SANDBOX, "status-demo", "sim", "sim.md"), "# sim\n\n跑了一遍,没有发现异常。\n");

// ── check-rtl:合规与违规 ────────────────────────────────────────────────────
const blocking = (file, isTb) => checkFile(file, isTb);
const goodIssues = blocking(join(SANDBOX, "good-mod", "rtl", "good.sv"), false);
check(goodIssues.length === 0, "合规模块零问题", goodIssues.map((i) => i.message).join("; "));
const tbIssues = blocking(join(SANDBOX, "good-mod", "verif", "sim", "tb_good.sv"), true);
check(tbIssues.length === 0, "合规测试平台零问题(不要求九个小节块与断言)", tbIssues.map((i) => i.message).join("; "));

const badIssues = blocking(join(SANDBOX, "bad-mod", "rtl", "bad.sv"), false);
const rules = new Set(badIssues.map((issue) => issue.rule));
for (const expected of ["文件头", "编译隔离", "端口类型", "always_ff", "复位极性", "end/else", "九个小节块", "设计断言", "Tab 字符", "代码行非英文"]) {
  check(rules.has(expected), `违规样本报出了「${expected}」`);
}
const tabIssue = badIssues.find((issue) => issue.rule === "Tab 字符");
check(tabIssue?.line === 12, `Tab 那条报了准确行号(实际 ${String(tabIssue?.line)})`);

// ── 警告要报出来,但不阻塞门禁 ──────────────────────────────────────────────
//
// 原来这里写的是 `.every((issue) => issue.rule.startsWith("Tab") || true)` —— 末尾那个
// `|| true` 让断言恒真,等于没验(是外部 review 指出来的)。现在改成两条真能失败的断言:
// 三条警告规则都被**报出来**(不漏报),以及"只有警告时 CLI 不拦门禁"(退出码 0,下面 CLI 那组验)。
const warnOnly = ["Tab 字符", "代码行非英文", "行尾混用"];
const crlfFile = join(SANDBOX, "mixed-mod", "rtl", "mixed.sv");
mkdirSync(dirname(crlfFile), { recursive: true });
writeFileSync(join(SANDBOX, "mixed-mod", "rtl", "mixed.sv"), goodRtl.replace("module good (", "module mixed (").replace(/\n/gu, "\r\n").replace("`resetall\r\n", "`resetall\n"));
const mixedIssues = blocking(join(SANDBOX, "mixed-mod", "rtl", "mixed.sv"), false);
check(
  mixedIssues.some((issue) => issue.rule === "行尾混用") && !mixedIssues.some((issue) => issue.rule === "九个小节块"),
  "行尾混用会被抓出来(其它规则仍通过)"
);
const reportedWarnRules = new Set([...rules, ...mixedIssues.map((issue) => issue.rule)]);
for (const rule of warnOnly) {
  check(reportedWarnRules.has(rule), `警告规则「${rule}」会被报出来(不是静默丢掉)`);
}

// 只有警告的模块:门口不该拦(否则真正的坏代码与"顺手清一下"的警告混为一谈)
mkdirSync(join(SANDBOX, "warn-mod", "rtl"), { recursive: true });
writeFileSync(join(SANDBOX, "warn-mod", "rtl", "warn.sv"), goodRtl.replace("    logic [7:0] dout_q;", "    logic [7:0] dout_q;\t// Tab"));
const warnOnlyIssues = blocking(join(SANDBOX, "warn-mod", "rtl", "warn.sv"), false);
check(
  warnOnlyIssues.length > 0 && warnOnlyIssues.every((issue) => warnOnly.includes(issue.rule)),
  `警告样本只报警告(实际 ${warnOnlyIssues.map((issue) => issue.rule).join("、") || "什么都没报"})`
);

// ── 自带模板必须过自己的检查器 ──────────────────────────────────────────────
const templateRtl = blocking(join(TEMPLATES, "rtl.sv"), false);
check(templateRtl.length === 0, "自带 RTL 模板过检查器", templateRtl.map((i) => i.message).join("; "));
const templateTb = blocking(join(TEMPLATES, "tb.sv"), true);
check(templateTb.length === 0, "自带测试平台模板过检查器", templateTb.map((i) => i.message).join("; "));

// ── 扫描范围:以 rtl/ 为根,跳过生成目录 ─────────────────────────────────────
mkdirSync(join(SANDBOX, "bad-mod", "rtl", "work"), { recursive: true });
writeFileSync(join(SANDBOX, "bad-mod", "rtl", "work", "stale.sv"), badRtl);
const scanned = collectHdl(join(SANDBOX, "bad-mod", "rtl")).map((file) => file.replace(/\\/gu, "/"));
check(
  scanned.length > 0 && scanned.every((file) => file.includes("/bad-mod/rtl/")),
  `扫描以 rtl/ 为根(实际 ${scanned.length} 个)`
);
check(scanned.some((file) => file.endsWith("bad.sv")), "rtl/ 下的源码被收到");
check(!scanned.some((file) => file.includes("/work/")), "跳过 work/ 这类生成目录(仿真库不在检查范围)");

// ── stage-status ───────────────────────────────────────────────────────────
check(
  findConvention(join(SANDBOX, "status-demo", "rtl")) === join(SANDBOX, ".fpga-workbench.json"),
  "从子目录向上能找到约定文件"
);
check(findConvention(join(ROOT, "tools")) === undefined, "没有约定文件时返回 undefined(调用方要退 2)");
// 环节名是 rtl,但报告文件叫 lint.md(报告与 RTL 同目录)—— 两者都要对上
check(readVerdict(join(SANDBOX, "status-demo", "rtl", "lint.md"), "rtl")?.verdict === "PASS", "读得出 `结论:PASS`");

const fullWidth = join(SANDBOX, "status-demo", "sim", "full.md");
writeFileSync(fullWidth, "# sim\n\n结论：FAIL\n");
check(readVerdict(fullWidth, "sim")?.verdict === "FAIL", "全角冒号的结论也认");
writeFileSync(join(SANDBOX, "status-demo", "spec.md"), "spec_state: confirmed\n");
check(readVerdict(join(SANDBOX, "status-demo", "spec.md"), "spec")?.verdict === "CONFIRMED", "spec 环节用 spec_state 兜底");

// SANDBOX 不清理:上一次跑留下的 review.md 会让"未做(按需)"这条测不准,先清掉。
// spec/spec.md 则一律重写,保证两条断言既确定又能反复跑。
const reviewFile = join(SANDBOX, "status-demo", "review.md");
if (existsSync(reviewFile)) unlinkSync(reviewFile);
mkdirSync(join(SANDBOX, "status-demo", "spec"), { recursive: true });
writeFileSync(join(SANDBOX, "status-demo", "spec", "spec.md"), "spec_state: confirmed\n");

const rows = collect(join(SANDBOX, "status-demo"), ["spec", "rtl", "sim", "comp", "review"]);
const byStage = new Map(rows.map((row) => [row.stage, row.state]));
check(byStage.get("rtl") === "PASS", `rtl 读的是 rtl/lint.md(实际 ${String(byStage.get("rtl"))})`);
check(byStage.get("sim") === "有产物但没写结论", `没写结论的文件被认出来(实际 ${String(byStage.get("sim"))})`);
check(byStage.get("comp") === "未开始", `没有目录的环节是"未开始"(实际 ${String(byStage.get("comp"))})`);
check(byStage.get("spec") === "CONFIRMED", `spec 读的是 spec/spec.md 里的 spec_state(实际 ${String(byStage.get("spec"))})`);
check(byStage.get("review") === "未做(按需)", `审查没做过时是"未做(按需)",不误报成未开始(实际 ${String(byStage.get("review"))})`);

// 审查的结论是 approved / changes requested / blocked —— 读不出来就等于审查白做
// (认不出来只影响显示:这个脚本是汇总,不是门禁)
writeFileSync(reviewFile, "# review\n\n结论:APPROVED\n");
check(readVerdict(reviewFile, "review")?.verdict === "APPROVED", "读得出 `结论:APPROVED`");
const reviewRow = collect(join(SANDBOX, "status-demo"), ["review"]).at(0);
check(reviewRow.state === "APPROVED" && reviewRow.valid === true, "审查结论被当成合法取值(实际 " + String(reviewRow.state) + "/" + String(reviewRow.valid) + ")");
writeFileSync(reviewFile, "# review\n\n结论:CHANGES_REQUESTED\n");
check(
  readVerdict(reviewFile, "review")?.verdict === "CHANGES_REQUESTED"
    && collect(join(SANDBOX, "status-demo"), ["review"]).at(0).valid === true,
  "读得出 `结论:CHANGES_REQUESTED`"
);
writeFileSync(reviewFile, "# review\n\n结论:changes requested\n");
check(readVerdict(reviewFile, "review")?.verdict === "CHANGES", "写成两词也至少读得出前半(不 gag)");

// ── init-scaffold:一次建好模块 / 工程的骨架 ────────────────────────────────
// 目录名带时间戳:这个自检会反复跑,而 SANDBOX 不清理 —— 用固定名字的话第二次跑就"全都已存在",
// created 数为 0,断言会误报(fixture 得每次都是新的)。
const stamp = String(Date.now());
const scaffoldMod = join(SANDBOX, `scaffold-mod-${stamp}`);
const modulePlan = planScaffold(scaffoldMod, { kind: "module" });
check(modulePlan.dirs.length === 7, `模块级骨架 7 个目录(6 个环节 + spec/explore;实际 ${modulePlan.dirs.length})`);
check(
  modulePlan.dirs.some((dir) => dir.endsWith("rtl")) && !modulePlan.dirs.some((dir) => dir.endsWith("lint")),
  "机械检查报告跟 RTL 同目录,所以不建 lint/ 目录"
);
check(
  !modulePlan.dirs.some((dir) => dir.endsWith("review")),
  "审查是按需能力,不占目录(报告写 <模块根>/review.md)"
);
check(modulePlan.anchors.length === 1 && modulePlan.anchors[0].value.kind === "module", "模块级写一个 kind: module 的锚点");
check(modulePlan.anchors[0].value.spec === "spec/spec.md", "锚点里的 spec 路径相对模块根");
check(
  modulePlan.dirs.some((dir) => dir.endsWith(join("spec", "explore"))),
  "给 spec 建 explore(探索产物有地方放)"
);

const dryRun = applyScaffold(modulePlan, { dryRun: true });
check(
  dryRun.created.length === modulePlan.dirs.length + 1 && !existsSync(scaffoldMod),
  "--dry-run 只报告不落盘(根目录都没建出来)"
);

const applied = applyScaffold(modulePlan, {});
check(
  applied.created.length === modulePlan.dirs.length + 1,
  `落盘:${modulePlan.dirs.length} 个目录 + 1 个锚点(实际 ${applied.created.length})`
);
check(
  existsSync(join(scaffoldMod, ".fpga-workbench.json")) && existsSync(join(scaffoldMod, "sim")),
  "锚点与环节文件夹都建出来了"
);

// 幂等 + 不覆盖已有锚点(用户可能在锚点里加了字段)
const anchorFile = join(scaffoldMod, ".fpga-workbench.json");
writeFileSync(anchorFile, '{"kind":"module","spec":"spec/spec.md","用户加的字段":1}\n');
const secondRun = applyScaffold(modulePlan, {});
check(secondRun.created.length === 0, "幂等:第二次不新建任何东西");
check(readFileSync(anchorFile, "utf8").includes("用户加的字段"), "已有锚点不被覆盖");
applyScaffold(modulePlan, { force: true });
check(!readFileSync(anchorFile, "utf8").includes("用户加的字段"), "--force 才重建锚点");

// 工程级 + 每个模块一套
const scaffoldPrj = join(SANDBOX, `scaffold-prj-${stamp}`);
const projectPlan = planScaffold(scaffoldPrj, { kind: "project", modules: ["uart", "ddr"] });
check(projectPlan.anchors.length === 3, `工程 + 2 模块 → 3 个锚点(实际 ${projectPlan.anchors.length})`);
check(
  projectPlan.anchors[0].value.kind === "project" && projectPlan.anchors[0].value.spec === "project/spec/spec.md",
  "工程锚点写 kind: project 且指向 project/spec/spec.md"
);
check(projectPlan.dirs.some((dir) => dir.endsWith(join("project", "board"))), "建了工程级的 board/");
check(
  projectPlan.dirs.some((dir) => dir.endsWith(join("uart", "sim"))) && projectPlan.dirs.some((dir) => dir.endsWith(join("ddr", "timing"))),
  "每个模块各自一套模块级文件夹"
);

// ── CLI 退出码 ─────────────────────────────────────────────────────────────
const run = (script, args) => spawnSync(process.execPath, [join(TOOLS, script), ...args], { stdio: "ignore" }).status;
check(run("check-rtl.mjs", [join(SANDBOX, "good-mod")]) === 0, "check-rtl 合规 → 退出码 0");
check(run("check-rtl.mjs", [join(SANDBOX, "bad-mod")]) === 1, "check-rtl 违规 → 退出码 1");
check(run("check-rtl.mjs", [join(SANDBOX, "warn-mod")]) === 0, "check-rtl 只有警告 → 退出码 0(警告不拦门禁)");
check(run("check-rtl.mjs", [join(SANDBOX, "no-such-mod")]) === 2, "check-rtl 没有 rtl/ → 退出码 2");
check(run("stage-status.mjs", [join(SANDBOX, "status-demo")]) === 0, "stage-status 有约定文件 → 0");
check(run("stage-status.mjs", [join(ROOT, "tools")]) === 2, "stage-status 没约定文件 → 2");
check(run("init-scaffold.mjs", []) === 2, "init-scaffold 不给根目录 → 退出码 2");
check(run("init-scaffold.mjs", [join(SANDBOX, "scaffold-cli"), "--kind", "bogus"]) === 2, "--kind 非法 → 退出码 2");
check(run("init-scaffold.mjs", [join(SANDBOX, "scaffold-cli")]) === 0, "建模块骨架 → 退出码 0");
check(
  existsSync(join(SANDBOX, "scaffold-cli", "rtl")) && existsSync(join(SANDBOX, "scaffold-cli", ".fpga-workbench.json")),
  "CLI 真的把骨架建出来了"
);
check(run("init-scaffold.mjs", [join(SANDBOX, "scaffold-cli")]) === 0, "重复建同一目录也返回 0(幂等)");

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 自带工具脚本判定正确(含自带模板自洽)");
if (failures.length > 0) process.exitCode = 1;
