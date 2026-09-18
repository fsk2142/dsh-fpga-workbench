// 宿主半侧:注册工具链设置、登记预设根、探测路径是否就绪,并给设置页一个只读状态接口。
//
// 四件事:
//   1. ctx.settings.register —— 「设置 → FPGA 开发模式」的字段,存进 settings.yaml。
//   2. ensureUserPreset —— 把本包自带的预设同步进用户预设目录(见那里的长注释)。
//   3. 探测 + 自动建缓存目录 —— 判定哪一项没就绪,并替用户建出缓存目录。
//   4. 只读 HTTP 路由 —— 设置页拿它显示状态(浏览器不能 stat 本地文件)。
//
// **配置全部在宿主侧**,所以图形界面和命令行跑的是同一份设置:CLI/headless 没有
// webServer 时只是少一个设置页,路径本身照常可用,自动建缓存目录也照常生效。
//
// **刻意不往会话提示里注入任何东西。** 提示段注册在插件行(profile 层),作用域是全局,
// 那样普通会话也会看到 FPGA 工具链的信息与警告,与"不影响正常会话"冲突。所以工具链那
// 段提示由 **lib/mode.js** 注册 —— 它只从本预设的组装里挂载,作用域是 agent 作用域。
// 一句话:插件行管"配置 + 探测",模式行管"这个模式知道什么"。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import z from "@deepseek-ai/schemastery";
import { FIELDS, NS, inspectTools, probeFilesystem } from "./toolchain.js";

export { NS };

/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export const STATUS_PATH = "/plugins/fpga-workbench/toolchain";

/** 预设 id(= 预设目录名)。 */
const PRESET_ID = "fpga-workbench";

/** 用户预设目录名(harness home 下),与 dsh-agent-presets 的约定一致。 */
const USER_PRESET_DIR = ".agent-presets";

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
 * 把本包自带的预设放进**用户预设目录** `$DSH_HOME/.agent-presets/<id>/`。
 *
 * 为什么走这里,而不是给预设名单加一个根 —— `dsh-agent-presets` 的构造函数里:
 *
 *     resolvedRoots = [内置根] + **config.roots** + [用户根]
 *
 * 也就是说 `roots` **只从行 config 取,不读设置值**(它的设置命名空间只接 `default`)。
 * 而给行 config 加根的补丁覆盖实测没有生效:名单里看不到本预设,并且不存在的根会被
 * scanRoot 静默跳过 —— 完全没有报错,所以查了很久。
 *
 * 用户根不一样:`includeUserRoot` 默认打开,**无条件扫描**。把预设放进去不需要任何配置,
 * 也不需要覆盖任何行。
 *
 * 幂等:内容一致就不动(升级后预设变了会刷新)。写失败只记日志,不影响插件其余功能。
 * @param ctx - host plugin context(用于记日志)。
 */
function ensureUserPreset(ctx) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const source = join(PRESET_ROOT, PRESET_ID);
    const destination = join(home, USER_PRESET_DIR, PRESET_ID);
    if (!existsSync(source)) {
      note(ctx, "warn", `fpga-workbench: 包里没有预设目录 ${source}`);
      return;
    }
    if (sameTree(source, destination)) return;
    cpSync(source, destination, { recursive: true, force: true });
    note(ctx, "info", `fpga-workbench: 已把预设同步到用户预设目录:${destination}`);
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 同步预设到用户目录失败:${error.message}`);
  }
}

/**
 * 递归比较两棵目录树是否一致(只比相对路径与文件内容)。
 * @param left - 源目录。
 * @param right - 目标目录,可能不存在。
 * @returns 完全一致时为 true。
 */
function sameTree(left, right) {
  try {
    if (!existsSync(right)) return false;
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() ? [[relative(left, full), readFileSync(full)]] : [];
      });
    const mine = walk(left);
    const theirs = new Map(walk(right));
    if (mine.length !== theirs.size) return false;
    return mine.every(([name, content]) => {
      const other = theirs.get(name);
      return other !== undefined && Buffer.compare(content, other) === 0;
    });
  } catch {
    return false;
  }
}

/**
 * 挂载宿主半侧。
 * @param ctx - host plugin context carrying `settings`.
 */
export function apply(ctx) {
  const settings = ctx.settings.register(NS, SettingsSchema, { base: {} });

  // 让「FPGA 开发模式」出现在新建会话的预设选择器里。
  ensureUserPreset(ctx);

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
