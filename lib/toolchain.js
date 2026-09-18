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

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
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
  { file: "check-rtl.mjs", what: "RTL 机械规范检查(文件头 / 九个小节块 / 端口类型 / 复位极性 / Tab / 行尾 / 断言 / 测试平台自检)" },
  { file: "stage-status.mjs", what: "阶段状态汇总(读各阶段结果里的 `结论:...`)" }
];

/** 模板种类 → 文件名。用户提供的目录里有同名文件就优先用他的。 */
export const TEMPLATE_FILES = [
  { kind: "rtl", label: "RTL 模板", file: "rtl.sv" },
  { kind: "tb", label: "测试平台模板", file: "tb.sv" },
  { kind: "xdc", label: "约束模板", file: "constraints.xdc" }
];

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
  {
    key: "vivadoPath",
    label: "Vivado",
    // 明确写文件名:Windows 上 Vivado **没有** vivado.exe,入口就是 bin\vivado.bat
    // (那个无扩展名的 vivado 是 Linux/msys 的 shell 脚本)。只写"可执行文件"太含糊,
    // 用户会去找一个不存在的 vivado.exe。
    hint: "vivado.bat 的完整路径(Windows 上没有 vivado.exe)",
    kind: "file",
    required: true,
    skips: ["综合", "实现与布局布线", "比特流生成", "时序报告"],
    usage: (path) => [
      `非交互批处理:"${path}" -mode batch -source <脚本.tcl> -log <日志路径> -journal <记录路径>`,
      "不加 -mode batch 会拉起图形界面等人操作;Tcl 脚本里用 open_project/open_run 驱动流程。"
    ]
  },
  {
    key: "modelsimPath",
    label: "ModelSim",
    // 要 vsim.exe 而不是 modelsim.exe:后者是图形界面,会弹窗等人操作,自动化跑不了。
    hint: "vsim.exe 的完整路径(用 vsim.exe,不是图形界面的 modelsim.exe)",
    kind: "file",
    required: true,
    skips: ["RTL 功能仿真", "时序仿真", "波形调试"],
    usage: (path) => [
      `非交互仿真:"${path}" -c -do "do <脚本.do>; quit -f"`,
      "-c 必须加(命令行模式),否则弹图形界面;波形用 $dumpfile/$dumpvars 或 vcd 落到缓存目录,别指望在无界面会话里看 wave 窗口。"
    ]
  },
  {
    key: "verilatorPath",
    label: "Verilator",
    hint: "verilator_bin.exe 的完整路径(MSYS2 装在 C:\\msys64\\mingw64\\bin 下)",
    kind: "file",
    required: true,
    skips: ["快速 lint", "回归仿真", "覆盖率统计"],
    usage: (path) => [
      `快速 lint:"${path}" --lint-only -Wall --top-module <顶层模块> <文件...>`,
      "用 verilator_bin.exe 本体(它旁边的 dll 会被同目录解析);那个无扩展名的 verilator 是 perl 包装脚本,需要 PATH 里有 perl。"
    ]
  },
  {
    key: "libraryPath",
    label: "库目录",
    hint: "厂商与仿真库所在目录",
    kind: "directory",
    required: true,
    skips: ["厂商原语仿真", "IP 库编译"],
    usage: (path) => [`仿真编译时把编译库指到这里(vlog -work / -L 或 vsim 的库映射),不要每次就地重建:${path}`]
  },
  {
    key: "cachePath",
    label: "缓存目录",
    hint: "存放开发过程中产生的中间文件(仿真输出、日志、综合产物等)",
    kind: "directory",
    // 用户要求五个路径都必填。它和工具的区别只在"缺席的后果":工具是某一步做不了,
    // 缓存目录是中间产物没处落 —— 宿主会先尝试自动创建(见 lib/index.js ensureCacheDir)。
    required: true,
    skips: ["波形与日志留存", "中间产物落盘", "回归结果归档"],
    usage: (path) => [`所有中间产物(仿真输出、日志、综合产物、波形、回归结果)只写到这里:${path}`]
  },
  {
    key: "templateDir",
    label: "模板目录",
    // 唯一一个**可选**字段:留空就用插件自带的那几份。写法规范由模板承载,不写死在技能
    // 正文里 —— 用户换一套模板,行为跟着换,技能一个字都不用改。
    hint: "留空用插件自带的模板;填了就优先用你目录里的同名文件(rtl.sv / tb.sv / constraints.xdc)",
    kind: "directory",
    required: false,
    // 没就绪也不会"跳过什么":缺哪个文件就用自带的那份,不会挡路。
    skips: []
  }
];

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
 * 拿一项配置的值。
 * @param values - 设置值。
 * @param key - 字段名。
 * @returns 去掉首尾空白的字符串,可能为空。
 */
