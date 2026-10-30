#!/usr/bin/env node
/**
 * 把历史版本里 `tools/lib/version-range.mjs` 的真实用户名目录换成占位符（F-08）。
 *
 * ## 为什么要做
 *
 * 提交信息已经清干净了，但**文件内容**在旧版本里仍含
 * `C:/Users/<真名>/AppData/...`。`git log -S` 能翻到就说明它可访问 ——
 * 改动提交信息治不了这一层。
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
 * `--tree-filter` 要每个提交检出整个工作树（317 个提交会很慢）。
 * `--index-filter` 只碰索引，快得多。
 *
 * ## 替换范围
 *
 * **只动一个文件、一种片段**：`X:/Users/<名>` → `X:/Users/<用户名>`。
 * 不做通用批量替换 —— 那会误伤文档里正常的路径示例。
 *
 * 用 `git update-index --cacheinfo` 写回索引，不检出工作树。
 */
import { execFileSync } from "node:child_process";

const TARGET = "tools/lib/version-range.mjs";

const git = (args, input) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input })
  });

let original;
try {
  original = git(["show", `:${TARGET}`]);
} catch {
  // 这个提交里没有该文件（还没创建或已删除）—— 正常，跳过
  process.exit(0);
}

// 把 `X:/Users/<名>` 或 `X:\Users\<名>` 里的名字换成占位符。
// 已经是 <用户名> 的不再重复替换。
const rewritten = original.replace(
  /([A-Za-z]:[\\/]Users[\\/])(?![<])[^\\/\s"'`]+/gu,
  "$1<用户名>"
);

if (rewritten === original) process.exit(0);

// 写进对象库，再把索引项指向新 blob
const hash = git(["hash-object", "-w", "--stdin"], rewritten).trim();
git(["update-index", "--add", "--cacheinfo", `100644,${hash},${TARGET}`]);
process.exit(0);
