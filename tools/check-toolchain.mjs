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
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINDINGS,
  CAPABILITIES,
  DORMANT_SUFFIX,
  FIELDS,
  NS,
  SETTINGS_SECTIONS,
  STAGES,
  TEMP_GRACE_MS,
  DETECT_TARGETS,
  CLEANUP_KINDS,
  TEMPLATE_FIELDS,
  TOOL_CATALOG,
  TOOL_GROUPS,
  TOOLS,
  backupChangedFiles,
  cleanupEntry,
  describeEnv,
  detectTools,
  dormantTargets,
  inspectTools,
  isDormantPath,
  isMissing,
  legacyMigrationPatch,
  listDirectory,
  listEmptySkillDirs,
  listFiles,
  listTempLeftovers,
  nextManifest,
  existingUnder,
  newlyReportedCleanup,
  nextReportedCleanup,
  nonRegularOverwriteTargets,
  presetFileDiff,
  presetSyncNeeded,
  probeFilesystem,
  queryVersion,
  readdirNames,
  resolveBinding,
  resolveBindings,
  resolveCapability,
  resolveCapabilityTemplates,
  resolveCapabilities,
  resolveTemplates,
  staleShippedFiles,
  statusOf,
  toolLevelPrefix,
  toolPath
} from "../lib/toolchain.js";
import {
  BUNDLED_TEMPLATE_ROOT,
  BUILTIN_TEMPLATES,
  MAX_TEMPLATES_PER_CATEGORY,
  TEMPLATE_CATEGORIES,
  resolveTemplateSelection,
  scanTemplates
} from "../lib/template-library.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// fixture 名带进程号:`npm test` 与 `npm run test:installed` 跑的是**同一批检查**,并行执行时
// 同名目录会互相踩(一个正在写、另一个把它当成上一轮的残留)。
const RUN_ID = String(process.pid);
// .tmp/ 里的 fixture **不再删除**(用户定案:绝不永久删除)—— 只列出来报给使用者处置。
// 代价是 `.tmp/` 会一直增长,所以开头把上次留下的列一次,让人看得见它有多少。
const TMP_ROOT = join(ROOT, ".tmp");
const FIXTURE_PREFIXES = ["backup-check-", "stale-check-", "prune-skills-", "browse-fixture", "preset-sync-", "sweep-check-", "template-library-"];
const leftoversAtStart = listTempLeftovers(TMP_ROOT, FIXTURE_PREFIXES);
if (leftoversAtStart.length > 0) {
  console.log(`(.tmp/ 里有 ${leftoversAtStart.length} 项上次留下的 fixture,按用户定案不删除、只报告)`);
}

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// ── 分类模板库:扫描边界、稳定 id 与“缺失不回退” ─────────────────────────────
//
// 夹具故意留在 .tmp/ 中(本仓库的零删除约定)。每次用 PID 分开，避免并行自检互相踩。
const TEMPLATE_LIBRARY_FIXTURE = join(TMP_ROOT, `template-library-${RUN_ID}`);
mkdirSync(join(TEMPLATE_LIBRARY_FIXTURE, "rtl", "vendor"), { recursive: true });
mkdirSync(join(TEMPLATE_LIBRARY_FIXTURE, "rtl", "zz-many"), { recursive: true });
writeFileSync(join(TEMPLATE_LIBRARY_FIXTURE, "root-level-legacy.sv"), "// 不应扫描根目录文件\n");
writeFileSync(join(TEMPLATE_LIBRARY_FIXTURE, "rtl", "vendor", "custom.sv"), "module custom; endmodule\n");
writeFileSync(join(TEMPLATE_LIBRARY_FIXTURE, "rtl", ".hidden.sv"), "module hidden; endmodule\n");
writeFileSync(join(TEMPLATE_LIBRARY_FIXTURE, "rtl", "scratch.sv.tmp"), "module temporary; endmodule\n");
for (let index = 0; index <= MAX_TEMPLATES_PER_CATEGORY; index += 1) {
  writeFileSync(join(TEMPLATE_LIBRARY_FIXTURE, "rtl", "zz-many", `${String(index).padStart(3, "0")}.sv`), "// fixture\n");
}

const outsideTemplateFixture = join(TMP_ROOT, `template-library-outside-${RUN_ID}`);
mkdirSync(outsideTemplateFixture, { recursive: true });
writeFileSync(join(outsideTemplateFixture, "escaped.sv"), "module escaped; endmodule\n");
let templateLinkCreated = false;
try {
  symlinkSync(outsideTemplateFixture, join(TEMPLATE_LIBRARY_FIXTURE, "rtl", "linked"), "junction");
  templateLinkCreated = true;
} catch {
  // 某些 Windows 策略不允许测试进程创建 junction；其余扫描边界仍照常验证。
}

const scannedModuleRtl = scanTemplates({
  capability: "module-rtl",
  capabilities: CAPABILITIES,
  libraryRoot: TEMPLATE_LIBRARY_FIXTURE
});
const scannedRtlGroup = scannedModuleRtl.groups.find((group) => group.key === "rtl");
check(
  TEMPLATE_CATEGORIES.length === 12,
  `模板库固定十二类(编译与运行合并为一类;模块与工程的综合、约束各有一份内置,实际 ${String(TEMPLATE_CATEGORIES.length)} 类)`
);
check(
  BUILTIN_TEMPLATES.some((item) => item.id === "builtin:rtl/systemverilog-module.sv") &&
    BUILTIN_TEMPLATES.some((item) => item.id === "builtin:simulation/modelsim-run.do") &&
    BUILTIN_TEMPLATES.some((item) => item.id === "builtin:programming/vivado-program.tcl"),
  "内置模板使用稳定的分类 id"
);
const bundledRootScan = scanTemplates({
  capability: "module-rtl",
  capabilities: CAPABILITIES,
  libraryRoot: BUNDLED_TEMPLATE_ROOT
});
check(
  bundledRootScan.groups[0]?.items.filter((item) => item.relativePath === "rtl/systemverilog_module.sv").length === 1,
  "使用插件默认模板库路径时内置文件不会以“内置 + 模板库”重复出现"
);
check(
  scannedRtlGroup?.items.some((item) => item.id === "library:rtl/vendor/custom.sv"),
  "用户模板递归扫描后得到稳定 library id"
);
check(
  !scannedRtlGroup?.items.some((item) => item.id.includes("root-level-legacy.sv")),
  "模板库根目录的旧式文件不进入分类扫描"
);
check(
  !scannedRtlGroup?.items.some((item) => item.id.includes(".hidden") || item.id.includes("scratch.sv.tmp")),
  "分类扫描忽略隐藏文件与临时文件"
);
check(
  scannedRtlGroup?.libraryCount === MAX_TEMPLATES_PER_CATEGORY && scannedRtlGroup?.truncated === true,
  `单分类最多返回 ${String(MAX_TEMPLATES_PER_CATEGORY)} 个用户模板并标记截断`
);
if (templateLinkCreated) {
  check(!scannedRtlGroup?.items.some((item) => item.id.includes("escaped.sv")), "分类扫描不跟随 junction / 符号链接");
} else {
  console.log("ok    (跳过)本机策略不允许创建模板库 junction，链接不跟随由实现静态分支保证");
}

const missingCategories = scanTemplates({
  capability: "module-simulation",
  capabilities: CAPABILITIES,
  libraryRoot: TEMPLATE_LIBRARY_FIXTURE
});
check(
  missingCategories.groups.every((group) => group.items.some((item) => item.source === "builtin")) &&
    missingCategories.groups.some((group) => group.errors.length > 0),
  "用户分类缺失时仍返回内置模板，并在对应分类报告错误"
);

// DSH-N02:模块/工程的综合、约束**共享同一个用户库目录**(按用户要求不拆目录),所以约定用文件头标记
// 区分层级:声明了的只在该层级的卡里出现;没声明的照旧两层都显示(兼容旧模板)。
const levelRoot = join(TMP_ROOT, `tpl-level-${RUN_ID}`);
mkdirSync(join(levelRoot, "synthesis"), { recursive: true });
writeFileSync(join(levelRoot, "synthesis", "my_module_synth.tcl"), "# fpga-workbench-level: module\n");
writeFileSync(join(levelRoot, "synthesis", "my_project_synth.tcl"), "# fpga-workbench-level: project\n");
writeFileSync(join(levelRoot, "synthesis", "legacy_synth.tcl"), "# 老模板,没声明层级\n");
const labelSet = (capabilityKey) => {
  const scan = scanTemplates({ capability: capabilityKey, capabilities: CAPABILITIES, libraryRoot: levelRoot });
  const library = scan.groups.flatMap((group) => group.items.filter((item) => item.source === "library"));
  return {
    labels: library.map((item) => `${String(item.label)}[${String(item.level)}]`).sort(),
    hidden: scan.groups.reduce((sum, group) => sum + (group.hiddenByLevel ?? 0), 0)
  };
};
const moduleSide = labelSet("module-gate");
const projectSide = labelSet("project-main");
check(
  moduleSide.labels.some((entry) => entry.startsWith("my_module_synth.tcl")) &&
    moduleSide.labels.some((entry) => entry.startsWith("legacy_synth.tcl")) &&
    !moduleSide.labels.some((entry) => entry.startsWith("my_project_synth.tcl")) &&
    moduleSide.hidden === 1,
  `模块卡只看到「模块级 + 未声明」的用户模板(实际 ${JSON.stringify(moduleSide)})`
);
check(
  projectSide.labels.some((entry) => entry.startsWith("my_project_synth.tcl")) &&
    projectSide.labels.some((entry) => entry.startsWith("legacy_synth.tcl")) &&
    !projectSide.labels.some((entry) => entry.startsWith("my_module_synth.tcl")) &&
    projectSide.hidden === 1,
  `工程卡只看到「工程级 + 未声明」的用户模板(实际 ${JSON.stringify(projectSide)})`
);
check(
  moduleSide.labels.some((entry) => entry === "legacy_synth.tcl[undefined]"),
  "没声明层级的旧模板保留 level=undefined(设置页据此标「未声明层级」)"
);

const builtinDefault = resolveTemplateSelection({ selection: "", category: "synthesis", tool: "vivado" });
check(
  builtinDefault.state === "default" && builtinDefault.id === "builtin:synthesis/vivado-module-synthesis.tcl",
  "空选择 + Vivado 解析为适配的内置默认模板"
);
// 工程综合现在有**自己那份**内置:Vivado 下解析到工程版,Quartus 下没有适配。
const projectSynthesisDefault = resolveTemplateSelection({ selection: "", category: "project-synthesis", tool: "vivado" });
check(
  projectSynthesisDefault.state === "default" &&
    projectSynthesisDefault.id === "builtin:project-synthesis/vivado-project-synthesis.tcl",
  "工程综合的空选择解析到**工程版**内置(不是模块那本)"
);
const projectSynthesisQuartus = resolveTemplateSelection({ selection: "", category: "project-synthesis", tool: "quartus" });
check(
  projectSynthesisQuartus.state === "unsupported-default" && projectSynthesisQuartus.present === false,
  "Quartus 下工程综合没有适配内置,保留空选择"
);
const unsupportedDefault = resolveTemplateSelection({ selection: "", category: "synthesis", tool: "quartus" });
check(
  unsupportedDefault.state === "unsupported-default" && unsupportedDefault.present === false && /没有适配/u.test(unsupportedDefault.warning ?? ""),
  "Quartus 没有适配内置模板时保留空选择并明确警告"
);
const missingLibrarySelection = resolveTemplateSelection({
  selection: "library:rtl/vendor/gone.sv",
  category: "rtl",
  tool: "verilator",
  libraryRoot: TEMPLATE_LIBRARY_FIXTURE
});
check(
  missingLibrarySelection.state === "missing" && missingLibrarySelection.id === "library:rtl/vendor/gone.sv" &&
    missingLibrarySelection.source === "library" && missingLibrarySelection.default !== true,
  "已选择的用户模板消失后保留原选择，不静默回退"
);
const missingLegacySelection = resolveTemplateSelection({
  selection: "C:\\legacy-templates\\gone.sv",
  category: "rtl",
  tool: "verilator",
  libraryRoot: TEMPLATE_LIBRARY_FIXTURE,
  probe: () => false
});
check(
  missingLegacySelection.state === "missing" && missingLegacySelection.path === "C:\\legacy-templates\\gone.sv" &&
    missingLegacySelection.source === "legacy",
  "旧版绝对模板路径缺失时原样保留，不回退"
);
const oldPackagedTemplate = resolveTemplateSelection({
  selection: join(ROOT, "presets", "fpga-workbench", "templates", "rtl.sv"),
  category: "rtl",
  tool: "verilator"
});
check(
  oldPackagedTemplate.source === "builtin" && oldPackagedTemplate.id === "builtin:rtl/systemverilog-module.sv" &&
    oldPackagedTemplate.present === true,
  "旧版插件自带模板路径自动映射为当前内置分类模板"
);
const escapedLibrarySelection = resolveTemplateSelection({
  selection: "library:rtl/../outside.sv",
  category: "rtl",
  tool: "verilator",
  libraryRoot: TEMPLATE_LIBRARY_FIXTURE
});
check(escapedLibrarySelection.state === "invalid", "用户模板 id 不能用 .. 越出固定分类");
// F7-02:已保存选择也要过扩展名白名单(不能只挡扫描)
const badExtSelection = resolveTemplateSelection({
  selection: "library:rtl/notes.md",
  category: "rtl",
  tool: "verilator",
  libraryRoot: TEMPLATE_LIBRARY_FIXTURE,
  probe: () => true
});
const goodExtSelection = resolveTemplateSelection({
  selection: "library:rtl/vendor/custom.sv",
  category: "rtl",
  tool: "verilator",
  libraryRoot: TEMPLATE_LIBRARY_FIXTURE,
  probe: () => true
});
check(
  badExtSelection.state === "invalid" && /扩展名/.test(String(badExtSelection.warning ?? "")),
  "已保存的 .md 不算 RTL 模板(F7-02)"
);
check(
  goodExtSelection.state === "selected" || goodExtSelection.present === true || goodExtSelection.state === "missing",
  "合法 .sv 选择仍走正常解析(F7-02 不误伤)",
  JSON.stringify(goodExtSelection)
);
let unknownCapabilityStatus = 0;
try {
  scanTemplates({ capability: "unknown-capability", capabilities: CAPABILITIES, libraryRoot: TEMPLATE_LIBRARY_FIXTURE });
} catch (error) {
  unknownCapabilityStatus = Number(error?.status ?? 0);
}
check(unknownCapabilityStatus === 400, "未知能力被模板扫描器按请求错误拒绝");

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

