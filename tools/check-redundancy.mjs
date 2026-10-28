// 冗余文件检查：重复内容、未引用的 references、未被引用的模板、包体积异常。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/u)
  .filter((line) => line.trim() !== "");

// ① 重复内容（内容哈希相同）
console.log("=== ① 重复内容 ===");
const byHash = new Map();
for (const rel of tracked) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) continue;
  const size = statSync(full).size;
  if (size === 0) continue; // 空文件不算重复
  const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
  if (!byHash.has(digest)) byHash.set(digest, []);
  byHash.get(digest).push(rel);
}
const dupes = [...byHash.values()].filter((group) => group.length > 1);
if (dupes.length === 0) {
  console.log("  ✅ 无重复内容");
} else {
  for (const group of dupes) console.log(`  ⚠️ ${group.join("  ==  ")}`);
}

// ② 未被 SKILL.md 引用的 references
console.log("\n=== ② 未引用的 references ===");
const skillRoot = join(ROOT, "presets", "fpga-workbench", "skills");
let orphanRefs = 0;
for (const skill of readdirSync(skillRoot)) {
  const skillFile = join(skillRoot, skill, "SKILL.md");
  const refDir = join(skillRoot, skill, "references");
  if (!existsSync(skillFile) || !existsSync(refDir)) continue;
  const text = readFileSync(skillFile, "utf8");
  for (const ref of readdirSync(refDir)) {
    if (!text.includes(ref)) {
      console.log(`  ⚠️ ${skill}/references/${ref}`);
      orphanRefs += 1;
    }
  }
}
if (orphanRefs === 0) console.log("  ✅ 全部被 SKILL.md 引用");

// ③ 未被任何命令/技能引用的模板
console.log("\n=== ③ 未引用的模板 ===");
const allSource = tracked
  .filter((rel) => rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".md"))
  .map((rel) => {
    try {
      return readFileSync(join(ROOT, rel), "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");
const templateRoot = join(ROOT, "presets", "fpga-workbench", "templates");
const orphanTemplates = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    const base = name;
    if (!allSource.includes(base)) orphanTemplates.push(relative(ROOT, full).replace(/\\/gu, "/"));
  }
};
walk(templateRoot);
if (orphanTemplates.length === 0) {
  console.log("  ✅ 全部被引用");
} else {
  for (const item of orphanTemplates) console.log(`  ⚠️ ${item}`);
}

// ④ 包体积与 npm files 白名单覆盖
console.log("\n=== ④ 包体积 ===");
const total = tracked.reduce((sum, rel) => {
  const full = join(ROOT, rel);
  return existsSync(full) ? sum + statSync(full).size : sum;
}, 0);
console.log(`  跟踪文件 ${String(tracked.length)} 个 / ${(total / 1024 / 1024).toFixed(2)} MB`);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const files = pkg.files ?? [];
console.log(`  npm files 白名单: ${Array.isArray(files) ? files.join(", ") : "(未声明)"}`);

const problems = dupes.length + orphanRefs + orphanTemplates.length;
console.log("");
console.log(problems === 0 ? "  ✅ 冗余检查通过" : `  ⚠️ ${String(problems)} 项待确认`);
