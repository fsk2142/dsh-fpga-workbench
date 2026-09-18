// 工具链:字段定义 + 存在性判定 —— 纯逻辑,零 import。
//
// 单独成文件的原因:宿主 lib/index.js 要 import schemastery,而 schemastery 只在 profile
// 的 node_modules 里(工作区没有),所以从仓库里 import lib/index.js 会解析失败。把纯逻辑
// 放在这个无依赖文件里,自检就能直接跑它。
//
// 这里的产出只用来喂**设置页**:哪个路径空着/填错了,会跳过哪些开发环节。
// 不往会话提示里注入任何东西 —— 那是刻意的(见 README「关于提示注入」)。
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
