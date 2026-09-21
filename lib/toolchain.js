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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
 * **没有"看波形"这类交互入口**:源码集合、编译顺序、顶层与仿真器流程都要结合当前工程判断,
 * 脚本拍不了板。要看波形用**已经确认过的 `verif/run.do`** 起 GUI,见 `fpga-module-verif` 第三步。
 */
export const TOOLS = [
  {
    file: "setup-scaffold.mjs",
    level: "shared",
    stage: "规格环节",
    what: "一次建好模块 / 工程的骨架(模块直接用;工程加 --kind project --modules A,B;幂等,不覆盖已有锚点)"
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
    what: "按模板起一个测试平台(默认落 verif/tb_<模块名下划线形式>.sv,如 UartRx → tb_uart_rx.sv)"
  },
  {
    file: "module-synth-new.mjs",
    level: "module",
    stage: "综合环节",
    what: "按模板起一个约束文件(默认落 synth/<模块名>.xdc)"
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
 * `announce: "custom"` 的三份是**环节脚本**(仿真 / 综合 / 比对):自带那份由命令的默认值
 * 起出来(`--kind run-do` / `--kind synth-script` / `--kind comp`,起法写在环节技能里),提示里
 * 不必播报一条 agent 不会去读的路径;只有用户配了自己那份时才必须出现 —— 他要把它传给 `--template`。
 * 另外三份是**写法规范的载体**:agent 写 RTL / 测试平台 / 约束之前得先读,所以任何时候都播报。
 */
export const TEMPLATE_FIELDS = [
  { key: "rtlTemplatePath", kind: "rtl", label: "RTL 模板", file: "rtl.sv" },
  { key: "tbTemplatePath", kind: "tb", label: "测试平台模板", file: "tb.sv" },
  { key: "xdcTemplatePath", kind: "xdc", label: "约束模板", file: "constraints.xdc" },
  { key: "runDoTemplatePath", kind: "run-do", label: "run.do 模板", file: "run.do", announce: "custom" },
  { key: "synthScriptTemplatePath", kind: "synth-script", label: "综合脚本模板", file: "run_synth.tcl", announce: "custom" },
  { key: "compScriptTemplatePath", kind: "comp", label: "比对脚本模板", file: "comp.py", announce: "custom" }
];

/** 语言与标准:合成一个下拉,避免"语言和标准对不上"的组合(vhdl-2008 配 1800-2017 这种)。 */
const LANG_STD = [
  { value: "sv-2017", label: "SystemVerilog (IEEE 1800-2017)" },
  { value: "sv-2012", label: "SystemVerilog (IEEE 1800-2012)" },
  { value: "v2001", label: "Verilog-2001" },
  { value: "vhdl-2008", label: "VHDL-2008" }
];

/**
 * 三类工具各有哪些选择。每组后面紧跟它自己的路径字段。
 *
 * `usage` 挂在**选项**上而不是路径字段上:调用姿势取决于选了哪个工具(Verilator 是 --lint-only,
 * XSim 是 xvlog/xelab/xsim),挂在路径上就写不出这个区别。
 *
 * 每组都有两个"非具体工具"的选项,含义不同、不要混:
 * - `other`:本机有、但不在这份清单里 → 路径照样要填(检测帮不上忙,只能手填);
 * - `none`:**用户明确说"这台没有 / 不用"** → 路径空着也不算未就绪,检测**不再去探它**
 *   (省得每次打开设置都提醒一遍"没检测到路径")。
 */
const COMPILERS = [
  {
    value: "verilator",
    label: "Verilator (verilator_bin.exe)",
    needs: "compilerPath",
    usage: (path) => [
      `快速 lint:"${path}" --lint-only -Wall --top-module <顶层模块> <文件...>`,
      "用 verilator_bin.exe 本体(它旁边的 dll 会被同目录解析);那个无扩展名的 verilator 是 perl 包装脚本,需要 PATH 里有 perl。"
    ]
  },
  {
    value: "iverilog",
    label: "Icarus Verilog (iverilog)",
    needs: "compilerPath",
    usage: (path) => [`编译检查:"${path}" -g2012 -o <临时输出文件> <文件...>`, "它同时也能跑仿真(vvp),但对 SystemVerilog 的支持有限。"]
  },
  { value: "other", label: "其他(自己填路径)", needs: "compilerPath", usage: () => [] },
  // 「不用」= 用户明确说了这台没有这个工具:路径空着也不算未就绪,检测也不再去探它
  { value: "none", label: "不用(本机没有这个工具)", needs: "compilerPath", usage: () => [] }
];

const SIMULATORS = [
  {
    value: "modelsim",
    label: "ModelSim / Questa (vsim)",
    needs: "simulatorPath",
    usage: (path) => [
      `非交互仿真:"${path}" -c -do "do <脚本.do>; quit -f"`,
      "-c 必须加(命令行模式),否则弹图形界面;波形用 $dumpfile/$dumpvars 或 vcd 落到 `verif/`(本环节目录,可再生的)。"
    ]
  },
  {
    value: "xsim",
    label: "Vivado XSim (xvlog / xelab / xsim)",
    needs: "simulatorPath",
    // XSim 要的是 Vivado 的 bin **目录**(xvlog/xelab/xsim 三个命令都在里面),不是一个可执行文件。
    // 路径类型与调用姿势一样挂在选项上 —— 否则设置页会给它弹文件选择框,填进来的也是错的。
    kind: "directory",
    usage: (path) => [
      `三步走:"${pad(path)}xvlog" -sv <源码...> → "${pad(path)}xelab" -debug typical <顶层> -s tb_sim → "${pad(path)}xsim" tb_sim -runall`,
      "路径填 Vivado 的 bin 目录(那三个命令都在里面)。"
    ]
  },
  { value: "other", label: "其他(自己填路径)", needs: "simulatorPath", usage: () => [] },
  { value: "none", label: "不用(本机没有这个工具)", needs: "simulatorPath", usage: () => [] }
];

const SYNTHESIZERS = [
  {
    value: "vivado",
    label: "Vivado (vivado.bat)",
    needs: "synthesizerPath",
    usage: (path) => [
      `非交互批处理:"${path}" -mode batch -source <脚本.tcl> -log <日志路径> -journal <记录路径>`,
      "不加 -mode batch 会拉起图形界面等人操作;Tcl 脚本里用 open_project/open_run 驱动流程。"
    ]
  },
  {
    // 下拉里摆着 Quartus,不等于本插件有一条 Quartus 流程 —— 自带的技能与模板只有 Vivado 那套
    // (工程结构 / 约束 / 实现 / 下载都没有 Quartus 分支)。所以标注就写在**选项**上(工具之间的
    // 差别一律挂选项,见上面 XSim 的 kind):它只是"能填路径、能被检测到",用哪个工具看设置。
    // 不写清这层,用户和 agent 都会以为选了它就有一条 Quartus 流程(用户口径:肯定标注)。
    value: "quartus",
    label: "Quartus Prime (quartus_sh)—— 只提供路径与检测(工程、约束、实现、下载那套分支没有);命令按设置里选中的工具走,没选它就不会用到它",
    needs: "synthesizerPath",
    usage: (path) => [`非交互批处理:"${path}" -t <脚本.tcl>`, "综合用 quartus_map,实现与烧录用 quartus_fit / quartus_pgm。"]
  },
  { value: "other", label: "其他(自己填路径)", needs: "synthesizerPath", usage: () => [] },
  { value: "none", label: "不用(本机没有这个工具)", needs: "synthesizerPath", usage: () => [] }
];

/** 把目录形式的路径补成可拼接的前缀(XSim 的路径是一个目录)。 */
function pad(path) {
  return path.endsWith("\\") || path.endsWith("/") ? path : `${path}\\`;
}

/**
 * 字段:键、显示名、说明、类型、是否**必须就绪**、缺失时会跳过哪些开发步骤、以及给 agent
 * 看的调用姿势。
 *
 * 默认值一律为空 —— 路径必须由用户填。探测 PATH 得到的值不可信(实测那台机器上
 * verilator 已经不在 PATH 上,旧探测值指向一个已删除的目录),猜错比留空更糟:
 * agent 会照着一个不存在的路径去调工具。
 *
 * 三个路径字段是必填(编译器 / 仿真器 / 综合器,用户要求"路径都要"),外加**可选**的库映射文件与六份模板文件(RTL / 测试平台 / 约束 + 仿真 / 综合 / 比对三个环节脚本)。`required` 的语义
 * 是"没就绪会影响开发流程":设置页据此决定要不要报"会跳过什么",宿主据此算缺失清单 ——
 * 可选字段(模板与库映射文件)缺了不挡路,因为缺哪个模板文件就用插件自带的那份。
 *
 * `skips` 是"没就绪会跳过哪些步骤" —— 用户要的提示就靠它,而不是只丢一句"未配置"。
 *
 * `usage` 只喂会话提示(设置页不用它,statusOf 不会把它发给客户端)。写在这里而不是
 * 提示文案里,是因为它和字段是同一件事的两面:路径变了,配方里的路径也得跟着变。
 * 只写最容易出错的**调用方式**,不写完整流程 —— 领域知识 agent 自己有,踩过的坑
 * (弹图形界面、找不到 vivado.exe)才需要写下来。
 */
export const FIELDS = [
  // 分组按重要性排(用户口径):先把"缺了它什么都跑不了"的运行时放前面,再到三类工具。
  //
  // ── 终端工具:会话终端与 .ps1 脚本 ─────────────────────────────────────────
  {
    key: "pwsh",
    group: "终端工具",
    control: "select",
    label: "用哪个终端",
    hint: "会话终端与 .ps1 脚本用哪个;本机没有就选「不用」,检测也就不再探它",
    default: "pwsh",
    // 和三类工具一样:「不用」= 用户明确说本机没有 → 不要求填、检测不再提醒
    options: [
      { value: "pwsh", label: "PowerShell 7 (pwsh.exe)", needs: "pwshPath" },
      { value: "none", label: "不用(本机没有这个工具)", needs: "pwshPath" }
    ],
    required: false,
    skips: []
  },
  {
    key: "pwshPath",
    group: "终端工具",
    control: "text",
    label: "PowerShell 7",
    // 诚实标注(用户口径):这条路径只喂给会话提示;**宿主终端是不是真的用它,本插件管不到** ——
    // 不能写成"已就绪"暗示已经强制绑定。版本是执行约束(统一 7.6.6),检测会把实际版本报出来。
    hint:
      "pwsh.exe;会话终端与 .ps1 脚本用它(5.1 是另一套,别混)。本模式按 PowerShell 7.6.6 校验,「检测本机工具」会报出实际版本;" +
      "这条路径是给会话提示用的 —— 宿主终端是否真的使用它,不由本插件保证。留空则按 PATH 解析",
    // 留空的后果由宿主说清(客户端不自己编):"留空即用自带"对运行时字段是错话
    blankNote: "留空按 PATH 找",
    kind: "file",
    required: false,
    skips: [],
    usage: (path) => [`终端与脚本用 PowerShell 7(不是 Windows PowerShell 5.1):"${path}" -NoProfile -File <脚本.ps1>`]
  },

  // ── 脚本工具:写参考模型、造测试向量、比对仿真日志 ─────────────────────────
  {
    key: "python",
    group: "脚本工具",
    control: "select",
    label: "用哪个脚本解释器",
    hint: "参考模型、测试向量、日志比对用哪个;本机没有 Python 就选「不用」",
    default: "python",
    options: [
      { value: "python", label: "Python 3 (python.exe)", needs: "pythonPath" },
      { value: "none", label: "不用(本机没有这个工具)", needs: "pythonPath" }
    ],
    required: false,
    skips: []
  },
  {
    key: "pythonPath",
    group: "脚本工具",
    control: "text",
    label: "Python 3",
    // 与 pwsh 同款标注:只如实报版本,不做判定;宿主怎么用它不由本插件保证。
    hint:
      "python.exe;写参考模型、造测试向量、比对仿真日志可以用它(「检测本机工具」只如实报出版本,不做版本判定)。" +
      "这条路径是给会话提示用的 —— 宿主终端是否真的使用它,不由本插件保证。没配也能开发",
    blankNote: "留空按 PATH 找",
    kind: "file",
    required: false,
    skips: [],
    usage: (path) => [`跑脚本:"${path}" <脚本.py>(装包用同目录的 pip;要用 cocotb 之类的库就在这个解释器里装)`]
  },

  // ── 编译工具:RTL 的 lint / 编译检查 ──────────────────────────────────────
  {
    key: "compiler",
    group: "编译工具",
    control: "select",
    label: "用哪个编译器",
    hint: "RTL 的 lint / 编译检查用哪个工具",
    default: "verilator",
    options: COMPILERS,
    required: false,
    skips: []
  },
  {
    key: "compilerPath",
    group: "编译工具",
    control: "text",
    label: "编译器路径",
    hint: "Verilator 填 verilator_bin.exe(MSYS2 装在 C:\\msys64\\mingw64\\bin 下);换了别的工具就填它的可执行文件",
    kind: "file",
    required: true,
    skips: ["快速 lint", "回归编译", "覆盖率统计"]
  },
  {
    key: "rtlLangStd",
    group: "编译工具",
    control: "select",
    label: "RTL 语言与标准",
    // 一个下拉同时定语言与标准:分成两个就会有"VHDL + IEEE 1800"这种对不上的组合。
    hint: "写 RTL 时按这个来(扩展名、语法特性、编译开关都跟它走)",
    default: "sv-2017",
    options: LANG_STD,
    required: false,
    skips: []
  },

  // ── 仿真器:功能仿真 ────────────────────────────────────────────────────────
  {
    key: "simulator",
    group: "仿真工具",
    control: "select",
    label: "用哪个仿真器",
    hint: "功能仿真用哪个工具;下面填它的路径",
    default: "modelsim",
    options: SIMULATORS,
    required: false,
    skips: []
  },
  {
    key: "simulatorPath",
    group: "仿真工具",
    control: "text",
    label: "仿真器路径",
    // 要 vsim.exe 而不是 modelsim.exe:后者是图形界面,会弹窗等人操作,自动化跑不了。
    hint: "ModelSim 填 vsim.exe(不是图形界面的 modelsim.exe);选 Vivado XSim 就填 Vivado 的 bin 目录",
    kind: "file",
    required: true,
    skips: ["RTL 功能仿真", "时序仿真", "波形调试"]
  },
  {
    key: "simLangStd",
    group: "仿真工具",
    control: "select",
    label: "仿真语言与标准",
    hint: "测试平台用什么语言写;和 RTL 不同也可以(例如 RTL 用 VHDL、测试平台用 SystemVerilog)",
    default: "same",
    options: [{ value: "same", label: "与 RTL 相同" }, ...LANG_STD],
    required: false,
    skips: []
  },

  // ── 综合器:综合、实现、bitstream、时序 ────────────────────────────────────
  {
    key: "synthesizer",
    group: "综合工具",
    control: "select",
    label: "用哪个综合器",
    hint: "综合、实现与 bitstream 用哪个工具",
    default: "vivado",
    options: SYNTHESIZERS,
    required: false,
    skips: []
  },
  {
    key: "synthesizerPath",
    group: "综合工具",
    control: "text",
    label: "综合器路径",
    // 明确写文件名:Windows 上 Vivado **没有** vivado.exe,入口就是 bin\vivado.bat
    // (那个无扩展名的 vivado 是 Linux/msys 的 shell 脚本)。只写"可执行文件"太含糊。
    hint: "Vivado 填 vivado.bat(Windows 上没有 vivado.exe);Quartus 填 quartus_sh.exe",
    kind: "file",
    required: true,
    skips: ["综合", "实现与布局布线", "比特流生成", "时序报告"]
  },

  // ── 库映射 ─────────────────────────────────────────────────────────────────
  {
    key: "modelsimIniPath",
    group: "库映射",
    control: "text",
    label: "库映射文件",
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
      `厂商库 / IP 库能不能用,看这份文件的 [Library] 段:${path}`,
      "改映射用 vmap;`vmap` 不带参数会列出**当前生效**的全部映射。注意查找顺序:MODELSIM 环境变量 → 当前目录的 modelsim.ini → 安装目录那份 —— 工作目录里冒出一份就会盖掉这份。"
    ]
  },
  // 缓存目录字段**已删**(用户定案):每个阶段的产物放各自阶段的目录里 —— 编译库
  // `verif/work`、日志与波形 `verif/`、综合产物 `synth/`。外置一个全局缓存目录的代价实测
  // 是"跑仿真要提权"(工作区外写入过不了沙箱),而收益只是"别撑大源码树" —— 那些文件本来
  // 就是可再生的,就地生成 + 工作区规则里忽略掉就够了。
  // ── 模板 ───────────────────────────────────────────────────────────────────
  {
    key: "rtlTemplatePath",
    group: "模板",
    control: "text",
    label: "RTL 模板",
    hint: "留空用插件自带的 rtl.sv;填了就用你这份(文件头、九个小节块、对齐都照它;机械检查器仍按自带那套约定判)",
    blankNote: "留空即用自带",
    kind: "file",
    required: false,
    skips: []
  },
  {
    key: "tbTemplatePath",
    group: "模板",
    control: "text",
    label: "测试平台模板",
    hint: "留空用插件自带的 tb.sv;填了就用你这份(自检与成功标记的写法照它)",
    blankNote: "留空即用自带",
    kind: "file",
    required: false,
    skips: []
  },
  {
    key: "xdcTemplatePath",
    group: "模板",
    control: "text",
    label: "约束模板",
    hint: "留空用插件自带的 constraints.xdc;填了就用你这份",
    blankNote: "留空即用自带",
    kind: "file",
    required: false,
    skips: []
  },
  // 三个**环节脚本**模板。与上面三份同款(可选、留空即用自带、缺了不挡路),只是提示段的播报
  // 规则不同:自带那份由命令默认起出来,只有用户自己那份才需要进提示(见 TEMPLATE_FIELDS)。
  {
    key: "runDoTemplatePath",
    group: "模板",
    control: "text",
    label: "run.do 模板(仿真脚本)",
    hint: "你自己那份 ModelSim 批处理仿真脚本(run -all 与结尾的 gate 都在里面);留空用插件自带的 templates/run.do",
    blankNote: "留空即用自带",
    kind: "file",
    required: false,
    skips: []
  },
  {
    key: "synthScriptTemplatePath",
    group: "模板",
    control: "text",
    label: "综合脚本模板",
    hint: "你自己那份批处理综合脚本(建工程、跑 runs、收报告都在里面);留空用插件自带的 templates/run_synth.tcl",
    blankNote: "留空即用自带",
    kind: "file",
    required: false,
    skips: []
  },
  {
    key: "compScriptTemplatePath",
    group: "模板",
    control: "text",
    label: "比对脚本模板",
    hint: "你自己那份数据比对脚本(先归一化、只比值);留空用插件自带的 templates/comp.py",
    blankNote: "留空即用自带",
    kind: "file",
    required: false,
    skips: []
  },

  // ── 旧键:只为迁移而存在,设置页不显示 ─────────────────────────────────────
  //
  // 三个路径字段改过名(verilatorPath/modelsimPath/vivadoPath → compilerPath/
  // simulatorPath/synthesizerPath),好让"编译器路径"这种说法名副其实。改名不能让用户
  // 已经填好的值消失,所以旧键留在 schema 里(否则 schemastery 会把它们从解析结果里丢掉,
  // 迁移就无从谈起),由 valueOf 做兜底。设置页不渲染它们(control: hidden)。
  { key: "verilatorPath", group: "旧键", control: "hidden", label: "Verilator 路径(旧)", hint: "", kind: "file", required: false, skips: [] },
  { key: "modelsimPath", group: "旧键", control: "hidden", label: "ModelSim 路径(旧)", hint: "", kind: "file", required: false, skips: [] },
  { key: "vivadoPath", group: "旧键", control: "hidden", label: "Vivado 路径(旧)", hint: "", kind: "file", required: false, skips: [] }
];

/**
 * 路径字段的共性在这里补齐:文本输入框、归在「工具路径」组。
 *
 * 逐项写容易漏,而漏了的后果是设置页把它们塞进别的分组 —— 统一补默认值更稳。
 * (现在每个字段都显式写了 group,这里只兜底,别再依赖它。)
 */
for (const field of FIELDS) {
  if (field.control === undefined) field.control = "text";
}

/**
 * 算出"旧键 → 新键"的一次性迁移补丁。
 *
 * 为什么要有它(而不是只在 valueOf 里兜底):兜底只让**宿主**看见旧值 —— 宿主判"已就绪",
 * 而设置页的输入框读的是新键的原始值,于是**框是空的、状态却是绿的**。两处对同一件事给出
 * 两个答案,用户第一眼就会发现(这是实际抓到的 bug)。
 *
 * 所以要把数据真的搬过去:新键为空、旧键有值时,写新键并清空旧键(清空是为了避免以后
 * 清空新字段时旧值又"复活")。
 * @param values - 设置解析后的值。
 * @returns 要写进设置的补丁;没有可迁移的项时为空对象。
 */
export function legacyMigrationPatch(values) {
  const patch = {};
  for (const [next, previous] of Object.entries(LEGACY_KEYS)) {
    const oldValue = String(values?.[previous] ?? "").trim();
    const newValue = String(values?.[next] ?? "").trim();
    if (newValue === "" && oldValue !== "") {
      patch[next] = oldValue;
      patch[previous] = "";
    }
  }
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

/**
 * 旧键 → 新键。三个路径字段改过名,改名不能让用户已经填好的值消失。
 *
 * 代价说明:新字段被**清空**时会退回旧键的值(因为解析后的值看不出"空"和"没设过")。
 * 用户真遇到就手动清一下旧键;比"改个名就把三个路径弄丢"划算。
 */
const LEGACY_KEYS = {
  compilerPath: "verilatorPath",
  simulatorPath: "modelsimPath",
  synthesizerPath: "vivadoPath"
};

/**
 * 拿一项配置的值(带旧键兜底)。
 * @param values - 设置值。
 * @param key - 字段名。
 * @returns 去掉首尾空白的字符串,可能为空。
 */
function valueOf(values, key) {
  const own = String(values?.[key] ?? "").trim();
  if (own !== "") return own;
  const legacy = LEGACY_KEYS[key];
  return legacy === undefined ? "" : String(values?.[legacy] ?? "").trim();
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

/**
 * 管着某个路径字段的那个下拉,以及当前选中的选项。
 *
 * 路径字段的调用姿势与**路径类型**都挂在选项上:ModelSim 填的是 vsim.exe,换成 XSim
 * 填的却是 Vivado 的 bin 目录。所以判定存在性之前,要先问"是哪个下拉在管它、选的是哪个"。
 * @param field - 路径字段。
 * @param values - 设置解析后的值。
 * @returns 选中的选项;没有下拉管这个字段时返回 undefined。
 */
function selectedOption(field, values) {
  const owner = FIELDS.find(
    (entry) => entry.control === "select" && (entry.options ?? []).some((option) => option.needs === field.key)
  );
  if (owner === undefined) return undefined;
  const raw = valueOf(values, owner.key);
  const chosen = raw === "" ? String(owner.default ?? "") : raw;
  return (owner.options ?? []).find((option) => option.value === chosen);
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
 * @returns 每项 `{ key, label, hint, kind, skips, path, configured, present }`;
 *   有版本要求的字段另带 `versionExpected`(见 {@link versionExpectationOf})。
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
    const option = selectedOption(field, values);
    // 路径类型随所选工具变:选 XSim 时这个字段填的是目录,不是文件。
    const kind = option?.kind ?? field.kind;
    // 用户明确选了「不用(本机没有这个工具)」:空着也不算未就绪,检测也不再探它。
    const unused = option?.value === "none";
    let present = false;
    if (configured) {
      try {
        present = probe(raw, kind) === true;
      } catch {
        present = false;
      }
    }
    return { ...field, kind, path: raw, configured, present, unused, versionExpected: versionExpectationOf(field.key) };
  });
}

/**
 * 某个路径字段的**版本要求**(检测表里写了 `version.expected` 才算,目前只有 `pwshPath`)。
 *
 * 为什么要它:状态路由**只探文件在不在**(它不起进程,见上面的长注释),答不出"版本对不对" ——
 * 但要求本身必须跟着状态发出去,消费方(设置页 / 会话提示)才知道不许拿"文件存在"冒充版本达标。
 * 少了它就会出现:手填一个 7.4.2 的 pwshPath,状态那一行说"已就绪"、旁边的检测行说"版本不匹配"
 * —— 同屏自相矛盾,而用户不知道该信哪条。
 * @param key - 字段名。
 * @returns 期望版本字符串;该字段没有版本要求时为 undefined。
 */
function versionExpectationOf(key) {
  return DETECT_TARGETS.find((target) => target.field === key)?.version?.expected;
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
  stale: "过期技能/模板",
  emptyDir: "空技能目录",
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
 * 列出 `skills/` 下的**空目录**(被删技能腾出来的壳)—— **一个都不删**。
 *
 * 为什么需要看:`cpSync` 只合并不删,包里删掉一个技能之后,用户预设里会留一串看着像"技能还在"
 * 的空壳(实测遇到过 9 个)。技能是按目录扫的,空目录不会被加载,但留着会让人误判当前有哪些能力。
 * 进清单、报出来,由使用者自己处置(插件不删文件)。
 *
 * 放在这个文件(而不是宿主 lib/index.js)的原因与其它纯逻辑相同:自检可以直接 import 它。
 * 只处理传入的那棵子树 —— 用户自己在预设目录里建的东西一律不碰。
 * @param skillsDir - 用户预设目录下的 `skills/`。
 * @returns 空目录的**绝对路径**数组;目录不存在或读不动时为空数组(不影响同步本身)。
 */
export function listEmptySkillDirs(skillsDir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    try {
      if (readdirSync(dir).length === 0) out.push(dir);
    } catch {
      // 读不动就算了:空目录不影响加载,不该让同步整体失败
    }
  }
  return out;
}

/**
 * 列出一棵目录树里的所有文件,相对路径用 `/` 分隔(便于跨平台比较)。
 * @param root - 目录。
 * @returns 相对路径数组;读不了时为空数组。
 */
export function listFiles(root) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
    );
  try {
    return walk(root).map((file) => relative(root, file).split(sep).join("/"));
  } catch {
    return [];
  }
}

