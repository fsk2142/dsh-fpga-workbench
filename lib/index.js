// 宿主半侧:注册工具链设置、探测工具、把结果注入会话提示、给设置页一个只读状态接口。
//
// 四件事:
//   1. ctx.settings.register —— 「设置 → FPGA 工作台」的字段,存进 settings.yaml。
//   2. 文件系统探测 —— 配的路径是否真的存在(文件 existsSync,目录 isDirectory)。
//   3. ctx.systemPrompt.section —— 把可用路径**和缺失警告**注入会话提示。这是关键:
//      没有它,设置就只是一个没人读的表单;有了它,选中「FPGA 工作台」的会话一上来就知道
//      工具在哪、以及哪些步骤必须跳过。
//   4. 只读 HTTP 路由 —— 设置页拿它显示警告(浏览器不能 stat 本地文件,只能问宿主)。
//
// `text` 传函数而不是字符串:system-prompt 装配时会对函数求值
// (dsh-system-prompt/lib/index.js:339),所以改完设置或换了工具,下一个会话就带上新结果。

import { existsSync, statSync } from "node:fs";

import z from "@deepseek-ai/schemastery";
import { FIELDS, NS, inspectTools, renderEnvironment } from "./toolchain.js";

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
        text: () => renderEnvironment(inspectTools(settings.get(), probeFilesystem))
      }),
    "fpga-workbench: toolchain prompt section"
  );

  // 设置页的状态接口。webServer 在 headless/CLI 部署里不存在,拿不到就跳过这一步 ——
  // 提示注入仍然生效,缺的只是设置页上的警告。
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
export const inject = ["settings", "systemPrompt"];
