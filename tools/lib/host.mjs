// 「profile 在哪儿、DSH 宿主装在哪儿」的**唯一来源**。
//
// 为什么单独成文件:这几个位置原先散在各个脚本里,而且至少一处写成了某台机器的绝对路径
// (`C:/Users/<用户名>/.dsh/...`)。那种默认值有两个后果:
//   · 别人克隆一份就跑不起来(路径根本不存在);
//   · 把开发机的用户名一起提交进公开仓库。
// 现在统一按"环境变量优先 → 常规安装位置 → 明确报错"推导,**仓库里不出现任何用户目录**。
//
// 约定:
//   · `DSH_PROFILE_DIR` 显式覆盖 profile 目录;
//   · `DSH_PROFILE_NAME` 只改 profile 名(默认 desktop);
//   · `DSH_PROFILE_MANIFEST` 直接覆盖 profile 清单路径(安装安全实测用);
//   · `DSH_APP_DIR` 显式覆盖宿主目录(桌面端在 app.asar 里,普通 Node 读不了,
//     所以指向桌面端时由 check-all.mjs 换 Electron 去跑)。
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** 用户主目录;拿不到时为空串(调用方据此给出明确的报错,而不是拼出相对路径)。 */
export function homeDir() {
  return process.env.USERPROFILE ?? process.env.HOME ?? "";
}

/** profile 名(默认 desktop,与官方桌面端一致)。 */
export function profileName() {
  const explicit = process.env.DSH_PROFILE_NAME;
  return explicit !== undefined && explicit !== "" ? explicit : "desktop";
}

/**
 * profile 目录。
 * @returns 绝对路径;主目录取不到时返回空串 —— 调用方必须检查。
 */
export function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR;
  if (explicit !== undefined && explicit !== "") return explicit;
  const home = homeDir();
  if (home === "") return "";
  return join(home, ".dsh", "profiles", profileName());
}

/** profile 清单(package.json)。 */
export function profileManifest() {
  const explicit = process.env.DSH_PROFILE_MANIFEST;
  if (explicit !== undefined && explicit !== "") return explicit;
  const dir = profileDir();
  return dir === "" ? "" : join(dir, "package.json");
}

/**
 * 可能装着 DSH 宿主的位置,按优先级排列(**只列候选,不判断有效性**)。
 *
 * 桌面端排在最前:它是用户实际在跑的那个;npm 全局那份往往版本陈旧。
 * 旧桌面端(`Program Files/DSH Desktop`)留作最后兜底 —— 老版本升级上来的人还在用。
 * @returns 绝对路径数组(去重);全部由环境变量推出,不写死任何用户名。
 */
export function hostCandidates() {
  const out = [];
  const explicit = process.env.DSH_APP_DIR;
  if (explicit !== undefined && explicit !== "") out.push(explicit);
  const local = process.env.LOCALAPPDATA;
  if (local !== undefined && local !== "") {
    // 官方桌面端:运行时整个在 app.asar 里,要指向 asar 内的 dsh 目录。
    // 普通 Node 读不了 asar,所以这条候选只在 Electron 下(或 asar 被解包时)才算数 ——
    // 由 hostDir() 的实际探测决定,不在这里预先排除。
    out.push(join(local, "Programs", "DeepSeek Harness", "resources", "app.asar", "dsh"));
  }
  const roaming = process.env.APPDATA;
  if (roaming !== undefined && roaming !== "") {
    out.push(join(roaming, "npm", "node_modules", "@deepseek-ai", "dsh"));
  }
  // 旧桌面端的固定安装位置:只在它真的存在时才进候选(否则没必要让候选表里挂着一条死路径)。
  const legacy = "C:\\Program Files\\DSH Desktop\\resources\\app";
  if (existsSync(legacy)) out.push(legacy);
  return [...new Set(out)];
}

/**
 * 桌面端的安装根(`.../Programs/DeepSeek Harness`),没装时为空串。
 *
 * 判断依据是**外层的 exe 与 app.asar 文件存在**,而不是 asar 内部的 package.json ——
 * 后者普通 Node 读不到,拿它当判据会在"明明装了桌面端"的机器上判成没装。
 * @returns 安装根目录,或空串。
 */
export function desktopRoot() {
  const local = process.env.LOCALAPPDATA;
  if (local === undefined || local === "") return "";
  const root = join(local, "Programs", "DeepSeek Harness");
  const exe = join(root, "DeepSeek Harness.exe");
  const asar = join(root, "resources", "app.asar");
  return existsSync(exe) && existsSync(asar) ? root : "";
}

