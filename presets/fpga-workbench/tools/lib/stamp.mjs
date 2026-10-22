// 按模板起一个源文件:**复制**过去,只替换模块名,其余内容原样保留。
//
// **这是内部模块,不是命令**(各环节的入口见 `module-rtl-new.mjs` / `module-verif-new.mjs`)—— 一个环节一个入口,
// 命令名一看就知道属于哪个环节,调用方也不用记 `--kind`。
//
// 为什么要有它:文件头、小节 banner、端口对齐这些模板里已经写好了,让模型逐字抄一遍既费 token
// 又容易抄歪(对齐差一列、少一个小节块)。复制是原子的,抄不错。
//
// **只动模块名,不动内容**(用户定的口径):模板千差万别,只保证"换名字"这一件事,别的都不替 ——
//   · `<ModuleName>` → 模块名;`<module_snake>` → 下划线小写形式(如 `UartRx` → `uart_rx`)
//   · 日期、作者、版本、比较输出路径等**一律不替**:模板里怎么写的就怎么留着,该改的地方由后续编辑改
//   · 模板里没有这些占位符(用户自己的模板多半如此)→ 就是一次纯复制
//
// 故意不做的事:不猜模板、不改模板内容、不覆盖已有文件(除非 --force)。
// **`--force` 覆盖是可恢复的**:旧内容先复制成同目录的 `<目标>.bak-<时间戳>`(路径会打印出来),
// 新内容先写临时文件、读回来核验过才改名替换 —— 见 {@link writeFileRecoverable}。
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";

/** 取一个错误的可读文字(非 Error 的抛出物也要能报出来)。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `relative` 的结果是不是"根之外"。
 *
 * 不用 `startsWith("../")` 那一类写法:名字以 `..` 开头(`..foo`)的目录是**根里面**的合法路径,
 * 老写法会把它误判成逃逸。这里只认三种:正好是 `..`、以 `..<分隔符>` 开头、解析到了别的盘。
 * @param relative - {@link relativePath} 的结果。
 * @returns 指向根之外时 true。
 */
function outsideOf(relative) {
  return relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative);
}

/**
 * 取一个路径的**真实**路径(不递归、不枚举):路径不存在就下探到**最近的已存在祖先**,
 * 只对那个祖先做**一次** `realpathSync`,剩下的段按字面接回去。
 * @param path - 任意路径(可以还不存在)。
 * @returns 真实路径。
 */
function realPathOf(path) {
  let probe = path;
  const tail = [];
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) return resolve(path);
    tail.unshift(basename(probe));
    probe = up;
  }
  const real = realpathSync(probe);
  return tail.length === 0 ? real : join(real, ...tail);
}

/**
 * 词法判断之外的第二道:**看穿 junction / 符号链接**的真实落点。
 *
 * 为什么必须有:纯字符串判断只看"路径长什么样"。Windows 上一个 junction(或符号链接)能让
 * `mkdirSync(..., {recursive:true})` 与写文件的**真实落点**跑到根目录**外面**去,而词法上
 * 一切正常(实测形状:`<根>\sub` 指向别处,`--out sub/x.sv` 与模块子目录都会照写不误)。
 *
 * 只做**两次** `realpathSync` —— 一次**目标根**、一次目标**最近的已存在父路径** ——
 * 不做全量 realpath、不递归 lstat(O(1))。目的是"能识破 junction 逃逸",**不是**穷举 TOCTOU:
 * 检查与写入之间仍可能有竞态,这里不假装能防住。
 * @param root - 真实根目录的词法路径(可以还不存在)。
 * @param target - 要写入 / 建目录的目标路径(词法上已在根里,由调用方先挡一层)。
 * @returns 逃出根时给 `{ realRoot, landing }`(`landing` 是真实落点,打印给用户看);没逃出给 `undefined`。
 */
/**
 * 证据文件是否安全落在 root 内(F5-11 预备 / F6-01 / F7-04 共用):
 * 相对路径、realpath 不越根、最终是普通文件(目录/junction 逃逸都不算)。
 * @param root - 根目录。
 * @param rel - 相对 root 的路径。
 */
