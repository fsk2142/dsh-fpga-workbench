// 工具链:字段定义 + 存在性判定 + 给会话提示的说明 —— 只 import node 内置模块。
//
// 单独成文件的原因:宿主 lib/index.js 要 import schemastery,而 schemastery 只在 profile
// 的 node_modules 里(工作区没有),所以从仓库里 import lib/index.js 会解析失败。把不依赖
// schemastery 的东西放在这里,自检就能直接跑它 —— 于是 `node:fs` 可以用,第三方包不可以。
//
// 两处消费同一个定义:
//   - 设置页:哪个路径空着/填错了,会跳过哪些开发环节(inspectTools → statusOf)。
//   - 会话提示:FPGA 模式里把已核对过的路径与调用姿势交给 agent(describeEnv,由 lib/mode.js
//     在**预设作用域**注册,不在插件行 —— 见 README「关于提示注入」)。
//
// tools/check-toolchain.mjs 覆盖这里的边界行为。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalTemplateSelection, resolveTemplateSelection } from "./template-library.js";

/** 设置命名空间,同时也是客户端设置页认领的那个 key。两边必须写同一个值。 */
export const NS = "fpga-workbench";

/**
 * 插件自带的默认模板(用户没提供模板目录时用这几份)。
 *
 * 用 import.meta.url 求值,与 lib/index.js 的预设根同一个道理:路径随包走,不依赖
 * 工作目录,也不受用户预设目录里那份副本影响。
 */
const BUNDLED_TEMPLATE_DIR = fileURLToPath(new URL("../presets/fpga-workbench/templates/", import.meta.url));

/** 插件自带的命令行工具(Node 直接跑,不需要额外环境)。 */
const BUNDLED_TOOLS_DIR = fileURLToPath(new URL("../presets/fpga-workbench/tools/", import.meta.url));

/**
 * 自带命令:**级别既写在名字里,也落在目录上** ——
 * 名字 `module-rtl-new.mjs` / `project-...`(只抄命令、没抄路径也抄不错);
 * 目录 `tools/module/` / `tools/project/`(拿错级别的命令在那个目录里根本不存在);
 * 两级共用的在 `tools/` 顶层,名字不带级别前缀(`setup-scaffold.mjs`)。
 *
 * 为什么两处都写(用户 2026-09-19:"给模块工具带上 module 标签,防止调用错误,而不是用路径进行区分"):
 * 命令名只看得出**环节**(rtl-new),看不出**级别**;工程级以后加自己的 rtl 类命令时,
 * 同一个目录里两套同名口径必然混。技能名早就是 `fpga-module-*` / `fpga-project-*` 这么分的,
 * 命令照同一口径。目录与名字都由守卫对着 `TOOLS` 登记校验,不会各自漂。
 */
const LEVEL_DIRS = { module: "module", project: "project", shared: "" };

/** 命令名的级别前缀(`shared` 不加前缀 —— 它两级都用,加了反而误导)。 */
const LEVEL_PREFIX = { module: "module-", project: "project-", shared: "" };

/**
 * 自带命令。两类:两级共用的骨架,以及模块级的检查/起文件。
 *
 * **没有"看波形"这类交互入口**:要看波形用已经确认过的仿真脚本起 GUI。
 */
export const TOOLS = [
  {
    file: "setup-scaffold.mjs",
    level: "shared",
    stage: "规格环节",
    what: "在用户指定目录中一次建好模块 / 工程骨架(工程加 --kind project；不自动套工程名或创建模块子目录；幂等)"
  },
  {
    file: "module-rtl-new.mjs",
    level: "module",
    stage: "RTL 环节",
    what: "按模板起一个 RTL 文件(复制模板、只替模块名,默认落 rtl/)"
  },
  {
    file: "module-rtl-check.mjs",
    level: "module",
    stage: "RTL 环节",
    what: "机械规范检查(文件头 / 九个小节块 / 端口类型 / 复位极性 / Tab / 行尾 / 断言 / 测试平台自检)"
  },
  {
    file: "module-verif-new.mjs",
    level: "module",
    stage: "验证环节",
    what: "按分类模板起测试平台、仿真脚本(编译与运行同一份)或验证脚本(测试平台默认落 verif/tb_<snake>，其余也落 verif/)"
  },
  {
    file: "module-synth-new.mjs",
    level: "module",
    stage: "综合环节",
    what: "按模板起约束文件(默认落 synth/<模块名>.xdc)或综合脚本(--kind synth-script 落 synth/run_synth.tcl)"
  },
  {
    file: "module-report-check.mjs",
    level: "module",
    stage: "验收环节",
    what: "核报告引用的证据路径是否真的在(spec 的 AC 行声明的证据位置 + verif/synth 报告里引用的路径;只验存在,不判内容)"
  },
  {
    file: "project-rtl-check.mjs",
    level: "project",
    stage: "工程 RTL / lint 环节",
    what: "检查工程 src/rtl、src/sim 与根 sim/ 中的 Verilog/SystemVerilog 源码,以及根 ip/ 的 IP 时序卡(缺卡只警告)"
  }
];

/** 命令的绝对路径(级别落到目录上,所以路径要拼出来)。 */
export function toolPath(tool) {
  return join(BUNDLED_TOOLS_DIR, LEVEL_DIRS[tool.level] ?? "", tool.file);
}

/** 命令名应有的级别前缀(守卫用它校验"名字带级别")。 */
export function toolLevelPrefix(tool) {
  return LEVEL_PREFIX[tool.level] ?? "";
}

/**
 * 模板种类 → 字段名与文件名。字段填了就优先用用户那份,留空或不存在就用自带。
 *
 * 这些旧字段只负责迁移老配置；默认值也必须指向现行分类模板，不能依赖已经退出的平铺模板。
 */
export const TEMPLATE_FIELDS = [
  { key: "rtlTemplatePath", kind: "rtl", label: "RTL 模板", file: "rtl/systemverilog_module.sv" },
  { key: "tbTemplatePath", kind: "tb", label: "测试平台模板", file: "simulation/testbench/systemverilog_testbench.sv" },
  { key: "xdcTemplatePath", kind: "xdc", label: "约束模板", file: "constraints/vivado_module_xdc.xdc" },
  { key: "runDoTemplatePath", kind: "sim-run", label: "仿真脚本模板", file: "simulation/run/modelsim_run.do", announce: "custom" },
  { key: "synthScriptTemplatePath", kind: "synth-script", label: "综合脚本模板", file: "synthesis/vivado_module_synthesis.tcl", announce: "custom" },
  { key: "compScriptTemplatePath", kind: "comp", label: "验证脚本模板", file: "verification/python_data_verification.py", announce: "custom" }
];

/** 语言与标准:合成一个下拉,避免"语言和标准对不上"的组合(vhdl-2008 配 1800-2017 这种)。 */
const LANG_STD = [
  { value: "sv-2017", label: "SystemVerilog (IEEE 1800-2017)" },
  { value: "sv-2012", label: "SystemVerilog (IEEE 1800-2012)" },
  { value: "v2001", label: "Verilog-2001" },
  { value: "vhdl-2008", label: "VHDL-2008" }
];

/** 设置页的三个顶层区。数组只定义展示分区,不表示执行顺序。 */
export const SETTINGS_SECTIONS = [
  { key: "common", label: "工具设置", hint: "先登记并确认本机工具；模块和工程只引用这里的工具。" },
  { key: "module", label: "模块工具", hint: "四类能力可以按任务反复切换，不是流水线。" },
  { key: "project", label: "工程工具", hint: "工程主工具、系统仿真与脚本验证分别设置，不自动执行。" }
];

const SECTION_LABELS = Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.key, section.label]));

/**
 * 本机工具登记表。路径、路径类型、调用提示只在这里定义一次,设置、探测、状态与会话提示共用。
 * 自定义槽位只有用户明确选择时才参与某个环节;没有调用说明时只承诺“路径可用”。
 */
export const TOOL_CATALOG = {
  python: {
    role: "script",
    label: "Python 3",
    pathKey: "pythonPath",
    kind: "file",
    hint: "python.exe；用于参考模型、测试向量和日志比对。检测只如实报告版本；这里只登记路径，不保证宿主终端强制使用它。",
    usage: (path) => [`跑脚本:${usagePath(path)} <脚本.py>(依赖要安装到这个解释器对应的环境中)`]
  },
  verilator: {
    role: "compiler",
    label: "Verilator",
    pathKey: "verilatorPath",
    kind: "file",
    hint: "填写 verilator_bin.exe；MSYS2 常见位置是 C:\\msys64\\mingw64\\bin。",
    usage: (path) => [
      `快速 lint:${usagePath(path)} --lint-only -Wall --top-module <顶层模块> <文件...>`,
      "优先使用 verilator_bin.exe 本体；无扩展名的 verilator 是 Perl 包装脚本。"
    ]
  },
  iverilog: {
    role: "compiler",
    label: "Icarus Verilog",
    pathKey: "iverilogPath",
    kind: "file",
    hint: "填写 iverilog.exe；可用于编译检查和配合 vvp 仿真，但 SystemVerilog 支持有限。",
    usage: (path) => [`编译检查:${usagePath(path)} -g2012 -o <临时输出文件> <文件...>`, "需要运行结果时再配合同目录的 vvp。"]
  },
  modelsim: {
    role: "simulator",
    label: "ModelSim",
    pathKey: "modelsimPath",
    kind: "file",
    hint: "填写 ModelSim 的 vsim.exe，而不是会直接打开图形界面的 modelsim.exe。",
    usage: (path) => [
      `非交互仿真:${usagePath(path)} -c -do "do <脚本.do>; quit -f"`,
      "-c 表示命令行模式；日志和波形应放到当前验证环节目录。"
    ]
  },
  questa: {
    role: "simulator",
    label: "QuestaSim",
    pathKey: "questaPath",
    kind: "file",
    hint: "填写 QuestaSim 的 vsim.exe；它与 ModelSim 分开登记、分开检测。",
    usage: (path) => [
      `非交互仿真:${usagePath(path)} -c -do "do <脚本.do>; quit -f"`,
      "-c 表示命令行模式；日志和波形应放到当前验证环节目录。"
    ]
  },
  xsim: {
    role: "simulator",
    label: "Vivado XSim",
    pathKey: "xsimPath",
    kind: "directory",
    hint: "填写 Vivado 的 bin 目录；xvlog、xelab、xsim 三个入口都应在其中。",
    usage: (path) => [
      `三步走:"${pad(path)}xvlog" -sv <源码...> → "${pad(path)}xelab" -debug typical <顶层> -s tb_sim → "${pad(path)}xsim" tb_sim -runall`,
      "这里登记的是 Vivado bin 目录，不是某一个可执行文件。"
    ]
  },
  vivado: {
    role: "fpga",
    label: "Vivado",
    pathKey: "vivadoPath",
    kind: "file",
    hint: "Windows 填写 vivado.bat；用批处理模式执行综合、实现、时序和 bitstream 工作。",
    usage: (path) => [
      `非交互批处理:${usagePath(path)} -mode batch -source <脚本.tcl> -log <日志路径> -journal <记录路径>`,
      "不加 -mode batch 会启动图形界面。"
    ]
  },
  quartus: {
    role: "fpga",
    label: "Quartus Prime",
    pathKey: "quartusPath",
    kind: "file",
    hint: "填写 quartus_sh.exe。插件可以登记和检测路径，但当前没有承诺完整的 Quartus 工程流程。",
    supportNote: "当前只保证路径与检测，不代表已有完整工程流程。",
    usage: (path) => [`非交互批处理:${usagePath(path)} -t <脚本.tcl>`, "具体综合、实现和烧录命令须按当前 Quartus 工程确认。"]
  },
  "custom-compiler": {
    role: "compiler",
    label: "自定义编译工具",
    pathKey: "customCompilerPath",
    nameKey: "customCompilerName",
    notesKey: "customCompilerNotes",
    kind: "file"
  },
  "custom-simulator": {
    role: "simulator",
    label: "自定义仿真工具",
    pathKey: "customSimulatorPath",
    nameKey: "customSimulatorName",
    notesKey: "customSimulatorNotes",
    kind: "file"
  },
  "custom-fpga": {
    role: "fpga",
    label: "自定义 FPGA 工具",
    pathKey: "customFpgaToolPath",
    nameKey: "customFpgaToolName",
    notesKey: "customFpgaToolNotes",
    kind: "file"
  }
};

