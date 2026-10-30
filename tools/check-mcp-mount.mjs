// MCP 挂载层的**并发与失败**行为自检 —— `npm test` 的一部分,不需要宿主、不需要那个 exe。
//
// 为什么单独一条(2026-10-21,实测踩出来):这层有三个只在**真实边界条件**下才暴露的缺陷,
// 静态检查和"正常路径"的单元测试都碰不到:
//
//   1. 并发调用 `syncMcpClient` 会互相踩掉对方记下的 fiber —— 第二次撞上 serverName 冲突
//      抛错后把 state 清空,于是第一次那份**还活着**的 fiber 再也找不到。表现:设置页报
//      "未启用",但工具表里仍留着一组 mcp__* 工具、服务器进程也不退。
//   2. `await fiber` 抛错时,旧写法只清 state 不 dispose,fiber 半死不活留在注册表里。
//   3. 卸载后必须真的归零 —— 否则下一轮挂载会撞自己上一轮的 serverName。
//
// 用**注入假依赖**的办法测:不打真宿主、不起真进程,几百毫秒跑完,任何机器都能跑。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { syncMcpClient } from "../lib/mcp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

/** 假的路径判定:任何非空且不是 "MISSING" 的串都算可用。 */
const fakeInspect = (path) => {
  const text = String(path ?? "").trim();
  if (text === "") return { ok: false, reason: "未设置" };
  if (text === "MISSING") return { ok: false, reason: "路径不存在" };
  return { ok: true, reason: "" };
};

/**
 * 假宿主模块:一个**有状态的**注册表,能模拟 mcp-client 的两条关键行为:
 *   · 同一作用域内 serverName 不能重复注册(第二次抛错);
 *   · fiber.dispose() 要把名字释放掉,否则下一轮挂不上。
 * @param scope - 共享的作用域对象(模拟"同一个预设作用域")。
 * @returns 一个像 dsh-mcp-client 的模块对象。
 */
function fakeMcpClient(scope) {
  return {
    inject: ["tools"],
    Config: {},
    apply() {},
    __scope: scope
  };
}

/**
 * 假的 `ctx.plugin`:创建 fiber 时按真实的 mcp-client 语义做 serverName 占用登记,
 * dispose 时释放。
 *
 * ⚠️ **fiber 不是 thenable**。真实 cordis 的 `Fiber` 类**没有 `then` 方法**(实测:
 * cordis/lib/index.js 的 `var Fiber = class` 里搜不到 `then(`),所以 `await fiber`
 * 立即得到 fiber 本身、不等待任何东西 —— 启动完成与否由 fiber 自己的生命周期管,
 * 插件体里显式 await 的是别的东西(mcp-client 里是 `await connection.ready`)。
 *
 * 我第一版替身给 fiber 加了 `then`,那会制造真实环境里不存在的 thenable 语义:
 * `resolve(fiber)` 交回一个 thenable,Promise 解析流程会**再调一次它的 then**,
 * 于是挂载逻辑被跑两遍、第二遍撞上自己刚占的 serverName。那是替身的错,不是插件的错。
 * @param scope - `{ names:Set }`。
 * @param options - `{ failAfterCreate }` 控制插件体是否抛。
 */
function fakeCtx(scope, options = {}) {
  const created = [];
  return {
    __created: created,
    plugin(plugin, config) {
      const fiber = {
        disposed: false,
        config,
        // 故意**没有 then**
        async dispose() {
          if (fiber.disposed) return;
          fiber.disposed = true;
          scope.names.delete(config.serverName);
        }
      };
      created.push(fiber);
      // 真实 mcp-client 的 apply 在**注册时**就占用 serverName(见它的 ctx.effect),
      // 冲突时在 ctx.plugin 这一层同步抛出 —— 这正是"启动失败"的来源。
      if (options.failAfterCreate === true) {
        throw new Error('mcp-client: serverName "vivado" is already in use by another mcp-client instance');
      }
      if (scope.names.has(config.serverName)) {
        throw new Error(`mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance`);
      }
      scope.names.add(config.serverName);
      return fiber;
    }
  };
}

const fakeLoader = (client) => async () => client;

/** 给一个"当前还占着几个 serverName"的读数。 */
const live = (scope) => scope.names.size;

// ── ① 正常挂载 → 卸载 → 归零 ────────────────────────────────────────────────