/**
 * 证据路径的**形式**是否合法（越界/绝对路径/空值都挡在这里）。
 *
 * 抽成公用函数,是因为 `evidencePathInside` 与 `evidenceFileInside` 原先各写一遍
 * 一模一样的判断 —— 而改一处忘另一处是这类代码最典型的漂移。
 *
 * **纯空白要挡**(2026-10-22 边界实测发现):`"   "` 非空,于是原先的 `path === ""`
 * 放它过去,`join(root, "   ")` 拼出一个不存在的路径,再被 `catch` 当成"尚不存在"
 * 放行 —— 结果是"证据"一栏只写几个空格也算合法引用。
 * 判断用 `trim()`,不是 `=== ""`。
 * @param rel - 报告里写的相对路径。
 * @returns `{ ok, path }`;`ok` 为 false 时 `path` 无意义。
 */
function evidencePathForm(rel) {
  const path = String(rel ?? "").replace(/^\.\//u, "");
  const ok =
    path.trim() !== "" &&
    !path.split(/[\\/]+/u).includes("..") &&
    !/^[A-Za-z]:/u.test(path) &&
    !path.startsWith("\\\\");
  return { ok, path };
}

/**
 * 证据**路径**是否安全(E8-01):不存在时只做形式与父目录检查;
 * 存在时必须是普通文件(非 symlink)且 realpath 仍在 root 内。
 */
export function evidencePathInside(root, rel) {
  const { ok, path } = evidencePathForm(rel);
  if (!ok) return false;
  const target = join(root, path);
  if (realEscape(root, target) !== undefined) return false;
  try {
    const info = lstatSync(target);
    // **目录引用**:报告里写「`verif/`」这种"这个环节的目录在哪"是合法的 —— 在根内就够了,
    // 而且我们不会去读它(不读就谈不上"最终 symlink"那种风险)。以前这里一律要求 isFile(),
    // 于是 eth_crc32 报告里的 `verif/` / `rtl/` / `synth/` 被判成"越出模块根"(实测误报)。
    if (info.isDirectory()) return true;
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const realRoot = realpathSync(root);
    const real = realpathSync(target);
    const relOut = relativePath(realRoot, real);
    return relOut === "" || (!relOut.startsWith(`..${sep}`) && relOut !== ".." && !isAbsolute(relOut));
  } catch {
    return true; // 尚不存在:引用合法性由"缺失"判据管
  }
}

export function evidenceFileInside(root, rel) {
  const { ok, path } = evidencePathForm(rel);
  if (!ok) return false;
  const target = join(root, path);
  if (realEscape(root, target) !== undefined) return false;
  try {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const realRoot = realpathSync(root);
    const real = realpathSync(target);
    const relOut = relativePath(realRoot, real);
    return relOut === "" || (!relOut.startsWith(`..${sep}`) && relOut !== ".." && !isAbsolute(relOut));
  } catch {
    return false;
  }
}

export function realEscape(root, target) {
  const realRoot = realPathOf(root);
  const realParent = realPathOf(dirname(target));
  if (!outsideOf(relativePath(realRoot, realParent))) return undefined;
  return { realRoot, landing: join(realParent, basename(target)) };
}

/**
 * 失败路径上留下的临时/半成品文件 —— **留在原处,不删**。
 *
 * 用户定案(2026-09):本插件的脚本**绝不永久删除**任何文件。这里不 shell、也不加原生依赖,
 * 而 Windows 上把文件送进回收站需要其中之一,所以失败时我们不改权限、也不删,只把路径报出来
 * (写进给使用者看的错误信息),由他自己处置。留着的最坏后果是一个几十字节的临时文件,
 * 比"悄悄删掉、事后无法追查"轻得多。
 * @param file - 留在原处的文件路径。
 * @returns 一句可拼进错误信息的说明。
 */
function leftoverNote(file) {
  return `留下的文件未删除,请自行处置:${file}`;
}

/**
 * 覆盖一个已有文件时**先留可恢复快照、再原子替换**:写临时文件 → 读回来逐字节核验 → 改名替换。
 *
 * 为什么不是 `writeFileSync(target, text)`:`writeFileSync` 是**先截断再写**,写到一半失败
 * (磁盘满、权限、进程被杀)就把用户原来的文件毁成半截,旧内容一点不剩 —— `--force` 于是成了
 * "丢改动"的开关。这里保证三件事:
 *   · 替换前把旧内容原样复制成同目录的 `<目标>.bak-<时间戳>`(那个 `-1`/`-2` 后缀只用来避开
 *     同一个时间戳的第二次覆盖 —— 绝不覆盖已有的快照)
 *   · 新内容先落到临时文件,并**读回来逐字节核验**;核验不过就报错,目标一个字节都不动
 *   · 核验通过才 `rename` 到目标(同目录改名;不会出现"半截文件")
 * 快照与替换失败都保留原文件,把原因(含快照路径)抛给调用方去报错退出。
 * **失败路径不再删除临时/半成品文件**(用户定案:绝不永久删除),路径会写进错误信息,由使用者处置。
 *
 * @param target - 目标文件。已存在就留快照;不存在则是一次普通落盘。
 * @param text - 要写入的正文(UTF-8)。
 * @returns 快照路径;目标原本不存在时返回 `undefined`(没有旧内容可留)。
 * @throws 快照或替换失败时抛出 —— 原文件与已存在的快照都保留,失败原因里带路径。
 */
export function writeFileRecoverable(target, text) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, text);
    if (!readFileSync(temporary).equals(Buffer.from(text, "utf8"))) {
      throw new Error("写进去的内容与要写的对不上");
    }
  } catch (error) {
    throw new Error(`写临时文件失败,目标未动:${target} —— ${errorText(error)}(${leftoverNote(temporary)})`);
  }

  let snapshot;
  if (existsSync(target)) {
    const stampText = new Date().toISOString().replace(/[:.]/gu, "-");
    snapshot = `${target}.bak-${stampText}`;
    for (let n = 1; existsSync(snapshot); n += 1) snapshot = `${target}.bak-${stampText}-${n}`;
    try {
      copyFileSync(target, snapshot);
      if (!readFileSync(snapshot).equals(readFileSync(target))) throw new Error("复制出来的内容与原文对不上");
    } catch (error) {
      // 半成品快照与临时文件都**不留白**:路径报出来,别让人以为"备份没做成、东西也没了"
      throw new Error(
        `快照失败,原文件未动:${target} —— ${errorText(error)}(${leftoverNote(snapshot)};${leftoverNote(temporary)})`
      );
    }
  }

  // 目标的权限跟过去:改名会带上临时文件自己的权限,不改的话覆盖会把目标的权限换掉
  if (snapshot !== undefined) {
    try {
      chmodSync(temporary, statSync(target).mode);
    } catch {
      // 权限带不过去不算失败:内容才是判据
    }
  }
  try {
    renameSync(temporary, target);
  } catch (error) {
    throw new Error(
      `替换失败,原文件保留${snapshot === undefined ? "" : `(快照:${snapshot})`}:${target} —— ${errorText(error)}(${leftoverNote(temporary)})`
    );
  }
  return snapshot;
}