/** 工具设置卡片的固定分类；顺序只用于展示，不表示调用顺序。 */
export const TOOL_GROUPS = [
  { key: "script", label: "脚本工具" },
  { key: "compiler", label: "编译工具" },
  { key: "simulator", label: "仿真工具" },
  { key: "fpga", label: "FPGA 工具" }
];

const TOOL_GROUP_BY_KEY = Object.fromEntries(TOOL_GROUPS.map((group) => [group.key, group]));

/** 环节只是能力分组；这里没有“当前环节”或先后状态。 */
export const STAGES = [
  { key: "module-spec", section: "module", label: "规格", bindings: ["moduleSpecScript"] },
  { key: "module-rtl", section: "module", label: "RTL", bindings: ["moduleRtlCompiler"] },
  { key: "module-verif", section: "module", label: "验证", bindings: ["moduleVerifSimulator", "moduleVerifScript"] },
  { key: "module-synth", section: "module", label: "综合", bindings: ["moduleSynthFpga"] },
  { key: "module-review", section: "module", label: "审查", bindings: [], note: "按审查对象复用其他环节工具，不单设工具。" },
  { key: "project-spec", section: "project", label: "规格", bindings: ["projectSpecScript"] },
  { key: "project-integrate", section: "project", label: "集成", bindings: ["projectIntegrateCompiler", "projectIntegrateFpga"] },
  { key: "project-constraints", section: "project", label: "约束", bindings: ["projectConstraintsFpga"] },
  { key: "project-syssim", section: "project", label: "系统仿真", bindings: ["projectSyssimSimulator", "projectSyssimScript"] },
  { key: "project-impl", section: "project", label: "实现", bindings: ["projectImplFpga"] },
  { key: "project-timing", section: "project", label: "时序", bindings: ["projectTimingFpga"] },
  { key: "project-board", section: "project", label: "上板", bindings: ["projectBoardFpga"] },
  { key: "project-release", section: "project", label: "发布", bindings: ["projectReleaseFpga"] }
];

const STAGE_BY_KEY = Object.fromEntries(STAGES.map((stage) => [stage.key, stage]));

const ROLE_TOOLS = {
  script: ["python"],
  compiler: ["verilator", "iverilog", "custom-compiler"],
  simulator: ["modelsim", "questa", "xsim", "custom-simulator"],
  fpga: ["vivado", "quartus", "custom-fpga"]
};

const bind = (key, section, stage, label, role) => ({
  key,
  section,
  stage,
  label,
  role,
  toolKey: `${key}Tool`,
  pathKey: `${key}Path`,
  tools: ROLE_TOOLS[role]
});

export const BINDINGS = [
  bind("moduleSpecScript", "module", "module-spec", "脚本工具", "script"),
  bind("moduleRtlCompiler", "module", "module-rtl", "编译 / lint 工具", "compiler"),
  bind("moduleVerifSimulator", "module", "module-verif", "仿真工具", "simulator"),
  bind("moduleVerifScript", "module", "module-verif", "参考模型 / 比对脚本工具", "script"),
  bind("moduleSynthFpga", "module", "module-synth", "综合工具", "fpga"),
  bind("projectSpecScript", "project", "project-spec", "脚本工具", "script"),
  bind("projectIntegrateCompiler", "project", "project-integrate", "编译 / elaboration 工具", "compiler"),
  bind("projectIntegrateFpga", "project", "project-integrate", "FPGA 套件", "fpga"),
  bind("projectConstraintsFpga", "project", "project-constraints", "约束工具", "fpga"),
  bind("projectSyssimSimulator", "project", "project-syssim", "系统仿真工具", "simulator"),
  bind("projectSyssimScript", "project", "project-syssim", "参考模型 / 比对脚本工具", "script"),
  bind("projectImplFpga", "project", "project-impl", "实现工具", "fpga"),
  bind("projectTimingFpga", "project", "project-timing", "时序工具", "fpga"),
  bind("projectBoardFpga", "project", "project-board", "下载 / 调试工具", "fpga"),
  bind("projectReleaseFpga", "project", "project-release", "重建 / 复核工具", "fpga")
];

const BINDING_BY_KEY = Object.fromEntries(BINDINGS.map((binding) => [binding.key, binding]));

/**
 * 新设置页按“能力”选择工具，不按开发阶段重复登记路径。
 *
 * 数组顺序只控制展示顺序；它不代表执行顺序，更不会生成流水线。每个能力只保存一个
 * `toolKey`，实际路径永远回到 {@link TOOL_CATALOG} 对应的通用路径读取。
 */
export const CAPABILITIES = [
  {
    key: "module-rtl",
    section: "module",
    label: "RTL 编译工具",
    hint: "用于 RTL 语法、lint 与编译检查；可以和验证、修改反复切换，不是固定的第一步。",
    role: "compiler",
    toolKey: "moduleRtlTool",
    tools: ROLE_TOOLS.compiler,
    templates: [{ key: "moduleRtlTemplate", category: "rtl", label: "RTL 模板" }]
  },
  {
    key: "module-simulation",
    section: "module",
    label: "仿真测试工具",
    hint: "编译测试平台并运行功能仿真；编译与运行是同一份脚本(按模式调用)，可以只重跑其中一项。",
    role: "simulator",
    toolKey: "moduleSimulationTool",
    tools: ROLE_TOOLS.simulator,
    templates: [
      { key: "moduleTestbenchTemplate", category: "testbench", label: "Testbench 模板" },
      { key: "moduleSimulationRunTemplate", category: "sim-run", label: "仿真脚本", hint: "编译与运行是同一份脚本(按模式调用)；留空由 AI 自行决定，也可从模板库选一份固定脚本。" }
    ]
  },
  {
    key: "module-verification",
    section: "module",
    label: "脚本验证工具",
    hint: "用于参考模型、测试向量、日志或结果比对；是否使用由当前验证问题决定。",
    role: "script",
    toolKey: "moduleVerificationTool",
    tools: ROLE_TOOLS.script,
    templates: [{ key: "moduleVerificationTemplate", category: "verification", label: "验证脚本模板" }]
  },
  {
    key: "module-gate",
    section: "module",
    label: "综合与门禁工具",
    hint: "用于模块综合、资源与时序门禁；结果可以返回 RTL 或约束继续迭代。",
    role: "fpga",
    toolKey: "moduleGateTool",
    tools: ROLE_TOOLS.fpga,
    templates: [
      { key: "moduleSynthesisTemplate", category: "synthesis", label: "综合脚本" },
      { key: "moduleConstraintsTemplate", category: "constraints", label: "约束模板" }
    ]
  },
  {
    key: "project-main",
    section: "project",
    label: "工程主工具",
    hint: "同一个厂商 FPGA 工具统一承担工程综合、实现、时序、生成文件和下载；不会自动串行执行。",
    role: "fpga",
    toolKey: "projectMainTool",
    tools: ROLE_TOOLS.fpga,
    templates: [
      { key: "projectLintTemplate", category: "linter", label: "Linter 脚本", hint: "留空由 AI 自行决定；也可从模板库选一份固定脚本。" },
      { key: "projectRtlTemplate", category: "rtl", label: "RTL 模板" },
      { key: "projectConstraintsTemplate", category: "project-constraints", label: "约束模板", hint: "工程约束与模块约束不是同一份:模块版只管模块自己的时钟;工程版管全工程时钟 + 引脚 + IO 时序(引脚以 sch/ 原理图为准)。" },
      { key: "projectSynthesisTemplate", category: "project-synthesis", label: "综合脚本", hint: "工程综合与模块综合不是同一份脚本:库里那份是模块级的(<ModuleName>、从模块根跑)。这一栏留空由 AI 自行决定;要固定,请从模板库里选一份工程用的(打开 prj/<工程>.xpr 后跑 synth_1)。" },
      { key: "projectImplementationTemplate", category: "implementation", label: "实现脚本" },
      { key: "projectBitstreamTemplate", category: "bitstream", label: "Bitstream 脚本", hint: "留空由 AI 自行决定；也可从模板库选一份固定脚本。" },
      { key: "projectProgrammingTemplate", category: "programming", label: "下载脚本" }
    ]
  },
  {
    key: "project-simulation",
    section: "project",
    label: "系统仿真工具",
    hint: "用于模块集成后的系统级测试平台与运行；编译与运行是同一份脚本(按模式调用)，且不要求和模块仿真选择同一份模板。",
    role: "simulator",
    toolKey: "projectSimulationTool",
    tools: ROLE_TOOLS.simulator,
    templates: [
      { key: "projectTestbenchTemplate", category: "testbench", label: "Testbench 模板" },
      { key: "projectSimulationRunTemplate", category: "sim-run", label: "仿真脚本", hint: "编译与运行是同一份脚本(按模式调用)；留空由 AI 自行决定，也可从模板库选一份固定脚本。" }
    ]
  },
  {
    key: "project-verification",
    section: "project",
    label: "脚本验证工具",
    hint: "用于系统级参考模型、数据生成和结果比对；与模块验证工具独立选择。",
    role: "script",
    toolKey: "projectVerificationTool",
    tools: ROLE_TOOLS.script,
    templates: [{ key: "projectVerificationTemplate", category: "verification", label: "验证脚本模板" }]
  }
];

const CAPABILITY_BY_KEY = Object.fromEntries(CAPABILITIES.map((capability) => [capability.key, capability]));

/** 把目录形式的路径补成可拼接的前缀(XSim 的路径是一个目录)。 */
function pad(path) {
  return path.endsWith("\\") || path.endsWith("/") ? path : `${path}\\`;
}

/**
 * 扁平设置 schema。客户端再按 section / stage 元数据组合成三个顶层区和环节卡。
 *
 * 通用路径默认空,由用户登记或从检测候选中选择；环节选择默认 auto,保留 AI 针对当前任务
 * 判断的空间。所有字段都是可选能力,缺一项只影响显式绑定它的环节,不会形成全局门禁。
 * 语言、库映射和模板仍属于通用区。旧全局键隐藏保留一个迁移周期。
 */
