// 验证环节:按模板起文件(**复制**模板;测试平台只替模块名,run.do 与 comp.py 一个字符都不改)。
//
// 用法:
//   node module-verif-new.mjs <模块根> <模块名> --template <测试平台模板路径>
//                     [--out <相对路径>] [--force] [--dry-run]
//   node module-verif-new.mjs <模块根> --kind run-do [--template <run.do 路径>]
//                     [--out <相对路径>] [--force] [--dry-run]
//   node module-verif-new.mjs <模块根> --kind comp [--template <比对脚本路径>]
//                     [--out <相对路径>] [--force] [--dry-run]
// 默认落到 `verif/tb_<snake>.sv`(`<snake>` 是模块名的下划线形式;扩展名跟着模板走)。
// `--kind run-do` 起的是批处理仿真脚本,固定落 `verif/run.do`;`--kind comp` 起的是比对脚本,
// 固定落 `verif/comp.py`(两个都不跟模板扩展名走,也不替模块名);不给 `--template` 时用自带
// 的那份(`templates/run.do` / `templates/comp.py`)。
// 模板路径看会话开头「本机 FPGA 工具链」的模板一节。
// 退出码:0 成功 / 1 目标已存在且未加 --force / 2 参数或环境不对
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStampArgs, stampFile } from "../lib/stamp.mjs";

/** 自带的 run.do 模板:`tools/` 与 `templates/` 同级(装进 profile 后这个相对关系不变)。 */
const BUNDLED_RUN_DO = fileURLToPath(new URL("../../templates/run.do", import.meta.url));
/** 自带的比对脚本模板(先归一化、只比值;行尾/大小写/0x 前缀都不算差异)。 */
const BUNDLED_COMP = fileURLToPath(new URL("../../templates/comp.py", import.meta.url));

/** 入口。 */
function main() {
  const args = parseStampArgs(process.argv.slice(2));
  // kind 说的是"起哪种模板"(tb → 测试平台 / run-do → 批处理仿真脚本 / comp → 比对脚本),
  // 不是环节名:defaultDestination 按它推落点,所以测试平台这里是 "tb",不是 "verif"。
  if (args.kind === "run-do") {
    return stampFile({ ...args, template: args.template ?? BUNDLED_RUN_DO });
  }
  if (args.kind === "comp") {
    return stampFile({ ...args, template: args.template ?? BUNDLED_COMP });
  }
  return stampFile({ ...args, kind: "tb" });
}

/** 直接跑本文件时才走 CLI;被 import 时什么都不做。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
