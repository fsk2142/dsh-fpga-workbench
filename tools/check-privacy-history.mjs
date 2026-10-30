#!/usr/bin/env node
/**
 * 隐私检查（历史侧）—— 扫 `git log` 而不是只看当前工作树。
 *
 * ## 为什么需要它（F-11）
 *
 * `check-privacy.mjs` 只看 `git ls-files`（**当前**版本控制文件）。
 * 于是「旧提交里写过真实用户目录 / 对话痕迹」这类问题它永远发现不了 ——
 * 而公开仓库的历史是**可访问**的，`git log` 里能翻到的就是公开的。
 *
 * ## 查什么
 *
 * | 类别 | 查法 |
 * |---|---|
 * | 提交信息里的**对话痕迹** | `用户要求` / `用户定案` / `用户报障` / `我当时` 等措辞 |
 * | 提交信息里的**个人路径** | 本机绝对路径片段（如 `C:\Users\<名>`） |
 * | 提交信息的**邮箱** | 作者/提交者邮箱若不是 noreply 也不是已知项目邮箱，点出来 |
 * | 历史 blob 里的**本机路径** | `git log -S` 搜关键片段（只报提交与路径，不回显内容） |
 *
 * ## 隐私保护
 *
 * **不回显命中的原文** —— 只报「哪个提交、什么类别、多少处」。
 * 否则这个检查工具本身就成了泄露渠道（报告里也是这么要求的）。
 *
 * 用法：
 * ```
 * node tools/check-privacy-history.mjs [--limit <提交数>] [--json]
 * ```
 *
 * 退出码：0 = 没有命中；1 = 有命中（需人工判定是否清理）。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node tools/check-privacy-history.mjs [--limit <提交数>] [--json]");
  write("");
  write("  扫 git log 的提交信息与历史 blob，找对话痕迹、本机路径、可疑邮箱。");
  write("  **不回显命中原文** —— 只报提交与类别，避免检查工具本身成为泄露渠道。");
  write("");
  write("  --limit N   只扫最近 N 条提交（默认全扫）");
  write("  --json      输出机器可读 JSON");
  write("");
  write("退出码：0 = 无命中；1 = 有命中；2 = 用法错误。");
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = { limit: 0, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        console.error("--limit 需要一个正整数");
        process.exit(2);
      }
      options.limit = value;
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") usage(0);
    console.error(`未知参数：${arg}`);
    usage();
  }
  return options;
};

/** 跑 git，返回 stdout。 */
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * 提交信息里的**对话痕迹**关键词。
 *
 * 只挑「明显是转述对话」的措辞；泛泛的「用户」不算 —— 报告也说了要按风险分级，
 * 不能把任何「用户」字样一概当秘密。
 */
const CONVERSATION_MARKERS = [
  "用户要求",
  "用户定案",
  "用户报障",
  "用户指出",
  "用户当场",
  "用户认可",
  "用户明确",
  "我当时",
  "我犯的错",
  "我说过",
  "我建议",
  "按用户口径"
];

/** 本机绝对路径的形态（只认「盘符 + Users」这种高置信度）。 */
const LOCAL_PATH_PATTERNS = [
  /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_.-]+/u,
  /[A-Za-z]:[\\/]Documents and Settings[\\/][A-Za-z0-9_.-]+/u,
  /\/home\/[a-z0-9_-]+/u
];

/** 已知可接受的邮箱（noreply 之类）。 */
const ACCEPTABLE_EMAIL = /(?:users\.noreply\.github\.com|noreply@|example\.(?:com|org))/iu;

const main = () => {
  const options = parseArgs(process.argv.slice(2));

  const findings = [];

  // ── ① 提交信息 ──
  const logArgs = ["log", "--pretty=format:%H%x1f%an%x1f%ae%x1f%s%x1f%b%x1e"];
  if (options.limit > 0) logArgs.splice(1, 0, `-n${String(options.limit)}`);
  const raw = git(logArgs);
  const commits = raw
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "")
    .map((chunk) => {
      const [hash, author, email, subject, body] = chunk.split("\x1f");
      return { hash, author, email, subject, body: body ?? "" };
    });

  for (const commit of commits) {
    const message = `${commit.subject}\n${commit.body}`;

    // 对话痕迹
    const hitMarkers = CONVERSATION_MARKERS.filter((marker) => message.includes(marker));
    if (hitMarkers.length > 0) {
      findings.push({
        kind: "提交信息含对话痕迹",
        hash: commit.hash.slice(0, 7),
        count: hitMarkers.length,
        // 只报关键词类别，不回显上下文
        markers: hitMarkers
      });
    }

    // 个人路径
    for (const pattern of LOCAL_PATH_PATTERNS) {
      if (pattern.test(message)) {
        findings.push({
          kind: "提交信息含本机路径",
          hash: commit.hash.slice(0, 7),
          count: 1,
          markers: ["(路径已隐去)"]
        });
        break;
      }
    }

    // 邮箱
    if (typeof commit.email === "string" && commit.email !== "" && !ACCEPTABLE_EMAIL.test(commit.email)) {
      findings.push({
        kind: "提交者邮箱非 noreply",
        hash: commit.hash.slice(0, 7),
        count: 1,
        markers: ["(邮箱已隐去)"]
      });
    }
  }

  // ── ② 历史 blob 里的本机路径 ──
  //
  // `git log -S<片段>` 找「哪次提交改过含该片段的文件」。片段取 `Users` 太宽，
  // 所以拆成两个更具体的：`C:/Users` 与 `C:\Users`（各自在路径里出现才算）。
  for (const fixString of ["C:/Users", "C:\\Users"]) {
    let log = "";
    try {
      log = git(["log", "--all", "--pretty=format:%H", "-S", fixString]);
    } catch {
      continue;
    }
    const hashes = log.split("\n").map((line) => line.trim()).filter(Boolean);
    if (hashes.length > 0) {
      findings.push({
        kind: "历史 blob 含本机用户目录路径",
        hash: hashes[0].slice(0, 7),
        count: hashes.length,
        markers: [`${String(hashes.length)} 条提交曾引入/删除该片段`]
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ commits: commits.length, findings }, null, 2));
  } else {
    console.log(`扫描 ${String(commits.length)} 条提交`);
    console.log("");
    if (findings.length === 0) {
      console.log("PASS：提交信息与历史 blob 里没发现对话痕迹、本机路径或可疑邮箱。");
      console.log("      （范围：当前 git 仓库的全部可达提交）");
    } else {
      // 按类别归并，避免刷屏
      const byKind = new Map();
      for (const item of findings) {
        if (!byKind.has(item.kind)) byKind.set(item.kind, []);
        byKind.get(item.kind).push(item);
      }
      for (const [kind, items] of byKind) {
        console.log(`${kind}：${String(items.length)} 处`);
        for (const item of items.slice(0, 8)) {
          console.log(`  ${item.hash}  ${item.markers.join("、")}`);
        }
        if (items.length > 8) console.log(`  ...还有 ${String(items.length - 8)} 处`);
        console.log("");
      }
      console.log("注意：命中不等于必须清理 —— 泛泛的「用户」不算隐私，");
      console.log("      但引用私人对话原文、真实用户名或本机路径的，要考虑改写历史。");
      console.log("      改历史的注意事项见 docs/SCRUB-COMMIT-HISTORY.md。");
    }
  }

  process.exit(findings.length > 0 ? 1 : 0);
};

main();
