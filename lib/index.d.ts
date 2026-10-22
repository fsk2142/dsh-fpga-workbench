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
export declare function apply(ctx: any, config: any): void;
export declare const name = "fpga-workbench";
export declare const inject: string[];
//#endregion
export { NS, legacyMigrationPatch, statusOf };