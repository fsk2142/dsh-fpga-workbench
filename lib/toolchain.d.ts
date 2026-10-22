//#region src/toolchain.d.ts
/** 设置命名空间,同时也是客户端设置页认领的那个 key。两边必须写同一个值。 */
export declare const NS = "fpga-workbench";
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
export declare const LEVEL_DIRS: Record<ToolLevel, string>;
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
  options?: Array<{
    value: string;
    label?: string;
  }>;
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
  options?: Array<{
    value: string;
    label?: string;
  }>;
  /** 关联的环节绑定键（用于把字段与 BINDINGS 对上）。 */
  bindingKey?: string;
  stage?: string;
  [extra: string]: unknown;
}
/**
 * 自带命令。两类:两级共用的骨架,以及模块级的检查/起文件。
 *
 * **没有"看波形"这类交互入口**:要看波形用已经确认过的仿真脚本起 GUI。
 */
export declare const TOOLS: {
  file: string;
  level: string;
  stage: string;
  what: string;
}[];
/** 命令的绝对路径(级别落到目录上,所以路径要拼出来)。 */
export declare function toolPath(tool: {
  level: ToolLevel;
  file: string;
}): string;
/** 命令名应有的级别前缀(守卫用它校验"名字带级别")。 */
export declare function toolLevelPrefix(tool: {
  level: ToolLevel;
}): string;
/**
 * 模板种类 → 字段名与文件名。字段填了就优先用用户那份,留空或不存在就用自带。
 *
 * 这些旧字段只负责迁移老配置；默认值也必须指向现行分类模板，不能依赖已经退出的平铺模板。
 */
export declare const TEMPLATE_FIELDS: TemplateSlot[];
/** 设置页的三个顶层区。数组只定义展示分区,不表示执行顺序。 */
export declare const SETTINGS_SECTIONS: {
  key: string;
  label: string;
  hint: string;
}[];
/**
 * 本机工具登记表。路径、路径类型、调用提示只在这里定义一次,设置、探测、状态与会话提示共用。
 * 自定义槽位只有用户明确选择时才参与某个环节;没有调用说明时只承诺“路径可用”。
 */
export declare const TOOL_CATALOG: Record<string, ToolCatalogEntry>;
/** 工具设置卡片的固定分类；顺序只用于展示，不表示调用顺序。 */
export declare const TOOL_GROUPS: {
  key: string;
  label: string;
}[];
/** 环节只是能力分组；这里没有“当前环节”或先后状态。 */
export declare const STAGES: ({
  key: string;
  section: string;
  label: string;
  bindings: string[];
  note?: undefined;
} | {
  key: string;
  section: string;
  label: string;
  bindings: never[];
  note: string;
})[];
export declare const STAGE_BY_KEY: {
  [k: string]: {
    key: string;
    section: string;
    label: string;
    bindings: string[];
    note?: undefined;
  } | {
    key: string;
    section: string;
    label: string;
    bindings: never[];
    note: string;
  };
};
export declare const BINDINGS: Binding[];
/**
 * 新设置页按“能力”选择工具，不按开发阶段重复登记路径。
 *
 * 数组顺序只控制展示顺序；它不代表执行顺序，更不会生成流水线。每个能力只保存一个
 * `toolKey`，实际路径永远回到 {@link TOOL_CATALOG} 对应的通用路径读取。
 */
export declare const CAPABILITIES: CapabilitySpec[];
export declare const CAPABILITY_BY_KEY: {
  [k: string]: CapabilitySpec;
};
/**
 * 扁平设置 schema。客户端再按 section / stage 元数据组合成三个顶层区和环节卡。
 *
 * 通用路径默认空,由用户登记或从检测候选中选择；环节选择默认 auto,保留 AI 针对当前任务
 * 判断的空间。所有字段都是可选能力,缺一项只影响显式绑定它的环节,不会形成全局门禁。
 * 语言、库映射和模板仍属于通用区。旧全局键隐藏保留一个迁移周期。
 */
