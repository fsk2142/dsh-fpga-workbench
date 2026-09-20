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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative as relativePath, resolve } from "node:path";

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
 * @param kind - `rtl` / `tb` / `xdc` / `run-do` / `synth-script` / `comp`。
 * @param name - 模块名(`run-do` / `comp` 不用它:那两类文件不替模块名)。
 * @param template - 模板路径(扩展名跟着它走,用户模板是 `.vhd` 就出 `.vhd`;`run-do` / `synth-script` / `comp` 文件名固定)。
 * @returns 相对路径:`rtl/<模块名>.<ext>` / `verif/tb_<snake>.<ext>` / `synth/<模块名>.<ext>` / `verif/run.do` / `synth/run_synth.tcl` / `verif/comp.py`。
 */
export function defaultDestination(kind, name, template) {
  const ext = extname(template);
  if (kind === "rtl") return join("rtl", `${name}${ext}`);
  if (kind === "tb") return join("verif", `tb_${snakeCase(name)}${ext}`);
  if (kind === "xdc") return join("synth", `${name}${ext}`);
  // run.do 的文件名是**固定**的:跑法里 `do run.do` 写死了它,换个名字就对不上;
  // 用户自己的模板也不改这个名字(所以这里不看 name,也不看模板扩展名)。
  if (kind === "run-do") return join("verif", "run.do");
  // 综合脚本同理:跑法里写的是 `synth/run_synth.tcl`(报告也按这个目录收)
  if (kind === "synth-script") return join("synth", "run_synth.tcl");
  // 比对脚本同理:技能里给的是 `python verif/comp.py <参照> <输出>`
  if (kind === "comp") return join("verif", "comp.py");
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
 * `module-rtl-new.mjs`(RTL)、`module-verif-new.mjs`(测试平台 / `run-do` / `comp`)、
 * `module-synth-new.mjs`(约束 / `synth-script`)。这样命令一看就知道属于哪个环节,
 * 也不需要调用方去记 `--kind`。
 * @param options - `{ root, name, template, kind, out, force, dryRun }`;`synth-script` 另收 `{ part, top }`(从 spec 读到的值)。
 * @returns 退出码:0 成功 / 1 目标已存在且未加 force / 2 参数或环境不对。
 */
export function stampFile(options) {
  const { root, name, template, kind } = options;
  // `run-do` / `comp` 是**原样复制**:落点固定、正文不替模块名 —— 所以不要模块名。
  const copyAsIs = kind === "run-do" || kind === "comp";
  if (root === undefined || template === undefined || (name === undefined && !copyAsIs)) {
    console.error(
      copyAsIs
        ? `用法:<模块根> --kind ${kind} [--template <模板路径>] [--out <相对路径>] [--force] [--dry-run]`
        : "用法:<模块根> <模块名> --template <模板路径> [--out <相对路径>] [--force] [--dry-run]"
    );
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
  if (isAbsolute(relative)) {
    console.error(`--out 要写相对路径(相对根目录),收到绝对路径:${relative}`);
    return 2;
  }
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, relative);
  const inside = relativePath(rootResolved, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    console.error(`--out 指向根目录之外,已拒绝:${relative}`);
    console.error(`合法范围只能是根目录(及其子目录)里面:${rootResolved}`);
    return 2;
  }
  if (existsSync(target) && options.force !== true) {
    console.error(`目标已存在,不覆盖:${target}(要覆盖加 --force)`);
    return 1;
  }

  const source = readFileSync(template, "utf8");
  // `run-do` / `comp` 一个字符都不改(模板头里的 `<ModuleName>` 留给起完按工程改),所以只提示还留着的占位符
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
  if (options.dryRun !== true) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  console.log(`${options.dryRun === true ? "[dry-run] 将复制模板到" : "已复制模板到"} ${target}`);
  console.log(`  模板:${template}`);
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
  // 位置参数只取**第一个选项之前**的那些(与 module-verif-wave 同一条规矩):否则选项的值会被当成
  // 模块根/模块名 —— 实测 `module-verif-new.mjs --kind run-do` 漏给根目录时,`run-do` 会被当成根,
  // 于是在 `./run-do/` 下起出 verif/run.do 还退 0(少给参数变成了"悄悄写到别处")。
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