/**
 * 分出目标目录里"我们写过、包里已没有"的文件(**待清理,只报告**)与"不是我们写的"(一律保留)。
 *
 * 为什么需要它:`cpSync` 是**合并**,不会删多余的 —— 我们从包里删掉一个技能(比如弃用的
 * `fpga-module-flow`),或者把技能改名(`fpga-spec` → `fpga-module-spec`),用户预设目录里
 * 那份旧的会一直留着。而**预设的技能是从用户目录扫的**(customSkillDirs 相对预设文件解析),
 * 于是老技能照样在被加载 —— 所以这个清单必须**报出来**,不能沉默。
 *
 * **判据只有一条:上次同步清单里记过、包里已没有的 = 我们写的。** 清单里没有的一律当成用户的
 * 东西保留 —— 这包括用户自己放进 `skills/` 的技能(它会被预设加载,但那是用户的东西,轮不到
 * 本插件替他处置)。用户定案(2026-09):插件运行时**绝不永久删除**,所以这里的结果是
 * **待清理清单**(由调用方打印 + 放进返回值),不是"该删就删"的执行计划。
 * @param source - 包内目录。
 * @param destination - 用户目录。
 * @param previousManifest - 上次同步写下的相对路径清单;拿不到时 `stale` 为空(分不清是谁写的)。
 * @returns `{ stale, foreign }`:待清理的相对路径(过期技能/模板),以及清单外的(用户自己的)。
 */
