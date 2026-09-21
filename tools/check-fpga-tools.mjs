// 自带工具脚本的功能自检(setup-scaffold / module-rtl-new / module-rtl-check / module-verif-new / module-synth-new)。
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
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkFile, collectHdl } from "../presets/fpga-workbench/tools/module/module-rtl-check.mjs";
import { applyScaffold, planScaffold, readModeRules } from "../presets/fpga-workbench/tools/setup-scaffold.mjs";
import { defaultDestination, renderTemplate } from "../presets/fpga-workbench/tools/lib/stamp.mjs";
import { SWEEP_GRACE_MS, sweepTempEntries } from "../lib/toolchain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "presets", "fpga-workbench", "tools");
// 级别落到目录上:模块级命令在 tools/module/(工程级的以后放 tools/project/)
const MODULE_TOOLS = join(TOOLS, "module");
const TEMPLATES = join(ROOT, "presets", "fpga-workbench", "templates");
const SANDBOX = join(ROOT, ".tmp", `fpga-tools-check-${String(process.pid)}`);
// 自检自己收尾:这个沙箱每次跑都重建(内容用时间戳区分),跑完整个删掉 —— 否则它会一直涨。
// 沙箱名带进程号、开头这次清理带宽限期:两个自检(`npm test` 与 `npm run test:installed`)
// 并行跑同一批检查时,别把对方正在用的沙箱删掉。
sweepTempEntries(join(ROOT, ".tmp"), ["fpga-tools-check"], SWEEP_GRACE_MS);

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
  !assertIssues.some((issue) => issue.line === secondAssertLine),
  `第二条(说明齐全)没被连坐(第 ${secondAssertLine} 行)`
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

// 读不到 / 说不清就**不猜**:spec 里器件写成"待定 + 两个候选"时,那两行必须还是模板原样
writeFileSync(specFile, [
  "# spec:uart_rx", "",
  "## 目标器件", "",
  "器件型号:待定(候选 xc7a100tfgg484-2 或 xc7z020clg484-1)", ""
].join("\n"));
const ambiguousText = run("module-synth-new.mjs", [specMod, "uart_rx", "--kind", "synth-script", "--force"]) === 0
  && existsSync(specScript)
  ? readFileSync(specScript, "utf8")
  : "";
check(
  ambiguousText === renderTemplate(bundledRunSynth, "uart_rx").text,
  "spec 里说不清器件(两个候选)时:脚本与模板逐字节一致(没有猜一个型号写进去)"
);
// 连 spec/spec.md 都没有时同样不猜(new-file 那个模块根只有 rtl/ verif/ synth/)
const noSpecScript = join(newFileRoot, "synth", "run_synth.tcl");
const noSpecCode = run("module-synth-new.mjs", [newFileRoot, "uart_rx", "--kind", "synth-script"]);
check(
  noSpecCode === 0 && existsSync(noSpecScript)
    && readFileSync(noSpecScript, "utf8") === renderTemplate(bundledRunSynth, "uart_rx").text,
  `没有 spec/spec.md 时:脚本起得出来、两行一个都不填(实际退出码 ${noSpecCode})`
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
check(
  run("setup-scaffold.mjs", [forceRoot, "--kind", "project", "--force"]) === 1
    && !existsSync(join(forceRoot, "project"))
    && readFileSync(forceAnchor, "utf8").includes("\"module\""),
  "跨 kind 是硬拒绝:带 --force 也退 1,project/ 与根锚点都没动"
);

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 自带工具脚本判定正确(含自带模板自洽)");
if (failures.length > 0) process.exitCode = 1;

// 收尾:只删自己这个沙箱(名字带进程号,别把并行那次的删了)。残留会让"这次到底跑没跑"看不出来。
if (sweepTempEntries(join(ROOT, ".tmp"), [`fpga-tools-check-${String(process.pid)}`]) === 0 && existsSync(SANDBOX)) {
  console.log("FAIL: 收尾没清掉沙箱");
  process.exitCode = 1;
}
