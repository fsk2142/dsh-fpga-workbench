// toolchain.ts 第三批：给数据表加索引签名 / 让字段形状可写。
//
// 两类根因：
//   1. `TOOL_CATALOG[x]` / `LEGACY_CUSTOM[x]` 用 `string` 索引**精确形状**的对象
//      → TS7053。加 `Record<string, ...>` 解决，运行时不变（各调用点都有 `?? 兜底`）。
//   2. `for (const field of FIELDS) { field.section = "common" }` → TS2322
//      （某些字段字面量里没有 `section`，TS 把它的类型推成 `undefined`）。
//      `FIELDS` 的元素需要声明成"可写且字段可选"的形状。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "C:/Work/dsh-plug-in/dsh-fpga-workbench/src/toolchain.ts";
copyFileSync(FILE, `${FILE}.pre-type3b-backup`);

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

// ── 1. 在 ToolLevel 定义之后插入两个通用接口 ────────────────────────────────
replaceAll(
  'export const LEVEL_DIRS: Record<ToolLevel, string> = { module: "module", project: "project", shared: "" };',
  `export const LEVEL_DIRS: Record<ToolLevel, string> = { module: "module", project: "project", shared: "" };

/**
 * 设置页一个字段的形状。
 *
 * 为什么这么多可选：FIELDS 里的字段来自几张不同的表（工具路径 / 模板 / 能力偏好），
 * 有些字段没有 \`section\` / \`group\` / \`default\`。下面那段 \`for (const field of FIELDS)\`
 * 会给缺的补默认值 —— 所以这些成员必须**可写且可选**，否则 TS 按字面量推断成
 * \`undefined\`，赋值就报 TS2322（实测踩到）。
 */
export interface FieldSpec {
  key: string;
  tool?: string;
  kind?: string;
  label?: string;
  hint?: string;
  control?: string;
  default?: unknown;
  section?: string;
  sectionLabel?: string;
  group?: string;
  blankNote?: string;
  required?: boolean;
  skips?: string[];
  usage?: (path: string) => string[];
  templateLevel?: unknown;
  [extra: string]: unknown;
}`,
  "FieldSpec 接口"
);

// ── 2. FIELDS 显式标注 ────────────────────────────────────────────────────
replaceAll("export const FIELDS = [", "export const FIELDS: FieldSpec[] = [", "FIELDS 标注");

// ── 3. 两张按 key 查的对象表加索引签名 ─────────────────────────────────────
//     `TOOL_CATALOG[name]` 在运行时一定带 `?? 兜底`，所以"未知键返回 undefined"安全。
replaceAll("export const TOOL_CATALOG = {", "export const TOOL_CATALOG: Record<string, ToolCatalogEntry> = {", "TOOL_CATALOG 索引签名");
replaceAll("const LEGACY_CUSTOM = {", "const LEGACY_CUSTOM: Record<string, LegacyCustomEntry> = {", "LEGACY_CUSTOM 索引签名");

// ── 4. 两个条目接口（放在 ToolLevel 之后）──────────────────────────────────
replaceAll(
  "export interface FieldSpec {",
  `/** TOOL_CATALOG 的一项：工具的展示名、路径字段名等。 */
export interface ToolCatalogEntry {
  role?: string;
  label?: string;
  pathKey?: string;
  kind?: string;
  hint?: string;
  usage?: (path: string) => string[];
  /** 自定义工具用的两个字段名（名字 / 备注）。 */
  nameKey?: string;
  notesKey?: string;
  [extra: string]: unknown;
}

/** LEGACY_CUSTOM 的一项：旧版"自定义工具"映射到新字段。 */
export interface LegacyCustomEntry {
  tool?: string;
  pathKey?: string;
  nameKey?: string;
  notesKey?: string;
  [extra: string]: unknown;
}

export interface FieldSpec {`,
  "ToolCatalogEntry / LegacyCustomEntry 接口"
);

if (text === readFileSync(FILE, "utf8")) {
  console.error("没有替换生效");
  process.exit(1);
}
writeFileSync(FILE, text, "utf8");
console.log(applied.join("\n"));
