// 检查补丁文件的字节是否真的是合法 UTF-8,以及 YAML 能否解析。
//
// 起因:pwsh 打印 cordis.patch.yml 时中文注释全是乱码。若文件里真有坏字节,
// 合并补丁时 YAML 解析会失败,而「空文件或坏文件会让启动失败」是 DSH 的明确行为。
import { readFileSync } from "node:fs";
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
  const replaced = text.includes("\uFFFD");
  check(!replaced, "没有替换字符 U+FFFD(乱码的标志)");
  // 中文注释应当能被正确读出来
  check(text.includes("本插件"), "中文注释可正确解码");
  console.log(`文件 ${bytes.length} 字节,${text.split("\n").length} 行`);
  console.log("首行:", JSON.stringify(text.split("\n")[0].slice(0, 60)));
}

// 2. YAML 形状:顶层数组、每项有 name、insert 有数组
const meaningful = (text ?? "").split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
const joined = meaningful.join("\n");
check(/^- /.test(joined.trim()), "顶层是数组(第一行非注释以 - 开头)");
check(/-\s*insert:/.test(joined), "含 insert:");
check(/name:\s*'dsh-fpga-workbench'/.test(joined), "插入本包名");

// 3. 不能是空文件或纯注释(DSH 明确:会让启动失败)
check(meaningful.length > 0, "不是空文件/纯注释文件");

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 补丁文件字节与形状都合法");
if (failures.length > 0) process.exitCode = 1;
