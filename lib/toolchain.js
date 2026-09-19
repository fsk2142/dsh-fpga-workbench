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
 * 自带命令。只列"能用一条命令判定成败"的那类 —— 要读输出才知道好坏的,归技能,不归脚本。
 */
export const TOOLS = [
  {
    file: "spec-scaffold.mjs",
    stage: "规格环节",
    what: "一次建好模块 / 工程的骨架(模块直接用;工程加 --kind project --modules A,B;幂等,不覆盖已有锚点)"
  },
  { file: "rtl-new.mjs", stage: "RTL 环节", what: "按模板起一个 RTL 文件(复制模板、只替模块名,默认落 rtl/)" },
  { file: "rtl-check.mjs", stage: "RTL 环节", what: "机械规范检查(文件头 / 九个小节块 / 端口类型 / 复位极性 / Tab / 行尾 / 断言 / 测试平台自检)" },
  { file: "verif-new.mjs", stage: "验证环节", what: "按模板起一个测试平台(默认落 verif/tb_<模块名下划线形式>.sv,如 UartRx → tb_uart_rx.sv)" },
  { file: "synth-new.mjs", stage: "综合环节", what: "按模板起一个约束文件(默认落 synth/<模块名>.xdc)" }
];

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
  { value: "other", label: "其他(自己填路径)", needs: "compilerPath", usage: () => [] }
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
    usage: (path) => [
      `三步走:"${pad(path)}xvlog" -sv <源码...> → "${pad(path)}xelab" -debug typical <顶层> -s tb_sim → "${pad(path)}xsim" tb_sim -runall`,
      "路径填 Vivado 的 bin 目录(那三个命令都在里面)。"
    ]
  },
  {
    value: "verilator",
    label: "Verilator(只适合 lint 与快速回归,没有时序)",
    needs: "simulatorPath",
    usage: (path) => [
      `编译+跑:"${path}" --binary --timing --top-module <顶层> <文件...>,产物在 obj_dir/`,
      "它不建模延迟:时序相关的行为验不了,不能拿来代替功能仿真。"
    ]
  },
  { value: "other", label: "其他(自己填路径)", needs: "simulatorPath", usage: () => [] }
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
  { value: "other", label: "其他(自己填路径)", needs: "synthesizerPath", usage: () => [] }
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
 * 五个路径字段都是必填(用户要求"路径都要"),外加一个**可选**的模板目录。`required` 的语义
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
  // ── 编译器:RTL 的 lint / 编译检查 ──────────────────────────────────────────
  {
    key: "compiler",
    group: "编译器",
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
    group: "编译器",
    control: "text",
    label: "编译器路径",
    hint: "Verilator 填 verilator_bin.exe(MSYS2 装在 C:\\msys64\\mingw64\\bin 下);换了别的工具就填它的可执行文件",
    kind: "file",
    required: true,
    skips: ["快速 lint", "回归编译", "覆盖率统计"]
  },
  {
    key: "rtlLangStd",
    group: "编译器",
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
    group: "仿真器",
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
    group: "仿真器",
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
    group: "仿真器",
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
    group: "综合器",
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
    group: "综合器",
    control: "text",
    label: "综合器路径",
    // 明确写文件名:Windows 上 Vivado **没有** vivado.exe,入口就是 bin\vivado.bat
    // (那个无扩展名的 vivado 是 Linux/msys 的 shell 脚本)。只写"可执行文件"太含糊。
    hint: "Vivado 填 vivado.bat(Windows 上没有 vivado.exe)",
    kind: "file",
    required: true,
    skips: ["综合", "实现与布局布线", "比特流生成", "时序报告"]
  },

  // ── 库与缓存 ───────────────────────────────────────────────────────────────
  {
    key: "libraryPath",
    group: "库与缓存",
    control: "text",
    label: "库目录",
    hint: "厂商与仿真库所在目录",
    kind: "directory",
    required: true,
    skips: ["厂商原语仿真", "IP 库编译"],
    usage: (path) => [`仿真编译时把编译库指到这里(vlog -work / -L 或 vsim 的库映射),不要每次就地重建:${path}`]
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
    usage: (path) => [`所有中间产物(仿真输出、日志、综合产物、波形、回归结果)只写到这里:${path}`]
  },

  // ── 模板 ───────────────────────────────────────────────────────────────────
  {
    key: "rtlTemplatePath",
    group: "模板",
    control: "text",
    label: "RTL 模板",
    hint: "留空用插件自带的 rtl.sv;填了就用你这份(文件头、九个小节块、对齐都照它;机械检查器仍按自带那套约定判)",
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
 * 文件字段也接受目录:用户可能填到工具所在目录(有些安装把可执行文件放在 bin 下),
 * 替他把关只会误报。目录字段要求真的是目录。
 * @param path - 配置里填的路径。
 * @param kind - `"file"` 或 `"directory"`。
 * @returns 存在且类型可接受。
 */
export function probeFilesystem(path, kind) {
  if (!existsSync(path)) return false;
  try {
    return kind === "directory" ? statSync(path).isDirectory() : true;
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
    let present = false;
    if (configured) {
      try {
        present = probe(raw, field.kind) === true;
      } catch {
        present = false;
      }
    }
    return { ...field, path: raw, configured, present };
  });
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
 * 当前状态:每项的存在情况 + 给设置页用的汇总(**这是设置页字段定义的唯一来源**)。
 *
 * `missing` **只算必填项**:五个路径没就绪会挡路,所以进清单;语言、仿真器、模板都是可选的,
 * 缺了不挡路,不能报成未就绪。
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
      ({ key, label, hint, kind, required, skips, path, configured, present, group, control, options, default: fallback }) => ({
        key,
        label,
        hint,
        kind,
        required,
        skips,
        path,
        configured,
        present,
        group,
        control,
        options,
        default: fallback
      })
    );
  const missing = tools.filter((tool) => tool.required === true && !tool.present).map((tool) => tool.key);
  return { tools, missing, ok: missing.length === 0 };
}

