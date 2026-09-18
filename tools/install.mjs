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
//   1. 先校验。一致就什么都不做 —— 避免无谓的删除。
//   2. 不一致才"移除旧副本 + 重装"。
//   3. 任何一步失败都**明确打印恢复命令**,绝不把"删了但没装回去"当成功 ——
//      那种状态会让 profile 的 bundles 列着一个不存在的包,DSH 启动会直接失败。
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

if (checkOnly) {
  const failures = verify();
  console.log(failures.length === 0 ? "已装副本与源一致。" : `不一致:\n - ${failures.join("\n - ")}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} else {
  // 1. 先看有没有必要动。一致就直接结束 —— 不做无谓的删除。
  const before = verify();
  if (before.length === 0) {
    console.log("已装副本与源一致,无需重装。");
    process.exit(0);
  }
  console.log(`需要刷新(${before.join("；")})`);

  // 2. 删除前检查路径形状 —— 只允许删 <...>/profiles/<name>/node_modules/<pkg>
  const expectedTail = ["profiles", PROFILE_NAME, "node_modules", PACKAGE_NAME].join(sep);
  if (!INSTALLED.endsWith(expectedTail)) {
    console.error(`拒绝删除:路径形状不符合预期\n  实际: ${INSTALLED}\n  期望结尾: ${expectedTail}`);
    process.exit(1);
  }

  // 3. 可写性预检:先往 profile 目录写一个临时文件再删掉。
  //
  // 这一步是为了堵住一个真实事故:pnpm 需要在 profile 目录里建临时文件,而受限沙箱
  // (例如由别的 agent 进程代跑)会以 EPERM 拒绝 —— 于是"删掉旧副本"成功、"装回去"
  // 失败,profile 的 bundles 就列着一个不存在的包目录,DSH 启动直接失败。
  // 写不了就什么都不做,让用户在自己的终端里跑。
  const probe = join(PROFILE_DIR, `_fpga_install_probe_${String(process.pid)}`);
  try {
    writeFileSync(probe, "probe");
    rmSync(probe, { force: true });
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
    try {
      rmSync(probe, { force: true });
    } catch {
      /* 清不掉也无所谓,名字带 pid、不影响加载 */
    }
    process.exit(1);
  }

  if (existsSync(INSTALLED)) {
    console.log(`移除旧副本:${INSTALLED}`);
    try {
      rmSync(INSTALLED, { recursive: true, force: true });
    } catch (error) {
      console.error(`移除失败:${error.message}\n未做任何改动,状态仍然可用。`);
      process.exit(1);
    }
  }

  // 3. 重装。失败时必须让用户知道现在处于"副本已移除"的状态。
  if (!runAdd()) {
    console.error(
      [
        "",
        "失败:旧副本已移除,但重装没有成功 —— profile 的 bundles 仍然列着这个包,",
        "而它的目录不存在,DSH 启动会直接失败。",
        "",
        "请在你的终端里跑这一条修复:",
        `  ${RECOVERY}`,
        ""
      ].join("\n")
    );
    process.exit(1);
  }

  // 4. 校验
  console.log("");
  const after = verify();
  if (after.length === 0) {
    console.log("PASS: 已装副本与源逐字节一致。重启 DSH Desktop 生效。");
  } else {
    console.log(`FAIL: ${after.join(" | ")}`);
    console.log(`pnpm 又跳过了拷贝 —— 再跑一次本脚本,或手动:${RECOVERY}`);
    process.exitCode = 1;
  }
}
