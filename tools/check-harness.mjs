// 在 Node 里跑一遍与浏览器测试页相同的加载语义与断言。
//
// 目的不是替代浏览器测试,而是先确认**测试页本身没有 bug**:否则用户打开页面
// 看到一片红,却分不清是插件坏了还是测试坏了。
//
// 这里的 DOM 是最小替身:只提供 bundle 真正用到的那几个 API。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * 两个标识符不是一回事,bundle 里都是对的,断言必须分清:
 *   MODULE_ID —— 模块身份,必须是包名,内核用它对账启动图;
 *   PANEL_ID  —— 面板身份,侧边栏行的 id 与 main 面板的 key,内核按它匹配点击。
 */
const MODULE_ID = "dsh-fpga-workbench";
const PANEL_ID = "fpga-workbench";
const LABEL = "FPGA 工作台";
/**
 * 入口所在的槽:list 槽,侧边栏为第三方预留。
 *
 * 侧边栏渲染这一槽的每一行为一个 glyph 行,`order` 决定它排在官方保留行之后的哪个
 * 位置,行自身负责调用 `layout.selectPanel(id)` —— 所以插件只需要交出 id/label/字形。
 */
const ENTRY_SLOT = "sidebar.panellist";

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// ── 最小 DOM 替身 ────────────────────────────────────────────────────────────
const styleNodes = [];
globalThis.document = {
  querySelector: (selector) => styleNodes.find((node) => node.attrs["data-fpga-workbench"] !== undefined && selector.includes("fpga-workbench")) ?? null,
  createElement: (tag) => {
    const node = { tag, attrs: {}, textContent: "", setAttribute: (k, v) => { node.attrs[k] = v; } };
    return node;
  },
  head: { append: (node) => styleNodes.push(node) }
};

