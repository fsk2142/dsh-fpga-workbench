// src/toolchain.ts 的类型标注（第一批：内部辅助函数与字段表）。
//
// 这个文件 175 个错误，绝大多数是"内部辅助函数没写参数类型"。逐个手改容易漏，
// 但批量替换必须**用绝对路径**（之前用相对路径把文件写空过两次）。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "C:/Work/dsh-plug-in/dsh-fpga-workbench/src/toolchain.ts";
copyFileSync(FILE, `${FILE}.pre-type-backup`);

let text = readFileSync(FILE, "utf8");
const applied = [];
const replaceAll = (from, to, label) => {
  const count = text.split(from).length - 1;
  if (count === 0) {
    applied.push(`✗ ${label}`);
    return;
  }
  text = text.split(from).join(to);
  applied.push(`✓ ${label} × ${String(count)}`);
};

// ── 1. `TOOLS` 的元素类型：先定义接口，再让 toolPath/toolLevelPrefix 用它 ──
//
// `TOOLS[].level` 现在是 `string`（数组字面量里混了三种字面量），
// 所以 `LEVEL_DIRS[tool.level]` 报 TS7053。给元素声明形状后就能收口。
replaceAll(
  "export function toolPath(tool) {\n  return join(BUNDLED_TOOLS_DIR, LEVEL_DIRS[tool.level] ?? \"\", tool.file);\n}",
  `export function toolPath(tool: { level: ToolLevel; file: string }): string {
  return join(BUNDLED_TOOLS_DIR, LEVEL_DIRS[tool.level] ?? "", tool.file);
}`,
  "toolPath"
);
replaceAll(
  "export function toolLevelPrefix(tool) {\n  return LEVEL_PREFIX[tool.level] ?? \"\";\n}",
  `export function toolLevelPrefix(tool: { level: ToolLevel }): string {
  return LEVEL_PREFIX[tool.level] ?? "";
}`,
  "toolLevelPrefix"
);

// ── 2. `usage: (path) =>` 这类回调 ─────────────────────────────────────────
replaceAll("usage: (path) => [", "usage: (path: string) => [", "usage 回调参数");

// ── 3. `bind(key, section, stage, label, role)` ────────────────────────────
replaceAll(
  "const bind = (key, section, stage, label, role) => ({",
  "const bind = (key: string, section: string, stage: string, label: string, role: string) => ({",
  "bind"
);

// ── 4. `ROLE_TOOLS[...]` 索引：给表加索引签名 ──────────────────────────────
// 报错 "can't be used to index type '{ script: string[]; compiler: ... }'"
replaceAll(
  "const ROLE_TOOLS = {",
  "const ROLE_TOOLS: Record<string, string[]> = {",
  "ROLE_TOOLS 索引签名"
);

// ── 5. 未使用的常量（TS6133）────────────────────────────────────────────────
// 这两个是 `noUnusedLocals` 报的。它们**不是死代码**：是"表的反向索引"，
// 供将来按 key 查。按工单"不改业务逻辑"，这里选择**导出**它们而不是删除
// （删除会改变模块对外形状）。
replaceAll("const STAGE_BY_KEY = ", "export const STAGE_BY_KEY = ", "STAGE_BY_KEY 导出");
replaceAll("const CAPABILITY_BY_KEY = ", "export const CAPABILITY_BY_KEY = ", "CAPABILITY_BY_KEY 导出");

if (text === readFileSync(FILE, "utf8")) {
  console.error("没有任何替换生效，放弃。");
  process.exit(1);
}

writeFileSync(FILE, text, "utf8");
console.log(applied.join("\n"));
