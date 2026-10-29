// 文档准确性核查:文档里提到的文件路径、命令、npm script 是否真实存在。
//
// 为什么要机器核:文档会随代码演进变旧,而"文档说有这么个文件、实际没有"这类错误
// 人眼很难逐条发现。这里把它变成可重复的检查。
//
// **所有路径都基于本文件位置**(仓库根 = 上一级),不依赖 cwd —— 否则从别的目录
// 调用就会去读错地方的文件。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = (rel) => join(ROOT, rel);

const DOCS = ["README.md", "docs/DEVELOPMENT.md", "docs/COMPATIBILITY.md", "docs/SCRUB-COMMIT-HISTORY.md"];
const problems = [];

/** 1. 反引号里形如 `lib/xxx.js` / `tools/xxx.mjs` 的路径是否真实存在。 */
for (const doc of DOCS) {
  const text = readFileSync(at(doc), "utf8");
  for (const match of text.matchAll(/`((?:lib|tools|presets|scripts|docs)\/[\w./-]+\.(?:js|mjs|md|yml|sv|xdc|tcl|do|py|json))`/gu)) {
    const rel = match[1];
    if (!existsSync(at(rel))) problems.push(`${doc}: 提到 \`${rel}\`，但文件不存在`);
  }
}

/** 2. `node tools/xxx.mjs` 形式的命令，目标是否存在。 */
for (const doc of DOCS) {
  const text = readFileSync(at(doc), "utf8");
  for (const match of text.matchAll(/node\s+(tools\/[\w./-]+\.mjs|scripts\/[\w./-]+\.mjs)/gu)) {
    const rel = match[1];
    if (!existsSync(at(rel))) problems.push(`${doc}: 命令 \`node ${rel}\` 的目标不存在`);
  }
}

/** 3. `npm run xxx` 提到的 script 是否在 package.json 里。 */
const manifest = JSON.parse(readFileSync(at("package.json"), "utf8"));
const scripts = new Set(Object.keys(manifest.scripts ?? {}));
for (const doc of DOCS) {
  const text = readFileSync(at(doc), "utf8");
  for (const match of text.matchAll(/npm run ([\w:-]+)/gu)) {
    const name = match[1];
    if (!scripts.has(name)) problems.push(`${doc}: 提到 \`npm run ${name}\`，但 package.json 里没有这个脚本`);
  }
}

/** 4. 文档里写的技能名是否都在 skills/ 下。 */
const skillDirs = readdirSync(at("presets/fpga-workbench/skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
for (const doc of DOCS) {
  const text = readFileSync(at(doc), "utf8");
  for (const match of text.matchAll(/\b(fpga-(?:module|project)-[a-z-]+)\b/gu)) {
    const name = match[1];
    // `fpga-module-flow` 是 README 明确写了"已删除"的历史技能名，不算不实。
    if (name === "fpga-module-flow") continue;
    if (!skillDirs.includes(name)) problems.push(`${doc}: 提到技能 \`${name}\`，但 skills/ 下没有`);
  }
}

/** 5. 文档里的模板份数声明与真实的模板文件数对得上。 */
const readme = readFileSync(at("README.md"), "utf8");
const templateCount = readdirSync(at("presets/fpga-workbench/templates"), { recursive: true }).filter(
  (file) => typeof file === "string" && /\.(sv|xdc|tcl|do|py)$/u.test(file)
).length;
console.log(`模板文件实际数: ${templateCount}`);
const claim = /(\d+)\s*份内置模板/u.exec(readme);
if (claim !== null && Number(claim[1]) !== templateCount) {
  problems.push(`README 说「${claim[1]} 份内置模板」，实际 ${templateCount} 个文件`);
} else if (claim !== null) {
  console.log(`✅ README 的模板份数声明(${claim[1]})与文件数一致`);
}

/**
 * 6. 「N 个技能」「N 个命令」「N 个辅助模块」这类**数量陈述**与实际情况对得上。
 *
 * 为什么单列一条:这些数字散落在 README 与源码注释里（例如 `check-preset-root.mjs`
 * 的「15 个技能会在每轮都占用…」），**没有任何机制盯着它们**。增删一个技能后,
 * 注释会悄悄变成错的,而它是给下一个改代码的人看的。
 *
 * 做法:对每条「已知会在仓库里出现的陈述形态」,先算真实值,再在文档与 tools/ 的源码里
 * 搜这个陈述,对不上就报。
 */
// 复用上面第 4 条已经读出来的 `skillDirs`（技能目录名数组）。
const skillCount = skillDirs.length;
const projectSkillCount = skillDirs.filter((name) => name.startsWith("fpga-project-")).length;
const moduleSkillCount = skillDirs.filter((name) => name.startsWith("fpga-module-")).length;

// 命令与辅助模块的真实数：直接从源码拿（toolchain 只依赖 node 内置模块）。
const { TOOLS } = await import("../lib/toolchain.js");
const commandCount = TOOLS.length;
const helperCount = readdirSync(at("presets/fpga-workbench/tools/lib")).filter((f) => f.endsWith(".mjs")).length;

/**
 * 每条陈述:正则（必须捕获那个数字）+ 真实值 + 人话标签。
 * 正则里刻意**不写死数字** —— 否则它就和自己要检查的东西一样会过期。
 */
const CLAIMS = [
  { pattern: /(\d+)\s*份内置模板/u, actual: templateCount, label: "内置模板份数" },
  { pattern: /(\d+)\s*个自带命令/u, actual: commandCount, label: "自带命令数" },
  { pattern: /(\d+)\s*个辅助模块/u, actual: helperCount, label: "辅助模块数" },
  { pattern: /(\d+)\s*个技能/u, actual: skillCount, label: "技能总数" }
];

/** 要检查的文本:README + docs/ + tools/ 下所有 .mjs（源码注释里的数字陈述同样要盯）。 */
const haystacks = [["README.md", readme]];
for (const doc of ["docs/DEVELOPMENT.md", "docs/COMPATIBILITY.md"]) {
  haystacks.push([doc, readFileSync(at(doc), "utf8")]);
}
for (const file of readdirSync(at("tools"))) {
  if (file.endsWith(".mjs")) haystacks.push([`tools/${file}`, readFileSync(at(`tools/${file}`), "utf8")]);
}

for (const [name, text] of haystacks) {
  for (const { pattern, actual, label } of CLAIMS) {
    const global = new RegExp(pattern.source, "gu");
    for (const match of text.matchAll(global)) {
      const claimed = Number(match[1]);
      // `11 个技能` 是工程级的说法（README 那一行是「工程级能力（11 个技能）」），
      // 所以对「N 个技能」这条要接受两种真实值之一。
      const acceptable = label === "技能总数" ? new Set([skillCount, projectSkillCount, moduleSkillCount]) : new Set([actual]);
      if (!acceptable.has(claimed)) {
        const expected = [...acceptable].join(" 或 ");
        problems.push(`${name}: ${label}说「${claimed}」，实际是 ${expected}`);
      }
    }
  }
}

console.log(
  `技能实际数: ${skillCount}（模块级 ${moduleSkillCount} / 工程级 ${projectSkillCount}）/ 命令 ${commandCount} 个 / 辅助模块 ${helperCount} 个`
);

console.log("");
if (problems.length === 0) {
  console.log("✅ 文档里提到的路径、命令、npm script、技能名全部真实存在");
} else {
  console.log(`❌ ${problems.length} 处不实:`);
  for (const problem of problems) console.log("  " + problem);
  process.exitCode = 1;
}
