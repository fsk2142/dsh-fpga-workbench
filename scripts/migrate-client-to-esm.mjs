// 把 src/client/index.ts 从「手写 loader 包装」改成标准 ESM。
//
// 为什么必须改（实测）:原文件自己在 `window.__ModuleLoader__.load({ factory })` 里
// 手动 `exports.apply = apply`。而 tsdown 配置里又加了一层 banner/footer 包装 ——
// 两层叠加后，内层那份手写的 exports 赋值落在 tsdown 的 factory 里面，但 tsdown 只
// 认 ESM 的 `export` 语法，于是产物里 `exports.apply` 根本不存在，宿主加载后
// `clientExports.apply is not a function`，整张设置卡失效。
//
// 这次改动是**纯机械**的：
//   1. 去掉头部 `window.__ModuleLoader__.load({ id, factory: (require) => {` 与
//      里面的 module/exports 垫片；
//   2. 去掉尾部 `return module.exports; } });`；
//   3. 整段代码反缩进 4 格（它们原本嵌在 factory 里）；
//   4. `const React = require("react")` → `import React from "react"`。
//
// 任何一行**非空白**内容都不改。
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const FILE = "src/client/index.ts";
const BACKUP = `${FILE}.pre-esm-backup`;
copyFileSync(FILE, BACKUP);

const lines = readFileSync(FILE, "utf8").split("\n");

// ── 定位头部 ────────────────────────────────────────────────────────────────
const headStart = lines.findIndex((line) => line.includes("window.__ModuleLoader__.load({"));
if (headStart < 0) throw new Error("没找到 window.__ModuleLoader__.load 头部");

const shimEnd = lines.findIndex((line) => line.includes("Symbol.toStringTag") && line.includes("Module"));
if (shimEnd < 0) throw new Error("没找到 Symbol.toStringTag 垫片行");

const bodyStart = shimEnd + 1;

// ── 定位尾部 ────────────────────────────────────────────────────────────────
//
// 尾部已经被手动改成 ESM `export` 语句了（`export { apply }` / `export const inject`
// 等），所以这里**不再找 `return module.exports`** —— 只要找到第一条 ESM 导出语句，
// 从那里开始原样保留（不反缩进，它们已经在顶层）。
let tailStart = -1;
for (let index = 0; index < lines.length; index += 1) {
  if (/^(?:export\s|export\{)/u.test(lines[index].trimStart()) && index > shimEnd) {
    tailStart = index;
    break;
  }
}
if (tailStart < 0) throw new Error("没找到 ESM 导出语句");

console.log(`头部垫片：第 ${String(headStart + 1)}–${String(shimEnd + 1)} 行`);
console.log(`正文：第 ${String(bodyStart + 1)}–${String(tailStart)} 行`);
console.log(`导出段（原样保留）：第 ${String(tailStart + 1)}–${String(lines.length)} 行`);

// ── 正文反缩进 4 格（只动前导空白）─────────────────────────────────────────
const body = lines.slice(bodyStart, tailStart).map((line) => {
  if (line.trim() === "") return "";
  return line.startsWith("    ") ? line.slice(4) : line;
});

// ── React 的 require 换成 ESM import ────────────────────────────────────────
let reactIndex = -1;
for (let index = 0; index < body.length; index += 1) {
  if (/^\s*const React = require\("react"\);?\s*$/u.test(body[index])) {
    reactIndex = index;
    break;
  }
}
if (reactIndex >= 0) {
  body[reactIndex] = 'import React from "react";';
  console.log(`React 的 require 已换成 ESM import（正文第 ${String(reactIndex + 1)} 行）`);
} else {
  console.log('⚠ 没找到 `const React = require("react")`，需人工确认');
}

// ── 组装输出 ────────────────────────────────────────────────────────────────
const head = lines.slice(0, headStart);
const tail = lines.slice(tailStart);
const out = [...head, ...body, "", ...tail];
while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
out.push("");

writeFileSync(FILE, `${out.join("\n")}`, "utf8");
console.log(`\n写完：${String(lines.length)} 行 → ${String(out.length)} 行`);
console.log(`原文件已备份为 ${BACKUP}`);
