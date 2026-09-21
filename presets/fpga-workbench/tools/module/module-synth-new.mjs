// 综合环节:按模板起一个约束文件或综合脚本(**复制**模板,只替模块名/填 spec 里那两项)。
//
// 用法:
//   node module-synth-new.mjs <模块根> <模块名> --template <约束模板路径>
//                      [--out <相对路径>] [--force] [--dry-run]
//   node module-synth-new.mjs <模块根> <模块名> --kind synth-script
//                      [--template <综合脚本路径>] [--out <相对路径>] [--force] [--dry-run]
// 默认落到 `synth/<模块名>.xdc`。`--kind synth-script` 固定落 `synth/run_synth.tcl`(文件名不跟
// 模板扩展名走);不给 `--template` 时用自带那份 `templates/run_synth.tcl`。
// 综合脚本里的**器件型号与顶层模块名从 spec 读出来填进去** —— 器件与时钟只写一处,别再手抄。
// **器件来源(用户口径 2026-09-21)**:模块 spec 不重述器件,以**工程 spec** 为准 ——
//   ① 模块自己的 `spec/spec.md` 写了 → 用它;
//   ② 没有 → 用**兄弟目录** `../project/spec/spec.md`(本模式的工程骨架:<工程根>/project/ + <工程根>/<模块>/);
//   ③ 两处都没有 → **拒绝生成**(退出码 2),而不是继承模板里的默认器件 —— 那会拿一个看起来可信的
//      错值去综合(实测:老 IP 与工程器件不同族 → IP 被锁、模块找不到,查很久)。
// 顶层模块名同理:spec 里没有就按**模块名**填(那不是猜 —— 本模式约定 `rtl/<模块名>.sv` 就是顶层)。
// 模板路径看会话开头「本机 FPGA 工具链」的模板一节。
// 写完记得:约束文件名与里面的时钟名必须与器件配置里的写法完全一致(见 fpga-module-synth)。
// 退出码:0 成功 / 1 目标已存在且未加 --force / 2 参数或环境不对(含"器件没定")
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStampArgs, stampFile } from "../lib/stamp.mjs";

/** 自带的综合脚本模板:`tools/` 与 `templates/` 同级(装进 profile 后这个相对关系不变)。 */
const BUNDLED_RUN_SYNTH = fileURLToPath(new URL("../../templates/run_synth.tcl", import.meta.url));

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
 * 按「模块 spec → 工程 spec」的顺序读器件与顶层名。
 * @param root - 模块根。
 * @returns `{ specPath, part, top, partSource }`;`partSource` 是器件从哪读到的(`"module"` / `"project"` / `undefined`)。
 */
export function readSpecFields(root) {
  const specPath = join(root, "spec", "spec.md");
  const mine = fieldsFromSpec(specPath);
  if (mine.part !== undefined) return { specPath, ...mine, partSource: "module" };
  // 模块 spec 没写器件(按新口径这本来就是常态):看工程的 spec —— 模块根与 `project/` 是兄弟
  const projectSpec = join(root, "..", "project", "spec", "spec.md");
  const fromProject = fieldsFromSpec(projectSpec);
  return {
    specPath,
    part: fromProject.part,
    top: mine.top ?? fromProject.top,
    partSource: fromProject.part === undefined ? undefined : "project"
  };
}

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
  // 器件定不下来就**拒绝**:留着模板里的默认器件等于拿一个看起来可信的错值去综合(见文件头)。
  if (args.root !== undefined && spec.part === undefined) {
    console.error("器件没定,先不起综合脚本(继承模板默认器件会拿错器件去综合):");
    console.error(`  模块 spec:${spec.specPath} 里没有器件型号`);
    console.error("  工程 spec(<模块根的兄弟目录>/project/spec/spec.md)里也没有");
    console.error("  器件只写一处(用户口径):写进工程 spec,或写进这个模块的 spec;再跑本命令。");
    return 2;
  }
  // 顶层名 spec 里没有 → 按模块名填(本模式约定 `rtl/<模块名>.sv` 就是顶层,不是猜)
  const top = spec.top ?? args.name;
  if (args.root !== undefined && spec.top === undefined && top !== undefined) {
    console.log(`(spec 里没写「顶层模块名:」,按模块名填了 ${top};要用别的名字就在 spec 里写明)`);
  }
  if (spec.partSource === "project") console.log(`(器件 ${spec.part} 取自工程 spec)`);
  return stampFile({ ...args, template: args.template ?? BUNDLED_RUN_SYNTH, part: spec.part, top });
}

/** 直接跑本文件时才走 CLI;被 import 时什么都不做。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
