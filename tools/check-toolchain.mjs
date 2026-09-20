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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIELDS,
  NS,
  SWEEP_GRACE_MS,
  DETECT_TARGETS,
  TOOLS,
  backupChangedFiles,
  describeEnv,
  detectTools,
  inspectTools,
  isMissing,
  legacyMigrationPatch,
  listDirectory,
  listFiles,
  presetSyncNeeded,
  probeFilesystem,
  pruneEmptySkillDirs,
  resolveTemplates,
  staleShippedFiles,
  statusOf,
  sweepTempEntries,
  toolLevelPrefix,
  toolPath
} from "../lib/toolchain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// fixture 名带进程号:`npm test` 与 `npm run test:installed` 跑的是**同一批检查**,并行执行时
// 同名目录会互相踩(一个正在写、另一个开头把它扫掉)—— 现象是随机假失败。
const RUN_ID = String(process.pid);
// 自检自己收尾:这些前缀是本次跑出来的 fixture(含列目录用的 browse-fixture),
// 跑到最后要把它们扫干净 —— 开头也扫一次,清掉上次异常退出留下的残留;
// 开头那次带宽限期,免得删掉并行那次正在用的目录。
const TMP_ROOT = join(ROOT, ".tmp");
const FIXTURE_PREFIXES = ["backup-check-", "stale-check-", "prune-skills-", "browse-fixture", "preset-sync-"];
sweepTempEntries(TMP_ROOT, FIXTURE_PREFIXES, SWEEP_GRACE_MS);


const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

/** 桩探测:只有名单里的路径算存在。 */
const probeWith = (present) => (path) => present.includes(path);

/** 类型敏感的桩:目录只在 kind === "directory" 时算存在,文件只在 kind === "file" 时算存在。 */
const probeTyped = (dirs, files) => (path, kind) =>
  kind === "directory" ? dirs.includes(path) : files.includes(path);

/**
 * 缺失判定:用**生产函数**的那一条规则(`isMissing`),不自己复制一份 ——
 * 复制的话改 statusOf 的规则这里照样绿,断言就白写了(审计抓到过)。
 */
const missingKeys = (tools) => tools.filter(isMissing).map((tool) => tool.key);

// ── 字段定义 ────────────────────────────────────────────────────────────────
//
// 布局按用户要求:每个工具一组 —— 先"用哪个"(下拉),下面紧跟它的路径,语言挂在对应工具下。
const KEYS = FIELDS.map((field) => field.key);
const VISIBLE = FIELDS.filter((field) => field.control !== "hidden");
const REQUIRED_FIELDS = FIELDS.filter((field) => field.required === true);
const CHOICE_FIELDS = VISIBLE.filter((field) => field.control === "select");
const OPTIONAL_FIELDS = FIELDS.filter((field) => field.required !== true);
const HIDDEN_FIELDS = FIELDS.filter((field) => field.control === "hidden");
check(KEYS.length === 20, `字段共 20 个:17 个可见 + 3 个隐藏旧键(实际 ${KEYS.length})`);
check(VISIBLE.length === 17, `可见字段 17 个(实际 ${VISIBLE.length})`);
check(
  HIDDEN_FIELDS.map((field) => field.key).join(",") === "verilatorPath,modelsimPath,vivadoPath",
  "三个改名前的旧键作为隐藏字段保留(迁移用)"
);
check(KEYS.includes("cachePath"), "含缓存目录字段");
check(
  REQUIRED_FIELDS.length === 4,
  `四个路径必填:编译器 / 仿真器 / 综合器 / 缓存(实际 ${REQUIRED_FIELDS.length})`
);
check(
  REQUIRED_FIELDS.map((field) => field.key).join(",") === "compilerPath,simulatorPath,synthesizerPath,cachePath",
  "必填的就是那四个路径",
  REQUIRED_FIELDS.map((field) => field.key).join(",")
);
check(
  REQUIRED_FIELDS.every((field) => field.skips.length > 0),
  "每个必填项都写清了没就绪会让哪些能力当前不可执行(否则界面上会出现空的清单)"
);
// 库映射文件必须是**文件**类型:写成目录,设置页就会给它弹文件夹选择框
// (用户实际踩到过:选完 .ini,框里填的是那个文件夹)。
const libraryField = FIELDS.find((field) => field.key === "modelsimIniPath");
check(libraryField?.kind === "file", "库映射文件按文件类型探/选(否则设置页弹的是文件夹框)");
check(
  libraryField?.required === false && (libraryField?.skips ?? []).length === 0,
  "库映射文件不挡路:缺了用安装目录那份,不报成「当前不可执行」"
);
check(
  OPTIONAL_FIELDS.every((field) => field.skips.length === 0),
  "可选字段不报'会跳过什么'(它缺了并不跳过任何环节)"
);
const GROUPS = [...new Set(VISIBLE.map((field) => field.group))];
check(GROUPS.length === 7, `可见的分组恰好七个(实际 ${GROUPS.join("、")})`);
check(
  GROUPS.join(",") === "终端工具,脚本工具,编译工具,仿真工具,综合工具,库与缓存,模板",
  `分组按重要性排:终端 → 脚本 → 编译 → 仿真 → 综合 → 库与缓存 → 模板(实际 ${GROUPS.join(" → ")})`
);
// 每个工具组里:先"用哪个",紧跟它的路径 —— 这是用户要的排列
const ORDER = VISIBLE.map((field) => field.key);
for (const [choice, path] of [["compiler", "compilerPath"], ["simulator", "simulatorPath"], ["synthesizer", "synthesizerPath"]]) {
  check(ORDER.indexOf(path) === ORDER.indexOf(choice) + 1, `${choice} 后面紧跟 ${path}`);
}
check(CHOICE_FIELDS.length === 7, `七个下拉:三类工具 + 终端 + 脚本 + RTL 语言 + 仿真语言(实际 ${CHOICE_FIELDS.length})`);
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
check(empty.length === 20, "空设置也返回全部字段");
check(
  empty.filter((tool) => tool.control !== "select").every((tool) => tool.configured === false && tool.present === false),
  "空设置下所有路径字段都未配置且不可用"
);
check(
  empty.filter((tool) => tool.control === "select").every((tool) => tool.present === true && tool.path === tool.default),
  "下拉字段空值也拿得到默认值,且判为合法"
);
check(missingKeys(empty).length === 4, "空设置下四项必填都算未就绪");