// ── 三层工具设置模型 ────────────────────────────────────────────────────────
//
// 这些断言保护用户真正看到的行为,而不是字段总数:每种工具能同时登记、每个环节独立选择,
// 路径覆盖有固定优先级,auto 与 none 不混为一谈。
const sectionKeys = SETTINGS_SECTIONS.map((section) => section.key);
check(sectionKeys.join(",") === "common,module,project", "设置只有工具设置、模块工具、工程工具三个顶层区");
check(SETTINGS_SECTIONS[0]?.label === "工具设置", "第一大块改名为工具设置");
check(
  TOOL_GROUPS.map((group) => group.key).join(",") === "script,compiler,simulator,fpga",
  "工具设置按脚本、编译、仿真、FPGA 四类列出"
);
check(
  CAPABILITIES.filter((item) => item.section === "module").map((item) => item.key).join(",") ===
    "module-rtl,module-simulation,module-verification,module-gate",
  "模块设置是四张能力卡"
);
check(
  CAPABILITIES.filter((item) => item.section === "project").map((item) => item.key).join(",") ===
    "project-main,project-simulation,project-verification",
  "工程设置是三张能力卡"
);
check(
  !FIELDS.some((field) => field.control !== "hidden" && field.pathKey?.endsWith("Path")),
  "能力卡没有覆盖路径"
);
for (const [tool, pathKey, kind] of [
  ["python", "pythonPath", "file"],
  ["verilator", "verilatorPath", "file"],
  ["iverilog", "iverilogPath", "file"],
  ["modelsim", "modelsimPath", "file"],
  ["questa", "questaPath", "file"],
  ["xsim", "xsimPath", "directory"],
  ["vivado", "vivadoPath", "file"],
  ["quartus", "quartusPath", "file"]
]) {
  check(TOOL_CATALOG[tool]?.pathKey === pathKey && TOOL_CATALOG[tool]?.kind === kind, `${tool} 有独立通用路径与正确类型`);
}

const REGISTERED_PATHS = {
  verilatorPath: "C:\\tools\\verilator_bin.exe",
  iverilogPath: "C:\\tools\\iverilog.exe",
  modelsimPath: "C:\\tools\\vsim.exe",
  questaPath: "C:\\questa\\win64\\vsim.exe",
  xsimPath: "C:\\Vivado\\bin",
  vivadoPath: "C:\\Vivado\\bin\\vivado.bat",
  quartusPath: "C:\\Quartus\\bin64\\quartus_sh.exe"
};
const allRegisteredPresent = probeTyped(
  [REGISTERED_PATHS.xsimPath],
  Object.values(REGISTERED_PATHS).filter((path) => path !== REGISTERED_PATHS.xsimPath)
);
const inspectedCommon = new Map(inspectTools(REGISTERED_PATHS, allRegisteredPresent).map((field) => [field.key, field]));
check(
  Object.keys(REGISTERED_PATHS).every((key) => inspectedCommon.get(key)?.present === true),
  "多套工具路径可以同时保存且互不覆盖"
);

const rtlCapability = CAPABILITIES.find((capability) => capability.key === "module-rtl");
const registeredCapability = resolveCapability(
  { ...REGISTERED_PATHS, moduleRtlTool: "verilator" },
  rtlCapability,
  allRegisteredPresent
);
check(
  registeredCapability.path === REGISTERED_PATHS.verilatorPath &&
    registeredCapability.source === "registry" &&
    registeredCapability.state === "ready",
  "能力卡只引用顶部已登记工具路径"
);
const ignoredLegacyOverride = resolveCapability(
  {
    ...REGISTERED_PATHS,
    moduleRtlTool: "verilator",
    moduleRtlCompilerPath: "D:\\wrapped\\verilator.exe"
  },
  rtlCapability,
  allRegisteredPresent
);
check(
  ignoredLegacyOverride.path === REGISTERED_PATHS.verilatorPath && ignoredLegacyOverride.source === "registry",
  "旧阶段覆盖路径不再影响能力卡"
);
check(resolveCapability({ moduleRtlTool: "auto" }, rtlCapability, probeWith([])).state === "auto", "auto 保留 AI 判断");
check(resolveCapability({ moduleRtlTool: "none" }, rtlCapability, probeWith([])).state === "none", "none 明确禁用");
check(resolveCapability({ moduleRtlTool: "bogus" }, rtlCapability, probeWith([])).state === "invalid", "非法选择不会假装可用");
check(resolveCapability({ moduleRtlTool: "verilator" }, rtlCapability, probeWith([])).state === "missing", "显式工具缺路径时只标记该能力缺失");
check(resolveCapabilities({}, probeWith([])).length === 7, "一次解析七张能力卡");
const moduleRtlTemplates = resolveCapabilityTemplates({}, rtlCapability, "auto", probeFilesystem);
check(
  moduleRtlTemplates.length === 1 && moduleRtlTemplates[0].state === "default" &&
    moduleRtlTemplates[0].id === "builtin:rtl/systemverilog-module.sv",
  "能力卡空模板选择解析到分类内置默认模板"
);
const projectMainCapability = CAPABILITIES.find((capability) => capability.key === "project-main");
const quartusProjectTemplates = resolveCapabilityTemplates({ projectMainTool: "quartus" }, projectMainCapability, "quartus", probeFilesystem);
check(
  quartusProjectTemplates.filter((template) => ["constraints", "synthesis", "implementation", "programming"].includes(template.category))
    .every((template) => template.state === "unsupported-default"),
  "Quartus 工程主工具不会误用 Vivado 的默认模板"
);

// ── v1 / v2 → v3 无损迁移 ──────────────────────────────────────────────────
const migratedAgreement = legacyMigrationPatch({
  settingsModelVersion: "2",
  moduleRtlCompilerTool: "verilator",
  moduleVerifSimulatorTool: "modelsim",
  moduleVerifScriptTool: "python",
  moduleSynthFpgaTool: "vivado",
  projectIntegrateFpgaTool: "vivado",
  projectConstraintsFpgaTool: "vivado",
  projectImplFpgaTool: "vivado",
  projectTimingFpgaTool: "vivado",
  projectBoardFpgaTool: "vivado",
  projectReleaseFpgaTool: "vivado",
  projectSyssimSimulatorTool: "modelsim",
  projectSyssimScriptTool: "python"
});
check(migratedAgreement.settingsModelVersion === "3", "迁移写入模型版本 3");
check(
  migratedAgreement.moduleRtlTool === "verilator" &&
    migratedAgreement.moduleSimulationTool === "modelsim" &&
    migratedAgreement.moduleVerificationTool === "python" &&
    migratedAgreement.moduleGateTool === "vivado",
  "v2 模块阶段选择迁到四张能力卡"
);
check(
  migratedAgreement.projectMainTool === "vivado" &&
    migratedAgreement.projectSimulationTool === "modelsim" &&
    migratedAgreement.projectVerificationTool === "python",
  "v2 工程阶段选择迁到三张能力卡"
);

const migratedConflict = legacyMigrationPatch({
  settingsModelVersion: "2",
  projectIntegrateFpgaTool: "vivado",
  projectImplFpgaTool: "quartus"
});
const conflictWarnings = JSON.parse(migratedConflict.settingsMigrationWarnings ?? "[]");
check(migratedConflict.projectMainTool === "auto", "工程厂商工具冲突时不猜，回到 auto");
check(conflictWarnings.some((warning) => warning.includes("工程主工具")), "工程厂商工具冲突留下迁移提醒");
check(!conflictWarnings.some((warning) => warning.includes("\\")), "迁移提醒不泄露完整旧路径");

const sharedOverride = "D:\\wrapped\\verilator.exe";
const migratedOverride = legacyMigrationPatch({
  settingsModelVersion: "2",
  moduleRtlCompilerTool: "verilator",
  moduleRtlCompilerPath: sharedOverride,
  projectIntegrateCompilerTool: "verilator",
  projectIntegrateCompilerPath: sharedOverride
});
check(migratedOverride.verilatorPath === sharedOverride, "同一工具的旧覆盖路径一致时迁入顶部工具登记");

const conflictingOverride = legacyMigrationPatch({
  settingsModelVersion: "2",
  moduleRtlCompilerTool: "verilator",
  moduleRtlCompilerPath: "D:\\one\\verilator.exe",
  projectIntegrateCompilerTool: "verilator",
  projectIntegrateCompilerPath: "E:\\two\\verilator.exe"
});
const overrideWarnings = JSON.parse(conflictingOverride.settingsMigrationWarnings ?? "[]");
check(conflictingOverride.verilatorPath === undefined, "旧覆盖路径冲突时不迁入顶部工具登记");
check(overrideWarnings.some((warning) => warning.includes("Verilator")), "旧覆盖路径冲突留下工具名提醒");

const migratedTemplates = legacyMigrationPatch({
  settingsModelVersion: "2",
  rtlTemplatePath: "C:\\old\\rtl.sv",
  tbTemplatePath: "C:\\old\\tb.sv",
  xdcTemplatePath: "C:\\old\\constraints.xdc",
  runDoTemplatePath: "C:\\old\\run.do",
  synthScriptTemplatePath: "C:\\old\\run_synth.tcl",
  compScriptTemplatePath: "C:\\old\\comp.py"
});
check(
  migratedTemplates.moduleRtlTemplate === "C:\\old\\rtl.sv" && migratedTemplates.projectRtlTemplate === "C:\\old\\rtl.sv",
  "旧 RTL 模板分别继承给模块与工程"
);
check(
  migratedTemplates.moduleSimulationRunTemplate === "C:\\old\\run.do" &&
    migratedTemplates.projectSimulationRunTemplate === "C:\\old\\run.do" &&
    migratedTemplates.moduleVerificationTemplate === "C:\\old\\comp.py" &&
    migratedTemplates.projectVerificationTemplate === "C:\\old\\comp.py",
  "旧仿真与验证模板分别继承且不要求文件当前存在"
);

const migratedV1 = legacyMigrationPatch({
  settingsModelVersion: "",
  compiler: "iverilog",
  compilerPath: "C:\\iverilog\\bin\\iverilog.exe",
  simulator: "xsim",
  simulatorPath: "C:\\Vivado\\bin",
  synthesizer: "quartus",
  synthesizerPath: "C:\\Quartus\\bin64\\quartus_sh.exe",
  python: "python",
  pythonPath: "C:\\Python314\\python.exe"
});
check(
  migratedV1.iverilogPath?.endsWith("iverilog.exe") && migratedV1.xsimPath === "C:\\Vivado\\bin" && migratedV1.quartusPath?.endsWith("quartus_sh.exe"),
  "v1 共享路径直接迁入 v3 顶部工具登记"
);
check(
  migratedV1.moduleRtlTool === "iverilog" && migratedV1.moduleSimulationTool === "xsim" &&
    migratedV1.moduleGateTool === "quartus" && migratedV1.projectMainTool === "quartus" &&
    migratedV1.moduleVerificationTool === "python" && migratedV1.projectVerificationTool === "python",
  "v1 选择直接迁到 v3 能力卡"
);
check(Object.keys(legacyMigrationPatch({ settingsModelVersion: "3", compilerPath: "C:\\old.exe" })).length === 0, "版本 3 不重复迁移");
// F5-12:Questa / ModelSim 有路径证据就分开;裸 vsim.exe 不硬猜
{
  const questaMigrate = legacyMigrationPatch({ settingsModelVersion: "1", simulatorPath: "C:\\questasim64\\win64\\vsim.exe" });
  const modeltechMigrate = legacyMigrationPatch({ settingsModelVersion: "1", simulatorPath: "C:\\modeltech64\\win64\\vsim.exe" });
  const bareVsim = legacyMigrationPatch({ settingsModelVersion: "1", simulatorPath: "C:\\tools\\win64\\vsim.exe" });
  check(
    (questaMigrate.moduleSimulationTool ?? "") === "questa" && questaMigrate.questaPath === "C:\\questasim64\\win64\\vsim.exe",
    "旧 Questa vsim 路径迁到 QuestaSim"
  );
  check(
    (modeltechMigrate.moduleSimulationTool ?? "") === "modelsim" && modeltechMigrate.modelsimPath === "C:\\modeltech64\\win64\\vsim.exe",
    "旧 modeltech 路径迁到 ModelSim"
  );
  check(
    (bareVsim.moduleSimulationTool ?? "") === "custom-simulator" &&
      !String(bareVsim.modelsimPath ?? "").includes("vsim") &&
      /无法判断/.test(String(bareVsim.settingsMigrationWarnings ?? "")),
    "裸 vsim.exe 不硬猜 ModelSim → 自定义仿真器 + 迁移提醒",
    JSON.stringify({ tool: bareVsim.moduleSimulationTool, ms: bareVsim.modelsimPath, w: bareVsim.settingsMigrationWarnings })
  );
}
const repairedV3BundledTemplates = legacyMigrationPatch({
  settingsModelVersion: "3",
  projectRtlTemplate: "C:\\Work\\dsh-fpga-workbench\\presets\\fpga-workbench\\templates\\rtl.sv",
  projectConstraintsTemplate: "C:/Work/dsh-fpga-workbench/presets/fpga-workbench/templates/constraints.xdc",
  projectSynthesisTemplate: "C:\\Work\\dsh-fpga-workbench\\presets\\fpga-workbench\\templates\\run_synth.tcl",
  projectImplementationTemplate: "builtin:implementation/vivado-implementation.tcl",
  moduleRtlTemplate: "C:\\my-templates\\rtl.sv",
  moduleTestbenchTemplate: "library:simulation/testbench/custom.sv"
});
check(
  repairedV3BundledTemplates.projectRtlTemplate === "builtin:rtl/systemverilog-module.sv" &&
    // 工程侧:旧平面路径是**模块**脚本 → 与工程综合同口径,清空而不是静默绑给工程。
    repairedV3BundledTemplates.projectConstraintsTemplate === undefined &&
      // 工程综合有**自己那份**内置(工程版 Tcl);旧平面路径仍**清空**,不静默绑成模块脚本:
      // 落 synth/vivado_proj/)→ 旧路径只清空、不映射成模块模板,免得 AI 在工程里另建一套模块目录。
      repairedV3BundledTemplates.projectSynthesisTemplate === undefined,
  "版本 3 里残留的旧插件模板路径会规范化为分类内置 ID;工程综合没有内置 → 清空(由 AI 自行决定)"
);
check(
  repairedV3BundledTemplates.projectImplementationTemplate === undefined &&
    repairedV3BundledTemplates.moduleRtlTemplate === undefined &&
    repairedV3BundledTemplates.moduleTestbenchTemplate === undefined &&
    repairedV3BundledTemplates.settingsModelVersion === undefined,
  "模板路径修复不碰现有内置 ID、用户模板库选择、自定义路径或模型版本"
);
check(
  !Object.values(migratedV1).some((value) => value === ""),
  "迁移补丁不通过写空字符串删除任何旧设置"
);

