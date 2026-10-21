// 起子进程的唯一入口:在 Windows 上**必带 `windowsHide`**。
//
// 为什么单独成文件(2026-10-21,用户实报):`npm test` 每次跑到 ModelSim 那几段,屏幕上都会
// 闪一下黑色控制台窗口。根因不是 vsim 的问题,而是 Node 的行为:
//
//   · DSH Desktop 是 GUI 进程,本身**没有**控制台(Console)可以继承;
//   · `spawnSync` 在 Windows 上默认 `windowsHide: false`,于是每次起子进程,系统都会为它
//     新建一个控制台窗口,子进程退出后窗口消失 —— 看起来就是"闪一下";
//   · `npm test` 里要起几十次 vsim / python / node(六个仿真夹具、一致性矩阵、比较脚本…),
//     所以是"每检查一次弹一下",而不是一次。
//
// 只要显式 `windowsHide: true`,Node 就会加 `CREATE_NO_WINDOW`,窗口不再出现。
// 这里把它做成**不可省略**的封装:调用点只传业务选项,本模块负责补上这一个。
import { spawnSync as rawSpawnSync } from "node:child_process";

/**
 * `spawnSync` 的封装,Windows 上强制隐藏子进程窗口。
 *
 * 其余选项原样透传;调用方显式给了 `windowsHide` 时以调用方为准(留一个逃生口,
 * 例如将来真要弹一个用户可见的控制台)。非 Windows 上这是一个空操作。
 * @param command - 要执行的程序。
 * @param args - 参数数组。
 * @param options - `spawnSync` 的选项(无需再写 `windowsHide`)。
 * @returns `spawnSync` 的返回值。
 */
export function spawnSync(command, args, options = {}) {
  return rawSpawnSync(command, args, {
    windowsHide: true,
    ...options
  });
}

/**
 * 静态守卫用:禁止直接使用 `node:child_process` 的 `spawnSync`。
 *
 * `tools/check-fpga-tools.mjs` 里有一条断言扫源码,确保没有新的调用点绕过本封装 ——
 * 否则"某天加了一个夹具,又开始闪窗口"这种回归没人会注意到(它不影响任何测试结果)。
 */
export const SPAWN_GUARD_HINT =
  "起子进程请用 tools/lib/spawn.mjs 的 spawnSync(它保证 Windows 上不弹控制台窗口)";