// 旧键兜底:改名不能让用户已经填好的路径消失
const migrated = inspectTools(
  { verilatorPath: "C:\\old\\verilator_bin.exe", modelsimPath: "C:\\old\\vsim.exe", vivadoPath: "C:\\old\\vivado.bat" },
  probeWith(["C:\\old\\verilator_bin.exe", "C:\\old\\vsim.exe", "C:\\old\\vivado.bat"])
);
const migratedByKey = new Map(migrated.map((tool) => [tool.key, tool]));
check(migratedByKey.get("compilerPath")?.path === "C:\\old\\verilator_bin.exe", "旧 verilatorPath 落到 compilerPath");
check(migratedByKey.get("simulatorPath")?.path === "C:\\old\\vsim.exe", "旧 modelsimPath 落到 simulatorPath");
check(migratedByKey.get("synthesizerPath")?.path === "C:\\old\\vivado.bat", "旧 vivadoPath 落到 synthesizerPath");
check(missingKeys(migrated).join(",") === "cachePath", "迁移后只剩没填过的那一项未就绪");

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

// 路径类型随所选工具变:XSim 要的是 Vivado 的 bin **目录**(xvlog/xelab/xsim 三个命令都在里面),
// ModelSim 要的是 vsim.exe。类型错了设置页会给 XSim 弹文件选择框,填个同名文件也会被判成"已就绪"。
const xsimTools = new Map(
  inspectTools({ simulator: "xsim", simulatorPath: "C:\\Xilinx\\Vivado\\bin" }, probeTyped(["C:\\Xilinx\\Vivado\\bin"], []))
    .map((tool) => [tool.key, tool])
);
check(xsimTools.get("simulatorPath")?.kind === "directory", "选 XSim:仿真器路径按目录判定(设置页要弹目录选择框)");
check(xsimTools.get("simulatorPath")?.present === true, "选 XSim + 填了存在的 bin 目录 → 就绪");
check(
  inspectTools(
    { simulator: "xsim", simulatorPath: "C:\\Xilinx\\Vivado\\bin\\xsim.bat" },
    probeTyped([], ["C:\\Xilinx\\Vivado\\bin\\xsim.bat"])
  ).find((tool) => tool.key === "simulatorPath")?.present === false,
  "选 XSim 却填了个文件 → 未就绪(那个路径里没有 xvlog/xelab/xsim)"
);
const modelsimTools = new Map(
  inspectTools({ simulator: "modelsim", simulatorPath: "C:\\modeltech64\\win64\\vsim.exe" }, probeTyped([], ["C:\\modeltech64\\win64\\vsim.exe"]))
    .map((tool) => [tool.key, tool])
);
check(modelsimTools.get("simulatorPath")?.kind === "file", "选 ModelSim:仍按文件判定(默认姿势不变)");
check(modelsimTools.get("simulatorPath")?.present === true, "选 ModelSim + 填了存在的 vsim.exe → 就绪");

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
  missingKeys(partial).join(",") === "compilerPath,simulatorPath,cachePath",
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
const prepared = { vivadoPath: "C:\\v", modelsimPath: "C:\\m", verilatorPath: "C:\\t", modelsimIniPath: "C:\\l\\modelsim.ini", cachePath: "C:\\c" };
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
check(clientSource.includes("/plugins/fpga-workbench/detect"), "客户端用的检测路由与宿主一致");
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
check(FIELDS.find((field) => field.key === "synthesizerPath")?.hint.includes("quartus_sh.exe"), "综合器说明写了 Quartus 的确切文件名 quartus_sh.exe");
check(FIELDS.find((field) => field.key === "simulatorPath")?.hint.includes("vsim.exe"), "仿真器说明写了确切文件名 vsim.exe");
check(FIELDS.find((field) => field.key === "compilerPath")?.hint.includes("verilator_bin.exe"), "编译器说明写了确切文件名 verilator_bin.exe");
// 客户端要按宿主返回的 skips 显示"当前不可执行哪些能力",不能自己另写一份清单
// (只检查几个只可能来自宿主的步骤名,别用"综合"这种会撞上提示文案的词)
check(clientSource.includes("skips"), "客户端用宿主返回的 skips 渲染提示");
for (const step of ["比特流生成", "RTL 功能仿真", "厂商原语仿真"]) {
  check(!clientSource.includes(step), `客户端没有硬编码步骤「${step}」(必须来自宿主)`);
}
// 取不到状态接口时必须说出来 —— 字段定义也来自那里,否则界面会是一片空白,
// 看起来像插件没装好,而其实只是那条路由没答上来。
check(clientSource.includes("failed"), "客户端在拿不到状态接口时会给出说明(否则就是空白页)");
// 写入模型:改动先留在页面上,点「保存改动」才**一次原子提交**(scope.mutate 多字段)。
// 逐字段写的老做法已经删掉 —— 它会出现"存了三个、第四个失败"的半吊子状态。
check(
  clientSource.includes("scope.mutate(ops)") && clientSource.includes('op: "set"'),
  "保存走一次原子提交(scope.mutate 多字段,不是逐字段写)"
);
check(
  /const missed = keys\.filter/u.test(clientSource),
  "保存成败靠比对宿主刷新后的值(宿主拒收时 mutate 也正常结算,等它报错是等不到的)"
);
check(
  clientSource.includes("const [drafts, setDrafts]") && clientSource.includes("有未保存的改动"),
  "改动先记在页面上并标出「有未保存的改动」,点保存才落地"
);
check(clientSource.includes("放弃改动"), "能丢弃未保存的改动(误改不用凭记忆打回原值)");
check(
  clientSource.includes("onToolChange(field.key, next, pathKey)"),
  "换工具时联动换它管着的那条路径"
);
check(clientSource.includes("保存失败:"), "提交抛错时显示保存失败(否则用户以为已经生效)");
check(
  clientSource.includes("路径不可用 —— ") && clientSource.includes("field.blankNote"),
  "填了却用不了时:说清它现在不生效,并带上宿主给的留空后果"
);
// 文件字段**只认文件**:目录也算"可用"的话,提示段会照着它拼出一条跑不通的命令行
// (用户实际把 C:\msys64\mingw64\bin 填进了「编译器路径」)。
check(
  probeFilesystem(ROOT, "file") === false && probeFilesystem(ROOT, "directory") === true,
  "目录填进文件字段 → 不可用(不允许「只要存在就算」)"
);
check(clientSource.includes("预设同步失败"), "预设同步失败在设置页可见(否则只躺在日志里)");
check(
  !clientSource.includes("检测本组工具") && clientSource.includes("detectNote"),
  "没有「检测」按钮:检测在打开页面与换工具时自动跑,结论写在各自那一行下面"
);
check(clientSource.includes("没检测到"), "选中的工具没找到路径时就地说明(不回声用户原来填的那条)");
check(
  clientSource.includes('option?.value === "none"') && clientSource.includes("不用这个工具"),
  "选了「不用」的字段:不再检测、也不再显示未就绪"
);
check(
  clientSource.includes("selectedOptionOf") && clientSource.includes("hit.option === option.value"),
  "检测结果按**当前选中的工具**筛(未保存的换工具也算)"
);
// "留空的后果"必须由宿主说:模板是"用自带那份"、库映射文件是"用安装目录那份"、运行时是"按 PATH 找"。
// 客户端原来自己编一句「留空即用自带」—— 对后两类是错话,用户在设置页上实际看到了。
check(
  !clientSource.includes("留空即用自带"),
  "客户端不再硬编码「留空即用自带」(否则库映射文件/运行时那两行都是错话)"
);
check(
  libraryField?.blankNote === "留空用安装目录那份" &&
    FIELDS.find((field) => field.key === "rtlTemplatePath")?.blankNote === "留空即用自带",
  "两类可选字段的留空后果各说各的(库映射文件 ≠ 模板)"
);
check(clientSource.includes("可能是旧的"), "来自 PATH 的命中标明可信度低(不能与厂商安装位置一个说法)");

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
const hostSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
check(!hostSource.includes("systemPrompt"), "宿主不注册 systemPrompt 段");
// 状态要跟着**页面上那一份**走:带查询串问一次 = 预演未保存的改动;桌面壳由宿主告知页面
// (靠页面嗅探 UA 实测会失效 —— 在 DSH Desktop 里被当成普通浏览器,退了页面内列表)。
check(
  hostSource.includes("pendingOverrides"),
  "状态路由能预演未保存的改动(带查询串问一次,不必先保存)"
);
check(
  clientSource.includes("setPreview") && clientSource.includes("?${query.toString()}"),
  "设置页为未保存的改动预演一次状态(不必先保存才看得见就绪与否)"
);
// 「浏览…」不再弹系统窗口(用户口径:弹窗出过好几回问题;而且这种外壳里它给不出真实路径)。
// 一律用页面内列表 —— 所以客户端里不该再有"借文件框弹框"那条路。
check(
  !clientSource.includes("webkitdirectory") && !clientSource.includes('createElement("input")'),
  "不再弹系统文件框(一律用页面内列表)"
);
check(
  clientSource.includes("force.includes(entry.key)") && clientSource.includes("runDetect({ [selectKey]: option }"),
  "换工具就去重跑检测并把那条路径**强制**跟着换(没检测到就清空)"
);

