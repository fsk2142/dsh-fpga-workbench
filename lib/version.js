// 版本与「有没有新版」。
//
// 三件事:
//   1. 把这个包自己的版本、以及它声明兼容的 DSH 版本,汇成一处 —— 免得版本号散落在
//      package.json、README、补丁里各写一遍、各漂各的;
//   2. 版本号解析与比较(纯函数,自检直接打靶);
//   3. 检查更新 —— **走 DSH 自带的市场更新 API**,而不是自己去问 GitHub。
//
// ## 为什么走市场 API(2026-10-21,参 dsh-llm-account 的做法后改的)
//
// 早先这版是自己请求 `api.github.com/repos/<owner>/<repo>/tags` 再比版本号。那有个
// **实质性错误**:它分不出"这个插件是怎么装的"。本插件常见的装法是 `file:` / 链接到
// 源码目录(开发模式),那种安装**永远不会通过更新按钮变化** —— 改代码刷新就生效。
// 自己比 tag 会对这种安装报"已是最新",让用户等一个永远不来的东西。
//
// 宿主那边的 `dshmarket` 早就把这件事算好了(`dsh-market/update-api/v1`):
//
//   GET /dsh-market/api/v1/updates?name=dsh-fpga-workbench&force=1
//   → { "package": { "source": "linked", "installedVersion": "0.5.0",
//                    "latestVersion": null, "updateAvailable": false } }
//
// 它知道安装方式(`linked` / `file` / `git` / `npm`)、知道真实已装版本、知道有没有新版。
// 同源请求自带会话 cookie,不需要额外的凭据,也不受 GitHub 限流影响。
//
// 几条刻意的取舍:
//   · **不自动检查、不后台轮询**。只有用户点了设置页那个按钮才会发请求。
//   · **不把结果写进设置**。检查更新是瞬时事实,不是配置。
//   · **失败就是失败**。市场缺席(404)、宿主太老、网络失败 —— 各自如实说明,
//     绝不编一个"已是最新"。这类"看起来是绿的"是自检里最坏的一种。
//   · **区分「不会更新」与「已是最新」**。链接安装是前者,不是后者。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 包根(本文件在 lib/ 下)。 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 读本包的清单。读不到时抛 —— 版本号读不出来,后面所有判断都没有意义。
 * @returns package.json 解析结果。
 */
export function readManifest() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
}

/**
 * 本插件自己的版本与它声明的兼容范围。
 * @returns `{ version, description, repository, dshRange, releases }`。
 */
export function packageInfo() {
  const manifest = readManifest();
  return {
    version: String(manifest.version ?? ""),
    description: String(manifest.description ?? ""),
    repository: manifest.repository?.url ?? manifest.repository ?? "",
    dshRange: String(manifest.dsh?.compatibility?.dsh ?? ""),
    releases: Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
  };
}

/**
 * 把版本号切成可比较的三段数字。
 *
 * 只处理 `x.y.z` 与带 `-rc.N` 后缀的形式 —— 本仓库就用这两种,不引 semver 依赖。
 * @param text - 版本字符串。
 * @returns `{ major, minor, patch, pre }`;认不出时返回 undefined。
 */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(text ?? "").trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? ""
  };
}

/**
 * 比较两个版本。预发布版(`-rc.1`)排在对应的正式版**之前**。
 * @param left - 版本字符串。
 * @param right - 版本字符串。
 * @returns 负数表示 left 更旧,0 表示相同,正数表示 left 更新;任一认不出时返回 undefined。
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return undefined;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  // 正式版 > 预发布版;两个都有预发布标记时按**段**比:
  // 直接按字符串比会把 rc.10 判成比 rc.2 小(`"rc.10" < "rc.2"`),那是错的。
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return comparePreRelease(a.pre, b.pre);
}

/**
 * 比较两段预发布标记,数字段按数值比、其余按字典序。
 *
 * 例:`rc.2` < `rc.10`;`alpha` < `beta`;`rc.1` < `rc.1.2`。
 * @param left - 预发布标记(不含 `-`)。
 * @param right - 另一个。
 * @returns 负数/0/正数。
 */