export declare const FIELDS: ({
  key: string;
  tool: string;
  section: string;
  sectionLabel: string;
  group: string;
  control: string;
  label: string;
  hint: string | undefined;
  blankNote: string;
  kind: string;
  required: boolean;
  skips: never[];
} | {
  tool: string;
  section: string;
  sectionLabel: string;
  group: string;
  required: boolean;
  skips: never[];
  key: string | undefined;
  control: string;
  label: string;
  hint: string;
} | {
  key: string;
  section: string;
  sectionLabel: string;
  group: string;
  control: string;
  label: string;
  hint: string;
  default: string;
  options: {
    value: string;
    label: string;
  }[];
  required: boolean;
  skips: never[];
  usage?: undefined;
  defaultPath?: undefined;
  blankNote?: undefined;
  kind?: undefined;
} | {
  options?: undefined;
  key: string;
  section: string;
  sectionLabel: string;
  group: string;
  control: string;
  label: string;
  hint: string;
  blankNote: string;
  kind: string;
  required: boolean;
  skips: never[];
  usage: (path: string) => string[];
  defaultPath?: undefined;
  default?: undefined;
} | {
  options?: undefined;
  usage?: undefined;
  key: string;
  section: string;
  sectionLabel: string;
  group: string;
  control: string;
  label: string;
  hint: string;
  blankNote: string;
  defaultPath: string;
  kind: string;
  required: boolean;
  skips: never[];
  default?: undefined;
} | {
  options?: undefined;
  usage?: undefined;
  defaultPath?: undefined;
  key: string;
  section: string;
  sectionLabel: string;
  group: string;
  control: string;
  label: string;
  hint: string;
  blankNote: string;
  kind: string;
  required: boolean;
  skips: never[];
  default?: undefined;
} | {
  section: string;
  sectionLabel: string;
  capability: string;
  capabilityLabel: string;
  group: string;
  required: boolean;
  skips: never[];
  key: string;
  control: string;
  label: string;
  hint: string;
  default: string;
  options: ({
    value: string;
    label: string;
  } | {
    value: string;
    label: string;
    supportNote: string | undefined;
  })[];
} | {
  section: string;
  sectionLabel: string;
  capability: string;
  capabilityLabel: string;
  group: string;
  required: boolean;
  skips: never[];
  key: string;
  category: string;
  control: string;
  label: string;
  hint: string;
  default: string;
} | {
  options?: undefined;
  usage?: undefined;
  defaultPath?: undefined;
  section?: undefined;
  sectionLabel?: undefined;
  blankNote?: undefined;
  kind?: undefined;
  key: string;
  group: string;
  control: string;
  label: string;
  hint: string;
  default: string;
  required: boolean;
  skips: never[];
})[];
export declare const SETTINGS_MODEL_VERSION = "3";
/**
 * 把 v1 全局设置或 v2 阶段设置一次性迁到“顶部工具登记 + 七张能力卡”。即使已经是 v3，
 * 也会幂等修复能力卡里残留的旧插件平面模板路径；用户自己的路径与新式模板 ID 不动。
 *
 * 迁移只追加新字段或把旧插件模板路径替换成等价 ID，绝不把旧字段写空。冲突保留在旧隐藏字段中，
 * 并写一条不含完整路径的提醒。
 */
export declare function legacyMigrationPatch(values: Record<string, unknown>): Record<string, unknown>;
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
export declare function probeFilesystem(path: string, kind?: string): boolean;
/**
 * 清空探测缓存。设置刚保存、或用户点了"重新检测"时调用,让界面立刻反映改动。
 */
export declare function clearProbeCache(): void;
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
export declare function listDirectory(dir: string): {
  path: string;
  parent: string | undefined;
  entries: Array<{
    name: string;
    path: string;
    kind: string;
  }>;
  truncated: boolean;
  error?: string;
};
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
export declare function resolveBinding(values: Record<string, unknown>, binding: Binding, probe?: (path: string, kind?: string) => boolean): ResolvedBinding | MissingBinding;
/** 解析全部环节绑定。数组顺序只用于稳定展示,不表示执行顺序。 */
export declare function resolveBindings(values: Record<string, unknown>, probe?: (path: string, kind?: string) => boolean): Array<ResolvedBinding | MissingBinding>;
/**
 * 解析一张能力卡的工具选择。能力卡只读取顶部工具登记，不存在阶段覆盖路径。
 * @param values - 设置值。
 * @param capability - {@link CAPABILITIES} 中的一项。
 * @param probe - `(path, kind) => boolean`。
 * @returns 能力卡的工具解析结果。
 */
