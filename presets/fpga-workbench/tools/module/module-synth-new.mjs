// 综合环节:按模板起一个约束文件或综合脚本(**复制**模板,只替模块名/填 spec 里那两项)。
//
// 用法:
//   node module-synth-new.mjs <模块根> <模块名> --template <约束模板路径>
//                      [--out <相对路径>] [--force] [--dry-run]
//   node module-synth-new.mjs <模块根> <模块名> --kind synth-script
//                      [--template <综合脚本路径>] [--out <相对路径>] [--force] [--dry-run]
// 默认落到 `synth/<模块名>.xdc`。`--kind synth-script` 固定落 `synth/run_synth.tcl`(文件名不跟
// 模板扩展名走);不给 `--template` 时用分类模板库里的 `synthesis/vivado_synthesis.tcl`。
// 综合脚本里的**器件型号与顶层模块名从 spec 读出来填进去** —— 器件与时钟只写一处,别再手抄。
// **器件来源**:模块根若位于某个工程目录之下,向上找到 `kind: project` 锚点并读 `doc/spec.md`;
// 否则读模块自己的 `spec/spec.md`。不再猜“兄弟 project/”目录 —— 工程目录是用户指定的任意路径。
// 顶层模块名同理:spec 里没有就按**模块名**填(那不是猜 —— 本模式约定 `rtl/<模块名>.sv` 就是顶层)。
// 模板路径看会话开头「本机 FPGA 工具链」的模板一节。
// 写完记得:约束文件名与里面的时钟名必须与器件配置里的写法完全一致(见 fpga-module-synth)。
// 退出码:0 成功 / 1 目标已存在且未加 --force / 2 参数或环境不对(含"器件没定")
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStampArgs, stampFile } from "../lib/stamp.mjs";

/** 自带的综合脚本模板:`tools/` 与 `templates/` 同级(装进 profile 后这个相对关系不变)。 */
const BUNDLED_RUN_SYNTH = fileURLToPath(new URL("../../templates/synthesis/vivado_synthesis.tcl", import.meta.url));

// 器件型号:spec.md 没有固定模板,所以按**型号串**认,不按第几节认 —— Xilinx/AMD 的型号一律以
// `xc` 起头,后面可以是 `7a100t`(7 系列)也可以是 `ku040`/`zu7ev`/`vu9p`(UltraScale 那种两字母系列),
// 所以字母允许 1~3 个:`xc7a100tfgg484-2` / `xcku040-ffva1156-2-e` 都是这个形状。
// 与「器件 / device / part」这样的**字段行**配合使用,`xci` / `xdc` / 工具名 `xcelium` 这类词就挡在外面。
const PART_RE = /\bxc[a-z]{0,3}[0-9][0-9a-z]*(?:-[0-9a-z]+)*\b/giu;
const DEVICE_LINE_RE = /器件|芯片|device|part/iu;
/**
 * **器件字段行**:`目标器件:**xc7a…` / `器件型号:xc7a…` / `PART: xc7a…` —— 标签后面跟冒号。
 *
 * 为什么单独认它(2026-09-21 实测踩到):真实 spec 里除了正经的「目标器件」字段,**修订历史表**也会
 * 提到器件("目标器件改判为 `xc7a100tfgg484-2`(原 `xcku3p-ffva676-2-i` …)")—— 那样一行里就有两个
 * 候选,按"只认唯一候选"的旧写法会判成**说不清**,于是两个真实模块都读不出器件。字段行优先:它写的
 * 是**现在**用什么,历史里提到的旧器件不该盖过它。
 */
const DEVICE_FIELD_RE = /^\s*[-*|]?\s*\**\s*(?:目标器件|器件型号|器件|芯片|part|device)\**\s*[:：]/iu;
// 顶层模块名:那一行要说「顶层」(`顶层模块名:uart_rx`);值取冒号后面第一个标识符。
const TOP_LINE_RE = /顶层|top\s*module/iu;

