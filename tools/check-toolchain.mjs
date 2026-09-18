// 工具链逻辑的行为检查 —— 这是本插件里唯一非平凡的纯逻辑。
//
// 断言的是四类会真出错的性质:
//   1. 只有必需项未就绪才算"缺失" —— 缓存目录是写入目标,不存在是正常的;报成缺失会让
//      每台新机器一打开设置就是一片红,提示也就没人看了
//   2. 探测抛错不能让整页崩 —— 沙箱/权限问题会让 stat 抛异常
//   3. 两侧契约一致 —— 客户端 bundle 不能 import 宿主代码,字段与路由只能各写一份,
//      写歪了界面就会显示错的东西(不报错)
//   4. 会话提示分得清三种状态(就绪 / 没填 / 填错)—— 都写成"未配置",agent 就分不清
//      该去填还是该去改;并且它只能由模式半侧注册,不能进插件行
//
// 只 import lib/toolchain.js:它只用 node 内置模块,而 lib/index.js 要 schemastery,
// 后者只在 profile 的 node_modules 里,从仓库 import 会解析失败。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELDS, NS, describeEnv, inspectTools, probeFilesystem, resolveTemplates } from "../lib/toolchain.js";

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

/** 桩探测:只有名单里的路径算存在。 */
const probeWith = (present) => (path) => present.includes(path);

/** 缺失判定(与 lib/index.js 的 statusOf 同规则:只看必需项)。 */
const missingKeys = (tools) => tools.filter((tool) => tool.required === true && !tool.present).map((tool) => tool.key);

// ── 字段定义 ────────────────────────────────────────────────────────────────
const KEYS = FIELDS.map((field) => field.key);
const REQUIRED_FIELDS = FIELDS.filter((field) => field.required === true);
check(KEYS.length === 6, `字段共 6 个:五个路径 + 模板目录(实际 ${KEYS.length})`);
check(KEYS.includes("cachePath"), "含缓存目录字段");
check(
  REQUIRED_FIELDS.length === 5,
  `五个路径全部必填(实际 ${REQUIRED_FIELDS.length}/${FIELDS.length})`
);
check(
  FIELDS.filter((field) => field.required !== true).map((field) => field.key).join(",") === "templateDir",
  "只有模板目录可选 —— 缺了就退回插件自带的模板,不挡路"
);
check(
  REQUIRED_FIELDS.every((field) => field.skips.length > 0),
  "每个必填项都写清了没就绪会跳过哪些步骤(否则界面上会出现空的跳过清单)"
);
check(
  FIELDS.filter((field) => field.required !== true).every((field) => field.skips.length === 0),
  "可选字段不报'会跳过什么'(它缺了并不跳过任何环节)"
);

// ── 存在性判定 ──────────────────────────────────────────────────────────────
const empty = inspectTools({}, probeWith([]));
check(empty.length === 6, "空设置也返回全部字段");
check(empty.every((tool) => tool.configured === false && tool.present === false), "空设置下全部未配置且不可用");
check(missingKeys(empty).length === 5, "空设置下五项必填都算未就绪(模板目录不算)");

const partial = inspectTools(
  { vivadoPath: "C:\\vivado.bat", modelsimPath: "C:\\missing\\vsim.exe", cachePath: "C:\\cache" },
  probeWith(["C:\\vivado.bat"])
);
const byKey = new Map(partial.map((tool) => [tool.key, tool]));
check(byKey.get("vivadoPath")?.present === true, "存在的路径判为可用");
check(byKey.get("modelsimPath")?.present === false && byKey.get("modelsimPath")?.configured === true, "路径错:已配置但未就绪");
check(byKey.get("verilatorPath")?.configured === false, "没填的项:未配置");
check(
  missingKeys(partial).join(",") === "modelsimPath,verilatorPath,libraryPath,cachePath",
  `未就绪清单正确(实际 ${missingKeys(partial).join(",")})`
);
check(byKey.get("cachePath")?.present === false, "缓存目录状态如实反映(未创建)");

// 值两端空白要当成没填(否则 "  " 会被当成一条路径)
const blank = inspectTools({ vivadoPath: "   " }, probeWith([]));
check(blank.find((tool) => tool.key === "vivadoPath")?.configured === false, "纯空白视同未配置");
check(blank.find((tool) => tool.key === "vivadoPath")?.path === "", "路径取出去掉首尾空白");

