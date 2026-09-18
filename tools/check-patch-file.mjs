// 检查补丁文件的字节是否真的是合法 UTF-8,以及形状是否是纯模式插件该有的样子。
//
// 起因一:pwsh 打印 cordis.patch.yml 时中文注释全是乱码。若文件里真有坏字节,合并补丁时
// YAML 解析会失败,而「空文件或坏文件会让启动失败」是 DSH 的明确行为。
//
// 起因二(更实际):这个包现在**只是把预设挂进名单**,补丁里应当只有一条 agent-presets
// 覆盖行 —— 没有 insert、没有插件行。所以这里断言它"恰好只有那一条",防止旧 UI 时代的
// 插件行被加回来(那会让插件又被当客户端挂载)。
//
// 用加载补丁时的同一个 schema(含 !!js 标签)解析,而不是默认 schema。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";

const FILE = "C:/Work/dsh-fpga-workbench/cordis.patch.yml";
const bytes = readFileSync(FILE);

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// 1. 严格 UTF-8 解码:坏字节会抛错
let text = null;
try {
  text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  check(true, "文件字节是合法 UTF-8");
} catch (error) {
  check(false, "不是合法 UTF-8 —— YAML 解析会失败", error.message);
}

if (text !== null) {
  check(!text.includes("\uFFFD"), "没有替换字符 U+FFFD(乱码的标志)");
  check(text.includes("本插件"), "中文注释可正确解码");
  console.log(`文件 ${bytes.length} 字节,${text.split("\n").length} 行`);
}

// 2. 用宿主解析补丁时用的同一个 schema
let rows = null;
const require = createRequire("file:///C:/Program Files/DSH Desktop/resources/app/package.json");
try {
  const yaml = require("js-yaml");
  const { entryListSchema } = require("@deepseek-ai/cordis-plugin-include");
  rows = yaml.load(text, { schema: entryListSchema });
  check(true, "用宿主同一套 schema 解析成功(含 !!js 标签)");
} catch (error) {
  check(false, "解析失败 —— 启动会崩", error.message);
}

if (rows !== null) {
  check(Array.isArray(rows), "顶层是数组");
  check(rows.length === 1, `只有 1 个顶层条目(实际 ${rows.length})`);
  check(rows[0]?.id === "agent-presets", `唯一一条是 agent-presets 覆盖(实际 ${String(rows[0]?.id)})`);
  // 纯模式插件不该有插件行
  check(rows.every((row) => row.insert === undefined), "没有 insert 插件行(纯模式插件不挂载任何东西)");
}

// 3. 不能是空文件或纯注释(DSH 明确:会让启动失败)
const meaningful = (text ?? "").split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
check(meaningful.length > 0, "不是空文件/纯注释文件");

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 补丁字节与形状都合法(纯模式插件)");
if (failures.length > 0) process.exitCode = 1;
