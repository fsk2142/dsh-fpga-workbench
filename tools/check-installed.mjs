// 验证 profile 里已安装的那份与工作区源是否一致。
//
// 为什么需要它:pnpm 对 `file:` 依赖按**路径**记账,不按内容。源文件改过之后
// `dsh plugin add` 会回答 "Already up to date" 而**不重新拷贝** —— 现象是
// 「改完了没生效」,而且没有任何报错。这一条只能靠比对内容发现。
//
// 用法(装完之后跑):
//   node tools/check-installed.mjs
// 退出码 0 = 已装与源一致;非 0 = 需要重装(先 remove 再 add)。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareTree, shippedFiles } from "./shipped.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = process.env.DSH_PROFILE_DIR
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh", "profiles", "desktop");
const INSTALLED = join(PROFILE, "node_modules", "dsh-fpga-workbench");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

if (!existsSync(INSTALLED)) {
  console.log(`未安装:${INSTALLED}`);
  console.log(`安装命令:dsh plugin --profile desktop add file:${ROOT}`);
  process.exitCode = 1;
} else {
  console.log(`源:   ${ROOT}`);
  console.log(`已装: ${INSTALLED}\n`);

  // 1. 按 package.json 的 files 白名单逐字节比 —— 与 install.mjs 用同一份清单(shipped.mjs)。
  //
  // 两个脚本必须同源:各写一份清单会出现"一个说一致、另一个说不一致"。而且清单不能写死 ——
  // 写死的清单漏过 lib/toolchain.js,也会在"加了文件但忘了加清单"时静默漏检,而漏掉的
  // 恰好是新模式要用的东西。反过来,已装副本里多出来的文件是上次安装的残留,同样要报。
  const drift = compareTree(ROOT, INSTALLED);
  check(drift.length === 0, `已装副本与源逐字节一致(共 ${String(shippedFiles(ROOT).length)} 个文件)`, drift.slice(0, 12).join("\n        "));
  if (drift.length > 12) console.log(`        …另有 ${drift.length - 12} 项`);

  // 2. `files` 白名单必须覆盖运行时真正读取的四棵预设子树。
  //
  // pnpm 装 file: 依赖时按 files 打包,白名单外的东西**不会被拷进 profile**。
  // 踩过的坑:presets/ 没写进 files → 安装副本缺预设目录 → 预设列表里永远看不到
  // 「FPGA 开发模式」,而且没有任何报错。所以这里逐棵子树断言,而不是只看 "presets"。
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const files = manifest.files ?? [];
  for (const subdir of ["skills", "templates", "tools", "workspace"]) {
    check(
      files.includes(`presets/fpga-workbench/${subdir}`),
      `files 白名单包含 presets/fpga-workbench/${subdir}(否则安装副本缺这棵运行时子树)`
    );
  }
  // 两份 YAML 只是编辑源:预设由 cordis.patch.yml 内联声明提供,运行时读不到也不需要它们。
  check(
    !files.some((entry) => /\/(?:agent\.cordis|preset)\.ya?ml$/u.test(String(entry))),
    "files 白名单不含 agent.cordis.yml / preset.yml(编辑源不进发布包)"
  );
  check(files.includes("lib"), "files 白名单包含 lib(否则两半代码不会被装进去)");
  check(manifest.dsh?.bundle?.patch !== undefined, "清单声明了 dsh.bundle.patch(否则补丁不会进组合)");
  // 设置页在客户端半侧,所以这里必须有 dsh.client
  check(manifest.dsh?.client?.platform === "web", "清单声明了 dsh.client.platform = web(设置页要靠它)");
  // 预设里那一行按 "包名 + 子路径" 挂模式半侧;exports 少了它,预设会被判成 broken
  //
  // 写法在迁移到 tsdown 后变了：原来是裸字符串，现在是带类型的条件导出
  // `{ types, default }`。两种都认 —— 要守的是"指向 lib/mode.js"，不是 JSON 形状。
  {
    const modeExport = manifest.exports?.["./mode"];
    const target = typeof modeExport === "string" ? modeExport : modeExport?.default;
    check(
      target === "./lib/mode.js",
      `exports 声明了 ./mode 指向 ./lib/mode.js（预设行 dsh-fpga-workbench/mode 靠它解析；实际 ${JSON.stringify(modeExport)}）`
    );
  }
  // schema 用 peer 而不是 dependency:profile 自带这个包,peer 不会触发安装或改锁文件
  check(
    manifest.peerDependencies?.["@deepseek-ai/schemastery"] !== undefined,
    "schemastery 声明为 peerDependency(宿主注册 settings 需要它)"
  );
  check(manifest.dependencies === undefined, "没有 dependencies(不动 profile 的依赖树)");

  console.log(
    failures.length > 0
      ? `\nFAIL (${failures.length}): 已装副本与源不一致,重装:\n  dsh plugin --profile desktop remove dsh-fpga-workbench\n  dsh plugin --profile desktop add file:${ROOT}`
      : "\nPASS: 已装副本与源逐字节一致,预设与补丁齐全"
  );
  if (failures.length > 0) process.exitCode = 1;
}