// 探测抛错不能让整页崩
const throwing = inspectTools({ vivadoPath: "C:\\x" }, () => {
  throw new Error("boom");
});
check(throwing.find((tool) => tool.key === "vivadoPath")?.present === false, "探测抛错时按不可用处理,不向外冒泡");

// 全部就绪
const prepared = { vivadoPath: "C:\\v", modelsimPath: "C:\\m", verilatorPath: "C:\\t", libraryPath: "C:\\l", cachePath: "C:\\c" };
const ready = inspectTools(prepared, probeWith(Object.values(prepared)));
check(missingKeys(ready).length === 0, "全部就绪时没有缺失项");

// ── 两侧契约 ────────────────────────────────────────────────────────────────
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
check(clientSource.includes(`"${NS}"`), `客户端命名空间与宿主一致(${NS})`);
check(clientSource.includes("/plugins/fpga-workbench/toolchain"), "客户端用的状态路由与宿主一致");
for (const field of FIELDS) {
  check(clientSource.includes(`"${field.key}"`), `客户端有字段 ${field.key}`);
  // 说明文字两边必须逐字一致 —— 说法不一致会让人去填一个不存在的文件名。
  // 真实教训:hint 只写"可执行文件",用户就会去找 Windows 上并不存在的 vivado.exe。
  // 比的是**源码文本**,所以把宿主运行时的反斜杠转义成源码里的写法再比。
  const literal = field.hint.replace(/\\/gu, "\\\\");
  check(clientSource.includes(literal), `客户端 hint 与宿主一致:${field.key}`);
}
// 说明里要给确切文件名,不能含糊成"可执行文件"
check(FIELDS.find((field) => field.key === "vivadoPath")?.hint.includes("vivado.bat"), "Vivado 说明写了确切文件名 vivado.bat");
check(FIELDS.find((field) => field.key === "modelsimPath")?.hint.includes("vsim.exe"), "ModelSim 说明写了确切文件名 vsim.exe");
check(FIELDS.find((field) => field.key === "verilatorPath")?.hint.includes("verilator_bin.exe"), "Verilator 说明写了确切文件名 verilator_bin.exe");
// 客户端要按宿主返回的 skips 显示"会跳过什么",不能自己另写一份跳过清单
// (只检查几个只可能来自宿主的步骤名,别用"综合"这种会撞上提示文案的词)
check(clientSource.includes("skips"), "客户端用宿主返回的 skips 渲染提示");
for (const step of ["比特流生成", "RTL 功能仿真", "厂商原语仿真"]) {
  check(!clientSource.includes(step), `客户端没有硬编码步骤「${step}」(必须来自宿主)`);
}
// 写入必须等落地再刷新状态。
// scope.set 是排队的 mutation,不等它就去问宿主会拿到旧值 —— 实机现象是"填完路径要
// 关掉设置再打开才显示已就绪"。这条只能靠源码断言守住:它是时序契约,不是纯逻辑。
check(
  clientSource.includes("return Promise.resolve(pending)"),
  "写入函数把 scope.set 的 promise 返回出去(不等结算就会显示旧状态)"
);
check(/writeField\([\s\S]{0,120}?\.then\(/u.test(clientSource), "刷新状态写在写入结算之后(.then 里)");

// 不再往会话提示里注入任何东西 —— 这是刻意的设计决定
check(!readFileSync(new URL("../lib/index.js", import.meta.url), "utf8").includes("systemPrompt"), "宿主不注册 systemPrompt 段");

// ── 会话提示(只有本模式看得到) ──────────────────────────────────────────────
//
// 这一段是"五个路径真的被用起来"的落点:已就绪的路径与调用姿势原样交给 agent,
// 未就绪的说清是没填还是填错、会跳过什么。断言的是三种状态的**措辞必须不同** ——
// 把它们写成同一句"未配置",agent 就分不清该去填还是该去改。
const readyText = describeEnv(prepared, probeWith(Object.values(prepared)));
check(readyText.includes(prepared.vivadoPath), "提示里给出 Vivado 的真实路径");
check(readyText.includes("-mode batch"), "提示里给出 Vivado 的非交互调用方式");
check(readyText.includes(prepared.modelsimPath) && readyText.includes("-c -do"), "提示里给出 ModelSim 的命令行调用方式");
check(readyText.includes("--lint-only"), "提示里给出 Verilator 的 lint 调用方式");
check(!readyText.includes("未就绪"), "全部就绪时不出现未就绪清单");
check(readyText.includes(prepared.cachePath) && readyText.includes("不要污染 RTL 源码目录"), "产物只写缓存目录这条约定在提示里");
check(readyText.includes("where"), "提示里写明权威来源,不让 agent 去 PATH 猜");

const halfText = describeEnv({ vivadoPath: "C:\\vivado.bat" }, probeWith([]));
check(halfText.includes("路径不存在(C:\\vivado.bat)"), "填了但不存在:说成路径不存在(要去改)");
check(halfText.includes("Verilator:未配置"), "没填的项:说成未配置(要去填)");
check(halfText.includes("比特流生成"), "未就绪时带上会跳过哪些步骤");

const noCacheText = describeEnv({ vivadoPath: "C:\\vivado.bat" }, probeWith(["C:\\vivado.bat"]));
check(!noCacheText.includes("不要污染 RTL 源码目录"), "缓存目录没就绪时,不提产物落盘约定(它落不下去)");

const unreadable = describeEnv(undefined, probeWith([]));
check(unreadable.length > 0 && unreadable.includes("读不到"), "拿不到设置时如实说读不到,而不是当成没配");

// ── 模板:用户提供优先,缺了退回插件自带 ─────────────────────────────────────
//
// 写法规范由模板承载(文件头、九个小节、对齐这些),不写死在技能正文里 —— 所以
// "用哪一份"必须在提示里说清,否则 agent 只能猜,而猜错就是格式不一致。
const bundled = resolveTemplates({}, probeFilesystem);
check(bundled.length === 3, `认三种模板:RTL / 测试平台 / 约束(实际 ${bundled.length})`);
check(
  bundled.every((template) => template.present),
  "插件自带的模板都在包里(少一份,agent 就只能自己编格式)",
  bundled.filter((template) => !template.present).map((template) => template.path).join(", ")
);
check(bundled.every((template) => template.source === "bundled"), "没填模板目录时用自带那份");

const USER_DIR = "C:\\my-templates";
const allUser = resolveTemplates({ templateDir: USER_DIR }, () => true);
check(allUser.every((template) => template.source === "user"), "填了模板目录就优先用用户那份");
check(allUser[0].path === join(USER_DIR, "rtl.sv"), `用户模板按同名文件取(实际 ${allUser[0].path})`);

const mixed = resolveTemplates({ templateDir: USER_DIR }, (path) => path === join(USER_DIR, "tb.sv"));
check(mixed.find((template) => template.kind === "tb").source === "user", "用户目录里有的那份优先用");
check(
  mixed.find((template) => template.kind === "rtl").source === "bundled",
  "用户目录里缺的那份退回自带(而不是报错或留空)"
);

const bundledText = describeEnv(prepared, () => true);
check(bundledText.includes("rtl.sv") && bundledText.includes("插件自带"), "提示里说清模板用哪一份");
const userText = describeEnv(
  { ...prepared, templateDir: USER_DIR },
  (path) => path.startsWith(USER_DIR) || Object.values(prepared).includes(path)
);
check(userText.includes("你提供的"), "用户提供了模板时,提示里标明是他提供的");

// 注册在**模式半侧**:插件行是全局作用域,普通会话也会看到 FPGA 工具链信息
const modeSource = readFileSync(new URL("../lib/mode.js", import.meta.url), "utf8");
check(modeSource.includes("systemPrompt.section("), "模式半侧注册提示段");
check(modeSource.includes('inject = ["systemPrompt"]'), "模式半侧的 inject 是服务名数组(写成对象会让这一行整个不激活)");
check(modeSource.includes("describeEnv(") && modeSource.includes("probeFilesystem"), "模式半侧复用 lib/toolchain.js 的定义,不另写一份文案");
check(!modeSource.includes("child_process") && !modeSource.includes("spawn("), "模式半侧不起进程(命令交给 shell 工具跑)");

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 工具链判定、提示文案与两侧契约全部正确");
if (failures.length > 0) process.exitCode = 1;