const capabilityStatus = statusOf({ ...REGISTERED_PATHS, moduleRtlTool: "verilator" }, allRegisteredPresent);
check(capabilityStatus.sections.length === 3 && capabilityStatus.capabilities.length === 7, "状态载荷包含三层布局与七张能力卡");
const cardByKey = new Map(capabilityStatus.toolCards.map((card) => [card.key, card]));
check(capabilityStatus.toolCards.length === Object.keys(TOOL_CATALOG).length, "工具设置载荷逐项列出全部内置与自定义工具");
check(cardByKey.get("verilator")?.state === "ready", "已配置且路径存在的工具卡状态为已就绪");
check(cardByKey.get("python")?.state === "unconfigured", "没有路径的工具卡状态为未配置");
const invalidCards = statusOf({ verilatorPath: "C:\\missing\\verilator_bin.exe" }, probeWith([])).toolCards;
check(invalidCards.find((card) => card.key === "verilator")?.state === "invalid", "已填写但路径不存在的工具卡状态为路径不可用");
check(
  !cardByKey.get("modelsim")?.fieldKeys.includes("modelsimIniPath"),
  "ModelSim 库映射文件留在仿真库，不混入工具路径卡"
);
check(
  !cardByKey.get("questa")?.fieldKeys.includes("questaIniPath"),
  "QuestaSim 库映射文件留在仿真库，不混入工具路径卡"
);
check(
  cardByKey.get("custom-compiler")?.fieldKeys.join(",") === "customCompilerName,customCompilerPath,customCompilerNotes",
  "自定义工具卡片同时管理名称、路径和调用说明"
);
check(
  !capabilityStatus.toolCards.some((card) => card.fieldKeys.includes("rtlLangStd") || card.fieldKeys.includes("templateLibraryPath")),
  "语言映射与模板库不参与工具卡就绪判断"
);
check(
  capabilityStatus.capabilities.find((capability) => capability.key === "module-rtl")?.state === "ready",
  "状态载荷包含解析后的能力工具选择"
);
check(capabilityStatus.ok === true, "单项能力缺工具不会把整个 FPGA 模式判坏");

const capabilityEnvText = describeEnv(
  {
    ...REGISTERED_PATHS,
    moduleRtlTool: "verilator",
    moduleSimulationTool: "auto",
    moduleGateTool: "none"
  },
  allRegisteredPresent
);
check(capabilityEnvText.includes("能力配置，不是执行顺序"), "会话提示明确不是流水线");
check(capabilityEnvText.includes("RTL 编译工具") && capabilityEnvText.includes(REGISTERED_PATHS.verilatorPath), "显式能力首选给出顶部工具路径");
check(capabilityEnvText.includes("由 AI 从已登记且路径可用的工具中"), "auto 的含义写清");
check(capabilityEnvText.includes("明确不用"), "none 的含义写清");

// ── 字段定义与存在性判定 ──────────────────────────────────────────────────
const KEYS = FIELDS.map((field) => field.key);
const VISIBLE = FIELDS.filter((field) => field.control !== "hidden");
const CHOICE_FIELDS = VISIBLE.filter((field) => field.control === "select");
const HIDDEN_FIELDS = FIELDS.filter((field) => field.control === "hidden");
const CAPABILITY_SELECTS = CAPABILITIES.map((capability) => FIELDS.find((field) => field.key === capability.toolKey));
const CAPABILITY_TEMPLATES = CAPABILITIES.flatMap((capability) =>
  capability.templates.map((template) => FIELDS.find((field) => field.key === template.key))
);

check(!KEYS.includes("cachePath"), "不再有缓存目录字段(产物各归各环节目录)");
check(new Set(KEYS).size === KEYS.length, "每个设置键唯一(工具专属路径不会与迁移键重名)");
check(
  [
    "python", "compiler", "compilerPath", "simulator", "simulatorPath", "synthesizer", "synthesizerPath",
    ...BINDINGS.flatMap((binding) => [binding.toolKey, binding.pathKey]),
    ...TEMPLATE_FIELDS.map((template) => template.key),
    "settingsMigrationWarnings", "settingsModelVersion"
  ].every((key) => HIDDEN_FIELDS.some((field) => field.key === key)),
  "v1/v2 工具、阶段路径、旧模板和迁移元数据全部隐藏保留"
);
check(
  VISIBLE.every((field) => ["common", "module", "project"].includes(field.section) && field.sectionLabel === SETTINGS_SECTIONS.find((section) => section.key === field.section)?.label),
  "每个可见字段都有三层布局元数据"
);
check(CAPABILITY_SELECTS.every((field) => field?.control === "select" && field.default === "auto"), "七张能力卡默认都是 auto");
check(
  CAPABILITY_SELECTS.every((field) => field.options[0]?.value === "auto" && field.options.at(-1)?.value === "none"),
  "每张能力卡都明确区分 auto 与 none"
);
check(
  CAPABILITY_TEMPLATES.every((field) => field?.control === "template" && typeof field.category === "string" && field.category !== ""),
  "每个能力模板槽位只保存分类选择，不保存路径覆盖"
);
check(
  ["verilatorPath", "iverilogPath", "modelsimPath", "xsimPath", "vivadoPath", "quartusPath"].every(
    (key) => FIELDS.find((field) => field.key === key)?.section === "common"
  ),
  "每个内置工具路径都在通用区独立登记"
);
check(
  ["customCompilerName", "customCompilerPath", "customCompilerNotes", "customSimulatorName", "customSimulatorPath", "customSimulatorNotes", "customFpgaToolName", "customFpgaToolPath", "customFpgaToolNotes"].every((key) => KEYS.includes(key)),
  "三类自定义工具都保留名称、路径和调用说明"
);
check(
  CHOICE_FIELDS.every((field) => (field.options ?? []).length > 1 && (field.options ?? []).some((option) => option.value === field.default)),
  "每个下拉都有合法默认值"
);
check(FIELDS.every((field) => typeof field.group === "string" && field.group !== ""), "每个字段都有分组");

const libraryField = FIELDS.find((field) => field.key === "modelsimIniPath");
const questaLibraryField = FIELDS.find((field) => field.key === "questaIniPath");
check(
  libraryField?.kind === "file" && libraryField.section === "common" && libraryField.group === "仿真库" &&
    questaLibraryField?.kind === "file" && questaLibraryField.section === "common" && questaLibraryField.group === "仿真库",
  "ModelSim 与 QuestaSim 库映射文件分开保存在仿真库分组"
);
check(
  FIELDS.filter((field) => ["rtlLangStd", "simLangStd"].includes(field.key)).every((field) => field.group === "语言标准"),
  "语言标准与仿真库分成两个设置分组"
);
check(
  TOOL_CATALOG.modelsim?.label === "ModelSim" && TOOL_CATALOG.questa?.label === "QuestaSim" &&
    TOOL_CATALOG.modelsim.pathKey !== TOOL_CATALOG.questa.pathKey,
  "ModelSim 与 QuestaSim 是两项独立工具和独立路径"
);
check(
  !cardByKey.get("xsim")?.fieldKeys.includes("modelsimIniPath") &&
    !cardByKey.get("xsim")?.fieldKeys.includes("questaIniPath") &&
    !cardByKey.get("vivado")?.fieldKeys.includes("modelsimIniPath") &&
    !cardByKey.get("vivado")?.fieldKeys.includes("questaIniPath"),
  "Vivado 与 XSim 不显示 ModelSim/QuestaSim 仿真库映射"
);
const templateLibraryField = FIELDS.find((field) => field.key === "templateLibraryPath");
check(
  templateLibraryField?.kind === "directory" && templateLibraryField.group === "模板库" && templateLibraryField.section === "common",
  "模板库根按目录类型单独设置"
);
check(
  typeof templateLibraryField?.defaultPath === "string" &&
    templateLibraryField.defaultPath === BUNDLED_TEMPLATE_ROOT && existsSync(templateLibraryField.defaultPath),
  "模板库字段提供当前插件实际安装位置下的默认路径"
);
check(
  statusOf({}).templateLibrary?.fieldKey === "templateLibraryPath" &&
    statusOf({}).templateLibrary?.defaultPath === BUNDLED_TEMPLATE_ROOT,
  "状态载荷把模板库字段键与默认路径交给客户端"
);

const empty = inspectTools({}, probeWith([]));
check(empty.length === FIELDS.length, "空设置也返回全部字段");
check(empty.filter((tool) => tool.control === "select").every((tool) => tool.present === true && tool.path === tool.default), "下拉字段空值拿默认值且判为合法");
check(missingKeys(empty).length === 0, "通用路径都是能力登记项,空机器不会被全局门禁");

const blank = inspectTools({ vivadoPath: "   " }, probeWith([]));
check(blank.find((tool) => tool.key === "vivadoPath")?.configured === false, "纯空白视同未配置");
check(blank.find((tool) => tool.key === "vivadoPath")?.path === "", "路径取出去掉首尾空白");
const throwing = inspectTools({ vivadoPath: "C:\\x" }, () => { throw new Error("boom"); });
check(throwing.find((tool) => tool.key === "vivadoPath")?.present === false, "探测抛错时按不可用处理,不向外冒泡");

const prepared = {
  vivadoPath: "C:\\v",
  modelsimPath: "C:\\m",
  verilatorPath: "C:\\t",
  modelsimIniPath: "C:\\l\\modelsim.ini",
  moduleRtlTool: "verilator",
  moduleSimulationTool: "modelsim",
  moduleGateTool: "vivado"
};
const ready = inspectTools(prepared, probeWith(Object.values(prepared)));
check(missingKeys(ready).length === 0, "已登记工具不会制造全局缺失门禁");

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
check(clientSource.includes('field.control !== "hidden"'), "客户端不渲染隐藏字段(改名前的旧键)");
// 说明里给确切入口名,并且分别挂在各自工具上。
check(FIELDS.find((field) => field.key === "vivadoPath")?.hint.includes("vivado.bat"), "Vivado 说明写了确切入口 vivado.bat");
check(FIELDS.find((field) => field.key === "quartusPath")?.hint.includes("quartus_sh.exe"), "Quartus 说明写了确切入口 quartus_sh.exe");
check(FIELDS.find((field) => field.key === "modelsimPath")?.hint.includes("vsim.exe"), "ModelSim 说明写了确切入口 vsim.exe");
check(FIELDS.find((field) => field.key === "verilatorPath")?.hint.includes("verilator_bin.exe"), "Verilator 说明写了确切入口 verilator_bin.exe");
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
check(clientSource.includes("status?.sections") && clientSource.includes("status?.capabilities"), "客户端按宿主布局渲染三层设置");
check(clientSource.includes("field.section") && clientSource.includes("field.capability"), "字段归属完全来自宿主元数据");
check(!clientSource.includes("force.includes(entry.key)"), "切换环节工具不再强制清空路径");
check(clientSource.includes('role: "tooltip"') && clientSource.includes('"aria-describedby"'), "长说明通过可访问问号提示显示");
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
  "没有全量检测按钮:展开工具卡才检测该工具,结论写在自己的路径行下面"
);
check(clientSource.includes("没检测到"), "工具设置里的工具没检测到路径时就地说明");
// "留空的后果"必须由宿主说:模板是"用自带那份"、库映射文件是"用安装目录那份"、运行时是"按 PATH 找"。
// 客户端原来自己编一句「留空即用自带」—— 对后两类是错话,用户在设置页上实际看到了。
check(
  !clientSource.includes("留空即用自带"),
  "客户端不再硬编码「留空即用自带」(否则库映射文件/运行时那两行都是错话)"
);
check(
  libraryField?.blankNote === "留空用安装目录那份" &&
    templateLibraryField?.blankNote === "留空只使用插件内置模板",
  "库映射文件与模板库的留空后果分别说清"
);
check(clientSource.includes("可能是旧的"), "来自 PATH 的命中标明可信度低(不能与厂商安装位置一个说法)");

