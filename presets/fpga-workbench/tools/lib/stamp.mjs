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
import { dirname, extname, join } from "node:path";

/** 唯一会被替换的两个占位符。其余 `<...>` 原样保留 —— 内容不归这个脚本管。 */
export const NAME_TOKENS = ["ModuleName", "module_snake"];

/** 模板里出现这些名字时,只提示"编辑时记得改",不替。 */
const KNOWN_TOKENS = [...NAME_TOKENS, "DATE", "Author", "Version", "COMPARISON_OUTPUT"];

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
 * @param kind - `rtl` / `tb` / `xdc`。
 * @param name - 模块名。
 * @param template - 模板路径(扩展名跟着它走,用户模板是 `.vhd` 就出 `.vhd`)。
 * @returns 相对路径:`rtl/<模块名>.<ext>` / `verif/tb_<snake>.<ext>` / `synth/<模块名>.<ext>`。
 */
export function defaultDestination(kind, name, template) {
  const ext = extname(template);
  if (kind === "rtl") return join("rtl", `${name}${ext}`);
  if (kind === "tb") return join("verif", `tb_${snakeCase(name)}${ext}`);
  if (kind === "xdc") return join("synth", `${name}${ext}`);
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
 * `module-rtl-new.mjs`(RTL)、`module-verif-new.mjs`(测试平台)。这样命令一看就知道属于哪个环节,
 * 也不需要调用方去记 `--kind`。
 * @param options - `{ root, name, template, kind, out, force, dryRun }`。
 * @returns 退出码:0 成功 / 1 目标已存在且未加 force / 2 参数或环境不对。
 */
export function stampFile(options) {
  const { root, name, template, kind } = options;
  if (root === undefined || name === undefined || template === undefined) {
    console.error("用法:<模块根> <模块名> --template <模板路径> [--out <相对路径>] [--force] [--dry-run]");
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
  const target = join(root, relative);
  if (existsSync(target) && options.force !== true) {
    console.error(`目标已存在,不覆盖:${target}(要覆盖加 --force)`);
    return 1;
  }

  const { text, replaced, remaining } = renderTemplate(readFileSync(template, "utf8"), name);
  if (options.dryRun !== true) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  console.log(`${options.dryRun === true ? "[dry-run] 将复制模板到" : "已复制模板到"} ${target}`);
  console.log(`  模板:${template}`);
  console.log(
    replaced.length === 0
      ? "  模板里没有模块名占位符 → 纯复制(名字与内容按你的模板习惯改)"
      : `  已替换模块名:${replaced.map((token) => `<${token}>`).join("、")}`
  );
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
 * @returns 参数字典(不含 kind —— kind 由各入口固定)。
 */
export function parseStampArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  return {
    root: positional[0],
    name: positional[1],
    template: value("--template"),
    out: value("--out"),
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run")
  };
}