// ── 会话提示(只有本模式看得到) ──────────────────────────────────────────────
//
// 这一段是"用户填的路径真的被用起来"的落点:已就绪的路径与调用姿势原样交给 agent,
// 未就绪的说清是没填还是填错、以及哪些能力当前不可执行。断言的是三种状态的**措辞必须不同** ——
// 把它们写成同一句"未配置",agent 就分不清该去填还是该去改。
const readyText = describeEnv(prepared, probeWith(Object.values(prepared)));
check(readyText.includes(prepared.vivadoPath), "提示里给出 Vivado 的真实路径");
check(readyText.includes("-mode batch"), "提示里给出 Vivado 的非交互调用方式");
check(readyText.includes(prepared.modelsimPath) && readyText.includes("-c -do"), "提示里给出 ModelSim 的命令行调用方式");
check(readyText.includes("--lint-only"), "提示里给出 Verilator 的 lint 调用方式");
check(!readyText.includes("未就绪"), "全部就绪时不出现未就绪清单");
// 产物落点的分工:大型可再生的进缓存目录,结论要指着的留在环节目录 —— 两处说法必须一致
// (曾经提示段写"所有中间产物只写缓存",技能又要求日志/波形留在 verif/,用的人不知道该信哪条)
check(
  readyText.includes(prepared.cachePath) && readyText.includes("大型可再生的东西") &&
    readyText.includes("留在各自环节目录"),
  "提示里写明产物落点的分工(缓存目录 vs 环节目录)"
);
check(readyText.includes("where"), "提示里写明权威来源,不让 agent 去 PATH 猜");

