// 宿主路由的行为验证:对真实 HTTP 请求检查三种数据状态。
//
// 这里验证的是"面板永远拿得到一份可渲染的数据"这条不变量 —— workbench.json 缺失是
// 首次运行的正常状态,不是故障;损坏的 JSON 要变成面板上的一句说明,而不是静默空白。
import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REGISTRY = join(ROOT, "workbench.json");
const SHADOW = join(ROOT, ".tmp", "workbench.json.shadow");

const host = await import(new URL("../lib/index.js", import.meta.url));

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

check(typeof host.apply === "function", "宿主入口导出 apply");

let route;
const webCtx = {
  webServer: { register: (r) => ((route = r), () => {}) },
  effect: (fn) => (fn(), () => {})
};
host.apply({ inject: (_deps, cb) => cb(webCtx) });
check(route?.kind === "exact", "注册的是 exact 路由");
check(route?.path === "/plugins/fpga-workbench/data", "路由路径正确");

const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}${route.path}`;
const get = async () => {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
};

// 1. 正常状态
await writeFile(
  REGISTRY,
  `${JSON.stringify({ workspace: "C:\\Work\\demo", projects: [{ name: "m1", path: "C:\\Work\\demo\\m1", stage: "sim" }] }, null, 2)}\n`
);
let result = await get();
check(result.status === 200, "正常注册表:HTTP 200");
check(result.body.projects?.length === 1, "正常注册表:projects 被读出");
check(result.body.projects?.[0]?.name === "m1", "正常注册表:项目字段保留");

// 2. 文件缺失(首次运行的正常状态)
await rename(REGISTRY, SHADOW);
result = await get();
check(result.status === 200, "文件缺失:仍然 200(不是 500)");
check(Array.isArray(result.body.projects) && result.body.projects.length === 0, "文件缺失:返回空列表");
check(result.body.error === undefined, "文件缺失:不算错误");

// 3. JSON 损坏
await writeFile(REGISTRY, "{ this is not json");
result = await get();
check(result.status === 200, "JSON 损坏:仍然 200");
check(typeof result.body.error === "string", "JSON 损坏:error 字段带原因");
check(Array.isArray(result.body.projects), "JSON 损坏:projects 仍是数组(面板可渲染)");

// 4. 顶层不是对象
await writeFile(REGISTRY, "[1,2,3]");
result = await get();
check(typeof result.body.error === "string", "顶层是数组:带 error 而不是静默通过");

// 5. 恢复原文件
await rename(SHADOW, REGISTRY);
server.close();

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 宿主路由在四种数据状态下都返回可渲染结果");
if (failures.length > 0) process.exitCode = 1;
