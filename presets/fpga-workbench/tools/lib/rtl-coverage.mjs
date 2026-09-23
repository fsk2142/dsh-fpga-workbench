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

/**
 * **仿真辅助代码允许的规则**(白名单,第九轮收口复审 Batch B)。
 *
 * 之前是黑名单(只从结果里删掉"九个小节块 / 设计断言"),于是以后 checker **新增任何 RTL-only 规则**
 * 都会自动落到 sim-support 上,again 制造误报 —— 白名单把边界钉死:不在表里的规则一律不适用于它们。
 * 留在表里的都是通用、无争议的:文件头、编译隔离、Tab / 非英文 / 行尾(混用)。
 */
const SIM_SUPPORT_RULES = new Set(["文件头", "编译隔离", "Tab 字符", "代码行非英文", "行尾混用"]);

/**
 * 仿真辅助代码(sim/ 下的非 tb_*:package / interface / BFM / 记分板 / 驱动…)的规则裁剪。
 *
 * 第八轮复审 E8-05:这类文件以前按"普通 RTL"查,于是要求九个 RTL 小节 banner、设计断言、
 * always_ff 形态、复位极性 …… 合法的仿真辅助代码未必长那样,报出来就是噪声。
 * 第九轮收口复审 Batch B 把它定成**白名单**:只保留 {@link SIM_SUPPORT_RULES} 里的通用规则;
 * 缺文件头、缺 `default_nettype(编译隔离)这类仍然照报 —— 那是所有 HDL 都该守的。
 * @param issues - checkFile() 的原始结果。
 * @returns 只留通用规则后的结果。
 */
export function keepSimSupportOnly(issues) {
  return issues.filter((issue) => SIM_SUPPORT_RULES.has(issue.rule));
}
