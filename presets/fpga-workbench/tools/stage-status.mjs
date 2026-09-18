#!/usr/bin/env node
// 阶段状态汇总 —— 一眼看出"做到哪一步了"。
//
// 为什么要它:每个阶段的结果都写在各自的文件夹里,换会话、隔一周回来、或者会话被压缩过之后,
// 想知道"现在在哪一步"就得把七八个文件翻一遍。这个脚本把每个阶段的结论抽成一行。
//
// 约定(技能里也写着):每个阶段的结果文件里要有一行 `结论:PASS`(或 FAIL / BLOCKED /
// NOT_APPLICABLE / UNVERIFIED / SKIPPED)。抽不到就报"有产物但没写结论" —— 这本身也是个
// 值得知道的状态。
//
// 用法:
//   node stage-status.mjs [<模块或工作区目录>] [--json]
// 目录默认当前目录;会从该目录向上找 `.fpga-workbench.json`。
// 退出码:0 正常(哪怕有阶段没做) / 2 找不到约定文件。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** 模块级的阶段文件夹。 */
const MODULE_STAGES = ["spec", "lint", "sim", "comp", "synth", "timing", "review"];

/** 工程级的阶段文件夹(在工作区根的 project/ 下)。 */
const PROJECT_STAGES = ["spec", "integrate", "constraints", "syssim", "impl", "timing", "board", "release", "audit"];

/** 合法结论取值(与技能里写的口径一致)。 */
const VERDICTS = ["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE", "UNVERIFIED", "SKIPPED"];

/** 从起点向上找约定文件(导出给自检用)。 */
export function findConvention(start) {
  let current = resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, ".fpga-workbench.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** 目录里最新的 .md 文件(排除我们自己生成的汇总)。 */
function newestMarkdown(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => join(dir, entry.name))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0];
}

/** 优先 `<阶段>/<阶段>.md`,找不到就取该目录里最新的 md。 */
function resultFile(stageDir, stage) {
  const named = join(stageDir, `${stage}.md`);
  if (existsSync(named)) return { file: named, mtime: statSync(named).mtimeMs };
  return newestMarkdown(stageDir);
}

/**
 * 抽结论:找 `结论:PASS` 这种行;抽不到返回 undefined。
 *
 * spec 阶段特殊:它的结论本来就是 spec_state(draft → confirmed),所以那一阶段允许读
 * `spec_state:` 作为兜底 —— 不必让规格文件里写两遍同一件事。
 * @param file - 结果文件。
 * @param stage - 阶段名。
 * @returns `{ verdict, raw }` 或 undefined。
 */
export function readVerdict(file, stage) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const match = /结论\s*[:：]\s*[*`]*([A-Za-z_]+)/u.exec(text);
  if (match !== null) return { verdict: match[1].toUpperCase(), raw: match[0] };
  if (stage === "spec") {
    const state = /spec_state\s*[:：]\s*[*`]*([A-Za-z_]+)/u.exec(text);
    if (state !== null) return { verdict: state[1].toUpperCase(), raw: state[0] };
  }
  return undefined;
}

/** 该阶段允许的结论取值。 */
function allowedVerdicts(stage) {
  return stage === "spec" ? [...VERDICTS, "DRAFT", "CONFIRMED"] : VERDICTS;
}

/**
 * 汇总一个根目录下的所有阶段(导出给自检用)。
 * @param root - 阶段文件夹所在目录。
 * @param stages - 阶段名单。
 * @returns 每个阶段的状态。
 */
export function collect(root, stages) {
  return stages.map((stage) => {
    const stageDir = join(root, stage);
    if (!existsSync(stageDir)) return { stage, state: "未开始", file: undefined, mtime: undefined };
    const found = resultFile(stageDir, stage);
    if (found === undefined) return { stage, state: "有目录无结果文件", file: undefined, mtime: undefined };
    const verdict = readVerdict(found.file, stage);
    return {
      stage,
      state: verdict === undefined ? "有产物但没写结论" : verdict.verdict,
      file: found.file,
      mtime: found.mtime,
      valid: verdict === undefined ? undefined : allowedVerdicts(stage).includes(verdict.verdict)
    };
  });
}

/** 入口。 */
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法:node stage-status.mjs [<模块或工作区目录>] [--json]");
    return 0;
  }
  const asJson = args.includes("--json");
  const start = args.find((arg) => !arg.startsWith("-")) ?? process.cwd();

  const convention = findConvention(start);
  if (convention === undefined) {
    console.error(`从 ${resolve(start)} 向上没找到 .fpga-workbench.json`);
    console.error("这个文件是整套流程的锚点:它在哪,阶段文件夹就在哪。先跑 fpga-spec 那个技能把它建出来。");
    return 2;
  }

  let kind = "module";
  try {
    kind = JSON.parse(readFileSync(convention, "utf8")).kind ?? "module";
  } catch {
    console.error(`约定文件不是合法 JSON:${convention}`);
    return 2;
  }

  const root = dirname(convention);
  const isProject = kind === "project";
  const rows = isProject ? collect(join(root, "project"), PROJECT_STAGES) : collect(root, MODULE_STAGES);

  if (asJson) {
    console.log(JSON.stringify({ kind, root, convention, stages: rows }, null, 2));
    return 0;
  }

  console.log(`${isProject ? "工程级" : "模块级"}:${root}`);
  console.log(`约定文件:${relative(root, convention).split(sep).join("/")}\n`);
  for (const row of rows) {
    const where = row.file === undefined ? "" : `  ${relative(root, row.file).split(sep).join("/")}`;
    const when = row.mtime === undefined ? "" : `  ${new Date(row.mtime).toLocaleString("zh-CN")}`;
    const note = row.valid === false ? "  ← 取值不在约定范围内" : "";
    console.log(`${row.stage.padEnd(12)} ${String(row.state).padEnd(20)}${where}${when}${note}`);
  }
  const done = rows.filter((row) => ["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"].includes(row.state)).length;
  console.log(`\n${done}/${rows.length} 个阶段有结论。"有产物但没写结论"的,补一行 \`结论:...\` 就能被这里看到。`);
  return 0;
}

/** 直接跑本文件时才进 CLI;被 import 时只导出上面那些函数。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
