// 「装这个插件会不会扰动我的 profile」的实测。
//
// 做法:把真实 profile 的清单复制到工作区镜像里,先解析出一个基线树,再把本插件
// 作为依赖加进去,然后对比两次解析里既有依赖的版本有没有变。全程不读写真实
// profile,只在工作区里跑。
//
// 这里已经覆盖了"前后两份锁文件比版本位移"这件事(基线 vs 加重后,逐包比)。
// 曾经另有一个 `compare-locks.mjs` 做同样的事,但它读的是本脚本跑完丢在
// `.tmp/install-mirror/` 里的中间产物 —— 那个镜像每跑一次重建一次,它单跑必崩,
// 而且断言与这里完全重复,所以删了。**要看位移明细就跑本脚本**,别再拆一个读中间产物的。
//
// 它回答的是 pnpm 的行为问题(add 是局部添加还是整树重解析),不是代码问题:
// 插件源码本身没有任何运行时依赖,唯一能被动摇的是 profile 里那些**没有精确锁定**
// 的依赖——目前只有 @suagr_xl/dsh-safety(^0.2.1)。
//
// 用法:node tools/check-install-safety.mjs
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "./lib/spawn.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROFILE_HINT, profileManifest } from "./lib/host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MIRROR = join(ROOT, ".tmp", "install-mirror");

/** 真实 profile 的清单,只读。位置由 tools/lib/host.mjs 统一推导,不写死任何用户目录。 */
const PROFILE_MANIFEST = profileManifest();
/** 真实 profile 的工作区策略,决定 nodeLinker 与 allowBuilds。 */
const PROFILE_WORKSPACE = PROFILE_MANIFEST === "" ? "" : join(dirname(PROFILE_MANIFEST), "pnpm-workspace.yaml");

const fail = [];
const note = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) fail.push(label);
};

/**
 * pnpm 的 **JS 入口**(Windows 上才有意义),找不到就是 null。
 *
 * 为什么绕这一圈(2026-09-25 实测):`pnpm` 在 Windows 上是 `pnpm.cmd` shim,而 Node **不能不经
 * shell 执行 .cmd** —— `spawnSync("pnpm.cmd", …, { shell: false })` 直接失败(status null);
 * 退回 `shell: true` 又会触发 **DEP0190**(参数只做拼接、不转义),并且路径里带空格就会把参数
 * 拆错(`file:C:/My Repo` 这类)。所以这里用 `where.exe`(真实 .exe,不经 shell)找到 shim 旁边
 * 的 `node_modules/pnpm/bin/pnpm.cjs`,之后一律用 node 直接跑它 —— 没有 shell、没有拼接。
 */
const PNPM_JS = (() => {
  if (process.platform !== "win32") return null;
  const found = spawnSync("where.exe", ["pnpm"], { encoding: "utf8", windowsHide: true });
  for (const line of `${found.stdout ?? ""}`.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const candidate = join(dirname(line), "node_modules", "pnpm", "bin", "pnpm.cjs");
    if (existsSync(candidate)) return candidate;
  }
  return null;
})();