export declare function resolveCapability(values: Record<string, unknown>, capability: CapabilitySpec, probe?: (path: string, kind?: string) => boolean): ResolvedCapability;
/** 解析七张能力卡；数组顺序只用于展示，不代表执行顺序。 */
export declare function resolveCapabilities(values: Record<string, unknown>, probe?: (path: string, kind?: string) => boolean): ResolvedCapability[];
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
  version?: {
    args: string[];
    pattern: RegExp;
    timeoutMs?: number;
  };
  /** 候选路径的 glob 列表（每个探测目标都有，可能为空数组）。 */
  globs: Array<{
    root: string;
    pattern: string;
    fallback?: boolean;
  }>;
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
export declare function resolveCapabilityTemplates(values: Record<string, unknown>, capability: CapabilitySpec, tool?: string, probe?: (path: string, kind?: string) => boolean): ResolvedTemplate[];
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
export declare function inspectTools(values: Record<string, unknown>, probe: (path: string, kind?: string) => boolean): InspectedField[];
/**
 * 兼容旧调用方的字段级缺失判定。新模型没有全局必填路径；实际环节状态由 resolveBinding 判定。
 * @param tool - {@link inspectTools} 的一项。
 * @returns 该进缺失清单时为 true。
 */
export declare function isMissing(tool: InspectedField): boolean;
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
export declare function statusOf(values: Record<string, unknown>, probe?: (path: string, kind?: string) => boolean): Record<string, unknown>;
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
export declare function verilatorRootHint(path: string, probe?: (path: string, kind?: string) => boolean): string[];
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
export declare function describeEnv(values: Record<string, unknown>, probe?: (path: string, kind?: string) => boolean): string;
/**
 * 解析每个模板最终用哪一份:用户填的那份优先,没填或找不到就退回插件自带的。
 *
 * 写 RTL / 测试平台 / 约束之前应当先读这几份文件 —— 写法规范由模板承载,不靠 agent 记规则。
 * @param values - 设置解析后的值。
 * @param probe - `(path, kind) => boolean`。
 * @returns 每项 `{ kind, label, file, path, source, present, announce, missing? }`;`source` 为 `"user"` 或 `"bundled"`;
 *   `missing` 是"填了但找不到"的那个路径;`announce` 是提示段的播报规则(见 {@link TEMPLATE_FIELDS})。
 */
export declare function resolveTemplates(values: Record<string, unknown>, probe: (path: string, kind?: string) => boolean): Array<{
  kind: string;
  label: string;
  file: string;
  path: string;
  source: string;
  present: boolean;
  announce: string;
  missing?: string;
}>;
/** 版本查询的超时:一个只会打印版本号的进程,几秒还不回就是有问题,不能把检测挂住。 */
export declare const VERSION_PROBE_TIMEOUT_MS = 5000;
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
export declare function promptScalar(value: unknown): string;
/**
 * 把一个值渲染成**可以直接粘进 PowerShell** 的参数(同一套显示层的另一个语义)。
 *
 * 顺序很重要:先 `promptScalar` 变成**单行**(控制字符变可见转义),再按 PowerShell 规则加引号 ——
 * 少了第一步,值里的换行会把命令示例劈成两行(实测过)。PowerShell 的单引号字符串是字面量
 * (内部 `'` 写成 `''`),所以含空格/引号/`$`/反引号时用它最稳。
 * @param value - 任意用户提供的字符串。
 * @returns PowerShell 里可直接使用的**单行**参数字面量。
 */
export declare function promptArg(value: unknown): string;
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
export declare function queryVersion(path: string, command: {
  args: string[];
  pattern: RegExp;
  timeoutMs?: number;
}): {
  version?: string;
  error?: string;
  output?: string;
};
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
export declare const DETECT_TARGETS: DetectTarget[];
/** 列一个目录下的子目录名;读不动时为空 —— 一个拒绝访问的目录不该让整次检测失败。 */
export declare function readdirNames(dir: string): string[];
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
export declare function detectTools(probe?: (path: string, kind?: string) => boolean, list?: (dir: string) => string[], env?: NodeJS.ProcessEnv, readVersion?: (path: string, command: {
  args: string[];
  pattern: RegExp;
  timeoutMs?: number;
}) => unknown, fields?: string[] | undefined): Array<Record<string, unknown>>;
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
export declare const INSTALL_HINTS: Record<string, InstallHint>;
/**
 * 「最省事的起步组合」—— 只在**一个工具都没登记**时出现,不打扰已经配好的人。
 *
 * 新机器上最先遇到的问题不是"哪个工具最强",而是"到底要装几个"。
 * 这三行按投入产出排序:免费的两个先上,商业的按需再加。
 */
export declare const MINIMAL_SETUP: string[];
/**
 * 把一个没就绪的工具渲染成"缺什么 + 怎么装"的几行。
 *
 * 只在**没装**的时候给安装指引;已经装好的人不需要被念叨怎么装。
 * @param toolKey - TOOL_CATALOG 的键(如 `vivado`)。
 * @returns 提示行数组;没有对应指引时为空数组。
 */
export declare function installGuidance(toolKey: string): string[];
//#endregion