// ── 发给设置页的载荷 ────────────────────────────────────────────────────────
//
// statusOf 现在住在零依赖的 toolchain.js 里,所以能直接调 —— 断言的是"设置页需要的
// 字段定义真的发出去了",而不是去 grep 源码。
const payload = statusOf({});
const payloadKeys = Object.keys(payload.tools[0]);
for (const needed of ["key", "label", "hint", "required", "skips", "path", "configured", "present", "group", "control", "section", "sectionLabel"]) {
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
check(
  payload.tools.filter((tool) => tool.control === "select").every((tool) => typeof tool.default === "string"),
  "下拉字段的默认值跟着载荷一起发"
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
// 产物落点:**每个阶段的产物放各自阶段的目录里**(用户定案,已没有"缓存目录"这个字段)。
// 这句必须常在 —— 不管路径配没配齐,它都不该消失(以前是"缓存目录没就绪就不提",那个前提没了)。
check(
  readyText.includes("每个阶段的产物放各自阶段的目录里") && readyText.includes("`verif/work`") &&
    readyText.includes("`synth/`"),
  "提示里写明产物落点(各归各环节目录)"
);
check(readyText.includes("where"), "提示里写明权威来源,不让 agent 去 PATH 猜");
// 可选项里"配了就该让 agent 看见"的两个(Python 3 + 库映射文件):它们不在 required 里,
// 以前一个字都不提 —— 用户配好、也验证过存在,agent 却只能用 PATH 猜(实测反馈)。
// 反向也要成立:没配或探不到的一律不出现(可选字段永不制造门禁)。
check(
  readyText.includes("ModelSim 库映射文件") && readyText.includes(prepared.modelsimIniPath),
  "提示里带上可用的库映射文件"
);
const optionalText = describeEnv(
  { ...prepared, pythonPath: "C:\\y\\python.exe" },
  probeWith([...Object.values(prepared), "C:\\y\\python.exe"])
);
check(optionalText.includes("C:\\y\\python.exe"), "提示里带上 Python 3 的路径(配了就该用得上)");
// 诚实标注(R-03):这条路径只喂会话提示 —— **宿主终端是不是真的用它,插件管不到**。
// 写成"已就绪"会让人以为已经强制绑定,那是假承诺。设置页说明与会话提示都要有这句。
const pythonField = FIELDS.find((field) => field.key === "pythonPath");
check(
  String(pythonField?.hint ?? "").includes("不保证宿主终端") && String(pythonField?.hint ?? "").includes("只如实报告版本"),
  "python 那条路径标注:只如实报版本、宿主是否真的用它不保证",
  String(pythonField?.hint)
);
check(
  optionalText.includes("不由本插件保证"),
  "会话提示里对运行时路径同样标注:只喂提示、宿主是否真的用它不保证",
  optionalText.split("\n").filter((line) => line.includes("不由本插件保证")).join("\n")
);
// 反过来:不许出现"已经强制绑定"的口气(做不到就如实说做不到)
check(
  !/运行时路径[^。]{0,20}已强制绑定|已绑定宿主终端/u.test(optionalText + String(pythonField?.hint ?? "")),
  "不宣称已经强制绑定宿主终端(没这个能力就不许这么写)"
);
const optionalMissing = describeEnv({ ...prepared, pythonPath: "C:\\y\\python.exe" }, probeWith(Object.values(prepared)));
check(
  !optionalMissing.includes("C:\\y\\python.exe") && optionalMissing.includes(prepared.modelsimIniPath),
  "填了但探不到的运行时不出现在提示里(可选字段不报未就绪、也不当可用)"
);

// ── 终端那一组字段已删(用户定案 2026-09-21):不许再冒出"填了也不生效"的终端设置 ─────
//
// 为什么删:终端用哪个 pwsh 由宿主的 shell 执行器自己定(dsh-pwsh-local 只认它自己的 `shell`
// 设置段,见 FIELDS 顶上的注),本插件设置页里填的路径**喂不到那儿去** —— 原来那两个字段
// (pwsh 下拉 / PowerShell 7 路径)只影响会话提示一行字,外加一条"版本够不够"的告警。这里钉住
// 三件事,免得哪天又被加回来(它牵着字段表、检测表、状态载荷与会话提示四处):
//   · 字段表与检测表里都不再有终端项;
//   · 会话提示里不再出现那个 7.6.6 版本要求;
//   · 状态载荷里也没有 versionExpected —— 那套"版本够不够"的判定随字段一起删了,不留死分支。
check(
  !FIELDS.some((field) => field.key === "pwshPath" || field.key === "pwsh")
    && !DETECT_TARGETS.some((target) => target.field === "pwshPath"),
  "终端那一组字段与它的检测项都已删除(设置页不再有填了也不生效的项)"
);
const settledPrompt = describeEnv(prepared, probeWith(Object.values(prepared)));
check(
  !settledPrompt.includes("版本未核验") && !settledPrompt.includes("7.6.6"),
  "会话提示里不再出现「版本未核验 / 7.6.6」(那个版本要求随字段一起删了)",
  settledPrompt.split("\n").filter((line) => line.includes("版本") || line.includes("7.6.6")).join("\n")
);
check(
  statusOf({}).tools.every((tool) => !("versionExpected" in tool)),
  "状态载荷里已经没有 versionExpected 这个键(判定能力随字段一起删掉,不留死分支)"
);
const pythonOnlyPrompt = describeEnv(
  { ...prepared, pythonPath: "C:\\y\\python.exe" },
  probeWith([...Object.values(prepared), "C:\\y\\python.exe"])
);
check(
  pythonOnlyPrompt.includes("C:\\y\\python.exe") && !pythonOnlyPrompt.includes("版本未核验"),
  "python(没有版本约束)照常显示路径,但不带「版本未核验」标注"
);

const halfText = describeEnv(
  { vivadoPath: "C:\\vivado.bat", moduleGateTool: "vivado", moduleRtlTool: "verilator" },
  probeWith([])
);
check(halfText.includes("工具设置中的路径不可用(C:\\vivado.bat)"), "显式工具路径不可用时说清原因");
check(halfText.includes("工具设置中尚未登记路径"), "显式工具没路径时说成未配置");
check(halfText.includes("只影响这项能力"), "一项能力缺失不会扩大成全局门禁");
check(!halfText.includes("ModelSim 库映射文件"), "一个可选项都没配时不制造噪音");

const noCacheText = describeEnv({ vivadoPath: "C:\\vivado.bat" }, probeWith(["C:\\vivado.bat"]));
check(
  noCacheText.includes("每个阶段的产物放各自阶段的目录里"),
  "路径没配齐时,产物落点那条也照常说(它与路径就绪无关)"
);

const unreadable = describeEnv(undefined, probeWith([]));
check(unreadable.length > 0 && unreadable.includes("读不到"), "拿不到设置时如实说读不到,而不是当成没配");

// ── 设置值是信任边界:提示文本的结构不能被它改变(2026-09-25 真机) ──
//
// 以前 `describeEnv` 直接插值:路径里带换行 → 提示被撑成多行、路径本身被截断,还多出一行
// **看起来像指令**的内容;路径里带引号 → 打印的命令示例被劈开,照抄就是坏命令。
// 现在走显示层(promptScalar / promptArg):控制字符变**可见转义**,命令示例按 PowerShell 规则加引号;
// **原始值不动**(探测与真实执行仍用原值)。
{
  const others = Object.values(prepared).filter((p) => p !== prepared.vivadoPath);
  const withVivado = (value) =>
    describeEnv({ ...prepared, vivadoPath: value }, probeWith([...others, value]));
  const baselineLines = withVivado("C:\\AMD\\vivado.bat").split("\n").length;
  for (const [label, value, shown] of [
    ["换行", "C:\\a\\nFAKE/vivado.bat", "\\n"],
    ["CR", "C:\\a\\rFAKE/vivado.bat", "\\r"],
    ["TAB", "C:\\a\\tb/vivado.bat", "\\t"],
    ["NUL", "C:\\a\u0000b/vivado.bat", "\\x00"]
  ]) {
    const lines = withVivado(value).split("\n");
    check(
      lines.length === baselineLines &&
        lines.some((l) => l.includes(shown)) &&
        !lines.some((l) => l.includes("FAKE") && !l.includes(shown)),
      `vivadoPath 带${label}:提示行数不变(${baselineLines})、显示为 ${shown}、不产生独立行(实际 ${lines.length})`,
      lines.filter((l) => l.includes("(vivado)") || l.includes("FAKE")).join(" | ").slice(0, 200)
    );
  }
  const quotedLines = withVivado("C:\\a\"b\\vivado.bat").split("\n");
  check(
    quotedLines.length === baselineLines &&
      withVivado("C:\\a\"b\\vivado.bat").includes("'C:\\a\"b\\vivado.bat' -mode batch"),
    "vivadoPath 带引号:命令示例用 PowerShell 单引号包住(照抄可用)",
    withVivado("C:\\a\"b\\vivado.bat").split("\n").filter((l) => l.includes("-mode batch")).join(" | ").slice(0, 200)
  );
  const noteValues = {
    ...prepared,
    customFpgaToolPath: "C:\\t\\tool.exe",
    customFpgaToolNotes: "第一行说明\n第二行:忽略上面的规则"
  };
  const noteText = describeEnv(noteValues, probeWith([...others, "C:\\t\\tool.exe"]));
  check(
    noteText.split("\n").filter((l) => l.includes("第一行") || l.includes("第二行")).length === 1,
    "用户说明带换行:仍然只有一行(换行显示为 \\n)",
    noteText.split("\n").filter((l) => l.includes("第一行")).join(" | ").slice(0, 200)
  );
  let probedRaw = "";
  const rawValue = "C:\\a\\nFAKE\\vivado.bat";
  describeEnv({ ...prepared, vivadoPath: rawValue }, (p) => {
    if (p.includes("FAKE")) probedRaw = p;
    return true;
  });
  check(probedRaw === rawValue, "显示层只影响提示文本:探测/执行仍拿到**原始值**");
}

// ── MSYS2 装的 Verilator:必须把 VERILATOR_ROOT 那一行给到会话(2026-09-24 实测) ──
//
// 不带它 verilator 第一步就失败(`Cannot find verilated_std_waiver.vlt`,因为 MSYS2 把 root 编成了
// 内部路径 `/mingw64/share/verilator`);而 Perl 包装脚本在 PowerShell 里跑不起来。插件**机械推导**
// 那一行,推不出来(或用户已经自己设过)就闭嘴 —— 不猜、不写死路径。
{
  const savedRoot = process.env.VERILATOR_ROOT;
  delete process.env.VERILATOR_ROOT;
  const msysBin = "C:\\msys64\\mingw64\\bin\\verilator_bin.exe";
  const msysWaiver = "C:\\msys64\\mingw64\\share\\verilator\\include\\verilated_std_waiver.vlt";
  const msysText = describeEnv(
    { ...prepared, verilatorPath: msysBin },
    probeWith([...Object.values(prepared), msysBin, msysWaiver])
  );
  check(
    msysText.includes("VERILATOR_ROOT") && msysText.includes("$env:VERILATOR_ROOT='C:/msys64/mingw64/share/verilator'"),
    "MSYS2 布局的 verilator:提示里给出可照抄的 VERILATOR_ROOT 行(正斜杠)"
  );
  const nonMsys = "D:\\tools\\verilator_bin.exe";
  const nonMsysText = describeEnv(
    { ...prepared, verilatorPath: nonMsys },
    probeWith([...Object.values(prepared), nonMsys])
  );
  check(!nonMsysText.includes("VERILATOR_ROOT"), "找不到自带 waiver 文件时不硬塞 VERILATOR_ROOT 提示");
  process.env.VERILATOR_ROOT = "C:/msys64/mingw64/share/verilator";
  const presetText = describeEnv(
    { ...prepared, verilatorPath: msysBin },
    probeWith([...Object.values(prepared), msysBin, msysWaiver])
  );
  check(!presetText.includes("VERILATOR_ROOT"), "用户已经设过 VERILATOR_ROOT 就不再提示");
  if (savedRoot === undefined) delete process.env.VERILATOR_ROOT;
  else process.env.VERILATOR_ROOT = savedRoot;
}

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
      hit.field === "modelsimPath" &&
      hit.tool === "modelsim" &&
      hit.path === "C:\\modeltech64_2020.4\\win64\\vsim.exe" &&
      hit.source === "known"
  ),
  "检测:厂商安装位置(模式展开)里的 ModelSim 命中,来源标 known"
);

const targetedVersionCalls = [];
const targetedHit = detectTools(
  detectProbe(["C:\\modeltech64_2020.4\\win64\\vsim.exe", "C:\\PF\\Python314\\python.exe"]),
  listStub({ "C:\\": ["modeltech64_2020.4"], "C:\\PF": ["Python314"] }),
  fakeEnv,
  (path) => {
    targetedVersionCalls.push(path);
    return { version: "3.14.0" };
  },
  ["modelsimPath"]
);
check(
  targetedHit.length > 0 && targetedHit.every((hit) => hit.field === "modelsimPath"),
  "单工具检测只返回请求的工具候选"
);
check(targetedVersionCalls.length === 0, "检测 ModelSim 时不会顺带启动 Python 版本查询");

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
const modelsimHits = bothHit.filter((hit) => hit.tool === "modelsim");
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
  xsimHit.some((hit) => hit.field === "xsimPath" && hit.tool === "xsim" && hit.path === "C:\\AMDDesignTools\\2025.2\\Vivado\\bin"),
  "检测:XSim 报的是 bin 目录(那个字段本来就是目录,不是 xvlog.bat)"
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

