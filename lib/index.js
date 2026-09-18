// 宿主半侧:注册工具链设置命名空间,并把它注入 FPGA 模式会话的提示。
//
// 两件事:
//   1. ctx.settings.register —— 让「设置 → FPGA 工作台」有可持久化的字段(存进
//      settings.yaml,与其他插件的设置一致)。
//   2. ctx.systemPrompt.section —— 把填好的路径写进会话提示。
//
// 第 2 条是关键:没有它,设置就只是一个没人读的表单。有了它,选中「FPGA 工作台」的
// 会话一上来就知道 Vivado / ModelSim / Verilator 在哪、库在哪 —— 不需要每次问用户,
// 也不会去 PATH 里猜(实测这台机器 PATH 上已经没有 verilator)。
//
// `text` 传函数而不是字符串:system-prompt 在装配时对函数求值
// (dsh-system-prompt/lib/index.js:339),所以用户改完设置,下一个会话就带上新值。

import z from "@deepseek-ai/schemastery";
import { FIELDS, NS, renderToolchain } from "./toolchain.js";

export { NS, renderToolchain };

/** 设置 schema:每个字段一个字符串,默认空。 */
export const SettingsSchema = z.object(
  Object.fromEntries(FIELDS.map(([key]) => [key, z.string().default("")]))
);

/**
 * 挂载宿主半侧。
 * @param ctx - host plugin context carrying `settings` and `systemPrompt`.
 */
export function apply(ctx) {
  const settings = ctx.settings.register(NS, SettingsSchema, { base: {} });

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "fpga-workbench/environment",
        // 950:排在 FILE_REFERENCE(900)之后、TOOL_BASH(1000)之前 —— 工具链路径属于
        // 环境事实,紧挨着工具说明出现最合适。
        order: 950,
        text: () => renderToolchain(settings.get())
      }),
    "fpga-workbench: toolchain prompt section"
  );
}

export const name = "fpga-workbench";
export const inject = ["settings", "systemPrompt"];
