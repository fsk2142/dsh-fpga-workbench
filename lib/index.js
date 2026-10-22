import { scanTemplates } from "./template-library.js";
import { CAPABILITIES, FIELDS, NS, clearProbeCache, detectTools, legacyMigrationPatch, listDirectory, statusOf } from "./toolchain.js";
import { runSelfCheck } from "./selfcheck.js";
import { checkForUpdateWithCookie, packageInfo } from "./version.js";
import z from "@deepseek-ai/schemastery";
// src/index.ts
/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
const STATUS_PATH = "/plugins/fpga-workbench/toolchain";
/** 设置页「浏览…」列目录的路由(弹不出系统对话框时的备选)。与 lib/client.js 里的常量必须一致。 */
const BROWSE_PATH = "/plugins/fpga-workbench/browse";
/** 设置页「检测本机工具」的路由。与 lib/client.js 里的常量必须一致。 */
const DETECT_PATH = "/plugins/fpga-workbench/detect";
/** 能力卡展开时读取分类模板的只读路由。与 lib/client.js 里的常量必须一致。 */
const TEMPLATE_PATH = "/plugins/fpga-workbench/templates";
/** 设置页保存本插件配置的路由。与 lib/client.js 里的常量必须一致。 */
const SETTINGS_PATH = "/plugins/fpga-workbench/settings";
/** 设置页「运行自检」的只读路由。与 lib/client.js 里的常量必须一致。 */
const SELFCHECK_PATH = "/plugins/fpga-workbench/selfcheck";
/**
* 设置页「检查更新」的路由。与 lib/client.js 里的常量必须一致。
*
* 它**不会**在插件启动时被调用,也不会被定时器调用:这是唯一会离开本机的请求,
* 必须由用户点一下才发生。
*/
const UPDATE_PATH = "/plugins/fpga-workbench/update";
/** 设置页读版本信息(本插件版本 + 兼容的 DSH 版本)的只读路由。不发网络请求。 */
const VERSION_PATH = "/plugins/fpga-workbench/version";
/**
* 设置 schema:每个字段一个字符串。
*
* 默认值来自字段定义 —— 下拉字段(语言/标准/仿真器)有非空默认值,路径字段默认空。
* 下拉的默认值必须与选项对齐,否则 statusOf 会把它报成"取值不在选项里"。
*
* 每个字段都必须是 volatile:DSH 0.1.7 的 settings 服务只允许写 volatile 字段,
* 且 describe() 只列出带 volatile 字段的行。普通字段会在保存时被直接拒绝。
*/
const SettingsSchema = z.object(Object.fromEntries(FIELDS.map((field) => {
	const fallback = "default" in field ? String(field.default ?? "") : "";
	return [field.key, z.string().default(fallback).volatile()];
})));
/**
* DSH 0.1.7+ 的 Loader 行 schema 导出名。
*
* 旧版本由 `settings.register(NS, ...)` 注册命名空间;新版本改为从插件导出的
* `Config` 派生本行的设置表单,再由 settings 服务的 `describe/update` 读写。
*/
const Config = SettingsSchema;
/** 记一条日志;没有 logger 就退回 console。 */
function note(ctx, level, message) {
	try {
		const logger = ctx?.logger;
		if (logger !== void 0 && typeof logger[level] === "function") logger[level](message);
		else console[level === "warn" ? "warn" : "log"](message);
	} catch {}
}
/**
* 把旧的全局工具选择与共享路径一次性迁到“工具设置 + 环节首选”模型。
*
* 大迁移由隐藏的 settingsModelVersion 控制；完成后不会再次介入用户的新工具选择。唯一例外是
* 幂等收敛旧插件平面模板路径为等价 builtin ID；用户模板与自定义路径不动。工具专属的
* verilatorPath / modelsimPath / vivadoPath 原地保留,共享路径只在目标为空时迁入。
*
* 幂等:没有旧值时什么都不写。失败只记日志 —— 迁移不成功顶多是路径要重填,
* 不该影响插件其余部分；日志只列字段名,不打印用户路径。
* @param settings - 已注册的设置命名空间句柄(`register()` 的返回值)。
* @param ctx - host plugin context(用于记日志)。
*/
function migrateLegacyKeys(settings, ctx) {
	try {
		const patch = legacyMigrationPatch(settings.get());
		const keys = Object.keys(patch);
		if (keys.length === 0) return;
		Promise.resolve(settings.update(patch)).then(() => note(ctx, "info", `fpga-workbench: 已整理旧设置(${keys.join(", ")})`), (error) => note(ctx, "warn", `fpga-workbench: 旧字段迁移失败,请重新填一次路径:${error.message}`));
	} catch (error) {
		note(ctx, "warn", `fpga-workbench: 旧字段迁移失败,请重新填一次路径:${String(error)}`);
	}
}
/** 读取一个小的 JSON 请求体,超过上限就拒绝(设置补丁本身很小)。 */
function readJsonBody(req, limit = 1048576) {
	return new Promise((resolve, reject) => {
		let text = "";
		/**
		* 已经 reject 过就不再收数据（2026-10-22 审查后修）。
		*
		* 原来超限时只 `reject`：Promise 定了，但 `data` 监听器还挂着，
		* 对端继续发多久、`text` 就继续长多久 —— 内存无界增长，而且没人再管这条连接。
		* 现在超限即停：置标志、卸监听、掐断 socket。
		*/
		let settled = false;
		const abort = (reason) => {
			if (settled) return;
			settled = true;
			reject(new Error(reason));
			req.pause?.();
			req.removeAllListeners?.("data");
			req.destroy?.();
		};
		req.setEncoding?.("utf8");
		req.on("data", (chunk) => {
			if (settled) return;
			text += chunk;
			if (text.length > limit) abort("请求体过大");
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			if (text.trim() === "") return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch (error) {
				reject(/* @__PURE__ */ new Error(`请求体不是合法 JSON:${String(error)}`));
			}
		});
		req.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}
/**
* 状态路由的"预演值":查询串里带的字段名 → 当成临时的设置值。
*
* 设置页有**未保存的改动**时用它问一次状态,于是"已就绪 / 未就绪"跟着**页面上那一份**走,
* 不必等保存;而且"换了工具还没保存"时,路径类型(文件 / 目录)也按**新选中的工具**判
* (类型随工具变,见 toolchain.js 的 effectiveKind)。
* 只认本插件的字段名(白名单),不认的忽略;只读 —— 不写设置、不建目录。
* @param req - HTTP 请求。
* @returns 要覆盖的字段值;查询串坏掉时为空对象。
*/
function pendingOverrides(req) {
	const overrides = {};
	try {
		const params = new URL(req.url ?? "", "http://localhost").searchParams;
		for (const field of FIELDS) {
			if (typeof field.key !== "string") continue;
			const value = params.get(field.key);
			if (value !== null) overrides[field.key] = value;
		}
	} catch {}
	return overrides;
}
/**
* DSH 0.1.7+ 的 settings 句柄。
*
* 旧 API 的 `register()` 返回一个已绑定命名空间的对象;新 API 把设置表单位于插件自己的
* Loader 行上,由 `describe()` 找到本行、由 `update(ns, patch)` 写入。这里保留旧的
* `get()/update(patch)` 调用形状,让路由与迁移逻辑不必知道宿主已经换过代。
* @param {object} ctx - host plugin context.
* @param {Record<string, unknown>} [initial] - Loader 传入的初始行配置。
* @returns {{ get: () => Record<string, unknown>, update: (patch: Record<string, unknown>) => Promise<Record<string, unknown>> }}
*/
function createSettingsFacade(ctx, initial = {}) {
	let current = { ...initial };
	let service;
	const sync = () => {
		if (service === void 0) return;
		try {
			const descriptor = service.describe({ redactSecrets: true })?.find((entry) => entry?.ns === NS);
			if (descriptor?.value !== null && typeof descriptor?.value === "object") current = {
				...current,
				...descriptor.value
			};
		} catch (error) {
			note(ctx, "warn", `fpga-workbench: 读取当前设置失败:${String(error)}`);
		}
	};
	const facade = {
		get: () => {
			sync();
			return { ...current };
		},
		update: async (patch) => {
			const next = {
				...current,
				...patch
			};
			if (service === void 0) {
				current = next;
				return facade.get();
			}
			await service.update(NS, patch);
			current = next;
			return facade.get();
		}
	};
	ctx.inject(["settings"], (settingsCtx) => {
		const candidate = settingsCtx.settings;
		if (typeof candidate?.describe !== "function" || typeof candidate?.update !== "function") {
			note(ctx, "warn", "fpga-workbench: 当前宿主 settings 服务没有 describe/update,设置只保留本次进程内的值");
			return;
		}
		service = candidate;
		if (typeof candidate.configure === "function") try {
			ctx.effect(() => candidate.configure?.({ auto: false }, ctx.fiber), "fpga-workbench: settings page policy");
		} catch (error) {
			note(ctx, "warn", `fpga-workbench: 关闭自动设置表单失败:${String(error)}`);
		}
		sync();
	});
	return facade;
}
/**
* 挂载宿主半侧。
* @param {object} ctx - host plugin context carrying `settings`.
* @param {Record<string, unknown>} [config] - Loader 传入的本行配置。
*/
function apply(ctx, config = {}) {
	const settings = createSettingsFacade(ctx, config);
	const migrate = () => migrateLegacyKeys(settings, ctx);
	const loader = ctx.loader;
	Promise.resolve(loader?.await?.()).then(migrate, migrate);
	ctx.inject(["webServer"], (webCtx) => {
		const json = (res, payload, status = 200) => {
			res.writeHead(status, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store"
			});
			res.end(JSON.stringify(payload));
		};
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: STATUS_PATH,
			handler: (req, res) => {
				const values = settings.get();
				json(res, {
					...statusOf({
						...values,
						...pendingOverrides(req)
					}),
					values
				});
			}
		}), "fpga-workbench: toolchain status route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: SETTINGS_PATH,
			handler: async (req, res) => {
				if (req.method === "GET") {
					json(res, { values: settings.get() });
					return;
				}
				if (req.method !== "POST") {
					json(res, { error: "只支持 GET 或 POST" }, 405);
					return;
				}
				try {
					const patch = (await readJsonBody(req)).patch;
					if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
						json(res, { error: "patch 必须是普通对象" }, 400);
						return;
					}
					const values = await settings.update(patch);
					clearProbeCache();
					json(res, { values });
				} catch (error) {
					json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
				}
			}
		}), "fpga-workbench: settings save route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: SELFCHECK_PATH,
			handler: (req, res) => {
				if (req.method !== "GET") {
					json(res, { error: "只支持 GET" }, 405);
					return;
				}
				json(res, runSelfCheck(settings.get()));
			}
		}), "fpga-workbench: self-check route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: VERSION_PATH,
			handler: (req, res) => {
				if (req.method !== "GET") {
					json(res, { error: "只支持 GET" }, 405);
					return;
				}
				json(res, packageInfo());
			}
		}), "fpga-workbench: version route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: UPDATE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					json(res, { error: "只支持 POST" }, 405);
					return;
				}
				try {
					const host = typeof req.headers?.host === "string" ? req.headers.host : "";
					const forwarded = String(req.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
					const hostname = host.replace(/:\d+$/u, "");
					const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
					const scheme = forwarded === "https" || forwarded === "http" ? forwarded : isLoopback ? "http" : "https";
					/**
					* **只接受回环 Host**（2026-10-22 审查后补的纵深防线）。
					*
					* 这个路由会把**浏览器带来的 DSH 会话 Cookie**原样转发给
					* `${base}/dsh-market/api/v1/updates`，而 `base` 里的 Host 由请求方完全控制。
					* 宿主侧 `isTrustedApiRequest` 目前会挡掉非回环 Host（403），但插件不该把
					* 正确性全押在宿主闸门上 —— 旧版宿主、反向代理改写、或闸门未覆盖插件路由的
					* 部署形态下，一个外部页面 `no-cors` fetch 一次即可完成「Cookie 外送」。
					*
					* 拒绝时**不回显** base，避免把这条错误变成探测侧信道。
					*/
					if (!isLoopback) {
						json(res, { error: "更新检查只接受来自本机界面的请求" }, 403);
						return;
					}
					const base = host === "" ? "" : `${scheme}://${host}`;
					if (base === "") {
						json(res, { error: "请求缺少 Host 头，无法确定更新源地址" }, 400);
						return;
					}
					const cookie = typeof req.headers?.cookie === "string" ? req.headers.cookie : void 0;
					const result = await checkForUpdateWithCookie(base, cookie);
					json(res, {
						...packageInfo(),
						...result
					});
				} catch (error) {
					json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
				}
			}
		}), "fpga-workbench: update check route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: BROWSE_PATH,
			handler: (req, res) => {
				let requested = "";
				try {
					requested = new URL(req.url ?? "", "http://localhost").searchParams.get("path") ?? "";
				} catch {
					requested = "";
				}
				json(res, listDirectory(requested));
			}
		}), "fpga-workbench: directory browse route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: DETECT_PATH,
			handler: (req, res) => {
				let field;
				try {
					field = new URL(req.url ?? "", "http://localhost").searchParams.get("field") ?? void 0;
				} catch {
					field = void 0;
				}
				json(res, { found: detectTools(void 0, void 0, void 0, void 0, field === void 0 ? void 0 : [field]) });
			}
		}), "fpga-workbench: tool detection route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: TEMPLATE_PATH,
			handler: (req, res) => {
				let capability = "";
				try {
					capability = new URL(req.url ?? "", "http://localhost").searchParams.get("capability") ?? "";
				} catch {
					capability = "";
				}
				if (!CAPABILITIES.some((entry) => entry.key === capability)) {
					json(res, { error: "未知能力，拒绝扫描模板目录" }, 400);
					return;
				}
				try {
					const values = settings.get();
					json(res, scanTemplates({
						capability,
						capabilities: CAPABILITIES,
						libraryRoot: String(values?.templateLibraryPath ?? "")
					}));
				} catch (error) {
					const suggested = Number(error?.status);
					const status = Number.isInteger(suggested) && suggested >= 400 && suggested <= 599 ? suggested : 500;
					json(res, { error: error instanceof Error ? error.message : "模板读取失败" }, status);
				}
			}
		}), "fpga-workbench: categorized template route");
	});
}
const name = "fpga-workbench";
const inject = ["settings"];
export { BROWSE_PATH, Config, DETECT_PATH, NS, SELFCHECK_PATH, SETTINGS_PATH, STATUS_PATH, SettingsSchema, TEMPLATE_PATH, UPDATE_PATH, VERSION_PATH, apply, inject, legacyMigrationPatch, name, statusOf };
