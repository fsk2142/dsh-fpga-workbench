// 假 DSH 内核:照 dsh-client-modules 的真实语义加载并实例化一个客户端插件 bundle。
//
// 为什么需要它:插件加载失败时 DSH 只会说「did not provide an error message」,
// 而失败会把整个桌面端拦住不让启动。这个页把同一段加载路径搬到浏览器里跑,
// 于是任何失败都会变成一条真实堆栈,而且崩也只崩这个页面。
//
// 它复刻的契约(全部照 C:\Program Files\DSH Desktop\...\dsh-client-modules\lib\index.js):
//   1. bundle 以 window.__ModuleLoader__.load({id, factory}) 注册,只注册不执行
//   2. 物化 = factory(require) → exports,在 loadCache 里记忆化,require 循环抛错
//   3. require 先查基座模块表,再查已注册 factory,其他一律抛错
//   4. 插件 bundle 必须导出 apply
//   5. ctx.slots / ctx.layout 由别的插件提供;slots.inject 在父槽未声明时等待

const results = [];
let failed = 0;

/** 记录一条断言结果,并同步打印到页面。 */
function check(ok, label, detail) {
  if (!ok) failed += 1;
  results.push({ ok, label, detail });
  const line = `${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`;
  console.log(line);
  render();
}

/** 捕获任何未处理错误,绝不让失败只留下一条空白。 */
function fatal(label, error) {
  check(false, label, error && error.stack ? error.stack : String(error));
}

function render() {
  const pre = document.getElementById("out");
  pre.textContent =
    `${failed === 0 ? "PASS" : `FAIL (${String(failed)})`}  —— 共 ${String(results.length)} 项\n\n` +
    results.map((r) => `${r.ok ? "ok  " : "FAIL"}  ${r.label}${r.detail === undefined ? "" : `\n        ${r.detail}`}`).join("\n");
}

