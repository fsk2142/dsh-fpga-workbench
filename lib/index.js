// 宿主半侧:注册工具链设置、登记预设根、探测路径是否就绪,并给设置页一个只读状态接口。
//
// 四件事:
//   1. ctx.settings.register —— 「设置 → FPGA 工作台」的字段,存进 settings.yaml。
//   2. ensurePresetRoot —— 把本包自带的预设根登记进预设名单(见那里的长注释)。
//   3. 探测 + 自动建缓存目录 —— 判定哪一项没就绪,并替用户建出缓存目录。
//   4. 只读 HTTP 路由 —— 设置页拿它显示状态(浏览器不能 stat 本地文件)。
//
// **配置全部在宿主侧**,所以图形界面和命令行跑的是同一份设置:CLI/headless 没有
// webServer 时只是少一个设置页,路径本身照常可用,自动建缓存目录也照常生效。
//
// **刻意不往会话提示里注入任何东西。** 提示段注册在插件行(profile 层),作用域是全局,
// 那样普通会话也会看到 FPGA 工具链的信息与警告,与"不影响正常会话"冲突。要按会话作用域
// 注入,得让 section 由预设组装来注册,而不是这里。目前的决定是只在设置页提示。

import { existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import z from "@deepseek-ai/schemastery";
import { FIELDS, NS, inspectTools } from "./toolchain.js";

export { NS };

/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export const STATUS_PATH = "/plugins/fpga-workbench/toolchain";

/** 预设名单(cordis 服务名/设置命名空间)—— 本包要往里登记自己的预设根。 */
const ROSTER_NS = "agent-presets";

/**
 * 本包自带的预设根。
 *
 * 用 `import.meta.url` 而不是补丁里的 `!!js ... new URL('presets/', baseUrl)`:
 * 后者依赖"补丁 !!js 求值时的 baseUrl 是补丁文件所在目录"这个假设,而实测那个假设
 * 不成立 —— 路径落在别处、目录不存在,scanRoot 对不存在的根**静默返回空**,于是预设
 * 从名单里消失且没有任何报错。模块自身的 URL 不依赖任何假设。
 */
const PRESET_ROOT = fileURLToPath(new URL("../presets/", import.meta.url));

/** 设置 schema:每个字段一个字符串,默认空。 */
export const SettingsSchema = z.object(
  Object.fromEntries(FIELDS.map((field) => [field.key, z.string().default("")]))
);

/**
 * 真实文件系统探测。
 *
 * 文件字段也接受目录:用户可能填到工具所在目录(有些安装把可执行文件放在 bin 下),
 * 替他把关只会误报。目录字段要求真的是目录。
 * @param path - 配置里填的路径。
 * @param kind - `"file"` 或 `"directory"`。
 * @returns 存在且类型可接受。
 */
function probeFilesystem(path, kind) {
  if (!existsSync(path)) return false;
  try {
    return kind === "directory" ? statSync(path).isDirectory() : true;
  } catch {
    return false;
  }
}

/**
 * 缓存目录是写入目标,不是已经装好的工具 —— 配置了但还没创建时替用户建出来。
 *
 * 放在宿主侧:图形界面和命令行共用这一份配置,两边都需要那个目录存在。建不出来
 * (权限不足、盘符不存在)就不吭声,交给状态判定如实报"未就绪",而不是假装成功。
 * @param values - 设置解析后的值。
 */
export function ensureCacheDir(values) {
  const path = String(values?.cachePath ?? "").trim();
  if (path === "") return;
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // 建不出来就保持现状,由 statusOf 报未就绪
  }
}

/**
 * 当前状态:每项的存在情况 + 给设置页用的汇总。
 *
 * 五个字段都是必填(用户要求"路径都要"),所以任何一项没就绪都会进 `missing`。
 * @param values - 设置解析后的值。
 * @returns `{ tools, missing, ok }`;`tools` 每项带 `skips`,说明没就绪会跳过什么。
 */
export function statusOf(values) {
  const tools = inspectTools(values, probeFilesystem).map(
    ({ key, label, hint, kind, required, skips, path, configured, present }) => ({
      key,
      label,
      hint,
      kind,
      required,
      skips,
      path,
      configured,
      present
    })
  );
  const missing = tools.filter((tool) => !tool.present).map((tool) => tool.key);
  return { tools, missing, ok: missing.length === 0 };
}

/** 路径比较用的归一化:大小写与结尾分隔符不该影响判断。 */
function samePath(left, right) {
  const norm = (value) => String(value ?? "").replace(/[\\/]+$/u, "").replace(/\//gu, "\\").toLowerCase();
  return norm(left) !== "" && norm(left) === norm(right);
}

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
 * 把本包自带的预设根登记进预设名单。
 *
 * 为什么必须运行时做,而不是靠补丁里那行 `roots:`:
 *   预设名单的取值是「schema 默认 → 行 config(base) → 用户层(settings.yaml)」三层合并。
 *   实测补丁里给 `agent-presets` 行写 `roots` **没有生效**(名单里看不到本预设,且没有任何
 *   报错 —— 不存在的根会被静默跳过)。与其继续依赖那条没走通的路,不如由插件把自己登记进
 *   **用户层**:那是最权威的一层,而且插件知道自己的真实位置,不用猜 baseUrl 语义。
 *
 * 幂等且不夺权:先读当前生效的 roots,已包含本包就直接返回;否则**追加**,不覆盖用户自己
 * 配的根。agent-presets 还没注册时(加载顺序)有限次重试。
 * @param ctx - host plugin context carrying `settings`.
 * @param attempt - 内部重试计数。
 */
async function ensurePresetRoot(ctx, attempt = 0) {
  try {
    const roster = ctx.settings.get(ROSTER_NS);
    if (roster === undefined) {
      if (attempt < 10) setTimeout(() => void ensurePresetRoot(ctx, attempt + 1), 500);
      return;
    }
    const roots = Array.isArray(roster.roots) ? roster.roots : [];
    if (roots.some((entry) => samePath(entry?.path, PRESET_ROOT))) return;
    await ctx.settings.update(ROSTER_NS, { roots: [...roots, { path: PRESET_ROOT, trust: "user" }] });
    note(ctx, "info", `fpga-workbench: 已把预设根登记进 ${ROSTER_NS}:${PRESET_ROOT}`);
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 登记预设根失败:${error.message}`);
  }
}

/**
 * 挂载宿主半侧。
 * @param ctx - host plugin context carrying `settings`.
 */
export function apply(ctx) {
  const settings = ctx.settings.register(NS, SettingsSchema, { base: {} });

  // 让「FPGA 工作台」出现在新建会话的预设选择器里。
  void ensurePresetRoot(ctx);

  // 开一次就先把缓存目录建出来,用户第一次打开设置页看到的就是就绪状态。
  ensureCacheDir(settings.get());

  // 设置页的状态接口。webServer 在 headless/CLI 部署里不存在 —— 拿不到就不注册这一步,
  // 设置项本身照常可读写,只是没有状态提示(GUI 与 CLI 共用同一份配置)。
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: STATUS_PATH,
          handler: (_req, res) => {
            const values = settings.get();
            // 每次查询都补一次:用户可能刚改了缓存路径,或手工删掉了那个目录
            ensureCacheDir(values);
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store"
            });
            res.end(JSON.stringify(statusOf(values)));
          }
        }),
      "fpga-workbench: toolchain status route"
    );
  });
}

export const name = "fpga-workbench";
export const inject = ["settings"];