export function presetFileDiff(source, destination, previousManifest) {
  if (!existsSync(destination)) return { stale: [], foreign: [] };
  const shipped = new Set(Array.isArray(previousManifest) ? previousManifest : []);
  const stale = [];
  const foreign = [];
  for (const rel of listFiles(destination)) {
    if (existsSync(join(source, rel))) continue;
    (shipped.has(rel) ? stale : foreign).push(rel);
  }
  return { stale, foreign };
}

/**
 * **待清理**的相对路径(= {@link presetFileDiff} 的 `stale`)。报告用 —— 不删。
 * @param source - 包内目录。
 * @param destination - 用户目录。
 * @param previousManifest - 上次同步写下的相对路径清单。
 * @returns 待清理的相对路径数组(过期技能/模板)。
 */
export function staleShippedFiles(source, destination, previousManifest) {
  return presetFileDiff(source, destination, previousManifest).stale;
}

/**
 * 用户预设目录这次还需不需要同步。
 *
 * **只比较"我们在维护的那部分"**:包内每个文件都要在用户那份里且内容一致。
 *
 * 用户自己往里放的东西(笔记、模板,以及他自己放进 `skills/` 的技能)**不参与判定** ——
 * 否则两棵树永远"不一致",每次启动都重同步、重备份一遍(实测就是这么攒出一堆无用备份的);
 * 而且判定会变成"用户不该往这里放东西"的口气 —— 事实是这里就是他的地盘。
 *
 * 包内已删、用户目录里还留着的旧文件(过期技能/模板)也**不参与判定**:零删除之后,同步本身
 * 清不掉它们,把它们算成"需要同步"只会让每次启动都白备份 + 白复制一遍、并且每启动一次就多留
 * 一个备份目录。它们改由 `pendingCleanup` 报出来(见 lib/index.js)。
 * @param source - 包内那份目录。
 * @param destination - 用户那份目录。
 * @param previousManifest - 上次同步写下的清单。**已不参与判定**(语义收窄,形参保留:调用点与
 *   静态断言都按三个参数写,去掉只会让改动扩散到不该动的地方)。
 * @returns 需要同步时为 true;读不动时也返回 true(宁可多同步一次,不可漏同步)。
 */
