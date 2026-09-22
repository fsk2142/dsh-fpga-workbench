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

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import z from "@deepseek-ai/schemastery";
import {
  CAPABILITIES,
  FIELDS,
  NS,
  backupChangedFiles,
  cleanupEntry,
  detectTools,
  DORMANT_SUFFIX,
  dormantTargets,
  formatCleanup,
  isDormantPath,
  legacyMigrationPatch,
  listDirectory,
  listEmptySkillDirs,
  listFiles,
  newlyReportedCleanup,
  nextManifest,
  nextReportedCleanup,
  presetFileDiff,
  presetSyncNeeded,
  statusOf
} from "./toolchain.js";
import { scanTemplates } from "./template-library.js";

export { NS };

/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export const STATUS_PATH = "/plugins/fpga-workbench/toolchain";

/** 设置页「浏览…」列目录的路由(弹不出系统对话框时的备选)。与 lib/client.js 里的常量必须一致。 */
export const BROWSE_PATH = "/plugins/fpga-workbench/browse";

/** 设置页「检测本机工具」的路由。与 lib/client.js 里的常量必须一致。 */
export const DETECT_PATH = "/plugins/fpga-workbench/detect";

/** 能力卡展开时读取分类模板的只读路由。与 lib/client.js 里的常量必须一致。 */
export const TEMPLATE_PATH = "/plugins/fpga-workbench/templates";

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
 * "已经提示过哪些待清理项"的记录文件(放在 {@link BACKUP_DIR} 里,理由同上)。
 *
 * 用户定案(2026-09-21):待清理项我们永远不会删,同一批反复提示就成了噪音 —— 这份记录让提醒
 * **只喊一次**。设置页仍显示完整清单,所以"不重复提醒"不等于"藏起来"。
 */