function valueOf(values, key) {
  return String(values?.[key] ?? "").trim();
}

/**
 * 判定每个字段的状态。
 *
 * `probe(path, kind)` 由调用方注入:宿主传真实文件系统探测,自检传桩函数 ——
 * 于是这段判定逻辑可以脱离文件系统被测。
 * @param values - 设置解析后的值。
 * @param probe - `(path, kind) => boolean`,路径存在且类型匹配。
 * @returns 每项 `{ key, label, hint, kind, skips, path, configured, present }`。
 */
export function inspectTools(values, probe) {
  return FIELDS.map((field) => {
    const path = valueOf(values, field.key);
    const configured = path !== "";
    let present = false;
    if (configured) {
      try {
        present = probe(path, field.kind) === true;
      } catch {
        present = false;
      }
    }
    return { ...field, path, configured, present };
  });
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
      : ["已就绪:", ...ready.flatMap(readyLines)].join("\n")
  );
  if (blocked.length > 0) {
    lines.push(
      [
        "未就绪(这些环节先别硬跑,让用户去「设置 → FPGA 开发模式」补齐):",
        ...blocked.map((tool) => `- ${tool.label}:${blockReason(tool)} → 会跳过 ${tool.skips.join("、")}`)
      ].join("\n")
    );
  }
  lines.push(templateLines(values, probe));
  if (cache?.present) {
    lines.push("中间产物(仿真输出、日志、综合产物、波形)只写到缓存目录,不要污染 RTL 源码目录。");
  }
  lines.push(
    [
      "本模式自带的命令(Node 直接跑,不用装东西):",
      ...TOOLS.map((tool) => `- ${tool.what}:node "${join(BUNDLED_TOOLS_DIR, tool.file)}" <模块目录>`)
    ].join("\n")
  );
  lines.push("命令用现有 shell 工具跑(走沙箱、输出可回看);综合与大回归放后台任务再读日志,不要前台死等。");

  return lines.join("\n\n");
}

/**
 * 解析每个模板最终用哪一份:用户目录里的同名文件优先,缺了退回插件自带的。
 *
 * 写 RTL / 测试平台 / 约束之前应当先读这几份文件 —— 写法规范由模板承载,不靠 agent 记规则。
 * @param values - 设置解析后的值。
 * @param probe - `(path, kind) => boolean`。
 * @returns 每项 `{ kind, label, file, path, source, present }`;`source` 为 `"user"` 或 `"bundled"`。
 */
export function resolveTemplates(values, probe) {
  const dir = String(values?.templateDir ?? "").trim();
  return TEMPLATE_FILES.map(({ kind, label, file }) => {
    const owned = dir === "" ? "" : join(dir, file);
    if (owned !== "" && exists(probe, owned)) {
      return { kind, label, file, path: owned, source: "user", present: true };
    }
    const bundled = join(BUNDLED_TEMPLATE_DIR, file);
    return { kind, label, file, path: bundled, source: "bundled", present: exists(probe, bundled) };
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
  const lines = resolveTemplates(values, probe).map((template) => {
    const origin = template.source === "user" ? "你提供的" : "插件自带";
    return `- ${template.label}(${origin}):${template.path}`;
  });
  const missing = resolveTemplates(values, probe).filter((template) => !template.present);
  return [
    "模块模板 —— 写 RTL、测试平台、约束之前先读这几份,照它们的格式来:",
    ...lines,
    ...(missing.length === 0
      ? []
      : [`(注意:${missing.map((template) => `${template.label} 的 ${template.file}`).join("、")}没找到 —— 找不到就别硬编,先跟用户确认)`])
  ].join("\n");
}

/**
 * 一个可用字段的说明行:标签、真实路径、调用姿势。
 * @param tool - {@link inspectTools} 的一项。
 * @returns 若干行文本(带缩进)。
 */
function readyLines(tool) {
  const head = `- ${tool.label}:${tool.path}`;
  try {
    return [head, ...tool.usage(tool.path).map((line) => `  ${line}`)];
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
