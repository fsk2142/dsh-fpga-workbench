// 版本与「有没有新版」。
//
// 两件事:
//   1. 把这个包自己的版本、以及它声明兼容的 DSH 版本,汇成一处 —— 免得版本号散落在
//      package.json、README、补丁里各写一遍、各漂各的;
//   2. 提供一个**可选**的更新检查:去 GitHub 的 releases/tags 问一句"最新版是什么",
//      和当前版本比一比。
//
// 几条刻意的取舍:
//   · **不自动检查、不后台轮询**。插件是装在别人机器上的,静默联网既冒犯也没有必要;
//     只有用户点了设置页那个按钮,或者显式调了路由,才会发请求。
//   · **不把结果写进设置**。检查更新是瞬时事实,不是配置;写进去只会让"上次查到的版本"
//     变成另一种陈旧状态。
//   · **失败就是失败**。网络不通、GitHub 限流、仓库还没有 release —— 各自如实说明,
//     绝不编一个"已是最新"。这类"看起来是绿的"是自检里最坏的一种。
//   · 只发一个 GET,不带任何用户信息、不带仓库内容;响应只看 tag 列表。
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
 * 去 GitHub 问最新 tag。**只有被显式调用时才发请求**。
 *
 * 用 tags 而不是 releases:本仓库没打 release(发布方式是按 git 装),tags 才是它
 * 实际会有的东西。同时取 releases 作为补充(将来真打了 release 也能用)。
 * @param fetchImpl - 可注入的 fetch(测试用);默认用全局 fetch。
 * @param timeoutMs - 超时;默认 8 秒。
 * @returns `{ ok, latest, source, reason }` —— `ok:false` 时 `reason` 是给人看的原因。
 */
export async function checkForUpdate(fetchImpl = globalThis.fetch, timeoutMs = 8_000) {
  const slug = repositorySlug();
  if (slug === "") {
    return { ok: false, latest: "", source: "", reason: "清单与 README 里都没有可识别的仓库地址" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, latest: "", source: "", reason: "当前运行环境没有 fetch,无法检查更新" };
  }

  const current = packageInfo().version;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 只需要 tag 名;per_page 取小一点,别把整个 release 描述拉下来。
    const response = await fetchImpl(`https://api.github.com/repos/${slug}/tags?per_page=30`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "dsh-fpga-workbench-update-check"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        ok: false,
        latest: "",
        source: slug,
        reason: `GitHub 返回 ${String(response.status)}(仓库可能是私有的,或者被限流)`
      };
    }
    const tags = await response.json();
    const versions = (Array.isArray(tags) ? tags : [])
      .map((item) => parseVersion(item?.name))
      .filter((item) => item !== undefined);
    if (versions.length === 0) {
      return {
        ok: false,
        latest: "",
        source: slug,
        reason: `仓库 ${slug} 还没有打过版本 tag —— 跟着 main 走,没有可比较的版本号`
      };
    }
    const tags2 = (Array.isArray(tags) ? tags : [])
      .map((item) => String(item?.name ?? ""))
      .filter((name) => parseVersion(name) !== undefined);
    if (tags2.length === 0) {
      return {
        ok: false,
        latest: "",
        source: slug,
        reason: `仓库 ${slug} 还没有打过版本 tag —— 跟着 main 走,没有可比较的版本号`
      };
    }
    // 取**最大**的那个:升序排序后取末尾。
    // (曾经写成 `sort(...)[0]`,那是**最小**的 —— 有新版也会被判成"已是最新",而且不报错。)
    const newest = tags2.sort((left, right) => compareVersions(left, right) ?? 0).at(-1);
    const order = compareVersions(newest, current);
    if (order === undefined) {
      return { ok: false, latest: newest, source: slug, reason: `认不出当前版本 ${current}` };
    }
    return {
      ok: true,
      latest: newest.replace(/^v/u, ""),
      source: slug,
      reason: order > 0 ? "有新版本" : "已是最新",
      outdated: order > 0,
      current
    };
  } catch (error) {
    return {
      ok: false,
      latest: "",
      source: slug,
      reason: error?.name === "AbortError" ? `请求超时(${String(timeoutMs)}ms)` : `请求失败:${String(error?.message ?? error)}`
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 一次检查更新最多花多久(设置页按钮的说明里会写)。 */
export const UPDATE_CHECK_BUDGET_MS = 8_000;