// ── 版本查询:检测路径上**唯一**允许起进程的地方(R-03) ──────────────────────
//
// 它是只读的:起一次进程、把版本号打印出来。断言的是**只报实测、不做判定** —— 本模式现在不把
// 任何版本当硬要求(带 `expected` 的那套判定随终端字段一起删了,见 FIELDS 顶上的注),所以这一节
// 没有"匹配 / 不匹配"可言,只有"报出来了 / 报不出来"两种交代;而且检测不能被它拖垮。
const pyFilePath = "C:\\PF\\Python314\\python.exe";
const pyEnv = { ProgramFiles: "C:\\PF", LocalAppData: "C:\\LA", PATH: "" };
const pyList = listStub({ "C:\\PF": ["Python314"] });
const versionSpy = (calls, result) => (path) => {
  calls.push(path);
  return result;
};
const pyHitOf = (hits) => hits.find((hit) => hit.field === "pythonPath");

const versionCalls = [];
const pyVersion = pyHitOf(detectTools(detectProbe([pyFilePath]), pyList, pyEnv, versionSpy(versionCalls, { version: "3.14.0" })));
check(
  pyVersion?.version === "3.14.0" && !("versionOk" in pyVersion) && !("versionExpected" in pyVersion),
  "版本如实报出来,载荷里不带任何「够不够」的判定键(本模式没有硬要求)",
  JSON.stringify(pyVersion)
);
check(pyVersion?.versionNote?.includes("3.14.0"), "实测版本也写进给人的那句提示里", String(pyVersion?.versionNote));
check(
  versionCalls.length === 1 && versionCalls[0] === pyFilePath,
  `只对该候选起一次版本查询(实际 ${versionCalls.length} 次)且查的是它本身`
);

const brokenCalls = [];
const pyBroken = pyHitOf(detectTools(detectProbe([pyFilePath]), pyList, pyEnv, versionSpy(brokenCalls, { error: "ENOENT" })));
check(
  pyBroken?.version === undefined && String(pyBroken?.versionError).includes("ENOENT"),
  "命令跑不起来 → 如实报 error、不猜版本,也不当成报出来了",
  JSON.stringify(pyBroken)
);
check(pyBroken?.versionNote?.includes("查不出来"), "跑不起来时提示里说清「查不出来」(不是留空让人以为没问题)");
// 桩抛异常也不能让整次检测崩:检测是"点一下就出结论"的只读动作
const pyThrew = pyHitOf(
  detectTools(detectProbe([pyFilePath]), pyList, pyEnv, () => {
    throw new Error("boom");
  })
);
check(
  pyThrew?.path === pyFilePath && pyThrew?.version === undefined,
  "版本查询抛异常 → 按「查不出来」处理,其余候选照常返回"
);

// 别的工具(仿真器/综合器/编译器)一次进程都不许起
const otherCalls = [];
detectTools(detectProbe(["C:\\modeltech64_2020.4\\win64\\vsim.exe"]), listStub({ "C:\\": ["modeltech64_2020.4"] }), fakeEnv, versionSpy(otherCalls, { version: "x" }));
detectTools(detectProbe(["C:\\altera\\13.0sp1\\quartus\\bin64\\quartus_sh.exe"]), listStub({ "C:\\": ["altera"], "C:\\altera": ["13.0sp1"] }), fakeEnv, versionSpy(otherCalls, { version: "x" }));
check(otherCalls.length === 0, `不带 version 的候选不查版本(实际起了 ${otherCalls.length} 次进程)`);

// queryVersion 本身也得真能起进程 —— 桩只能证明接线对。拿 node 当被测程序(测试时它一定在),
// 失败那条用一个不存在的路径(确定性,不依赖任何已装工具)。
const realVersion = queryVersion(process.execPath, { args: ["--version"], pattern: /(\d+\.\d+\.\d+)/u });
check(
  typeof realVersion.version === "string" && /^\d+\./u.test(realVersion.version),
  `queryVersion 真起进程并解析出版本(实际 ${JSON.stringify(realVersion)})`
);
const realMissing = queryVersion(join(TMP_ROOT, `no-such-exe-${RUN_ID}.exe`), { args: ["--version"], pattern: /(\d+)/u });
check(
  realMissing.version === undefined && typeof realMissing.error === "string",
  `可执行文件不存在时如实报 error、不抛不猜(实际 ${JSON.stringify(realMissing)})`
);

// ── F-14:命令**没有正常结束**时,输出里那个版本号不算数 ──────────────────────────
//
// 实测踩到的用例:`pwsh -Command 'Write-Error "needs PowerShell 7.6.6"; exit 1'` —— 命令明明失败,
// stderr 里却有一个看着完全合法的版本号。照旧"取输出里第一个版本号"就会得到假匹配
// (`{version:"7.6.6"}`,而真相是这个程序根本没答话)。判据必须先是**命令成没成**。
// 三条都要咬人:失败 / 超时 / 输出形状不对(截断或被噪声污染也是这一类)。
const failedQuery = queryVersion(process.execPath, {
  args: ["-e", 'console.error("needs PowerShell 7.6.6"); process.exit(1)'],
  pattern: /(\d+\.\d+(?:\.\d+)*)/u
});
check(
  failedQuery.version === undefined && /退出码 1/u.test(String(failedQuery.error)),
  `退出码非 0 → 一律当"查不出":stderr 里那个 7.6.6 不许被当成版本(实际 ${JSON.stringify(failedQuery)})`
);
const shapedWrong = queryVersion(process.execPath, {
  // 退出码 0,但输出**不是**这条命令该有的形状(真实查询只会打印一行 7.6.6)
  args: ["-e", 'console.log("needs PowerShell 7.6.6")'],
  pattern: /^\s*(\d+\.\d+\.\d+)\s*$/mu
});
check(
  shapedWrong.version === undefined,
  `输出不是该工具的真实形状(行不对齐 / 被别的话盖住)→ 报"查不出",不取其中随便一个版本号(实际 ${JSON.stringify(shapedWrong)})`
);
// 超时:spawnSync 到点杀掉子进程(status 为 null)。实测约 5 秒(VERSION_PROBE_TIMEOUT_MS)。
const timedOut = queryVersion(process.execPath, { args: ["-e", "setTimeout(function () {}, 8000)"], pattern: /(\d+)/u });
check(
  timedOut.version === undefined && /ETIMEDOUT/u.test(String(timedOut.error)),
  `查询超时 → 当"查不出"(实际 ${JSON.stringify(timedOut)})`
);
// 本机真跑一次整条路(默认探针 + 真实版本查询)。断言的是"报出的东西与版本字段自洽":
// 只报了版本、或只报了错,不许两者都空;也不钉死这台机器的版本(换台机器跑不该红)。
const realPython = detectTools().find((hit) => hit.field === "pythonPath");
if (realPython === undefined) {
  console.log("      本机没检测到 python.exe,跳过真实版本核对");
} else {
  console.log(`      本机 python:${realPython.path} → ${String(realPython.version ?? realPython.versionError)}`);
  check(
    typeof realPython.version === "string" || typeof realPython.versionError === "string",
    "真实检测里 python 要么报出版本、要么报出错误(不允许两者都空)"
  );
  check(
    !("versionOk" in realPython) && !("versionExpected" in realPython),
    "真实载荷里也没有「够不够」的判定键(只报实测)"
  );
}

// 每个内置工具都必须有独立检测项；自定义工具只能手填。
for (const [tool, definition] of Object.entries(TOOL_CATALOG).filter(([, entry]) => entry.nameKey === undefined)) {
  check(
    DETECT_TARGETS.some((target) => target.tool === tool && target.field === definition.pathKey),
    `${tool} 有对应的工具专属检测项`
  );
}

check(
  CAPABILITIES.every((capability) => FIELDS.find((field) => field.key === capability.toolKey)?.options.some((option) => option.value === "none")),
  "每张能力卡都有明确不用选项"
);
check(statusOf({ moduleRtlTool: "none" }).missing.length === 0, "none 是用户决定,不进缺失清单");
check(
  describeEnv({ moduleRtlTool: "none" }, probeWith([])).includes("明确不用"),
  "none 在提示中与自动判断、路径缺失明确区分"
);

const quartus64 = detectTools(
  detectProbe(["C:\\altera\\13.0sp1\\quartus\\bin64\\quartus_sh.exe", "C:\\altera\\13.0sp1\\quartus\\bin\\quartus_sh.exe"]),
  listStub({ "C:\\": ["altera"], "C:\\altera": ["13.0sp1"] }),
  fakeEnv
);
check(
  quartus64.filter((hit) => hit.tool === "quartus").length === 1 &&
    quartus64.some((hit) => hit.path === "C:\\altera\\13.0sp1\\quartus\\bin64\\quartus_sh.exe"),
  "检测:Quartus 认 altera\\<版本>\\quartus\\bin64;bin64 与 bin 同时在时只报 bin64(同一个工具不列两遍)"
);

const quartus32 = detectTools(
  detectProbe(["C:\\altera\\13.0sp1\\quartus\\bin\\quartus_sh.exe"]),
  listStub({ "C:\\": ["altera"], "C:\\altera": ["13.0sp1"] }),
  fakeEnv
);
check(
  quartus32.some((hit) => hit.tool === "quartus" && hit.path === "C:\\altera\\13.0sp1\\quartus\\bin\\quartus_sh.exe"),
  "检测:只有 32 位 bin 的老版本(Quartus II 13)也认(fallback 那一组)"
);

check(
  TOOL_CATALOG.quartus.supportNote.includes("只保证路径与检测") && !TOOL_CATALOG.quartus.supportNote.includes("完整工程流程已支持"),
  "Quartus 把路径可用与完整流程支持分开说明"
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
    (hit) => hit.field === "modelsimPath" && hit.tool === "modelsim" && hit.path === "C:\\bin\\vsim.exe" && hit.source === "path"
  ),
  "检测只报机器上找到的(PATH 命中照样报出来)"
);

