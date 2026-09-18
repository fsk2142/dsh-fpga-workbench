// 工具链:字段定义、缺失检测、提示渲染 —— 纯逻辑,零 import。
//
// 单独成文件的原因:宿主 lib/index.js 要 import schemastery,而 schemastery 只在 profile
// 的 node_modules 里(工作区没有),所以从仓库里 import lib/index.js 会解析失败。把纯逻辑
// 放在这个无依赖文件里,自检就能直接跑它。
// tools/check-toolchain.mjs 覆盖这里的边界行为。

/** 设置命名空间,同时也是客户端设置页认领的那个 key。两边必须写同一个值。 */
export const NS = "fpga-workbench";

/**
 * 字段:键、显示名、说明、类型、是否**必须存在**、以及缺失时会跳过哪些开发步骤。
 *
 * 默认值一律为空 —— 路径必须由用户填。探测 PATH 得到的值不可信(实测那台机器上
 * verilator 已经不在 PATH 上,旧探测值指向一个已删除的目录),猜错比留空更糟:
 * agent 会照着一个不存在的路径去调工具。
 *
 * `required` 区分两类,这对警告很重要:
 *   - true(工具):不存在就做不了事,警告里要列清会跳过哪些步骤 —— 用户要的就是这个
 *   - false(缓存目录):是**写入目标**,还不存在是正常的(首次使用时会创建),
 *     不该报成"缺失",否则每台新机器一上来就是一片红
 *
 * `skips` 只在 required 时有意义,是"缺了它,哪一步做不了"。
 */
export const FIELDS = [
  {
    key: "vivadoPath",
    label: "Vivado",
    hint: "vivado.bat / vivado 可执行文件",
    kind: "file",
    required: true,
    skips: ["综合", "实现与布局布线", "比特流生成", "时序报告"]
  },
  {
    key: "modelsimPath",
    label: "ModelSim",
    hint: "vsim.exe / vsim 可执行文件",
    kind: "file",
    required: true,
    skips: ["RTL 功能仿真", "时序仿真", "波形调试"]
  },
  {
    key: "verilatorPath",
    label: "Verilator",
    hint: "verilator 可执行文件",
    kind: "file",
    required: true,
    skips: ["快速 lint", "回归仿真", "覆盖率统计"]
  },
  {
    key: "libraryPath",
    label: "库目录",
    hint: "厂商与仿真库所在目录",
    kind: "directory",
    required: true,
    skips: ["厂商原语仿真", "IP 库编译"]
  },
  {
    key: "cachePath",
    label: "缓存目录",
    hint: "存放开发过程中产生的中间文件(仿真输出、日志、综合产物等)",
    kind: "directory",
    required: false,
    skips: []
  }
];

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

/**
 * 把缺失情况渲染成警告,逐项说清会跳过哪些步骤。
 *
 * 只看**必需**项:缓存目录是写入目标,还没创建不该报成"缺失",否则新机器一上来
 * 就是一片红,警告也就没人看了。
 * @param tools - `inspectTools` 的结果。
 * @returns 警告正文;没有必需项缺失时返回空串。
 */
export function renderToolWarning(tools) {
  const missing = tools.filter((tool) => tool.required === true && !tool.present);
  if (missing.length === 0) return "";
  return [
    "注意:下列 FPGA 工具缺失,相关步骤必须跳过 —— 不要调用它们,也不要假装已执行:",
    ...missing.map((tool) => {
      const why = tool.configured ? `路径不存在:${tool.path}` : "尚未在设置里配置";
      return `- ${tool.label}(${why})→ 跳过:${tool.skips.join("、")}`;
    })
  ].join("\n");
}

/**
 * 把可用的路径渲染成提示段。
 *
 * 两类都算可用:
 *   - 探测到存在的工具
 *   - 配置了但还不存在、且**不是必需**的项(缓存目录):它是写入目标,agent 应该拿到
 *     这个路径去写中间产物,即使目录还没创建
 *
 * 一个都没有就返回空串 —— system-prompt 装配时会丢掉空段
 * (dsh-system-prompt/lib/index.js:148),所以没配置时提示里不会多出无意义的话。
 * @param tools - `inspectTools` 的结果。
 * @returns 提示段正文,可能为空串。
 */
export function renderToolchain(tools) {
  const usable = tools.filter((tool) => tool.present || (tool.required === false && tool.configured));
  if (usable.length === 0) return "";
  return [
    "这个环境的 FPGA 工具链路径(用户在设置里配置过,直接使用这些路径,不要自己去找):",
    ...usable.map((tool) => `- ${tool.label}: ${tool.path}`)
  ].join("\n");
}

/**
 * 会话提示里要加的全部内容:可用路径 + 缺失警告。
 * @param tools - `inspectTools` 的结果。
 * @returns 两段拼起来的正文;都为空时返回空串。
 */
export function renderEnvironment(tools) {
  return [renderToolchain(tools), renderToolWarning(tools)].filter((part) => part !== "").join("\n\n");
}