const halfText = describeEnv({ vivadoPath: "C:\\vivado.bat" }, probeWith([]));
check(halfText.includes("路径不可用(C:\\vivado.bat)"), "填了但用不了:说清原因(不存在,或类型不对)");
check(halfText.includes("编译器路径:未配置"), "没填的项:说成未配置(要去填)");
check(halfText.includes("比特流生成"), "未就绪时带上当前不可执行的能力");

const noCacheText = describeEnv({ vivadoPath: "C:\\vivado.bat" }, probeWith(["C:\\vivado.bat"]));
check(!noCacheText.includes("大型可再生的东西"), "缓存目录没就绪时,不提产物落盘约定(它落不下去)");

const unreadable = describeEnv(undefined, probeWith([]));
check(unreadable.length > 0 && unreadable.includes("读不到"), "拿不到设置时如实说读不到,而不是当成没配");

// ── 浏览:列目录(设置页「浏览…」靠它) ──────────────────────────────────────
const browseRoot = join(TMP_ROOT, `browse-fixture-${RUN_ID}`);
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

// ── 一键检测:只认厂商安装位置,PATH 命中单独标来源 ──────────────────────────
//
// 为什么这么设计:当年删掉的那版是**猜 PATH** —— 实测探测值指着一个已删除的目录,
// agent 照着不存在的路径去调工具。所以:known 优先、path 标注可信度、多候选不自动选。
const fakeEnv = { ProgramFiles: "C:\\PF", LocalAppData: "C:\\LA", PATH: "C:\\bin;C:\\old" };
const listStub = (dirs) => (dir) => dirs[dir] ?? [];
const detectProbe = (paths) => (path) => paths.includes(path);

const knownHit = detectTools(
  detectProbe(["C:\\modeltech64_2020.4\\win64\\vsim.exe"]),
  listStub({ "C:\\": ["modeltech64_2020.4", "Windows"] }),
  fakeEnv
);
check(
  knownHit.some(
    (hit) =>
      hit.field === "simulatorPath" &&
      hit.option === "modelsim" &&
      hit.path === "C:\\modeltech64_2020.4\\win64\\vsim.exe" &&
      hit.source === "known"
  ),
  "检测:厂商安装位置(模式展开)里的 ModelSim 命中,来源标 known"
);

const pathHit = detectTools(detectProbe(["C:\\bin\\vsim.exe"]), listStub({ "C:\\": [] }), fakeEnv);
check(
  pathHit.some((hit) => hit.path === "C:\\bin\\vsim.exe" && hit.source === "path"),
  "检测:只在 PATH 上找到时照样报出来,但来源标 path(页面会写「可能是旧的」)"
);

const bothHit = detectTools(
  detectProbe(["C:\\modeltech64_2020.4\\win64\\vsim.exe", "C:\\bin\\vsim.exe"]),
  listStub({ "C:\\": ["modeltech64_2020.4"] }),
  fakeEnv
);
const modelsimHits = bothHit.filter((hit) => hit.option === "modelsim");
check(
  modelsimHits.length === 1 && modelsimHits[0].source === "known",
  "检测:有厂商安装位置命中时,不报同一工具的 PATH 命中(免得旧副本顶掉真安装)"
);