export function presetSyncNeeded(source, destination, previousManifest) {
  if (!existsSync(destination)) return true;
  try {
    return listFiles(source).some((rel) => {
      const mirror = join(destination, rel);
      return !existsSync(mirror) || !readFileSync(mirror).equals(readFileSync(join(source, rel)));
    });
  } catch {
    return true;
  }
}

/**
 * 把 `destination` 里**与 `source` 不同**的文件备份到 `backupRoot`(覆盖之前先留一份)。
 *
 * 用在"把我们自带的预设同步进用户预设目录"这一步:`$DSH_HOME/.agent-presets/<id>/` 既然是
 * 用户的地盘,就不能拿我们的版本无条件盖掉他的改动。分不清"用户改的"和"上一版的我们"?
 * 一律按"可能改过"处理 —— 多备份一份文本文件,比悄悄盖掉用户的东西便宜得多。
 *
 * `backupRoot` 由调用方给,并且要放在 `.agent-presets/` **外面** —— 那底下每个目录都会被
 * 当成一个预设去扫。
 * @param source - 包内那份目录。
 * @param destination - 用户那份目录。
 * @param backupRoot - 备份写到哪儿。
 * @returns `{ dir, count, files }`;没有差异时为 undefined。写不动就抛(由调用方决定怎么办)。
 */
