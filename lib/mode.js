// 模式半侧:把「本机工具链」交给 **FPGA 开发模式** 的会话。
//
// 这一行只从 presets/fpga-workbench/agent.cordis.yml 挂载 —— 那是本预设自己的组装,
// 作用域是 agent 作用域,所以只有 FPGA 模式的会话能看到这段提示。插件行(lib/index.js)
// **刻意不注册**任何提示段:那层作用域是全局,普通会话也会看到 FPGA 工具链信息,与
// "不影响正常会话"冲突(见 README「关于提示注入」)。
//
// 为什么是提示段而不是一个工具:路径与调用姿势是这个模式的**背景事实**,每次会话都
// 用得上,而工具要靠模型想起来去调。真正的命令仍由 agent 用现有 shell 工具跑 —— 走
// 沙箱、输出可回看、能中断;这里不自己起进程,也就没有第二套超时与日志要维护。
//
// 取值路径:ctx.get("settings").get(NS) 是 dsh-settings 已注册命名空间的**解析后**值
// (默认值 → 行 config → 用户层,见 dsh-settings/lib/index.js:395 与 :517)。用动态
// 取而不是静态 inject:拿不到服务时只是少一段提示,不能让整行挂载失败 —— 那会让
// FPGA 模式整个起不来。

import { NS, describeEnv, probeFilesystem } from "./toolchain.js";

/** 提示段名(全局唯一即可;只有本模式注册它)。 */
const SECTION = "fpga-workbench:toolchain";

/**
 * 段落位置:紧随人设之后。
 *
 * dsh-system-prompt 的 SECTION_ORDERS 里人设是 0,工具说明从 1000(TOOL_BASH)起,
 * 100 落在两者之间的空档 —— 这段是"环境事实",读在人设之后、工具规则之前。
 */
const ORDER = 100;

export const name = "fpga-workbench-mode";

/** 只依赖提示注册表:Cordis 允许服务缺失时整行不激活,那也比挂载失败好。 */
export const inject = ["systemPrompt"];

/**
 * 读当前的设置值。
 *
 * 动态取服务而不是静态 inject:`settings` 拿不到时返回 undefined,由 describeEnv
 * 如实说明"读不到值",而不是让本行不挂载。
 * @param ctx - 本行的插件上下文。
 * @returns 解析后的设置值,或 undefined。
 */
function readValues(ctx) {
  try {
    return ctx.get("settings")?.get(NS);
  } catch {
    return undefined;
  }
}

/**
 * 挂载模式半侧。
 * @param ctx - 预设作用域内的插件上下文。
 */
export function apply(ctx) {
  // text 传函数:每次组装提示时重新取值,用户在设置页改完路径立刻生效,不用重启会话。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION,
        order: ORDER,
        text: () => describeEnv(readValues(ctx), probeFilesystem)
      }),
    "fpga-workbench: toolchain section"
  );
}
