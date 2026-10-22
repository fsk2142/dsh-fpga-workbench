//#region src/template-library.d.ts
/** 单个分类最多返回的用户模板数。超过时停止继续收集并明确标记。 */
export declare const MAX_TEMPLATES_PER_CATEGORY = 500;
/** 插件自带的分类模板根；由 import.meta.url 定位，不受工作目录影响。 */
export declare const BUNDLED_TEMPLATE_ROOT: string;
/**
 * 固定模板分类。directory 同时决定内置相对路径与用户库目录，不接受请求方自定义目录。
 * 数组顺序只用于界面稳定展示，不表示执行顺序。
 */
export declare const TEMPLATE_CATEGORIES: {
  key: string;
  label: string;
  directory: string;
  extensions: string[];
}[];
/**
 * 内置模板。compatibleTools 中的 "*" 表示与具体工具无关；其余项只对明确工具适配。
 * auto 尚未决定具体工具，因此可以看到候选默认；显式 Quartus / 自定义工具则不会误用 Vivado/ModelSim 脚本。
 */
export declare const BUILTIN_TEMPLATES: {
  id: any;
  category: any;
  label: any;
  relativePath: any;
  compatibleTools: any;
}[];
/** 带 HTTP 建议状态的输入错误；宿主接口据此返回非 2xx。 */
export declare class TemplateLibraryRequestError extends Error {
  constructor(message: any, status?: number);
}
/**
 * 扫描一张能力卡允许使用的固定分类。
 * @param options - `{ capability, capabilities, libraryRoot }`。
 * @returns 各分类的内置项、用户库项、错误与截断信息。
 */
export declare function scanTemplates({ capability, capabilities, libraryRoot }: {
  capabilities: any;
  capability: any;
  libraryRoot?: string | undefined;
}): {
  capability: any;
  groups: {
    key: any;
    label: any;
    directory: any;
    items: any[];
    builtinCount: number;
    libraryCount: number;
    truncated: boolean;
    errors: any[];
  }[];
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
  libraryRoot?: string | undefined;
  selection?: string | undefined;
  tool?: string | undefined;
}): {
  id: string;
  selection: string;
  category: any;
  label: string;
  path: string;
  source: string;
  state: string;
  present: boolean;
  default: boolean;
  summary: string;
} | {
  id: any;
  category: any;
  label: any;
  relativePath: any;
  compatibleTools: any;
  selection: string;
  summary: any;
  path: string;
  source: string;
  state: string;
  present: boolean;
  default: boolean;
  warning: string | undefined;
} | {
  selection: string;
  summary: any;
  id: string;
  category: any;
  label: string;
  path: string;
  source: string;
  state: any;
  present: boolean;
  default: boolean;
  warning: any;
} | {
  id: any;
  selection: any;
  category: any;
  label: any;
  relativePath: any;
  path: string;
  source: string;
  state: string;
  present: boolean;
  default: boolean;
  summary: string;
  warning: string | undefined;
};
/**
 * 把旧版插件自带的平面模板路径规范化成稳定的分类模板 ID。
 * 用户自己的绝对路径、library: 选择和已经规范化的 builtin: ID 原样保留。
 */
export declare function canonicalTemplateSelection(selection: any, category: any): any;
//#endregion