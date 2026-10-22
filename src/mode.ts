// 模式半侧:把「本机工具链」交给 **FPGA 开发模式** 的会话。
//
// 这一行只从 presets/fpga-workbench/agent.cordis.yml 挂载 —— 那是本预设自己的组装,
// 作用域是 agent 作用域,所以只有 FPGA 模式的会话能看到这段提示。插件行(lib/index.js)
// **刻意不注册**任何提示段:那层作用域是全局,普通会话也会看到 FPGA 工具链信息,与
// "不影响正常会话"冲突(见 README「关于提示注入」)。
//
// 为什么是提示段而不是一个工具:路径与调用姿势是这个模式的**背景事实**,每次会话都
// 用得上,而工具要靠模型想起来去调。真正的命令仍由 agent 用现有 shell 工具跑 —— 走
// 沙箱、输出可回看、能中断;这里不自己起进程,也就没有第二套超时与日志要维护。
//
// 取值路径:DSH 0.2.0 从 settings.describe() 的本插件 descriptor 读取解析后值;
// 旧版仍可用 settings.get(NS)。动态读取让设置改动在下一次提示组装时生效。

import { MCP_PATH_KEY, syncMcpClient } from "./mcp.js";
import { NS, describeEnv, probeFilesystem } from "./toolchain.js";

/** 提示段名(全局唯一即可;只有本模式注册它)。 */
const SECTION = "fpga-workbench:toolchain";

/**
 * 本文件用到的设置服务形状。
 *
 * 为什么自己声明而不引宿主的类型:这里刻意**动态**取服务(拿不到就退化成"读不到值"),
 * 所以只关心这两个方法存不存在,不关心宿主类型的完整形状。声明得越窄,宿主换版本时
 * 越不容易因为类型漂移而报错。
 */
interface SettingsLike {
  describe?: (options?: { redactSecrets?: boolean }) => ReadonlyArray<{ ns?: string; value?: unknown }> | undefined;
  get?: (ns: string) => unknown;
}

/** Cordis 上下文里本文件真正用到的那几个成员。 */
interface ModeContext {
  get: (name: string) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  effect?: (factory: () => unknown, label?: string) => unknown;
  inject?: (deps: string[], callback: (ctx: ModeContext) => void) => unknown;
  /** 提示注册表：本行只依赖它。 */
  systemPrompt?: {
    section: (options: { name: string; order: number; text: () => string }) => unknown;
  };
  /** 宿主注入的日志器（可选，连不上也不能因此崩）。 */
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  /** MCP 客户端上下文透传用（`syncMcpClient` 自己会识别形状）。 */
  [key: string]: unknown;
}

/** MCP 挂载状态：记住当前 fiber 与路径，避免重复起会话。 */
interface McpState {
  fiber: unknown;
  path: string | undefined;
}

/** 设置快照：一条 descriptor。 */
interface SettingsDescriptor {
  ns?: string;
  value?: unknown;
}

/**
 * 段落位置:紧随人设之后。
 *
 * dsh-system-prompt 的 SECTION_ORDERS 里人设是 0,工具说明从 1000(TOOL_BASH)起,
 * 100 落在两者之间的空档 —— 这段是"环境事实",读在人设之后、工具规则之前。
 */
const ORDER = 100;

export const name = "fpga-workbench-mode";

/** 只依赖提示注册表:Cordis 允许服务缺失时整行不激活,那也比挂载失败好。 */
export const inject = ["systemPrompt"];

/**
 * 读当前的设置值。
 *
 * 动态取服务而不是静态 inject:`settings` 拿不到时返回 undefined,由 describeEnv
 * 如实说明"读不到值",而不是让本行不挂载。
 * @param ctx - 本行的插件上下文。
 * @returns 解析后的设置值,或 undefined。
 */
function readValues(ctx: ModeContext): unknown {
  try {
    const settings = ctx.get("settings") as SettingsLike | undefined;
    if (typeof settings?.describe === "function") {
      const descriptor = settings
        .describe({ redactSecrets: true })
        ?.find((entry: SettingsDescriptor) => entry?.ns === NS);
      if (descriptor?.value !== null && typeof descriptor?.value === "object") return descriptor.value;
    }
    return settings?.get?.(NS);
  } catch {
    return undefined;
  }
}

