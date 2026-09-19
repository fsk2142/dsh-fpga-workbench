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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIELDS,
  NS,
  TOOLS,
  backupChangedFiles,
  describeEnv,
  inspectTools,
  legacyMigrationPatch,
  listDirectory,
  listFiles,
  probeFilesystem,
  resolveTemplates,
  staleShippedFiles,
  statusOf
} from "../lib/toolchain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
//
// 布局按用户要求:每个工具一组 —— 先"用哪个"(下拉),下面紧跟它的路径,语言挂在对应工具下。
const KEYS = FIELDS.map((field) => field.key);
const VISIBLE = FIELDS.filter((field) => field.control !== "hidden");
const REQUIRED_FIELDS = FIELDS.filter((field) => field.required === true);
const CHOICE_FIELDS = VISIBLE.filter((field) => field.control === "select");
const OPTIONAL_FIELDS = FIELDS.filter((field) => field.required !== true);
const HIDDEN_FIELDS = FIELDS.filter((field) => field.control === "hidden");
check(KEYS.length === 16, `字段共 16 个:13 个可见 + 3 个隐藏旧键(实际 ${KEYS.length})`);
check(VISIBLE.length === 13, `可见字段 13 个(实际 ${VISIBLE.length})`);
check(
  HIDDEN_FIELDS.map((field) => field.key).join(",") === "verilatorPath,modelsimPath,vivadoPath",
  "三个改名前的旧键作为隐藏字段保留(迁移用)"
);
check(KEYS.includes("cachePath"), "含缓存目录字段");
check(
  REQUIRED_FIELDS.length === 5,
  `五个路径必填:编译器 / 仿真器 / 综合器 / 库 / 缓存(实际 ${REQUIRED_FIELDS.length})`
);
check(
  REQUIRED_FIELDS.map((field) => field.key).join(",") === "compilerPath,simulatorPath,synthesizerPath,libraryPath,cachePath",
  "必填的就是那五个路径",
  REQUIRED_FIELDS.map((field) => field.key).join(",")
);
check(
  REQUIRED_FIELDS.every((field) => field.skips.length > 0),
  "每个必填项都写清了没就绪会跳过哪些步骤(否则界面上会出现空的跳过清单)"
);
check(
  OPTIONAL_FIELDS.every((field) => field.skips.length === 0),
  "可选字段不报'会跳过什么'(它缺了并不跳过任何环节)"
);
const GROUPS = [...new Set(VISIBLE.map((field) => field.group))];
check(GROUPS.length === 5, `可见的分组恰好五个(实际 ${GROUPS.join("、")})`);
check(
  GROUPS.join(",") === "编译器,仿真器,综合器,库与缓存,模板",
  `分组顺序:编译器 → 仿真器 → 综合器 → 库与缓存 → 模板(实际 ${GROUPS.join(" → ")})`
);
// 每个工具组里:先"用哪个",紧跟它的路径 —— 这是用户要的排列
const ORDER = VISIBLE.map((field) => field.key);
for (const [choice, path] of [["compiler", "compilerPath"], ["simulator", "simulatorPath"], ["synthesizer", "synthesizerPath"]]) {
  check(ORDER.indexOf(path) === ORDER.indexOf(choice) + 1, `${choice} 后面紧跟 ${path}`);
}
check(CHOICE_FIELDS.length === 5, `五个下拉:三类工具 + RTL 语言 + 仿真语言(实际 ${CHOICE_FIELDS.length})`);
check(
  CHOICE_FIELDS.every((field) => {
    const options = field.options ?? [];
    return options.length > 1 && options.some((option) => option.value === field.default);
  }),
  "每个下拉都有默认值,且默认值本身是合法选项(否则会被判成取值非法)"
);
check(
  CHOICE_FIELDS.every((field) => (field.options ?? []).every((option) => typeof option.label === "string" && option.label !== "")),
  "下拉选项都写了给人看的标签"
);
check(
  ["compiler", "simulator", "synthesizer"].every((key) =>
    (FIELDS.find((field) => field.key === key)?.options ?? []).every(
      (option) => typeof option.needs === "string" && typeof option.usage === "function"
    )
  ),
  "三类工具的下拉:每个选项都指明用哪个路径字段,并带自己的调用姿势(usage 挂在选项上)"
);
check(FIELDS.every((field) => typeof field.group === "string" && field.group !== ""), "每个字段都有分组(设置页按它分段)");
check(
  CHOICE_FIELDS.every((field) => {
    const options = field.options ?? [];
    return options.length > 1 && options.some((option) => option.value === field.default);
  }),
  "每个下拉都有默认值,且默认值本身是合法选项(否则会被判成取值非法)"
);
check(
  CHOICE_FIELDS.every((field) => (field.options ?? []).every((option) => typeof option.label === "string" && option.label !== "")),
  "下拉选项都写了给人看的标签"
);
check(
  ["compiler", "simulator", "synthesizer"].every((key) =>
    (FIELDS.find((field) => field.key === key)?.options ?? []).every(
      (option) => typeof option.needs === "string" && typeof option.usage === "function"
    )
  ),
  "三类工具的下拉:每个选项都指明用哪个路径字段,并带自己的调用姿势(usage 挂在选项上)"
);

