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

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import z from "@deepseek-ai/schemastery";
import {
  FIELDS,
  NS,
  backupChangedFiles,
  inspectTools,
  legacyMigrationPatch,
  listDirectory,
  listFiles,
  probeFilesystem,
  staleShippedFiles,
  statusOf
} from "./toolchain.js";

export { NS };

/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export const STATUS_PATH = "/plugins/fpga-workbench/toolchain";

/** 设置页「浏览…」列目录的路由(弹不出系统对话框时的备选)。与 lib/client.js 里的常量必须一致。 */
export const BROWSE_PATH = "/plugins/fpga-workbench/browse";

/** 预设 id(= 预设目录名)。 */
const PRESET_ID = "fpga-workbench";

/** 用户预设目录名(harness home 下),与 dsh-agent-presets 的约定一致。 */
const USER_PRESET_DIR = ".agent-presets";

/** 覆盖用户预设前的备份目录(harness home 下)。**不能**放进 .agent-presets 里:那底下每个目录都会被当成预设去扫。 */
const BACKUP_DIR = ".fpga-workbench-backup";

/**
 * 同步清单文件名(记我们写过哪些文件),放在 {@link BACKUP_DIR} 里。
 *
 * 必须放在预设目录**外面**:放里面会让"包内那棵树与用户那棵树是否一致"永远为假,
 * 于是每次启动都白同步一遍。
 */
const MANIFEST_FILE = "synced-files.json";

/**
 * 本包自带的预设根。
 *
 * 用 `import.meta.url` 而不是补丁里的 `!!js ... new URL('presets/', baseUrl)`:
 * 后者依赖"补丁 !!js 求值时的 baseUrl 是补丁文件所在目录"这个假设,而实测那个假设
 * 不成立 —— 路径落在别处、目录不存在,scanRoot 对不存在的根**静默返回空**,于是预设
 * 从名单里消失且没有任何报错。模块自身的 URL 不依赖任何假设。
 */
const PRESET_ROOT = fileURLToPath(new URL("../presets/", import.meta.url));

/**
 * 设置 schema:每个字段一个字符串。
 *
 * 默认值来自字段定义 —— 下拉字段(语言/标准/仿真器)有非空默认值,路径字段默认空。
 * 下拉的默认值必须与选项对齐,否则 statusOf 会把它报成"取值不在选项里"。
 */
