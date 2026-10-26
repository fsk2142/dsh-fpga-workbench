// 隐私自检：本机路径 / 用户名 / 邮箱 / 密钥。
//
// ## 为什么要有这个文件
//
// 2026-10-24 全面审查抓到一处泄漏：`tools/lib/version-range.mjs` 里为了找 semver 库，
// 硬编码了 `C:/Users/<用户名>/AppData/...`。而**同一轮**我还在技术栈文档里
// 把「硬编码本机路径」写成 `dsh-safe-delete` 踩过的坑之一。
//
// 结论：**写进文档的教训不等于自己会遵守**。这类检查必须自动化、进 `npm test`，
// 不能靠"提交前记得跑一下"。
//
// ## 判据
//
// 只报**真的会泄露**的形态，避免噪声：
//   · `C:\Users\<真名>` / `/Users/<name>` / `/home/<name>` —— 但排除 `John Doe` 这类占位名；
//   · 真实邮箱 —— 排除 `noreply` / `example.com` / 依赖包的 scoped 名；
//   · 常见密钥前缀（`sk-` / `ghp_` / `AKIA` / `Bearer <长串>`）。
//
// **不含**：GitHub 账号名（`fsk2142`）—— 它是仓库地址的一部分，公开且必要。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

/** git 跟踪的文件列表。 */
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);

/** 逐文件读内容（跳过二进制与过大的文件）。 */
const readText = (rel) => {
  try {
    const text = readFileSync(join(ROOT, rel), "utf8");
    // 含 NUL 的当二进制跳过
    return text.includes("\u0000") ? "" : text;
  } catch {
    return "";
  }
};

/**
 * 自检模式：把 stdin 的内容当成一个待检文件。
 *
 * 为什么需要它：本检查只扫 **git 跟踪**的文件（那才是会推上去的东西），
 * 所以「往仓库里临时扔一个未跟踪的探针」这种验证方式**看不到效果** ——
 * 我第一次做反向验证时就栽在这里，5 种泄漏全部"漏抓"，实际是根本没扫那个文件。
 *
 * 用法：`echo '<泄漏样本>' | node tools/check-privacy.mjs --stdin`
 */
const STDIN_MODE = process.argv.includes("--stdin");

/**
 * 本文件自身不参与扫描。
 *
 * 它的注释与自检样例里**必须**写出会被检测的形态（`C:\Users\xxx`、`someone@qq.com`），
 * 否则读代码的人看不出判据长什么样。不排除自己就是永久的自指误报
 * —— 2026-10-26 第一次跑就撞上了。
 */
const SELF = "tools/check-privacy.mjs";

const files = STDIN_MODE
  ? [{ rel: "<stdin>", text: readFileSync(0, "utf8") }]
  : tracked
      .filter((rel) => rel !== SELF)
      .map((rel) => ({ rel, text: readText(rel) }))
      .filter((item) => item.text !== "");

// ── 1. 本机绝对路径 ─────────────────────────────────────────────────────
//
// 只认"用户目录 + 看起来像真人名/账号"的形态。`<name>` / `<用户名>` 是占位符
// （README 与 scrub 脚本里当例子用），`John Doe` 是英文占位名（等价于"张三"），
// 都出现在文档里是合理的，不该报。
//
// 三种形态：Windows 的 `C:\Users\xxx`、macOS 的 `/Users/xxx`、Linux 的 `/home/xxx`。
// 分隔符用 `[/\\]` 统一表示，避免正则字面量里的转义纠缠。
// 名字部分优先吃完整的 `<...>` 占位符，否则只吃常规字符。
const homePattern =
  /(?:[A-Za-z]:[/\\]+Users[/\\]+|[/\\]Users[/\\]|[/\\]home[/\\])(<[^>]*>|[A-Za-z0-9._$%{}-]+)/gu;

const PLACEHOLDER_NAMES = /^(John|Jane|user|username|your[_-]?name|someuser|example|\$\{?[A-Za-z_]+\}?|%[A-Za-z_]+%|<[^>]*>)$/iu;

const homeHits = [];
for (const { rel, text } of files) {
  for (const match of text.matchAll(homePattern)) {
    const name = match[1];
    if (PLACEHOLDER_NAMES.test(name)) continue;
    // 行号：数一下匹配位置之前有多少换行
    const line = text.slice(0, match.index).split("\n").length;
    homeHits.push(`${rel}:${String(line)}  ${match[0].slice(0, 70)}`);
  }
}
check(
  homeHits.length === 0,
  `没有本机用户目录的绝对路径（会泄露用户名，且在别人机器上永远失效）`,
  homeHits.slice(0, 8).join("\n        ")
);

// ── 2. 真实邮箱 ─────────────────────────────────────────────────────────
const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const EMAIL_ALLOW = /noreply|example\.com|@deepseek|@types|@vitejs|@babel|@rollup|@esbuild|pnpm\.io|@npmjs|jane@|john@/iu;

const emailHits = [];
for (const { rel, text } of files) {
  // 正常模式只扫可能写邮箱的文件（图片 / 字体之类扫了也没意义）；
  // 自检模式（`--stdin`）没有扩展名，必须全扫 —— 否则注入的样本永远测不到这条。
  if (!STDIN_MODE && !/\.(md|ts|mjs|cjs|js|json|yml|yaml)$/u.test(rel)) continue;
  for (const match of text.matchAll(emailPattern)) {
    if (EMAIL_ALLOW.test(match[0])) continue;
    const line = text.slice(0, match.index).split("\n").length;
    emailHits.push(`${rel}:${String(line)}  ${match[0]}`);
  }
}
check(emailHits.length === 0, "没有真实邮箱地址", emailHits.slice(0, 8).join("\n        "));

// ── 3. 密钥前缀 ─────────────────────────────────────────────────────────
const secretPatterns = [
  ["OpenAI 风格 sk-", /sk-[A-Za-z0-9]{20,}/gu],
  ["GitHub ghp_", /ghp_[A-Za-z0-9]{20,}/gu],
  ["AWS AKIA", /AKIA[A-Z0-9]{16}/gu],
  ["Bearer 长串", /Bearer\s+[A-Za-z0-9._-]{20,}/gu]
];
const secretHits = [];
for (const { rel, text } of files) {
  for (const [kind, pattern] of secretPatterns) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      secretHits.push(`${rel}:${String(line)}  [${kind}] ${match[0].slice(0, 30)}…`);
    }
  }
}
check(secretHits.length === 0, "没有硬编码密钥", secretHits.slice(0, 8).join("\n        "));

// ── 4. 自检：判据本身有效（防止把检测逻辑写坏而永远绿灯）────────────────
check(
  PLACEHOLDER_NAMES.test("John Doe") === false && PLACEHOLDER_NAMES.test("John") === true,
  "占位名判据把 `John` 当占位、`John Doe` 不匹配（后者含空格，实际靠别名匹配）"
);
check(
  EMAIL_ALLOW.test("someone@users.noreply.github.com") && !EMAIL_ALLOW.test("someone@qq.com"),
  "邮箱白名单只放行 noreply / 依赖包域，不放行普通邮箱域"
);

console.log(
  failures.length > 0
    ? `\nFAIL (${String(failures.length)}): ${failures.join(" | ")}`
    : "\nPASS: 隐私检查通过（无本机路径 / 邮箱 / 密钥）"
);
if (failures.length > 0) process.exitCode = 1;