export const FIELDS = [
  // 通用区只登记“这台机器有什么”。每个工具一个独立路径,切换环节首选时不会互相覆盖。
  ...[
    ["python", "脚本工具"],
    ["verilator", "编译工具"],
    ["iverilog", "编译工具"],
    ["modelsim", "仿真工具"],
    ["questa", "仿真工具"],
    ["xsim", "仿真工具"],
    ["vivado", "FPGA 工具"],
    ["quartus", "FPGA 工具"]
  ].map(([tool, group]) => {
    const definition = TOOL_CATALOG[tool];
    return {
      key: definition.pathKey,
      tool,
      section: "common",
      sectionLabel: SECTION_LABELS.common,
      group,
      control: "text",
      label: definition.label,
      hint: definition.hint,
      blankNote: "留空表示尚未登记",
      kind: definition.kind,
      required: false,
      skips: []
    };
  }),

  // 自定义槽位保留名字、路径和调用说明。说明为空时不能把“路径存在”说成“已有固定配方”。
  ...[
    ["custom-compiler", "自定义编译工具", "编译工具"],
    ["custom-simulator", "自定义仿真工具", "仿真工具"],
    ["custom-fpga", "自定义 FPGA 工具", "FPGA 工具"]
  ].flatMap(([tool, label, group]) => {
    const definition = TOOL_CATALOG[tool];
    const shared = { tool, section: "common", sectionLabel: SECTION_LABELS.common, group, required: false, skips: [] };
    return [
      {
        ...shared,
        key: definition.nameKey,
        control: "text",
        label: `${label}名称`,
        hint: "显示给 AI 和环节选择看的名称；不填则使用默认的“自定义工具”名称。"
      },
      {
        ...shared,
        key: definition.pathKey,
        tool,
        control: "text",
        label: `${label}路径`,
        hint: "填写该工具实际入口；路径可用不代表插件已经知道完整调用方法。",
        blankNote: "留空表示尚未登记",
        kind: definition.kind
      },
      {
        ...shared,
        key: definition.notesKey,
        control: "textarea",
        label: `${label}调用说明`,
        hint: "可写命令入口、必要参数或工程限制；AI 应结合当前工程核对，不能把这里当自动脚本。"
      }
    ];
  }),

  {
    key: "rtlLangStd",
    section: "common",
    sectionLabel: SECTION_LABELS.common,
    group: "语言标准",
    control: "select",
    label: "RTL 语言与标准",
    hint: "写 RTL 时按这个来；扩展名、语法特性和编译开关都跟它走。",
    default: "sv-2017",
    options: LANG_STD,
    required: false,
    skips: []
  },
  {
    key: "simLangStd",
    section: "common",
    sectionLabel: SECTION_LABELS.common,
    group: "语言标准",
    control: "select",
    label: "仿真语言与标准",
    hint: "测试平台可以与 RTL 使用不同语言，例如 VHDL RTL 配 SystemVerilog 测试平台。",
    default: "same",
    options: [{ value: "same", label: "与 RTL 相同" }, ...LANG_STD],
    required: false,
    skips: []
  },

  // ── 库映射 ─────────────────────────────────────────────────────────────────
  {
    key: "modelsimIniPath",
    section: "common",
    sectionLabel: SECTION_LABELS.common,
    group: "仿真库",
    control: "text",
    label: "ModelSim 库映射文件",
    // 口径(用户定案):这里要的是**映射文件**,不是库目录。
    // 厂商预编译库能不能用,取决于 modelsim.ini 的 [Library] 段(`库名 = 目录`)—— 库在哪、
    // 叫什么,那份文件已经说了,agent 只需要库名(`-L unisims_ver`)。自己新编的 work 库是
    // **就地建**的(在 verif/ 下),不需要一个全局目录。
    // 旧字段叫 libraryPath(目录、必填):照字面会让人去填"厂商库所在目录",而且它没就绪时
    // 会把「厂商原语仿真 / IP 库编译」报成当前不可执行 —— 映射好了明明就能跑,那是**假门禁**。
    // 这次**不做旧值迁移**:值从"目录"变成了"文件",搬过去只会是个错值。
    hint: "ModelSim 的 modelsim.ini:厂商预编译库靠它的 [Library] 段(库名 = 目录)解析。留空则用安装目录里那份",
    blankNote: "留空用安装目录那份",
    kind: "file",
    required: false,
    skips: [],
    usage: (path) => [
      `厂商库 / IP 库能不能用,看这份文件的 [Library] 段:${promptScalar(path)}`,
      "改映射用 vmap;`vmap` 不带参数会列出**当前生效**的全部映射。注意查找顺序:MODELSIM 环境变量 → 当前目录的 modelsim.ini → 安装目录那份 —— 工作目录里冒出一份就会盖掉这份。"
    ]
  },
  {
    key: "questaIniPath",
    section: "common",
    sectionLabel: SECTION_LABELS.common,
    group: "仿真库",
    control: "text",
    label: "QuestaSim 库映射文件",
    hint: "QuestaSim 使用的 modelsim.ini；厂商预编译库通过其中的 [Library] 段解析。留空则使用 QuestaSim 安装目录中的默认文件",
    blankNote: "留空用 QuestaSim 安装目录中的默认文件",
    kind: "file",
    required: false,
    skips: [],
    usage: (path) => [
      `QuestaSim 厂商库 / IP 库映射文件:${promptScalar(path)}`,
      "库名与目录以 [Library] 段为准；使用前应确认当前工作目录没有另一份 modelsim.ini 覆盖它。"
    ]
  },
  // 缓存目录字段**已删**(用户定案):每个阶段的产物放各自阶段的目录里 —— 编译库
  // `verif/work`、日志与波形 `verif/`、综合产物 `synth/`。外置一个全局缓存目录的代价实测
  // 是"跑仿真要提权"(工作区外写入过不了沙箱),而收益只是"别撑大源码树" —— 那些文件本来
  // 就是可再生的,就地生成 + 工作区规则里忽略掉就够了。
  {
    key: "templateLibraryPath",
    section: "common",
    sectionLabel: SECTION_LABELS.common,
    group: "模板库",
    control: "text",
    label: "额外模板库（可选）",
    hint: "可选。填写包含 rtl、constraints、verification、simulation 等固定分类目录的根目录；能力卡展开时才扫描。",
    blankNote: "留空只使用插件内置模板",
    defaultPath: BUNDLED_TEMPLATE_DIR,
    kind: "directory",
    required: false,
    skips: []
  },

  // 能力卡只保存“用哪个已登记工具”和“选择哪份模板”；这里绝不再生成独立路径字段。
  ...CAPABILITIES.flatMap((capability) => {
    const shared = {
      section: capability.section,
      sectionLabel: SECTION_LABELS[capability.section],
      capability: capability.key,
      capabilityLabel: capability.label,
      group: capability.label,
      required: false,
      skips: []
    };
    return [
      {
        ...shared,
        key: capability.toolKey,
        control: "select",
        label: "工具",
        hint: "默认由 AI 从顶部已经就绪的工具中结合当前任务判断；也可以固定首选工具，或明确选择不用。设置不会自动执行任何环节。",
        default: "auto",
        options: [
          { value: "auto", label: "由 AI 从已就绪工具中判断" },
          ...capability.tools.map((tool) => ({ value: tool, label: TOOL_CATALOG[tool].label, supportNote: TOOL_CATALOG[tool].supportNote })),
          { value: "none", label: "明确不用" }
        ]
      },
      ...capability.templates.map((template) => ({
        ...shared,
        key: template.key,
        category: template.category,
        control: "template",
        label: template.label,
        hint: "可从内置模板与已设置的模板库中选择；留空表示使用与当前工具适配的内置默认模板。",
        default: ""
      }))
    ];
  }),

  // v1 全局键、v2 阶段键和旧模板键只供迁移；隐藏保留，不清空、不参与新能力解析。
  { key: "python", group: "旧键", control: "hidden", label: "Python 选择(旧)", hint: "", default: "", required: false, skips: [] },
  { key: "compiler", group: "旧键", control: "hidden", label: "编译工具选择(旧)", hint: "", default: "", required: false, skips: [] },
  { key: "compilerPath", group: "旧键", control: "hidden", label: "编译工具共享路径(旧)", hint: "", default: "", required: false, skips: [] },
  { key: "simulator", group: "旧键", control: "hidden", label: "仿真工具选择(旧)", hint: "", default: "", required: false, skips: [] },
  { key: "simulatorPath", group: "旧键", control: "hidden", label: "仿真工具共享路径(旧)", hint: "", default: "", required: false, skips: [] },
  { key: "synthesizer", group: "旧键", control: "hidden", label: "FPGA 工具选择(旧)", hint: "", default: "", required: false, skips: [] },
  { key: "synthesizerPath", group: "旧键", control: "hidden", label: "FPGA 工具共享路径(旧)", hint: "", default: "", required: false, skips: [] },
  ...BINDINGS.flatMap((binding) => [
    { key: binding.toolKey, group: "旧键", control: "hidden", label: `${binding.label}选择(旧)`, hint: "", default: "", required: false, skips: [] },
    { key: binding.pathKey, group: "旧键", control: "hidden", label: `${binding.label}路径(旧)`, hint: "", default: "", required: false, skips: [] }
  ]),
  ...TEMPLATE_FIELDS.map((template) => ({
    key: template.key,
    group: "旧键",
    control: "hidden",
    label: `${template.label}(旧)`,
    hint: "",
    default: "",
    required: false,
    skips: []
  })),
  { key: "settingsMigrationWarnings", group: "旧键", control: "hidden", label: "迁移提醒", hint: "", default: "", required: false, skips: [] },
  { key: "settingsModelVersion", group: "旧键", control: "hidden", label: "设置模型版本", hint: "", default: "", required: false, skips: [] }
];

/**
 * 路径字段的共性在这里补齐:文本输入框、归在「工具路径」组。
 *
 * 逐项写容易漏,而漏了的后果是设置页把它们塞进别的分组 —— 统一补默认值更稳。
 * (现在每个字段都显式写了 group,这里只兜底,别再依赖它。)
 */
for (const field of FIELDS) {
  if (field.control === undefined) field.control = "text";
  if (field.control !== "hidden" && field.section === undefined) {
    field.section = "common";
    field.sectionLabel = SECTION_LABELS.common;
    if (field.group === "库映射") field.group = "仿真库";
  }
}

const SETTINGS_MODEL_VERSION = "3";

const LEGACY_STAGE_TARGETS = {
  compiler: ["moduleRtlCompilerTool", "projectIntegrateCompilerTool"],
  simulator: ["moduleVerifSimulatorTool", "projectSyssimSimulatorTool"],
  synthesizer: [
    "moduleSynthFpgaTool",
    "projectIntegrateFpgaTool",
    "projectConstraintsFpgaTool",
    "projectImplFpgaTool",
    "projectTimingFpgaTool",
    "projectBoardFpgaTool",
    "projectReleaseFpgaTool"
  ],
  python: ["moduleSpecScriptTool", "moduleVerifScriptTool", "projectSpecScriptTool", "projectSyssimScriptTool"]
};

const LEGACY_CUSTOM = {
  compiler: { tool: "custom-compiler", pathKey: "customCompilerPath", nameKey: "customCompilerName", notesKey: "customCompilerNotes" },
  simulator: { tool: "custom-simulator", pathKey: "customSimulatorPath", nameKey: "customSimulatorName", notesKey: "customSimulatorNotes" },
  synthesizer: { tool: "custom-fpga", pathKey: "customFpgaToolPath", nameKey: "customFpgaToolName", notesKey: "customFpgaToolNotes" }
};

/** v3 能力卡从哪些 v2 阶段选择中继承。规格讨论不在这里，它没有新工具卡。 */
const LEGACY_CAPABILITY_SOURCES = {
  moduleRtlTool: ["moduleRtlCompilerTool"],
  moduleSimulationTool: ["moduleVerifSimulatorTool"],
  moduleVerificationTool: ["moduleVerifScriptTool"],
  moduleGateTool: ["moduleSynthFpgaTool"],
  projectMainTool: [
    "projectIntegrateFpgaTool",
    "projectConstraintsFpgaTool",
    "projectImplFpgaTool",
    "projectTimingFpgaTool",
    "projectBoardFpgaTool",
    "projectReleaseFpgaTool"
  ],
  projectSimulationTool: ["projectSyssimSimulatorTool"],
  projectVerificationTool: ["projectSyssimScriptTool"]
};

/** 旧的六个全局模板路径分别继承给模块和工程；路径不存在也要原样保留。 */
const LEGACY_TEMPLATE_TARGETS = {
  rtlTemplatePath: ["moduleRtlTemplate", "projectRtlTemplate"],
  tbTemplatePath: ["moduleTestbenchTemplate", "projectTestbenchTemplate"],
  xdcTemplatePath: ["moduleConstraintsTemplate", "projectConstraintsTemplate"],
  runDoTemplatePath: ["moduleSimulationRunTemplate", "projectSimulationRunTemplate"],
  synthScriptTemplatePath: ["moduleSynthesisTemplate", "projectSynthesisTemplate"],
  compScriptTemplatePath: ["moduleVerificationTemplate", "projectVerificationTemplate"]
};

/** 新能力卡的模板字段 → 固定分类，用于把旧插件模板路径收敛成稳定 ID。 */
const TEMPLATE_CATEGORY_BY_KEY = Object.fromEntries(
  CAPABILITIES.flatMap((capability) => capability.templates.map((template) => [template.key, template.category]))
);

/**
 * 修复已经完成 v3 迁移、但能力卡里仍保存旧插件平面模板路径的设置。
 * 这不是再次迁移工具选择；只改能被精确识别为本插件旧模板的值，因而可重复执行。
 */
function legacyBundledTemplateRepair(values) {
  const patch = {};
  for (const [key, category] of Object.entries(TEMPLATE_CATEGORY_BY_KEY)) {
    const selected = String(values?.[key] ?? "").trim();
    if (selected === "") continue;
    const canonical = canonicalTemplateSelection(selected, category);
    if (canonical !== selected) patch[key] = canonical;
  }
  return patch;
}