/**
 * 组装这段提示。**绝不向外抛异常**。
 *
 * text 是每次组装提示时调用的,它一抛,可能连累这个会话的每一次请求。而这段内容只是
 * 环境信息、不是正确性的一部分 —— 出问题就退化成空(段落为空会被丢掉),同时留一条日志。
 * 静默降级在这里是对的:另一种选择是整个会话用不了。
 * @param ctx - 预设作用域内的插件上下文。
 * @returns 提示段正文,失败时为空串。
 */
function sectionText(ctx: ModeContext): string {
  try {
    // `readValues` 返回 unknown（设置形状不可信）；`describeEnv` 只读字符串字段，
    // 传空对象等价于"什么都没配"，与旧行为一致。
    return describeEnv((readValues(ctx) ?? {}) as Record<string, unknown>, probeFilesystem);
  } catch (error) {
    try {
      ctx.logger?.warn?.(`fpga-workbench: 工具链提示段组装失败:${String(error)}`);
    } catch {
      // 连日志都失败就算了,不能因此让会话崩掉
    }
    return "";
  }
}

/**
 * 挂载模式半侧。
 * @param ctx - 预设作用域内的插件上下文。
 */
export function apply(ctx: ModeContext): void {
  // text 传函数:每次组装提示时重新取值,用户在设置页改完路径立刻生效,不用重启会话。
  ctx.effect?.(
    () =>
      ctx.systemPrompt?.section({
        name: SECTION,
        order: ORDER,
        text: () => sectionText(ctx)
      }),
    "fpga-workbench: toolchain section"
  );

  // AMD 官方 Vivado MCP(可选):设置里填了 exe 路径就挂一个 mcp-client 上来,
  // 于是本模式的会话多出 `mcp__vivado__*` 一组工具。路径为空就什么都不做。
  //
  // 为什么挂在这里而不是插件行:工具要**只对本模式可见** —— 挂到插件行会变成全局,
  // 普通会话也会看到一组 Vivado 工具。
  //
  // 设置是运行时值,`!!js` 在加载期求值读不到它,所以只能在这里读设置再动态挂载
  // (细节见 lib/mcp.js 的文件头)。
  const mcpState: McpState = { fiber: undefined, path: undefined };
  // `settings/document-updated` 是宿主设置服务在 describe() 发现变更时发出的事件
  // (见 dsh-settings 的 describe 实现)。保存本插件的设置会让它触发一次,于是这里
  // 重新读一遍路径 —— 改了路径不必重启,清空了就卸载。
  if (typeof ctx.on === "function") {
    ctx.on("settings/document-updated", (ns: unknown) => {
      if (ns === undefined || ns === NS) void applyMcp(ctx, mcpState);
    });
  }
  // 首次挂载:不 await,避免拖慢预设激活;连上了会在下一次工具列表刷新时出现。
  void applyMcp(ctx, mcpState);
  ctx.effect?.(
    () => () => {
      void syncMcpClient(ctx as never, "", mcpState as never);
    },
    "fpga-workbench: vivado mcp teardown"
  );
}

/**
 * 读当前设置里的 MCP 路径并同步挂载状态。**不抛异常**。
 * @param ctx - 预设作用域的插件上下文。
 * @param state - 记住当前挂载的 fiber 与路径。
 */
async function applyMcp(ctx: ModeContext, state: McpState): Promise<void> {
  try {
    const values = readValues(ctx);
    const wanted = String((values as Record<string, unknown> | undefined)?.[MCP_PATH_KEY] ?? "").trim();
    if (wanted === state.path) return; // 没变:不重启 MCP 会话
    const status = await syncMcpClient(ctx as never, wanted, state as never);
    if (wanted !== "" && status !== "已连接") {
      ctx.logger?.info?.(`fpga-workbench: Vivado MCP ${status}`);
    }
  } catch (error) {
    try {
      ctx.logger?.warn?.(`fpga-workbench: Vivado MCP 同步失败:${String(error)}`);
    } catch {
      // 连日志都失败就算了,不能因此让会话崩掉
    }
  }
}
