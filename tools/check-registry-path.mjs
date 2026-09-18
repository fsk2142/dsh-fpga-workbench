// 校验 profile 补丁里的 registry 路径:YAML 解析之后必须与宿主解析函数算出的一致。
//
// 为什么需要它:两边脱节不会有任何报错,只会让面板读错文件 —— 表现为"未配置工作区"
// 或空列表,而你改了工作区那份却毫无反应。这类静默错配必须机器验。
//
// 特别要盯的是 Windows 反斜杠:YAML 里裸写 `C:\Work\x` 里的 `\W`、`\d` 在双引号内
// 会被当转义;单引号内才是字面量。所以不能靠肉眼,要真的解析出来比。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// js-yaml 与 entryListSchema 都从已安装的 DSH 里借 —— 那正是宿主解析补丁时用的
// 同一套。必须用 entryListSchema 而不是默认 schema:补丁里含 `!!js` 标签,
// 默认 schema 会以"unknown tag"直接拒绝。
const require = createRequire("file:///C:/Program Files/DSH Desktop/resources/app/package.json");
let yaml;
let entryListSchema;
try {
  yaml = require("js-yaml");
  ({ entryListSchema } = require("@deepseek-ai/cordis-plugin-include"));
} catch (error) {
  console.log(`解析依赖不可用(${error.code}),跳过`);
  process.exit(0);
}

// 1. 解析补丁
const patchText = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
let rows;
try {
  rows = yaml.load(patchText, { schema: entryListSchema });
  check(true, "补丁能被 loader 的 schema 解析(含 !!js)");
} catch (error) {
  check(false, "补丁 YAML 解析失败 —— 启动时会崩", error.message);
  process.exit(1);
}

check(Array.isArray(rows), "顶层是数组");

// 按 id 定位本插件那一行,而不是假设它在第一个 —— 补丁里还有别的条目
// (agent-presets 覆盖行),顺序会随需要变化。
const entry = Array.isArray(rows)
  ? rows.flatMap((row) => row.insert ?? []).find((item) => item.id === "fpga-workbench")
  : undefined;
check(entry !== undefined, "补丁里有本插件的 insert 行");
if (entry === undefined) {
  console.log(failures.length > 0 ? `\nFAIL (${failures.length})` : "");
  process.exitCode = 1;
  process.exit();
}

check(entry.name === JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name, "insert 的 name 等于本包名");

// 2. 取补丁里的 registry,并与宿主解析函数的结果对比
const fromPatch = entry.config?.registry;
check(typeof fromPatch === "string" && fromPatch.length > 0, `补丁给出了 config.registry(${String(fromPatch)})`);

if (typeof fromPatch === "string") {
  // 反斜杠必须是字面量,不能被 YAML 当转义吃掉
  check(fromPatch.includes("\\"), "registry 里保留了 Windows 反斜杠");
  check(!/[\u0000-\u001f]/u.test(fromPatch), "registry 里没有控制字符(被转义吃掉的迹象)");

  const host = await import(new URL("../lib/index.js", import.meta.url));
  const resolved = host.registryPathFrom(entry.config);
  check(resolved === fromPatch, `宿主采用的路径与补丁一致(${resolved})`);

  // 3. 该路径必须真的存在,否则面板就是空的
  const { existsSync } = await import("node:fs");
  check(existsSync(fromPatch), `registry 指向的文件存在(${fromPatch})`);
}

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 补丁里的 registry 解析正确,且宿主采用的就是它"
);
if (failures.length > 0) process.exitCode = 1;
