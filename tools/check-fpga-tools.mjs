// 自带工具脚本的功能自检(setup-scaffold / module-rtl-new / module-rtl-check / module-verif-new / module-synth-new)。
//
// 为什么必须机器验:这两个脚本是"确定性检查",价值全在判得准。误报一次,人就再也不信它了。
// 所以这里用真文件跑,断言的是会真出错的性质:
//   · 合规的样本必须全过;违规的样本每类规则都要报出来(规则名对得上)
//   · **插件自带的模板必须过自己的检查器** —— 我们发的模板和检查器不能互相矛盾
//   · Tab / 代码行非英文 / 行尾混用 只算警告,不能阻塞门禁(与旧包 WARN_CHECKS 一致)
//   · 测试平台不要求九个小节块与设计断言(模板里的 tb.sv 本来就没有)
//   · 状态汇总要认得 结论 / spec_state,认得出"有产物没结论",找不到约定文件时退 2
//   · `--force` 覆盖**可恢复**:旧内容留同目录 `.bak-<时间戳>` 快照,失败时原文件不动,
//     且**失败路径不再删除**临时/半成品文件(零删除:路径写进错误信息,由使用者处置)
//   · 路径边界**不是只看词法就算完**:junction / 符号链接的真实落点必须仍在根里(用**真 junction**
//     定向验证,造不出来就明说跳过),拒绝时把**真实落点**打出来
//   · 骨架失败时**如实说已经发生了什么**(建了哪些目录 / 写了哪些文件 / 留下哪些快照),
//     不谎报"原有文件没有改动";落盘前先做一次全量可写性预检(只读目标提前失败)
//   · run.do 不替用户猜:多 TB 无 TOP / 同名文件内容不同 → 退出码 1(有 ModelSim 时真跑夹具;
//     这台机器没有仿真器就明确跳过 —— 源码自检不该因为没装 ModelSim 变红)
//
// 沙箱限制:node 不能开管道抓子进程输出,所以内容断言直接 import 函数;退出码单独用
// spawnSync(stdio:"ignore") 验(不开管道,能拿到 status)。要点 run.do 的 `[ME]` 输出时,
// 把 stdout 重定向到**文件句柄**再读文件(那不是管道)。
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, copyFileSync, mkdirSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkFile, collectHdl } from "../presets/fpga-workbench/tools/module/module-rtl-check.mjs";
import { INSTRUCTION_FILE, applyScaffold, planScaffold, readModeRules } from "../presets/fpga-workbench/tools/setup-scaffold.mjs";
import { defaultDestination, renderTemplate } from "../presets/fpga-workbench/tools/lib/stamp.mjs";
import { TEMP_GRACE_MS, listTempLeftovers } from "../lib/toolchain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "presets", "fpga-workbench", "tools");
// 级别落到目录上:模块级命令在 tools/module/(工程级的以后放 tools/project/)
const MODULE_TOOLS = join(TOOLS, "module");
const TEMPLATES = join(ROOT, "presets", "fpga-workbench", "templates");
const SANDBOX = join(ROOT, ".tmp", `fpga-tools-check-${String(process.pid)}`);
// 沙箱名带进程号。**开头/结尾都不再删沙箱**(用户定案:绝不永久删除)—— 只把上次留下的列出来。
// 代价是 `.tmp/` 会一直增长,清单打出来供人工处置;别为了"干净"在这里加回删除调用。
const staleSandboxes = listTempLeftovers(join(ROOT, ".tmp"), ["fpga-tools-check"], TEMP_GRACE_MS);
if (staleSandboxes.length > 0) {
  console.log(`(.tmp/ 里有 ${staleSandboxes.length} 项上次留下的自检沙箱,按用户定案不删除、只报告)`);
}

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

for (const dir of ["good-mod/rtl", "good-mod/verif", "bad-mod/rtl", "bad-mod/ip", "status-demo/rtl", "status-demo/verif"]) {
  mkdirSync(join(SANDBOX, dir), { recursive: true });
}
writeFileSync(join(SANDBOX, "good-mod", "rtl", "good.sv"), goodRtl);
writeFileSync(join(SANDBOX, "good-mod", "verif", "tb_good.sv"), goodTb);
writeFileSync(join(SANDBOX, "bad-mod", "rtl", "bad.sv"), badRtl);
writeFileSync(join(SANDBOX, "bad-mod", "ip", "vendor.sv"), badRtl); // ip/ 不该被扫
writeFileSync(join(SANDBOX, ".fpga-workbench.json"), JSON.stringify({ kind: "module", spec: "spec/spec.md" }));

// ── check-rtl:合规与违规 ────────────────────────────────────────────────────
const blocking = (file, isTb) => checkFile(file, isTb);
const goodIssues = blocking(join(SANDBOX, "good-mod", "rtl", "good.sv"), false);
check(goodIssues.length === 0, "合规模块零问题", goodIssues.map((i) => i.message).join("; "));
// 测试平台与 RTL 同处一套骨架,但它在 verif/ 下(仿真与比对是同一个环节,没有 sim/ 这一层)
const tbIssues = blocking(join(SANDBOX, "good-mod", "verif", "tb_good.sv"), true);
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

// 端口**写法**问题(类型没写全)同样只警告:排版/写法错了不会让结论错 —— 实测吃过亏:一个跑得通、
// 仿真全过的平台,因为端口写法被报 3 项阻塞 FAIL,排版拿到了和功能失败一样的红色,人就不再看它了。
// 样本从合规样本改出来(**只动端口声明那几行**),所以它身上只该有这一类问题:报出来(不静默消失)
// 但不拦门禁(退出码 0,在下面 CLI 那一组验)。
const styleFile = join(SANDBOX, "style-mod", "rtl", "style.sv");
mkdirSync(dirname(styleFile), { recursive: true });
writeFileSync(
  styleFile,
  goodRtl
    .replace("    input  wire        clk,", "    input              clk,")
    .replace("    input  wire        rst,", "    input              rst,")
);
const styleIssues = blocking(styleFile, false);
check(
  styleIssues.length > 0 && styleIssues.every((issue) => issue.rule === "端口类型"),
  `端口写法样本报出来的只有「端口类型」(实际 ${styleIssues.map((issue) => `${issue.rule}@${issue.line}`).join("、") || "什么都没报"})`
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

// 外来代码(厂商 IP / 他人模块)放 rtl/ip/ —— 它不按本模块的格式规范检查,不跳过就会成片误报
mkdirSync(join(SANDBOX, "ip-skip-mod", "rtl", "ip"), { recursive: true });
writeFileSync(join(SANDBOX, "ip-skip-mod", "rtl", "good.sv"), goodRtl);
writeFileSync(join(SANDBOX, "ip-skip-mod", "rtl", "ip", "vendor_bad.sv"), badRtl);
const ipSkipped = collectHdl(join(SANDBOX, "ip-skip-mod", "rtl"));
check(
  ipSkipped.length === 1 && ipSkipped[0].endsWith("good.sv"),
  `rtl/ip/ 下的外来代码被跳过(实际扫到 ${ipSkipped.length} 个文件)`
);

// ── init-scaffold:一次建好模块 / 工程的骨架 ────────────────────────────────
// 目录名带时间戳:这个自检会反复跑,而 SANDBOX 不清理 —— 用固定名字的话第二次跑就"全都已存在",
// created 数为 0,断言会误报(fixture 得每次都是新的)。
const stamp = String(Date.now());
const scaffoldMod = join(SANDBOX, `scaffold-mod-${stamp}`);
const modulePlan = planScaffold(scaffoldMod, { kind: "module" });
check(modulePlan.dirs.length === 5, `模块级骨架 5 个目录(4 个环节 + spec/explore;实际 ${modulePlan.dirs.length})`);
check(
  modulePlan.dirs.some((dir) => dir.endsWith("rtl")) && !modulePlan.dirs.some((dir) => dir.endsWith("lint")),
  "机械检查报告跟 RTL 同目录,所以不建 lint/ 目录"
);
check(
  modulePlan.dirs.some((dir) => dir.endsWith("verif")) && !modulePlan.dirs.some((dir) => dir.endsWith("comp")),
  "验证环节的目录是 verif/(不叫 comp)"
);
check(
  !modulePlan.dirs.some((dir) => dir.endsWith("sim")),
  "不建 sim/ 目录:仿真与比对合成 verif 环节,测试平台落在 verif/ 下"
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
  dryRun.created.length === modulePlan.dirs.length + 2 && !existsSync(scaffoldMod),
  "--dry-run 只报告不落盘(根目录都没建出来)"
);

const applied = applyScaffold(modulePlan, {});
check(
  applied.created.length === modulePlan.dirs.length + 2,
  `落盘:${modulePlan.dirs.length} 个目录 + 锚点 + 工作区指令(实际 ${applied.created.length})`
);
check(
  existsSync(join(scaffoldMod, ".fpga-workbench.json")) && existsSync(join(scaffoldMod, "verif")),
  "锚点与环节文件夹都建出来了"
);

// 工作区指令(用户口径 2026-09-19):骨架顺带落一份 AGENTS.fpga.md,正文从 README 的规则区块抽
const instructionPath = join(scaffoldMod, "AGENTS.fpga.md");
check(modulePlan.instruction === instructionPath, `plan 里给的是 <根>/AGENTS.fpga.md(实际 ${String(modulePlan.instruction)})`);
const rulesText = readModeRules();
check(
  rulesText.includes("FPGA 开发模式的工作区规则") && rulesText.split("\n").length >= 8,
  `规则正文抽出来了(${rulesText.split("\n").length} 行)`
);
check(!rulesText.includes("<!--"), "抽出来的正文不含 HTML 标记(落盘给人读的)");
const written = readFileSync(instructionPath, "utf8");
check(written === rulesText, "落盘的正文与抽取结果逐字节一致");
check(!written.startsWith("\uFEFF"), "落盘的指令文件不带 BOM");

// 幂等 + 不覆盖已有锚点(用户可能在锚点里加了字段)
const anchorFile = join(scaffoldMod, ".fpga-workbench.json");
writeFileSync(anchorFile, '{"kind":"module","spec":"spec/spec.md","用户加的字段":1}\n');
const secondRun = applyScaffold(modulePlan, {});
check(secondRun.created.length === 0, "幂等:第二次不新建任何东西");
check(readFileSync(anchorFile, "utf8").includes("用户加的字段"), "已有锚点不被覆盖");
// 用户按项目改过的工作区指令更不能被覆盖 —— 这是我们写进他仓库的文件,覆盖等于改他的东西
const customInstruction = "# 我按项目改过了\n";
writeFileSync(instructionPath, customInstruction);
applyScaffold(modulePlan, {});
check(readFileSync(instructionPath, "utf8") === customInstruction, "已有的 AGENTS.fpga.md 不被覆盖(用户改过的那份留着)");
applyScaffold(modulePlan, { force: true });
check(readFileSync(anchorFile, "utf8").includes("用户加的字段") === false, "--force 才重建锚点");
check(readFileSync(instructionPath, "utf8") === rulesText, "--force 才重写工作区指令");

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
  projectPlan.dirs.some((dir) => dir.endsWith(join("uart", "verif"))) && projectPlan.dirs.some((dir) => dir.endsWith(join("ddr", "synth"))),
  "每个模块各自一套模块级文件夹"
);

// ── 起文件(module-rtl-new / module-verif-new / module-synth-new:各环节一个入口,只替模块名) ──
const bundledRtl = readFileSync(join(TEMPLATES, "rtl.sv"), "utf8");
const rendered = renderTemplate(bundledRtl, "UartRx");
check(rendered.replaced.join(",") === "ModuleName", `只替模块名(实际替了 ${rendered.replaced.join("、") || "无"})`);
check(!rendered.text.includes("<ModuleName>"), "模块名占位符替干净了");
check(rendered.text.includes("<DATE>") && rendered.text.includes("<Author>"), "日期 / 作者不动(内容归模板自己管)");
check(rendered.remaining.includes("DATE") && rendered.remaining.includes("Author"), "没替的占位符会被提示出来");

// 自带 TB 模板的判定契约:两条判据字符串必须在,且模板里不能再写"err_cnt>0 会非零退出"——
// ModelSim 批处理下 $fatal 不改退出码(2020.4 实测),照旧说法写会让人以为看退出码就能抓到失败。
const bundledTb = readFileSync(join(TEMPLATES, "tb.sv"), "utf8");
check(
  bundledTb.includes("ALL TESTS PASSED (err_cnt=0)") && bundledTb.includes("TB FAILED: err_cnt="),
  "自带 TB 模板里两条判据字符串都在(成功标记 + 失败标记),脚本靠它们判成败"
);
check(
  /does NOT make vsim exit non-zero/u.test(bundledTb) && !/must exit non-zero/u.test(bundledTb),
  "自带 TB 模板写明 $fatal 不改 vsim 退出码(不是'必须非零退出'那种说法)"
);

// 自带 run.do 模板(verif 环节的批处理仿真脚本):`--kind run-do` 起的就是它。
// 那几条踩过的坑是"退出码可信"的全部依据(跳 stub / onfinish stop / gate 里 -code 1),缺一段都不能按退出码判。
const bundledRunDoPath = join(TEMPLATES, "run.do");
const bundledRunDoExists = existsSync(bundledRunDoPath);
const bundledRunDo = bundledRunDoExists ? readFileSync(bundledRunDoPath, "utf8") : "";
check(bundledRunDoExists, "自带 run.do 模板存在(module-verif-new --kind run-do 起的就是它)");
for (const marker of ["*_stub.*", "onfinish stop", "quit -f -code 1", "ALL TESTS PASSED"]) {
  check(bundledRunDo.includes(marker), `自带 run.do 模板里有「${marker}」`);
}