/**
 * 桌面端自带的 Electron 可执行文件,以及它的 Node 运行环境。
 *
 * 官方桌面端把运行时放在 `app.asar` 里,普通 Node 的 `fs` 读不到 asar 内部 ——
 * 但 Electron 的 fs **支持 asar**。所以凡是"要 require 宿主里的包"的子检查
 * (冒烟测试、加载契约)都必须用它来跑,`ELECTRON_RUN_AS_NODE=1` 让它以纯 Node 身份执行。
 * @returns `{ command, env }`;没装桌面端时 `command` 为空串。
 */
export function desktopElectron() {
  const root = desktopRoot();
  if (root === "") return { command: "", env: {} };
  return {
    command: join(root, "DeepSeek Harness.exe"),
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      DSH_APP_DIR: join(root, "resources", "app.asar", "dsh")
    }
  };
}

/**
 * 挑一个"存在 package.json"的宿主目录。
 *
 * 这里**只证明目录形状对**(能被 createRequire 当锚点),不判断版本 —— 版本筛选是
 * check-all.mjs 的事(它要对着兼容声明比)。单独调用本脚本时,形状对就够跑。
 * @returns 宿主目录;一个都不像时为空串。
 */
export function hostDir() {
  for (const candidate of hostCandidates()) {
    if (!existsSync(join(candidate, "package.json"))) continue;
    // 指向 asar 内部时只有 Electron 的 fs 看得见。普通 Node 在这里 existsSync 已经是 false
    // (所以到不了这一步);加这一条是为了在"asar 被解包到磁盘"的机器上也别误判成普通目录。
    if (candidate.includes(".asar") && !process.versions.electron) continue;
    return candidate;
  }
  return "";
}

/**
 * 挑一个**真的能提供现代 schemastery** 的宿主目录。
 *
 * `hostDir()` 只看目录形状,于是本机会挑到 npm 全局那份陈旧的 `@deepseek-ai/dsh`
 * (实测 0.1.1-rc.2,它的 schemastery 没有 `.volatile()`)—— 冒烟测试随后报
 * `z.string(...).default(...).volatile is not a function`,而那**不是插件的错**,
 * 是"用错宿主做验证"。这里按能力探测:`@deepseek-ai/schemastery` 能解析、
 * 且 `.volatile` 存在,才算可用宿主。
 *
 * 桌面端把运行时放在 `app.asar` 里,普通 Node 读不到 —— 那种候选在这里会自然落选,
 * 由 check-all.mjs 改用 Electron 去跑(它会显式传 DSH_APP_DIR 下来)。
 * @returns `{ dir, version, problem }`;`dir` 为空串表示没找到可用宿主。
 */
export function compatibleHostDir() {
  const tried = [];
  for (const candidate of hostCandidates()) {
    if (!existsSync(join(candidate, "package.json"))) {
      tried.push(`${candidate}(没有 package.json,普通 Node 读不到时常见于 app.asar)`);
      continue;
    }
    const version = readHostVersion(candidate);
    const schemastery = probeSchemastery(candidate);
    if (!schemastery.ok) {
      tried.push(`${candidate}(v${version ?? "?"}:${schemastery.problem})`);
      continue;
    }
    return { dir: candidate, version, problem: undefined, tried };
  }
  return { dir: "", version: undefined, problem: tried.join(";"), tried };
}

/** 读宿主 package.json 的 version;读不到为 undefined。 */
function readHostVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/**
 * 宿主是否提供了**本插件真正用得上**的 schemastery。
 *
 * 本插件的 `SettingsSchema` 全篇依赖 `.volatile()`(DSH 0.1.7 起 settings 只收 volatile 字段),
 * 而旧宿主的 schemastery 没有这个方法 —— 加载时抛 `z.string(...).default(...).volatile is not a
 * function`,看着像插件坏了,其实是"用错宿主做验证"。
 *
 * 所以这里不看版本号、**直接试能力**:真的 require 进来,建一个字符串 schema,调 `.volatile()`。
 * 拿版本号当判据会骗人(全局那份 dsh 0.1.1-rc.2 的 schemastery 版本看着够新,能力却不够)。
 * @returns `{ ok, version, problem }`。
 */
