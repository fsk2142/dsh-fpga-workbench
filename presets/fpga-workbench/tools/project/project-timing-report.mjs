#!/usr/bin/env node
/**
 * Vivado 时序报告解析：把关键数字从报告里抠出来，**不给结论**。
 *
 * ## 为什么不做判定
 *
 * 时序报告「过不过」取决于**这个设计的目标**：LED 输出不需要建立保持时间，
 * 200 MHz 的 AXI 需要；教学工程可以先不管 I/O 延迟，量产工程不行。
 *
 * 把这些写成固定判据，等于把某个工程的经验变成通用规定 —— 那是错的。
 *
 * 所以本工具只做一件机器擅长的事：**从几千行报告里把那几个数字找出来**。
 * 判不判、按什么门槛判，由使用者（或 skill 里的人工判据）决定。
 *
 * ## 它解决什么实际问题
 *
 * 本机 `top_ddr3_rw` 那份 routed 报告是 **5.1 MB**。人打开它会跳着看，
 * 而「未约束端点有几个」「四角是否都分析了」恰恰藏在中间某一段。
 *
 * ## 解析哪些段（按真实报告格式，实测 Vivado 2020.2 / 2025.2 输出）
 *
 * ```
 * | Design Timing Summary       ← 总体 WNS/TNS/WHS/THS/WPWS；无约束时是 NA
 * check_timing report          ← 12 项，形如 "4. checking xxx (0)"，每个角重复一份
 * | Clock Summary              ← 时钟清单（名字/周期/频率）
 * | Timer Settings 的角表       ← Slow / Fast 各自是否分析了建立/保持
 * ```
 *
 * ## 输出
 *
 * 人类可读的摘要 + `--json` 机器可读。**不输出 PASS/FAIL**。
 *
 * 退出码：0 = 解析成功；2 = 输入错误或读不到关键段。
 *
 * ## 用法
 *
 * ```
 * node project-timing-report.mjs <报告文件或目录> [--json]
 * ```
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node project-timing-report.mjs <报告文件或目录> [--json]");
  write("");
  write("  解析 Vivado 的 report_timing_summary 输出，抠出关键数字。");
  write("  **不给 PASS/FAIL** —— 过不过取决于这个设计的目标，由你判断。");
  write("");
  write("  --json    输出机器可读 JSON");
  write("");
  write("退出码：0 解析成功 / 2 输入错误或读不到关键段。");
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = { target: "", json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") usage(0);
    rest.push(arg);
  }
  options.target = rest[0] ?? "";
  return options;
};

/** 找到报告文件（给目录时按常见命名找）。 */
const locateReport = (target) => {
  if (!existsSync(target)) return { error: `路径不存在：${target}` };
  const stat = statSync(target);
  if (stat.isFile()) return { file: target };

  const candidates = readdirSync(target)
    .filter((name) => /timing.*summary.*\.rpt$/iu.test(name))
    .map((name) => join(target, name));
  if (candidates.length === 0) return { error: `${target} 里没有 timing summary 报告` };
  const routed = candidates.find((path) => /routed/iu.test(path));
  return { file: routed ?? candidates[0] };
};

/**
 * 解析 Design Timing Summary 的数字行。
 *
 * 真实格式（列数随版本变）：
 *   WNS(ns)  TNS(ns)  TNS Failing Endpoints  ...  WHS(ns)  THS(ns) ...
 *   -------  -------  ---------------------  ...  -------  -------
 *   3.134    0.000    0                      ...  0.114    0.000
 *
 * 无约束时数字行全是 `NA`。
 */
const parseDesignSummary = (text) => {
  const lines = text.split(/\r?\n/u);
  const headerAt = lines.findIndex((line) => /^\s*WNS\(ns\)/u.test(line));
  if (headerAt < 0) return undefined;

  const headers = lines[headerAt].trim().split(/\s{2,}/u);

  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "" || /^-+(\s+-+)*$/u.test(line)) continue;
    const cells = line.split(/\s{2,}/u).filter((cell) => cell !== "");
    if (cells.length < 2) continue;

    const values = {};
    for (let column = 0; column < Math.min(headers.length, cells.length); column += 1) {
      const key = headers[column].replace(/\(ns\)/u, "").trim();
      const raw = cells[column];
      values[key] = /^NA$/iu.test(raw) ? null : Number(raw);
    }
    return { values, raw: line };
  }
  return undefined;
};

/**
 * 解析 check_timing 的 12 项。
 *
 * 格式：`4. checking unconstrained_internal_endpoints (0)`
 * **这段在报告里出现多次**（每个角一份）—— 取最大值，因为任一角有就算有。
 */
const parseCheckTiming = (text) => {
  const found = new Map();
  for (const match of text.matchAll(/^\s*\d+\.\s+checking\s+(\w+)\s*\((\d+)\)/gmu)) {
    const [, name, count] = match;
    found.set(name, Math.max(found.get(name) ?? 0, Number(count)));
  }
  return found;
};

/** 解析四角（Timer Settings 段的 Corner Name 表）。 */
const parseCorners = (text) => {
  const corners = [];
  const section = /Corner\s+Analyze\s+Analyze[\s\S]{0,400}?Name\s+Max Paths\s+Min Paths\s*\n\s*-+\s+-+\s+-+\s*\n([\s\S]{0,300}?)\n\s*\n/u.exec(text);
  if (section === null) return corners;
  for (const line of section[1].split(/\r?\n/u)) {
    const match = /^\s*(\w+)\s+(Yes|No)\s+(Yes|No)\s*$/u.exec(line);
    if (match !== null) corners.push({ name: match[1], setup: match[2], hold: match[3] });
  }
  return corners;
};

