// 宿主路由的行为验证:对真实 HTTP 请求检查数据状态与配置覆盖。
//
// 这里验证的是"面板永远拿得到一份可渲染的数据"这条不变量 —— workbench.json 缺失是
// 首次运行的正常状态,不是故障;损坏的 JSON 要变成面板上的一句说明,而不是静默空白。
//
// ⚠️ 这个检查**绝不碰真实的 workbench.json**。
// 早期版本直接读写它,结果把用户的真实配置覆盖成了测试用的 demo 数据,而且"还原"时
// 还原的是 demo —— 表现为"会话总是落到别的工作区分组"(因为 workspace 路径不匹配了)。
// 现在所有用例都指向 .tmp/ 下的临时文件。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TMP = join(ROOT, ".tmp");
const TEST_REGISTRY = join(TMP, "route-test-registry.json");
const SHADOW = join(TMP, "route-test-registry.shadow.json");

const host = await import(new URL("../lib/index.js", import.meta.url));

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

check(typeof host.apply === "function", "宿主入口导出 apply");
check(typeof host.registryPathFrom === "function", "导出 registryPathFrom(配置解析可单独验证)");

/**
 * 挂载插件并返回一个真实的 HTTP 端点。
 * @param config - 传给 apply 的行配置。
 */
async function mount(config) {
  let route;
  const webCtx = {
    webServer: { register: (r) => ((route = r), () => {}) },
    effect: (fn) => (fn(), () => {})
  };
  host.apply({ inject: (_deps, cb) => cb(webCtx) }, config);
  if (route === undefined) throw new Error("apply 没有注册路由");
  const server = createServer((req, res) => route.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}${route.path}`;
  return {
    route,
    server,
    get: async () => {
      const response = await fetch(url);
      return { status: response.status, body: await response.json() };
    }
  };
}

// 真实文件必须保持不动 —— 先记下它的内容,结束时比对。
const REAL_REGISTRY = host.registryPathFrom(undefined);
const realBefore = await readFile(REAL_REGISTRY, "utf8").catch(() => null);

await mkdir(TMP, { recursive: true });

// ── 用例全部指向临时注册表 ──────────────────────────────────────────────────

const base = await mount({ registry: TEST_REGISTRY });
check(base.route.kind === "exact", "注册的是 exact 路由");
check(base.route.path === "/plugins/fpga-workbench/data", "路由路径正确");

await writeFile(
  TEST_REGISTRY,
  `${JSON.stringify({ workspace: "C:\\Work\\demo", projects: [{ name: "m1", path: "C:\\Work\\demo\\m1", stage: "sim" }] }, null, 2)}\n`
);
let result = await base.get();
check(result.status === 200, "正常注册表:HTTP 200");
check(result.body.projects?.length === 1, "正常注册表:projects 被读出");
check(result.body.projects?.[0]?.name === "m1", "正常注册表:项目字段保留");
check(result.body.registry === TEST_REGISTRY, "响应里带出实际读取的路径(排障用)");

// 文件缺失 = 首次运行的正常状态
await rename(TEST_REGISTRY, SHADOW);
result = await base.get();
check(result.status === 200, "文件缺失:仍然 200(不是 500)");
check(Array.isArray(result.body.projects) && result.body.projects.length === 0, "文件缺失:返回空列表");
check(result.body.error === undefined, "文件缺失:不算错误");

// JSON 损坏
await writeFile(TEST_REGISTRY, "{ this is not json");
result = await base.get();
check(result.status === 200, "JSON 损坏:仍然 200");
check(typeof result.body.error === "string", "JSON 损坏:error 字段带原因");
check(Array.isArray(result.body.projects), "JSON 损坏:projects 仍是数组(面板可渲染)");

// 顶层不是对象
await writeFile(TEST_REGISTRY, "[1,2,3]");
result = await base.get();
check(typeof result.body.error === "string", "顶层是数组:带 error 而不是静默通过");

base.server.close();

// ── config.registry 覆盖 ─────────────────────────────────────────────────────

const OVERRIDE = join(TMP, "route-test-override.json");
await writeFile(
  OVERRIDE,
  `${JSON.stringify({ workspace: "D:\\elsewhere", projects: [{ name: "override-proj", path: "D:\\elsewhere\\p" }] }, null, 2)}\n`
);
const overridden = await mount({ registry: OVERRIDE });
result = await overridden.get();
check(result.body.registry === OVERRIDE, "config.registry 被采用");
check(result.body.projects?.[0]?.name === "override-proj", "读到的是覆盖路径里的数据");
check(result.body.workspace === "D:\\elsewhere", "覆盖文件的内容被读回");

// 空字符串视为未配置,退回默认路径
const blank = await mount({ registry: "   " });
result = await blank.get();
check(result.body.registry === REAL_REGISTRY, "空 registry 配置退回默认路径");

overridden.server.close();
blank.server.close();

// ── 收尾:确认真实文件没被这个检查改动过 ────────────────────────────────────

const realAfter = await readFile(REAL_REGISTRY, "utf8").catch(() => null);
check(realAfter === realBefore, "真实 workbench.json 未被本次检查改动");

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 路由在数据异常与配置覆盖下都返回可渲染结果,且没碰真实配置"
);
if (failures.length > 0) process.exitCode = 1;
