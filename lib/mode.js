import { NS, describeEnv, probeFilesystem } from "./toolchain.js";
import { syncMcpClient } from "./mcp.js";
//#region src/mode.ts
/** 提示段名(全局唯一即可;只有本模式注册它)。 */
const SECTION = "fpga-workbench:toolchain";
/**
* 段落位置:紧随人设之后。
*
* dsh-system-prompt 的 SECTION_ORDERS 里人设是 0,工具说明从 1000(TOOL_BASH)起,
* 100 落在两者之间的空档 —— 这段是"环境事实",读在人设之后、工具规则之前。
*/
const ORDER = 100;
const name = "fpga-workbench-mode";
/** 只依赖提示注册表:Cordis 允许服务缺失时整行不激活,那也比挂载失败好。 */
const inject = ["systemPrompt"];
/**
* 读当前的设置值。
*
* 动态取服务而不是静态 inject:`settings` 拿不到时返回 undefined,由 describeEnv
* 如实说明"读不到值",而不是让本行不挂载。
* @param ctx - 本行的插件上下文。
* @returns 解析后的设置值,或 undefined。
*/
function readValues(ctx) {
	try {
		const settings = ctx.get("settings");
		if (typeof settings?.describe === "function") {
			const descriptor = settings.describe({ redactSecrets: true })?.find((entry) => entry?.ns === NS);
			if (descriptor?.value !== null && typeof descriptor?.value === "object") return descriptor.value;
		}
		return settings?.get?.(NS);
	} catch {
		return;
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
function sectionText(ctx) {
	try {
		return describeEnv(readValues(ctx), probeFilesystem);
	} catch (error) {
		try {
			ctx.logger?.warn?.(`fpga-workbench: 工具链提示段组装失败:${String(error)}`);
		} catch {}
		return "";
	}
}
/**
* 挂载模式半侧。
* @param ctx - 预设作用域内的插件上下文。
*/
function apply(ctx) {
	ctx.effect?.(() => ctx.systemPrompt?.section({
		name: SECTION,
		order: ORDER,
		text: () => sectionText(ctx)
	}), "fpga-workbench: toolchain section");
	const mcpState = {
		fiber: void 0,
		path: void 0
	};
	if (typeof ctx.on === "function") ctx.on("settings/document-updated", (ns) => {
		if (ns === void 0 || ns === "fpga-workbench") applyMcp(ctx, mcpState);
	});
	applyMcp(ctx, mcpState);
	ctx.effect?.(() => () => {
		syncMcpClient(ctx, "", mcpState);
	}, "fpga-workbench: vivado mcp teardown");
}
/**
* 读当前设置里的 MCP 路径并同步挂载状态。**不抛异常**。
* @param ctx - 预设作用域的插件上下文。
* @param state - 记住当前挂载的 fiber 与路径。
*/
async function applyMcp(ctx, state) {
	try {
		const values = readValues(ctx);
		const wanted = String(values?.["vivadoMcpPath"] ?? "").trim();
		if (wanted === state.path) return;
		const status = await syncMcpClient(ctx, wanted, state);
		if (wanted !== "" && status !== "已连接") ctx.logger?.info?.(`fpga-workbench: Vivado MCP ${status}`);
	} catch (error) {
		try {
			ctx.logger?.warn?.(`fpga-workbench: Vivado MCP 同步失败:${String(error)}`);
		} catch {}
	}
}
//#endregion
export { apply, inject, name };
