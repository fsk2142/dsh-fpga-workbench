// 精确诊断那 4 处"不一致"：到底差异在哪一个字段。
//
// 只打印第一个不同的位置，避免拿两段长 JSON 去肉眼比。
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = (rel) => join(ROOT, rel);

const load = async (dir, entry) => import(pathToFileURL(at(join(dir, `${entry}.js`))).href);

/** 找出两个值第一处不同的路径。 */
function firstDiff(left, right, path = "") {
  if (left === right) return undefined;
  if (typeof left !== typeof right) return `${path}: 类型 ${typeof left} vs ${typeof right}`;
  if (left === null || right === null) return `${path}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`;
  if (typeof left !== "object") return `${path}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`;
  if (Array.isArray(left) !== Array.isArray(right)) return `${path}: 数组/对象不一致`;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return `${path}: 长度 ${left.length} vs ${right.length}`;
    for (let index = 0; index < left.length; index += 1) {
      const diff = firstDiff(left[index], right[index], `${path}[${index}]`);
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const diff = firstDiff(left[key], right[key], path === "" ? key : `${path}.${key}`);
    if (diff !== undefined) return diff;
  }
  return undefined;
}

const toolBefore = await load("lib.handwritten-backup", "toolchain");
const toolAfter = await load("lib", "toolchain");

console.log("=== FIELDS 第一处差异 ===");
console.log(" ", firstDiff(toolBefore.FIELDS, toolAfter.FIELDS) ?? "无差异");

console.log("\n=== TOOL_CATALOG 第一处差异 ===");
console.log(" ", firstDiff(toolBefore.TOOL_CATALOG, toolAfter.TOOL_CATALOG) ?? "无差异");

// FIELDS 里有没有函数？（有函数的话 JSON 比较会失败，因为函数被序列化掉了）
const hasFn = (value) => {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(hasFn);
};
console.log("\n=== FIELDS 里是否含函数（会让 JSON 比较失真）===");
console.log("  FIELDS:", hasFn(toolBefore.FIELDS));
console.log("  TOOL_CATALOG:", hasFn(toolBefore.TOOL_CATALOG));

// 逐字段找 function 类型的键
const findFns = (value, path = "") => {
  const out = [];
  if (typeof value === "function") {
    out.push(path);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const key of Object.keys(value)) out.push(...findFns(value[key], path === "" ? key : `${path}.${key}`));
  return out;
};
console.log("  函数位置(前 10):", findFns(toolBefore.FIELDS).slice(0, 10).join(", ") || "无");
console.log("  TOOL_CATALOG 函数位置:", findFns(toolBefore.TOOL_CATALOG).slice(0, 10).join(", ") || "无");

console.log("\n=== runSelfCheck 第一处差异 ===");
const selfBefore = await load("lib.handwritten-backup", "selfcheck");
const selfAfter = await load("lib", "selfcheck");
const before = selfBefore.runSelfCheck({});
const after = selfAfter.runSelfCheck({});
console.log(" ", firstDiff(before, after) ?? "无差异");
// 逐项列出不同的 check
for (let index = 0; index < Math.max(before.checks.length, after.checks.length); index += 1) {
  const left = before.checks[index];
  const right = after.checks[index];
  const diff = firstDiff(left, right);
  if (diff !== undefined) console.log(`  check[${index}] (${left?.id ?? right?.id}): ${diff}`);
}
void readFileSync;
void existsSync;
