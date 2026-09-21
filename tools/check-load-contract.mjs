// 加载契约的飞行前检查 —— 重启 DSH 之前跑一次,专门查"会让桌面端起不来"的那类问题。
//
// 为什么单独一个检查:这个插件历史上**两次**让桌面端起不来,根因都不是逻辑错,而是加载契约:
//   · 客户端 bundle 的 exports.inject 写成了对象(应该是服务名数组)→ apply 拿到缺服务的 ctx,
//     第一行抛 TypeError,而宿主只回一句 "did not provide an error message";
//   · loader 的 id 与包名不一致 / bundle 里出现相对 require → 整份组合加载失败。
// 这些错有个共同点:**静态看不出来,一启动就黑屏**。所以用机器逐条钉住。
//
// 查什么:
//   1. 所有会被加载的 .js/.mjs 语法是否通过(node --check)
//   2. lib/ 内部的相对 import 是否指向存在的文件,且导入的名字**真的被那个文件导出**
//      (改了一半的重命名就死在这条上)
//   3. 客户端 bundle 契约:loader id = 包名、exports.inject 是数组、无相对 require、无 static import
//   4. 宿主半侧:导出 apply / inject = ["settings"] / index.js 里不出现 systemPrompt
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");
const BUNDLED_TOOLS = join(ROOT, "presets", "fpga-workbench", "tools");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const manifest = JSON.parse(read("package.json"));

/**
 * 一套极小的 React 替身:够把客户端组件真的跑起来。
 *
 * 只实现设置页用到的那几个 hook:useState 存值(所以第二遍渲染能看到第一遍设的状态)、
 * useEffect 收集起来由调用方决定何时执行、createElement 返回可遍历的普通对象
 * (于是能在渲染树里找到某个按钮并"点"它)。
 *
 * **盲区(如实记下,不打算修)**:这个替身**不执行 useEffect 返回的清理函数**,所以客户端那处
 * 250ms 防抖的 `clearTimeout` 不会生效(旧定时器照跑)。下面那些"等 400ms"是用墙钟时间凑合出来的,
 * 也就是说**防抖本身没被验证**,只验证了"延迟之后确实问了一次状态"。
 * @returns `{ react, reset, runEffects, tree }`。
 */
function createFakeReact() {
  const states = [];
  const refs = [];
  const effects = [];
  let cursor = 0;
  return {
    react: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState: (initial) => {
        const index = cursor;
        cursor += 1;
        if (!(index in states)) states[index] = initial;
        return [
          states[index],
          (next) => {
            states[index] = typeof next === "function" ? next(states[index]) : next;
          }
        ];
      },
      useEffect: (fn) => {
        effects.push(fn);
      },
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      // 和 useState 一样**按槽位跨渲染保留**(真实 useRef 就是如此):客户端拿它存"代次",
      // 若每次渲染给个新对象,自增与比对就落在两个不同的对象上 —— 代次保护会假通过。
      useRef: (initial) => {
        const index = cursor;
        cursor += 1;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      }
    },
    /** 每次渲染前重置 hook 游标(状态本身保留)。 */
    reset: () => {
      cursor = 0;
    },
    /** 执行这一轮收集到的 effect。 */
    runEffects: () => {
      for (const fn of effects.splice(0)) fn();
    }
  };
}

/**
 * 在渲染树里找按钮。
 * @param node - createElement 的产物。
 * @param text - 按钮文字里包含的片段。
 * @returns 找到的节点,或 undefined。
 */
