#!/usr/bin/env node
/**
 * Vivado 综合/实现报告解析：把资源占用与 DRC 数字抠出来，**不给结论**。
 *
 * ## 为什么不判定
 *
 * 「LUT 用了 80% 算不算超标」取决于**器件**：同样的 51,000 个 LUT，
 * 在 XC7A100T（63,400 可用）上是 80%，在 XC7A200T 上是 38%。
 * 写成「≤ 80% 就通过」的固定判据，等于把某个器件的经验变成通用规定。
 *
 * 所以本工具只做一件事：**把报告里的数字对准到一张表上**。
 *
 * ## 解析哪些报告（实测 Vivado 2020.2 / 2025.2 输出）
 *
 * | 报告 | 由谁产生 | 抠出什么 |
 * |---|---|---|
 * | `*_utilization_synth.rpt` / `*_utilization_impl.rpt` | `report_utilization` | LUT/FF/BRAM/DSP/IO 的 Used / Available / Util% |
 * | `*_drc_*.rpt` | `report_drc` | 违规条数、按严重度分组（Error / Critical Warning / Warning） |
 *
 * 两种都能给，给了哪个就解析哪个（按文件名和内容自动识别）。
 *
 * ## 用法
 *
 * ```
 * node project-report-extract.mjs <报告文件或 run 目录> [--json]
 * ```
 *
 * 给目录时自动找 `*_utilization_*.rpt` 与 `*_drc_*.rpt`，优先 impl 的。
 *
 * 退出码：0 = 解析成功；2 = 输入错误或没找到可解析的报告。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node project-report-extract.mjs <报告文件或 run 目录> [--json]");
  write("");
  write("  解析 report_utilization 与 report_drc 的输出，抠出资源占用与 DRC 违规数。");
  write("  **不给 PASS/FAIL** —— 资源是否超标取决于器件。");
  write("");
  write("  --json    输出机器可读 JSON");
  write("");
  write("退出码：0 解析成功 / 2 输入错误或无可解析报告。");
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
 * 解析 report_utilization。
 *
 * 真实格式（表框 + 管道分隔）：
 *   +-------------------------+------+-------+-----------+-------+
 *   |        Site Type        | Used | Fixed | Available | Util% |
 *   +-------------------------+------+-------+-----------+-------+
 *   | Slice LUTs*             |    1 |     0 |     63400 | <0.01 |
 *   |   LUT as Logic          |    1 |     0 |     63400 | <0.01 |
 *   | Slice Registers         |    0 |     0 |    126800 |  0.00 |
 */
const parseUtilization = (text) => {
  const rows = [];
  const lines = text.split(/\r?\n/u);

  let inTable = false;
  for (const line of lines) {
    // 表头行
    if (/^\s*\|.*Site Type.*\|.*Used.*\|.*Available.*\|/u.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;

    // **表格内的分隔线要继续**（表头后面紧跟 `+---+`，第一版把它当成表格结束，
    //  结果一行数据都没解析出来 —— 实测 `led_utilization_synth.rpt` 输出空表）
    if (/^\s*\+[-+]+\+?\s*$/u.test(line)) continue;

    // 非管道行 = 表格真的结束了
    if (!/^\s*\|/u.test(line)) {
      inTable = false;
      continue;
    }

    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 5) continue;
    // cells[0] 与最后一个都是空（首尾管道）
    const name = cells[1];
    const used = Number(cells[2]);
    const available = Number(cells[4]);
    const utilRaw = cells[5];

    if (name === "" || !Number.isFinite(used) || !Number.isFinite(available)) continue;
    if (available === 0) continue; // 这类（如 Fixed）没意义

    // `<0.01` 这种要特殊处理
    const util =
      /<0\.01/u.test(utilRaw) ? 0.005 : Number(utilRaw.replace(/%/u, ""));

    rows.push({
      name,
      used,
      available,
      utilPercent: Number.isFinite(util) ? util : null
    });
  }

  return rows;
};

/**
 * 解析 report_drc。
 *
 * 真实格式：
 *               Violations found: 0
 *   +------+----------+-------------+------------+
 *   | Rule | Severity | Description | Violations |
 *   +------+----------+-------------+------------+
 *   | NSTD-1 | Critical Warning | ... | 3 |
 */
