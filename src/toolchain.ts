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
import { basename, dirname, isAbsolute, join, sep } from "node:path";
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
/** 命令级别的三个取值（`TOOLS[].level` 只会是它们之一）。 */
export type ToolLevel = "module" | "project" | "shared";

/**
 * 级别 → 命令所在子目录（`shared` 是两级共用，所以是空串）。
 *
 * `Record<ToolLevel, string>` 而不是裸对象字面量：`TOOLS[].level` 是 `ToolLevel`，
 * 用这个类型才能直接 `LEVEL_DIRS[tool.level]` 索引（裸字面量索引会 TS7053）。
 */
export const LEVEL_DIRS: Record<ToolLevel, string> = { module: "module", project: "project", shared: "" };

/**
 * 设置页一个字段的形状。
 *
 * 为什么这么多可选：FIELDS 里的字段来自几张不同的表（工具路径 / 模板 / 能力偏好），
 * 有些字段没有 `section` / `group` / `default`。下面那段 `for (const field of FIELDS)`
 * 会给缺的补默认值 —— 所以这些成员必须**可写且可选**，否则 TS 按字面量推断成
 * `undefined`，赋值就报 TS2322（实测踩到）。
 */
/** TOOL_CATALOG 的一项：工具的展示名、路径字段名等。 */
export interface ToolCatalogEntry {
  /** 表里每一项都有这四个 —— 改成必选后 `key: definition.pathKey` 不必断言。 */
  role: string;
  label: string;
  /** 路径字段名：表里每一项都有它（FIELDS 展开时当 key 用）。 */
  pathKey: string;
  kind: string;
  /** 有些工具要额外说明"支持范围"（例如免费版有限制）。 */
  supportNote?: string;
  /** 提示文案：自定义工具那三条没有，所以可选。 */
  hint?: string;
  usage?: (path: string) => string[];
  /** 自定义工具用的两个字段名（名字 / 备注）：只有自定义项才有。 */
  nameKey?: string;
  notesKey?: string;
  [extra: string]: unknown;
}

/** LEGACY_CUSTOM 的一项：旧版"自定义工具"映射到新字段。 */
export interface LegacyCustomEntry {
  tool?: string;
  pathKey?: string;
  nameKey?: string;
  notesKey?: string;
  [extra: string]: unknown;
}

/**
 * 一条"哪个环节用哪类工具"的绑定（{@link BINDINGS} 的一项）。
 *
 * `bind()` 产出的形状就是这五个字段。声明成接口后，`resolveBinding` 里的
 * `binding.tools` / `ROLE_TOOLS[binding.role]` 才有类型 —— 标成
 * `Record<string, unknown>` 时它们是 `unknown`，下游报 TS18046 / TS2538。
 */
export interface Binding {
  key: string;
  section: string;
  stage: string;
  label: string;
  role: string;
  /** 该绑定允许的工具键（由 role 决定，bind() 里一定补上）。 */
  tools: string[];
  /** "用哪个工具"的设置字段名（每个绑定都有）。 */
  toolKey: string;
  /** "这个环节的覆盖路径"的设置字段名（每个绑定都有）。 */
  pathKey: string;
  [extra: string]: unknown;
}

/** 能力卡里的一个模板槽位。 */
export interface CapabilityTemplate {
  key: string;
  category: string;
  label: string;
  [extra: string]: unknown;
}

/**
 * 一张能力卡（{@link CAPABILITIES} 的一项）。
 *
 * 声明成真实形状后，`capability.templates.map((template) => ...)` 里的 `template`
 * 才有类型 —— 标成 `Record<string, unknown>` 时它是 `unknown`，下游 16 处报 TS18046。
 */
export interface CapabilitySpec {
  key: string;
  section: string;
  label: string;
  hint?: string;
  role: string;
  toolKey: string;
  tools: string[];
  /** 每张能力卡都有模板槽位（可能为空数组）—— 声明必选后不必到处判空。 */
  templates: CapabilityTemplate[];
  [extra: string]: unknown;
}

/**
 * `inspectTools` 的一项：字段定义 + 这台机器上的实际情况。
 *
 * 它是设置页渲染的直接输入，所以成员名必须是**真实的**（不是索引签名糊过去）——
 * 下游 `.filter((tool) => tool.control !== "hidden")` 这类代码要能过类型检查。
 */
export interface InspectedField extends FieldSpec {
  /** 实际生效的路径类型（可能与 field.kind 不同：随选中的工具变）。 */
  kind?: string;
  /** 用户填的原值（未 trim）。 */
  path?: string;
  configured?: boolean;
  present?: boolean;
  inactive?: boolean;
  unused?: boolean;
  required?: boolean;
  /** 下拉/选择的候选项。 */
  options?: Array<{ value: string; label?: string }>;
}

export interface FieldSpec {
  /** 字段唯一标识：每个字段都有（原来推成 string | undefined 是因为我漏看 place spread）。 */
  key: string;
  tool?: string;
  kind?: string;
  label?: string;
  hint?: string;
  control?: string;
  default?: unknown;
  section?: string;
  sectionLabel?: string;
  group?: string;
  blankNote?: string;
  required?: boolean;
  skips?: string[];
  usage?: (path: string) => string[];
  templateLevel?: unknown;
  /** 下拉/选择的候选项。 */
  options?: Array<{ value: string; label?: string }>;
  /** 关联的环节绑定键（用于把字段与 BINDINGS 对上）。 */
  bindingKey?: string;
  stage?: string;
  [extra: string]: unknown;
}

/** 命令名的级别前缀(`shared` 不加前缀 —— 它两级都用,加了反而误导)。 */
const LEVEL_PREFIX: Record<ToolLevel, string> = { module: "module-", project: "project-", shared: "" };

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
export function toolPath(tool: { level: ToolLevel; file: string }): string {
  return join(BUNDLED_TOOLS_DIR, LEVEL_DIRS[tool.level] ?? "", tool.file);
}

/** 命令名应有的级别前缀(守卫用它校验"名字带级别")。 */
export function toolLevelPrefix(tool: { level: ToolLevel }): string {
  return LEVEL_PREFIX[tool.level] ?? "";
}

/**
 * 模板种类 → 字段名与文件名。字段填了就优先用用户那份,留空或不存在就用自带。
 *
 * 这些旧字段只负责迁移老配置；默认值也必须指向现行分类模板，不能依赖已经退出的平铺模板。
 */
