// 更真实的装载验证：模拟宿主「服务就绪后才调用 inject 回调」的行为。
//
// 上一版的问题：假 ctx 里 `inject(deps, cb)` 直接同步调 cb，而真实宿主是
// **服务就绪后**才调 —— 于是 webServer 那块从未真正执行过，测不到它会不会抛。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MINE = "C:/Work/dsh-plug-in/dsh-fpga-workbench";
const entry = join(MINE, "lib/index.js");
if (!existsSync(entry)) {
  console.error(`  ❌ 找不到 ${entry}`);
  process.exit(1);
}

const mod = await import(pathToFileURL(entry).href);

/** 造一个尽量接近宿主的 ctx。 */
const makeContext = (options) => {
  const log = [];

  const ctx = {
    log,
    effect: (callback, label) => {
      log.push(`effect(${label ?? "?"})`);
      const cleanup = callback();
      // **原样返回**：非函数句柄不能被包成函数（cordis 的契约）
      return typeof cleanup === "function" ? cleanup : (cleanup ?? (() => undefined));
    },
    inject: (deps, callback) => {
      log.push(`inject([${deps.join(",")}])`);
      if (options.inject === false) return;
      const scoped = { ...ctx, get: (name) => (options.services ?? {})[name] };
      try {
        callback(scoped);
        log.push("inject-cb-ok");
      } catch (error) {
        log.push(`inject-cb-THREW(${String(error?.message ?? error).slice(0, 60)})`);
        throw error;
      }
    },
    get: (name) => (options.services ?? {})[name],
    set: () => () => undefined,
    provide: () => () => undefined,
    on: () => () => undefined,
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined }
  };
  return ctx;
};

/** 假 webServer：记录 register 调用。 */
const fakeWebServer = () => {
  const routes = [];
  const add = (method) => (route, handler) => {
    routes.push(`${method} ${route} (${typeof handler})`);
    return () => undefined;
  };
  return { routes, register: add("ANY"), get: add("GET"), post: add("POST") };
};

const brokenWebServer = () => ({
  register: () => {
    throw new Error("EADDRINUSE: port busy");
  },
  get: () => {
    throw new Error("EADDRINUSE: port busy");
  },
  post: () => {
    throw new Error("EADDRINUSE: port busy");
  }
});

const fakeSettings = { describe: () => [], update: async () => undefined };

const trials = [
  { label: "宿主齐全（webServer + settings）", options: { services: { webServer: fakeWebServer(), settings: fakeSettings } } },
  { label: "只有 webServer", options: { services: { webServer: fakeWebServer() } } },
  { label: "只有 settings", options: { services: { settings: fakeSettings } } },
  { label: "空 ctx（什么都没有）", options: { services: {} } },
  { label: "ctx.inject 不存在", options: { inject: false, services: {} } },
  { label: "webServer.register 会抛（端口占用）", options: { services: { webServer: brokenWebServer(), settings: fakeSettings } } }
];

console.log("=== 真实形态的 apply() 装载验证 ===\n");

let failures = 0;
for (const trial of trials) {
  const ctx = makeContext(trial.options);
  let threw = "";
  try {
    mod.apply(ctx, {});
  } catch (error) {
    threw = String(error?.message ?? error).slice(0, 110);
    failures += 1;
  }

  const routes = trial.options.services?.webServer?.routes?.length ?? 0;
  console.log(`  ${threw === "" ? "✅" : "❌"} ${trial.label}`);
  console.log(`       ${ctx.log.join(" → ")}`);
  if (routes > 0) console.log(`       注册 ${String(routes)} 条路由：${trial.options.services.webServer.routes.slice(0, 3).join(", ")}`);
  if (threw !== "") console.log(`       异常: ${threw}`);
}

console.log("");
console.log(failures === 0 ? "  ✅ 六种场景 apply() 都不抛" : `  ❌ ${String(failures)} 个场景抛异常`);
process.exit(failures === 0 ? 0 : 1);