// ── 存在性判定 ──────────────────────────────────────────────────────────────
const empty = inspectTools({}, probeWith([]));
check(empty.length === 16, "空设置也返回全部字段");
check(
  empty.filter((tool) => tool.control !== "select").every((tool) => tool.configured === false && tool.present === false),
  "空设置下所有路径字段都未配置且不可用"
);
check(
  empty.filter((tool) => tool.control === "select").every((tool) => tool.present === true && tool.path === tool.default),
  "下拉字段空值也拿得到默认值,且判为合法"
);
check(missingKeys(empty).length === 5, "空设置下五项必填都算未就绪");

// 旧键兜底:改名不能让用户已经填好的路径消失
const migrated = inspectTools(
  { verilatorPath: "C:\\old\\verilator_bin.exe", modelsimPath: "C:\\old\\vsim.exe", vivadoPath: "C:\\old\\vivado.bat" },
  probeWith(["C:\\old\\verilator_bin.exe", "C:\\old\\vsim.exe", "C:\\old\\vivado.bat"])
);
const migratedByKey = new Map(migrated.map((tool) => [tool.key, tool]));
check(migratedByKey.get("compilerPath")?.path === "C:\\old\\verilator_bin.exe", "旧 verilatorPath 落到 compilerPath");
check(migratedByKey.get("simulatorPath")?.path === "C:\\old\\vsim.exe", "旧 modelsimPath 落到 simulatorPath");
check(migratedByKey.get("synthesizerPath")?.path === "C:\\old\\vivado.bat", "旧 vivadoPath 落到 synthesizerPath");
check(missingKeys(migrated).join(",") === "libraryPath,cachePath", "迁移后只剩没填过的那两项未就绪");

// 光在 valueOf 里兜底是不够的:设置页的输入框读的是**新键的原始值**,只兜底就会
// "框是空的、状态却是绿的"(用户实际抓到的 bug)。所以要把值真的搬过去。
const migration = legacyMigrationPatch({
  verilatorPath: "C:\\old\\verilator_bin.exe",
  modelsimPath: "C:\\old\\vsim.exe",
  vivadoPath: "C:\\old\\vivado.bat"
});
check(
  migration.compilerPath === "C:\\old\\verilator_bin.exe"
    && migration.simulatorPath === "C:\\old\\vsim.exe"
    && migration.synthesizerPath === "C:\\old\\vivado.bat",
  "迁移补丁:旧值写进新键"
);
check(
  migration.verilatorPath === "" && migration.modelsimPath === "" && migration.vivadoPath === "",
  "迁移补丁:同时清空旧键(否则以后清空新字段时旧值会复活)"
);
check(
  Object.keys(legacyMigrationPatch({ compilerPath: "C:\\new\\v.exe", verilatorPath: "C:\\old" })).length === 0,
  "新键已有值时不再迁移(幂等)"
);
check(Object.keys(legacyMigrationPatch({})).length === 0, "没有旧值时不写任何东西(不无谓改用户配置)");
const ownWins = inspectTools({ compilerPath: "C:\\new\\v.exe", verilatorPath: "C:\\old\\v.exe" }, probeWith(["C:\\new\\v.exe"]));
check(ownWins.find((tool) => tool.key === "compilerPath")?.path === "C:\\new\\v.exe", "新键有值时优先用新键(旧键只是兜底)");

