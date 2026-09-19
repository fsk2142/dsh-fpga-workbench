// 自带工具脚本的功能自检(spec-scaffold / rtl-new / rtl-check / verif-new / synth-new)。
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

import { checkFile, collectHdl } from "../presets/fpga-workbench/tools/module/rtl-check.mjs";
import { applyScaffold, planScaffold } from "../presets/fpga-workbench/tools/spec-scaffold.mjs";
import { defaultDestination, renderTemplate } from "../presets/fpga-workbench/tools/lib/stamp.mjs";
import { modelSimDo, pickTestbench, simulatorKind } from "../presets/fpga-workbench/tools/module/verif-wave.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "presets", "fpga-workbench", "tools");
// 级别落到目录上:模块级命令在 tools/module/(工程级的以后放 tools/project/)
const MODULE_TOOLS = join(TOOLS, "module");
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
  dryRun.created.length === modulePlan.dirs.length + 1 && !existsSync(scaffoldMod),
  "--dry-run 只报告不落盘(根目录都没建出来)"
);

const applied = applyScaffold(modulePlan, {});
check(
  applied.created.length === modulePlan.dirs.length + 1,
  `落盘:${modulePlan.dirs.length} 个目录 + 1 个锚点(实际 ${applied.created.length})`
);
check(
  existsSync(join(scaffoldMod, ".fpga-workbench.json")) && existsSync(join(scaffoldMod, "verif")),
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
  projectPlan.dirs.some((dir) => dir.endsWith(join("uart", "verif"))) && projectPlan.dirs.some((dir) => dir.endsWith(join("ddr", "synth"))),
  "每个模块各自一套模块级文件夹"
);

// ── 起文件(rtl-new / verif-new / synth-new:各环节一个入口,只替模块名) ──────
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
check(defaultDestination("xdc", "UartRx", "C:/t/c.xdc") === join("synth", "UartRx.xdc"), "约束文件落 synth/<模块名>.xdc");
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

// ── CLI 退出码 ─────────────────────────────────────────────────────────────
// spec-scaffold 是两级共用(在 tools/ 顶层);其余被调用的都是模块级命令(在 tools/module/)
const run = (script, args) => {
  const path = existsSync(join(TOOLS, script)) ? join(TOOLS, script) : join(MODULE_TOOLS, script);
  return spawnSync(process.execPath, [path, ...args], { stdio: "ignore" }).status;
};


// 语言边界:TB 扩展名跟设置里选的仿真语言走 —— 只认 .sv 的话,Verilog 的测试平台会被静默跳过
mkdirSync(join(SANDBOX, "tb-v-mod", "rtl"), { recursive: true });
mkdirSync(join(SANDBOX, "tb-v-mod", "verif"), { recursive: true });
writeFileSync(join(SANDBOX, "tb-v-mod", "verif", "tb_only.v"), goodTb);
check(
  run("rtl-check.mjs", [join(SANDBOX, "tb-v-mod")]) === 0,
  "verif/ 下的 .v 测试平台会被检查(只认 .sv 的话这里会退 2)"
);
mkdirSync(join(SANDBOX, "vhdl-mod", "rtl"), { recursive: true });
writeFileSync(join(SANDBOX, "vhdl-mod", "rtl", "top.vhd"), "-- VHDL 源码\n");
check(run("rtl-check.mjs", [join(SANDBOX, "vhdl-mod")]) === 2, "纯 VHDL 项目:如实退 2(本检查器不覆盖,不得当通过)");

