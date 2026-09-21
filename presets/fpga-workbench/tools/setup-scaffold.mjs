// 规格环节:一次性建立模块 / 工程的骨架(阶段文件夹 + 锚点)。
//
// 为什么要有它:目录名与个数是固定的,但手工逐个建立容易漏(漏了后面的技能会去找不存在的目录),
// 不同会话建出来的也不一致。这把"建骨架"变成一条命令:
//   · 写锚点 `.fpga-workbench.json`(kind 与 spec 路径)—— 整套流程靠它定位
//   · 建该级别全部环节目录,并给 spec/ 建 explore/(探索产物有地方放)
//   · 幂等:已存在的目录不动;已有锚点不覆盖(除非 --force,且锚点类型与本次一致)
//   · `--force` 的覆盖**可恢复**:旧内容先留一份同目录 `<文件>.bak-<时间戳>` 快照(路径会打印
//     出来),新内容写临时文件核验过才替换 —— 理由见 `lib/stamp.mjs` 的 {@link writeFileRecoverable}
//
// 只建目录与锚点,**不生成空的 spec.md / flow.md** —— 报告要由讨论产出,不预置占位内容。
//
// 用法:
//   node setup-scaffold.mjs <根目录> [--kind module|project] [--modules A,B] [--force] [--dry-run]
// 退出码:0 成功 / 1 出错(含落盘失败:此时原有文件一个都没动)/ 2 参数不对
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeFileRecoverable } from "./lib/stamp.mjs";

/**
 * 本模式的工作区指令文件名。
 *
 * 为什么是这个名字:宿主的 `dsh-agent-instructions` 按候选名发现指令文件并注入,本模式把
 * `AGENTS.fpga.md` 排在 `AGENTS.md` 之前(见 `agent.cordis.yml`)。所以项目里可以放一份
 * **本模式专用**的工作区规则,不必挤进用户的 `AGENTS.md`。
 */
export const INSTRUCTION_FILE = "AGENTS.fpga.md";

/**
 * 规则正文的唯一来源:包根 README 里标记的那一段。
 *
 * 为什么不另存一份模板文件:那段规则会随用户口径变,多一份就要跟着改、迟早对不上。
 * 放 README 里既能直接在仓库里读到,又能被这条命令抽出来落盘 —— **一处真相**。
 * 相对的路径从本文件算(`presets/fpga-workbench/tools/` 往上三层 = 包根),不依赖工作目录。
 */
const RULES_SOURCE = fileURLToPath(new URL("../../../README.md", import.meta.url));
const RULES_START = "<!-- fpga-mode-rules:start -->";
const RULES_END = "<!-- fpga-mode-rules:end -->";

/**
 * 从 README 抽出模式规则区块。
 * @returns 正文(不含标记行),末尾带一个换行。
 * @throws 读不到文件或找不到标记时抛出 —— 宁可让建骨架失败,也不要落一份空规则。
 */
export function readModeRules() {
  const text = readFileSync(RULES_SOURCE, "utf8");
  const from = text.indexOf(RULES_START);
  const to = text.indexOf(RULES_END);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`README 里找不到模式规则区块(${RULES_START} … ${RULES_END}):${RULES_SOURCE}`);
  }
  return `${text.slice(from + RULES_START.length, to).trim()}\n`;
}

/**
 * 模块级的环节目录(放各环节的结论与证据:报告、日志、波形、输出数据)。
 *
 * 四个环节:**规格(讨论)→ RTL(编写)→ 验证(跑出数据 + 独立比对)→ 综合(门禁 + 综合后时序)**。
 * 模块级只到综合,布局布线与板级签核属工程级。
 *
 * 仿真与比对合成一个环节(用户口径:测试平台只负责把数据跑出来,判"对不对"要拿独立参照比 ——
 * 两件事本来是一件事,劈成两半会让人以为"仿真跑绿了"就等于"对了")。所以这里只有 verif/,
 * 测试平台、参考模型、比对脚本、日志与输出数据都放它下面。
 *
 * 两个刻意的例外:
 * · **机械检查报告跟 RTL 放一起**(`rtl/lint.md`)—— 所以这里没有 lint/ 目录
 * · **审查是按需能力,不占目录** —— 报告写 `<模块根>/review.md`,这里也没有 review/ 目录
 */
export const MODULE_STAGES = ["spec", "rtl", "verif", "synth"];

/** 工程级的环节目录(位于 `<工作区根>/project/` 下)。 */
export const PROJECT_STAGES = ["spec", "integrate", "constraints", "syssim", "impl", "timing", "board", "release"];

