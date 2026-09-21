// 刷新安装本插件并校验装进去的是不是当前源。
//
// 为什么需要它:pnpm 对 `file:` 依赖按**路径**记账,不按内容。源文件改了之后它会回答
// "Already up to date" 而**不重新拷贝** —— 现象是「代码改了、界面没变」,且毫无报错。
//
// 用法(必须在**你自己的终端**里跑,不要由别的进程代跑):
//   node C:\Work\dsh-fpga-workbench\tools\install.mjs          刷新并校验
//   node C:\Work\dsh-fpga-workbench\tools\install.mjs --check  只校验,不动任何东西
//
// 安全设计(踩过坑之后定的):
//   1. 先校验。一致就什么都不做 —— 避免无谓的改动。
//   2. 不一致才"把旧副本**改名**成备份 + 重装"。**绝不先删**:删了再装,中间失败会让 profile 的
//      bundles 指着一个不存在的包目录,DSH 启动直接失败(实测过)。改名是原子的、可回滚。
//   3. 安装成功 → 备份**保留**并报告路径(处置交给用户,本脚本不删)。
//      安装失败 → 把备份改回原名、恢复原状,退出码非零并说明原因。
//   4. **零删除**:本脚本不调用任何删除 API(用户定案:插件运行时绝不永久删除)。
//      静态守卫见 tools/check-toolchain.mjs —— 以后有人加回删除调用,自检会红。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupEntry, formatCleanup } from "../lib/toolchain.js";
import { compareTree } from "./shipped.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "dsh-fpga-workbench";
const PROFILE_NAME = process.env.DSH_PROFILE_NAME ?? "desktop";
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(HOME, ".dsh", "profiles", PROFILE_NAME);
const INSTALLED = join(PROFILE_DIR, "node_modules", PACKAGE_NAME);

const checkOnly = process.argv.includes("--check");

/** 恢复命令:无论在哪一步失败,用户都可以靠这一条把状态修回来。 */
const RECOVERY = `dsh plugin --profile ${PROFILE_NAME} add file:${ROOT}`;

/** 文件名安全的时间戳(备份 / 半成品改名用)。 */
const timestamp = () => new Date().toISOString().replace(/[:.]/gu, "-");

/**
 * 本脚本留下的、**不删除**的东西(探针文件、备份、安装失败留下的半成品)。
 * 用户定案:绝不永久删除,所以连自己造的临时文件也只报出来,由使用者处置。
 */
const pendingCleanup = [];

/** 打印"没删掉的遗留物"清单,并说清怎么处置。 */
function reportLeftovers() {
  if (pendingCleanup.length === 0) return;
  console.log("\n未删除的遗留物(本脚本不删任何文件,请自行处置):");
  for (const line of formatCleanup(pendingCleanup)) console.log(line);
  console.log("确认新副本正常之后,把它们移进回收站即可。");
}

/** 校验已装副本与源是否一致。@returns 失败项标签数组 */
function verify() {
  // 按 package.json 的 files 白名单逐字节比 —— 不写死文件名。
  // 写死过 4 个文件,于是只改技能/模板时会回答"已一致,无需重装",静默不生效。
  const failures = compareTree(ROOT, INSTALLED);
  const manifest = join(INSTALLED, "package.json");
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    if (parsed.dsh?.bundle?.patch === undefined) failures.push("已装清单缺 dsh.bundle.patch");
    if (parsed.dsh?.client?.platform !== "web") failures.push("已装清单缺 dsh.client.platform");
  }
  return failures;
}

/**
 * 调用 dsh 安装/重装。
 * @returns 是否成功。
 */
function runAdd() {
  console.log(`\n安装: dsh plugin --profile ${PROFILE_NAME} add file:${ROOT}\n`);
  const added = spawnSync("dsh", ["plugin", "--profile", PROFILE_NAME, "add", `file:${ROOT}`], {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true
  });
  if (added.error !== undefined) {
    console.error(`\n调用 dsh 失败:${added.error.message}`);
    return false;
  }
  if ((added.status ?? 1) !== 0) {
    console.error(`\ndsh plugin add 退出码 ${String(added.status)}`);
    return false;
  }
  return true;
}

/**
 * 安装失败时把备份改名回原位 —— **只改名,不删**。
 *
 * 失败可能留下两种东西:pnpm 建了一半的目录(INSTALLED 又出现了)、以及我们的备份。两个都不能删,
 * 所以先把半成品改名移开(带 `.failed-<时间戳>` 后缀),再把备份改回 INSTALLED;恢复后 INSTALLED
 * 里就是**原来那份旧副本**,与运行本脚本之前的状态一致。
 * @param backup - 备份目录路径;本来没有旧副本时为 undefined。
 * @returns 是否恢复成功。
 */
function restore(backup) {
  if (backup === undefined) {
    console.log("本来就没有旧副本(首次安装),不涉及回滚。");
    return true;
  }
  try {
    if (existsSync(INSTALLED)) {
      const stray = `${INSTALLED}.failed-${timestamp()}`;
      renameSync(INSTALLED, stray);
      console.log(`安装失败留下的半成品已改名移开(**未删除**):${stray}`);
      pendingCleanup.push(cleanupEntry("partial", stray));
    }
    renameSync(backup, INSTALLED);
    const at = pendingCleanup.findIndex((item) => item.path === backup);
    if (at >= 0) pendingCleanup.splice(at, 1);
    console.log(`已把备份改回原名,状态恢复:${INSTALLED}`);
    return true;
  } catch (error) {
    console.error(`回滚失败:${error.message}\n备份仍在原处(**没有删除**):${backup}`);
    return false;
  }
}

