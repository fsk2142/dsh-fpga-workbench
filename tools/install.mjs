// 一条命令刷新安装本插件,并立刻校验装进去的是不是当前源。
//
// 为什么不能直接 `dsh plugin add`:pnpm 对 `file:` 依赖按**路径**记账,不按内容。
// 源文件改了之后它会回答 "Already up to date" 而**不重新拷贝**,你看到的现象是
// 「代码改了、界面没变」,而且没有任何报错。所以必须先把旧副本从 node_modules 里
// 移除,再装。
//
// 用法:
//   node C:\Work\dsh-fpga-workbench\tools\install.mjs          重装并校验
//   node C:\Work\dsh-fpga-workbench\tools\install.mjs --check  只校验,不动任何东西
//
// 它只删一个目录:<profile>/node_modules/dsh-fpga-workbench,并且删之前会检查这个
// 路径的形状(必须在 profiles/<name>/node_modules 下),避免任何情况下误删别的东西。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "dsh-fpga-workbench";
const PROFILE_NAME = process.env.DSH_PROFILE_NAME ?? "desktop";
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(HOME, ".dsh", "profiles", PROFILE_NAME);
const INSTALLED = join(PROFILE_DIR, "node_modules", PACKAGE_NAME);

/** 会被宿主读取的文件 —— 装完必须与源逐字节一致。 */
const FILES = ["package.json", "cordis.patch.yml", "lib/index.js", "lib/client.js"];

const checkOnly = process.argv.includes("--check");

function hash(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** 校验已装副本与源是否一致。@returns 失败项标签数组 */
function verify() {
  const failures = [];
  if (!existsSync(INSTALLED)) return [`未安装到 ${INSTALLED}`];
  for (const rel of FILES) {
    const source = join(ROOT, rel);
    const installed = join(INSTALLED, rel);
    if (!existsSync(source)) continue;
    if (!existsSync(installed)) {
      failures.push(`已装缺 ${rel}`);
      continue;
    }
    if (hash(source) !== hash(installed)) failures.push(`${rel} 与源不一致`);
  }
  const manifest = join(INSTALLED, "package.json");
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    if (parsed.dsh?.bundle?.patch === undefined) failures.push("已装清单缺 dsh.bundle.patch");
    if (parsed.dsh?.client?.platform !== "web") failures.push("已装清单缺 dsh.client.platform");
  }
  return failures;
}

if (checkOnly) {
  const failures = verify();
  console.log(failures.length === 0 ? "已装副本与源一致。" : `不一致:\n - ${failures.join("\n - ")}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} else {
  // 1. 删除前检查路径形状 —— 只允许删 <...>/profiles/<name>/node_modules/<pkg>
  const expectedTail = [ "profiles", PROFILE_NAME, "node_modules", PACKAGE_NAME ].join(sep);
  if (!INSTALLED.endsWith(expectedTail)) {
    console.error(`拒绝删除:路径形状不符合预期\n  实际: ${INSTALLED}\n  期望结尾: ${expectedTail}`);
    process.exit(1);
  }

  if (existsSync(INSTALLED)) {
    console.log(`移除旧副本:${INSTALLED}`);
    rmSync(INSTALLED, { recursive: true, force: true });
  } else {
    console.log("没有旧副本,直接安装。");
  }

  // 2. 安装。stdio 继承,让 pnpm 的输出原样显示给你。
  console.log(`\n安装: dsh plugin --profile ${PROFILE_NAME} add file:${ROOT}\n`);
  const added = spawnSync("dsh", ["plugin", "--profile", PROFILE_NAME, "add", `file:${ROOT}`], {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true
  });
  if (added.error !== undefined) {
    console.error(`\n调用 dsh 失败:${added.error.message}`);
    process.exitCode = 1;
  } else if ((added.status ?? 1) !== 0) {
    console.error(`\ndsh plugin add 退出码 ${String(added.status)}`);
    process.exitCode = 1;
  } else {
    // 3. 校验
    console.log("");
    const failures = verify();
    if (failures.length === 0) {
      console.log("PASS: 已装副本与源逐字节一致。重启 DSH Desktop 生效。");
    } else {
      console.log(`FAIL: ${failures.join(" | ")}`);
      console.log("如果这里报不一致,说明 pnpm 又跳过了拷贝 —— 再跑一次本脚本。");
      process.exitCode = 1;
    }
  }
}
