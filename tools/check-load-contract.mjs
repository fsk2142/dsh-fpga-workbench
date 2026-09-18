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
 * @returns `{ react, reset, runEffects, tree }`。
 */
function createFakeReact() {
  const states = [];
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
      useRef: (initial) => ({ current: initial })
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
 * 组件里会碰 document(注入样式表)与 fetch(两条路由),Node 里都没有,所以按参数注入,
 * 而不是去改全局。
 * @param source - bundle 源码。
 * @param options - `{ fetch, react }` 替身。
 * @returns `{ id, factory }` 或 undefined。
 */
function runBundle(source, options) {
  let registered;
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({
      dataset: {},
      style: {},
      textContent: "",
      setAttribute() {}
    }),
    head: { append() {} }
  };
  const windowStub = {
    __ModuleLoader__: {
      load: (spec) => {
        registered = spec;
      }
    }
  };
  const run = new Function("window", "require", "document", "fetch", `${source}\nreturn window.__ModuleLoader__;`);
  run(windowStub, (id) => (id === "react" ? options.react : undefined), documentStub, options.fetch);
  return registered;
}

// ── 1. 语法 ─────────────────────────────────────────────────────────────────
const loadable = [
  ...readdirSync(LIB).filter((name) => name.endsWith(".js")).map((name) => join("lib", name)),
  ...readdirSync(join(ROOT, "presets", "fpga-workbench", "tools")).map((name) => join("presets", "fpga-workbench", "tools", name))
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
const written = [];
const scope = {
  store: {
    getSnapshot: () => ({
      status: "ready",
      value: { compilerPath: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", simulator: "modelsim" }
    })
  },
  set: (key, value) => {
    written.push([key, value]);
    return Promise.resolve();
  }
};
let captured;
let browserRequested = 0;
const payload = {
  tools: [
    { key: "compiler", label: "用哪个编译器", hint: "选一个", required: false, skips: [], path: "verilator", configured: true, present: true, group: "编译器", control: "select", options: [{ value: "verilator", label: "Verilator" }, { value: "other", label: "其他" }], default: "verilator" },
    { key: "compilerPath", label: "编译器路径", hint: "填 exe", required: true, skips: ["快速 lint"], path: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", configured: true, present: true, group: "编译器", control: "text", kind: "file" },
    { key: "libraryPath", label: "库目录", hint: "填目录", required: true, skips: [], path: "", configured: false, present: false, group: "库与缓存", control: "text", kind: "directory" },
    { key: "verilatorPath", label: "旧键里的路径", hint: "", required: false, skips: [], path: "", configured: false, present: false, group: "旧键", control: "hidden" }
  ],
  missing: ["libraryPath"],
  ok: false
};
const browsePayload = {
  path: "C:\\msys64\\mingw64\\bin",
  parent: "C:\\msys64\\mingw64",
  entries: [
    { name: "verilator_bin.exe", path: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", kind: "file" },
    { name: "mingw64", path: "C:\\msys64\\mingw64", kind: "directory" }
  ],
  truncated: false
};
const fetchStub = (url) => {
  const target = String(url);
  if (target.includes("/browse")) {
    browserRequested += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(browsePayload) });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
};
const registered = runBundle(read("lib/client.js"), { fetch: fetchStub, react: fake.react });
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
const rendered = JSON.stringify(secondTree ?? {});
for (const expected of ["用哪个编译器", "编译器路径", "库目录", "浏览…", "已就绪", "未就绪"]) {
  check(rendered.includes(expected), `渲染结果里出现「${expected}」`);
}
check(!rendered.includes("旧键里的路径"), "隐藏字段没有被渲染出来");
check(browserRequested === 0, "没点「浏览…」时不会去请求接口(不白跑)");

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
  check(browseRendered.includes("用这个目录"), "浏览面板提供「用这个目录」(XSim 那种要目录的路径)");
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
  check(
    written.some(([key, value]) => key === "compilerPath" && value === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe"),
    "过滤到唯一一项后回车直接选中并写进设置",
    JSON.stringify(written)
  );
} catch (error) {
  check(false, "过滤与回车能选中", String(error));
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 加载契约成立,客户端渲染冒烟也过了(重启前可以放心)");
if (failures.length > 0) process.exitCode = 1;
