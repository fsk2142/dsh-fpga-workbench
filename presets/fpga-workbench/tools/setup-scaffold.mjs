// 规格环节:在用户指定目录中一次性建立模块 / 工程骨架(阶段文件夹 + 锚点)。
//
// 为什么要有它:目录名与个数是固定的,但手工逐个建立容易漏(漏了后面的技能会去找不存在的目录),
// 不同会话建出来的也不一致。这把"建骨架"变成一条命令:
//   · 写锚点 `.fpga-workbench.json`(kind 与 spec 路径)—— 整套流程靠它定位
//   · 建该级别全部环节目录,并给 spec/ 建 explore/(探索产物有地方放)
//   · 幂等:已存在的目录不动;已有锚点不覆盖(除非 --force,且锚点类型与本次一致)
//   · `--force` 的覆盖**可恢复**:旧内容先留一份同目录 `<文件>.bak-<时间戳>` 快照(路径会打印
//     出来),新内容写临时文件核验过才替换 —— 理由见 `lib/stamp.mjs` 的 {@link writeFileRecoverable}
//   · 落盘**前**先做**全量预检**:每个目标的**真实落点**(看穿 junction / 符号链接)必须仍在根里、
//     目标必须可写、**位置类型必须对**(环节目录的位置得是目录、锚点与规则文件的位置得是文件 ——
//     见 {@link assertStageDirsAreDirs} 与 {@link assertFileTargetsAreFiles});不过就在动手之前拒绝
//     (理由见 `lib/stamp.mjs` 的 {@link realEscape})
//
// 只建目录与锚点,**不生成空的 spec.md / flow.md** —— 报告要由讨论产出,不预置占位内容。
//
// **失败不撒谎、也不回滚**:预检之后才动手,万一还是失败(目标被占用、路径上某一节是文件…),
// 本脚本**不做删除式回滚**(用户定案:插件运行时绝不永久删除),而是把**已经发生的动作**
// (建了哪些目录 / 写了哪些文件 / 留下了哪些快照)挂到错误信息上原样列出来,由使用者自己处置。
//
// 用法:
//   node setup-scaffold.mjs <用户指定目录> [--kind module|project] [--force] [--dry-run]
// 退出码:0 成功 / 1 出错(落盘失败:已经发生的动作会原样列出来)/ 2 参数不对,或目标经
//         junction / 符号链接逃出了根目录
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { realEscape, writeFileRecoverable } from "./lib/stamp.mjs";

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

/**
 * 工程级目录。传入的路径本身就是工程根，不再自动套“工作区 / 工程名”这一层。
 * `doc/` 放工程级报告与 files.md；`src/sim/` 是专用模块简单仿真，根 `sim/` 是工程级仿真。
 */
export const PROJECT_DIRS = [
  "doc", "sch", "prj", "src", join("src", "rtl"), join("src", "sim"),
  "ip", "sim", "xdc", "bit"
];

/**
 * 算出要建哪些目录、要写哪些锚点(不落盘)。
 * @param root - 用户指定目录:模块模式下就是模块根,工程模式下就是工程根。
 * @param options - `{ kind }`。`kind` 为 `module` 或 `project`。
 * @returns `{ dirs, anchors, instruction, root }`;`anchors` 每项 `{ file, value }`;
 *   `instruction` 是工作区指令文件的绝对路径(两级都落一份,模块根或工程根);
 *   `root` 原样带回根目录 —— 落盘时的**真实路径边界**以它为基准({@link applyScaffold})。
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
    for (const rel of PROJECT_DIRS) dirs.push(join(root, rel));
    anchors.push({
      file: join(root, ".fpga-workbench.json"),
      value: { kind: "project", spec: "doc/spec.md" }
    });
  } else {
    moduleAt(root);
  }

  return { dirs, anchors, instruction: join(root, INSTRUCTION_FILE), root };
}

/** 给错误挂一个机器可读的类别(入口按它决定退出码)。 */
function coded(error, code) {
  error.code = code;
  return error;
}

