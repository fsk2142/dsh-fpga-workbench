// 验证环节:按模板起文件(测试平台只替模块名；编译、运行与比对脚本原样复制)。
//
// 用法:
//   node module-verif-new.mjs <模块根> <模块名> --template <测试平台模板路径>
//                     [--out <相对路径>] [--force] [--dry-run]
//   node module-verif-new.mjs <模块根> --kind sim-compile [--template <编译脚本路径>]
//   node module-verif-new.mjs <模块根> --kind sim-run [--template <运行脚本路径>]
//                     [--out <相对路径>] [--force] [--dry-run]
//   node module-verif-new.mjs <模块根> --kind comp [--template <比对脚本路径>]
//                     [--out <相对路径>] [--force] [--dry-run]
// 默认落到 `verif/tb_<snake>.sv`(`<snake>` 是模块名的下划线形式;扩展名跟着模板走)。
// 两份仿真脚本分别固定落 `verif/compile.do` 与 `verif/run.do`;比对脚本固定落 `verif/comp.py`。
// 不给 `--template` 时使用分类模板库中的对应内置模板。
// 模板路径看会话开头「本机 FPGA 工具链」的模板一节。
// 退出码:0 成功 / 1 目标已存在且未加 --force / 2 参数或环境不对
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStampArgs, stampFile } from "../lib/stamp.mjs";

const BUNDLED_SIM_COMPILE = fileURLToPath(new URL("../../templates/simulation/compile/modelsim_compile.do", import.meta.url));
const BUNDLED_SIM_RUN = fileURLToPath(new URL("../../templates/simulation/run/modelsim_run.do", import.meta.url));
/** 自带的比对脚本模板(先归一化、只比值;行尾/大小写/0x 前缀都不算差异)。 */
const BUNDLED_COMP = fileURLToPath(new URL("../../templates/verification/python_data_verification.py", import.meta.url));

/** 入口。 */
function main() {
  const args = parseStampArgs(process.argv.slice(2));
  // kind 说的是"起哪种模板"(tb / sim-compile / sim-run / comp),
  // 不是环节名:defaultDestination 按它推落点,所以测试平台这里是 "tb",不是 "verif"。
  if (args.kind === "sim-compile") {
    return stampFile({ ...args, template: args.template ?? BUNDLED_SIM_COMPILE });
  }
  if (args.kind === "sim-run") {
    return stampFile({ ...args, template: args.template ?? BUNDLED_SIM_RUN });
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
