// 综合环节:按模板起一个约束文件(**复制**模板、只替模块名)。
//
// 用法:
//   node synth-new.mjs <模块根> <模块名> --template <约束模板路径>
//                      [--out <相对路径>] [--force] [--dry-run]
// 默认落到 `synth/<模块名>.xdc`。模板路径看会话开头「本机 FPGA 工具链」的模板一节。
// 写完记得:约束文件名与里面的时钟名必须与器件配置里的写法完全一致(见 fpga-module-synth)。
// 退出码:0 成功 / 1 目标已存在且未加 --force / 2 参数或环境不对
import { pathToFileURL } from "node:url";

import { parseStampArgs, stampFile } from "./lib/stamp.mjs";

/** 入口。 */
function main() {
  return stampFile({ ...parseStampArgs(process.argv.slice(2)), kind: "xdc" });
}

/** 直接跑本文件时才走 CLI;被 import 时什么都不做。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