/**
 * 算出要建哪些目录、要写哪些锚点(不落盘)。
 * @param root - 根目录:模块根,或工程的工作区根。
 * @param options - `{ kind, modules }`。`kind` 为 `module` 或 `project`;工程级可给 `modules`
 *   (每个模块建一套模块级骨架,模块目录取根目录下的同名子目录)。
 * @returns `{ dirs, anchors, instruction }`;`anchors` 每项 `{ file, value }`;
 *   `instruction` 是工作区指令文件的绝对路径(两级都落一份,模块根或工程根)。
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

  return { dirs, anchors, instruction: join(root, INSTRUCTION_FILE) };
}

/**
 * 落盘(幂等)。已有目录不重建;已有锚点不覆盖,除非 `force`。
 *
 * 覆盖走 {@link writeFileRecoverable}:旧内容先留同目录 `.bak-<时间戳>` 快照,新内容核验过才替换。
 * 快照或替换失败**抛错**(原文件不动),由入口报错退出 —— 这里不吞异常,免得留下半吊子骨架。
 * @param plan - {@link planScaffold} 的结果。
 * @param options - `{ dryRun, force }`。
 * @returns `{ created, skipped, backups }`,元素是绝对路径;`backups` 是本次留下的快照。
 */
export function applyScaffold(plan, options = {}) {
  const dryRun = options.dryRun === true;
  const created = [];
  const skipped = [];
  const backups = [];

  for (const dir of plan.dirs) {
    if (existsSync(dir)) {
      skipped.push(dir);
      continue;
    }
    if (!dryRun) mkdirSync(dir, { recursive: true });
    created.push(dir);
  }

  // 覆盖前的快照单独记一份:它不参与"建了什么"的计数,只用来告诉用户旧内容在哪
  const write = (file, text) => {
    if (!dryRun) {
      const snapshot = writeFileRecoverable(file, text);
      if (snapshot !== undefined) backups.push(snapshot);
    }
    created.push(file);
  };

  for (const { file, value } of plan.anchors) {
    if (existsSync(file) && options.force !== true) {
      skipped.push(file);
      continue;
    }
    write(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  // 工作区指令:两级各落一份(模块根 / 工程根),同样"已存在就跳过" —— 用户按项目改过的那份
  // 不能被我们覆盖掉。`--force` 才重写。
  if (plan.instruction !== undefined) {
    if (existsSync(plan.instruction) && options.force !== true) {
      skipped.push(plan.instruction);
    } else {
      write(plan.instruction, readModeRules());
    }
  }

  return { created, skipped, backups };
}

/**
 * 模块名必须是**单个目录段** —— 它会在根目录下当同名子目录用(`join(root, name)`)。
 *
 * 为什么必须挡:实测过 `--modules "..\..\evil"`,骨架真建到了根目录**之外**,退出码还是 0;
 * 绝对路径会被 `join` 拼成 `<根>\C:\...` 这种废路径,抛异常崩掉。挡在拼路径之前,并说清合法范围。
 * 根目录本身是用户显式指定的落点,不在此列 —— 这里只管拿模块名拼出来的子路径。
 *
 * @param name - `--modules` 里的一个名字(已 trim、空串已被滤掉)。
 * @returns 不合法时返回给用户看的原因;合法返回 undefined。
 */
export function moduleNameError(name) {
  if (isAbsolute(name)) return "这是绝对路径";
  if (name.includes("/") || name.includes("\\")) return "带了路径分隔符";
  if (name === "." || name === "..") return "`.` / `..` 指向根目录本身或它的上级";
  if (name.includes(":")) return "带了盘符或冒号";
  return undefined;
}

/** 会吃掉后一个参数的选项 —— 它们的值不是位置参数。 */
const VALUE_FLAGS = ["--kind", "--modules"];

/**
 * 解析命令行参数。位置参数**只取第一个选项之前**的那些(与 `lib/stamp.mjs` 的 `parseStampArgs`
 * 同一条规矩),其余一律算用法错误。
 *
 * 为什么不能"随便挑一个不像选项的当根目录":实测 `--kind project <根>` 会把选项的值(`project`)
 * 当成根目录,于是在**当前目录**下建出一整套 `./project/` 还退 0 —— 用户以为建在了自己给的根上。
 * 落点只能来自明确写在最前面的那个参数:少给、写反都报错,绝不猜、也绝不落到别处。
 *
 * @param argv - 去掉 node 与脚本路径后的参数。
 * @returns 参数字典;写法不对时 `error` 是给用户看的原因(由调用方按用法错误退 2)。
 */
function parseArgs(argv) {
  const positional = [];
  const stray = [];
  let seenOption = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("-")) {
      (seenOption ? stray : positional).push(arg);
      continue;
    }
    seenOption = true;
    if (VALUE_FLAGS.includes(arg)) index += 1;
  }
  const error = positional.length > 1
    ? `根目录只能给一个(收到 ${positional.length} 个:${positional.map((arg) => JSON.stringify(arg)).join("、")})`
    : stray.length > 0
      ? `位置参数要写在选项前面 —— 选项后面这些得是选项:${stray.map((arg) => JSON.stringify(arg)).join("、")}`
      : undefined;
  const root = positional[0];
  const kind = argv.includes("--kind") ? argv[argv.indexOf("--kind") + 1] : "module";
  const modules = argv.includes("--modules")
    ? (argv[argv.indexOf("--modules") + 1] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "")
    : [];
  return { root, error, kind, modules, force: argv.includes("--force"), dryRun: argv.includes("--dry-run") };
}

