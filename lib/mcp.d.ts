/** 设置里保存 MCP 可执行文件路径的字段名(与 toolchain.js 的 FIELDS 一致)。 */
export declare const MCP_PATH_KEY = "vivadoMcpPath";
/** 工具名前缀里用的服务器名;最终工具形如 `mcp__vivado__vivado_start`。 */
export declare const MCP_SERVER_NAME = "vivado";
/** 路径检查结果。`ok` 为 false 时 `reason` 是给人看的一句话。 */
interface McpPathInspection {
  ok: boolean;
  reason: string;
}
/** 传给宿主 mcp-client 的配置形状（只列本插件用到的字段）。 */
interface McpClientConfig {
  transport: "stdio";
  serverName: string;
  command: string;
  args: string[];
  failOnStartupError: boolean;
  toolCallTimeoutMs: number;
  reconnect: {
    enabled: boolean;
    initialDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
  };
}
/** 挂载状态：记住当前 fiber 与路径。 */
interface McpMountState {
  fiber: unknown;
  path: string | undefined;
  /**
   * 上次 dispose 失败留下的 fiber，下次 unload 先重试它（F-07）。
   *
   * 为什么要单独一个字段：`fiber` 是「当前挂着的」，`pendingDispose` 是「已决定卸但没卸掉的」。
   * 混用一个字段时，失败那次会把引用清掉，后续再也拿不到它去重试。
   */
  pendingDispose: unknown;
}
/** 宿主 mcp-client 模块的最小形状（`apply` / `inject` / `Config`）。 */
interface HostMcpClient {
  apply?: (...args: unknown[]) => unknown;
  inject?: unknown;
  Config?: unknown;
}
/** 可注入依赖（自检用；生产调用不传）。 */
interface McpDeps {
  inspectMcpPath?: (path: unknown) => McpPathInspection;
  loadHostMcpClient?: (ctx: unknown) => Promise<HostMcpClient | undefined>;
}
/** Cordis 上下文里本文件用到的那几个成员。 */
interface McpContext {
  plugin?: (spec: unknown, config: unknown) => unknown;
  baseUrl?: string;
  fiber?: {
    ctx?: {
      baseUrl?: string;
    };
  };
  [key: string]: unknown;
}
/**
 * 判断一个路径看起来是不是可用的 MCP 服务器可执行文件。
 *
 * 只做"文件在不在、是不是文件"这种事实判断 —— **不探测版本、不执行它**。
 * 真正的连通性由 DSH 的 mcp-client 在挂载时自己建立,失败会记日志,不拖垮插件。
 * @param path - 用户填的路径。
 * @returns `{ ok, reason }`;`ok` 为 false 时 `reason` 是给人看的一句话。
 */
export declare function inspectMcpPath(path: unknown): McpPathInspection;
/**
 * 把用户设置翻译成 mcp-client 的配置。
 *
 * `--stdio` 是那个服务器的原生 stdio 传输(实测它默认起 HTTP 服务,只有带这个参数才是
 * 我们需要的"由宿主拉起、生命周期跟着会话走"的形态)。
 * @param path - 已确认可用的可执行文件路径。
 * @returns mcp-client 的 Config 对象。
 */
export declare function mcpConfigFor(path: string): McpClientConfig;
/**
 * 在当前上下文里挂载/更新/卸载 MCP 客户端。
 *
 * 用一个 fiber 记录当前挂载:路径变了就换一个,清空了就卸载。**幂等** —— 设置保存会
 * 反复触发它,同一条路径不会重复挂载。**串行** —— 同一 state 上的调用排队执行,
 * 避免并发时互相踩掉对方记下的 fiber(见 {@link syncChains})。
 *
 * @param ctx - 本模式作用域的插件上下文。
 * @param path - 用户设置的路径(可以是空串)。
 * @param state - 调用方持有的状态对象(用来记住上一次挂载的东西)。
 * @param deps - 可注入的依赖(只为自检用;生产调用不传)。
 *   `{ inspectMcpPath, loadHostMcpClient }` —— 让测试能不打真宿主就覆盖挂载/卸载流程。
 * @returns 一条给人看的状态说明。
 */
export declare function syncMcpClient(ctx: McpContext, path: unknown, state: McpMountState, deps?: McpDeps): Promise<string>;
/** 供自检使用:路径填了但文件不在,是要报出来的一条。 */
export declare function mcpPathProblem(path: unknown): string | undefined;
export {};