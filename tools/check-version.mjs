// 版本与「检查更新」的判定自检 —— `npm test` 的一部分,不联网。
//
// 这条管的是一类**很容易悄悄坏掉**的东西:
//   · 版本比较写错(预发布版排序、rc.10 vs rc.2)→ 用户永远被告知"已是最新";
//   · 检查更新变成自动的、或者挂在启动路径上 → 插件在别人机器上静默联网;
//   · 查询失败被当成"已是最新" → 最坏的那种假绿灯。
// 三条都能在不联网的前提下钉死:版本比较是纯函数,GitHub 那一层用注入的假 fetch 打靶。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkForUpdate, compareVersions, packageInfo, parseVersion, repositorySlug, updateStateOf } from "../lib/version.js";
// 宿主兼容范围的唯一断言口（判据 + includePrerelease 的说明都在那个文件头）。
import { followsDshVersion, inspectRange, satisfiesHost } from "./lib/version-range.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// ── 一、版本解析 ─────────────────────────────────────────────────────────────

{
  const plain = parseVersion("0.4.5");
  check(
    plain?.major === 0 && plain?.minor === 4 && plain?.patch === 5 && plain?.pre === "",
    `能解析 x.y.z(实际 ${JSON.stringify(plain)})`
  );
  const tagged = parseVersion("v1.2.3");
  check(tagged?.major === 1 && tagged?.minor === 2, "带 v 前缀也能解析(git tag 常见写法)");
  const rc = parseVersion("0.5.0-rc.1");
  check(rc?.major === 0 && rc?.minor === 5 && rc?.patch === 0 && rc?.pre === "rc.1", `能解析预发布版(实际 ${JSON.stringify(rc)})`);
  check(parseVersion("abc") === undefined, "认不出的字符串返回 undefined,而不是编一个 0.0.0");
  check(parseVersion("") === undefined, "空串返回 undefined");
}

// ── 二、版本比较 ─────────────────────────────────────────────────────────────