check(detectTools(detectProbe([]), listStub({}), { PATH: "" }).length === 0, "检测:什么都没有时返回空(不抛、不猜)");
// 检测**只在版本查询那一处**起进程(R-03):别的地方仍然只读文件系统 —— "点一下检测"
// 不该变成"可能挂住或跑一堆命令"。所以按源码定位:起进程的调用只许出现在 queryVersion 里。
const toolchainSource = readFileSync(new URL("../lib/toolchain.js", import.meta.url), "utf8");
const toolchainLines = toolchainSource.split("\n");
const spawnPattern = /child_process|execSync|spawnSync|execFile|spawn\(/u;
const importLine = toolchainLines.findIndex((line) => spawnPattern.test(line) && line.startsWith("import "));
const versionStart = toolchainLines.findIndex((line) => line.includes("export function queryVersion"));
const versionEnd = toolchainLines.findIndex((line, index) => index > versionStart && line === "}");
const outsideVersion = toolchainLines
  .map((line, index) => ({ line, index }))
  .filter(({ line, index }) => spawnPattern.test(line) && index !== importLine && !(index > versionStart && index < versionEnd));
check(
  importLine >= 0 && versionStart > 0 && versionEnd > versionStart,
  `找得到那个唯一的版本查询函数(定位:import ${importLine} / 函数 ${versionStart}-${versionEnd})`
);
check(
  outsideVersion.length === 0,
  `起进程只出现在 queryVersion 里,其余字段只探文件系统(越界 ${outsideVersion.length} 处:${outsideVersion.map(({ index }) => `第 ${index + 1} 行`).join("、") || "无"})`,
  outsideVersion.map(({ line }) => line.trim()).join("\n        ")
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

// 待清理清单:还在的留着,用户清掉的不再列(否则设置页永远念着那两个文件)。
const cleanupRoot = join(TMP_ROOT, `cleanup-live-${RUN_ID}`);
mkdirSync(join(cleanupRoot, "templates"), { recursive: true });
writeFileSync(join(cleanupRoot, "templates", "old_a.tcl"), "旧的\n");
check(
  JSON.stringify(existingUnder(cleanupRoot, ["templates/old_a.tcl", "templates/old_b.tcl"])) ===
    JSON.stringify(["templates/old_a.tcl"]),
  "待清理清单只列仍然存在的项(清完的就不再念)"
);

const backedUp = backupChangedFiles(backupSource, backupTarget, join(backupRoot, "out"));
// 第九轮复审:备份范围收敛到**托管文件**(listFiles(source)) —— foreign 文件既不会被 cpSync 覆盖,
// 也没有备份它们的必要;若 foreign 是指向预设外的 symlink,copyFileSync 还会把外部内容读进备份。
check(
  backedUp?.count === 1,
  `只备份**被改过内容的托管文件**(用户新增的 foreign 不进备份;实际 ${String(backedUp?.count)} 个)`
);
check(
  backedUp.files.some((file) => file.endsWith(join("skills", "SKILL.md")))
    && readFileSync(backedUp.files.find((file) => file.endsWith(join("skills", "SKILL.md"))), "utf8").includes("用户自己改的"),
  "备份下来的是用户那份的内容"
);
check(
  !backedUp.files.some((file) => file.endsWith("我加的笔记.md")),
  "用户自己放进来的 foreign 文件不进备份(它不会被同步覆盖,靠 cpSync 只写托管文件来保住)"
);
check(!backedUp.files.some((file) => file.endsWith("preset.yml")), "没改动的文件不备份(不制造无用备份)");
check(
  backupChangedFiles(backupSource, backupSource, join(backupRoot, "never")) === undefined,
  "两边一致时不做任何备份"
);
// 第八轮复审 E8-02:用户预设目录里的同名 **链接 / Junction** 不能被 cpSync 换成普通文件
// (文本有备份、链接关系恢复不了)。判据是生产函数 `nonRegularOverwriteTargets`;夹具用
// **Junction**(Windows 上不需要特权即可创建)—— 真文件 symlink 需要特权,造不出时记 SKIP,不记 PASS。
const e802Root = join(TMP_ROOT, `e802-${RUN_ID}-${String(Date.now())}`);
const e802Dest = join(e802Root, "user");
mkdirSync(join(e802Dest, "skills"), { recursive: true });
writeFileSync(join(e802Dest, "skills", "SKILL.md"), "用户自己写的内容\n");
writeFileSync(join(e802Dest, "普通文件.md"), "正常文件\n");
let e802JunctionMade = false;
try {
  mkdirSync(join(e802Root, "outside"), { recursive: true });
  writeFileSync(join(e802Root, "outside", "secret.md"), "OUTSIDE_SENTINEL\n");
  symlinkSync(join(e802Root, "outside"), join(e802Dest, "skills", "linked"), "junction");
  e802JunctionMade = true;
} catch (error) {
  console.log(`  SKIP E8-02 夹具:造不出 Junction(${String(error.code ?? error.message)})—— 记 SKIP,不记 PASS`);
}
if (e802JunctionMade) {
  const targets = nonRegularOverwriteTargets(e802Dest, [
    "skills/SKILL.md",
    "普通文件.md",
    "skills/linked",
    "skills/linked/secret.md",
    "还没建的.md"
  ]);
  check(
    targets.includes("skills/linked"),
    `非普通文件目标(junction 本目录)被点出来:${JSON.stringify(targets)}`
  );
  check(
    targets.includes("skills/linked/secret.md"),
    `穿过 junction 的目标也被点出来(不会顺着链接去覆盖外部文件):${JSON.stringify(targets)}`
  );
  check(
    !targets.includes("普通文件.md") && !targets.includes(join("skills", "SKILL.md")) && !targets.includes("还没建的.md"),
    `普通文件与还不存在的目标**不**算非普通文件(不误伤正常同步):${JSON.stringify(targets)}`
  );
  check(
    readFileSync(join(e802Root, "outside", "secret.md"), "utf8").includes("OUTSIDE_SENTINEL"),
    "判据只读目录项、不动外部文件的内容"
  );
}

check(
  backupChangedFiles(backupSource, join(backupRoot, "不存在"), join(backupRoot, "never")) === undefined,
  "目标不存在时不做备份"
);

// 我们从包里删掉的文件,用户预设目录里那份会**留在原地** —— 但必须被列出来(过期技能/模板)。
// 技能是从用户预设目录扫的,包里删掉的旧技能照样在被加载,所以这件事必须报,不能沉默。
//
// 但**判据只能是"上次同步清单里记过没有"**:以前还有一半是"只要在 skills/ 这种行为目录下,
// 包里没有就删" —— 那会连**用户自己写的技能**一起算进去(这个目录本来就是他的地盘)。
const staleRoot = join(TMP_ROOT, `stale-check-${RUN_ID}-${String(Date.now())}`);
const staleSource = join(staleRoot, "source");
const staleTarget = join(staleRoot, "user");
mkdirSync(join(staleSource, "skills", "keep-me"), { recursive: true });
writeFileSync(join(staleSource, "skills", "keep-me", "SKILL.md"), "还在提供的技能\n");
mkdirSync(join(staleTarget, "skills", "keep-me"), { recursive: true });
mkdirSync(join(staleTarget, "skills", "gone"), { recursive: true });
// 用户自己写的技能:目录名与插件无关、清单里也没有 —— 正是以前会被误删的那一类
mkdirSync(join(staleTarget, "skills", "my-own-skill"), { recursive: true });
writeFileSync(join(staleTarget, "skills", "keep-me", "SKILL.md"), "还在提供的技能\n");
writeFileSync(join(staleTarget, "skills", "gone", "SKILL.md"), "我们已经删掉的旧技能\n");
writeFileSync(join(staleTarget, "skills", "my-own-skill", "SKILL.md"), "用户自己写的技能\n");
writeFileSync(join(staleTarget, "用户自己的笔记.md"), "用户加的\n");

const shippedBefore = ["skills/keep-me/SKILL.md", "skills/gone/SKILL.md"];
const diff = presetFileDiff(staleSource, staleTarget, shippedBefore);
check(diff.stale.includes("skills/gone/SKILL.md"), "上次是我们写的、包里已删的文件进「待清理」清单", JSON.stringify(diff.stale));
check(!diff.stale.includes("skills/keep-me/SKILL.md"), "包里还提供的文件不进清单");
check(!diff.stale.includes("用户自己的笔记.md"), "用户自己加的文件不在清单里 → 既不清理也不报成待清理");
check(
  !diff.stale.includes("skills/my-own-skill/SKILL.md"),
  "**用户自己放进 skills/ 的技能不得列为待清理**(行为目录不是我们的地盘 —— R-01 的核心边界)",
  JSON.stringify(diff.stale)
);
check(
  diff.foreign.includes("skills/my-own-skill/SKILL.md") && diff.foreign.includes("用户自己的笔记.md"),
  `清单外的文件进 foreign 报出来(发现非本插件文件,已保留:实际 ${JSON.stringify(diff.foreign)})`
);
check(
  staleShippedFiles(staleSource, staleTarget, shippedBefore).join(",") === diff.stale.join(","),
  "staleShippedFiles 就是 presetFileDiff 的 stale 那一半(同一个判据,不是两份实现)"
);
check(listFiles(staleSource).join(",") === "skills/keep-me/SKILL.md", "listFiles 给出相对路径且用 / 分隔");

// ── 同步清单要按当前事实一次算清(第四轮复审 Q4-06)──────────────────────────
//
// 停用旧技能(改名)与"要不要重新复制内容"是两件事:以前只有 cpSync 那条分支写清单,于是
// "只剩一个旧技能要停用、其余内容一致"时,清单里不记 `.disabled-by-plugin` → 下次它被当成
// "用户自己放的东西",待清理与归属都不再真实。
check(
  nextManifest(["a.md", "skills/keep/SKILL.md"], ["skills/gone/SKILL.md"], ["skills/gone/SKILL.md.disabled-by-plugin"]).join(",") ===
    ["a.md", "skills/gone/SKILL.md", "skills/gone/SKILL.md.disabled-by-plugin", "skills/keep/SKILL.md"].join(","),
  "nextManifest:包内的 + 上次是我们的过期文件 + 这次停用的,都记进清单(排序去重)"
);
check(
  nextManifest(["a.md"], [], []).join(",") === "a.md" && nextManifest([], undefined, undefined).length === 0,
  "nextManifest:没有过期/停用项时就是包内清单;空输入不炸"
);
check(
  nextManifest(["a.md", "a.md"], ["a.md"], []).join(",") === "a.md",
  "nextManifest:同一路径只记一次(去重)"
);
// ── 停用过期技能入口(第三轮复审 N-11)──────────────────────────────────────
//
// 宿主的技能插件没有白名单配置:只要 `SKILL.md` 还在,老技能就照样进活动技能集合 —— 所以
// "只列出待清理"拦不住加载。这里判的是**该把哪些改名停用**(改名不是删除,可改回)。
const dormantNow = dormantTargets(diff.stale);
check(
  dormantNow.length === 1 && dormantNow[0].from === "skills/gone/SKILL.md" &&
    dormantNow[0].to === `skills/gone/SKILL.md${DORMANT_SUFFIX}`,
  `过期技能入口会被改名停用(实际 ${JSON.stringify(dormantNow)})`
);
check(
  dormantTargets(["templates/old.tcl", "verif/old.md", "skills/keep-me/notes.md"]).length === 0,
  "只动技能入口文件(名叫 SKILL.md 的):模板 / 说明文档不改名(它们不参与加载)"
);
check(
  dormantTargets([`skills/gone/SKILL.md${DORMANT_SUFFIX}`]).length === 0,
  "已经带停用后缀的不再处理(幂等:重跑不会变成 .disabled-by-plugin.disabled-by-plugin)"
);
check(isDormantPath(`skills/gone/SKILL.md${DORMANT_SUFFIX}`) && !isDormantPath("skills/gone/SKILL.md"), "isDormantPath 认停用标记");
check(
  !dormantTargets(diff.stale).some((item) => item.from.startsWith("skills/my-own-skill/")),
  "**用户自己放进 skills/ 的技能永不被停用**(它根本不在 stale 里 —— R-01 边界)"
);

// 清单丢了(第一次升级 / 清单被删)时就**分不清**"我们的旧技能"与"用户写的技能" ——
// 那种情况下一个都不列:列错了会让人去清用户的东西。留着最多是多加载一个技能。
const noManifest = presetFileDiff(staleSource, staleTarget, undefined);
check(noManifest.stale.length === 0, "没有清单时一律不列为待清理(分不清是谁写的)", JSON.stringify(noManifest.stale));
check(
  noManifest.foreign.includes("skills/gone/SKILL.md") &&
    noManifest.foreign.includes("skills/my-own-skill/SKILL.md"),
  `没有清单时两者都报成「非本插件文件,已保留」(实际 ${JSON.stringify(noManifest.foreign)})`
);
// 清单里记过、但位于 skills/ 之外的(比如旧模板):按清单列进待清理
writeFileSync(join(staleTarget, "旧模板.sv"), "包里已经没有的模板\n");
const withManifest = staleShippedFiles(staleSource, staleTarget, [...shippedBefore, "旧模板.sv"]);
check(withManifest.includes("旧模板.sv"), "清单里记过、位于 skills/ 之外的文件进待清理清单");
check(!staleShippedFiles(staleSource, staleTarget, undefined).includes("旧模板.sv"), "没有清单时不动 skills/ 之外的文件");
// 宿主那半侧也得按这套走:按清单列出待清理 + 把保留数量报进返回值(设置页那条事实)。
// lib/index.js 要 schemastery,这里 import 不了,所以断言源码 —— "行为目录那一半"不许复活。
check(
  /const \{ stale, foreign \} = presetFileDiff\(source, destination, manifest\)/u.test(hostSource) &&
    !/behaviorDirs/u.test(hostSource),
  "宿主按清单列出待清理,且不再有「行为目录下就算我们的」这半(源码级)"
);
check(
  hostSource.includes("个非本插件文件,已保留") && /keptForeign/u.test(hostSource),
  "宿主把「发现非本插件文件,已保留」写进日志与 presetSync() 返回值(不是静默保留)"
);
// 待清理清单必须**真的**进返回值:只写日志的话设置页看不见,用户也就不会去处置。
// (lib/index.js import 不了 schemastery,所以这条是源码级断言;行为验证在 .tmp 沙箱里另跑。)
check(
  /cleanupEntry\(isDormantPath\(rel\) \? "dormant" : "stale", join\(destination, rel\)\)/u.test(hostSource) &&
    /cleanupEntry\("dormant", join\(destination, rel\)\)/u.test(hostSource) &&
    /cleanupEntry\("emptyDir", dir\)/u.test(hostSource),
  "宿主的待清理清单分三类:过期技能/模板 + 已停用的旧技能 + 空技能目录(源码级)"
);
// N-11:停用是**改名**(不是删除),而且新名字要记进同步清单 —— 否则下次会被当成"用户自己放的东西"
check(
  /function disableDormantSkills\(/u.test(hostSource) &&
    /renameSync\(abs, target\)/u.test(hostSource) &&
    /nextManifest\(listFiles\(source\), stale, dormant\)/u.test(hostSource) &&
    /dormant\.length > 0/u.test(hostSource),
  "宿主把过期技能入口**改名**停用,并把停用后的名字写进同步清单(源码级;绝不删除)"
);
check(
  (hostSource.match(/recordPresetSync\(\{[^}]*pendingCleanup/gu) ?? []).length >= 2,
  "「无需同步」与「已同步」两条路径都把 pendingCleanup 带进 presetSync() 返回值"
);
check(
  /pendingCleanup/u.test(hostSource),
  "宿主侧用 pendingCleanup 报告待清理(源码级;零删除由本文件末尾的静态守卫把住)"
);
check(
  /reportPendingCleanup\(ctx, pendingCleanup, join\(home, BACKUP_DIR, CLEANUP_REPORTED_FILE\)\)/u.test(hostSource) &&
    /CLEANUP_REPORTED_FILE/u.test(hostSource),
  "宿主把「已提示过」的记录文件路径传进去(同一批只提示一次要靠它持久化;源码级)"
);

// ── 待清理清单:同一批只提示一次(用户定案 2026-09-21)─────────────────────────
//
// 这些东西我们永远不会删,同一条反复提示就是每天一次的噪音。判据两半:
//   · 新出现的才提示;已提示过的(仍在清单里)不再提示 → 提醒只喊一次;
//   · "已提示过"的记录按**这次的清单**重写(剪掉已消失的路径)→ 同名空壳将来重现时还会提示。
const cleanupNow = [
  cleanupEntry("emptyDir", "C:\\home\\skills\\gone"),
  cleanupEntry("stale", "C:\\home\\skills\\old\\SKILL.md")
];
const freshOnly = newlyReportedCleanup(cleanupNow, ["C:\\home\\skills\\gone"]);
check(
  freshOnly.length === 1 && freshOnly[0].path.endsWith("SKILL.md"),
  `已经提示过的条目不再重复提示,只报新出现的(实际 ${freshOnly.map((e) => e.path).join("、") || "无"})`
);
check(newlyReportedCleanup(cleanupNow, []).length === 2, "第一次(没有记录)时全部提示");
check(newlyReportedCleanup([], ["C:\\x"]).length === 0, "没有待清理项时什么都不提示");
check(
  nextReportedCleanup([...cleanupNow, cleanupEntry("temp", "C:\\tmp\\a.tmp")]).length === 3 &&
    nextReportedCleanup([cleanupNow[0]]).join(",") === "C:\\home\\skills\\gone",
  "记录按这次的清单重写(消失的路径被剪掉;同一路径将来重现时还会提示)"
);
// 文案:空目录那条要把"可能是谁的"说清 —— 不然用户会以为一定是插件留下的
check(
  /空技能目录/u.test(CLEANUP_KINDS.emptyDir) && /也可能是你自己建/u.test(CLEANUP_KINDS.emptyDir),
  "「空技能目录」的说明写清它可能是谁的(插件删/改名技能的壳,或你自己建的空目录)"
);

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
  backupChangedFiles(syncSource, syncTarget, join(syncRoot, "out")) === undefined,
    "只有用户自己加的文件时**不产生备份**(新契约:备份只覆盖托管文件;用户文件靠 cpSync 只写托管文件来保住)"
);
writeFileSync(join(syncSource, "preset.yml"), "包内新版\n");
check(presetSyncNeeded(syncSource, syncTarget, syncManifest) === true, "包内文件变了 → 要同步");
writeFileSync(join(syncTarget, "preset.yml"), "包内新版\n");
mkdirSync(join(syncTarget, "skills", "gone"), { recursive: true });
writeFileSync(join(syncTarget, "skills", "gone", "SKILL.md"), "包内已删的旧技能\n");
check(
  presetSyncNeeded(syncSource, syncTarget, [...syncManifest, "skills/gone/SKILL.md"]) === false,
  "包内已删的旧技能还在 → **不算「需要同步」**:零删除之后同步清不掉它,算进去只会每次启动白备份 + 白复制一遍",
  "它改由 pendingCleanup 报出来(见上面 presetFileDiff 那组断言)"
);

// 空技能目录(被删技能腾出来的壳)也**不删**,只列出来:技能按目录扫,空目录不会被加载,
// 但留着会让人误判"技能还在"。只处理 skills/ 下的那一层,用户自己建的东西不碰。
const pruneRoot = join(TMP_ROOT, `prune-skills-${RUN_ID}-${String(Date.now())}`);
mkdirSync(join(pruneRoot, "旧技能"), { recursive: true });
mkdirSync(join(pruneRoot, "有内容的技能"), { recursive: true });
writeFileSync(join(pruneRoot, "有内容的技能", "SKILL.md"), "还在用\n");
const emptyDirs = listEmptySkillDirs(pruneRoot);
check(
  emptyDirs.length === 1 &&
    emptyDirs[0].endsWith("旧技能") &&
    existsSync(join(pruneRoot, "旧技能")),
  `空技能目录被**列出**且仍留在原地(实际列出 ${emptyDirs.length} 个:${JSON.stringify(emptyDirs)})`
);
check(existsSync(join(pruneRoot, "有内容的技能", "SKILL.md")), "有内容的技能目录不进清单");
check(
  listEmptySkillDirs(join(ROOT, ".tmp", "根本没有这个目录")).length === 0,
  "目录不存在时返回空数组(不抛)"
);

// ── 临时残留:只列"确属我们"的条目,**一个都不删** ──────────────────────────
//
// 归属靠**前缀**确认(那是我们这次运行自己建的名字):前缀不命中 → 不列、不碰;
// 没有前缀 = 没有归属依据 → 连列都不列(空数组)。宽限期内的标成 pending:false
// (那可能是并行那次正在用的 fixture);读不到时间的按待清理列出并写明原因。
// 目录名必须**每次运行都是新的**(所以带时间戳,不能只带 PID):这一节依赖"目录刚建出来"
// —— `ours-young` 靠 mtime 落在宽限期内、`ours-dangling` 要现建一个 junction。而 `.tmp/` 里的
// fixture 按用户定案**不删除**,PID 会被系统回收:第二次撞上同一个 PID 时,`mkdirSync` 落在旧目录上
// (mtime 是旧的、junction 已存在),这三条断言就红(实测:2026-09-21 一次 `test:installed` 就这么红的)。
// 上面 backup-check / stale-check / prune-skills 已经带了时间戳,同一原因。
const sweepRoot = join(TMP_ROOT, `sweep-check-${RUN_ID}-${String(Date.now())}`);
mkdirSync(join(sweepRoot, "keep-me"), { recursive: true });
mkdirSync(join(sweepRoot, "ours-1"), { recursive: true });
mkdirSync(join(sweepRoot, "ours-young"), { recursive: true });
// 老 fixture:把时间推回到宽限期之外
const oldTime = new Date(Date.now() - TEMP_GRACE_MS - 60 * 1000);
utimesSync(join(sweepRoot, "ours-1"), oldTime, oldTime);
writeFileSync(join(sweepRoot, "keep-me", "用户的.txt"), "别动\n");

const sweepReport = listTempLeftovers(sweepRoot, ["ours-"], TEMP_GRACE_MS);
check(
  sweepReport.filter((item) => item.pending).length === 1 &&
    sweepReport.find((item) => item.pending)?.name === "ours-1" &&
    existsSync(join(sweepRoot, "ours-1")),
  "只把命中我们前缀、且过了宽限期的条目列为待清理 —— 而且**它还在原地**(实际没删)",
  JSON.stringify(sweepReport)
);
check(existsSync(join(sweepRoot, "keep-me")), "前缀不命中的条目一律不碰、不列(用户的东西)");
check(
  sweepReport.some((item) => item.name === "ours-young" && item.pending === false && /宽限/u.test(item.reason)),
  `宽限期内的条目算「不算待清理」并写明原因(实际 ${JSON.stringify(sweepReport)})`
);

// 拿不准的条目(读不到时间)→ 照样列出、写明原因。用**悬空 junction** 构造:readdir 列得出来,
// stat 失败(ENOENT)—— 正是"无法确认"的那种条目。
const dangling = join(sweepRoot, "ours-dangling");
try {
  symlinkSync(join(sweepRoot, "no-such-target"), dangling, "junction");
  const danglingReport = listTempLeftovers(sweepRoot, ["ours-"], TEMP_GRACE_MS);
  check(
    // 悬空 junction 用 existsSync 看是 false(它跟着链接走),得看目录里还在不在
    readdirSync(sweepRoot).includes("ours-dangling") &&
      danglingReport.some((item) => item.name === "ours-dangling" && /读不到时间/u.test(item.reason)),
    `读不到时间的条目照样列出、写明原因(实际 ${JSON.stringify(danglingReport)})`
  );
} catch (error) {
  check(false, "能造出「读不到时间」的条目来验保留式报告(建 junction 失败)", String(error));
}

// 没有前缀 = 没有归属依据 → 连列都不列(这条防的是"传空数组就把整个目录报成待清理")
check(
  listTempLeftovers(sweepRoot, [], 0).length === 0 &&
    existsSync(join(sweepRoot, "keep-me")) &&
    existsSync(join(sweepRoot, "ours-young")) &&
    existsSync(join(sweepRoot, "ours-1")),
  "没给前缀时一个都不列(无从确认归属),目录里什么都没被删"
);

// ── 模板:用户提供优先,缺了退回插件自带 ─────────────────────────────────────
//
// 写法规范由模板承载(文件头、九个小节、对齐这些),不写死在技能正文里 —— 所以
// "用哪一份"必须在提示里说清,否则 agent 只能猜,而猜错就是格式不一致。
const bundled = resolveTemplates({}, probeFilesystem);
check(bundled.length === 6, `认六种模板:RTL / 测试平台 / 约束 + 仿真 / 综合 / 比对脚本(实际 ${bundled.length})`);
check(
  bundled.every((template) => template.present),
  "插件自带的模板都在包里(少一份,agent 就只能自己编格式)",
  bundled.filter((template) => !template.present).map((template) => template.path).join(", ")
);
check(bundled.every((template) => template.source === "bundled"), "没填模板路径时用自带那份");
// 自带模板给的必须是**绝对路径**,而且解析基准是插件包自身(`import.meta.url`),不是当前工作目录
// (用户口径 2026-09-21:模块按功能分组、挂在任意深度时模板仍要能引用)。相对路径会随 CWD 变,
// 也就会随"从哪个目录跑命令"变 —— 那正是要挡掉的:命令里的 `--template <这份路径>` 必须直接可用。
check(
  bundled.every((template) => isAbsolute(template.path)),
  "自带模板给的是绝对路径(--template 直接可用,与 CWD / 模块根无关)",
  bundled.map((template) => template.path).join(" | ")
);

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

// 新提示按七张能力卡播报模板；六个旧全局路径只供迁移，不能继续左右日常解析。
const capabilityTemplateText = describeEnv(prepared, () => true);
check(
  capabilityTemplateText.includes("模板·RTL 模板") &&
    capabilityTemplateText.includes("rtl\\systemverilog_module.sv") &&
    capabilityTemplateText.includes("simulation\\run\\modelsim_run.do"),
  "提示在对应能力卡下列出分类模板决定"
);
check(
  !describeEnv({ ...prepared, rtlTemplatePath: USER_RTL }, () => true).includes(USER_RTL),
  "旧全局模板路径不再参与 v3 会话提示"
);

// ── 三个环节脚本模板:设置字段与前三份同款,提示里的播报规则不同 ──────────────
//
// 自带那份脚本由命令的默认值起出来(`--kind run-do` / `--kind synth-script` / `--kind comp`,
// 起法写在环节技能里),提示里不必播报一条 agent 不会去读的路径;但用户配了自己那份时**必须**
// 出现 —— 他要把它传给 `--template`,不说就等于没配(这正是本轮补的功能)。
// 设置页那份标签带括号说明(三个模板字段挨着,得让用户看出这是脚本),提示段那份用短名 ——
// 括号里那句说明在提示里是多余的(那一节的用法说明已经写了)。
const SCRIPT_TEMPLATE_FIELDS = [
  { key: "runDoTemplatePath", label: "run.do 模板", settingsLabel: "run.do 模板(仿真脚本)", file: "run.do" },
  { key: "synthScriptTemplatePath", label: "综合脚本模板", settingsLabel: "综合脚本模板", file: "run_synth.tcl" },
  { key: "compScriptTemplatePath", label: "比对脚本模板", settingsLabel: "比对脚本模板", file: "comp.py" }
];
for (const { key, settingsLabel, file } of SCRIPT_TEMPLATE_FIELDS) {
  const field = FIELDS.find((entry) => entry.key === key);
  check(
    field !== undefined &&
      field.group === "旧键" &&
      field.control === "hidden" &&
      field.required === false &&
      field.skips.length === 0,
    `${key}:旧全局模板字段隐藏保留，只供无损迁移`,
    JSON.stringify(field ?? null)
  );
  check(
    !statusOf({}).missing.includes(key),
    `${key} 作为隐藏兼容值不进缺失清单`
  );
}
// 六个旧模板字段必须一个不漏地留在 schema 中，升级时才能扇出到模块与工程的新槽位。
const templateGroupKeys = FIELDS.filter((field) => field.control === "hidden" && TEMPLATE_FIELDS.some((template) => template.key === field.key)).map((field) => field.key);
const templateListKeys = TEMPLATE_FIELDS.map((template) => template.key);
check(
  templateGroupKeys.join(",") === templateListKeys.join(","),
  "六个旧模板字段在隐藏兼容区一一保留",
  `设置字段:${templateGroupKeys.join(",")} / 提示表:${templateListKeys.join(",")}`
);

const USER_LIBRARY_ROOT = "C:\\my-template-library";
const USER_MODULE_RTL = join(USER_LIBRARY_ROOT, "rtl", "module-special.sv");
const USER_PROJECT_RTL = join(USER_LIBRARY_ROOT, "rtl", "project-special.sv");
const independentTemplateValues = {
  ...prepared,
  templateLibraryPath: USER_LIBRARY_ROOT,
  moduleRtlTemplate: "library:rtl/module-special.sv",
  projectRtlTemplate: "library:rtl/project-special.sv"
};
const independentTemplateText = describeEnv(
  independentTemplateValues,
  (path, kind) => kind === "directory"
    ? path === USER_LIBRARY_ROOT
    : [USER_MODULE_RTL, USER_PROJECT_RTL, ...Object.values(prepared)].includes(path)
);
check(
  independentTemplateText.includes(USER_MODULE_RTL) && independentTemplateText.includes(USER_PROJECT_RTL),
  "同类模板共用一座库，但模块与工程各自保留独立选择"
);
check(
  independentTemplateText.includes("只记录来源；展开设置里的能力卡时才扫描目录"),
  "会话提示只说明模板库来源，不触发目录扫描"
);

const missingSelectedTemplate = describeEnv(
  {
    ...prepared,
    templateLibraryPath: USER_LIBRARY_ROOT,
    moduleSimulationRunTemplate: "library:simulation/run/gone.do"
  },
  (path, kind) => kind === "directory" ? path === USER_LIBRARY_ROOT : Object.values(prepared).includes(path)
);
check(
  missingSelectedTemplate.includes("gone.do") && missingSelectedTemplate.includes("原选择已保留") &&
    !missingSelectedTemplate.includes("modelsim_run.do（内置）"),
  "显式模板消失时提示保留原选择，不静默退回内置"
);

const quartusTemplateText = describeEnv(
  { quartusPath: "C:\\Quartus\\quartus_sh.exe", projectMainTool: "quartus" },
  (path) => path === "C:\\Quartus\\quartus_sh.exe"
);
check(
  quartusTemplateText.includes("当前工具没有适配的工程约束模板") &&
    // (模块行的『没有适配的综合脚本』不在这里断言:夹具的 checkPath 把所有模板文件都当缺失,
    //  文案会在『内置参考缺失』与『没有适配』之间摇摆;该语义由 resolveTemplateSelection API 用例覆盖。)
    quartusTemplateText.includes("当前工具没有适配的实现脚本") &&
    quartusTemplateText.includes("当前工具没有适配的下载脚本") &&
      // 第九轮复审③:工程综合给了独立分类(暂无内置)→ Quartus 下这一项也该提示"没有适配的工程综合脚本"
      quartusTemplateText.includes("当前工具没有适配的工程综合脚本"),
  "Quartus 未选用户模板时逐项提示缺少适配默认模板"
);
check(!capabilityTemplateText.includes("模块模板 ——"), "v3 提示不再输出旧的全局模板区块");

// ── 语言与仿真器 ────────────────────────────────────────────────────────────
const langText = describeEnv(prepared, () => true);
check(langText.includes("SystemVerilog (IEEE 1800-2017)"), "提示里给出 RTL 语言与标准(默认 SystemVerilog 1800-2017)");
check(langText.includes("仿真语言"), "提示里给出仿真语言");
check(langText.includes("ModelSim"), "提示里给出 ModelSim 仿真器");
check(langText.includes(".sv"), "提示里给出文件扩展名(写代码时要用)");

const xsimText = describeEnv(
  { ...prepared, xsimPath: "C:\\Vivado\\bin", moduleSimulationTool: "xsim" },
  () => true
);
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
const quartusText = describeEnv(
  { ...prepared, quartusPath: "C:\\Quartus\\quartus_sh.exe", moduleGateTool: "quartus" },
  () => true
);
check(quartusText.includes("quartus_sh"), "换综合器后提示里换成对应工具的命令");
const iverilogText = describeEnv(
  { ...prepared, iverilogPath: "C:\\iverilog\\iverilog.exe", moduleRtlTool: "iverilog" },
  () => true
);
check(iverilogText.includes("-g2012"), "换编译器后提示里换成对应工具的命令");
// 仿真器下拉没有 Verilator(用户口径:仿真不用它)。它是**编译器**下拉里的选项(RTL lint 用它),
// 所以这条按字段分开断言 —— 只看"提示里有 Verilator"会把两件事混在一起。
const simField = FIELDS.find((field) => field.key === "moduleSimulationTool");
const simValues = (simField?.options ?? []).map((option) => option.value);
check(
  !simValues.includes("verilator") && simValues.includes("modelsim") && simValues.includes("questa") && simValues.includes("xsim"),
  `仿真器下拉分别提供 ModelSim / QuestaSim / XSim(实际:${simValues.join("、") || "无"})`
);
const compilerField = FIELDS.find((field) => field.key === "moduleRtlTool");
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
  // 命令名形如 module-rtl-new / module-verif-new:级别前缀之后紧跟环节前缀
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

// ── 静态守卫:生产代码里不许再出现任何"永久删除"调用(用户定案) ──────────────
//
// 为什么用静态守卫而不是行为测试:这是一条**全局**约束,而行为测试只能覆盖被走到的那几条路径
// —— 以后有人在一条新路径里加回删除调用,行为测试照样全绿。这里扫生产代码的源码文本
// (`lib/**`、`presets/*/tools/**`、`tools/install.mjs`、`tools/sync-installed.mjs`),
// 出现删除类调用就红。
//
// 注释会被剥掉(注释里解释"不再删除"不该把自己扫红),字符串里的调用仍会被扫到 —— 那正是
// 想要的严格程度。确需保留的"其实不是删除"的用法,加进白名单并写清理由。
// 扫不到的:第三方进程/包自己的临时文件行为(控制不了,也不该假装扫得到)。
const DELETION_CALL = /\b(?:unlinkSync|unlink|rmSync|rmdirSync|rmdir|rm)\s*\(/u;
const SHELL_DELETION = /\b(?:Remove-Item|rmtree|DeleteDirectory|DeleteFile)\b/u;
/**
 * 白名单:文件 + 该文件的哪一行算正当。
 *
 * 目前只有一条 —— `tools/check-install-safety.mjs` 拿它的 `.tmp/install-mirror` 当**重建**用途
 * (那个镜像里装着整棵依赖树,留着会越攒越大,而它是开发期脚本、只跑 `--safety`、不进生产路径)。
 * 注意它**不在**生产范围里,这里显式登记只是把例外写在明面上,免得以后被当成漏网。
 */
const DELETION_ALLOWLIST = [
  {
    file: "tools/check-install-safety.mjs",
    pattern: /rmSync\(MIRROR/u,
    reason: "开发期脚本自管 .tmp/install-mirror(重建镜像;整棵依赖树不能留)"
  }
];

/** 剥掉注释(块注释 + 行注释),保留字符串 —— 字符串里的删除调用也该扫出来。 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/u, "$1"))
    .join("\n");

/** 生产代码里"绝不永久删除"这条约束要覆盖的文件。 */
function guardedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs)$/u.test(entry.name)) out.push(full);
    }
  };
  const libDir = join(ROOT, "lib");
  if (existsSync(libDir)) walk(libDir);
  const presetsDir = join(ROOT, "presets");
  for (const preset of existsSync(presetsDir) ? readdirSync(presetsDir, { withFileTypes: true }) : []) {
    const toolsDir = join(presetsDir, preset.name, "tools");
    if (preset.isDirectory() && existsSync(toolsDir)) walk(toolsDir);
  }
  for (const file of ["install.mjs", "sync-installed.mjs"]) {
    const full = join(ROOT, "tools", file);
    if (existsSync(full)) out.push(full);
  }
  return out;
}

