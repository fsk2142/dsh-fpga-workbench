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
  detectTools,
  legacyMigrationPatch,
  listDirectory,
  statusOf
} from "./toolchain.js";
import { scanTemplates } from "./template-library.js";
import { runSelfCheck } from "./selfcheck.js";
import { checkForUpdate, packageInfo } from "./version.js";

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
  Object.fromEntries(FIELDS.map((field) => [field.key, z.string().default(field.default ?? "").volatile()]))
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
function note(ctx, level, message) {
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
function migrateLegacyKeys(settings, ctx) {
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
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding?.("utf8");
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > limit) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (text.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON:${String(error)}`));
      }
    });
    req.on("error", reject);
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
function createSettingsFacade(ctx, initial = {}) {
  let current = { ...initial };
  let service;

  const sync = () => {
    if (service === undefined) return;
    try {
      const descriptor = service.describe({ redactSecrets: true })?.find((entry) => entry?.ns === NS);
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
    update: async (patch) => {
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

  ctx.inject(["settings"], (settingsCtx) => {
    const candidate = settingsCtx.settings;
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
        ctx.effect(() => candidate.configure({ auto: false }, ctx.fiber), "fpga-workbench: settings page policy");
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
export function apply(ctx, config) {
  const settings = createSettingsFacade(ctx, config);

  // 把改名前的旧键搬进新键(一次性,幂等)。等 Loader 把本行 settings face 挂好再迁移,
  // 否则新 API 还没有 describe/update 可用,迁移只改到进程内临时值。
  const migrate = () => migrateLegacyKeys(settings, ctx);
  Promise.resolve(ctx.loader?.await?.()).then(migrate, migrate);

  // 预设由 cordis.patch.yml 里的 @deepseek-ai/dsh-agent-preset 行注册,不再往用户预设目录写副本。

  // 设置页的只读接口(状态 / 列目录 / 检测本机工具 / 分类模板 / 自检)与保存接口。webServer 在
  // headless/CLI 部署里不存在 —— 拿不到就不注册这一步,设置项本身照常可读写,只是没有状态提示与按钮
  // (GUI 与 CLI 共用同一份配置)。
  ctx.inject(["webServer"], (webCtx) => {
    const json = (res, payload, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(payload));
    };

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: STATUS_PATH,
          handler: (req, res) => {
            const values = settings.get();
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
    webCtx.effect(
      () =>
        webCtx.webServer.register({
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
              const patch = body?.patch;
              if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
                json(res, { error: "patch 必须是普通对象" }, 400);
                return;
              }
              const values = await settings.update(patch);
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
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: SELFCHECK_PATH,
          handler: (req, res) => {
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
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: VERSION_PATH,
          handler: (req, res) => {
            if (req.method !== "GET") {
              json(res, { error: "只支持 GET" }, 405);
              return;
            }
            json(res, packageInfo());
          }
        }),
      "fpga-workbench: version route"
    );

    // 「检查更新」:**唯一会离开本机的请求**,只有用户点按钮才会打到这里。
    // 不用 GET,免得被浏览器的预取/缓存悄悄触发;失败如实返回原因,不编"已是最新"。
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: UPDATE_PATH,
          handler: async (req, res) => {
            if (req.method !== "POST") {
              json(res, { error: "只支持 POST" }, 405);
              return;
            }
            try {
              const result = await checkForUpdate();
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
    webCtx.effect(
      () =>
        webCtx.webServer.register({
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
        }),
      "fpga-workbench: directory browse route"
    );

    // 「检测本机工具」:设置页展开哪张工具卡,这里只检测那张卡的路径字段。
    // Python 会额外起一次只读版本查询,其余工具只探文件系统。没有 field 查询参数时仍保留
    // 全量检测,兼容旧客户端；新客户端始终传 field,不会打开页面就把所有工具扫一遍。
    // **不传设置值**:检测只报机器事实；已保存值与未保存草稿由页面自己判断。
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: DETECT_PATH,
          handler: (req, res) => {
            let field;
            try {
              field = new URL(req.url ?? "", "http://localhost").searchParams.get("field") ?? undefined;
            } catch {
              field = undefined;
            }
            json(res, { found: detectTools(undefined, undefined, undefined, undefined, field === undefined ? undefined : [field]) });
          }
        }),
      "fpga-workbench: tool detection route"
    );

    // 分类模板只在能力卡展开时读取。请求方只能给能力 key；扫描分类完全来自 CAPABILITIES
    // 白名单，不能借这个接口枚举任意本地路径。扫描失败仍保留非 2xx 与结构化错误，客户端据此
    // 区分“模板读取失败”和“确实没有用户模板”。
    webCtx.effect(
      () =>
        webCtx.webServer.register({
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
        }),
      "fpga-workbench: categorized template route"
    );
  });
}

export const name = "fpga-workbench";
export const inject = ["settings"];