const parseDrc = (text) => {
  const totalMatch = /Violations found:\s*(\d+)/u.exec(text);
  const total = totalMatch === null ? null : Number(totalMatch[1]);

  const bySeverity = new Map();
  const details = [];

  for (const line of text.split(/\r?\n/u)) {
    if (!/^\s*\|/u.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const [, rule, severity, description, count] = cells;
    // 跳过表头与分隔行
    if (rule === "Rule" || /^-+$/u.test(rule)) continue;
    const violations = Number(count);
    if (!Number.isFinite(violations)) continue;

    const key = severity === "" ? "(未标)" : severity;
    bySeverity.set(key, (bySeverity.get(key) ?? 0) + violations);
    if (violations > 0) details.push({ rule, severity: key, description: description.slice(0, 60), violations });
  }

  return { total, bySeverity: Object.fromEntries(bySeverity), details };
};

/** 报告类型识别（按文件名与内容）。 */
const classify = (text, file) => {
  const name = basename(file).toLowerCase();
  if (/utilization/u.test(name) || /Utilization Design Information/u.test(text)) return "utilization";
  if (/drc/u.test(name) || /Report DRC/u.test(text)) return "drc";
  return undefined;
};

const locateReports = (target) => {
  if (!existsSync(target)) return { error: `路径不存在：${target}` };
  const stat = statSync(target);
  if (stat.isFile()) return { files: [target] };

  const all = readdirSync(target).map((name) => join(target, name));
  // 优先 impl（routed / impl），其次 synth
  const pick = (pattern) => {
    const hit = all.filter((path) => pattern.test(path));
    if (hit.length === 0) return undefined;
    const impl = hit.find((path) => /routed|impl/iu.test(path));
    return impl ?? hit[0];
  };

  const files = [];
  const utilization = pick(/utilization.*\.rpt$/iu);
  const drc = pick(/drc.*\.rpt$/iu);
  if (utilization !== undefined) files.push(utilization);
  if (drc !== undefined) files.push(drc);

  if (files.length === 0) return { error: `${target} 里没有 utilization / drc 报告` };
  return { files };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.target === "") usage();

  const located = locateReports(resolve(options.target));
  if (located.error !== undefined) {
    console.error(located.error);
    process.exit(2);
  }

  const payload = { utilization: [], drc: undefined, reports: [] };

  for (const file of located.files) {
    const text = readFileSync(file, "utf8");
    const kind = classify(text, file);
    if (kind === undefined) continue;
    payload.reports.push({ file, kind });

    if (kind === "utilization") {
      const rows = parseUtilization(text);
      // 只保留主要资源（去掉 * 标注与缩进的子项，但保留 LUT/FF/BRAM/DSP/IO）
      const MAIN = /^(?:Slice LUTs|Slice Registers|Block RAM Tile|DSPs|Bonded IOB|Global Clock Buffers?|MMCM|PLL)\b/u;
      payload.utilization = rows.filter((row) => MAIN.test(row.name.replace(/\*/u, "")));
      payload.utilizationAll = rows;
    } else {
      payload.drc = parseDrc(text);
    }
  }

  if (payload.reports.length === 0) {
    console.error("没找到能识别的报告（需要 report_utilization 或 report_drc 的输出）");
    process.exit(2);
  }

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  for (const report of payload.reports) {
    console.log(`报告：${basename(report.file)}`);
  }
  console.log("");

  if (payload.utilization.length > 0) {
    console.log("资源占用");
    console.log(`  ${"资源".padEnd(20)}${"已用".padStart(10)}${"可用".padStart(12)}${"占比".padStart(10)}`);
    for (const row of payload.utilization) {
      const util = row.utilPercent === null ? "?" : `${String(row.utilPercent)}%`;
      console.log(`  ${row.name.padEnd(20)}${String(row.used).padStart(10)}${String(row.available).padStart(12)}${util.padStart(10)}`);
    }
    console.log("");
  }

  if (payload.drc !== undefined) {
    console.log("DRC");
    if (payload.drc.total === null) {
      console.log("  报告里没写 Violations found 总数");
    } else {
      console.log(`  违规总数：${String(payload.drc.total)}`);
    }
    const severities = Object.entries(payload.drc.bySeverity).filter(([, count]) => count > 0);
    if (severities.length === 0) {
      console.log("  按严重度：无违规");
    } else {
      console.log("  按严重度：");
      for (const [severity, count] of severities) console.log(`    ${severity}: ${String(count)}`);
    }
    if (payload.drc.details.length > 0) {
      console.log("  明细（前 10 条）：");
      for (const item of payload.drc.details.slice(0, 10)) {
        console.log(`    ${item.rule} [${item.severity}] ×${String(item.violations)}  ${item.description}`);
      }
    }
    console.log("");
  }

  console.log("───");
  console.log("以上是报告里的数字。**本工具不给结论** ——");
  console.log("资源是否超标取决于器件（同一个 LUT 数在 Artix 上是 80%、在 Kintex 上是 38%），");
  console.log("DRC 哪些必须清零也取决于设计。判定口径见对应技能，由你按工程实际情况执行。");

  process.exit(0);
};

main();