const badChoice = inspectTools({ simulator: "not-a-simulator" }, probeWith([]));
check(
  badChoice.find((tool) => tool.key === "simulator")?.present === false,
  "下拉值不在选项里 → 判为不合法(而不是照用)"
);

const partial = inspectTools(
  { vivadoPath: "C:\\vivado.bat", modelsimPath: "C:\\missing\\vsim.exe", cachePath: "C:\\cache" },
  probeWith(["C:\\vivado.bat"])
);
const byKey = new Map(partial.map((tool) => [tool.key, tool]));
check(byKey.get("synthesizerPath")?.present === true, "存在的路径判为可用(旧键迁过来的也算)");
check(
  byKey.get("simulatorPath")?.present === false && byKey.get("simulatorPath")?.configured === true,
  "路径错:已配置但未就绪"
);
check(byKey.get("compilerPath")?.configured === false, "没填的项:未配置");
check(
  missingKeys(partial).join(",") === "compilerPath,simulatorPath,libraryPath,cachePath",
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
//
// 客户端**不再重复一份字段定义**:标签、说明、下拉选项、默认值、分组全部由宿主那条状态
// 路由返回。所以这里不再比"两边 hint 是否逐字一致"(那种重复已经没有),改成断言更强的东西:
// 客户端里**不许出现任何字段名**,它只能照着宿主给的字段渲染。
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
check(clientSource.includes(`"${NS}"`), `客户端命名空间与宿主一致(${NS})`);
check(clientSource.includes("/plugins/fpga-workbench/toolchain"), "客户端用的状态路由与宿主一致");
const hardcoded = KEYS.filter((key) => clientSource.includes(`"${key}"`));
check(hardcoded.length === 0, "客户端没有硬编码任何字段名(定义只存在于宿主)", hardcoded.join(", "));
const hardcodedHints = FIELDS.filter(
  // 空 hint 不算(隐藏旧键的 hint 是空的,而 includes("") 永远为真)
  (field) => field.hint !== "" && clientSource.includes(field.hint.replace(/\\/gu, "\\\\"))
);
check(hardcodedHints.length === 0, "客户端没有硬编码字段说明", hardcodedHints.map((field) => field.key).join(", "));
check(/status\?\.tools|status\.tools/u.test(clientSource), "客户端从宿主返回的 status.tools 渲染字段");
check(clientSource.includes('field.control === "select"'), "客户端会按 control 渲染下拉");
check(clientSource.includes("field.options"), "下拉选项来自宿主");
check(clientSource.includes("field.group"), "分组来自宿主");
check(clientSource.includes('field.control === "hidden"'), "客户端不渲染隐藏字段(改名前的旧键)");
// 说明里要给确切文件名,不能含糊成"可执行文件" —— 真实教训:只写"可执行文件",
// 用户就会去找 Windows 上并不存在的 vivado.exe。
check(FIELDS.find((field) => field.key === "synthesizerPath")?.hint.includes("vivado.bat"), "综合器说明写了确切文件名 vivado.bat");
check(FIELDS.find((field) => field.key === "simulatorPath")?.hint.includes("vsim.exe"), "仿真器说明写了确切文件名 vsim.exe");
check(FIELDS.find((field) => field.key === "compilerPath")?.hint.includes("verilator_bin.exe"), "编译器说明写了确切文件名 verilator_bin.exe");
// 客户端要按宿主返回的 skips 显示"会跳过什么",不能自己另写一份跳过清单
// (只检查几个只可能来自宿主的步骤名,别用"综合"这种会撞上提示文案的词)
check(clientSource.includes("skips"), "客户端用宿主返回的 skips 渲染提示");
for (const step of ["比特流生成", "RTL 功能仿真", "厂商原语仿真"]) {
  check(!clientSource.includes(step), `客户端没有硬编码步骤「${step}」(必须来自宿主)`);
}
// 取不到状态接口时必须说出来 —— 字段定义也来自那里,否则界面会是一片空白,
// 看起来像插件没装好,而其实只是那条路由没答上来。
check(clientSource.includes("failed"), "客户端在拿不到状态接口时会给出说明(否则就是空白页)");
// 写入必须等落地再刷新状态。
// scope.set 是排队的 mutation,不等它就去问宿主会拿到旧值 —— 实机现象是"填完路径要
// 关掉设置再打开才显示已就绪"。这条只能靠源码断言守住:它是时序契约,不是纯逻辑。
check(
  clientSource.includes("return Promise.resolve(pending)"),
  "写入函数把 scope.set 的 promise 返回出去(不等结算就会显示旧状态)"
);
check(/writeField\([\s\S]{0,120}?\.then\(/u.test(clientSource), "刷新状态写在写入结算之后(.then 里)");

// ── 发给设置页的载荷 ────────────────────────────────────────────────────────
//
// statusOf 现在住在零依赖的 toolchain.js 里,所以能直接调 —— 断言的是"设置页需要的
// 字段定义真的发出去了",而不是去 grep 源码。
const payload = statusOf({});
const payloadKeys = Object.keys(payload.tools[0]);
for (const needed of ["key", "label", "hint", "required", "skips", "path", "configured", "present", "group", "control", "options", "default"]) {
  check(payloadKeys.includes(needed), `载荷里有 ${needed}(设置页要靠它渲染)`);
}
check(!payloadKeys.includes("usage"), "载荷里没有 usage(那是提示段专用,设置页用不上)");
check(payload.tools.length === VISIBLE.length, `载荷发全部可见字段、不发隐藏旧键(实际 ${payload.tools.length} / 可见 ${VISIBLE.length})`);
check(
  payload.tools.every((tool) => tool.control !== "hidden"),
  "载荷里没有隐藏字段(设置页不需要,渲染出来只会是几个看不懂的空框)"
);
check(
  payload.tools.filter((tool) => tool.control === "select").every((tool) => Array.isArray(tool.options) && tool.options.length > 0),
  "下拉字段的选项跟着载荷一起发(客户端不在本地维护选项)"
);

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
check(halfText.includes("编译器路径:未配置"), "没填的项:说成未配置(要去填)");
check(halfText.includes("比特流生成"), "未就绪时带上会跳过哪些步骤");

const noCacheText = describeEnv({ vivadoPath: "C:\\vivado.bat" }, probeWith(["C:\\vivado.bat"]));
check(!noCacheText.includes("不要污染 RTL 源码目录"), "缓存目录没就绪时,不提产物落盘约定(它落不下去)");

const unreadable = describeEnv(undefined, probeWith([]));
check(unreadable.length > 0 && unreadable.includes("读不到"), "拿不到设置时如实说读不到,而不是当成没配");

// ── 浏览:列目录(设置页「浏览…」靠它) ──────────────────────────────────────
const browseRoot = join(ROOT, ".tmp", "browse-fixture");
mkdirSync(join(browseRoot, "subdir"), { recursive: true });
writeFileSync(join(browseRoot, "tool.exe"), "");
writeFileSync(join(browseRoot, "readme.txt"), "");

const listing = listDirectory(browseRoot);
check(listing.entries.length >= 3, `列出目录内容(实际 ${listing.entries.length} 项)`);
check(listing.entries[0].kind === "directory", "目录排在文件前面(先看到目录,好往下钻)");
check(
  listing.entries.some((entry) => entry.name === "tool.exe" && entry.kind === "file"),
  "文件也列出来(要选的就是 .exe / .bat)"
);
check(
  listing.entries.some((entry) => entry.name === "subdir" && entry.path === join(browseRoot, "subdir")),
  "条目带完整路径(点了直接能填)"
);
check(listing.parent === join(ROOT, ".tmp"), `给出上级目录(实际 ${String(listing.parent)})`);

const absent = listDirectory(join(browseRoot, "nope"));
check(absent.entries.length === 0 && typeof absent.error === "string", "目录不存在时如实报 error,而不是抛异常");
const drives = listDirectory("");
check(drives.entries.length > 0 && drives.entries.every((entry) => entry.kind === "directory"), "空路径列盘符(从根开始挑)");

// ── 覆盖用户预设前的备份(用户的地盘不能无条件盖掉) ──────────────────────────
const backupRoot = join(ROOT, ".tmp", `backup-check-${String(Date.now())}`);
const backupSource = join(backupRoot, "source");
const backupTarget = join(backupRoot, "user");
mkdirSync(join(backupSource, "skills"), { recursive: true });
mkdirSync(join(backupTarget, "skills"), { recursive: true });
writeFileSync(join(backupSource, "skills", "SKILL.md"), "包内新版\n");
writeFileSync(join(backupSource, "preset.yml"), "一样的内容\n");
writeFileSync(join(backupTarget, "skills", "SKILL.md"), "用户自己改的\n");
writeFileSync(join(backupTarget, "preset.yml"), "一样的内容\n");
writeFileSync(join(backupTarget, "我加的笔记.md"), "用户新增\n");

const backedUp = backupChangedFiles(backupSource, backupTarget, join(backupRoot, "out"));
check(backedUp?.count === 2, `用户改过的与新增的会被备份(实际 ${String(backedUp?.count)} 个)`);
check(
  backedUp.files.some((file) => file.endsWith(join("skills", "SKILL.md")))
    && readFileSync(backedUp.files.find((file) => file.endsWith(join("skills", "SKILL.md"))), "utf8").includes("用户自己改的"),
  "备份下来的是用户那份的内容"
);
check(backedUp.files.some((file) => file.endsWith("我加的笔记.md")), "用户新增的文件也保住(不会被同步弄丢)");
check(!backedUp.files.some((file) => file.endsWith("preset.yml")), "没改动的文件不备份(不制造无用备份)");
check(
  backupChangedFiles(backupSource, backupSource, join(backupRoot, "never")) === undefined,
  "两边一致时不做任何备份"
);
check(
  backupChangedFiles(backupSource, join(backupRoot, "不存在"), join(backupRoot, "never")) === undefined,
  "目标不存在时不做备份"
);

// 我们从包里删掉的文件,用户预设目录里那份要跟着删 —— 否则"删掉的技能"照样在被加载
// (技能是从用户预设目录扫的;cpSync 只合并不删多余的)。
const staleRoot = join(ROOT, ".tmp", `stale-check-${String(Date.now())}`);
const staleSource = join(staleRoot, "source");
const staleTarget = join(staleRoot, "user");
mkdirSync(join(staleSource, "skills", "keep-me"), { recursive: true });
writeFileSync(join(staleSource, "skills", "keep-me", "SKILL.md"), "还在提供的技能\n");
mkdirSync(join(staleTarget, "skills", "keep-me"), { recursive: true });
mkdirSync(join(staleTarget, "skills", "gone"), { recursive: true });
writeFileSync(join(staleTarget, "skills", "keep-me", "SKILL.md"), "还在提供的技能\n");
writeFileSync(join(staleTarget, "skills", "gone", "SKILL.md"), "我们已经删掉的旧技能\n");
writeFileSync(join(staleTarget, "用户自己的笔记.md"), "用户加的\n");

const shippedBefore = ["skills/keep-me/SKILL.md", "skills/gone/SKILL.md"];
const stale = staleShippedFiles(staleSource, staleTarget, shippedBefore);
check(stale.includes("skills/gone/SKILL.md"), "上次是我们写的、包里已删的文件会被清掉", JSON.stringify(stale));
check(!stale.includes("skills/keep-me/SKILL.md"), "包里还提供的文件不动");
check(!stale.includes("用户自己的笔记.md"), "用户自己加的文件不在清单里 → 不删");
check(listFiles(staleSource).join(",") === "skills/keep-me/SKILL.md", "listFiles 给出相对路径且用 / 分隔");

// 技能这类"留着就直接改变 AI 行为"的目录:即使没有清单(第一次升级、或技能刚改名)也要清 ——
// 否则一次改名会让新旧两套技能同时被加载。
const noManifest = staleShippedFiles(staleSource, staleTarget, undefined);
check(noManifest.includes("skills/gone/SKILL.md"), "没有清单时,skills/ 下包内已没有的文件仍然清掉");
check(!noManifest.includes("用户自己的笔记.md"), "没有清单时,清单外且不在 skills/ 下的文件照样不删");
// 清单里记过、但位于 skills/ 之外的(比如旧模板):按清单删
writeFileSync(join(staleTarget, "旧模板.sv"), "包里已经没有的模板\n");
const withManifest = staleShippedFiles(staleSource, staleTarget, [...shippedBefore, "旧模板.sv"]);
check(withManifest.includes("旧模板.sv"), "清单里记过、位于 skills/ 之外的文件按清单删");
check(!staleShippedFiles(staleSource, staleTarget, undefined).includes("旧模板.sv"), "没有清单时不动 skills/ 之外的文件");

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
check(bundled.every((template) => template.source === "bundled"), "没填模板路径时用自带那份");

// 三个模板字段各自独立:填哪个用哪个,互不影响
const USER_RTL = "C:\\my-templates\\rtl.sv";
const USER_TB = "C:\\my-templates\\tb.sv";
const onlyRtl = resolveTemplates({ rtlTemplatePath: USER_RTL }, (path) => path === USER_RTL);
check(onlyRtl.find((template) => template.kind === "rtl").source === "user", "填了 RTL 模板就用用户那份");
check(onlyRtl.find((template) => template.kind === "rtl").path === USER_RTL, "用的是填的那个路径本身(不是同名推断)");
check(
  onlyRtl.filter((template) => template.kind !== "rtl").every((template) => template.source === "bundled"),
  "没填的那两类仍用自带(三个字段互不影响)"
);

const twoOfThree = resolveTemplates({ rtlTemplatePath: USER_RTL, tbTemplatePath: USER_TB }, (path) => [USER_RTL, USER_TB].includes(path));
check(
  twoOfThree.find((template) => template.kind === "xdc").source === "bundled",
  "只填两份时,第三份退回自带"
);

// 填了但文件不在:必须如实报出来 —— 否则用户以为自己那份生效了,实际用的是自带的
const wrong = resolveTemplates({ rtlTemplatePath: "C:\\nope\\rtl.sv" }, probeFilesystem);
const wrongRtl = wrong.find((template) => template.kind === "rtl");
check(wrongRtl.source === "bundled" && wrongRtl.missing === "C:\\nope\\rtl.sv", "填了但找不到 → 退回自带并记下那个路径");
const wrongText = describeEnv(prepared, () => true).length > 0
  ? describeEnv({ ...prepared, rtlTemplatePath: "C:\\nope\\rtl.sv" }, (path) => Object.values(prepared).includes(path))
  : "";
check(wrongText.includes("填的路径不存在"), "提示里点明'填的路径不存在,已退回自带'");

const bundledText = describeEnv(prepared, () => true);
check(bundledText.includes("rtl.sv") && bundledText.includes("插件自带"), "提示里说清模板用哪一份");
const userText = describeEnv(
  { ...prepared, rtlTemplatePath: USER_RTL },
  (path) => path === USER_RTL || Object.values(prepared).includes(path)
);
check(userText.includes("你提供的"), "用户提供了模板时,提示里标明是他提供的");

// ── 语言与仿真器 ────────────────────────────────────────────────────────────
const langText = describeEnv(prepared, () => true);
check(langText.includes("SystemVerilog (IEEE 1800-2017)"), "提示里给出 RTL 语言与标准(默认 SystemVerilog 1800-2017)");
check(langText.includes("仿真语言"), "提示里给出仿真语言");
check(langText.includes("ModelSim / Questa"), "提示里给出仿真器(默认 ModelSim)");
check(langText.includes(".sv"), "提示里给出文件扩展名(写代码时要用)");

const xsimText = describeEnv({ ...prepared, simulator: "xsim" }, () => true);
check(
  // 断言 XSim 自己的三个命令 —— 别用"同目录"这种词:Verilator 那句里也有,会假通过
  xsimText.includes("xvlog") && xsimText.includes("xelab") && xsimText.includes("-runall"),
  "选 XSim 时提示里换成 xvlog / xelab / xsim 三步"
);
check(
  !xsimText.includes("vsim.exe") || xsimText.includes("xvlog"),
  "选了 XSim 就不会再拿 vsim 的命令糊弄"
);
// 换工具要跟着换命令:三条 usage 各自绑在选项上
const quartusText = describeEnv({ ...prepared, synthesizer: "quartus" }, () => true);
check(quartusText.includes("quartus_sh"), "换综合器后提示里换成对应工具的命令");
const iverilogText = describeEnv({ ...prepared, compiler: "iverilog" }, () => true);
check(iverilogText.includes("-g2012"), "换编译器后提示里换成对应工具的命令");
const vhdlText = describeEnv({ ...prepared, rtlLangStd: "vhdl-2008" }, () => true);
check(vhdlText.includes("VHDL-2008") && vhdlText.includes(".vhd"), "换语言后扩展名跟着变");

// 注册在**模式半侧**:插件行是全局作用域,普通会话也会看到 FPGA 工具链信息
const modeSource = readFileSync(new URL("../lib/mode.js", import.meta.url), "utf8");
check(modeSource.includes("systemPrompt.section("), "模式半侧注册提示段");
check(modeSource.includes('inject = ["systemPrompt"]'), "模式半侧的 inject 是服务名数组(写成对象会让这一行整个不激活)");
check(modeSource.includes("describeEnv(") && modeSource.includes("probeFilesystem"), "模式半侧复用 lib/toolchain.js 的定义,不另写一份文案");
check(!modeSource.includes("child_process") && !modeSource.includes("spawn("), "模式半侧不起进程(命令交给 shell 工具跑)");

// 自带命令按环节分,名字带环节前缀(用户要求:一眼看出属于哪个环节,不要跨环节混用)。
// 以前是 init-scaffold / new-file / check-rtl 这种通用名,看不出归属,也容易在错的环节被调用。
const STAGE_PREFIX = { "规格环节": "spec-", "RTL 环节": "rtl-", "验证环节": "verif-" };
check(
  TOOLS.every((tool) => typeof tool.stage === "string" && tool.stage !== ""),
  "每个自带命令都标了属于哪个环节"
);
const prefixViolations = TOOLS.filter((tool) => {
  const prefix = STAGE_PREFIX[tool.stage];
  return prefix !== undefined && !tool.file.startsWith(prefix);
});
check(
  prefixViolations.length === 0,
  `命令名带环节前缀(不合规:${prefixViolations.map((tool) => `${tool.file}(${tool.stage})`).join("、") || "无"})`
);
check(new Set(TOOLS.map((tool) => tool.file)).size === TOOLS.length, "同一命令不重复登记");
check(
  !TOOLS.some((tool) => /new-file|stamp/u.test(tool.file)),
  "起文件的命令按环节分开(rtl-new / verif-new),不是一个大而全的通用入口"
);
check(
  TOOLS.every((tool) => !tool.file.includes("/") && !tool.file.includes("\\")),
  "命令都在工具目录顶层(tools/lib 是内部模块,不算命令)"
);
// 命令的说明会原样进会话提示,所以落点必须跟代码一致:`verif-new` 走 defaultDestination,
// 模块名会转下划线(UartRx → tb_uart_rx.sv),且落在 verif/(仿真与比对是同一个环节)。
// 这里曾写成 `sim/tb_<模块名>.sv`,照着找会找错文件。
const verifNew = TOOLS.find((tool) => tool.file === "verif-new.mjs");
check(
  /verif\/tb_<(模块名下划线形式|snake)>|verif\/tb_uart_rx/u.test(String(verifNew?.what ?? "")),
  "verif-new 的说明写明落点:verif/ 下、模块名转下划线(不是 sim/tb_<模块名>.sv)"
);

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 工具链判定、提示文案与两侧契约全部正确");
if (failures.length > 0) process.exitCode = 1;
