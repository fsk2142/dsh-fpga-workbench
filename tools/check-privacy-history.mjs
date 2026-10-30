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

/**
 * 本机绝对路径的形态（只认高置信度）。
 *
 * ## 为什么要排除占位符（2026-10-30 实测）
 *
 * 检查工具的**文档与示例本身**必须写出会被检测的形态，否则没法说明规则。
 * 但那些示例用的是 `<name>` / `xxx` / `John` 这类占位符 —— 它们不是真账号。
 *
 * 原正则 `/\/home\/[a-z0-9_-]+/` 会把示例里的 `/home/x` 当成真实路径报出来（误报）。
 * 现在统一用 `PLACEHOLDER` 排除。
 */
const PLACEHOLDER = /^(?:<.*>|x{1,3}|name|username|user|john|jane|example|me|you|someone|\$\{?[\w]*\}?|\*+|\.+|…)$/iu;

/** 是不是占位符（不是真账号）。 */
const isPlaceholder = (segment) => segment === undefined || PLACEHOLDER.test(segment);

const LOCAL_PATH_PATTERNS = [
  { re: /[A-Za-z]:[\\/]Users[\\/]([^\\/\s'"`<>|]+)/gu, group: 1 },
  { re: /[A-Za-z]:[\\/]Documents and Settings[\\/]([^\\/\s'"`<>|]+)/gu, group: 1 },
  { re: /\/home\/([a-z0-9_-]+)/gu, group: 1 }
];

/**
 * 提交文本里有没有**真实的**本机路径（占位符不算）。
 * @param text - 提交信息。
 * @returns 命中的路径形态；没有则返回 undefined。
 */
const findLocalPath = (text) => {
  for (const { re, group } of LOCAL_PATH_PATTERNS) {
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match !== null) {
      if (!isPlaceholder(match[group])) return match[0];
      match = re.exec(text);
    }
  }
  return undefined;
};

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

    // 个人路径（占位符不算 —— 见 findLocalPath 的说明）
    if (findLocalPath(message) !== undefined) {
      findings.push({
        kind: "提交信息含本机路径",
        hash: commit.hash.slice(0, 7),
        count: 1,
        markers: ["(路径已隐去)"]
      });
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
  // ## 为什么不用 `git log -S`
  //
  // `-S<片段>` 匹配的是「**这次提交让该片段的出现次数变了**」—— 引入它和**删除**它
  // 都会命中。于是「某人删掉了硬编码路径」这个**正确的修复**反而被报成问题，
  // 而且永远报（只要历史上出现过一次）。
  //
  // ## 现在的做法
  //
  // 直接遍历每个提交里**受影响文件的当前内容**，看还有没有真实路径。
  // 已经清理干净的历史不会再报。
  //
  // 为控制开销，只查**曾经改过** `tools/` 或 `presets/` 下文件的提交 —— 路径只可能在那。
  // 用 `git grep` 在整棵树上查（它按 blob 缓存，比逐个 `git show` 快）。
  {
    // 一份「含真实用户目录」的提交清单。`git grep` 不支持历史，所以按提交查。
    const suspects = new Set();
    // 找出所有涉及过的、可能带路径的文件（一次查完，不按提交逐个扫）
    for (const fixString of ["Users/", "Users\\"]) {
      let log = "";
      try {
        log = git(["log", "--all", "--pretty=format:%H", "-S", fixString, "--", "tools", "presets", "scripts"]);
      } catch {
        continue;
      }
      for (const line of log.split("\n")) {
        const hash = line.trim();
        if (hash !== "") suspects.add(hash);
      }
    }

    // 对每个候选提交，检查它当时那棵树里还有没有**真实**路径
    //
    // `git grep` 只能按模式过滤，认不出占位符（`<用户名>` / `xxx` / `John`），
    // 所以 grep 只用来**缩小范围**，真正的判定走 findLocalPath（与提交信息同一套规则）。
    const stillLeaking = [];
    for (const hash of suspects) {
      let files = "";
      try {
        files = git(["grep", "-l", "-I", "-E", "[A-Za-z]:[\\\\/]Users[\\\\/]", hash, "--", "tools", "presets", "scripts"]);
      } catch {
        continue; // grep 没命中会退 1
      }
      const paths = files
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(line.indexOf(":") + 1)); // 去掉 `<hash>:` 前缀

      for (const path of paths) {
        let content = "";
        try {
          content = git(["show", `${hash}:${path}`]);
        } catch {
          continue;
        }
        if (findLocalPath(content) !== undefined) {
          stillLeaking.push({ hash, path });
          break;
        }
      }
    }

    if (stillLeaking.length > 0) {
      findings.push({
        kind: "历史 blob 含本机用户目录路径",
        hash: stillLeaking[0].hash.slice(0, 7),
        count: stillLeaking.length,
        markers: [`${String(stillLeaking.length)} 个提交的树里仍有真实路径（占位符不算）`]
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