export const SettingsSchema = z.object(
  Object.fromEntries(FIELDS.map((field) => [field.key, z.string().default(field.default ?? "")]))
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
 * 幂等:内容一致就不动(升级后预设变了会刷新)。**用户自己改过的文件先备份再覆盖** ——
 * 这个目录既然是用户的,就不能拿我们的版本无条件盖掉他的改动。
 * 写失败只记日志,不影响插件其余功能。
 * @param ctx - host plugin context(用于记日志)。
 */
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
 * 三件事,顺序不能反:
 * 1. **先备份**:用户自己改过或新增的文件留一份(这个目录是用户的地盘);
 * 2. **删掉我们从包里删掉的**:`cpSync` 只合并不删多余的,而**技能是从用户目录扫的**
 *    (预设的 customSkillDirs 相对预设文件解析)—— 不删的话,弃用技能会一直在被加载;
 * 3. **再同步** + 写下这次的清单(供下次算"哪些是我们写的")。
 *
 * 幂等:内容一致就整个跳过。写失败只记日志,不影响插件其余功能。
 * @param ctx - host plugin context(用于记日志)。
 */
function ensureUserPreset(ctx) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const source = join(PRESET_ROOT, PRESET_ID);
    const destination = join(home, USER_PRESET_DIR, PRESET_ID);
    const manifestPath = join(home, BACKUP_DIR, MANIFEST_FILE);
    if (!existsSync(source)) {
      note(ctx, "warn", `fpga-workbench: 包里没有预设目录 ${source}`);
      return;
    }
    if (sameTree(source, destination)) {
      // 内容一致也要把清单补上:没有清单,下次我们删文件时没人知道那是我们写的
      // (清单只在自己不在时写一次,不是每次启动都写)
      if (readManifest(manifestPath) === undefined) writeManifest(ctx, manifestPath, listFiles(source));
      return;
    }

    const backup = backupChangedFiles(source, destination, join(home, BACKUP_DIR, timestamp()));
    if (backup !== undefined) {
      note(ctx, "info", `fpga-workbench: 用户预设目录里有 ${backup.count} 个文件与包内版本不同,已备份到 ${backup.dir}`);
    }

    const stale = staleShippedFiles(source, destination, readManifest(manifestPath));
    for (const rel of stale) {
      unlinkSync(join(destination, rel));
    }
    if (stale.length > 0) {
      note(ctx, "info", `fpga-workbench: 已清掉 ${stale.length} 个包内不再提供的文件:${stale.join("、")}`);
    }

    cpSync(source, destination, { recursive: true, force: true });
    writeManifest(ctx, manifestPath, listFiles(source));
    note(ctx, "info", `fpga-workbench: 已把预设同步到用户预设目录:${destination}`);
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 同步预设到用户目录失败:${error.message}`);
  }
}

/** 备份目录名用的时间戳(文件名安全)。 */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

/**
 * 读上次同步写下的清单(我们写过哪些文件)。
 *
 * 放在 `BACKUP_DIR` 里、**不放进预设目录**:预设目录里多一个文件会让"两棵树是否一致"
 * 永远为假,于是每次启动都白同步一遍。
 * @param path - 清单文件路径。
 * @returns 相对路径数组;没有或读不动时返回 undefined(那时的策略是"什么都不删")。
 */
function readManifest(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.files) ? parsed.files : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写下这次同步的清单。
 * @param ctx - host plugin context(用于记日志,可为 undefined)。
 * @param path - 清单文件路径。
 * @param files - 相对路径数组(见 {@link listFiles})。
 */
function writeManifest(ctx, path, files) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ syncedAt: new Date().toISOString(), files }, null, 2));
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 写同步清单失败(下次不会自动清理旧文件):${error.message}`);
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
 * 把改名前的旧键搬进新键。
 *
 * 三个路径字段改过名(verilatorPath → compilerPath 等)。只在 valueOf 里兜底是不够的:
 * 那样宿主认旧值、设置页读新值,就会出现"框是空的、状态却已就绪"。这里把值真的搬过去。
 *
 * 幂等:没有可迁移的项时什么都不写。失败只记日志 —— 迁移不成功顶多是路径要重填,
 * 不该影响插件其余部分。
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
      () => note(ctx, "info", `fpga-workbench: 已迁移旧字段到新字段(${keys.join(", ")})`),
      (error) => note(ctx, "warn", `fpga-workbench: 旧字段迁移失败,请重新填一次路径:${error.message}`)
    );
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 旧字段迁移失败,请重新填一次路径:${String(error)}`);
  }
}

/**
 * 挂载宿主半侧。
 * @param ctx - host plugin context carrying `settings`.
 */
export function apply(ctx) {
  const settings = ctx.settings.register(NS, SettingsSchema, { base: {} });

  // 把改名前的旧键搬进新键(一次性,幂等)。必须在设置页读值之前做 ——
  // 否则会出现"输入框是空的、状态却显示已就绪"这种自相矛盾的画面。
  migrateLegacyKeys(settings, ctx);

  // 让「FPGA 开发模式」出现在新建会话的预设选择器里。
  ensureUserPreset(ctx);

  // 开一次就先把缓存目录建出来,用户第一次打开设置页看到的就是就绪状态。
  ensureCacheDir(settings.get());

  // 设置页的两条只读接口。webServer 在 headless/CLI 部署里不存在 —— 拿不到就不注册这一步,
  // 设置项本身照常可读写,只是没有状态提示与浏览按钮(GUI 与 CLI 共用同一份配置)。
  ctx.inject(["webServer"], (webCtx) => {
    const json = (res, payload) => {
      res.writeHead(200, {
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
          handler: (_req, res) => {
            const values = settings.get();
            // 每次查询都补一次:用户可能刚改了缓存路径,或手工删掉了那个目录
            ensureCacheDir(values);
            json(res, statusOf(values));
          }
        }),
      "fpga-workbench: toolchain status route"
    );

    // 「浏览…」用:列一个目录,让用户在界面上点选文件/目录,而不是手打路径。
    // 只读 —— 不创建、不删除、不改名;鉴权与状态路由相同(桌面端自带 Host/Origin 围栏)。
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
  });
}

export const name = "fpga-workbench";
export const inject = ["settings"];
