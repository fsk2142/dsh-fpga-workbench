#!/usr/bin/env node
/**
 * 一键清理提交历史里的对话痕迹。
 *
 * 把 `docs/SCRUB-COMMIT-HISTORY.md` 里那套手工步骤包成命令，**默认只做检查**，
 * 加 `--apply` 才真的改写历史（重写会改变所有 SHA，必须显式确认）。
 *
 * ## 用法
 *
 * ```
 * node scripts/scrub-history.mjs            # 只扫描，报告有多少提交需要清理
 * node scripts/scrub-history.mjs --preview   # 展示改写前后的样例对比
 * node scripts/scrub-history.mjs --apply     # 真改写（自动建备份分支）
 * ```
 *
 * ## 为什么默认不改写
 *
 * 重写历史不可逆、会改所有 SHA、可能让别人的安装引用失效。这种操作不该因为
 * 「跑了个脚本」就发生。
 *
 * @module dsh-llm-account/scripts/scrub-history
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** 会被认作「对话痕迹」的模式。 */
const TRACE_PATTERN = /用户|原话|报障/u;

/** 读一个命令的 stdout（失败返回空串）。 */
function run(args, options = {}) {
  try {
    return execFileSync(args[0], args.slice(1), { encoding: "utf8", ...options }).trim();
  } catch {
    return "";
  }
}

/** 取一个提交的完整信息。 */
function messageOf(sha) {
  return run(["git", "show", sha, "--format=%B", "--no-patch"]);
}

/**
 * 对一段提交信息做与 `scrub-commit-msg.mjs` 相同的改写。
 *
 * 为什么要在这里重复一遍规则而不是 `import`：那个脚本是 stdin→stdout 的过滤器，
 * 供 git 调用；这里的 `--preview` 需要**同步**拿到结果，而它的接口是流式的。
 * 两处规则必须保持一致 —— 改一处记得改另一处。
 */
function scrub(message) {
  // **标题行绝不改** —— 通用替换会打坏专有名词（`用户模板库` → `需求模板库`、
  // `告诉用户怎么装` → `告诉需求怎么装`），而标题是 GitHub 上唯一默认可见的部分。
  // 只清理正文：第一个空行之后才动手。与 scrub-commit-msg.mjs 保持同一口径。
  // **标题基本不动，但真实用户路径要清**（`\C:\Users\<用户名>\AppData\...`）。
  // 通用替换 `用户 → 需求` 会打坏专有名词（`用户模板库` → `需求模板库`），所以只清路径。
  const replaced = message.replace(/(?:\\?[A-Za-z]:)?[\\/]+Users[\\/]+[^\\/\s]+/gu, "<用户目录>");
  const split = replaced.indexOf("\n\n");
  if (split < 0) return replaced;
  const title = replaced.slice(0, split);
  const body = replaced.slice(split);
  // 注意 body 以 `\n\n` 开头；下面的 `^\n+` 会吃掉它，所以拼回去时必须显式补一个空行 ——
  // 早先直接 `title + body`，结果 `标题正文` 粘在一起（实测踩到）。
  const cleaned = body
    .replace(/^[^\n]*用户\s*20\d{2}-\d{2}-\d{2}[^\n]*\n?/gmu, "")
    .replace(/[（(]\s*20\d{2}-\d{2}-\d{2}\s*用户[^)）]*[)）]/gu, "")
    .replace(/[（(]\s*用户(?:要求|报障|反馈)[^)）]*[)）]/gu, "")
    .replace(/用户(?:报障|反馈|原话|说)([：:]?\s*「)/gu, "实际现象是$1")
    .replace(/用户(?:报障|反馈|原话|说)[：:]?\s*/gu, "")
    .replace(/经用户(?:确认|反馈|要求)/gu, "经实测")
    .replace(/经实测与实测/gu, "经实测")
    // `用户口径` 会造出「需求口径」这个生造词 —— 本仓库 25 处，必须先处理。
    .replace(/^[^\n]*用户口径\s*20\d{2}-\d{2}-\d{2}[：:][^\n]*\n?/gmu, "")
    .replace(/用户口径[：:]\s*/gu, "要求：")
    .replace(/用户口径/gu, "设计取向")
    .replace(/用户要求[：:]\s*/gu, "要求：")
    .replace(/按?用户要求/gu, "按需求")
    .replace(/用户/g, "需求")
    // 第三人称指代：比「用户」更容易暴露"AI 在与某个人对话"（自检抓到的漏网）。
    .replace(/^[^\n]*(?:他|她)(?:最初|当时|之前|自己)?的?原话[^\n]*\n?/gmu, "")
    .replace(/(?:他|她)(?:说|要求|希望|认为|反馈|报障|确认|决定)/gu, "要求")
    .replace(/的?原话[：:]?\s*/gu, "")
    .replace(/需求(?:二次|再次|又)?报障([：:]?\s*「)/gu, "实际现象是$1")
    .replace(/^[^\n]*按需求[（(]原话[)）][：:]?[^\n]*\n?/gmu, "")
    .replace(/^(\s*)报障([：:]|\s*「)/gmu, "$1实际现象是：")
    .replace(/需求(?:二次|再次|又)?报障[：:]?\s*/gu, "")
    .replace(/报障时/gu, "出问题时")
    .replace(/报障后/gu, "出问题后")
    .replace(/出问题时时/gu, "出问题时")
    .replace(/出问题后后/gu, "出问题后")
    .replace(/\n{3,}/gu, "\n\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .replace(/^\n+/u, "");

  const trimmed = cleaned.replace(/\n+$/u, "");
  return trimmed === "" ? `${title}\n` : `${title}\n\n${trimmed}\n`;
}

