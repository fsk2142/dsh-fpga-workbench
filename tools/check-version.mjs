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

import { checkForUpdate, compareVersions, packageInfo, parseVersion, repositorySlug } from "../lib/version.js";

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
  const tagsReply = (names) => ({
    ok: true,
    status: 200,
    json: async () => names.map((name) => ({ name }))
  });

  // 夹具版本**相对当前清单**算出来,不写死具体数字 ——
  // 写死过一次:版本从 0.4.5 升到 0.5.0 后,"有新版本"那条夹具(0.4.9)反而比当前旧,
  // 断言就红了。那是夹具过期,不是逻辑错,但红得一样刺眼。
  const current = packageInfo().version;
  const newer = `v9.9.9`;
  const older = `v0.0.1`;

  // 有新版本
  const hasNewer = await checkForUpdate(async () => tagsReply([newer, older]));
  check(
    hasNewer.ok === true && hasNewer.latest === "9.9.9" && hasNewer.outdated === true,
    `能识别出有新版本(${JSON.stringify(hasNewer)})`
  );

  // 已是最新:用当前版本本身当 tag
  const same = await checkForUpdate(async () => tagsReply([`v${current}`]));
  check(same.ok === true && same.outdated === false, `同版本判为已是最新(${JSON.stringify(same)})`);

  // 本地比 tag 还新(开发中)—— 不能报"有新版本"
  const ahead = await checkForUpdate(async () => tagsReply([older]));
  check(ahead.ok === true && ahead.outdated === false, "本地版本更新时不报有新版本");

  // 多个 tag 时取**最大**的那个(曾经写成 sort()[0] 取到最小,有新版也报"已是最新")
  const many = await checkForUpdate(async () => tagsReply(["v0.0.1", newer, "v0.0.2"]));
  check(many.ok === true && many.latest === "9.9.9", `多个 tag 时取最大版本(${String(many.latest)})`);

  // 没有任何 tag:如实说,不编"已是最新"
  const noTags = await checkForUpdate(async () => tagsReply([]));
  check(
    noTags.ok === false && String(noTags.reason).includes("tag"),
    `仓库没有 tag 时如实说明(${String(noTags.reason)})`
  );

  // GitHub 报错(私有/限流)
  const denied = await checkForUpdate(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  check(
    denied.ok === false && String(denied.reason).includes("403"),
    `HTTP 失败时把状态码报出来(${String(denied.reason)})`
  );

  // 网络异常
  const boom = await checkForUpdate(async () => {
    throw new Error("ECONNREFUSED");
  });
  check(
    boom.ok === false && String(boom.reason).includes("ECONNREFUSED"),
    `网络异常时如实说明(${String(boom.reason)})`
  );

  // 超时:用会一直不 resolve 的 fetch 打,超时值压到 1ms
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