/**
 * 写前**全量预检**:把这次要建 / 要写的目标一次全过一遍 —— **只读探测,不建任何东西**。
 *
 * ① **真实落点**:词法检查挡不住 junction / 符号链接(纯字符串判断只看"路径长什么样"),
 *    这里用目标**最近的已存在父路径**的真实路径再核一次(见 `lib/stamp.mjs` 的 {@link realEscape})。
 * ② **可写**:已存在的目标探它自己(只读属性在这里露出来),还没建的目标探它**最近的已存在祖先**
 *    (创建正是落在它里面)。提前失败,别建了一半才发现写不进去。
 *    ⚠ **探不到 ACL 层面的拒绝**(2026-09-21 实测:给一个目录挂 `deny (W)`,里面真的写不进去,而
 *    `accessSync(W_OK)` 照样通过 —— Windows 上 `access` 看的是**只读属性**,而目录的只读属性本身
 *    是无效的)。想真知道能不能写就得试写一次,而试写要删掉那个探针文件 —— 本模式零删除,不干。
 *    那种失败会在写的时候暴露,由下面的 {@link withActions} **如实报告**,不在这里假装能预检。
 *
 * 预检本身只读 —— 不过就抛,此时**一个字节都没动**。它挡不住的东西(TOCTOU、写入途中被别的进程
 * 占住、路径某一节是文件、上面那条 ACL 拒绝)由下面的 `withActions` 如实报告,不假装能防住。
 * @param plan - `{ dirs, anchors, instruction, root }`。
 * @throws 逃逸给 `code: "FPGA_PATH_ESCAPE"`(含真实落点),不可写给 `"FPGA_UNWRITABLE"`。
 */