function findButton(node, text) {
  if (node === null || typeof node !== "object") return undefined;
  if (node.type === "button" && (node.children ?? []).some((child) => typeof child === "string" && child.includes(text))) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findButton(child, text);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 数一数树里有几个这样的按钮(用来断言"只有可检测的那一组有检测按钮")。
 * @param node - createElement 的产物。
 * @param text - 按钮文字里包含的片段。
 * @returns 个数。
 */
function countButtons(node, text) {
  if (node === null || typeof node !== "object") return 0;
  const self = node.type === "button" && (node.children ?? []).some((child) => typeof child === "string" && child.includes(text)) ? 1 : 0;
  return self + (node.children ?? []).reduce((sum, child) => sum + countButtons(child, text), 0);
}

/**
 * 在渲染树里找带某个 prop 的节点。
 * @param node - createElement 的产物。
 * @param predicate - 对 props 的判断。
 * @returns 找到的节点,或 undefined。
 */
function findByProp(node, predicate) {
  if (node === null || typeof node !== "object") return undefined;
  if (predicate(node.props ?? {})) return node;
  for (const child of node.children ?? []) {
    const found = findByProp(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 过滤框的识别条件(按占位文字,不依赖 class)。 */
const FILTER_BOX = (props) => typeof props.placeholder === "string" && props.placeholder.includes("打字过滤");

/**
 * 跑一遍客户端 bundle:喂假的 window / document / fetch / react,返回它注册的那份 spec。
 *
 * 组件里会碰 document(注入样式表)与 fetch(三条路由),Node 里都没有,所以按参数注入,
 * 而不是去改全局。
 * @param source - bundle 源码。
 * @param options - `{ fetch, react }` 替身。
 * @returns `{ id, factory }` 或 undefined。
 */
/**
 * 假的 document:够让客户端注入样式表,并**记下最后建出来的元素** ——
 * 测试要拿它模拟"浏览器的文件框里选中了文件"。
 * @returns document 替身。
 */
function createFakeDocument() {
  const stub = {
    inputsCreated: 0,
    querySelector: () => null,
    createElement: (tag) => {
      const element = {
        dataset: {},
        style: {},
        textContent: "",
        clicked: false,
        setAttribute() {},
        click() {
          element.clicked = true;
        }
      };
      // 数一数建了几个 <input>:设置页**不该**再借文件框弹系统窗口(用户口径:别用弹窗)
      if (tag === "input") stub.inputsCreated += 1;
      stub.lastCreated = element;
      return element;
    },
    head: { append() {} }
  };
  return stub;
}

function runBundle(source, options) {
  let registered;
  const documentStub = options.document ?? createFakeDocument();
  const windowStub = {
    __ModuleLoader__: {
      load: (spec) => {
        registered = spec;
      }
    }
  };
  const run = new Function(
    "window",
    "require",
    "document",
    "fetch",
    "navigator",
    `${source}\nreturn window.__ModuleLoader__;`
  );
  run(
    windowStub,
    (id) => (id === "react" ? options.react : undefined),
    documentStub,
    options.fetch,
    options.navigator ?? { userAgent: "" }
  );
  return registered;
}

// ── 1. 语法 ─────────────────────────────────────────────────────────────────
// 自带工具目录是分层的(lib/ 是内部模块、module/ 与 project/ 是各级命令),语法检查要**递归到底**,
// 否则要么漏检子目录里的文件,要么拿目录去跑 `node --check`。
const toolFiles = [];
const walkTools = (rel) => {
  for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const child = join(rel, entry.name);
    if (entry.isDirectory()) walkTools(child);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) toolFiles.push(child);
  }
};
walkTools(join("presets", "fpga-workbench", "tools"));
const loadable = [
  ...readdirSync(LIB).filter((name) => name.endsWith(".js")).map((name) => join("lib", name)),
  ...toolFiles
];
const broken = loadable.filter((rel) => spawnSync(process.execPath, ["--check", join(ROOT, rel)], { stdio: "ignore" }).status !== 0);
check(broken.length === 0, `${loadable.length} 个可加载文件语法通过`, broken.join(", "));

// ── 2. lib 内部相对 import 是否真的对得上 ───────────────────────────────────
const linkProblems = [];
for (const name of readdirSync(LIB).filter((entry) => entry.endsWith(".js"))) {
  const source = readFileSync(join(LIB, name), "utf8");
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.\/[^"']+)["']/gu)) {
    const names = match[1].split(",").map((part) => part.trim().split(/\s+as\s+/u)[0]).filter((part) => part !== "");
    const target = join(LIB, match[2]);
    if (!existsSync(target)) {
      linkProblems.push(`${name} → ${match[2]} 不存在`);
      continue;
    }
    const targetSource = readFileSync(target, "utf8");
    for (const imported of names) {
      const declared = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${imported}\\b|export\\s*\\{[^}]*\\b${imported}\\b`, "u");
      if (!declared.test(targetSource)) linkProblems.push(`${name} 导入了 ${imported},但 ${match[2]} 没有导出它`);
    }
  }
}
check(linkProblems.length === 0, "lib/ 内部相对 import 都能解析", linkProblems.join("\n        "));

// ── 3. 客户端 bundle 契约 ───────────────────────────────────────────────────
const client = read("lib/client.js");
const loaderId = /__ModuleLoader__\.load\(\{[\s\S]{0,120}?id:\s*"([^"]+)"/u.exec(client)?.[1];
check(loaderId === manifest.name, `bundle 的 loader id 等于包名(实际 ${String(loaderId)} vs ${manifest.name})`);
check(/exports\.inject\s*=\s*\[/u.test(client), "exports.inject 是数组(写成对象会让整行不激活)");
check(!/exports\.inject\s*=\s*\{/u.test(client), "exports.inject 不是对象字面量");
check(/exports\.apply\s*=/u.test(client), "导出 apply");
check(/exports\.name\s*=/u.test(client), "导出 name");
check(!/require\(\s*["']\./u.test(client), "bundle 内没有相对 require(会被拼进组合后解析失败)");
check(!/^\s*import\s/mu.test(client), "bundle 内没有 static import");
check(/settingsScope/u.test(client) && !/exports\.inject\s*=\s*\[[^\]]*settingsScope/u.test(client),
  "可能不存在的服务(settingsScope)走内部 inject,不放进 exports.inject");

// ── 4. 宿主半侧 ────────────────────────────────────────────────────────────
const host = read("lib/index.js");
check(/export function apply/u.test(host), "宿主导出 apply");
check(/export const inject = \["settings"\]/u.test(host), `宿主 inject 恰好是 ["settings"]`);
check(!/systemPrompt/u.test(host), "index.js 里不出现 systemPrompt(提示只能由模式半侧注册)");
check(/export const name = /u.test(host), "宿主导出 name");

// settings 句柄的调用签名:`register()` 返回的是**已绑定命名空间**的句柄 ——
// get() 不带参、update(patch) 只接补丁。多传一个 ns 会被当成补丁本身,运行时才报
// "must be a plain object"(方法存在、参数类型错,静态完全看不出来 —— 踩过一次)。
const handleCalls = [...host.matchAll(/settings\.(get|update|replace|watch)\(([^)]*)\)/gu)].map(
  (match) => `settings.${match[1]}(${match[2]})`
);
check(handleCalls.length > 0, "宿主在用 settings 句柄");
check(
  handleCalls.every((call) => !/^settings\.(update|replace|watch)\(\s*(NS|["'])/u.test(call)),
  "settings 句柄的写方法只传数据、不传命名空间(句柄已绑定)",
  handleCalls.join("  ")
);

const mode = read("lib/mode.js");
check(/export const inject = \["systemPrompt"\]/u.test(mode), `模式半侧 inject 是 ["systemPrompt"]`);
check(/export function apply/u.test(mode), "模式半侧导出 apply");

// ── 5. 客户端渲染冒烟 ───────────────────────────────────────────────────────
//
// 光"bundle 能加载"不够:设置页真正跑的是那个 React 组件的**渲染体**。这里用一套极小的
// React 替身把组件真的调用两遍(第一遍拿字段、第二遍渲染字段行与浏览面板),于是
// "渲染路径里引用了不存在的函数 / 结构写错"这类白屏问题能在重启前抓到 ——
// 没有浏览器,这是唯一能自动验到那一层的手段。
const fake = createFakeReact();
/** 保存时真正提交上去的 ops(只有点「保存改动」才会往里进)。 */
const written = [];
/**
 * 宿主那份值:保存被接受时会跟着变 —— 客户端就是靠**比对它**来判断存没存进去。
 *
 * 这里的 compilerPath 故意**不等于**浏览夹具里的那个文件:值一样时"改动"会被判成没改
 * (改回原值就不算脏,这是设计),那样就测不到"未保存"这条路了。
 */
const hostValues = {
  compilerPath: "C:\\old\\verilator_bin.exe",
  simulator: "modelsim",
  // 第三个可编辑字段的宿主值:用来验"这次确实存了、期间也没再被改过"的键会正常清掉
  // (与"保存期间又被改过、必须留着"的那个键形成对照)。
  modelsimIniPath: "C:\\modelsim\\modelsim.ini"
};
/** 模拟宿主拒收:mutate **正常结算**但值不进去(真实 SDK 就是这样:它 recover 一下就 return)。 */
let hostAcceptsSave = true;
/**
 * 保存请求的"手动放行":非 null 时 mutate **不立刻结算**,由测试决定何时 resolve。
 * 真实宿主是异步的,而"请求还在路上、用户接着改"这段窗口正是要复现的那段 —— 所以
 * 结算时(drainDeferredSaves)才把值收下,和真实 mutate 的因果一致。
 */
let deferSaves = null;
/** 把挂起的保存请求放行:宿主收下这批值,再让 mutate 的 Promise 结算。 */
const drainDeferredSaves = () => {
  const pending = deferSaves ?? [];
  deferSaves = null;
  for (const settle of pending) settle();
  return pending.length;
};
const scope = {
  store: { getSnapshot: () => ({ status: "ready", value: { ...hostValues } }) },
  mutate: (ops) => {
    written.push(...ops);
    const accept = () => {
      if (hostAcceptsSave) for (const op of ops) hostValues[op.path[0]] = op.value;
    };
    if (deferSaves === null) {
      accept();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      deferSaves.push(() => {
        accept();
        resolve();
      });
    });
  }
};
let captured;
let browserRequested = 0;
const payload = {
  tools: [
    { key: "compiler", label: "用哪个编译器", hint: "选一个", required: false, skips: [], path: "verilator", configured: true, present: true, group: "编译器", control: "select", options: [{ value: "verilator", label: "Verilator", needs: "compilerPath" }, { value: "other", label: "其他", needs: "compilerPath" }, { value: "ghost", label: "没装的工具", needs: "compilerPath" }], default: "verilator", detectable: true },
    { key: "compilerPath", label: "编译器路径", hint: "填 exe", required: true, skips: ["快速 lint"], path: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", configured: true, present: true, group: "编译器", control: "text", kind: "file", detectable: true },
    // 目录字段的样本:key / 标签 / 组名照 lib/toolchain.js 的 FIELDS 写(`simulatorPath` 在「仿真工具」组)。
    // 为什么这里必须有一个 kind=directory 的字段:选 XSim 时这个字段填的是 Vivado 的 bin **目录**
    // (kind 挂在选项上,见 toolchain.js 的 SIMULATORS.xsim),所以目录分支在真实使用中可达,
    // 「用这个目录」那条路要继续被测到。detectable 是假值:夹具里没有管它的 `simulator` 下拉。
    { key: "simulatorPath", label: "仿真器路径", hint: "填目录", required: true, skips: [], path: "", configured: false, present: false, group: "仿真工具", control: "text", kind: "directory", detectable: false },
    // 第三个可编辑字段(键/标签/组名照 lib/toolchain.js 的 FIELDS):一次保存提交**两个**键时,
    // 才分得清"存下去且没人再动它"(该清)和"存下去但期间又被改过"(该留)。
    { key: "modelsimIniPath", label: "库映射文件", hint: "填 modelsim.ini", required: false, skips: [], path: "", configured: true, present: true, group: "库映射", control: "text", kind: "file", detectable: false },
    { key: "verilatorPath", label: "旧键里的路径", hint: "", required: false, skips: [], path: "", configured: false, present: false, group: "旧键", control: "hidden" }
  ],
  missing: ["simulatorPath"],
  ok: false
};
let browsePayload = {
  path: "C:\\msys64\\mingw64\\bin",
  parent: "C:\\msys64\\mingw64",
  entries: [
    { name: "verilator_bin.exe", path: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", kind: "file" },
    { name: "mingw64", path: "C:\\msys64\\mingw64", kind: "directory" }
  ],
  truncated: false
};
/** 检测路由的答复:换工具时要靠它把路径一起换掉(也顺带覆盖检测结果那一块的渲染)。 */
const detectPayload = {
  found: [
    { field: "compilerPath", option: "verilator", label: "Verilator", path: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", source: "known" },
    { field: "compilerPath", option: "other", label: "Icarus Verilog", path: "C:\\iverilog\\bin\\iverilog.exe", source: "known" }
  ]
};
let detectRequested = 0;
/** 状态路由带查询串的请求次数 = 客户端为"未保存的改动"预演了几次状态。 */
let previewRequested = 0;
/**
 * 状态路由的答复(预演那条路)。**每次请求发出时取当时的这一份** —— 所以测试可以给先后两次
 * 预演安排不同的答复,用来分辨"最后落在界面上的是哪一次的结果"。
 */
let statusPayload = payload;
/** 预演答复:只改一个字段,别处照旧。用来分辨乱序返回时是哪一次的结果落在界面上。 */
const previewAnswer = (overrides, key = "compilerPath") => ({
  tools: payload.tools.map((entry) => (entry.key === key ? { ...entry, ...overrides } : entry))
});
/** 列目录答复:一个只有一项的目录;路径本身用来分辨是哪一次请求列出来的。 */
const listingOf = (path) => ({
  path,
  parent: "C:\\",
  entries: [{ name: "one.exe", path: `${path}\\one.exe`, kind: "file" }],
  truncated: false
});
/**
 * 三条异步取数的"手动放行"(与上面的 deferSaves 同一套写法):非 null 时,对应的那条请求
 * **不立刻结算**,由测试决定谁先 resolve。有了它,"先发出、后返回"这个乱序窗口就能**真的**造出来,
 * 而不是靠墙钟凑时序 —— 代次保护要挡的正是这个窗口。
 * 数组里每一项是一个 `() => void`:调用它就结算它那一笔(答复取的是**它发出时**的那份数据)。
 */
let deferPreview = null;
let deferDetect = null;
let deferBrowse = null;
const fetchStub = (url) => {
  const target = String(url);
  if (target.includes("/browse")) {
    browserRequested += 1;
    const data = browsePayload;
    if (deferBrowse !== null) {
      return new Promise((resolve) => deferBrowse.push(() => resolve({ ok: true, json: () => Promise.resolve(data) })));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  }
  if (target.includes("/detect")) {
    detectRequested += 1;
    if (deferDetect !== null) {
      return new Promise((resolve) => deferDetect.push(() => resolve({ ok: true, json: () => Promise.resolve(detectPayload) })));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(detectPayload) });
  }
  if (target.includes("?")) {
    previewRequested += 1;
    const data = statusPayload;
    if (deferPreview !== null) {
      return new Promise((resolve) => deferPreview.push(() => resolve({ ok: true, json: () => Promise.resolve(data) })));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
};
const doc = createFakeDocument();
/** 可切换的外壳:空 UA = 普通浏览器;带 Electron = 桌面壳。客户端在点击时读它。 */
const nav = { userAgent: "" };
const registered = runBundle(read("lib/client.js"), { fetch: fetchStub, react: fake.react, document: doc, navigator: nav });
check(registered?.id === manifest.name, `客户端 bundle 注册的 id = 包名(实际 ${String(registered?.id)})`);
const clientExports = registered?.factory((id) => (id === "react" ? fake.react : undefined));
check(typeof clientExports?.apply === "function", "客户端工厂能执行并导出 apply");

let firstTree;
let secondTree;
try {
  clientExports.apply({
    inject: (deps, callback) => callback({
      settingsScope: { bind: () => scope },
      effect: (fn) => fn(),
      slots: {
        inject: (name, generator) => {
          generator().next();
        },
        register: (spec, component) => {
          captured = component;
          return { dispose() {} };
        }
      }
    })
  });
  check(typeof captured === "function", "设置页把组件注册到了 settings.section 槽");
  fake.reset();
  firstTree = captured();
  await new Promise((resolve) => setImmediate(resolve));
  fake.runEffects();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  secondTree = captured();
} catch (error) {
  check(false, "设置页组件能渲染", String(error));
}

check(firstTree !== undefined && secondTree !== undefined, "设置页两次渲染都没抛异常(第二遍带字段)");

// 打开设置页自动检测一次(结论写在字段那一行下面)。上面两遍渲染各只跑了一轮 effects,而**第一遍**
// 跑的时候字段还是空的 —— 检测函数遇到 `fields.length === 0` 直接 return,于是这条路径到这里
// 还没被真正执行过。这里在"字段已就绪"之后补跑一轮:检测请求确实发出去了才算数。
const detectBeforeAuto = detectRequested;
fake.runEffects();
await new Promise((resolve) => setImmediate(resolve));
check(
  detectRequested > detectBeforeAuto,
  `字段就绪后打开页面自动检测了一次(实际发出 ${detectRequested - detectBeforeAuto} 次检测请求)`
);

const rendered = JSON.stringify(secondTree ?? {});
for (const expected of ["用哪个编译器", "编译器路径", "仿真器路径", "浏览…", "已就绪", "未就绪"]) {
  check(rendered.includes(expected), `渲染结果里出现「${expected}」`);
}
check(!rendered.includes("旧键里的路径"), "隐藏字段没有被渲染出来");
check(browserRequested === 0, "没点「浏览…」时不会去请求接口(不白跑)");

// 检测不再靠按钮:打开页面就自动跑一次(结论写在字段行下面),所以页面里不该有检测按钮
check(
  countButtons(secondTree, "检测本组工具") === 0,
  `页面里没有「检测本组工具」按钮(实际 ${countButtons(secondTree, "检测本组工具")} 个)`
);

// 保存栏在**最后**(用户口径),不在顶部
const rootKids = (secondTree?.children ?? []).filter((kid) => kid !== null && typeof kid === "object");
const footIndex = rootKids.findIndex((kid) => kid?.props?.className === "fpga-set-foot");
const lastRowIndex = rootKids.map((kid) => kid?.props?.className).lastIndexOf("fpga-set-row");
check(
  lastRowIndex !== -1 && footIndex > lastRowIndex,
  `保存栏在最后一行字段之后(实际 foot=${footIndex} / 最后一行=${lastRowIndex})`
);
check(
  findButton(findByProp(secondTree, (props) => props.className === "fpga-set-head"), "保存改动") === undefined,
  "保存按钮不在顶部(顶部只有标题)"
);

// 点「浏览…」:列目录 → 面板出现(带过滤框)
let browsing;
try {
  const button = findButton(secondTree, "浏览…");
  check(button !== undefined, "渲染树里找得到「浏览…」按钮");
  button.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  check(browserRequested === 1, `点按钮后去列了目录(实际请求 ${browserRequested} 次)`);
  fake.reset();
  browsing = captured();
  const browseRendered = JSON.stringify(browsing ?? {});
  check(browseRendered.includes("verilator_bin.exe"), "浏览面板列出目录里的文件");
  // 「用这个目录」只该给**要目录**的字段:这里开的是**文件**字段(编译器路径),点了它会把当前
  // 目录填进本该填 verilator_bin.exe 的框里。目录字段那一份在文件末尾单独验。
  // 按**按钮**判,不按字符串判 —— 目录字段的说明文字里也有「用这个目录」这几个字。
  check(findButton(browsing, "用这个目录") === undefined, "文件字段(编译器路径)的面板里没有「用这个目录」按钮");
  check(browseRendered.includes("↑ 上级"), "浏览面板能回上级目录");
  check(
    findByProp(browsing, FILTER_BOX) !== undefined,
    "浏览面板带过滤框(一个 bin 目录几十上百项,靠它几秒钟找到目标)"
  );
} catch (error) {
  check(false, "浏览面板能渲染", String(error));
}

// 过滤 + 回车:打几个字母只剩一项,回车直接选中并写入设置
try {
  findByProp(browsing, FILTER_BOX).props.onChange({ target: { value: "veril" } });
  fake.reset();
  const filtered = captured();
  const filteredText = JSON.stringify(filtered ?? {});
  check(filteredText.includes("verilator_bin.exe"), "过滤后目标还在");
  // 按**列表项的写法**判断:光看 "mingw64" 会撞上路径本身(C:\msys64\mingw64\bin)
  check(!filteredText.includes("📁 mingw64"), "过滤把不匹配的项去掉(只剩一项才好回车)");
  written.length = 0;
  findByProp(filtered, FILTER_BOX).props.onKeyDown({ key: "Enter" });
  fake.reset();
  const picked = captured();
  check(
    findByProp(picked, (props) => props.value === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe") !== undefined,
    "过滤到唯一一项后回车:选中的值出现在输入框里"
  );
  check(written.length === 0, "回车选中**不立刻写设置**(改动先留在页面上)");
  check(JSON.stringify(picked ?? {}).includes("有未保存的改动"), "回车选中后出现「有未保存的改动」");

  // 点「保存改动」:一次原子提交;宿主接受后未保存标记消失
  written.length = 0;
  findButton(picked, "保存改动").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  check(
    written.length === 1 &&
      written[0].op === "set" &&
      written[0].path[0] === "compilerPath" &&
      written[0].value === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe",
    "点保存:一次 mutate 提交那个字段(不是逐字段写)",
    JSON.stringify(written)
  );
  fake.reset();
  const saved = captured();
  check(!JSON.stringify(saved ?? {}).includes("有未保存的改动"), "宿主接受后未保存标记消失");

  // 宿主拒收:mutate 正常结算但值没进去 —— 只能靠**比对结果**发现,而且改动必须留着。
  // (这条替换掉了原来那条源码断言:"保存失败要看得见"必须真渲染出来才算数。)
  hostAcceptsSave = false;
  findByProp(saved, (props) => props.value === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe").props.onChange({
    target: { value: "D:\\alt\\verilator_bin.exe" }
  });
  fake.reset();
  findButton(captured(), "保存改动").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  const rejected = captured();
  const rejectedText = JSON.stringify(rejected ?? {});
  check(rejectedText.includes("没有确认这次改动生效"), "宿主没接受时如实说没确认(不能假装成功)");
  check(rejectedText.includes("有未保存的改动"), "保存没成功时改动仍然留着");
  check(
    findByProp(rejected, (props) => props.value === "D:\\alt\\verilator_bin.exe") !== undefined,
    "保存没成功时输入框里还是用户改的那份"
  );

  // 放弃改动:回到宿主那份值
  findButton(rejected, "放弃改动").props.onClick();
  fake.reset();
  const discarded = captured();
  check(!JSON.stringify(discarded ?? {}).includes("有未保存的改动"), "点「放弃改动」后未保存标记消失");
  check(
    findByProp(discarded, (props) => props.value === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe") !== undefined,
    "放弃改动后输入框回到宿主那份值"
  );
  hostAcceptsSave = true;
} catch (error) {
  check(false, "过滤与回车能选中", String(error));
}

// 换工具 → 它管着的那条路径**强制**跟着换(有就换成它的,没检测到就清空);检测不用按钮。
try {
  written.length = 0;
  fake.reset();
  const selectNode = findByProp(captured(), (props) => props.value === "verilator");
  check(selectNode !== undefined, "找得到「用哪个编译器」下拉");
  selectNode.props.onChange({ target: { value: "other" } });
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  const switched = captured();
  check(detectRequested > 0, "换工具时问了一次检测接口(去拿那个工具的路径)");
  check(
    findByProp(switched, (props) => props.value === "C:\\iverilog\\bin\\iverilog.exe") !== undefined,
    "换工具:路径自动换成那个工具的(检测到的)"
  );
  check(written.length === 0, "换工具也只是记进未保存区(不立刻写设置)");

  // 换到**没装**的工具:路径必须清空 —— 留着上一个工具的路径会造出"框里是 A、下拉是 B、
  // 状态还显示已就绪"的自相矛盾画面(用户实际反馈过这一条)。
  fake.reset();
  findByProp(captured(), (props) => props.value === "other").props.onChange({ target: { value: "ghost" } });
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  const cleared = captured();
  const clearedRow = findByProp(cleared, (props) => props.key === "compilerPath");
  const clearedInput = findByProp(clearedRow, (props) => props.type === "text" && typeof props.onChange === "function");
  check(
    clearedInput?.props.value === "",
    `换到没装的工具:路径被清空(实际 ${JSON.stringify(clearedInput?.props.value)})`
  );
  check(JSON.stringify(cleared ?? {}).includes("没检测到"), "换到没装的工具:那一行下面说明没检测到");
} catch (error) {
  check(false, "换工具时路径联动能走通", String(error));
}

// 检测结论只报**当前选中的工具**的路径:**换工具时**自动重跑(没有检测按钮),
// 不回声原来那条,也不拿别的工具来答话。
try {
  // 换到「其他(Icarus Verilog)」:那一栏跟着换成它的(forced),结论也只报它
  fake.reset();
  findByProp(captured(), (props) => props.value === "ghost").props.onChange({ target: { value: "other" } });
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  const switchedToOther = captured();
  const otherText = JSON.stringify(switchedToOther ?? {});
  check(otherText.includes("iverilog.exe"), "换成 Icarus Verilog:那一栏换成它的路径");
  check(!otherText.includes("verilator_bin.exe"), "不拿别的工具(Verilator)的路径来答话");
  check(!otherText.includes("没检测到"), "找到了就说找到了(不该同时说没检测到)");
  check(
    findByProp(
      findByProp(switchedToOther, (props) => props.key === "compilerPath"),
      (props) => props.value === "C:\\iverilog\\bin\\iverilog.exe"
    ) !== undefined,
    "输入框里就是新工具那条路径"
  );

  // 未保存的改动要能"预演"状态:带上页面上的值问一次宿主,于是**不必先保存**就看到就绪与否
  // (防抖 250ms,所以这里等一拍)
  fake.reset();
  captured();
  fake.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 400));
  check(previewRequested > 0, `未保存的改动预演了一次状态(实际 ${previewRequested} 次)`);
} catch (error) {
  check(false, "检测按选中的工具筛能走通", String(error));
}

// 「浏览…」**一律给页面内列表,不弹系统窗口**(用户口径:弹窗出过好几回问题;而且实测在这种
// 外壳里系统框给不出真实路径)。所以:点它只去列目录,**永远不建 `<input type="file">`**。
try {
  check(browserRequested > 0, "点「浏览…」直接给页面内列表");
  check(doc.inputsCreated === 0, `不弹系统文件框(实际建了 ${doc.inputsCreated} 个 input)`);
  const requestsBefore = browserRequested;
  fake.reset();
  findButton(captured(), "浏览…").props.onClick();
  check(doc.inputsCreated === 0, "换外壳(带 Electron 的 UA)也一样:不再弹框");
  check(browserRequested === requestsBefore + 1, "仍然是去列目录");
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  check(
    JSON.stringify(captured() ?? {}).includes("点一下"),
    "列表打开时说明怎么选(点一下文件 / 过滤后回车 / 直接粘路径)"
  );
} catch (error) {
  check(false, "「浏览…」只走页面内列表能走通", String(error));
}

// 「用这个目录」在**目录字段**上还要有(上面验的是文件字段没有它):XSim 那种要目录的路径,
// 没有这个按钮就只能一层层钻到底再手打一遍。按字段行取按钮,不靠"树里第几个"。
try {
  fake.reset();
  const dirBrowse = findButton(findByProp(captured(), (props) => props.key === "simulatorPath"), "浏览…");
  check(dirBrowse !== undefined, "目录字段(仿真器路径)那一行有自己的「浏览…」");
  if (dirBrowse !== undefined) {
    dirBrowse.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    fake.reset();
    check(
      findButton(captured(), "用这个目录") !== undefined,
      "目录字段的面板里有「用这个目录」按钮(XSim 那种要目录的路径)"
    );
  }
} catch (error) {
  check(false, "目录字段的浏览面板能渲染", String(error));
}

// 保存**成功**也不能吞掉请求回来之前的新输入:成功后只清「这次确实存了、而且期间没再被改过」的键。
// 保存期间控件并没有被锁住(下拉、输入框、浏览都还能用),用户接着改是完全可能的 —— 无条件清空
// 会让那几笔静默消失,现象就是"提示保存成功,但刚敲的那几笔没了"。
try {
  written.length = 0;
  // 从空白草稿开始:先把上一段留下的改动放弃掉(不然这次提交里会混进别的键)
  fake.reset();
  const discard = findButton(captured(), "放弃改动");
  if (discard !== undefined && discard.props.disabled !== true) {
    discard.props.onClick();
    fake.reset();
  }
  // 顺手关掉浏览面板:字段行里的**第一个**文本框才是字段自己的输入框,不跟面板的过滤框抢
  const closeBrowse = findButton(captured(), "关闭");
  if (closeBrowse !== undefined) {
    closeBrowse.props.onClick();
    fake.reset();
  }

  /**
   * 某个字段行里的输入框(按行的 key 取,不靠"树里第几个")。
   * 自己重渲染一次:**每次渲染前必须 reset 游标**,连着重渲染两遍会把 hook 对错槽位
   * (读到的 drafts 就是空的,保存直接 early-return —— 这条踩过一次)。
   */
  const inputOf = (key) => {
    fake.reset();
    return findByProp(
      findByProp(captured(), (props) => props.key === key),
      (props) => props.type === "text" && typeof props.onChange === "function"
    );
  };

  // 1) 先改字段 A(编译器路径),外加一个这次一并提交的键 C(库映射文件)
  const midA = "C:\\mid\\verilator_bin.exe";
  const savedC = "C:\\lib\\modelsim.ini";
  inputOf("compilerPath").props.onChange({ target: { value: midA } });
  inputOf("modelsimIniPath").props.onChange({ target: { value: savedC } });
  fake.reset();
  check(JSON.stringify(captured() ?? {}).includes("有未保存的改动"), "保存前:A 与 C 都算未保存");

  // 2) 点「保存改动」:**不让它结算**(替身停在路上)—— 这段窗口里界面并没有被锁住
  deferSaves = [];
  fake.reset();
  findButton(captured(), "保存改动").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  check(
    deferSaves.length === 1 && written.length === 2,
    `保存请求发出去了、还停在路上(挂起 ${deferSaves.length} 次 / 提交 ${written.length} 个键)`
  );

  // 3) 保存进行中:改字段 B(仿真器路径),并把 A 再改成一个不同的新值
  inputOf("simulatorPath").props.onChange({ target: { value: "C:\\sim\\modelsim" } });
  inputOf("compilerPath").props.onChange({ target: { value: "C:\\late\\verilator_bin.exe" } });

  // 4) 放行:宿主收下这批值(A 回读到的就是刚保存的那个中间值)
  check(drainDeferredSaves() === 1, "按测试的节奏结算:宿主收下了这次提交");
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  const settledTree = captured();
  const rowOf = (key) => findByProp(settledTree, (props) => props.key === key);

  check(
    !JSON.stringify(settledTree ?? {}).includes("没有确认这次改动生效"),
    "这次保存被宿主接受了(走的确实是成功那条分支)"
  );
  // ① 保存期间新改的 B 还在
  check(
    findByProp(rowOf("simulatorPath"), (props) => props.value === "C:\\sim\\modelsim") !== undefined,
    "保存成功不清掉期间新改的 B(仿真器路径还是刚敲的那份)"
  );
  // ② A 显示用户最后敲的新值,而且仍然标着「未保存」
  check(
    findByProp(rowOf("compilerPath"), (props) => props.value === "C:\\late\\verilator_bin.exe") !== undefined,
    "保存期间又被改过的 A 显示用户最后敲的那个新值(不是刚保存的中间值)"
  );
  check(
    JSON.stringify(rowOf("compilerPath") ?? {}).includes("未保存"),
    "A 仍然带「未保存」标记(它和刚存下去的那份已经不一样了)"
  );
  // ③ 这次确实存了、期间也没人再动它的 C 正常清掉
  check(
    findByProp(rowOf("modelsimIniPath"), (props) => props.value === savedC) !== undefined,
    "C 显示的就是刚保存下去的那份"
  );
  check(
    !JSON.stringify(rowOf("modelsimIniPath") ?? {}).includes("未保存"),
    "保存成功的 C 不再显示「未保存」"
  );
} catch (error) {
  check(false, "保存成功不吞掉期间的新输入能走通", String(error));
} finally {
  // 万一挂在半路:别把挂起的保存请求留到后面
  deferSaves = null;
}

// ── 代次保护:先发出、后返回的旧结果不许盖掉新结果 ──────────────────────────────
//
// 设置页有三处异步取数(状态预演 / 工具检测 / 列目录)。用户连点两下时,先发出的那次可能
// **后**返回 —— 没有代次保护,它会把界面盖回上一个工具/上一个目录。下面的替身能控制
// resolve 的顺序(deferPreview / deferDetect / deferBrowse),所以这几条测的确实是乱序返回,
// 而不是靠墙钟凑出来的时序。
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 一段文本在 JSON 文本里的样子(反斜杠会被转义,直接比字符串会永远不匹配)。 */
const asJsonText = (text) => JSON.stringify(String(text)).slice(1, -1);
/**
 * 受控地开**一次**预演:先关着闸门把积压的 effect 与 250ms 防抖定时器放干净(那些请求正常结算),
 * 再开闸门、渲染一次,让这一次的预演请求停在闸门上。测试自己决定何时放行。
 *
 * 连那棵渲染树一起交回去:测试可以直接在**已经渲染好的**树上点按钮,而不必再渲染一次 ——
 * 多渲染一次就多排一个防抖 effect,会凭空多出一次预演请求(代次也就跟着动了)。
 * @param answer - 这一次预演要用的状态答复。
 * @returns `{ tree, held }`:`tree` 是这次渲染的树;`held` 是挂在闸门上的请求(每项一个 `() => void`)。
 */
const onePreview = async (answer) => {
  deferPreview = null;
  fake.runEffects();
  await sleep(400);
  deferPreview = [];
  statusPayload = answer;
  fake.reset();
  const tree = captured();
  fake.runEffects();
  await sleep(300);
  return { tree, held: deferPreview };
};
try {
  // 先把之前积压的 effect 与 250ms 防抖定时器都放干净(闸门关着,让它们正常结算)——
  // 下面"两次请求"才数得准。
  fake.runEffects();
  await sleep(400);

  // ① 状态预演:两次请求乱序返回,先发那次的答复**最后**才 resolve
  deferPreview = [];
  statusPayload = previewAnswer({ present: false }); // 先发的那次:按"未就绪"答
  fake.reset();
  captured();
  fake.runEffects();
  await sleep(300);
  statusPayload = previewAnswer({ present: true }); // 后发的那次:按"已就绪"答
  fake.reset();
  captured();
  fake.runEffects();
  await sleep(300);
  check(deferPreview.length === 2, `两次预演请求都发出去了、都停在路上(实际 ${deferPreview.length} 次)`);
  deferPreview[1](); // 最新那次先回
  await tick();
  deferPreview[0](); // 旧那次最后回 —— 没有代次保护时它会盖掉上面那份
  await tick();
  fake.reset();
  const orderedRow = JSON.stringify(findByProp(captured(), (props) => props.key === "compilerPath") ?? {});
  check(orderedRow.includes("已就绪"), "乱序返回:那一行是**后发**那次的结论(已就绪)");
  check(!orderedRow.includes("未就绪"), "乱序返回:先发那次的旧结论(未就绪)被丢掉,没盖回来");
  deferPreview = null;

  // ② 工具检测:连着换两次工具,先发的那次(上一个工具)后回来
  // 按"带 onChange 的下拉"取值 —— 光按 `props.value` 会先撞上 <option>(它没有 onChange)。
  // 注意:**一棵树只渲染一次**(每次渲染前 reset 游标;连渲两遍 hook 就错位了)。
  const selectIn = (tree, value) =>
    findByProp(
      tree,
      (props) => props.className === "fpga-set-input" && props.value === value && typeof props.onChange === "function"
    );
  deferDetect = [];
  fake.reset();
  const beforeSwitch = captured();
  check(selectIn(beforeSwitch, "verilator") !== undefined, "当前选中的工具是 Verilator(换工具的起点)");
  selectIn(beforeSwitch, "verilator").props.onChange({ target: { value: "ghost" } }); // 请求 #1:没装的工具
  fake.reset();
  selectIn(captured(), "ghost").props.onChange({ target: { value: "other" } }); // 请求 #2:Icarus
  check(deferDetect.length === 2, `两次检测请求都发出去了、都停在路上(实际 ${deferDetect.length} 次)`);
  deferDetect[1](); // 最新那次(Icarus)先回
  await tick();
  deferDetect[0](); // 旧那次(ghost:没检测到)最后回
  await tick();
  fake.reset();
  const detectRow = JSON.stringify(findByProp(captured(), (props) => props.key === "compilerPath") ?? {});
  check(detectRow.includes("iverilog.exe"), "乱序返回:那一行报的是最新那次工具(Icarus)检测到的路径");
  check(!detectRow.includes("没检测到"), "乱序返回:旧那次(ghost)的结论被丢掉,没盖回来");
  deferDetect = null;

  // ③ 「路径不可用(…)」这句说明必须按**页面上这一份**(预演)拼,不能按宿主那份已保存的值:
  // 否则"状态按新值、说明按旧值",同一行自相矛盾。
  const previewPath = "C:\\preview\\nothere.exe";
  const savedPath = "C:\\msys64\\mingw64\\bin\\verilator_bin.exe";
  const mixed = await onePreview(previewAnswer({ configured: true, present: false, path: previewPath }));
  check(mixed.held.length === 1, `缺陷二的预演请求发出去了(实际 ${mixed.held.length} 次)`);
  mixed.held[0]();
  await tick();
  fake.reset();
  const mixedRow = JSON.stringify(findByProp(captured(), (props) => props.key === "compilerPath") ?? {});
  check(
    mixedRow.includes(`路径不可用(${asJsonText(previewPath)})`),
    "说明按**页面上预演的那份**路径拼(状态与说明同一来源)"
  );
  check(
    !mixedRow.includes(`路径不可用(${asJsonText(savedPath)})`),
    "说明不再拿宿主那份已保存的路径来拼(改了路径还没保存也不会自相矛盾)"
  );

  // ④ 页面上这条路径**清空了**(未保存):那一行该说"未配置",而不是照宿主那份(配过)说"路径不可用"
  const clearedRow = await onePreview(previewAnswer({ configured: false, present: false, path: "" }));
  check(clearedRow.held.length === 1, `清空路径后的预演请求发出去了(实际 ${clearedRow.held.length} 次)`);
  clearedRow.held[0]();
  await tick();
  fake.reset();
  const clearedText = JSON.stringify(findByProp(captured(), (props) => props.key === "compilerPath") ?? {});
  check(clearedText.includes("未配置,当前不可执行"), "页面上清空了就按页面这一份说「未配置」");
  check(!clearedText.includes("路径不可用("), "不再按宿主那份已保存的值说「路径不可用(…)」");

  // ⑤ 可选字段同理:预演说"没配"时,不该再按宿主那份(配过)报「路径不可用」
  const optionalRow = await onePreview(previewAnswer({ configured: false, present: false }, "modelsimIniPath"));
  check(optionalRow.held.length === 1, `可选字段的预演请求发出去了(实际 ${optionalRow.held.length} 次)`);
  optionalRow.held[0]();
  await tick();
  fake.reset();
  const optionalText = JSON.stringify(findByProp(captured(), (props) => props.key === "modelsimIniPath") ?? {});
  check(!optionalText.includes("路径不可用"), "可选字段按页面上那一份判:预演说没配就不报「路径不可用」");

  // ⑥ 列目录:快速切两次,先发的那次列表不许覆盖后发的那次
  deferPreview = null;
  deferBrowse = [];
  browsePayload = listingOf("C:\\dir-first");
  fake.reset();
  findButton(captured(), "浏览…").props.onClick();
  browsePayload = listingOf("C:\\dir-second");
  fake.reset();
  findButton(captured(), "浏览…").props.onClick();
  check(deferBrowse.length === 2, `两次列目录请求都发出去了、都停在路上(实际 ${deferBrowse.length} 次)`);
  deferBrowse[1](); // 后发的先回
  await tick();
  deferBrowse[0](); // 先发的最后回 —— 不许把面板退回上一个目录
  await tick();
  fake.reset();
  const listed = JSON.stringify(captured() ?? {});
  check(listed.includes(asJsonText("C:\\dir-second")), "面板显示的是**后发**那次列出来的目录");
  check(!listed.includes(asJsonText("C:\\dir-first")), "先发那次的列表没有盖回来(代次保护挡掉了)");

  // ⑦ 改动全部放弃后,还在路上的那次预演回来也不许塞回来(否则界面按一份过期预演显示状态)
  const { tree, held } = await onePreview(previewAnswer({ present: false })); // 这次答复说"未就绪"
  check(held.length === 1, `放弃改动前的预演请求停在路上(实际 ${held.length} 次)`);
  deferPreview = null; // 闸门关掉:只把**这一笔**留到最后放行
  findButton(tree, "放弃改动").props.onClick(); // 在**已经渲染好的**树上点,免得又排一次防抖
  fake.reset();
  captured();
  fake.runEffects(); // 预演作废:代次推一格、状态清掉(就在这一步)
  held[0](); // 过期的那笔现在才回来
  await tick();
  fake.reset();
  const afterRevert = JSON.stringify(findByProp(captured(), (props) => props.key === "compilerPath") ?? {});
  check(afterRevert.includes("已就绪"), "放弃改动后:那一行按宿主那份显示(已就绪)");
  check(!afterRevert.includes("未就绪"), "放弃改动后:过期的预演回来也没塞回来");
} catch (error) {
  check(false, "异步取数的乱序返回与说明同源能走通", String(error));
} finally {
  // 万一挂在半路:别把挂起的请求留到后面
  deferPreview = null;
  deferDetect = null;
  deferBrowse = null;
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 加载契约成立,客户端渲染冒烟也过了(重启前可以放心)");
if (failures.length > 0) process.exitCode = 1;