const xsimHit = detectTools(
  detectProbe(["C:\\AMDDesignTools\\2025.2\\Vivado\\bin\\xvlog.bat"]),
  listStub({ "C:\\": ["AMDDesignTools"], "C:\\AMDDesignTools": ["2025.2"] }),
  fakeEnv
);
check(
  xsimHit.some((hit) => hit.option === "xsim" && hit.path === "C:\\AMDDesignTools\\2025.2\\Vivado\\bin"),
  "检测:XSim 报的是 bin 目录(那个字段本来就是目录,不是 xvlog.bat)"
);

const pwshHit = detectTools(
  detectProbe(["C:\\PF\\PowerShell\\7\\pwsh.exe"]),
  listStub({ "C:\\PF\\PowerShell": ["7"] }),
  fakeEnv
);
check(
  pwshHit.some(
    (hit) => hit.field === "pwshPath" && hit.path === "C:\\PF\\PowerShell\\7\\pwsh.exe" && hit.option === "pwsh"
  ),
  "检测:PowerShell 7 按 %ProgramFiles% 展开找到(带选项标记,好让设置页按「不用」筛)"
);

const pythonHit = detectTools(
  detectProbe(["C:\\PF\\Python314\\python.exe"]),
  listStub({ "C:\\PF": ["Python314"] }),
  fakeEnv
);
check(
  pythonHit.some((hit) => hit.field === "pythonPath" && hit.path === "C:\\PF\\Python314\\python.exe"),
  "检测:Python 3 按 Python3* 匹配到版本目录(不写死版本号)"
);

// 每个具体工具(选项里不是"其他"、也不是"不用"的)都必须在检测表里有对应项。这条守卫来自一次真实遗漏:
// 下拉里有 Quartus、检测表里没有 —— 界面上写着"支持它",一键检测却对它无能为力。
for (const [selectKey, pathKey] of [
  ["compiler", "compilerPath"],
  ["simulator", "simulatorPath"],
  ["synthesizer", "synthesizerPath"],
  ["pwsh", "pwshPath"],
  ["python", "pythonPath"]
]) {
  const options = FIELDS.find((field) => field.key === selectKey)?.options ?? [];
  const missing = options
    .filter(
      (option) =>
        option.value !== "other" &&
        option.value !== "none" &&
        !DETECT_TARGETS.some((target) => target.option === option.value && target.field === pathKey)
    )
    .map((option) => option.value);
  check(missing.length === 0, `${selectKey} 的每个具体工具都在检测表里(漏:${missing.join("、") || "无"})`);
}

// 每个下拉都要有「不用(本机没有这个工具)」:让用户能明确说"这台没有" —— 于是那个字段空着
// 也不算未就绪,检测也不再反复提醒"没检测到路径"(用户口径:这样就不必一直去探有没有工具)。
for (const key of ["compiler", "simulator", "synthesizer"]) {
  const options = FIELDS.find((field) => field.key === key)?.options ?? [];
  check(options.some((option) => option.value === "none"), `${key} 有「不用」选项`);
}
check(
  statusOf({ compiler: "none" }).missing.includes("compilerPath") === false,
  "选了「不用」:statusOf 的缺失清单里没有它(那是用户的决定,不是没配好)"
);
check(
  describeEnv({ compiler: "none" }, probeWith([])).includes("用户已说明本机没有"),
  "选了「不用」:提示段如实说本机没有它,而不是列进「当前不可执行」"
);

const quartus64 = detectTools(
  detectProbe(["C:\\altera\\13.0sp1\\quartus\\bin64\\quartus_sh.exe", "C:\\altera\\13.0sp1\\quartus\\bin\\quartus_sh.exe"]),
  listStub({ "C:\\": ["altera"], "C:\\altera": ["13.0sp1"] }),
  fakeEnv
);
check(
  quartus64.filter((hit) => hit.option === "quartus").length === 1 &&
    quartus64.some((hit) => hit.path === "C:\\altera\\13.0sp1\\quartus\\bin64\\quartus_sh.exe"),
  "检测:Quartus 认 altera\\<版本>\\quartus\\bin64;bin64 与 bin 同时在时只报 bin64(同一个工具不列两遍)"
);

const quartus32 = detectTools(
  detectProbe(["C:\\altera\\13.0sp1\\quartus\\bin\\quartus_sh.exe"]),
  listStub({ "C:\\": ["altera"], "C:\\altera": ["13.0sp1"] }),
  fakeEnv
);
check(
  quartus32.some((hit) => hit.option === "quartus" && hit.path === "C:\\altera\\13.0sp1\\quartus\\bin\\quartus_sh.exe"),
  "检测:只有 32 位 bin 的老版本(Quartus II 13)也认(fallback 那一组)"
);