export function backupChangedFiles(source, destination, backupRoot) {
  if (!existsSync(destination)) return undefined;
  const changed = listFiles(destination).filter((rel) => {
    const mirror = join(source, rel);
    return !existsSync(mirror) || !readFileSync(mirror).equals(readFileSync(join(destination, rel)));
  });
  if (changed.length === 0) return undefined;

  const files = [];
  for (const rel of changed) {
    const target = join(backupRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(destination, rel), target);
    files.push(target);
  }
  return { dir: backupRoot, count: changed.length, files };
}

/**
 * 一个字段该不该进"缺失"清单:必填、没就绪,而且用户**没有**明确选「不用」。
 *
 * 抽成一条共用规则(`statusOf` 与自检都用它):自检要是自己复制一份判断,改生产规则时
 * 它照样绿 —— 那种断言等于没有(本轮审计就是靠这条发现的)。
 * @param tool - {@link inspectTools} 的一项。
 * @returns 该进缺失清单时为 true。
 */
export function isMissing(tool) {
  return tool.required === true && !tool.present && tool.unused !== true;
}

/**
 * 当前状态:每项的存在情况 + 给设置页用的汇总(**这是设置页字段定义的唯一来源**)。
 *
 * `missing` **只算必填项**:那四个路径没就绪会挡路,所以进清单;语言、仿真器、库映射文件、模板都是可选的,
 * 缺了不挡路,不能报成未就绪。用户明确选「不用」的也不进(那是决定,不是没配好)。
 *
 * 放在这个文件里而不是 lib/index.js:它是纯逻辑,自检可以直接 import 它、断言发给客户端的
 * 载荷形状 —— 而 index.js 要 schemastery,自检跑不了。
 * @param values - 设置解析后的值。
 * @returns `{ tools, missing, ok }`;`tools` 每项带字段定义(除 `usage`,那是提示段专用的文案)。
 */