/** 根据旧共享路径里可核对的名字识别工具；认不出来就落入自定义槽位。 */
function inferLegacyTool(role, path) {
  const lower = String(path).trim().toLowerCase().replaceAll("/", "\\");
  if (role === "compiler") {
    if (/(^|\\)iverilog(?:\.exe)?$/u.test(lower)) return "iverilog";
    if (/(^|\\)verilator(?:_bin)?(?:\.exe)?$/u.test(lower)) return "verilator";
  }
  if (role === "simulator") {
    // Questa / ModelSmart 路径证据优先于仅凭 vsim.exe 名(F5-12):两者可执行文件同名
    if (lower.includes("questasim") || lower.includes("\\questa\\")) return "questa";
    if (lower.includes("modeltech")) return "modelsim";
    // 只有 vsim.exe、路径里没有 modeltech/questa 证据 → **不硬猜**(F5-12):落自定义槽,由用户确认
    if (/(^|\\)vsim(?:\.exe)?$/u.test(lower)) return LEGACY_CUSTOM[role]?.tool;
    if (/(^|\\)(?:xsim|xvlog|xelab)(?:\.bat|\.exe)?$/u.test(lower) || /\\vivado\\bin\\?$/u.test(lower)) return "xsim";
  }
  if (role === "synthesizer") {
    if (/(^|\\)quartus_sh(?:\.exe)?$/u.test(lower) || lower.includes("\\quartus\\")) return "quartus";
    if (/(^|\\)vivado(?:\.bat|\.exe)?$/u.test(lower) || lower.includes("\\vivado\\")) return "vivado";
  }
  return LEGACY_CUSTOM[role]?.tool;
}

/** 用于比较 Windows 路径是否只是大小写或分隔符不同；不解析、不访问文件系统。 */
function comparablePath(path) {
  return String(path ?? "").trim().replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
}

/**
 * 把 v1 全局设置或 v2 阶段设置一次性迁到“顶部工具登记 + 七张能力卡”。即使已经是 v3，
 * 也会幂等修复能力卡里残留的旧插件平面模板路径；用户自己的路径与新式模板 ID 不动。
 *
 * 迁移只追加新字段或把旧插件模板路径替换成等价 ID，绝不把旧字段写空。冲突保留在旧隐藏字段中，
 * 并写一条不含完整路径的提醒。
 */
export function legacyMigrationPatch(values) {
  const source = values ?? {};
  const templateRepair = legacyBundledTemplateRepair(source);
  if (valueOf(source, "settingsModelVersion") === SETTINGS_MODEL_VERSION) return templateRepair;

  const effective = { ...source, ...templateRepair };
  const patch = { settingsModelVersion: SETTINGS_MODEL_VERSION, ...templateRepair };
  const warnings = [];
  const current = (key) => String(effective[key] ?? "").trim();
  const original = (key) => String(source[key] ?? "").trim();
  const remember = (key, value, persist = false) => {
    const text = String(value ?? "").trim();
    if (text === "" || current(key) !== "") return;
    effective[key] = text;
    if (persist) patch[key] = text;
  };
  const warn = (message) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  /** 把 v1 的一个角色只放进内存中的 v2 形状，再由下面统一收敛到 v3。 */
  const normalizeV1Role = (role, allowed, specificEvidence = []) => {
    const selection = current(role);
    const sharedPath = current(`${role}Path`);
    let tool;
    if (selection === "none") tool = "none";
    else if (allowed.includes(selection)) tool = selection;
    else if (selection === "other") tool = LEGACY_CUSTOM[role]?.tool;
    else if (sharedPath !== "") tool = inferLegacyTool(role, sharedPath);
    else {
      const candidates = specificEvidence.filter(([, key]) => current(key) !== "").map(([candidate]) => candidate);
      if (new Set(candidates).size === 1) tool = candidates[0];
      else if (new Set(candidates).size > 1) warn(`旧版${role}登记了多个工具，请在新能力卡中确认首选。`);
    }
    if (tool === undefined) return;
    // F5-12:裸 vsim.exe 落到自定义槽时说清原因,不要装作已经认出是哪一家
    if (role === "simulator" && tool === LEGACY_CUSTOM.simulator?.tool && /(^|\\)vsim(?:\.exe)?$/iu.test(sharedPath)) {
      warn("旧仿真器路径只有 vsim.exe、无法判断是 ModelSim 还是 QuestaSim；已放入自定义仿真器，请确认后改选。");
    }

    for (const key of LEGACY_STAGE_TARGETS[role] ?? []) {
      if (current(key) === "" || current(key) === "auto") effective[key] = tool;
    }
    if (tool === "none" || sharedPath === "") return;
    const definition = TOOL_CATALOG[tool];
    if (definition !== undefined) {
      const existing = current(definition.pathKey);
      if (existing === "") remember(definition.pathKey, sharedPath, true);
      else if (comparablePath(existing) !== comparablePath(sharedPath)) {
        warn(`${definition.label} 的旧共享路径与工具设置不同，请手动确认。`);
      }
    }
    const custom = LEGACY_CUSTOM[role];
    if (custom !== undefined && tool === custom.tool) {
      remember(custom.nameKey, "旧配置中的其他工具", true);
      remember(custom.notesKey, `从旧的${role}共享设置迁移；请结合当前工程确认调用方法。`, true);
    }
  };

  normalizeV1Role("compiler", ["verilator", "iverilog"], [
    ["verilator", "verilatorPath"],
    ["iverilog", "iverilogPath"]
  ]);
  normalizeV1Role("simulator", ["modelsim", "xsim"], [
    ["modelsim", "modelsimPath"],
    ["xsim", "xsimPath"]
  ]);
  normalizeV1Role("synthesizer", ["vivado", "quartus"], [
    ["vivado", "vivadoPath"],
    ["quartus", "quartusPath"]
  ]);

  const pythonSelection = current("python");
  if (pythonSelection === "none") {
    for (const key of LEGACY_STAGE_TARGETS.python) effective[key] = "none";
  } else if (pythonSelection === "python" || current("pythonPath") !== "") {
    for (const key of LEGACY_STAGE_TARGETS.python) {
      if (current(key) === "" || current(key) === "auto") effective[key] = "python";
    }
  }

  // v2 的阶段覆盖路径不再生效；一致时可补进顶部登记，冲突时保留旧值并提醒。
  const overridePaths = new Map();
  for (const binding of BINDINGS) {
    const path = current(binding.pathKey);
    const selection = current(binding.toolKey);
    if (path === "" || !binding.tools.includes(selection) || TOOL_CATALOG[selection] === undefined) continue;
    const rows = overridePaths.get(selection) ?? [];
    rows.push(path);
    overridePaths.set(selection, rows);
  }
  for (const [toolKey, paths] of overridePaths) {
    const definition = TOOL_CATALOG[toolKey];
    const unique = [...new Map(paths.map((path) => [comparablePath(path), path])).values()];
    const registered = current(definition.pathKey);
    if (registered === "" && unique.length === 1) {
      remember(definition.pathKey, unique[0], true);
    } else if (unique.length > 1 || (registered !== "" && unique.some((path) => comparablePath(path) !== comparablePath(registered)))) {
      warn(`${definition.label} 存在不同的旧阶段路径，请在工具设置中手动确认。`);
    }
  }

  const capabilityByToolKey = Object.fromEntries(CAPABILITIES.map((capability) => [capability.toolKey, capability]));
  for (const [targetKey, sourceKeys] of Object.entries(LEGACY_CAPABILITY_SOURCES)) {
    const existing = original(targetKey);
    // 版本还没到 3 时，schema 给出的默认 auto 可以被真实旧选择替换；具体选择和 none 永远不覆盖。
    if (existing !== "" && existing !== "auto") continue;
    const capability = capabilityByToolKey[targetKey];
    const chosen = sourceKeys.map(current).filter((value) => value !== "" && value !== "auto");
    const valid = chosen.filter((value) => value === "none" || capability.tools.includes(value));
    if (chosen.length !== valid.length) warn(`${capability.label} 含有无法识别的旧工具选择，请手动确认。`);
    const unique = [...new Set(valid)];
    if (unique.length === 0) continue;
    if (unique.length === 1) patch[targetKey] = unique[0];
    else {
      patch[targetKey] = "auto";
      warn(`${capability.label} 的旧工具选择不一致，已保留为由 AI 判断，请手动确认。`);
    }
  }

  for (const [legacyKey, targetKeys] of Object.entries(LEGACY_TEMPLATE_TARGETS)) {
    const path = current(legacyKey);
    if (path === "") continue;
    for (const targetKey of targetKeys) {
      if (original(targetKey) === "") {
        patch[targetKey] = canonicalTemplateSelection(path, TEMPLATE_CATEGORY_BY_KEY[targetKey]);
      }
    }
  }

  let previousWarnings = [];
  try {
    const parsed = JSON.parse(original("settingsMigrationWarnings") || "[]");
    if (Array.isArray(parsed)) previousWarnings = parsed.filter((entry) => typeof entry === "string");
  } catch {
    previousWarnings = ["旧的迁移提醒格式无法读取，请重新确认能力选择。"];
  }
  const combinedWarnings = [...new Set([...previousWarnings, ...warnings])];
  if (combinedWarnings.length > 0) patch.settingsMigrationWarnings = JSON.stringify(combinedWarnings);

  return patch;
}

/**
 * 真实文件系统探测。
 *
 * **两边都要求类型对得上**:目录字段要真的是目录;文件字段要真的是文件。
 *
 * 文件字段原来"只要存在就算" —— 结果用户把 `C:\msys64\mingw64\bin`(目录)填进「编译器路径」时
 * 一切显示正常,而提示段照着它给 agent 拼出一条**跑不通的命令行**
 * (`"C:\...\bin" --lint-only ...`)。用户口径也是"这种就该显示未就绪"。宁可让人去填对,
 * 也不要一边说已就绪、一边给出一条跑不了的路。
 * @param path - 配置里填的路径。
 * @param kind - `"file"` 或 `"directory"`。
 * @returns 存在且类型相符。
 */
