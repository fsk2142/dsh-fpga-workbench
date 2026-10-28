// 验证环节:按模板起文件(测试平台只替模块名；编译、运行与比对脚本原样复制)。
//
// 用法:
//   node module-verif-new.mjs <模块根> <模块名> [--template <测试平台模板路径>]
//                     [--out <相对路径>] [--force] [--dry-run]
//   node module-verif-new.mjs <模块根> --kind sim-compile [--template <仿真脚本路径>]
//   node module-verif-new.mjs <模块根> --kind sim-run [--template <仿真脚本路径>]
//                     [--out <相对路径>] [--force] [--dry-run]
//   node module-verif-new.mjs <模块根> --kind comp [--template <比对脚本路径>]
//                     [--out <相对路径>] [--force] [--dry-run]
//   node module-verif-new.mjs <模块根> --kind uvm [--out <相对路径>] [--force] [--dry-run]
// 默认落到 `verif/tb_<snake>.sv`(`<snake>` 是模块名的下划线形式;扩展名跟着模板走)。
// 编译与运行**同一份**仿真脚本(模板 modelsim_run.do),固定落 `verif/run.do`(按模式调用);比对脚本固定落 `verif/comp.py`。
// 不给 `--template` 时使用分类模板库中的对应内置模板。
//
// `--kind uvm` 起的是 **UVM 骨架**(不是填空模板):它自带一个 demo DUT 并已验证可跑通,
// 目的有二 —— ① 证明环境是好的;② 给你一个已知能跑的起点去改。生成后要做两件事:
// 换掉 demo DUT、把 scoreboard 的期望值算法换成 spec 对应的参考模型。
// 起之前建议先跑 `module-verif-uvm-selftest.mjs` 确认环境(它退 3 = 环境缺失)。
//
// 模板路径看会话开头「本机 FPGA 工具链」的模板一节。
// 退出码:0 成功 / 1 目标已存在且未加 --force / 2 参数或环境不对
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStampArgs, stampFile } from "../lib/stamp.mjs";

const BUNDLED_SIM = fileURLToPath(new URL("../../templates/simulation/run/modelsim_run.do", import.meta.url));
/** 自带的比对脚本模板(先归一化、只比值;行尾/大小写/0x 前缀都不算差异)。 */
const BUNDLED_COMP = fileURLToPath(new URL("../../templates/verification/python_data_verification.py", import.meta.url));
// 自带的测试平台模板。**四种 kind 一律支持默认值**(第八轮复审留下的那条:用法说明写着"不给 --template
// 就用分类模板库里的内置",但 tb 那种以前其实要求显式给 —— 说的和做的两套)。
const BUNDLED_TB = fileURLToPath(new URL("../../templates/simulation/testbench/systemverilog_testbench.sv", import.meta.url));
/**
 * UVM 骨架。
 *
 * 为什么放在 `skills/.../references/` 而不在 `templates/`:
 * `templates/` 里的每一项都是「生成即用、只需填模块名」的填空模板,由
 * `check-preset-root` 逐一核对;而 UVM 骨架**必然要改**(换 DUT、写参考模型),
 * 且还要环境就绪。放 references 更诚实 —— 它是"起点样例"而不是"填空模板"。
 * 但用户不该为此多走一步手动复制,所以这里给它留了 `--kind uvm` 入口。
 */
const BUNDLED_UVM = fileURLToPath(
  new URL("../../skills/fpga-module-verif/references/uvm-selfcheck.sv", import.meta.url)
);

/** 入口。 */
function main() {
  const args = parseStampArgs(process.argv.slice(2));
  // kind 说的是"起哪种模板"(tb / sim-compile / sim-run / comp / uvm),
  // 不是环节名:defaultDestination 按它推落点,所以测试平台这里是 "tb",不是 "verif"。
  // sim-compile 与 sim-run 用**同一份**仿真脚本(起第二次会被"已存在、不覆盖"挡下,这是预期的)。
  if (args.kind === "sim-compile" || args.kind === "sim-run") {
    return stampFile({ ...args, template: args.template ?? BUNDLED_SIM });
  }
  if (args.kind === "comp") {
    return stampFile({ ...args, template: args.template ?? BUNDLED_COMP });
  }
  if (args.kind === "uvm") {
    // 骨架的 demo DUT / package 名都是 `demo_*`,不依赖模块名替换 —— 原样复制,
    // 由用户改。所以这里不传模块名也能用。
    return stampFile({ ...args, kind: "tb", template: args.template ?? BUNDLED_UVM });
  }
  return stampFile({ ...args, kind: "tb", template: args.template ?? BUNDLED_TB });
}

/** 直接跑本文件时才走 CLI;被 import 时什么都不做。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