export function statusOf(values) {
  const tools = inspectTools(values, probeFilesystem)
    // 隐藏字段(改名前的旧键)不发给设置页 —— 它们只是迁移用的兜底,渲染出来就是几个
    // 空输入框,用户不知道那是什么。
    .filter((tool) => tool.control !== "hidden")
    .map(
      ({ key, label, hint, kind, required, skips, path, configured, present, unused, group, control, options, blankNote, default: fallback, versionExpected }) => ({
        key,
        label,
        hint,
        kind,
        required,
        skips,
        path,
        configured,
        present,
        // 用户选了「不用」:设置页据此显示"不用这个工具",而不是当成未就绪
        unused,
        // 版本是执行约束的字段(目前只有 pwshPath)带上要求版本:客户端据此**不许**说光"已就绪"
        // —— 这里的 `present` 只证明文件在,版本要由检测起进程才知道(见 versionExpectationOf)
        versionExpected,
        group,
        control,
        options,
        // 留空的后果(客户端照它显示;不再自己编一句"留空即用自带" —— 那对库映射文件/运行时是错话)
        blankNote,
        default: fallback,
        // 这个字段能不能靠自动检测填上:客户端据此决定要不要为它报"没检测到路径"
        //(库/缓存/模板没有厂商安装位置可探,不报 —— 报了也只是噪音)。
        detectable: DETECT_TARGETS.some((target) => target.field === key)
      })
    );
  const missing = tools.filter(isMissing).map((tool) => tool.key);
  return { tools, missing, ok: missing.length === 0 };
}

/** 拿不到设置时的说明:与其让 agent 以为"工具链没配",不如说清是读不到值。 */
const UNREADABLE =
  "FPGA 工具链:读不到「设置 → FPGA 开发模式」里的路径(插件宿主半侧没挂上?)。本会话里工具位置只能自己确认,不要假设它们存在。";

/**
 * 运行时路径(终端 / 解释器)的诚实标注:这条路径只喂给会话提示,**不保证宿主终端真的用它**。
 *
 * 插件能核对的是"这个文件在不在、版本是几";把路径交给宿主终端是**宿主**的事,本插件没有
 * 强制绑定它的手段。这种话不能说成"已就绪" —— 用户会以为已经强制生效,发现没有时就不再信任提示。
 */
const RUNTIME_NOTE =
  "注意:上面这两条运行时路径是**给本会话提示**用的 —— 宿主终端是否真的使用它们,不由本插件保证(用户已统一要求 PowerShell 7.6.6;实际版本要在设置里点「检测本机工具」看,不符合就问用户,不要按 7.6.6 假设)。";

/**
 * 生成 FPGA 模式会话里那段工具链说明。
 *
 * **这是"用户填的路径真的被用起来"的地方**:路径由用户填、由宿主核对存在性,再原样交给
 * agent,于是它不必去 where/PATH 猜。没就绪的项要连着"会跳过什么"一起说 —— 只说
 * "未配置",agent 会当它不存在然后绕过去。
 *
 * 空字符串表示"没什么可说",此时提示段会被丢掉(见 dsh-system-prompt 的 renderPrompt)。
 * @param values - 设置解析后的值;`undefined` 表示设置服务/命名空间拿不到。
 * @param probe - `(path, kind) => boolean`,同 {@link inspectTools}。
 * @returns 提示段的正文。
 */
