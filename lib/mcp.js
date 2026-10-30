import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// src/mcp.ts
/** 设置里保存 MCP 可执行文件路径的字段名(与 toolchain.js 的 FIELDS 一致)。 */
const MCP_PATH_KEY = "vivadoMcpPath";
/** 工具名前缀里用的服务器名;最终工具形如 `mcp__vivado__vivado_start`。 */
const MCP_SERVER_NAME = "vivado";
/**
* 判断一个路径看起来是不是可用的 MCP 服务器可执行文件。
*
* 只做"文件在不在、是不是文件"这种事实判断 —— **不探测版本、不执行它**。
* 真正的连通性由 DSH 的 mcp-client 在挂载时自己建立,失败会记日志,不拖垮插件。
* @param path - 用户填的路径。
* @returns `{ ok, reason }`;`ok` 为 false 时 `reason` 是给人看的一句话。
*/
function inspectMcpPath(path) {
	const text = String(path ?? "").trim();
	if (text === "") return {
		ok: false,
		reason: "未设置"
	};
	let stat;
	try {
		stat = statSync(text);
	} catch {
		return {
			ok: false,
			reason: "路径不存在"
		};
	}
	if (!stat.isFile()) return {
		ok: false,
		reason: "不是文件"
	};
	return {
		ok: true,
		reason: ""
	};
}
/**
* 把用户设置翻译成 mcp-client 的配置。
*
* `--stdio` 是那个服务器的原生 stdio 传输(实测它默认起 HTTP 服务,只有带这个参数才是
* 我们需要的"由宿主拉起、生命周期跟着会话走"的形态)。
* @param path - 已确认可用的可执行文件路径。
* @returns mcp-client 的 Config 对象。
*/
function mcpConfigFor(path) {
	return {
		transport: "stdio",
		serverName: MCP_SERVER_NAME,
		command: path,
		args: ["--stdio"],
		failOnStartupError: false,
		toolCallTimeoutMs: 6e5,
		reconnect: {
			enabled: true,
			initialDelayMs: 500,
			maxDelayMs: 3e4,
			maxAttempts: 5
		}
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
const syncChains = /* @__PURE__ */ new WeakMap();
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
async function syncMcpClient(ctx, path, state, deps = {}) {
	const previous = syncChains.get(state) ?? Promise.resolve();
	const run = () => syncMcpClientNow(ctx, path, state, deps);
	const current = previous.then(run, run);
	syncChains.set(state, current.then(() => void 0, () => void 0));
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
async function syncMcpClientNow(ctx, path, state, deps = {}) {
	const inspect = deps.inspectMcpPath ?? inspectMcpPath;
	const wanted = String(path ?? "").trim();
	const inspection = inspect(wanted);
	if (!inspection.ok) {
		if (state.fiber !== void 0 || state.pendingDispose !== void 0) {
			const result = await unload(state);
			if (!result.ok) return `停用失败（可能仍连接）:${result.reason ?? "dispose 报错"}`;
			return inspection.reason === "未设置" ? "未启用" : `已停用(${inspection.reason})`;
		}
		return inspection.reason === "未设置" ? "未启用" : `不可用:${inspection.reason}`;
	}
	if (state.fiber !== void 0 && state.path === wanted) return "已连接";
	const previousPath = state.path;
	if (state.fiber !== void 0 || state.pendingDispose !== void 0) {
		const result = await unload(state);
		if (!result.ok) return `切换失败：旧会话未能卸载（${result.reason ?? "dispose 报错"}），已保留原连接状态`;
	}
	const mcpClient = await (deps.loadHostMcpClient ?? loadHostMcpClient)(ctx);
	if (mcpClient === void 0) return "宿主的 dsh-mcp-client 取不到 —— 这项能力不可用,其余功能照常";
	if (typeof mcpClient?.apply !== "function") return "宿主的 dsh-mcp-client 没有 apply —— 这项能力不可用,其余功能照常";
	if (typeof ctx.plugin !== "function") return "当前上下文不能挂载 MCP 客户端 —— 这项能力不可用,其余功能照常";
	let fiber;
	try {
		fiber = ctx.plugin({
			name: "fpga-workbench-vivado-mcp",
			apply: mcpClient.apply,
			inject: mcpClient.inject,
			Config: mcpClient.Config
		}, mcpConfigFor(wanted));
		state.fiber = fiber;
		state.path = wanted;
		await fiber;
		return previousPath === void 0 ? "已连接" : `已切换到 ${wanted}`;
	} catch (error) {
		let disposed = true;
		if (fiber !== void 0 && typeof fiber.dispose === "function") try {
			await fiber.dispose();
		} catch {
			disposed = false;
		}
		if (disposed) {
			state.fiber = void 0;
			state.path = void 0;
		} else state.pendingDispose = fiber;
		return `启动失败:${error instanceof Error ? error.message : String(error)}`;
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
	for (const specifier of hostMcpClientSpecifiers(ctx)) try {
		const loaded = await import(specifier);
		if (typeof loaded?.apply === "function") return loaded;
		if (typeof loaded?.default?.apply === "function") return loaded.default;
	} catch {}
}
/**
* {@link loadHostMcpClient} 要试的模块说明符(按可信度排序)。
* @param ctx - 插件上下文。
* @returns 说明符数组。
*/
function hostMcpClientSpecifiers(ctx) {
	const out = [];
	const appDir = process.env.DSH_APP_DIR;
	if (typeof appDir === "string" && appDir !== "") out.push(pathToFileURL(join(appDir, "node_modules", "@deepseek-ai", "dsh-mcp-client", "lib", "index.js")).href);
	try {
		const base = ctx?.baseUrl ?? ctx?.fiber?.ctx?.baseUrl;
		if (typeof base === "string" && base.startsWith("file:")) {
			const dir = base.endsWith("/") ? base : `${base}/`;
			out.push(new URL("node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js", dir).href);
			out.push(new URL("../node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js", dir).href);
		}
	} catch {}
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
async function unload(state) {
	const pending = state.pendingDispose;
	if (pending !== void 0) try {
		await pending.dispose?.();
		state.pendingDispose = void 0;
		state.path = void 0;
		if (state.fiber === pending) {
			state.fiber = void 0;
			return { ok: true };
		}
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error)
		};
	}
	const fiber = state.fiber;
	if (fiber === void 0) {
		state.path = void 0;
		return { ok: true };
	}
	if (typeof fiber.dispose !== "function") {
		state.fiber = void 0;
		state.path = void 0;
		return { ok: true };
	}
	try {
		await fiber.dispose();
		state.fiber = void 0;
		state.path = void 0;
		state.pendingDispose = void 0;
		return { ok: true };
	} catch (error) {
		state.pendingDispose = fiber;
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}
/** 供自检使用:路径填了但文件不在,是要报出来的一条。 */
function mcpPathProblem(path) {
	const inspection = inspectMcpPath(path);
	return inspection.ok || inspection.reason === "未设置" ? void 0 : inspection.reason;
}
export { MCP_PATH_KEY, MCP_SERVER_NAME, inspectMcpPath, mcpConfigFor, mcpPathProblem, syncMcpClient };