// ── 最小 React:只提供 bundle 用到的入口 ─────────────────────────────────────
const React = {
  createElement: (type, props, ...children) => ({ __element: true, type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: (effect) => {
    const cleanup = effect();
    return typeof cleanup === "function" ? cleanup : undefined;
  }
};

// ── 内核语义 ────────────────────────────────────────────────────────────────
const PLATFORM = new Map([["react", React]]);
const registry = new Map();
const loadCache = new Map();

const kernelRequire = (specifier) => {
  if (PLATFORM.has(specifier)) return PLATFORM.get(specifier);
  if (loadCache.has(specifier)) return loadCache.get(specifier);
  const registration = registry.get(specifier);
  if (registration !== undefined) return materialize(specifier);
  throw new Error(`kernel: cannot resolve module "${specifier}"`);
};

function materialize(id) {
  if (loadCache.has(id)) return loadCache.get(id);
  const registration = registry.get(id);
  if (registration === undefined) throw new Error(`kernel: module "${id}" is not registered`);
  const exports = registration.factory(kernelRequire);
  loadCache.set(id, exports);
  return exports;
}

globalThis.window = { __ModuleLoader__: { load: (registration) => registry.set(registration.id, registration) } };

// 加载 bundle:内核的 __ModuleLoader__ 必须先就位(上面已设)
const source = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
new Function("window", source)(globalThis.window);

// ── 假 slots(复刻 SlotRegistry.inject 的等待语义)──────────────────────────
const slots = {
  declarations: new Set(),
  waiting: new Map(),
  entries: new Map(),
  injectCalls: [],
  register(options, component) {
    if (typeof options?.name !== "string") throw new Error("slots.register: options.name is required");
    if (!this.entries.has(options.name)) this.entries.set(options.name, []);
    this.entries.get(options.name).push({ options, component });
    return () => {};
  },
  inject(key, callback) {
    this.injectCalls.push(key);
    if (this.declarations.has(key)) {
      runCallback(key, callback);
      return () => {};
    }
    if (!this.waiting.has(key)) this.waiting.set(key, []);
    this.waiting.get(key).push(callback);
    return () => {};
  },
  declare(key) {
    this.declarations.add(key);
    const pending = this.waiting.get(key) ?? [];
    this.waiting.delete(key);
    for (const callback of pending) runCallback(key, callback);
  }
};

function runCallback(key, callback) {
  const produced = callback();
  if (produced !== null && typeof produced === "object" && typeof produced.next === "function") {
    let step = produced.next();
    while (!step.done) step = produced.next();
  }
}

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

const ctx = { slots, layout, effect: (fn) => fn() };

// ── 与测试页相同的断言序列 ──────────────────────────────────────────────────

check(registry.size === 1, `bundle 注册了 1 个 factory(实际 ${registry.size})`);
const [id] = [...registry.keys()];
check(id === MODULE_ID, `bundle 模块 id 等于包名(${id})`);

let plugin = null;
try {
  plugin = materialize(MODULE_ID);
  check(true, "物化成功(factory(require) → exports)");
} catch (error) {
  check(false, "物化失败", error.stack);
}

if (plugin !== null) {
  check(typeof plugin.apply === "function", "导出 apply");
  // 客户端插件的服务注入契约是数组,不是对象。形状错了 apply 会拿到没有 slots 的
  // ctx,第一行就抛 TypeError —— 而宿主只回一句「没有错误信息」。
  check(Array.isArray(plugin.inject), `inject 是数组(实际 ${JSON.stringify(plugin.inject)})`);
  check(
    Array.isArray(plugin.inject) && plugin.inject.every((name) => typeof name === "string"),
    "inject 每一项都是字符串(服务名)"
  );

  // 父槽已声明
  slots.declare(ENTRY_SLOT);
  slots.declare("main");
  plugin.apply(ctx);
  const row = (slots.entries.get(ENTRY_SLOT) ?? [])[0];
  const panel = (slots.entries.get("main") ?? [])[0];
  check(row !== undefined && panel !== undefined, "两个槽都注册了行");
  check(row?.options.id === PANEL_ID, `入口行 id 正确(${row?.options.id})`);
  check(row?.options.label === LABEL, `入口行 label 正确(${row?.options.label})`);
  check(typeof row?.options.order === "number", `入口行带 order(${row?.options.order})`);
  check(panel?.options.key === PANEL_ID, `面板 key 正确(${panel?.options.key})`);
  check(row?.options.id === panel?.options.key, "入口行 id === 面板 key");

  // 父槽后声明(内核的等待语义)
  slots.entries.clear();
  slots.declarations.clear();
  slots.waiting.clear();
  slots.injectCalls.length = 0;
  plugin.apply(ctx);
  check(slots.entries.size === 0, "父槽未声明时不注册、只挂起");
  check(slots.injectCalls.includes(ENTRY_SLOT), `apply 请求了入口槽(${slots.injectCalls.join(", ")})`);
  slots.declare(ENTRY_SLOT);
  slots.declare("main");
  check((slots.entries.get(ENTRY_SLOT) ?? []).length === 1, "父槽后声明时挂起的注册被执行");

  // selectPanel 与「切进去 / 切回来」:侧边栏的行会自己调这个方法
  layout.selectPanel(PANEL_ID);
  check(layout.activePanelId === PANEL_ID, "selectPanel 能切到本面板(侧边栏行点击走这条路)");
  layout.selectPanel(null);
  check(layout.activePanelId === null, "selectPanel(null) 能切回会话");

  // 入口字形:侧边栏把行渲染成 { size, active },组件只该返回一个 mark,不该是按钮
  const glyph = row.component({ size: 18, active: false });
  check(glyph?.__element === true, "入口字形返回元素(不是 undefined)");
  check(glyph?.type === "svg", `入口字形是 svg(实际 ${String(glyph?.type)})`);
  check(glyph?.props?.width === 18, `入口字形采用传入的 size(${String(glyph?.props?.width)})`);
  const defaultSize = row.component({});
  check(defaultSize?.props?.width === 18, "不传 size 时有合理默认值");

  // 反向防呆:侧边栏行不是按钮 —— 若实现退回"自己造一个 button + 自己切换",
  // 就说明它又在依赖槽不提供的 props。
  check(glyph?.type !== "button", "入口不是自造按钮(切换由侧边栏行负责)");

  // 面板组件可调用
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ projects: [] }) });
  try {
    const panelElement = panel.component();
    check(panelElement?.__element === true, "面板组件返回元素");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 测试页所用的加载语义与断言全部通过");
if (failures.length > 0) process.exitCode = 1;