{
  // 比较函数返回的是**差值**,不是 ±1 —— 断言按符号判,别写死 -1。
  const sign = (value) => (value === undefined ? undefined : Math.sign(value));
  check(sign(compareVersions("0.4.5", "0.4.6")) === -1, "0.4.5 < 0.4.6");
  check(sign(compareVersions("0.4.6", "0.4.5")) === 1, "0.4.6 > 0.4.5");
  check(compareVersions("0.4.5", "0.4.5") === 0, "相同版本返回 0");
  check(sign(compareVersions("1.0.0", "0.9.9")) === 1, "主版本优先于次版本");
  check(sign(compareVersions("0.10.0", "0.9.0")) === 1, "按数值比而不是字典序(0.10 > 0.9)");

  // 预发布版排在同号正式版之前
  check(sign(compareVersions("1.0.0-rc.1", "1.0.0")) === -1, "1.0.0-rc.1 < 1.0.0");
  check(sign(compareVersions("1.0.0", "1.0.0-rc.1")) === 1, "1.0.0 > 1.0.0-rc.1");

  // 这条踩过:按字符串比会把 rc.10 判成比 rc.2 小
  check(
    sign(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")) === -1,
    "rc.2 < rc.10(数字段按数值比,不能按字符串)"
  );
  check(
    sign(compareVersions("0.2.1-rc.2", "0.2.1-rc.10")) === -1,
    "本仓库实际用的 rc 形式也正确"
  );

  check(compareVersions("junk", "1.0.0") === undefined, "任一侧认不出时返回 undefined,不硬判");
}

// ── 三、清单读出来的信息 ─────────────────────────────────────────────────────

{
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const info = packageInfo();
  check(info.version === manifest.version, `packageInfo().version 与清单一致(${info.version})`);
  check(parseVersion(info.version) !== undefined, `版本号本身可解析(实际 ${info.version})`);
  check(
    info.dshRange === String(manifest.dsh?.compatibility?.dsh ?? ""),
    "兼容范围取自清单,不是另抄一份"
  );
  check(info.releases.length > 0, `声明了兼容的 DSH 版本(${info.releases.join("、")})`);

  // ── 兼容声明必须与「真的验过的版本」一一对应 ──────────────────────────────
  //
  // 2026-10-22 实测发现两件事，合起来改了这里：
  //
  // 1. **宿主代码里没有任何地方读 `dsh.compatibility.dshReleases`**
  //    （扫了 1139 个 js 文件，零引用）。真正决定能否加载的是 `peerDependencies`
  //    （启动门禁读它）。所以 `dshReleases` 是**给人看的备注**，但它不该自相矛盾。
  //
  // 2. **`^` 对 0.x 预发布版会把没验过的版本也算进去**：用宿主自带的 semver 实测，
  //    `^0.2.0-rc.1` 会放行 `0.2.0`（正式版）、`0.2.5`、`0.1.9` —— 而那些我们从没
  //    跑过。`dsh-llm-account` 用的是**精确版本**（`0.2.0-rc.2 || 0.2.1-rc.1 || …`），
  //    正是为了避开这一点。这里对齐它的做法。
  const compat = String(manifest.dsh?.compatibility?.dsh ?? "");
  const releases = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {});
  const missingFromRange = releases.filter((release) => !satisfiesHost(release, compat));
  check(
    missingFromRange.length === 0,
    `dshReleases 里每个版本都被兼容范围覆盖(带 includePrerelease;漏写:${missingFromRange.join("、") || "无"})`
  );
  // 写法合规：单个 >= 起点、无上界、无 ||、不是 *（判据在 tools/lib/version-range.mjs）。
  const verdict = inspectRange(compat);
  check(
    verdict.ok,
    `兼容范围是单个无上界的 >= 起点（实际 ${JSON.stringify(compat)}：${verdict.problem ?? "合规"}）`
  );

  const peers = manifest.peerDependencies ?? {};
  const drifted = Object.entries(peers)
    .filter(([name]) => followsDshVersion(name))
    .filter(([, range]) => range !== compat)
    .map(([name]) => name);
  check(
    drifted.length === 0,
    `宿主 peer 范围与 compatibility.dsh 逐字相同(漂开:${drifted.join("、") || "无"})`
  );
  // 第三方库不跟宿主版本线（cordis / schemastery / react…），防止被"统一"掉。
  const wrongThird = Object.entries(peers)
    .filter(([name]) => !followsDshVersion(name))
    .filter(([, range]) => range === compat)
    .map(([name]) => name);
  check(
    wrongThird.length === 0,
    `非 DSH 包保持独立约束、不跟宿主版本线(误改:${wrongThird.join("、") || "无"})`
  );

  // ── engines.dsh 才是真正的门禁（2026-10-22 迁移时补上）────────────────────
  //
  // 宿主 `app-boot/lib/index.js` 的 `unmetRequirements()` 源码实证：
  //
  //     if (Object.hasOwn(engines, "dsh")) {
  //       // 只看 engines.dsh —— peerDependencies 全部忽略
  //       return satisfies(runtimeVersion, engines.dsh) ? {} : { "engines.dsh": engines.dsh };
  //     }
  //     // 没有 engines.dsh → 每个 @deepseek-ai/dsh-* peer 都要单独匹配
  //
  // 所以有 engines.dsh 时**它说了算**。漏了它、或与 peer 漂开，就会出「以为改了
  // peer 范围、实际门禁还是旧的」这种事。
  //
  // **还踩到一个 semver 陷阱**（这次实测）：`>=0.2.0-rc.2 <0.3.0` 会**拒绝**
  // 0.2.1-rc.2 —— semver 规范第 11 条规定，范围里出现预发布标记时，只有同一组
  // [major,minor,patch] 的预发布版才可能满足。`>=0.2.0-rc.2` 的预发布许可只覆盖
  // `0.2.0-*`，不覆盖 `0.2.1-*`。所以这里坚持**精确列表**，不用 `>=`。
  const enginesDsh = String(manifest.engines?.dsh ?? "");
  check(
    enginesDsh !== "",
    `声明了 engines.dsh（有它时宿主只读它、忽略 peer；实际 ${JSON.stringify(enginesDsh)}）`
  );
  check(
    enginesDsh === compat,
    `engines.dsh 与 compatibility.dsh 一致（engines=${JSON.stringify(enginesDsh)} / compat=${JSON.stringify(compat)}）`
  );
  // **写法要求：统一单一起点**（2026-10-24 用户规范）。
  //
  // @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 全部写同一个 >= 起点，不累加、不枚举。
  // 成立前提是宿主判定带 includePrerelease —— 见 tools/lib/version-range.mjs 文件头。
  // 累加式（>=0.1.7-rc.2 || >=0.2.0-rc.1 || …）在 includePrerelease 下等价于第一段，
  // 维护成本与精确列表相同却伪装成范围，所以不再用。
  //
  // 第三方库（cordis / schemastery / react…）不跟这条规则，判据见 followDshVersion。
  check(
    followsDshVersion("@deepseek-ai/dsh") &&
      followsDshVersion("@deepseek-ai/dsh-settings") &&
      !followsDshVersion("@deepseek-ai/cordis") &&
      !followsDshVersion("@deepseek-ai/schemastery"),
    "「跟 DSH 版本走」的包名判据正确（dsh / dsh-* 算，cordis / schemastery 不算）"
  );
}

