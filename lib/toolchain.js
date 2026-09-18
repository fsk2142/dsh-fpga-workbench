// 工具链字段与提示渲染 —— 纯逻辑,零 import。
//
// 单独成文件的原因:宿主 lib/index.js 要 import schemastery,而 schemastery 只在
// profile 的 node_modules 里(工作区没有),所以从仓库里 import lib/index.js 会解析失败。
// 把纯逻辑放在这个无依赖文件里,自检就能直接跑它。
// tools/check-toolchain.mjs 覆盖这里的两个行为:只列填过的字段、全空时返回空串。

/** 设置命名空间,同时也是客户端设置页认领的那个 key。两边必须写同一个值。 */
export const NS = "fpga-workbench";

/**
 * 字段:键、在提示里显示的名字、在设置页里的说明。
 *
 * 默认值一律为空 —— 路径必须由用户填。探测 PATH 得到的值不可信(实测那台机器上
 * Vivado / Verilator 的位置都变过,verilator 甚至已经不在 PATH 上),猜错比留空更糟:
 * agent 会照着一个不存在的路径去调工具。
 */
export const FIELDS = [
  ["vivadoPath", "Vivado", "vivado.bat / vivado 可执行文件(综合与实现)"],
  ["modelsimPath", "ModelSim", "vsim.exe / vsim 可执行文件(仿真)"],
  ["verilatorPath", "Verilator", "verilator 可执行文件(lint 与快速仿真)"],
  ["libraryPath", "库目录", "厂商与仿真库所在目录"]
];

/**
 * 把已配置的路径渲染成提示段。
 *
 * 只列非空的项;一项都没填就返回空串 —— system-prompt 在装配时会丢掉空段
 * (dsh-system-prompt/lib/index.js:148 只保留 text 非空的段),所以没配置时
 * 提示里不会多出一句无意义的话。
 * @param values - 设置解析后的值;缺字段按未配置处理。
 * @returns 提示段正文,可能为空串。
 */
export function renderToolchain(values) {
  const configured = FIELDS
    .map(([key, label]) => [label, String(values?.[key] ?? "").trim()])
    .filter(([, value]) => value !== "");
  if (configured.length === 0) return "";
  return [
    "这个环境的 FPGA 工具链路径(用户在设置里配置过,直接使用这些路径,不要自己去找):",
    ...configured.map(([label, value]) => `- ${label}: ${value}`)
  ].join("\n");
}
