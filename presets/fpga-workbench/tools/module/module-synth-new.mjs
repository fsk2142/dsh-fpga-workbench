// 综合环节:按模板起一个约束文件或综合脚本(**复制**模板,只替模块名/填 spec 里那两项)。
//
// 用法:
//   node module-synth-new.mjs <模块根> <模块名> --template <约束模板路径>
//                      [--out <相对路径>] [--force] [--dry-run]
//   node module-synth-new.mjs <模块根> <模块名> --kind synth-script
//                      [--template <综合脚本路径>] [--out <相对路径>] [--force] [--dry-run]
// 默认落到 `synth/<模块名>.xdc`。`--kind synth-script` 固定落 `synth/run_synth.tcl`(文件名不跟
// 模板扩展名走);不给 `--template` 时用自带那份 `templates/run_synth.tcl`。
// 综合脚本里的**器件型号与顶层模块名从 `spec/spec.md` 读出来填进去** —— 器件与时钟只写一处,
// 别再手抄;读不到就不猜:那两行保留模板原样,并提示手填。
// 模板路径看会话开头「本机 FPGA 工具链」的模板一节。
// 写完记得:约束文件名与里面的时钟名必须与器件配置里的写法完全一致(见 fpga-module-synth)。
// 退出码:0 成功 / 1 目标已存在且未加 --force / 2 参数或环境不对
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStampArgs, stampFile } from "../lib/stamp.mjs";

/** 自带的综合脚本模板:`tools/` 与 `templates/` 同级(装进 profile 后这个相对关系不变)。 */
const BUNDLED_RUN_SYNTH = fileURLToPath(new URL("../../templates/run_synth.tcl", import.meta.url));

// 器件型号:spec.md 没有固定模板,所以按**型号串**认,不按第几节认 —— Xilinx 的型号一律以
// `xc` 起头、且必然带数字(器件规模),`xc7a100tfgg484-2` / `xcku040-ffva1156-2-e` 都是这个形状。
// 两条一起用,`xci` / `xdc` / 工具名 `xcelium` 这类词就挡在外面了(它们没有数字)。
const PART_RE = /\bxc[0-9a-z]*\d[0-9a-z]*(?:-[0-9a-z]+)*\b/giu;
const DEVICE_LINE_RE = /器件|芯片|device|part/iu;
// 顶层模块名:那一行要说「顶层」(`顶层模块名:uart_rx`);值取冒号后面第一个标识符。
const TOP_LINE_RE = /顶层|top\s*module/iu;

/**
 * 从 spec/spec.md 里读器件型号与顶层模块名。
 *
 * **读不到就是不填**(`undefined`),调用方保留模板原样并提示手填:猜一个型号写进综合脚本
 * 比留一行给人填坏得多。
 * @param root - 模块根。
 * @returns `{ specPath, part, top }`;`part` / `top` 读不到时是 `undefined`。
 */
export function readSpecFields(root) {
  const specPath = join(root, "spec", "spec.md");
  if (!existsSync(specPath)) return { specPath, part: undefined, top: undefined };
  const lines = readFileSync(specPath, "utf8").split(/\r?\n/u);

  // 器件:先只看写着「器件 / device / part」的行;那种行一个都没有,才在整篇里找。
  // **只认唯一候选**:一行里写两个不同型号(候选 / 备选)、或全篇提到别的型号 = 说不清,不填。
  const onDeviceLines = distinct(lines.filter((line) => DEVICE_LINE_RE.test(line)).flatMap(partTokens));
  const wholeFile = distinct(lines.flatMap(partTokens));
  const candidates = onDeviceLines.length > 0 ? onDeviceLines : wholeFile;
  const part = candidates.length === 1 ? candidates[0] : undefined;

  // 顶层模块名:带「顶层」的行、冒号后面第一个标识符;说不止一个名字时不认
  const tops = distinct(lines.filter((line) => TOP_LINE_RE.test(line)).map(topToken).filter(Boolean));
  const top = tops.length === 1 ? tops[0] : undefined;

  return { specPath, part, top };
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
  return stampFile({ ...args, template: args.template ?? BUNDLED_RUN_SYNTH, part: spec.part, top: spec.top });
}

/** 直接跑本文件时才走 CLI;被 import 时什么都不做。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