/** 唯一会被替换的两个占位符。其余 `<...>` 原样保留 —— 内容不归这个脚本管。 */
export const NAME_TOKENS = ["ModuleName", "module_snake"];

/** 模板里出现这些名字时,只提示"编辑时记得改",不替。 */
const KNOWN_TOKENS = [...NAME_TOKENS, "DATE", "Author", "Version", "COMPARISON_OUTPUT"];

/** 综合脚本里那两行赋值(`synth-script` 专用的填写目标)。 */
const SYNTH_FIELDS = {
  part: { line: /^set\s+PART\s+"[^"]*"/mu, label: "器件型号" },
  top: { line: /^set\s+TOP\s+"[^"]*"/mu, label: "顶层模块名" }
};

/**
 * CamelCase / 混合写法 → snake_case(TB 文件名与模块名用这个)。
 * @param name - 模块名。
 * @returns 小写下划线形式。
 */
export function snakeCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

/**
 * 按 kind 推出默认的落盘位置(相对模块根)。
 * @param kind - `rtl` / `tb` / `xdc` / `sim-compile` / `sim-run` / `synth-script` / `comp`。
 * @param name - 模块名(脚本类不用它:文件名固定、正文原样复制)。
 * @param template - 模板路径(语言模板的扩展名跟着它走；脚本类文件名固定)。
 * @returns 相对路径:`rtl/<模块名>.<ext>` / `verif/tb_<snake>.<ext>` / `synth/<模块名>.<ext>` / `verif/run.do`(编译与运行同一份,按模式调用) / `synth/run_synth.tcl` / `verif/comp.py`。
 */