/** 在镜像里跑一次 pnpm。 */
function pnpm(args) {
  const via = PNPM_JS === null
    ? { command: "pnpm", prefix: [], shell: process.platform === "win32" }
    : { command: process.execPath, prefix: [PNPM_JS], shell: false };
  const result = spawnSync(via.command, [...via.prefix, ...args], {
    cwd: MIRROR,
    encoding: "utf8",
    shell: via.shell,
    windowsHide: true,
    env: {
      ...process.env,
      // 缓存与 store 都留在工作区:沙箱只允许写工作区。
      npm_config_store_dir: join(ROOT, ".tmp", "pnpm-store"),
      npm_config_cache: join(ROOT, ".tmp", "npm-cache"),
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false"
    }
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** 读出锁文件里每个包的锁定版本,用于前后对比。 */
function lockVersions() {
  const file = join(MIRROR, "pnpm-lock.yaml");
  if (!existsSync(file)) return new Map();
  const text = readFileSync(file, "utf8");
  const found = new Map();
  // 只取 packages: 段里的 `  /name@version:`(或 name@version:)条目。
  const section = text.split(/\n(?=\S)/).find((part) => part.startsWith("packages:"));
  if (section === undefined) return found;
  for (const match of section.matchAll(/^\s{2}\/?((?:@[^/\s]+\/)?[^@\s/]+)@([^\s:(]+)/gm)) {
    found.set(match[1], match[2]);
  }
  return found;
}

if (PROFILE_MANIFEST === "" || !existsSync(PROFILE_MANIFEST)) {
  console.error(
    [
      PROFILE_MANIFEST === ""
        ? "读不出 profile 位置(USERPROFILE / HOME 都为空)。"
        : `找不到 profile 清单:${PROFILE_MANIFEST}`,
      "",
      "这一项测的是「装本插件会不会扰动**你这份** profile 的依赖树」,所以必须指到真实 profile。",
      `  ${PROFILE_HINT}`,
      "不给这个变量的话,按 <用户主目录>/.dsh/profiles/desktop 推导(官方桌面端的默认位置)。",
      ""
    ].join("\n")
  );
  process.exit(1);
}

// ── 搭镜像 ───────────────────────────────────────────────────────────────────

rmSync(MIRROR, { recursive: true, force: true });
mkdirSync(MIRROR, { recursive: true });

const profile = JSON.parse(readFileSync(PROFILE_MANIFEST, "utf8"));

// git 规格的依赖在解析时要执行 `git init` 等子进程。**能不能纳入只看 git 在不在**(2026-09-25):
// 之前是无条件排除,理由写的是"本沙箱不可用"—— 那是**环境**限制,不是"与本题无关",于是那个依赖
// 的版本位移其实一直没被检查。现在先探一次 git:可用就纳入;不可用才排除,并且这一条会**判 FAIL**
// (覆盖不到就说覆盖不到,别让"排除"看起来像"没关系")。
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
const dependencies = {};
const excluded = [];
for (const [name, spec] of Object.entries(profile.dependencies ?? {})) {
  const isGitSpec = /^(git\+|github:|git:|https?:)/.test(spec) || /\.git(#|$)/.test(spec);
  if (isGitSpec && !gitAvailable) excluded.push(`${name} (${spec})`);
  else dependencies[name] = spec;
}

const mirrorManifest = {
  name: "dsh-install-mirror",
  private: true,
  dependencies,
  dsh: profile.dsh
};
writeFileSync(join(MIRROR, "package.json"), `${JSON.stringify(mirrorManifest, null, 2)}\n`);
if (existsSync(PROFILE_WORKSPACE)) {
  writeFileSync(join(MIRROR, "pnpm-workspace.yaml"), readFileSync(PROFILE_WORKSPACE));
}

const direct = Object.keys(dependencies);
console.log(`镜像 profile 的依赖:${direct.length} 个`);
console.log(`pnpm 调用方式:${PNPM_JS === null ? "退回 pnpm shim(shell:true;会有 DEP0190 警告)" : `直接 node 跑 ${PNPM_JS}(不经 shell)`}`);
console.log(`git 子进程:${gitAvailable ? "可用 → git 规格的依赖已纳入检查" : "不可用 → git 规格的依赖被排除,它们的版本位移未覆盖"}`);
if (excluded.length > 0) console.log(`已排除:${excluded.join(", ")}`);
console.log("第一步:解析基线树(可能要几分钟,要联网)…");
const before = pnpm(["install", "--lockfile-only"]);
if (before.code !== 0) {
  console.error("基线解析失败,无法判断扰动:\n", before.out.slice(-2000));
  process.exit(1);
}
const baseLock = lockVersions();
console.log(`基线锁定包数 = ${baseLock.size}`);

// ── 加入本插件,再解析一次 ────────────────────────────────────────────────────

console.log("第二步:把本插件作为依赖加进去,再解析…");
const spec = `file:${ROOT}`;
const added = pnpm(["add", spec, "--lockfile-only"]);
if (added.code !== 0) {
  console.error(`添加失败(pnpm add ${spec}):\n`, added.out.slice(-2000));
  process.exit(1);
}
const afterLock = lockVersions();
console.log(`加入后锁定包数 = ${afterLock.size}`);

// ── 对比:既有依赖有没有被动过 ───────────────────────────────────────────────

const changed = [];
for (const [name, version] of baseLock) {
  const next = afterLock.get(name);
  if (next === undefined) changed.push(`${name}: ${version} -> 被移除`);
  else if (next !== version) changed.push(`${name}: ${version} -> ${next}`);
}

console.log("");
if (changed.length === 0) {
  console.log("既有无一个依赖的锁定版本发生位移。");
} else {
  console.log("以下依赖的锁定版本发生变化:");
  for (const line of changed) console.log("  " + line);
}

note(changed.length === 0, "加入本插件不会移动任何既有依赖的锁定版本");
note(excluded.length === 0, `git 规格的依赖也纳入检查${excluded.length === 0 ? "" : `(排除了 ${excluded.length} 个:版本位移未覆盖)`}`);
const self = afterLock.get("dsh-fpga-workbench");
note(self !== undefined, "本插件进入了依赖树");
console.log(`本插件锁定为 dsh-fpga-workbench@${self ?? "(未锁定)"}`);

console.log(
  fail.length > 0
    ? `\nFAIL: 安装会扰动既有依赖,先别装,看清上面哪些位移了。`
    : `\nPASS: 安装不扰动既有依赖。`
);
if (fail.length > 0) process.exitCode = 1;