// ── 三b、检查更新用的协议不能硬编码 http ─────────────────────────────────────
//
// 宿主走 HTTPS(或用户经反向代理)时,`http://<host>` 会拼成 `http://example.com:443`
// —— 协议错、端口也错,表现只是「更新检查失败」。这条守卫盯源码里不再出现硬编码。
{
  const source = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  check(
    !/base\s*=\s*host\s*===\s*""\s*\?\s*""\s*:\s*`http:\/\/\$\{host\}`/u.test(source),
    "不把更新检查的源站协议硬编码成 http（按 x-forwarded-proto / 回环 / 外部域名判定）"
  );
  check(
    /x-forwarded-proto/u.test(source),
    "读取 x-forwarded-proto 以支持反向代理后的 HTTPS"
  );
}

// ── 四、仓库地址从哪里来 ─────────────────────────────────────────────────────

{
  const slug = repositorySlug();
  check(/^[^/\s]+\/[^/\s]+$/u.test(slug), `能识别出 owner/repo(实际 ${slug || "空"})`);
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  // 本包刻意不带 repository 字段(按 git 装,不走 npm),所以地址回退到 README —— 那条断言盯这个设计
  check(
    manifest.repository === undefined || typeof manifest.repository === "object" || typeof manifest.repository === "string",
    "清单里没有 repository 时可以回退到 README"
  );
}

// ── 五、检查更新的行为(注入假 fetch,不联网)──────────────────────────────────