export function defaultDestination(kind, name, template) {
  const ext = extname(template);
  if (kind === "rtl") return join("rtl", `${name}${ext}`);
  if (kind === "tb") return join("verif", `tb_${snakeCase(name)}${ext}`);
  if (kind === "xdc") return join("synth", `${name}${ext}`);
  // 模块内使用、外部不引用的脚本 → 落点文件名跟模板走(用户定案,避免再冒出旧 run.do 这种含糊名)
  // 编译与运行合一份模板(用户口径 2026-09-23):落点仍是 verif/run.do,模式由调用方在命令行给。
  if (kind === "sim-compile" || kind === "sim-run") return join("verif", "run.do");
  // 比对脚本同理:技能里给的是 `python verif/comp.py <参照> <输出>`
  if (kind === "comp") return join("verif", "comp.py");
  // 综合脚本同理:跑法里写的是 `synth/run_synth.tcl`(报告也按这个目录收)
  if (kind === "synth-script") return join("synth", "run_synth.tcl");
  return undefined;
}

/**
 * 只替换模块名占位符。
 * @param text - 模板正文。
 * @param name - 模块名。
 * @returns `{ text, replaced, remaining }`;`remaining` 是仍留在正文里的已知占位符名。
 */
export function renderTemplate(text, name) {
  const values = { ModuleName: name, module_snake: snakeCase(name) };
  let out = text;
  const replaced = [];
  for (const token of NAME_TOKENS) {
    const marker = `<${token}>`;
    if (!out.includes(marker)) continue;
    out = out.split(marker).join(values[token]);
    replaced.push(token);
  }
  const remaining = KNOWN_TOKENS.filter((token) => out.includes(`<${token}>`));
  return { text: out, replaced, remaining };
}

/**
 * 把 spec 里读到的器件型号 / 顶层模块名填进综合脚本那两行(`set PART` / `set TOP`)。
 *
 * **只在读到值时替换**:读不到就保留模板原样 —— 猜一个型号写进综合脚本,比留一行让人手填坏得多
 * (器件与时钟只写一处,是为了不重复,不是为了替用户编一个值)。
 * @param text - 已替过模块名的脚本正文。
 * @param fields - `{ part, top }`;两项都可以是 `undefined`(没读到)。
 * @returns `{ text, filled }`,`filled` 是真正填进去的字段名。
 */
export function fillSynthScript(text, fields = {}) {
  let out = text;
  const filled = [];
  for (const [key, field] of Object.entries(SYNTH_FIELDS)) {
    if (fields[key] === undefined || !field.line.test(out)) continue;
    out = out.replace(field.line, `set ${key.toUpperCase()} "${fields[key]}"`);
    filled.push(key);
  }
  return { text: out, filled };
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  return {
    root: positional[0],
    name: positional[1],
    template: value("--template"),
    kind: value("--kind") ?? "rtl",
    out: value("--out"),
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run")
  };
}

/**
 * 按模板起文件(打印用了哪份模板、替了什么、还有哪些要在编辑时改)。
 *
 * 这是内部模块,不直接当命令用 —— 各环节的入口给它固定的 kind:
 * `module-rtl-new.mjs`(RTL)、`module-verif-new.mjs`(测试平台 / `sim-compile` / `sim-run` / `comp`)、
 * `module-synth-new.mjs`(约束 / `synth-script`)。这样命令一看就知道属于哪个环节,
 * 也不需要调用方去记 `--kind`。
 * @param options - `{ root, name, template, kind, out, force, dryRun }`;`synth-script` 另收 `{ part, top }`(从 spec 读到的值)。
 * @returns 退出码:0 成功 / 1 目标已存在且未加 force / 2 参数不对,或落盘失败(原文件保留)。
 */
