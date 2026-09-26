// 检查补丁文件的字节是否真的是合法 UTF-8,以及形状是否是纯模式插件该有的样子。
//
// 起因一:pwsh 打印 cordis.patch.yml 时中文注释全是乱码。若文件里真有坏字节,合并补丁时
// YAML 解析会失败,而「空文件或坏文件会让启动失败」是 DSH 的明确行为。
//
// 起因二(更实际):DSH 0.1.7-rc.2 已移除 `agent-presets` 补丁行,由宿主的新 preset registry
// 扫描用户预设目录。这个包现在只需要一条 insert 插件行;保留旧覆盖行会产生
// "entry agent-presets not found" 警告,并可能遮蔽新注册表的行为。
//
// 用加载补丁时的同一个 schema(含 !!js 标签)解析,而不是默认 schema。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";

// 宿主安装目录:唯一来源在 check-all.mjs(由它用同一个环境变量传下来),
// 这里保留同样的默认值,好让本文件被单独调用时也能跑。
const APP = process.env.DSH_APP_DIR ?? "C:/Program Files/DSH Desktop/resources/app";
// 补丁文件按**本文件的位置**定位(仓库根 = 本文件的上一级)—— 写死本机绝对路径的话,
// 仓库克隆到别处、或从别的目录调用就断。`readFileSync` 直接收 URL,不用再拼字符串路径。
const FILE = new URL("../cordis.patch.yml", import.meta.url);
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

// 2. 用宿主解析补丁时用的同一个 schema(所以整个文件属于「需要宿主」那一层:
//    check-all 在宿主目录不在时对它记 SKIP,而不是让源码层报 FAIL)
let rows = null;
const require = createRequire(`${APP}/package.json`);
try {
  const yaml = require("js-yaml");
  const { entryListSchema } = require("@deepseek-ai/cordis-plugin-include");
  rows = yaml.load(text, { schema: entryListSchema });
  check(true, "用宿主同一套 schema 解析成功(含 !!js 标签)");
} catch (error) {
  check(
    false,
    `解析失败 —— 启动会崩(宿主目录:${APP};装在别处就用 DSH_APP_DIR 指过去)`,
    error.message
  );
}

if (rows !== null) {
  check(Array.isArray(rows), "顶层是数组");
  check(rows.length === 1, `只有 1 个顶层 insert 条目(实际 ${rows.length})`);

  // 一:宿主插件行 —— 没有它,「设置 → FPGA 开发模式」没有可绑定的命名空间和设置路由。
  const inserted = rows.flatMap((row) => row.insert ?? []);
  check(inserted.length === 2, `有 2 条 insert 行(宿主插件 + 预设声明;实际 ${inserted.length})`);
  check(inserted[0]?.id === "fpga-workbench", `宿主 insert 行 id 正确(实际 ${String(inserted[0]?.id)})`);
  // 用包名而不是绝对路径:裸名从 profile 的 node_modules 解析,它的 import 也跟着解析。
  check(
    inserted[0]?.name === "dsh-fpga-workbench",
    `宿主 insert 用包名挂载(实际 ${String(inserted[0]?.name)})`
  );

  // 二:官方 0.1.7 registry 只从组合里的 @deepseek-ai/dsh-agent-preset 行收集预设。
  const presetRow = inserted.find((row) => row.id === "preset-fpga-workbench");
  check(presetRow !== undefined, "有 FPGA 预设声明行");
  check(
    presetRow?.name === "@deepseek-ai/dsh-agent-preset",
    `预设行按官方包名挂载(实际 ${String(presetRow?.name)})`
  );
  check(presetRow?.config?.id === "fpga-workbench", "预设 config.id 是 fpga-workbench");
  check(
    Array.isArray(presetRow?.config?.plugins) && presetRow.config.plugins.length > 0,
    "预设声明了非空的 plugins 数组"
  );

  // 三:不再有 agent-presets 覆盖行
  check(!rows.some((row) => row.id === "agent-presets"), "没有旧的 agent-presets 覆盖行");
}

// 3. 不能是空文件或纯注释(DSH 明确:会让启动失败)
const meaningful = (text ?? "").split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
check(meaningful.length > 0, "不是空文件/纯注释文件");

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 补丁字节与形状都合法");
if (failures.length > 0) process.exitCode = 1;