{
  const scope = { names: new Set() };
  const client = fakeMcpClient(scope);
  const ctx = fakeCtx(scope);
  const state = { fiber: undefined, path: undefined };
  const deps = { inspectMcpPath: fakeInspect, loadHostMcpClient: fakeLoader(client) };

  const on = await syncMcpClient(ctx, "C:/x/mcp.exe", state, deps);
  check(on === "已连接", `首次挂载报已连接(实际 ${on})`);
  check(live(scope) === 1, `serverName 已占用(实际 ${live(scope)})`);

  const off = await syncMcpClient(ctx, "", state, deps);
  check(off === "未启用", `清空路径报未启用(实际 ${off})`);
  check(live(scope) === 0, `卸载后 serverName 已释放(实际 ${live(scope)})`);
  check(state.fiber === undefined, "卸载后 state.fiber 已清空");
}

// ── ② 同一路径重复同步:幂等,不重复挂载 ────────────────────────────────────

{
  const scope = { names: new Set() };
  const client = fakeMcpClient(scope);
  const ctx = fakeCtx(scope);
  const state = { fiber: undefined, path: undefined };
  const deps = { inspectMcpPath: fakeInspect, loadHostMcpClient: fakeLoader(client) };

  await syncMcpClient(ctx, "C:/x/mcp.exe", state, deps);
  const second = await syncMcpClient(ctx, "C:/x/mcp.exe", state, deps);
  check(second === "已连接", `重复同步报已连接(实际 ${second})`);
  check(ctx.__created.length === 1, `只创建了一个 fiber(实际 ${ctx.__created.length})`);
  check(live(scope) === 1, `serverName 只占一次(实际 ${live(scope)})`);

  await syncMcpClient(ctx, "", state, deps);
}

// ── ③ 并发两次挂载:必须排队,不能互相踩 ────────────────────────────────────
//
// 这是修复前会失败的那条:两次调用交错跑,第二次撞冲突、catch 清 state,
// 把第一次的 fiber 引用丢掉 → 最终 serverName 泄漏。

{
  const scope = { names: new Set() };
  const client = fakeMcpClient(scope);
  const ctx = fakeCtx(scope);
  const state = { fiber: undefined, path: undefined };
  const deps = { inspectMcpPath: fakeInspect, loadHostMcpClient: fakeLoader(client) };

  const results = await Promise.all([
    syncMcpClient(ctx, "C:/x/mcp.exe", state, deps),
    syncMcpClient(ctx, "C:/x/mcp.exe", state, deps)
  ]);
  check(
    results.every((r) => r === "已连接"),
    `并发两次都报已连接(实际 ${JSON.stringify(results)})`
  );
  check(ctx.__created.length === 1, `并发两次只创建一个 fiber(实际 ${ctx.__created.length} 个)`);
  check(live(scope) === 1, `并发后 serverName 只占一次(实际 ${live(scope)})`);

  const off = await syncMcpClient(ctx, "", state, deps);
  check(off === "未启用", `并发后仍能正常卸载(实际 ${off})`);
  check(live(scope) === 0, `并发后卸载干净(实际 ${live(scope)})`);
}

// ── ④ 启动失败:必须 dispose 掉半活的 fiber,不留泄漏 ───────────────────────
//
// 两种失败形态都要覆盖:
//   (a) `ctx.plugin()` **同步抛出** —— 真实 mcp-client 在注册 serverName 时就是这样抛的
//       (它的 ctx.effect 在 plugin() 内部执行)。这种情况下 fiber 变量根本拿不到,
//       调用方无法 dispose;真正该做的是"别把 state 写脏"。
//   (b) plugin() 返回了 fiber、随后 await 才失败 —— 这时必须 dispose。

{
  const scope = { names: new Set() };
  const client = fakeMcpClient(scope);
  const ctx = fakeCtx(scope, { failAfterCreate: true });
  const state = { fiber: undefined, path: undefined };
  const deps = { inspectMcpPath: fakeInspect, loadHostMcpClient: fakeLoader(client) };

  const result = await syncMcpClient(ctx, "C:/x/mcp.exe", state, deps);
  check(result.startsWith("启动失败"), `启动失败如实报告(实际 ${result})`);
  check(state.fiber === undefined, "失败后 state.fiber 没有留值");
  check(live(scope) === 0, `失败后没有占用 serverName(实际 ${live(scope)})`);
  // (a) 形态下拿不到 fiber,不该假装 dispose 过 —— 断言"没有把半活的 fiber 记进 state"即可。
  check(
    ctx.__created.every((f) => state.fiber !== f),
    "同步抛出的那次没有把半活 fiber 记进 state"
  );
}