export function stampFile(options) {
  const { root, name, template, kind } = options;
  // 脚本模板是**原样复制**:落点固定、正文不替模块名 —— 所以不要模块名。
  const copyAsIs = ["sim-compile", "sim-run", "comp"].includes(kind);
  if (root === undefined || template === undefined || (name === undefined && !copyAsIs)) {
    console.error(
      copyAsIs
        ? `用法:<模块根> --kind ${kind} [--template <模板路径>] [--out <相对路径>] [--force] [--dry-run]`
        : "用法:<模块根> <模块名> --template <模板路径> [--out <相对路径>] [--force] [--dry-run]"
    );
    return 2;
  }
  // 模块名只收**一段**(第五轮 3.4:以前 `module-rtl-new <根> a/b` 会拼出 `rtl/a/b.sv` —— 逃逸被
  // 后面的边界检查挡住,但与"模块名是一段"这个约定不一致;判据与骨架共用同一个函数,不再两处各写)。
  const nameProblem = copyAsIs || name === undefined ? undefined : moduleNameError(name);
  if (nameProblem !== undefined) {
    console.error(`模块名不合法(${nameProblem}):${name}`);
    return 2;
  }
  if (!existsSync(template)) {
    console.error(`模板不存在:${template}`);
    console.error("模板路径看会话开头「本机 FPGA 工具链」的模板一节(用户配的那份或插件自带那份)。");
    return 2;
  }

  const relative = options.out ?? defaultDestination(kind, name, template);
  if (relative === undefined) {
    console.error("这种模板没有默认位置 —— 用 --out <相对模块根的路径> 指定放哪。");
    return 2;
  }
  // `--out` 是**相对根目录**的路径,不许拿它写到根目录外面去。
  // 实测过:不挡的话 `--out "..\x.sv"` 会真把文件落在模块根之外(绝对路径在 Windows 上会被
  // join 拼坏、退 1,属于另一种"没写出去",不必单独处理)。挡在写之前,并说清合法范围。
  // **词法只挡得住字面**:下一道用真实路径看穿 junction / 符号链接(见 {@link realEscape})。
  if (isAbsolute(relative)) {
    console.error(`--out 要写相对路径(相对根目录),收到绝对路径:${relative}`);
    return 2;
  }
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, relative);
  const inside = relativePath(rootResolved, target);
  if (inside === "" || outsideOf(inside)) {
    console.error(`--out 指向根目录之外,已拒绝:${relative}`);
    console.error(`合法范围只能是根目录(及其子目录)里面:${rootResolved}`);
    return 2;
  }
  const escape = realEscape(rootResolved, target);
  if (escape !== undefined) {
    console.error(`--out 经 junction / 符号链接的真实落点在根目录之外,已拒绝:${relative}`);
    console.error(`  词法上看着在根里:${target}`);
    console.error(`  真实落点:${escape.landing}(根目录真实路径:${escape.realRoot})`);
    return 2;
  }
  const targetExists = existsSync(target);
  if (targetExists && options.force !== true) {
    console.error(`目标已存在,不覆盖:${target}(要覆盖加 --force;覆盖前会先留一份 <目标>.bak-<时间戳> 快照)`);
    return 1;
  }

  const source = readFileSync(template, "utf8");
  // 脚本模板一个字符都不改,所以只提示还留着的占位符
  let text;
  let replaced = [];
  let remaining;
  if (copyAsIs) {
    text = source;
    remaining = KNOWN_TOKENS.filter((token) => source.includes(`<${token}>`));
  } else {
    ({ text, replaced, remaining } = renderTemplate(source, name));
  }
  // `synth-script` 额外把 spec 里读到的器件型号 / 顶层模块名填进那两行(读到才填)
  let filled = [];
  if (kind === "synth-script") {
    ({ text, filled } = fillSynthScript(text, options));
  }
  let snapshot;
  if (options.dryRun !== true) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      snapshot = writeFileRecoverable(target, text);
    } catch (error) {
      console.error(`写文件失败,原文件没动:${target}`);
      console.error(`  ${errorText(error)}`);
      return 2;
    }
  }

  console.log(`${options.dryRun === true ? "[dry-run] 将复制模板到" : "已复制模板到"} ${target}`);
  console.log(`  模板:${template}`);
  if (snapshot !== undefined) {
    // 打印出来才叫"可恢复":不打印的话没人知道旧内容在哪
    console.log(`  覆盖前已留快照(要恢复就把它的内容复制回目标):${snapshot}`);
  } else if (options.dryRun === true && targetExists) {
    console.log("  目标已存在:正式跑会先留一份 <目标>.bak-<时间戳> 快照,再覆盖");
  }
  console.log(
    copyAsIs
      ? `  原样复制:${kind} 的文件名与正文都固定,不替模块名`
      : replaced.length === 0
        ? "  模板里没有模块名占位符 → 纯复制(名字与内容按你的模板习惯改)"
        : `  已替换模块名:${replaced.map((token) => `<${token}>`).join("、")}`
  );
  if (kind === "synth-script") {
    if (filled.length > 0) {
      console.log(`  已从 spec/spec.md 填入:${filled.map((key) => `${SYNTH_FIELDS[key].label} ${options[key]}`).join("、")}`);
    }
    for (const [key, field] of Object.entries(SYNTH_FIELDS)) {
      if (filled.includes(key)) continue;
      console.log(
        options[key] === undefined
          ? `  没读到${field.label}(spec/spec.md),请手填 —— 脚本里那行保持模板原样`
          : `  脚本里没有 \`set ${key.toUpperCase()}\` 那一行,${field.label}没填进去 —— 请手填`
      );
    }
  }
  if (remaining.length > 0) {
    // 只是提示:这些内容归模板自己的规矩管,该改的地方由后续编辑改
    console.log(`  编辑时记得处理:${remaining.map((token) => `<${token}>`).join("、")}`);
  }
  const todos = (text.match(/TODO/gu) ?? []).length;
  if (todos > 0) console.log(`  待填:${todos} 处 \`TODO\``);
  return 0;
}

