// 宿主半侧:注册工具链设置、登记预设根、探测路径是否就绪,并给设置页一个只读状态接口。
//
// 三件事:
//   1. ctx.settings.register —— 「设置 → FPGA 开发模式」的字段,存进 settings.yaml。
//   2. ensureUserPreset —— 把本包自带的预设同步进用户预设目录(见那里的长注释)。
//   3. 只读 HTTP 路由 —— 设置页拿它显示状态(浏览器不能 stat 本地文件)。
//
// **配置全部在宿主侧**,所以图形界面和命令行跑的是同一份设置:CLI/headless 没有
// webServer 时只是少一个设置页,路径本身照常可用。
//
// **刻意不往会话提示里注入任何东西。** 提示段注册在插件行(profile 层),作用域是全局,
// 那样普通会话也会看到 FPGA 工具链的信息与警告,与"不影响正常会话"冲突。所以工具链那
// 段提示由 **lib/mode.js** 注册 —— 它只从本预设的组装里挂载,作用域是 agent 作用域。
// 一句话:插件行管"配置 + 探测",模式行管"这个模式知道什么"。

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import z from "@deepseek-ai/schemastery";
import {
  FIELDS,
  NS,
  backupChangedFiles,
  cleanupEntry,
  detectTools,
  formatCleanup,
  legacyMigrationPatch,
  listDirectory,
  listEmptySkillDirs,
  listFiles,
  presetFileDiff,
  presetSyncNeeded,
  statusOf
} from "./toolchain.js";

export { NS };

/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export const STATUS_PATH = "/plugins/fpga-workbench/toolchain";

/** 设置页「浏览…」列目录的路由(弹不出系统对话框时的备选)。与 lib/client.js 里的常量必须一致。 */
export const BROWSE_PATH = "/plugins/fpga-workbench/browse";

/** 设置页「检测本机工具」的路由。与 lib/client.js 里的常量必须一致。 */
export const DETECT_PATH = "/plugins/fpga-workbench/detect";

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
 * 上一次预设同步的结果 —— **只报事实**:不自动修复,也不决定任何流程。
 *
 * 为什么要有它:同步失败原本只写一条日志,用户看到的现象是"预设列表里没有「FPGA 开发模式」",
 * 却不知道为什么。设置页的状态接口把这个对象原样带出去,由页面显示。
 * `state` ∈ `pending`(还没跑)/ `up-to-date`(内容一致,无需动作)/ `synced`(本次同步过)/ `failed`。
 * `pendingCleanup` 是**本该清理、但按用户定案没有删**的文件清单(绝对路径 + 类别,见
 * lib/toolchain.js 的 CLEANUP_KINDS)—— 页面/使用者据此自己处置。
 */
let lastPresetSync = { id: PRESET_ID, state: "pending" };

/** 记一次预设同步的结果。 */
function recordPresetSync(patch) {
  lastPresetSync = { ...lastPresetSync, ...patch };
}

/**
 * 上一次预设同步的结果(设置页诊断用)。
 * @returns 结果的副本,免得调用方改到内部状态。
 */
export function presetSync() {
  return { ...lastPresetSync };
}

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
 * 当前状态:每项的存在情况 + 给设置页用的汇总。
 *
 * 实现在 lib/toolchain.js(纯逻辑,自检能直接跑它);这里只是转出去,保持原有导入路径可用,
 * 顺便让冒烟测试能在**已装副本**上验这两件事。
 */
export { legacyMigrationPatch, listEmptySkillDirs, statusOf } from "./toolchain.js";

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
 * 三件事,顺序不能反:
 * 1. **先备份**:用户自己改过或新增的文件留一份(这个目录是用户的地盘);
 * 2. **列出该清理的**:上次清单里记过、包里已没有的文件(过期技能/模板)+ `skills/` 下的空
 *    技能目录。**只列不删** —— 用户定案:插件运行时绝不永久删除(见 {@link reportPendingCleanup})。
 *    不列的话,弃用技能会一直在被加载,而用户不知道那是从哪里来的。判断依据是"我们写过没有",
 *    不是"它在不在 skills/ 这种目录下"(那条口径会把**用户自己写的技能**也算进去)。
 * 3. **再同步** + 写下这次的清单(供下次算"哪些是我们写的")。
 *
 * 幂等:包内内容一致就整个跳过(过期文件不再触发同步 —— 同步清不掉它,见 presetSyncNeeded)。
 * 写失败只记日志,不影响插件其余功能。
 * @param ctx - host plugin context(用于记日志)。
 */
