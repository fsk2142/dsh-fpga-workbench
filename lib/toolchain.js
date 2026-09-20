// 工具链:字段定义 + 存在性判定 + 给会话提示的说明 —— 只 import node 内置模块。
//
// 单独成文件的原因:宿主 lib/index.js 要 import schemastery,而 schemastery 只在 profile
// 的 node_modules 里(工作区没有),所以从仓库里 import lib/index.js 会解析失败。把不依赖
// schemastery 的东西放在这里,自检就能直接跑它 —— 于是 `node:fs` 可以用,第三方包不可以。
//
// 三处消费同一个定义:
//   - 设置页:哪个路径空着/填错了,会跳过哪些开发环节(inspectTools → statusOf)。
//   - 会话提示:FPGA 模式里把已核对过的路径与调用姿势交给 agent(describeEnv,由 lib/mode.js
//     在**预设作用域**注册,不在插件行 —— 见 README「关于提示注入」)。
//   - 缓存目录:写入目标,宿主会先尝试建出来(ensureCacheDir,in lib/index.js)。
//
// tools/check-toolchain.mjs 覆盖这里的边界行为。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
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
 * 自带命令。三类:两级共用的骨架、模块级的检查/起文件、以及**给人用的交互入口**
 * (波形 GUI —— 用户要看波形时必须真有这条手段,见 `module-verif-wave.mjs`)。
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
    file: "module-verif-wave.mjs",
    level: "module",
    stage: "验证环节",
    what: "打开波形 GUI 让人亲眼排查(编译 + 开 GUI + 加波形 + 停在 0 时刻,不自动 run;--dry-run 只看要做什么)"
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

/** 模板种类 → 字段名与文件名。字段填了就优先用用户那份,留空或不存在就用自带。 */
export const TEMPLATE_FIELDS = [
  { key: "rtlTemplatePath", kind: "rtl", label: "RTL 模板", file: "rtl.sv" },
  { key: "tbTemplatePath", kind: "tb", label: "测试平台模板", file: "tb.sv" },
  { key: "xdcTemplatePath", kind: "xdc", label: "约束模板", file: "constraints.xdc" }
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
      "-c 必须加(命令行模式),否则弹图形界面;波形用 $dumpfile/$dumpvars 或 vcd 落到缓存目录。"
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
    value: "quartus",
    label: "Quartus Prime (quartus_sh)",
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
 * 四个路径字段是必填(编译器 / 仿真器 / 综合器 / 缓存,用户要求"路径都要"),外加**可选**的库映射文件与三份模板文件(RTL / 测试平台 / 约束)。`required` 的语义
 * 是"没就绪会影响开发流程":设置页据此决定要不要报"会跳过什么",宿主据此算缺失清单 ——
 * 可选字段(模板目录)缺了不挡路,因为缺哪个模板文件就用插件自带的那份。
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
    hint: "pwsh.exe;会话终端与 .ps1 脚本用它(5.1 是另一套,别混)。留空则按 PATH 解析",
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
    hint: "python.exe;写参考模型、造测试向量、比对仿真日志可以用它。没配也能开发",
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

  // ── 库与缓存 ───────────────────────────────────────────────────────────────
  {
    key: "modelsimIniPath",
    group: "库与缓存",
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
  {
    key: "cachePath",
    group: "库与缓存",
    control: "text",
    label: "缓存目录",
    hint: "存放开发过程中产生的中间文件(仿真输出、日志、综合产物等)",
    kind: "directory",
    // 它和工具的区别只在"缺席的后果":工具是某一步做不了,缓存目录是中间产物没处落 ——
    // 宿主会先尝试自动创建(见 lib/index.js ensureCacheDir)。
    required: true,
    skips: ["波形与日志留存", "中间产物落盘", "回归结果归档"],
    // 分工写清,别说成"所有中间产物" —— 各环节目录里本来就有该留的东西(验证结果、报告),
    // 与提示段里那句保持同一口径。两处说法不一致比不写更糟:用的人不知道该信哪条。
    usage: (path) => [
      `大型可再生的中间产物写这里,不要把模块源码目录撑大:综合/实现的工程与 runs、回归的编译产物、工具缓存 —— ${path}`,
      "环节目录里该留的仍留在原地:环节报告、仿真日志与波形、验证输出数据、约束与模板文件(报告要能指着它们)。"
    ]
  },

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
    return { ...field, kind, path: raw, configured, present, unused };
  });
}

/**
 * 开头清理残留时的宽限窗口:比这更新的条目,当成**另一次正在跑的自检**留下的,不动。
 *
 * 两个自检会用到同名 fixture(`npm test` 与 `npm run test:installed` 跑的是同一批检查),
 * 并行执行时各自开头的清理会删掉对方正在用的目录 —— 现象是随机的假失败。fixture 名带进程号
 * 已经能避开大部分冲突,这个窗口再挡住"清理别人正在用的目录"这一种。
 */
export const SWEEP_GRACE_MS = 10 * 60 * 1000;