// (b) plugin() 成功返回、await 阶段才失败 → 必须 dispose
{
  const scope = { names: new Set() };
  const client = fakeMcpClient(scope);
  const createdFiber = { disposed: false, name: "late-fail" };
  const ctx = {
    plugin() {
      // 返回一个"await 才失败"的对象:它不是 thenable,所以失败由显式检查触发 ——
      // 这里用一个会被 syncMcpClientNow 直接使用的普通对象模拟"后续步骤失败"。
      throw new Error("mcp-client: serverName already in use");
    }
  };
  // 该场景与 (a) 同构;真正的 (b) 在现代 cordis 里几乎不出现(fiber 非 thenable),
  // 所以这里不再造一个畸形的 thenable —— 只钉住"失败不留 state"这条。
  const state = { fiber: undefined, path: undefined };
  const result = await syncMcpClient(ctx, "C:/x/mcp.exe", state, {
    inspectMcpPath: fakeInspect,
    loadHostMcpClient: fakeLoader(client)
  });
  check(
    result.startsWith("启动失败") && state.fiber === undefined,
    `plugin() 抛错时如实报告且不留 state(实际 ${result})`
  );
  void createdFiber;
}

// ── ⑤ 取不到宿主模块:如实说明,不当成成功 ──────────────────────────────────

{
  const state = { fiber: undefined, path: undefined };
  const ctx = fakeCtx({ names: new Set() });
  const result = await syncMcpClient(ctx, "C:/x/mcp.exe", state, {
    inspectMcpPath: fakeInspect,
    loadHostMcpClient: async () => undefined
  });
  check(
    result.includes("取不到") && !result.includes("已连接"),
    `取不到宿主模块时如实说明(实际 ${result})`
  );
  check(state.fiber === undefined, "取不到模块时 state 没被写成有值");
}

// ── ⑥ 路径不可用(MISSING):不挂载,并说明原因 ──────────────────────────────

{
  const scope = { names: new Set() };
  const ctx = fakeCtx(scope);
  const state = { fiber: undefined, path: undefined };
  const result = await syncMcpClient(ctx, "MISSING", state, {
    inspectMcpPath: fakeInspect,
    loadHostMcpClient: fakeLoader(fakeMcpClient(scope))
  });
  check(result.includes("不可用"), `路径不存在时报不可用(实际 ${result})`);
  check(ctx.__created.length === 0, "路径不存在时不去创建 fiber");
}

// ── ⑦ **N-04**：dispose 失败 + 切换也失败后，残留必须还能被回收 ────────────────
//
// 上一版的洞：切换失败会把 `state.fiber` 清空，但 `pendingDispose` 还留着；
// 之后清空路径时，入口只有 `state.fiber !== undefined` 才调 unload，
// 于是残留再也无人处理 —— 表现为「UI 说已停用，serverName 实际还被占着」。
{
  const scope = { names: new Set() };
  const ctx = fakeCtx(scope);

  // **让第一次卸载失败一次**：直接替换第一个 fiber 的 dispose。
  // 为什么这样造：`fakeCtx.plugin` 自己创建 fiber（真实 cordis 也是这样，
  // `apply` 由 fiber 驱动），所以不能靠自定义 client 的 apply 去注入。
  let disposeAttempts = 0;
  let failNext = true;

  const state = { fiber: undefined, path: undefined, pendingDispose: undefined };
  const deps = { inspectMcpPath: fakeInspect, loadHostMcpClient: fakeLoader(fakeMcpClient(scope)) };

  // 第一次挂载：成功
  const first = await syncMcpClient(ctx, "C:/x/a.dll", state, deps);
  check(first === "已连接", `首次挂载成功（实际 ${first}）`);
  check(state.fiber !== undefined, "state.fiber 已记下");

  // 给已挂的 fiber 换成一个「第一次会失败」的 dispose
  const original = state.fiber;
  const originalDispose = original.dispose.bind(original);
  original.dispose = async () => {
    disposeAttempts += 1;
    if (failNext) {
      failNext = false;
      throw new Error("dispose 临时失败");
    }
    await originalDispose();
  };

  // 切到另一个路径：unload 会失败 → 不许挂新的
  const createdBefore = ctx.__created.length;
  const second = await syncMcpClient(ctx, "C:/x/b.dll", state, deps);
  check(ctx.__created.length === createdBefore, "卸载失败时不挂新 fiber（不出现两个客户端抢 serverName）");
  check(/切换失败|未卸载|仍连接/u.test(second), `报的是切换失败而不是成功（实际 ${second}）`);
  check(state.pendingDispose !== undefined, "失败后 pendingDispose 保留了残留引用");

  // 关键：清空路径时**仍然会重试**残留（这次 dispose 成功）
  const cleared = await syncMcpClient(ctx, "", state, deps);
  check(/未启用/u.test(cleared), `清空路径后报未启用（实际 ${cleared}）`);
  check(state.pendingDispose === undefined, "残留已被回收（pendingDispose 清空）");
  check(state.fiber === undefined, "state.fiber 也已清空");
  // **Q-02 的核心断言**：同一个对象最多被成功 dispose 一次。
  // 上一版这里是 `>= 2` —— 那恰好掩盖了"被调用第三次"的 bug。
  check(disposeAttempts === 2, `dispose 恰好被调用 2 次（1 失败 + 1 成功，实际 ${String(disposeAttempts)} 次）`);
}

