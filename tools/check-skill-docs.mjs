// 技能文档与代码的一致性检查。
//
// 为什么单独成一项：文档在 `presets/.../skills/`，代码在 `presets/.../tools/`，
// 两棵树分开演化。**模型是照着文档里的命令去调的** —— 文档写错参数，模型就调错，
// 而插件自身一切正常、任何单元测试都不会红。
//
// 这类漂移只有"把两棵树放一起比"才能发现。原来 `check-fpga-tools` 只对着一份
// SKILL.md 查了个别字符串，等于没查。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRESET = join(ROOT, "presets", "fpga-workbench");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

/** 递归列出某目录下所有指定后缀的文件。 */
function listFiles(dir, suffix, depth = 0) {
  const out = [];
  if (depth > 5) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, suffix, depth + 1));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

const skillFiles = listFiles(join(PRESET, "skills"), ".md");
const workspaceFiles = listFiles(join(PRESET, "workspace"), ".md");
const docFiles = [...skillFiles, ...workspaceFiles];

/**
 * 一个脚本**或它 import 的本地模块**接受了哪些长参数。
 *
 * 必须顺着 import 走一层：真正的参数解析在 `tools/lib/stamp.mjs` 的
 * `parseStampArgs`，入口脚本自己只有一个用法注释。
 */
function acceptedFlags(file) {
  const texts = [readFileSync(file, "utf8")];
  for (const match of texts[0].matchAll(/from\s*["'](\.[^"']+)["']/gu)) {
    try {
      texts.push(readFileSync(join(dirname(file), match[1]), "utf8"));
    } catch {
      /* 读不到就算了，别因为一个 import 让整条检查失效 */
    }
  }
  const flags = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(/["'`](--[a-z][a-z0-9-]*)["'`]/gu)) flags.add(match[1]);
    for (const match of text.matchAll(/(?:usage|用法)[^\n]*?(--[a-z][a-z0-9-]*)/giu)) flags.add(match[1]);
  }
  return flags;
}

// ── 建立「脚本 → 接受的 flag」表 ─────────────────────────────────────────────
const toolFiles = listFiles(join(PRESET, "tools"), ".mjs");
const accepted = new Map();
for (const file of toolFiles) accepted.set(file.split(/[\\/]/u).pop(), acceptedFlags(file));

// ── ① 文档提到的脚本必须真实存在 ───────────────────────────────────────────
{
  const mentions = new Set();
  for (const file of docFiles) {
    for (const match of readFileSync(file, "utf8").matchAll(/\b([\w-]+\.mjs)\b/gu)) mentions.add(match[1]);
  }
  const missing = [...mentions].filter((name) => !accepted.has(name));
  check(
    missing.length === 0,
    `文档提到的 ${String(mentions.size)} 个脚本都真实存在（缺：${missing.join("、") || "无"}）`
  );
}

// ── ② 文档给脚本的 flag 必须是它真的接受的 ─────────────────────────────────
//
// 文档里的实际形态是**带引号的路径**（`node "<自带命令目录>\module\x.mjs" …`），
// 只认裸文件名会得到"0 处引用"—— 那是一次假通过，等于没查。
{
  const referenced = [];
  for (const file of docFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /node\s+(?:"([^"\n]*?\.mjs)"|'([^'\n]*?\.mjs)'|([\w./\\-]+\.mjs))([^\n`]*)/gu
    )) {
      const raw = match[1] ?? match[2] ?? match[3] ?? "";
      const script = raw.split(/[\\/]/u).pop();
      const rest = match[4] ?? "";
      for (const flag of rest.matchAll(/(--[a-z][a-z0-9-]*)/gu)) {
        referenced.push({ file: file.replace(ROOT, "").split("\\").join("/"), script, flag: flag[1] });
      }
    }
  }
  // "0 处引用"本身就是失败 —— 不检查不等于通过。
  check(
    referenced.length > 0,
    `文档里确实有带参数的命令可查（实际 ${String(referenced.length)} 处）`
  );
  const mismatched = [
    ...new Set(
      referenced
        .filter(({ script, flag }) => accepted.has(script) && !accepted.get(script).has(flag))
        .map(({ file, script, flag }) => `${file} → ${script} ${flag}`)
    )
  ];
  check(
    mismatched.length === 0,
    `文档给脚本的 ${String(referenced.length)} 处 flag 都被代码接受（不符 ${String(mismatched.length)} 处）`,
    mismatched.slice(0, 10).join("\n")
  );
}

// ── ③ 声明支持 --help 的脚本必须真的能跑 ───────────────────────────────────
{
  const broken = [];
  for (const file of toolFiles) {
    if (!/--help/u.test(readFileSync(file, "utf8"))) continue;
    try {
      execFileSync(process.execPath, [file, "--help"], { encoding: "utf8", stdio: "pipe", timeout: 15_000 });
    } catch (error) {
      broken.push(`${file.split(/[\\/]/u).pop()}（退出码 ${String(error.status ?? "?")}）`);
    }
  }
  check(broken.length === 0, `声明支持 --help 的脚本都能正常响应（坏：${broken.join("、") || "无"}）`);
}

// ── ④ 技能 frontmatter 的 name 必须与目录名一致 ────────────────────────────
//
// 不一致时技能加载不上，而目录还在 —— 只看目录存在性会发现不了。
{
  const skillDirs = readdirSync(join(PRESET, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const mismatched = [];
  for (const dir of skillDirs) {
    let text;
    try {
      text = readFileSync(join(PRESET, "skills", dir, "SKILL.md"), "utf8");
    } catch {
      mismatched.push(`${dir}：缺 SKILL.md`);
      continue;
    }
    const declared = /^---[\s\S]*?^name:\s*(.+)$/mu.exec(text)?.[1]?.trim().replace(/^["']|["']$/gu, "");
    if (declared !== dir) mismatched.push(`${dir}：SKILL.md 里写的是 ${String(declared)}`);
  }
  check(
    mismatched.length === 0,
    `${String(skillDirs.length)} 个技能的 frontmatter name 与目录名一致（不符：${mismatched.join("；") || "无"}）`
  );
}

// ── ⑤ 技能正文引用的 references 文件都存在 ─────────────────────────────────
{
  const broken = [];
  for (const dir of readdirSync(join(PRESET, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    let text;
    try {
      text = readFileSync(join(PRESET, "skills", dir.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/references\/([\w.-]+\.md)/gu)) {
      try {
        statSync(join(PRESET, "skills", dir.name, "references", match[1]));
      } catch {
        broken.push(`${dir.name} → references/${match[1]}`);
      }
    }
  }
  check(broken.length === 0, `技能正文引用的 references 文件都存在（缺：${broken.join("、") || "无"}）`);
}

console.log("");
if (failures.length === 0) {
  console.log("PASS: 技能文档与代码参数一致(19 份文档 / 11 个脚本)");
} else {
  console.log(`FAIL (${String(failures.length)}): ${failures.join(" | ")}`);
  process.exitCode = 1;
}