/**
 * 同一个器件的不同写法折叠:短的若是长的**前缀**(大小写不敏感)→ 只留长的。
 *
 * 实测形状:`- **目标器件**:\`xc7a100tfgg484-2\`(Artix-7 XC7A100T,-2,Vivado 2025.2)。`
 * —— 行里同时出现全串与族名 `XC7A100T`,不折叠就会判成"两个候选 = 说不清"。
 * 注意:不同族的型号(`xcku3p-…` vs `xc7a100t…`)互不为前缀,**不会**被折叠掉。
 * @param tokens - 候选数组。
 * @returns 折叠后的数组(保持顺序)。
 */
function collapsePrefixes(tokens) {
  return tokens.filter((token) => !tokens.some((other) => other !== token && other.length > token.length && other.toLowerCase().startsWith(token.toLowerCase())));
}

/**
 * 从一份 spec.md 里读器件型号与顶层模块名(读不到就是 `undefined`,不猜)。
 *
 * 器件按三级读:
 *   ① **器件字段行**(`目标器件:` / `器件型号:` / `PART:`)—— 写到 `**` 加粗也行;
 *   ② 没字段行时:任何写着「器件 / device / part」的行;
 *   ③ 再没有:整篇找。
 * 每一级都先做**同器件写法折叠**、再**只认唯一候选**:一行里两个不同型号(候选 / 备选)= 说不清,不认。
 * 顶层模块名:带「顶层」的行、冒号后面第一个标识符;说不止一个名字时不认。
 *
 * 导出给 `module-report-check.mjs` 复用(器件一致性检查要用**同一套**读法 —— 两处各写一份,
 * 迟早出现"这个工具读得出、那个读不出"的分歧)。
 * @param specPath - spec.md 路径(不存在时两项都是 `undefined`)。
 * @returns `{ part, top }`。
 */
export function fieldsFromSpec(specPath) {
  if (!existsSync(specPath)) return { part: undefined, top: undefined };
  const lines = readFileSync(specPath, "utf8").split(/\r?\n/u);
  const unique = (list) => (list.length === 1 ? list[0] : undefined);
  const from = (filter) => unique(collapsePrefixes(distinct(lines.filter(filter).flatMap(partTokens))));
  const part = from((line) => DEVICE_FIELD_RE.test(line))
    ?? from((line) => DEVICE_LINE_RE.test(line))
    ?? from(() => true);
  const tops = distinct(lines.filter((line) => TOP_LINE_RE.test(line)).map(topToken).filter(Boolean));
  return {
    part,
    top: tops.length === 1 ? tops[0] : undefined
  };
}

/**
 * 按「**工程 spec 优先** → 模块 spec」的顺序读器件,顶层名只认模块自己的 spec。
 *
 * 器件只写一处,工程是权威:
 *   - 向上找到 `kind: project` 锚点后,若其 `doc/spec.md` 有器件 → **以它为准**;
 *     模块 spec 也写了、但**不一致** → 返回 `conflict`(调用方**拒绝生成**,不替用户选一个);
 *   - 工程 spec 没有(独立模块) → 用模块 spec 自己写的;
 *   - 两处都没有 → `part` 为 `undefined`(调用方拒绝生成)。
 * 顶层名(Q4-02):**只认模块 spec**。工程 spec 里那个是整个工程的顶层(如 `system_top`),
 * 借过来会写进模块综合脚本 —— 模块名才是这里该用的兜底(见 `main()`)。
 * @param root - 模块根。
 * @returns `{ specPath, projectSpecPath, part, top, partSource, conflict }`;
 *   `conflict` 为 `{ module, project, projectSpecPath }`(只在不同时为 `undefined` 之外的对象)。
 */
