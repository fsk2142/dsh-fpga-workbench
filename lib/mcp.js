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

/**
 * 判断一个路径看起来是不是可用的 MCP 服务器可执行文件。
 *
 * 只做"文件在不在、是不是文件"这种事实判断 —— **不探测版本、不执行它**。
 * 真正的连通性由 DSH 的 mcp-client 在挂载时自己建立,失败会记日志,不拖垮插件。
 * @param path - 用户填的路径。
 * @returns `{ ok, reason }`;`ok` 为 false 时 `reason` 是给人看的一句话。
 */
export function inspectMcpPath(path) {
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
export function mcpConfigFor(path) {
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
 * 在当前上下文里挂载/更新/卸载 MCP 客户端。
 *
 * 用一个 fiber 记录当前挂载:路径变了就换一个,清空了就卸载。**幂等** —— 设置保存会
 * 反复触发它,同一条路径不会重复挂载。
 * @param ctx - 本模式作用域的插件上下文。
 * @param path - 用户设置的路径(可以是空串)。
 * @param state - 调用方持有的状态对象(用来记住上一次挂载的东西)。
 * @returns 一条给人看的状态说明。
 */
export async function syncMcpClient(ctx, path, state) {
  const wanted = String(path ?? "").trim();
  const inspection = inspectMcpPath(wanted);

  // 要卸载:用户清空了路径,或者路径已经不可用。
  if (!inspection.ok) {
    if (state.fiber !== undefined) {
      await unload(state);
      return inspection.reason === "未设置" ? "未启用" : `已停用(${inspection.reason})`;
    }
    return inspection.reason === "未设置" ? "未启用" : `不可用:${inspection.reason}`;
  }

  // 路径没变:什么都不做(避免每次保存设置都重启一次会话)。
  if (state.fiber !== undefined && state.path === wanted) return "已连接";

  const previous = state.fiber;
  const previousPath = state.path;
  state.fiber = undefined;
  state.path = undefined;
  if (previous !== undefined) await unload(state);

  // 拿 mcp-client 插件。它在**宿主**里,不在本插件的依赖里(它是 peer 性质的服务)。
  // 按包名直接 import 会失败:插件的代码住在 profile 的 node_modules 下,那里没有
  // @deepseek-ai/dsh-mcp-client,而宿主那层 profile 解析只路由给"宿主编排的插件",
  // 不管插件内部发起的动态 import(实测踩过:返回 ERR_MODULE_NOT_FOUND)。
  // 所以要**从宿主目录**把它取出来 —— 依次试几个可靠的位置。
  const mcpClient = await loadHostMcpClient(ctx);
  if (mcpClient === undefined) {
    return "宿主的 dsh-mcp-client 取不到 —— 这项能力不可用,其余功能照常";
  }
  if (typeof mcpClient?.apply !== "function") {
    return "宿主的 dsh-mcp-client 没有 apply —— 这项能力不可用,其余功能照常";
  }

  try {
    const fiber = ctx.plugin(
      { name: "fpga-workbench-vivado-mcp", apply: mcpClient.apply, inject: mcpClient.inject, Config: mcpClient.Config },
      mcpConfigFor(wanted)
    );
    state.fiber = fiber;
    state.path = wanted;
    // await 让"连上了没"反映在返回值里;连不上也不抛(见 failOnStartupError: false)。
    await fiber;
    return previousPath === undefined ? "已连接" : `已切换到 ${wanted}`;
  } catch (error) {
    state.fiber = undefined;
    state.path = undefined;
    return `启动失败:${String(error?.message ?? error)}`;
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
async function loadHostMcpClient(ctx) {
  for (const specifier of hostMcpClientSpecifiers(ctx)) {
    try {
      const loaded = await import(specifier);
      if (typeof loaded?.apply === "function") return loaded;
      if (typeof loaded?.default?.apply === "function") return loaded.default;
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
function hostMcpClientSpecifiers(ctx) {
  const out = [];
  const appDir = process.env.DSH_APP_DIR;
  if (typeof appDir === "string" && appDir !== "") {
    // 用 pathToFileURL 而不是手拼 file:// —— Windows 的盘符与反斜杠手拼必错。
    out.push(pathToFileURL(join(appDir, "node_modules", "@deepseek-ai", "dsh-mcp-client", "lib", "index.js")).href);
  }
  try {
    const base = ctx?.baseUrl ?? ctx?.fiber?.ctx?.baseUrl;
    if (typeof base === "string" && base.startsWith("file:")) {
      // baseUrl 指向本插件包根;宿主的包若与它并列,就在这里。
      out.push(new URL("./node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js", base).href);
    }
  } catch {
    // baseUrl 拿不到就跳过这一条
  }
  out.push("@deepseek-ai/dsh-mcp-client");
  return out;
}

/** 卸载当前挂载的 MCP 客户端,不抛异常。 */
async function unload(state) {  const fiber = state.fiber;
  state.fiber = undefined;
  state.path = undefined;
  if (fiber === undefined) return;
  try {
    await fiber.dispose();
  } catch {
    // 卸载失败不该影响设置保存;下次保存会再试一次
  }
}

/**
 * 这个路径是否值得让设置页显示"已就绪"。
 * 与 {@link inspectMcpPath} 同义,单独导出是为了设置页那边读起来更像状态而不是校验。
 * @param path - 用户填的路径。
 * @returns 布尔。
 */
export function mcpPathReady(path) {
  return inspectMcpPath(path).ok;
}

/** 供自检使用:路径填了但文件不在,是要报出来的一条。 */
export function mcpPathProblem(path) {
  const inspection = inspectMcpPath(path);
  return inspection.ok || inspection.reason === "未设置" ? undefined : inspection.reason;
}