/**
 * 删掉临时根目录下**匹配给定前缀**的条目。
 *
 * 为什么需要:自检每次跑都会建时间戳目录(backup-check-* / stale-check-* / prune-skills-*),
 * SANDBOX 又刻意不清理 —— 跑得多了 `.tmp/` 就攒出上百个目录(实测一次清理删掉 150+ 项、
 * 光这一项就 5 MB)。所以自检**自己用完自己收**:开头先扫掉上次残留,结尾再扫一遍。
 *
 * 只删"名字以给定前缀开头"的条目,不递归进子目录挑东西,也不碰不匹配的任何东西;
 * 传进来的前缀由调用方写死(它们只是自检的 fixture 名)。
 * 放在这个文件而不是宿主 lib/index.js:自检要直接 import 它(后者依赖 schemastery)。
 * @param dir - 临时根目录(不存在时直接返回 0)。
 * @param prefixes - 要清理的名字前缀。
 * @param minAgeMs - 只删"比它更旧"的条目;默认 0 = 全删(收尾时用)。开头清理传
 *   {@link SWEEP_GRACE_MS},免得把并行那次正在用的 fixture 删掉。
 * @returns 删掉的条目个数。
 */
export function sweepTempEntries(dir, prefixes, minAgeMs = 0) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const full = join(dir, entry.name);
    try {
      if (minAgeMs > 0 && Date.now() - statSync(full).mtimeMs < minAgeMs) continue;
    } catch {
      continue; // 连时间都问不到就不碰它
    }
    try {
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 删不掉不影响自检结论:这只是收尾
    }
  }
  return removed;
}

/**
 * 删掉 `skills/` 下的**空目录**(被删技能腾出来的壳),返回删了几个。
 *
 * 为什么需要:`cpSync` 只合并不删,而清理那一步按文件 `unlink` —— 文件没了、目录还在,
 * 用户预设里就会留一串看着像"技能还在"的空壳(实测遇到过 9 个)。技能是按目录扫的,空目录不会
 * 被加载,但留着会让人误判当前有哪些能力。
 *
 * 放在这个文件(而不是宿主 lib/index.js)的原因与其它纯逻辑相同:自检可以直接 import 它。
 * 只处理传入的那棵子树,只删空目录 —— 用户自己在预设目录里建的东西一律不碰。
 * @param skillsDir - 用户预设目录下的 `skills/`。
 * @returns 删掉的目录个数;目录不存在或删不掉时按 0 计(不影响同步本身)。
 */
export function pruneEmptySkillDirs(skillsDir) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    try {
      if (readdirSync(dir).length === 0) {
        rmdirSync(dir);
        removed += 1;
      }
    } catch {
      // 删不掉就算了:空目录不影响加载,不该让同步整体失败
    }
  }
  return removed;
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
 * 找出目标目录里"包里已经没有、但之前是我们在维护"的文件。
 *
 * 为什么需要它:`cpSync` 是**合并**,不会删多余的 —— 我们从包里删掉一个技能(比如弃用的
 * `fpga-module-flow`),或者把技能改名(`fpga-spec` → `fpga-module-spec`),用户预设目录里
 * 那份旧的会一直留着。而**预设的技能是从用户目录扫的**(customSkillDirs 相对预设文件解析),
 * 于是老技能照样在被加载;改完名会变成新旧两套同时加载。
 *
 * 两类要删:
 * 1. 上次清单里记过、包里已没有的 —— 确定是我们写过的东西;
 * 2. **`behaviorDirs` 底下、包里已没有的** —— 技能这类"留着就直接改变 AI 行为"的东西,
 *    即使没有清单(第一次升级、清单还没建起来)也要清,否则一次改名就留下两套技能。
 *    其它目录(用户可能自己放笔记/模板)只要不在清单里就一律保留。
 * @param source - 包内目录。
 * @param destination - 用户目录。
 * @param previousManifest - 上次同步写下的相对路径清单;拿不到时只按第 2 类清。
 * @param behaviorDirs - 留着旧文件会直接改变行为的顶层目录(相对路径,用 `/` 分隔)。
 * @returns 该删掉的相对路径数组。
 */
export function staleShippedFiles(source, destination, previousManifest, behaviorDirs = ["skills"]) {
  if (!existsSync(destination)) return [];
  const shipped = new Set(Array.isArray(previousManifest) ? previousManifest : []);
  const heads = behaviorDirs.map((dir) => `${dir.replace(/\/+$/u, "")}/`);
  return listFiles(destination).filter((rel) => {
    if (existsSync(join(source, rel))) return false;
    return shipped.has(rel) || heads.some((head) => rel.startsWith(head));
  });
}