function ensureUserPreset(ctx) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const source = join(PRESET_ROOT, PRESET_ID);
    const destination = join(home, USER_PRESET_DIR, PRESET_ID);
    const manifestPath = join(home, BACKUP_DIR, MANIFEST_FILE);
    const manifest = readManifest(manifestPath);
    if (!existsSync(source)) {
      note(ctx, "warn", `fpga-workbench: 包里没有预设目录 ${source}`);
      recordPresetSync({ dir: destination, state: "failed", error: `包里没有预设目录 ${source}` });
      return;
    }

    // 该清理的东西:**清单里记过、包里已没有**的文件(过期技能/模板)+ skills/ 下的空技能目录。
    // 判据是"我们写过没有",不是"它在不在 skills/ 这种目录下"(后者会把用户自己写的技能也列进来)。
    const { stale, foreign } = presetFileDiff(source, destination, manifest);
    const pendingCleanup = [
      ...stale.map((rel) => cleanupEntry("stale", join(destination, rel))),
      ...listEmptySkillDirs(join(destination, "skills")).map((dir) => cleanupEntry("emptyDir", dir))
    ];
    reportPendingCleanup(ctx, pendingCleanup);

    if (!presetSyncNeeded(source, destination, manifest)) {
      // 内容一致也要把清单补上:没有清单,下次就没法分辨"我们的旧文件"与"用户自己放的东西"
      // (清单只在自己不在时写一次,不是每次启动都写)
      if (manifest === undefined) writeManifest(ctx, manifestPath, listFiles(source));
      recordPresetSync({ dir: destination, state: "up-to-date", error: undefined, pendingCleanup });
      return;
    }

    const backup = backupChangedFiles(source, destination, join(home, BACKUP_DIR, timestamp()));
    if (backup !== undefined) {
      note(ctx, "info", `fpga-workbench: 用户预设目录里有 ${backup.count} 个文件与包内版本不同,已备份到 ${backup.dir}`);
    }

    // 清单里没有的 = **用户自己的东西**(他自己写的技能、笔记、模板)。一概保留,并报出来 ——
    // 静默保留会让人不知道"这个技能是本插件给的还是我自己放的";用户放 skills/ 下的技能
    // 会被预设加载,更该让他看见。
    if (foreign.length > 0) {
      const userSkills = foreign.filter((rel) => rel.startsWith("skills/"));
      note(
        ctx,
        "info",
        `fpga-workbench: 预设目录里发现 ${foreign.length} 个非本插件文件,已保留(不在同步清单里,不动用户的东西):${foreign.join("、")}` +
          (userSkills.length > 0 ? `;其中 skills/ 下的 ${userSkills.length} 个会被本预设当作技能加载` : "")
      );
    }

    cpSync(source, destination, { recursive: true, force: true });
    // 清单 = 包里这些 + 我们写过、包里已删、但**仍留在原地**的那些。都要记:漏记的话,下次它们
    // 就会被当成"用户自己放的东西"(foreign),报告就变成了误导。过期文件由此一直是"已知的待清理项"。
    writeManifest(ctx, manifestPath, [...new Set([...listFiles(source), ...stale])].sort());
    note(
      ctx,
      "info",
      `fpga-workbench: 已把预设同步到用户预设目录:${destination}` +
        (pendingCleanup.length > 0 ? `;另有 ${pendingCleanup.length} 项待清理(未删除,见上面的清单)` : "")
    );
    recordPresetSync({ dir: destination, state: "synced", backupDir: backup?.dir, error: undefined, keptForeign: foreign.length, keptForeignFiles: foreign, pendingCleanup });
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 同步预设到用户目录失败:${error.message}`);
    recordPresetSync({ state: "failed", error: error.message });
  }
}

/**
 * 打印"本该清理、但按用户定案没有删"的清单。
 *
 * 用户定案(2026-09):插件运行时**绝不永久删除**任何文件。插件运行时不 shell、也不加原生依赖,
 * 而 Windows 上把文件送进回收站需要其中之一,所以这里选的是 **零删除 + 如实报告**:绝对路径 +
 * 类别全列出来,处置由使用者自己决定。**这不是"已经安全清掉了"**,只是把"该清理什么"说清楚。
 * @param ctx - host plugin context(用于记日志)。
 * @param entries - {@link cleanupEntry} 的数组。
 */
function reportPendingCleanup(ctx, entries) {
  if (entries.length === 0) return;
  note(
    ctx,
    "warn",
    `fpga-workbench: 有 ${entries.length} 项本该清理的文件,按用户定案只报告不删除(请自行处置):\n${formatCleanup(entries).join("\n")}`
  );
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

  // 不再有"缓存目录"这回事(用户定案:每个阶段的产物放各自阶段的目录里),所以这里
  // 也没有"开一次就把目录建出来"这一步了。

  // 设置页的三条只读接口(状态 / 列目录 / 检测本机工具)。webServer 在 headless/CLI 部署里不存在 —— 拿不到就不注册这一步,
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
          handler: (req, res) => {
            const values = settings.get();
            // 查询串里带上字段名 = "**预演**这一次改动":设置页有未保存的改动时用它问一次,
            // 于是"就绪/未就绪"跟着**页面上那一份**走,而不是等保存后才更新。
            // 只读:不写设置,也不建任何目录。
            json(res, {
              ...statusOf({ ...values, ...pendingOverrides(req) }),
              // preset 是"上次启动时同步成没成"的事实:设置页据此显示一行,失败要看得见
              preset: presetSync()
            });
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

    // 「检测本机工具」:把机器上找到的候选连同来源报给设置页。**只有 PowerShell / Python 两条
    // 候选会起一次只读的版本查询**(版本是执行约束的一部分,见 toolchain.js 的 queryVersion),
    // 其余一律只探文件系统。
    // **不传设置值**:检测只报机器事实,按当前选中的工具筛选、以及"填没填"由页面判断 ——
    // 页面才看得到那些**未保存的改动**(刚换了工具还没保存时,回声已保存的值会答非所问)。
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: DETECT_PATH,
          handler: (_req, res) => json(res, { found: detectTools() })
        }),
      "fpga-workbench: tool detection route"
    );
  });
}

export const name = "fpga-workbench";
export const inject = ["settings"];