export const TEMPLATE_FIELDS: TemplateSlot[] = [
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
export const TOOL_CATALOG: Record<string, ToolCatalogEntry> = {
  python: {
    role: "script",
    label: "Python 3",
    pathKey: "pythonPath",
    kind: "file",
    hint: "python.exe；用于参考模型、测试向量和日志比对。检测只如实报告版本；这里只登记路径，不保证宿主终端强制使用它。",
    usage: (path: string) => [`跑脚本:${usagePath(path)} <脚本.py>(依赖要安装到这个解释器对应的环境中)`]
  },
  verilator: {
    role: "compiler",
    label: "Verilator",
    pathKey: "verilatorPath",
    kind: "file",
    hint: "填写 verilator_bin.exe；MSYS2 常见位置是 C:\\msys64\\mingw64\\bin。",
    usage: (path: string) => [
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
    usage: (path: string) => [`编译检查:${usagePath(path)} -g2012 -o <临时输出文件> <文件...>`, "需要运行结果时再配合同目录的 vvp。"]
  },
  modelsim: {
    role: "simulator",
    label: "ModelSim",
    pathKey: "modelsimPath",
    kind: "file",
    hint: "填写 ModelSim 的 vsim.exe，而不是会直接打开图形界面的 modelsim.exe。",
    usage: (path: string) => [
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
    usage: (path: string) => [
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
    usage: (path: string) => [
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
    usage: (path: string) => [
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
    usage: (path: string) => [`非交互批处理:${usagePath(path)} -t <脚本.tcl>`, "具体综合、实现和烧录命令须按当前 Quartus 工程确认。"]
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

/**
 * 「这个模式最常缺的几样」—— 只对**已经装了部分工具**的用户提示。
 *
 * 优先级按"投入产出":免费的编译检查工具排最前(装完立刻能跑 lint),
 * 商业的综合/仿真工具排后面(要授权,不是每人都需要)。
 * 一条都不装时走 MINIMAL_SETUP 那段更完整的建议,不会重复。
 */
const MISSING_TOOL_HINTS = [
  { tool: "python", why: "脚本工具:参考模型、测试向量生成与日志比对都要用它" },
  { tool: "verilator", why: "编译检查:最快的 RTL lint,免费" },
  { tool: "vivado", why: "综合与实现:模块/工程综合、时序、bitstream 都靠它(装了 Quartus 可跳过)" },
  { tool: "modelsim", why: "仿真:跑测试平台并产出波形(装了 QuestaSim 可跳过)" }
];

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

export const STAGE_BY_KEY = Object.fromEntries(STAGES.map((stage) => [stage.key, stage]));

const ROLE_TOOLS: Record<string, string[]> = {
  script: ["python"],
  compiler: ["verilator", "iverilog", "custom-compiler"],
  simulator: ["modelsim", "questa", "xsim", "custom-simulator"],
  fpga: ["vivado", "quartus", "custom-fpga"]
};

const bind = (key: string, section: string, stage: string, label: string, role: string): Binding => ({
  key,
  section,
  stage,
  label,
  role,
  toolKey: `${key}Tool`,
  pathKey: `${key}Path`,
  tools: ROLE_TOOLS[role]
});

export const BINDINGS: Binding[] = [
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
export const CAPABILITIES: CapabilitySpec[] = [
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

export const CAPABILITY_BY_KEY = Object.fromEntries(CAPABILITIES.map((capability) => [capability.key, capability]));

/** 把目录形式的路径补成可拼接的前缀(XSim 的路径是一个目录)。 */
function pad(path: string): string {
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
    usage: (path: string) => [
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
    usage: (path: string) => [
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
  {
    // AMD 官方 Vivado MCP 服务器(可选)。我们只登记**路径**,不打包、不分发它 ——
    // 其 LICENSE 第 3.2 条禁止向第三方分发;第 2.1 条则明确允许"用户选择的 AI agent
    // 代表用户访问它",插件就是那个 agent,所以存路径并调用是合规的。
    key: "vivadoMcpPath",
    section: "common",
    sectionLabel: SECTION_LABELS.common,
    group: "Vivado MCP",
    control: "text",
    label: "Vivado MCP 服务器（可选）",
    hint:
      "AMD 官方的 vivado_mcp_server 可执行文件（从 AMD 官网登录后下载，需自行遵守其 LICENSE）。" +
      "填了它，本模式的会话多出一组 mcp__vivado__* 工具：常驻 TCL 会话、批处理综合/实现、" +
      "run 进度轮询、日志解析。留空则该能力不出现，其余一切照旧。",
    blankNote: "留空不使用 Vivado MCP（不影响其它功能）",
    kind: "file",
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
for (const field of FIELDS as FieldSpec[]) {
  if (field.control === undefined) field.control = "text";
  if (field.control !== "hidden" && field.section === undefined) {
    field.section = "common";
    field.sectionLabel = SECTION_LABELS.common;
    if (field.group === "库映射") field.group = "仿真库";
  }
}

export const SETTINGS_MODEL_VERSION = "3";

const LEGACY_STAGE_TARGETS: Record<string, string[]> = {
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

const LEGACY_CUSTOM: Record<string, LegacyCustomEntry> = {
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
function legacyBundledTemplateRepair(values: Record<string, unknown>): Record<string, unknown> {
  const patch = {};
  for (const [key, category] of Object.entries(TEMPLATE_CATEGORY_BY_KEY)) {
    const selected = String(values?.[key] ?? "").trim();
    if (selected === "") continue;
    const canonical = canonicalTemplateSelection(selected, category);
    if (canonical !== selected) (patch as Record<string, string>)[String(key)] = canonical;
  }
  return patch;
}

/** 根据旧共享路径里可核对的名字识别工具；认不出来就落入自定义槽位。 */
function inferLegacyTool(role: string, path: string): string {
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
    if (/(^|\\)vsim(?:\.exe)?$/u.test(lower)) return LEGACY_CUSTOM[role]?.tool ?? "";
    if (/(^|\\)(?:xsim|xvlog|xelab)(?:\.bat|\.exe)?$/u.test(lower) || /\\vivado\\bin\\?$/u.test(lower)) return "xsim";
  }
  if (role === "synthesizer") {
    if (/(^|\\)quartus_sh(?:\.exe)?$/u.test(lower) || lower.includes("\\quartus\\")) return "quartus";
    if (/(^|\\)vivado(?:\.bat|\.exe)?$/u.test(lower) || lower.includes("\\vivado\\")) return "vivado";
  }
  return LEGACY_CUSTOM[role]?.tool ?? "";
}

/** 用于比较 Windows 路径是否只是大小写或分隔符不同；不解析、不访问文件系统。 */
function comparablePath(path: string): string {
  return String(path ?? "").trim().replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
}

/**
 * 把 v1 全局设置或 v2 阶段设置一次性迁到“顶部工具登记 + 七张能力卡”。即使已经是 v3，
 * 也会幂等修复能力卡里残留的旧插件平面模板路径；用户自己的路径与新式模板 ID 不动。
 *
 * 迁移只追加新字段或把旧插件模板路径替换成等价 ID，绝不把旧字段写空。冲突保留在旧隐藏字段中，
 * 并写一条不含完整路径的提醒。
 */
export function legacyMigrationPatch(values: Record<string, unknown>): Record<string, unknown> {
  const source = values ?? {};
  const templateRepair = legacyBundledTemplateRepair(source);
  if (valueOf(source, "settingsModelVersion") === SETTINGS_MODEL_VERSION) return templateRepair;

  const effective: Record<string, unknown> = { ...source, ...templateRepair };
  const patch: Record<string, unknown> = { settingsModelVersion: SETTINGS_MODEL_VERSION, ...templateRepair };
  const warnings: string[] = [];
  const current = (key: string): string => String(effective[key] ?? "").trim();
  const original = (key: string): string => String(source[key] ?? "").trim();
  const remember = (key: string, value: unknown, persist = false): void => {
    const text = String(value ?? "").trim();
    if (text === "" || current(key) !== "") return;
    effective[key] = text;
    if (persist) patch[key] = text;
  };
  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  /** 把 v1 的一个角色只放进内存中的 v2 形状，再由下面统一收敛到 v3。 */
  const normalizeV1Role = (role: string, allowed: string[], specificEvidence: Array<[string, string]> = []): string | undefined => {
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
      if (typeof custom.nameKey === "string") remember(custom.nameKey, "旧配置中的其他工具", true);
      if (typeof custom.notesKey === "string") remember(custom.notesKey, `从旧的${role}共享设置迁移；请结合当前工程确认调用方法。`, true);
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
    /**
     * **只在目标还没被显式选过时才写 "none"**（2026-10-22 审查 L9）。
     *
     * 原来无条件把所有 python 阶段设成 "none" —— 而 v2 用户可能已在某个阶段
     * 显式选了具体工具（例如验证阶段用自定义脚本工具），那条选择会在一次迁移里
     * 被静默覆盖。本函数其它分支都有 `current(key) === ""` 这个守卫，这里补同一口径。
     */
    for (const key of LEGACY_STAGE_TARGETS.python) {
      if (current(key) === "") effective[key] = "none";
    }
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
    const unique = [...new Map(paths.map((path: unknown) => [comparablePath(String(path)), path])).values()];
    const registered = current(definition.pathKey);
    if (registered === "" && unique.length === 1) {
      remember(definition.pathKey, unique[0], true);
    } else if (unique.length > 1 || (registered !== "" && unique.some((path) => comparablePath(String(path)) !== comparablePath(registered)))) {
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

  let previousWarnings: string[] = [];
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
export function probeFilesystem(path: string, kind?: string): boolean {
  // **键里必须带 kind**。同一个路径可能被按两种类型问:例如用户把目录填进文件字段时,
  // 界面会先问"是文件吗"(否),再问"是目录吗"(是)。只按路径建键会让第二次直接
  // 命中第一次的 false —— 于是"目录填进文件字段"这种错误被误判成"不可用"或反之。
  // 这是缓存本可以引入、但绝不允许引入的那类错误(实测被自检抓到)。
  const key = `${kind ?? "file"}\u0000${path}`;
  const cached = probeCache.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < PROBE_TTL_MS) return cached.ok;
  const ok = probeUncached(path, kind);
  // 超上限时先丢最早的一半 —— 比"清空"平滑,不会引起一次集中的重查风暴。
  if (probeCache.size >= PROBE_CACHE_LIMIT) {
    const entries = [...probeCache.entries()].sort((left, right) => left[1].at - right[1].at);
    for (const [old] of entries.slice(0, Math.floor(PROBE_CACHE_LIMIT / 2))) probeCache.delete(old);
  }
  probeCache.set(key, { ok, at: now });
  return ok;
}

/**
 * 缓存多久(毫秒)。
 *
 * 为什么需要:**每次组装会话提示**都会对每个已登记工具路径做一次探测,实测 25 次同步
 * `statSync`,占组装耗时的 68%(2026-10-21 实测)。而那 0.6ms 是**阻塞事件循环**的 ——
 * 同一个循环还在服务流式输出与工具调用。而这些路径一天改一次就算频繁,重查毫无收益。
 *
 * 5 秒是个折中:用户在设置页填好路径、点保存后,最坏等 5 秒就能在提示里看到"已就绪";
 * 而一次对话里 20 个请求只查一次。**几秒的陈旧**在这里是无害的(提示只是环境说明),
 * 而"每次请求都碰磁盘"是持续成本。
 */
const PROBE_TTL_MS = 5_000;

/** 探测结果的短 TTL 缓存:`路径 → { ok, at }`。 */
const probeCache = new Map();

/** 缓存条目上限,防止长时间运行后无界增长(路径数量本来就很少,这只是兜底)。 */
const PROBE_CACHE_LIMIT = 256;

/**
 * 清空探测缓存。设置刚保存、或用户点了"重新检测"时调用,让界面立刻反映改动。
 */
export function clearProbeCache() {
  probeCache.clear();
}

/**
 * 真去碰磁盘。**不带缓存** —— 只有 {@link probeFilesystem} 在缓存未命中/过期时调它。
 * @param path - 路径。
 * @param kind - `"file"` 或 `"directory"`。
 * @returns 存在且类型相符。
 */
function probeUncached(path: string, kind?: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return kind === "directory" ? statSync(path).isDirectory() : statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 拿一项配置的字符串值。迁移完成后不再跨字段兜底,避免清空新字段时旧值复活。 */
function valueOf(values: Record<string, unknown>, key: string): string {
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
export function listDirectory(dir: string): { path: string; parent: string | undefined; entries: Array<{ name: string; path: string; kind: string }>; truncated: boolean; error?: string } {
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

  // 相对路径一律拒绝:它锚在**宿主进程的工作目录**上(`..\..\..` 会穿到别处),
  // 而设置页的「浏览…」从来只发绝对路径 —— 收到相对路径只可能是界面之外的请求。
  // **不限制能去哪**:这个 UI 的用途就是"从盘根往下逐层找到工具的可执行文件"。
  if (!isAbsolute(target)) {
    return { path: target, parent: undefined, entries: [], truncated: false, error: "只接受绝对路径" };
  }

  let names;
  try {
    names = readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return { path: target, parent: parentOf(target), entries: [], truncated: false, error: String((error as { code?: string; message?: string }).code ?? (error as { message?: string }).message) };
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
function parentOf(dir: string): string | undefined {
  const trimmed = dir.replace(/[\\/]+$/u, "");
  // 盘根 / UNC share 根之上没有"上一级",返回原样:
  //   · `C:\` 削成 `C:` 是**盘上的工作目录**(readdirSync("C:") 列的是进程 CWD),
  //     显示路径与列出的内容对不上,人很容易把错目录存进设置;
  //   · `\\server\share\` 削掉 share 会得到语法非法的 UNC。
  if (trimmed === "" || /^[A-Za-z]:$/u.test(trimmed) || /^\\\\[^\\]+\\[^\\]+$/u.test(trimmed)) return dir;
  const parent = dirname(trimmed);
  return parent === dir || parent === "" || parent === "." ? dir : parent;
}

/** 解析一个环节绑定；只解析能力事实,不会选择或执行任何工具。 */
/** `resolveBinding` 的结论：绑定本身 + 这次解析出的选择与状态。 */
export interface ResolvedBinding extends Binding {
  selection: string;
  state: string;
  present: boolean;
  unused?: boolean;
  reason?: string;
  path?: string;
  [extra: string]: unknown;
}

/**
 * 绑定不存在时的结论。
 *
 * **它没有 section / stage / label / role / tools** —— 那些来自绑定本身，而绑定都没找到。
 * 所以这里必须是独立的形状，不能用 `ResolvedBinding` 糊过去（第一版那样写，
 * 这个分支直接 TS2739「缺少 5 个属性」）。
 */
export interface MissingBinding {
  key: string;
  selection: string;
  state: string;
  present: false;
  reason: string;
  [extra: string]: unknown;
}

export function resolveBinding(values: Record<string, unknown>, binding: Binding, probe: (path: string, kind?: string) => boolean = probeFilesystem): ResolvedBinding | MissingBinding {
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
export function resolveBindings(values: Record<string, unknown>, probe: (path: string, kind?: string) => boolean = probeFilesystem): Array<ResolvedBinding | MissingBinding> {
  return BINDINGS.map((binding) => resolveBinding(values, binding, probe));
}

/**
 * 解析一张能力卡的工具选择。能力卡只读取顶部工具登记，不存在阶段覆盖路径。
 * @param values - 设置值。
 * @param capability - {@link CAPABILITIES} 中的一项。
 * @param probe - `(path, kind) => boolean`。
 * @returns 能力卡的工具解析结果。
 */
export function resolveCapability(values: Record<string, unknown>, capability: CapabilitySpec, probe: (path: string, kind?: string) => boolean = probeFilesystem): ResolvedCapability {
  if (capability === undefined) {
    return { key: "", section: "", label: "", role: "", toolKey: "", tools: [], templates: [], selection: "", state: "invalid", present: false, reason: "能力配置不存在" } as MissingCapability;
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
export function resolveCapabilities(values: Record<string, unknown>, probe: (path: string, kind?: string) => boolean = probeFilesystem): ResolvedCapability[] {
  return CAPABILITIES.map((capability) => resolveCapability(values, capability, probe));
}

/**
 * 精确解析一张能力卡保存的模板选择。这里只 stat 最终文件，不枚举模板库目录。
 * @param values - 设置值。
 * @param capability - {@link CAPABILITIES} 中的一项。
 * @param tool - 该能力当前的工具选择。
 * @param probe - `(path, kind) => boolean`。
 */
/** 一个探测目标（{@link DETECT_TARGETS} 的一项）。 */
export interface DetectTarget {
  tool: string;
  label: string;
  field: string;
  /** 可选：显式指定版本查询命令。 */
  version?: { args: string[]; pattern: RegExp; timeoutMs?: number };
  /** 候选路径的 glob 列表（每个探测目标都有，可能为空数组）。 */
  globs: Array<{ root: string; pattern: string; fallback?: boolean }>;
  fields?: string[];
  /** 候选可执行文件名（相对 glob 目录）。只有走 PATH 回退时会用到。 */
  exe?: string;
  /** 该目标的路径类型（文件 / 目录）。 */
  kind?: string;
  [extra: string]: unknown;
}

/** 一个内置模板槽位（{@link TEMPLATE_FIELDS} 的一项）。 */
export interface TemplateSlot {
  key: string;
  kind: string;
  label: string;
  file: string;
  announce?: string;
  [extra: string]: unknown;
}

/** 能力卡不存在时的结论（没有定义里的任何字段）。 */
export interface MissingCapability {
  key: string;
  section: string;
  label: string;
  role: string;
  toolKey: string;
  tools: string[];
  templates: CapabilityTemplate[];
  selection: string;
  state: string;
  present: false;
  reason: string;
  [extra: string]: unknown;
}

/** 一张能力卡解析后的结论：能力定义 + 这次选中的工具与可用性。 */
export interface ResolvedCapability extends CapabilitySpec {
  selection: string;
  /** 解析状态：`ready` / `missing` / `auto` / `invalid` 等（客户端按它分色）。 */
  state?: string;
  tool?: string;
  toolLabel?: string;
  configured?: boolean;
  path?: string;
  present?: boolean;
  supportNote?: string;
  reason?: string;
  [extra: string]: unknown;
}

/** 一张能力卡解析一个模板槽位的结果（`describeEnv` 直接读这些字段）。 */
export interface ResolvedTemplate extends CapabilityTemplate {
  source?: string;
  path?: string;
  present?: boolean;
  compatible?: boolean;
  reason?: string;
  templateLabel?: unknown;
  [extra: string]: unknown;
}

export function resolveCapabilityTemplates(values: Record<string, unknown>, capability: CapabilitySpec, tool = "auto", probe: (path: string, kind?: string) => boolean = probeFilesystem): ResolvedTemplate[] {
  const libraryRoot = valueOf(values, "templateLibraryPath");
  return (capability?.templates ?? []).map((template) => {
    const templateArgs = {
      selection: valueOf(values, template.key),
      category: template.category,
      tool,
      libraryRoot,
      probe
    };
    const resolved = resolveTemplateSelection(templateArgs as { selection: string; category: string; tool: string; libraryRoot: string; probe: (path: string, kind?: string) => boolean });
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
export function inspectTools(values: Record<string, unknown>, probe: (path: string, kind?: string) => boolean): InspectedField[] {
  return (FIELDS as FieldSpec[]).map((field) => {
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
 * 兼容旧调用方的字段级缺失判定。新模型没有全局必填路径；实际环节状态由 resolveBinding 判定。
 * @param tool - {@link inspectTools} 的一项。
 * @returns 该进缺失清单时为 true。
 */
export function isMissing(tool: InspectedField): boolean {
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
export function statusOf(values: Record<string, unknown>, probe: (path: string, kind?: string) => boolean = probeFilesystem): Record<string, unknown> {
  const tools = inspectTools(values, probe)
    // 隐藏字段只供迁移使用,不发给设置页。
    .filter((tool) => tool.control !== "hidden")
    .map((tool) => {
      const { usage: _usage, ...safe } = tool;
      return {
        ...safe,
        detectable: DETECT_TARGETS.some((target) => target.field === tool.key),
        // 「没装怎么装」—— 只在**没就绪**时带出去;装好的人不需要在界面上再看一遍下载指引。
        install: tool.present === true || typeof tool.tool !== "string" ? undefined : INSTALL_HINTS[tool.tool]
      };
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
  let migrationWarnings: string[] = [];
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
export function verilatorRootHint(path: string, probe: (path: string, kind?: string) => boolean = probeFilesystem): string[] {
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
export function describeEnv(values: Record<string, unknown>, probe?: (path: string, kind?: string) => boolean): string {
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
      ? [
          // 一个工具都没登记:这时候最该告诉用户的是"怎么装",而不是只说"没核验到"。
          // 换台新机器时,卡住人的从来不是"少了哪个",而是"到底要装几个、从哪儿下"。
          "工具设置:当前没有核验到可用路径。这不妨碍分析、设计和代码修改;要跑编译/仿真/综合时再装。",
          "**起步建议(按需取用,不必全装)**:",
          ...MINIMAL_SETUP.map((line) => `· ${line}`),
          "装完在「设置 → FPGA 开发模式 → 工具设置」里逐项登记路径,点「检测」可以自动找。"
        ].join("\n")
      : ["工具设置中已登记且路径可用的工具:", ...available].join("\n")
  );
  if (available.some((line) => line.includes("(python):"))) lines.push(RUNTIME_NOTE);

  // 部分工具缺失:已经装了几个,但**这个模式最常需要的那几类还没有**。
  // 只在确实缺的时候说,而且只说缺的那几条 —— 已经配好的人不该被念叨"怎么装 Vivado"。
  const missing = MISSING_TOOL_HINTS.filter((entry) => {
    const definition = TOOL_CATALOG[entry.tool];
    if (definition === undefined) return false;
    const path = valueOf(values, definition.pathKey);
    if (path === "") return true;
    try {
      return checkPath(path, definition.kind) !== true;
    } catch {
      return true;
    }
  });
  // 一条都没装时上面那段"起步建议"已经说过了,这里不重复。
  if (available.length > 0 && missing.length > 0) {
    lines.push(
      [
        "还缺这些工具(按需补,不必全装):",
        ...missing.flatMap((entry) => {
          const guidance = installGuidance(entry.tool);
          return [`- ${String(entry.why ?? "")}`, ...guidance];
        })
      ].join("\n")
    );
  }

  for (const [fieldKey, product] of [["modelsimIniPath", "ModelSim"], ["questaIniPath", "QuestaSim"]]) {
    const iniPath = valueOf(values, fieldKey);
    if (iniPath !== "" && exists(checkPath, iniPath)) {
      lines.push(`${product} 库映射文件:${promptScalar(iniPath)}（厂商库解析以其中 [Library] 段为准）。`);
    }
  }

  const resolved = resolveCapabilities(values, checkPath);
  /**
   * 已经全文列过的模板路径。同一份内置模板会被模块卡和工程卡各引用一次
   * (RTL 模板、Testbench、仿真脚本、验证脚本都是这样),第二次再写一遍完整绝对路径
   * 是纯冗余 —— 而且那些路径动辄 150–190 字节。
   *
   * 去重**不损失信息**:第一次仍写全路径,后面只写"(同模块工具的 RTL 模板)"这样的引用。
   * 实测(2026-10-21):最坏情况下这类重复占提示 5%,省下来的是每次请求都省。
   */
  const seenTemplatePaths = new Map();
  for (const sectionKey of ["module", "project"]) {
    const section = SETTINGS_SECTIONS.find((entry) => entry.key === sectionKey);
    const sectionLines = [`${String(section?.label ?? "")}能力偏好（可以按任务反复切换，不表示先后）:`];
    for (const capability of resolved.filter((entry) => entry.section === sectionKey)) {
      const head = `- ${capability.label}`;
      if (capability.state === "auto") {
        sectionLines.push(`${head}:由 AI 从已登记且路径可用的工具中结合当前任务判断；不改写设置。`);
      } else if (capability.state === "none") {
        sectionLines.push(`${head}:明确不用。`);
      } else if (capability.state === "invalid") {
        sectionLines.push(`${head}:选择无效，当前不可执行；其他能力照常工作。`);
      } else if (capability.state === "ready") {
        /**
         * **只写工具名，不再重复完整路径**（2026-10-23 优化）。
         *
         * 原来这里会把 `C:\AMDDesignTools\2025.2\Vivado\bin\vivado.bat` 再抄一遍，
         * 而上一节「工具设置中已登记」已经把每个工具的路径列过了 —— 6 个能力 × 每个
         * 2 条偏好节（模块 + 工程）= 同一条路径在提示词里出现 4 次。
         *
         * 模型要的是「这个环节该用哪个工具」，路径去上面查即可。同一信息只讲一次，
         * 也避免两处路径写法不一致时模型不知道该信哪个。
         *
         * `（来源:工具设置）` 一并去掉：这一节开头已经说过「内容来自设置」。
         */
        sectionLines.push(`${head}:首选 ${capability.toolLabel}。`);
        if (capability.supportNote) sectionLines.push(`  支持范围:${capability.supportNote}`);
        if (capability.notes) sectionLines.push(`  用户说明:${promptScalar(capability.notes)}`);
        else if (capability.tool?.startsWith("custom-")) sectionLines.push("  未提供固定调用说明；使用前须结合当前工程和工具帮助确认。");
      } else {
        // 只有「路径不可用」这种例外才值得把路径抄近处 —— 那是用户要去修的东西。
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
          // 同一路径已经全文列过一次 → 这里只写引用,不再重复那一长串绝对路径。
          const firstSeen = seenTemplatePaths.get(template.path);
          if (firstSeen !== undefined) {
            sectionLines.push(`  模板·${template.label}:同上(与${firstSeen})`);
          } else {
            seenTemplatePaths.set(template.path, `${capability.label}的「${template.label}」`);
            sectionLines.push(`  模板·${template.label}:${promptScalar(template.path)}${source === "" ? "" : `（${source}）`}`);
          }
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
        ? `模板库:${promptScalar(templateLibraryPath)}（只记录来源；展开设置里的能力卡时才扫描目录）。`
        : `模板库:${promptScalar(templateLibraryPath)}（路径当前不可用；已保存的模板选择不会被替换）。`
    );
  }
  lines.push("显式首选应优先采用；若当前工程事实不允许，要说明原因再调整。工具未实际运行就不能把对应验证写成通过。配置本身不会生成命令队列或自动调用工具。");
  lines.push(choiceLines(tools as InspectedField[]));
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
      /**
       * **命令根只声明一次**（2026-10-23 优化）。
       *
       * 原来每条命令都写完整绝对路径 —— 7 条里有同一段 67 字符的前缀重复 7 次，
       * 光那段就占 469 字符。而下面三行本来就已经说明 `module-` 在 `tools/module/`、
       * `project-` 在 `tools/project/`、共用的在 `tools/` 顶层 —— 等于同一结构讲了两遍。
       *
       * 所以：把根目录提出来写一次，每条只留相对路径。**信息一点没少**，
       * 模型拼命令时用 `<命令根>` 开头即可；路径也不再有正反斜杠混用的余地。
       */
      `命令根:${toolPath({ level: "shared", file: "" }).replace(/[\\/][^\\/]*$/u, "")}`,
      "· `module-` = 模块级(在 `module/` 下);`project-` = 工程级(在 `project/` 下);",
      "  两级共用的(如 setup-scaffold)不加级别前缀,直接在命令根下。",
      ...TOOLS.map((tool) => {
        const level = tool.level === "shared" ? "两级共用" : tool.level === "module" ? "模块级" : "工程级";
        // 相对命令根的路径：模块级在 module\ 下、工程级在 project\ 下、共用的直接在根下。
        const dir = LEVEL_DIRS[tool.level as ToolLevel] ?? "";
        const relative = dir === "" ? tool.file : `${dir}\\${tool.file}`;
        return `- [${level} / ${tool.stage}] ${tool.what}:node "<命令根>\\${relative}" <根目录>`;
      })
    ].join("\n")
  );
  lines.push("命令用现有 shell 工具跑(走沙箱、输出可回看);综合与大回归放后台任务再读日志,不要前台死等。");

  // AMD 官方 Vivado MCP(可选)。只在用户真的填了路径时才出现 —— 没装的人不该读到
  // 一整段"你有这些工具"的说明,那只会让模型去调不存在的工具。
  const mcpPath = valueOf(values, "vivadoMcpPath");
  if (mcpPath !== "") {
    let mcpPresent = false;
    try {
      mcpPresent = checkPath(mcpPath, "file") === true;
    } catch {
      mcpPresent = false;
    }
    lines.push(
      mcpPresent
        ? [
            "已启用 **Vivado MCP**(AMD 官方,由用户自行下载):本会话有一组 `mcp__vivado__*` 工具,"
              + "它管的是一个**常驻 Vivado 会话**,与你用 shell 跑 `vivado -mode batch` 是两条路。",
            "怎么用:",
            "- 起会话用 `vivado_start`(必须给 `session_type` 与已存在的 `working_dir`);之后所有 Tcl 走 `vivado_execute`。",
            "- **综合/实现这类长命令**:先 `launch_runs synth_1`,再单独一次 `wait_on_run synth_1`;"
              + "命令超过约 5 分钟会返回 `status: running`,此时用 `vivado_status` 隔 30–60 秒查一次,不要循环狂查。",
            "- 批处理:建工程、`add_files`、`set_property`、约束可以合成一条;"
              + "`launch_runs` / `wait_on_run` / `synth_design` / `open_project` / `source` 必须单独调用。",
            "- 出错先看它返回的 `recovery_hint` 与 `log_file`;要用日志里的具体告警,`vivado_log_messages` 比肉眼翻文件可靠。",
            "- 一个会话同一时刻只跑一条命令,不要对同一 session 并行调用 `vivado_execute`。",
            "**结论仍然由你判**:MCP 只是把命令送进 Vivado、把输出送回来,它不判断设计对不对;"
              + "证据落盘与 PASS/FAIL 的判据照旧走本模式的技能。"
          ].join("\n")
        : `Vivado MCP:${promptScalar(mcpPath)}(路径当前不可用;这组工具不会出现,其余功能照常)。`
    );
  }

  return lines.join("\n\n");
}

/**
 * 语言与标准(工具选什么由上一条已就绪清单负责,这里只说语言)。
 *
 * agent 写代码要按这里来 —— 不写清楚,它会按自己的习惯挑语言,而"这个工程是 VHDL"只有设置里知道。
 * @param tools - {@link inspectTools} 的结果。
 * @returns 提示段里的一节。
 */
function choiceLines(tools: InspectedField[]): string {
  const byKey = new Map(tools.filter((tool) => tool.control === "select").map((tool) => [tool.key, tool]));
  const labelOf = (tool: FieldSpec | undefined): string =>
  tool?.options?.find((option: { value: string; label?: string }) => option.value === tool.path)?.label ?? String(tool?.path ?? "");
  const rtl = byKey.get("rtlLangStd");
  const sim = byKey.get("simLangStd");
  const simLabel = sim?.path === "same" ? `与 RTL 相同(${labelOf(rtl)})` : labelOf(sim);

  return [
    "语言与标准(按设置来,不要自己换一套):",
    `- RTL:${labelOf(rtl)} —— 文件扩展名 ${EXTENSIONS[String(rtl?.path ?? "")] ?? ".sv"}`,
    `- 仿真语言:${simLabel}`
  ].join("\n");
}

/** 语言 → 文件扩展名。写代码时按它决定 .sv / .v / .vhd。 */
const EXTENSIONS: Record<string, string> = {
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
export function resolveTemplates(
  values: Record<string, unknown>,
  probe: (path: string, kind?: string) => boolean
): Array<{ kind: string; label: string; file: string; path: string; source: string; present: boolean; announce: string; missing?: string }> {
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
function exists(probe: (path: string, kind?: string) => boolean, path: string): boolean {
  try {
    return probe(path, "file") === true;
  } catch {
    return false;
  }
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
export function promptScalar(value: unknown): string {
  const text = String(value ?? "");
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
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
export function promptArg(value: unknown): string {
  const text = promptScalar(value);
  if (/^[A-Za-z0-9_.:/\\-]+$/u.test(text)) return text;
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * 工具目录里的 usage 示例:路径一律按 **PowerShell 可粘贴**的形式渲染。
 *
 * **只归一「真实的路径分隔符」**(2026-10-22):
 *
 * 起因是实测发现提示自相矛盾 —— `VERILATOR_ROOT` 那行用了正斜杠,紧随其后的
 * `& C:\msys64\...\verilator_bin.exe` 却是反斜杠,而说明里正写着「路径用正斜杠,
 * 别被转义吃掉」。反斜杠在 PowerShell 双引号字符串 / Tcl 里会被当转义(`\t` `\n` `\v`)。
 *
 * 但第一版我直接 `split(sep).join("/")`,把**所有**反斜杠都换了 —— 那会毁掉另一条既有
 * 契约:`promptScalar` 要把路径里的控制字符渲染成**可见转义**(`\n` → `\n` 两个字),
 * 全换斜杠后 `C:\a\nFAKE` 变成 `C:/a/nFAKE`,看起来像路径段而不是转义,断言当场红。
 *
 * 所以判据收窄:只把「分隔符位置」上的反斜杠换成斜杠 —— 即**后面不再跟
 * `n` `r` `t` `x` 等转义字母**的那些。Windows 真实路径里的目录名极少以这些字母开头,
 * 而转义序列恰好都是。
 *
 * 只影响**显示出来的命令示例**;设置里存的仍是用户填的原值。
 * @param path - 已登记的工具路径(原值)。
 * @returns 渲染后的参数。
 */
const usagePath = (path: unknown): string => {
  const text = String(path ?? "");
  /**
   * 只把**明确是路径分隔符**的反斜杠换成 `/`（2026-10-23，被 `check-toolchain` 教了三次）。
   *
   * ## 最终判据
   *
   * **保留**（不换）这四类 —— 它们是"转义形态"，换掉就等于把转义破坏成路径段：
   *   · `\` + 真实控制字符 U+0000–001F / 007F–009F（`promptScalar` 的转义引导符）；
   *   · `\n` `\r` `\t` `\x` —— 字面转义的四种形态。**这四类一律不动。**
   *
   * **要换**：其余所有反斜杠（普通目录分隔符）。
   *
   * ## 为什么 `\n` 一律不动，而不是"看后面跟什么"
   *
   * 我试过用 `\n` 后面跟不跟字母来区分「转义」与「目录名」—— 但
   * `\nFAKE`（字面转义 + 大写字母）与 `\nodejs`（目录名 + 小写字母）**在字符串层面
   * 无法可靠区分**。我为此连改三版，每版都被断言拦下。
   *
   * 而这两类错误代价不同：
   *   · 把转义换坏（`\n` → `/n`）= **静默的显示错误**，用户照抄命令就错；
   *   · 把 `\nodejs` 保留成反斜杠 = 只是**观感不统一**，命令照样能跑。
   *
   * 所以取"宁可保留转义"这一侧。真实世界里以 `n` `r` `t` `x` 开头的目录名很少，
   * 而 `\n` `\r` `\t` 字面转义会被用户真的粘进来。
   *
   * **已知取舍**：`C:\tools\...` / `C:\nodejs\...` 这类路径在命令示例里仍会保留反斜杠，
   * 与同行其它的 `/` 混排 —— 这是上面代价权衡的结果，不是遗漏。
   */
  const normalized = text.replace(/\\(?![\u0000-\u001f\u007f-\u009f]|[nrtx])/gu, "/");
  // promptArg 内部已经调 promptScalar（渲染控制字符 + 按需加引号），这里不再重复转义。
  return promptArg(normalized);
};

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
export function queryVersion(path: string, command: { args: string[]; pattern: RegExp; timeoutMs?: number }): { version?: string; error?: string; output?: string } {
  try {
    const result = spawnSync(path, command.args, {
      encoding: "utf8",
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true
    });
    if (result.error !== undefined && result.error !== null) {
      return { error: String((result.error as { code?: string; message?: string }).code ?? (result.error as { message?: string }).message) };
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
    return { error: String((error as { code?: string; message?: string })?.code ?? (error as { message?: string })?.message ?? error) };
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
export const DETECT_TARGETS: DetectTarget[] = [
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
function matchesPattern(name: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  const lowered = name.toLowerCase();
  if (star === -1) return lowered === pattern.toLowerCase();
  return lowered.startsWith(pattern.slice(0, star).toLowerCase()) && lowered.endsWith(pattern.slice(star + 1).toLowerCase());
}

/** 展开 `%Name%` 记号;变量不在时原样保留(那样自然探不到,不会误报成命中)。 */
function expandEnv(text: string, env: NodeJS.ProcessEnv): string {
  return String(text).replace(/%([^%]+)%/gu, (whole, name) => {
    const value = env?.[name];
    return typeof value === "string" && value !== "" ? value : whole;
  });
}

/** 列一个目录下的子目录名;读不动时为空 —— 一个拒绝访问的目录不该让整次检测失败。 */
export function readdirNames(dir: string): string[] {
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
function expandPattern(root: string, pattern: string, list: (dir: string) => string[]): string[] {
  let current = [root];
  for (const segment of String(pattern).split("\\")) {
    if (segment === "") continue;
    const next = [];
    for (const dir of current) {
      if (segment.includes("*")) {
        for (const name of list(dir)) if (matchesPattern(String(name), segment)) next.push(join(dir, name));
      } else {
        next.push(join(dir, segment));
      }
    }
    current = next;
  }
  return current;
}

/** PATH 里的目录(去掉引号与空项)。 */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
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
  probe: (path: string, kind?: string) => boolean = probeFilesystem,
  list: (dir: string) => string[] = readdirNames,
  env: NodeJS.ProcessEnv = process.env,
  readVersion: (path: string, command: { args: string[]; pattern: RegExp; timeoutMs?: number }) => unknown = queryVersion,
  fields: string[] | undefined = undefined
): Array<Record<string, unknown>> {
  const hits: Array<{ field: string; tool: string; label: string; path: string; source: string; version?: unknown; versionError?: unknown; versionNote?: string }> = [];
  const seen = new Set<string>();
  const exists = (path: string, kind = "file"): boolean => {
    try {
      return probe(path, kind) === true;
    } catch {
      return false;
    }
  };
  /** 展开一组模式,留下真实存在的(同一个路径只留一次)。 */
  const expand = (globs: Array<{ root: string; pattern: string }>): string[] =>
    globs
      .flatMap((glob: { root: string; pattern: string }) => expandPattern(expandEnv(glob.root, env), expandEnv(glob.pattern, env), list))
      .filter((path, index, all) => exists(path) && all.indexOf(path) === index);

  /**
   * 版本信息:只有带 `version` 的检测项会走到这里 —— 也就是**只有它会起进程**。
   * 认不出 / 起不来 / **命令失败**时如实记 error 与原始输出(见 queryVersion)。
   * 只报实测到的东西:不做"版本够不够"的判定(没有字段声明硬要求了 —— 带 `expected` 的
   * 那套判定随终端字段一起删了,2026-09-21;用户对 Python 3 没有统一版本约束)。
   */
  const versionInfo = (target: DetectTarget, path: string): Record<string, unknown> => {
    if (target.version === undefined) return {};
    let queried: { version?: unknown; error?: unknown };
    try {
      queried = (readVersion(path, target.version) ?? {}) as { version?: unknown; error?: unknown };
    } catch (error) {
      queried = { error: String((error as { message?: string })?.message ?? error) };
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
  const wanted = Array.isArray(fields) ? new Set((fields as unknown[]).map(String)) : undefined;
  const targets = wanted === undefined
    ? DETECT_TARGETS
    : DETECT_TARGETS.filter((target) => wanted.has(target.field));
  for (const target of targets) {
    const primary = expand(target.globs.filter((glob) => glob.fallback !== true));
    const known = primary.length > 0 ? primary : expand(target.globs.filter((glob) => glob.fallback === true));
    const present = known.map((path) => ({ path, source: "known" }));
    if (present.length === 0) {
      for (const dir of pathDirs(env)) {
        if (target.exe === undefined) break;
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

/**
 * 每个工具「没装时怎么办」的安装指引。
 *
 * 为什么要有这张表:检测为空时原来的提示只有一句"当前没有核验到可用路径",
 * 用户知道缺,但不知道**去哪儿装、装完要填哪个文件、免费的够不够用** ——
 * 换台新机器时这正是最卡人的一步。
 *
 * 只写**确定的事**:官方获取渠道 + 一句"装完把哪个文件填进设置"。
 * 不写版本号(会过期)、不写"推荐某某版本"(各家工程要求不同)、不写直链
 * (链接会变,而且有些要登录)。`free` 表示可免费用于商用;`account` 表示下载需注册账号。
 */
/**
 * 某个工具"从哪儿装、填什么"的说明。
 *
 * ⚠️ 这是**对象**不是字符串数组 —— 我第一批误标成 `Record<string, string[]>`，
 * 结果 `hint.free` / `hint.where` 等 10 处报 TS2339。按真实数据声明。
 */
export interface InstallHint {
  /** 工具名（设置页展示用）。 */
  label?: string;
  where: string;
  note: string;
  url: string;
  free?: boolean;
  account?: boolean;
  [extra: string]: unknown;
}

export const INSTALL_HINTS: Record<string, InstallHint> = {
  python: {
    label: "Python 3",
    free: true,
    account: false,
    where: "python.org 的 Windows 安装包,或 Microsoft Store 的 Python;Anaconda / Miniconda 也可以。",
    note: "装完把 python.exe 填进「脚本工具」—— 参考模型与日志比对脚本靠它跑。",
    url: "https://www.python.org/downloads/windows/"
  },
  verilator: {
    label: "Verilator",
    free: true,
    account: false,
    where: "Windows 上用 MSYS2:`pacman -S mingw-w64-x86_64-verilator`。",
    note: "填 mingw64/bin/verilator_bin.exe(不是无扩展名的 Perl 包装脚本);"
      + "若报找不到 verilated_std_waiver.vlt,再设环境变量 VERILATOR_ROOT 指向 share/verilator。",
    url: "https://www.msys2.org/"
  },
  iverilog: {
    label: "Icarus Verilog",
    free: true,
    account: false,
    where: "steveicarus.github.io 的 Windows 安装包(装完通常已在 PATH)。",
    note: "SystemVerilog 支持有限,适合 Verilog-2001 工程做编译检查;综合与仿真仍以厂商工具为准。",
    url: "https://steveicarus.github.io/iverilog/"
  },
  modelsim: {
    label: "ModelSim",
    free: false,
    account: true,
    where: "Siemens EDA 官网(Intel/Altera 随 Quartus 附带的版本也可以)。",
    note: "商业软件,需要授权。填 win64/vsim.exe,不是会直接开图形界面的 modelsim.exe。",
    url: "https://www.siemens.com/en-us/products/ic/eda/simulation/"
  },
  questa: {
    label: "QuestaSim",
    free: false,
    account: true,
    where: "Siemens EDA 官网。",
    note: "商业软件,需要授权。与 ModelSim 分开登记 —— 两者可执行文件同名,靠路径区分。",
    url: "https://www.siemens.com/en-us/products/ic/eda/simulation/"
  },
  xsim: {
    label: "Vivado XSim",
    free: true,
    account: true,
    where: "随 Vivado 一起安装(AMD 官网,需登录;有免费的 WebPACK 版)。",
    note: "填 Vivado 的 bin 目录(xvlog / xelab / xsim 三个入口都在里面),不是某个 exe。",
    url: "https://www.xilinx.com/support/download.html"
  },
  vivado: {
    label: "Vivado",
    free: true,
    account: true,
    where: "AMD 官网(需 AMD 账号);器件在 WebPACK 范围内的项目可以零成本使用。",
    note: "填 vivado.bat。综合、实现、时序与 bitstream 用它;与 Quartus 二选一即可,不必都装。",
    url: "https://www.xilinx.com/support/download.html"
  },
  quartus: {
    label: "Quartus Prime",
    free: true,
    account: true,
    where: "Intel / Altera 官网;Lite 版免费。",
    note: "填 quartus_sh.exe。注意:本插件目前只保证路径登记与检测,不承诺完整的 Quartus 工程流程。",
    url: "https://www.intel.com/content/www/us/en/software-kit/776511/intel-quartus-prime-lite-edition-design-software-version-23-1-for-windows.html"
  }
};

/**
 * 「最省事的起步组合」—— 只在**一个工具都没登记**时出现,不打扰已经配好的人。
 *
 * 新机器上最先遇到的问题不是"哪个工具最强",而是"到底要装几个"。
 * 这三行按投入产出排序:免费的两个先上,商业的按需再加。
 */
export const MINIMAL_SETUP = [
  "**只想写 RTL 并做编译检查** → 装 Python 3 + Verilator(或 Icarus Verilog)。两个都免费,十分钟能配好。",
  "**要综合、实现、生成 bitstream** → 再加 Vivado(AMD 账号,WebPACK 免费版)或 Quartus Prime Lite;两者二选一。",
  "**要做门级/时序仿真** → 需要 ModelSim 或 QuestaSim,这两个是商业软件、需授权;没有它们也能做 RTL 级仿真。"
];

/**
 * 把一个没就绪的工具渲染成"缺什么 + 怎么装"的几行。
 *
 * 只在**没装**的时候给安装指引;已经装好的人不需要被念叨怎么装。
 * @param toolKey - TOOL_CATALOG 的键(如 `vivado`)。
 * @returns 提示行数组;没有对应指引时为空数组。
 */
export function installGuidance(toolKey: string): string[] {
  const hint = INSTALL_HINTS[toolKey];
  if (hint === undefined) return [];
  const cost = hint.free === true ? "免费" : "商业授权";
  const account = hint.account === true ? ",下载需注册账号" : "";
  return [
    `    安装:${hint.where}(${cost}${account})`,
    `    填什么:${hint.note}`,
    `    官网:${hint.url}`
  ];
}
