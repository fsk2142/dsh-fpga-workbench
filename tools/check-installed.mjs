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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = process.env.DSH_PROFILE_DIR
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh", "profiles", "desktop");
const INSTALLED = join(PROFILE, "node_modules", "dsh-fpga-workbench");

/** 这个包该装进去的全部内容:清单 + 补丁 + 宿主半侧 + 模式半侧 + 客户端半侧。 */
const REQUIRED = [
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/mode.js",
  "lib/client.js"
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

/** 一棵目录下的全部文件(相对路径,用 / 分隔),目录不存在时为空。 */
function walk(dir, base = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return entry.isFile() ? [relative(base, full).split("\\").join("/")] : [];
  });
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

  // 1b. 整个 presets/ 树逐文件比 —— 预设里现在还有 skills/(模式专属技能),以后还会加东西。
  //
  // 不写死文件名:写死的清单会在"加了文件但忘了加清单"时静默漏检,而漏掉的恰好是新
  // 模式要用的东西。反过来,已装副本里多出来的文件是上次安装的残留,同样要报。
  const presetFiles = walk(join(ROOT, "presets"));
  check(presetFiles.length > 0, "源里有预设文件");
  for (const rel of presetFiles) {
    const installed = join(INSTALLED, "presets", rel);
    check(
      existsSync(installed) && hash(join(ROOT, "presets", rel)) === hash(installed),
      `presets/${rel} 与源一致`
    );
  }
  for (const rel of walk(join(INSTALLED, "presets"))) {
    check(presetFiles.includes(rel), `已装副本里没有源里不存在的 presets/${rel}(旧副本残留,重装)`);
  }

  // 2. `files` 白名单必须覆盖预设目录。
  //
  // pnpm 装 file: 依赖时按 files 打包,白名单外的东西**不会被拷进 profile**。
  // 踩过的坑:presets/ 没写进 files → 安装副本缺预设目录 → 补丁里的 agent-presets
  // roots 指向空目录 → 预设列表里永远看不到「FPGA 工作台」,而且没有任何报错。
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  check((manifest.files ?? []).includes("presets"), "files 白名单包含 presets(否则预设不会被装进去)");
  check((manifest.files ?? []).includes("lib"), "files 白名单包含 lib(否则两半代码不会被装进去)");
  check(manifest.dsh?.bundle?.patch !== undefined, "清单声明了 dsh.bundle.patch(否则补丁不会进组合)");
  // 设置页在客户端半侧,所以这里必须有 dsh.client
  check(manifest.dsh?.client?.platform === "web", "清单声明了 dsh.client.platform = web(设置页要靠它)");
  // 预设里那一行按 "包名 + 子路径" 挂模式半侧;exports 少了它,预设会被判成 broken
  check(
    manifest.exports?.["./mode"] === "./lib/mode.js",
    "exports 声明了 ./mode(预设行 dsh-fpga-workbench/mode 靠它解析)"
  );
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