/**
 * 用户预设目录这次还需不需要同步。
 *
 * **只比较"我们在维护的那部分"**:包内每个文件都要在用户那份里且内容一致;上次清单里记过、
 * 包里已经没有的(以及 `skills/` 下多出来的)要先清掉。
 *
 * 用户自己往里放的普通文件(比如在预设目录里搁一份笔记)**不参与判定** —— 否则两棵树
 * 永远"不一致",每次启动都重同步、重备份一遍(实测就是这么攒出一堆无用备份的)。
 * 用户放在 `skills/` 下的自定义技能同样不会被删,但它们属于"包里没有、也不是我们写的",
 * 由 {@link staleShippedFiles} 的清单规则兜住 —— 它只清我们自己写过的。
 * @param source - 包内那份目录。
 * @param destination - 用户那份目录。
 * @param previousManifest - 上次同步写下的清单。
 * @param behaviorDirs - 留着旧文件会直接改变行为的顶层目录,同 {@link staleShippedFiles}。
 * @returns 需要同步时为 true;读不动时也返回 true(宁可多同步一次,不可漏同步)。
 */
export function presetSyncNeeded(source, destination, previousManifest, behaviorDirs = ["skills"]) {
  if (!existsSync(destination)) return true;
  if (staleShippedFiles(source, destination, previousManifest, behaviorDirs).length > 0) return true;
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
      ({ key, label, hint, kind, required, skips, path, configured, present, unused, group, control, options, blankNote, default: fallback }) => ({
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
  const cache = tools.find((tool) => tool.key === "cachePath");
  const lines = [
    "本机 FPGA 工具链 —— 来自「设置 → FPGA 开发模式」,那里是权威来源,不要用 where/PATH 去猜工具位置:"
  ];

  lines.push(
    ready.length === 0
      ? "现在没有一个路径可用。"
      : ["已就绪:", ...ready.flatMap((tool) => readyLines(tool, tools))].join("\n")
  );
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
  if (cache?.present) {
    lines.push(
      "中间产物落哪里:综合/实现的工程与 runs、回归的编译产物、工具缓存这类**大型可再生的东西**写缓存目录,不要把源码目录撑大;" +
        "环节报告、仿真日志与波形、验证输出数据这些**结论要指着的东西**留在各自环节目录里。"
    );
  }
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
 * @returns 每项 `{ kind, label, file, path, source, present, missing? }`;`source` 为 `"user"` 或 `"bundled"`;
 *   `missing` 是"填了但找不到"的那个路径。
 */
export function resolveTemplates(values, probe) {
  return TEMPLATE_FIELDS.map(({ key, kind, label, file }) => {
    const custom = String(values?.[key] ?? "").trim();
    const bundled = join(BUNDLED_TEMPLATE_DIR, file);
    if (custom === "") {
      return { kind, label, file, path: bundled, source: "bundled", present: exists(probe, bundled) };
    }
    if (exists(probe, custom)) {
      return { kind, label, file, path: custom, source: "user", present: true };
    }
    // 填了但文件不在:如实说出来,别让用户以为自己那份生效了
    return { kind, label, file, path: bundled, source: "bundled", present: exists(probe, bundled), missing: custom };
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
 * @param values - 设置解析后的值。
 * @param probe - `(path, kind) => boolean`。
 * @returns 提示段里的一节。
 */
function templateLines(values, probe) {
  const templates = resolveTemplates(values, probe);
  const lines = templates.map((template) => {
    const origin = template.source === "user" ? "你提供的" : "插件自带";
    return `- ${template.label}(${origin}):${template.path}`;
  });
  const absent = templates.filter((template) => !template.present);
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
    return [head, ...usage.map((line) => `  ${line}`)];
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
// 只读文件系统:**不起进程、不问版本**。起进程会把"检测"变成"可能挂住"(用户那栏工具
// 没装好时尤其明显),而这里要的就只是"这个文件在不在"。
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

/** 检测表的每一项:往哪个字段填、命中后把下拉切到哪个选项、以及去哪儿找。
 *
 * `globs` 里带 `fallback: true` 的那几条只在首选一组**没命中**时才用(见 {@link detectTools})。
 * 检测表必须覆盖每个具体工具(选项里不是"其他"的那些)—— 自检有一条守卫盯着这件事:
 * 漏一个,用户就只能自己手填路径,而界面上明明写着"支持它"。
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
    globs: [{ root: "%ProgramFiles%", pattern: "PowerShell\\*\\pwsh.exe" }]
  },
  {
    field: "pythonPath",
    option: "python",
    label: "Python 3",
    exe: "python.exe",
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
 * `probe` / `list` / `env` 都可注入,所以自检拿桩函数就能跑,不必真装工具。
 * @param probe - `(path, kind) => boolean`,同 {@link inspectTools}。
 * @param list - `(dir) => string[]`,列子目录名。
 * @param env - 环境(用到 `PATH` / `ProgramFiles` / `LocalAppData`)。
 * @returns 每项 `{ field, option?, label, path, source }`;`source` 为 `"known"` 或 `"path"`。
 */
export function detectTools(probe = probeFilesystem, list = readdirNames, env = process.env) {
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
      hits.push({ field: target.field, option: target.option, label: target.label, path, source: hit.source });
    }
  }
  return hits;
}