// 检测**不回声用户填的值**:已保存的设置和页面上未保存的改动可能不是一回事(用户刚换了
// 工具还没保存)。宿主回声旧值,现象就是"换完工具点检测,报的还是我原来填的那条路径"。
// 按当前选中的工具筛选、以及"填没填",由设置页做(它才看得到未保存的改动)。
//
// ⚠️ 这条断言**必须能失败**:以前它传了第 4 个"设置值"参数、而 detectTools 的签名只收
// (probe, list, env) —— 参数被静默忽略,结果恒为 [] → 断言恒真、等于没测(审计抓到的)。
// 现在改成"探得到就必须报出来":PATH 上的 vsim.exe 照样报(来源 path),不存在"回声"这条路。
check(
  detectTools(detectProbe(["C:\\bin\\vsim.exe"]), listStub({ "C:\\": [] }), fakeEnv).some(
    (hit) => hit.field === "simulatorPath" && hit.path === "C:\\bin\\vsim.exe" && hit.source === "path"
  ),
  "检测只报机器上找到的(PATH 命中照样报出来)"
);

check(detectTools(detectProbe([]), listStub({}), { PATH: "" }).length === 0, "检测:什么都没有时返回空(不抛、不猜)");
// 检测只读文件系统,不许起进程 —— 起进程会把"点一下检测"变成"可能挂住"
check(
  !/child_process|execSync|spawnSync|execFile/u.test(readFileSync(new URL("../lib/toolchain.js", import.meta.url), "utf8")),
  "检测不起进程(只读文件系统)"
);

// ── 覆盖用户预设前的备份(用户的地盘不能无条件盖掉) ──────────────────────────
const backupRoot = join(TMP_ROOT, `backup-check-${RUN_ID}-${String(Date.now())}`);
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
const staleRoot = join(TMP_ROOT, `stale-check-${RUN_ID}-${String(Date.now())}`);
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

// 用户自己往预设目录里放的东西(不在 skills/ 下的普通文件)**不参与"要不要同步"的判定** ——
// 否则两棵树永远不一致,每次启动都重同步、重备份一遍(实测就是这么攒出一堆无用备份的)。
const syncRoot = join(TMP_ROOT, `preset-sync-${RUN_ID}`);
const syncSource = join(syncRoot, "source");
const syncTarget = join(syncRoot, "user");
mkdirSync(join(syncSource, "skills", "fpga-module-rtl"), { recursive: true });
mkdirSync(join(syncTarget, "skills", "fpga-module-rtl"), { recursive: true });
writeFileSync(join(syncSource, "preset.yml"), "包内那版\n");
writeFileSync(join(syncTarget, "preset.yml"), "包内那版\n");
writeFileSync(join(syncSource, "skills", "fpga-module-rtl", "SKILL.md"), "技能正文\n");
writeFileSync(join(syncTarget, "skills", "fpga-module-rtl", "SKILL.md"), "技能正文\n");
const syncManifest = listFiles(syncSource);
check(presetSyncNeeded(syncSource, syncTarget, syncManifest) === false, "内容一致 → 不重新同步(幂等)");
writeFileSync(join(syncTarget, "我的笔记.md"), "用户自己放的\n");
check(
  presetSyncNeeded(syncSource, syncTarget, syncManifest) === false,
  "用户加的普通文件不触发重同步(第二次启动不该再同步一遍)"
);
check(
  backupChangedFiles(syncSource, syncTarget, join(syncRoot, "out")) !== undefined,
  "判定不触发同步,但真同步时用户那份仍会被备份(不会弄丢)"
);
writeFileSync(join(syncSource, "preset.yml"), "包内新版\n");
check(presetSyncNeeded(syncSource, syncTarget, syncManifest) === true, "包内文件变了 → 要同步");
writeFileSync(join(syncTarget, "preset.yml"), "包内新版\n");
mkdirSync(join(syncTarget, "skills", "gone"), { recursive: true });
writeFileSync(join(syncTarget, "skills", "gone", "SKILL.md"), "包内已删的旧技能\n");
check(
  presetSyncNeeded(syncSource, syncTarget, [...syncManifest, "skills/gone/SKILL.md"]) === true,
  "包内已删的旧技能还在 → 要同步(否则弃用技能照样被加载)"
);