function probeSchemastery(dir) {
  let resolved;
  try {
    resolved = createRequire(join(dir, "package.json")).resolve("@deepseek-ai/schemastery");
  } catch (error) {
    return { ok: false, problem: `解析不到 @deepseek-ai/schemastery(${String(error.code ?? error)})` };
  }
  let version;
  try {
    // …/node_modules/@deepseek-ai/schemastery/<入口> → 往上找到包根读版本(只为报错时更好认)
    for (let at = dirname(resolved); at !== dirname(at); at = dirname(at)) {
      if (at.endsWith("schemastery")) {
        version = JSON.parse(readFileSync(join(at, "package.json"), "utf8")).version;
        break;
      }
    }
  } catch {
    version = undefined;
  }
  try {
    const require = createRequire(join(dir, "package.json"));
    const schema = require("@deepseek-ai/schemastery");
    const z = typeof schema?.default === "function" ? schema.default : schema;
    const built = z.string().default("").volatile();
    if (typeof built !== "object" || built === null) {
      return { ok: false, version, problem: "schemastery 的 schema 构造结果不是对象" };
    }
    return { ok: true, version, problem: undefined };
  } catch (error) {
    return {
      ok: false,
      version,
      problem: `schemastery 不支持本插件要用的 .volatile()(${String(error?.message ?? error)})`
    };
  }
}

/** 统一的"找不到就说清楚怎么给"提示。 */
export const HOST_HINT =
  "设置环境变量 DSH_APP_DIR 指向 DSH 安装目录(桌面端在 resources/app,内含 package.json)";

/** 统一的 profile 提示。 */
export const PROFILE_HINT =
  "设置环境变量 DSH_PROFILE_DIR 指向 profile 目录(例如 <DSH_HOME>/profiles/desktop)";

/**
 * 把 `@deepseek-ai/*` 这类**宿主提供的裸依赖**接到宿主目录上去。
 *
 * 为什么需要这一步(2026-10-21,换台机器才会暴露):本插件声明的是 peerDependency,
 * 自己不带 `@deepseek-ai/schemastery`。真机上 DSH 有自己的 profile 解析层
 * (`dsh-app-boot` 的 profile-resolution-bootstrap)把这些裸名路由到宿主,
 * **profile 的 node_modules 里根本没有它们**(hoisted 布局下实测为 0 个包)。
 *
 * 于是冒烟测试只 `import(已装/index.js)` 时,本机能碰巧跑通 —— Electron 的 asar 支持
 * 会一路往上找;换台机器就 `ERR_MODULE_NOT_FOUND`,而那报的是**测试环境的解析方式**,
 * 不是插件坏了。这里显式复刻宿主那层路由,让这条检查到哪儿都一样。
 *
 * 只在 Node 支持同步 resolve hook 时启用;不支持就如实返回 `enabled:false`,不假装验过。
 * @param appDir - 宿主目录(内含 node_modules);空串表示没找到宿主。
 * @returns `{ enabled, moduleRoot, reason }`。
 */
export function installHostPeerResolution(appDir) {
  if (appDir === "") return { enabled: false, moduleRoot: "", reason: "没有找到宿主安装目录" };
  const moduleRoot = join(appDir, "node_modules");
  if (!existsSync(moduleRoot)) {
    return { enabled: false, moduleRoot, reason: `宿主目录里没有 node_modules:${moduleRoot}` };
  }
  const moduleBuiltin = process.getBuiltinModule?.("node:module");
  const registerHooks = moduleBuiltin?.registerHooks;
  if (typeof registerHooks !== "function") {
    return {
      enabled: false,
      moduleRoot,
      reason: "当前 Node 没有 module.registerHooks(需要 22.15+/23.5+),裸依赖仍按默认规则解析"
    };
  }
  // 宿主目录里的一个"虚拟父模块":用它当 parentURL,裸名就会从宿主的 node_modules 解析。
  const anchor = pathToFileURL(join(moduleRoot, "__dsh_host_anchor__.mjs")).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // 只接管宿主自己的裸名;相对/绝对/URL 与其它包原样交给 Node。
      if (specifier.startsWith("@deepseek-ai/")) {
        try {
          return nextResolve(specifier, { ...context, parentURL: anchor });
        } catch {
          // 宿主里也没有 → 退回默认解析,让原始错误照常抛出来
        }
      }
      return nextResolve(specifier, context);
    }
  });
  return { enabled: true, moduleRoot, reason: "" };
}