// ── run.do 的"不替你猜":多 TB 不给 TOP → 拒绝;同名文件内容不同 → 拒绝 ────────────────
//
// 先做**静态**断言(任何机器上都跑,只需要模板本身):那两段守卫的形状不对(比如判在 elaborate
// 之后、quit 的退出码写成 0、或只剩一句提示),这里就红。再往下用真 ModelSim 跑夹具验退出码 ——
// 静态断言证明"有那段",真跑证明"真会拦"。
//
// 断言的是**守卫块**:从错误锚点那一行起,到"第一个裸 `}`"或"第一条 quit"为止(哪个先到算哪个)。
// 只查"文件里有没有那几行字"是不够的:后面那些守卫的 quit 会把断言喂饱(实测咬过 —— 把这段的
// quit 删掉,宽松断言照样绿)。
const guardBlock = (anchor) => {
  const at = bundledRunDo.indexOf(anchor);
  if (at < 0) return ["(模板里没有这个锚点)"];
  const from = bundledRunDo.lastIndexOf("\n", at) + 1;
  const block = [];
  for (const line of bundledRunDo.slice(from).split("\n")) {
    block.push(line.trim());
    if (line.trim() === "}" || line.trim().startsWith("quit")) break;
  }
  return block;
};
const guardOk = (anchor, label) => {
  const block = guardBlock(anchor);
  check(
    block[0].includes("ERROR:") && block.includes("quit -f -code 1"),
    `${label}(块首 ${block[0]};块尾 ${block[block.length - 1]})`
  );
};
guardOk("TOP_OVERRIDE is empty", "run.do:多个 TB 命中且 TOP_OVERRIDE 为空 → 报错后接 quit -f -code 1");
check(
  /proc same_file_content/u.test(bundledRunDo) && /-translation binary/u.test(bundledRunDo),
  "run.do:同名去重比的是内容(逐字节读出来比,不是只看大小)"
);
guardOk("duplicate basename with DIFFERENT content", "run.do:同名而内容不同 → 报错后接 quit -f -code 1(不是打一行提示就丢)");
check(
  !/kept the first/u.test(bundledRunDo),
  "run.do:旧口径(kept the first)已经不在 —— 两种口径并存的话等于没改"
);