/** 找出所有含痕迹的提交。 */
function tracedCommits() {
  const shas = run(["git", "log", "--all", "--format=%H"]).split("\n").filter((line) => line !== "");
  return shas.filter((sha) => TRACE_PATTERN.test(messageOf(sha)));
}

/** 主流程。 */
function main() {
  const apply = process.argv.includes("--apply");
  const preview = process.argv.includes("--preview");

  const traced = tracedCommits();
  const total = run(["git", "rev-list", "--all", "--count"]);
  console.log(`提交总数：${total}`);
  console.log(`含对话痕迹：${traced.length}`);

  if (traced.length === 0) {
    console.log("\n无需清理。");
    return;
  }

  if (preview) {
    // 取一个最典型的（正文最长的）提交展示前后对比。
    const sample = traced
      .map((sha) => ({ sha, body: messageOf(sha) }))
      .sort((left, right) => right.body.length - left.body.length)[0];
    if (sample !== undefined) {
      console.log("\n──── 改写前 ────");
      console.log(sample.body.slice(0, 600));
      console.log("\n──── 改写后 ────");
      console.log(scrub(sample.body).slice(0, 600));
    }
    console.log("\n确认无误后加 --apply 执行改写。");
    return;
  }

  if (!apply) {
    console.log("\n这是只读扫描。下一步：");
    console.log("  node scripts/scrub-history.mjs --preview   看改写效果");
    console.log("  node scripts/scrub-history.mjs --apply     真正改写（会自动备份）");
    return;
  }

  // —— 真正的改写 ——
  const backup = `backup-before-scrub-${new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19)}`;
  console.log(`\n创建备份分支：${backup}`);
  run(["git", "branch", backup]);

  // 关键：filter-branch 在临时目录执行，脚本必须用绝对路径。
  const here = dirname(fileURLToPath(import.meta.url));
  const filterScript = join(here, "scrub-commit-msg.mjs").replace(/\\/gu, "/");
  console.log(`改写中（脚本：${filterScript}）…`);

  const beforeTree = run(["git", "rev-parse", "HEAD^{tree}"]);
  execFileSync(
    "git",
    ["filter-branch", "-f", "--msg-filter", `node "${filterScript}"`, "--", "--all"],
    { stdio: "inherit", env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: "1" } },
  );

  // 改写后校验：文件内容必须一个字节都没变。
  const afterTree = run(["git", "rev-parse", "HEAD^{tree}"]);
  if (beforeTree !== afterTree) {
    console.error("\n⚠ 文件内容发生了变化（tree 不一致）。请检查：");
    console.error(`  git diff --stat ${backup} HEAD`);
    console.error(`  git reset --hard ${backup}   # 需要回滚时`);
    process.exitCode = 1;
    return;
  }
  console.log("✓ 文件内容未变（只改了提交信息）");

  const left = tracedCommits().length;
  if (left === 0) {
    console.log("✓ 痕迹已全部清除");
  } else {
    // `--all` 会连备份分支与悬空对象一起扫到，所以「仍有 N 处」不等于失败。
    // 真正的判据是：**当前分支上还有没有**。
    const reachable = run(["git", "log", "HEAD", "--format=%H"]).split("\n").filter((line) => line !== "");
    const live = reachable.filter((sha) => TRACE_PATTERN.test(messageOf(sha)));
    if (live.length === 0) {
      console.log(`✓ 当前分支已干净（另有 ${left} 处在备份分支/悬空对象里，属正常）`);
    } else {
      console.log(`⚠ 当前分支仍有 ${live.length} 处未清理 —— 说明改写规则漏了某种写法`);
    }
  }
  console.log(`\n下一步（确认无误后）：`);
  console.log(`  git push --force origin main`);
  console.log(`  git tag --list | %{ git push --force origin "refs/tags/$_" }`);
  console.log(`  git branch -D ${backup}    # 一切正常后删备份`);
}

main();