const CLEANUP_REPORTED_FILE = "reported-cleanup.json";

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
    // **停用**过期技能入口(N-11):宿主的技能插件没有白名单配置,`SKILL.md` 还在就会被加载 ——
    // 所以把我们写过、包里已删的那份 `SKILL.md` **改名**(只改名,绝不删除),它就不再进活动技能集。
    // 只动清单证明是我们写的那些文件;用户自己放的技能永远不会进 `stale`。
    const dormant = disableDormantSkills(ctx, destination, stale);
    const justDisabled = new Set(dormant.map((rel) => rel.slice(0, -DORMANT_SUFFIX.length)));
    const pendingCleanup = [
      ...stale
        .filter((rel) => !justDisabled.has(rel))
        .map((rel) => cleanupEntry(isDormantPath(rel) ? "dormant" : "stale", join(destination, rel))),
      ...dormant.map((rel) => cleanupEntry("dormant", join(destination, rel))),
      ...listEmptySkillDirs(join(destination, "skills")).map((dir) => cleanupEntry("emptyDir", dir))
    ];
    reportPendingCleanup(ctx, pendingCleanup, join(home, BACKUP_DIR, CLEANUP_REPORTED_FILE));

    if (!presetSyncNeeded(source, destination, manifest)) {
      // 内容一致也要把清单补上:没有清单,下次就没法分辨"我们的旧文件"与"用户自己放的东西"。
      // 第四轮复审 Q4-06:停用旧技能(改名)与"要不要重新复制内容"是两件事 —— 只要这次**动了**
      // 归属(停用了旧技能),就必须按当前事实重写清单;否则那个 `.disabled-by-plugin` 下一次会被
      // 当成"用户自己放的东西",待清理清单与归属都不再真实。
      if (manifest === undefined || dormant.length > 0) {
        writeManifest(ctx, manifestPath, nextManifest(listFiles(source), stale, dormant));
      }
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
    writeManifest(ctx, manifestPath, nextManifest(listFiles(source), stale, dormant));
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
 * 停用"我们写过、包里已删"的过期技能入口(`skills/**\/SKILL.md`)—— **改名,绝不删除**。
 *
 * 为什么不做"只报告"(第三轮复审 N-11):预设的技能是从用户预设目录扫的,而宿主的技能插件
 * (dsh-skill-filesystem)只有 `includeDefaultRoots` / `customSkillDirs` / `bundledSkillDir` 三个配置,
 * **没有白名单或排除** —— 只要 `SKILL.md` 还在,老技能照样进活动技能集合。改名之后它不再被加载,
 * 文件仍在原地(带上 {@link DORMANT_SUFFIX}),用户随时能改回来。
 *
 * 只处理 `stale` 里那些(判据:上次同步清单记过、包里已没有 = 我们写的);用户自己放进 `skills/`
 * 的技能永远不在 `stale` 里,不会被碰。已经带停用后缀的跳过(幂等)。改名失败只记日志:
 * 顶多是这个旧技能继续被加载,不该让整个同步失败。
 * @param ctx - host plugin context(用于记日志)。
 * @param destination - 用户预设目录。
 * @param stale - {@link presetFileDiff} 的 `stale`(相对路径)。
 * @returns 真正改了名的那些新相对路径(供清单与报告用)。
 */
function disableDormantSkills(ctx, destination, stale) {
  const done = [];
  for (const { from, to } of dormantTargets(stale)) {
    const abs = join(destination, from);
    const target = join(destination, to);
    if (!existsSync(abs)) continue; // 已经不在了(用户自己清了),没什么可停用
    if (existsSync(target)) {
      // 目标名已存在:不覆盖,只报出来(用户可能手工改过名)
      note(ctx, "warn", `fpga-workbench: 停用旧技能时目标名已存在,未动:${to}`);
      continue;
    }
    try {
      renameSync(abs, target);
      done.push(to);
      note(ctx, "info", `fpga-workbench: 过期技能入口已改名停用(**未删除**,可改回):${from} → ${to}`);
    } catch (error) {
      note(ctx, "warn", `fpga-workbench: 停用过期技能入口失败(${error.message});它仍会被加载:${from}`);
    }
  }
  return done;
}

/**
 * 打印"本该清理、但按用户定案没有删"的清单 —— **同一批只提示一次**。
 *
 * 用户定案(2026-09):插件运行时**绝不永久删除**任何文件。插件运行时不 shell、也不加原生依赖,
 * 而 Windows 上把文件送进回收站需要其中之一,所以这里选的是 **零删除 + 如实报告**:绝对路径 +
 * 类别全列出来,处置由使用者自己决定。**这不是"已经安全清掉了"**,只是把"该清理什么"说清楚。
 *
 * 用户定案(2026-09-21):这些条目我们永远不会删,重复提示就成了每天一次的噪音 ——
 * 所以提示只发**新出现的**那几条(记在 {@link CLEANUP_REPORTED_FILE});设置页照旧显示**完整**清单
 * (那是按需去看的),提醒与展示分开:提醒只喊一次,清单一直在。
 * @param ctx - host plugin context(用于记日志)。
 * @param entries - {@link cleanupEntry} 的数组(这次的完整清单)。
 * @param reportedPath - "已提示过"的记录文件路径。
 */
function reportPendingCleanup(ctx, entries, reportedPath) {
  if (entries.length === 0) return;
  const reported = readReportedCleanup(reportedPath);
  const fresh = newlyReportedCleanup(entries, reported);
  // 记录按**这次的清单**重写(剪掉已经不存在的路径):否则同一路径将来重新出现时就不再提示了
  writeReportedCleanup(ctx, reportedPath, nextReportedCleanup(entries));
  if (fresh.length === 0) return;
  note(
    ctx,
    "warn",
    `fpga-workbench: 有 ${entries.length} 项本该清理的文件,按用户定案只报告不删除(请自行处置):\n${formatCleanup(fresh).join("\n")}` +
      (fresh.length < entries.length ? `\n  (另有 ${entries.length - fresh.length} 项之前提示过,不再重复;完整清单在「设置 → FPGA 开发模式」)` : "")
  );
}

/**
 * 读"已提示过"的记录。
 *
 * 和同步清单一样放在 `BACKUP_DIR` 里(**不放进预设目录**):预设目录里多一个文件会让"两棵树是否
 * 一致"永远为假,于是每次启动都白同步一遍。读不动就当没提示过(宁可多说一次,不可漏说)。
 * @param path - 记录文件路径。
 * @returns 路径数组;没有或读不动时为空数组。
 */
function readReportedCleanup(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.paths) ? parsed.paths : [];
  } catch {
    return [];
  }
}

/**
 * 写下"已提示过"的记录(下次只提示新出现的)。
 * @param ctx - host plugin context(用于记日志,可为 undefined)。
 * @param path - 记录文件路径。
 * @param paths - {@link nextReportedCleanup} 的结果。
 */
function writeReportedCleanup(ctx, path, paths) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ updatedAt: new Date().toISOString(), paths }, null, 2));
  } catch (error) {
    // 写不进去的代价只是"下次可能重复提示一次",不影响功能
    note(ctx, "warn", `fpga-workbench: 写「已提示过的待清理项」失败(下次可能重复提示一次):${error.message}`);
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
 * 把旧的全局工具选择与共享路径一次性迁到“通用工具 + 环节首选”模型。
 *
 * 迁移由隐藏的 settingsModelVersion 控制；完成后不会再次介入用户的新选择。工具专属的
 * verilatorPath / modelsimPath / vivadoPath 原地保留,共享路径只在目标为空时迁入。
 *
 * 幂等:版本已经是 2 时什么都不写。失败只记日志 —— 迁移不成功顶多是路径要重填,
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
      () => note(ctx, "info", `fpga-workbench: 已迁移旧工具设置(${keys.join(", ")})`),
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

  // 设置页的四条只读接口(状态 / 列目录 / 检测本机工具 / 分类模板)。webServer 在 headless/CLI 部署里不存在 —— 拿不到就不注册这一步,
  // 设置项本身照常可读写,只是没有状态提示与浏览按钮(GUI 与 CLI 共用同一份配置)。
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
              // preset 是"上次启动时同步成没成"的事实:设置页据此显示一行,失败要看得见
              preset: presetSync()
            });
          }
        }),
      "fpga-workbench: toolchain status route"
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