// 删完文件还要收掉空目录:只 unlink 会在用户预设里留下一串空壳技能目录(实测遇到过 9 个),
// 列表里看着像"技能还在"。只删 skills/ 下的空目录,用户自己建的东西不碰。
const pruneRoot = join(TMP_ROOT, `prune-skills-${RUN_ID}-${String(Date.now())}`);
mkdirSync(join(pruneRoot, "旧技能"), { recursive: true });
mkdirSync(join(pruneRoot, "有内容的技能"), { recursive: true });
writeFileSync(join(pruneRoot, "有内容的技能", "SKILL.md"), "还在用\n");
const removedDirs = pruneEmptySkillDirs(pruneRoot);
check(removedDirs === 1 && !existsSync(join(pruneRoot, "旧技能")), `空技能目录被删掉(实际删了 ${removedDirs} 个)`);
check(existsSync(join(pruneRoot, "有内容的技能", "SKILL.md")), "有内容的技能目录不动");
check(pruneEmptySkillDirs(join(ROOT, ".tmp", "根本没有这个目录")) === 0, "目录不存在时返回 0(不抛)");

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
  // 断言 XSim 自己的三个命令 —— 别用"同目录"这种词:编译器那句 usage 里也有,会假通过
  xsimText.includes("xvlog") && xsimText.includes("xelab") && xsimText.includes("-runall"),
  "选 XSim 时提示里换成 xvlog / xelab / xsim 三步"
);
check(
  // 只留"不含 vsim 的命令"这一半:带上 `|| xsimText.includes("xvlog")` 会恒真 ——
  // 那半边上面那条已经断言过了(审计抓到的恒真断言)。
  !xsimText.includes('vsim.exe" -c -do'),
  "选了 XSim 就不会再拿 vsim 的命令糊弄"
);
// 换工具要跟着换命令:三条 usage 各自绑在选项上
const quartusText = describeEnv({ ...prepared, synthesizer: "quartus" }, () => true);
check(quartusText.includes("quartus_sh"), "换综合器后提示里换成对应工具的命令");
const iverilogText = describeEnv({ ...prepared, compiler: "iverilog" }, () => true);
check(iverilogText.includes("-g2012"), "换编译器后提示里换成对应工具的命令");
// 仿真器下拉没有 Verilator(用户口径:仿真不用它)。它是**编译器**下拉里的选项(RTL lint 用它),
// 所以这条按字段分开断言 —— 只看"提示里有 Verilator"会把两件事混在一起。
const simField = FIELDS.find((field) => field.key === "simulator");
const simValues = (simField?.options ?? []).map((option) => option.value);
check(
  !simValues.includes("verilator") && simValues.includes("modelsim") && simValues.includes("xsim"),
  `仿真器下拉只有 ModelSim / XSim(实际:${simValues.join("、") || "无"})`
);
const compilerField = FIELDS.find((field) => field.key === "compiler");
check(
  (compilerField?.options ?? []).some((option) => option.value === "verilator"),
  "编译器下拉里保留 Verilator(RTL 环节的 lint 用它)"
);
const vhdlText = describeEnv({ ...prepared, rtlLangStd: "vhdl-2008" }, () => true);
check(vhdlText.includes("VHDL-2008") && vhdlText.includes(".vhd"), "换语言后扩展名跟着变");

// 注册在**模式半侧**:插件行是全局作用域,普通会话也会看到 FPGA 工具链信息
const modeSource = readFileSync(new URL("../lib/mode.js", import.meta.url), "utf8");
check(modeSource.includes("systemPrompt.section("), "模式半侧注册提示段");
check(modeSource.includes('inject = ["systemPrompt"]'), "模式半侧的 inject 是服务名数组(写成对象会让这一行整个不激活)");
check(modeSource.includes("describeEnv(") && modeSource.includes("probeFilesystem"), "模式半侧复用 lib/toolchain.js 的定义,不另写一份文案");
check(!modeSource.includes("child_process") && !modeSource.includes("spawn("), "模式半侧不起进程(命令交给 shell 工具跑)");

