// 宿主半侧:注册工具链设置,探测路径是否就绪,并给设置页一个只读状态接口。
//
// 三件事:
//   1. ctx.settings.register —— 「设置 → FPGA 工作台」的字段,存进 settings.yaml。
//   2. 探测 + 自动建缓存目录 —— 判定哪一项没就绪,并替用户建出缓存目录。
//   3. 只读 HTTP 路由 —— 设置页拿它显示状态(浏览器不能 stat 本地文件)。
//
// **配置全部在宿主侧**,所以图形界面和命令行跑的是同一份设置:CLI/headless 没有
// webServer 时只是少一个设置页,路径本身照常可用。自动建缓存目录也在宿主侧,两边都生效。
//
// **刻意不往会话提示里注入任何东西。** 提示段注册在插件行(profile 层),作用域是全局,
// 那样普通会话也会看到 FPGA 工具链的信息与警告,与"不影响正常会话"冲突。要按会话作用域
// 注入,得让 section 由预设组装来注册,而不是这里。目前的决定是只在设置页提示。

import { existsSync, mkdirSync, statSync } from "node:fs";

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
 * 缓存目录是写入目标,不是已经装好的工具 —— 配置了但还没创建时替用户建出来。
 *
 * 放在宿主侧:图形界面和命令行共用这一份配置,两边都需要那个目录存在。建不出来
 * (权限不足、盘符不存在)就不吭声,交给状态判定如实报"未就绪",而不是假装成功。
 * @param values - 设置解析后的值。
 */
export function ensureCacheDir(values) {
  const path = String(values?.cachePath ?? "").trim();
  if (path === "") return;
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // 建不出来就保持现状,由 statusOf 报未就绪
  }
}

/**
 * 当前状态:每项的存在情况 + 给设置页用的汇总。
 *
 * 五个字段都是必填(用户要求"路径都要"),所以任何一项没就绪都会进 `missing`。
 * @param values - 设置解析后的值。
 * @returns `{ tools, missing, ok }`;`tools` 每项带 `skips`,说明没就绪会跳过什么。
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
  const missing = tools.filter((tool) => !tool.present).map((tool) => tool.key);
  return { tools, missing, ok: missing.length === 0 };
}

/**
 * 挂载宿主半侧。
 * @param ctx - host plugin context carrying `settings`.
 */
export function apply(ctx) {
  const settings = ctx.settings.register(NS, SettingsSchema, { base: {} });

  // 开一次就先把缓存目录建出来,用户第一次打开设置页看到的就是就绪状态。
  ensureCacheDir(settings.get());

  // 设置页的状态接口。webServer 在 headless/CLI 部署里不存在 —— 拿不到就不注册这一步,
  // 设置项本身照常可读写,只是没有状态提示(GUI 与 CLI 共用同一份配置)。
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: STATUS_PATH,
          handler: (_req, res) => {
            const values = settings.get();
            // 每次查询都补一次:用户可能刚改了缓存路径,或手工删掉了那个目录
            ensureCacheDir(values);
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store"
            });
            res.end(JSON.stringify(statusOf(values)));
          }
        }),
      "fpga-workbench: toolchain status route"
    );
  });
}

export const name = "fpga-workbench";
export const inject = ["settings"];
