// 把源同步进 profile 里那份已装副本 —— **不经过 pnpm**。
//
// 什么时候用它:profile 的 pnpm 操作被供应链策略挡住时(例如锁文件里有别的包太新,
// 而 `dsh plugin add` 因此整体失败)。这里只做 pnpm 对 `file:` 依赖本来会做的那件事:
// 把包内容拷进 node_modules/<包名>。因为依赖声明与锁文件记录的是**路径**
// (`file:C:/Work/dsh-fpga-workbench`),内容更新不会让它们失效。
//
// 它**不碰**:profile 的 package.json、pnpm-lock.yaml、pnpm-workspace.yaml、settings.yaml,
// 也不联网、不装任何新依赖。**也不删除任何文件**(用户定案):已装副本里多出来的旧文件只列出来。
//
// 用法(在你自己的终端里跑):
//   node C:\Work\dsh-fpga-workbench\tools\sync-installed.mjs            同步并校验
//   node C:\Work\dsh-fpga-workbench\tools\sync-installed.mjs --check    只看差异,不动
//   node C:\Work\dsh-fpga-workbench\tools\sync-installed.mjs --prune    也列出已装多出的旧文件
//     ↑ `--prune` 原本是"顺带删掉",现已改为**只列不删**(用户定案:插件运行时绝不永久删除)。
//       开关保留,免得既有流程按老写法调用时报"未知参数";两种写法的行为现在一样。
//
// 退出码:内容差异(缺文件 / 内容不一致)算失败(那正是本脚本要来修的);**"已装多出"只报告、
// 不算失败** —— 它已经不可能由本脚本处置了(不删除),拿它报红只会逼人去恢复删除。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupEntry, formatCleanup } from "../lib/toolchain.js";
import { compareTree, hashOf, shippedFiles } from "./shipped.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "dsh-fpga-workbench";
const PROFILE_NAME = process.env.DSH_PROFILE_NAME ?? "desktop";
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(HOME, ".dsh", "profiles", PROFILE_NAME);
const INSTALLED = join(PROFILE_DIR, "node_modules", PACKAGE_NAME);

/** 文件名安全的时间戳(备份目录名与"改名移开"的后缀用)。 */
const timestamp = () => new Date().toISOString().replace(/[:.]/gu, "-");

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

/** compareTree 里"已装多出"的那一类 —— 只报告,不算失败(见文件头的退出码说明)。 */
const isExtra = (item) => item.startsWith("已装多出 ");
const blockingOf = (list) => list.filter((item) => !isExtra(item));
const extrasOf = (list) => list.filter(isExtra);

/** 已装副本里"源里没有"的相对路径(= compareTree 的「已装多出」那一类)。 */
const extraFiles = () => shippedFiles(INSTALLED).filter((rel) => !files.includes(rel));

/**
 * 列出"已装副本里多出来"的文件 —— **只列不删**(用户定案:零删除 + 如实报告)。
 * @param list - 相对路径数组;空数组时什么都不打印。
 */
function reportExtras(list) {
  if (list.length === 0) return;
  console.log(`\n已装副本里有 ${list.length} 个源里没有的文件(旧版本残留,**只列不删**):`);
  for (const line of formatCleanup(list.map((rel) => cleanupEntry("installedExtra", join(INSTALLED, rel))))) {
    console.log(line);
  }
  console.log("本插件不删除文件:要处置请自己把它们移到回收站(或在资源管理器里删除)。");
  console.log(
    prune
      ? "(你加了 --prune:它现在只表示「把这份清单列出来」,**不再删除**。)"
      : "(加 --prune 看到的也是同一份清单 —— 它不再删除任何东西。)"
  );
  console.log("注意:`presets/` 下多出来的旧技能**照样会被预设加载**,别把它当成已清理。");
}

