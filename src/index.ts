// 宿主半侧:注册工具链设置、探测路径是否就绪,并给设置页一组只读/写入接口。
//
// 两件事:
//   1. Config + settings.describe/update —— 「设置 → FPGA 开发模式」的字段。
//   2. HTTP 路由 —— 状态、浏览、检测、模板与设置保存(浏览器不能 stat 本地文件)。
//
// **配置全部在宿主侧**,所以图形界面和命令行跑的是同一份设置:CLI/headless 没有
// webServer 时只是少一个设置页,路径本身照常可用。
//
// **刻意不往会话提示里注入任何东西。** 提示段注册在插件行(profile 层),作用域是全局,
// 那样普通会话也会看到 FPGA 工具链的信息与警告,与"不影响正常会话"冲突。所以工具链那
// 段提示由 **lib/mode.js** 注册 —— 它只从本预设的组装里挂载,作用域是 agent 作用域。
// 一句话:插件行管"配置 + 探测",模式行管"这个模式知道什么"。

import z from "@deepseek-ai/schemastery";
import {
  CAPABILITIES,
  FIELDS,
  NS,
  clearProbeCache,
  detectTools,
  legacyMigrationPatch,
  listDirectory,
  statusOf
} from "./toolchain.js";
import { scanTemplates } from "./template-library.js";
import { runSelfCheck } from "./selfcheck.js";
import { checkForUpdateWithCookie, packageInfo } from "./version.js";

export { NS };

/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export const STATUS_PATH = "/plugins/fpga-workbench/toolchain";

/** 设置页「浏览…」列目录的路由(弹不出系统对话框时的备选)。与 lib/client.js 里的常量必须一致。 */
export const BROWSE_PATH = "/plugins/fpga-workbench/browse";

/** 设置页「检测本机工具」的路由。与 lib/client.js 里的常量必须一致。 */
export const DETECT_PATH = "/plugins/fpga-workbench/detect";

/** 能力卡展开时读取分类模板的只读路由。与 lib/client.js 里的常量必须一致。 */
export const TEMPLATE_PATH = "/plugins/fpga-workbench/templates";

/** 设置页保存本插件配置的路由。与 lib/client.js 里的常量必须一致。 */
export const SETTINGS_PATH = "/plugins/fpga-workbench/settings";

/** 设置页「运行自检」的只读路由。与 lib/client.js 里的常量必须一致。 */
export const SELFCHECK_PATH = "/plugins/fpga-workbench/selfcheck";

/**
 * 设置页「检查更新」的路由。与 lib/client.js 里的常量必须一致。
 *
 * 它**不会**在插件启动时被调用,也不会被定时器调用:这是唯一会离开本机的请求,
 * 必须由用户点一下才发生。
 */
export const UPDATE_PATH = "/plugins/fpga-workbench/update";

/** 设置页读版本信息(本插件版本 + 兼容的 DSH 版本)的只读路由。不发网络请求。 */
export const VERSION_PATH = "/plugins/fpga-workbench/version";

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
  register: (options: { kind: string; path: string; handler: (req: HttpRequest, res: HttpResponse) => unknown }) => unknown;
}

/** 宿主的 settings 服务（describe / update，形状宽松校验）。 */
interface SettingsServiceLike {
  describe: (options?: { redactSecrets?: boolean }) => ReadonlyArray<{ ns?: string; value?: unknown }> | undefined;
  update: (ns: string, patch: unknown) => Promise<unknown> | unknown;
  configure?: (options: { auto: boolean }, fiber?: unknown) => unknown;
  get?: (ns: string) => unknown;
}

/** Cordis 上下文里本文件用到的成员。 */
interface HostContext {
  get: (name: string) => unknown;
  /** Cordis 契约：上下文一定有 inject / effect / on（可选的是"服务"，不是这几个方法）。 */
  inject: (deps: string[], callback: (ctx: HostContext) => void) => unknown;
  effect: (factory: () => unknown, label?: string) => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  /** webServer 只在带 Web 的宿主里存在，所以它是可选的（缺了只是少一个设置页）。 */
  webServer?: WebServerLike;
  baseUrl?: string;
  fiber?: unknown;
  [key: string]: unknown;
}