// 真跑夹具:六个场景,只看退出码 + `[ME]` 输出。
// 为什么非真跑不可:模板里"有那几行字"与"真会拦下来"是两件事。
// ModelSim 是外部许可工具:`npm test` 不该因为这台机器没装它就变红 —— 探不到就明确跳过并说明。
// stdio 不能开管道(沙箱限制,见文件头),所以把 stdout 重定向到**文件句柄**再读 `[ME]` 输出。
const simRoot = join(SANDBOX, "rundo-sim");
const rtlFoo = "module foo; endmodule\n";
const tbSource = (name) => `module ${name};\n  initial begin\n    $display("ALL TESTS PASSED (err_cnt=0)");\n    $finish;\n  end\nendmodule\n`;
// `[ME] ERROR:` 那一块 = 错误头 + 紧跟其后的缩进续行(**候选/路径就列在这里**)。
// 只断言"输出里出现过某个路径"不够:编译清单里本来就有同样的路径(实测咬过 —— 守卫删掉后
// 那条断言照样绿)。所以定位到错误块里再看。
const rundoError = (output) => {
  const lines = output.split(/\r?\n/u);
  const from = lines.findIndex((line) => line.startsWith("[ME] ERROR:"));
  if (from < 0) return { header: "", details: [] };
  const details = [];
  for (let index = from + 1; index < lines.length && /^\[ME\]   /u.test(lines[index]); index += 1) {
    details.push(lines[index]);
  }
  return { header: lines[from], details };
};
const simRun = (name, files, doPath = bundledRunDoPath) => {
  const verif = join(simRoot, name, "verif");
  for (const [rel, text] of Object.entries(files)) {
    const file = join(simRoot, name, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const log = join(verif, "ME-stdout.log");
  const fd = openSync(log, "w");
  // 交给 ModelSim 的路径一律转正斜杠:反斜杠里的 `\t`/`\n` 会被 Tcl 当转义吃掉(实测)
  const status = spawnSync("vsim", ["-c", "-do", `do ${doPath.replace(/\\/gu, "/")}; quit -f`], {
    stdio: ["ignore", fd, "ignore"],
    cwd: verif
  }).status;
  closeSync(fd);
  return { status, output: existsSync(log) ? readFileSync(log, "utf8") : "" };
};

const vsimProbe = spawnSync("vsim", ["-c", "-do", "quit -f"], { stdio: "ignore" });
if (vsimProbe.status !== 0) {
  check(
    true,
    `run.do 的六个夹具真跑:本机没有可用的 ModelSim(vsim 退出码 ${String(vsimProbe.status)},null = PATH 上没有)-> 跳过这段,不假装通过`
  );
} else {
  const manyTb = { "rtl/foo.sv": rtlFoo, "verif/tb_a.sv": tbSource("tb_a"), "verif/tb_b.sv": tbSource("tb_b") };
  // ① 零 TB:verif/ 下一个 tb_*.sv 都没有 → 1(既有保护,别被这次改动碰坏)
  let sim = simRun("none", { "rtl/foo.sv": rtlFoo, "verif/helper.sv": rtlFoo });
  check(sim.status === 1, `零 TB → 退出码 1(实际 ${String(sim.status)})`);
  check(/no tb_\*\.sv/u.test(rundoError(sim.output).header), "零 TB 报的是「没有 tb_*.sv」这一条");
  // ② 单 TB → 0(唯一的"正常路径",它坏了说明守卫误伤)
  sim = simRun("one", { "rtl/foo.sv": rtlFoo, "verif/tb_foo.sv": tbSource("tb_foo") });
  check(sim.status === 0, `单 TB 照旧跑通 → 退出码 0(实际 ${String(sim.status)})`);
  // ③ 多个 TB + 没给 TOP_OVERRIDE → 1,且把候选**逐条列出来**
  sim = simRun("many", manyTb);
  check(sim.status === 1, `多 TB 无 TOP_OVERRIDE → 退出码 1(不再默默挑排序第一个;实际 ${String(sim.status)})`);
  const manyError = rundoError(sim.output);
  check(
    /matched 2 testbenches/u.test(manyError.header)
      && sim.output.includes("TOP_OVERRIDE")
      && manyError.details.some((line) => line.includes("tb_a.sv"))
      && manyError.details.some((line) => line.includes("tb_b.sv")),
    `多 TB 那条报出了命中数,并在错误里把两个候选逐条列出、指向 TOP_OVERRIDE(实际续行 ${manyError.details.length} 条)`
  );
  // ④ 多个 TB + 显式 TOP_OVERRIDE → 0(填了就等于指定了本次跑哪个)
  const topPatched = bundledRunDo.replace("set TOP_OVERRIDE {}", "set TOP_OVERRIDE {tb_b}");
  check(topPatched !== bundledRunDo, "夹具:旋钮 TOP_OVERRIDE 真被填上了(没填上的话下面那条会测成另一回事)");
  mkdirSync(simRoot, { recursive: true });
  const topDo = join(simRoot, "many-with-top.do");
  writeFileSync(topDo, topPatched);
  sim = simRun("many-top", manyTb, topDo);
  check(sim.status === 0, `多 TB + 显式 TOP_OVERRIDE → 退出码 0(实际 ${String(sim.status)})`);
  // ⑤ 同名且内容一致 → 0(内容一致才允许丢),并说明丢了哪一份
  sim = simRun("dup-same", { "rtl/foo.sv": rtlFoo, "verif/foo.sv": rtlFoo, "verif/tb_foo.sv": tbSource("tb_foo") });
  check(sim.status === 0, `同名同内容 → 退出码 0(只丢重复那份;实际 ${String(sim.status)})`);
  check(
    sim.output.includes("duplicate basename skipped (identical content)"),
    "同名同内容会打出「identical content」说清丢了哪一份(不静默)"
  );
  // ⑥ 同名而内容不同 → 1,并把两个路径都列出来。
  //    器材**刻意等长**:只比大小的实现会把它当成同一个文件放过去,这条夹具就抓这种实现。
  const dupA = "module foo; endmodule // r1\n";
  const dupB = "module foo; endmodule // r2\n";
  check(Buffer.byteLength(dupA) === Buffer.byteLength(dupB), "夹具:同名不同内容的两份等长(只比大小的实现会被抓出来)");
  sim = simRun("dup-diff", { "rtl/foo.sv": dupA, "verif/foo.sv": dupB, "verif/tb_foo.sv": tbSource("tb_foo") });
  check(sim.status === 1, `同名而内容不同 → 退出码 1(实际 ${String(sim.status)})`);
  const dupError = rundoError(sim.output);
  check(
    /duplicate basename with DIFFERENT content/u.test(dupError.header)
      && dupError.details.some((line) => line.includes("rtl/foo.sv"))
      && dupError.details.some((line) => line.includes("verif/foo.sv")),
    `同名不同内容那条在错误里把两个路径都列出来了(实际续行 ${dupError.details.length} 条)`
  );
}

// 用户自己的模板(没有任何占位符)→ 必须与模板逐字节一致
const plainTemplate = join(SANDBOX, "plain-tb.vhd");
writeFileSync(plainTemplate, "-- 我自己的模板\nentity tb_x is end entity;\n");
const plain = renderTemplate(readFileSync(plainTemplate, "utf8"), "UartRx");
check(plain.text === readFileSync(plainTemplate, "utf8"), "没有占位符的模板:原样复制,一个字节都不改");
check(plain.replaced.length === 0, "没有占位符时不谎报'替换了什么'");

// 落点与文件名
check(defaultDestination("rtl", "UartRx", "C:/t/rtl.sv") === join("rtl", "UartRx.sv"), "RTL 落到 rtl/<模块名>.sv");
check(
  defaultDestination("tb", "UartRx", "C:/t/tb.sv") === join("verif", "tb_uart_rx.sv"),
  "测试平台落到 verif/tb_<snake>.sv(驼峰转下划线;仿真与比对合成一个环节后落在 verif/)"
);
check(defaultDestination("tb", "UartRx", "C:/t/tb.vhd") === join("verif", "tb_uart_rx.vhd"), "扩展名跟着模板走");
// run.do 反过来:名字是**固定**的(跑法里 `do run.do` 写死了它),不跟模板扩展名走、也不替模块名
check(
  defaultDestination("run-do", undefined, "C:/t/run.do") === join("verif", "run.do"),
  "run.do 落到 verif/run.do(起它时不用给模块名)"
);
check(
  defaultDestination("run-do", "UartRx", "C:/t/custom.tcl") === join("verif", "run.do"),
  "换了自己的模板也还是 verif/run.do(文件名不跟模板扩展名走)"
);
check(defaultDestination("xdc", "UartRx", "C:/t/c.xdc") === join("synth", "UartRx.xdc"), "约束文件落 synth/<模块名>.xdc");
// 综合脚本与比对脚本的文件名同样是**固定**的:跑法里写死了 `synth/run_synth.tcl`、
// 技能里写死了 `verif/comp.py`,换个名字就对不上 —— 所以不看 name、也不跟模板扩展名走
check(
  defaultDestination("synth-script", "UartRx", "C:/t/run_synth.tcl") === join("synth", "run_synth.tcl"),
  "综合脚本落 synth/run_synth.tcl"
);
check(
  defaultDestination("synth-script", "UartRx", "C:/t/my_synth.tcl") === join("synth", "run_synth.tcl"),
  "换了自己的综合脚本模板,落点仍是 synth/run_synth.tcl(文件名不跟模板扩展名走)"
);
check(
  defaultDestination("comp", undefined, "C:/t/comp.py") === join("verif", "comp.py"),
  "比对脚本落 verif/comp.py(起它时不用给模块名)"
);
check(
  defaultDestination("comp", "UartRx", "C:/t/my_compare.py") === join("verif", "comp.py"),
  "换了自己的比对脚本模板,落点仍是 verif/comp.py"
);
// 模块级约束**只要时钟**(用户 2026-09-19 确认:模块没有管脚,管脚/电平/IO 延迟都是工程级的事)。
// 自带 XDC 模板要说清这条,而且不许再引用旧包的 `device_config.tcl / TIMING_CLOCKS` ——
// 那是旧结构,我们现在只有 spec/spec.md 这一处时钟参考。
const bundledXdc = readFileSync(join(TEMPLATES, "constraints.xdc"), "utf8");
check(
  /CLOCKS ONLY|clock constraint only/iu.test(bundledXdc),
  "自带 XDC 模板写明:模块级只要时钟约束"
);
check(
  !/device_config|TIMING_CLOCKS/u.test(bundledXdc),
  "自带 XDC 模板不再引用旧包的 device_config.tcl / TIMING_CLOCKS"
);
check(
  /spec\/spec\.md/u.test(bundledXdc),
  "自带 XDC 模板指向 spec/spec.md 作为器件与时钟参考的那一处"
);
check(
  /set_clock_groups -asynchronous|create_generated_clock/u.test(bundledXdc),
  "自带 XDC 模板提到多时钟域要加 generated clock 或异步时钟组(否则会报未约束/跨域)"
);
// 用户既有约定:一个 xdc 里按 IO → 时钟 → CFG → debug 四段的顺序摆(模块级只填时钟那段)。
// 顺序是给人照着写文件的,写在模板头部 —— 乱了这条就红。
check(
  /I\/O constraints[\s\S]*Clock constraints[\s\S]*Configuration commands[\s\S]*Debug constraints/u.test(bundledXdc),
  "自带 XDC 模板按 IO → 时钟 → CFG → debug 四段的顺序摆好"
);

// ── CLI 退出码 ─────────────────────────────────────────────────────────────
// setup-scaffold 是两级共用(在 tools/ 顶层、名字不带级别前缀);其余被调用的都是模块级命令
// cwd 可选:验"落点"的断言要能规定"当前目录"在哪,否则相对路径落到哪看不出来(也脏了仓库根)。
const run = (script, args, cwd) => {
  const path = existsSync(join(TOOLS, script)) ? join(TOOLS, script) : join(MODULE_TOOLS, script);
  return spawnSync(process.execPath, [path, ...args], { stdio: "ignore", cwd }).status;
};


// 语言边界:TB 扩展名跟设置里选的仿真语言走 —— 只认 .sv 的话,Verilog 的测试平台会被静默跳过
mkdirSync(join(SANDBOX, "tb-v-mod", "rtl"), { recursive: true });
mkdirSync(join(SANDBOX, "tb-v-mod", "verif"), { recursive: true });
writeFileSync(join(SANDBOX, "tb-v-mod", "verif", "tb_only.v"), goodTb);
check(
  run("module-rtl-check.mjs", [join(SANDBOX, "tb-v-mod")]) === 0,
  "verif/ 下的 .v 测试平台会被检查(只认 .sv 的话这里会退 2)"
);
mkdirSync(join(SANDBOX, "vhdl-mod", "rtl"), { recursive: true });
writeFileSync(join(SANDBOX, "vhdl-mod", "rtl", "top.vhd"), "-- VHDL 源码\n");
check(run("module-rtl-check.mjs", [join(SANDBOX, "vhdl-mod")]) === 2, "纯 VHDL 项目:如实退 2(本检查器不覆盖,不得当通过)");

check(run("module-rtl-check.mjs", [join(SANDBOX, "good-mod")]) === 0, "check-rtl 合规 → 退出码 0");
check(run("module-rtl-check.mjs", [join(SANDBOX, "bad-mod")]) === 1, "check-rtl 违规 → 退出码 1");
check(run("module-rtl-check.mjs", [join(SANDBOX, "warn-mod")]) === 0, "check-rtl 只有警告 → 退出码 0(警告不拦门禁)");
check(run("module-rtl-check.mjs", [join(SANDBOX, "style-mod")]) === 0, "check-rtl 只有端口写法问题 → 退出码 0(排版不拦门禁)");
check(run("module-rtl-check.mjs", [join(SANDBOX, "no-such-mod")]) === 2, "check-rtl 没有 rtl/ → 退出码 2");

// ── 三条来自实测事故的判据:断言说明逐条齐全 / 数据比对禁 != / 成功标记挂 err_cnt ─────
//
// 这三条以前都只查"整个文件里有没有那个字样",于是"看着有、其实没有"。所以既要验退出码
// (说明它真的会咬人),也要验报出来的行号(能定位到具体哪一处),还要验没误伤旁边那处。
// 夹具都放在只带 verif/ 的模块根下(rtl/ 建空目录,让退出码只由测试平台决定)。

// ① 断言说明必须逐条齐全:每处断言各自写一遍 Purpose / Trigger / Failure
const tbAsserts = [
  header("tb_asserts"), "`resetall", "`timescale 1ns/1ps", "`default_nettype none", "",
  "module tb_asserts;", "    integer err_cnt = 0;", "    logic clk = 0;", "",
  "    // Purpose  : reset must hold the first check",
  "    // Trigger  : checked every posedge clk",
  "    // Failure  : the first check must report",
  "    a_first : assert property (@(posedge clk) rst |-> rst);", "",
  "    // Purpose  : second check",
  "    // Trigger  : checked every posedge clk",
  "    // Failure  : the second check must report",
  "    a_second : assert property (@(posedge clk) clk |-> clk);", "",
  "    initial begin",
  "        if (err_cnt == 0) $display(\"ALL TESTS PASSED (err_cnt=0)\");",
  "        else $fatal(1, \"TB FAILED\");",
  "        $finish;",
  "    end",
  "endmodule", "`resetall", "`default_nettype wire", ""
].join("\n");
const assertMod = join(SANDBOX, "assert-mod");
mkdirSync(join(assertMod, "rtl"), { recursive: true });
mkdirSync(join(assertMod, "verif"), { recursive: true });
const tbAssertsPath = join(assertMod, "verif", "tb_asserts.sv");
writeFileSync(tbAssertsPath, tbAsserts);
const assertOkCode = run("module-rtl-check.mjs", [assertMod]);
check(assertOkCode === 0, `两条断言的说明各写一遍 → 退出码 0(实际 ${assertOkCode})`);
// 只删第一条断言的 Purpose,其余一行不动
const tbAssertsMissing = tbAsserts
  .split("\n")
  .filter((line) => line !== "    // Purpose  : reset must hold the first check")
  .join("\n");
writeFileSync(tbAssertsPath, tbAssertsMissing);
const assertBadCode = run("module-rtl-check.mjs", [assertMod]);
check(assertBadCode === 1, `只删第一条断言的 Purpose → 退出码 1(逐条查,不是全文件查;实际 ${assertBadCode})`);
const assertLines = tbAssertsMissing.split("\n");
const firstAssertLine = assertLines.findIndex((line) => line.includes("a_first : assert property")) + 1;
const secondAssertLine = assertLines.findIndex((line) => line.includes("a_second : assert property")) + 1;
const assertIssues = blocking(tbAssertsPath, true);
check(
  assertIssues.some((issue) => issue.rule === "设计断言" && issue.line === firstAssertLine && issue.message.includes("Purpose")),
  `缺说明报在第一处断言那一行(第 ${firstAssertLine} 行;实际 ${assertIssues.map((i) => `${i.rule}@${i.line}`).join("、") || "什么都没报"})`
);
check(
  // 只看「设计断言」这条:夹具里那两条断言本身是**恒真式**(`rst |-> rst` / `clk |-> clk`),
  // 所以「恒真断言」那条警告本来就该在两条上都报 —— 这里要验的是说明块规则别连坐。
  !assertIssues.some((issue) => issue.rule === "设计断言" && issue.line === secondAssertLine),
  `第二条(说明齐全)没被「设计断言」连坐(第 ${secondAssertLine} 行)`
);

// ② 数据比对禁 `!=`:同一行出现期望值命名的信号 → 阻塞;循环/计数条件 → 只警告
//    (全 X 时 `X != y` 求值为 X,`if (X)` 为假 → 一条错都不报)
const neqMod = join(SANDBOX, "neq-mod");
mkdirSync(join(neqMod, "rtl"), { recursive: true });
mkdirSync(join(neqMod, "verif"), { recursive: true });
const neqPath = join(neqMod, "verif", "tb_neq.sv");
const neqBad = goodTb
  .replace("module tb_good;", "module tb_neq;")
  .replace(
    "        if (err_cnt == 0)",
    "        if (dut_data != exp_data) err_cnt = err_cnt + 1;\n        if (err_cnt == 0)"
  );
writeFileSync(neqPath, neqBad);
const neqBadCode = run("module-rtl-check.mjs", [neqMod]);
check(neqBadCode === 1, `数据比对用 '!='(同行有 exp_data)→ 退出码 1(实际 ${neqBadCode})`);
check(
  blocking(neqPath, true).some((issue) => issue.rule === "数据比对"),
  "报出来的是「数据比对」这条阻塞规则(不是混进警告里)"
);
writeFileSync(neqPath, neqBad.replace("dut_data != exp_data", "dut_data !== exp_data"));
const neqOkCode = run("module-rtl-check.mjs", [neqMod]);
check(neqOkCode === 0, `同一行改成 '!==' → 退出码 0(实际 ${neqOkCode})`);

const neqLoopMod = join(SANDBOX, "neq-loop-mod");
mkdirSync(join(neqLoopMod, "rtl"), { recursive: true });
mkdirSync(join(neqLoopMod, "verif"), { recursive: true });
const neqLoopPath = join(neqLoopMod, "verif", "tb_neq_loop.sv");
writeFileSync(neqLoopPath, goodTb
  .replace("module tb_good;", "module tb_neq_loop;")
  .replace(
    "        if (err_cnt == 0)",
    "        while (i != 0) i = i - 1;\n        if (err_cnt == 0)"
  ));
check(
  blocking(neqLoopPath, true).some((issue) => issue.rule === "!= 待确认"),
  "循环/计数条件的 '!=' 会被报出来(不是静默放过)"
);
const neqLoopCode = run("module-rtl-check.mjs", [neqLoopMod]);
check(neqLoopCode === 0, `循环条件的 '!=' 只报警告 → 退出码 0(不拦门禁;实际 ${neqLoopCode})`);

// ②b 两侧都要是**信号**才算数据比对(2026-09-21 实测踩到):`exp_pixel_idx != 0` 这种
//     "计数/索引比常量"原来被当成数据比对拦死,与"循环/计数条件可以保留"的口径冲突。
const neqConstMod = join(SANDBOX, "neq-const-mod");
mkdirSync(join(neqConstMod, "rtl"), { recursive: true });
mkdirSync(join(neqConstMod, "verif"), { recursive: true });
const neqConstPath = join(neqConstMod, "verif", "tb_neq_const.sv");
writeFileSync(neqConstPath, goodTb
  .replace("module tb_good;", "module tb_neq_const;")
  .replace(
    "        if (err_cnt == 0)",
    "        if (exp_pixel_idx != 0 && (exp_pixel_idx % C_IMG_W) != (C_IMG_W - 1)) err_cnt = err_cnt + 1;\n        if (err_cnt == 0)"
  ));
check(
  !blocking(neqConstPath, true).some((issue) => issue.rule === "数据比对"),
  "期望值命名的**计数/索引**比常量(`exp_pixel_idx != 0`)不算数据比对(不判 FAIL)"
);
check(
  blocking(neqConstPath, true).some((issue) => issue.rule === "!= 待确认"),
  "但那两处 '!=' 仍会提醒一句(不是静默放过)"
);
const neqConstCode = run("module-rtl-check.mjs", [neqConstMod]);
check(neqConstCode === 0, `计数/索引比常量只报警告 → 退出码 0(实际 ${neqConstCode})`);

// ②c 一行里有**多个** `!=`:每一个都要看(第三轮复审 N-06)
//     真正会漏的形状:第一个 `!=` **两侧都是信号**但不是期望值命名(`a != b`),数据比对在后面 ——
//     只看第一个匹配就会把它当"待确认",于是真正的数据比对被漏掉。
const neqMultiMod = join(SANDBOX, "neq-multi-mod");
mkdirSync(join(neqMultiMod, "rtl"), { recursive: true });
mkdirSync(join(neqMultiMod, "verif"), { recursive: true });
const neqMultiPath = join(neqMultiMod, "verif", "tb_neq_multi.sv");
writeFileSync(neqMultiPath, goodTb
  .replace("module tb_good;", "module tb_neq_multi;")
  .replace(
    "        if (err_cnt == 0)",
    "        if (sq_a != sq_b && dut_data != exp_data) err_cnt = err_cnt + 1;\n        if (err_cnt == 0)"
  ));
check(
  blocking(neqMultiPath, true).some((issue) => issue.rule === "数据比对"),
  "同一行前一个 '!=' 是信号间比较(非期望值命名)、后一个才是数据比对 → 仍然判 FAIL(N-06)"
);
const neqMultiTwoSignals = goodTb
  .replace("module tb_good;", "module tb_neq_multi2;")
  .replace(
    "        if (err_cnt == 0)",
    "        if (sq_a != sq_b && sq_c != sq_d) err_cnt = err_cnt + 1;\n        if (err_cnt == 0)"
  );
writeFileSync(neqMultiPath, neqMultiTwoSignals);
check(
  !blocking(neqMultiPath, true).some((issue) => issue.rule === "数据比对") &&
    blocking(neqMultiPath, true).some((issue) => issue.rule === "!= 待确认"),
  "同一行两个都是普通信号比较 → 只提醒、不判 FAIL"
);

// ③ 成功标记必须与 err_cnt 挂钩:无条件打印的 ALL TESTS PASSED 只是字形
//    (控制头与打印之间夹一行说明也是同一条语句 —— 自带模板就是这种分行写法)
const tbMarker = (verdict) => [
  header("tb_marker"), "`resetall", "`timescale 1ns/1ps", "`default_nettype none", "",
  "module tb_marker;", "    integer err_cnt = 0;", "    initial begin",
  ...verdict,
  "        $finish;", "    end", "endmodule", "`resetall", "`default_nettype wire", ""
].join("\n");
const VERDICT_TIED = [
  "        if (err_cnt == 0)",
  "            // only zero violations counts as a pass",
  "            $display(\"ALL TESTS PASSED (err_cnt=0)\");",
  "        else $fatal(1, \"TB FAILED\");"
];
const VERDICT_UNCONDITIONAL = [
  "        $display(\"ALL TESTS PASSED\");",
  "        $fatal(1, \"TB FAILED\");"
];
// 串里写着 err_cnt=0 但无条件 —— 这张正是实测事故的形状:字样在,条件不在
const VERDICT_STRING_ONLY = [
  "        $display(\"ALL TESTS PASSED (err_cnt=0)\");",
  "        $fatal(1, \"TB FAILED\");"
];
const markerMod = join(SANDBOX, "marker-mod");
mkdirSync(join(markerMod, "rtl"), { recursive: true });
mkdirSync(join(markerMod, "verif"), { recursive: true });
const markerPath = join(markerMod, "verif", "tb_marker.sv");
writeFileSync(markerPath, tbMarker(VERDICT_TIED));
const markerOkCode = run("module-rtl-check.mjs", [markerMod]);
check(markerOkCode === 0, `成功标记挂在 err_cnt 条件上 → 退出码 0(实际 ${markerOkCode})`);
const markerBad = tbMarker(VERDICT_UNCONDITIONAL);
writeFileSync(markerPath, markerBad);
const markerBadCode = run("module-rtl-check.mjs", [markerMod]);
check(markerBadCode === 1, `无条件打印 ALL TESTS PASSED → 退出码 1(实际 ${markerBadCode})`);
const markerLine = markerBad.split("\n").findIndex((line) => line.includes("ALL TESTS PASSED")) + 1;
check(
  blocking(markerPath, true).some((issue) => issue.rule === "测试平台自检" && issue.line === markerLine),
  `成功标记那条报在打印它的行上(期望第 ${markerLine} 行)`
);
writeFileSync(markerPath, tbMarker(VERDICT_STRING_ONLY));
const markerStringCode = run("module-rtl-check.mjs", [markerMod]);
check(markerStringCode === 1, `打印串里写着 err_cnt=0 但无条件 → 退出码 1(字符串不是条件;实际 ${markerStringCode})`);

check(run("setup-scaffold.mjs", []) === 2, "setup-scaffold 不给根目录 → 退出码 2");
// 起文件:不覆盖已有文件、模板不存在要报错
const newFileRoot = join(SANDBOX, `new-file-${stamp}`);
check(
  run("module-rtl-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv")]) === 0,
  "module-rtl-new 按模板起文件 → 退出码 0"
);
check(existsSync(join(newFileRoot, "rtl", "uart_rx.sv")), "RTL 落在 rtl/ 下");
// 模块根可以放在**任意深度**(用户口径 2026-09-21:按功能分组,别被固定的类别目录限制)。
// 模板引用与模块路径无关 —— `--template` 拿的是设置里那份或插件包自带那份的**绝对路径**
// (解析基准是插件包自身,不是 CWD):所以多层、带空格都照落,不需要为此改任何东西。
const deepMod = join(SANDBOX, `deep-${stamp}`, "功能组 甲", "uart_rx");
check(
  run("module-rtl-new.mjs", [deepMod, "UartRx", "--template", join(TEMPLATES, "rtl.sv")]) === 0
    && existsSync(join(deepMod, "rtl", "UartRx.sv")),
  "多层 + 带空格的模块根照样落对(模板引用与模块路径、当前目录无关)"
);
check(
  run("module-verif-new.mjs", [deepMod, "UartRx", "--template", join(TEMPLATES, "tb.sv")]) === 0
    && existsSync(join(deepMod, "verif", "tb_uart_rx.sv")),
  "同一个深层模块根:测试平台也落在它自己的 verif/ 下"
);
check(
  run("module-rtl-check.mjs", [newFileRoot]) === 0,
  "模板生成的文件直接过机械检查(骨架开箱合规)"
);
check(
  run("module-verif-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "tb.sv")]) === 0
    && existsSync(join(newFileRoot, "verif", "tb_uart_rx.sv")),
  "verif-new 把测试平台落在 verif/tb_<snake>.sv"
);
// `--kind run-do`:技能里就是这么调的(只给模块根)—— 不给 --template 也要能起出 verif/run.do
check(
  run("module-verif-new.mjs", [newFileRoot, "--kind", "run-do"]) === 0
    && existsSync(join(newFileRoot, "verif", "run.do")),
  "verif-new --kind run-do 起出 verif/run.do(不用给模块名与模板)"
);
check(
  readFileSync(join(newFileRoot, "verif", "run.do"), "utf8") === bundledRunDo,
  "起出来的 run.do 与自带模板逐字节一致(不替模块名、不改内容)"
);
check(
  run("module-verif-new.mjs", [newFileRoot, "--kind", "run-do"]) === 1,
  "已存在的 run.do 不覆盖 → 退出码 1"
);
check(
  run("module-verif-new.mjs", [newFileRoot, "--kind", "run-do", "--force"]) === 0,
  "--force 才覆盖 run.do"
);

// ── --force 的覆盖必须**可恢复** ───────────────────────────────────────────────
//
// 原来是 `writeFileSync(target, text)` —— 先截断再写,而且旧内容一点不剩,`--force` 于是成了
// "丢用户改动"的开关。现在:覆盖前把旧内容留成同目录 `<目标>.bak-<时间戳>`,新内容先写临时文件、
// 核验过才改名替换。夹具先塞一份"用户改过的"内容,再 --force,快照必须逐字节等于它。
const backupMod = join(SANDBOX, `backup-force-${stamp}`);
const backupVerif = join(backupMod, "verif");
const backupRunDo = join(backupVerif, "run.do");
const tamperedRunDo = "# 用户改过的 run.do(夹具)\nset RTL_DIR {../my_rtl}\n";
mkdirSync(backupVerif, { recursive: true });
writeFileSync(backupRunDo, tamperedRunDo);
check(
  run("module-verif-new.mjs", [backupMod, "--kind", "run-do", "--force"]) === 0,
  "已有 run.do + --force → 退出码 0(覆盖)"
);
check(readFileSync(backupRunDo, "utf8") === bundledRunDo, "目标确实被新模板覆盖了");
const runDoBackups = readdirSync(backupVerif).filter((name) => name.startsWith("run.do.bak-"));
check(
  runDoBackups.length === 1,
  `覆盖前留了一份 run.do.bak-<时间戳> 快照(实际 ${runDoBackups.length} 个:${readdirSync(backupVerif).join("、")})`
);
const backupText = runDoBackups.length === 1 ? readFileSync(join(backupVerif, runDoBackups[0]), "utf8") : "(没有快照)";
check(
  backupText === tamperedRunDo,
  "快照里是覆盖前的旧内容、逐字节一致(所以真能恢复回去;不是留了个空壳)"
);
check(
  !readdirSync(backupVerif).some((name) => name.includes(".tmp-")),
  "替换没有留下临时文件(先写临时文件、核验后改名,收尾要干净)"
);

// 快照/替换失败时:`保留原文件` + 报错退出 + **不删**留下的临时/半成品。夹具:让 `verif/run.do`
// 这个位置被一个**目录**占着 —— 快照那一步就失败(复制不了目录),此时目标一个字节都不该动,
// 而临时文件必须**还在**(零删除:路径写进错误信息,由使用者自己处置)。
//
// stdio 不能开管道(沙箱限制,见文件头):stderr 也重定向到**文件句柄**再读。
const runStderr = (script, args) => {
  // 解析顺序:预设的工具目录 → 仓库根 tools/(install / sync-installed 这些在仓库层)
  const path = [join(MODULE_TOOLS, script), join(TOOLS, script), join(ROOT, "tools", script)].find((candidate) => existsSync(candidate)) ?? join(TOOLS, script);
  const log = join(SANDBOX, `stderr-${script}-${String(Date.now())}.log`);
  const fd = openSync(log, "w");
  const code = spawnSync(process.execPath, [path, ...args], { stdio: ["ignore", "ignore", fd] }).status;
  closeSync(fd);
  return { code, output: readFileSync(log, "utf8") };
};
// 同一个道理,但收 **stdout** —— 检查器把正常结论(ok / warn / PASS)写在 stdout,只有用法错误与
// 落盘失败走 stderr。用 runStderr 去读一条警告会什么都读不到(实测踩过:断言像在测空气)。
const runStdout = (script, args) => {
  // 解析顺序:预设的工具目录 → 仓库根 tools/(install / sync-installed 这些在仓库层)
  const path = [join(MODULE_TOOLS, script), join(TOOLS, script), join(ROOT, "tools", script)].find((candidate) => existsSync(candidate)) ?? join(TOOLS, script);
  const log = join(SANDBOX, `stdout-${script}-${String(Date.now())}.log`);
  const fd = openSync(log, "w");
  const code = spawnSync(process.execPath, [path, ...args], { stdio: ["ignore", fd, "ignore"] }).status;
  closeSync(fd);
  return { code, output: readFileSync(log, "utf8") };
};
const dirTargetMod = join(SANDBOX, `backup-dir-${stamp}`);
const dirTarget = join(dirTargetMod, "verif", "run.do");
mkdirSync(dirTarget, { recursive: true });
writeFileSync(join(dirTarget, "keep.txt"), "keep\n");
const dirForce = runStderr("module-verif-new.mjs", [dirTargetMod, "--kind", "run-do", "--force"]);
check(dirForce.code === 2, `快照失败(目标位置是目录)→ 退出码 2(落盘失败;实际 ${String(dirForce.code)})`);
const dirLeftovers = readdirSync(join(dirTargetMod, "verif")).filter(
  (name) => name.includes(".tmp-") || name.includes(".bak-")
);
check(
  existsSync(join(dirTarget, "keep.txt")) &&
    readdirSync(join(dirTargetMod, "verif")).includes("run.do") &&
    dirLeftovers.length > 0,
  `失败时原有内容原样保留,临时/半成品**留在原地不删**(实际留下:${dirLeftovers.join("、") || "无"})`
);
check(
  dirLeftovers.length > 0 && dirLeftovers.every((name) => dirForce.output.includes(name)),
  "留下的临时/半成品文件路径都写进了错误信息(不是悄悄丢在原地没人知道)",
  dirForce.output.slice(-400)
);
// 漏给根目录时必须报参数错,不能把 `--kind` 的值当成根目录去写(实测踩过:会在 ./run-do/ 下起文件还退 0)
check(
  run("module-verif-new.mjs", ["--kind", "run-do"]) === 2,
  "漏给模块根 → 退出码 2(`--kind` 的值不会被当成根目录)"
);

// ── 起综合脚本 / 比对脚本(module-synth-new --kind synth-script / module-verif-new --kind comp)──
// 综合脚本那两行(器件型号、顶层模块名)以前靠手抄 —— 手抄就是"器件与时钟只写一处"之外的第二处
// 来源,换器件时必漏。现在起脚本时从 spec/spec.md 读出来填。夹具器件**故意与自带模板里那个
// 不同**:填没填上,一眼分得出来。
const bundledRunSynth = readFileSync(join(TEMPLATES, "run_synth.tcl"), "utf8");
// 器件预检**必须同时认两种写法**(2026-09-21 实测:9 个真实 `.xci` 全是 Vivado 2025.x 的 JSON,
// 器件被拆成 DEVICE / PACKAGE / SPEEDGRADE 三段,只有老的 `part = xc…` 整串正则 → 一条都匹配不上,
// 预检于是打了 WARN 就跳过 = 从来没真跑过)。行为已用真 Vivado 复核(见 run_synth.tcl 头注)。
// 断言钉在**真的 regexp 命令行**上,不是钉在模板文本里出现过这几个词 —— 否则上面那段解释性
// 注释就能把断言喂饱(这么写的第一版就被注释蒙过去了,咬人验证时才发现)。
check(
  /proc xci_part/u.test(bundledRunSynth) &&
    /regexp[^\n]*"DEVICE"/u.test(bundledRunSynth) &&
    /regexp[^\n]*"PACKAGE"/u.test(bundledRunSynth) &&
    /regexp[^\n]*"SPEEDGRADE"/u.test(bundledRunSynth),
  "run_synth.tcl 的器件预检真的去读 2025.x JSON 三段(DEVICE / PACKAGE / SPEEDGRADE)"
);
check(
  /regexp[^\n]*part\[\^A-Za-z0-9\]/u.test(bundledRunSynth),
  "run_synth.tcl 仍保留老写法(整条器件串)作退路(两种写法都要认)"
);
// 器件串不全(缺速度等级)时**不能打成 OK**(第三轮复审 N-13):只能按前缀比 —— 那必须说出来。
// 断言按 if/else 的代码形状钉(不是钉"文本里出现过 INCOMPLETE"),真实行为已用 Vivado Tcl 复核过:
// JSON 三段全 → complete=1;缺 SPEEDGRADE → complete=0;老式整串 → complete=1。
check(
  /if \{\$xcomplete\} \{\s*\n\s*puts "\\\[run_synth\\\] OK:/u.test(bundledRunSynth) &&
    /else \{\s*\n[\s\S]{0,400}?INCOMPLETE/u.test(bundledRunSynth),
  "run_synth.tcl 只在器件串**完整**时打 OK;不全时改为 WARN + INCOMPLETE(N-13)"
);
check(
  !/\[\^\}\]\*\?/u.test(bundledRunSynth),
  "run_synth.tcl 里没有「排除花括号」那种正则(裸花括号会把 braced 字符串提前关掉,实测把 proc 拆散)"
);
const specMod = join(SANDBOX, `spec-mod-${stamp}`);
mkdirSync(join(specMod, "spec"), { recursive: true });
const specFile = join(specMod, "spec", "spec.md");
writeFileSync(specFile, [
  "# spec:uart_rx", "",
  "## 目标器件与封装", "",
  "- 器件型号:xc7z020clg484-1",
  "- 器件族:Zynq-7000", "",
  "## 接口", "",
  "- 顶层模块名:uart_rx", ""
].join("\n"));
const specScript = join(specMod, "synth", "run_synth.tcl");
const specCode = run("module-synth-new.mjs", [specMod, "uart_rx", "--kind", "synth-script"]);
check(
  specCode === 0 && existsSync(specScript),
  `module-synth-new --kind synth-script 起出 synth/run_synth.tcl(实际退出码 ${specCode})`
);
const specText = existsSync(specScript) ? readFileSync(specScript, "utf8") : "";
check(specText.includes('set PART "xc7z020clg484-1"'), "脚本里的器件型号是照 spec/spec.md 填的(夹具器件与模板默认值不同)");
check(specText.includes('set TOP "uart_rx"'), "脚本里的顶层模块名也是照 spec/spec.md 填的");
check(!specText.includes("xc7a100tfgg484-2"), "模板里那个默认器件被替掉了(不留第二处器件来源)");
check(!/<[A-Za-z_][A-Za-z0-9_]*>/u.test(specText), "起出来的综合脚本里没有未替换的占位符");
check(run("module-synth-new.mjs", [specMod, "uart_rx", "--kind", "synth-script"]) === 1, "已存在的 run_synth.tcl 不覆盖 → 退出码 1");
check(run("module-synth-new.mjs", [specMod, "uart_rx", "--kind", "synth-script", "--force"]) === 0, "--force 才覆盖 run_synth.tcl");

// 器件定不下来就**拒绝生成**(用户口径 2026-09-21 + 第三轮复审 N-01):以前是"起出来、两行保留模板
// 原样",那等于把模板默认器件(XC7A100T)留在别的器件工程里 —— 看起来可信的错值比直接报错坏得多。
writeFileSync(specFile, [
  "# spec:uart_rx", "",
  "## 目标器件", "",
  "器件型号:待定(候选 xc7a100tfgg484-2 或 xc7z020clg484-1)", ""
].join("\n"));
const ambiguousCode = run("module-synth-new.mjs", [specMod, "uart_rx", "--kind", "synth-script", "--force"]);
check(ambiguousCode === 2, `spec 里说不清器件(两个候选)→ 拒绝生成、退出码 2(实际 ${ambiguousCode})`);
check(
  readFileSync(specScript, "utf8").includes('set PART "xc7z020clg484-1"'),
  "拒绝时不碰已有文件(里面还是上次那份真器件)"
);
// 连 spec/spec.md 都没有的模块根:同样拒绝,而且**不落文件**
const noSpecScript = join(newFileRoot, "synth", "run_synth.tcl");
const noSpecCode = run("module-synth-new.mjs", [newFileRoot, "uart_rx", "--kind", "synth-script"]);
check(
  noSpecCode === 2 && !existsSync(noSpecScript),
  `没有 spec/spec.md → 拒绝生成、退出码 2、不落文件(实际 ${noSpecCode})`
);

// 模块 spec **不重述器件**时(N-01 后的常态):器件从**兄弟工程 spec** 读;顶层名缺省用模块名
const projSynthRoot = join(SANDBOX, `synth-proj-${stamp}`);
const projSynthMod = join(projSynthRoot, "uart_rx");
mkdirSync(join(projSynthRoot, "project", "spec"), { recursive: true });
mkdirSync(join(projSynthMod, "spec"), { recursive: true });
writeFileSync(join(projSynthRoot, "project", "spec", "spec.md"), "# 工程 spec\n\n- 器件型号:xcku040-ffva1156-2-e\n");
writeFileSync(join(projSynthMod, "spec", "spec.md"), "# 模块 spec\n\n- 器件见工程 spec(不重述)\n");
const projSynthCode = run("module-synth-new.mjs", [projSynthMod, "uart_rx", "--kind", "synth-script"]);
// 读之前先判存在:被咬坏时这里**红**就够了,不能因为文件没生成就抛 ENOENT 把整份自检崩掉
const projSynthScript = join(projSynthMod, "synth", "run_synth.tcl");
const projSynthText = existsSync(projSynthScript) ? readFileSync(projSynthScript, "utf8") : "";
check(
  projSynthCode === 0 && projSynthText.includes('set PART "xcku040-ffva1156-2-e"') &&
    !projSynthText.includes("xc7a100tfgg484-2"),
  `模块 spec 不写器件 → 器件取自工程 spec(退出码 ${String(projSynthCode)})`,
  projSynthText.split("\n").filter((line) => line.startsWith("set ")).join(" | ")
);
check(
  projSynthText.includes('set TOP "uart_rx"'),
  "spec 没写顶层名 → 按模块名填(不是模板默认 top)"
);
// 真实 spec 的形状(2026-09-21 实测踩到):除了「目标器件」字段行,**修订历史表**里还会留旧器件,
// 字段行同一行还带括号里的族名(`(Artix-7 XC7A100T,-2,…)`)—— 不处理就会判成"说不清"而拒绝生成。
writeFileSync(
  join(projSynthMod, "spec", "spec.md"),
  [
    "# spec:uart_rx", "",
    "| 版本 | 日期 | 变更 |",
    "|---|---|---|",
    "| v1.2 | 2026-09-20 | 目标器件改判为 `xc7a100tfgg484-2`(原 `xcku3p-ffva676-2-i` 不同族,IP 被锁) |", "",
    "## 目标器件", "",
    "- **目标器件**:`xc7a100tfgg484-2`(Artix-7 XC7A100T,-2,Vivado 2025.2)。", "",
    "- 顶层模块名:uart_rx", ""
  ].join("\n")
);
const realShapeCode = run("module-synth-new.mjs", [projSynthMod, "uart_rx", "--kind", "synth-script", "--force"]);
const realShapeText = existsSync(projSynthScript) ? readFileSync(projSynthScript, "utf8") : "";
check(
  realShapeCode === 0 && realShapeText.includes('set PART "xc7a100tfgg484-2"') && !realShapeText.includes("xcku3p"),
  `真实 spec 形状(字段行 + 族名 + 历史行)→ 取字段行那个器件(退出码 ${String(realShapeCode)})`,
  realShapeText.split("\n").filter((line) => line.startsWith("set ")).join(" | ")
);

// `--kind comp`:比对脚本落 verif/comp.py(原样复制,不改一个字符)
const bundledCompPath = join(TEMPLATES, "comp.py");
const bundledComp = existsSync(bundledCompPath) ? readFileSync(bundledCompPath, "utf8") : "";
check(existsSync(bundledCompPath), "自带 comp.py 模板存在(module-verif-new --kind comp 起的就是它)");
const compPath = join(newFileRoot, "verif", "comp.py");
const compCode = run("module-verif-new.mjs", [newFileRoot, "--kind", "comp"]);
check(
  compCode === 0 && existsSync(compPath),
  `module-verif-new --kind comp 起出 verif/comp.py(不用给模块名与模板;实际退出码 ${compCode})`
);
check(existsSync(compPath) && readFileSync(compPath, "utf8") === bundledComp, "起出来的 comp.py 与自带模板逐字节一致(不替模块名、不改内容)");
check(run("module-verif-new.mjs", [newFileRoot, "--kind", "comp"]) === 1, "已存在的 comp.py 不覆盖 → 退出码 1");
check(run("module-verif-new.mjs", [newFileRoot, "--kind", "comp", "--force"]) === 0, "--force 才覆盖 comp.py");
check(run("module-verif-new.mjs", ["--kind", "comp"]) === 2, "漏给模块根(comp)→ 退出码 2");

// comp.py 的判定口径:**"样本数为 0 算不算通过"不是它的事** —— 脚本只管比数据,两边都空就正常
// 比完 0 个值、退 0(用户裁定:以前那条"0 样本算失败"是判断层的规矩,不该塞进工具里)。
// 这条断言把口径钉住:规则加回去,它立刻红。顺带钉住另一半 —— 取值真不一致仍然退 1,
// 否则"改成 0"会退化成永远通过。python 只在 PATH 上找(设置里那个「Python 3」字段就是它);
// stdio 不开管道(沙箱限制,见文件头)。
const compFixture = join(SANDBOX, "comp-case");
mkdirSync(compFixture, { recursive: true });
const compCase = (name, text) => {
  const path = join(compFixture, name);
  writeFileSync(path, text);
  return path;
};
const emptyRef = compCase("empty_ref.hex", "");
const emptyOut = compCase("empty_out.hex", "\n\n");
const diffRef = compCase("diff_ref.hex", "0x0001\n");
const diffOut = compCase("diff_out.hex", "0x0002\n");
const compStatus = (...args) => spawnSync("python", [bundledCompPath, ...args], { stdio: "ignore" }).status;
const emptyCode = compStatus(emptyRef, emptyOut);
check(
  emptyCode === 0,
  `comp.py:两边都没有样本 → 正常比完(0 个值)退 0,不再算失败(实际退出码 ${emptyCode};null = PATH 上没有 python)`
);
check(
  compStatus(diffRef, diffOut) === 1,
  "comp.py:取值不一致仍然退 1(去掉 0 样本那条规则没把判据弄丢)"
);

// ── module-synth-new:约束落点 ───────────────────────────────────────────────
check(
  run("module-synth-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "constraints.xdc")]) === 0
    && existsSync(join(newFileRoot, "synth", "uart_rx.xdc")),
  "module-synth-new 把约束落在 synth/<模块名>.xdc"
);
check(
  run("module-rtl-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv")]) === 1,
  "已存在的文件不覆盖 → 退出码 1"
);
check(
  run("module-rtl-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv"), "--force"]) === 0,
  "--force 才覆盖"
);
// `--out` 是相对根目录的路径:`..` 逃逸与绝对路径都要挡在写之前(审查指出、实测复现过:
// 不挡的话 `--out "..\x.sv"` 会真写到根目录外面)
const escapeRoot = join(SANDBOX, `escape-${stamp}`, "mod");
mkdirSync(escapeRoot, { recursive: true });
const escapeTarget = join(SANDBOX, `escape-${stamp}`, "escaped.sv");
check(
  run("module-rtl-new.mjs", [escapeRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv"), "--out", join("..", "escaped.sv")]) === 2,
  "--out 用 .. 逃出根目录 → 退出码 2"
);
check(!existsSync(escapeTarget), "逃逸请求没有真的写出文件(挡在写之前)");
check(
  run("module-rtl-new.mjs", [escapeRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv"), "--out", escapeTarget]) === 2,
  "--out 传绝对路径 → 退出码 2"
);
check(
  run("module-rtl-new.mjs", [escapeRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv"), "--out", join("rtl", "sub", "uart_rx.sv")]) === 0
    && existsSync(join(escapeRoot, "rtl", "sub", "uart_rx.sv")),
  "根目录内的子目录照样能写(护栏不误伤合法用法)"
);
check(
  run("module-rtl-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "no-such.sv")]) === 2,
  "模板不存在 → 退出码 2(不猜模板)"
);
check(run("module-rtl-new.mjs", [newFileRoot, "uart_rx"]) === 2, "不给 --template → 退出码 2");check(run("setup-scaffold.mjs", [join(SANDBOX, "scaffold-cli"), "--kind", "bogus"]) === 2, "--kind 非法 → 退出码 2");
check(run("setup-scaffold.mjs", [join(SANDBOX, "scaffold-cli")]) === 0, "建模块骨架 → 退出码 0");
check(
  existsSync(join(SANDBOX, "scaffold-cli", "rtl")) && existsSync(join(SANDBOX, "scaffold-cli", ".fpga-workbench.json")),
  "CLI 真的把骨架建出来了"
);
check(run("setup-scaffold.mjs", [join(SANDBOX, "scaffold-cli")]) === 0, "重复建同一目录也返回 0(幂等)");

// ── 位置参数只取"第一个选项之前":写反了报参数错,不许把选项的值当成根目录 ─────────────
//
// 实测(修前):`--kind project <根>` 里 `argv.find(a => !a.startsWith("-"))` 拿到的是选项的**值**
// `project`,于是在当前目录下建出一整套 `./project/` 还退 0 —— 用户以为建在他给的根上(写到错地方
// 还不报错)。规矩照 `lib/stamp.mjs` 的 parseStampArgs:位置参数只取第一个选项之前的;其余算用法错误。
// 所以三条一起验:① 写反 → 退 2;② 当前目录的 ./project 与他给的根**都什么都没建**;③ 根写在前面照旧生效。
const argsCwd = join(SANDBOX, `args-cwd-${stamp}`);
mkdirSync(argsCwd, { recursive: true });
const reversedRoot = join(argsCwd, "realroot");
const reversedCode = run("setup-scaffold.mjs", ["--kind", "project", reversedRoot], argsCwd);
check(reversedCode === 2, `--kind project <根>(选项在前)→ 退出码 2(实际 ${reversedCode})`);
check(
  !existsSync(join(argsCwd, "project")) && !existsSync(reversedRoot),
  "写反时 ./project 与那个根目录都没被创建(选项的值没被当成根目录)"
);
const argsRoot = join(SANDBOX, `args-root-${stamp}`);
const argsOkCode = run("setup-scaffold.mjs", [argsRoot, "--kind", "project"]);
check(
  argsOkCode === 0
    && existsSync(join(argsRoot, "project", "impl"))
    && existsSync(join(argsRoot, ".fpga-workbench.json")),
  `<根> --kind project(根在前)照旧退 0 且骨架真建在该根下(实际 ${argsOkCode})`
);
const posAfterOptRoot = join(SANDBOX, `args-stray-${stamp}`);
const posAfterOptCode = run("setup-scaffold.mjs", [posAfterOptRoot, "foo", "--kind", "project"]);
check(
  posAfterOptCode === 2 && !existsSync(posAfterOptRoot),
  `<根> foo --kind project(多一个位置参数)→ 退出码 2(实际 ${posAfterOptCode})`
);
check(
  run("setup-scaffold.mjs", [posAfterOptRoot, "--kind", "project", "foo"]) === 2,
  "位置参数出现在选项之后(<根> --kind project foo)→ 退出码 2"
);

// ── 模块名是"根目录下的一级子目录名":不许拿它把骨架建到根目录外面去 ──────────────
//
// 实测过(审查指出、这里复现过):不加判断的话 `--modules "..\..\evil"` 会真在根目录**之上**
// 建出整套模块骨架,退出码还是 0;绝对路径则会被 join 拼成 `<根>\C:\...` 抛异常崩掉(退 1)。
// 所以每个逃逸写法都要:① 退出码 2;② 那条逃逸路径**确实没被创建**(挡在写之前,不是写失败)。
const escapeBase = join(SANDBOX, `mod-escape-${stamp}`);
const moduleEscapeRoot = join(escapeBase, "b", "root");
mkdirSync(moduleEscapeRoot, { recursive: true });
const escapeMod = (name) => run("setup-scaffold.mjs", [moduleEscapeRoot, "--kind", "project", "--modules", name]);
check(escapeMod("..\\..\\evil_bs") === 2, "模块名用 ..\\..\\ 逃出根目录 → 退出码 2");
check(!existsSync(join(escapeBase, "evil_bs")), "反斜杠逃逸的模块目录没有落地(根目录之外什么都没建)");
check(escapeMod("../evil_fs") === 2, "模块名用 ../ 逃出根目录 → 退出码 2");
check(!existsSync(join(escapeBase, "b", "evil_fs")), "正斜杠逃逸的模块目录没有落地");
check(escapeMod("..") === 2, "模块名就是一个 .. → 退出码 2");
check(
  !existsSync(join(escapeBase, "b", ".fpga-workbench.json")) && !existsSync(join(escapeBase, "b", "spec")),
  ".. 没有把锚点 / 环节目录写到根目录的上一级"
);
check(escapeMod(join(SANDBOX, "abs-evil")) === 2, "模块名传绝对路径 → 退出码 2(不是崩掉退 1)");
check(!existsSync(join(SANDBOX, "abs-evil")), "绝对路径的模块名没有写出任何东西");
check(escapeMod("D:evil") === 2, "模块名带盘符 → 退出码 2");
check(escapeMod(join("sub", "mod")) === 2, "模块名带路径分隔符(合法子目录写法)→ 退出码 2(模块名只收一段)");
check(
  escapeMod("uart_rx") === 0 && existsSync(join(moduleEscapeRoot, "uart_rx", "rtl")),
  "合法的一级子目录名照样建(护栏不误伤)"
);
check(
  escapeMod("a..b") === 0 && existsSync(join(moduleEscapeRoot, "a..b", "rtl")),
  "名字里带 .. 但不是 .. 本身 → 照样建(护栏不误伤)"
);

// ── --force 的语义:只重写**类型一致**的锚点与工作区指令,不跨 kind 覆盖 ────────────
//
// 实测:同类型时 `--force` 真覆盖(改坏的锚点与 AGENTS.fpga.md 都被重写回来,退 0);
// 跨 kind(module 根跑 --kind project --force)是硬拒绝退 1,目录与锚点都不动 ——
// 提示文字因此不再让用户"再加 --force 重建"(那条路到不了 applyScaffold)。
const forceRoot = join(SANDBOX, `scaffold-force-${stamp}`);
const forceAnchor = join(forceRoot, ".fpga-workbench.json");
const forceRules = join(forceRoot, "AGENTS.fpga.md");
check(run("setup-scaffold.mjs", [forceRoot]) === 0, "先建一次模块骨架(供 --force 断言用)→ 退出码 0");
writeFileSync(forceAnchor, `${JSON.stringify({ kind: "module", spec: "TAMPERED" }, null, 2)}\n`);
writeFileSync(forceRules, "TAMPERED RULES\n");
check(
  run("setup-scaffold.mjs", [forceRoot]) === 0
    && readFileSync(forceAnchor, "utf8").includes("TAMPERED")
    && readFileSync(forceRules, "utf8").includes("TAMPERED"),
  "不给 --force 时已有锚点与工作区指令都不动(用户改过的那份不会被覆盖)"
);
check(
  run("setup-scaffold.mjs", [forceRoot, "--force"]) === 0
    && !readFileSync(forceAnchor, "utf8").includes("TAMPERED")
    && readFileSync(forceAnchor, "utf8").includes("spec/spec.md")
    && !readFileSync(forceRules, "utf8").includes("TAMPERED"),
  "--force 真覆盖已有锚点与工作区指令(不是只接受的空开关)"
);
// 覆盖**可恢复**:锚点与工作区指令这两份旧内容都留下了同目录 `.bak-<时间戳>` 快照,
// 而且快照里必须是覆盖前的那份 —— 不然"可恢复"只是句口号。
const forceBackups = readdirSync(forceRoot).filter((name) => name.includes(".bak-"));
const anchorBackup = forceBackups.find((name) => name.startsWith(".fpga-workbench.json.bak-"));
const rulesBackup = forceBackups.find((name) => name.startsWith(`${INSTRUCTION_FILE}.bak-`));
check(
  anchorBackup !== undefined && rulesBackup !== undefined,
  `--force 覆盖锚点与 ${INSTRUCTION_FILE} 前都留了快照(实际:${forceBackups.join("、") || "一个都没有"})`
);
check(
  anchorBackup !== undefined && readFileSync(join(forceRoot, anchorBackup), "utf8").includes("TAMPERED"),
  "锚点快照里是覆盖前的那份内容(所以改坏了能恢复回去)"
);
check(
  rulesBackup !== undefined && readFileSync(join(forceRoot, rulesBackup), "utf8") === "TAMPERED RULES\n",
  `${INSTRUCTION_FILE} 快照里是覆盖前的那份内容、逐字节一致`
);
check(
  run("setup-scaffold.mjs", [forceRoot, "--kind", "project", "--force"]) === 1
    && !existsSync(join(forceRoot, "project"))
    && readFileSync(forceAnchor, "utf8").includes("\"module\""),
  "跨 kind 是硬拒绝:带 --force 也退 1,project/ 与根锚点都没动"
);

// ── F-13:路径边界不能只看词法 —— junction 的真实落点必须被识破 ───────────────
//
// 纯字符串判断只看"路径长什么样";一个 junction(或符号链接)能让 `--out` 与模块子目录的**真实落点**
// 跑到根目录**外面**去,而词法上一切正常。这里用**真 junction** 定向验证(node 的
// `symlinkSync(..., "junction")` 在 Windows 上不需要管理员权限;造不出来就明确跳过,不假装通过):
//   · `--out` 落在"根里的 junction 子目录"下 → 真实落点在根外 → 退 2,一个文件都不落
//   · 骨架的 `--modules` 给一个 junction 的模块名 → 退 2,外面什么都没建、里面也没动
// 两条都验"拒绝时把**真实落点**打出来了" —— 不然用户只知道被拒、不知道东西本来会落到哪。
const junctionBase = join(SANDBOX, `junction-${stamp}`);
const junctionOutside = join(junctionBase, "outside");
mkdirSync(junctionOutside, { recursive: true });
/** 造一个真 junction;本机造不出来(权限/文件系统)时明说并返回 false。 */
const makeJunction = (parent, name) => {
  try {
    symlinkSync(junctionOutside, join(parent, name), "junction");
    return true;
  } catch (error) {
    console.log(`(本机造不出 junction:${error.code ?? ""} ${error.message} -> F-13 的 junction 定向验证跳过,不假装通过)`);
    return false;
  }
};
const stampJunctionRoot = join(junctionBase, "mod");
mkdirSync(stampJunctionRoot, { recursive: true });
if (makeJunction(stampJunctionRoot, "escape")) {
  const junctionOutFile = join(junctionOutside, "escaped.sv");
  const junctionStamp = runStderr("module-rtl-new.mjs", [
    stampJunctionRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv"), "--out", join("escape", "escaped.sv")
  ]);
  check(junctionStamp.code === 2, `--out 经 junction 的真实落点在根外 → 退出码 2(实际 ${String(junctionStamp.code)})`);
  check(!existsSync(junctionOutFile), "junction 逃逸请求没有真的写出文件(挡在写之前)");
  check(
    junctionStamp.output.includes(junctionOutside) && junctionStamp.output.includes("真实落点"),
    `拒绝时打出了真实落点(期望提到 ${junctionOutside})`,
    junctionStamp.output.slice(-300)
  );
}
const junctionRoot = join(junctionBase, "proj");
mkdirSync(junctionRoot, { recursive: true });
if (makeJunction(junctionRoot, "uart")) {
  const junctionScaffold = runStderr("setup-scaffold.mjs", [junctionRoot, "--kind", "project", "--modules", "uart"]);
  check(junctionScaffold.code === 2, `--modules 给 junction 的模块名 → 退出码 2(实际 ${String(junctionScaffold.code)})`);
  check(!existsSync(join(junctionOutside, "spec")), "junction 逃逸的模块骨架没有落到根目录外面");
  check(!existsSync(join(junctionRoot, "project")), "预检挡在任何落盘之前(根里的 project/ 都没建)");
  check(
    junctionScaffold.output.includes(junctionOutside) && junctionScaffold.output.includes("真实落点"),
    `骨架拒绝时也打出了真实落点(期望提到 ${junctionOutside})`,
    junctionScaffold.output.slice(-300)
  );
}
// junction 造不出来的机器上,至少钉住"真拿真实路径核过"(不是靠字符串就完事)
const stampSource = readFileSync(join(TOOLS, "lib", "stamp.mjs"), "utf8");
const scaffoldSource = readFileSync(join(TOOLS, "setup-scaffold.mjs"), "utf8");
check(
  /realpathSync/u.test(stampSource) && /realEscape/u.test(scaffoldSource),
  "F-13:stamp.mjs 用 realpathSync 核真实落点,骨架的预检复用它(不只查字符串)"
);

// ── F-04:骨架失败时不许谎报"原有文件没有改动" ────────────────────────────────
//
// 复现:`<根>/uart/.fpga-workbench.json` 这个锚点位置被一个**目录**占着 —— 覆盖时"先留快照"那一步
// 失败(EISDIR,复制不了目录)。而在此之前,工程级与模块级的**目录已经全建出来了**、根锚点也**已经
// 写好了**。修前那句"落盘失败,原有文件没有改动"就是谎报;现在错误信息里必须如实列出**已经发生的
// 动作**(零删除:不回滚,只报告),留在盘上的东西也要真在。
const halfRoot = join(SANDBOX, `half-fail-${stamp}`);
mkdirSync(join(halfRoot, "uart", ".fpga-workbench.json"), { recursive: true });
const halfFail = runStderr("setup-scaffold.mjs", [halfRoot, "--kind", "project", "--modules", "uart", "--force"]);
check(halfFail.code === 1, `骨架建到一半失败 → 退出码 1(实际 ${String(halfFail.code)})`);
check(
  !halfFail.output.includes("原有文件没有改动") && /已经发生的动作[^]*新建目录 \d+ 个:/u.test(halfFail.output),
  "失败信息带着「已经发生的动作」**及其明细**,不再谎报「原有文件没有改动」",
  halfFail.output.slice(-400)
);
const actionLine = (prefix) => halfFail.output.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith(prefix)) ?? "";
const halfDirs = actionLine("新建目录 ");
const halfFiles = actionLine("新建 / 覆盖文件 ");
check(
  /新建目录 \d+ 个:/u.test(halfDirs) && !halfDirs.includes("(无)") && halfFiles.includes(".fpga-workbench.json"),
  "如实列出一半的活:建了哪些目录、写好了哪个锚点(不回滚、不谎报)",
  `${halfDirs} | ${halfFiles}`
);
check(
  existsSync(join(halfRoot, "project", "impl")) && existsSync(join(halfRoot, "uart", "rtl"))
    && readFileSync(join(halfRoot, ".fpga-workbench.json"), "utf8").includes("project"),
  "留下的那些**确实在盘上**(零删除:不删、不回滚,处置交给使用者)"
);

// 写前全量可写性预检:只读的目标要在**动手之前**发现(不然就是建了一半才发现写不进去)
const roRoot = join(SANDBOX, `preflight-ro-${stamp}`);
mkdirSync(roRoot, { recursive: true });
const roAnchor = join(roRoot, ".fpga-workbench.json");
writeFileSync(roAnchor, `${JSON.stringify({ kind: "module", spec: "spec/spec.md" }, null, 2)}\n`);
chmodSync(roAnchor, 0o444);
const roFail = runStderr("setup-scaffold.mjs", [roRoot, "--force"]);
check(roFail.code === 1, `只读锚点 + --force → 退出码 1(实际 ${String(roFail.code)})`);
check(
  roFail.output.includes("写前预检不通过") && roFail.output.includes(roAnchor),
  "只读目标在「写前预检」就被发现(不是建到一半才报)",
  roFail.output.slice(-300)
);
check(!existsSync(join(roRoot, "verif")), "预检不过时一个环节目录都没建(真正提前失败)");

// ── 环节目录的位置被**同名文件**占着时,不许当"目录已存在"跳过 ────────────────────
//
// 复现:落盘那一步原来用 `existsSync(dir)` 判"已存在" —— 一个**同名文件**也算,于是被当成"目录建好了"
// 跳过;全跳过之后就打出"骨架已完整,无需改动。",可 `rtl/` 根本建不出目录、下游技能写不进去
// (与 F-04 同形状的谎报)。现在必须:退 1、指名道姓说哪个位置不是目录、一个环节目录都不建、
// 用户那个同名文件原样不动(零删除)。`--dry-run` 也走同一关,不许预演成"将要建立"。
const stageFileRoot = join(SANDBOX, `stage-is-file-${stamp}`);
mkdirSync(stageFileRoot, { recursive: true });
const stageFile = join(stageFileRoot, "rtl");
writeFileSync(stageFile, "这里是个文件,不是目录\n");
const stageDry = runStderr("setup-scaffold.mjs", [stageFileRoot, "--dry-run"]);
check(
  stageDry.code === 1 && !stageDry.output.includes("骨架已完整") && !stageDry.output.includes("将要建立"),
  `--dry-run 也不把"位置是文件"预演成"将要建立"/"骨架已完整"(退出码 ${String(stageDry.code)})`,
  stageDry.output.slice(-300)
);
const stageFail = runStderr("setup-scaffold.mjs", [stageFileRoot]);
check(stageFail.code === 1, `环节目录的位置被同名文件占着 → 退出码 1(实际 ${String(stageFail.code)})`);
check(
  !stageFail.output.includes("骨架已完整") && stageFail.output.includes(stageFile),
  "不谎报「骨架已完整」,并指名道姓给出那个位置",
  stageFail.output.slice(-300)
);
check(
  !existsSync(join(stageFileRoot, "spec")) && !existsSync(join(stageFileRoot, "verif")),
  "拒绝时一个环节目录都没建(没动用户的盘)"
);
check(!existsSync(join(stageFileRoot, ".fpga-workbench.json")), "锚点也没写(拒绝发生在任何落盘之前)");
check(
  !existsSync(join(stageFileRoot, INSTRUCTION_FILE)) && readFileSync(stageFile, "utf8").includes("这里是个文件"),
  `拒绝时连工作区指令都没落(零删除:用户那个同名文件原样没动,${INSTRUCTION_FILE} 也没落)`
);

// ── 姊妹口子:锚点 / 规则文件的**位置是目录**、又没给 --force ─────────────────────
//
// 上面那关卡的是"环节目录的位置是文件";这一关卡的是反过来的那一半:`main()` 只预读**根锚点**,
// 工程模式下各模块的锚点、以及工作区指令,都由落盘那一步按"已存在"跳过 —— 位置放的是**目录**时,
// "跳过"就成了谎报的前提:全部"已存在"→ 打出"骨架已完整,无需改动。",可锚点/规则文件根本没写出来。
// 两条都要:退出码 1、点名那个位置、用户那个目录原样不动(零删除)。
const anchorDirRoot = join(SANDBOX, `anchor-is-dir-${stamp}`);
mkdirSync(join(anchorDirRoot, "uart", ".fpga-workbench.json", "inner"), { recursive: true });
writeFileSync(join(anchorDirRoot, "uart", ".fpga-workbench.json", "inner", "keep.txt"), "keep\n");
const anchorDir1 = runStderr("setup-scaffold.mjs", [anchorDirRoot, "--kind", "project", "--modules", "uart"]);
const anchorDir2 = runStderr("setup-scaffold.mjs", [anchorDirRoot, "--kind", "project", "--modules", "uart"]);
check(
  anchorDir1.code === 1 && anchorDir2.code === 1,
  `模块锚点位置是目录(不给 --force)→ 两次都退 1(实际 ${String(anchorDir1.code)} / ${String(anchorDir2.code)})`
);
check(
  !anchorDir1.output.includes("骨架已完整") && !anchorDir2.output.includes("骨架已完整") &&
    anchorDir2.output.includes(join(anchorDirRoot, "uart", ".fpga-workbench.json")),
  "第二次全「已存在」时也不谎报「骨架已完整」,并点名那个位置",
  anchorDir2.output.slice(-300)
);
check(
  !existsSync(join(anchorDirRoot, "project")) && !existsSync(join(anchorDirRoot, "uart", "rtl")),
  "拒绝发生在任何落盘之前(工程与模块的环节目录都没建)"
);
check(
  readFileSync(join(anchorDirRoot, "uart", ".fpga-workbench.json", "inner", "keep.txt"), "utf8").includes("keep"),
  "用户那个目录连同里面的东西原样没动(零删除)"
);

const rulesDirRoot = join(SANDBOX, `rules-is-dir-${stamp}`);
mkdirSync(join(rulesDirRoot, "spec", "explore"), { recursive: true });
for (const stage of ["rtl", "verif", "synth"]) mkdirSync(join(rulesDirRoot, stage), { recursive: true });
writeFileSync(join(rulesDirRoot, ".fpga-workbench.json"), '{"kind":"module","spec":"spec/spec.md"}\n');
mkdirSync(join(rulesDirRoot, INSTRUCTION_FILE), { recursive: true });
writeFileSync(join(rulesDirRoot, INSTRUCTION_FILE, "keep.txt"), "keep\n");
const rulesDir = runStderr("setup-scaffold.mjs", [rulesDirRoot]);
check(rulesDir.code === 1, `工作区规则的位置是目录 → 退出码 1(实际 ${String(rulesDir.code)})`);
check(
  !rulesDir.output.includes("骨架已完整") && rulesDir.output.includes(join(rulesDirRoot, INSTRUCTION_FILE)),
  `骨架齐了但规则文件写不出来时,不谎报「骨架已完整」(${INSTRUCTION_FILE} 的位置被点名)`,
  rulesDir.output.slice(-300)
);
check(
  readFileSync(join(rulesDirRoot, INSTRUCTION_FILE, "keep.txt"), "utf8").includes("keep"),
  "用户那个目录原样没动(零删除)"
);

// ── IP 时序卡:rtl/ip/<ip>/timing.json 缺了 / 读不出来 → 警告(不拦门禁) ─────────
//
// 约定来自用户工程里的实际做法(2026-09-21):每个 IP 目录一张卡,写**实测**出来的时序前提。
// 卡是给人看的前提,缺了不该拦住 lint(所以是警告);但它必须被看见 —— 换实现时读的正是它。
const ipCardRoot = join(SANDBOX, `ip-card-${stamp}`);
mkdirSync(join(ipCardRoot, "rtl", "ip", "xpm_fifo_sync"), { recursive: true });
writeFileSync(join(ipCardRoot, "rtl", "good.sv"), goodRtl);
const noCard = runStdout("module-rtl-check.mjs", [ipCardRoot]);
check(
  noCard.code === 0 && noCard.output.includes("rtl/ip/xpm_fifo_sync/timing.json") &&
    noCard.output.includes("没有 timing.json"),
  `IP 目录没有 timing.json → 警告但不拦门禁(退出码 ${String(noCard.code)})`,
  noCard.output.slice(-400)
);
writeFileSync(
  join(ipCardRoot, "rtl", "ip", "xpm_fifo_sync", "timing.json"),
  `${JSON.stringify({ card: "xpm_fifo_sync @ probe", measured: "2026-09-21", probe: "rtl/ip/xpm_fifo_sync/probe.sv", config: { READ_MODE: "std" } }, null, 2)}\n`
);
const withCard = runStdout("module-rtl-check.mjs", [ipCardRoot]);
check(
  withCard.code === 0 && !withCard.output.includes("没有 timing.json") && !withCard.output.includes("缺栏目"),
  "补上完整的 timing.json(四栏齐全)后那条警告消失(卡在就放行)"
);
writeFileSync(
  join(ipCardRoot, "rtl", "ip", "xpm_fifo_sync", "timing.json"),
  `${JSON.stringify({ card: "xpm_fifo_sync", config: {} }, null, 2)}\n`
);
const partialCard = runStdout("module-rtl-check.mjs", [ipCardRoot]);
check(
  partialCard.code === 0 && /缺栏目:measured、probe/u.test(partialCard.output),
  "timing.json 少了 measured / probe → 警告点出缺哪栏(卡片要能复核)",
  partialCard.output.slice(-300)
);
// N-12:光"四个键都在"不算合格 —— 空串 / 空 config / 探针不存在 / 一条数值都没有,都要点出来
writeFileSync(
  join(ipCardRoot, "rtl", "ip", "xpm_fifo_sync", "timing.json"),
  `${JSON.stringify({ card: "xpm_fifo_sync", measured: "2026-09-21", probe: "rtl/ip/xpm_fifo_sync/probe_missing.sv", config: {} }, null, 2)}\n`
);
const hollowCard = runStdout("module-rtl-check.mjs", [ipCardRoot]);
check(
  hollowCard.code === 0 && /探针找不到/u.test(hollowCard.output) && /config 要是非空对象/u.test(hollowCard.output) && /数值都没有/u.test(hollowCard.output),
  "空洞的卡(config 空、探针不在、没有数值)→ 三条都点出来(N-12)",
  hollowCard.output.slice(-400)
);
writeFileSync(
  join(ipCardRoot, "rtl", "ip", "xpm_fifo_sync", "probe.sv"),
  "// probe\n"
);
writeFileSync(
  join(ipCardRoot, "rtl", "ip", "xpm_fifo_sync", "timing.json"),
  `${JSON.stringify({ card: "xpm_fifo_sync", measured: "2026-09-21", probe: "rtl/ip/xpm_fifo_sync/probe.sv", config: { READ_MODE: "std" }, read_latency: 2 }, null, 2)}\n`
);
const realCardNow = runStdout("module-rtl-check.mjs", [ipCardRoot]);
check(
  !/timing\.json/u.test(realCardNow.output) || !/不完整|缺栏目/u.test(realCardNow.output),
  "填全之后(探针真在、有数值)不再报卡的问题"
);
writeFileSync(join(ipCardRoot, "rtl", "ip", "xpm_fifo_sync", "timing.json"), '{ broken json\n');
const badCard = runStdout("module-rtl-check.mjs", [ipCardRoot]);
check(
  badCard.code === 0 && badCard.output.includes("解析不了"),
  "timing.json 解析不了 → 一样报警告(读不出来的卡等于没有卡)",
  badCard.output.slice(-300)
);
// 直接放一个**文件**在 rtl/ip/ 下时不受这条影响:只有"一个 IP 一个目录"才要求卡
writeFileSync(join(ipCardRoot, "rtl", "ip", "vendor_models.sv"), "// foreign model\n");
const withLoose = runStdout("module-rtl-check.mjs", [ipCardRoot]);
check(
  withLoose.code === 0 && !withLoose.output.includes("vendor_models.sv/timing.json"),
  "rtl/ip/ 下的普通文件不当成 IP 目录(不误报)"
);

// ── 端口类型 / 字面量 / 内部 wire:用户口径(2026-09-21)───────────────────────
//
// 三条都是**警告**(写法类,不拦门禁),但都要真的报出来;而且要躲开三个已知的误报来源:
//   ① 函数 / 任务的形参写 `input logic x` 是正常的;
//   ② `1'b0` 这种"带宽度"的写法不许报(实测你代码里 223 处);
//   ③ 声明了但没用到的 wire 不算"内部 wire 用错"(那是没用上)。
const nameRuleFile = join(SANDBOX, `style-${stamp}.sv`);
const nameRuleIssues = (body) => {
  writeFileSync(nameRuleFile, ["`resetall", "`default_nettype none", "module m (", body, ");", "endmodule", "`default_nettype wire", ""].join("\n"));
  return checkFile(nameRuleFile, false).map((issue) => `${issue.rule}|${issue.message}`);
};
const hasIssue = (issues, pattern) => issues.some((line) => pattern.test(line));
check(
  hasIssue(nameRuleIssues("    input logic  clk"), /端口类型\|端口方向与类型不搭:input logic → input wire/u),
  "input 用了 logic → 端口类型警告(提示改成 wire)"
);
check(
  hasIssue(nameRuleIssues("    output wire dout"), /端口类型\|端口方向与类型不搭:output wire → output logic/u),
  "output 用了 wire → 端口类型警告(提示改成 logic)"
);
check(
  !hasIssue(nameRuleIssues(["    input wire clk,", "    output logic dout"].join("\n")),
    /端口类型\|端口方向与类型不搭/u
  ),
  "规范写法(input wire / output logic)不报"
);
check(
  !hasIssue(nameRuleIssues(["    input wire clk,", "    output logic dout", "    function automatic logic f (", "        input logic x", "    );", "        return x;", "    endfunction"].join("\n")),
    /端口类型\|端口方向与类型不搭/u
  ),
  "函数 / 任务的形参 `input logic` 不当成端口(不误报)"
);
check(
  hasIssue(nameRuleIssues("    assign dout = '0"), /字面量写法\|禁止「'0」/u),
  "禁止 `'0` 这种无宽度填充写法(报出来)"
);
check(
  hasIssue(nameRuleIssues("    assign dout = 'b0"), /字面量写法\|字面量没带宽度/u),
  "`'b0` 这种基前不带宽度 → 警告"
);
check(
  !hasIssue(nameRuleIssues("    assign dout = 1'b0"), /字面量写法/u),
  "`1'b0` 是合法写法(带宽度),不报(否则你代码里 223 处全红)"
);
check(
  !hasIssue(nameRuleIssues("    assign dout = '{default: 1'b0}"), /字面量写法/u),
  "赋值模式 `'{default: …}`(数组清零用)不当成无宽度填充"
);
// 恒真断言(`X |-> X`):"有断言"不等于"有设计检查"(第三轮复审 N-07)
check(
  hasIssue(nameRuleIssues("    assert property (@(posedge clk) rst |-> rst);"), /恒真断言/u),
  "恒真断言 `rst |-> rst` → 警告(它不管设计怎样都通过)"
);
check(
  !hasIssue(nameRuleIssues("    assert property (@(posedge clk) rst |=> !done);"), /恒真断言/u),
  "真正要守的性质(前后件不是同一标识符)不报恒真断言"
);
check(
  hasIssue(nameRuleIssues(["    input wire clk,", "    output logic dout", "    wire mid;", "    assign mid = clk;"].join("\n")),
    /内部 wire\|内部 signal 'mid' 用了 wire/u
  ),
  "内部 wire 没接实例端口 → 警告(该用 logic)"
);
check(
  !hasIssue(nameRuleIssues(["    input wire clk,", "    output logic dout", "    wire mid;", "    sub u0 (.a(clk), .b(mid));"].join("\n")),
    /内部 wire/u
  ),
  "内部 wire 真的接了实例之间的连接网 → 不报"
);
check(
  !hasIssue(nameRuleIssues(["    input wire clk,", "    output logic dout", "    wire unused_net;"].join("\n")),
    /内部 wire/u
  ),
  "声明了但没用到的 wire → 不报(那是没用上,不是类型问题)"
);

// ── 结论报告的证据路径校验(module-report-check) ──────────────────────────────
//
// 判据来自用户工程里的实际写法(2026-09-21 照 `spec/spec.md` 的 AC 表 + `verif/*.md` 的引用写的):
//   ① AC 表行里声明的证据位置必须真的在(但只在模块**已经写出结论**之后才要求 —— 还没做到时红线
//      会变成噪音);② 结论文件引用的路径必须存在;③ 行号后缀(`rtl/x.sv:120-140`)摘掉后再核;
//   ④ 可再生目录(`work/`)里的东西不在不算错(用户口径:跑一次就重生成)。
const rcRoot = join(SANDBOX, `report-check-${stamp}`);
const writeReport = (rel, text) => {
  mkdirSync(join(rcRoot, dirname(rel)), { recursive: true });
  writeFileSync(join(rcRoot, rel), text);
};
const acSpec = (evidence) => [
  "# spec",
  "",
  "| 编号 | 判据 | 怎么验 | 证据 |",
  "|---|---|---|---|",
  `| AC-001 | 逐像素一致 | 独立重推 | \`${evidence}\` |`,
  ""
].join("\n");
writeReport("rtl/good.sv", goodRtl);

// 场景 A:只有 spec(还没做验证)→ AC 里那条还不存在的证据位置只报 info,不判错
writeReport("spec/spec.md", acSpec("verif/comp_report.md"));
const notYet = runStdout("module-report-check.mjs", [rcRoot]);
check(
  notYet.code === 0 && notYet.output.includes("还不存在"),
  `还没写结论文件时,AC 里的证据位置缺失只报 info、不判错(退出码 ${String(notYet.code)})`,
  notYet.output.slice(-300)
);

// 场景 B:已经有了结论文件,而 AC 声明的证据位置不存在 → 这就是"看着验过了"
writeReport("spec/spec.md", acSpec("verif/nowhere.md"));
writeReport("verif/verif.md", "# 验证报告\n\n结论: PASS\n");
const staleAc = runStdout("module-report-check.mjs", [rcRoot]);
check(
  staleAc.code === 1 && staleAc.output.includes("verif/nowhere.md"),
  `写出结论后 AC 声明的证据位置不存在 → 退 1 并点名(实际 ${String(staleAc.code)})`,
  staleAc.output.slice(-300)
);

// 场景 C:结论文件里的引用 —— 行号摘掉再核;可再生的缺失不判错;已退役 IP 的引用要判
writeReport("spec/spec.md", acSpec("verif/comp_report.md"));
writeReport("verif/comp_report.md", "# 比对报告\n\n结论: PASS\n");
writeReport(
  "verif/verif.md",
  [
    "# 验证报告",
    "",
    "结论: PASS",
    "",
    "- 比对脚本:`verif/comp_report.md`",
    "- 行号引用:`rtl/good.sv:120-140`(行号不该当文件名)",
    "- 仿真波形:`verif/work/vsim.wlf`(可再生目录,不在不算错)",
    "- 已退役的 IP 卡:`rtl/ip/retired_ip/timing.json`",
    ""
  ].join("\n")
);
const mixed = runStdout("module-report-check.mjs", [rcRoot]);
check(
  mixed.code === 1 && mixed.output.includes("rtl/ip/retired_ip/timing.json"),
  "结论文件引用了不存在的路径 → 退 1(并点名那条)",
  mixed.output.slice(-400)
);
check(
  !mixed.output.includes("FAIL") || !/FAIL[^\n]*rtl\/good\.sv/u.test(mixed.output),
  "带行号的引用摘掉行号后再核:文件在就算过"
);
check(
  /verif\/work\/vsim\.wlf[^\n]*可再生/u.test(mixed.output),
  "可再生目录(work/)里的东西缺失只报 info、不当成错"
);

// 场景 D:依据的**摘要**变了 → 只警告(不影响退出码);`--record` 之后不再报
writeReport("spec/spec.md", acSpec("verif/comp_report.md"));
writeReport("verif/comp_report.md", "# 比对报告\n\n结论: PASS\n");
writeReport("verif/sim.log", "cycle 0 ok\n");
writeReport(
  "verif/verif.md",
  ["# 验证报告", "", "结论: PASS", "", "- 比对脚本:`verif/comp_report.md`", "- 仿真日志:`verif/sim.log`", ""].join("\n")
);
const recordRun = runStdout("module-report-check.mjs", [rcRoot, "--record"]);
check(
  recordRun.code === 0 && /sha256=[0-9a-f]{64}/u.test(readFileSync(join(rcRoot, "verif", "verif.md"), "utf8")) &&
    /旧版本留在/u.test(recordRun.output),
  "--record 把证据摘要写进报告(覆盖前留旧版本)",
  recordRun.output.slice(-200)
);
const recorded = runStdout("module-report-check.mjs", [rcRoot]);
check(
  recorded.code === 0 && !recorded.output.includes("摘要变了"),
  `记完摘要后不报(重跑同样的输出不该天天报,退出码 ${String(recorded.code)})`
);
writeReport("verif/sim.log", "cycle 0 ok\ncycle 1 CHANGED\n");
const digested = runStdout("module-report-check.mjs", [rcRoot]);
check(
  digested.code === 0 && /摘要变了/u.test(digested.output) && /verif\/sim\.log/u.test(digested.output),
  `依据内容真的变了 → 警告(不判错,退出码 ${String(digested.code)})`,
  digested.output.slice(-300)
);
// N-08:依据变了之后,**不许**用 --record 直接盖章;要先确认,再显式 --accept-changed
// (拒绝信息走 stderr —— 那是错误通道,所以这里用 runStderr 抓)
const blockedRecord = runStderr("module-report-check.mjs", [rcRoot, "--record"]);
check(
  blockedRecord.code === 1 && /内容变了/u.test(blockedRecord.output) && /verif\/sim\.log/u.test(blockedRecord.output),
  `依据变了时 --record 拒绝盖章、点出是哪个文件(实际退出码 ${String(blockedRecord.code)})`,
  blockedRecord.output.slice(-300)
);
const acceptedRecord = runStdout("module-report-check.mjs", [rcRoot, "--record", "--accept-changed"]);
check(
  acceptedRecord.code === 0 && /接受.*verif\/sim\.log/u.test(acceptedRecord.output),
  "--accept-changed 才写回新摘要,并说明「接受了哪些变更」",
  acceptedRecord.output.slice(-300)
);
const afterAccept = runStdout("module-report-check.mjs", [rcRoot]);
check(
  afterAccept.code === 0 && !/摘要变了/u.test(afterAccept.output),
  "接受后重跑不再报摘要变化"
);

// 场景 E:器件一致性(模块 spec vs 它所属工程 spec,用户口径 2026-09-21:器件只写一处)
const projRoot = join(SANDBOX, `device-${stamp}`);
const devMod = join(projRoot, "uart_rx");
mkdirSync(join(projRoot, "project", "spec"), { recursive: true });
mkdirSync(join(devMod, "spec"), { recursive: true });
writeFileSync(join(projRoot, "project", "spec", "spec.md"), "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
writeFileSync(join(devMod, "spec", "spec.md"), "# 模块 spec\n\n- 器件型号:xc7z020clg484-1\n");
const deviceBad = runStdout("module-report-check.mjs", [devMod]);
check(
  deviceBad.code === 0 && /器件\(xc7z020clg484-1\)与工程 spec 器件\(xc7a100tfgg484-2\)不一致/u.test(deviceBad.output),
  `模块 spec 与工程 spec 的器件不一致 → 警告(不判错,退出码 ${String(deviceBad.code)})`,
  deviceBad.output.slice(-300)
);
writeFileSync(join(devMod, "spec", "spec.md"), "# 模块 spec\n\n- 器件见工程 spec(不重述)\n");
const deviceOk = runStdout("module-report-check.mjs", [devMod]);
check(
  deviceOk.code === 0 && !deviceOk.output.includes("器件两处不一致"),
  "模块 spec 不重述器件(以工程为准)→ 不报"
);

// 场景 F:第三轮复审 N-03 / N-04 / N-05 / N-09 —— 空检查不是通过、器件按字段读、证据不许越界
const scopeRoot = join(SANDBOX, `inscope-${stamp}`);
mkdirSync(join(scopeRoot, "spec"), { recursive: true });
mkdirSync(join(scopeRoot, "verif"), { recursive: true });
const bare = runStdout("module-report-check.mjs", [scopeRoot]);
check(
  bare.code === 0 && /NO_REPORTS/u.test(bare.output) && !/^PASS/mu.test(bare.output),
  "一份文件都没有 → NO_REPORTS,不能叫 PASS(N-03)",
  bare.output.slice(-200)
);
// N-09:只有草稿(没有「结论:」行)时,AC 里缺证据只报 info —— 以前任何 verif/*.md 都会触发硬失败
writeFileSync(join(scopeRoot, "spec", "spec.md"), acSpec("verif/nowhere.md"));
writeFileSync(join(scopeRoot, "verif", "debug.md"), "# 调试草稿\n\n- 临时引用:`verif/nowhere.md`\n");
const draftOnly = runStdout("module-report-check.mjs", [scopeRoot]);
check(
  draftOnly.code === 0,
  `只有草稿(没有「结论:」行)时 AC 缺证据不判错(实际退出码 ${String(draftOnly.code)})`,
  draftOnly.output.slice(-260)
);
// N-03:有结论文件但一条证据路径都没引用 → NO_EVIDENCE,同样不能叫 PASS
writeFileSync(join(scopeRoot, "spec", "spec.md"), "# spec(没有 AC 表)\n");
writeFileSync(join(scopeRoot, "verif", "debug.md"), "# 调试草稿(清空引用)\n");
writeFileSync(join(scopeRoot, "verif", "verif.md"), "# 验证报告\n\n结论: PASS\n");
const noEvidence = runStdout("module-report-check.mjs", [scopeRoot]);
check(
  noEvidence.code === 0 && /NO_EVIDENCE/u.test(noEvidence.output) && !/^PASS/mu.test(noEvidence.output),
  "有结论但零引用 → NO_EVIDENCE,不能叫 PASS(N-03)",
  noEvidence.output.slice(-200)
);
// N-05:证据路径越界(`..` / 绝对路径)一律如实报,且不拿它去核存在性
writeFileSync(join(scopeRoot, "verif", "verif.md"), ["# 验证报告", "", "结论: PASS", "", "- 越界引用:`verif/../../outside.txt`", ""].join("\n"));
const escaped = runStdout("module-report-check.mjs", [scopeRoot]);
check(
  escaped.code === 1 && /必须留在模块根里面/u.test(escaped.output) && escaped.output.includes("verif/../../outside.txt"),
  `证据路径越出模块根 → FAIL 并点名(实际退出码 ${String(escaped.code)})`,
  escaped.output.slice(-300)
);
// N-04:UltraScale 型号按**字段行**读(老正则 `x[a-z]?\d` 匹配不上 xcku040/xczu7ev → 静默不报)
const usRoot = join(SANDBOX, `ultrascale-${stamp}`);
const usMod = join(usRoot, "uart_rx");
mkdirSync(join(usRoot, "project", "spec"), { recursive: true });
mkdirSync(join(usMod, "spec"), { recursive: true });
writeFileSync(join(usRoot, "project", "spec", "spec.md"), "# 工程 spec\n\n- 器件型号:xcku040-ffva1156-2-e\n");
writeFileSync(join(usMod, "spec", "spec.md"), "# 模块 spec\n\n- 器件型号:xczu7ev-ffvc1156-2-e\n");
const usBad = runStdout("module-report-check.mjs", [usMod]);
check(
  /器件\(xczu7ev-ffvc1156-2-e\)与工程 spec 器件\(xcku040-ffva1156-2-e\)不一致/u.test(usBad.output),
  "UltraScale 器件(xcku040 / xczu7ev)能读出来并判不一致(N-04)",
  usBad.output.slice(-300)
);

// 场景 G:sync-installed 半途失败 → 必须说清"混合状态"、退出码非 0(第三轮复审 N-10)
//   造法:在沙箱 profile 里把本该写文件的位置**放成目录**(copyFileSync 对它必然 EPERM),
//   且它排在写入顺序的第二个 —— 于是恰好是"写了一个、第二个失败"的半途状态。
const syncSb = join(SANDBOX, `sync-partial-${stamp}`);
const syncInstalled = join(syncSb, "profiles", "desktop", "node_modules", "dsh-fpga-workbench");
mkdirSync(join(syncInstalled, "lib", "client.js"), { recursive: true });
writeFileSync(join(syncInstalled, "package.json"), "{}\n");
const savedProfileDir = process.env.DSH_PROFILE_DIR;
process.env.DSH_PROFILE_DIR = join(syncSb, "profiles", "desktop");
// 中断信息走 stderr(错误通道),所以用 runStderr 抓
const syncPartial = runStderr("sync-installed.mjs", []);
if (savedProfileDir === undefined) delete process.env.DSH_PROFILE_DIR;
else process.env.DSH_PROFILE_DIR = savedProfileDir;
check(
  syncPartial.code === 1 && /混合状态/u.test(syncPartial.output) && /已写入 \d+\/\d+ 个文件/u.test(syncPartial.output),
  `sync-installed 半途失败 → 退出码 1 并说清"混合状态 + 已写几个"(实际 ${String(syncPartial.code)})`,
  syncPartial.output.slice(-300)
);

// ── F-03:check-patch-file.mjs 不许写死仓库绝对路径 ───────────────────────────
//
// 写死 `C:/Work/dsh-fpga-workbench/cordis.patch.yml` 的后果是"克隆到别处就断"。改成按
// `import.meta.url` 相对定位 —— 这里同时钉住两件事:不再有绝对路径、用的是 import.meta.url。
const patchCheckSource = readFileSync(join(ROOT, "tools", "check-patch-file.mjs"), "utf8");
check(
  !/[A-Za-z]:[\\/][^"'\n]*cordis\.patch\.yml/u.test(patchCheckSource),
  "check-patch-file.mjs 里没有写死的仓库绝对路径(克隆到别处也找得到补丁)"
);
check(
  /import\.meta\.url/u.test(patchCheckSource) && /cordis\.patch\.yml/u.test(patchCheckSource),
  "check-patch-file.mjs 按 import.meta.url 相对定位补丁文件"
);

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 自带工具脚本判定正确(含自带模板自洽)");
if (failures.length > 0) process.exitCode = 1;

// 收尾:沙箱**不删**(用户定案:绝不永久删除),只报一次。残留会一直涨 —— 这是零删除的代价,
// 所以清单要打出来让人能处置;别为了"干净"在这里加回删除调用(生产代码的静态守卫也会拦)。
const sandboxLeftover = listTempLeftovers(join(ROOT, ".tmp"), [`fpga-tools-check-${String(process.pid)}`]);
if (sandboxLeftover.length > 0 && existsSync(SANDBOX)) {
  console.log(`\n自检沙箱留在原处(按用户定案不删除):${SANDBOX}`);
}
