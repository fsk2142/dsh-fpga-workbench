// AMD 官方 Vivado MCP 服务器的接入层。
//
// 它做什么:用户在「设置 → FPGA 开发模式 → Vivado MCP」里填了一个可执行文件路径,
// 这里就把 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 挂到本模式的作用域上,
// 于是这个模式的会话多出一组 `mcp__vivado__*` 工具(常驻 TCL 会话、批处理综合/实现、
// run 进度轮询、日志解析)。
//
// **为什么用程序化挂载,而不是在 cordis.patch.yml 里写一行 mcp-client**:
// MCP 行需要 `command`(可执行文件路径),而那是**用户设置**,存在 profile 的补丁里、
// 运行时才读得到;`!!js` 表达式在**加载期**求值,那时候设置还没解析出来。所以只能
// 在运行时读设置、再 `ctx.plugin()` 挂载。
//
// **许可证边界(重要,别越线)**:
//   · 那个 exe 由用户**自行**从 AMD 官网下载(需登录)。本仓库既不打包也不分发它 ——
//     其 LICENSE 第 3.2 条禁止向第三方分发 Licensed Materials。
//   · 第 2.1 条明确允许「用户选择的 AI agent 代表用户访问它」。本插件就是那个 agent,
//     所以我们只**存路径并调用**,这是被许可的用法。
//   · 本文件不解析、不拆解那个二进制的任何内容,只把它当黑盒 MCP 服务器启动。
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 设置里保存 MCP 可执行文件路径的字段名(与 toolchain.js 的 FIELDS 一致)。 */
export const MCP_PATH_KEY = "vivadoMcpPath";

/** 工具名前缀里用的服务器名;最终工具形如 `mcp__vivado__vivado_start`。 */
export const MCP_SERVER_NAME = "vivado";

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
  reconnect: { enabled: boolean; initialDelayMs: number; maxDelayMs: number; maxAttempts: number };
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
  fiber?: { ctx?: { baseUrl?: string } };
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
export function inspectMcpPath(path: unknown): McpPathInspection {
  const text = String(path ?? "").trim();
  if (text === "") return { ok: false, reason: "未设置" };
  let stat;
  try {
    stat = statSync(text);
  } catch {
    return { ok: false, reason: "路径不存在" };
  }
  if (!stat.isFile()) return { ok: false, reason: "不是文件" };
  return { ok: true, reason: "" };
}

/**
 * 把用户设置翻译成 mcp-client 的配置。
 *
 * `--stdio` 是那个服务器的原生 stdio 传输(实测它默认起 HTTP 服务,只有带这个参数才是
 * 我们需要的"由宿主拉起、生命周期跟着会话走"的形态)。
 * @param path - 已确认可用的可执行文件路径。
 * @returns mcp-client 的 Config 对象。
 */
export function mcpConfigFor(path: string): McpClientConfig {
  return {
    transport: "stdio",
    serverName: MCP_SERVER_NAME,
    command: path,
    args: ["--stdio"],
    // 启动失败**不**拒绝插件激活:用户可能先把路径填了、后来才装 Vivado。
    // 失败会记日志,其余功能照常可用。
    failOnStartupError: false,
    // 单次工具调用超时。综合/实现那类长命令由服务器自己做 handoff(它 5 分钟后返回
    // "status: running",之后靠 vivado_status 轮询),所以这里只要覆盖"一次普通 Tcl
    // 命令"的量级;设太大只会在真正卡死时白等。
    toolCallTimeoutMs: 10 * 60 * 1000,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 5 }
  };
}

/**
 * 每个 state 上挂一条串行链,保证 syncMcpClient 不会并发执行。
 *
 * 为什么必需(实测踩过,2026-10-21):用户连点两次保存、或者 `settings/document-updated`
 * 连续触发两次时,两次 syncMcpClient 会交错跑。第二次看到 `state.fiber === undefined`
 * 就去挂载,结果撞上 mcp-client 的 `serverName 已被占用` 而抛错,catch 里又把 state 清空 ——
 * **把第一次那份正确的 fiber 引用丢掉了**。之后清空路径时 `state.fiber` 已是 undefined,
 * `unload` 什么都不做,但那个 fiber 还活着并连着 MCP 服务器:
 * 工具留在工具表里(报告"未启用"却还能看到 11 个 `mcp__vivado__*`),服务器进程也不退。
 *
 * 用 WeakMap 挂在 state 上而不是模块级:每个调用方(每个预设作用域)各有各的链,互不阻塞。
 */
