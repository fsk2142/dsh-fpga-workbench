// 宿主半侧:注册工具链设置,并探测填的路径是否存在,供设置页显示"会跳过哪些步骤"。
//
// 两件事:
//   1. ctx.settings.register —— 「设置 → FPGA 工作台」的字段,存进 settings.yaml。
//   2. 只读 HTTP 路由 —— 设置页拿它判断哪一项没就绪(浏览器不能 stat 本地文件)。
//
// **刻意不往会话提示里注入任何东西。** 提示段是注册在插件行(profile 层)上的,
// 作用域是全局 —— 那样普通会话也会看到 FPGA 工具链的信息与警告,与"不影响正常会话"
// 冲突。要按会话作用域注入,得让 section 由预设组装来注册,而不是这里。目前的决定是
// 只在设置页提示。

import { existsSync, statSync } from "node:fs";

import z from "@deepseek-ai/schemastery";
import { FIELDS, NS, inspectTools } from "./toolchain.js";

export { NS };

/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export const STATUS_PATH = "/plugins/fpga-workbench/toolchain";

/** 设置 schema:每个字段一个字符串,默认空。 */
export const SettingsSchema = z.object(
  Object.fromEntries(FIELDS.map((field) => [field.key, z.string().default("")]))
);

/**
 * 真实文件系统探测。
 *
 * 文件字段也接受目录:用户可能填到工具所在目录(有些安装把可执行文件放在 bin 下),
 * 替他把关只会误报。目录字段要求真的是目录。
 * @param path - 配置里填的路径。
 * @param kind - `"file"` 或 `"directory"`。
 * @returns 存在且类型可接受。
 */
function probeFilesystem(path, kind) {
  if (!existsSync(path)) return false;
  try {
    return kind === "directory" ? statSync(path).isDirectory() : true;
  } catch {
    return false;
  }
}

/**
 * 当前状态:每项的存在情况 + 给设置页用的汇总。
 * @param values - 设置解析后的值。
 * @returns `{ tools, missing, ok }`;`tools` 每项带 `skips`,说明缺失会跳过什么。
 */
export function statusOf(values) {
  const tools = inspectTools(values, probeFilesystem).map(
    ({ key, label, hint, kind, required, skips, path, configured, present }) => ({
      key,
      label,
      hint,
      kind,
      required,
      skips,
      path,
      configured,
      present
    })
  );
  // 只有"必须存在"的项缺失才算故障。缓存目录是写入目标,还不存在是正常的。
  const missing = tools.filter((tool) => tool.required && !tool.present).map((tool) => tool.key);
  return { tools, missing, ok: missing.length === 0 };
}

/**
 * 挂载宿主半侧。
 * @param ctx - host plugin context carrying `settings`.
 */
export function apply(ctx) {
  const settings = ctx.settings.register(NS, SettingsSchema, { base: {} });

  // 设置页的状态接口。webServer 在 headless/CLI 部署里不存在 —— 拿不到就不注册这一步,
  // 设置项本身照常可读写,只是没有状态提示。
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: STATUS_PATH,
          handler: (_req, res) => {
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store"
            });
            res.end(JSON.stringify(statusOf(settings.get())));
          }
        }),
      "fpga-workbench: toolchain status route"
    );
  });
}

export const name = "fpga-workbench";
export const inject = ["settings"];