/**
 * 读一个已有锚点的 `kind`。
 * @param file - 锚点文件路径。
 * @returns `{ kind }` 或 `{ error }`;文件在但解析不了时给 error —— 由调用方决定怎么办
 *   (这里的策略是**绝不覆盖**读不懂的文件)。
 */
function readAnchorKind(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { kind: typeof parsed?.kind === "string" ? parsed.kind : "(没有 kind 字段)" };
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
}

/** 入口。 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error !== undefined || args.root === undefined) {
    if (args.error !== undefined) console.error(args.error);
    console.error("用法:node setup-scaffold.mjs <根目录> [--kind module|project] [--modules A,B] [--force] [--dry-run]");
    console.error("根目录写在最前面;写在选项后面的话,选项的值会被当成根目录(建到别处去)。");
    return 2;
  }
  if (args.kind !== "module" && args.kind !== "project") {
    console.error(`--kind 只接受 module 或 project(收到 ${args.kind})`);
    return 2;
  }
  for (const name of args.modules) {
    const reason = moduleNameError(name);
    if (reason === undefined) continue;
    console.error(`--modules 里的模块名不合法:${JSON.stringify(name)} —— ${reason}`);
    console.error("模块名只能是根目录下的**单个目录段**(会在 `<根>/<模块名>/` 建一套模块骨架):");
    console.error("  不能带 `/` 或 `\\`、不能是 `.` / `..`、不能带盘符或冒号、不能是绝对路径。");
    return 2;
  }

  const root = args.root;
  const plan = planScaffold(root, { kind: args.kind, modules: args.modules });

  // 一个根只能有一个锚点,而它的 `kind` 决定整套流程怎么找环节目录。
  // 拿 module 的根去建工程(或反过来)的话,脚本只会"锚点已存在,未覆盖"地把目录建一半:
  // project/ 有了、锚点还是 kind: module —— 工程级技能照样找不到工程。
  // 真事:实跑集成场景时这么踩过。所以这里明说冲突、给出迁移办法,而不是留个半吊子状态。
  // `--force` 是**同类型**的重写开关(重写锚点与工作区指令),不跨类型覆盖 —— 所以这条冲突是
  // 硬拒绝,提示文字也不再说"再加 --force 重建"(说了也到不了这里)。
  const rootAnchor = plan.anchors[0]?.file;
  if (rootAnchor !== undefined && existsSync(rootAnchor)) {
    const existing = readAnchorKind(rootAnchor);
    if (existing.error !== undefined) {
      console.error(`根目录已有锚点,但读不出它的内容:${rootAnchor}`);
      console.error(`${existing.error} —— 不覆盖用户的文件;把它移走(或修好它)再跑。--force 也覆盖不了它:能覆盖的只有读得出、且类型一致的锚点。`);
      return 1;
    }
    if (existing.kind !== args.kind) {
      console.error(`根锚点的类型与本次不一致:${rootAnchor}`);
      console.error(`  锚点写的是 kind: ${existing.kind},本次要建 kind: ${args.kind}`);
      console.error("  一个根只能属于一种:模块根放模块自己的 spec/rtl/verif/synth,工程根放 project/ 与各模块子目录。");
      console.error(`  要建工程:先把现有模块目录(含它自己的锚点)整体移进 <根>/${args.modules[0] ?? "<模块名>"}/,根上只留工程级的,再跑一次本命令 —— 不要用 --force 覆盖,那会丢掉锚点里已有的内容。`);
      console.error("  要重建:把根上的锚点移到一边(改名也算)再跑本命令 —— --force 只重写类型一致的锚点,不跨类型覆盖。");
      return 1;
    }
  }

  let applied;
  try {
    applied = applyScaffold(plan, { dryRun: args.dryRun, force: args.force });
  } catch (error) {
    // 落盘失败(快照失败 / 替换失败)时原有文件一个都没动 —— 说清这一点,别让人以为写坏了一半
    console.error("落盘失败,原有文件没有改动:");
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { created, skipped, backups } = applied;

  const label = args.dryRun ? "[dry-run] 将要建立" : "已建立";
  console.log(`${label} ${created.length} 项,跳过已存在的 ${skipped.length} 项(根目录:${root})`);
  for (const path of created) console.log(`  + ${relative(root, path) || "."}`);
  // 覆盖是可恢复的:快照留在哪必须打出来,否则等于没说
  for (const backup of backups) console.log(`  覆盖前已留快照(要恢复就把它的内容复制回目标):${backup}`);
  const anchor = plan.anchors[0]?.file;
  if (anchor !== undefined && !created.includes(anchor)) {
    console.log(`锚点已存在,未覆盖:${anchor}(要重建用 --force)`);
  }
  if (plan.instruction !== undefined && !created.includes(plan.instruction)) {
    console.log(`${INSTRUCTION_FILE} 已存在,未覆盖(按项目改过的那份不会被我们覆盖;要重写用 --force)`);
  }
  if (plan.instruction !== undefined && created.includes(plan.instruction)) {
    console.log(`${INSTRUCTION_FILE} 是本模式的工作区规则,按项目改这一份即可 —— 正文来源是包内 README 的规则区块。`);
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
