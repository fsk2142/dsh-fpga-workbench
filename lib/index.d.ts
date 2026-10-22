import { NS, legacyMigrationPatch, statusOf } from "./toolchain.js";
import z from "@deepseek-ai/schemastery";
//#region src/index.d.ts
/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export declare const STATUS_PATH = "/plugins/fpga-workbench/toolchain";
/** 设置页「浏览…」列目录的路由(弹不出系统对话框时的备选)。与 lib/client.js 里的常量必须一致。 */
export declare const BROWSE_PATH = "/plugins/fpga-workbench/browse";
/** 设置页「检测本机工具」的路由。与 lib/client.js 里的常量必须一致。 */
export declare const DETECT_PATH = "/plugins/fpga-workbench/detect";
/** 能力卡展开时读取分类模板的只读路由。与 lib/client.js 里的常量必须一致。 */
export declare const TEMPLATE_PATH = "/plugins/fpga-workbench/templates";
/** 设置页保存本插件配置的路由。与 lib/client.js 里的常量必须一致。 */
export declare const SETTINGS_PATH = "/plugins/fpga-workbench/settings";
/** 设置页「运行自检」的只读路由。与 lib/client.js 里的常量必须一致。 */
export declare const SELFCHECK_PATH = "/plugins/fpga-workbench/selfcheck";
/**
 * 设置页「检查更新」的路由。与 lib/client.js 里的常量必须一致。
 *
 * 它**不会**在插件启动时被调用,也不会被定时器调用:这是唯一会离开本机的请求,
 * 必须由用户点一下才发生。
 */
export declare const UPDATE_PATH = "/plugins/fpga-workbench/update";
/** 设置页读版本信息(本插件版本 + 兼容的 DSH 版本)的只读路由。不发网络请求。 */
export declare const VERSION_PATH = "/plugins/fpga-workbench/version";
/** 本文件用到的 HTTP 请求/响应形状（只列真正访问的成员）。 */
interface HttpRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  setEncoding?: (encoding: string) => void;
  /** Node 的 IncomingMessage 一定有 on —— 标必选，调用处不必判空。 */
  on: (event: string, listener: (...args: never[]) => void) => void;
  /**
   * 直接掐断这条连接（可选：`IncomingMessage` 有，但测试替身不一定给）。
   *
   * 请求体超限时必须用它 —— 只 `reject` 的话对端还会继续灌数据，
   * 而 `data` 监听器仍在拼字符串，进程内存会无界增长。
   */
  destroy?: () => void;
  removeAllListeners?: (event?: string) => void;
  pause?: () => void;
}
/** `json()` 目标：`res.writeHead` + `res.end` 就够了。 */
interface HttpResponse {
  writeHead: (status: number, headers?: Record<string, string>) => unknown;
  end: (body?: string) => unknown;
}
/** 宿主的 webServer 服务（只列本插件用到的两种注册）。 */
interface WebServerLike {
  register: (options: {
    kind: string;
    path: string;
    handler: (req: HttpRequest, res: HttpResponse) => unknown;
  }) => unknown;
}
/** Cordis 上下文里本文件用到的成员。 */
interface HostContext {
  get: (name: string) => unknown;
  /** Cordis 契约：上下文一定有 inject / effect / on（可选的是"服务"，不是这几个方法）。 */
  inject: (deps: string[], callback: (ctx: HostContext) => void) => unknown;
  effect: (factory: () => unknown, label?: string) => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  /** webServer 只在带 Web 的宿主里存在，所以它是可选的（缺了只是少一个设置页）。 */
  webServer?: WebServerLike;
  baseUrl?: string;
  fiber?: unknown;
  [key: string]: unknown;
}
/**
 * 设置 schema:每个字段一个字符串。
 *
 * 默认值来自字段定义 —— 下拉字段(语言/标准/仿真器)有非空默认值,路径字段默认空。
 * 下拉的默认值必须与选项对齐,否则 statusOf 会把它报成"取值不在选项里"。
 *
 * 每个字段都必须是 volatile:DSH 0.1.7 的 settings 服务只允许写 volatile 字段,
 * 且 describe() 只列出带 volatile 字段的行。普通字段会在保存时被直接拒绝。
 */
export declare const SettingsSchema: z<Schemastery.ObjectS<any>, Schemastery.ObjectT<any>, "plain">;
/**
 * DSH 0.1.7+ 的 Loader 行 schema 导出名。
 *
 * 旧版本由 `settings.register(NS, ...)` 注册命名空间;新版本改为从插件导出的
 * `Config` 派生本行的设置表单,再由 settings 服务的 `describe/update` 读写。
 */
export declare const Config: z<Schemastery.ObjectS<any>, Schemastery.ObjectT<any>, "plain">;
/**
 * 挂载宿主半侧。
 * @param {object} ctx - host plugin context carrying `settings`.
 * @param {Record<string, unknown>} [config] - Loader 传入的本行配置。
 */
export declare function apply(ctx: HostContext, config?: Record<string, unknown>): void;
export declare const name = "fpga-workbench";
export declare const inject: string[];
//#endregion
export { NS, legacyMigrationPatch, statusOf };