const syncChains = new WeakMap<McpMountState, Promise<void>>();

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
export async function syncMcpClient(
  ctx: McpContext,
  path: unknown,
  state: McpMountState,
  deps: McpDeps = {}
): Promise<string> {
  const previous = syncChains.get(state) ?? Promise.resolve();
  const run = () => syncMcpClientNow(ctx, path, state, deps);
  const current = previous.then(run, run);
  // 链上只关心"跑完了",不关心成败 —— 失败由 syncMcpClientNow 自己翻译成状态文案。
  syncChains.set(state, current.then(() => undefined, () => undefined));
  // ⚠️ 必须把结果归一成**字符串**再返回。
  // 直接 `return current` 时,若同步链里某处把一个 thenable(例如 fiber)当成结果漏出来,
  // 外层的 `await` 会再解析一次 —— 于是那个 thenable 的 `then` 被调用两次,挂载逻辑跑两遍,
  // 第二次撞上自己的 serverName 冲突。`String(...)` 把"意外漏出的对象"变成可读的文本,
  // 也保证这次 await 只消耗一个 Promise 层。
  const settled = await current;
  return typeof settled === "string" ? settled : String(settled ?? "");
}

/**
 * {@link syncMcpClient} 的实际工作;只在串行链里被调用,不需要再防并发。
 * @param ctx - 本模式作用域的插件上下文。
 * @param path - 用户设置的路径。
 * @param state - 调用方的状态对象。
 * @param deps - 可注入的依赖(见 {@link syncMcpClient})。
 * @returns 状态说明。
 */
