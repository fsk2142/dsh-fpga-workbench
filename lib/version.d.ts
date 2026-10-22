//#region src/version.d.ts
/**
 * 读本包的清单。读不到时抛 —— 版本号读不出来,后面所有判断都没有意义。
 * @returns package.json 解析结果。
 */
export declare function readManifest(): any;
/**
 * 本插件自己的版本与它声明的兼容范围。
 * @returns `{ version, description, repository, dshRange, releases }`。
 */
export declare function packageInfo(): {
  version: string;
  description: string;
  repository: any;
  dshRange: string;
  releases: string[];
};
/** 版本号切段后的形状。 */
interface VersionParts {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标记（不含 `-`）；空串表示正式版。 */
  pre: string;
}
/**
 * 把版本号切成可比较的三段数字。
 *
 * 只处理 `x.y.z` 与带 `-rc.N` 后缀的形式 —— 本仓库就用这两种,不引 semver 依赖。
 * @param text - 版本字符串。
 * @returns `{ major, minor, patch, pre }`;认不出时返回 undefined。
 */
export declare function parseVersion(text: unknown): VersionParts | undefined;
/**
 * 比较两个版本。预发布版(`-rc.1`)排在对应的正式版**之前**。
 * @param left - 版本字符串。
 * @param right - 版本字符串。
 * @returns 负数表示 left 更旧,0 表示相同,正数表示 left 更新;任一认不出时返回 undefined。
 */
export declare function compareVersions(left: unknown, right: unknown): number | undefined;
/**
 * 把 package.json 里的各种 repository 写法归一成 `owner/repo`。
 *
 * 本包没有 `repository` 字段(发布到 npm 时也没打算带),所以**回退到 README 里那份
 * 安装命令** —— 它是仓库地址唯一的既有出处,别再抄一份。
 * @returns `owner/repo`;认不出来时为空串。
 */
export declare function repositorySlug(): string;
/** 一次更新检查的结论。 */
export interface UpdateState {
  ok: boolean;
  kind: "available" | "current" | "not-applicable" | "unknown";
  installed: string;
  latest: string;
  source: string;
  reason: string;
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
export declare function updateStateOf(payload: unknown): UpdateState;
/**
 * 可注入的 fetch 形状。
 *
 * 用最窄的那份签名（`(url, init) => Promise<Response>`）而不是 ``typeof fetch`` ——
 * 后者在 DOM 类型里是**两个重载**，一个具体实现很难同时满足两个重载，
 * 会报 TS2345「not assignable to parameter」。
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
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
export declare function checkForUpdate(fetchImpl?: FetchLike | undefined, timeoutMs?: number, baseUrl?: string): Promise<UpdateState>;
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
export declare function checkForUpdateWithCookie(baseUrl: string, cookie?: string, timeoutMs?: number): Promise<UpdateState>;
//#endregion
export {};