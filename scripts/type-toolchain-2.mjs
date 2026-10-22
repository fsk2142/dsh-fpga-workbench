// toolchain.ts 第二批：单行替换（避开多行匹配的换行符问题）。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "C:/Work/dsh-plug-in/dsh-fpga-workbench/src/toolchain.ts";
copyFileSync(FILE, `${FILE}.pre-type2-backup`);

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

// 单行签名（不做多行匹配）
replaceAll("export function toolPath(tool) {", "export function toolPath(tool: { level: ToolLevel; file: string }): string {", "toolPath");
replaceAll("export function toolLevelPrefix(tool) {", "export function toolLevelPrefix(tool: { level: ToolLevel }): string {", "toolLevelPrefix");

// LEVEL_PREFIX 也要能吃 ToolLevel
replaceAll(
  'const LEVEL_PREFIX = { module: "module-", project: "project-", shared: "" };',
  'const LEVEL_PREFIX: Record<ToolLevel, string> = { module: "module-", project: "project-", shared: "" };',
  "LEVEL_PREFIX 索引签名"
);

if (text === readFileSync(FILE, "utf8")) {
  console.error("没有替换生效");
  process.exit(1);
}
writeFileSync(FILE, text, "utf8");
console.log(applied.join("\n"));
