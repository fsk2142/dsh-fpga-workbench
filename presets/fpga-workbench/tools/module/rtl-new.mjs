// RTL 环节:按模板起一个 RTL 文件(**复制**模板、只替模块名)。
//
// 用法:
//   node rtl-new.mjs <模块根> <模块名> --template <RTL 模板路径>
//                    [--out <相对路径>] [--force] [--dry-run]
// 默认落到 `rtl/<模块名>.<模板扩展名>`。模板路径从会话开头「本机 FPGA 工具链」的模板一节取。
// 退出码:0 成功 / 1 目标已存在且未加 --force / 2 参数或环境不对
import { pathToFileURL } from "node:url";

import { parseStampArgs, stampFile } from "../lib/stamp.mjs";

/** 入口。 */
function main() {
  return stampFile({ ...parseStampArgs(process.argv.slice(2)), kind: "rtl" });
}

/** 直接跑本文件时才走 CLI;被 import 时什么都不做。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