function enclosingProjectSpec(root) {
  let cursor = resolve(root);
  while (true) {
    const anchor = join(cursor, ".fpga-workbench.json");
    if (existsSync(anchor)) {
      try {
        if (JSON.parse(readFileSync(anchor, "utf8"))?.kind === "project") {
          return join(cursor, "doc", "spec.md");
        }
      } catch {
        // 读不懂的锚点不拿来猜工程；模块自己的 spec 仍可独立工作。
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

export function readSpecFields(root) {
  const specPath = join(root, "spec", "spec.md");
  const projectSpecPath = enclosingProjectSpec(root);
  const mine = fieldsFromSpec(specPath);
  const fromProject = projectSpecPath === undefined ? {} : fieldsFromSpec(projectSpecPath);

  if (fromProject.part !== undefined && mine.part !== undefined && mine.part.toLowerCase() !== fromProject.part.toLowerCase()) {
    // 两处都写了、还不一样:器件以工程为准,模块那份是错的 —— 拒绝,并把两处都列出来
    return {
      specPath,
      projectSpecPath,
      part: fromProject.part,
      top: mine.top,
      partSource: "project",
      conflict: { module: mine.part, project: fromProject.part, projectSpecPath }
    };
  }
  if (fromProject.part !== undefined) {
    return { specPath, projectSpecPath, part: fromProject.part, top: mine.top, partSource: "project" };
  }
  return { specPath, projectSpecPath, part: mine.part, top: mine.top, partSource: mine.part === undefined ? undefined : "module" };
}

/**
 * 器件串**完不完整**(第四轮 Q4-11):"正则匹配到"不等于"能喂给 Vivado 的 `-part`"。
 *
 * 实测形状:spec 里只写族名简称(`XC7A100T`)也匹配得上,于是脚本会生成 `set PART "XC7A100T"` ——
 * 那不是一个合法 part(Vivado 需要器件+封装+速度等级)。不能硬编码"7 系列专用"的正则(会误伤别的族),
 * 只按**形状**判:必须有速度等级分隔,且它前面那段以"字母+数字"结尾(封装码,如 `fgg484` / `ffva1156` /
 * `ffvc1156`)。拿不准的就**拒绝生成**,让人把完整型号写进 spec。
 * @param part - 解析出来的器件串。
 * @returns 看起来是完整器件串时为 true。
 */
export function partLooksComplete(part) {
  if (typeof part !== "string") return false;
  const [device = "", ...rest] = part.split("-");
  if (rest.length === 0) return false; // 没有分隔:`XC7A100T`、`xcku040`、`xczu7ev`
  // 封装码:器件段自带(`xc7a100tfgg484`)或单独一段(`xcku040-ffva1156-…`)—— 都是"字母 + ≥3 位数字"
  const hasPackage = /[a-z]+\d{3,}$/iu.test(device) || rest.some((segment) => /^[a-z]+\d{3,}$/iu.test(segment));
  // 速度等级:单独一段纯数字(可带一个后缀字母),如 `-2` / `-1` / `-2` + `-e`
  const hasSpeed = rest.some((segment) => /^\d+[a-z]?$/iu.test(segment));
  return hasPackage && hasSpeed;
}
/** 判据的边界用例(自检直接调它,不用起文件):真实 spec + 常见残缺写法。 */
export const PART_SHAPE_CASES = [
  { part: "xc7a100tfgg484-2", complete: true },
  { part: "xc7z020clg484-1", complete: true },
  { part: "xcku040-ffva1156-2-e", complete: true },
  { part: "xczu7ev-ffvc1156-2-e", complete: true },
  { part: "XC7A100T", complete: false },
  { part: "xcku040", complete: false },
  { part: "xc7a100t-2", complete: false },
  { part: "xcku040-ffva1156", complete: false }
];
/** 取一行里所有像器件型号的词。 */
function partTokens(line) {
  return line.match(PART_RE) ?? [];
}

/** 取「顶层…:名字」里的名字;这一行说不出来就返回 `undefined`。 */
function topToken(line) {
  const [, after = ""] = /[:：](.*)$/u.exec(line) ?? [];
  const [, name = ""] = /^\s*`?([A-Za-z_][A-Za-z0-9_$]*)/u.exec(after) ?? [];
  return name === "" ? undefined : name;
}

/** 去重(保持出现顺序)。 */
function distinct(list) {
  return [...new Set(list)];
}

/** 入口。 */
function main() {
  const args = parseStampArgs(process.argv.slice(2));
  if (args.kind !== "synth-script") return stampFile({ ...args, kind: "xdc" });
  // 漏给模块根时不去读 spec(那会拼出一个不存在的路径):交给 stampFile 如实报参数错
  const spec = args.root === undefined ? {} : readSpecFields(args.root);
  // 两处器件**不一致**就拒绝(第四轮复审 Q4-01):器件以工程 spec 为准,模块那份是错的 ——
  // 自动挑一个(无论挑哪个)都会把"两份规格打架"这件事藏起来,而 IP 是按其中一个定制的。
  if (spec.conflict !== undefined) {
    console.error("两处器件型号不一致,先不起综合脚本:");
    console.error(`  工程 spec:${spec.conflict.projectSpecPath} → ${spec.conflict.project}`);
    console.error(`  模块 spec:${spec.specPath} → ${spec.conflict.module}`);
    console.error("  器件只写一处(工程 spec 是权威):把模块 spec 里那份删掉,或在工程 spec 里改对;再跑本命令。");
    return 2;
  }
  // 器件串**不完整**也拒绝(第四轮 Q4-11):`set PART "XC7A100T"` 这种不是合法 part,
  // 到综合时才报错、且看不出根因 —— 让人先把完整型号(器件+封装+速度等级)写进 spec。
  if (args.root !== undefined && spec.part !== undefined && !partLooksComplete(spec.part)) {
    console.error(`器件串不完整,先不起综合脚本:解析到的是 ${spec.part}`);
    console.error("  要写完整型号,例如 xc7a100tfgg484-2(器件 + 封装 + 速度等级)——");
    console.error(spec.projectSpecPath === undefined
      ? `  模块 spec:${spec.specPath}`
      : `  工程 spec:${spec.projectSpecPath} 或模块 spec:${spec.specPath}`);
    return 2;
  }
  // 器件定不下来就**拒绝**:留着模板里的默认器件等于拿一个看起来可信的错值去综合(见文件头)。
  if (args.root !== undefined && spec.part === undefined) {
    console.error("器件没定,先不起综合脚本(继承模板默认器件会拿错器件去综合):");
    console.error(`  模块 spec:${spec.specPath} 里没有器件型号`);
    if (spec.projectSpecPath !== undefined) console.error(`  工程 spec:${spec.projectSpecPath} 里也没有`);
    console.error("  写进模块 spec；若模块位于工程目录下,也可写进该工程的 doc/spec.md。再跑本命令。");
    return 2;
  }
  // 顶层名:只认**模块自己的** spec,没有就按模块名填(第四轮复审 Q4-02:工程 spec 里那个是
  // 整个工程的顶层 `system_top`,借过来会写进模块综合脚本;本模式约定 `rtl/<模块名>.sv` 才是顶层)
  const top = spec.top ?? args.name;
  if (args.root !== undefined && spec.top === undefined && top !== undefined) {
    console.log(`(spec 里没写「顶层模块名:」,按模块名填了 ${top};要用别的名字就在 spec 里写明)`);
  }
  if (spec.partSource === "project") {
    console.log(`(器件 ${spec.part} 取自工程 spec:${spec.projectSpecPath})`);
  }
  return stampFile({ ...args, template: args.template ?? BUNDLED_RUN_SYNTH, part: spec.part, top });
}

/** 直接跑本文件时才走 CLI;被 import 时什么都不做。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