if (checkOnly) {
  const failures = verify();
  console.log(failures.length === 0 ? "已装副本与源一致。" : `不一致:\n - ${failures.join("\n - ")}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} else {
  // 1. 先看有没有必要动。一致就直接结束 —— 不做无谓的改动。
  const before = verify();
  if (before.length === 0) {
    console.log("已装副本与源一致,无需重装。");
    process.exit(0);
  }
  console.log(`需要刷新(${before.join("；")})`);

  // 2. 改名/安装前检查路径形状 —— 只允许动 <...>/profiles/<name>/node_modules/<pkg>
  const expectedTail = ["profiles", PROFILE_NAME, "node_modules", PACKAGE_NAME].join(sep);
  if (!INSTALLED.endsWith(expectedTail)) {
    console.error(`拒绝改动:路径形状不符合预期\n  实际: ${INSTALLED}\n  期望结尾: ${expectedTail}`);
    process.exit(1);
  }

  // 3. 可写性预检:先往 profile 目录写一个探针文件。
  //
  // 这一步是为了堵住一个真实事故:pnpm 需要在 profile 目录里建临时文件,而受限沙箱
  // (例如由别的 agent 进程代跑)会以 EPERM 拒绝 —— 于是重装失败。写不了就什么都不做,
  // 让用户在自己的终端里跑。
  // 探针文件**不删除**(零删除):名字固定,每次覆盖同一个文件,不会越攒越多;路径在末尾报出来。
  const probe = join(PROFILE_DIR, "_fpga_install_probe.txt");
  try {
    writeFileSync(probe, `probe ${timestamp()}\n`);
  } catch (error) {
    console.error(
      [
        `无法写入 profile 目录:${error.message}`,
        "",
        "本脚本必须在你自己的终端里运行(受限沙箱不允许 pnpm 在 profile 目录建临时文件)。",
        "未做任何改动,状态仍然可用。",
        "",
        "请手动执行:",
        `  ${RECOVERY}`,
        ""
      ].join("\n")
    );
    process.exit(1);
  }
  pendingCleanup.push(cleanupEntry("temp", probe));

  // 4. 先把现有副本**改名**成备份(同目录改名,原子;不删)。
  let backup;
  if (existsSync(INSTALLED)) {
    backup = `${INSTALLED}.bak-${timestamp()}`;
    try {
      renameSync(INSTALLED, backup);
    } catch (error) {
      console.error(
        [
          `旧副本改名备份失败:${error.message}`,
          `  源:   ${INSTALLED}`,
          `  目标: ${backup}`,
          "",
          "**没有删除任何东西**,状态未动 —— 本脚本不会「删掉再装」。",
          "常见原因:目录被别的进程占着(正在跑的 DSH 或编辑器),或者当前进程没有写权限。",
          "处理办法:关掉占用它的进程后重试;或手动执行:",
          `  ${RECOVERY}`,
          ""
        ].join("\n")
      );
      reportLeftovers();
      process.exit(1);
    }
    console.log(`旧副本已改名备份(**未删除**):${backup}`);
    pendingCleanup.push(cleanupEntry("backup", backup));
  }

  // 5. 重装。失败就把备份改回原名 —— 恢复成运行前的状态。
  if (!runAdd()) {
    console.error(
      [
        "",
        "失败:重装没有成功。已尝试把备份改回原名,恢复运行前的状态。",
        "",
        "如果上面显示回滚失败,请在你自己的终端里手动跑这一条:",
        `  ${RECOVERY}`,
        ""
      ].join("\n")
    );
    restore(backup);
    reportLeftovers();
    process.exit(1);
  }

  // 6. 校验 + 冒烟:**任何一步不过都回到运行前的状态**(第三轮复审 N-02)。
  //
  // 以前只有 `add` 失败才回滚:pnpm "返回成功但少拷了文件"、或新副本一加载就炸时,坏副本**留在盘上**,
  // 重启就是黑屏 —— 而备份明明还在旁边。现在两条路都走同一个 rollback:把半成品改名移开、备份改回原名。
  console.log("");
  const rollback = (what) => {
    console.error(`\n失败:${what}`);
    console.error("正在回到运行前的状态(把新副本移开、备份改回原名)—— 重启不会用到坏副本。");
    if (!restore(backup)) {
      console.error("**回滚没成功**,盘上现在可能是混合状态:请在你自己的终端里手动跑:");
      console.error(`  ${RECOVERY}`);
    }
    reportLeftovers();
    process.exit(1);
  };
  const after = verify();
  if (after.length !== 0) {
    rollback(`已装副本与源不一致(pnpm 又跳过了拷贝):${after.join(" | ")}`);
  }
  console.log("PASS: 已装副本与源逐字节一致。");
  // 光"字节一致"还不够 —— 再在真实解析环境里加载一遍(宿主半侧 import + 客户端 bundle
  // 的工厂函数执行)。这一步能抓住"文件都对、但一加载就炸"的情况,而那种情况重启后就是黑屏。
  console.log("\n冒烟测试:在 profile 的解析环境里加载一遍…\n");
  const smoke = spawnSync(process.execPath, [join(ROOT, "tools", "smoke-installed.mjs")], { stdio: "inherit" });
  if ((smoke.status ?? 1) !== 0) {
    rollback("冒烟测试没过(新副本在这个解析环境里加载不起来)");
  }
  console.log("\n重启 DSH Desktop 生效。");
  reportLeftovers();
}
