// RTL 检查的**覆盖判定**(模块级与工程级共用一份,第九轮复审②)。
//
// 为什么单独成文件:两个 checker(module/project)各有一份同构的机械规则(此前已确认"维护性重复"
// 一时不合并),但**覆盖判定**这种"状态口径"必须唯一 —— 模块级曾经只统计 `verif/` 下的 VHDL,
// 于是 `rtl/good.sv + rtl/broken.vhd` 还能打印 PASS;工程级修好了、模块级没跟上,就是漂移。
// 这里只放"数哪些没检查 / 该怎么定性"这一小块,不碰两边的规则实现。

import { existsSync } from "node:fs";

/** VHDL 源文件扩展名:本插件的机械检查器只覆盖 SystemVerilog / Verilog。 */
export const VHDL = /\.(vhd|vhdl)$/iu;

/**
 * 数出**未检查的 VHDL**(所有范围都要数,别只数其中一个目录)。
 * @param dirs - 要统计的范围目录(不存在的自动跳过)。
 * @param collectHdl - 收集函数 `(dir, pattern) => string[]`,用调用方自己那份(两边实现不同也无妨)。
 * @returns 未检查的 VHDL 文件路径(原样,不做相对化)。
 */
export function uncheckedVhdl(dirs, collectHdl) {
  return dirs.flatMap((dir) => (existsSync(dir) ? collectHdl(dir, VHDL) : []));
}

/**
 * 覆盖定性(单一口径):
 * - `full`:范围内没有未检查的 VHDL → 结论可以按"已覆盖"说;
 * - `none`:一个 HDL 都没检查到、却有 VHDL → 本环节对它 NOT_APPLICABLE(退 2);
 * - `partial`:检查了 HDL,但还有 VHDL 没检查 → **不能写 PASS**(退 2),只能 PARTIAL。
 * @param checkedCount - 已检查的 HDL 文件数。
 * @param skipped - 未检查的 VHDL 文件。
 * @returns `"full" | "partial" | "none"`。
 */
export function coverageVerdict(checkedCount, skipped) {
  if (skipped.length === 0) return "full";
  return checkedCount === 0 ? "none" : "partial";
}

/**
 * 把未检查清单压成一行提示用的短串(前 5 个 + 省略号)。
 * @param files - 未检查的文件路径。
 * @returns 逗号分隔的短串。
 */
export function shortenList(files) {
  return `${files.slice(0, 5).join("、")}${files.length > 5 ? " …" : ""}`;
}