// 自带命令按**级别 + 环节**分,两者都要一眼看出来(用户要求:不要跨级别或跨环节混用)。
// 以前是 init-scaffold / new-file / check-rtl 这种通用名,看不出归属;级别后来才落到目录上
// (tools/module/ 与 tools/project/),命令名本身仍然只看得出环节 —— 所以两条都要断言。
const STAGE_PREFIX = { "规格环节": "spec-", "RTL 环节": "rtl-", "验证环节": "verif-" };
const LEVELS = ["module", "project", "shared"];
check(
  TOOLS.every((tool) => typeof tool.stage === "string" && tool.stage !== ""),
  "每个自带命令都标了属于哪个环节"
);
check(
  TOOLS.every((tool) => LEVELS.includes(tool.level)),
  `每个自带命令都标了级别(module / project / shared;实际:${[...new Set(TOOLS.map((tool) => String(tool.level)))].join("、")})`
);
const prefixViolations = TOOLS.filter((tool) => {
  const prefix = STAGE_PREFIX[tool.stage];
  // 两级共用的命令不带级别前缀,也就不参与"级别+环节"的拼接检查
  if (prefix === undefined || tool.level === "shared") return false;
  // 命令名形如 module-rtl-new / module-verif-wave:级别前缀之后紧跟环节前缀
  return !tool.file.startsWith(`${toolLevelPrefix(tool)}${prefix}`);
});
check(
  prefixViolations.length === 0,
  `命令名带环节前缀(不合规:${prefixViolations.map((tool) => `${tool.file}(${tool.stage})`).join("、") || "无"})`
);
check(new Set(TOOLS.map((tool) => tool.file)).size === TOOLS.length, "同一命令不重复登记");
check(
  !TOOLS.some((tool) => /new-file|stamp/u.test(tool.file)),
  "起文件的命令按环节分开(module-rtl-new / module-verif-new),不是一个大而全的通用入口"
);
check(
  TOOLS.every((tool) => !tool.file.includes("/") && !tool.file.includes("\\")),
  "命令名本身不带路径(级别靠名字前缀与 tools/<级别>/ 目录两处表示)"
);
// 级别要落到真实目录上:module 的必须在 tools/module/、project 的在 tools/project/、
// shared 的在 tools/ 顶层 —— 这样"拿错级别的命令"在文件系统上就不存在。
const wrongDir = TOOLS.filter((tool) => {
  const expected = tool.level === "module" ? "module" : tool.level === "project" ? "project" : "";
  return !toolPath(tool).includes(join("tools", expected, tool.file));
});
check(
  wrongDir.length === 0,
  `命令都放在自己级别的目录里(不合规:${wrongDir.map((tool) => `${tool.file}(${tool.level})`).join("、") || "无"})`
);
check(
  TOOLS.every((tool) => existsSync(toolPath(tool))),
  "每个登记的命令文件都在(路径按级别拼得出来)"
);
// 命令名**自带级别前缀**(module- / project-),两级共用的不加 —— 用户口径:靠名字防误用,
// 而不是靠路径。这条与"级别目录"是两件事,都要守:名字写错照样会把模块级命令用进工程流程。
const prefixWrong = TOOLS.filter((tool) => !tool.file.startsWith(toolLevelPrefix(tool)));
check(
  prefixWrong.length === 0,
  `命令名带级别前缀(不合规:${prefixWrong.map((tool) => `${tool.file}(${tool.level})`).join("、") || "无"})`
);
check(
  TOOLS.filter((tool) => tool.level === "shared").every((tool) => !/^(module|project)-/u.test(tool.file)),
  "两级共用的命令不加级别前缀(加了反而误导)"
);
// 文档与技能里写的路径必须**带级别**:`tools/<环节>.mjs` 这种旧写法会让调用方少一层目录,
// 而且看不出这条命令属于哪一级。
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const documented = [
  ["README.md", readFileSync(join(rootDir, "README.md"), "utf8")],
  ...TOOLS.map((tool) => [`${tool.file} 的说明`, String(tool.what ?? "")])
];
const levelMissing = documented.filter(([, text]) => {
  // 只看"tools/<级别>/<级别>-*.mjs"这种路径形态:目录或文件名漏了级别都算
  for (const match of text.matchAll(/tools\/((?:module|project)\/)?((?:module|project)-)?[a-z-]*\.mjs/gu)) {
    const [, dir, prefix] = match;
    if (dir === undefined && prefix === undefined) continue; // 两级共用的,不看
    if (dir === undefined || prefix === undefined) return true;
  }
  return false;
});
check(
  levelMissing.length === 0,
  `文档里的命令路径都带级别目录与级别前缀(漏:${levelMissing.map(([name]) => name).join("、") || "无"})`
);
// 反向:README 里写的路径要真按级别解析得到,而且解析出的文件名与登记一致 —— 这条能抓住
// "路径写错一层"或"文件搬了忘了改文档"。
const readmeText = documented[0][1];
const pathMismatch = [];
for (const match of readmeText.matchAll(/presets\/fpga-workbench\/tools\/((?:module\/|project\/)?)([a-z-]+\.mjs)/gu)) {
  const [, dir, file] = match;
  const tool = TOOLS.find((entry) => entry.file === file);
  if (tool === undefined) {
    pathMismatch.push(`${file}(未登记)`);
    continue;
  }
  const expected = tool.level === "shared" ? "" : `${tool.level}/`;
  if (dir !== expected) pathMismatch.push(`${file}(写在 ${dir || "顶层"},应在 ${expected || "顶层"})`);
  if (!existsSync(toolPath(tool))) pathMismatch.push(`${file}(文件不在)`);
}
check(
  pathMismatch.length === 0 && readmeText.includes("tools/module/"),
  `README 里的命令路径与级别登记一致(问题:${pathMismatch.join("、") || "无"})`
);
// 命令的说明会原样进会话提示,所以落点必须跟代码一致:`verif-new` 走 defaultDestination,
// 模块名会转下划线(UartRx → tb_uart_rx.sv),且落在 verif/(仿真与比对是同一个环节)。
// 这里曾写成 `sim/tb_<模块名>.sv`,照着找会找错文件。
const verifNew = TOOLS.find((tool) => tool.file === "module-verif-new.mjs");
check(
  /verif\/tb_<(模块名下划线形式|snake)>|verif\/tb_uart_rx/u.test(String(verifNew?.what ?? "")),
  "verif-new 的说明写明落点:verif/ 下、模块名转下划线(不是 sim/tb_<模块名>.sv)"
);

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 工具链判定、提示文案与两侧契约全部正确");
if (failures.length > 0) process.exitCode = 1;

// 收尾:把本次的 fixture 目录扫掉,并且**必须扫干净** —— 只提示不删就等于没做,
// 下次跑还会看到一堆残留(这个自检的临时目录以前就是这么攒到上百个的)。
sweepTempEntries(TMP_ROOT, FIXTURE_PREFIXES);
const leftOver = readdirSync(TMP_ROOT, { withFileTypes: true })
  .filter((entry) => FIXTURE_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
  .map((entry) => entry.name);
if (leftOver.length > 0) {
  console.log(`FAIL: 收尾没清干净,还剩 ${leftOver.length} 项:${leftOver.join("、")}`);
  process.exitCode = 1;
}
