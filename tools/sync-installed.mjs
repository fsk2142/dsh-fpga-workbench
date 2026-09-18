// 把源同步进 profile 里那份已装副本 —— **不经过 pnpm**。
//
// 什么时候用它:profile 的 pnpm 操作被供应链策略挡住时(例如锁文件里有别的包太新,
// 而 `dsh plugin add` 因此整体失败)。这里只做 pnpm 对 `file:` 依赖本来会做的那件事:
// 把包内容拷进 node_modules/<包名>。因为依赖声明与锁文件记录的是**路径**
// (`file:C:/Work/dsh-fpga-workbench`),内容更新不会让它们失效。
//
// 它**不碰**:profile 的 package.json、pnpm-lock.yaml、pnpm-workspace.yaml、settings.yaml,
// 也不联网、不装任何新依赖。
//
// 用法(在你自己的终端里跑):
//   node C:\Work\dsh-fpga-workbench\tools\sync-installed.mjs            同步并校验
//   node C:\Work\dsh-fpga-workbench\tools\sync-installed.mjs --check    只看差异,不动
//   node C:\Work\dsh-fpga-workbench\tools\sync-installed.mjs --prune    顺带删掉已装多出的旧文件
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { compareTree, hashOf, shippedFiles } from "./shipped.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "dsh-fpga-workbench";
const PROFILE_NAME = process.env.DSH_PROFILE_NAME ?? "desktop";
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(HOME, ".dsh", "profiles", PROFILE_NAME);
const INSTALLED = join(PROFILE_DIR, "node_modules", PACKAGE_NAME);

const checkOnly = process.argv.includes("--check");
const prune = process.argv.includes("--prune");

/** 拒绝在形状不对的路径上写东西(与 install.mjs 同一条保险)。 */
const expectedTail = ["profiles", PROFILE_NAME, "node_modules", PACKAGE_NAME].join(sep);
if (!INSTALLED.endsWith(expectedTail)) {
  console.error(`拒绝写入:路径形状不符合预期\n  实际: ${INSTALLED}\n  期望结尾: ${expectedTail}`);
  process.exit(1);
}

if (!existsSync(INSTALLED)) {
  console.error(
    [
      `已装副本不存在:${INSTALLED}`,
      "",
      "这种情况不能手工同步 —— 说明这个包还没被 profile 接受过。",
      "请先正常安装(它会写 profile 的依赖与锁文件):",
      `  dsh plugin --profile ${PROFILE_NAME} add file:${ROOT}`,
      ""
    ].join("\n")
  );
  process.exit(1);
}

const files = shippedFiles(ROOT);
if (files.length === 0) {
  console.error("读不出该装哪些文件(检查 package.json 的 files 白名单)");
  process.exit(1);
}

const before = compareTree(ROOT, INSTALLED);
console.log(`源:   ${ROOT}`);
console.log(`已装: ${INSTALLED}`);
console.log(`应装 ${files.length} 个文件,当前差异 ${before.length} 项。\n`);

if (checkOnly) {
  for (const item of before) console.log(`  ${item}`);
  console.log(before.length === 0 ? "\n已一致,无需同步。" : "\n去掉 --check 即执行同步。");
  process.exitCode = before.length === 0 ? 0 : 1;
} else {
  // 只写真正有差异的文件:既少做无用功,也避免去动那些本来就一致的文件
  // (实测:对"内容已相同"的文件写入会被拦,而真正需要改的那些能写)。
  const targets = files
    .map((rel) => ({ rel, source: join(ROOT, rel), target: join(INSTALLED, rel) }))
    .filter(({ source, target }) => !existsSync(target) || hashOf(source) !== hashOf(target));

  for (const { rel, source, target } of targets) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    console.log(`  写入 ${rel}`);
  }
  console.log(`\n已写入 ${targets.length} 个文件(共 ${files.length} 个,其余一致、跳过)。`);

  // 已装多出来的文件:默认只报不动手(删除要人点头)
  const stale = shippedFiles(INSTALLED).filter((rel) => !files.includes(rel));
  if (stale.length > 0) {
    if (prune) {
      for (const rel of stale) {
        rmSync(join(INSTALLED, rel), { force: true });
        console.log(`  删除旧文件 ${rel}`);
      }
    } else {
      console.log(`\n注意:已装副本里有 ${stale.length} 个源里没有的文件(旧版本残留):`);
      for (const rel of stale) console.log(`  ${rel}`);
      console.log("要清掉就加 --prune 再跑一次。");
    }
  }

  const after = compareTree(ROOT, INSTALLED);
  if (after.length === 0) {
    console.log("\nPASS: 已装副本与源逐字节一致。重启 DSH Desktop 生效。");
    console.log("(这不是 pnpm 安装:依赖声明与锁文件本来就有这个包,只是内容旧了。");
    console.log(" 下次正常 pnpm 操作会用同源内容重链一次,无害。)");
  } else {
    console.log(`\nFAIL: 同步后仍有 ${after.length} 项差异:`);
    for (const item of after) console.log(`  ${item}`);
    process.exitCode = 1;
  }
}
