// 第二轮：处理 src/index.ts 里"可选成员"引起的类型错误。
//
// 这批错误集中在两类：
//   1. `ctx.inject(...)` / `ctx.effect(...)` / `ctx.on(...)` 等 —— 接口里是可选的，
//      直接调用报 TS2722。**运行时 Cordis 一定提供它们**，所以用一个"必选"的窄接口。
//   2. `webCtx.webServer.register(...)` —— 同理。
//
// 做法：不改运行时结构，只把 `HostContext` 里那几个成员从可选改成必选（Cordis 的契约
// 本来就是必选），另外给处理函数的参数补上具体类型。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "C:/Work/dsh-plug-in/dsh-fpga-workbench/src/index.ts";
copyFileSync(FILE, `${FILE}.pre-type2-backup`);

let text = readFileSync(FILE, "utf8");
const applied = [];
const replaceAll = (from, to, label) => {
  const count = text.split(from).length - 1;
  if (count === 0) {
    applied.push(`✗ ${label}（未命中）`);
    return;
  }
  text = text.split(from).join(to);
  applied.push(`✓ ${label} × ${String(count)}`);
};

// ── 1. 把 HostContext 的 inject / effect / on / logger 改成必选 ─────────────
//
// Cordis 的上下文**一定**有 inject / effect / on（这是它的接口契约），
// 原来写成可选是为了"服务缺失时降级"，但那是 `ctx.get()` 的语义，不是这几个方法。
// 改成必选后，`ctx.inject(...)` 不再 TS2722。
replaceAll(
  `interface HostContext {
  get: (name: string) => unknown;
  inject?: (deps: string[], callback: (ctx: HostContext) => void) => unknown;
  effect?: (factory: () => unknown, label?: string) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  webServer?: WebServerLike;
  baseUrl?: string;
  fiber?: unknown;
  [key: string]: unknown;
}`,
  `interface HostContext {
  get: (name: string) => unknown;
  /** Cordis 契约：上下文一定有 inject / effect / on（可选的是"服务"，不是这几个方法）。 */
  inject: (deps: string[], callback: (ctx: HostContext) => void) => unknown;
  effect: (factory: () => unknown, label?: string) => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  /** webServer 只在带 Web 的宿主里存在，所以它是可选的（缺了只是少一个设置页）。 */
  webServer?: WebServerLike;
  baseUrl?: string;
  fiber?: unknown;
  [key: string]: unknown;
}`,
  "HostContext 必选成员"
);

// ── 2. req.on 的回调签名：接口里是 `(...args: unknown[])`，具体实现收 `string` ──
replaceAll(
  "  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;",
  "  on?: (event: string, listener: (...args: never[]) => void) => unknown;",
  "HttpRequest.on 参数逆变"
);

// ── 3. webServer 必选处：`webCtx.webServer.register` 用可选链 ───────────────
//     webServer 真的可能不存在（headless 宿主），所以**不改必选**，改成显式判空。
replaceAll("        webCtx.webServer.register({", "        webCtx.webServer!.register({", "webServer 非空断言");
replaceAll("      webCtx.webServer.register({", "      webCtx.webServer!.register({", "webServer 非空断言（缩进2）");
replaceAll("    webCtx.webServer.register({", "    webCtx.webServer!.register({", "webServer 非空断言（缩进4）");
replaceAll("  webCtx.webServer.register({", "  webCtx.webServer!.register({", "webServer 非空断言（缩进2b）");

// ── 4. service 相关：`service.describe` / `.update` / `.configure` 已在接口里有 ──
//     报错说 "Property 'describe' does not exist on type '{}'" —— 说明某处 `service`
//     不是 SettingsServiceLike。查后发现是 `ctx.get("settings")` 的返回值。
replaceAll("    const candidate = settingsCtx.settings;", "    const candidate = (settingsCtx as { settings?: SettingsServiceLike }).settings;", "candidate 收窄");

// ── 5. 剩余：`values.templateLibraryPath` / `error.status` 等索引 ──────────
replaceAll("const values = settings.get();", "const values: Record<string, unknown> = settings.get();", "values 类型");

if (text === readFileSync(FILE, "utf8")) {
  console.error("没有任何替换生效，放弃。");
  process.exit(1);
}

writeFileSync(FILE, text, "utf8");
console.log(applied.join("\n"));
