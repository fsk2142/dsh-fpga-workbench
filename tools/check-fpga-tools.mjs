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
import { spawnSync } from "./lib/spawn.mjs";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync as rawMkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync as rawWriteFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 沙箱写文件的**瞬时锁重试**（N12，2026-10-29 实测）。
 *
 * ## 为什么要它
 *
 * Windows 的 AV / 索引器会短暂锁住新建文件，`writeFileSync` 于是抛 `EPERM (-4048)`。
 * 本文件有 300+ 处写入，任一处撞上都会让**整个自检崩溃** ——
 * 而且崩溃与断言失败长得不一样：**没有 FAIL 行**，只剩一个 exit code 1，
 * 事后完全不知道是哪一步挂的（第19轮审查把这条记为 N12，与"断言失败"的 N6 区分）。
 *
 * ## 怎么做
 *
 * 只对这一层做包装，不改 300 处调用点。只重试**明确的瞬时错误**（EPERM/EBUSY/EACCES），
 * 其它错误照原样抛 —— 不能把「真的没权限」也当瞬时问题掩盖掉。
 *
 * 重试间隔递增（10/30/60/100ms），总共最多 4 次；仍失败就带上路径抛出去，
 * 由顶层 try/catch 转成可读的 FAIL 行。
 */
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EMFILE", "ENFILE"]);
const RETRY_DELAYS_MS = [10, 30, 60, 100];

/** 同步等待（本文件没有异步上下文，重试只能是忙等；单次最多 200ms 总延迟）。 */
const sleepSync = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 忙等：这里只需要几十毫秒，用 Atomics 之类反而更绕
  }
};

/**
 * 带瞬时错误重试地跑一个 fs 调用。
 * @param {() => void} action - 要执行的操作。
 * @param {string} target - 出错时打进错误信息的路径。
 */
const withTransientRetry = (action, target) => {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      action();
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_FS_CODES.has(error.code) || attempt === RETRY_DELAYS_MS.length) {
        // 非瞬时错误、或已用尽重试：补上路径再抛（原始错误常只有 code 没有路径）
        if (typeof error.message === "string" && !error.message.includes(target)) {
          error.message = `${error.message} (${target})`;
        }
        throw error;
      }
      sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
};

/** 顶层用的 writeFileSync：瞬时锁自动重试。 */
const writeFileSync = (file, data, options) =>
  withTransientRetry(() => rawWriteFileSync(file, data, options), String(file));

/** 顶层用的 mkdirSync：AV 也会锁目录创建。 */
const mkdirSync = (dir, options) =>
  withTransientRetry(() => rawMkdirSync(dir, options), String(dir));

// checkFile 现在住在共享纯规则模块里(DSH-N06);checker 只留目录发现与角色等入口侧。
import { checkFile } from "../presets/fpga-workbench/tools/lib/rtl-check-rules.mjs";
import { collectHdl } from "../presets/fpga-workbench/tools/module/module-rtl-check.mjs";
import { PART_SHAPE_CASES, partLooksComplete } from "../presets/fpga-workbench/tools/module/module-synth-new.mjs";
import {
  hasDigestBlock,
  recordedDigests,
  withDigests
} from "../presets/fpga-workbench/tools/module/module-report-check.mjs";
import { INSTRUCTION_FILE, applyScaffold, planScaffold, readModeRules } from "../presets/fpga-workbench/tools/setup-scaffold.mjs";
import { defaultDestination, renderTemplate, snakeCase } from "../presets/fpga-workbench/tools/lib/stamp.mjs";
import { TEMP_GRACE_MS, listTempLeftovers } from "./lib/cleanup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "presets", "fpga-workbench", "tools");
// 级别落到目录上:模块级命令在 tools/module/,工程级命令在 tools/project/
const MODULE_TOOLS = join(TOOLS, "module");
const PROJECT_TOOLS = join(TOOLS, "project");
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

/**
 * 顶层崩溃兜底（N12，2026-10-29）。
 *
 * ## 为什么需要
 *
 * 本文件是**顺序脚本**，没有 main 可包 —— 任一步抛异常（实测：沙箱写文件撞上 Windows
 * AV 的瞬时锁，`EPERM (-4048)`）都会让进程直接崩掉。而崩溃与断言失败**长得不一样**：
 *
 * | 形态 | 输出 | 事后能查到什么 |
 * |---|---|---|
 * | 断言失败（N6） | 有 `FAIL <label>` 行 | 是哪一条断言、哪个工具 |
 * | **崩溃（N12）** | 只有 exit code 1 | **什么都没有** |
 *
 * 所以这里接住未捕获异常，转成一条能定位的 FAIL 行：带错误摘要、出错路径、以及
 * 「跑到哪一步了」（已完成的断言数）。这样重跑时至少知道往哪看。
 *
 * 注意：这是**兜底**，不是替代修复。正常路径仍应让断言把问题说清楚；
 * 走到这里说明遇到了没预料到的环境问题。
 */
