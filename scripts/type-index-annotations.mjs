// 批量给 src/index.ts 的 HTTP 处理器补类型（纯机械，只加类型标注）。
//
// 为什么用脚本而不是手改 15 处：同一个模式 `(req, res) =>` 反复出现，手改容易漏。
// 但**必须用绝对路径**——之前用 PowerShell 的相对路径把文件写空过两次。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "C:/Work/dsh-plug-in/dsh-fpga-workbench/src/index.ts";
copyFileSync(FILE, `${FILE}.pre-type-backup`);

let text = readFileSync(FILE, "utf8");
const before = text;

/** 记录每处替换是否命中，便于核对。 */
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

// ── 1. 所有 HTTP 处理器的 `(req, res)` ─────────────────────────────────────
replaceAll("handler: (req, res) => {", "handler: (req: HttpRequest, res: HttpResponse) => {", "handler (req, res)");
replaceAll("handler: (req, res) =>", "handler: (req: HttpRequest, res: HttpResponse) =>", "handler (req, res) 简写");

// ── 2. json() 的参数 ───────────────────────────────────────────────────────
replaceAll(
  "const json = (res, payload, status = 200) => {",
  "const json = (res: HttpResponse, payload: unknown, status = 200): void => {",
  "json(res, payload, status)"
);

// ── 3. 迁移函数与 apply/config 入口 ────────────────────────────────────────
replaceAll("function applyMigration(settings, ctx){", "function applyMigration(settings: SettingsFacade, ctx: HostContext): void {", "applyMigration");
replaceAll("function applyMigration(settings, ctx) {", "function applyMigration(settings: SettingsFacade, ctx: HostContext): void {", "applyMigration");
replaceAll("export function apply(ctx) {", "export function apply(ctx: HostContext): void {", "apply(ctx)");
replaceAll("function prepareSettings(ctx, config = {})", "function prepareSettings(ctx: HostContext, config: Record<string, unknown> = {})", "prepareSettings");
replaceAll("function readJsonBody(req, limit", "function readJsonBody(req: HttpRequest, limit", "readJsonBody req");
replaceAll("const readJsonBody = (req, limit", "const readJsonBody = (req: HttpRequest, limit", "readJsonBody arrow req");

// ── 4. chunk 参数（req.on("data") 的回调）──────────────────────────────────
replaceAll('req.on("data", (chunk) => {', 'req.on("data", (chunk: string) => {', 'chunk 参数');

// ── 5. inject 回调参数 ─────────────────────────────────────────────────────
replaceAll("ctx.inject([\"settings\"], (settingsCtx) => {", "ctx.inject([\"settings\"], (settingsCtx: HostContext) => {", "settingsCtx");
replaceAll('ctx.inject(["settings"], (settingsCtx) => {', 'ctx.inject(["settings"], (settingsCtx: HostContext) => {', "settingsCtx");

// ── 6. effect 里带着 webCtx 的那类 ─────────────────────────────────────────
replaceAll("(webCtx) => {", "(webCtx: HostContext) => {", "webCtx");

// ── 7. patch 参数 ─────────────────────────────────────────────────────────
replaceAll("update: async (patch) => {", "update: async (patch: Record<string, unknown>): Promise<Record<string, unknown>> => {", "facade.update patch");
replaceAll(".find((entry) => entry?.ns === NS)", ".find((entry: { ns?: string; value?: unknown }) => entry?.ns === NS)", "find entry");

if (text === before) {
  console.error("没有任何替换生效，放弃。");
  process.exit(1);
}

writeFileSync(FILE, text, "utf8");
console.log(applied.join("\n"));
console.log(`\n原文件已备份为 ${FILE}.pre-type-backup`);