async function syncMcpClientNow(
  ctx: McpContext,
  path: unknown,
  state: McpMountState,
  deps: McpDeps = {}
): Promise<string> {
  const inspect = deps.inspectMcpPath ?? inspectMcpPath;
  const wanted = String(path ?? "").trim();
  const inspection = inspect(wanted);

  // 要卸载:用户清空了路径,或者路径已经不可用。
  if (!inspection.ok) {
    // **N-04**：即便 `fiber` 已空，只要 `pendingDispose` 还在，也要试着清掉它。
    // 原实现只在 `fiber !== undefined` 时才 unload —— 残留就永远没人处理了。
    if (state.fiber !== undefined || state.pendingDispose !== undefined) {
      const result = await unload(state);
      if (!result.ok) {
        // 卸载失败：不能报「已停用」，要如实说「还挂着」
        return `停用失败（可能仍连接）:${result.reason ?? "dispose 报错"}`;
      }
      return inspection.reason === "未设置" ? "未启用" : `已停用(${inspection.reason})`;
    }
    return inspection.reason === "未设置" ? "未启用" : `不可用:${inspection.reason}`;
  }

  // 路径没变:什么都不做(避免每次保存设置都重启一次会话)。
  if (state.fiber !== undefined && state.path === wanted) return "已连接";

  const previousPath = state.path;

  // **N-04**：卸载没成功就**不许挂新的** —— 否则会出现两个 MCP 客户端抢同一个
  // serverName（第二个多半因为重名直接抛错，状态还更乱）。
  if (state.fiber !== undefined || state.pendingDispose !== undefined) {
    const result = await unload(state);
    if (!result.ok) {
      return `切换失败：旧会话未能卸载（${result.reason ?? "dispose 报错"}），已保留原连接状态`;
    }
  }

  // 拿 mcp-client 插件。它在**宿主**里,不在本插件的依赖里(它是 peer 性质的服务)。
  // 按包名直接 import 会失败:插件的代码住在 profile 的 node_modules 下,那里没有
  // @deepseek-ai/dsh-mcp-client,而宿主那层 profile 解析只路由给"宿主编排的插件",
  // 不管插件内部发起的动态 import(实测踩过:返回 ERR_MODULE_NOT_FOUND)。
  // 所以要**从宿主目录**把它取出来 —— 依次试几个可靠的位置。
  const loadClient = deps.loadHostMcpClient ?? loadHostMcpClient;
  const mcpClient = await loadClient(ctx);
  if (mcpClient === undefined) {
    return "宿主的 dsh-mcp-client 取不到 —— 这项能力不可用,其余功能照常";
  }
  if (typeof mcpClient?.apply !== "function") {
    return "宿主的 dsh-mcp-client 没有 apply —— 这项能力不可用,其余功能照常";
  }
  // 类型上 `plugin` 是可选的；运行时 Cordis 上下文一定有它。
  // 缺了它就是"这个作用域不支持挂插件"，如实报告而不是抛。
  if (typeof ctx.plugin !== "function") {
    return "当前上下文不能挂载 MCP 客户端 —— 这项能力不可用,其余功能照常";
  }

  /** Cordis 的 fiber：可 await、有 dispose。 */
  type FiberLike = { dispose?: () => Promise<unknown> } & PromiseLike<unknown>;
  let fiber: FiberLike | undefined;
  try {
    fiber = ctx.plugin(
      { name: "fpga-workbench-vivado-mcp", apply: mcpClient.apply, inject: mcpClient.inject, Config: mcpClient.Config },
      mcpConfigFor(wanted)
    ) as FiberLike;
    // **先记下再 await**:`await fiber` 可能抛(例如 serverName 撞车),那时 fiber 本身
    // 可能已经建出来并活着。旧写法在 catch 里只清 state 不 dispose,留下一个**活着的
    // fiber** —— 工具留在工具表里、服务器进程不退,而 state 已忘掉它,再也卸不掉。
    state.fiber = fiber;
    state.path = wanted;
    await fiber;
    return previousPath === undefined ? "已连接" : `已切换到 ${wanted}`;
  } catch (error) {
    // 失败时把已经建出来的 fiber 一并收掉，别留半活状态。
    //
    // **但 dispose 失败时不能清掉引用**（F-07 同族）：那样就再也拿不到它去重试，
    // 与「留下一个活着的 fiber」是同一个后果。留进 pendingDispose，下次 unload 会再试。
    let disposed = true;
    if (fiber !== undefined && typeof fiber.dispose === "function") {
      try {
        await fiber.dispose();
      } catch {
        // 见上：保留引用，交给 pendingDispose
        disposed = false;
      }
    }
    if (disposed) {
      state.fiber = undefined;
      state.path = undefined;
    } else {
      state.pendingDispose = fiber;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `启动失败:${message}`;
  }
}

/**
 * 从**宿主**里取出 `@deepseek-ai/dsh-mcp-client`。
 *
 * 为什么不能直接 `import("@deepseek-ai/dsh-mcp-client")`:本插件的代码住在 profile 的
 * `node_modules/dsh-fpga-workbench/` 下,从那里往上找不到 dsh-mcp-client(它装在宿主里,
 * 不是 profile 的依赖)。宿主那层 profile 解析只负责"编排进来的插件行",插件**内部**发起
 * 的动态 import 不在它的路由范围 —— 实测返回 `ERR_MODULE_NOT_FOUND`,而那时用户已经填好
 * 了路径、设置页却什么都不会发生。**这个功能曾经就是这样静默失效的。**
 *
 * 依次试这几个位置,全失败返回 undefined(调用方如实报告,不假装连上):
 *   1. `DSH_APP_DIR` —— 宿主显式告诉我们它在哪(桌面端会在 asar 内);
 *   2. 本插件自己的 `node_modules` —— 某些部署会把宿主包并列进来;
 *   3. 包名 —— 部署把宿主包暴露给插件时(例如 npm 全局安装的 headless 版)。
 * @param ctx - 插件上下文。
 * @returns 模块命名空间,或 undefined。
 */
async function loadHostMcpClient(ctx: McpContext): Promise<HostMcpClient | undefined> {
  for (const specifier of hostMcpClientSpecifiers(ctx)) {
    try {
      const loaded = (await import(specifier)) as {
        apply?: unknown;
        default?: { apply?: unknown };
      };
      if (typeof loaded?.apply === "function") return loaded as HostMcpClient;
      if (typeof loaded?.default?.apply === "function") return loaded.default as HostMcpClient;
    } catch {
      // 这个位置没有,试下一个
    }
  }
  return undefined;
}

/**
 * {@link loadHostMcpClient} 要试的模块说明符(按可信度排序)。
 * @param ctx - 插件上下文。
 * @returns 说明符数组。
 */
function hostMcpClientSpecifiers(ctx: McpContext): string[] {
  const out: string[] = [];
  const appDir = process.env.DSH_APP_DIR;
  if (typeof appDir === "string" && appDir !== "") {
    // 用 pathToFileURL 而不是手拼 file:// —— Windows 的盘符与反斜杠手拼必错。
    out.push(pathToFileURL(join(appDir, "node_modules", "@deepseek-ai", "dsh-mcp-client", "lib", "index.js")).href);
  }
  try {
    const base = ctx?.baseUrl ?? ctx?.fiber?.ctx?.baseUrl;
    if (typeof base === "string" && base.startsWith("file:")) {
      // baseUrl 指向本插件包根;宿主的包若与它并列,就在这里。
      //
      // ⚠️ 不能直接 `new URL("./node_modules/...", base)`:URL 解析依赖 base 的**结尾形式** ——
      // 以 `/` 结尾时是"目录",相对路径拼在它下面;不以 `/` 结尾时最后一段被当成**文件名**、
      // 会被整段替换掉。实测 `file:///C:/pkg` → `file:///C:/node_modules/...`(退到盘符根),
      // 于是这条候选永远找不到包、静默失效。所以先把 base 归一成目录形式再拼。
      const dir = base.endsWith("/") ? base : `${base}/`;
      out.push(new URL("node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js", dir).href);
      // 顺带试"本插件的 lib/ 下一层"——baseUrl 也可能指到某个入口文件
      out.push(new URL("../node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js", dir).href);
    }
  } catch {
    // baseUrl 拿不到就跳过这一条
  }
  out.push("@deepseek-ai/dsh-mcp-client");
  return out;
}

/**
 * 卸载当前挂载的 MCP 客户端,不抛异常。
 *
 * ## 为什么成功后才清状态（F-07）
 *
 * 原实现是**先把 `state.fiber` 清空、再 dispose**。dispose 抛错时那个 fiber 就丢了 ——
 * 后续「清空路径再重新保存」看到 `state.fiber === undefined`，**永远不会再试一次**。
 * 注释写的「下次保存会再试一次」与实际行为正好相反。
 *
 * 现在：dispose 成功才清 `fiber`；失败时把它留在一个**待重试**字段里，
 * 下一次 `unload` 会先重试那个残留的，再处理新的。
 *
 * ## N-04：返回值与「有残留就必须处理」
 *
 * 上一版仍有一个洞：`fiber` 被清空（例如切换失败）而 `pendingDispose` 还在时，
 * 调用方看到 `state.fiber === undefined` 就直接返回，**残留再也无人处理**。
 *
 * 所以这里：
 *   · 返回 `{ ok }` 让调用方知道卸载到底成不成；
 *   · 只要 `pendingDispose` 非空就**一定会尝试处理**（与 `fiber` 是否为空无关）；
 *   · 卸载失败时保留 `state.fiber`（不伪装成「已禁用」），让上层能显示真实状态。
 */
async function unload(state: McpMountState): Promise<{ ok: boolean; reason?: string }> {
  // ① 先处理上次没卸干净的 —— **不看 fiber 是否为空**，这是 N-04 的关键
  const pending = state.pendingDispose as { dispose?: () => Promise<unknown> } | undefined;
  if (pending !== undefined) {
    try {
      await pending.dispose?.();
      state.pendingDispose = undefined;
    } catch (error) {
      // 仍然失败：保留引用，且**明确报告失败** —— 上层不该以为已卸载
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const fiber = state.fiber as { dispose?: () => Promise<unknown> } | undefined;
  if (fiber === undefined) {
    state.path = undefined;
    return { ok: true };
  }

  if (typeof fiber.dispose !== "function") {
    state.fiber = undefined;
    state.path = undefined;
    return { ok: true };
  }

  try {
    await fiber.dispose();
    // **成功后才清**：失败时保留引用，下次还能重试
    state.fiber = undefined;
    state.path = undefined;
    state.pendingDispose = undefined;
    return { ok: true };
  } catch (error) {
    // 保留 fiber 引用（让上层能看到「仍然挂着」）并记进 pendingDispose 供下次重试。
    // 不抛：卸载失败不该让设置保存失败；但**返回 ok:false**，调用方据此决定要不要挂新的。
    state.pendingDispose = fiber;
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 供自检使用:路径填了但文件不在,是要报出来的一条。 */
export function mcpPathProblem(path: unknown): string | undefined {
  const inspection = inspectMcpPath(path);
  return inspection.ok || inspection.reason === "未设置" ? undefined : inspection.reason;
}