/** 拿不到设置时的说明:与其让 agent 以为"工具链没配",不如说清是读不到值。 */
const UNREADABLE =
  "FPGA 工具链:读不到「设置 → FPGA 开发模式」里的路径(插件宿主半侧没挂上?)。本会话里工具位置只能自己确认,不要假设它们存在。";

/**
 * 生成 FPGA 模式会话里那段工具链说明。
 *
 * **这是"五个路径真的被用起来"的地方**:路径由用户填、由宿主核对存在性,再原样交给
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
  const blocked = required.filter((tool) => !tool.present);
  const cache = tools.find((tool) => tool.key === "cachePath");
  const lines = [
    "本机 FPGA 工具链 —— 来自「设置 → FPGA 开发模式」,那里是权威来源,不要用 where/PATH 去猜工具位置:"
  ];

  lines.push(
    ready.length === 0
      ? "五个路径现在没有一个可用。"
      : ["已就绪:", ...ready.flatMap((tool) => readyLines(tool, tools))].join("\n")
  );
  if (blocked.length > 0) {
    lines.push(
      [
        "未就绪(这些环节不得强行执行,须请用户先在「设置 → FPGA 开发模式」补齐):",
        ...blocked.map((tool) => `- ${tool.label}:${blockReason(tool)} → 会跳过 ${tool.skips.join("、")}`)
      ].join("\n")
    );
  }
  lines.push(choiceLines(tools));
  lines.push(templateLines(values, probe));
  if (cache?.present) {
    lines.push("中间产物(仿真输出、日志、综合产物、波形)只写到缓存目录,不要污染 RTL 源码目录。");
  }
  lines.push(
    [
      "本模式自带的命令(Node 直接跑,不用装东西)。**按环节分,不要跨环节混用**:",
      ...TOOLS.map((tool) => `- [${tool.stage}] ${tool.what}:node "${join(BUNDLED_TOOLS_DIR, tool.file)}" <模块目录>`)
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
    "(这几条只管写法;`rtl-check.mjs` 这个机械检查器按**插件自带那套约定**判定(文件头字段、九个小节块、对齐)。使用自定义模板且约定不同时,以检查器的报告为准,不得为通过它而改动设计。)"
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
  return tool.configured ? `路径不存在(${tool.path})` : "未配置";
}