function preflight(plan) {
  const targets = [...plan.dirs, ...plan.anchors.map((anchor) => anchor.file)];
  if (plan.instruction !== undefined) targets.push(plan.instruction);
  const escapes = [];
  const unwritable = [];
  for (const target of targets) {
    const escape = realEscape(plan.root, target);
    if (escape !== undefined) {
      escapes.push({ target, escape });
      continue;
    }
    let probe = target;
    while (!existsSync(probe)) {
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    try {
      accessSync(probe, constants.W_OK);
    } catch (error) {
      // 原因也带上(`EPERM` 才是"只读";别的错误说明预检本身有问题,不能吞成"不可写")
      unwritable.push({ target, probe, reason: `${error?.code ?? ""} ${error?.message ?? error}`.trim() });
    }
  }
  if (escapes.length > 0) {
    const lines = escapes.map(
      ({ target, escape }) => `  ${target}\n    真实落点:${escape.landing}(根目录真实路径:${escape.realRoot})`
    );
    throw coded(new Error(`拒绝:目标经 junction / 符号链接逃出了根目录(预检不过,一个字节都没动):\n${lines.join("\n")}`), "FPGA_PATH_ESCAPE");
  }
  if (unwritable.length > 0) {
    const lines = unwritable.map(({ target, probe, reason }) => `  ${target}(按可写性探的是:${probe};${reason})`);
    throw coded(new Error(`写前预检不通过 —— 目标只读或不可写,提前失败(一个字节都没动):\n${lines.join("\n")}`), "FPGA_UNWRITABLE");
  }
}

/**
 * 一个**已存在**的路径是不是"类型不对"(该是目录的却是个文件、该是文件的却是个目录)。
 *
 * 为什么要它:落盘那一步用 `existsSync(x)` 判"已存在" —— 它不看类型,于是**同名的另一种东西**
 * 也算"已经有了",被静默跳过;全跳过之后就打出"骨架已完整,无需改动。" —— 而那个位置根本建不出
 * 要的东西(与 F-04 同形状的谎报,`<模块根>/rtl` 是个文件时实测踩到)。所以判据必须是**类型**。
 * @param path - 目标路径。
 * @param kind - `"directory"`(该是目录)或 `"file"`(该是文件)。
 * @returns 类型不对时 true;路径不存在时 false;读不出类型(悬空链接之类)按"不对"处理。
 */
function typeMismatch(path, kind) {
  if (!existsSync(path)) return false;
  try {
    return kind === "directory" ? !statSync(path).isDirectory() : !statSync(path).isFile();
  } catch {
    return true;
  }
}

/**
 * 环节目录的位置被**同名文件**占着时,在动手之前拒绝。
 *
 * 为什么必须单独管:见 {@link typeMismatch} —— `existsSync` 判不出类型,会把"这里是个文件"
 * 当成"目录建好了"跳过,于是报出"骨架已完整"这种谎。零删除:只报告,一个字节都不动。
 * `--dry-run` 也要过这一关 —— 预演同样不许报"将要建立"/"骨架已完整"。
 * @param plan - `{ dirs, root }`。
 * @throws 冲突给 `code: "FPGA_CONFLICT"`(逐个列出占位的路径)。
 */
function assertStageDirsAreDirs(plan) {
  const blocked = plan.dirs.filter((dir) => typeMismatch(dir, "directory"));
  if (blocked.length === 0) return;
  const lines = blocked.map((dir) => `  ${dir}(这里是文件,不是目录 —— 环节目录建不出来)`);
  throw coded(
    new Error(
      `拒绝:环节目录的位置被同名文件占着(一个字节都没动):\n${lines.join("\n")}\n` +
        "把它改名或移到别处再跑 —— 本模式不删用户的文件,不会替你腾位置。"
    ),
    "FPGA_CONFLICT"
  );
}

/**
 * 锚点 / 工作区指令的位置**不是文件**时,同样在动手之前拒绝。
 *
 * 这是上面那条的姊妹口子(同一次实测里一起查出来的):`main()` 只预读**根锚点**,工程模式下各
 * 模块的锚点、以及工作区指令都由落盘那一步按"已存在"跳过 —— 位置放的是**目录**时,跳过就成了
 * 谎报的前提:全部跳过 → 打出"骨架已完整,无需改动。",而那个锚点/规则文件根本没写出来。
 *
 * **`--force` 时不拦**:那条路会真的去写,写不动时由 {@link withActions} 如实列出"已经发生的动作"
 * —— 那正是 F-04 的证据(拿"锚点位置是目录 + `--force`"当夹具),不能改成提前拒绝。
 * @param plan - `{ anchors, instruction }`。
 * @param force - 本次是否 `--force`。
 * @throws 冲突给 `code: "FPGA_CONFLICT"`。
 */
function assertFileTargetsAreFiles(plan, force) {
  if (force === true) return;
  const targets = plan.anchors.map((anchor) => anchor.file);
  if (plan.instruction !== undefined) targets.push(plan.instruction);
  const blocked = targets.filter((file) => typeMismatch(file, "file"));
  if (blocked.length === 0) return;
  const lines = blocked.map((file) => `  ${file}(这里是目录,不是文件 —— 锚点 / 规则文件写不出来)`);
  throw coded(
    new Error(
      `拒绝:锚点 / 工作区规则的位置被目录占着(一个字节都没动):\n${lines.join("\n")}\n` +
        "把它改名或移到别处再跑 —— 本模式不删用户的文件,不会替你腾位置。"
    ),
    "FPGA_CONFLICT"
  );
}

/**
 * 失败时把**已经发生的动作**挂到错误信息上 —— **如实报告,不做删除式回滚**。
 *
 * 用户定案:插件运行时绝不永久删除,所以失败时不能"把建了一半的东西删掉"来假装没发生;
 * 会让调用方以为"什么都没动"的那种说法(`原有文件没有改动`)在"先建了目录、再写锚点"的顺序下
 * 就是**谎报**。这里改成把状态原样列出来,由使用者自己处置。
 * @param error - 原错误。
 * @param state - 已经记下的动作(`{ dirs, files, skipped, backups }`)。
 * @param root - 根目录(把绝对路径缩成好读的相对路径);缺失时用绝对路径。
 * @returns 带完整说明的新错误(保留原错误的 `code`)。
 */
function withActions(error, state, root) {
  const short = (path) => (root === undefined ? path : relative(root, path) || ".");
  const snapshots = state.backups.length === 0
    ? ""
    : `\n  覆盖前留下的快照(要恢复就把它的内容复制回目标):${state.backups.join("、")}`;
  const detail = [
    "已经发生的动作(**不做删除式回滚**,下面这些留在原地,请自行处置):",
    `  新建目录 ${state.dirs.length} 个:${state.dirs.map(short).join("、") || "(无)"}`,
    `  新建 / 覆盖文件 ${state.files.length} 个:${state.files.map(short).join("、") || "(无)"}`,
    `  跳过已存在 ${state.skipped.length} 个:${state.skipped.map(short).join("、") || "(无)"}${snapshots}`
  ].join("\n");
  const wrapped = new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
  wrapped.code = error?.code;
  return wrapped;
}

/**
 * 落盘(幂等)。已有目录不重建;已有锚点不覆盖,除非 `force`。
 *
 * 覆盖走 {@link writeFileRecoverable}:旧内容先留同目录 `.bak-<时间戳>` 快照,新内容核验过才替换。
 * 动手之前先过一遍 {@link preflight}(真实路径边界 + 可写性)与 {@link assertStageDirsAreDirs}
 * (环节目录的位置必须是目录),不过就**在动手之前**拒绝。
 * 预检之后万一仍然失败,**不回滚、也不吞异常**(用户定案:绝不永久删除),而是把**已经发生的动作**
 * 一起抛出去(见 {@link withActions}),由入口原样打印。
 * @param plan - {@link planScaffold} 的结果(带 `root`)。
 * @param options - `{ dryRun, force }`。
 * @returns `{ created, skipped, backups }`,元素是绝对路径;`backups` 是本次留下的快照。
 */
export function applyScaffold(plan, options = {}) {
  const dryRun = options.dryRun === true;
  const state = { dirs: [], files: [], skipped: [], backups: [] };

  // 先过"位置对不对"这两关(dry-run 也要过):环节目录的位置必须是目录、锚点与规则文件的位置
  // 必须是文件 —— 被占着时**不写**、也不谎报"骨架已完整"
  assertStageDirsAreDirs(plan);
  assertFileTargetsAreFiles(plan, options.force);

  try {
    // dry-run 只报告不落盘,所以不预检(预检的意义是"别建到一半才发现写不进去")
    if (!dryRun) preflight(plan);

    for (const dir of plan.dirs) {
      if (existsSync(dir)) {
        state.skipped.push(dir);
        continue;
      }
      if (!dryRun) mkdirSync(dir, { recursive: true });
      state.dirs.push(dir);
    }

    // 覆盖前的快照单独记一份:它不参与"建了什么"的计数,只用来告诉用户旧内容在哪
    const write = (file, text) => {
      if (!dryRun) {
        const snapshot = writeFileRecoverable(file, text);
        if (snapshot !== undefined) state.backups.push(snapshot);
      }
      state.files.push(file);
    };

    for (const { file, value } of plan.anchors) {
      if (existsSync(file) && options.force !== true) {
        state.skipped.push(file);
        continue;
      }
      write(file, `${JSON.stringify(value, null, 2)}\n`);
    }

    // 工作区指令:两级各落一份(模块根 / 工程根),同样"已存在就跳过" —— 用户按项目改过的那份
    // 不能被我们覆盖掉。`--force` 才重写。
    if (plan.instruction !== undefined) {
      if (existsSync(plan.instruction) && options.force !== true) {
        state.skipped.push(plan.instruction);
      } else {
        write(plan.instruction, readModeRules());
      }
    }
  } catch (error) {
    throw withActions(error, state, plan.root);
  }

  return { created: [...state.dirs, ...state.files], skipped: state.skipped, backups: state.backups };
}



/** 会吃掉后一个参数的选项 —— 它们的值不是位置参数。 */
const VALUE_FLAGS = ["--kind", "--modules"];

/**
 * 解析命令行参数。位置参数**只取第一个选项之前**的那些(与 `lib/stamp.mjs` 的 `parseStampArgs`
 * 同一条规矩),其余一律算用法错误。
 *
 * 为什么不能"随便挑一个不像选项的当根目录":实测 `--kind project <根>` 会把选项的值(`project`)
 * 当成根目录,于是在**当前目录**下建出一整套工程树还退 0 —— 用户以为建在了自己给的根上。
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
  return {
    root,
    error,
    kind,
    modulesOption: argv.includes("--modules"),
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run")
  };
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
    console.error("用法:node setup-scaffold.mjs <用户指定目录> [--kind module|project] [--force] [--dry-run]");
    console.error("用户指定目录写在最前面；这个路径本身就是模块根或工程根，不会再自动套一层目录。");
    return 2;
  }
  if (args.kind !== "module" && args.kind !== "project") {
    console.error(`--kind 只接受 module 或 project(收到 ${args.kind})`);
    return 2;
  }
  if (args.modulesOption) {
    console.error("--modules 已停用：工程骨架不会自动创建模块子目录。");
    console.error("请把用户指定目录作为工程根；工程 RTL 统一平铺在 src/rtl/，专用模块简单仿真放 src/sim/。");
    return 2;
  }

  const root = args.root;
  const plan = planScaffold(root, { kind: args.kind });

  // 一个根只能有一个锚点,而它的 `kind` 决定整套流程怎么找环节目录。
  // 拿 module 的根去建工程(或反过来)的话,脚本只会"锚点已存在,未覆盖"地把目录建一半:
  // 工程目录建了一半、锚点还是 kind: module —— 工程级技能照样找不到工程。
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
      console.error("  一个根只能属于一种：模块根放 spec/rtl/verif/synth；工程根放 doc/sch/prj/src/ip/sim/xdc/bit。");
      console.error("  要建工程：另选一个工程目录再跑；这个参数就是工程根，不要在已有模块根上强行改类型。");
      console.error("  要重建:把根上的锚点移到一边(改名也算)再跑本命令 —— --force 只重写类型一致的锚点,不跨类型覆盖。");
      return 1;
    }
  }

  let applied;
  try {
    applied = applyScaffold(plan, { dryRun: args.dryRun, force: args.force });
  } catch (error) {
    // 失败**不一定是"什么都没发生"**(可能已经建了目录、写了前几个锚点),所以这里不撒"原有文件没动"
    // 的谎、也不做删除式回滚:`已经发生的动作`就在错误信息里(见 withActions),原样打出来。
    // 例外是"位置被同名文件占着"(FPGA_CONFLICT):那一条在动手之前就抛了,盘上确实原样 —— 说清即可。
    // 退出码按类别分:预检发现逃逸 = 路径边界问题(2),其余(不可写 / 位置被占 / 落盘失败)= 1。
    console.error(
      error?.code === "FPGA_CONFLICT"
        ? "预检不过(一个字节都没动,盘上还是原样):"
        : "落盘失败(没有做删除式回滚,已经发生的动作见下):"
    );
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    return error?.code === "FPGA_PATH_ESCAPE" ? 2 : 1;
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
