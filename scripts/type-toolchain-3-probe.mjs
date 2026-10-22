// toolchain.ts 第三批：给几张"按 key 查"的数据表加索引签名。
//
// 这批 30+ 个错误全是同一个根因：`TOOL_CATALOG[x]` / `ROLE_TOOLS[x]` 之类用 `string`
// 索引一个**精确形状**的对象字面量。加 `Record<string, ...>` 就解决，且不改变运行时。
//
// 注意：加索引签名会让"访问不存在的键"从"编译期报错"变成"返回 undefined"。
// 这些表在代码里本来就是 `?? 默认值` 兜底的（见各调用点），所以安全。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "C:/Work/dsh-plug-in/dsh-fpga-workbench/src/toolchain.ts";
copyFileSync(FILE, `${FILE}.pre-type3-backup`);

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

// 先看这几个表是怎么声明的。
const declarations = [
  "const TOOL_CATALOG",
  "export const TOOL_CATALOG",
  "const LEGACY_CUSTOM",
  "const ROLE_TOOLS",
  "const INFER_",
  "const KIND_BY_",
  "const DETECT_TARGETS",
  "export const DETECT_TARGETS",
  "const FIELDS",
  "export const FIELDS",
  "const CAPABILITIES",
  "export const CAPABILITIES",
  "const TOOLS",
  "export const TOOLS",
  "const STAGES",
  "export const STAGES"
];
for (const name of declarations) {
  const pattern = `${name} = {`;
  const arrayPattern = `${name} = [`;
  if (text.includes(pattern)) applied.push(`· 对象表: ${name}`);
  if (text.includes(arrayPattern)) applied.push(`· 数组表: ${name}`);
}

writeFileSync(FILE, text, "utf8");
console.log(applied.join("\n"));