export function describeEnv(values, probe) {
  if (values === undefined || values === null) return UNREADABLE;

  const tools = inspectTools(values, probe);
  // 只按**必填**项算就绪/未就绪:模板目录是可选的,缺了不挡路,不能报成"未就绪"
  const required = tools.filter((tool) => tool.required === true);
  const ready = required.filter((tool) => tool.present);
  const blocked = required.filter((tool) => !tool.present && tool.unused !== true);
  const lines = [
    "本机 FPGA 工具链 —— 来自「设置 → FPGA 开发模式」,那里是权威来源,不要用 where/PATH 去猜工具位置:"
  ];

  lines.push(
    ready.length === 0
      ? "现在没有一个路径可用。"
      : ["已就绪:", ...ready.flatMap((tool) => readyLines(tool, tools))].join("\n")
  );
  // 可选项里"配了就该让 agent 看见"的三个:两个运行时(PowerShell 7 / Python 3)与库映射文件。
  // 它们不在 required 里(缺了不挡路,所以进不了上面的"已就绪"),但配好且确实存在时,正是 agent
  // 该拿来用的东西 —— 不说,它就只能去 PATH 猜(实测反馈:配好却一个字都看不到)。
  // 字段清单是显式的三个 key;语言选择与模板另有 choiceLines / templateLines 各自的段落,别重复列。
  // 可选字段永不制造门禁:没配、探不到、或用户已声明"本机没有"的都不出现。
  const optionalReady = ["pwshPath", "pythonPath", "modelsimIniPath"]
    .map((key) => tools.find((tool) => tool.key === key))
    .filter((tool) => tool !== undefined && tool.present === true && tool.unused !== true);
  if (optionalReady.length > 0) {
    // 运行时那两条(PowerShell / Python)要把话说到底:文件在不在是插件核对的,**宿主终端是不是
    // 真的用这条路径,插件管不到**。写成"已就绪"会让人以为已经强制绑定 —— 那是假承诺。
    const runtime = optionalReady.some((tool) => tool.key === "pwshPath" || tool.key === "pythonPath");
    lines.push(
      ["可选运行时与库映射(配了就能用):", ...optionalReady.flatMap((tool) => readyLines(tool, tools)), ...(runtime ? [RUNTIME_NOTE] : [])].join("\n")
    );
  }
  if (blocked.length > 0) {
    lines.push(
      [
        "当前本机不能执行以下能力(要补就在「设置 → FPGA 开发模式」里填路径)。分析、设计与代码修改照常继续,不必等它补齐;只有本次任务确实需要跑那个工具时,才请用户补:",
        ...blocked.map((tool) => `- ${tool.label}:${blockReason(tool)} → 当前不可执行:${tool.skips.join("、")}`),
        "这些能力没实际跑过就不算验证过 —— 按该环节技能里的判定词如实记,不得当成通过。"
      ].join("\n")
    );
  }
  // 用户明确说了"本机没有"的工具:既不算未就绪(那是决定,不是没配好),也要让 agent 知道 ——
  // 否则它可能建议一条本机根本跑不了的路(例如"跑个 lint 看看")。
  const unusedTools = tools.filter((tool) => tool.unused === true);
  if (unusedTools.length > 0) {
    lines.push(
      `用户已说明本机没有以下工具,不要再建议用它们(相关能力按不可用处理):${unusedTools.map((tool) => tool.label).join("、")}`
    );
  }
  lines.push(choiceLines(tools));
  lines.push(templateLines(values, probe));
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
    return `- ${template.label}(${origin}${usage}):${template.path}`;
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

/**
 * 一个可用字段的说明行:标签、所选工具、真实路径、该工具的调用姿势。
 *
 * 工具那三行要连**选的是哪个**一起说 —— 调用命令取决于它(Verilator 是 --lint-only,
 * XSim 是 xvlog/xelab/xsim),所以 usage 挂在选项上、由这里取。
 * @param tool - {@link inspectTools} 的一项。
 * @param tools - 全部字段(用来找到管着这个路径的那个下拉)。
 * @returns 若干行文本(带缩进)。
 */
function readyLines(tool, tools) {
  const owner = tools.find(
    (entry) => entry.control === "select" && (entry.options ?? []).some((option) => option.needs === tool.key)
  );
  const option = owner === undefined ? undefined : (owner.options ?? []).find((entry) => entry.value === owner.path);
  const noun = tool.label.replace(/路径$/u, "");
  const head = owner === undefined
    ? `- ${tool.label}:${tool.path}`
    : `- ${noun}:${option?.label ?? "(未选)"} —— ${tool.path}`;
  try {
    const usage = typeof option?.usage === "function"
      ? option.usage(tool.path)
      : typeof tool.usage === "function" ? tool.usage(tool.path) : [];
    // 版本是执行约束的字段(pwshPath):这里只核对过**文件在**,版本没核过 —— 那就不许让它
    // 读起来像"已经达标"。要求版本是确定的事实,照写;实测版本只能由「检测本机工具」给出。
    const versionNote = tool.versionExpected === undefined
      ? []
      : [`  ⚠ 版本未核验:本模式要求 ${String(tool.versionExpected)};文件在不能证明版本,去「设置 → FPGA 开发模式」点「检测本机工具」看实测版本`];
    return [head, ...usage.map((line) => `  ${line}`), ...versionNote];
  } catch {
    // 配方是给人看的文字,拼不出来也不能让提示组装失败
    return [head];
  }
}

/**
 * 一个未就绪字段的原因:没填,还是填了但路径不存在。两种要分开说 ——
 * "填错了"要去改,"没填"要去填。
 * @param tool - {@link inspectTools} 的一项。
 * @returns 原因文字。
 */
function blockReason(tool) {
  // 不能说"路径不存在" —— 也可能存在但**类型不对**(比如把目录填进了要可执行文件的字段)
  return tool.configured ? `路径不可用(${tool.path}):不存在,或不是这个字段要的类型` : "未配置";
}

// ── 一键检测本机工具 ────────────────────────────────────────────────────────
//
// 基本只读文件系统:找出"这个文件在不在"。**唯一的例外是版本查询**(见 queryVersion):
// 对 `pwshPath` / `pythonPath` 这两个字段,文件在不在答不了"是不是那个版本",而用户对
// PowerShell 的要求是 7.6.6 —— 版本本身就是执行约束的一部分(5.1 与别的 7.x 是另一套东西)。
// 所以只有这两条候选会起一次只打印版本号的进程,别的字段一律照旧只探文件系统。
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

/**
 * 本机 PowerShell 的版本要求 —— 执行约束(用户口径:统一 PowerShell 7.6.6)。
 *
 * 写在这里的原因:检测要拿它判"匹配 / 不匹配",而"匹配"是一句不能含糊的话 ——
 * 5.1 或别的 7.x 都不算,必须报出来让用户自己决定。
 */
export const EXPECTED_PWSH_VERSION = "7.6.6";

/** 版本查询的超时:一个只会打印版本号的进程,几秒还不回就是有问题,不能把检测挂住。 */
export const VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * 只读地跑一次版本查询 —— **检测路径上唯一允许起进程的地方**。
 *
 * 允许它的理由:版本是执行约束的一部分(见 {@link EXPECTED_PWSH_VERSION}),`existsSync`
 * 答不了这个;而"静默接受 5.1"正是用户明确不要的。它只读:命令行只是把版本号打印出来,
 * 不改任何状态、不落文件。
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
 * `version` 只有两个运行时字段有:它们的版本是执行约束的一部分,文件在不在不够(见 {@link queryVersion})。
 * `expected` 有值 = 该版本是硬要求;没有 = 只如实报版本,不做判定。
 */
export const DETECT_TARGETS = [
  {
    field: "simulatorPath",
    option: "modelsim",
    label: "ModelSim / Questa",
    exe: "vsim.exe",
    globs: [{ root: "C:\\", pattern: "modeltech*\\win64\\vsim.exe" }]
  },
  {
    field: "simulatorPath",
    option: "xsim",
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
    field: "synthesizerPath",
    option: "vivado",
    label: "Vivado",
    exe: "vivado.bat",
    globs: [
      { root: "C:\\", pattern: "AMDDesignTools\\*\\Vivado\\bin\\vivado.bat" },
      { root: "C:\\", pattern: "Xilinx\\Vivado\\*\\bin\\vivado.bat" }
    ]
  },
  {
    field: "synthesizerPath",
    option: "quartus",
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
    field: "compilerPath",
    option: "verilator",
    label: "Verilator",
    exe: "verilator_bin.exe",
    globs: [{ root: "C:\\", pattern: "msys*\\mingw64\\bin\\verilator_bin.exe" }]
  },
  {
    field: "compilerPath",
    option: "iverilog",
    label: "Icarus Verilog",
    exe: "iverilog.exe",
    globs: [{ root: "C:\\", pattern: "iverilog\\bin\\iverilog.exe" }]
  },
  {
    // PowerShell 7 与 Python 不是"某厂商的 FPGA 工具",但它们是本模式实际会用到的东西
    // (终端/脚本、参考模型与数据比对),所以照样给检测 —— 它们各自也有「不用」选项。
    field: "pwshPath",
    option: "pwsh",
    label: "PowerShell 7",
    exe: "pwsh.exe",
    // 版本是执行约束(用户口径:统一 7.6.6),文件在不在不够 —— 所以这一条会起一次只读的
    // 版本查询。`-NoProfile` 让它不受用户 profile 影响;`-Command` 只打印版本号。
    // 模式按**这条命令的真实输出**写:`$PSVersionTable.PSVersion.ToString()` 输出的就是
    // 一行 `7.6.6`,所以整行锚定 Major.Minor.Patch —— 报错信息里"提到"某个版本号不算版本。
    version: {
      args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      pattern: /^\s*(\d+\.\d+\.\d+)\s*$/mu,
      expected: EXPECTED_PWSH_VERSION
    },
    globs: [{ root: "%ProgramFiles%", pattern: "PowerShell\\*\\pwsh.exe" }]
  },
  {
    // Python 只如实报版本,不做判定(工程里用哪个 3.x 由用户定,没有统一约束)。
    field: "pythonPath",
    option: "python",
    label: "Python 3",
    exe: "python.exe",
    // `python --version` 输出 `Python 3.14.0`(老 2.x 走 stderr),整行锚定它 —— 同 pwsh,不取
    // "输出里随便一个版本号"。
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
 *   —— 检测路径上唯一会起进程的地方,只有带 `version` 的检测项(两个运行时字段)会用到它。
 * @returns 每项 `{ field, option?, label, path, source }`;`source` 为 `"known"` 或 `"path"`。
 *   带版本查询的项另有 `version` / `versionError` / `versionExpected` / `versionOk` / `versionNote`。
 */
export function detectTools(probe = probeFilesystem, list = readdirNames, env = process.env, readVersion = queryVersion) {
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
   * 版本信息:只有带 `version` 的检测项会走到这里 —— 也就是**只有它俩会起进程**。
   * 认不出 / 起不来 / **命令失败**时如实记 error 与原始输出(见 queryVersion);`expected`
   * 存在时一律判定为不匹配(不静默放过,也绝不当成匹配)。
   */
  const versionInfo = (target, path) => {
    if (target.version === undefined) return {};
    let queried;
    try {
      queried = readVersion(path, target.version) ?? {};
    } catch (error) {
      queried = { error: String(error?.message ?? error) };
    }
    const expected = target.version.expected;
    const version = typeof queried.version === "string" ? queried.version : undefined;
    const versionOk = expected === undefined ? undefined : version === expected;
    const note = version === undefined
      ? `${target.label} 路径可用,但版本查不出来(${queried.error ?? "没有输出"})${expected === undefined ? "" : ` —— 本模式要求 ${expected},请自己确认`}`
      : versionOk === false
        // 这句话两条路径都成立:候选不会被「用这个」采用,手填的那条也不会被状态说成"已就绪"
        // (状态里带 versionExpected,消费方只许说"版本未核验")。
        ? `实际版本 ${version} —— 本模式要求 ${expected},版本不匹配(不会被当成"已就绪",也不会被「用这个」采用)`
        : `版本 ${version}${expected === undefined ? "" : `(符合本模式的 ${expected} 要求)`}`;
    return { version, versionError: queried.error, versionExpected: expected, versionOk, versionNote: note };
  };

  // 只报**机器上找到了什么**,不报"你已经填了什么" —— 已保存的设置与页面上**未保存的改动**
  // 可能不是一回事(用户刚换了工具还没保存),由宿主来回声旧值就会出现
  // "换完工具点检测,报的还是我原来填的那条路径"。填没填、在不在,设置页自己知道。
  for (const target of DETECT_TARGETS) {
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
      const dedupe = `${target.field}|${target.option ?? ""}|${path.toLowerCase()}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      // 版本查的是**证明文件本身**(hit.path),不是填进字段的那个路径(目录字段会不一样)
      hits.push({ field: target.field, option: target.option, label: target.label, path, source: hit.source, ...versionInfo(target, hit.path) });
    }
  }
  return hits;
}