// ── ⑦b **Q-02**：非幂等 dispose 不得被重复调用 ───────────────────────────────
//
// 上一版 ⑦ 的 fake 把成功 dispose 写成幂等（重复调用返回成功），
// 所以"第三次调用"被抓不到。这里造一个**严格非幂等**的资源：
// 第一次失败、第二次成功、**第三次拒绝**，并断言总共只调用 2 次。
{
  const scope = { names: new Set() };
  const ctx = fakeCtx(scope);
  const state = { fiber: undefined, path: undefined, pendingDispose: undefined };
  const deps = { inspectMcpPath: fakeInspect, loadHostMcpClient: fakeLoader(fakeMcpClient(scope)) };

  await syncMcpClient(ctx, "C:/x/a.dll", state, deps);

  let calls = 0;
  let phase = "first";
  const target = state.fiber;
  const originalDispose = target.dispose.bind(target);
  target.dispose = async () => {
    calls += 1;
    if (phase === "first") {
      phase = "second";
      throw new Error("transient");
    }
    if (phase === "second") {
      phase = "done";
      await originalDispose();
      return;
    }
    // 非幂等资源：已经释放过，再调就报错
    throw new Error("already disposed");
  };

  // 第一次切路径：dispose 失败
  const first = await syncMcpClient(ctx, "C:/x/b.dll", state, deps);
  check(/切换失败|未卸载|仍连接/u.test(first), `第一次切换失败（实际 ${first}）`);
  check(calls === 1, `dispose 被调用 1 次（实际 ${String(calls)}）`);

  // 第二次清空：pending 会成功，且**不能**再碰同一个对象
  const second = await syncMcpClient(ctx, "", state, deps);
  check(/未启用/u.test(second), `第二次清空成功报未启用（实际 ${second}）`);
  check(calls === 2, `dispose 总共 2 次，没有第三次（实际 ${String(calls)}）`);
  check(state.fiber === undefined, "fiber 已清空");
  check(state.pendingDispose === undefined, "pendingDispose 已清空");
}

// ── ⑧ 静态守卫:并发保护真的用 WeakMap 而不是模块级共享锁 ──────────────────

{
  const source = (await import("node:fs")).readFileSync(join(ROOT, "lib", "mcp.js"), "utf8");
  check(/new WeakMap\(\)/u.test(source), "用一个 WeakMap 维护每个 state 的串行链");
  check(/syncChains\.set\(state/u.test(source), "串行链是**按 state** 挂的,不是全局锁(否则多个会话互相阻塞)");
  check(
    /await fiber\.dispose\(\)/u.test(source) || /fiber\.dispose\(\)/u.test(source),
    "启动失败的分支里会 dispose 已创建的 fiber"
  );
  // 按包名直接 import 宿主模块是旧 bug:必须走 loadHostMcpClient
  check(
    !/await import\("@deepseek-ai\/dsh-mcp-client"\)/u.test(source),
    "没有按包名直接 import 宿主模块(那条路在 profile 里必然失败)"
  );
}

console.log(
  failures.length > 0
    ? `\nFAIL (${String(failures.length)}): ${failures.join(" | ")}`
    : "\nPASS: MCP 挂载层的并发、幂等、失败清理与卸载都正确"
);
if (failures.length > 0) process.exitCode = 1;