function comparePreRelease(left, right) {
  const split = (text) => String(text).split(".");
  const a = split(left);
  const b = split(right);
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    if (a[at] === undefined) return -1;
    if (b[at] === undefined) return 1;
    const na = /^\d+$/u.test(a[at]) ? Number(a[at]) : undefined;
    const nb = /^\d+$/u.test(b[at]) ? Number(b[at]) : undefined;
    if (na !== undefined && nb !== undefined) {
      if (na !== nb) return na - nb;
      continue;
    }
    // 数字段排在非数字段之前(SemVer 的口径)
    if (na !== undefined && nb === undefined) return -1;
    if (na === undefined && nb !== undefined) return 1;
    if (a[at] !== b[at]) return a[at] < b[at] ? -1 : 1;
  }
  return 0;
}

/**
 * 把 package.json 里的各种 repository 写法归一成 `owner/repo`。
 *
 * 本包没有 `repository` 字段(发布到 npm 时也没打算带),所以**回退到 README 里那份
 * 安装命令** —— 它是仓库地址唯一的既有出处,别再抄一份。
 * @returns `owner/repo`;认不出来时为空串。
 */
export function repositorySlug() {
  const info = packageInfo();
  const fromManifest = /github\.com[:/]([^/]+)\/([^/#.]+)/u.exec(String(info.repository));
  if (fromManifest !== null) return `${fromManifest[1]}/${fromManifest[2]}`;
  try {
    const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
    const fromReadme = /github\.com[:/]([^/\s]+)\/([^/#\s.]+)/u.exec(readme);
    if (fromReadme !== null) return `${fromReadme[1]}/${fromReadme[2]}`;
  } catch {
    // 读不到 README 就如实返回空 —— 由调用方说明"没配仓库地址"
  }
  return "";
}

/**
 * DSH 市场更新 API 的版本化前缀。见 dshmarket 的 `UPDATE-API-V1.md`。
 *
 * 同源 HTTP 接口:浏览器里 fetch 自带 DSH 的会话 cookie,不需要额外凭据 ——
 * 这也是那个 API 文档给插件 UI 的用法。
 */
const MARKET_API = "/dsh-market/api/v1";

/**
 * 这些 `source` 意味着「这种安装不会通过更新按钮变化」。
 *
 * `linked` 是符号链接/junction 到源码目录(开发模式,本机就是这种);`file` 是本地路径装。
 * 两者都**跟着源码走** —— 改代码刷新就生效,不存在"更新"这个动作。
 * 把它们与「已是最新」分开很重要:后者意味着"以后会有新版,现在没有"。
 */
const NON_UPDATABLE_SOURCES = new Set(["linked", "file", "directory", "workspace"]);

/** 从响应里取 `package` 对象(形状不可信,逐项校验)。 */
function packageOf(payload) {
  if (typeof payload !== "object" || payload === null) return undefined;
  const pkg = payload.package;
  if (typeof pkg !== "object" || pkg === null) return undefined;
  return pkg;
}

/**
 * 把一次市场 API 响应翻成界面能直接用的结论。**纯函数**,便于自检打靶。
 *
 * 判断顺序有意为之:先看「这种安装能不能更新」,再看有没有新版 —— 否则一个链接安装
 * 会被画成「已是最新」,而那是错的。
 * @param payload - 已解析的 JSON。
 * @returns `{ ok, kind, installed, latest, source, reason }`。
 *   `kind`: `available`(有新版) / `current`(已最新) / `not-applicable`(此安装不会更新) / `unknown`(查不到)。
 */
export function updateStateOf(payload) {
  const pkg = packageOf(payload);
  if (pkg === undefined) {
    return { ok: false, kind: "unknown", installed: "", latest: "", source: "", reason: "更新接口没有返回 package 字段" };
  }
  const source = typeof pkg.source === "string" ? pkg.source.trim().toLowerCase() : "";
  const installed = typeof pkg.installedVersion === "string" ? pkg.installedVersion : "";
  const latest = typeof pkg.latestVersion === "string" ? pkg.latestVersion : "";
  if (NON_UPDATABLE_SOURCES.has(source)) {
    return {
      ok: true,
      kind: "not-applicable",
      installed,
      latest: "",
      source,
      reason:
        source === "linked"
          ? "这个插件是链接到源码目录安装的:改代码后刷新/重启即生效,不存在「更新」这个动作"
          : "这个插件是从本地路径安装的:换源码后重新安装即可,不走在线更新"
    };
  }
  if (pkg.updateAvailable === true && latest !== "") {
    return { ok: true, kind: "available", installed, latest, source, reason: "有新版本" };
  }
  if (pkg.updateAvailable === false && installed !== "") {
    return { ok: true, kind: "current", installed, latest: "", source, reason: "已是最新" };
  }
  return {
    ok: false,
    kind: "unknown",
    installed,
    latest,
    source,
    reason: `更新接口的回答不认识(source=${source === "" ? "?" : source})`
  };
}

/**
 * 问宿主「这个插件有没有新版」。**只有被显式调用时才发请求**。
 *
 * 走宿主自带的市场 API,而不是自己去问 GitHub —— 理由见文件头:只有宿主知道
 * 这个插件是**怎么装的**,而那决定了"更新"这件事对它是否适用。
 * @param fetchImpl - 可注入的 fetch(测试用);默认用全局 fetch。
 * @param timeoutMs - 超时;默认 8 秒。
 * @param baseUrl - 设置页所在的原点;默认相对路径(浏览器里同源)。
 * @returns {@link updateStateOf} 的形状。
 */
export async function checkForUpdate(fetchImpl = globalThis.fetch, timeoutMs = 8_000, baseUrl = "") {
  const current = packageInfo().version;
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      kind: "unknown",
      installed: current,
      latest: "",
      source: "",
      reason: "当前运行环境没有 fetch,无法检查更新"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = `${baseUrl}${MARKET_API}/updates?name=${encodeURIComponent("dsh-fpga-workbench")}&force=1`;
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      // 同源请求自带会话 cookie;显式声明只是让意图清楚。
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      const reason =
        response.status === 404
          ? "这个宿主没有插件更新接口(DSH 版本较旧,或没装插件市场)"
          : `更新检查失败(HTTP ${String(response.status)})`;
      return { ok: false, kind: "unknown", installed: current, latest: "", source: "", reason };
    }
    const payload = await response.json();
    const state = updateStateOf(payload);
    // 市场没给 installedVersion 时,退回本地清单里的版本(它一定是对的)。
    return { ...state, installed: state.installed === "" ? current : state.installed };
  } catch (error) {
    return {
      ok: false,
      kind: "unknown",
      installed: current,
      latest: "",
      source: "",
      reason:
        error?.name === "AbortError" ? `请求超时(${String(timeoutMs)}ms)` : `请求失败:${String(error?.message ?? error)}`
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 宿主侧调用 {@link checkForUpdate} 的入口:把浏览器的会话凭据带过去。
 *
 * 为什么需要:市场 API 在生产宿主上要**浏览器会话 cookie**(dshmarket 的文档写明:
 * 没有 cookie 的请求答 `401`)。而插件路由是**宿主进程**发的请求,天然没有那个 cookie ——
 * 所以由插件把浏览器那一份**原样转发**,让市场的鉴权闸自己判断。
 * 不伪造、不绕过:拿不到 cookie 就只发匿名请求,市场拒绝时如实归 `unknown`。
 * @param baseUrl - 源站(例如 `http://127.0.0.1:65274`);空串表示相对路径。
 * @param cookie - 浏览器的 Cookie 头;没有就不带。
 * @param timeoutMs - 超时。
 * @returns {@link updateStateOf} 的形状。
 */
export async function checkForUpdateWithCookie(baseUrl, cookie, timeoutMs = 8_000) {
  const extra = { accept: "application/json" };
  if (typeof cookie === "string" && cookie !== "") extra.cookie = cookie;
  // **只合并 headers,其余选项(signal / method / credentials)原样透传** ——
  // 早先这里把 options 整个重建,顺手丢掉了 checkForUpdate 传进来的 AbortSignal,
  // 于是超时永远不会触发,请求一直挂着直到外部放弃。
  const withHeaders = (url, options = {}) =>
    globalThis.fetch(url, { ...options, headers: { ...extra, ...(options.headers ?? {}) } });
  return checkForUpdate(withHeaders, timeoutMs, baseUrl);
}
