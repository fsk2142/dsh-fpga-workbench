// 一次性建立模块 / 工程的阶段文件夹骨架。
//
// 为什么要有它:目录名与个数是固定的,但手工逐个建立容易漏(漏了后面的技能会去找不存在的目录),
// 不同会话建出来的也不一致。这把"建骨架"变成一条命令:
//   · 写锚点 `.fpga-workbench.json`(kind 与 spec 路径)—— 整套流程靠它定位
//   · 建该级别全部环节目录,并给 spec/ 建 explore/(探索产物有地方放)
//   · 幂等:已存在的目录不动;已有锚点不覆盖(除非 --force)
//
// 只建目录与锚点,**不生成空的 spec.md / flow.md** —— 报告要由讨论产出,不预置占位内容。
//
// 用法:
//   node init-scaffold.mjs <根目录> [--kind module|project] [--modules A,B] [--force] [--dry-run]
// 退出码:0 成功 / 1 出错 / 2 参数不对
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 模块级的环节目录(放各环节的结论与证据:报告、日志、波形、输出数据)。
 *
 * 两个刻意的例外(与 stage-status 的口径一致):
 * · **机械检查报告跟 RTL 放一起**(`rtl/lint.md`)—— 所以这里没有 lint/ 目录
 * · **审查是按需能力,不占目录** —— 报告写 `<模块根>/review.md`,这里也没有 review/ 目录
 */
export const MODULE_STAGES = ["spec", "rtl", "sim", "comp", "synth", "timing"];

/** 工程级的环节目录(位于 `<工作区根>/project/` 下)。 */
export const PROJECT_STAGES = ["spec", "integrate", "constraints", "syssim", "impl", "timing", "board", "release"];

/**
 * 算出要建哪些目录、要写哪些锚点(不落盘)。
 * @param root - 根目录:模块根,或工程的工作区根。
 * @param options - `{ kind, modules }`。`kind` 为 `module` 或 `project`;工程级可给 `modules`
 *   (每个模块建一套模块级骨架,模块目录取根目录下的同名子目录)。
 * @returns `{ dirs, anchors }`;`anchors` 每项 `{ file, value }`。
 */
export function planScaffold(root, options = {}) {
  const kind = options.kind ?? "module";
  const dirs = [];
  const anchors = [];

  const moduleAt = (moduleRoot) => {
    for (const stage of MODULE_STAGES) dirs.push(join(moduleRoot, stage));
    dirs.push(join(moduleRoot, "spec", "explore"));
    anchors.push({
      file: join(moduleRoot, ".fpga-workbench.json"),
      value: { kind: "module", spec: "spec/spec.md" }
    });
  };

  if (kind === "project") {
    const project = join(root, "project");
    for (const stage of PROJECT_STAGES) dirs.push(join(project, stage));
    dirs.push(join(project, "spec", "explore"));
    anchors.push({
      file: join(root, ".fpga-workbench.json"),
      value: { kind: "project", spec: "project/spec/spec.md" }
    });
    for (const name of options.modules ?? []) moduleAt(join(root, name));
  } else {
    moduleAt(root);
  }

  return { dirs, anchors };
}

/**
 * 落盘(幂等)。已有目录不重建;已有锚点不覆盖,除非 `force`。
 * @param plan - {@link planScaffold} 的结果。
 * @param options - `{ dryRun, force }`。
 * @returns `{ created, skipped }`,元素是绝对路径。
 */
export function applyScaffold(plan, options = {}) {
  const dryRun = options.dryRun === true;
  const created = [];
  const skipped = [];

  for (const dir of plan.dirs) {
    if (existsSync(dir)) {
      skipped.push(dir);
      continue;
    }
    if (!dryRun) mkdirSync(dir, { recursive: true });
    created.push(dir);
  }

  for (const { file, value } of plan.anchors) {
    if (existsSync(file) && options.force !== true) {
      skipped.push(file);
      continue;
    }
    if (!dryRun) writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    created.push(file);
  }

  return { created, skipped };
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const root = argv.find((arg) => !arg.startsWith("-"));
  const kind = argv.includes("--kind") ? argv[argv.indexOf("--kind") + 1] : "module";
  const modules = argv.includes("--modules")
    ? (argv[argv.indexOf("--modules") + 1] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "")
    : [];
  return { root, kind, modules, force: argv.includes("--force"), dryRun: argv.includes("--dry-run") };
}

/** 入口。 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.root === undefined) {
    console.error("用法:node init-scaffold.mjs <根目录> [--kind module|project] [--modules A,B] [--force] [--dry-run]");
    return 2;
  }
  if (args.kind !== "module" && args.kind !== "project") {
    console.error(`--kind 只接受 module 或 project(收到 ${args.kind})`);
    return 2;
  }

  const root = args.root;
  const plan = planScaffold(root, { kind: args.kind, modules: args.modules });
  const { created, skipped } = applyScaffold(plan, { dryRun: args.dryRun, force: args.force });

  const label = args.dryRun ? "[dry-run] 将要建立" : "已建立";
  console.log(`${label} ${created.length} 项,跳过已存在的 ${skipped.length} 项(根目录:${root})`);
  for (const path of created) console.log(`  + ${relative(root, path) || "."}`);
  const anchor = plan.anchors[0]?.file;
  if (anchor !== undefined && !created.includes(anchor)) {
    console.log(`锚点已存在,未覆盖:${anchor}(要重建用 --force)`);
  }
  if (created.length === 0) console.log("骨架已完整,无需改动。");
  return 0;
}

/** 直接跑本文件时才走 CLI;被 import 时只导出上面的函数。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