/** 设置门面的形状（createSettingsFacade 的返回）。 */
interface SettingsFacade {
  get: () => Record<string, unknown>;
  update: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
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
export const SettingsSchema = z.object(
  Object.fromEntries(
    FIELDS.map((field) => {
      // `FIELDS` 是若干字面量形状的联合，不是每个成员都有 `default`
      // （模板字段 / 能力偏好字段就没有）。用 `in` 收窄，别硬取。
      const fallback = "default" in field ? String(field.default ?? "") : "";
      return [field.key, z.string().default(fallback).volatile()];
    })
  )
);

/**
 * DSH 0.1.7+ 的 Loader 行 schema 导出名。
 *
 * 旧版本由 `settings.register(NS, ...)` 注册命名空间;新版本改为从插件导出的
 * `Config` 派生本行的设置表单,再由 settings 服务的 `describe/update` 读写。
 */
export const Config = SettingsSchema;

/**
 * 当前状态:每项的存在情况 + 给设置页用的汇总。
 *
 * 实现在 lib/toolchain.js(纯逻辑,自检能直接跑它);这里只是转出去,保持原有导入路径可用,
 * 顺便让冒烟测试能在**已装副本**上验这两件事。
 */
export { legacyMigrationPatch, statusOf } from "./toolchain.js";

/** 记一条日志;没有 logger 就退回 console。 */
function note(ctx: HostContext, level: "info" | "warn", message: string): void {
  try {
    const logger = ctx?.logger;
    if (logger !== undefined && typeof logger[level] === "function") logger[level](message);
    else console[level === "warn" ? "warn" : "log"](message);
  } catch {
    // 日志本身不该影响功能
  }
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
function migrateLegacyKeys(settings: SettingsFacade, ctx: HostContext): void {
  try {
    const patch = legacyMigrationPatch(settings.get());
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    Promise.resolve(
      // ⚠️ `register()` 返回的是**已绑定命名空间**的句柄,它的 update 只接补丁。
      // 多传一个 ns 会被当成补丁本身,报 "must be a plain object" —— 踩过。
      settings.update(patch)
    ).then(
      () => note(ctx, "info", `fpga-workbench: 已整理旧设置(${keys.join(", ")})`),
      (error) => note(ctx, "warn", `fpga-workbench: 旧字段迁移失败,请重新填一次路径:${error.message}`)
    );
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 旧字段迁移失败,请重新填一次路径:${String(error)}`);
  }
}

/** 读取一个小的 JSON 请求体,超过上限就拒绝(设置补丁本身很小)。 */
function readJsonBody(req: HttpRequest, limit = 1024 * 1024): Promise<Record<string, unknown>> {
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
    const abort = (reason: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(reason));
      req.pause?.();
      req.removeAllListeners?.("data");
      req.destroy?.();
    };
    req.setEncoding?.("utf8");
    req.on("data", (chunk: string) => {
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
        reject(new Error(`请求体不是合法 JSON:${String(error)}`));
      }
    });
    req.on("error", (error: unknown) => {
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
function pendingOverrides(req: HttpRequest): Record<string, unknown> {
  const overrides: Record<string, string> = {};
  try {
    const params = new URL(req.url ?? "", "http://localhost").searchParams;
    for (const field of FIELDS) {
      // `field.key` 在联合类型里不是每个成员都有（有 key 是 string）—— 先判。
      if (typeof field.key !== "string") continue;
      const value = params.get(field.key);
      if (value !== null) overrides[field.key] = value;
    }
  } catch {
    // 查询串坏掉就当没有预演:状态照旧按已保存的值算
  }
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
function createSettingsFacade(ctx: HostContext, initial: Record<string, unknown> = {}): SettingsFacade {
  let current = { ...initial };
  let service: SettingsServiceLike | undefined;

  const sync = () => {
    if (service === undefined) return;
    try {
      const descriptor = service.describe({ redactSecrets: true })?.find((entry: { ns?: string; value?: unknown }) => entry?.ns === NS);
      if (descriptor?.value !== null && typeof descriptor?.value === "object") {
        current = { ...current, ...descriptor.value };
      }
    } catch (error) {
      note(ctx, "warn", `fpga-workbench: 读取当前设置失败:${String(error)}`);
    }
  };

  const facade = {
    get: () => {
      sync();
      return { ...current };
    },
    update: async (patch: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const next = { ...current, ...patch };
      if (service === undefined) {
        current = next;
        return facade.get();
      }
      await service.update(NS, patch);
      current = next;
      return facade.get();
    }
  };

  /**
   * `ctx.inject` 是较新宿主才有的服务（cordis 的子插件机制）。
   *
   * 2026-10-23 修：原来这里直接写 `ctx.inject(["settings"], cb)` —— 宿主没有这个方法时
   * 抛 `TypeError: ctx.inject is not a function`，而**它不在任何 try/catch 里**，
   * 冒泡到 cordis 会让整个插件 fiber 进入错误态（观感上就是"插件挂了/界面不对"）。
   *
   * 所以先看有没有：没有就退回"用 loader 传进来的行配置 + update 时直接写"，
   * 也就是下面的 `service === undefined` 分支 —— 设置仍能读能写，只是不跟随外部改动。
   */
  const injectService = (ctx as { inject?: (deps: string[], callback: (scoped: HostContext) => unknown) => unknown }).inject;
  if (typeof injectService !== "function") {
    note(ctx, "warn", "fpga-workbench: 宿主没有 ctx.inject,设置不跟随外部改动(改用启动时的配置)");
    return facade;
  }

  injectService.call(ctx, ["settings"], (settingsCtx: HostContext) => {
    const candidate = (settingsCtx as { settings?: SettingsServiceLike }).settings;
    if (
      typeof candidate?.describe !== "function" ||
      typeof candidate?.update !== "function"
    ) {
      note(ctx, "warn", "fpga-workbench: 当前宿主 settings 服务没有 describe/update,设置只保留本次进程内的值");
      return;
    }
    service = candidate;
    if (typeof candidate.configure === "function") {
      try {
        ctx.effect(() => candidate.configure?.({ auto: false }, ctx.fiber), "fpga-workbench: settings page policy");
      } catch (error) {
        note(ctx, "warn", `fpga-workbench: 关闭自动设置表单失败:${String(error)}`);
      }
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
export function apply(ctx: HostContext, config: Record<string, unknown> = {}): void {
  const settings = createSettingsFacade(ctx, config);

  // 把改名前的旧键搬进新键(一次性,幂等)。等 Loader 把本行 settings face 挂好再迁移,
  // 否则新 API 还没有 describe/update 可用,迁移只改到进程内临时值。
  const migrate = () => migrateLegacyKeys(settings, ctx);
  // `ctx.loader` 是宿主可选提供的（旧版本没有）。用窄断言取它，缺了就同步迁移。
  const loader = (ctx as { loader?: { await?: () => Promise<unknown> } }).loader;
  Promise.resolve(loader?.await?.()).then(migrate, migrate);

  // 预设由 cordis.patch.yml 里的 @deepseek-ai/dsh-agent-preset 行注册,不再往用户预设目录写副本。

  // 设置页的只读接口(状态 / 列目录 / 检测本机工具 / 分类模板 / 自检)与保存接口。webServer 在
  // headless/CLI 部署里不存在 —— 拿不到就不注册这一步,设置项本身照常可读写,只是没有状态提示与按钮
  // (GUI 与 CLI 共用同一份配置)。
  //
  // 与上面 `settings` 那处同理：`ctx.inject` 不是所有宿主都有。没有就跳过整个 webServer
  // 区块 —— 那些是设置页的只读接口，缺了只是没有状态提示，设置本身照常可读写。
  const injectWebService = (ctx as { inject?: (deps: string[], callback: (scoped: HostContext) => unknown) => unknown }).inject;
  if (typeof injectWebService !== "function") {
    note(ctx, "warn", "fpga-workbench: 宿主没有 ctx.inject,设置页的状态接口未注册(设置本身仍可用)");
    return;
  }

  injectWebService.call(ctx, ["webServer"], (webCtx: HostContext) => {
    const json = (res: HttpResponse, payload: unknown, status = 200): void => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(payload));
    };

    /**
     * **安全地注册路由**：`effect` 缺失时直接注册（不托管生命周期）。
     *
     * `webCtx.effect` 在类型上是必需的，但真实宿主不一定提供 —— 探针实测
     * 一个只有 `webServer` 的 ctx 会抛 `TypeError: webCtx.effect is not a function`。
     * 而这条语句**在 inject 回调里**，抛出去同样会污染插件 fiber。
     *
     * 没有 effect 时退化成"直接注册、进程结束时随宿主一起消失" —— 对只读接口完全够用。
     */
    const registerRoute = (factory: () => unknown, label?: string): void => {
      const effect = (webCtx as { effect?: (fn: () => unknown, label?: string) => unknown }).effect;
      if (typeof effect === "function") {
        effect.call(webCtx, factory, label ?? "fpga-workbench: settings routes");
        return;
      }
      try {
        factory();
      } catch (error) {
        note(ctx, "warn", `fpga-workbench: 注册设置页路由失败:${String(error)}`);
      }
    };

    /**
     * `webServer` 服务本身也可能没有（headless / CLI 部署）。
     *
     * 虽然 `inject(["webServer"])` 名义上保证服务就绪，但探针实测"回调里的 ctx 没有
     * webServer"会让后面每一处 `webServer.register(...)` 抛
     * `Cannot read properties of undefined (reading 'register')`。
     * 与其让 8 个路由各抛一次，这里一次性判掉。
     */
    const webServer = (webCtx as {
      webServer?: {
        register: (spec: {
          kind: string;
          path: string;
          handler: (req: HttpRequest, res: HttpResponse) => unknown;
        }) => unknown;
      };
    }).webServer;
    if (webServer === undefined || typeof webServer.register !== "function") {
      note(ctx, "warn", "fpga-workbench: 宿主没有 webServer,设置页的状态接口未注册(设置本身仍可用)");
      return;
    }

    registerRoute(
      () =>
        webServer.register({
          kind: "exact",
          path: STATUS_PATH,
          handler: (req: HttpRequest, res: HttpResponse) => {
            const values: Record<string, unknown> = settings.get();
            // 查询串里带上字段名 = "**预演**这一次改动":设置页有未保存的改动时用它问一次,
            // 于是"就绪/未就绪"跟着**页面上那一份**走,而不是等保存后才更新。
            // 只读:不写设置,也不建任何目录。
            json(res, {
              ...statusOf({ ...values, ...pendingOverrides(req) }),
              // 当前行的真实配置也一并给客户端,新 settings API 不再提供旧 settingsScope 快照。
              values
            });
          }
        }),
      "fpga-workbench: toolchain status route"
    );

    // DSH 0.1.7 的 settings 服务按插件行读写配置,浏览器半侧通过这条路由提交补丁。
    // 鉴权仍由宿主 webServer 前置闸门负责,这里不重复实现。
    registerRoute(
      () =>
        webServer.register({
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
              const body = await readJsonBody(req);
              // `body` 是 Record<string, unknown>；`patch` 取出来是 unknown，
              // 下面的 typeof/Array.isArray 检查把它收窄成普通对象。
              const patch = (body as { patch?: unknown }).patch;
              if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
                json(res, { error: "patch 必须是普通对象" }, 400);
                return;
              }
              // 上面的 typeof / Array.isArray 已把它收窄成"非数组对象"，
              // 这里显式断言成 Record —— `settings.update` 要的就是普通对象。
              const values = await settings.update(patch as Record<string, unknown>);
              // 设置刚改过:清掉路径探测缓存,让界面与会话提示**立刻**反映新路径,
              // 而不是等 5 秒 TTL 过期(见 toolchain.js 的 probeFilesystem)。
              clearProbeCache();
              json(res, { values });
            } catch (error) {
              json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
            }
          }
        }),
      "fpga-workbench: settings save route"
    );

    // 「运行自检」:只读、不起进程、不写文件(实现见 lib/selfcheck.js)。用户点一下就能看到
    // "这份已装副本 + 这份设置"的实际状态,而不是只在开发机上跑 npm test 才知道。
    registerRoute(
      () =>
        webServer.register({
          kind: "exact",
          path: SELFCHECK_PATH,
          handler: (req: HttpRequest, res: HttpResponse) => {
            if (req.method !== "GET") {
              json(res, { error: "只支持 GET" }, 405);
              return;
            }
            json(res, runSelfCheck(settings.get()));
          }
        }),
      "fpga-workbench: self-check route"
    );

    // 版本信息:**不发网络请求**,只报本包自己的版本与它声明兼容的 DSH 版本。
    // 设置页打开时读这一条就够显示"当前版本"。
    registerRoute(
      () =>
        webServer.register({
          kind: "exact",
          path: VERSION_PATH,
          handler: (req: HttpRequest, res: HttpResponse) => {
            if (req.method !== "GET") {
              json(res, { error: "只支持 GET" }, 405);
              return;
            }
            json(res, packageInfo());
          }
        }),
      "fpga-workbench: version route"
    );

    // 「检查更新」:走宿主市场 API(见 lib/version.js 文件头)。**只有用户点按钮才会打到这里。**
    //
    // 为什么仍然保留这条插件路由、而不让浏览器直接打市场 API:插件路由能带上自己的
    // 解释(失败原因、版本字段统一化),也让"客户端只认一个端点"这条简单些。但要注意
    // 认证:市场 API 在生产环境要浏览器会话 cookie,而这里是**宿主进程**发的请求 ——
    // 所以本路由把浏览器的 Cookie 头**原样转发**过去,让市场的鉴权闸自己判断。
    // 不自己伪造凭据,也不绕过市场:拿不到就如实说"查不到"。
    registerRoute(
      () =>
        webServer.register({
          kind: "exact",
          path: UPDATE_PATH,
          handler: async (req, res) => {
            if (req.method !== "POST") {
              json(res, { error: "只支持 POST" }, 405);
              return;
            }
            try {
              // 找一个能装下市场应用的源站地址:优先请求自己的 Host(浏览器就在本机)。
              //
              // **协议不能硬编码 http**(2026-10-22 的兼容性实测抓到):DSH Desktop 跑在
              // 本机 http 上,所以以前够用;但宿主一旦走 HTTPS(或用户通过反向代理访问),
              // `http://<host>` 会拼成 `http://example.com:443` —— 协议错、端口也错,
              // 请求被拒或打到别的服务,而界面只会说「更新检查失败」。
              //
              // 判据顺序:反向代理给的 `x-forwarded-proto` → 再看 host 是不是本机回环
              // (回环一律 http) → 其余按 https 处理(Host 是外部域名时它更可能走 TLS)。
              const host = typeof req.headers?.host === "string" ? req.headers.host : "";
              // `x-forwarded-proto` 可能是 "https, http" 这种链,取第一段。
              const forwarded = String(req.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
              const hostname = host.replace(/:\d+$/u, "");
              const isLoopback =
                hostname === "localhost" ||
                hostname === "127.0.0.1" ||
                hostname === "[::1]" ||
                hostname === "::1";
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
                // HTTP/1.0 没有 Host 头：`fetch` 会拒绝相对 URL，报出来却是"网络失败"，容易误导。
                json(res, { error: "请求缺少 Host 头，无法确定更新源地址" }, 400);
                return;
              }
              const cookie = typeof req.headers?.cookie === "string" ? req.headers.cookie : undefined;
              const result = await checkForUpdateWithCookie(base, cookie);
              json(res, { ...packageInfo(), ...result });
            } catch (error) {
              json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
            }
          }
        }),
      "fpga-workbench: update check route"
    );

    // 「浏览…」用:列一个目录,让用户在界面上点选文件/目录,而不是手打路径。
    // 只读 —— 不创建、不删除、不改名。
    // **鉴权不在插件里做**(做了是重复):这三条路由挂在宿主 `webServer` 上,前面是宿主的两层闸
    // (`dsh-client-connection` 的 `requestRejection`)——
    //   ① Host/Origin 围栏 `isTrustedApiRequest`:非回环 Host、或 `Origin` 与 Host 不一致、
    //      或 `Sec-Fetch-Site: cross-site` → 403;
    //   ② 浏览器会话认证 `browserAuth.isAuthenticated`(进程启动 token 换 cookie)→ 401。
    // 2026-09-21 真机实测(服务在 127.0.0.1:43120):裸 GET、外部 Origin、外部 Host、
    // 可信 Origin + 假 cookie、乃至**不存在的路径** —— 一律 403 `forbidden`,一个字节都取不到。
    // 所以这里保持"不做来源校验":真正的闸在宿主那一层,重复实现只会变成假门禁。
    registerRoute(
      () =>
        webServer.register({
          kind: "exact",
          path: BROWSE_PATH,
          handler: (req: HttpRequest, res: HttpResponse) => {
            let requested = "";
            try {
              requested = new URL(req.url ?? "", "http://localhost").searchParams.get("path") ?? "";
            } catch {
              requested = "";
            }
            json(res, listDirectory(requested));
          }
        }),
      "fpga-workbench: directory browse route"
    );

    // 「检测本机工具」:设置页展开哪张工具卡,这里只检测那张卡的路径字段。
    // Python 会额外起一次只读版本查询,其余工具只探文件系统。没有 field 查询参数时仍保留
    // 全量检测,兼容旧客户端；新客户端始终传 field,不会打开页面就把所有工具扫一遍。
    // **不传设置值**:检测只报机器事实；已保存值与未保存草稿由页面自己判断。
    registerRoute(
      () =>
        webServer.register({
          kind: "exact",
          path: DETECT_PATH,
          handler: (req: HttpRequest, res: HttpResponse) => {
            let field;
            try {
              field = new URL(req.url ?? "", "http://localhost").searchParams.get("field") ?? undefined;
            } catch {
              field = undefined;
            }
            json(res, {
              found: detectTools(
                undefined,
                undefined,
                undefined,
                undefined,
                field === undefined ? undefined : [field]
              )
            });
          }
        }),
      "fpga-workbench: tool detection route"
    );

    // 分类模板只在能力卡展开时读取。请求方只能给能力 key；扫描分类完全来自 CAPABILITIES
    // 白名单，不能借这个接口枚举任意本地路径。扫描失败仍保留非 2xx 与结构化错误，客户端据此
    // 区分“模板读取失败”和“确实没有用户模板”。
    registerRoute(
      () =>
        webServer.register({
          kind: "exact",
          path: TEMPLATE_PATH,
          handler: (req: HttpRequest, res: HttpResponse) => {
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
              const values: Record<string, unknown> = settings.get();
              json(res, scanTemplates({
                capability,
                capabilities: CAPABILITIES,
                libraryRoot: String(values?.templateLibraryPath ?? "")
              }));
            } catch (error) {
              // `error` 是 unknown；`template-library` 会抛带 `status` 的错误，取它当 HTTP 码。
              const suggested = Number((error as { status?: unknown } | undefined)?.status);
              const status = Number.isInteger(suggested) && suggested >= 400 && suggested <= 599 ? suggested : 500;
              json(res, { error: error instanceof Error ? error.message : "模板读取失败" }, status);
            }
          }
        }),
      "fpga-workbench: categorized template route"
    );
  });
}

export const name = "fpga-workbench";
export const inject = ["settings"];
