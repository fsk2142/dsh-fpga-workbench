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

/**
 * 递归收集元素树里的所有元素(可按类型/类名过滤)。
 * 假 React 的 createElement 只造普通对象,不做渲染,所以要自己遍历。
 * @param root - 组件返回的元素。
 * @param predicate - 可选过滤。
 */
function elements(root, predicate) {
  const found = [];
  (function walk(node) {
    if (node === null || typeof node !== "object") return;
    if (node.__element === true && (predicate === undefined || predicate(node))) found.push(node);
    for (const child of node.children ?? []) walk(child);
  })(root);
  return found;
}

/** 取一个元素树里某类名按钮的文本(用于断言渲染内容)。 */
function textOf(element) {
  const parts = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (typeof node !== "object") return;
    for (const child of node.children ?? []) walk(child);
  })(element);
  return parts.join("");
}

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
//
// useRef 必须真的保存值:`WorkbenchPanel` 靠它保证自动新建会话只发生一次。
// 如果这里返回一个每次都是新对象的假 ref,那个"只开一次"的守卫就失效,
// 而这个测试本该抓住那种回归。
const React = {
  createElement: (type, props, ...children) => ({ __element: true, type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: (effect) => {
    const cleanup = effect();
    return typeof cleanup === "function" ? cleanup : undefined;
  },
  useRef: (initial) => ({ current: initial })
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

/**
 * uiWorkspace 的替身:记录会话动作,并提供工作区列表与会话快照。
 *
 * 两个列表的形状都照宿主:
 *   工作区记录是 { path, title, workspaceId }(dsh-workspace:209-222)
 *   会话快照是 { phase, byId, current } —— byId[id] 里有 title / updatedAt
 * 实现要用它们渲染"这个工作台里的会话"列表,所以形状必须一致。
 */
const uiWorkspace = {
  /** 每次 startSession 的 workspaceId。 */
  calls: [],
  /** 每次 openSession 的 sessionId。 */
  opened: [],
  /**
   * 工作区列表是否已就绪。默认 false —— 模拟插件加载的很早期,那时列表还是空的。
   * 这个开关是回归测试的关键:实现若只在 apply 时解析一次 id,就会永远拿到 undefined,
   * 会话于是落到"当前/最近"的分组(用户报的"跑到别的分区"正是这个)。
   */
  ready: false,
  workspaces: {
    list: {
      getSnapshot: () => ({
        phase: uiWorkspace.ready ? "ready" : "loading",
        items: uiWorkspace.ready
          ? [
              {
                workspaceId: "ws-fpga",
                path: "C:\\Work\\dsh-fpga-workbench",
                title: "FPGA 工作台",
                sessionIds: ["s-old", "s-new"]
              },
              { workspaceId: "ws-other", path: "C:\\Work\\FPGA_Files", title: "FPGA_Files", sessionIds: ["s-other"] }
            ]
          : []
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

  // apply 会拉一次注册表来解析目标工作区,所以必须在它之前把 fetch 替换掉。
  const FETCHED = { workspace: "C:\\Work\\dsh-fpga-workbench", projects: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(FETCHED) });

  // 父槽已声明
  slots.declare(ENTRY_SLOT);
  slots.declare("main");
  slots.declare("sidebar.workspaces");
  plugin.apply(ctx);
  const row = (slots.entries.get(ENTRY_SLOT) ?? [])[0];
  const panel = (slots.entries.get("main") ?? [])[0];
  const sidebarEntry = (slots.entries.get("sidebar.workspaces") ?? [])[0];
  check(row !== undefined && panel !== undefined, "两个槽都注册了行");
  check(row?.options.id === PANEL_ID, `入口行 id 正确(${row?.options.id})`);
  check(row?.options.label === LABEL, `入口行 label 正确(${row?.options.label})`);
  check(typeof row?.options.order === "number", `入口行带 order(${row?.options.order})`);
  check(panel?.options.key === PANEL_ID, `面板 key 正确(${panel?.options.key})`);
  check(row?.options.id === panel?.options.key, "入口行 id === 面板 key");

  // 等注册表那次 fetch 落地,才能断言解析出的工作区
  await new Promise((resolve) => setTimeout(resolve, 0));

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

  // 等最后一次 apply 的注册表 fetch 落地。
  // 注意:每次 apply 都会重新解析并重新绑定 startSession,所以必须等**最后一次** ——
  // 只等第一次会让面板用上尚未解析完成的那个绑定,测试就会误报 undefined。
  await new Promise((resolve) => setTimeout(resolve, 0));

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

  // 回归测试:工作区列表在 apply 时还没就绪,到点击时才就绪。
  //
  // 这正是线上出过的 bug —— 实现只在 apply 时解析一次 workspaceId,那时列表是空的,
  // 拿到 undefined 就永远缓存着,于是会话落到"当前/最近"的分组(用户报的"跑到别的分区")。
  // 所以这里把 ready 留到此刻才打开:只有"点击时实时解析"的实现才能通过。
  check(uiWorkspace.ready === false, "apply 期间工作区列表尚未就绪(模拟真实时序)");
  uiWorkspace.ready = true;

  // 面板组件可调用 —— 它同时扮演"会话选择器"
  try {
    const panelElement = panel.component();
    check(panelElement?.__element === true, "面板组件返回元素");

    // 面板是**选择器**,不是"挂载即新建":挂载时不该产生任何会话动作,
    // 否则用户永远看不到这个列表(会被立刻跳走)。
    check(uiWorkspace.calls.length === 0, `面板挂载时不自动新建会话(实际 ${uiWorkspace.calls.length} 次)`);
    check(uiWorkspace.opened.length === 0, "面板挂载时不自动打开会话");

    /** 递归收集元素树里的按钮,按标题找。 */
    const buttons = elements(panelElement, (node) => node.type === "button");
    console.log(`      面板里的按钮:${buttons.length} 个`);

    // 会话列表:只列本工作台的会话,按更新时间倒序
    const sessionButtons = buttons.filter((b) => b.props?.className === "fpga-wb-session");
    check(sessionButtons.length === 2, `列出本工作台的 2 个会话(实际 ${sessionButtons.length})`);
    const texts = sessionButtons.map((b) => textOf(b));
    check(texts[0].includes("测试"), `最近的会话排在最前(第一项:${texts[0]})`);
    check(!texts.join(" ").includes("别人的会话"), "没有混进别的工作区的会话");

    // 点会话 → 打开它
    sessionButtons[0].props.onClick();
    check(uiWorkspace.opened.length === 1, `点会话会打开它(实际 ${uiWorkspace.opened.length} 次)`);
    check(uiWorkspace.opened[0] === "s-new", `打开的是被点的那一个(实际 ${String(uiWorkspace.opened[0])})`);

    // 「新建 FPGA 会话」按钮:建在注册表 workspace 路径对应的那个工作区里。
    // 不指定 id 时服务会挑"当前 → 最近用过的",会话就落到别的分组 —— 用户报的正是这个。
    const createButton = buttons.find((b) => b.props?.className === "fpga-wb-action");
    check(createButton !== undefined, "面板里有「新建 FPGA 会话」按钮");
    createButton.props.onClick();
    check(uiWorkspace.calls.length === 1, `点按钮新建一次会话(实际 ${uiWorkspace.calls.length} 次)`);
    check(
      uiWorkspace.calls[0] === "ws-fpga",
      `会话落在 FPGA 工作台对应的工作区(实际 ${String(uiWorkspace.calls[0])})`
    );
  } catch (error) {
    check(false, "面板组件", error.stack);
  }

  // ── 会话区替换(盖掉官方那一个)────────────────────────────────────────────
  try {
    check(sidebarEntry !== undefined, "注册进了 sidebar.workspaces");

    // 必须用负数优先级:single 槽"优先级低的赢",官方在 0;若用 >=0 同优先级会直接抛错。
    check(
      typeof sidebarEntry?.options.priority === "number" && sidebarEntry.options.priority < 0,
      `会话区替换用负数优先级(实际 ${String(sidebarEntry?.options.priority)})`
    );
    // 不能声明子槽 —— 声明已被声明的子槽会抛错(插件加载失败 → 桌面端起不来)
    check(sidebarEntry?.options.children === undefined, "替换条目没有声明子槽");

    const tree = sidebarEntry.component();
    check(tree?.__element === true, "会话区组件返回元素");

    // 关键:必须列出**所有**工作区,否则用户没法导航到别的会话
    const names = elements(tree, (n) => n.props?.className === "fpga-sb-name");
    check(names.length === 2, `列出全部 2 个工作区(实际 ${names.length})`);
    check(textOf(names[0]) === LABEL, `工作台分组排最前且显示为「${LABEL}」(实际 ${textOf(names[0])})`);
    check(textOf(names[1]) === "FPGA_Files", `其余工作区保留自己的名字(实际 ${textOf(names[1])})`);
    check(
      elements(tree, (n) => n.props?.className === "fpga-sb-path").length === 2,
      "每个分组都显示工作文件夹路径"
    );

    // 点工作区**名字** = 在该工作区新建会话(用户指定的交互)
    uiWorkspace.calls.length = 0;
    names[1].props.onClick();
    check(
      uiWorkspace.calls.length === 1 && uiWorkspace.calls[0] === "ws-other",
      `点工作区名字在该工作区新建会话(实际 ${JSON.stringify(uiWorkspace.calls)})`
    );

    // 点会话名 = 打开它
    const sessionBtns = elements(tree, (n) => n.props?.className === "fpga-sb-session");
    check(sessionBtns.length === 3, `列出全部会话(完整套 3 个,含别的工作区的)(实际 ${sessionBtns.length})`);
    uiWorkspace.opened.length = 0;
    sessionBtns[0].props.onClick();
    check(uiWorkspace.opened.length === 1, `点会话会打开它(实际 ${uiWorkspace.opened.length} 次)`);

    // 收起箭头:收起后该分组的会话不再渲染
    const carets = elements(tree, (n) => n.props?.className === "fpga-sb-caret");
    check(carets.length === 2, `每个分组一个收起箭头(实际 ${carets.length})`);
    check(carets[0].props["aria-expanded"] === "true", "默认展开");
    carets[0].props.onClick();
    const collapsedTree = sidebarEntry.component();
    const collapsedSessions = elements(collapsedTree, (n) => n.props?.className === "fpga-sb-session");
    check(collapsedSessions.length === 1, `收起第一个分组后只剩另一组的会话(实际 ${collapsedSessions.length})`);
    const collapsedCaret = elements(collapsedTree, (n) => n.props?.className === "fpga-sb-caret")[0];
    check(collapsedCaret?.props["aria-expanded"] === "false", "收起后 aria-expanded 为 false");
    collapsedCaret.props.onClick();
    check(
      elements(sidebarEntry.component(), (n) => n.props?.className === "fpga-sb-session").length === 3,
      "再点一次恢复展开"
    );

    // 搜索:只留有命中的分组与会话
    const searchBox = elements(tree, (n) => n.props?.className === "fpga-sb-search")[0];
    check(searchBox !== undefined, "会话区有搜索框");
    searchBox.props.onChange({ target: { value: "测试" } });
    const searched = sidebarEntry.component();
    const searchedSessions = elements(searched, (n) => n.props?.className === "fpga-sb-session");
    check(searchedSessions.length === 1, `搜索「测试」只留 1 个会话(实际 ${searchedSessions.length})`);
    check(textOf(searchedSessions[0]).includes("测试"), "留下的是命中的那个");
    searchBox.props.onChange({ target: { value: "" } });
    check(
      elements(sidebarEntry.component(), (n) => n.props?.className === "fpga-sb-session").length === 3,
      "清空搜索后恢复全部会话"
    );
  } catch (error) {
    check(false, "会话区替换", error.stack);
  }

  // 路径匹配的健壮性:大小写与结尾分隔符不该影响结果
  try {
    const { registryPathFrom } = await import(new URL("../lib/index.js", import.meta.url));
    check(typeof registryPathFrom === "function", "宿主侧仍导出 registryPathFrom");
  } catch (error) {
    check(false, "加载宿主模块", error.stack);
  }

  globalThis.fetch = originalFetch;
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 测试页所用的加载语义与断言全部通过");
if (failures.length > 0) process.exitCode = 1;
