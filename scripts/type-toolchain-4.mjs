// toolchain.ts 第四批：修 FieldSpec 与 ToolCatalogEntry 的成员可选性。
//
// 第三批我把 `FieldSpec.key` 写成必选 `string`、`ToolCatalogEntry.pathKey` 写成可选，
// 于是 `key: definition.pathKey` 变成 `string | undefined` 赋给 `string` → TS2322。
//
// 正确的形状（按真实数据看）：
//   · `FIELDS` 的每一项**都**有 `key`（它是字段的唯一标识）→ 必选。
//   · `TOOL_CATALOG` 的 `pathKey` / `label` / `hint` / `kind` 在表里**每一项都有**
//     → 改成必选；`role` 也有。`nameKey` / `notesKey` 只有自定义工具才有 → 保持可选。
//
// 这样既不用 `as` 断言，也符合真实数据。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "C:/Work/dsh-plug-in/dsh-fpga-workbench/src/toolchain.ts";
copyFileSync(FILE, `${FILE}.pre-type4-backup`);

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

// ── 1. ToolCatalogEntry：把表里每项都有的成员改成必选 ───────────────────────
replaceAll(
  `export interface ToolCatalogEntry {
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
}`,
  `export interface ToolCatalogEntry {
  /** 表里每一项都有这四个 —— 改成必选后 \`key: definition.pathKey\` 不必断言。 */
  role: string;
  label: string;
  pathKey: string;
  kind: string;
  hint: string;
  usage?: (path: string) => string[];
  /** 自定义工具用的两个字段名（名字 / 备注）：只有自定义项才有。 */
  nameKey?: string;
  notesKey?: string;
  [extra: string]: unknown;
}`,
  "ToolCatalogEntry 必选成员"
);

// ── 2. FieldSpec 里同样处理：label / hint / kind 展开处用的是定义里的值 ──────
//     但它们**不是**每个字段都有（模板字段就没有 tool/kind），所以保持可选。
//     真正要改的是 `key` —— 它一定是 string。
replaceAll("export interface FieldSpec {\n  key: string;", "export interface FieldSpec {\n  /** 字段唯一标识：每个字段都有（原来推成 string | undefined 是因为我漏看 place spread）。 */\n  key: string;", "FieldSpec.key 注释");

if (text === readFileSync(FILE, "utf8")) {
  console.error("没有替换生效");
  process.exit(1);
}
writeFileSync(FILE, text, "utf8");
console.log(applied.join("\n"));
