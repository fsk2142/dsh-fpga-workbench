// 验证 profile 里已安装的那份与工作区源是否一致。
//
// 为什么需要它:pnpm 对 `file:` 依赖按**路径**记账,不按内容。源文件改过之后
// `dsh plugin add` 会回答 "Already up to date" 而**不重新拷贝** —— 你看到的现象是
// 「代码改了、界面没变」,而且没有任何报错。这一条只能靠比对文件内容发现。
//
// 用法(装完之后跑):
//   node tools/check-installed.mjs
// 退出码 0 = 已装与源一致;非 0 = 需要重装(先 remove 再 add)。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = process.env.DSH_PROFILE_DIR
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh", "profiles", "desktop");
const INSTALLED = join(PROFILE, "node_modules", "dsh-fpga-workbench");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

/** 文件的 sha256,读不到返回 null。 */
function hash(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

if (!existsSync(INSTALLED)) {
  console.log(`未安装:${INSTALLED}`);
  console.log("安装命令:dsh plugin --profile desktop add file:<工作区路径>");
  process.exitCode = 1;
} else {
  console.log(`源:   ${ROOT}`);
  console.log(`已装: ${INSTALLED}\n`);

  // 1. 每个会被宿主读取的文件都必须存在且与源逐字节一致。
  //    cordis.patch.yml 曾经整个缺失 —— 那是"补丁声明没生效"的直接迹象。
  const REQUIRED = ["package.json", "cordis.patch.yml", "lib/index.js", "lib/client.js"];
  for (const rel of REQUIRED) {
    const source = join(ROOT, rel);
    const installed = join(INSTALLED, rel);
    if (!existsSync(source)) {
      check(true, `源里没有 ${rel}(跳过)`);
      continue;
    }
    if (!existsSync(installed)) {
      check(false, `已装缺 ${rel} —— 这是旧副本,必须重装`);
      continue;
    }
    check(hash(source) === hash(installed), `${rel} 与源一致`);
  }

  // 2. 已装的清单必须声明 dsh.bundle.patch,且补丁文件真的在 —— 没有它宿主半侧
  //    (数据路由)不会加载,面板点开就是"无法读取工作台数据"。
  const installedManifest = existsSync(join(INSTALLED, "package.json"))
    ? JSON.parse(readFileSync(join(INSTALLED, "package.json"), "utf8"))
    : null;
  check(installedManifest?.dsh?.bundle?.patch !== undefined, "已装清单声明了 dsh.bundle.patch");
  if (installedManifest?.dsh?.bundle?.patch !== undefined) {
    check(existsSync(join(INSTALLED, installedManifest.dsh.bundle.patch)), `补丁文件存在(${installedManifest.dsh.bundle.patch})`);
  }
  check(installedManifest?.dsh?.client?.platform === "web", "已装清单声明了 dsh.client.platform");

  // 3. 已装副本的代码必须含有当前入口槽 —— 这是"装的是哪一版"最直接的判据。
  const installedClient = existsSync(join(INSTALLED, "lib", "client.js"))
    ? readFileSync(join(INSTALLED, "lib", "client.js"), "utf8")
    : "";
  const sourceClient = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  const slotOf = (text) => /name:\s*"(sidebar\.panellist|conversation\.session\.header\.actions)"/.exec(text)?.[1];
  check(slotOf(installedClient) === slotOf(sourceClient), `入口槽与源一致(${slotOf(installedClient)} vs ${slotOf(sourceClient)})`);

  console.log(
    failures.length > 0
      ? `\nFAIL (${failures.length}): 已装副本与源不一致,重装:\n  dsh plugin --profile desktop remove dsh-fpga-workbench\n  dsh plugin --profile desktop add file:${ROOT}`
      : "\nPASS: 已装副本与源逐字节一致,且清单声明完整"
  );
  if (failures.length > 0) process.exitCode = 1;
}
