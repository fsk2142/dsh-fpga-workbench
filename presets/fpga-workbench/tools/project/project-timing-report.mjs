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

/**
 * 找到报告文件（给目录时按常见命名找）。
 *
 * ## R08：多份 routed 报告不能"取第一个"
 *
 * 原来是 `candidates.find((path) => /routed/iu.test(path))` ——
 * 取的是 `readdirSync` 顺序里的第一个。而目录枚举顺序**既不等于生成时间、
 * 也不等于 run 的新旧**：`a_routed_timing_summary.rpt`（旧，WNS=+1）与
 * `z_routed_timing_summary.rpt`（新，WNS=-2）并存时会读到旧的那份，
 * 给上层一个**错误版本的事实**。
 *
 * 工具本身不判 PASS，但它报的数字是上层判据的输入 —— 版本错了后面全错。
 *
 * 现在：
 * 1. routed 优先（那才是最终结果），同档按 **mtime 取最新**
 * 2. **把选择依据打印出来**（多个候选时列出被放弃的）
 * 3. 候选里混着 synth/impl 时明确说明
 */
const locateReport = (target) => {
  if (!existsSync(target)) return { error: `路径不存在：${target}` };
  const stat = statSync(target);
  if (stat.isFile()) return { file: target, picked: [{ file: target, reason: "直接用给定文件" }] };

  const candidates = readdirSync(target)
    .filter((name) => /timing.*summary.*\.rpt$/iu.test(name))
    .map((name) => join(target, name));
  if (candidates.length === 0) return { error: `${target} 里没有 timing summary 报告` };

  // 按 mtime 降序；routed 优先
  const withMeta = candidates.map((path) => {
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // 读不到时间就排最后
    }
    /**
     * **N10：只用 basename 判断阶段，不能看完整路径。**
     *
     * 原来看整个 `path` —— 于是父目录名叫 `routed-parent` 时，里面**所有**报告
     * （包括 synth 的）都被当成 "routed"，选出来的"routed 优先"理由也是假的。
     *
     * 阶段是文件名的属性，不是目录名的。
     */
    const base = path.split(/[\\/]/u).pop() ?? path;
    return { path, mtime, routed: /routed/iu.test(base) };
  });
  withMeta.sort((a, b) => {
    if (a.routed !== b.routed) return a.routed ? -1 : 1;
    return b.mtime - a.mtime;
  });

  const chosen = withMeta[0];
  const others = withMeta.slice(1);

  return {
    file: chosen.path,
    picked: [
      {
        file: chosen.path,
        reason:
          candidates.length === 1
            ? "唯一候选"
            : `${String(candidates.length)} 个候选里选 ${chosen.routed ? "routed 优先 + " : ""}mtime 最新`,
        /** 被放弃的候选（让上层能看出来是否选错了版本）。 */
        skipped: others.map((item) => ({
          file: item.path,
          mtime: item.mtime,
          routed: item.routed
        }))
      }
    ]
  };
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
  /** 解析出来的非法单元格（列名 + 原文 + 行号）。 */
  const badCells = [];

  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "" || /^-+(\s+-+)*$/u.test(line)) continue;
    const cells = line.split(/\s{2,}/u).filter((cell) => cell !== "");
    if (cells.length < 2) continue;

    /**
     * **R09：数值解析失败不能悄悄变成 NA。**
     *
     * 原来这行是：
     *
     * ```js
     * values[key] = /^NA$/iu.test(raw) ? null : Number(raw);
     * ```
     *
     * `Number("TRUNCATED")` 得到 `NaN`，而 JSON 把 `NaN` 序列化成 `null` ——
     * 与合法的 `NA` **长得一模一样**。于是「报告被截断 / 列错位」看起来像
     * 「这些值本来就不适用」，`hasConstraints` 仍然 true、退出 0。
     *
     * 现在三态分开：
     * - 合法数字 → 数值
     * - 明确的 `NA` → null（真的不适用）
     * - **其它** → 记进 `badCells`，由调用方按输入错误处理
     */
    /**
     * **N11：缺列的合法数字行不能被吞成"缺省值"。**
     *
     * 原来循环上限是 `Math.min(headers.length, cells.length)` —— 表头 4 列、
     * 数字行只有 2 个单元格时，只解析前 2 列就返回成功。
     * 结果是 `summary` 里没有 WHS/THS，`hasConstraints=true`、退 0，
     * 而**没有任何地方说"这两列缺失"**。
     *
     * 现在：列数不一致就记进 `badCells`（带列名说哪个缺），按输入错误处理。
     */
    const values = {};
    for (let column = 0; column < headers.length; column += 1) {
      const key = headers[column].replace(/\(ns\)/u, "").trim();

      // 这一列在数字行里没有对应单元格 → 结构问题，不是"值不适用"
      if (column >= cells.length) {
        badCells.push({ column: key, raw: "<缺列>", line: i + 1 });
        values[key] = undefined;
        continue;
      }

      const raw = cells[column];
      if (/^NA$/iu.test(raw)) {
        values[key] = null;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        badCells.push({ column: key, raw: raw.slice(0, 24), line: i + 1 });
        values[key] = undefined;
        continue;
      }
      values[key] = parsed;
    }
    return { values, raw: line, badCells };
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

  /**
   * **R09：解析出非数字、非 NA 的单元格 → 输入错误，不当"没有约束"。**
   *
   * 这类输入的典型来源：报告被截断、列错位、或者根本不是这一版 Vivado 的格式。
   * 继续往下算只会给出**看起来正常、实际无意义**的数字。
   */
  if (Array.isArray(summary.badCells) && summary.badCells.length > 0) {
    // **N11**：区分「值非法」与「整列缺失」—— 修法不同，说清楚
    const missing = summary.badCells.filter((cell) => cell.raw === "<缺列>");
    const invalid = summary.badCells.filter((cell) => cell.raw !== "<缺列>");

    if (missing.length > 0) {
      console.error(`Design Timing Summary 有 ${String(missing.length)} 列在数字行里没有对应单元格：`);
      for (const cell of missing.slice(0, 8)) {
        console.error(`  第 ${String(cell.line)} 行  缺列「${cell.column}」`);
      }
    }
    if (invalid.length > 0) {
      console.error(`另有 ${String(invalid.length)} 个单元格不是数字也不是 NA：`);
      for (const cell of invalid.slice(0, 8)) {
        console.error(`  第 ${String(cell.line)} 行  列「${cell.column}」= ${JSON.stringify(cell.raw)}`);
      }
    }
    console.error("");
    console.error("这通常说明：报告被截断 / 列错位 / 不是这一版 Vivado 的格式。");
    console.error("本工具不去猜那些值 —— 猜出来的数字看起来正常，实际没有意义。");
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
    reportVerdict,
    /** **R08**：多份候选时选的是哪份、为什么，被放弃的是哪些。 */
    picked: located.picked ?? []
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  console.log(`报告：${basename(located.file)}（${String(payload.sizeKB)} KB）`);

  // **R08**：选择依据要说出来 —— 多份 routed 报告并存时不说明就可能读的是旧版
  for (const item of payload.picked) {
    if (item.reason !== undefined && item.reason !== "直接用给定文件" && item.reason !== "唯一候选") {
      console.log(`  选择依据：${item.reason}`);
    }
    if (Array.isArray(item.skipped) && item.skipped.length > 0) {
      const names = item.skipped.map((x) => basename(x.file)).join("、");
      console.log(`  未采用：${names}`);
      console.log("  **注意**：目录里有多份候选报告时，本工具按 mtime 取最新 ——");
      console.log("  但时间新不等于「属于目标 run」。要绝对确定就显式给报告路径。");
    }
  }
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