/** 解析 Clock Summary。 */
const parseClocks = (text) => {
  const clocks = [];
  const section = /\|\s*Clock Summary[\s\S]{0,200}?-+\s*\n\s*Clock\s+Waveform[\s\S]{0,120}?-+\s*\n([\s\S]*?)(?=\n\s*\n\s*-{10,}|\n\s*\|\s*\w)/u.exec(text);
  if (section === null) return clocks;
  for (const line of section[1].split(/\r?\n/u)) {
    const match = /^\s*(\S+)\s+\{[\d.\s]+\}\s+([\d.]+)\s+([\d.]+)\s*$/u.exec(line);
    if (match !== null) clocks.push({ name: match[1], period: Number(match[2]), frequency: Number(match[3]) });
  }
  return clocks;
};

/** 报告自己给的那句结论（如实转述，不替换成我的判定）。 */
const parseReportVerdict = (text) => {
  if (/All user specified timing constraints are met/u.test(text)) return "报告结论：所有用户时序约束满足";
  if (/There are \d+ failing/u.test(text)) return "报告结论：有失败路径";
  if (/There are no user specified timing constraints/u.test(text)) return "报告结论：没有用户时序约束";
  return undefined;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.target === "") usage();

  const located = locateReport(resolve(options.target));
  if (located.error !== undefined) {
    console.error(located.error);
    process.exit(2);
  }

  const text = readFileSync(located.file, "utf8");
  const summary = parseDesignSummary(text);
  if (summary === undefined) {
    console.error(`读不到 Design Timing Summary：${located.file}`);
    console.error("提示：这是 report_timing_summary 的输出吗？普通 report_timing 没有这段。");
    process.exit(2);
  }

  const checks = parseCheckTiming(text);
  const corners = parseCorners(text);
  const clocks = parseClocks(text);
  const reportVerdict = parseReportVerdict(text);
  const hasConstraints = summary.values.WNS !== null || summary.values.WHS !== null;

  const payload = {
    report: located.file,
    sizeKB: Math.round(statSync(located.file).size / 1024),
    summary: summary.values,
    hasConstraints,
    checks: Object.fromEntries(checks),
    corners,
    clocks,
    reportVerdict
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  console.log(`报告：${basename(located.file)}（${String(payload.sizeKB)} KB）`);
  console.log("");

  // Design Timing Summary
  const value = (key) => summary.values[key];
  const show = (key) => (value(key) === null || value(key) === undefined ? "NA" : String(value(key)));
  console.log("Design Timing Summary");
  console.log(`  建立：WNS = ${show("WNS")} ns   TNS = ${show("TNS")} ns   TNS 失败端点 = ${show("TNS Failing Endpoints")}`);
  console.log(`  保持：WHS = ${show("WHS")} ns   THS = ${show("THS")} ns   THS 失败端点 = ${show("THS Failing Endpoints")}`);
  if (value("WPWS") !== undefined) {
    console.log(`  脉宽：WPWS = ${show("WPWS")} ns   TPWS = ${show("TPWS")} ns`);
  }
  if (!hasConstraints) {
    console.log("");
    console.log("  注意：WNS/WHS 都是 NA，说明设计里没有时序约束。");
    console.log("        这种情况下数字不存在 —— 不代表通过，也不代表失败。");
  }
  console.log("");

  // 时钟
  if (clocks.length > 0) {
    console.log(`时钟（${String(clocks.length)} 个）`);
    for (const clock of clocks) {
      console.log(`  ${clock.name.padEnd(26)} 周期 ${String(clock.period).padStart(8)} ns   频率 ${String(clock.frequency).padStart(8)} MHz`);
    }
    console.log("");
  }

  // 四角
  if (corners.length > 0) {
    console.log("分析角");
    for (const corner of corners) {
      console.log(`  ${corner.name.padEnd(8)} 建立=${corner.setup}  保持=${corner.hold}`);
    }
    console.log("");
  }

  // check_timing
  if (checks.size > 0) {
    console.log(`check_timing（${String(checks.size)} 项，取各角最大值）`);
    const zero = [];
    const nonZero = [];
    for (const [name, count] of checks) {
      if (count === 0) zero.push(name);
      else nonZero.push([name, count]);
    }
    if (zero.length > 0) console.log(`  为 0：${zero.join(", ")}`);
    if (nonZero.length > 0) {
      console.log("  非 0：");
      for (const [name, count] of nonZero) console.log(`    ${name}: ${String(count)}`);
    } else {
      console.log("  全部为 0");
    }
    console.log("");
  }

  // 报告原话
  if (reportVerdict !== undefined) {
    console.log(reportVerdict);
    console.log("");
  }

  console.log("───");
  console.log("以上是报告里的数字。**本工具不给结论** ——");
  console.log("时序过不过取决于这个设计的目标（哪些端口有时序要求、目标频率多少）。");
  console.log("判定口径见 `fpga-project-timing` 技能的判据,由你按工程实际情况执行。");

  process.exit(0);
};

main();
