#!/usr/bin/env node
/**
 * 把历史版本里的真实用户名目录换成占位符（F-08）。
 *
 * ## 为什么要做
 *
 * 提交信息已经清干净了，但**文件内容**在旧版本里仍含 `C:/Users/<真名>/...`。
 * `git log -S` 能翻到就说明它可访问 —— 改动提交信息治不了这一层。
 *
 * ## 覆盖哪些文件
 *
 * 不止 `version-range.mjs`。实测发现 `scripts/scrub-history.mjs` **自己的注释**里
 * 也写过真实路径 —— 「清理工具把真实路径写进注释」正是它自己警告过的坑。
 *
 * 所以对**所有可能含路径的目录**都做替换：`tools/`、`presets/`、`scripts/`、`docs/`。
 * 但替换只针对 `X:/Users/<名>` / `X:\Users\<名>` 这一种片段，不做通用批量替换 ——
 * 那会误伤文档里正常的路径示例（`C:\Users\xxx` 这类占位符本来就该保留）。
 *
 * ## 怎么用
 *
 * 由 `git filter-branch --index-filter` 调用，作用于**每个提交的索引**：
 *
 * ```
 * git filter-branch -f \
 *   --index-filter 'node "<绝对路径>/scripts/scrub-blob-username.mjs"' \
 *   --tag-name-filter cat -- --all
 * ```
 *
 * ## 为什么在 index-filter 里做
 *
 * `--tree-filter` 要每个提交检出整个工作树（318 个提交会很慢）。
 * `--index-filter` 只碰索引，快得多。
 */
import { execFileSync } from "node:child_process";

/** 可能是路径载体的目录（前缀匹配）。 */
const TARGET_DIRS = ["tools/", "presets/", "scripts/", "docs/"];

/** 已经是占位符的不再替换。 */
const PLACEHOLDER = /^(?:<|xxx?$|name$|username$|user$|john|jane|example|someone)/iu;

const git = (args, input) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input })
  });

/** 列出这个提交索引里的文件。 */
let files;
try {
  files = git(["ls-files"]).split("\n").map((line) => line.trim()).filter(Boolean);
} catch {
  process.exit(0);
}

const targets = files.filter((path) => TARGET_DIRS.some((dir) => path.startsWith(dir)));
if (targets.length === 0) process.exit(0);

for (const path of targets) {
  let original;
  try {
    original = git(["show", `:${path}`]);
  } catch {
    continue;
  }

  // 只替换 `X:/Users/<名>` 或 `X:\Users\<名>` 里那些**不是占位符**的名字。
  const rewritten = original.replace(
    /([A-Za-z]:[\\/]Users[\\/])([^\\/\s"'`]+)/gu,
    (whole, prefix, name) => (PLACEHOLDER.test(name) ? whole : `${prefix}<用户名>`)
  );

  if (rewritten === original) continue;

  // 写进对象库，再把索引项指向新 blob（不检出工作树）
  const hash = git(["hash-object", "-w", "--stdin"], rewritten).trim();
  git(["update-index", "--add", "--cacheinfo", `100644,${hash},${path}`]);
}

process.exit(0);