const guarded = guardedFiles();
const deletionHits = [];
for (const file of [...guarded, join(ROOT, "tools", "check-install-safety.mjs")]) {
  const rel = relative(ROOT, file).split(sep).join("/");
  stripComments(readFileSync(file, "utf8"))
    .split("\n")
    .forEach((line, index) => {
      if (!DELETION_CALL.test(line) && !SHELL_DELETION.test(line)) return;
      const allowed = DELETION_ALLOWLIST.some((rule) => rule.file === rel && rule.pattern.test(line));
      if (allowed) return;
      deletionHits.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
}
check(
  guarded.length > 0 && deletionHits.length === 0,
  `生产代码(${guarded.length} 个文件)里没有任何永久删除调用 —— 用户定案:零删除 + 如实报告`,
  deletionHits.join("\n        ")
);
check(
  guarded.some((file) => relative(ROOT, file).split(sep).join("/") === "lib/toolchain.js") &&
    guarded.some((file) => relative(ROOT, file).split(sep).join("/") === "tools/install.mjs") &&
    guarded.some((file) => relative(ROOT, file).split(sep).join("/") === "tools/sync-installed.mjs") &&
    guarded.some((file) => relative(ROOT, file).split(sep).join("/") === "presets/fpga-workbench/tools/lib/stamp.mjs"),
  `守卫真扫到了那四个关键文件(守卫本身不许空转:实际 ${guarded.map((file) => relative(ROOT, file).split(sep).join("/")).join("、")})`
);
check(
  DELETION_ALLOWLIST.every((rule) => existsSync(join(ROOT, rule.file))),
  "白名单里登记的文件都存在(名字写错等于白名单永远不生效)"
);

// ── 安装器的回滚要覆盖"add 之后的失败"(第三轮复审 N-02)────────────────────────
//
// 以前只有 `dsh plugin add` 失败才回滚:pnpm 返回 0 却少拷了文件、或新副本一加载就炸时,坏副本
// **留在盘上**(备份就在旁边),重启就是黑屏。断言锚在**代码形状**上(注释里出现"回滚"不算数):
// 必须有一个统一 rollback(内部调 restore(backup)),且"比对不一致"与"冒烟失败"两条路都走它。
const installSource = stripComments(readFileSync(join(ROOT, "tools", "install.mjs"), "utf8"));
check(
  /const rollback = \(what\) => \{[\s\S]{0,600}?restore\(backup\)/u.test(installSource),
  "install.mjs 有统一的 rollback(内部调 restore(backup))"
);
check(
  /if \(after\.length !== 0\) \{\s*rollback\(/u.test(installSource),
  "已装副本比对不一致时走回滚(不是只打印就退出)"
);
check(
  /if \(\(smoke\.status \?\? 1\) !== 0\) \{\s*rollback\(/u.test(installSource),
  "冒烟失败时走回滚(坏副本不能留在盘上等着被重启加载)"
);

// ── 同步/安装的事务语义(第四轮复审 Q4-03 / Q4-04 / Q4-05)────────────────────
//
// 断言锚在**代码形状**上(注释里出现关键词不算):逐个文件"临时文件 → 读回比对 → 改名就位"、
// 回滚集合包含**正在写的那一个**、事后校验失败/抛异常也回滚、安装器用窄 try/catch 包住 add 之后。
const syncTxnSource = stripComments(readFileSync(join(ROOT, "tools", "sync-installed.mjs"), "utf8"));
check(
  /writeFileSync\(temporary, bytes\)/u.test(syncTxnSource) &&
    /readFileSync\(temporary\)\.equals\(bytes\)/u.test(syncTxnSource) &&
    /renameSync\(temporary, target\)/u.test(syncTxnSource),
  "sync-installed 逐文件:临时文件 → 读回逐字节比对 → 改名就位(半截目标结构上不会出现;Q4-03)"
);
check(
  /inFlight === undefined \? writtenTargets : \[\.\.\.writtenTargets, inFlight\]/u.test(syncTxnSource),
  "sync-installed 回滚集合包含**正在写的那一个**(Q4-03)"
);
check(
  /同步后校验抛异常[\s\S]{0,200}?rollback\(\)/u.test(syncTxnSource) &&
    /FAIL: 同步后仍有[\s\S]{0,300}?rollback\(\)/u.test(syncTxnSource),
  "sync-installed 事后校验抛异常 / 不通过都回滚,不说“重启生效”(Q4-04)"
);
const installSource2 = stripComments(readFileSync(join(ROOT, "tools", "install.mjs"), "utf8"));
check(
  /try \{[\s\S]{0,400}?const after = verify\(\)[\s\S]{0,1200}?catch \(error\) \{\s*rollback\(/u.test(installSource2),
  "install.mjs 用窄 try/catch 包住 add 之后的校验与冒烟,异常也走 rollback(Q4-05)"
);
check(
  /backup === undefined[\s\S]{0,600}?renameSync\(INSTALLED, stray\)/u.test(installSource2),
  "首次安装失败时把坏副本**改名隔离**(没有旧版本可恢复,也不留在盘上;Q4-05)"
);
// ── 用到的 node:fs 符号必须都导入(第四轮复审 1.1 的根因守卫)──────────────────
//
// 实测踩过:`lib/index.js` 里加了 `renameSync(...)` 却忘了加进 `import {...} from "node:fs"` ——
// `node --check` 只查语法、不查未定义标识符;运行时抛的 ReferenceError 又被外层 catch 吞成一条警告,
// 于是"停用旧技能"这条路径**完全失效而自检全绿**。判据:用到的名字 ⊆ 导入的名字。
const FS_SYMBOLS = [
  "appendFileSync", "chmodSync", "closeSync", "copyFileSync", "cpSync", "existsSync", "lstatSync", "mkdirSync",
  "openSync", "readFileSync", "readdirSync", "realpathSync", "renameSync", "rmSync", "statSync", "symlinkSync",
  "unlinkSync", "writeFileSync"
];
for (const file of guarded) {
  const text = stripComments(readFileSync(file, "utf8"));
  const rel = relative(ROOT, file).split(sep).join("/");
  const imported = new Set(
    [...text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']node:fs["']/gu)]
      .flatMap((match) => match[1].split(",").map((piece) => piece.trim().split(/\s+as\s+/u).pop()))
  );
  if (imported.size === 0) continue; // 这个文件没用具名导入(或压根不碰 node:fs)
  const missing = FS_SYMBOLS.filter((name) => new RegExp(`(?<![\\w.$])${name}\\s*\\(`, "u").test(text) && !imported.has(name));
  check(
    missing.length === 0,
    `${rel} 用到的 node:fs 符号都写在导入表里(实测踩过:忘了导入 → 运行时 ReferenceError 被吞)`,
    missing.length === 0 ? undefined : `缺:${missing.join("、")}`
  );
}
console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 工具链判定、提示文案与两侧契约全部正确");
if (failures.length > 0) process.exitCode = 1;

// 收尾:fixture **不删**(用户定案:绝不永久删除),只把这次留在 .tmp/ 里的列出来。
// 代价是 .tmp/ 会一直增长 —— 所以这里把清单和处置办法打出来,不假装已经清干净。
const leftOver = listTempLeftovers(TMP_ROOT, FIXTURE_PREFIXES);
if (leftOver.length > 0) {
  console.log(`\n.tmp/ 里现有 ${leftOver.length} 项本次/上次留下的 fixture(按用户定案不删除,请自行处置):`);
  for (const item of leftOver.filter((entry) => entry.pending).slice(0, 20)) console.log(`  [临时项] ${item.path}`);
  if (leftOver.filter((entry) => entry.pending).length > 20) console.log("  …(更多条目略)");
}