export function probeFilesystem(path, kind) {
  if (!existsSync(path)) return false;
  try {
    return kind === "directory" ? statSync(path).isDirectory() : statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 拿一项配置的字符串值。迁移完成后不再跨字段兜底,避免清空新字段时旧值复活。 */
function valueOf(values, key) {
  return String(values?.[key] ?? "").trim();
}

/**
 * 列一个目录,给设置页的「浏览…」用。
 *
 * 为什么要自己写:DSH 现成的选择器(`ctx.directoryPicker`)**只能选目录**(原生对话框的
 * 标题就是 "Select Workspace Directory"),而且它是给工作区切换器占位用的,没有"谁都能调
 * 一次"的接口。而这里要选的是 **.exe / .bat 文件**,所以自带一个:宿主列目录、设置页渲染
 * 列表,文件和目录都能点。
 *
 * 只读:只列名字与类型,不读内容。目录在前、同类按名字排;条目数封顶,免得误点进一个
 * 几万项的目录把页面卡住。
 * @param dir - 要列的目录;空串表示列出盘符(Windows)或文件系统根。
 * @returns `{ path, parent, entries, truncated, error? }`;`entries` 每项 `{ name, path, kind }`。
 */
export function listDirectory(dir) {
  const target = String(dir ?? "").trim();
  if (target === "") {
    const roots = process.platform === "win32"
      ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`).filter((drive) => existsSync(drive))
      : ["/"];
    return {
      path: "",
      parent: undefined,
      entries: roots.map((drive) => ({ name: drive, path: drive, kind: "directory" })),
      truncated: false
    };
  }

  let names;
  try {
    names = readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return { path: target, parent: parentOf(target), entries: [], truncated: false, error: String(error.code ?? error.message) };
  }

  const entries = names
    .map((entry) => ({
      name: entry.name,
      path: join(target, entry.name),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
    }))
    .filter((entry) => entry.kind !== "other")
    .sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : 1));

  const cap = 500;
  return { path: target, parent: parentOf(target), entries: entries.slice(0, cap), truncated: entries.length > cap };
}

/**
 * 上级目录;已经在根上时返回它自己。
 * @param dir - 当前目录。
 * @returns 上级目录路径。
 */
function parentOf(dir) {
  const parent = dirname(dir.replace(/[\\/]+$/u, ""));
  return parent === dir || parent === "" ? dir : parent;
}

/** 解析一个环节绑定；只解析能力事实,不会选择或执行任何工具。 */
export function resolveBinding(values, binding, probe = probeFilesystem) {
  if (binding === undefined) {
    return { key: "", selection: "", state: "invalid", present: false, reason: "环节绑定不存在" };
  }
  const selection = valueOf(values, binding.toolKey) || "auto";
  if (selection === "auto") return { ...binding, selection, state: "auto", present: true };
  if (selection === "none") return { ...binding, selection, state: "none", present: true, unused: true };
  if (!binding.tools.includes(selection) || TOOL_CATALOG[selection] === undefined) {
    return { ...binding, selection, state: "invalid", present: false, reason: "工具选择无效" };
  }

  const tool = TOOL_CATALOG[selection];
  const override = valueOf(values, binding.pathKey);
  const common = valueOf(values, tool.pathKey);
  const path = override || common;
  const source = override !== "" ? "stage" : common !== "" ? "common" : undefined;
  let present = false;
  if (path !== "") {
    try {
      present = probe(path, tool.kind) === true;
    } catch {
      present = false;
    }
  }
  const customName = tool.nameKey === undefined ? "" : valueOf(values, tool.nameKey);
  return {
    ...binding,
    selection,
    tool: selection,
    toolLabel: customName || tool.label,
    kind: tool.kind,
    path,
    source,
    configured: path !== "",
    present,
    state: present ? "ready" : "missing",
    supportNote: tool.supportNote,
    notes: tool.notesKey === undefined ? "" : valueOf(values, tool.notesKey)
  };
}

/** 解析全部环节绑定。数组顺序只用于稳定展示,不表示执行顺序。 */
export function resolveBindings(values, probe = probeFilesystem) {
  return BINDINGS.map((binding) => resolveBinding(values, binding, probe));
}

/**
 * 解析一张能力卡的工具选择。能力卡只读取顶部工具登记，不存在阶段覆盖路径。
 * @param values - 设置值。
 * @param capability - {@link CAPABILITIES} 中的一项。
 * @param probe - `(path, kind) => boolean`。
 * @returns 能力卡的工具解析结果。
 */
export function resolveCapability(values, capability, probe = probeFilesystem) {
  if (capability === undefined) {
    return { key: "", selection: "", state: "invalid", present: false, reason: "能力配置不存在" };
  }
  const selection = valueOf(values, capability.toolKey) || "auto";
  if (selection === "auto") return { ...capability, selection, state: "auto", present: true };
  if (selection === "none") return { ...capability, selection, state: "none", present: true, unused: true };
  if (!capability.tools.includes(selection) || TOOL_CATALOG[selection] === undefined) {
    return { ...capability, selection, state: "invalid", present: false, reason: "工具选择无效" };
  }

  const tool = TOOL_CATALOG[selection];
  const path = valueOf(values, tool.pathKey);
  let present = false;
  if (path !== "") {
    try {
      present = probe(path, tool.kind) === true;
    } catch {
      present = false;
    }
  }
  const customName = tool.nameKey === undefined ? "" : valueOf(values, tool.nameKey);
  return {
    ...capability,
    selection,
    tool: selection,
    toolLabel: customName || tool.label,
    kind: tool.kind,
    path,
    source: path === "" ? undefined : "registry",
    configured: path !== "",
    present,
    state: present ? "ready" : "missing",
    supportNote: tool.supportNote,
    notes: tool.notesKey === undefined ? "" : valueOf(values, tool.notesKey)
  };
}

/** 解析七张能力卡；数组顺序只用于展示，不代表执行顺序。 */
export function resolveCapabilities(values, probe = probeFilesystem) {
  return CAPABILITIES.map((capability) => resolveCapability(values, capability, probe));
}

/**
 * 精确解析一张能力卡保存的模板选择。这里只 stat 最终文件，不枚举模板库目录。
 * @param values - 设置值。
 * @param capability - {@link CAPABILITIES} 中的一项。
 * @param tool - 该能力当前的工具选择。
 * @param probe - `(path, kind) => boolean`。
 */
export function resolveCapabilityTemplates(values, capability, tool = "auto", probe = probeFilesystem) {
  const libraryRoot = valueOf(values, "templateLibraryPath");
  return (capability?.templates ?? []).map((template) => {
    const resolved = resolveTemplateSelection({
      selection: valueOf(values, template.key),
      category: template.category,
      tool,
      libraryRoot,
      probe
    });
    const { label: templateLabel, ...state } = resolved;
    return { ...template, ...state, templateLabel };
  });
}

/**
 * 判定每个字段的状态。
 *
 * `probe(path, kind)` 由调用方注入:宿主传真实文件系统探测,自检传桩函数 ——
 * 于是这段判定逻辑可以脱离文件系统被测。
 *
 * 下拉字段没有路径可探:它的"就绪"= 取到的值确实是一个合法选项(空则用默认值)。
 * @param values - 设置解析后的值。
 * @param probe - `(path, kind) => boolean`,路径存在且类型匹配。
 * @returns 每项 `{ key, label, hint, kind, skips, path, configured, present }`。
 */
export function inspectTools(values, probe) {
  return FIELDS.map((field) => {
    const raw = valueOf(values, field.key);
    // 下拉字段:没有路径可探。"就绪"= 值(空则取默认值)确实是合法选项之一。
    if (field.control === "select") {
      const chosen = raw === "" ? String(field.default ?? "") : raw;
      const valid = (field.options ?? []).some((option) => option.value === chosen);
      return { ...field, path: chosen, configured: chosen !== "", present: valid };
    }
    const configured = raw !== "";
    const binding = field.bindingKey === undefined ? undefined : BINDING_BY_KEY[field.bindingKey];
    const selection = binding === undefined ? "" : valueOf(values, binding.toolKey) || "auto";
    const selectedTool = TOOL_CATALOG[selection];
    const kind = selectedTool?.kind ?? field.kind;
    const inactive = binding !== undefined && (selection === "auto" || selection === "none" || selectedTool === undefined);
    const unused = selection === "none";
    // 名称与说明是普通文本,不是路径；它们无需文件系统探测。
    if (kind === undefined) return { ...field, path: raw, configured, present: true, inactive, unused };
    let present = false;
    if (inactive || (binding !== undefined && !configured)) {
      present = true;
    } else if (configured) {
      try {
        present = probe(raw, kind) === true;
      } catch {
        present = false;
      }
    }
    return { ...field, kind, path: raw, configured, present, inactive, unused };
  });
}

/**
 * 报告"该清理但没清"的类别 —— **只用于报告,不用于删除**(见下面的长注释)。
 *
 * 用户定案:插件运行时**绝不永久删除**任何文件。本插件没有 shell、也不加原生依赖,而 Windows
 * 上"送进回收站"需要其中之一(或原生模块),所以这里选的是 **零删除 + 如实报告**:把本该清掉的
 * 东西收集成清单(绝对路径 + 类别)打印出来、放进返回值,处置交给使用者。
 * **注意:没有实现回收站**,不要把这里的类别读成"已经安全删掉了"。
 */
export const CLEANUP_KINDS = {
  temp: "临时项",
  partial: "半成品",
  installedExtra: "已装副本多余文件",
  backup: "备份(保留)"
};

/**
 * 造一条待清理项。
 * @param kind - {@link CLEANUP_KINDS} 的键。
 * @param path - **绝对路径**(报告里直接拿去处置)。
 * @returns `{ kind, label, path }`。
 */
export function cleanupEntry(kind, path) {
  return { kind, label: CLEANUP_KINDS[kind] ?? kind, path };
}

/**
 * 把待清理清单排成可直接打印的行(没有条目时为空数组)。
 * @param entries - {@link cleanupEntry} 的数组。
 * @returns 形如 `  [过期技能/模板] C:\...\skills\gone\SKILL.md` 的行。
 */
export function formatCleanup(entries) {
  return (Array.isArray(entries) ? entries : []).map((item) => `  [${item.label}] ${item.path}`);
}

/**
 * 临时残留的宽限窗口:比这更新的条目,当成**另一次正在跑的自检**留下的,只报"还在宽限期"。
 *
 * 两个自检会用到同名 fixture(`npm test` 与 `npm run test:installed` 跑的是同一批检查),
 * 并行执行时这个窗口能避免把对方正在用的目录报成"待清理"(fixture 名带进程号已能避开大部分)。
 */
export const TEMP_GRACE_MS = 10 * 60 * 1000;

/**
 * 列出临时根目录下**匹配给定前缀**的条目 —— **一个都不删**。
 *
 * 为什么需要:自检每次跑都会建时间戳目录(backup-check-* / stale-check-* / prune-skills-*),
 * 而清理这一步**现在只报告**:清单打印出来,由使用者自己处置 `.tmp/` 里的残留。
 *
 * 归属边界(这条是重点,别再放宽):
 * - **只有名字命中调用方给的前缀**才算"我们建的",才可能进清单;不命中的一律不碰、不列;
 * - 前缀一个都没有(空数组/非字符串)时返回空数组 —— 那种情况下无从确认归属,连列都不该列;
 * - 只处理这一层,不递归进不匹配的子目录里挑东西;
 * - 宽限期内的条目标 `pending: false`(可能是并行那次正在用的),`pending: true` 的才是"待清理";
 * - 读不到时间的(悬空链接等)按待清理列出,并把原因写进 `reason`(不猜)。
 *
 * 传进来的前缀由调用方写死(它们只是自检的 fixture 名)。
 * 放在这个文件而不是宿主 lib/index.js:自检要直接 import 它(后者依赖 schemastery)。
 * @param dir - 临时根目录(不存在时返回空数组)。
 * @param prefixes - 认归属用的名字前缀。
 * @param minAgeMs - 宽限窗口(默认 0 = 全部算待清理)。
 * @returns 匹配到的条目数组,每项 `{ kind, label, name, path, pending, reason }`。
 */
export function listTempLeftovers(dir, prefixes, minAgeMs = 0) {
  const wanted = (Array.isArray(prefixes) ? prefixes : []).filter(
    (prefix) => typeof prefix === "string" && prefix !== ""
  );
  const out = [];
  if (wanted.length === 0) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!wanted.some((prefix) => entry.name.startsWith(prefix))) continue;
    const full = join(dir, entry.name);
    let pending = true;
    let reason;
    try {
      if (minAgeMs > 0 && Date.now() - statSync(full).mtimeMs < minAgeMs) {
        pending = false;
        reason = "还在宽限期内(可能是并行那次正在用的 fixture),不算待清理";
      }
    } catch (error) {
      reason = `读不到时间(${String(error?.code ?? error?.message ?? error)}),按待清理列出`;
    }
    out.push({ ...cleanupEntry("temp", full), name: entry.name, pending, reason });
  }
  return out;
}

/**
 * 兼容旧调用方的字段级缺失判定。新模型没有全局必填路径；实际环节状态由 resolveBinding 判定。
 * @param tool - {@link inspectTools} 的一项。
 * @returns 该进缺失清单时为 true。
 */
export function isMissing(tool) {
  return tool.required === true && !tool.present && tool.unused !== true;
}

/**
 * 当前状态:每项的存在情况 + 给设置页用的汇总(**这是设置页字段定义的唯一来源**)。
 *
 * `missing` 只列显式选择了具体工具、但路径缺失/无效的环节绑定。`auto` 与 `none` 都是有效决定；
 * 即使一个绑定缺失,`ok` 仍为 true,因为其余环节和不依赖外部工具的工作可以继续。
 *
 * 放在这个文件里而不是 lib/index.js:它是纯逻辑,自检可以直接 import 它、断言发给客户端的
 * 载荷形状 —— 而 index.js 要 schemastery,自检跑不了。
 * @param values - 设置解析后的值。
 * @returns `{ tools, sections, stages, bindings, missing, ok }`。
 */
export function statusOf(values, probe = probeFilesystem) {
  const tools = inspectTools(values, probe)
    // 隐藏字段只供迁移使用,不发给设置页。
    .filter((tool) => tool.control !== "hidden")
    .map((tool) => {
      const { usage: _usage, ...safe } = tool;
      return { ...safe, detectable: DETECT_TARGETS.some((target) => target.field === tool.key) };
    });
  const toolCards = Object.entries(TOOL_CATALOG).map(([key, definition]) => {
    const fields = tools.filter((field) => field.tool === key);
    const pathField = fields.find((field) => field.key === definition.pathKey);
    const group = TOOL_GROUP_BY_KEY[definition.role];
    const configured = pathField?.configured === true;
    const present = pathField?.present === true;
    return {
      key,
      role: definition.role,
      groupLabel: group?.label ?? definition.role,
      label: definition.nameKey === undefined ? definition.label : valueOf(values, definition.nameKey) || definition.label,
      pathKey: definition.pathKey,
      fieldKeys: fields.map((field) => field.key),
      kind: definition.kind,
      path: pathField?.path ?? "",
      configured,
      present,
      detectable: pathField?.detectable === true,
      state: !configured ? "unconfigured" : present ? "ready" : "invalid"
    };
  });
  const templateLibraryPath = valueOf(values, "templateLibraryPath");
  const capabilities = resolveCapabilities(values, probe).map((capability) => ({
    ...capability,
    toolOptions: [
      { value: "auto", label: "由 AI 从已就绪工具中判断", ready: true, disabled: false },
      ...capability.tools.map((toolKey) => {
        const card = toolCards.find((entry) => entry.key === toolKey);
        return {
          value: toolKey,
          label: card?.label ?? TOOL_CATALOG[toolKey]?.label ?? toolKey,
          ready: card?.state === "ready",
          disabled: card?.state !== "ready",
          state: card?.state ?? "unconfigured",
          supportNote: TOOL_CATALOG[toolKey]?.supportNote
        };
      }),
      { value: "none", label: "明确不用", ready: true, disabled: false }
    ],
    templates: resolveCapabilityTemplates(values, capability, capability.selection, probe)
  }));
  const missing = capabilities
    .filter((capability) => capability.state === "missing" || capability.state === "invalid")
    .map((capability) => capability.key);
  let migrationWarnings = [];
  try {
    const parsed = JSON.parse(valueOf(values, "settingsMigrationWarnings") || "[]");
    if (Array.isArray(parsed)) migrationWarnings = parsed.filter((entry) => typeof entry === "string");
  } catch {
    migrationWarnings = ["旧设置迁移提醒无法读取，请重新确认能力选择。"];
  }
  let templateLibraryPresent = templateLibraryPath === "";
  if (templateLibraryPath !== "") {
    try {
      templateLibraryPresent = probe(templateLibraryPath, "directory") === true;
    } catch {
      templateLibraryPresent = false;
    }
  }
  // 某张能力卡缺工具只影响该能力，不把整个 FPGA 模式判坏。
  return {
    tools,
    toolGroups: TOOL_GROUPS.map((group) => ({ ...group })),
    toolCards,
    sections: SETTINGS_SECTIONS.map((section) => ({ ...section })),
    capabilities,
    templateLibrary: {
      fieldKey: "templateLibraryPath",
      path: templateLibraryPath,
      configured: templateLibraryPath !== "",
      present: templateLibraryPresent,
      defaultPath: BUNDLED_TEMPLATE_DIR
    },
    migrationWarnings,
    missing,
    ok: true
  };
}

/** 拿不到设置时的说明:与其让 agent 以为"工具链没配",不如说清是读不到值。 */
const UNREADABLE =
  "FPGA 工具链:读不到「设置 → FPGA 开发模式」里的路径(插件宿主半侧没挂上?)。本会话里工具位置只能自己确认,不要假设它们存在。";

/**
 * 运行时路径(解释器)的诚实标注:这条路径只喂给会话提示,**不保证宿主终端真的用它**。
 *
 * 插件能核对的是"这个文件在不在、版本是几";把路径交给宿主终端是**宿主**的事,本插件没有
 * 强制绑定它的手段。这种话不能说成"已就绪" —— 用户会以为已经强制生效,发现没有时就不再信任提示。
 * (终端那条同理,而且比这更彻底:终端用哪个 pwsh 完全由宿主决定,这里**连路径都不问** —— 见 FIELDS 顶上的注。)
 */
const RUNTIME_NOTE =
  "注意:上面这条运行时路径是**给本会话提示**用的 —— 宿主终端是否真的使用它,不由本插件保证(实际版本要在设置里点「检测本机工具」看,不确定就问用户,不要按某个版本假设)。";

/**
 * MSYS2 装的 Verilator 在原生 Windows 上必须带 `VERILATOR_ROOT` —— 把可照抄的那一行给会话。
 *
 * 为什么(2026-09-24 本机实测,verilator 5.050):MSYS2 包把 root 编成了 **MSYS2 内部路径**
 * `/mingw64/share/verilator`,在 Windows 上被解释成当前盘下的 `C:\mingw64\...`(不存在),于是不带
 * 这个环境变量时 verilator **第一步就失败**:
 *   `%Error: Cannot find verilated_std_waiver.vlt containing built-in lint waivers: '/mingw64/share/verilator\include\...'`
 * 而 `C:\msys64\mingw64\bin\verilator` 那个 Perl 包装脚本在 PowerShell 里跑不起来(实测报
 * 「无法在管道中间运行文档」),所以能用 verilator_bin.exe 的布局里,这个环境变量就是必需的。
 *
 * 这里**机械推导**而不是写死:从 `…\bin\verilator_bin.exe` 取兄弟目录 `…\share\verilator`,并
 * **确认** `include/verilated_std_waiver.vlt` 真在(推不出来就什么都不说);已经设过
 * `VERILATOR_ROOT` 的机器也不再提示(那是用户自己的选择)。
 * @param path - 已登记的 verilator 可执行文件路径。
 * @param probe - `(path, kind) => boolean`。
 * @returns 提示行数组;空数组表示不需要提示。
 */
export function verilatorRootHint(path, probe = probeFilesystem) {
  if (String(process.env.VERILATOR_ROOT ?? "").trim() !== "") return [];
  if (!/^verilator_bin(\.exe)?$/iu.test(basename(String(path)))) return [];
  const root = join(dirname(dirname(String(path))), "share", "verilator");
  if (!exists(probe, join(root, "include", "verilated_std_waiver.vlt"))) return [];
  // 路径一律用正斜杠:反斜杠里的 \f/\v/\t/\r 会被 Tcl 与某些命令行当转义吃掉。
  const posix = root.split(sep).join("/");
  return [
    "  本机 Verilator 是 MSYS2 布局:必须带 VERILATOR_ROOT,在**同一条命令**里先设再跑 ——",
    `    $env:VERILATOR_ROOT='${promptScalar(posix)}'; & ${usagePath(path)} --lint-only -Wall --top-module <顶层> <文件...>`,
    "    (不带它 verilator 第一步就报 Cannot find verilated_std_waiver.vlt;路径用正斜杠,别被转义吃掉)"
  ];
}

/**
 * 生成 FPGA 模式会话里那段工具链说明。
 *
 * **这是"用户填的路径真的被用起来"的地方**:工具设置只列实际核验可用的路径；每个模块/
 * 工程环节再说明 auto、none、显式首选及路径来源。它描述能力地图,不生成执行顺序。
 *
 * 空字符串表示"没什么可说",此时提示段会被丢掉(见 dsh-system-prompt 的 renderPrompt)。
 * @param values - 设置解析后的值;`undefined` 表示设置服务/命名空间拿不到。
 * @param probe - `(path, kind) => boolean`,同 {@link inspectTools}。
 * @returns 提示段的正文。
 */
export function describeEnv(values, probe) {
  if (values === undefined || values === null) return UNREADABLE;

  const checkPath = probe ?? probeFilesystem;
  const tools = inspectTools(values, checkPath);
  const lines = [
    "这是能力配置，不是执行顺序，可以按任务反复切换。以下内容来自「设置 → FPGA 开发模式」，它是工具路径与环节偏好的权威来源；不要用 where/PATH 猜，也不要把这些偏好拼成自动流水线。"
  ];

  const available = [];
  for (const [toolKey, definition] of Object.entries(TOOL_CATALOG)) {
    const path = valueOf(values, definition.pathKey);
    if (path === "") continue;
    let present = false;
    try {
      present = checkPath(path, definition.kind) === true;
    } catch {
      present = false;
    }
    if (!present) continue;
    const name = definition.nameKey === undefined ? definition.label : valueOf(values, definition.nameKey) || definition.label;
    const notes = definition.notesKey === undefined ? "" : valueOf(values, definition.notesKey);
    const row = [`- ${name} (${toolKey}):${promptScalar(path)}`];
    try {
      if (typeof definition.usage === "function") row.push(...definition.usage(path).map((line) => `  ${line}`));
    } catch {
      // 调用提示只是辅助文字,拼不出来不能影响设置本身。
    }
    if (definition.supportNote !== undefined) row.push(`  支持范围:${definition.supportNote}`);
    // MSYS2 布局的 verilator:把"本机必须带 VERILATOR_ROOT"直接写进就绪清单(见 verilatorRootHint)。
    row.push(...verilatorRootHint(path, checkPath));
    if (definition.notesKey !== undefined) {
      row.push(notes === "" ? "  未提供固定调用说明；使用前须结合当前工程和工具帮助确认。" : `  用户说明:${promptScalar(notes)}`);
    }
    available.push(...row);
  }
  lines.push(
    available.length === 0
      ? "工具设置:当前没有核验到可用路径；这不妨碍分析、设计和代码修改，需要执行外部工具时再补。"
      : ["工具设置中已登记且路径可用的工具:", ...available].join("\n")
  );
  if (available.some((line) => line.includes("(python):"))) lines.push(RUNTIME_NOTE);

  for (const [fieldKey, product] of [["modelsimIniPath", "ModelSim"], ["questaIniPath", "QuestaSim"]]) {
    const iniPath = valueOf(values, fieldKey);
    if (iniPath !== "" && exists(checkPath, iniPath)) {
      lines.push(`${product} 库映射文件:${promptScalar(iniPath)}（厂商库解析以其中 [Library] 段为准）。`);
    }
  }

  const resolved = resolveCapabilities(values, checkPath);
  for (const sectionKey of ["module", "project"]) {
    const section = SETTINGS_SECTIONS.find((entry) => entry.key === sectionKey);
    const sectionLines = [`${section.label}能力偏好（可以按任务反复切换，不表示先后）:`];
    for (const capability of resolved.filter((entry) => entry.section === sectionKey)) {
      const head = `- ${capability.label}`;
      if (capability.state === "auto") {
        sectionLines.push(`${head}:由 AI 从已登记且路径可用的工具中结合当前任务判断；不改写设置。`);
      } else if (capability.state === "none") {
        sectionLines.push(`${head}:明确不用。`);
      } else if (capability.state === "invalid") {
        sectionLines.push(`${head}:选择无效，当前不可执行；其他能力照常工作。`);
      } else if (capability.state === "ready") {
        sectionLines.push(`${head}:首选 ${capability.toolLabel} —— ${promptScalar(capability.path)}（来源:工具设置）。`);
        if (capability.supportNote) sectionLines.push(`  支持范围:${capability.supportNote}`);
        if (capability.notes) sectionLines.push(`  用户说明:${promptScalar(capability.notes)}`);
        else if (capability.tool?.startsWith("custom-")) sectionLines.push("  未提供固定调用说明；使用前须结合当前工程和工具帮助确认。");
      } else {
        const reason = capability.configured
          ? `工具设置中的路径不可用(${promptScalar(capability.path)})：不存在或类型不符`
          : "工具设置中尚未登记路径";
        sectionLines.push(`${head}:首选 ${capability.toolLabel}，但${reason}；只影响这项能力。`);
        if (capability.supportNote) sectionLines.push(`  支持范围:${capability.supportNote}`);
      }
      for (const template of resolveCapabilityTemplates(values, capability, capability.selection, checkPath)) {
        const source = template.source === "builtin"
          ? "内置"
          : template.source === "library" ? "模板库" : template.source === "legacy" ? "旧版路径" : "";
        if (template.present && template.path !== "") {
          sectionLines.push(`  模板·${template.label}:${promptScalar(template.path)}${source === "" ? "" : `（${source}）`}`);
        } else if (template.state === "unused") {
          sectionLines.push(`  模板·${template.label}:工具已明确不用。`);
        } else {
          const details = [...new Set([template.summary, template.warning].filter((entry) => typeof entry === "string" && entry !== ""))];
          sectionLines.push(`  模板·${template.label}:${details.join("；") || "当前不可用"}`);
        }
      }
    }
    lines.push(sectionLines.join("\n"));
  }
  const templateLibraryPath = valueOf(values, "templateLibraryPath");
  if (templateLibraryPath === "") {
    lines.push("模板库:未设置用户模板库；能力卡只使用适配当前工具的内置默认模板。这里没有触发目录扫描。");
  } else {
    let libraryPresent = false;
    try {
      libraryPresent = checkPath(templateLibraryPath, "directory") === true;
    } catch {
      libraryPresent = false;
    }
    lines.push(
      libraryPresent
        ? `模板库:${templateLibraryPath}（只记录来源；展开设置里的能力卡时才扫描目录）。`
        : `模板库:${templateLibraryPath}（路径当前不可用；已保存的模板选择不会被替换）。`
    );
  }
  lines.push("显式首选应优先采用；若当前工程事实不允许，要说明原因再调整。工具未实际运行就不能把对应验证写成通过。配置本身不会生成命令队列或自动调用工具。");
  lines.push(choiceLines(tools));
  // 产物落点:**每个阶段的产物放各自阶段的目录里**(用户定案,不再有"全局缓存目录"这个字段)。
  // 一句到底,不留"该信哪条"的空间 —— 报告要能指着它们,所以结论类必须留在环节目录。
  lines.push(
    "产物落哪里:**每个阶段的产物放各自阶段的目录里** —— 编译库落 `verif/work`(可再生的,删了下次自动重建)、" +
      "日志与波形落 `verif/`、综合与实现的工程及 runs 落 `synth/`、结论与报告留在各环节目录(报告要能指着它们)。" +
      "这些可再生物**别外置到工作区外的全局目录**:沙箱下那里可能要提权才写得进去,就地生成最省事。"
  );
  lines.push(
    [
      "本模式自带的命令(Node 直接跑,不用装东西)。**命令名带级别前缀(module- / project-),按环节分;不要跨级别或跨环节混用**:",
      "· `module-` = 模块级(在 `tools/module/` 下);`project-` = 工程级(在 `tools/project/` 下);",
      "  两级共用的(如 setup-scaffold)不加级别前缀,在 `tools/` 顶层。",
      ...TOOLS.map((tool) => {
        const level = tool.level === "shared" ? "两级共用" : tool.level === "module" ? "模块级" : "工程级";
        return `- [${level} / ${tool.stage}] ${tool.what}:node "${toolPath(tool)}" <根目录>`;
      })
    ].join("\n")
  );
  lines.push("命令用现有 shell 工具跑(走沙箱、输出可回看);综合与大回归放后台任务再读日志,不要前台死等。");

  return lines.join("\n\n");
}

/**
 * 语言与标准(工具选什么由上一条已就绪清单负责,这里只说语言)。
 *
 * agent 写代码要按这里来 —— 不写清楚,它会按自己的习惯挑语言,而"这个工程是 VHDL"只有设置里知道。
 * @param tools - {@link inspectTools} 的结果。
 * @returns 提示段里的一节。
 */
function choiceLines(tools) {
  const byKey = new Map(tools.filter((tool) => tool.control === "select").map((tool) => [tool.key, tool]));
  const labelOf = (tool) => tool?.options?.find((option) => option.value === tool.path)?.label ?? String(tool?.path ?? "");
  const rtl = byKey.get("rtlLangStd");
  const sim = byKey.get("simLangStd");
  const simLabel = sim?.path === "same" ? `与 RTL 相同(${labelOf(rtl)})` : labelOf(sim);

  return [
    "语言与标准(按设置来,不要自己换一套):",
    `- RTL:${labelOf(rtl)} —— 文件扩展名 ${EXTENSIONS[rtl?.path] ?? ".sv"}`,
    `- 仿真语言:${simLabel}`
  ].join("\n");
}

/** 语言 → 文件扩展名。写代码时按它决定 .sv / .v / .vhd。 */
const EXTENSIONS = {
  "sv-2017": ".sv / .svh",
  "sv-2012": ".sv / .svh",
  v2001: ".v",
  "vhdl-2008": ".vhd"
};

/**
 * 解析每个模板最终用哪一份:用户填的那份优先,没填或找不到就退回插件自带的。
 *
 * 写 RTL / 测试平台 / 约束之前应当先读这几份文件 —— 写法规范由模板承载,不靠 agent 记规则。
 * @param values - 设置解析后的值。
 * @param probe - `(path, kind) => boolean`。
 * @returns 每项 `{ kind, label, file, path, source, present, announce, missing? }`;`source` 为 `"user"` 或 `"bundled"`;
 *   `missing` 是"填了但找不到"的那个路径;`announce` 是提示段的播报规则(见 {@link TEMPLATE_FIELDS})。
 */
export function resolveTemplates(values, probe) {
  return TEMPLATE_FIELDS.map(({ key, kind, label, file, announce = "always" }) => {
    const custom = String(values?.[key] ?? "").trim();
    const bundled = join(BUNDLED_TEMPLATE_DIR, file);
    if (custom === "") {
      return { kind, label, file, path: bundled, source: "bundled", present: exists(probe, bundled), announce };
    }
    if (exists(probe, custom)) {
      return { kind, label, file, path: custom, source: "user", present: true, announce };
    }
    // 填了但文件不在:如实说出来,别让用户以为自己那份生效了
    return { kind, label, file, path: bundled, source: "bundled", present: exists(probe, bundled), missing: custom, announce };
  });
}

/** 探测包一层:设置页的探针不该把提示组装搞崩。 */
function exists(probe, path) {
  try {
    return probe(path, "file") === true;
  } catch {
    return false;
  }
}

/**
 * 模板那几行。只在这里说清"用哪一份",免得 agent 猜。
 *
 * 播报规则:写法规范那三份任何时候都列(agent 写之前要读);`announce: "custom"` 的环节脚本
 * 只在用户配了自己那份时列 —— 没配就不出现(自带那份是命令的默认值,列出来只是噪音)。
 * @param values - 设置解析后的值。
 * @param probe - `(path, kind) => boolean`。
 * @returns 提示段里的一节。
 */
function templateLines(values, probe) {
  const templates = resolveTemplates(values, probe);
  const listed = templates.filter((template) => template.announce !== "custom" || template.source === "user");
  const lines = listed.map((template) => {
    const origin = template.source === "user" ? "你提供的" : "插件自带";
    // 脚本模板要**用起来**才算数:说清它得传给命令,而不是当成"读一读格式"的那类
    const usage = template.announce === "custom" ? ",起脚本时传给命令的 --template" : "";
    return `- ${template.label}(${origin}${usage}):${promptScalar(template.path)}`;
  });
  const absent = listed.filter((template) => !template.present);
  // 填了却没找到的一律要说(哪怕这一条不播报):否则用户以为自己那份生效了,实际用的是自带的
  const wrongPath = templates.filter((template) => template.missing !== undefined);
  const notes = [];
  if (wrongPath.length > 0) {
    // 填了却没找到:必须说出来 —— 否则用户以为自己那份生效了,实际用的是自带的
    notes.push(`(注意:${wrongPath.map((t) => `${t.label} 填的路径不存在(${t.missing})`).join("、")} —— 已退回自带那份)`);
  }
  if (absent.length > 0) {
    notes.push(`(注意:${absent.map((t) => `${t.label} 的 ${t.file}`).join("、")}未找到 —— 不得凭空编造,须先与用户确认)`);
  }
  return [
    "模块模板 —— 写 RTL、测试平台、约束之前先读这几份,照其格式书写:",
    ...lines,
    ...notes,
    // 模板换了、但机械检查器认的还是自带那套约定 —— 不说清,agent 会以为"检查器报的就是用户模板的规矩"
    "(这几条只管写法;`module-rtl-check.mjs` 这个机械检查器按**插件自带那套约定**判定(文件头字段、九个小节块、对齐)。用了自定义模板、约定又不一致时,把它当参考、**以用户模板的规则为准**,并在报告里说明差异;不得为通过内置格式检查而改动设计或用户约定。)"
  ].join("\n");
}

// ── 一键检测本机工具 ────────────────────────────────────────────────────────
//
// 基本只读文件系统:找出"这个文件在不在"。**唯一的例外是版本查询**(见 queryVersion):
// 对声明了 `version` 的字段(pythonPath),文件在不在答不了"是不是那个版本" —— 用户对
// Python 没有统一版本要求,所以这条只如实把版本报出来、不做判定。
// 所以只有这一条候选会起一次只打印版本号的进程,别的字段一律照旧只探文件系统。
//
// 为什么当年删掉了路径探测、现在又加回来:删掉的是**猜 PATH**,不是探测本身 —— 实测
// 踩过"探测值指着一个已删除的目录,agent 照着不存在的路径去调工具"。所以这次:
//   · 只认厂商已知安装位置(模式展开),来源记 `"known"`;
//   · PATH 命中单独标出来(来源 `"path"`,页面上写明"可能是旧的");
//   · 同一个工具只要有 known 命中,就不报它的 PATH 命中(免得旧副本顶掉真安装);
//   · 多候选**不自动选** —— 由设置页列出来让用户点。
//
// 每种工具只写"怎么证明它装着":找个必定存在的文件(可执行文件本体),路径字段要目录的
// (XSim 要 Vivado 的 bin 目录)就取它的所在目录。

/** 版本查询的超时:一个只会打印版本号的进程,几秒还不回就是有问题,不能把检测挂住。 */
export const VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * **显示层**序列化:把用户设置里的值变成"可以安全放进提示文本"的字符串(2026-09-25)。
 *
 * 为什么必须有这一层:设置值是**信任边界**。以前直接把值插进 system prompt,于是:
 *   · 路径里带换行 → 提示被撑成多行,路径本身被截断,还多出一行**看起来像指令**的内容
 *     (实测 `vivadoPath = "C:/a\nFAKE-LINE/vivado.bat"` → 提示里真的多出 `FAKE-LINE/...` 那一行);
 *   · 路径里带引号 → 打印出来的命令行示例被劈开(`"C:/a"b/vivado.bat" -mode batch …`),照抄就是坏命令。
 * 而这些值**探测与真实执行时必须用原值** —— 所以只在这里转,别处一律不动。
 *
 * 规则:控制字符(CR/LF/TAB/NUL 及其它 C0/C1)**转成可见转义**而不是删掉 ——
 * 删掉会让"我以为填的是 A、其实提示里是 B"这种偏差更难发现。
 * @param value - 任意用户提供的字符串。
 * @returns 单行、不会改变提示结构的文本。
 */
export function promptScalar(value) {
  const text = String(value ?? "");
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (ch) => {
    const code = ch.codePointAt(0);
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
}

/**
 * 把一个值渲染成**可以直接粘进 PowerShell** 的参数(同一套显示层的另一个语义)。
 *
 * 顺序很重要:先 `promptScalar` 变成**单行**(控制字符变可见转义),再按 PowerShell 规则加引号 ——
 * 少了第一步,值里的换行会把命令示例劈成两行(实测过)。PowerShell 的单引号字符串是字面量
 * (内部 `'` 写成 `''`),所以含空格/引号/`$`/反引号时用它最稳。
 * @param value - 任意用户提供的字符串。
 * @returns PowerShell 里可直接使用的**单行**参数字面量。
 */
export function promptArg(value) {
  const text = promptScalar(value);
  if (/^[A-Za-z0-9_.:/\\-]+$/u.test(text)) return text;
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * 工具目录里的 usage 示例:路径一律按 **PowerShell 可粘贴**的形式渲染。
 * @param path - 已登记的工具路径(原值)。
 * @returns 渲染后的参数。
 */
const usagePath = (path) => promptArg(path);

/**
 * 只读地跑一次版本查询 —— **检测路径上唯一允许起进程的地方**。
 *
 * 允许它的理由:有些工具的版本本身就是"能不能用"的一部分,`existsSync` 答不了;但它只读:
 * 命令行只是把版本号打印出来,不改任何状态、不落文件。**只有检测项明确给了 `version` 才会走到这里**
 * (现在只有 pythonPath),而且只报实测版本 —— 本模式没有把哪个版本当硬要求。
 *
 * 起不来 / 超时 / **命令失败** / 输出认不出来 → 如实报 `error`,**不猜版本**(猜出来的版本号比
 * 没有更坏:用户会以为已经核对过)。参数由调用方给,本函数不拼命令行、不走 shell。
 * @param path - 可执行文件路径。
 * @param command - `{ args, pattern }`:查询参数与从输出里取版本号的模式(第一个捕获组)。
 * @returns `{ version }` 或 `{ error, output? }`。
 */
export function queryVersion(path, command) {
  try {
    const result = spawnSync(path, command.args, {
      encoding: "utf8",
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true
    });
    if (result.error !== undefined && result.error !== null) {
      return { error: String(result.error.code ?? result.error.message) };
    }
    // python --version 在 2.x 走 stderr、3.x 走 stdout;两个流一起看最省事
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    // **退出码非 0 / 被信号终止 → 一律当"查不出"**,不许再从输出里挑版本号:
    // 失败时的输出只说明"报错信息里提到了某个版本",那不是"这个程序是那个版本"。
    // 实测:`pwsh -Command 'Write-Error "needs PowerShell 7.6.6"; exit 1'` 会把 7.6.6 送进
    // stderr —— 照旧取第一个版本号就会得到"命令明明失败、版本还是错的"这种假匹配。
    if (result.status !== 0 || (result.signal ?? null) !== null) {
      const why = result.status === null ? `被信号 ${String(result.signal ?? "?")} 终止` : `退出码 ${String(result.status)}`;
      return { error: `版本查询命令没有正常结束(${why})`, output: output.slice(0, 200) };
    }
    // 模式由调用方按**各工具真实输出的形状**给(行锚定),拿不到就报查不出 —— 不取"输出里随便一个版本号"
    const version = command.pattern.exec(output)?.[1];
    if (version === undefined) return { error: "没能从输出里认出版本号", output: output.slice(0, 200) };
    return { version };
  } catch (error) {
    return { error: String(error?.code ?? error?.message ?? error) };
  }
}

/**
 * 检测表的每一项:往哪个字段填、命中后把下拉切到哪个选项、以及去哪儿找。
 *
 * `globs` 里带 `fallback: true` 的那几条只在首选一组**没命中**时才用(见 {@link detectTools})。
 * 检测表必须覆盖每个具体工具(选项里不是"其他"的那些)—— 自检有一条守卫盯着这件事:
 * 漏一个,用户就只能自己手填路径,而界面上明明写着"支持它"。
 *
 * `version` 只有运行时字段有:版本是"能不能用"的一部分,文件在不在不够(见 {@link queryVersion})。
 * 一律**只如实报版本,不做判定**(本模式没有把哪个版本当硬要求;用户对 Python 3 没有统一约束)。
 */
export const DETECT_TARGETS = [
  {
    field: "modelsimPath",
    tool: "modelsim",
    label: "ModelSim",
    exe: "vsim.exe",
    globs: [{ root: "C:\\", pattern: "modeltech*\\win64\\vsim.exe" }]
  },
  {
    field: "questaPath",
    tool: "questa",
    label: "QuestaSim",
    exe: "vsim.exe",
    globs: [
      { root: "C:\\", pattern: "questasim*\\win64\\vsim.exe" },
      { root: "C:\\", pattern: "Siemens\\questa*\\win64\\vsim.exe" },
      { root: "C:\\", pattern: "MentorGraphics\\questa*\\win64\\vsim.exe" }
    ]
  },
  {
    field: "xsimPath",
    tool: "xsim",
    label: "Vivado XSim",
    exe: "xvlog.bat",
    // 这个字段要的是**目录**:证明文件是 bin 里的 xvlog.bat,填进去的是它的所在目录。
    kind: "directory",
    globs: [
      { root: "C:\\", pattern: "AMDDesignTools\\*\\Vivado\\bin\\xvlog.bat" },
      { root: "C:\\", pattern: "Xilinx\\Vivado\\*\\bin\\xvlog.bat" }
    ]
  },
  {
    field: "vivadoPath",
    tool: "vivado",
    label: "Vivado",
    exe: "vivado.bat",
    globs: [
      { root: "C:\\", pattern: "AMDDesignTools\\*\\Vivado\\bin\\vivado.bat" },
      { root: "C:\\", pattern: "Xilinx\\Vivado\\*\\bin\\vivado.bat" }
    ]
  },
  {
    field: "quartusPath",
    tool: "quartus",
    label: "Quartus Prime",
    exe: "quartus_sh.exe",
    globs: [
      { root: "C:\\", pattern: "intelFPGA*\\*\\quartus\\bin64\\quartus_sh.exe" },
      { root: "C:\\", pattern: "altera*\\*\\quartus\\bin64\\quartus_sh.exe" },
      // 老版本(Quartus II 13 这类)只有 32 位 bin:首选一组没命中才用它 ——
      // bin64 与 bin 是**同一个工具**,两个都列出来只会让人多选一次。
      { root: "C:\\", pattern: "intelFPGA*\\*\\quartus\\bin\\quartus_sh.exe", fallback: true },
      { root: "C:\\", pattern: "altera*\\*\\quartus\\bin\\quartus_sh.exe", fallback: true }
    ]
  },
  {
    field: "verilatorPath",
    tool: "verilator",
    label: "Verilator",
    exe: "verilator_bin.exe",
    globs: [{ root: "C:\\", pattern: "msys*\\mingw64\\bin\\verilator_bin.exe" }]
  },
  {
    field: "iverilogPath",
    tool: "iverilog",
    label: "Icarus Verilog",
    exe: "iverilog.exe",
    globs: [{ root: "C:\\", pattern: "iverilog\\bin\\iverilog.exe" }]
  },
  {
    // Python 只如实报版本,不做判定(工程里用哪个 3.x 由用户定,没有统一约束)。
    field: "pythonPath",
    tool: "python",
    label: "Python 3",
    exe: "python.exe",
    // `python --version` 输出 `Python 3.14.0`(老 2.x 走 stderr),整行锚定它 ——
    // 不取"输出里随便一个版本号"。
    version: { args: ["--version"], pattern: /^\s*Python (\d+\.\d+\.\d+)\s*$/mu },
    globs: [
      { root: "%ProgramFiles%", pattern: "Python3*\\python.exe" },
      { root: "%LocalAppData%", pattern: "Programs\\Python\\Python3*\\python.exe" }
    ]
  }
];

/** 极简通配:只支持一个 `*`(厂商目录名那种模式够用,不为它引入 glob 依赖)。 */
function matchesPattern(name, pattern) {
  const star = pattern.indexOf("*");
  const lowered = name.toLowerCase();
  if (star === -1) return lowered === pattern.toLowerCase();
  return lowered.startsWith(pattern.slice(0, star).toLowerCase()) && lowered.endsWith(pattern.slice(star + 1).toLowerCase());
}

/** 展开 `%Name%` 记号;变量不在时原样保留(那样自然探不到,不会误报成命中)。 */
function expandEnv(text, env) {
  return String(text).replace(/%([^%]+)%/gu, (whole, name) => {
    const value = env?.[name];
    return typeof value === "string" && value !== "" ? value : whole;
  });
}

/** 列一个目录下的子目录名;读不动时为空 —— 一个拒绝访问的目录不该让整次检测失败。 */
export function readdirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 把 `C:\a\*\b\file.exe` 这样的模式展开成候选绝对路径。
 *
 * 只有带 `*` 的段需要列目录,所以列目录次数 = 模式里的通配段数(通常 0~2 次),
 * 不会去递归整块盘。
 * @param root - 起始目录。
 * @param pattern - 反斜杠分隔的模式;段里可带一个 `*`。
 * @param list - `(dir) => string[]`,列子目录名。
 * @returns 候选绝对路径(不保证存在,交给 probe 判)。
 */
function expandPattern(root, pattern, list) {
  let current = [root];
  for (const segment of String(pattern).split("\\")) {
    if (segment === "") continue;
    const next = [];
    for (const dir of current) {
      if (segment.includes("*")) {
        for (const name of list(dir)) if (matchesPattern(name, segment)) next.push(join(dir, name));
      } else {
        next.push(join(dir, segment));
      }
    }
    current = next;
  }
  return current;
}

/** PATH 里的目录(去掉引号与空项)。 */
function pathDirs(env) {
  return String(env?.PATH ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter((entry) => entry !== "");
}

/**
 * 检测这台机器上有哪些工具。
 *
 * **只报机器事实**:厂商已知安装位置里找到了什么(来源 `"known"`),没找到才看 PATH
 * (来源 `"path"`,页面上写"可能是旧的")。首选一组没命中时才用 `fallback` 那组。
 *
 * 刻意**不报**"用户已经填了什么":已保存的设置和页面上**未保存的改动**可能不一致
 * (刚换了工具还没保存),由宿主回声旧值就会出现"换完工具点检测,报的还是原来那条路径"。
 * 填没填、在不在,设置页自己知道;按工具筛选也由设置页做(它才看得到当前选中的是哪个)。
 *
 * `probe` / `list` / `env` / `readVersion` 都可注入,所以自检拿桩函数就能跑,不必真装工具。
 * @param probe - `(path, kind) => boolean`,同 {@link inspectTools}。
 * @param list - `(dir) => string[]`,列子目录名。
 * @param env - 环境(用到 `PATH` / `ProgramFiles` / `LocalAppData`)。
 * @param readVersion - `(path, command) => { version?, error?, output? }`,默认 {@link queryVersion}
 *   —— 检测路径上唯一会起进程的地方,只有带 `version` 的检测项(现在只有 pythonPath)会用到它。
 * @param fields - 可选字段名数组；传入时只检测这些工具路径，省略时保持兼容并检测全部。
 * @returns 每项 `{ field, tool, label, path, source }`;`source` 为 `"known"` 或 `"path"`。
 *   带版本查询的项另有 `version` / `versionError` / `versionNote`(只如实报,不判定)。
 */
export function detectTools(
  probe = probeFilesystem,
  list = readdirNames,
  env = process.env,
  readVersion = queryVersion,
  fields = undefined
) {
  const hits = [];
  const seen = new Set();
  const exists = (path, kind = "file") => {
    try {
      return probe(path, kind) === true;
    } catch {
      return false;
    }
  };
  /** 展开一组模式,留下真实存在的(同一个路径只留一次)。 */
  const expand = (globs) =>
    globs
      .flatMap((glob) => expandPattern(expandEnv(glob.root, env), expandEnv(glob.pattern, env), list))
      .filter((path, index, all) => exists(path) && all.indexOf(path) === index);

  /**
   * 版本信息:只有带 `version` 的检测项会走到这里 —— 也就是**只有它会起进程**。
   * 认不出 / 起不来 / **命令失败**时如实记 error 与原始输出(见 queryVersion)。
   * 只报实测到的东西:不做"版本够不够"的判定(没有字段声明硬要求了 —— 带 `expected` 的
   * 那套判定随终端字段一起删了,2026-09-21;用户对 Python 3 没有统一版本约束)。
   */
  const versionInfo = (target, path) => {
    if (target.version === undefined) return {};
    let queried;
    try {
      queried = readVersion(path, target.version) ?? {};
    } catch (error) {
      queried = { error: String(error?.message ?? error) };
    }
    const version = typeof queried.version === "string" ? queried.version : undefined;
    const note = version === undefined
      ? `${target.label} 路径可用,但版本查不出来(${queried.error ?? "没有输出"})`
      : `版本 ${version}`;
    return { version, versionError: queried.error, versionNote: note };
  };

  // 只报**机器上找到了什么**,不报"你已经填了什么" —— 已保存的设置与页面上**未保存的改动**
  // 可能不是一回事(用户刚换了工具还没保存),由宿主来回声旧值就会出现
  // "换完工具点检测,报的还是我原来填的那条路径"。填没填、在不在,设置页自己知道。
  const wanted = Array.isArray(fields) ? new Set(fields.map(String)) : undefined;
  const targets = wanted === undefined
    ? DETECT_TARGETS
    : DETECT_TARGETS.filter((target) => wanted.has(target.field));
  for (const target of targets) {
    const primary = expand(target.globs.filter((glob) => glob.fallback !== true));
    const known = primary.length > 0 ? primary : expand(target.globs.filter((glob) => glob.fallback === true));
    const present = known.map((path) => ({ path, source: "known" }));
    if (present.length === 0) {
      for (const dir of pathDirs(env)) {
        const path = join(dir, target.exe);
        if (exists(path)) present.push({ path, source: "path" });
      }
    }
    for (const hit of present) {
      const path = target.kind === "directory" ? dirname(hit.path) : hit.path;
      const dedupe = `${target.field}|${target.tool}|${path.toLowerCase()}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      // 版本查的是**证明文件本身**(hit.path),不是填进字段的那个路径(目录字段会不一样)
      hits.push({ field: target.field, tool: target.tool, label: target.label, path, source: hit.source, ...versionInfo(target, hit.path) });
    }
  }
  return hits;
}
