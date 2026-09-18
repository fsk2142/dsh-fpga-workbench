// 验证 profile 里已安装的那份与工作区源是否一致。
//
// 为什么需要它:pnpm 对 `file:` 依赖按**路径**记账,不按内容。源文件改过之后
// `dsh plugin add` 会回答 "Already up to date" 而**不重新拷贝** —— 现象是
// 「改完了没生效」,而且没有任何报错。这一条只能靠比对内容发现。
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

/** 这个包该装进去的全部内容(纯模式插件:预设 + 补丁 + 清单)。 */
const REQUIRED = [
  "package.json",
  "cordis.patch.yml",
  "presets/fpga-workbench/preset.yml",
  "presets/fpga-workbench/agent.cordis.yml"
];

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
  console.log(`安装命令:dsh plugin --profile desktop add file:${ROOT}`);
  process.exitCode = 1;
} else {
  console.log(`源:   ${ROOT}`);
  console.log(`已装: ${INSTALLED}\n`);

  // 1. 该装的东西必须都在,且与源逐字节一致。
  for (const rel of REQUIRED) {
    const source = join(ROOT, rel);
    const installed = join(INSTALLED, rel);
    if (!existsSync(source)) {
      check(false, `源里缺 ${rel}(它应该在仓库里)`);
      continue;
    }
    if (!existsSync(installed)) {
      check(false, `已装缺 ${rel} —— 旧副本,必须重装`);
      continue;
    }
    check(hash(source) === hash(installed), `${rel} 与源一致`);
  }

  // 2. `files` 白名单必须覆盖预设目录。
  //
  // pnpm 装 file: 依赖时按 files 打包,白名单外的东西**不会被拷进 profile**。
  // 踩过的坑:presets/ 没写进 files → 安装副本缺预设目录 → 补丁里的 agent-presets
  // roots 指向空目录 → 预设列表里永远看不到「FPGA 工作台」,而且没有任何报错。
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  check((manifest.files ?? []).includes("presets"), "files 白名单包含 presets(否则预设不会被装进去)");
  check(manifest.dsh?.bundle?.patch !== undefined, "清单声明了 dsh.bundle.patch(否则补丁不会进组合)");
  // 纯模式插件不该有客户端半侧 —— 有的话说明旧的 UI 代码又回来了
  check(manifest.dsh?.client === undefined, "清单没有 dsh.client(纯模式插件不注册 UI)");

  console.log(
    failures.length > 0
      ? `\nFAIL (${failures.length}): 已装副本与源不一致,重装:\n  dsh plugin --profile desktop remove dsh-fpga-workbench\n  dsh plugin --profile desktop add file:${ROOT}`
      : "\nPASS: 已装副本与源逐字节一致,预设与补丁齐全"
  );
  if (failures.length > 0) process.exitCode = 1;
}
