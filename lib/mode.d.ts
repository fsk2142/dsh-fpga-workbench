/** Cordis 上下文里本文件真正用到的那几个成员。 */
interface ModeContext {
  get: (name: string) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  effect?: (factory: () => unknown, label?: string) => unknown;
  inject?: (deps: string[], callback: (ctx: ModeContext) => void) => unknown;
  /** 提示注册表：本行只依赖它。 */
  systemPrompt?: {
    section: (options: {
      name: string;
      order: number;
      text: () => string;
    }) => unknown;
  };
  /** 宿主注入的日志器（可选，连不上也不能因此崩）。 */
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  /** MCP 客户端上下文透传用（`syncMcpClient` 自己会识别形状）。 */
  [key: string]: unknown;
}
export declare const name = "fpga-workbench-mode";
/** 只依赖提示注册表:Cordis 允许服务缺失时整行不激活,那也比挂载失败好。 */
export declare const inject: string[];
/**
 * 挂载模式半侧。
 * @param ctx - 预设作用域内的插件上下文。
 */
export declare function apply(ctx: ModeContext): void;
export {};