check(run("rtl-check.mjs", [join(SANDBOX, "good-mod")]) === 0, "check-rtl 合规 → 退出码 0");
check(run("rtl-check.mjs", [join(SANDBOX, "bad-mod")]) === 1, "check-rtl 违规 → 退出码 1");
check(run("rtl-check.mjs", [join(SANDBOX, "warn-mod")]) === 0, "check-rtl 只有警告 → 退出码 0(警告不拦门禁)");
check(run("rtl-check.mjs", [join(SANDBOX, "no-such-mod")]) === 2, "check-rtl 没有 rtl/ → 退出码 2");
check(run("spec-scaffold.mjs", []) === 2, "spec-scaffold 不给根目录 → 退出码 2");
// 起文件:不覆盖已有文件、模板不存在要报错
const newFileRoot = join(SANDBOX, `new-file-${stamp}`);
check(
  run("rtl-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv")]) === 0,
  "rtl-new 按模板起文件 → 退出码 0"
);
check(existsSync(join(newFileRoot, "rtl", "uart_rx.sv")), "RTL 落在 rtl/ 下");
check(
  run("rtl-check.mjs", [newFileRoot]) === 0,
  "模板生成的文件直接过机械检查(骨架开箱合规)"
);
check(
  run("verif-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "tb.sv")]) === 0
    && existsSync(join(newFileRoot, "verif", "tb_uart_rx.sv")),
  "verif-new 把测试平台落在 verif/tb_<snake>.sv"
);

// ── verif-wave:看波形的手段(用户明确要求"要看波形时必须真有这条")────────────────
// 只验生成物与判定,不真的开 GUI:开窗会卡住自检。生成的脚本语法另外用真 vsim 批处理跑过
// (`vsim -gui` 换成 `vsim -c`),`log`/`add wave`/`cd` 这些命令都实测过。
check(
  run("verif-wave.mjs", [newFileRoot, "--sim-path", join(TEMPLATES, "..", "tools", "xsim-placeholder"), "--dry-run"]) === 0,
  "verif-wave --dry-run 不落盘也能判定(退出码 0)"
);
check(
  pickTestbench(join(newFileRoot, "verif"), undefined, newFileRoot)?.endsWith("tb_uart_rx.sv") === true,
  "能自己认出 verif/ 下的测试平台"
);
const emptyVerif = join(SANDBOX, `wave-empty-${stamp}`);
mkdirSync(emptyVerif, { recursive: true });
check(
  pickTestbench(emptyVerif, undefined, emptyVerif) === undefined,
  "verif/ 下没有测试平台时返回 undefined(CLI 会如实退 1,不硬编一个名字)"
);
check(simulatorKind("C:/modeltech64_2020.4/win64/vsim.exe") === "modelsim", "按路径认出 ModelSim");
check(simulatorKind("C:/Xilinx/Vivado/2025.2/bin") === "xsim", "按路径认出 XSim");
check(simulatorKind("C:/some/other/sim.exe") === undefined, "认不出的仿真器返回 undefined(如实说明,不乱猜)");
const waveScript = modelSimDo(["C:/proj/rtl/a.sv", "C:/proj/verif/tb_a.sv"], "tb_a");
check(
  waveScript.includes('vsim -gui -voptargs="+acc=rn" tb_a') && waveScript.includes("add wave -r /*"),
  "生成的脚本:开 GUI 并把信号加进波形窗口"
);
check(
  waveScript.includes("log -r /*"),
  "生成的脚本有 log -r /*(实测:不加它 wlf 里只有时刻 0,波形是空的)"
);
check(
  waveScript.includes('cd "verif"'),
  "生成的脚本切到 verif/ 再建库(工作库与波形跟 run.do 的结果放一处)"
);
check(
  !/\brun\b/u.test(waveScript.replace(/^#.*$/gmu, "")),
  "生成的脚本不自动 run(GUI 停住等人操作,与批处理 run.do 互补)"
);
check(
  !/[\u4e00-\u9fff]/u.test(waveScript),
  "生成的脚本没有非 ASCII 字符(ModelSim 的 Tcl 不按 UTF-8 读 .do,中文注释会让它报 invalid command)"
);
check(
  run("synth-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "constraints.xdc")]) === 0
    && existsSync(join(newFileRoot, "synth", "uart_rx.xdc")),
  "synth-new 把约束落在 synth/<模块名>.xdc"
);
check(
  run("rtl-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv")]) === 1,
  "已存在的文件不覆盖 → 退出码 1"
);
check(
  run("rtl-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "rtl.sv"), "--force"]) === 0,
  "--force 才覆盖"
);
check(
  run("rtl-new.mjs", [newFileRoot, "uart_rx", "--template", join(TEMPLATES, "no-such.sv")]) === 2,
  "模板不存在 → 退出码 2(不猜模板)"
);
check(run("rtl-new.mjs", [newFileRoot, "uart_rx"]) === 2, "不给 --template → 退出码 2");check(run("spec-scaffold.mjs", [join(SANDBOX, "scaffold-cli"), "--kind", "bogus"]) === 2, "--kind 非法 → 退出码 2");
check(run("spec-scaffold.mjs", [join(SANDBOX, "scaffold-cli")]) === 0, "建模块骨架 → 退出码 0");
check(
  existsSync(join(SANDBOX, "scaffold-cli", "rtl")) && existsSync(join(SANDBOX, "scaffold-cli", ".fpga-workbench.json")),
  "CLI 真的把骨架建出来了"
);
check(run("spec-scaffold.mjs", [join(SANDBOX, "scaffold-cli")]) === 0, "重复建同一目录也返回 0(幂等)");

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 自带工具脚本判定正确(含自带模板自洽)");
if (failures.length > 0) process.exitCode = 1;