window.addEventListener("error", (event) => fatal("window.onerror", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => fatal("unhandledrejection", event.reason));

// ── 基座模块表:内核的冻结表里只有 React 这类共享库 ───────────────────────────

/** 极简 React:只提供这个 bundle 用到的入口,返回可检查的普通对象。 */
const React = {
  createElement(type, props, ...children) {
    return { __element: true, type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect(effect) {
    // 同步执行一次,让 effect 里的错误在这里暴露而不是被吞掉
    const cleanup = effect();
    return typeof cleanup === "function" ? cleanup : undefined;
  },
  /**
   * useRef 必须真的保存值:面板靠它保证「挂载即新建会话」只发生一次。
   * 返回一个每次都是新对象的假 ref,会让那个守卫失效,而测试本该抓住那种回归。
   */
  useRef(initial) {
    return { current: initial };
  }
};

const PLATFORM = new Map([
  ["react", React],
  ["react/jsx-runtime", { jsx: React.createElement, jsxs: React.createElement }],
  ["react-dom", { createRoot: () => ({ render() {}, unmount() {} }) }]
]);

// ── 内核:注册 → 物化 → 实例化 ───────────────────────────────────────────────

const kernel = {
  /** 注册表:id → factory。对应 loadCache 之前的 pendingQueue。 */
  registry: new Map(),
  /** 物化记忆表,对应 loadCache。 */
  loadCache: new Map(),
  /** 物化过程中的栈,用来检测 require 循环(内核对此抛错)。 */
  materializing: new Set(),

  /** 物化一个已注册的模块,语义同内核的 factory(require) → exports。 */
  materialize(id) {
    if (this.loadCache.has(id)) return this.loadCache.get(id);
    const registration = this.registry.get(id);
    if (registration === undefined) {
      throw new Error(`kernel: module "${id}" is neither in the platform table nor registered`);
    }
    if (this.materializing.has(id)) {
      throw new Error(`kernel: require cycle through "${id}" — factory-form CJS cannot provide partial exports`);
    }
    this.materializing.add(id);
    try {
      const exports = registration.factory((specifier) => this.require(specifier));
      if (typeof exports !== "object" || exports === null) {
        throw new Error(`kernel: module "${id}" factory returned ${typeof exports}, expected an object`);
      }
      this.loadCache.set(id, exports);
      return exports;
    } finally {
      this.materializing.delete(id);
    }
  },

  /** require 的解析顺序:基座模块表 → 已物化记录 → 已注册 factory → 抛错。 */
  require(specifier) {
    if (PLATFORM.has(specifier)) return PLATFORM.get(specifier);
    if (this.loadCache.has(specifier)) return this.loadCache.get(specifier);
    if (this.registry.has(specifier)) return this.materialize(specifier);
    throw new Error(`kernel: cannot resolve module "${specifier}" (not in the platform table, not registered)`);
  }
};

// 内核在页面加载前就注入这个队列对象;bundle 的顶层只做注册。
window.__ModuleLoader__ = { load: (registration) => kernel.registry.set(registration.id, registration) };

// ── 假 slots 服务:复刻 dsh-client-ui-renderer 的 SlotRegistry 行为 ───────────

const slots = {
  /** 已声明的槽:key → 声明的子槽表。对应 slots._core 的声明表。 */
  declarations: new Map(),
  /** 等待父槽声明的挂起项,对应 subscribeDeclaration + reconcile。 */
  waiting: new Map(),
  /** 实际注册进来的行,按槽名归档。 */
  entries: new Map(),
  /** inject 调用记录,给「缺失父槽会不会抛错」这类事实留证据。 */
  injectCalls: [],

  _addEntry(slot, options, component) {
    if (!this.entries.has(slot)) this.entries.set(slot, []);
    this.entries.get(slot).push({ options, component });
  },

  register(options, component) {
    if (typeof options?.name !== "string") throw new Error("slots.register: options.name is required");
    this._addEntry(options.name, options, component);
    return () => {};
  },

  /**
   * 对应 SlotRegistry.inject:槽已声明就同步执行;未声明则挂起,等声明提交后执行。
   * 未声明的父槽**不抛错**——这正是官方插件依赖的行为。
   */
  inject(key, callback) {
    this.injectCalls.push(key);
    if (this.declarations.has(key)) {
      this.run(key, callback);
      return () => {};
    }
    if (!this.waiting.has(key)) this.waiting.set(key, []);
    this.waiting.get(key).push(callback);
    return () => {};
  },

  /** 执行一个待运行的注入回调:同步函数或 generator 都可(内核两者都支持)。 */
  run(key, callback) {
    const produced = callback();
    if (produced !== null && typeof produced === "object" && typeof produced.next === "function") {
      let step = produced.next();
      while (!step.done) step = produced.next();
    }
  },

  /** 模拟某个槽被声明:唤醒所有等待它的注入。 */
  declare(key) {
    this.declarations.set(key, {});
    const pending = this.waiting.get(key) ?? [];
    this.waiting.delete(key);
    for (const callback of pending) this.run(key, callback);
  }
};

// ── 假 layout 服务:复刻 selectPanel 的 key 匹配与抛错 ───────────────────────

const layout = {
  activePanelId: null,
  selectPanel(panelId) {
    if (panelId !== null) {
      const known = (slots.entries.get("main") ?? []).some((entry) => entry.options.key === panelId);
      if (!known) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
    }
    this.activePanelId = panelId;
  }
};

// ── 假 uiWorkspace 服务:记录新建会话的调用,并提供工作区列表 ───────────────
//
// 列表形状照宿主(dsh-workspace 的记录是 { path, title, workspaceId })—— 实现要按
// workbench.json 的 workspace 路径匹配出 workspaceId,这是"会话落在正确分组下"的关键。

const uiWorkspace = {
  calls: [],
  opened: [],
  workspaces: {
    list: {
      getSnapshot: () => ({
        phase: "ready",
        items: [
          {
            workspaceId: "ws-fpga",
            path: "C:\\Work\\dsh-fpga-workbench",
            title: "FPGA 工作台",
            sessionIds: ["s-old", "s-new"]
          },
          { workspaceId: "ws-other", path: "C:\\Work\\FPGA_Files", title: "FPGA_Files", sessionIds: ["s-other"] }
        ]
      })
    }
  },
  sessions: {
    list: {
      getSnapshot: () => ({
        phase: "ready",
        current: "s-new",
        byId: {
          "s-old": { id: "s-old", title: "旧会话", updatedAt: "2026-09-18T03:00:00.000Z" },
          "s-new": { id: "s-new", title: "测试", updatedAt: "2026-09-18T06:27:00.000Z" },
          "s-other": { id: "s-other", title: "别人的会话", updatedAt: "2026-09-18T05:00:00.000Z" }
        }
      })
    }
  },
  startSession(workspaceId) {
    this.calls.push(workspaceId);
  },
  openSession(sessionId) {
    this.opened.push(sessionId);
  }
};

const ctx = { slots, layout, uiWorkspace, effect: (fn) => fn() };

window.__harness = { kernel, slots, layout, uiWorkspace, ctx, check, fatal, React, results, get failed() { return failed; } };