if (checkOnly) {
  for (const item of blockingOf(before)) console.log(`  ${item}`);
  reportExtras(extraFiles());
  console.log(
    blockingOf(before).length === 0
      ? "\n已一致,无需同步(「已装多出」只报告,不影响这条判断)。"
      : "\n去掉 --check 即执行同步。"
  );
  process.exitCode = blockingOf(before).length === 0 ? 0 : 1;
} else {
  // 只写真正有差异的文件:既少做无用功,也避免去动那些本来就一致的文件
  // (实测:对"内容已相同"的文件写入会被拦,而真正需要改的那些能写)。
  const targets = files
    .map((rel) => ({ rel, source: join(ROOT, rel), target: join(INSTALLED, rel) }))
    .filter(({ source, target }) => !existsSync(target) || hashOf(source) !== hashOf(target));

  // 半途失败**不能静默留下混合树**(第三轮复审 N-10):逐个覆写时,中途出错会得到"一部分新、
  // 一部分旧"的副本 —— 那种状态重启后行为不确定。做法与 `install.mjs` 同一套:写之前先把**要改的
  // 那些文件**的旧内容快照到 `<home>/.dsh/.fpga-workbench-backup/sync-<时间戳>/`;失败就回滚
  // (旧文件按快照写回;这次新加的文件**改名**移开 —— 零删除,不做永久删除)。
  const backupRoot = join(HOME, ".dsh", ".fpga-workbench-backup", `sync-${timestamp()}`);
  const snapshotOf = new Map();
  let written = 0;
  try {
    for (const { rel, source, target } of targets) {
      const before = existsSync(target) ? readFileSync(target) : undefined;
      snapshotOf.set(rel, before);
      if (before !== undefined) {
        const saved = join(backupRoot, rel);
        mkdirSync(dirname(saved), { recursive: true });
        writeFileSync(saved, before);
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      written += 1;
      console.log(`  写入 ${rel}`);
    }
  } catch (error) {
    console.error(`\n同步中断:${error.message}`);
    console.error(`  已写入 ${written}/${targets.length} 个文件 —— 正在回滚到运行前的状态(不删除任何东西)。`);
    const restored = [];
    const movedAside = [];
    for (const { rel, target } of targets.slice(0, written)) {
      const before = snapshotOf.get(rel);
      try {
        if (before === undefined) {
          const aside = `${target}.failed-${timestamp()}`;
          renameSync(target, aside);
          movedAside.push(aside);
        } else {
          writeFileSync(target, before);
          restored.push(rel);
        }
      } catch (rollbackError) {
        console.error(`  **回滚这一项失败**:${rel}(${rollbackError.message})`);
      }
    }
    console.error(`  回滚结果:恢复 ${restored.length} 个、把 ${movedAside.length} 个新增文件改名移开(未删除)。`);
    if (existsSync(backupRoot)) console.error(`  旧内容快照留在:${backupRoot}`);
    console.error("  修掉上面那个错误(通常是文件被占用或没有写权限)后重跑同一条命令即可;本脚本是幂等的。");
    reportExtras(extraFiles());
    process.exit(1);
  }
  console.log(`\n已写入 ${written} 个文件(共 ${files.length} 个,其余一致、跳过)。`);

  const after = compareTree(ROOT, INSTALLED);
  const remaining = blockingOf(after);
  if (remaining.length === 0) {
    const extras = extrasOf(after).length;
    console.log(`\nPASS: 源里列出的 ${files.length} 个文件在已装副本里逐字节一致${extras === 0 ? "" : `(另有 ${extras} 个源里没有的旧文件,只报告不删除 —— 它们仍在已装目录里,重启后照样会被加载)`}。重启 DSH Desktop 生效。`);
    console.log("(这不是 pnpm 安装:依赖声明与锁文件本来就有这个包,只是内容旧了。");
    console.log(" 下次正常 pnpm 操作会用同源内容重链一次,无害。)");
  } else {
    console.log(`\nFAIL: 同步后仍有 ${remaining.length} 项内容差异:`);
    for (const item of remaining) console.log(`  ${item}`);
    process.exitCode = 1;
  }
  reportExtras(extraFiles());
}
