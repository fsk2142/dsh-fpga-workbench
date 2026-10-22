import { canonicalTemplateSelection, resolveTemplateSelection } from "./template-library.js";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
//#region src/toolchain.ts
/** 设置命名空间,同时也是客户端设置页认领的那个 key。两边必须写同一个值。 */
const NS = "fpga-workbench";
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
* 级别 → 命令所在子目录（`shared` 是两级共用，所以是空串）。
*
* `Record<ToolLevel, string>` 而不是裸对象字面量：`TOOLS[].level` 是 `ToolLevel`，
* 用这个类型才能直接 `LEVEL_DIRS[tool.level]` 索引（裸字面量索引会 TS7053）。
*/
const LEVEL_DIRS = {
	module: "module",
	project: "project",
	shared: ""
};
/** 命令名的级别前缀(`shared` 不加前缀 —— 它两级都用,加了反而误导)。 */
const LEVEL_PREFIX = {
	module: "module-",
	project: "project-",
	shared: ""
};
/**
* 自带命令。两类:两级共用的骨架,以及模块级的检查/起文件。
*
* **没有"看波形"这类交互入口**:要看波形用已经确认过的仿真脚本起 GUI。
*/
const TOOLS = [
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
function toolPath(tool) {
	return join(BUNDLED_TOOLS_DIR, LEVEL_DIRS[tool.level] ?? "", tool.file);
}
/** 命令名应有的级别前缀(守卫用它校验"名字带级别")。 */
function toolLevelPrefix(tool) {
	return LEVEL_PREFIX[tool.level] ?? "";
}
/**
* 模板种类 → 字段名与文件名。字段填了就优先用用户那份,留空或不存在就用自带。
*
* 这些旧字段只负责迁移老配置；默认值也必须指向现行分类模板，不能依赖已经退出的平铺模板。
*/
const TEMPLATE_FIELDS = [
	{
		key: "rtlTemplatePath",
		kind: "rtl",
		label: "RTL 模板",
		file: "rtl/systemverilog_module.sv"
	},
	{
		key: "tbTemplatePath",
		kind: "tb",
		label: "测试平台模板",
		file: "simulation/testbench/systemverilog_testbench.sv"
	},
	{
		key: "xdcTemplatePath",
		kind: "xdc",
		label: "约束模板",
		file: "constraints/vivado_module_xdc.xdc"
	},
	{
		key: "runDoTemplatePath",
		kind: "sim-run",
		label: "仿真脚本模板",
		file: "simulation/run/modelsim_run.do",
		announce: "custom"
	},
	{
		key: "synthScriptTemplatePath",
		kind: "synth-script",
		label: "综合脚本模板",
		file: "synthesis/vivado_module_synthesis.tcl",
		announce: "custom"
	},
	{
		key: "compScriptTemplatePath",
		kind: "comp",
		label: "验证脚本模板",
		file: "verification/python_data_verification.py",
		announce: "custom"
	}
];
/** 语言与标准:合成一个下拉,避免"语言和标准对不上"的组合(vhdl-2008 配 1800-2017 这种)。 */
const LANG_STD = [
	{
		value: "sv-2017",
		label: "SystemVerilog (IEEE 1800-2017)"
	},
	{
		value: "sv-2012",
		label: "SystemVerilog (IEEE 1800-2012)"
	},
	{
		value: "v2001",
		label: "Verilog-2001"
	},
	{
		value: "vhdl-2008",
		label: "VHDL-2008"
	}
];
/** 设置页的三个顶层区。数组只定义展示分区,不表示执行顺序。 */
const SETTINGS_SECTIONS = [
	{
		key: "common",
		label: "工具设置",
		hint: "先登记并确认本机工具；模块和工程只引用这里的工具。"
	},
	{
		key: "module",
		label: "模块工具",
		hint: "四类能力可以按任务反复切换，不是流水线。"
	},
	{
		key: "project",
		label: "工程工具",
		hint: "工程主工具、系统仿真与脚本验证分别设置，不自动执行。"
	}
];
const SECTION_LABELS = Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.key, section.label]));
/**
* 本机工具登记表。路径、路径类型、调用提示只在这里定义一次,设置、探测、状态与会话提示共用。
* 自定义槽位只有用户明确选择时才参与某个环节;没有调用说明时只承诺“路径可用”。
*/
const TOOL_CATALOG = {
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
		usage: (path) => [`快速 lint:${usagePath(path)} --lint-only -Wall --top-module <顶层模块> <文件...>`, "优先使用 verilator_bin.exe 本体；无扩展名的 verilator 是 Perl 包装脚本。"]
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
		usage: (path) => [`非交互仿真:${usagePath(path)} -c -do "do <脚本.do>; quit -f"`, "-c 表示命令行模式；日志和波形应放到当前验证环节目录。"]
	},
	questa: {
		role: "simulator",
		label: "QuestaSim",
		pathKey: "questaPath",
		kind: "file",
		hint: "填写 QuestaSim 的 vsim.exe；它与 ModelSim 分开登记、分开检测。",
		usage: (path) => [`非交互仿真:${usagePath(path)} -c -do "do <脚本.do>; quit -f"`, "-c 表示命令行模式；日志和波形应放到当前验证环节目录。"]
	},
	xsim: {
		role: "simulator",
		label: "Vivado XSim",
		pathKey: "xsimPath",
		kind: "directory",
		hint: "填写 Vivado 的 bin 目录；xvlog、xelab、xsim 三个入口都应在其中。",
		usage: (path) => [`三步走:"${pad(path)}xvlog" -sv <源码...> → "${pad(path)}xelab" -debug typical <顶层> -s tb_sim → "${pad(path)}xsim" tb_sim -runall`, "这里登记的是 Vivado bin 目录，不是某一个可执行文件。"]
	},
	vivado: {
		role: "fpga",
		label: "Vivado",
		pathKey: "vivadoPath",
		kind: "file",
		hint: "Windows 填写 vivado.bat；用批处理模式执行综合、实现、时序和 bitstream 工作。",
		usage: (path) => [`非交互批处理:${usagePath(path)} -mode batch -source <脚本.tcl> -log <日志路径> -journal <记录路径>`, "不加 -mode batch 会启动图形界面。"]
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
/**
* 「这个模式最常缺的几样」—— 只对**已经装了部分工具**的用户提示。
*
* 优先级按"投入产出":免费的编译检查工具排最前(装完立刻能跑 lint),
* 商业的综合/仿真工具排后面(要授权,不是每人都需要)。
* 一条都不装时走 MINIMAL_SETUP 那段更完整的建议,不会重复。
*/
const MISSING_TOOL_HINTS = [
	{
		tool: "python",
		why: "脚本工具:参考模型、测试向量生成与日志比对都要用它"
	},
	{
		tool: "verilator",
		why: "编译检查:最快的 RTL lint,免费"
	},
	{
		tool: "vivado",
		why: "综合与实现:模块/工程综合、时序、bitstream 都靠它(装了 Quartus 可跳过)"
	},
	{
		tool: "modelsim",
		why: "仿真:跑测试平台并产出波形(装了 QuestaSim 可跳过)"
	}
];
/** 工具设置卡片的固定分类；顺序只用于展示，不表示调用顺序。 */
const TOOL_GROUPS = [
	{
		key: "script",
		label: "脚本工具"
	},
	{
		key: "compiler",
		label: "编译工具"
	},
	{
		key: "simulator",
		label: "仿真工具"
	},
	{
		key: "fpga",
		label: "FPGA 工具"
	}
];
const TOOL_GROUP_BY_KEY = Object.fromEntries(TOOL_GROUPS.map((group) => [group.key, group]));
/** 环节只是能力分组；这里没有“当前环节”或先后状态。 */
const STAGES = [
	{
		key: "module-spec",
		section: "module",
		label: "规格",
		bindings: ["moduleSpecScript"]
	},
	{
		key: "module-rtl",
		section: "module",
		label: "RTL",
		bindings: ["moduleRtlCompiler"]
	},
	{
		key: "module-verif",
		section: "module",
		label: "验证",
		bindings: ["moduleVerifSimulator", "moduleVerifScript"]
	},
	{
		key: "module-synth",
		section: "module",
		label: "综合",
		bindings: ["moduleSynthFpga"]
	},
	{
		key: "module-review",
		section: "module",
		label: "审查",
		bindings: [],
		note: "按审查对象复用其他环节工具，不单设工具。"
	},
	{
		key: "project-spec",
		section: "project",
		label: "规格",
		bindings: ["projectSpecScript"]
	},
	{
		key: "project-integrate",
		section: "project",
		label: "集成",
		bindings: ["projectIntegrateCompiler", "projectIntegrateFpga"]
	},
	{
		key: "project-constraints",
		section: "project",
		label: "约束",
		bindings: ["projectConstraintsFpga"]
	},
	{
		key: "project-syssim",
		section: "project",
		label: "系统仿真",
		bindings: ["projectSyssimSimulator", "projectSyssimScript"]
	},
	{
		key: "project-impl",
		section: "project",
		label: "实现",
		bindings: ["projectImplFpga"]
	},
	{
		key: "project-timing",
		section: "project",
		label: "时序",
		bindings: ["projectTimingFpga"]
	},
	{
		key: "project-board",
		section: "project",
		label: "上板",
		bindings: ["projectBoardFpga"]
	},
	{
		key: "project-release",
		section: "project",
		label: "发布",
		bindings: ["projectReleaseFpga"]
	}
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((stage) => [stage.key, stage]));
const ROLE_TOOLS = {
	script: ["python"],
	compiler: [
		"verilator",
		"iverilog",
		"custom-compiler"
	],
	simulator: [
		"modelsim",
		"questa",
		"xsim",
		"custom-simulator"
	],
	fpga: [
		"vivado",
		"quartus",
		"custom-fpga"
	]
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
const BINDINGS = [
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
const CAPABILITIES = [
	{
		key: "module-rtl",
		section: "module",
		label: "RTL 编译工具",
		hint: "用于 RTL 语法、lint 与编译检查；可以和验证、修改反复切换，不是固定的第一步。",
		role: "compiler",
		toolKey: "moduleRtlTool",
		tools: ROLE_TOOLS.compiler,
		templates: [{
			key: "moduleRtlTemplate",
			category: "rtl",
			label: "RTL 模板"
		}]
	},
	{
		key: "module-simulation",
		section: "module",
		label: "仿真测试工具",
		hint: "编译测试平台并运行功能仿真；编译与运行是同一份脚本(按模式调用)，可以只重跑其中一项。",
		role: "simulator",
		toolKey: "moduleSimulationTool",
		tools: ROLE_TOOLS.simulator,
		templates: [{
			key: "moduleTestbenchTemplate",
			category: "testbench",
			label: "Testbench 模板"
		}, {
			key: "moduleSimulationRunTemplate",
			category: "sim-run",
			label: "仿真脚本",
			hint: "编译与运行是同一份脚本(按模式调用)；留空由 AI 自行决定，也可从模板库选一份固定脚本。"
		}]
	},
	{
		key: "module-verification",
		section: "module",
		label: "脚本验证工具",
		hint: "用于参考模型、测试向量、日志或结果比对；是否使用由当前验证问题决定。",
		role: "script",
		toolKey: "moduleVerificationTool",
		tools: ROLE_TOOLS.script,
		templates: [{
			key: "moduleVerificationTemplate",
			category: "verification",
			label: "验证脚本模板"
		}]
	},
	{
		key: "module-gate",
		section: "module",
		label: "综合与门禁工具",
		hint: "用于模块综合、资源与时序门禁；结果可以返回 RTL 或约束继续迭代。",
		role: "fpga",
		toolKey: "moduleGateTool",
		tools: ROLE_TOOLS.fpga,
		templates: [{
			key: "moduleSynthesisTemplate",
			category: "synthesis",
			label: "综合脚本"
		}, {
			key: "moduleConstraintsTemplate",
			category: "constraints",
			label: "约束模板"
		}]
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
			{
				key: "projectLintTemplate",
				category: "linter",
				label: "Linter 脚本",
				hint: "留空由 AI 自行决定；也可从模板库选一份固定脚本。"
			},
			{
				key: "projectRtlTemplate",
				category: "rtl",
				label: "RTL 模板"
			},
			{
				key: "projectConstraintsTemplate",
				category: "project-constraints",
				label: "约束模板",
				hint: "工程约束与模块约束不是同一份:模块版只管模块自己的时钟;工程版管全工程时钟 + 引脚 + IO 时序(引脚以 sch/ 原理图为准)。"
			},
			{
				key: "projectSynthesisTemplate",
				category: "project-synthesis",
				label: "综合脚本",
				hint: "工程综合与模块综合不是同一份脚本:库里那份是模块级的(<ModuleName>、从模块根跑)。这一栏留空由 AI 自行决定;要固定,请从模板库里选一份工程用的(打开 prj/<工程>.xpr 后跑 synth_1)。"
			},
			{
				key: "projectImplementationTemplate",
				category: "implementation",
				label: "实现脚本"
			},
			{
				key: "projectBitstreamTemplate",
				category: "bitstream",
				label: "Bitstream 脚本",
				hint: "留空由 AI 自行决定；也可从模板库选一份固定脚本。"
			},
			{
				key: "projectProgrammingTemplate",
				category: "programming",
				label: "下载脚本"
			}
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
		templates: [{
			key: "projectTestbenchTemplate",
			category: "testbench",
			label: "Testbench 模板"
		}, {
			key: "projectSimulationRunTemplate",
			category: "sim-run",
			label: "仿真脚本",
			hint: "编译与运行是同一份脚本(按模式调用)；留空由 AI 自行决定，也可从模板库选一份固定脚本。"
		}]
	},
	{
		key: "project-verification",
		section: "project",
		label: "脚本验证工具",
		hint: "用于系统级参考模型、数据生成和结果比对；与模块验证工具独立选择。",
		role: "script",
		toolKey: "projectVerificationTool",
		tools: ROLE_TOOLS.script,
		templates: [{
			key: "projectVerificationTemplate",
			category: "verification",
			label: "验证脚本模板"
		}]
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
const FIELDS = [
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
	...[
		[
			"custom-compiler",
			"自定义编译工具",
			"编译工具"
		],
		[
			"custom-simulator",
			"自定义仿真工具",
			"仿真工具"
		],
		[
			"custom-fpga",
			"自定义 FPGA 工具",
			"FPGA 工具"
		]
	].flatMap(([tool, label, group]) => {
		const definition = TOOL_CATALOG[tool];
		const shared = {
			tool,
			section: "common",
			sectionLabel: SECTION_LABELS.common,
			group,
			required: false,
			skips: []
		};
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
		options: [{
			value: "same",
			label: "与 RTL 相同"
		}, ...LANG_STD],
		required: false,
		skips: []
	},
	{
		key: "modelsimIniPath",
		section: "common",
		sectionLabel: SECTION_LABELS.common,
		group: "仿真库",
		control: "text",
		label: "ModelSim 库映射文件",
		hint: "ModelSim 的 modelsim.ini:厂商预编译库靠它的 [Library] 段(库名 = 目录)解析。留空则用安装目录里那份",
		blankNote: "留空用安装目录那份",
		kind: "file",
		required: false,
		skips: [],
		usage: (path) => [`厂商库 / IP 库能不能用,看这份文件的 [Library] 段:${promptScalar(path)}`, "改映射用 vmap;`vmap` 不带参数会列出**当前生效**的全部映射。注意查找顺序:MODELSIM 环境变量 → 当前目录的 modelsim.ini → 安装目录那份 —— 工作目录里冒出一份就会盖掉这份。"]
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
		usage: (path) => [`QuestaSim 厂商库 / IP 库映射文件:${promptScalar(path)}`, "库名与目录以 [Library] 段为准；使用前应确认当前工作目录没有另一份 modelsim.ini 覆盖它。"]
	},
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
		key: "vivadoMcpPath",
		section: "common",
		sectionLabel: SECTION_LABELS.common,
		group: "Vivado MCP",
		control: "text",
		label: "Vivado MCP 服务器（可选）",
		hint: "AMD 官方的 vivado_mcp_server 可执行文件（从 AMD 官网登录后下载，需自行遵守其 LICENSE）。填了它，本模式的会话多出一组 mcp__vivado__* 工具：常驻 TCL 会话、批处理综合/实现、run 进度轮询、日志解析。留空则该能力不出现，其余一切照旧。",
		blankNote: "留空不使用 Vivado MCP（不影响其它功能）",
		kind: "file",
		required: false,
		skips: []
	},
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
		return [{
			...shared,
			key: capability.toolKey,
			control: "select",
			label: "工具",
			hint: "默认由 AI 从顶部已经就绪的工具中结合当前任务判断；也可以固定首选工具，或明确选择不用。设置不会自动执行任何环节。",
			default: "auto",
			options: [
				{
					value: "auto",
					label: "由 AI 从已就绪工具中判断"
				},
				...capability.tools.map((tool) => ({
					value: tool,
					label: TOOL_CATALOG[tool].label,
					supportNote: TOOL_CATALOG[tool].supportNote
				})),
				{
					value: "none",
					label: "明确不用"
				}
			]
		}, ...capability.templates.map((template) => ({
			...shared,
			key: template.key,
			category: template.category,
			control: "template",
			label: template.label,
			hint: "可从内置模板与已设置的模板库中选择；留空表示使用与当前工具适配的内置默认模板。",
			default: ""
		}))];
	}),
	{
		key: "python",
		group: "旧键",
		control: "hidden",
		label: "Python 选择(旧)",
		hint: "",
		default: "",
		required: false,
		skips: []
	},
	{
		key: "compiler",
		group: "旧键",
		control: "hidden",
		label: "编译工具选择(旧)",
		hint: "",
		default: "",
		required: false,
		skips: []
	},
	{
		key: "compilerPath",
		group: "旧键",
		control: "hidden",
		label: "编译工具共享路径(旧)",
		hint: "",
		default: "",
		required: false,
		skips: []
	},
	{
		key: "simulator",
		group: "旧键",
		control: "hidden",
		label: "仿真工具选择(旧)",
		hint: "",
		default: "",
		required: false,
		skips: []
	},
	{
		key: "simulatorPath",
		group: "旧键",
		control: "hidden",
		label: "仿真工具共享路径(旧)",
		hint: "",
		default: "",
		required: false,
		skips: []
	},
	{
		key: "synthesizer",
		group: "旧键",
		control: "hidden",
		label: "FPGA 工具选择(旧)",
		hint: "",
		default: "",
		required: false,
		skips: []
	},
	{
		key: "synthesizerPath",
		group: "旧键",
		control: "hidden",
		label: "FPGA 工具共享路径(旧)",
		hint: "",
		default: "",
		required: false,
		skips: []
	},
	...BINDINGS.flatMap((binding) => [{
		key: binding.toolKey,
		group: "旧键",
		control: "hidden",
		label: `${binding.label}选择(旧)`,
		hint: "",
		default: "",
		required: false,
		skips: []
	}, {
		key: binding.pathKey,
		group: "旧键",
		control: "hidden",
		label: `${binding.label}路径(旧)`,
		hint: "",
		default: "",
		required: false,
		skips: []
	}]),
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
	{
		key: "settingsMigrationWarnings",
		group: "旧键",
		control: "hidden",
		label: "迁移提醒",
		hint: "",
		default: "",
		required: false,
		skips: []
	},
	{
		key: "settingsModelVersion",
		group: "旧键",
		control: "hidden",
		label: "设置模型版本",
		hint: "",
		default: "",
		required: false,
		skips: []
	}
];
/**
* 路径字段的共性在这里补齐:文本输入框、归在「工具路径」组。
*
* 逐项写容易漏,而漏了的后果是设置页把它们塞进别的分组 —— 统一补默认值更稳。
* (现在每个字段都显式写了 group,这里只兜底,别再依赖它。)
*/
for (const field of FIELDS) {
	if (field.control === void 0) field.control = "text";
	if (field.control !== "hidden" && field.section === void 0) {
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
	python: [
		"moduleSpecScriptTool",
		"moduleVerifScriptTool",
		"projectSpecScriptTool",
		"projectSyssimScriptTool"
	]
};
const LEGACY_CUSTOM = {
	compiler: {
		tool: "custom-compiler",
		pathKey: "customCompilerPath",
		nameKey: "customCompilerName",
		notesKey: "customCompilerNotes"
	},
	simulator: {
		tool: "custom-simulator",
		pathKey: "customSimulatorPath",
		nameKey: "customSimulatorName",
		notesKey: "customSimulatorNotes"
	},
	synthesizer: {
		tool: "custom-fpga",
		pathKey: "customFpgaToolPath",
		nameKey: "customFpgaToolName",
		notesKey: "customFpgaToolNotes"
	}
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
const TEMPLATE_CATEGORY_BY_KEY = Object.fromEntries(CAPABILITIES.flatMap((capability) => capability.templates.map((template) => [template.key, template.category])));
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
		if (canonical !== selected && typeof key === "string") patch[key] = canonical;
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
		if (lower.includes("questasim") || lower.includes("\\questa\\")) return "questa";
		if (lower.includes("modeltech")) return "modelsim";
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
function legacyMigrationPatch(values) {
	const source = values ?? {};
	const templateRepair = legacyBundledTemplateRepair(source);
	if (valueOf(source, "settingsModelVersion") === "3") return templateRepair;
	const effective = {
		...source,
		...templateRepair
	};
	const patch = {
		settingsModelVersion: "3",
		...templateRepair
	};
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
		if (tool === void 0) return;
		if (role === "simulator" && tool === LEGACY_CUSTOM.simulator?.tool && /(^|\\)vsim(?:\.exe)?$/iu.test(sharedPath)) warn("旧仿真器路径只有 vsim.exe、无法判断是 ModelSim 还是 QuestaSim；已放入自定义仿真器，请确认后改选。");
		for (const key of LEGACY_STAGE_TARGETS[role] ?? []) if (current(key) === "" || current(key) === "auto") effective[key] = tool;
		if (tool === "none" || sharedPath === "") return;
		const definition = TOOL_CATALOG[tool];
		if (definition !== void 0) {
			const existing = current(definition.pathKey);
			if (existing === "") remember(definition.pathKey, sharedPath, true);
			else if (comparablePath(existing) !== comparablePath(sharedPath)) warn(`${definition.label} 的旧共享路径与工具设置不同，请手动确认。`);
		}
		const custom = LEGACY_CUSTOM[role];
		if (custom !== void 0 && tool === custom.tool) {
			if (typeof custom.nameKey === "string") remember(custom.nameKey, "旧配置中的其他工具", true);
			if (typeof custom.notesKey === "string") remember(custom.notesKey, `从旧的${role}共享设置迁移；请结合当前工程确认调用方法。`, true);
		}
	};
	normalizeV1Role("compiler", ["verilator", "iverilog"], [["verilator", "verilatorPath"], ["iverilog", "iverilogPath"]]);
	normalizeV1Role("simulator", ["modelsim", "xsim"], [["modelsim", "modelsimPath"], ["xsim", "xsimPath"]]);
	normalizeV1Role("synthesizer", ["vivado", "quartus"], [["vivado", "vivadoPath"], ["quartus", "quartusPath"]]);
	const pythonSelection = current("python");
	if (pythonSelection === "none") for (const key of LEGACY_STAGE_TARGETS.python) effective[key] = "none";
	else if (pythonSelection === "python" || current("pythonPath") !== "") {
		for (const key of LEGACY_STAGE_TARGETS.python) if (current(key) === "" || current(key) === "auto") effective[key] = "python";
	}
	const overridePaths = /* @__PURE__ */ new Map();
	for (const binding of BINDINGS) {
		const path = current(binding.pathKey);
		const selection = current(binding.toolKey);
		if (path === "" || !binding.tools.includes(selection) || TOOL_CATALOG[selection] === void 0) continue;
		const rows = overridePaths.get(selection) ?? [];
		rows.push(path);
		overridePaths.set(selection, rows);
	}
	for (const [toolKey, paths] of overridePaths) {
		const definition = TOOL_CATALOG[toolKey];
		const unique = [...new Map(paths.map((path) => [comparablePath(String(path)), path])).values()];
		const registered = current(definition.pathKey);
		if (registered === "" && unique.length === 1) remember(definition.pathKey, unique[0], true);
		else if (unique.length > 1 || registered !== "" && unique.some((path) => comparablePath(path) !== comparablePath(registered))) warn(`${definition.label} 存在不同的旧阶段路径，请在工具设置中手动确认。`);
	}
	const capabilityByToolKey = Object.fromEntries(CAPABILITIES.map((capability) => [capability.toolKey, capability]));
	for (const [targetKey, sourceKeys] of Object.entries(LEGACY_CAPABILITY_SOURCES)) {
		const existing = original(targetKey);
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
		for (const targetKey of targetKeys) if (original(targetKey) === "") patch[targetKey] = canonicalTemplateSelection(path, TEMPLATE_CATEGORY_BY_KEY[targetKey]);
	}
	let previousWarnings = [];
	try {
		const parsed = JSON.parse(original("settingsMigrationWarnings") || "[]");
		if (Array.isArray(parsed)) previousWarnings = parsed.filter((entry) => typeof entry === "string");
	} catch {
		previousWarnings = ["旧的迁移提醒格式无法读取，请重新确认能力选择。"];
	}
	const combinedWarnings = [.../* @__PURE__ */ new Set([...previousWarnings, ...warnings])];
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
function probeFilesystem(path, kind) {
	const key = `${kind ?? "file"}\u0000${path}`;
	const cached = probeCache.get(key);
	const now = Date.now();
	if (cached !== void 0 && now - cached.at < PROBE_TTL_MS) return cached.ok;
	const ok = probeUncached(path, kind);
	if (probeCache.size >= PROBE_CACHE_LIMIT) {
		const entries = [...probeCache.entries()].sort((left, right) => left[1].at - right[1].at);
		for (const [old] of entries.slice(0, Math.floor(PROBE_CACHE_LIMIT / 2))) probeCache.delete(old);
	}
	probeCache.set(key, {
		ok,
		at: now
	});
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
const PROBE_TTL_MS = 5e3;
/** 探测结果的短 TTL 缓存:`路径 → { ok, at }`。 */
const probeCache = /* @__PURE__ */ new Map();
/** 缓存条目上限,防止长时间运行后无界增长(路径数量本来就很少,这只是兜底)。 */
const PROBE_CACHE_LIMIT = 256;
/**
* 清空探测缓存。设置刚保存、或用户点了"重新检测"时调用,让界面立刻反映改动。
*/
function clearProbeCache() {
	probeCache.clear();
}
/**
* 真去碰磁盘。**不带缓存** —— 只有 {@link probeFilesystem} 在缓存未命中/过期时调它。
* @param path - 路径。
* @param kind - `"file"` 或 `"directory"`。
* @returns 存在且类型相符。
*/
function probeUncached(path, kind) {
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
function listDirectory(dir) {
	const target = String(dir ?? "").trim();
	if (target === "") return {
		path: "",
		parent: void 0,
		entries: (process.platform === "win32" ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`).filter((drive) => existsSync(drive)) : ["/"]).map((drive) => ({
			name: drive,
			path: drive,
			kind: "directory"
		})),
		truncated: false
	};
	if (!isAbsolute(target)) return {
		path: target,
		parent: void 0,
		entries: [],
		truncated: false,
		error: "只接受绝对路径"
	};
	let names;
	try {
		names = readdirSync(target, { withFileTypes: true });
	} catch (error) {
		return {
			path: target,
			parent: parentOf(target),
			entries: [],
			truncated: false,
			error: String(error.code ?? error.message)
		};
	}
	const entries = names.map((entry) => ({
		name: entry.name,
		path: join(target, entry.name),
		kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
	})).filter((entry) => entry.kind !== "other").sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : 1);
	const cap = 500;
	return {
		path: target,
		parent: parentOf(target),
		entries: entries.slice(0, cap),
		truncated: entries.length > cap
	};
}
/**
* 上级目录;已经在根上时返回它自己。
* @param dir - 当前目录。
* @returns 上级目录路径。
*/
function parentOf(dir) {
	const trimmed = dir.replace(/[\\/]+$/u, "");
	if (trimmed === "" || /^[A-Za-z]:$/u.test(trimmed) || /^\\\\[^\\]+\\[^\\]+$/u.test(trimmed)) return dir;
	const parent = dirname(trimmed);
	return parent === dir || parent === "" || parent === "." ? dir : parent;
}
function resolveBinding(values, binding, probe = probeFilesystem) {
	if (binding === void 0) return {
		key: "",
		selection: "",
		state: "invalid",
		present: false,
		reason: "环节绑定不存在"
	};
	const selection = valueOf(values, binding.toolKey) || "auto";
	if (selection === "auto") return {
		...binding,
		selection,
		state: "auto",
		present: true
	};
	if (selection === "none") return {
		...binding,
		selection,
		state: "none",
		present: true,
		unused: true
	};
	if (!binding.tools.includes(selection) || TOOL_CATALOG[selection] === void 0) return {
		...binding,
		selection,
		state: "invalid",
		present: false,
		reason: "工具选择无效"
	};
	const tool = TOOL_CATALOG[selection];
	const override = valueOf(values, binding.pathKey);
	const common = valueOf(values, tool.pathKey);
	const path = override || common;
	const source = override !== "" ? "stage" : common !== "" ? "common" : void 0;
	let present = false;
	if (path !== "") try {
		present = probe(path, tool.kind) === true;
	} catch {
		present = false;
	}
	const customName = tool.nameKey === void 0 ? "" : valueOf(values, tool.nameKey);
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
		notes: tool.notesKey === void 0 ? "" : valueOf(values, tool.notesKey)
	};
}
/** 解析全部环节绑定。数组顺序只用于稳定展示,不表示执行顺序。 */
function resolveBindings(values, probe = probeFilesystem) {
	return BINDINGS.map((binding) => resolveBinding(values, binding, probe));
}
/**
* 解析一张能力卡的工具选择。能力卡只读取顶部工具登记，不存在阶段覆盖路径。
* @param values - 设置值。
* @param capability - {@link CAPABILITIES} 中的一项。
* @param probe - `(path, kind) => boolean`。
* @returns 能力卡的工具解析结果。
*/
function resolveCapability(values, capability, probe = probeFilesystem) {
	if (capability === void 0) return {
		key: "",
		selection: "",
		state: "invalid",
		present: false,
		reason: "能力配置不存在"
	};
	const selection = valueOf(values, capability.toolKey) || "auto";
	if (selection === "auto") return {
		...capability,
		selection,
		state: "auto",
		present: true
	};
	if (selection === "none") return {
		...capability,
		selection,
		state: "none",
		present: true,
		unused: true
	};
	if (!capability.tools.includes(selection) || TOOL_CATALOG[selection] === void 0) return {
		...capability,
		selection,
		state: "invalid",
		present: false,
		reason: "工具选择无效"
	};
	const tool = TOOL_CATALOG[selection];
	const path = valueOf(values, tool.pathKey);
	let present = false;
	if (path !== "") try {
		present = probe(path, tool.kind) === true;
	} catch {
		present = false;
	}
	const customName = tool.nameKey === void 0 ? "" : valueOf(values, tool.nameKey);
	return {
		...capability,
		selection,
		tool: selection,
		toolLabel: customName || tool.label,
		kind: tool.kind,
		path,
		source: path === "" ? void 0 : "registry",
		configured: path !== "",
		present,
		state: present ? "ready" : "missing",
		supportNote: tool.supportNote,
		notes: tool.notesKey === void 0 ? "" : valueOf(values, tool.notesKey)
	};
}
/** 解析七张能力卡；数组顺序只用于展示，不代表执行顺序。 */
function resolveCapabilities(values, probe = probeFilesystem) {
	return CAPABILITIES.map((capability) => resolveCapability(values, capability, probe));
}
function resolveCapabilityTemplates(values, capability, tool = "auto", probe = probeFilesystem) {
	const libraryRoot = valueOf(values, "templateLibraryPath");
	return (capability?.templates ?? []).map((template) => {
		const { label: templateLabel, ...state } = resolveTemplateSelection({
			selection: valueOf(values, template.key),
			category: template.category,
			tool,
			libraryRoot,
			probe
		});
		return {
			...template,
			...state,
			templateLabel
		};
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
function inspectTools(values, probe) {
	return FIELDS.map((field) => {
		const raw = valueOf(values, field.key);
		if (field.control === "select") {
			const chosen = raw === "" ? String(field.default ?? "") : raw;
			const valid = (field.options ?? []).some((option) => option.value === chosen);
			return {
				...field,
				path: chosen,
				configured: chosen !== "",
				present: valid
			};
		}
		const configured = raw !== "";
		const binding = field.bindingKey === void 0 ? void 0 : BINDING_BY_KEY[field.bindingKey];
		const selection = binding === void 0 ? "" : valueOf(values, binding.toolKey) || "auto";
		const selectedTool = TOOL_CATALOG[selection];
		const kind = selectedTool?.kind ?? field.kind;
		const inactive = binding !== void 0 && (selection === "auto" || selection === "none" || selectedTool === void 0);
		const unused = selection === "none";
		if (kind === void 0) return {
			...field,
			path: raw,
			configured,
			present: true,
			inactive,
			unused
		};
		let present = false;
		if (inactive || binding !== void 0 && !configured) present = true;
		else if (configured) try {
			present = probe(raw, kind) === true;
		} catch {
			present = false;
		}
		return {
			...field,
			kind,
			path: raw,
			configured,
			present,
			inactive,
			unused
		};
	});
}
/**
* 兼容旧调用方的字段级缺失判定。新模型没有全局必填路径；实际环节状态由 resolveBinding 判定。
* @param tool - {@link inspectTools} 的一项。
* @returns 该进缺失清单时为 true。
*/
function isMissing(tool) {
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
function statusOf(values, probe = probeFilesystem) {
	const tools = inspectTools(values, probe).filter((tool) => tool.control !== "hidden").map((tool) => {
		const { usage: _usage, ...safe } = tool;
		return {
			...safe,
			detectable: DETECT_TARGETS.some((target) => target.field === tool.key),
			install: tool.present === true ? void 0 : INSTALL_HINTS[tool.tool]
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
			label: definition.nameKey === void 0 ? definition.label : valueOf(values, definition.nameKey) || definition.label,
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
			{
				value: "auto",
				label: "由 AI 从已就绪工具中判断",
				ready: true,
				disabled: false
			},
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
			{
				value: "none",
				label: "明确不用",
				ready: true,
				disabled: false
			}
		],
		templates: resolveCapabilityTemplates(values, capability, capability.selection, probe)
	}));
	const missing = capabilities.filter((capability) => capability.state === "missing" || capability.state === "invalid").map((capability) => capability.key);
	let migrationWarnings = [];
	try {
		const parsed = JSON.parse(valueOf(values, "settingsMigrationWarnings") || "[]");
		if (Array.isArray(parsed)) migrationWarnings = parsed.filter((entry) => typeof entry === "string");
	} catch {
		migrationWarnings = ["旧设置迁移提醒无法读取，请重新确认能力选择。"];
	}
	let templateLibraryPresent = templateLibraryPath === "";
	if (templateLibraryPath !== "") try {
		templateLibraryPresent = probe(templateLibraryPath, "directory") === true;
	} catch {
		templateLibraryPresent = false;
	}
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
const UNREADABLE = "FPGA 工具链:读不到「设置 → FPGA 开发模式」里的路径(插件宿主半侧没挂上?)。本会话里工具位置只能自己确认,不要假设它们存在。";
/**
* 运行时路径(解释器)的诚实标注:这条路径只喂给会话提示,**不保证宿主终端真的用它**。
*
* 插件能核对的是"这个文件在不在、版本是几";把路径交给宿主终端是**宿主**的事,本插件没有
* 强制绑定它的手段。这种话不能说成"已就绪" —— 用户会以为已经强制生效,发现没有时就不再信任提示。
* (终端那条同理,而且比这更彻底:终端用哪个 pwsh 完全由宿主决定,这里**连路径都不问** —— 见 FIELDS 顶上的注。)
*/
const RUNTIME_NOTE = "注意:上面这条运行时路径是**给本会话提示**用的 —— 宿主终端是否真的使用它,不由本插件保证(实际版本要在设置里点「检测本机工具」看,不确定就问用户,不要按某个版本假设)。";
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
function verilatorRootHint(path, probe = probeFilesystem) {
	if (String(process.env.VERILATOR_ROOT ?? "").trim() !== "") return [];
	if (!/^verilator_bin(\.exe)?$/iu.test(basename(String(path)))) return [];
	const root = join(dirname(dirname(String(path))), "share", "verilator");
	if (!exists(probe, join(root, "include", "verilated_std_waiver.vlt"))) return [];
	return [
		"  本机 Verilator 是 MSYS2 布局:必须带 VERILATOR_ROOT,在**同一条命令**里先设再跑 ——",
		`    $env:VERILATOR_ROOT='${promptScalar(root.split(sep).join("/"))}'; & ${usagePath(path)} --lint-only -Wall --top-module <顶层> <文件...>`,
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
function describeEnv(values, probe) {
	if (values === void 0 || values === null) return UNREADABLE;
	const checkPath = probe ?? probeFilesystem;
	const tools = inspectTools(values, checkPath);
	const lines = ["这是能力配置，不是执行顺序，可以按任务反复切换。以下内容来自「设置 → FPGA 开发模式」，它是工具路径与环节偏好的权威来源；不要用 where/PATH 猜，也不要把这些偏好拼成自动流水线。"];
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
		const name = definition.nameKey === void 0 ? definition.label : valueOf(values, definition.nameKey) || definition.label;
		const notes = definition.notesKey === void 0 ? "" : valueOf(values, definition.notesKey);
		const row = [`- ${name} (${toolKey}):${promptScalar(path)}`];
		try {
			if (typeof definition.usage === "function") row.push(...definition.usage(path).map((line) => `  ${line}`));
		} catch {}
		if (definition.supportNote !== void 0) row.push(`  支持范围:${definition.supportNote}`);
		row.push(...verilatorRootHint(path, checkPath));
		if (definition.notesKey !== void 0) row.push(notes === "" ? "  未提供固定调用说明；使用前须结合当前工程和工具帮助确认。" : `  用户说明:${promptScalar(notes)}`);
		available.push(...row);
	}
	lines.push(available.length === 0 ? [
		"工具设置:当前没有核验到可用路径。这不妨碍分析、设计和代码修改;要跑编译/仿真/综合时再装。",
		"**起步建议(按需取用,不必全装)**:",
		...MINIMAL_SETUP.map((line) => `· ${line}`),
		"装完在「设置 → FPGA 开发模式 → 工具设置」里逐项登记路径,点「检测」可以自动找。"
	].join("\n") : ["工具设置中已登记且路径可用的工具:", ...available].join("\n"));
	if (available.some((line) => line.includes("(python):"))) lines.push(RUNTIME_NOTE);
	const missing = MISSING_TOOL_HINTS.filter((entry) => {
		const definition = TOOL_CATALOG[entry.tool];
		if (definition === void 0) return false;
		const path = valueOf(values, definition.pathKey);
		if (path === "") return true;
		try {
			return checkPath(path, definition.kind) !== true;
		} catch {
			return true;
		}
	});
	if (available.length > 0 && missing.length > 0) lines.push(["还缺这些工具(按需补,不必全装):", ...missing.flatMap((entry) => {
		const guidance = installGuidance(entry.tool);
		return [`- ${entry.why}`, ...guidance];
	})].join("\n"));
	for (const [fieldKey, product] of [["modelsimIniPath", "ModelSim"], ["questaIniPath", "QuestaSim"]]) {
		const iniPath = valueOf(values, fieldKey);
		if (iniPath !== "" && exists(checkPath, iniPath)) lines.push(`${product} 库映射文件:${promptScalar(iniPath)}（厂商库解析以其中 [Library] 段为准）。`);
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
	const seenTemplatePaths = /* @__PURE__ */ new Map();
	for (const sectionKey of ["module", "project"]) {
		const sectionLines = [`${SETTINGS_SECTIONS.find((entry) => entry.key === sectionKey).label}能力偏好（可以按任务反复切换，不表示先后）:`];
		for (const capability of resolved.filter((entry) => entry.section === sectionKey)) {
			const head = `- ${capability.label}`;
			if (capability.state === "auto") sectionLines.push(`${head}:由 AI 从已登记且路径可用的工具中结合当前任务判断；不改写设置。`);
			else if (capability.state === "none") sectionLines.push(`${head}:明确不用。`);
			else if (capability.state === "invalid") sectionLines.push(`${head}:选择无效，当前不可执行；其他能力照常工作。`);
			else if (capability.state === "ready") {
				sectionLines.push(`${head}:首选 ${capability.toolLabel} —— ${promptScalar(capability.path)}（来源:工具设置）。`);
				if (capability.supportNote) sectionLines.push(`  支持范围:${capability.supportNote}`);
				if (capability.notes) sectionLines.push(`  用户说明:${promptScalar(capability.notes)}`);
				else if (capability.tool?.startsWith("custom-")) sectionLines.push("  未提供固定调用说明；使用前须结合当前工程和工具帮助确认。");
			} else {
				const reason = capability.configured ? `工具设置中的路径不可用(${promptScalar(capability.path)})：不存在或类型不符` : "工具设置中尚未登记路径";
				sectionLines.push(`${head}:首选 ${capability.toolLabel}，但${reason}；只影响这项能力。`);
				if (capability.supportNote) sectionLines.push(`  支持范围:${capability.supportNote}`);
			}
			for (const template of resolveCapabilityTemplates(values, capability, capability.selection, checkPath)) {
				const source = template.source === "builtin" ? "内置" : template.source === "library" ? "模板库" : template.source === "legacy" ? "旧版路径" : "";
				if (template.present && template.path !== "") {
					const firstSeen = seenTemplatePaths.get(template.path);
					if (firstSeen !== void 0) sectionLines.push(`  模板·${template.label}:同上(与${firstSeen})`);
					else {
						seenTemplatePaths.set(template.path, `${capability.label}的「${template.label}」`);
						sectionLines.push(`  模板·${template.label}:${promptScalar(template.path)}${source === "" ? "" : `（${source}）`}`);
					}
				} else if (template.state === "unused") sectionLines.push(`  模板·${template.label}:工具已明确不用。`);
				else {
					const details = [...new Set([template.summary, template.warning].filter((entry) => typeof entry === "string" && entry !== ""))];
					sectionLines.push(`  模板·${template.label}:${details.join("；") || "当前不可用"}`);
				}
			}
		}
		lines.push(sectionLines.join("\n"));
	}
	const templateLibraryPath = valueOf(values, "templateLibraryPath");
	if (templateLibraryPath === "") lines.push("模板库:未设置用户模板库；能力卡只使用适配当前工具的内置默认模板。这里没有触发目录扫描。");
	else {
		let libraryPresent = false;
		try {
			libraryPresent = checkPath(templateLibraryPath, "directory") === true;
		} catch {
			libraryPresent = false;
		}
		lines.push(libraryPresent ? `模板库:${promptScalar(templateLibraryPath)}（只记录来源；展开设置里的能力卡时才扫描目录）。` : `模板库:${promptScalar(templateLibraryPath)}（路径当前不可用；已保存的模板选择不会被替换）。`);
	}
	lines.push("显式首选应优先采用；若当前工程事实不允许，要说明原因再调整。工具未实际运行就不能把对应验证写成通过。配置本身不会生成命令队列或自动调用工具。");
	lines.push(choiceLines(tools));
	lines.push("产物落哪里:**每个阶段的产物放各自阶段的目录里** —— 编译库落 `verif/work`(可再生的,删了下次自动重建)、日志与波形落 `verif/`、综合与实现的工程及 runs 落 `synth/`、结论与报告留在各环节目录(报告要能指着它们)。这些可再生物**别外置到工作区外的全局目录**:沙箱下那里可能要提权才写得进去,就地生成最省事。");
	lines.push([
		"本模式自带的命令(Node 直接跑,不用装东西)。**命令名带级别前缀(module- / project-),按环节分;不要跨级别或跨环节混用**:",
		"· `module-` = 模块级(在 `tools/module/` 下);`project-` = 工程级(在 `tools/project/` 下);",
		"  两级共用的(如 setup-scaffold)不加级别前缀,在 `tools/` 顶层。",
		...TOOLS.map((tool) => {
			return `- [${tool.level === "shared" ? "两级共用" : tool.level === "module" ? "模块级" : "工程级"} / ${tool.stage}] ${tool.what}:node "${toolPath(tool)}" <根目录>`;
		})
	].join("\n"));
	lines.push("命令用现有 shell 工具跑(走沙箱、输出可回看);综合与大回归放后台任务再读日志,不要前台死等。");
	const mcpPath = valueOf(values, "vivadoMcpPath");
	if (mcpPath !== "") {
		let mcpPresent = false;
		try {
			mcpPresent = checkPath(mcpPath, "file") === true;
		} catch {
			mcpPresent = false;
		}
		lines.push(mcpPresent ? [
			"已启用 **Vivado MCP**(AMD 官方,由用户自行下载):本会话有一组 `mcp__vivado__*` 工具,它管的是一个**常驻 Vivado 会话**,与你用 shell 跑 `vivado -mode batch` 是两条路。",
			"怎么用:",
			"- 起会话用 `vivado_start`(必须给 `session_type` 与已存在的 `working_dir`);之后所有 Tcl 走 `vivado_execute`。",
			"- **综合/实现这类长命令**:先 `launch_runs synth_1`,再单独一次 `wait_on_run synth_1`;命令超过约 5 分钟会返回 `status: running`,此时用 `vivado_status` 隔 30–60 秒查一次,不要循环狂查。",
			"- 批处理:建工程、`add_files`、`set_property`、约束可以合成一条;`launch_runs` / `wait_on_run` / `synth_design` / `open_project` / `source` 必须单独调用。",
			"- 出错先看它返回的 `recovery_hint` 与 `log_file`;要用日志里的具体告警,`vivado_log_messages` 比肉眼翻文件可靠。",
			"- 一个会话同一时刻只跑一条命令,不要对同一 session 并行调用 `vivado_execute`。",
			"**结论仍然由你判**:MCP 只是把命令送进 Vivado、把输出送回来,它不判断设计对不对;证据落盘与 PASS/FAIL 的判据照旧走本模式的技能。"
		].join("\n") : `Vivado MCP:${promptScalar(mcpPath)}(路径当前不可用;这组工具不会出现,其余功能照常)。`);
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
function resolveTemplates(values, probe) {
	return TEMPLATE_FIELDS.map(({ key, kind, label, file, announce = "always" }) => {
		const custom = String(values?.[key] ?? "").trim();
		const bundled = join(BUNDLED_TEMPLATE_DIR, file);
		if (custom === "") return {
			kind,
			label,
			file,
			path: bundled,
			source: "bundled",
			present: exists(probe, bundled),
			announce
		};
		if (exists(probe, custom)) return {
			kind,
			label,
			file,
			path: custom,
			source: "user",
			present: true,
			announce
		};
		return {
			kind,
			label,
			file,
			path: bundled,
			source: "bundled",
			present: exists(probe, bundled),
			missing: custom,
			announce
		};
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
/** 版本查询的超时:一个只会打印版本号的进程,几秒还不回就是有问题,不能把检测挂住。 */
const VERSION_PROBE_TIMEOUT_MS = 5e3;
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
function promptScalar(value) {
	return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, (ch) => {
		const code = ch.codePointAt(0);
		if (ch === "\n") return "\\n";
		if (ch === "\r") return "\\r";
		if (ch === "	") return "\\t";
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
function promptArg(value) {
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
const usagePath = (path) => {
	return promptArg(String(path ?? "").replace(/\\+(?![nrtx0-9])/gu, "/"));
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
function queryVersion(path, command) {
	try {
		const result = spawnSync(path, command.args, {
			encoding: "utf8",
			timeout: VERSION_PROBE_TIMEOUT_MS,
			windowsHide: true
		});
		if (result.error !== void 0 && result.error !== null) return { error: String(result.error.code ?? result.error.message) };
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
		if (result.status !== 0 || (result.signal ?? null) !== null) return {
			error: `版本查询命令没有正常结束(${result.status === null ? `被信号 ${String(result.signal ?? "?")} 终止` : `退出码 ${String(result.status)}`})`,
			output: output.slice(0, 200)
		};
		const version = command.pattern.exec(output)?.[1];
		if (version === void 0) return {
			error: "没能从输出里认出版本号",
			output: output.slice(0, 200)
		};
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
const DETECT_TARGETS = [
	{
		field: "modelsimPath",
		tool: "modelsim",
		label: "ModelSim",
		exe: "vsim.exe",
		globs: [{
			root: "C:\\",
			pattern: "modeltech*\\win64\\vsim.exe"
		}]
	},
	{
		field: "questaPath",
		tool: "questa",
		label: "QuestaSim",
		exe: "vsim.exe",
		globs: [
			{
				root: "C:\\",
				pattern: "questasim*\\win64\\vsim.exe"
			},
			{
				root: "C:\\",
				pattern: "Siemens\\questa*\\win64\\vsim.exe"
			},
			{
				root: "C:\\",
				pattern: "MentorGraphics\\questa*\\win64\\vsim.exe"
			}
		]
	},
	{
		field: "xsimPath",
		tool: "xsim",
		label: "Vivado XSim",
		exe: "xvlog.bat",
		kind: "directory",
		globs: [{
			root: "C:\\",
			pattern: "AMDDesignTools\\*\\Vivado\\bin\\xvlog.bat"
		}, {
			root: "C:\\",
			pattern: "Xilinx\\Vivado\\*\\bin\\xvlog.bat"
		}]
	},
	{
		field: "vivadoPath",
		tool: "vivado",
		label: "Vivado",
		exe: "vivado.bat",
		globs: [{
			root: "C:\\",
			pattern: "AMDDesignTools\\*\\Vivado\\bin\\vivado.bat"
		}, {
			root: "C:\\",
			pattern: "Xilinx\\Vivado\\*\\bin\\vivado.bat"
		}]
	},
	{
		field: "quartusPath",
		tool: "quartus",
		label: "Quartus Prime",
		exe: "quartus_sh.exe",
		globs: [
			{
				root: "C:\\",
				pattern: "intelFPGA*\\*\\quartus\\bin64\\quartus_sh.exe"
			},
			{
				root: "C:\\",
				pattern: "altera*\\*\\quartus\\bin64\\quartus_sh.exe"
			},
			{
				root: "C:\\",
				pattern: "intelFPGA*\\*\\quartus\\bin\\quartus_sh.exe",
				fallback: true
			},
			{
				root: "C:\\",
				pattern: "altera*\\*\\quartus\\bin\\quartus_sh.exe",
				fallback: true
			}
		]
	},
	{
		field: "verilatorPath",
		tool: "verilator",
		label: "Verilator",
		exe: "verilator_bin.exe",
		globs: [{
			root: "C:\\",
			pattern: "msys*\\mingw64\\bin\\verilator_bin.exe"
		}]
	},
	{
		field: "iverilogPath",
		tool: "iverilog",
		label: "Icarus Verilog",
		exe: "iverilog.exe",
		globs: [{
			root: "C:\\",
			pattern: "iverilog\\bin\\iverilog.exe"
		}]
	},
	{
		field: "pythonPath",
		tool: "python",
		label: "Python 3",
		exe: "python.exe",
		version: {
			args: ["--version"],
			pattern: /^\s*Python (\d+\.\d+\.\d+)\s*$/mu
		},
		globs: [{
			root: "%ProgramFiles%",
			pattern: "Python3*\\python.exe"
		}, {
			root: "%LocalAppData%",
			pattern: "Programs\\Python\\Python3*\\python.exe"
		}]
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
function readdirNames(dir) {
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
		for (const dir of current) if (segment.includes("*")) {
			for (const name of list(dir)) if (matchesPattern(name, segment)) next.push(join(dir, name));
		} else next.push(join(dir, segment));
		current = next;
	}
	return current;
}
/** PATH 里的目录(去掉引号与空项)。 */
function pathDirs(env) {
	return String(env?.PATH ?? "").split(";").map((entry) => entry.trim().replace(/^"|"$/gu, "")).filter((entry) => entry !== "");
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
function detectTools(probe = probeFilesystem, list = readdirNames, env = process.env, readVersion = queryVersion, fields = void 0) {
	const hits = [];
	const seen = /* @__PURE__ */ new Set();
	const exists = (path, kind = "file") => {
		try {
			return probe(path, kind) === true;
		} catch {
			return false;
		}
	};
	/** 展开一组模式,留下真实存在的(同一个路径只留一次)。 */
	const expand = (globs) => globs.flatMap((glob) => expandPattern(expandEnv(glob.root, env), expandEnv(glob.pattern, env), list)).filter((path, index, all) => exists(path) && all.indexOf(path) === index);
	/**
	* 版本信息:只有带 `version` 的检测项会走到这里 —— 也就是**只有它会起进程**。
	* 认不出 / 起不来 / **命令失败**时如实记 error 与原始输出(见 queryVersion)。
	* 只报实测到的东西:不做"版本够不够"的判定(没有字段声明硬要求了 —— 带 `expected` 的
	* 那套判定随终端字段一起删了,2026-09-21;用户对 Python 3 没有统一版本约束)。
	*/
	const versionInfo = (target, path) => {
		if (target.version === void 0) return {};
		let queried;
		try {
			queried = readVersion(path, target.version) ?? {};
		} catch (error) {
			queried = { error: String(error?.message ?? error) };
		}
		const version = typeof queried.version === "string" ? queried.version : void 0;
		const note = version === void 0 ? `${target.label} 路径可用,但版本查不出来(${queried.error ?? "没有输出"})` : `版本 ${version}`;
		return {
			version,
			versionError: queried.error,
			versionNote: note
		};
	};
	const wanted = Array.isArray(fields) ? new Set(fields.map(String)) : void 0;
	const targets = wanted === void 0 ? DETECT_TARGETS : DETECT_TARGETS.filter((target) => wanted.has(target.field));
	for (const target of targets) {
		const primary = expand(target.globs.filter((glob) => glob.fallback !== true));
		const present = (primary.length > 0 ? primary : expand(target.globs.filter((glob) => glob.fallback === true))).map((path) => ({
			path,
			source: "known"
		}));
		if (present.length === 0) for (const dir of pathDirs(env)) {
			const path = join(dir, target.exe);
			if (exists(path)) present.push({
				path,
				source: "path"
			});
		}
		for (const hit of present) {
			const path = target.kind === "directory" ? dirname(hit.path) : hit.path;
			const dedupe = `${target.field}|${target.tool}|${path.toLowerCase()}`;
			if (seen.has(dedupe)) continue;
			seen.add(dedupe);
			hits.push({
				field: target.field,
				tool: target.tool,
				label: target.label,
				path,
				source: hit.source,
				...versionInfo(target, hit.path)
			});
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
const INSTALL_HINTS = {
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
		note: "填 mingw64/bin/verilator_bin.exe(不是无扩展名的 Perl 包装脚本);若报找不到 verilated_std_waiver.vlt,再设环境变量 VERILATOR_ROOT 指向 share/verilator。",
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
const MINIMAL_SETUP = [
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
function installGuidance(toolKey) {
	const hint = INSTALL_HINTS[toolKey];
	if (hint === void 0) return [];
	const cost = hint.free === true ? "免费" : "商业授权";
	const account = hint.account === true ? ",下载需注册账号" : "";
	return [
		`    安装:${hint.where}(${cost}${account})`,
		`    填什么:${hint.note}`,
		`    官网:${hint.url}`
	];
}
//#endregion
export { BINDINGS, CAPABILITIES, CAPABILITY_BY_KEY, DETECT_TARGETS, FIELDS, INSTALL_HINTS, LEVEL_DIRS, MINIMAL_SETUP, NS, SETTINGS_MODEL_VERSION, SETTINGS_SECTIONS, STAGES, STAGE_BY_KEY, TEMPLATE_FIELDS, TOOLS, TOOL_CATALOG, TOOL_GROUPS, VERSION_PROBE_TIMEOUT_MS, clearProbeCache, describeEnv, detectTools, inspectTools, installGuidance, isMissing, legacyMigrationPatch, listDirectory, probeFilesystem, promptArg, promptScalar, queryVersion, readdirNames, resolveBinding, resolveBindings, resolveCapabilities, resolveCapability, resolveCapabilityTemplates, resolveTemplates, statusOf, toolLevelPrefix, toolPath, verilatorRootHint };