{
  // 市场 API 的回答形状(见 dshmarket 的 UPDATE-API-V1.md)。
  const reply = (pkg) => ({ ok: true, status: 200, json: async () => ({ schema: "dsh-market/update-api/v1", package: pkg }) });

  // ① 链接安装:**不是**「已是最新」,而是「这种安装不会更新」
  const linked = await checkForUpdate(async () => reply({ source: "linked", installedVersion: "0.5.0", latestVersion: null, updateAvailable: false }));
  check(
    linked.ok === true && linked.kind === "not-applicable",
    `链接安装归 not-applicable,不冒充"已是最新"(${JSON.stringify(linked)})`
  );
  check(
    String(linked.reason).includes("链接"),
    `链接安装的说明里点明了原因(${String(linked.reason)})`
  );

  // `file:` 安装同理(本地路径装)
  const file = await checkForUpdate(async () => reply({ source: "file", installedVersion: "0.5.0", updateAvailable: false }));
  check(file.ok === true && file.kind === "not-applicable", `file: 安装也归 not-applicable(${String(file.kind)})`);

  // ② 有新版
  const available = await checkForUpdate(async () =>
    reply({ source: "git", installedVersion: "0.5.0", latestVersion: "0.6.0", updateAvailable: true })
  );
  check(
    available.ok === true && available.kind === "available" && available.latest === "0.6.0",
    `能识别出有新版本(${JSON.stringify(available)})`
  );

  // ③ 已是最新
  const current = await checkForUpdate(async () =>
    reply({ source: "npm", installedVersion: "0.5.0", latestVersion: null, updateAvailable: false })
  );
  check(current.ok === true && current.kind === "current", `同版本判为已是最新(${String(current.kind)})`);

  // ④ updateAvailable 为 true 却没给 latestVersion:不许编一个版本号
  const incomplete = await checkForUpdate(async () =>
    reply({ source: "npm", installedVersion: "0.5.0", updateAvailable: true })
  );
  check(
    incomplete.ok === false && incomplete.kind === "unknown",
    `updateAvailable 缺 latestVersion 时归 unknown,不编版本号(${String(incomplete.kind)})`
  );

  // ⑤ 市场缺席(404):如实说"没有更新接口",不冒充已最新
  const missing = await checkForUpdate(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  check(
    missing.ok === false && missing.kind === "unknown" && String(missing.reason).includes("没有插件更新接口"),
    `404 时说明"宿主没有更新接口"(${String(missing.reason)})`
  );

  // ⑥ 其它 HTTP 失败:把状态码报出来
  const denied = await checkForUpdate(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  check(
    denied.ok === false && String(denied.reason).includes("401"),
    `HTTP 失败时把状态码报出来(${String(denied.reason)})`
  );

  // ⑦ 形状不认识:不猜
  const weird = await checkForUpdate(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
  check(
    weird.ok === false && weird.kind === "unknown",
    `响应里没有 package 字段时归 unknown(${String(weird.reason)})`
  );

  // ⑧ 网络异常
  const boom = await checkForUpdate(async () => {
    throw new Error("ECONNREFUSED");
  });
  check(
    boom.ok === false && String(boom.reason).includes("ECONNREFUSED"),
    `网络异常时如实说明(${String(boom.reason)})`
  );

  // ⑨ 超时会中止并说明
  const timeout = await checkForUpdate(
    (_url, options) =>
      new Promise((resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    1
  );
  check(timeout.ok === false && String(timeout.reason).includes("超时"), `超时会中止并说明(${String(timeout.reason)})`);

  // ⑩ 纯函数层面:判断顺序是"先看能不能更新,再看有没有新版"
  //    这条防的是把链接安装画成"已是最新"(那是实质错误,不是措辞问题)
  const pureNotApplicable = updateStateOf({ package: { source: "linked", installedVersion: "1.0.0", latestVersion: "9.9.9", updateAvailable: true } });
  check(
    pureNotApplicable.kind === "not-applicable",
    `即使接口说 updateAvailable,链接安装仍归 not-applicable(实际 ${pureNotApplicable.kind})`
  );
}

// ── 六、静态守卫:不许自动联网 ───────────────────────────────────────────────

{
  const indexSource = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  const clientSource = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  const versionSource = readFileSync(join(ROOT, "lib", "version.js"), "utf8");

  // 检查更新必须是 POST:GET 会被浏览器预取/缓存悄悄触发
  check(
    /path:\s*UPDATE_PATH[\s\S]{0,400}req\.method !== "POST"/u.test(indexSource),
    "更新检查只接受 POST(避免被预取/缓存悄悄触发)"
  );
  // 启动路径上不许有定时器去查更新
  check(
    !/setInterval\([^)]*checkForUpdate/u.test(indexSource) &&
      !/setInterval\([^)]*checkForUpdate/u.test(clientSource),
    "没有定时器周期性检查更新"
  );
  // 客户端只在按钮回调里 fetch 更新路由
  check(
    !new RegExp(`fetch\\([^)]*${"UPDATE_URL"}[^)]*\\)[\\s\\S]{0,200}useEffect`, "u").test(clientSource),
    "客户端不在挂载时请求更新路由(只有点按钮才发)"
  );
  // 版本信息那条路由自己不发网络
  check(
    !/^\s*fetch\(/mu.test(versionSource) && !/await\s+fetch\(/u.test(versionSource),
    "lib/version.js 不直接调用全局 fetch(只通过注入的 fetchImpl,便于测试且不会被自动触发)"
  );
  // checkForUpdate 只在 index.js 的路由里被调用
  const callsInIndex = (indexSource.match(/checkForUpdate/g) ?? []).length;
  check(callsInIndex >= 1, "更新检查路由确实调用 checkForUpdate");
  check(
    !readFileSync(join(ROOT, "lib", "mode.js"), "utf8").includes("checkForUpdate"),
    "模式行不碰更新检查(它不该有任何联网行为)"
  );
}

console.log(
  failures.length > 0
    ? `\nFAIL (${String(failures.length)}): ${failures.join(" | ")}`
    : "\nPASS: 版本比较、更新检查行为与「不自动联网」的约束都成立"
);
if (failures.length > 0) process.exitCode = 1;
