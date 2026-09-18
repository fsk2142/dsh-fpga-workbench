// 工具链逻辑的行为检查 —— 这是本插件里唯一非平凡的纯逻辑,三条行为都会真出错:
//
//   1. 只把**存在**的工具写进提示 —— 列一个不存在的路径,agent 会照着它去调工具
//   2. 缺失时要说清**跳过哪些步骤** —— 这正是用户要的警告,只报"未配置"没有用
//   3. 缓存目录不存在**不算故障** —— 它是写入目标,首次使用时才创建;报成缺失会让
//      每台新机器一打开设置就是一片红
//
// 只 import 零依赖的 lib/toolchain.js:lib/index.js 要 schemastery,而它只在 profile
// 的 node_modules 里,从仓库 import 会解析失败。
import { readFileSync } from "node:fs";
import { FIELDS, NS, inspectTools, renderEnvironment } from "../lib/toolchain.js";

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

/** 桩探测:只有名单里的路径算存在。 */
const probeWith = (present) => (path) => present.includes(path);

const KEYS = FIELDS.map((field) => field.key);
check(KEYS.length === 5, `字段共 5 个(实际 ${KEYS.length})`);
check(KEYS.includes("cachePath"), "含缓存目录字段");
const cache = FIELDS.find((field) => field.key === "cachePath");
check(cache?.required === false, "缓存目录标记为非必需(不存在不算缺失)");
check(FIELDS.filter((field) => field.required === true).length === 4, "四个工具字段标记为必需");

// 1. 什么都不填 → 没有可用路径,但有缺失警告(4 个必需项都不可用)
const nothing = renderEnvironment(inspectTools({}, probeWith([])));
check(!nothing.includes("工具链路径"), "全空时没有可用路径段");
check(nothing.includes("尚未在设置里配置"), "全空时给出缺失警告");
check(nothing.includes("综合") && nothing.includes("RTL 功能仿真"), "警告里列出各工具会跳过的步骤");

// 2. 只把**存在**的工具写进提示;缓存目录按写入目标写
const mixed = inspectTools(
  { vivadoPath: "C:\\vivado.bat", modelsimPath: "C:\\missing\\vsim.exe", cachePath: "C:\\cache" },
  probeWith(["C:\\vivado.bat"])
);
const rendered = renderEnvironment(mixed);
check(rendered.includes("C:\\vivado.bat"), "存在的工具写进提示");
check(rendered.includes("Vivado"), "提示里带工具名");
check(rendered.includes("缓存目录: C:\\cache"), "缓存目录按写入目标写进提示(不存在也写)");
check(!rendered.includes("- ModelSim: "), "不存在的 ModelSim 不写成可用路径");

// 3. 缺失要列清跳过的步骤 —— 用户要的警告
check(rendered.includes("ModelSim"), "缺失的工具出现在警告里");
check(rendered.includes("路径不存在"), "已配置但探测不到,措辞说明是路径问题而非未配置");
check(rendered.includes("RTL 功能仿真"), "说清会跳过哪些步骤");

// 4. 未配置与路径错要区分措辞
check(renderEnvironment(inspectTools({}, probeWith([]))).includes("尚未在设置里配置"), "未配置的措辞与路径错不同");

// 5. 缓存目录不存在不算缺失:它不该出现在警告里
const cacheOnly = inspectTools({ cachePath: "C:\\not\\yet" }, probeWith([]));
const cacheOnlyRendered = renderEnvironment(cacheOnly);
check(
  cacheOnly.some((tool) => tool.key === "cachePath" && tool.present === false),
  "缓存目录状态可查(未创建)"
);
check(!/- 缓存目录\(/.test(cacheOnlyRendered), "缓存目录不进缺失警告");
check(cacheOnlyRendered.includes("缓存目录: C:\\not\\yet"), "但它作为写入目标写进可用路径");
check(
  cacheOnly.find((tool) => tool.key === "cachePath")?.required === false,
  "缓存目录标记为非必需"
);
// 警告只针对必需项:把必需项都配好并存在,警告就该消失
const ready = inspectTools(
  {
    vivadoPath: "C:\\v",
    modelsimPath: "C:\\m",
    verilatorPath: "C:\\t",
    libraryPath: "C:\\l",
    cachePath: "C:\\not\\yet"
  },
  probeWith(["C:\\v", "C:\\m", "C:\\t", "C:\\l"])
);
check(!renderEnvironment(ready).includes("必须跳过"), "必需项齐全时不再有缺失警告");
check(renderEnvironment(ready).includes("缓存目录: C:\\not\\yet"), "缓存目录仍未创建也不影响");

// 6. 探测抛错不能让整页崩
const throwing = inspectTools({ vivadoPath: "C:\\x" }, () => {
  throw new Error("boom");
});
check(throwing[0].present === false, "探测抛错时按不存在处理,不向外冒泡");

// 7. 两边契约一致 —— 客户端 bundle 里是硬编码的
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
check(clientSource.includes(`"${NS}"`), `客户端命名空间与宿主一致(${NS})`);
check(clientSource.includes("/plugins/fpga-workbench/toolchain"), "客户端用的状态路由与宿主一致");
for (const field of FIELDS) {
  check(clientSource.includes(`"${field.key}"`), `客户端有字段 ${field.key}`);
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 工具链探测与警告的行为全部正确");
if (failures.length > 0) process.exitCode = 1;