/**
 * 解析入口脚本的参数(各环节入口共用)。
 * @param argv - 去掉 node 与脚本路径后的参数。
 * @returns 参数字典(`kind` 只在真传了 `--kind` 时有值 —— 默认值由各入口按自己的环节给)。
 */
export function parseStampArgs(argv) {
  // 位置参数只取**第一个选项之前**的那些(与 setup-scaffold 同一条规矩):否则选项的值会被当成
  // 模块根/模块名 —— 实测脚本类 kind 漏给根目录时,kind 的值会被当成根,
  // 于是在当前目录下悄悄写到别处。这里只认选项前的显式位置参数。
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    positional.push(arg);
  }
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  return {
    root: positional[0],
    name: positional[1],
    template: value("--template"),
    kind: value("--kind"),
    out: value("--out"),
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run")
  };
}

/**
 * Windows 保留设备名:**带不带扩展名都算**(2026-09-25 实机)。
 *
 * 为什么必须挡在起文件之前:这类名字**建得出来、也读得到** —— PowerShell 能读,ModelSim 能编译
 * (`-- Compiling module con`),Vivado 也能 `read_verilog` 成功 —— 但 **Git 索引不了**:
 * `git add con.sv` → `error: open("con.sv"): No such file or directory` + `unable to index file`,
 * 退出码 128,而 `git status` 只把它列成 `??`。也就是说这类模块的源码**永远进不了版本库**,
 * 而所有工具链都"看起来正常" —— 这是最坏的一类错:没人会发现文件丢了。
 * (`con`/`prn`/`aux`/`nul`/`com1..9`/`lpt1..9` 由 Win32 保留;`com10`/`lpt10`/`console` 不是。)
 */
const WINDOWS_RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/**
 * 模块名必须是**单个目录段** —— 它会在根目录下当同名子目录用(`join(root, name)`)。
 *
 * 为什么必须挡:实测过 `--modules "..\..\evil"`,骨架真建到了根目录**之外**,退出码还是 0;
 * 绝对路径会被 `join` 拼成 `<根>\C:\...` 这种废路径,抛异常崩掉。挡在拼路径之前,并说清合法范围。
 * 根目录本身是用户显式指定的落点,不在此列 —— 这里只管拿模块名拼出来的子路径。
 *
 * **这里只挡字面**(名字本身长什么样)。名字合法、但 `<根>/<名字>` 已经是一个指向根外的
 * junction / 符号链接时,挡它的是落盘前的真实路径预检({@link applyScaffold} → `preflight`)。
 *
 * @param name - `--modules` 里的一个名字(已 trim、空串已被滤掉)。
 * @returns 不合法时返回给用户看的原因;合法返回 undefined。
 */
export function moduleNameError(name) {
  if (isAbsolute(name)) return "这是绝对路径";
  if (name.includes("/") || name.includes("\\")) return "带了路径分隔符";
  if (name === "." || name === "..") return "`.` / `..` 指向根目录本身或它的上级";
  if (name.includes(":")) return "带了盘符或冒号";
  if (WINDOWS_RESERVED_DEVICE.test(name)) return "Windows 保留设备名，无法可靠进入 Git";
  // 名字会被替换进生成的 RTL / Tcl 文本:非 ASCII 或带连字符的名字既不是合法 HDL 标识符,
  // 也会因为 Tcl 按系统编码读脚本而在内存里变成乱码(与 doc/spec.md 的器件正则同一类问题)。
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(name)) {
    return "不是合法的 HDL 标识符(只能用 A-Z a-z 0-9 _ $,首字符不能是数字)";
  }
  return undefined;
}