process.on("uncaughtException", (error) => {
  const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // **走 stderr**：pnpm test 只保留 stderr 与末尾几行 stdout，
  // 走 stdout 的话这条诊断会被截掉 —— 实测过（第20轮提的 N12 兜底，
  // 提交前那次失败里就没看到这条信息，只能靠日志逐行翻）。
  const lines = [
    "",
    "FAIL  意外崩溃（未捕获异常）",
    `        ${summary}`,
    `        已完成断言：${failures.length === 0 ? "全部通过（崩溃发生在断言之后）" : `${String(failures.length)} 条失败`}`
  ];
  if (typeof error?.stack === "string") {
    const frames = error.stack.split("\n").slice(1, 4).map((line) => line.trim());
    lines.push(`        调用栈：${frames.join(" ← ")}`);
  }
  lines.push(`        沙箱：${SANDBOX}`);
  lines.push("        这类多是 Windows 瞬时文件锁（EPERM/EBUSY），重跑通常即过；反复出现要查 AV/索引器。");
  console.error(lines.join("\n"));
  process.exitCode = 1;
});


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
// 注意:「文件头」与「九个小节块」两条机械检查已移除 —— 它们只查格式（字段名、banner 宽度），
// 对正确性无帮助，且字段名一改或加个中文字就红，属于「留下会造成编写问题」的那类。
// 结构要求保留在规范描述里（模板自带文件头与 9 个 banner，照模板即可）。
for (const expected of ["编译隔离", "端口类型", "always_ff", "复位极性", "end/else", "设计断言", "Tab 字符", "代码行非英文"]) {
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
const templateRtl = blocking(join(TEMPLATES, "rtl", "systemverilog_module.sv"), false);
check(templateRtl.length === 0, "自带 RTL 模板过检查器", templateRtl.map((i) => i.message).join("; "));
const templateTb = blocking(join(TEMPLATES, "simulation", "testbench", "systemverilog_testbench.sv"), true);
check(templateTb.length === 0, "自带测试平台模板过检查器", templateTb.map((i) => i.message).join("; "));

// 2026-09-24(审查报告 T-03/T-13):并发断言必须只在仿真里活,Vivado 合成对它是"忽略"
// (真机 2025.2 实测:`WARNING: [Synth 8-2898] ignoring concurrent assertion`,rc=0)。包 `ifndef
// SYNTHESIS` 后合成不再报这条警告,ModelSim 不定义 SYNTHESIS → 仿真里断言照旧生效。
{
  const rtlSource = readFileSync(join(TEMPLATES, "rtl", "systemverilog_module.sv"), "utf8");
  check(
    /^`ifndef SYNTHESIS[\s\S]{0,600}?assert property[\s\S]{0,200}?`endif/mu.test(rtlSource),
    "RTL 模板的并发断言包在 `ifndef SYNTHESIS 里(仿真照旧生效,合成不再吃那条 ignore 警告)"
  );
  check(
    /zero-time, synthesizable helpers only/u.test(rtlSource) &&
      /No #delay, @\(event\), wait, force\/release, file I\/O or interface stimulus/u.test(rtlSource) &&
      !/example: clock\/reset wait, drive interface/u.test(rtlSource),
    "RTL 模板的 Task 段只允许零时间可综合辅助(不再怂恿往里写时钟/复位等待与接口激励)"
  );
}

// 分类模板是唯一来源；旧的六份平铺模板不得继续存在，否则技能/工具迟早又会走回旧入口。
const retiredFlatTemplates = ["rtl.sv", "tb.sv", "constraints.xdc", "comp.py", "run_synth.tcl", "run.do"];
check(
  retiredFlatTemplates.every((name) => !existsSync(join(TEMPLATES, name))),
  "旧的六份平铺模板已经退出，只保留分类模板",
  retiredFlatTemplates.filter((name) => existsSync(join(TEMPLATES, name))).join("、")
);

// DSH-02:读不到主日志时**不许**说"没有 Critical Warning" —— 那是把"没查"说成"干净"。
// 两份综合模板都必须带 NOT_INSPECTED 分支,并且说明怎么把日志传进来。
for (const [label, file] of [
  ["模块综合", join(TEMPLATES, "synthesis", "vivado_module_synthesis.tcl")],
  ["工程综合", join(TEMPLATES, "synthesis", "vivado_project_synthesis.tcl")]
]) {
  const source = readFileSync(file, "utf8");
  check(
    /MAIN LOG NOT INSPECTED/u.test(source) && /NOT the same as clean/u.test(source),
    `${label}模板在主日志未读到时报 NOT_INSPECTED(而不是"没有 Critical Warning")`
  );
}

// DSH-05:器件以 doc/spec.md 为权威 —— 工程综合读不到器件时必须**失败**(不许 WARN 之后照旧 PASS)。
{
  const projectSynthSource = readFileSync(join(TEMPLATES, "synthesis", "vivado_project_synthesis.tcl"), "utf8");
  check(
    /no device part found in doc\/spec\.md/u.test(projectSynthSource) &&
      /doc\/spec\.md not found/u.test(projectSynthSource),
    "工程综合模板:doc/spec.md 缺失或读不到器件 → fail(不给不带器件核对结论的 PASS)"
  );
  // spec.md 是用户手写、正文通常是 UTF-8 中文。Tcl 的 `open $path r` 用系统编码
  // (中文 Windows 上是 cp936);不显式指定 UTF-8 时,`器件` 会被解成乱码,
  // spec_part 就会返回空、把规格里有器件误判成没有。
  const specPartProc = /proc spec_part \{path\} \{[\s\S]*?\n\}/u.exec(projectSynthSource)?.[0] ?? "";
  check(
    /fconfigure\s+\$fh\s+-encoding\s+utf-8/u.test(specPartProc),
    "spec_part 按 UTF-8 读取 doc/spec.md(不依赖系统编码)"
  );
  // 脚本文件本身也被 Tcl 按系统编码读取;正则里直接写中文时,内存里的模式已是乱码。
  // 必须用 ASCII 的 \u 转义写模式,文件读对了才匹配得上。
  check(
    /regexp\s+"\\u5668\\u4ef6\|Device\|Part"/u.test(specPartProc) &&
      !/regexp\s+\{[^}]*器件/u.test(specPartProc),
    "spec_part 的「器件」模式用 \\u 转义(不依赖脚本文件的读取编码)"
  );

  // 行为测试:把模板里的 spec_part **原样**交给真实 Tcl 跑一遍。
  // 静态断言只能证明"写法像对的";上一轮就是静态断言过了、真机仍然返回空。
  // 没有 ModelSim 时明说跳过,不把跳过记成 PASS。
  const specPartDir = join(SANDBOX, `spec-part-utf8-${String(Date.now())}`);
  mkdirSync(specPartDir, { recursive: true });
  const specFile = join(specPartDir, "spec.md");
  writeFileSync(specFile, "# 工程规格\n\n- 器件: xc7z020clg484-1\n", "utf8");
  const probeScript = join(specPartDir, "spec-part-check.tcl");
  writeFileSync(
    probeScript,
    `${specPartProc}\nset r [spec_part "${specFile.replace(/\\/gu, "/")}"]\nputs "SPEC_PART_RESULT=$r"\n`,
    "utf8"
  );
  const probeLog = join(specPartDir, "vsim.log");
  const probeFd = openSync(probeLog, "w");
  const probe = spawnSync("vsim", ["-c", "-do", `source ${probeScript.replace(/\\/gu, "/")}; quit -f`], {
    stdio: ["ignore", probeFd, "ignore"]
  });
  closeSync(probeFd);
  const probeOutput = existsSync(probeLog) ? readFileSync(probeLog, "utf8") : "";
  if (probe.error !== undefined || probe.status !== 0) {
    console.log(
      `  SKIP 真机 Tcl:spec_part 从 UTF-8 中文 spec 读出器件(本机 vsim 不可用:${probe.error?.message ?? `退出码 ${String(probe.status)}`})—— 记 NOT_TESTED`
    );
  } else {
    check(
      /SPEC_PART_RESULT=xc7z020clg484-1/u.test(probeOutput),
      "真机 Tcl:spec_part 从 UTF-8 中文 spec 读出器件"
    );
  }
}

// DSH-N01:E8-04 只挡了**递归子目录**的链接;collector 的**根目录自己**是 symlink/Junction 时,整段
// 采集会跑到工程外(结论就不再只覆盖工程内文件)。五个采集入口都必须显式拒绝根链接。
for (const [label, file] of [
  ["ModelSim compile", join(TEMPLATES, "simulation", "run", "modelsim_run.do")],
  ["ModelSim run", join(TEMPLATES, "simulation", "run", "modelsim_run.do")],
  ["模块综合", join(TEMPLATES, "synthesis", "vivado_module_synthesis.tcl")],
  ["RTL linter", join(TEMPLATES, "linter", "vivado_rtl_lint.tcl")],
  ["工程综合", join(TEMPLATES, "synthesis", "vivado_project_synthesis.tcl")]
]) {
  const source = readFileSync(file, "utf8");
  check(
    /\[file type \$[A-Z_]+\] eq "link"/u.test(source) && /refusing to follow it/u.test(source),
    `${label}模板拒绝**根目录**是 symlink/Junction(不只挡递归子目录)`
  );
}

// DSH-N06:规则只有**一份**出处 —— 两个 checker 都不许再自己定义 checkFile/规则常量,
// 必须从 tools/lib/rtl-check-rules.mjs 导入。
{
  const sharedRules = readFileSync(join(ROOT, "presets", "fpga-workbench", "tools", "lib", "rtl-check-rules.mjs"), "utf8");
  check(
    /export function checkFile\(/u.test(sharedRules) && /export function classifyNeq\(/u.test(sharedRules),
    "共享纯规则模块导出 checkFile / classifyNeq(唯一出处)"
  );
  for (const [label, file] of [
    ["module", join(ROOT, "presets", "fpga-workbench", "tools", "module", "module-rtl-check.mjs")],
    ["project", join(ROOT, "presets", "fpga-workbench", "tools", "project", "project-rtl-check.mjs")]
  ]) {
    const source = readFileSync(file, "utf8");
    check(
      !/^(?:export\s+)?function checkFile\b/mu.test(source),
      `${label} checker 不再自己定义 checkFile(改为从共享模块导入)`
    );
    check(
      /from "\.\.\/lib\/rtl-check-rules\.mjs"/u.test(source),
      `${label} checker 从共享纯规则模块导入`
    );
  }
}

const categorizedTemplates = {
  rtl: join(TEMPLATES, "rtl", "systemverilog_module.sv"),
  constraints: join(TEMPLATES, "constraints", "vivado_module_xdc.xdc"),
  verification: join(TEMPLATES, "verification", "python_data_verification.py"),
  testbench: join(TEMPLATES, "simulation", "testbench", "systemverilog_testbench.sv"),
  compile: join(TEMPLATES, "simulation", "run", "modelsim_run.do"),
  run: join(TEMPLATES, "simulation", "run", "modelsim_run.do"),
  synthesis: join(TEMPLATES, "synthesis", "vivado_module_synthesis.tcl"),
  "project-constraints": join(TEMPLATES, "constraints", "vivado_project_xdc.xdc"),

// DSH-01:内置 XDC 里**不许有生效的默认约束**(尤其 create_clock 的硬编码周期)——
// 时钟周期必须来自 doc/spec.md / 模块 spec 的目标频率;模板只保留注释示例。
// 否则只要端口恰好叫 clk,Vivado 会安静地按示例周期约束,工具全绿而工程事实是错的。
  implementation: join(TEMPLATES, "implementation", "vivado_implementation.tcl"),
  programming: join(TEMPLATES, "programming", "vivado_program.tcl"),
  "project-synthesis": join(TEMPLATES, "synthesis", "vivado_project_synthesis.tcl"),
  linter: join(TEMPLATES, "linter", "vivado_rtl_lint.tcl"),
  bitstream: join(TEMPLATES, "bitstream", "vivado_bitstream.tcl")
};

for (const [key, file] of [
  ["constraints", categorizedTemplates.constraints],
  ["project-constraints", categorizedTemplates["project-constraints"]]
]) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/u);
  const active = lines.filter((line) => /^\s*(create_clock|create_generated_clocks)\b/u.test(line));
  check(
    active.length === 0,
    `${key} 内置 XDC 没有生效的默认时钟约束(周期必须来自 spec;实际 ${String(active.length)} 行)`,
    active.slice(0, 3).join("\n")
  );
  check(
    lines.some((line) => /^\s*#.*create_clock/u.test(line)),
    `${key} 内置 XDC 保留了**注释示例**,让人知道该写成什么样`
  );
}
// 2026-09-24(审查报告 T-15/T-16):注释里的命令名与语义都要经得起 AI 照抄。
{
  const projectXdc = readFileSync(categorizedTemplates["project-constraints"], "utf8");
  check(
    !/create_generated_clocks/u.test(projectXdc) && /create_generated_clock\b/u.test(projectXdc),
    "工程 XDC 注释用的是真命令名 create_generated_clock(单数;复数那条命令不存在)"
  );
  check(
    /异步输入\*\*不等于\*\*[\s\S]{0,20}不用做时序检查/u.test(projectXdc) &&
      /先确认复位同步器/u.test(projectXdc),
    "工程 XDC 不再把「异步复位/异步输入」笼统说成不用做时序检查(要先确认同步器/CDC 结构)"
  );
}
check(
  Object.values(categorizedTemplates).every((path) => existsSync(path)),
  "内置模板都存在(模块与工程的综合/约束各一份;编译与运行合并后同一份路径只算一份)",
  Object.entries(categorizedTemplates).filter(([, path]) => !existsSync(path)).map(([key]) => key).join("、")
);
const categorizedRtlIssues = blocking(categorizedTemplates.rtl, false);
check(categorizedRtlIssues.length === 0, "分类 RTL 模板过检查器", categorizedRtlIssues.map((i) => i.message).join("; "));
const categorizedTbIssues = blocking(categorizedTemplates.testbench, true);
check(categorizedTbIssues.length === 0, "分类 Testbench 模板过检查器", categorizedTbIssues.map((i) => i.message).join("; "));

const executableTcl = (path) => readFileSync(path, "utf8")
  .split(/\r?\n/u)
  .filter((line) => !/^\s*#/u.test(line))
  .join("\n");
const compileTemplate = executableTcl(categorizedTemplates.compile);
const runTemplate = executableTcl(categorizedTemplates.run);
const synthesisTemplate = executableTcl(categorizedTemplates.synthesis);
const implementationTemplate = executableTcl(categorizedTemplates.implementation);
const bitstreamTemplate = executableTcl(categorizedTemplates.bitstream);
// 工程综合是**另一份**文件(module 版在模块根跑、自己建工程);下面复用策略的断言钉在工程版上。
const projectSynthesisTemplate = executableTcl(categorizedTemplates["project-synthesis"]);
const programmingTemplate = executableTcl(categorizedTemplates.programming);
const linterTemplate = executableTcl(categorizedTemplates.linter);
// 编译与运行合并成一份之后(用户口径 2026-09-23),"只做一件事"改成**按模式分界**的结构断言:
//   · 编译命令(vcom -quiet / vlog -quiet)全部落在 compile 段内;
//   · vsim 只出现在 run 段里(用 `vsim -c -modelsimini` 这个只在 run 段出现的形态定位,
//     免得把头部用法注释里的 vsim 也算进来)。
const modeCompileAt = compileTemplate.indexOf('if {$MODE eq "compile"}');
const modeRunAt = compileTemplate.indexOf("local work/ library is missing");
const firstCompileCmdAt = (() => {
  const a = compileTemplate.indexOf("vcom -quiet");
  const b = compileTemplate.indexOf("vlog -quiet");
  return a < 0 ? b : b < 0 ? a : Math.min(a, b);
})();
check(
  modeCompileAt > 0 && modeRunAt > modeCompileAt && firstCompileCmdAt > modeCompileAt &&
    // 2026-09-25 批处理子进程化:run 段的 vsim 调用变成 `exec … vsim.exe` + argv 列表,
    // 所以这里找的是"子进程那条命令行"而不是字面的 `vsim -c -modelsimini`。
    compileTemplate.indexOf("exec [file join [file dirname [info nameofexecutable]] vsim.exe]") > modeRunAt,
  "合并模板:编译命令都在 compile 段、装设计/仿真都在 run 段(按模式分界,不再各自一份文件)"
);
check(
  (/\bsynth_design\b/u.test(synthesisTemplate) || /launch_runs\s+synth_1/u.test(synthesisTemplate)) &&
    !/\bplace_design\b|\broute_design\b|\bwrite_bitstream\b|launch_runs\s+impl_1/u.test(synthesisTemplate),
  "Vivado 综合模板在综合后停止"
);
// 2026-09-24(审查报告 T-04/T-05/T-06/T-07):工程三件套各管一段 —— 综合可复用已有 run、
// 实现跑到 route + 真跑 DRC(不写 bitstream)、bitstream 只做 step continuation(不重跑实现)。
check(
  /RESET_POLICY/u.test(projectSynthesisTemplate) && /NEEDS_REFRESH/u.test(projectSynthesisTemplate) &&
    /set REUSED 0/u.test(projectSynthesisTemplate) &&
    !/set RESET_RUN/u.test(projectSynthesisTemplate),
  "工程综合按 RESET_POLICY=auto 复用新鲜 run(不再每次 reset_run 重跑)"
);
check(
  /\bopen_project\b/u.test(implementationTemplate) && /-to_step\s+route_design/u.test(implementationTemplate) &&
    /\breport_drc\b/u.test(implementationTemplate) && /\bget_drc_violations\b/u.test(implementationTemplate) &&
    // 禁的是**调用**(行首语句),不是提示文字:`puts "... write_bitstream escalates ..."` 这种说明必须留着。
    !/^\s*(?:synth_design|program_hw_devices|write_bitstream|open_checkpoint)\b/mu.test(implementationTemplate),
  "Vivado 实现模板走 Project Mode 到 route_design + DRC 门,不写 bitstream、不读 DCP、不下载"
);
check(
  /\bopen_project\b/u.test(bitstreamTemplate) && /-to_step\s+write_bitstream/u.test(bitstreamTemplate) &&
    /NEEDS_REFRESH/u.test(bitstreamTemplate) &&
    !/^\s*(?:synth_design|place_design|route_design)\b/mu.test(bitstreamTemplate),
  "Vivado bitstream 模板只做 step continuation(不重新 place/route,也不综合)"
);
check(
  /\bprogram_hw_devices\b/u.test(programmingTemplate) &&
    !/\bsynth_design\b|\bplace_design\b|\broute_design\b|\bwrite_bitstream\b/u.test(programmingTemplate),
  "Vivado 下载模板只使用已有 bitstream"
);
// 2026-09-24(复核报告第 3 项):linter 用 -lint 跑 Vivado RTL Linter,并把结果写成报告。
// 实测两条硬事实:① `-lint` 与 `-rtl` **互斥**,必须分两次调用;② 报告里的规则会有 -help 清单
// 之外的(实测 ASSIGN-10),所以规则清单不能写死、要从报告里抽。
check(
  /\bsynth_design\s+-lint\b/u.test(linterTemplate) && /-file\s+\$LINT_RPT/u.test(linterTemplate) &&
    /\bsynth_design\s+-rtl\b/u.test(linterTemplate) &&
    !/synth_design[^\n]*-rtl[^\n]*-lint|synth_design[^\n]*-lint[^\n]*-rtl/u.test(linterTemplate) &&
    /lint report not found/u.test(linterTemplate) &&
    /\^\\\|\\s\*\(\[A-Z\]\+-\[0-9\]\+\)/u.test(linterTemplate),
  "linter 模板分两步跑(-lint 与 -rtl 互斥)、报告必须落地、规则从报告里抽(不写死清单)"
);
// 2026-09-24 真机抓到的真 bug:linter 用的是 ModelSim 语法 `quit -f -code N`,Vivado 的 quit 只接受
// 一个可选返回码 → 实测 `wrong # args: should be "quit ?returnCode?"`,**连成功路径都退不出 0**
// (该退 2 的参数错也退成 1)。五份 Vivado Tcl 一律用 `exit N`。
for (const [label, source] of [
  ["module synth", synthesisTemplate],
  ["project synth", projectSynthesisTemplate],
  ["implementation", implementationTemplate],
  ["bitstream", bitstreamTemplate],
  ["programming", programmingTemplate],
  ["linter", linterTemplate]
]) {
  check(
    !/quit\s+-f\s+-code/u.test(source),
    `${label}:用 Vivado 的 exit N 退出,不写 ModelSim 的 quit -f -code(2025.2 实测报 wrong # args 并退 1)`
  );
}
check(
  [compileTemplate, runTemplate, synthesisTemplate, implementationTemplate, bitstreamTemplate, programmingTemplate]
    .every((source) => /\berror\b/iu.test(source)),
  "分类脚本缺少必需事实时都会明确失败"
);

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
check(modulePlan.dirs.length === 4, `模块级骨架 4 个目录(对应 4 个环节;实际 ${modulePlan.dirs.length})`);
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
  "模块骨架不含 review/ 目录(审查环节已移除,判定只看仿真验证与测试)"
);
check(modulePlan.anchors.length === 1 && modulePlan.anchors[0].value.kind === "module", "模块级写一个 kind: module 的锚点");
check(modulePlan.anchors[0].value.spec === "spec/spec.md", "锚点里的 spec 路径相对模块根");
check(
  !modulePlan.dirs.some((dir) => dir.endsWith(join("spec", "explore"))),
  "骨架不建 spec/explore —— 探索产物放工程外(它本来就不作正式证据)"
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

// 工作区指令(用户口径 2026-09-19):骨架顺带落一份 AGENTS.fpga.md,正文从包内 workspace 模板原样复制
const instructionPath = join(scaffoldMod, "AGENTS.fpga.md");
check(modulePlan.instruction === instructionPath, `plan 里给的是 <根>/AGENTS.fpga.md(实际 ${String(modulePlan.instruction)})`);
const rulesText = readModeRules();
check(
  rulesText.includes("FPGA 开发模式的工作区规则") && rulesText.split("\n").length >= 8,
  `规则源读取成功(${rulesText.split("\n").length} 行)`
);
check(!rulesText.includes("<!--"), "规则源不含 HTML 标记(落盘给人读的)");
const written = readFileSync(instructionPath, "utf8");
check(written === rulesText, "落盘的正文与包内规则源逐字节一致");
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

// 工程级：调用者给出的路径本身就是工程根，不再套“工作区/工程名”，也不自动创建模块目录。
const scaffoldPrj = join(SANDBOX, `scaffold-prj-${stamp}`);
const projectPlan = planScaffold(scaffoldPrj, { kind: "project" });
const expectedProjectDirs = [
  "doc", "sch", "prj", "src", join("src", "rtl"), join("src", "sim"), "ip", "sim", "xdc", "bit"
].map((rel) => join(scaffoldPrj, rel));
check(projectPlan.anchors.length === 1, `工程根只有 1 个锚点(实际 ${projectPlan.anchors.length})`);
check(
  projectPlan.anchors[0].file === join(scaffoldPrj, ".fpga-workbench.json") &&
    projectPlan.anchors[0].value.kind === "project" && projectPlan.anchors[0].value.spec === "doc/spec.md",
  "工程锚点直接写在用户指定目录，spec 指向 doc/spec.md"
);
check(
  projectPlan.dirs.length === expectedProjectDirs.length &&
    expectedProjectDirs.every((dir) => projectPlan.dirs.includes(dir)),
  "工程目录严格等于 doc/sch/prj/src/{rtl,sim}/ip/sim/xdc/bit"
);
check(
  projectPlan.dirs.every((dir) => !dir.includes(`${join(scaffoldPrj, "report")}\\`) && !dir.includes(`${join(scaffoldPrj, "src", "top")}\\`)) &&
    !projectPlan.dirs.includes(join(scaffoldPrj, "report")) && !projectPlan.dirs.includes(join(scaffoldPrj, "coe")) &&
    !projectPlan.dirs.includes(join(scaffoldPrj, "tcl")) && !projectPlan.dirs.includes(join(scaffoldPrj, "src", "top")),
  "工程骨架不再创建 report/coe/tcl/src/top，也不在指定目录外另套一层"
);

// ── 起文件(module-rtl-new / module-verif-new / module-synth-new:各环节一个入口,只替模块名) ──
const bundledRtl = readFileSync(categorizedTemplates.rtl, "utf8");
const rendered = renderTemplate(bundledRtl, "UartRx");
check(rendered.replaced.join(",") === "ModuleName", `只替模块名(实际替了 ${rendered.replaced.join("、") || "无"})`);
check(!rendered.text.includes("<ModuleName>"), "模块名占位符替干净了");
check(rendered.text.includes("<DATE>") && rendered.text.includes("<Author>"), "日期 / 作者不动(内容归模板自己管)");
check(rendered.remaining.includes("DATE") && rendered.remaining.includes("Author"), "没替的占位符会被提示出来");

// 自带 TB 模板的判定契约:两条判据字符串必须在,且模板里不能再写"err_cnt>0 会非零退出"——
// ModelSim 批处理下 $fatal 不改退出码(2020.4 实测),照旧说法写会让人以为看退出码就能抓到失败。
const bundledTb = readFileSync(categorizedTemplates.testbench, "utf8");
// **按语义断言，不按完整字面量**：模板后来加了 `check_cnt`（空 TB 不许说通过），
// 成功标记变成 `ALL TESTS PASSED (err_cnt=0, check_cnt=%0d)` ——
// 硬比对旧字面量只会让「改模板」变成「改测试」。
// 这里要守的是：**两个标记字符串都在**，run.do 靠它们判成败。
check(
  /ALL TESTS PASSED/u.test(bundledTb) && /TB FAILED/u.test(bundledTb),
  "自带 TB 模板里两条判据字符串都在(成功标记 + 失败标记),脚本靠它们判成败"
);
// 空 TB 不许报通过（2026-10-30 实测：骨架 TB 未填 stimulus 时 vsim 立刻
// 报 ALL TESTS PASSED、Time: 0 ps —— 时钟都没跑）。
check(
  /check_cnt/u.test(bundledTb) && /TB INCOMPLETE/u.test(bundledTb),
  "自带 TB 模板用 check_cnt 挡住「空 TB 报通过」，并给出 TB INCOMPLETE 标记"
);
check(
  /does NOT make vsim exit non-zero/u.test(bundledTb) && !/must exit non-zero/u.test(bundledTb),
  "自带 TB 模板写明 $fatal 不改 vsim 退出码(不是'必须非零退出'那种说法)"
);

// 仿真编译与运行是**同一份**(用户口径 2026-09-24:设置页也只剩一个槽位);这里保留 compile/run 两个键
// 只为断言"两个 kind 指向同一份文件",不再有两份脚本。
const bundledCompileDoPath = categorizedTemplates.compile;
const bundledCompileDo = readFileSync(bundledCompileDoPath, "utf8");
const bundledRunDoPath = categorizedTemplates.run;
const bundledRunDoExists = existsSync(bundledRunDoPath);
const bundledRunOnly = bundledRunDoExists ? readFileSync(bundledRunDoPath, "utf8") : "";
  const bundledRunDo = bundledRunOnly;
  check(
    bundledRunDoExists && existsSync(bundledCompileDoPath) && bundledCompileDoPath === bundledRunDoPath,
    "编译与运行分类模板是**同一份**文件,且都存在"
  );
// `onfinish stop` 不再是标记(2026-09-25 复核报告 C):批处理的"装设计 + 跑"搬进**子进程**后,
// 本进程不再展开设计,那句话变成非法调用(ModelSim:onfinish may only be used after elaboration)
// 并让父进程退 1 —— 真正的标记换成"子进程 + argv 直传 + transcript 新鲜度"这三条。
for (const marker of ["*_stub.*", "quit -f -code 1", "ALL TESTS PASSED"]) {
  check(bundledRunDo.includes(marker), `合并模板里有「${marker}」`);
}
for (const [label, pattern] of [
  ["批处理把装设计与仿真放进子 vsim(不复用自身进程)", /exec \[file join \[file dirname \[info nameofexecutable\]\] vsim\.exe\] \{\*\}\$child_argv/u],
  ["子进程 argv 不含可执行名(否则被当成顶层名)", /set child_argv \[list -c \{?\*?\}?\$cover_run_args/u],
  ["子进程死掉时从 -errorcode 取原生退出码并归一成 1", /CHILDSTATUS\\s\+\\d\+\\s\+\(\\d\+\)/u],
  ["transcript 必须是这次写的(不拿旧日志判 PASS)", /no fresh transcript/u],
  ["错误行判据收紧:不把 `Errors: 0` 汇总行当错误", /proc is_error_line/u]
]) {
  check(pattern.test(bundledRunDo), `批处理子进程化:${label}`);
}
check(
  !/^onfinish stop$/mu.test(bundledRunDo) && !/^onfinish /mu.test(bundledRunDo),
  "批处理路径不再设 onfinish(本进程不展开设计,那句是非法调用)"
);
// 2026-09-24(审查报告 T-02 / T-09):两处契约改动,断言钉在**可执行**文本上(注释里也会出现
// .svh/.vh 和 load 这些词,拿注释喂饱断言等于没测)。
for (const [label, pattern] of [
  ["头文件(.svh/.vh)进采集:只进新鲜度集合,不参与编译", /collect_hdl \$rtl_root \{\.svh \.vh\}/u],
  ["头文件写进 compile stamp(不再只记 .sv/.v/.vhd/.vhdl)", /foreach f \[concat \$kept \$headers\]/u],
  ["run 模式的集合比对把头文件也算进去", /\[lindex \$cur_parts 4\]/u],
  ["头文件一变 → 全量重编 Verilog/SystemVerilog(依赖推不准)", /set hdr_changed 0/u],
  ["load 是第三个正式模式(不再是「不给模式=GUI」那条路)", /\$MODE ne "compile" && \$MODE ne "run" && \$MODE ne "load"/u],
  ["用法行给出三个模式", /usage: do run\.do compile\|run\|load/u],
  // 2026-09-24(审查报告:compile configuration fingerprint):编译配置也进 stamp,run 时逐项比对。
  //
  // 2026-10-28 定稿：指纹**只记 ini 的路径，不记 mtime / size / 内容**。
  //
  // 两次弯路都踩过（真机）：
  //   ① 记原件 mtime/size —— 原件全局共享，别的工程一条 `vmap` 就改了它，
  //      compile 记完半秒后被外部改写，紧接着 run 报「配置变了」，重编后照样复发；
  //   ② 改记副本内容摘要 —— 也不行，`refresh_ini_copy` 每个模式都跑，
  //      run 时副本会重新从（已被改过的）原件复制，摘要必然对不上。
  //
  // 结论：ini 是**共享外部资源**，把它的内容算进身份，等于让别人的操作决定你重不重编。
  // 所以只保留「路径变了要重编」（用户真的换了一份 ini），内容变更不再触发。
  // 这条断言反过来钉住这个取舍 —— 别再"改回去更严谨"。
  ["配置身份:仿真器路径", /lappend items "exe=\[info nameofexecutable\]"/u],
  ["配置身份:ini 只记路径(不记 mtime/size/内容)", /lappend items "ini=\$::INI_SOURCE_FWD"/u],
  // 负向断言：这两个赋值必须**不存在**。用 `(?!…)` 在整段文本上表达，
  // 因为本循环里每项只能是正则、不能是布尔。
  [
    "配置身份:不再把 ini 的 mtime/size 算进身份(外部改 ini 不该触发重编)",
    /^(?![\s\S]*ini_mtime=\[file mtime)(?![\s\S]*ini_size=\[file size)[\s\S]*$/u
  ],
  ["配置身份:defines / incdirs / vendor_libs / opt", /lappend items "defines=/u],
  ["身份写进 stamp", /\{ puts \$stamp_fh "# cfg \$item" \}/u],
  ["run 模式逐项比对配置身份", /compile configuration changed after the last compile/u],
  // 2026-09-24(复核报告第 2 项):Verilog/SystemVerilog 把**完整 source set** 交给 vlog -incr,
  // 由 ModelSim 决定重编谁(FULL_REBUILD 时才不带 -incr)。
  ["Verilog/SV 全量交 vlog -incr", /vlog \{\*\}\$incr_args -quiet/u],
  ["清库全量时(force_full:配置变 / FULL_REBUILD / 新库)不带 -incr", /if \{!\$force_full\} \{ set incr_args \{-incr\} \}/u],
  ["force_full 把「配置变了」也算进去", /set force_full \[expr \{\$FULL_REBUILD \|\| \$fresh_work \|\| \$config_changed\}\]/u],
  ["compile 侧也比对配置身份(假新鲜就是这么来的)", /set cfg_diff \[config_diff \[read_stamp_cfg \$STAMP_PATH\] \[config_identity\]\]/u],
  ["配置变了就清库全量重编", /compile configuration changed -> cleaning work\/ and rebuilding every source/u],
  ["SV/V 的编译清单在全量/全空之间切换(不再只挑 changed)", /set sv_changed 0/u],
  // 2026-09-24:+acc 分流 —— 批处理不带(实测 2.3~2.6× 快),只有 GUI load 带可见性。
  ["批处理与 GUI 的 vopt 参数是两个旋钮", /set BATCH_VOPT_ARGS \{\}/u],
  ["GUI load 保留 +acc 可见性", /set DEBUG_VOPT_ARGS \{\+acc=rn\}/u],
  ["run 用 BATCH_*、load 用 DEBUG_*(各自拼 OPT_LEVEL)", /set VOPT_ALL \[string trim "\$BATCH_VOPT_ARGS \$OPT_LEVEL"\]/u],
  // 2026-09-24:顺序依赖不加配置文件 —— 编译失败自动重试一次(失败那趟已把 package/entity 编进库)。
  ["编译失败自动重试一次", /proc compile_step/u],
  ["两次都失败才报错退 1", /failed twice - refusing to use a stale library/u]
]) {
  check(pattern.test(compileTemplate), label);
}
check(
  (compileTemplate.match(/compile_step "/gu) ?? []).length === 3,
  `三处编译(vcom / vlog -sv / vlog)都走 compile_step;实际 ${String((compileTemplate.match(/compile_step "/gu) ?? []).length)} 处`
);
{
  // load 必须在 `run -all` **之前** return:否则 GUI 会话会被 batch 的 run/quit 逻辑接管。
  // 锚点用**语句形态**(\nrun -all):load 分支的提示文字里也写着 "no run -all",不能拿它当锚点。
  const loadAt = compileTemplate.indexOf('if {$MODE eq "load"}');
  const loadReturnAt = loadAt < 0 ? -1 : compileTemplate.indexOf("return", loadAt);
  // 2026-09-25 批处理子进程化:`run -all` 现在只出现在**子进程的 -do 参数**里(controller 自己不跑了),
  // 所以要盯的是"load 分支的 return 早于子进程 spawn",而不是"模板文本里没有 run -all"。
  const childSpawnAt = compileTemplate.indexOf("exec [file join [file dirname [info nameofexecutable]] vsim.exe]");
  check(
    loadAt > 0 && loadReturnAt > loadAt && childSpawnAt > loadReturnAt,
    `load 模式只装载:在该分支内 return,永远走不到子进程 spawn(load@${String(loadAt)} return@${String(loadReturnAt)} child@${String(childSpawnAt)})`
  );
  check(
    compileTemplate.includes("vsim -modelsimini $INI_FWD") && !/MODE eq "load"[\s\S]{0,400}?vsim -c /u.test(compileTemplate),
    "load 的 vsim 调用不带 -c(父会话才是 GUI;带 -c 会变成新的批处理会话)"
  );
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
  const compileLog = join(verif, "ME-compile-stdout.log");
  const compileFd = openSync(compileLog, "w");
  // 交给 ModelSim 的路径一律转正斜杠:反斜杠里的 `\t`/`\n` 会被 Tcl 当转义吃掉(实测)
  const compileStatus = spawnSync("vsim", ["-c", "-do", `do ${bundledCompileDoPath.replace(/\\/gu, "/")} compile`], {
    stdio: ["ignore", compileFd, "ignore"],
    cwd: verif
  }).status;
  closeSync(compileFd);
  const compileOutput = existsSync(compileLog) ? readFileSync(compileLog, "utf8") : "";
  if (compileStatus !== 0) return { status: compileStatus, output: compileOutput };
  const runLog = join(verif, "ME-run-stdout.log");
  const runFd = openSync(runLog, "w");
  const status = spawnSync("vsim", ["-c", "-do", `do ${doPath.replace(/\\/gu, "/")} run`], {
    stdio: ["ignore", runFd, "ignore"],
    cwd: verif
  }).status;
  closeSync(runFd);
  return { status, output: `${compileOutput}\n${existsSync(runLog) ? readFileSync(runLog, "utf8") : ""}` };
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
  check(/no tb_\*/u.test(rundoError(sim.output).header), "零 TB 报的是「没有 tb_* 测试平台」这一条");
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
  const topPatched = bundledRunOnly.replace(/set TOP_OVERRIDE\s+\{\}/u, "set TOP_OVERRIDE  {tb_b}");
  check(topPatched !== bundledRunOnly, "夹具:旋钮 TOP_OVERRIDE 真被填上了(没填上的话下面那条会测成另一回事)");
  mkdirSync(simRoot, { recursive: true });
  const topDo = join(simRoot, "many-with-top.do");
  writeFileSync(topDo, topPatched);
  sim = simRun("many-top", manyTb, topDo);
  check(sim.status === 0, `多 TB + 显式 TOP_OVERRIDE → 退出码 0(实际 ${String(sim.status)})`);
  // ⑤ 同名且内容一致 → 0(内容一致才允许丢),并说明丢了哪一份
  sim = simRun("dup-same", { "rtl/foo.sv": rtlFoo, "verif/foo.sv": rtlFoo, "verif/tb_foo.sv": tbSource("tb_foo") });
  /**
   * 这里曾出现**间歇性失败**（2026-10-26 第十一轮审查实测 1/4，本机也复现过一次：
   * 清空 `.tmp` 后连跑 3 次得到 0/1/1，之后连跑 5 次全 0）。
   *
   * 已排除：去重判定本身正确（失败那次 "identical content" 已打印，且那是**逐字节**
   * 内容比较而非 mtime）；"no fresh transcript" 分支也不会命中。
   * 剩下的怀疑是**去重之后的 compile/仿真阶段瞬态失败** —— 夹具里的 vsim 是临时写的
   * 脚本，Windows Defender 对新建脚本的首扫会造成瞬时 spawn 失败。
   *
   * 但当时**看不到 sim.output**，无法归因。所以失败时把输出尾部打出来：
   * 下次再闪，日志里直接能看到是哪一步、什么错误，不必再猜。
   */
  const dupDetail =
    sim.status === 0 ? undefined : `输出尾部:\n        ${String(sim.output ?? "").slice(-1500).replaceAll("\n", "\n        ")}`;
  check(sim.status === 0, `同名同内容 → 退出码 0(只丢重复那份;实际 ${String(sim.status)})`, dupDetail);
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

  // ⑦ 头文件(.svh)进新鲜度(2026-09-24;审查报告 T-02):宏在 vlog 那一步就展开了,头文件改了却
  //    不重编包含它的模块 → work/ 成了"对不上源码的旧库"且**不报错**。旧采集器只认
  //    .sv/.v/.vhd/.vhdl,头文件根本不进 stamp → run 会把过期 work/ 判成 current。
  //    夹具把头文件放 verif/(= vlog 的当前目录),这样 ```include 不需要 +incdir+ 也能找到。
  {
    const hdrRoot = join(simRoot, "hdr");
    const hdrVerif = join(hdrRoot, "verif");
    mkdirSync(join(hdrRoot, "rtl"), { recursive: true });
    mkdirSync(hdrVerif, { recursive: true });
    const hdrFile = join(hdrVerif, "defs.svh");
    writeFileSync(join(hdrRoot, "rtl", "foo.sv"), '`include "defs.svh"\nmodule foo; localparam int W = `DEF_W; endmodule\n');
    writeFileSync(hdrFile, "`define DEF_W 8\n");
    // TB 带一个 TB_DEFINES 开关:`SAFE_MODE` 定义与否决定打印什么 —— 于是"配置变了必须真重编"
    // 可以用**行为**验(打印值必须跟着变),而不只是看 stamp。
    writeFileSync(
      join(hdrVerif, "tb_foo.sv"),
      '`timescale 1ns/1ps\nmodule tb_foo;\n    initial begin\n`ifdef SAFE_MODE\n        $display("MODE=SAFE");\n`else\n        $display("MODE=FAST");\n`endif\n        $display("ALL TESTS PASSED (err_cnt=0)");\n        $finish;\n    end\nendmodule\n'
    );
    const hdrDo = join(hdrVerif, "run.do");
    writeFileSync(hdrDo, bundledRunOnly);
    const modeStep = (mode, options = {}) => {
      const { env = {}, tag = mode, doFile = hdrDo, cwd = hdrVerif } = options;
      const log = join(cwd, `ME-${tag}-hdr.log`);
      const fd = openSync(log, "w");
      const status = spawnSync("vsim", ["-c", "-do", `do ${doFile.replace(/\\/gu, "/")} ${mode}; quit -f`], {
        stdio: ["ignore", fd, "ignore"],
        cwd,
        env: { ...process.env, ...env }
      }).status;
      closeSync(fd);
      return { status, output: existsSync(log) ? readFileSync(log, "utf8") : "" };
    };
    let step = modeStep("compile");
    check(step.status === 0, `头文件夹具:首次 compile 退 0(实际 ${String(step.status)})`, step.output.slice(-200));
    step = modeStep("run");
    check(step.status === 0, `头文件夹具:什么都没改 run 退 0(实际 ${String(step.status)})`, step.output.slice(-200));
    // 内容与长度一起变 → 不依赖 mtime 精度
    writeFileSync(hdrFile, "`define DEF_W 16\n");
    step = modeStep("run");
    check(
      step.status === 1 && /changed after compile/u.test(step.output) && /defs\.svh/u.test(step.output),
      `改了 .svh → run 拒绝并点名该头文件(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    step = modeStep("compile");
    check(
      step.status === 0 && /header \(\.svh\/\.vh\) changed/u.test(step.output),
      `改了 .svh → compile 全量重编 Verilog/SystemVerilog(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    step = modeStep("run");
    check(step.status === 0, `重编之后 run 退 0(实际 ${String(step.status)})`, step.output.slice(-200));

    // ⑧ load(2026-09-24;审查报告 T-09):装载后**不** run -all、**不**自己退出。
    //    批处理里跑=我们在 -do 里自己补 `quit -f`;GUI 里跑就没有这一句(技能里写的就是它)。
    step = modeStep("load");
    check(
      step.status === 0 && /DESIGN LOADED/u.test(step.output) && !/SIMULATION PASSED/u.test(step.output),
      `load 模式:装载成功、不给仿真结论(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    // ⑧b +acc 分流(2026-09-24):GUI load 带可见性,批处理不带(实测 2.3~2.6× 快)。
    check(
      /vsim load \(GUI\): top=\S+ voptargs=\{\+acc=rn -O5\}/u.test(step.output),
      `load 的 voptargs 带 +acc(波形可见性);实际 ${(step.output.split(/\r?\n/u).find((l) => /voptargs/u.test(l)) ?? "").trim()}`
    );

    // ⑨ 编译配置身份(2026-09-24;审查报告 compile configuration fingerprint):改了任何编译配置都要
    //    让 run 拒绝 —— 否则"源码一字未动、直接 run"会静默跑在按旧配置编出来的库上(实测形态)。
    step = modeStep("compile");
    check(
      // 2026-10-28：ini 的 size 已不再进身份（见上面那组断言的说明），改看 ini= 这一行。
      step.status === 0 && /compile identity:/u.test(step.output) && /exe=/u.test(step.output) && /ini=/u.test(step.output),
      `配置身份:compile 把身份写进 stamp 并打印(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    step = modeStep("run");
    check(
      step.status === 0 && /compile identity: matches the last compile/u.test(step.output),
      `配置身份:配置没变时 run 退 0(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    // ⑧c 批处理那条路**不带** +acc(带的话就是 2.3~2.6× 的白等;加了这条以后谁把它改回去都会红)。
    //
    // 2026-10-28：批处理后来改成子进程 argv 直传，所以这里匹配的是 argv 行
    // （`... -voptargs=-O5 -do {...}`），不再是 `vsim: top=... voptargs={-O5}`。
    // 判据不变：有 `-voptargs=-O5`、且没有 `+acc`。
    check(
      /-voptargs=-O5(?:\s|$)/u.test(step.output) && !/-voptargs=[^\s]*\+acc/u.test(step.output),
      `批处理的 voptargs 不带 +acc;实际 ${(step.output.split(/\r?\n/u).find((l) => /voptargs/u.test(l)) ?? "").trim()}`
    );
    // ⑧d `-voptargs` **只在真有内容时传**(2026-09-25 真机)。`OPT_LEVEL {}` 是模板**文档承诺**的
    //     "退回工具默认",以前却拼出 `-voptargs=""` → ModelSim 2020.4 `** Error: (vsim-3789) Invalid
    //     -voptargs setting` 并**直接结束进程(退 12)**,于是这条用法只在 run 时才炸。
    //     判据看 **ModelSim 自己回显的命令行**(`# vsim …`),不是我们打印的那行 —— 后者两种情况一样。
    const emptyOptDo = join(hdrVerif, "run-empty-opt.do");
    writeFileSync(
      emptyOptDo,
      bundledRunOnly
        .replace(/set OPT_LEVEL\s+\{-O5\}/u, "set OPT_LEVEL      {}")
        .replace(/set DEBUG_VOPT_ARGS \{\+acc=rn\}/u, "set DEBUG_VOPT_ARGS {}")
    );
    check(
      readFileSync(emptyOptDo, "utf8") !== bundledRunOnly,
      "夹具:OPT_LEVEL / DEBUG_VOPT_ARGS 旋钮真被改掉了(没改上的话下面那几条测的是另一回事)"
    );
    const emptyOptCompile = modeStep("compile", { doFile: emptyOptDo, tag: "emptyopt-compile" });
    check(
      emptyOptCompile.status === 0,
      `OPT_LEVEL={} → compile 退 0(实际 ${String(emptyOptCompile.status)})`,
      emptyOptCompile.output.slice(-200)
    );
    const emptyOptRun = modeStep("run", { doFile: emptyOptDo, tag: "emptyopt-run" });
    check(
      emptyOptRun.status === 0 && /SIMULATION PASSED/u.test(emptyOptRun.output) &&
        !/-voptargs/u.test(emptyOptRun.output),
      `OPT_LEVEL={} → run 退 0 且命令行里**根本没有** -voptargs(实际 ${String(emptyOptRun.status)})`,
      emptyOptRun.output.slice(-300)
    );
    const emptyOptLoad = modeStep("load", { doFile: emptyOptDo, tag: "emptyopt-load" });
    check(
      emptyOptLoad.status === 0 && /DESIGN LOADED/u.test(emptyOptLoad.output) &&
        !/-voptargs/u.test(emptyOptLoad.output),
      `OPT_LEVEL={} + DEBUG_VOPT_ARGS={} → load 同样不传 -voptargs(实际 ${String(emptyOptLoad.status)})`,
      emptyOptLoad.output.slice(-300)
    );
    // 反面:非空时必须照传。顺序有讲究 —— 上面刚用 `OPT_LEVEL={}` 编过,配置身份门会拦住"直接换回
    // -O5 就 run"(这正是它的职责),所以先验被拦,重编之后再验命令行。
    const backToDefault = modeStep("run", { tag: "voptargs-stale" });
    check(
      backToDefault.status === 1 && /compile configuration changed/u.test(backToDefault.output) &&
        /opt:/u.test(backToDefault.output),
      `从 OPT_LEVEL={} 切回 -O5:run 退 1 并点名 opt(身份门的职责;实际 ${String(backToDefault.status)})`,
      backToDefault.output.slice(-250)
    );
    const recompile = modeStep("compile", { tag: "voptargs-recompile" });
    check(
      recompile.status === 0 && /cleaning work\/ and rebuilding/u.test(recompile.output),
      "切回 -O5 后重编:走清库全量路径(配置变了就不该在旧库上补)",
      recompile.output.slice(-250)
    );
    const voptArgsRun = modeStep("run", { tag: "voptargs-batch" });
    check(
      /-voptargs="?-O5"?/u.test(voptArgsRun.output),
      "默认档 run 照传 -voptargs=-O5(空才省,非空不许丢)",
      voptArgsRun.output.slice(-300)
    );
    const voptArgsLoad = modeStep("load", { tag: "voptargs-load" });
    check(
      /-voptargs="?\+acc=rn -O5"?/u.test(voptArgsLoad.output),
      "load 照传 -voptargs={+acc=rn -O5}",
      voptArgsLoad.output.slice(-300)
    );
    // ⑧e 批处理的"装设计 + 跑"在**子进程**里(2026-09-25 复核报告 C 项):ModelSim 在
    //     design-load/elaboration 失败时会直接结束**整个进程**并退 12(顶层不存在 / `-L` 库名
    //     写错 / 非法 voptargs 三种都实测过)—— 同进程里的 Tcl 连 catch 都来不及,于是既没有
    //     `[ME] ERROR`,退出码也违反 0/1/2。controller 现在 exec 子 vsim,拿 `-errorcode` 的
    //     CHILDSTATUS 归一成 1 + 一条 `[ME] ERROR`;`load` 必须留在进程内,不受影响。
    const missingTopDo = join(hdrVerif, "run-missing-top.do");
    writeFileSync(missingTopDo, bundledRunOnly.replace(/set TOP_OVERRIDE\s+\{\}/u, "set TOP_OVERRIDE   {no_such_module}"));
    step = modeStep("run", { doFile: missingTopDo, tag: "child-missing-top" });
    check(
      step.status === 1 && /\[ME\] ERROR/u.test(step.output) && /child exit code 12/u.test(step.output),
      `顶层模块不存在 → 退 1 且有 [ME] ERROR(原生 12 被归一;实际 ${String(step.status)})`,
      step.output.slice(-400)
    );
    const badLibDo = join(hdrVerif, "run-bad-lib.do");
    // 把 `set VENDOR_LIBS <任意默认值>` 换成不存在的库名。
    // 2026-10-28：默认值从 `{}` 改成了 `{unisim unimacro}`，所以正则要匹配任意内容，
    // 不能只匹配空 `{}` —— 否则替换不生效，这条断言就变成在测正常路径（假绿）。
    const patched = bundledRunOnly.replace(/^set VENDOR_LIBS\s+\{.*\}$/mu, "set VENDOR_LIBS    {no_such_lib}");
    check(patched !== bundledRunOnly, "夹具:VENDOR_LIBS 真被改成不存在的库名");
    writeFileSync(badLibDo, patched);
    step = modeStep("run", { doFile: badLibDo, tag: "child-bad-lib" });
    check(
      step.status === 1 && /\[ME\] ERROR/u.test(step.output),
      `厂商库名写错 → 退 1 且有 [ME] ERROR(实际 ${String(step.status)})`,
      step.output.slice(-400)
    );
    step = modeStep("run", { tag: "child-normal" });
    check(
      step.status === 0 && /SIMULATION PASSED/u.test(step.output) &&
        /child vsim process/u.test(step.output),
      `正常 PASS:走子进程、门判通过(隐含回归:汇总行 Errors: 0 不再被当成错误;实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    step = modeStep("load", { tag: "child-load" });
    check(
      step.status === 0 && /DESIGN LOADED/u.test(step.output) && !/child vsim process/u.test(step.output),
      "load 模式**不**走子进程(设计必须留在当前会话里)",
      step.output.slice(-300)
    );
    // ① TB_DEFINES 变了(环境变量):run 拒绝 **+ 闭环** —— 重新 compile 必须清库全量重编,
    //    并且之后的行为要真的反映新配置(2026-09-24 复核报告 P1:以前 compile 会"Nothing changed"
    //    却把新身份盖进 stamp,造成假新鲜;这里把检测之后的**恢复路径**也钉住)。
    step = modeStep("run", { env: { TB_DEFINES: "SAFE_MODE" }, tag: "defines" });
    check(
      step.status === 1 && /compile configuration changed after the last compile/u.test(step.output) &&
        /defines:/u.test(step.output) && /SAFE_MODE/u.test(step.output),
      `配置身份:改 TB_DEFINES → run 拒绝并点名 defines(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    step = modeStep("compile", { env: { TB_DEFINES: "SAFE_MODE" }, tag: "defines-compile" });
    check(
      step.status === 0 && /compile configuration changed -> cleaning work\/ and rebuilding every source/u.test(step.output) &&
        /full rebuild: compiling/u.test(step.output) && !/Nothing changed/u.test(step.output),
      `配置身份:改 TB_DEFINES 后 compile **清库全量重编**(不是 Nothing changed;实际 ${String(step.status)})`,
      step.output.slice(-400)
    );
    step = modeStep("run", { env: { TB_DEFINES: "SAFE_MODE" }, tag: "defines-run2" });
    check(
      step.status === 0 && /MODE=SAFE/u.test(step.output) && !/MODE=FAST/u.test(step.output),
      `配置身份闭环:重编之后行为跟着变(MODE=SAFE,不再是 FAST;实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    // ⑨d 什么都没改再 compile:仍要 Nothing changed(别让修复把日常 compile 变成全量)
    step = modeStep("compile", { env: { TB_DEFINES: "SAFE_MODE" }, tag: "noop" });
    check(
      step.status === 0 && /Nothing changed since the last compile/u.test(step.output) &&
        !/cleaning work\//u.test(step.output),
      `配置身份:源码与配置都没变时 compile 仍是 Nothing changed、不清库(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    // ② EXTRA_INCDIRS 变了(脚本旋钮)
    const incdirDo = join(hdrVerif, "run-incdir.do");
    writeFileSync(incdirDo, bundledRunOnly.replace(/set EXTRA_INCDIRS\s+\{\}/u, "set EXTRA_INCDIRS  {../rtl}"));
    check(readFileSync(incdirDo, "utf8") !== bundledRunOnly, "夹具:旋钮 EXTRA_INCDIRS 真被填上了(没填上的话下面那条测成另一回事)");
    step = modeStep("run", { tag: "incdir", doFile: incdirDo });
    check(
      step.status === 1 && /incdirs:/u.test(step.output) && /\.\.\/rtl/u.test(step.output),
      `配置身份:改 EXTRA_INCDIRS → run 拒绝并点名 incdirs(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    // ③ 换了另一份 modelsim.ini(路径不同就算换配置;这里只要求那份文件存在,内容不参与编译)
    const otherIni = join(hdrVerif, "mini.ini");
    writeFileSync(otherIni, "[Library]\n");
    step = modeStep("run", { env: { MODELSIM_INI: otherIni }, tag: "ini" });
    check(
      step.status === 1 && /ini:/u.test(step.output) && /mini\.ini/u.test(step.output),
      `配置身份:换 modelsim.ini → run 拒绝并点名 ini(实际 ${String(step.status)})`,
      step.output.slice(-300)
    );
    // ④ 旧版 stamp(没有任何 # cfg 行)不能被当成"配置一致":证明不了配置就要求重编 ——
    //    并且**升级路径要闭环**:compile 必须清库全量重编,之后 run 正常通过。
    {
      const oldVerif = join(hdrRoot, "verif-old");
      mkdirSync(join(oldVerif, "work"), { recursive: true });
      writeFileSync(join(oldVerif, "tb_foo.sv"), tbSource("tb_foo"));
      writeFileSync(join(oldVerif, "defs.svh"), "`define DEF_W 8\n"); // rtl/foo.sv 要 include 它
      writeFileSync(join(oldVerif, "work", ".fpga-compile-stamp"), "# compiled 2020-01-01T00:00:00\n");
      const oldDo = join(oldVerif, "run.do");
      writeFileSync(oldDo, bundledRunOnly);
      const oldLog = join(oldVerif, "ME-oldstamp.log");
      const oldFd = openSync(oldLog, "w");
      const oldStep = spawnSync("vsim", ["-c", "-do", `do ${oldDo.replace(/\\/gu, "/")} run; quit -f`], {
        stdio: ["ignore", oldFd, "ignore"],
        cwd: oldVerif,
        env: { ...process.env }
      }).status;
      closeSync(oldFd);
      const oldOut = existsSync(oldLog) ? readFileSync(oldLog, "utf8") : "";
      check(
        oldStep === 1 && /carries no configuration identity/u.test(oldOut),
        `配置身份:旧版 stamp(没有 # cfg 行)不会被当成配置一致 → run 退 1 并说明(实际 ${String(oldStep)})`,
        oldOut.slice(-300)
      );
      const oldCompile = modeStep("compile", { cwd: oldVerif, doFile: oldDo, tag: "oldstamp-compile" });
      check(
        oldCompile.status === 0 && /no configuration identity> \(written by an older template\)/u.test(oldCompile.output) &&
          /cleaning work\/ and rebuilding every source/u.test(oldCompile.output),
        `配置身份:旧版 stamp 升级路径 → compile 清库全量重编(实际 ${String(oldCompile.status)})`,
        oldCompile.output.slice(-400)
      );
      const oldRun2 = modeStep("run", { cwd: oldVerif, doFile: oldDo, tag: "oldstamp-run2" });
      check(
        oldRun2.status === 0 && /SIMULATION PASSED/u.test(oldRun2.output),
        `配置身份:旧版 stamp 重编之后 run 正常通过(实际 ${String(oldRun2.status)})`,
        oldRun2.output.slice(-300)
      );
    }

    // ⑩ 宏写在 **.sv** 里(不是 .svh):这才是"只编 changed 文件"真会出错的场景 ——
    //    `include 了 defs.sv 的 foo.sv 不会被重编,宏展开还是旧值,**而且不报错**;
    //    .svh/.vh 的 freshness 也管不到它(扩展名不是头文件)。现在 SV/V 全量交给 vlog -incr,
    //    由 ModelSim 连带重编包含方 —— 这里用**行为**验:改宏之后 elab 出来的宽度必须跟着变。
    {
      const macroRoot = join(simRoot, "macro");
      const macroVerif = join(macroRoot, "verif");
      mkdirSync(join(macroRoot, "rtl"), { recursive: true });
      mkdirSync(macroVerif, { recursive: true });
      const defsSv = join(macroVerif, "defs.sv");
      writeFileSync(defsSv, "`define TOP_W 4\n");
      writeFileSync(
        join(macroRoot, "rtl", "foo.sv"),
        '`include "defs.sv"\nmodule foo;\n    initial $display("MACRO_W=%0d", `TOP_W);\nendmodule\n'
      );
      writeFileSync(
        join(macroVerif, "tb_foo.sv"),
        '`timescale 1ns/1ps\nmodule tb_foo;\n    foo u_foo();\n    initial begin\n        $display("ALL TESTS PASSED (err_cnt=0)");\n        $finish;\n    end\nendmodule\n'
      );
      const macroDo = join(macroVerif, "run.do");
      writeFileSync(macroDo, bundledRunOnly);
      const macroStep = (mode, tag) => modeStep(mode, { cwd: macroVerif, doFile: macroDo, tag: `macro-${tag}` });
      let m = macroStep("compile", "c1");
      check(m.status === 0, `宏夹具:首次 compile 退 0(实际 ${String(m.status)})`, m.output.slice(-300));
      m = macroStep("run", "r1");
      check(
        m.status === 0 && /MACRO_W=4/u.test(m.output),
        `宏夹具:先跑出旧宽度 MACRO_W=4(实际 ${String(m.status)})`,
        m.output.slice(-300)
      );
      writeFileSync(defsSv, "`define TOP_W 8\n"); // 长度也变,不依赖 mtime 精度
      m = macroStep("compile", "c2");
      check(m.status === 0, `宏夹具:改宏之后 compile 退 0(实际 ${String(m.status)})`, m.output.slice(-300));
      m = macroStep("run", "r2");
      check(
        m.status === 0 && /MACRO_W=8/u.test(m.output),
        `改 .sv 里的宏 → 包含方跟着重编(全量交 vlog -incr):实测 MACRO_W=8(实际 ${String(m.status)})`,
        m.output.slice(-400)
      );
    }

    // ⑪ 顺序依赖(2026-09-24;复核报告 compile_order.txt 那一项):collector 按完整路径 lsort,
    //    所以 `import` 方可能排在 package 前面 —— 不加配置文件,靠"失败自动重试一次"在**一条
    //    compile 命令**里消化(失败那趟已把 package 编进 work/)。旧逻辑会在这里退 1。
    {
      const ordRoot = join(simRoot, "order");
      const ordVerif = join(ordRoot, "verif");
      mkdirSync(join(ordRoot, "rtl"), { recursive: true });
      mkdirSync(ordVerif, { recursive: true });
      // aaa_dut.sv 的路径排在 cfg_pkg.sv 前面 → 第一趟 vlog 一定找不到 package
      writeFileSync(
        join(ordRoot, "rtl", "aaa_dut.sv"),
        'module aaa_dut;\n    import cfg_pkg::*;\n    initial $display("PKG_W=%0d", DATA_W);\nendmodule\n'
      );
      writeFileSync(join(ordRoot, "rtl", "cfg_pkg.sv"), "package cfg_pkg;\n    parameter int DATA_W = 32;\nendpackage\n");
      writeFileSync(
        join(ordVerif, "tb_aaa_dut.sv"),
        '`timescale 1ns/1ps\nmodule tb_aaa_dut;\n    aaa_dut u_dut();\n    initial begin\n        $display("ALL TESTS PASSED (err_cnt=0)");\n        $finish;\n    end\nendmodule\n'
      );
      const ordDo = join(ordVerif, "run.do");
      writeFileSync(ordDo, bundledRunOnly);
      const ordStep = (mode, tag) => modeStep(mode, { cwd: ordVerif, doFile: ordDo, tag: `order-${tag}` });
      const ordCompile = ordStep("compile", "c1");
      check(
        ordCompile.status === 0 && /retrying once/u.test(ordCompile.output) &&
          /succeeded on the second attempt/u.test(ordCompile.output),
        `顺序夹具:反序包依赖在**一条 compile 命令**里成功(自动重试一次);实际 exit ${String(ordCompile.status)}`,
        ordCompile.output.slice(-400)
      );
      const ordRun = ordStep("run", "r1");
      check(
        ordRun.status === 0 && /PKG_W=32/u.test(ordRun.output),
        `顺序夹具:接着 run 也过(实际 ${String(ordRun.status)})`,
        ordRun.output.slice(-300)
      );
    }

    // ⑫ 反过来:真语法错**不能**被"重试一次"变成通过(这是重试机制唯一的风险点)。
    {
      const badRoot = join(simRoot, "badsyntax");
      const badVerif = join(badRoot, "verif");
      mkdirSync(join(badRoot, "rtl"), { recursive: true });
      mkdirSync(badVerif, { recursive: true });
      writeFileSync(join(badRoot, "rtl", "broken.sv"), "module broken;\n    logic [3:0] x = 4'b0000\nendmodule\n");
      writeFileSync(join(badVerif, "tb_broken.sv"), tbSource("tb_broken"));
      const badDo = join(badVerif, "run.do");
      writeFileSync(badDo, bundledRunOnly);
      const broken = modeStep("compile", { cwd: badVerif, doFile: badDo, tag: "badsyntax" });
      check(
        broken.status === 1 && /failed twice/u.test(broken.output),
        `真语法错:重试不会把它变成通过 → compile 退 1 并说 failed twice(实际 ${String(broken.status)})`,
        broken.output.slice(-300)
      );
    }

    // ⑬ EXTRA_INCDIRS 的**行为闭环**(复核报告 §18):换 include 搜索目录之后,compile 必须真重编,
    //    而且重编完的行为要反映新目录里的头文件(只查 stamp 变化不算)。
    {
      const incRoot = join(simRoot, "incdir");
      const incVerif = join(incRoot, "verif");
      mkdirSync(join(incRoot, "rtl"), { recursive: true });
      mkdirSync(join(incVerif, "inc_a"), { recursive: true });
      mkdirSync(join(incVerif, "inc_b"), { recursive: true });
      writeFileSync(join(incVerif, "inc_a", "defs.svh"), "`define VALUE 1\n");
      writeFileSync(join(incVerif, "inc_b", "defs.svh"), "`define VALUE 2\n");
      writeFileSync(
        join(incRoot, "rtl", "foo.sv"),
        '`include "defs.svh"\nmodule foo;\n    initial $display("VALUE=%0d", `VALUE);\nendmodule\n'
      );
      writeFileSync(
        join(incVerif, "tb_foo.sv"),
        '`timescale 1ns/1ps\nmodule tb_foo;\n    foo u_foo();\n    initial begin\n        $display("ALL TESTS PASSED (err_cnt=0)");\n        $finish;\n    end\nendmodule\n'
      );
      const withIncdir = (dir) => bundledRunOnly.replace(/set EXTRA_INCDIRS\s+\{\}/u, `set EXTRA_INCDIRS  {${dir}}`);
      const doA = join(incVerif, "run-a.do");
      const doB = join(incVerif, "run-b.do");
      writeFileSync(doA, withIncdir("inc_a"));
      writeFileSync(doB, withIncdir("inc_b"));
      check(withIncdir("inc_a") !== bundledRunOnly && withIncdir("inc_b") !== bundledRunOnly, "夹具:EXTRA_INCDIRS 两个档都真被填上了");
      const incStep = (mode, doFile, tag) => modeStep(mode, { cwd: incVerif, doFile, tag });
      let inc = incStep("compile", doA, "incdir-a-compile");
      check(inc.status === 0, `incdir 夹具:用 inc_a 编译退 0(实际 ${String(inc.status)})`, inc.output.slice(-300));
      inc = incStep("run", doA, "incdir-a-run");
      check(
        inc.status === 0 && /VALUE=1/u.test(inc.output),
        `incdir 夹具:先用 inc_a 跑出 VALUE=1(实际 ${String(inc.status)})`,
        inc.output.slice(-300)
      );
      inc = incStep("run", doB, "incdir-b-stale");
      check(
        inc.status === 1 && /incdirs:/u.test(inc.output),
        `incdir 夹具:换 inc_b → run 拒绝(实际 ${String(inc.status)})`,
        inc.output.slice(-300)
      );
      inc = incStep("compile", doB, "incdir-b-compile");
      check(
        inc.status === 0 && /cleaning work\/ and rebuilding/u.test(inc.output),
        `incdir 夹具:换 inc_b 后 compile 清库全量重编(实际 ${String(inc.status)})`,
        inc.output.slice(-400)
      );
      inc = incStep("run", doB, "incdir-b-run");
      check(
        inc.status === 0 && /VALUE=2/u.test(inc.output),
        `incdir 夹具:行为跟着变 VALUE=2(实际 ${String(inc.status)})`,
        inc.output.slice(-300)
      );
    }

    // ⑭ FULL_REBUILD=1 也走清库(复核报告 §13):语义是"当前库不可信、重建",不是"对现有库重编一遍"。
    {
      const fullDo = join(hdrVerif, "run-full.do");
      writeFileSync(fullDo, bundledRunOnly.replace(/set FULL_REBUILD\s+0/u, "set FULL_REBUILD   1"));
      check(readFileSync(fullDo, "utf8") !== bundledRunOnly, "夹具:FULL_REBUILD 旋钮真被打开了");
      const fullStep = modeStep("compile", { doFile: fullDo, tag: "fullrebuild", env: { TB_DEFINES: "SAFE_MODE" } });
      check(
        fullStep.status === 0 && /FULL_REBUILD=1: cleaning work\/ and compiling every source/u.test(fullStep.output) &&
          /full rebuild: compiling/u.test(fullStep.output),
        `FULL_REBUILD=1:清库 + 全量重编(实际 ${String(fullStep.status)})`,
        fullStep.output.slice(-400)
      );
    }

    // ⑮ 清库的安全边界(复核报告 §12):work/ 本身是 Junction → **拒绝**,不许穿过去清目标目录。
    {
      const linkRoot = join(simRoot, "worklink");
      const linkVerif = join(linkRoot, "verif");
      mkdirSync(join(linkRoot, "rtl"), { recursive: true });
      mkdirSync(linkVerif, { recursive: true });
      writeFileSync(join(linkRoot, "rtl", "foo.sv"), "module foo; endmodule\n");
      writeFileSync(join(linkVerif, "tb_foo.sv"), tbSource("tb_foo"));
      const linkDo = join(linkVerif, "run.do");
      writeFileSync(linkDo, bundledRunOnly.replace(/set FULL_REBUILD\s+0/u, "set FULL_REBUILD   1"));
      // 自造链接目标(不用文件后面才声明的 junctionOutside;那是 TDZ)
      const linkTarget = join(simRoot, "worklink-target");
      mkdirSync(linkTarget, { recursive: true });
      const markerPath = join(linkTarget, "keep-me.txt");
      writeFileSync(markerPath, "keep\n");
      let madeLink = true;
      try {
        symlinkSync(linkTarget, join(linkVerif, "work"), "junction");
      } catch (error) {
        madeLink = false;
        console.log(`ok    (跳过)本机造不出 junction(${String(error.code ?? "")}) —— work/ 链接守卫由实现静态分支保证`);
      }
      if (madeLink) {
        const linkStep = modeStep("compile", { cwd: linkVerif, doFile: linkDo, tag: "worklink" });
        check(
          linkStep.status === 1 && /refusing to clean it/u.test(linkStep.output) && /symlink\/Junction/u.test(linkStep.output),
          `work/ 是 Junction → 拒绝清库(实际 ${String(linkStep.status)})`,
          linkStep.output.slice(-300)
        );
        check(
          existsSync(markerPath) && readFileSync(markerPath, "utf8") === "keep\n",
          "拒绝之后**链接目标一个字节没动**(清库没有穿过去)"
        );
      }
    }
  }
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
// 2026-10-22 审查 L1：连续大写缩写要落在合理边界上。
// 原来只有 `([a-z0-9])([A-Z])` 一条，于是 `SPIMaster → spimaster`、`I2CMaster → i2_cmaster`。
// 关键是**数字不是分界**：I2C / I2S / AXI4 这类缩写里的数字与相邻大写属于同一个词。
check(snakeCase("SPIMaster") === "spi_master", "SPIMaster → spi_master(连续大写按缩写处理)");
check(snakeCase("I2CMaster") === "i2c_master", "I2CMaster → i2c_master(数字不是分界)");
check(snakeCase("AXI4Stream") === "axi4_stream", "AXI4Stream → axi4_stream(数字后接词首仍算边界)");
check(snakeCase("UartRx") === "uart_rx", "UartRx → uart_rx(技能里承诺的样例，不能改坏)");
// run.do 反过来:名字是**固定**的(跑法里 `do run.do` 写死了它),不跟模板扩展名走、也不替模块名
check(
  defaultDestination("sim-compile", undefined, "C:/t/compile.do") === join("verif", "run.do"),
  "仿真编译脚本落到 verif/run.do"
);
check(
  defaultDestination("sim-run", undefined, "C:/t/run.do") === join("verif", "run.do"),
  "run.do 落到 verif/run.do(起它时不用给模块名)"
);
check(
  defaultDestination("sim-run", "UartRx", "C:/t/custom.tcl") === join("verif", "run.do"),
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
const bundledXdc = readFileSync(categorizedTemplates.constraints, "utf8");
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
  const path = [join(TOOLS, script), join(MODULE_TOOLS, script), join(PROJECT_TOOLS, script)].find((candidate) => existsSync(candidate)) ?? join(TOOLS, script);
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
// 2026-09-22 收窄(用户口径):计数/索引比常量、比参数、函数返回值**不再提醒** ——
// 实测收窄前 timing_gen 9 条 + line_buffer 6 条警告全是这一类,把真正的数据比对淹了。
check(
  !blocking(neqLoopPath, true).some((issue) => issue.rule === "!= 待确认"),
  "循环/计数条件(`while (i != 0)`)不再提醒(按既定口径:循环/计数可保留)"
);
const neqLoopCode = run("module-rtl-check.mjs", [neqLoopMod]);
check(neqLoopCode === 0, `计数条件静默 → 退出码 0(实际 ${neqLoopCode})`);

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
  !blocking(neqConstPath, true).some((issue) => issue.rule === "!= 待确认"),
  "计数/索引比常量(`exp_pixel_idx != 0`、`(x % W) != (W-1)`)不再提醒(收窄后)"
);
const neqConstCode = run("module-rtl-check.mjs", [neqConstMod]);
check(neqConstCode === 0, `计数/索引比常量静默 → 退出码 0(实际 ${neqConstCode})`);

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

// ②d 收窄后的真实形状(取自 timing_gen 9 条 + line_buffer 6 条的同类写法,2026-09-22):
//     计数比常量 / 比全大写参数 / 函数返回值 / 参数表达式 / 不当判定用 —— 这些都不该再提醒
const neqShapeMod = join(SANDBOX, "neq-shape-mod");
mkdirSync(join(neqShapeMod, "rtl"), { recursive: true });
mkdirSync(join(neqShapeMod, "verif"), { recursive: true });
const neqShapePath = join(neqShapeMod, "verif", "tb_neq_shape.sv");
const neqShapes = [
  "        if (cnt != 0) cnt = cnt + 1;",
  "        if (cnt != C_IMG_HEIGHT) cnt = cnt + 1;",
  "        if ($fscanf(fd, \"%h\", mem[i]) != 1) cnt = cnt + 1;",
  "        if (tran_cnt != FRAME_SZ * TB_FRAME_NUM) cnt = cnt + 1;",
  "        $display(\"probe %0d\", (sig_a != sig_b));"
];
for (const shape of neqShapes) {
  writeFileSync(neqShapePath, goodTb
    .replace("module tb_good;", "module tb_neq_shape;")
    .replace("        if (err_cnt == 0)", `${shape}\n        if (err_cnt == 0)`));
  check(
    !blocking(neqShapePath, true).some((issue) => issue.rule === "!= 待确认"),
    `收窄:这类不再提醒 → ${shape.trim()}`
  );
}
// ⑤ 逐对分类(第四轮 Q4-08 + 第五轮 2.1):
//    FAIL 分支**也要**套收窄(期望值命名的**计数**比全大写参数不算数据比对),
//    但同一行里另一对真正的数据比对**不能被吞掉**(整行 every 就会吞)。
for (const shape of [
  "        if (exp_cnt != DEPTH) cnt = 0;",
  "        if (exp_pixel_idx != DEPTH) idx = 0;"
]) {
  writeFileSync(neqShapePath, goodTb
    .replace("module tb_good;", "module tb_neq_shape;")
    .replace("        if (err_cnt == 0)", `${shape}\n        if (err_cnt == 0)`));
  check(
    !blocking(neqShapePath, true).some((issue) => issue.rule === "数据比对"),
    `期望值命名的计数比全大写参数**不判 FAIL**(收窄漏套的回归)→ ${shape.trim()}`
  );
}
// 同一行:前一对是计数比参数,后一对才是真数据比对 → 必须仍然 FAIL(Q4-08)
writeFileSync(neqShapePath, goodTb
  .replace("module tb_good;", "module tb_neq_shape;")
  .replace("        if (err_cnt == 0)", "        if (cnt != MAX_COUNT && dut_data != exp_data) err_cnt = err_cnt + 1;\n        if (err_cnt == 0)"));
check(
  blocking(neqShapePath, true).some((issue) => issue.rule === "数据比对"),
  "同行的参数比较**不许**吞掉后面的数据比对(逐对分类;Q4-08)"
);
// 同一行:前一对计数比参数,后一对是普通信号判定 → 后面那对仍要提醒
writeFileSync(neqShapePath, goodTb
  .replace("module tb_good;", "module tb_neq_shape;")
  .replace("        if (err_cnt == 0)", "        if (cnt != MAX_COUNT && sig_a != sig_b) err_cnt = err_cnt + 1;\n        if (err_cnt == 0)"));
check(
  blocking(neqShapePath, true).some((issue) => issue.rule === "!= 待确认"),
  "同行的参数比较**不许**吞掉后面普通信号对的提醒(Q4-08)"
);
// 反向对照:两侧都是普通信号、又当判定用 → 仍然提醒(不能收窄成"什么都不报")
writeFileSync(neqShapePath, goodTb
  .replace("module tb_good;", "module tb_neq_shape;")
  .replace("        if (err_cnt == 0)", "        if (sig_a != sig_b) err_cnt = err_cnt + 1;\n        if (err_cnt == 0)"));
check(
  blocking(neqShapePath, true).some((issue) => issue.rule === "!= 待确认"),
  "收窄后仍提醒:两侧都是普通信号 + 当判定用"
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
  run("module-rtl-new.mjs", [newFileRoot, "uart_rx", "--template", categorizedTemplates.rtl]) === 0,
  "module-rtl-new 按模板起文件 → 退出码 0"
);
check(existsSync(join(newFileRoot, "rtl", "uart_rx.sv")), "RTL 落在 rtl/ 下");
// 模块根可以放在**任意深度**(用户口径 2026-09-21:按功能分组,别被固定的类别目录限制)。
// 模板引用与模块路径无关 —— `--template` 拿的是设置里那份或插件包自带那份的**绝对路径**
// (解析基准是插件包自身,不是 CWD):所以多层、带空格都照落,不需要为此改任何东西。
const deepMod = join(SANDBOX, `deep-${stamp}`, "功能组 甲", "uart_rx");
check(
  run("module-rtl-new.mjs", [deepMod, "UartRx", "--template", categorizedTemplates.rtl]) === 0
    && existsSync(join(deepMod, "rtl", "UartRx.sv")),
  "多层 + 带空格的模块根照样落对(模板引用与模块路径、当前目录无关)"
);
check(
  run("module-verif-new.mjs", [deepMod, "UartRx", "--template", categorizedTemplates.testbench]) === 0
    && existsSync(join(deepMod, "verif", "tb_uart_rx.sv")),
  "同一个深层模块根:测试平台也落在它自己的 verif/ 下"
);
check(
  run("module-rtl-check.mjs", [newFileRoot]) === 0,
  "模板生成的文件直接过机械检查(骨架开箱合规)"
);
check(
  run("module-verif-new.mjs", [newFileRoot, "uart_rx", "--template", categorizedTemplates.testbench]) === 0
    && existsSync(join(newFileRoot, "verif", "tb_uart_rx.sv")),
  "verif-new 把测试平台落在 verif/tb_<snake>.sv"
);
// 两个 kind(sim-compile / sim-run)起的是**同一份**仿真脚本;只给模块根,不需要模块名。
check(
  run("module-verif-new.mjs", [newFileRoot, "--kind", "sim-compile"]) === 0
    && existsSync(join(newFileRoot, "verif", "run.do")),
  "verif-new --kind sim-compile 起出 verif/run.do(合并后的落点名)"
);
check(
  readFileSync(join(newFileRoot, "verif", "run.do"), "utf8") === bundledCompileDo,
  "起出来的 run.do 与合并模板逐字节一致(sim-compile 侧)"
);
check(
    run("module-verif-new.mjs", [newFileRoot, "--kind", "sim-run"]) === 1,
    "sim-run 与 sim-compile 落同一个 verif/run.do:第二次起会拒绝覆盖(退 1)"
);
check(
  readFileSync(join(newFileRoot, "verif", "run.do"), "utf8") === bundledRunOnly,
  "起出来的 run.do 与合并模板逐字节一致(同一份)"
);
check(
  run("module-verif-new.mjs", [newFileRoot, "--kind", "sim-run"]) === 1,
  "已存在的 run.do 不覆盖 → 退出码 1"
);
check(
  run("module-verif-new.mjs", [newFileRoot, "--kind", "sim-run", "--force"]) === 0,
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
  run("module-verif-new.mjs", [backupMod, "--kind", "sim-run", "--force"]) === 0,
  "已有 run.do + --force → 退出码 0(覆盖)"
);
check(readFileSync(backupRunDo, "utf8") === bundledRunOnly, "目标确实被新模板覆盖了");
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
  // 解析顺序:预设的工具目录(按级别分目录) → 仓库根 tools/
  const path = [join(MODULE_TOOLS, script), join(PROJECT_TOOLS, script), join(TOOLS, script), join(ROOT, "tools", script)].find((candidate) => existsSync(candidate)) ?? join(TOOLS, script);
  const log = join(SANDBOX, `stderr-${script}-${String(Date.now())}.log`);
  const fd = openSync(log, "w");
  const code = spawnSync(process.execPath, [path, ...args], { stdio: ["ignore", "ignore", fd] }).status;
  closeSync(fd);
  return { code, output: readFileSync(log, "utf8") };
};
// 同一个道理,但收 **stdout** —— 检查器把正常结论(ok / warn / PASS)写在 stdout,只有用法错误与
// 落盘失败走 stderr。用 runStderr 去读一条警告会什么都读不到(实测踩过:断言像在测空气)。
const runStdout = (script, args) => {
  // 解析顺序:预设的工具目录(按级别分目录) → 仓库根 tools/
  const path = [join(MODULE_TOOLS, script), join(PROJECT_TOOLS, script), join(TOOLS, script), join(ROOT, "tools", script)].find((candidate) => existsSync(candidate)) ?? join(TOOLS, script);
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
const dirForce = runStderr("module-verif-new.mjs", [dirTargetMod, "--kind", "sim-run", "--force"]);
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
  run("module-verif-new.mjs", ["--kind", "sim-run"]) === 2,
  "漏给模块根 → 退出码 2(`--kind` 的值不会被当成根目录)"
);

// ── 起综合脚本 / 比对脚本(module-synth-new --kind synth-script / module-verif-new --kind comp)──
// 综合脚本那两行(器件型号、顶层模块名)以前靠手抄 —— 手抄就是"器件与时钟只写一处"之外的第二处
// 来源,换器件时必漏。现在起脚本时从 spec/spec.md 读出来填。夹具器件**故意与自带模板里那个
// 不同**:填没填上,一眼分得出来。
const bundledRunSynth = readFileSync(categorizedTemplates.synthesis, "utf8");
// 器件预检**必须同时认两种写法**(2026-09-21 实测:9 个真实 `.xci` 全是 Vivado 2025.x 的 JSON,
// 器件被拆成 DEVICE / PACKAGE / SPEEDGRADE 三段,只有老的 `part = xc…` 整串正则 → 一条都匹配不上,
// 预检于是打了 WARN 就跳过 = 从来没真跑过)。行为已用真 Vivado 复核(见 run_synth.tcl 头注)。
// 断言钉在**真的 regexp 命令行**上,不是钉在模板文本里出现过这几个词 —— 否则上面那段解释性
// 注释就能把断言喂饱(这么写的第一版就被注释蒙过去了,咬人验证时才发现)。
// 自带模板的时钟必须**同一个数**(第五轮 2.2):tb.sv 的 CLK_PERIOD 与 constraints.xdc 的
// `create_clock -period` 是同一份"默认节拍"的两处写法 —— 4ns vs 10ns 会让仿真按 250 MHz 跑、
// 时序却按 100 MHz 收,综合后时序结论直接失去意义。
const bundledTbHeader = readFileSync(categorizedTemplates.testbench, "utf8").split("\n").slice(0, 10);
check(
  bundledTbHeader.every((line) => line.length <= 86),
  `自带 tb.sv 的前 10 行都不超过 86 列(与 rtl.sv 的横幅约定一致;实际最长 ${Math.max(...bundledTbHeader.map((line) => line.length))} 列)`
);
const bundledTbClock = readFileSync(categorizedTemplates.testbench, "utf8");
const bundledXdcClock = readFileSync(categorizedTemplates.constraints, "utf8");
  const tbPeriod = /CLK_PERIOD\s*=\s*(\d+(?:\.\d+)?)\s*ns/u.exec(bundledTbClock)?.[1];
  // DSH-01 之后内置 XDC **没有生效时钟**(周期必须来自 spec),所以不再比较"两处同数":
  //   ① XDC 里真写了周期 → TB 必须同数(第五轮那条契约仍然有效);
  //   ② XDC 没写(内置模板的形态)→ TB 必须写明"周期取自 spec",别让 10 ns 看着像工程事实。
  const xdcPeriod = /^\s*create_clock[^\n]*-period\s+(\d+(?:\.\d+)?)/mu.exec(bundledXdcClock)?.[1];
  check(
    tbPeriod !== undefined &&
      (xdcPeriod !== undefined ? Number(tbPeriod) === Number(xdcPeriod) : /spec\/spec\.md/u.test(bundledTbClock)),
    `自带 tb.sv 的 CLK_PERIOD 与 XDC 口径一致(tb=${String(tbPeriod)}ns / xdc=${String(xdcPeriod)}ns)：XDC 有生效周期就同数,没有则 TB 必须写明周期取自 spec`
  );
// 第五轮之后追加(我这轮的审计发现):综合门禁自称查"建工程 / 收文件阶段的 CRITICAL WARNING",
// 实测真综合跑出的主日志里躺着一条 filemgmt 20-742,而它判了 PASS(那些行不进 runme.log,
// 消息计数也没算它)。现在多一层:扫**主日志**、逐条列出来 + 计数(不直接判死 —— 那类多数是良性)。
// 断言锚在**代码形状**上(注释里出现关键词不算),并且必须是真在扫主日志那份文件。
// 2026-09-24(T-17):主日志路径不再从 `$argv` 里找 `-log`(实测 `-source` 模式下 `$argv` 为空,
// 那段解析是死代码),改成与工程综合同口径:旋钮 MAIN_LOG → `-tclargs` 第一个参数 → 约定路径。
check(
  /set main_crits \{\}/u.test(bundledRunSynth) &&
    /lappend main_crits \$line/u.test(bundledRunSynth) &&
    /main log has \[llength \$main_crits\] CRITICAL WARNING/u.test(bundledRunSynth) &&
    /string match "#\*" \$line/u.test(bundledRunSynth) &&
    /set MAIN_LOG ""/u.test(bundledRunSynth) &&
    /\[llength \$argv\] > 0/u.test(bundledRunSynth) &&
    /run_synth\.log/u.test(bundledRunSynth) &&
    !/foreach \{flag value\} \$argv/u.test(bundledRunSynth),
  "run_synth.tcl 收尾判定会扫**主日志**里的 CRITICAL WARNING 并逐条列出(它们不进 runme.log);主日志路径走旋钮 / -tclargs / 约定路径"
);
check(
  /proc xci_part/u.test(bundledRunSynth) &&
    /regexp[^\n]*"DEVICE"/u.test(bundledRunSynth) &&
    /regexp[^\n]*"PACKAGE"/u.test(bundledRunSynth) &&
    /regexp[^\n]*"SPEEDGRADE"/u.test(bundledRunSynth),
  "run_synth.tcl 的器件预检真的去读 2025.x JSON 三段(DEVICE / PACKAGE / SPEEDGRADE)"
);
// 2026-10-22 审查 L2：Tcl 自上而下解释，`proc fail` 必须出现在**任何调用之前**。
// 否则"RTL/工程目录是 junction 就拒绝"那段护栏会报 `invalid command name "fail"`，
// 文案失效（看起来像脚本崩了，而不是明确拒绝）。
// 覆盖 synthesis/ 下全部模板（module 版与 project 版都在那儿）。
const synthesisDir = join(ROOT, "presets", "fpga-workbench", "templates", "synthesis");
const tclFiles = readdirSync(synthesisDir).filter((name) => name.endsWith(".tcl"));
check(tclFiles.length > 0, `找得到 synthesis/ 下的 Tcl 模板（${String(tclFiles.length)} 份）`);
for (const name of tclFiles) {
  const text = readFileSync(join(synthesisDir, name), "utf8");
  const procAt = text.search(/^\s*proc\s+fail\b/mu);
  const callAt = text.search(/^\s*fail\s+"/mu);
  check(
    procAt < 0 || callAt < 0 || procAt < callAt,
    `${name} 的 proc fail 定义在首次调用之前（L2；proc@${String(procAt)} call@${String(callAt)}）`
  );
}
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

// 模块位于带 project 锚点的用户指定工程目录下时,工程器件从 doc/spec.md 读;顶层名仍按模块名。
const projSynthRoot = join(SANDBOX, `synth-proj-${stamp}`);
const projSynthMod = join(projSynthRoot, "uart_rx");
mkdirSync(join(projSynthRoot, "doc"), { recursive: true });
mkdirSync(join(projSynthMod, "spec"), { recursive: true });
writeFileSync(join(projSynthRoot, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
writeFileSync(join(projSynthRoot, "doc", "spec.md"), "# 工程 spec\n\n- 器件型号:xcku040-ffva1156-2-e\n");
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
//
// **注意(第五轮 1.2)**:`readSpecFields()` 在「工程有器件 + 模块也有器件 + 不一致」时判 conflict → 退 2。
// 所以这条用例必须用**没有兄弟工程**的模块根(下面那个独立根),否则它走进的是冲突分支、
// 而不是"字段行怎么读" —— 焦点就糊了。
const realShapeRoot = join(SANDBOX, `synth-realshape-${stamp}`);
mkdirSync(join(realShapeRoot, "spec"), { recursive: true });
writeFileSync(
  join(realShapeRoot, "spec", "spec.md"),
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
const realShapeScript = join(realShapeRoot, "synth", "run_synth.tcl");
const realShapeCode = run("module-synth-new.mjs", [realShapeRoot, "uart_rx", "--kind", "synth-script"]);
const realShapeText = existsSync(realShapeScript) ? readFileSync(realShapeScript, "utf8") : "";
check(
  realShapeCode === 0 && realShapeText.includes('set PART "xc7a100tfgg484-2"') && !realShapeText.includes("xcku3p"),
  `真实 spec 形状(字段行 + 族名 + 历史行)→ 取字段行那个器件(退出码 ${String(realShapeCode)})`,
  realShapeText.split("\n").filter((line) => line.startsWith("set ")).join(" | ")
);

// `--kind comp`:比对脚本落 verif/comp.py(原样复制,不改一个字符)
const bundledCompPath = categorizedTemplates.verification;
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
// 归一化那几条要读它的输出("format-only difference ignored: …"),所以这里另外抓一次文本。
const compOutput = (...args) => spawnSync("python", [bundledCompPath, ...args], { encoding: "utf8" }).stdout;
const emptyCode = compStatus(emptyRef, emptyOut);
check(
  emptyCode === 0,
  `comp.py:两边都没有样本 → 正常比完(0 个值)退 0,不再算失败(实际退出码 ${emptyCode};null = PATH 上没有 python)`
);
check(
  compStatus(diffRef, diffOut) === 1,
  "comp.py:取值不一致仍然退 1(去掉 0 样本那条规则没把判据弄丢)"
);
// 2026-09-25 深挖补上:脚本**存在的理由**就是"先归一化再只比值"(实测事故:金标 CRLF、输出 LF,
// 逐字节比让纯排版差异冒充功能失败)。这五种行为原先一条夹具都没有 —— 归一化被改坏不会有人发现。
const bomRef = (() => {
  const path = join(compFixture, "bom_ref.hex");
  writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("0x10\n", "utf8")]));
  return path;
})();
const lfRef = compCase("lf_ref.hex", "0x0001\n0x0002\n");
// CRLF + 行尾空白 + 首尾空行 + 十六进制大小写:全部是**纯排版**,判一致;并且要**说出来忽略了什么**。
const messyOut = compCase("messy_out.hex", "\r\n  0x0001  \r\n0X0002\r\n\r\n");
const messyStatus = compStatus(lfRef, messyOut);
check(
  messyStatus === 0 && compOutput(lfRef, messyOut).includes("line endings"),
  `comp.py:纯排版差异(CRLF/LF + 行尾空白 + 空行 + 十六进制大小写)判一致并说明忽略了什么(实际 ${String(messyStatus)})`,
  compOutput(lfRef, messyOut).slice(-200)
);
check(
  compStatus(bomRef, compCase("bom_out.hex", "0x10\n")) === 0,
  "comp.py:一侧带 BOM 也判一致(utf-8-sig 抹掉)"
);
check(
  compStatus(compCase("prefix_ref.hex", "0xAA\n"), compCase("prefix_out.hex", "AA\n")) === 0,
  "comp.py:0x 前缀有无判一致"
);
check(
  compStatus(compCase("text_ref.txt", "hello \n"), compCase("text_out.txt", "hello\n"), "--kind", "text") === 0,
  "comp.py:--kind text 走文本归一化(行尾空白不算差异)"
);
check(
  compStatus(emptyRef, join(compFixture, "no-such-file.hex")) === 2,
  "comp.py:文件读不到 → 退 2(参数/环境错,与'值不一致'的 1 区分开)"
);
check(
  compStatus(emptyRef) === 2,
  "comp.py:参数不全 → 退 2"
);

// ── module-synth-new:约束落点 ───────────────────────────────────────────────
check(
  run("module-synth-new.mjs", [newFileRoot, "uart_rx", "--template", categorizedTemplates.constraints]) === 0
    && existsSync(join(newFileRoot, "synth", "uart_rx.xdc")),
  "module-synth-new 把约束落在 synth/<模块名>.xdc"
);
check(
  run("module-rtl-new.mjs", [newFileRoot, "uart_rx", "--template", categorizedTemplates.rtl]) === 1,
  "已存在的文件不覆盖 → 退出码 1"
);
check(
  run("module-rtl-new.mjs", [newFileRoot, "uart_rx", "--template", categorizedTemplates.rtl, "--force"]) === 0,
  "--force 才覆盖"
);
// `--out` 是相对根目录的路径:`..` 逃逸与绝对路径都要挡在写之前(审查指出、实测复现过:
// 不挡的话 `--out "..\x.sv"` 会真写到根目录外面)
const escapeRoot = join(SANDBOX, `escape-${stamp}`, "mod");
mkdirSync(escapeRoot, { recursive: true });
const escapeTarget = join(SANDBOX, `escape-${stamp}`, "escaped.sv");
check(
  run("module-rtl-new.mjs", [escapeRoot, "uart_rx", "--template", categorizedTemplates.rtl, "--out", join("..", "escaped.sv")]) === 2,
  "--out 用 .. 逃出根目录 → 退出码 2"
);
check(!existsSync(escapeTarget), "逃逸请求没有真的写出文件(挡在写之前)");
check(
  run("module-rtl-new.mjs", [escapeRoot, "uart_rx", "--template", categorizedTemplates.rtl, "--out", escapeTarget]) === 2,
  "--out 传绝对路径 → 退出码 2"
);
check(
  run("module-rtl-new.mjs", [escapeRoot, "uart_rx", "--template", categorizedTemplates.rtl, "--out", join("rtl", "sub", "uart_rx.sv")]) === 0
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
// `project`,于是在当前目录下建出一整套 `./project/` 还退 0 —— 这里的 `project` 是被误当成
// 路径的 `--kind` 选项值,不是现在的工程目录结构。用户会以为建在他给的根上(写到错地方
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
    && existsSync(join(argsRoot, "doc"))
    && existsSync(join(argsRoot, "src", "rtl"))
    && existsSync(join(argsRoot, "src", "sim"))
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

// `--modules` 已停用：无论值长什么样都在落盘前拒绝；工程不会替用户创建模块目录。
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
  escapeMod("uart_rx") === 2 && !existsSync(join(moduleEscapeRoot, "uart_rx")),
  "合法名字也不会触发自动建模块目录(--modules 已停用)"
);
check(
  escapeMod("a..b") === 2 && !existsSync(join(moduleEscapeRoot, "a..b")),
  "--modules 的任何取值都一致拒绝"
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
    && !existsSync(join(forceRoot, "doc"))
    && readFileSync(forceAnchor, "utf8").includes("\"module\""),
  "跨 kind 是硬拒绝:带 --force 也退 1,工程目录与根锚点都没动"
);

// ── F-13:路径边界不能只看词法 —— junction 的真实落点必须被识破 ───────────────
//
// 纯字符串判断只看"路径长什么样";一个 junction(或符号链接)能让 `--out` 与模块子目录的**真实落点**
// 跑到根目录**外面**去,而词法上一切正常。这里用**真 junction** 定向验证(node 的
// `symlinkSync(..., "junction")` 在 Windows 上不需要管理员权限;造不出来就明确跳过,不假装通过):
//   · `--out` 落在"根里的 junction 子目录"下 → 真实落点在根外 → 退 2,一个文件都不落
//   · 已停用的 `--modules` 即使指向 junction 也在解析期拒绝,不做任何落盘
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
    stampJunctionRoot, "uart_rx", "--template", categorizedTemplates.rtl, "--out", join("escape", "escaped.sv")
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
  check(!existsSync(join(junctionRoot, "doc")), "参数检查挡在任何落盘之前(工程目录也没建)");
  check(
    junctionScaffold.output.includes("--modules 已停用"),
    "骨架拒绝时明确说明 --modules 已停用",
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

// `--modules` 在任何落盘前拒绝，不会形成过去那种“工程建了一半、模块锚点失败”的半成品。
const halfRoot = join(SANDBOX, `half-fail-${stamp}`);
mkdirSync(join(halfRoot, "uart", ".fpga-workbench.json"), { recursive: true });
const halfFail = runStderr("setup-scaffold.mjs", [halfRoot, "--kind", "project", "--modules", "uart", "--force"]);
check(halfFail.code === 2, `--modules 在落盘前拒绝 → 退出码 2(实际 ${String(halfFail.code)})`);
check(
  halfFail.output.includes("--modules 已停用"),
  "拒绝原因明确指向已停用的参数",
  halfFail.output.slice(-400)
);
check(
  !existsSync(join(halfRoot, "doc")) && !existsSync(join(halfRoot, ".fpga-workbench.json")),
  "拒绝时工程目录与根锚点都没有落盘"
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
mkdirSync(join(anchorDirRoot, ".fpga-workbench.json", "inner"), { recursive: true });
writeFileSync(join(anchorDirRoot, ".fpga-workbench.json", "inner", "keep.txt"), "keep\n");
const anchorDir1 = runStderr("setup-scaffold.mjs", [anchorDirRoot, "--kind", "project"]);
const anchorDir2 = runStderr("setup-scaffold.mjs", [anchorDirRoot, "--kind", "project"]);
check(
  anchorDir1.code === 1 && anchorDir2.code === 1,
  `工程根锚点位置是目录 → 两次都退 1(实际 ${String(anchorDir1.code)} / ${String(anchorDir2.code)})`
);
check(
  !anchorDir1.output.includes("骨架已完整") && !anchorDir2.output.includes("骨架已完整") &&
    anchorDir2.output.includes(join(anchorDirRoot, ".fpga-workbench.json")),
  "第二次全「已存在」时也不谎报「骨架已完整」,并点名那个位置",
  anchorDir2.output.slice(-300)
);
check(
  !existsSync(join(anchorDirRoot, "doc")) && !existsSync(join(anchorDirRoot, "src")),
  "拒绝发生在任何落盘之前(工程目录都没建)"
);
check(
  readFileSync(join(anchorDirRoot, ".fpga-workbench.json", "inner", "keep.txt"), "utf8").includes("keep"),
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
  hollowCard.code === 0 && /探针不可用|探针找不到/u.test(hollowCard.output) && /config 要是非空对象/u.test(hollowCard.output) && /可识别的实测字段/u.test(hollowCard.output),
  "空洞的卡(config 空、探针不在、没有可识别实测字段)→ 三条都点出来(N-12/Q4-12)",
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

// ── project-rtl-check:工程树入口 + 根 ip/ 时序卡 ──────────────────────────────
//
// 工程 IP 在根 `ip/`(不是 `rtl/ip/`);时序卡相对**工程根**核验探针。
const projIpRoot = join(SANDBOX, `project-rtl-${stamp}`);
mkdirSync(join(projIpRoot, "src", "rtl"), { recursive: true });
mkdirSync(join(projIpRoot, "src", "sim"), { recursive: true });
mkdirSync(join(projIpRoot, "sim"), { recursive: true });
mkdirSync(join(projIpRoot, "ip", "xpm_fifo_sync"), { recursive: true });
writeFileSync(join(projIpRoot, "src", "rtl", "good.sv"), goodRtl);
writeFileSync(join(projIpRoot, "src", "sim", "tb_good.sv"), goodTb);
const projNoCard = runStdout("project-rtl-check.mjs", [projIpRoot]);
check(
  projNoCard.code === 0 &&
    projNoCard.output.includes("ip/xpm_fifo_sync/timing.json") &&
    projNoCard.output.includes("没有 timing.json") &&
    !projNoCard.output.includes("rtl/ip/"),
  `工程 IP 卡查根 ip/(不是 rtl/ip/),缺卡只警告(退出码 ${String(projNoCard.code)})`,
  projNoCard.output.slice(-300)
);
writeFileSync(join(projIpRoot, "ip", "xpm_fifo_sync", "probe.sv"), "// probe\n");
writeFileSync(
  join(projIpRoot, "ip", "xpm_fifo_sync", "timing.json"),
  `${JSON.stringify(
    { card: "xpm_fifo_sync @ probe", measured: "2026-09-22", probe: "ip/xpm_fifo_sync/probe.sv", config: { READ_MODE: "std" }, read_latency: 2 },
    null,
    2
  )}\n`
);
const projWithCard = runStdout("project-rtl-check.mjs", [projIpRoot]);
check(
  projWithCard.code === 0 && !projWithCard.output.includes("没有 timing.json") && !/探针不可用|探针找不到/u.test(projWithCard.output),
  "工程 IP 补上完整 timing.json(探针相对工程根)后警告消失"
);
const projNoRtl = join(SANDBOX, `project-rtl-noroot-${stamp}`);
mkdirSync(join(projNoRtl, "src"), { recursive: true });
check(
  runStdout("project-rtl-check.mjs", [projNoRtl]).code === 2,
  "工程没有 src/rtl/ → 退出码 2"
);

// F7-01:上板 Skill 必须真正读 DEVICE_FILTER(只写提示不执行 = 死路)
{
  const boardSkill = readFileSync(
    join(ROOT, "presets", "fpga-workbench", "skills", "fpga-project-board", "SKILL.md"),
    "utf8"
  );
  check(
    boardSkill.includes("get_hw_devices -filter $DEVICE_FILTER") &&
      boardSkill.includes("info exists DEVICE_FILTER"),
    "上板 Skill 的设备选择真正使用 DEVICE_FILTER"
  );
}

// F7-03/F7-04:根下平铺 IP 文件要提示;probe 目录不能当探针
{
  const f7Ip = join(SANDBOX, `project-ip-f7-${stamp}`);
  mkdirSync(join(f7Ip, "src", "rtl"), { recursive: true });
  mkdirSync(join(f7Ip, "ip", "fifo"), { recursive: true });
  writeFileSync(join(f7Ip, "src", "rtl", "good.sv"), goodRtl);
  writeFileSync(join(f7Ip, "ip", "loose.xci"), "# loose\n");
  writeFileSync(join(f7Ip, "ip", "fifo", "fifo.xci"), "# xci\n");
  writeFileSync(join(f7Ip, "ip", "fifo", "probe.sv"), "// probe file\n");
  writeFileSync(
    join(f7Ip, "ip", "fifo", "timing.json"),
    JSON.stringify(
      { card: "fifo @ probe", measured: "2026-09-22", probe: "ip/fifo", config: { MODE: "std" }, read_latency: 1 },
      null,
      2
    )
  );
  const dirProbe = runStdout("project-rtl-check.mjs", [f7Ip]);
  check(
    dirProbe.output.includes("ip/loose.xci") && /平铺/.test(dirProbe.output),
    "ip/ 根下平铺 .xci → 明确提示(F7-03)",
    dirProbe.output.slice(-300)
  );
  check(
    /探针不可用/.test(dirProbe.output),
    "probe 指向目录不能当探针(F7-04)",
    dirProbe.output.slice(-300)
  );
  writeFileSync(
    join(f7Ip, "ip", "fifo", "timing.json"),
    JSON.stringify(
      { card: "fifo @ probe", measured: "2026-09-22", probe: "ip/fifo/probe.sv", config: { MODE: "std" }, read_latency: 1 },
      null,
      2
    )
  );
  const fileProbe = runStdout("project-rtl-check.mjs", [f7Ip]);
  check(
    !/探针不可用/.test(fileProbe.output) && fileProbe.output.includes("ip/loose.xci"),
    "普通文件 probe 可用;平铺 .xci 提示仍保留",
    fileProbe.output.slice(-300)
  );
}

// F5-02:仿真目录里的 helper 不是 TB —— 不得报「缺成功标记」;真正的 tb_* 仍严查
{
  const f5Sim = join(SANDBOX, `project-helper-${stamp}`);
  mkdirSync(join(f5Sim, "src", "rtl"), { recursive: true });
  mkdirSync(join(f5Sim, "sim"), { recursive: true });
  writeFileSync(join(f5Sim, "src", "rtl", "good.sv"), goodRtl);
  // helper:合规普通 HDL(完整头/小节/断言),但**不是 TB** —— 没有 ALL TESTS PASSED / err_cnt
  writeFileSync(
    join(f5Sim, "sim", "driver_helper.sv"),
    goodRtl.replace(/module good/gu, "module driver_helper").replace(/good\.sv/gu, "driver_helper.sv")
  );
  writeFileSync(join(f5Sim, "sim", "tb_top.sv"), goodTb.replace(/tb_good/gu, "tb_top"));
  const helperRun = runStdout("project-rtl-check.mjs", [f5Sim]);
  check(
    helperRun.code === 0 && helperRun.output.includes("driver_helper.sv"),
    "仿真目录扫描到 helper(退出码 0)",
    helperRun.output.slice(-200)
  );
  check(
    !/driver_helper\.sv[\s\S]{0,240}(成功标记|ALL TESTS PASSED|err_cnt)/u.test(helperRun.output) &&
      !helperRun.output.includes("FAIL  sim/driver_helper.sv") &&
      !helperRun.output.includes("FAIL  src/sim/driver_helper.sv"),
    "helper 不按 TB 规则报缺成功标记/err_cnt",
    helperRun.output.slice(-400)
  );
  writeFileSync(
    join(f5Sim, "sim", "tb_bad.sv"),
    "# tb\nmodule tb_bad; initial $display(\"hi\"); endmodule\n"
  );
  const tbBad = runStdout("project-rtl-check.mjs", [f5Sim]);
  check(
    tbBad.code === 1 && /tb_bad\.sv/u.test(tbBad.output) && /ALL TESTS PASSED|成功标记/u.test(tbBad.output),
    "真正 TB 缺成功标记仍然 FAIL",
    tbBad.output.slice(-400)
  );
}

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
// 第五轮 3.3:`posedge rst_n`(命名像低有效却当复位时钟沿)也要被复位规则抓到
check(
  hasIssue(nameRuleIssues("    always_ff @(posedge rst_n) begin end"), /复位极性/u),
  "`posedge rst_n` 这种写法进「复位极性」(命名与用法矛盾;第五轮 3.3)"
);
// 2026-10-22 审查 H2:注释里出现违规字样**不算**代码。
// AGENTS.fpga.md 第 9 条要求"已有工程按实际约定来，要改先说明理由"——
// 在注释里写明理由（可能正好含 `negedge rst_n`）不该被判 FAIL。
check(
  !hasIssue(nameRuleIssues('    // NOTE: 本项目约定如此，never write "negedge rst_n" here.'), /复位极性/u),
  "注释里的 `negedge rst_n` 不触发「复位极性」(审查 H2)"
);
check(
  !hasIssue(nameRuleIssues("    // 这里不要用 always_ff @(posedge clk or negedge rst_n)"), /always_ff/u),
  "注释里的 `always_ff` + `negedge` 不触发「always_ff」(审查 H2 同源)"
);
// 2026-10-22 审查 M4:字符串里可以出现 `//`。
// 先按 `//` 截断会把字符串截断 —— 要么漏掉后面的真实违规，要么把字符串内容当代码。
// 注意两点：nameRuleIssues 把这些行塞进端口列表（`$fwrite` 在那里不合法），
// 且「数据比对」规则**只查测试平台**，所以这里单独写文件并按 testbench 检查。
const m4File = join(SANDBOX, `rtl-m4-${stamp}.sv`);
const m4Issues = (line, isTb = true) => {
  writeFileSync(
    m4File,
    ["`resetall", "`default_nettype none", "module m;", line, "endmodule", "`default_nettype wire", ""].join("\n")
  );
  return checkFile(m4File, isTb).map((issue) => `${issue.rule}|${issue.message}`);
};
check(
  hasIssue(m4Issues('  initial $fwrite(fd, "data//dump"); if (dut_data != exp_data) err_cnt++;'), /数据比对/u),
  "字符串后的真实 `!=` 违规仍被查到(审查 M4 漏检)"
);
check(
  !hasIssue(m4Issues("  initial $fwrite(fd, \"val '0 // ...\");"), /字面量写法/u),
  "字符串内部的 `'0` 不当代码报字面量(审查 M4 误报)"
);
// 第五轮 3.4:模块名只收一段 —— 带路径分隔符的模块名要退 2(以前会拼出 rtl/a/b.sv)
const nameProbeRoot = join(SANDBOX, `name-rule-${stamp}`);
mkdirSync(nameProbeRoot, { recursive: true });
const nameProbe = runStderr("module-rtl-new.mjs", [nameProbeRoot, "a/b", "--template", categorizedTemplates.rtl]); // 提示走 stderr
check(
  nameProbe.code === 2 && /模块名不合法/u.test(nameProbe.output) && !existsSync(join(nameProbeRoot, "rtl", "a")),
  `模块名带 / → 退 2 且不落文件(第五轮 3.4;实际 ${String(nameProbe.code)})`,
  nameProbe.output.slice(-200)
);
// 2026-09-25 真机:Windows 保留设备名**建得出来、工具也读得了,但 Git 索引不了**
// (`git add con.sv` → `unable to index file`,退 128;`git status` 只列 `??`)→ 源码永远进不了版本库,
// 而所有工具链都"看起来正常"。所以必须在**写文件之前**拒掉,大小写不敏感,带扩展名也算。
for (const bad of ["con", "CON", "con.sv", "nul", "aux", "prn", "com1", "lpt9.vhd"]) {
  const root = join(SANDBOX, `reserved-${stamp}-${bad}`);
  mkdirSync(root, { recursive: true });
  const got = runStderr("module-rtl-new.mjs", [root, bad, "--template", categorizedTemplates.rtl]);
  check(
    got.code === 2 && /Windows 保留设备名/u.test(got.output) && !existsSync(join(root, "rtl", `${bad}.sv`)),
    `保留设备名 ${bad} → 退 2、说清原因、**不落文件**(实际 ${String(got.code)})`,
    got.output.slice(-160)
  );
}
// 反过来:这些**不是**保留名,不能误杀(它们只是长得像)。
for (const good of ["console", "connection", "auxiliary", "com10", "lpt10"]) {
  const root = join(SANDBOX, `benign-${stamp}-${good}`);
  mkdirSync(root, { recursive: true });
  const got = runStderr("module-rtl-new.mjs", [root, good, "--template", categorizedTemplates.rtl]);
  check(
    got.code === 0 && existsSync(join(root, "rtl", `${good}.sv`)),
    `${good} 不是 Windows 保留设备名 → 正常起文件(实际 ${String(got.code)})`,
    got.output.slice(-160)
  );
}
// 模块名会被替换进生成的 RTL / Tcl 文本:非 ASCII 或非标识符字符既写不出合法 HDL,
// 也会在 Tcl 按系统编码读脚本时变成乱码(与 spec_part 同一类)。必须挡在落盘之前。
for (const bad of ["中文模块", "uart-rx", "1uart", "uart rx"]) {
  const root = join(SANDBOX, `ident-${stamp}-${bad.replace(/[^A-Za-z0-9]/gu, "_")}`);
  mkdirSync(root, { recursive: true });
  const got = runStderr("module-rtl-new.mjs", [root, bad, "--template", categorizedTemplates.rtl]);
  check(
    got.code === 2 && /合法的 HDL 标识符/u.test(got.output) && !existsSync(join(root, "rtl")),
    `非标识符模块名「${bad}」→ 退 2、说清原因、**不落文件**(实际 ${String(got.code)})`,
    got.output.slice(-160)
  );
}
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
mkdirSync(join(projRoot, "doc"), { recursive: true });
mkdirSync(join(devMod, "spec"), { recursive: true });
writeFileSync(join(projRoot, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
writeFileSync(join(projRoot, "doc", "spec.md"), "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
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
mkdirSync(join(usRoot, "doc"), { recursive: true });
mkdirSync(join(usMod, "spec"), { recursive: true });
writeFileSync(join(usRoot, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
writeFileSync(join(usRoot, "doc", "spec.md"), "# 工程 spec\n\n- 器件型号:xcku040-ffva1156-2-e\n");
writeFileSync(join(usMod, "spec", "spec.md"), "# 模块 spec\n\n- 器件型号:xczu7ev-ffvc1156-2-e\n");
const usBad = runStdout("module-report-check.mjs", [usMod]);
check(
  /器件\(xczu7ev-ffvc1156-2-e\)与工程 spec 器件\(xcku040-ffva1156-2-e\)不一致/u.test(usBad.output),
  "UltraScale 器件(xcku040 / xczu7ev)能读出来并判不一致(N-04)",
  usBad.output.slice(-300)
);

// 场景 H:第四轮复审 Q4-01 / Q4-02 —— 器件以工程 spec 为准;模块 top 不许借工程的
const q4Root = join(SANDBOX, `q4-device-${stamp}`);
const q4Mod = join(q4Root, "uart_rx");
mkdirSync(join(q4Root, "doc"), { recursive: true });
mkdirSync(join(q4Mod, "spec"), { recursive: true });
writeFileSync(join(q4Root, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
const q4ProjectSpec = join(q4Root, "doc", "spec.md");
const q4ModuleSpec = join(q4Mod, "spec", "spec.md");
const q4Script = join(q4Mod, "synth", "run_synth.tcl");
const q4Run = () => runStdout("module-synth-new.mjs", [q4Mod, "uart_rx", "--kind", "synth-script", "--force"]);
writeFileSync(q4ProjectSpec, "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n- 顶层模块名:system_top\n");

// Q4-01a:两份器件**不一致** → 拒绝(退 2),不写脚本,两处来源都点出来
writeFileSync(q4ModuleSpec, "# 模块 spec\n\n- 器件型号:xczu7ev-ffvc1156-2-e\n");
const q4Conflict = runStderr("module-synth-new.mjs", [q4Mod, "uart_rx", "--kind", "synth-script", "--force"]); // 拒绝信息走 stderr
check(
  q4Conflict.code === 2 && /两处器件型号不一致/u.test(q4Conflict.output) &&
    q4Conflict.output.includes("xc7a100tfgg484-2") && q4Conflict.output.includes("xczu7ev-ffvc1156-2-e") &&
    !existsSync(q4Script),
  `两处器件冲突 → 退 2、列两处来源、不落脚本(Q4-01;实际 ${String(q4Conflict.code)})`,
  q4Conflict.output.slice(-300)
);

// Q4-01b:模块不重述器件 → 用工程那份;且 **TOP 必须是模块名**(不是工程 spec 的 system_top,Q4-02)
writeFileSync(q4ModuleSpec, "# 模块 spec\n\n- 器件见工程 spec(不重述)\n");
const q4Project = q4Run();
const q4Text = existsSync(q4Script) ? readFileSync(q4Script, "utf8") : "";
check(
  q4Project.code === 0 && q4Text.includes('set PART "xc7a100tfgg484-2"'),
  `模块不写器件 → 用工程 spec 的器件(Q4-01;实际 ${String(q4Project.code)})`,
  q4Text.split("\n").filter((line) => line.startsWith("set ")).join(" | ")
);
check(
  q4Text.includes('set TOP "uart_rx"') && !q4Text.includes("system_top"),
  "工程 spec 的顶层名**不许**当模块 top 的后备(Q4-02:应为 uart_rx)"
);

// Q4-01c:两份写的是**同一个**器件 → 正常生成(不误报冲突)
writeFileSync(q4ProjectSpec, "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
writeFileSync(q4ModuleSpec, "# 模块 spec\n\n- 器件型号:XC7A100TFGG484-2\n");
const q4Same = q4Run();
check(q4Same.code === 0, `两份器件相同(只看大小写差异)→ 不误报冲突(实际 ${String(q4Same.code)})`, q4Same.output.slice(-200));

// Q4-07:模块内的 junction 指向模块外 → 引用的**真实落点**越界,FAIL 且 --record 不读它
if (makeJunction(q4Mod, "verif") === false && !existsSync(join(q4Mod, "verif"))) {
  console.log("ok    (跳过)本机造不出 junction,Q4-07 的定向用例未跑");
} else {
  writeFileSync(join(junctionOutside, "sample.txt"), "OUTSIDE-SENTINEL\n");
  writeFileSync(join(q4Mod, "verif", "verif.md"), "# 验证报告\n\n结论: PASS\n\n- 外部引用:`verif/linked/sample.txt`\n");
  const q4Escape = runStdout("module-report-check.mjs", [q4Mod]);
  check(
    q4Escape.code === 1 && /真实落点越出模块根/u.test(q4Escape.output) && q4Escape.output.includes("verif/linked/sample.txt"),
    `证据路径真实落点在模块外(junction)→ FAIL 并点名(Q4-07;实际 ${String(q4Escape.code)})`,
    q4Escape.output.slice(-300)
  );
  const q4Record = runStdout("module-report-check.mjs", [q4Mod, "--record"]);
  check(
    !/sha256=[0-9a-f]{64}/u.test(readFileSync(join(q4Mod, "verif", "verif.md"), "utf8")),
    "--record 不读模块外文件、不给它记摘要(Q4-07)"
  );
}
// Q4-11 的判据边界(真实 spec 形状 + 四种残缺写法)—— 直接调纯函数,不起文件
check(
  PART_SHAPE_CASES.every((item) => partLooksComplete(item.part) === item.complete),
  `器件串完整性判据:4 个真实型号算完整、4 种残缺写法(简称/缺封装/缺速度级)不算 ` +
    `(实际 ${PART_SHAPE_CASES.map((item) => `${item.part}=${String(partLooksComplete(item.part))}`).join(", ")})`
);
// 场景 I:第四轮第三批(Q4-10/11/13)
const q43Root = join(SANDBOX, `q43-${stamp}`);
const q43Mod = join(q43Root, "uart_rx");
mkdirSync(join(q43Mod, "spec"), { recursive: true });
mkdirSync(join(q43Mod, "verif"), { recursive: true });
// Q4-11:只有族名简称的器件串**不能**当完整 part 用(会生成 set PART "XC7A100T",Vivado 不认)
writeFileSync(join(q43Mod, "spec", "spec.md"), "# 模块 spec\n\n- 器件型号:XC7A100T\n");
const q43Short = runStderr("module-synth-new.mjs", [q43Mod, "uart_rx", "--kind", "synth-script"]);
check(
  q43Short.code === 2 && /器件串不完整/u.test(q43Short.output) && q43Short.output.includes("XC7A100T"),
  `器件串只有族名简称 → 拒绝生成(Q4-11;实际 ${String(q43Short.code)})`,
  q43Short.output.slice(-250)
);
writeFileSync(join(q43Mod, "spec", "spec.md"), "# 模块 spec\n\n- 器件型号:xc7a100t-2\n");
const q43NoPkg = runStderr("module-synth-new.mjs", [q43Mod, "uart_rx", "--kind", "synth-script"]);
check(q43NoPkg.code === 2, `器件串缺封装(只有器件+速度等级)→ 也拒绝(Q4-11;实际 ${String(q43NoPkg.code)})`);
// Q4-10:报告里有越界引用时 `--record` 必须先拒绝,不许"成功返回"
writeFileSync(join(q43Mod, "spec", "spec.md"), "# 模块 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
writeFileSync(join(q43Mod, "verif", "sim.log"), "cycle 0 ok\n");
writeFileSync(join(q43Mod, "verif", "verif.md"), "# 验证报告\n\n结论: PASS\n\n- 依据:`verif/sim.log`\n- 越界:`verif/../../outside.txt`\n");
const q43Record = runStderr("module-report-check.mjs", [q43Mod, "--record"]);
check(
  q43Record.code === 1 && /拒绝写入/u.test(q43Record.output) &&
    !/sha256=[0-9a-f]{64}/u.test(readFileSync(join(q43Mod, "verif", "verif.md"), "utf8")),
  `--record 遇到越界引用 → 退 1 且不写摘要(Q4-10;实际 ${String(q43Record.code)})`,
  q43Record.output.slice(-250)
);
// Q4-13:真机验证的**对外记录**在仓库里，且覆盖那几件"自检跑不到"的事。
//
// 逐版本的内部台账已移出仓库（含作者环境与协作细节，不适合公开）；
// 对外只保留 `docs/COMPATIBILITY.md` 的「已验证 / 未验证 / 已知限制」。
// 断言仍然有意义：它要求那份文档**必须**写出未验证项，不能只讲好的一面。
const compatPath = join(ROOT, "docs", "COMPATIBILITY.md");
const compatText = existsSync(compatPath) ? readFileSync(compatPath, "utf8") : "";
check(
  // 必须同时有「已验证的工具」与「明确标未验证的工具」—— 只列通过项等于自夸。
  /ModelSim/u.test(compatText) &&
    /Vivado/u.test(compatText) &&
    /未验证|NOT_TESTED/u.test(compatText) &&
    /QuestaSim[\s\S]{0,80}未验证|未验证[\s\S]{0,80}QuestaSim/u.test(compatText),
  "docs/COMPATIBILITY.md 列出已验证工具，并明确标注 QuestaSim 等未验证项(第四轮 Q4-13)"
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
  syncPartial.code === 1 && /正在回滚/u.test(syncPartial.output) && /回滚结果:恢复 \d+ 个/u.test(syncPartial.output) &&
    /已写入 \d+\/\d+ 个文件/u.test(syncPartial.output),
  `sync-installed 半途失败 → 退出码 1、说清已写几个、并回滚(N-10;实际 ${String(syncPartial.code)})`,
  syncPartial.output.slice(-400)
);
// 回滚是"恢复旧的 + 把这次新加的**改名**移开"(零删除):沙箱里 cordis.patch.yml 是这次新加的,
// 失败后它应当以 `.failed-<时间戳>` 的名字留在原地 —— 而不是消失。
const syncFilesNow = readdirSync(syncInstalled);
check(
  syncFilesNow.some((name) => /^cordis\.patch\.yml\.failed-/u.test(name)) && !syncFilesNow.includes("cordis.patch.yml"),
  `回滚把"这次新加的文件"改名移开(未删除):实际 ${syncFilesNow.join("、")}`
);

// 第五轮 2.6:反斜杠写法的引用也要抽出来核(以前只认正斜杠 → 整条漏检)
writeFileSync(join(scopeRoot, "verif", "bs.log"), "cycle 0 ok\n");
writeFileSync(join(scopeRoot, "verif", "verif.md"), ["# 验证报告", "", "结论: PASS", "", "- 反斜杠引用:`verif\\bs.log`", ""].join("\n"));
const backslashOk = runStdout("module-report-check.mjs", [scopeRoot]);
check(
  backslashOk.code === 0 && /1 条证据路径/u.test(backslashOk.output),
  "报告里用反斜杠写引用(`verif\\bs.log`)也能抽出来核(第五轮 2.6)",
  backslashOk.output.slice(-200)
);
writeFileSync(join(scopeRoot, "verif", "verif.md"), ["# 验证报告", "", "结论: PASS", "", "- 反斜杠引用:`verif\\gone.log`", ""].join("\n"));
const backslashBad = runStdout("module-report-check.mjs", [scopeRoot]);
check(
  backslashBad.code === 1 && /verif\/gone\.log/u.test(backslashBad.output),
  "反斜杠引用指向不存在的文件 → FAIL 并点名(统一成 / 展示)",
  backslashBad.output.slice(-200)
);
// 第五轮 3.7:报告里误留两段摘要块 → `--record` 之后只应剩一段
writeFileSync(join(scopeRoot, "verif", "bs.log"), "cycle 0 ok\n");
writeFileSync(
  join(scopeRoot, "verif", "verif.md"),
  [
    "# 验证报告", "", "结论: PASS", "", "- 依据:`verif/bs.log`", "",
    "<!-- evidence-digest:start -->", "旧段: verif/bs.log  sha256=" + "0".repeat(64), "<!-- evidence-digest:end -->", "",
    "<!-- evidence-digest:start -->", "又一段: verif/bs.log  sha256=" + "1".repeat(64), "<!-- evidence-digest:end -->", ""
  ].join("\n")
);
runStdout("module-report-check.mjs", [scopeRoot, "--record", "--accept-changed"]);
const digestBlocks = (readFileSync(join(scopeRoot, "verif", "verif.md"), "utf8").match(/evidence-digest:start/gu) ?? []).length;
check(digestBlocks === 1, `两段摘要块 → --record 之后只剩一段(第五轮 3.7;实际 ${String(digestBlocks)} 段)`);

// ── F5-01:摘要正则不得因共享 lastIndex 交替漏读 ───────────────────────────────
{
  const sample =
    "# 报告\n\n结论: PASS\n\n" +
    "<!-- evidence-digest:start -->\n" +
    "verif/a.txt  sha256=" + "a".repeat(64) + "\n" +
    "verif/b.txt  sha256=" + "b".repeat(64) + "\n" +
    "<!-- evidence-digest:end -->\n";
  const first = recordedDigests(sample);
  const second = recordedDigests(sample);
  const third = recordedDigests(sample);
  check(
    first.size === 2 && second.size === 2 && third.size === 2 &&
      first.get("verif/a.txt") === second.get("verif/a.txt") &&
      second.get("verif/b.txt") === third.get("verif/b.txt"),
    "recordedDigests 连续调用结果稳定(不再 true/false 交替漏读)"
  );
  check(hasDigestBlock(sample) && hasDigestBlock(sample) && hasDigestBlock(sample), "hasDigestBlock 连续调用稳定");
  const once = withDigests("# x\n", [["p", "e".repeat(64)]]);
  const twice = withDigests(once, [["p", "e".repeat(64)]]);
  check(once === twice, "withDigests 对同一 entries 幂等");
  const rewritten = withDigests(sample, [["verif/a.txt", "c".repeat(64)]]);
  check(
    recordedDigests(rewritten).get("verif/a.txt") === "c".repeat(64) &&
      !recordedDigests(rewritten).has("verif/b.txt"),
    "withDigests 替换摘要块内容(旧条目不再残留)"
  );
  const multi =
    "# r\n" +
    "<!-- evidence-digest:start -->\na  sha256=" + "1".repeat(64) + "\n<!-- evidence-digest:end -->\n" +
    "<!-- evidence-digest:start -->\nb  sha256=" + "2".repeat(64) + "\n<!-- evidence-digest:end -->\n";
  const merged = recordedDigests(multi);
  check(merged.size === 2 && merged.get("a") === "1".repeat(64) && merged.get("b") === "2".repeat(64), "多段摘要块全部读入(不只第一块)");
  const collapsed = withDigests(multi, [["a", "1".repeat(64)], ["b", "2".repeat(64)]]);
  check((collapsed.match(/evidence-digest:start/gu) ?? []).length === 1, "withDigests 把多段收成一段");
}

// F5-01 负向:两份依据都变了时 --record 必须两条都拦住,且不写回
{
  const f5Root = join(SANDBOX, `f5-digest-${stamp}`);
  mkdirSync(join(f5Root, "verif"), { recursive: true });
  mkdirSync(join(f5Root, "spec"), { recursive: true });
  writeFileSync(join(f5Root, "spec", "spec.md"), "# spec\n");
  writeFileSync(join(f5Root, "verif", "a.txt"), "A0\n");
  writeFileSync(join(f5Root, "verif", "b.txt"), "B0\n");
  writeFileSync(join(f5Root, "verif", "verif.md"), "# 验证报告\n\n结论: PASS\n\n- 依据 a:`verif/a.txt`\n- 依据 b:`verif/b.txt`\n");
  const rec0 = runStdout("module-report-check.mjs", [f5Root, "--record"]);
  check(rec0.code === 0, `先记两份摘要(退出码 ${String(rec0.code)})`, rec0.output.slice(-200));
  writeFileSync(join(f5Root, "verif", "a.txt"), "A1\n");
  writeFileSync(join(f5Root, "verif", "b.txt"), "B1\n");
  const bothChanged = runStdout("module-report-check.mjs", [f5Root]);
  check(
    bothChanged.code === 0 &&
      bothChanged.output.includes("verif/a.txt") &&
      bothChanged.output.includes("verif/b.txt") &&
      /摘要变了/.test(bothChanged.output),
    "两份依据都变时两份都要报出来(不许只报一半)",
    bothChanged.output.slice(-300)
  );
  const before = readFileSync(join(f5Root, "verif", "verif.md"), "utf8");
  const blocked = runStderr("module-report-check.mjs", [f5Root, "--record"]);
  const after = readFileSync(join(f5Root, "verif", "verif.md"), "utf8");
  check(
    blocked.code === 1 && before === after && blocked.output.includes("verif/a.txt") && blocked.output.includes("verif/b.txt"),
    `--record 任一依据已变 → 拒绝写入且两条都点名(退出码 ${String(blocked.code)})`,
    blocked.output.slice(-300)
  );
}

// 两处**实测误报**(2026-09-23,用户真实模块 eth_crc32 被抓红的那种):
//   ① 报告里引用**目录**(`verif/`、`rtl/`)是合法的 —— 在根内就够,不该判"越界";
//   ② `synth/vivado_proj/` 这类"跑出来就有"的可再生物缺失,只该 info,不该 FAIL。
mkdirSync(join(scopeRoot, "synth"), { recursive: true }); // synth/ 在,vivado_proj/ 故意不建(可再生物缺失)
mkdirSync(join(scopeRoot, "rtl"), { recursive: true });
writeFileSync(join(scopeRoot, "rtl", "x.sv"), "module x; endmodule\n");
writeFileSync(join(scopeRoot, "verif", "verif.md"), ["# 验证报告", "", "结论: PASS", "", "- 目录引用:`verif/`、`rtl/`", "- 可再生:`synth/vivado_proj/`", ""].join("\n"));
const dirRef = runStdout("module-report-check.mjs", [scopeRoot]);
check(
  !/真实落点越出模块根/u.test(dirRef.output),
  "报告引用**目录**(`verif/` / `rtl/`)不再被判成「越界」(实测误报;实际输出见下)",
  dirRef.output.slice(-300)
);
check(
  !/FAIL[^\n]*vivado_proj/u.test(dirRef.output) && /vivado_proj[^\n]*(可再生|现在不在)/u.test(dirRef.output),
  "`synth/vivado_proj/` 这种可再生物缺失只报 info、不判 FAIL(与 .gitignore 的可再生口径一致)"
);
// ── F-03:check-patch-file.mjs 不许写死仓库绝对路径 ───────────────────────────
//
// 写死绝对路径(如 `C:/<克隆位置>/cordis.patch.yml`)的后果是"克隆到别处就断"。改成按
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

// 收口两条 P2(2026-09-23 整理):
//   ① 向上找工程锚点要有层数上限 —— 否则远处一个无关工程的锚点会被继承,器件就取错了;
//   ② `module-verif-new` 的 tb 也要能用内置模板(它的用法说明本来就写着"不给 --template 就用内置",
//      但以前只有 --kind 那三种会默认,tb 要求显式给 —— 说的和做的两套)。
const p2Root = join(SANDBOX, `p2-${stamp}`);
const p2Deep = join(p2Root, "a", "b", "c", "d", "e", "uart_rx");
const p2Near = join(p2Root, "a", "uart_rx");
mkdirSync(join(p2Root, "doc"), { recursive: true });
for (const mod of [p2Deep, p2Near]) {
  mkdirSync(join(mod, "spec"), { recursive: true });
  writeFileSync(join(mod, "spec", "spec.md"), "# 模块 spec\n\n- 器件见工程 spec(不重述)\n");
}
writeFileSync(join(p2Root, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
writeFileSync(join(p2Root, "doc", "spec.md"), "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
const p2DeepRun = runStderr("module-synth-new.mjs", [p2Deep, "uart_rx", "--kind", "synth-script"]);
check(
  p2DeepRun.code === 2,
  `工程锚点在 6 层之上 → **不继承**(层数上限;期望退 2,实际 ${String(p2DeepRun.code)})`,
  p2DeepRun.output.slice(-200)
);
const p2NearRun = runStdout("module-synth-new.mjs", [p2Near, "uart_rx", "--kind", "synth-script"]);
check(
  p2NearRun.code === 0 && /器件 xc7a100tfgg484-2 取自工程 spec/u.test(p2NearRun.output),
  `正常布局(1 层)照旧继承工程器件(实际 ${String(p2NearRun.code)})`,
  p2NearRun.output.slice(-200)
);
const p2TbRoot = join(SANDBOX, `p2-tb-${stamp}`);
mkdirSync(join(p2TbRoot, "spec"), { recursive: true });
writeFileSync(join(p2TbRoot, "spec", "spec.md"), "# 模块 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
const p2Tb = runStdout("module-verif-new.mjs", [p2TbRoot, "UartRx"]);
check(
  p2Tb.code === 0 && existsSync(join(p2TbRoot, "verif", "tb_uart_rx.sv")),
  `module-verif-new 不给 --template 也能起 tb(用内置模板;实际 ${String(p2Tb.code)})`,
  p2Tb.output.slice(-200)
);

// 第八轮复审(同批)三条:仿真门的精确匹配、两处递归不收链接目录、混合 VHDL 不能算全覆盖 PASS。
check(
  /if \{\$raw eq "ALL TESTS PASSED \(err_cnt=0\)"/u.test(bundledRunOnly) &&
    !/string match "\*ALL TESTS PASSED\*"/u.test(bundledRunOnly),
  "run.do 的成功判定是**精确整行**(不是子串匹配 —— 否则\"no ALL TESTS PASSED\"这种否定句会假 PASS)"
);
const compileTemplateText = readFileSync(join(TEMPLATES, "simulation", "run", "modelsim_run.do"), "utf8");
check(
  /file type \$sub\] eq "link"/u.test(compileTemplateText),
  "合并模板递归收集时**跳过链接目录**(不收工程外 HDL;跳过即断环)"
);
check(
  /file type \$d\] eq "link"/u.test(bundledRunSynth),
  "模块综合模板(vivado_module_synthesis.tcl)的 collect_files 同样跳过链接目录(与仿真模板同一条判据)"
);
const mixRoot = join(SANDBOX, `mixvhdl-${stamp}`);
mkdirSync(join(mixRoot, "src", "rtl"), { recursive: true });
mkdirSync(join(mixRoot, "doc"), { recursive: true });
writeFileSync(join(mixRoot, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
writeFileSync(join(mixRoot, "doc", "spec.md"), "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
writeFileSync(join(mixRoot, "src", "rtl", "good.sv"), readFileSync(categorizedTemplates.rtl, "utf8"));
writeFileSync(join(mixRoot, "src", "rtl", "legacy.vhd"), "-- VHDL\nentity legacy is end entity;\n");
const mixRun = runStdout("project-rtl-check.mjs", [mixRoot]);
check(
  mixRun.code === 2 && /PARTIAL/u.test(mixRun.output) && /1 个 VHDL/u.test(mixRun.output),
  `混合 SV+VHDL 输出 PARTIAL 且退 2(不是静默 PASS;实际 ${String(mixRun.code)})`,
  mixRun.output.slice(-300)
);
// DSH-N06:同一句 `exp_cnt != i` 必须**两边一致** —— 工程侧以前用裸 EXPECTED_SIGNAL(与自己注释矛盾),
// 模块只给警告、工程却判 FAIL;现在规则共用一份,这条断言把工程侧也钉住。
const neqProjectRoot = join(SANDBOX, `neq-project-${stamp}`);
mkdirSync(join(neqProjectRoot, "src", "rtl"), { recursive: true });
mkdirSync(join(neqProjectRoot, "src", "sim"), { recursive: true });
mkdirSync(join(neqProjectRoot, "doc"), { recursive: true });
writeFileSync(join(neqProjectRoot, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
writeFileSync(join(neqProjectRoot, "doc", "spec.md"), "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
writeFileSync(join(neqProjectRoot, "src", "rtl", "gut.sv"), readFileSync(categorizedTemplates.rtl, "utf8"));
const neqTbHeader = readFileSync(categorizedTemplates.rtl, "utf8").split("\n").slice(0, 14).join("\n");
writeFileSync(
  join(neqProjectRoot, "src", "sim", "tb_dut.sv"),
  `${neqTbHeader}\n\n\`resetall\n\`default_nettype none\n\nmodule tb_dut;\n  logic [7:0] exp_cnt;\n  logic [7:0] i;\n  initial begin\n    if (exp_cnt != i) $display("x");\n  end\nendmodule\n\n\`default_nettype wire\n`
);
const neqProjectRun = runStdout("project-rtl-check.mjs", [neqProjectRoot]);
check(
  neqProjectRun.output.includes("这一行有 '!='") && !neqProjectRun.output.includes("数据比对用了"),
  "工程侧:期望命名的计数/索引比常量只给警告,不判数据比对 FAIL(与模块侧同一条规则)",
  neqProjectRun.output.slice(-300)
);

const mixJson = JSON.parse(runStdout("project-rtl-check.mjs", [mixRoot, "--json"]).output);
check(
  mixJson.coverage === "partial" && mixJson.skippedFiles.length === 1 && mixJson.checkedFiles.length === 1,
  `JSON 里 coverage/skippedFiles 可机器区分(实际 coverage=${String(mixJson.coverage)})`
);

// 第九轮复审②:模块级也要同一套 —— 以前只统计 verif/ 下的 VHDL,`rtl/good.sv + rtl/broken.vhd` 还能 PASS。
const mixModuleRoot = join(SANDBOX, `mixvhdl-module-${stamp}`);
mkdirSync(join(mixModuleRoot, "rtl"), { recursive: true });
mkdirSync(join(mixModuleRoot, "verif"), { recursive: true });
writeFileSync(join(mixModuleRoot, "rtl", "good.sv"), readFileSync(categorizedTemplates.rtl, "utf8"));
writeFileSync(join(mixModuleRoot, "rtl", "broken.vhd"), "-- VHDL\nentity broken is end entity;\n");
const mixModuleRun = runStdout("module-rtl-check.mjs", [mixModuleRoot]);
check(
  mixModuleRun.code === 2 && /PARTIAL/u.test(mixModuleRun.output) && /1 个 VHDL/u.test(mixModuleRun.output),
  `模块级混合 SV+VHDL 同样输出 PARTIAL 且退 2(rtl/ 下的 VHDL 也要数;实际 ${String(mixModuleRun.code)})`,
  mixModuleRun.output.slice(-300)
);
const mixModuleJson = JSON.parse(runStdout("module-rtl-check.mjs", [mixModuleRoot, "--json"]).output);
check(
  mixModuleJson.coverage === "partial" && mixModuleJson.skippedFiles.length === 1 && mixModuleJson.checkedFiles.length === 1,
  `模块级 --json 是干净可 parse 的 JSON,且 coverage/skippedFiles 可机器区分(实际 coverage=${String(mixModuleJson.coverage)})`
);

// 第八轮 E8-08:`--gate` 下"没有可核的东西"要退 2(默认退 0,保持向后兼容)。
const gateRoot = join(SANDBOX, `gate-${stamp}`);
mkdirSync(join(gateRoot, "rtl"), { recursive: true });
writeFileSync(join(gateRoot, "rtl", "good.sv"), readFileSync(categorizedTemplates.rtl, "utf8"));
const gateDefault = runStdout("module-report-check.mjs", [gateRoot]);
const gateStrict = runStdout("module-report-check.mjs", [gateRoot, "--gate"]);
check(
  gateDefault.code === 0 && gateStrict.code === 2 && /NO_REPORTS|NO_EVIDENCE/u.test(gateStrict.output),
  `NO_REPORTS 默认退 0、--gate 退 2(实际 ${String(gateDefault.code)} / ${String(gateStrict.code)})`,
  gateStrict.output.slice(-200)
);

// 第八轮 E8-05:sim/ 下的仿真辅助代码(package/interface/BFM/记分板)不套 RTL 结构门禁,
// 但通用规则(文件头 / 编译隔离)照查;tb_* 仍走 TB gate。
const simRoleRoot = join(SANDBOX, `simrole-${stamp}`);
mkdirSync(join(simRoleRoot, "src", "rtl"), { recursive: true });
mkdirSync(join(simRoleRoot, "sim"), { recursive: true });
mkdirSync(join(simRoleRoot, "doc"), { recursive: true });
writeFileSync(join(simRoleRoot, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
writeFileSync(join(simRoleRoot, "doc", "spec.md"), "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
writeFileSync(join(simRoleRoot, "src", "rtl", "good.sv"), readFileSync(categorizedTemplates.rtl, "utf8"));
const rtlTemplateHeader = readFileSync(categorizedTemplates.rtl, "utf8").split("\n").slice(0, 14).join("\n");
writeFileSync(
  join(simRoleRoot, "sim", "scoreboard.sv"),
  `${rtlTemplateHeader}\n\n\`resetall\n\`default_nettype none\n\nmodule scoreboard; endmodule\n\n\`default_nettype wire\n`
);
// 复审 Batch B 要的正向夹具:仿真辅助代码可以带 always_ff 与**自定义复位**,不该因此阻塞;
// 负向夹具:缺文件头 / 缺编译隔离,仍然必须被报出来(白名单里保留了这几条通用规则)。
writeFileSync(
  join(simRoleRoot, "sim", "scoreboard_ff.sv"),
  `${rtlTemplateHeader}

\`resetall
\`default_nettype none

module scoreboard_ff (input logic clk, input logic rst_async, output logic done);
  logic r;
  always_ff @(posedge clk or posedge rst_async) begin
    if (rst_async) r <= 1'b0;
    else r <= ~r;
  end
  assign done = r;
endmodule

\`default_nettype wire
`
);
const simRoleRun = runStdout("project-rtl-check.mjs", [simRoleRoot]);
check(
  simRoleRun.code === 0 && !/设计断言/u.test(simRoleRun.output),
  `sim/ 下的仿真辅助代码不套 RTL 结构门禁(实际退出码 ${String(simRoleRun.code)})`,
  simRoleRun.output.slice(-300)
);
check(
  !/scoreboard_ff\.sv\s+\(\d+ 项阻塞/u.test(simRoleRun.output),
  "仿真辅助代码带 always_ff / 自定义复位也不阻塞(白名单只留通用规则)",
  simRoleRun.output.slice(-300)
);
const simSupportNegRoot = join(SANDBOX, `simsupport-neg-${stamp}`);
mkdirSync(join(simSupportNegRoot, "src", "rtl"), { recursive: true });
mkdirSync(join(simSupportNegRoot, "sim"), { recursive: true });
mkdirSync(join(simSupportNegRoot, "doc"), { recursive: true });
writeFileSync(join(simSupportNegRoot, ".fpga-workbench.json"), '{"kind":"project","spec":"doc/spec.md"}\n');
writeFileSync(join(simSupportNegRoot, "doc", "spec.md"), "# 工程 spec\n\n- 器件型号:xc7a100tfgg484-2\n");
writeFileSync(join(simSupportNegRoot, "src", "rtl", "good.sv"), readFileSync(categorizedTemplates.rtl, "utf8"));
writeFileSync(join(simSupportNegRoot, "sim", "bad_helper.sv"), "module bad_helper; endmodule\n");
const simSupportNeg = runStdout("project-rtl-check.mjs", [simSupportNegRoot]);
check(
  // 负向：白名单保留了编译隔离那几条 —— 输出里报的是 `resetall` / `default_nettype` 的字样
  // （「文件头」那条已移除，不再作为判据）。
  simSupportNeg.code === 1 && /`resetall|`default_nettype/u.test(simSupportNeg.output),
  "sim-support 仍要查通用规则(缺 resetall / default_nettype)→ 退 1(实际 " + String(simSupportNeg.code) + ")",
  simSupportNeg.output.slice(-300)
);
const simRoleJson = JSON.parse(runStdout("project-rtl-check.mjs", [simRoleRoot, "--json"]).output);
check(
  simRoleJson.files.some((entry) => entry.role === "sim-support" && entry.file.includes("scoreboard")),
  `JSON 里标出 sim-support 角色(实际 ${JSON.stringify(simRoleJson.files.map((entry) => `${entry.file}:${String(entry.role)}`))})`
);

// 第八轮 E8-07 / E8-09 / E8-11:两份仿真模板的代码形状(真机行为另有实测证据,见提交说明)。
check(
  /\.fpga-compile-stamp/u.test(compileTemplateText) && /file mtime \$f\]/u.test(compileTemplateText),
  "编译成功后写 work/.fpga-compile-stamp(记录每个输入的 mtime + size)"
);
check(
  /no compile stamp in work\//u.test(bundledRunOnly) && /changed after compile/u.test(bundledRunOnly),
  "run 模式校验该标记,源码改过就拒绝运行(E8-07)"
);
check(
  /INI_EXPLICIT/u.test(compileTemplateText) && /modelsim\.ini not found/u.test(compileTemplateText),
  "编译段:显式指定的 modelsim.ini 不存在就报错,不静默退回安装默认(E8-09)"
);
check(
  /set VENDOR_LIBS/u.test(bundledRunOnly) && /-L \$lib/u.test(bundledRunOnly),
  "run.do:VENDOR_LIBS 旋钮逐个变成 vsim -L(E8-11)"
);

// 第九轮收口复审:compile → run 的一致性(改源码 / 删源码 / **新增源码** / 显式 ini 错)必须有
// **行为**测试,不能只断言源码里有那几行字符串。模型仿真器在就真跑,不在就明确 SKIP + NOT_TESTED。
const vsimPath = [
  process.env.MODELSIM,
  "C:\\modeltech64_2020.4\\win64\\vsim.exe",
  "C:\\modeltech64_2020.4\\win32\\vsim.exe"
].find((candidate) => typeof candidate === "string" && candidate !== "" && existsSync(candidate));
if (vsimPath === undefined) {
  console.log("  SKIP 仿真一致性行为矩阵:本机没找到 vsim.exe(环境变量 MODELSIM 或标准安装路径)—— 记 NOT_TESTED,不记 PASS");
} else {
  const simRoot = join(SANDBOX, `simmatrix-${stamp}`);
  mkdirSync(join(simRoot, "rtl"), { recursive: true });
  mkdirSync(join(simRoot, "verif"), { recursive: true });
  writeFileSync(join(simRoot, "rtl", "dut.sv"), "module dut (input logic clk, output logic q); assign q = clk; endmodule\n");
  // 第九轮收口复审 Batch C 的行为用例:`logic` 是 Verilog-2001 里合法的**标识符**,但在 SystemVerilog
  // 里是关键字 —— 若 `.v` 被强制 `-sv` 编译,基线编译就会报错。带上它,基线编译退 0 就证明分流出对了。
  writeFileSync(join(simRoot, "rtl", "legacy_v.v"), "module legacy_v; wire logic; assign logic = 1'b0; endmodule\n");
  writeFileSync(join(simRoot, "verif", "tb_dut.sv"), "`timescale 1ns/1ps\nmodule tb_dut;\n  logic clk = 0;\n  initial begin #1; $display(\"ALL TESTS PASSED (err_cnt=0)\"); $finish; end\nendmodule\n");
  copyFileSync(categorizedTemplates.compile, join(simRoot, "verif", "run.do"));
  copyFileSync(categorizedTemplates.run, join(simRoot, "verif", "run.do"));
  const runDo = (statement, env = {}) => spawnSync(vsimPath, ["-c", "-do", `${statement}; quit -f`], {
    cwd: join(simRoot, "verif"), env: { ...process.env, ...env }, encoding: "utf8"
  });
  const compiled = runDo("do run.do compile");
  check(compiled.status === 0, `仿真一致性夹具:基线编译退 0(实际 ${String(compiled.status)})`, String(compiled.stdout ?? "").slice(-300));
  const cleanRun = runDo("do run.do run");
  check(cleanRun.status === 0, `无源码变化 → run 退 0(实际 ${String(cleanRun.status)})`, String(cleanRun.stdout ?? "").slice(-300));
  writeFileSync(join(simRoot, "rtl", "dut.sv"), "module dut (input logic clk, output logic q); assign q = ~clk; endmodule\n// touched\n");
  const modifiedRun = runDo("do run.do run");
  check(modifiedRun.status !== 0 && /changed after compile|does not match/u.test(String(modifiedRun.stdout ?? "")), `改源码 → run 拒绝(实际 ${String(modifiedRun.status)})`, String(modifiedRun.stdout ?? "").slice(-300));
  runDo("do run.do compile");
  writeFileSync(join(simRoot, "rtl", "extra.sv"), "module extra; endmodule\n");
  const addedRun = runDo("do run.do run");
  check(addedRun.status !== 0 && /\(added\)/u.test(String(addedRun.stdout ?? "")), `**新增源码** → run 拒绝并点名(实际 ${String(addedRun.status)})`, String(addedRun.stdout ?? "").slice(-300));
  runDo("do run.do compile");
  const badIniRun = runDo("do run.do run", { MODELSIM_INI: "C:\\nope\\missing.ini" });
  check(badIniRun.status !== 0 && /modelsim.ini not found/u.test(String(badIniRun.stdout ?? "")), `run 侧显式 ini 不存在 → 拒绝 fallback(实际 ${String(badIniRun.status)})`, String(badIniRun.stdout ?? "").slice(-300));
}

// ── 上板通过率三项：X 初态 / 引脚比对 / 各自的边界 ──────────────────────────
// 2026-10-29：这两个命令盯的是「仿真看不到、上板才发现」的形态。
// 它们的判定出错比没有更糟（会让人以为查过了），所以每类结论都要实跑验证。
{
  const moduleTool = (name) => join(ROOT, "presets", "fpga-workbench", "tools", "module", name);
  const projectTool = (name) => join(ROOT, "presets", "fpga-workbench", "tools", "project", name);

  /** 造一个临时目录并写入若干文件。 */
  const scratch = (label, files) => {
    const dir = join(SANDBOX, `board-gate-${label}`);
    for (const [rel, text] of Object.entries(files)) {
      const file = join(dir, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return dir;
  };

  /** 用 stdio 重定向跑一个命令（沙箱里不能开管道）。 */
  const runTool = (script, args, cwd) => {
    const logPath = join(cwd, `out-${String(Date.now())}-${String(Math.random()).slice(2, 7)}.log`);
    const fd = openSync(logPath, "w");
    const status = spawnSync(process.execPath, [script, ...args], { cwd, stdio: ["ignore", fd, "ignore"] }).status;
    closeSync(fd);
    return { status, output: existsSync(logPath) ? readFileSync(logPath, "utf8") : "" };
  };

  // ① X 初态：干净 TB 通过，带初值被拦
  console.log("\n=== X 初态检查（module-verif-xinit.mjs）===");
  {
    const clean = scratch("xinit-clean", {
      "verif/tb_dut.sv": "module tb_dut;\n  logic clk;\n  logic rst_n;\n  logic [7:0] data;\n  initial begin forever #5 clk = ~clk; end\nendmodule\n"
    });
    const result = runTool(moduleTool("module-verif-xinit.mjs"), [clean], clean);
    check(result.status === 0, `无初值的 TB → 退 0(实际 ${String(result.status)})`, result.output.slice(-200));

    const dirty = scratch("xinit-dirty", {
      "verif/tb_dut.sv": "module tb_dut;\n  logic clk = 0;\n  logic rst_n = 0;\n  logic [7:0] data = '0;\nendmodule\n"
    });
    const blocked = runTool(moduleTool("module-verif-xinit.mjs"), [dirty], dirty);
    check(blocked.status === 1, `有寄存器初值 → 退 1(实际 ${String(blocked.status)})`, blocked.output.slice(-200));
    check(/rst_n/u.test(blocked.output) && /去掉声明处初值/u.test(blocked.output), "点名信号并给出改法");

    // 显式 'x / 'z 与时钟类都不该被拦成阻塞
    const exempt = scratch("xinit-exempt", {
      "verif/tb_dut.sv": "module tb_dut;\n  logic clk = 0;\n  logic rst_n = 'x;\nendmodule\n"
    });
    const exemptResult = runTool(moduleTool("module-verif-xinit.mjs"), [exempt], exempt);
    check(exemptResult.status === 3, `只有时钟类初值 → 退 3(实际 ${String(exemptResult.status)})`, exemptResult.output.slice(-200));

    // **h 进制的全 X/Z 也是显式未知**（第21轮审查发现的漏判，2026-10-29 修）
    //
    // 原来只认 `[01]*` 的二进制形态，`16'hxxxx` / `8'hXX` / `4'hz` 这类合法写法被当成
    // 「有初值」—— 用户按规范做的 X 化反而让检查器看不见（假阴性）。
    // 修的时候踩过两个坑，这里一起钉住：
    //   ① 字符类必须含 x/z（它们不是十六进制数字）
    //   ② 不能先把 `'` 剥掉（那是进制分隔符）
    const radixExempt = scratch("xinit-radix-x", {
      "verif/tb_dut.sv": [
        "module tb_dut;",
        "  logic [15:0] a = 16'hxxxx;",
        "  logic [7:0]  b = 8'hXX;",
        "  logic [3:0]  c = 4'hz;",
        "  logic [11:0] e = 12'hx;",
        "endmodule",
        ""
      ].join("\n")
    });
    const radixResult = runTool(moduleTool("module-verif-xinit.mjs"), [radixExempt], radixExempt);
    check(
      radixResult.status === 0,
      `h 进制的全 X/Z 认作显式未知 → 退 0(实际 ${String(radixResult.status)})`,
      radixResult.output.slice(-300)
    );

    // 反向：半已知的（4'b10xz）不是纯 X 化，仍算「有初值」
    const halfKnown = scratch("xinit-half-known", {
      "verif/tb_dut.sv": "module tb_dut;\n  logic [3:0] q = 4'b10xz;\nendmodule\n"
    });
    const halfResult = runTool(moduleTool("module-verif-xinit.mjs"), [halfKnown], halfKnown);
    check(
      halfResult.status === 1,
      `半已知的 4'b10xz 不算纯 X 化 → 退 1(实际 ${String(halfResult.status)})`,
      halfResult.output.slice(-200)
    );

    // 存储器未 X 化 —— 这是 X 的第一大来源，仿真器的全局初值选项覆盖不到
    const memOpen = scratch("xinit-mem-open", {
      "rtl/dut.sv": "module dut(input logic clk, input logic [7:0] din, output logic [7:0] dout);\n  logic [7:0] buf [0:1023];\n  assign dout = buf[din];\nendmodule\n",
      "verif/tb_dut.sv": "module tb_dut;\n  logic clk;\nendmodule\n"
    });
    const memOpenResult = runTool(moduleTool("module-verif-xinit.mjs"), [memOpen], memOpen);
    check(memOpenResult.status === 1, `存储器未 X 化 → 退 1(实际 ${String(memOpenResult.status)})`, memOpenResult.output.slice(-300));
    check(/SIM_INIT_X/u.test(memOpenResult.output), "给出 ifdef 改法");
    check(/读写指针也要一起/u.test(memOpenResult.output), "提醒 FIFO 指针要一起 X 化");

    // 有 SIM_INIT_X 守卫就该通过 —— 断言"有守卫"这个判据真的生效
    const memGuarded = scratch("xinit-mem-guarded", {
      "rtl/dut.sv": [
        "module dut(input logic clk, output logic [7:0] dout);",
        "  logic [7:0] buf [0:1023];",
        "`ifdef SIM_INIT_X",
        "  integer xi;",
        "  initial for (xi = 0; xi < 1024; xi = xi + 1) buf[xi] = 8'hxx;",
        "`endif",
        "  assign dout = buf[0];",
        "endmodule"
      ].join("\n"),
      "verif/tb_dut.sv": "module tb_dut;\n  logic clk;\nendmodule\n"
    });
    const memGuardedResult = runTool(moduleTool("module-verif-xinit.mjs"), [memGuarded], memGuarded);
    check(memGuardedResult.status === 0, `有 SIM_INIT_X 守卫 → 退 0(实际 ${String(memGuardedResult.status)})`, memGuardedResult.output.slice(-250));

    // $readmemh 初始化的存储器必须豁免 —— 否则对 .coe 化的 BRAM 全是假阳性
    const memReadmem = scratch("xinit-mem-readmem", {
      "rtl/dut.sv": [
        "module dut(output logic [7:0] dout);",
        "  logic [7:0] rom_data [0:255];",
        "  initial $readmemh(\"init.hex\", rom_data);",
        "  assign dout = rom_data[0];",
        "endmodule"
      ].join("\n"),
      "verif/tb_dut.sv": "module tb_dut;\nendmodule\n"
    });
    const memReadmemResult = runTool(moduleTool("module-verif-xinit.mjs"), [memReadmem], memReadmem);
    check(memReadmemResult.status === 3, `$readmemh 初始化的存储器 → 豁免退 3(实际 ${String(memReadmemResult.status)})`, memReadmemResult.output.slice(-250));
    check(/初始化文件/u.test(memReadmemResult.output), "豁免原因写清楚了（不是静默跳过）");
  }

  // ② 引脚比对：一致通过、电平不一致阻塞、漏约束阻塞
  console.log("\n=== 引脚/IO 机器比对（project-pin-audit.mjs）===");
  {
    const pinCsv = "pin,port,iostandard\nAB12,led[0],LVCMOS33\n";
    const makeProj = (label, xdc) => {
      const dir = scratch(label, { "xdc/pins.xdc": xdc, "board/pins.csv": pinCsv });
      return dir;
    };

    const same = makeProj("pin-same", "set_property PACKAGE_PIN AB12 [get_ports {led[0]}]\nset_property IOSTANDARD LVCMOS33 [get_ports {led[0]}]\n");
    const okResult = runTool(projectTool("project-pin-audit.mjs"), [same, "--expect", join(same, "board", "pins.csv")], same);
    // **N-09**：引脚层一致不再等于整体 PASS —— Bank/VCCO 没查，整体最高 PARTIAL。
    // 所以「完全一致」的退出码是 3（引脚层通过、整体未完整），不是 0。
    check(okResult.status === 3, `引脚层一致但整体 PARTIAL → 退 3(实际 ${String(okResult.status)})`, okResult.output.slice(-250));
    check(/整体 PARTIAL/u.test(okResult.output), "明确写出「整体 PARTIAL」而不是 PASS", okResult.output.slice(-250));
    check(/Bank\/VCCO/u.test(okResult.output), "说明 Bank/VCCO 未检查", okResult.output.slice(-250));

    const ioBad = makeProj("pin-io", "set_property PACKAGE_PIN AB12 [get_ports {led[0]}]\nset_property IOSTANDARD LVCMOS18 [get_ports {led[0]}]\n");
    const ioResult = runTool(projectTool("project-pin-audit.mjs"), [ioBad, "--expect", join(ioBad, "board", "pins.csv")], ioBad);
    check(ioResult.status === 1, `电平标准不一致 → 退 1(实际 ${String(ioResult.status)})`, ioResult.output.slice(-250));
    check(/电平标准不一致/u.test(ioResult.output) && /损伤/u.test(ioResult.output), "报出电平不一致并说明危害");

    // 总线端口名带 [] —— 第一版正则把它截成 led[0，导致全部误报"漏约束"
    const miss = makeProj("pin-miss", "set_property PACKAGE_PIN AA99 [get_ports {led[1]}]\n");
    const missResult = runTool(projectTool("project-pin-audit.mjs"), [miss, "--expect", join(miss, "board", "pins.csv")], miss);
    check(missResult.status === 1 && /漏约束/u.test(missResult.output), `期望有实际无 → 阻塞(实际 ${String(missResult.status)})`, missResult.output.slice(-250));
    check(/led\[0\]/u.test(missResult.output), "总线端口名 led[0] 被正确解析（含 ] 不截断）");
  }

  // ③ L0–L3 上板自检脚本生成器
  //
  // 只验**生成器行为**。生成的 Tcl 没在真机上跑过（本机没接板子，
  // open_hw_manager 跑不起来；用 ModelSim 的 Tcl 代跑不可行 —— 引号未闭合
  // 时 info complete 仍判完整，而 Vivado 命令在 ModelSim 里必然报无效命令）。
  // 所以这里不断言 Tcl 的语法正确性，只断言"生成的东西包含该有的结构"。
  console.log("\n=== L0–L3 上板自检（project-board-selftest.mjs）===");
  {
    const projDir = scratch("board-selftest", {
      ".fpga-workbench.json": JSON.stringify({ name: "selftest_proj", kind: "project" })
    });
    const result = runTool(projectTool("project-board-selftest.mjs"), [projDir], projDir);
    check(result.status === 0, `生成成功 → 退 0(实际 ${String(result.status)})`, result.output.slice(-250));

    const tclPath = join(projDir, "prj", "board_selftest.tcl");
    check(existsSync(tclPath), "输出到 prj/board_selftest.tcl");
    if (existsSync(tclPath)) {
      const tcl = readFileSync(tclPath, "utf8");
      check(/L0/u.test(tcl) && /L1/u.test(tcl) && /L2/u.test(tcl) && /L3/u.test(tcl), "含 L0–L3 四段");
      check(/stop_if_failed/u.test(tcl), "有「失败就停」逻辑（L0/L1 没过不往下走）");
      check(/connect_hw_server/u.test(tcl) && !/pyjnius/u.test(tcl), "走 hw_server，不依赖 pyjnius");
      check(/TODO:/u.test(tcl), "标了 TODO 供填寄存器地址");
      check(/selftest_proj/u.test(tcl), "工程名取自 .fpga-workbench.json");
    }

    // 缺参数 → 退 2，不能静默生成一个空文件
    const noArg = runTool(projectTool("project-board-selftest.mjs"), [], projDir);
    check(noArg.status === 2, `无参数 → 退 2(实际 ${String(noArg.status)})`);
  }

  // ④ SVA 断言真的能拦住非法状态
  //
  // 为什么必须真跑：本机**没有形式化工具**（JasperGold / VC Formal / SymbiYosys / qverify
  // 全无），SVA 是唯一能在桌面抓「状态机进非法编码」这类不变量的手段。
  // 只写文档不验证的话，断言写错了也不会有人知道 —— 那比不写更危险。
  //
  // 没有 ModelSim 时明确跳过（不把跳过记成 PASS）—— 与文件里其它真机用例同一口径。
  const svaProbeFd = openSync(join(SANDBOX, "sva-probe.log"), "w");
  const svaProbe = spawnSync("vsim", ["-c", "-do", "quit -f"], { stdio: ["ignore", svaProbeFd, "ignore"] });
  closeSync(svaProbeFd);
  const simAvailable = svaProbe.error === undefined && svaProbe.status === 0;

  if (!simAvailable) {
    console.log("  SKIP 真机 SVA:本机 vsim 不可用 —— 记 NOT_TESTED");
  } else {
    console.log("\n=== SVA 断言（真跑，验证它真的会拦）===");
    const svaDir = join(SANDBOX, "sva-check");
    mkdirSync(svaDir, { recursive: true });
    for (const [rel, text] of Object.entries({
      "dut.sv": [
        "module dut(input logic clk, input logic rst_sync_n, input logic go_bad, output logic [2:0] state);",
        "  always_ff @(posedge clk or negedge rst_sync_n) begin",
        "    if (!rst_sync_n)      state <= 3'd0;",
        "    else if (go_bad)      state <= 3'd6;",   // 非法编码
        "    else if (state < 3'd5) state <= state + 3'd1;",
        "  end",
        "endmodule"
      ].join("\n"),
      "dut_assertions.sv": [
        "module dut_assertions(input logic clk, input logic rst_sync_n, input logic [2:0] state);",
        "  property p_legal;",
        "    @(posedge clk) disable iff (!rst_sync_n) state <= 3'd5;",
        "  endproperty",
        "  ap_legal: assert property (p_legal) else $error(\"[SVA] state=%0d illegal\", state);",
        "endmodule"
      ].join("\n"),
      "tb_ok.sv": [
        "module tb_ok;",
        "  logic clk = 0, rst_sync_n = 0, go_bad = 0;",
        "  logic [2:0] state;",
        "  dut u(.clk(clk), .rst_sync_n(rst_sync_n), .go_bad(go_bad), .state(state));",
        "  dut_assertions a(.clk(clk), .rst_sync_n(rst_sync_n), .state(state));",
        "  always #5 clk = ~clk;",
        "  initial begin #20 rst_sync_n = 1; #80 $display(\"SVA_LEGAL_OK\"); $finish; end",
        "endmodule"
      ].join("\n"),
      "tb_bad.sv": [
        "module tb_bad;",
        "  logic clk = 0, rst_sync_n = 0, go_bad = 0;",
        "  logic [2:0] state;",
        "  dut u(.clk(clk), .rst_sync_n(rst_sync_n), .go_bad(go_bad), .state(state));",
        "  dut_assertions a(.clk(clk), .rst_sync_n(rst_sync_n), .state(state));",
        "  always #5 clk = ~clk;",
        "  initial begin #20 rst_sync_n = 1; #10 go_bad = 1; #40 $display(\"SVA_BAD_DONE\"); $finish; end",
        "endmodule"
      ].join("\n")
    })) {
      writeFileSync(join(svaDir, rel), text);
    }

    /** 编译并跑一个 top，返回合并输出。 */
    const runSva = (top) => {
      const logPath = join(svaDir, `${top}.log`);
      const fd = openSync(logPath, "w");
      const compile = spawnSync(
        "vlog",
        ["-sv", "-quiet", "dut.sv", "dut_assertions.sv", `${top}.sv`],
        { cwd: svaDir, stdio: ["ignore", fd, "ignore"] }
      );
      closeSync(fd);
      if (compile.status !== 0) return { status: compile.status, out: readFileSync(logPath, "utf8") };
      const runLog = join(svaDir, `${top}-run.log`);
      const runFd = openSync(runLog, "w");
      const status = spawnSync("vsim", ["-c", "-do", "run -all; quit -f", top], {
        cwd: svaDir,
        stdio: ["ignore", runFd, "ignore"]
      }).status;
      closeSync(runFd);
      return { status, out: readFileSync(runLog, "utf8") };
    };

    const legal = runSva("tb_ok");
    check(legal.status === 0 && /SVA_LEGAL_OK/u.test(legal.out), `合法设计断言不报(实际 ${String(legal.status)})`, legal.out.slice(-250));
    check(!/\[SVA\] state=/u.test(legal.out), "合法设计没有断言触发");

    const illegal = runSva("tb_bad");
    check(/\[SVA\] state=6/u.test(illegal.out), "非法编码被断言拦下（state=6）", illegal.out.slice(-350));
    check(/\*\* Error/u.test(illegal.out), "ModelSim 把它报成 Error 而不是静默 Note");
  }

  // ⑤ 时序报告解析（project-timing-report.mjs）
  //
  // 用**构造夹具**而不是真实工程报告：真实报告是某个项目的状态，
  // 拿它当断言基准 = 把那个项目当时的状况固化成规定。
  // 夹具只忠于 Vivado 的输出格式（实测 2020.2 / 2025.2 抓下来的形状）。
  console.log("\n=== 时序报告解析（project-timing-report.mjs）===");
  {
    const timingDir = join(SANDBOX, "timing-report");
    mkdirSync(timingDir, { recursive: true });

    /** 造一份符合 Vivado 真实格式的报告。 */
    const makeReport = (numbers, checks, extra = "") =>
      [
        "Copyright 1986-2020 Xilinx, Inc. All Rights Reserved.",
        "--------------------------------------------------------------------------------",
        "| Tool Version : Vivado v.2020.2 (win64)",
        "| Design       : fixture",
        "| Device       : 7a100t-fgg484",
        "--------------------------------------------------------------------------------",
        "",
        "Timing Summary Report",
        "",
        "    Enable Multi Corner Analysis               :  Yes",
        "",
        "    Corner  Analyze    Analyze",
        "    Name    Max Paths  Min Paths",
        "    ------  ---------  ---------",
        "    Slow    Yes        Yes",
        "    Fast    Yes        Yes",
        "",
        "check_timing report",
        ...Object.entries(checks).map(([name, count]) => `   ${String(count)}. checking ${name} (${count})`),
        "",
        "--------------------------------------------------------------------------------",
        "| Design Timing Summary",
        "| ---------------------",
        "--------------------------------------------------------------------------------",
        "",
        "    WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)",
        "    -------      -------  ---------------------  -------------------      -------      -------",
        numbers,
        "",
        extra,
        ""
      ].join("\n");

    const runTiming = (file, args = []) =>
      runTool(projectTool("project-timing-report.mjs"), [file, ...args], timingDir);

    // ① 正常报告：数字必须抠对
    const okReport = join(timingDir, "ok_timing_summary_routed.rpt");
    writeFileSync(
      okReport,
      makeReport(
        "        3.134        0.000                      0                  839        0.114        0.000",
        { no_clock: 0, unconstrained_internal_endpoints: 0, loops: 0 },
        "  All user specified timing constraints are met."
      )
    );
    const okResult = runTiming(okReport, ["--json"]);
    let okPayload = null;
    try {
      okPayload = JSON.parse(okResult.output);
    } catch {
      okPayload = null;
    }
    check(okResult.status === 0, `正常报告 → 退 0(实际 ${String(okResult.status)})`, okResult.output.slice(-250));
    check(okPayload?.summary?.WNS === 3.134, `WNS 抠对了（实际 ${String(okPayload?.summary?.WNS)}）`);
    check(okPayload?.summary?.WHS === 0.114, `WHS 抠对了（实际 ${String(okPayload?.summary?.WHS)}）`);
    check(okPayload?.hasConstraints === true, "识别出「有约束」");

    // ② 无约束报告：NA 必须如实转成 null，不能变成 0
    const naReport = join(timingDir, "na_timing_summary_routed.rpt");
    writeFileSync(
      naReport,
      makeReport(
        "         NA           NA                     NA                   NA           NA           NA",
        { no_clock: 0 },
        "  There are no user specified timing constraints."
      )
    );
    const naResult = runTiming(naReport, ["--json"]);
    let naPayload = null;
    try {
      naPayload = JSON.parse(naResult.output);
    } catch {
      naPayload = null;
    }
    check(naResult.status === 0, `NA 报告也能解析（不是错误）(实际 ${String(naResult.status)})`);
    check(naPayload?.summary?.WNS === null, `NA 转成 null 而不是 0（实际 ${JSON.stringify(naPayload?.summary?.WNS)}）`);
    check(naPayload?.hasConstraints === false, "识别出「无约束」");

    // ③ 关键性质：**工具不给结论**
    //    报告里有违例数字，工具也必须退 0 —— 判不判由使用者决定。
    const badReport = join(timingDir, "bad_timing_summary_routed.rpt");
    writeFileSync(
      badReport,
      makeReport(
        "       -1.234        5.000                     12                  839       -0.050        0.200",
        { no_clock: 3, unconstrained_internal_endpoints: 7 },
        "  There are 12 failing endpoints."
      )
    );
    const badResult = runTiming(badReport);
    check(badResult.status === 0, `有违例也不判 FAIL（退 0，实际 ${String(badResult.status)}）`);
    check(
      !/^\s*FAIL\b|\bPASS:/mu.test(badResult.output),
      "输出里没有 PASS/FAIL 字样（只给数字）"
    );
    check(/不给结论/u.test(badResult.output), "明文说明「本工具不给结论」");
    check(/no_clock: 3/u.test(badResult.output), "非零的 check_timing 如实列出");

    // ④ check_timing 多角重复 —— 必须取最大值
    const multiCorner = join(timingDir, "multi_timing_summary_routed.rpt");
    writeFileSync(
      multiCorner,
      [
        "    WNS(ns)   WHS(ns)",
        "    -------   -------",
        "      0.100     0.050",
        "",
        "  1. checking no_clock (0)",
        "  4. checking unconstrained_internal_endpoints (0)",
        "",
        "  1. checking no_clock (5)",
        "  4. checking unconstrained_internal_endpoints (2)",
        ""
      ].join("\n")
    );
    const multiResult = runTiming(multiCorner, ["--json"]);
    let multiPayload = null;
    try {
      multiPayload = JSON.parse(multiResult.output);
    } catch {
      multiPayload = null;
    }
    check(
      multiPayload?.checks?.no_clock === 5,
      `多角重复时取最大值（no_clock 实际 ${String(multiPayload?.checks?.no_clock)}，应为 5）`
    );

    // ⑤ 不是 timing summary → 退 2，不能假装解析成功
    const notTiming = join(timingDir, "not_timing.rpt");
    writeFileSync(notTiming, "some other report\nwith no timing section\n");
    const notResult = runTiming(notTiming);
    check(notResult.status === 2, `非时序报告 → 退 2(实际 ${String(notResult.status)})`);

    // ⑥ 目录输入：自动找 routed 那份
    const dirResult = runTiming(timingDir, ["--json"]);
    check(
      dirResult.status === 0 && /routed/u.test(dirResult.output),
      "给目录时优先选 routed 报告"
    );
  }
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 自带工具脚本判定正确(含自带模板自洽)");
if (failures.length > 0) process.exitCode = 1;

// 收尾:沙箱**不删**(用户定案:绝不永久删除),只报一次。残留会一直涨 —— 这是零删除的代价,
// 所以清单要打出来让人能处置;别为了"干净"在这里加回删除调用(生产代码的静态守卫也会拦)。
const sandboxLeftover = listTempLeftovers(join(ROOT, ".tmp"), [`fpga-tools-check-${String(process.pid)}`]);
if (sandboxLeftover.length > 0 && existsSync(SANDBOX)) {
  console.log(`\n自检沙箱留在原处(按用户定案不删除):${SANDBOX}`);
}