//#region src/template-library.d.ts
/**
 * 一个模板分类（{@link TEMPLATE_CATEGORIES} 的一项）。
 *
 * `directory` 同时决定内置相对路径与用户库目录 —— 不接受请求方自定义目录。
 */
export interface CategoryLike {
  key: string;
  label: string;
  directory: string;
  extensions: string[];
  [extra: string]: unknown;
}
/**
 * 一张能力卡里"我需要哪些分类的模板"的定义。
 *
 * 它来自 `toolchain.ts` 的 `CapabilitySpec`，但这里**只声明用到的成员** ——
 * 两个模块互相引用类型会造成循环依赖，而这个文件只需要 key / templates。
 */
export interface CapabilityLike {
  key: string;
  templates?: Array<{
    key: string;
    category: string;
    label?: string;
    [extra: string]: unknown;
  }>;
  [extra: string]: unknown;
}
/** 一个内置模板（{@link BUILTIN_TEMPLATES} 的一项）。 */
export interface BuiltinTemplate {
  category: string;
  id: string;
  relativePath: string;
  label: string;
  compatibleTools: string[];
  [extra: string]: unknown;
}
/** 模板库根的检查结果。 */
export interface RootState {
  configured: boolean;
  present: boolean;
  error?: string;
}
/** 一个分类的扫描结果。 */
export interface CategoryScan {
  /** 层级过滤后被隐藏了几项（调用方按 capability 的层级补上）。 */
  hiddenByLevel?: number;
  key: string;
  label: string;
  directory: string;
  items: Array<Record<string, unknown>>;
  builtinCount: number;
  libraryCount: number;
  truncated: boolean;
  errors: string[];
}
/** 单个分类最多返回的用户模板数。超过时停止继续收集并明确标记。 */
export declare const MAX_TEMPLATES_PER_CATEGORY = 500;
/** 插件自带的分类模板根；由 import.meta.url 定位，不受工作目录影响。 */
export declare const BUNDLED_TEMPLATE_ROOT: string;
/**
 * 固定模板分类。directory 同时决定内置相对路径与用户库目录，不接受请求方自定义目录。
 * 数组顺序只用于界面稳定展示，不表示执行顺序。
 */
export declare const TEMPLATE_CATEGORIES: CategoryLike[];
/**
 * 内置模板。compatibleTools 中的 "*" 表示与具体工具无关；其余项只对明确工具适配。
 * auto 尚未决定具体工具，因此可以看到候选默认；显式 Quartus / 自定义工具则不会误用 Vivado/ModelSim 脚本。
 */
export declare const BUILTIN_TEMPLATES: BuiltinTemplate[];
/** 带 HTTP 建议状态的输入错误；宿主接口据此返回非 2xx。 */
export declare class TemplateLibraryRequestError extends Error {
  /** HTTP 状态码：路由层直接用它回响应。 */
  status: number;
  constructor(message: string, status?: number);
}
/**
 * 扫描一张能力卡允许使用的固定分类。
 * @param options - `{ capability, capabilities, libraryRoot }`。
 * @returns 各分类的内置项、用户库项、错误与截断信息。
 */
export declare function scanTemplates({ capability, capabilities, libraryRoot }: {
  capability: string;
  capabilities?: readonly CapabilityLike[];
  libraryRoot?: string;
}): {
  capability: string;
  groups: CategoryScan[];
  library: {
    path: string;
    configured: boolean;
    present: boolean;
  };
  errors: string[];
  ok: boolean;
};
/**
 * 精确解析一项已保存选择。这里绝不枚举目录；只探测最终文件。
 * @param options - `{ selection, category, tool, libraryRoot, probe }`。
 */
export declare function resolveTemplateSelection({ selection, category, tool, libraryRoot, probe }?: {
  selection?: string;
  category: string;
  tool?: string;
  libraryRoot?: string;
  probe?: (path: string, kind?: string) => boolean;
}): Record<string, unknown>;
/**
 * 把旧版插件自带的平面模板路径规范化成稳定的分类模板 ID。
 * 用户自己的绝对路径、library: 选择和已经规范化的 builtin: ID 原样保留。
 */
export declare function canonicalTemplateSelection(selection: unknown, category: string): string;
//#endregion