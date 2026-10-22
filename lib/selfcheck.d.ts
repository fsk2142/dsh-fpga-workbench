//#region src/selfcheck.d.ts
/**
 * 四棵子树里**按名字被运行时读**的固定文件(不只是"目录在不在")。
 *
 * `workspace/AGENTS.fpga.md` 是建骨架时原样复制的模式规则正文(见 setup-scaffold.mjs 的
 * `RULES_SOURCE`);少了它 `setup-scaffold` 直接抛错、工程骨架建不出来 —— 只看目录看不出来。
 * 仓库侧 `check-preset-root.mjs` 用 setup-scaffold 导出的 `INSTRUCTION_FILE` 断言这份清单没写错。
 */
declare const REQUIRED_PRESET_FILES: string[];
/**
 * 应带的自带技能。
 *
 * 目录是真相,这份是**期望**:只有拿它比对,"整个技能目录被删掉"才看得出来(只数目录的话,
 * 16 个变 15 个照样"通过")。删技能必须同时改这里 —— 仓库侧 `check-preset-root.mjs` 断言
 * 两者逐项一致,漏改会在 `npm test` 里红。
 */
export declare const BUNDLED_SKILLS: string[];
/** 自检单项的三档结论。 */
export type CheckStatus = "pass" | "warn" | "fail";
/** 自检的一项结论（设置页按这个渲染）。 */
export interface CheckEntry {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}
/** `runSelfCheck` 的完整结论。 */
export interface SelfCheckReport {
  ranAt: string;
  ok: boolean;
  failed: number;
  warned: number;
  checks: CheckEntry[];
}
/**
 * 跑一遍只读自检。
 * @param values - 当前已保存的设置值(调用方从 settings 服务取)。
 * @param packageRoot - 要检查的包根;默认本文件所在的包(测试夹具可传别的目录)。
 * @returns `{ ranAt, ok, failed, warned, checks }` —— `checks` 每项 `{ id, label, status, detail }`。
 */
export declare function runSelfCheck(values?: Record<string, unknown>, packageRoot?: string): SelfCheckReport;
//#endregion
export { REQUIRED_PRESET_FILES };