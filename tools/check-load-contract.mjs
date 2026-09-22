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
 * **盲区(如实记下,不打算修)**:这个替身**不自动执行 useEffect 返回的清理函数** —— `runEffects()`
 * 把它们**交回给调用方**,由测试自己决定何时调(主题那一段就靠它模拟卸载)。所以客户端那处
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
    /**
     * 执行这一轮收集到的 effect,**并把它们的清理函数交回去**(不自动执行 —— 这个替身没有真正的
     * 卸载,要验"卸载时把改动还回去 / 退订"就得由调用方自己调,见下面主题那一段)。
     * @returns 这一轮 effect 返回的清理函数。
     */
    runEffects: () => {
      const cleanups = [];
      for (const fn of effects.splice(0)) {
        const cleanup = fn();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      return cleanups;
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
 * 假的 document:够让客户端注入样式表、按主题改根元素,并**记下最后建出来的元素** ——
 * 测试要拿它模拟"浏览器的文件框里选中了文件"。
 * @returns document 替身。
 */
function createFakeDocument() {
  const stub = {
    inputsCreated: 0,
    /** 客户端注入的每一份 <style>(`ensureStyles` 注入样式表;自动填充那条规则要能查到)。 */
    styles: [],
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
      if (tag === "style") stub.styles.push(element);
      stub.lastCreated = element;
      return element;
    },
    head: { append() {} },
    // 客户端会把判出来的主题写到根元素的内联样式上(<select> 的弹层按它渲染),卸载时再还回去。
    // 这里给一个真的 style 对象,那两步才有地方落,断言也才有东西可查。
    documentElement: { style: {} }
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
    },
    // 主题判定要读的两个浏览器 API,由测试注入(真浏览器里它们就在 window 上):
    // 一个给"实际底色",一个给系统偏好。
    getComputedStyle: options.getComputedStyle,
    matchMedia: options.matchMedia
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
 * 这里的 verilatorPath 故意**不等于**浏览夹具里的那个文件:值一样时"改动"会被判成没改
 * (改回原值就不算脏,这是设计),那样就测不到"未保存"这条路了。
 */
const hostValues = {
  verilatorPath: "C:\\tools\\verilator_bin.exe",
  moduleRtlCompilerTool: "verilator",
  moduleRtlCompilerPath: "",
  projectImplFpgaTool: "auto",
  xsimPath: "C:\\Vivado\\bin",
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
/**
 * 状态路由的答复(不带查询串那条 = 初次取字段定义)。字段表本身固定;末段要换的是带
 * `pendingCleanup` 的那份 preset(见 `statusPreset`)。
 */
const payload = {
  sections: [
    { key: "common", label: "通用工具", hint: "登记本机工具" },
    { key: "module", label: "模块工具", hint: "不是流水线" },
    { key: "project", label: "工程工具", hint: "分别设置" }
  ],
  stages: [
    { key: "module-rtl", section: "module", label: "RTL", bindings: ["moduleRtlCompiler"] },
    { key: "module-review", section: "module", label: "审查", bindings: [], note: "复用相关环节工具" },
    { key: "project-impl", section: "project", label: "实现", bindings: ["projectImplFpga"] }
  ],
  tools: [
    { key: "verilatorPath", label: "Verilator", hint: "填写 verilator_bin.exe", required: false, skips: [], section: "common", sectionLabel: "通用工具", group: "编译工具", control: "text", kind: "file", path: "C:\\tools\\verilator_bin.exe", configured: true, present: true, detectable: true },
    // 目录字段保留浏览分支覆盖；它也是通用工具,不会受任何环节选择影响。
    { key: "xsimPath", label: "Vivado XSim", hint: "填写 Vivado bin 目录", required: false, skips: [], section: "common", sectionLabel: "通用工具", group: "仿真工具", control: "text", kind: "directory", path: "C:\\Vivado\\bin", configured: true, present: true, detectable: true },
    // 第三个可编辑字段(键/标签/组名照 lib/toolchain.js 的 FIELDS):一次保存提交**两个**键时,
    // 才分得清"存下去且没人再动它"(该清)和"存下去但期间又被改过"(该留)。
    { key: "modelsimIniPath", label: "库映射文件", hint: "填 modelsim.ini", required: false, skips: [], section: "common", sectionLabel: "通用工具", path: "C:\\modelsim\\modelsim.ini", configured: true, present: true, group: "语言与库映射", control: "text", kind: "file", detectable: false },
    { key: "moduleRtlCompilerTool", label: "编译 / lint 工具", hint: "该环节首选工具", required: false, skips: [], section: "module", sectionLabel: "模块工具", stage: "module-rtl", stageLabel: "RTL", group: "RTL", bindingKey: "moduleRtlCompiler", control: "select", path: "verilator", configured: true, present: true, default: "auto", options: [{ value: "auto", label: "由 AI 根据任务判断" }, { value: "verilator", label: "Verilator" }, { value: "iverilog", label: "Icarus Verilog" }, { value: "none", label: "不用" }] },
    { key: "moduleRtlCompilerPath", label: "本环节覆盖路径", hint: "留空使用通用路径", required: false, skips: [], section: "module", sectionLabel: "模块工具", stage: "module-rtl", stageLabel: "RTL", group: "RTL", bindingKey: "moduleRtlCompiler", control: "text", kind: "file", path: "", configured: false, present: true, advanced: true, blankNote: "留空使用通用路径" },
    { key: "projectImplFpgaTool", label: "实现工具", hint: "该环节首选 FPGA 套件", required: false, skips: [], section: "project", sectionLabel: "工程工具", stage: "project-impl", stageLabel: "实现", group: "实现", bindingKey: "projectImplFpga", control: "select", path: "auto", configured: true, present: true, default: "auto", options: [{ value: "auto", label: "由 AI 根据任务判断" }, { value: "vivado", label: "Vivado" }, { value: "none", label: "不用" }] },
    { key: "legacyCompiler", label: "旧键", hint: "不显示", section: "common", group: "旧键", control: "hidden", path: "", configured: false, present: false }
  ],
  bindings: [
    { key: "moduleRtlCompiler", section: "module", stage: "module-rtl", label: "编译 / lint 工具", selection: "verilator", toolLabel: "Verilator", state: "ready", source: "common", path: "C:\\tools\\verilator_bin.exe", present: true },
    { key: "projectImplFpga", section: "project", stage: "project-impl", label: "实现工具", selection: "auto", state: "auto", present: true }
  ],
  missing: [],
  ok: true
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
/**
 * 检测路由的答复:只检测各个通用工具自己的路径,不会替环节选择工具或改写其他字段。
 * **`let` 而不是 const**:末尾那一段"检测结论里的版本信息"要给先后几次检测换不同的答复,
 * 而 fetch 替身取的是**发出时**的那一份。
 */
let detectPayload = {
  found: [
    { field: "verilatorPath", tool: "verilator", label: "Verilator", path: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", source: "known" },
    { field: "xsimPath", tool: "xsim", label: "Vivado XSim", path: "C:\\Vivado\\bin", source: "known" }
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
/**
 * 状态路由答复里的 `preset`(预设同步那一行 + 待清理清单)。默认 undefined = 拿不到 ——
 * 那条路径上"整行不显示"也是要验的行为之一;末段再给它一份带 `pendingCleanup` 的。
 */
let statusPreset;
/** 预演答复:可同时改字段与对应绑定,用来验证未保存状态和乱序保护。 */
const previewAnswer = (fieldOverrides, fieldKey = "verilatorPath", bindingKey, bindingOverrides = {}) => ({
  ...payload,
  tools: payload.tools.map((entry) => (entry.key === fieldKey ? { ...entry, ...fieldOverrides } : entry)),
  bindings: payload.bindings.map((binding) => (binding.key === bindingKey ? { ...binding, ...bindingOverrides } : binding))
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
    // 答复照**发出时**那一份取(与上面预演那条同一套):先发后回的乱序里,先发那笔
    // 带的就是它发出时的数据,不被后来的改动串味。
    const data = detectPayload;
    if (deferDetect !== null) {
      return new Promise((resolve) => deferDetect.push(() => resolve({ ok: true, json: () => Promise.resolve(data) })));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  }
  if (target.includes("?")) {
    previewRequested += 1;
    const data = statusPayload;
    if (deferPreview !== null) {
      return new Promise((resolve) => deferPreview.push(() => resolve({ ok: true, json: () => Promise.resolve(data) })));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...payload, preset: statusPreset }) });
};
const doc = createFakeDocument();
/** 可切换的外壳:空 UA = 普通浏览器;带 Electron = 桌面壳。客户端在点击时读它。 */
const nav = { userAgent: "" };

/**
 * 主题的夹具:**元素 → 它的"计算样式"**。
 *
 * 真浏览器里这份映射由 `getComputedStyle` 提供;替身里由测试自己摆 —— 于是"文字浅 / 文字深 /
 * 暗底 / 浅底 / 两者矛盾 / 透明 / 读不到"这几种情形都能直接造出来,不必真有一个浏览器,
 * 也不必等系统主题。
 *
 * **文字色与背景色分开两张表**:判定函数的首选信号是文字色(暗色主题下正文是浅色),
 * 背景只是次选 —— 两张表分开才造得出"文字浅 + 背景浅"这种矛盾夹具,断言才有咬人的地方。
 */
const backgrounds = new Map();
const textColors = new Map();
/**
 * 造一个假的元素(挂在 `parentElement` 上,模拟祖先链)。
 * @param background - 它的计算样式背景色(`rgb(…)` / `rgba(…)` / `transparent` / 空串 / undefined)。
 * @param parent - 祖先;null = 到头了。
 * @param textColor - 它的计算样式文字色;默认空串 = 读不到(于是判定会往背景那一步走)。
 * @returns 假元素(`style` 是真的,客户端要往上面写 colorScheme)。
 */
const boxWith = (background, parent = null, textColor = "") => {
  const node = { parentElement: parent, style: {} };
  backgrounds.set(node, background);
  textColors.set(node, textColor);
  return node;
};
/** 模拟系统偏好的当前值 + 订阅者(客户端要在偏好变化时重新判定)。 */
const preference = { matches: false, listeners: [] };
/**
 * 模拟系统偏好切换:先摆好新值,再通知订阅者(与真 matchMedia 的因果一致)。
 * @param matches - 新的偏好值。
 */
const flipPreference = (matches) => {
  preference.matches = matches;
  for (const fn of [...preference.listeners]) fn();
};
/** 一个"一问计算样式就炸"的元素:验异常兜底那一层。 */
const brokenBox = { parentElement: null, style: {} };
const getComputedStyleStub = (node) => {
  if (node === brokenBox) throw new Error("拿不到计算样式");
  return { backgroundColor: backgrounds.get(node) ?? "", color: textColors.get(node) ?? "" };
};
/** matchMedia 替身:`matches` 是**读的时候**取当前偏好(真 matchMedia 也是随时可读的)。 */
const matchMediaStub = (query) => ({
  media: String(query),
  get matches() {
    return preference.matches;
  },
  addEventListener: (type, fn) => {
    if (type === "change") preference.listeners.push(fn);
  },
  removeEventListener: (type, fn) => {
    if (type === "change") preference.listeners = preference.listeners.filter((entry) => entry !== fn);
  }
});

const registered = runBundle(read("lib/client.js"), {
  fetch: fetchStub,
  react: fake.react,
  document: doc,
  navigator: nav,
  getComputedStyle: getComputedStyleStub,
  matchMedia: matchMediaStub
});
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
for (const expected of ["通用工具", "模块工具", "工程工具", "RTL", "审查", "实现", "Verilator", "来自通用路径"]) {
  check(rendered.includes(expected), `三层设置界面出现「${expected}」`);
}
const help = findByProp(secondTree, (props) => props.className === "fpga-set-help");
check(help?.type === "button" && help.children?.[0] === "?", "字段说明以可聚焦的问号按钮显示");
check(findByProp(help, (props) => props.role === "tooltip") !== undefined, "问号说明使用 tooltip 语义");
check(typeof help?.props?.["aria-describedby"] === "string", "问号可通过键盘聚焦读取说明");
check(rendered.includes("填写 verilator_bin.exe"), "完整说明仍存在于 tooltip 中");
check(!rendered.includes("当前阶段") && !rendered.includes("下一阶段") && !rendered.includes("完成百分比"), "界面不引入流水线状态");
check(!rendered.includes("旧键"), "隐藏字段没有被渲染出来");
const overrideBefore = findByProp(secondTree, (props) => props.key === "moduleRtlCompilerPath");
check(overrideBefore !== undefined, "显式工具时显示环节覆盖路径");
const stageSelectRow = findByProp(secondTree, (props) => props.key === "moduleRtlCompilerTool");
const stageSelect = findByProp(stageSelectRow, (props) => typeof props.onChange === "function" && props.value === "verilator");
stageSelect?.props?.onChange({ target: { value: "auto" } });
fake.reset();
const autoTree = captured();
check(findByProp(autoTree, (props) => props.key === "moduleRtlCompilerPath") === undefined, "auto 时隐藏无意义的路径覆盖框");
check(hostValues.verilatorPath === "C:\\tools\\verilator_bin.exe", "换环节选择不清空通用路径");
findByProp(autoTree, (props) => props.key === "moduleRtlCompilerTool")?.children?.find((node) => node?.type === "select")?.props?.onChange({ target: { value: "verilator" } });
fake.reset();
captured();
check(browserRequested === 0, "没点「浏览…」时不会去请求接口(不白跑)");

// 检测不再靠按钮:打开页面就自动跑一次(结论写在字段行下面),所以页面里不该有检测按钮
check(
  countButtons(secondTree, "检测本组工具") === 0,
  `页面里没有「检测本组工具」按钮(实际 ${countButtons(secondTree, "检测本组工具")} 个)`
);

// 保存栏在**最后**(用户口径),不在顶部。字段现在嵌在 section / stage 里,所以只需确认
// 根级最后一个有效节点就是保存栏；字段存在性由上面的三层界面断言负责。
const rootKids = (secondTree?.children ?? []).filter((kid) => kid !== null && typeof kid === "object");
const footIndex = rootKids.findIndex((kid) => kid?.props?.className === "fpga-set-foot");
check(
  footIndex === rootKids.length - 1 && findByProp(secondTree, (props) => props.className === "fpga-set-row") !== undefined,
  `保存栏在所有设置分区之后(实际 foot=${footIndex} / 根节点数=${rootKids.length})`
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
      written[0].path[0] === "verilatorPath" &&
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

// 环节下拉只表达这个环节的偏好,不能顺手改写/清空通用路径,也不能因为切换选择就重跑检测。
try {
  written.length = 0;
  fake.reset();
  const beforeChoice = captured();
  const selectorRow = findByProp(beforeChoice, (props) => props.key === "moduleRtlCompilerTool");
  const selectNode = findByProp(selectorRow, (props) => props.value === "verilator" && typeof props.onChange === "function");
  check(selectNode !== undefined, "找得到模块 RTL 环节的工具下拉");
  const detectsBeforeChoice = detectRequested;
  const previewsBeforeChoice = previewRequested;
  selectNode.props.onChange({ target: { value: "none" } });
  fake.reset();
  const unused = captured();
  check(findByProp(unused, (props) => props.key === "moduleRtlCompilerPath") === undefined, "选择不用时隐藏本环节覆盖路径");
  check(
    findByProp(unused, (props) => props.value === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe") !== undefined,
    "环节改成不用时仍保留通用 Verilator 路径"
  );
  check(detectRequested === detectsBeforeChoice, "切换环节选择不会重跑通用工具检测");
  check(written.length === 0, "切换环节选择只进入未保存区(不立刻写设置)");

  // 未保存的选择也要预演绑定状态,但不保存、不改通用路径。
  fake.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 400));
  check(previewRequested > previewsBeforeChoice, "未保存的环节选择会预演绑定状态");

  fake.reset();
  const noneTree = captured();
  findByProp(
    findByProp(noneTree, (props) => props.key === "moduleRtlCompilerTool"),
    (props) => props.value === "none" && typeof props.onChange === "function"
  )?.props.onChange({ target: { value: "verilator" } });
  fake.reset();
  const restoredChoice = captured();
  check(findByProp(restoredChoice, (props) => props.key === "moduleRtlCompilerPath") !== undefined, "显式选工具后重新显示环节覆盖路径");
  check(hostValues.verilatorPath === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", "切换环节选择没有改写已保存的通用路径");

  // 显式工具切到另一个显式工具时,预演返回前不能沿用上一个工具的徽标与路径类型。
  findByProp(
    findByProp(restoredChoice, (props) => props.key === "moduleRtlCompilerTool"),
    (props) => props.value === "verilator" && typeof props.onChange === "function"
  )?.props.onChange({ target: { value: "iverilog" } });
  fake.reset();
  const awaitingPreview = captured();
  check(JSON.stringify(awaitingPreview ?? {}).includes("正在检查当前选择"), "显式工具切换后先显示等待检查,不冒充上一个工具已就绪");
  check(findByProp(awaitingPreview, (props) => props.key === "moduleRtlCompilerPath") === undefined, "工具类型尚未预演完成时暂不显示旧类型的覆盖路径");
  findByProp(
    findByProp(awaitingPreview, (props) => props.key === "moduleRtlCompilerTool"),
    (props) => props.value === "iverilog" && typeof props.onChange === "function"
  )?.props.onChange({ target: { value: "verilator" } });
} catch (error) {
  check(false, "环节选择与通用路径互不改写", String(error));
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
  const dirBrowse = findButton(findByProp(captured(), (props) => props.key === "xsimPath"), "浏览…");
  check(dirBrowse !== undefined, "目录字段(XSim 路径)那一行有自己的「浏览…」");
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
  inputOf("verilatorPath").props.onChange({ target: { value: midA } });
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
  inputOf("xsimPath").props.onChange({ target: { value: "C:\\sim\\xsim" } });
  inputOf("verilatorPath").props.onChange({ target: { value: "C:\\late\\verilator_bin.exe" } });

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
    findByProp(rowOf("xsimPath"), (props) => props.value === "C:\\sim\\xsim") !== undefined,
    "保存成功不清掉期间新改的 B(XSim 路径还是刚敲的那份)"
  );
  // ② A 显示用户最后敲的新值,而且仍然标着「未保存」
  check(
    findByProp(rowOf("verilatorPath"), (props) => props.value === "C:\\late\\verilator_bin.exe") !== undefined,
    "保存期间又被改过的 A 显示用户最后敲的那个新值(不是刚保存的中间值)"
  );
  check(
    JSON.stringify(rowOf("verilatorPath") ?? {}).includes("未保存"),
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
  const orderedRow = JSON.stringify(findByProp(captured(), (props) => props.key === "verilatorPath") ?? {});
  check(orderedRow.includes("已就绪"), "乱序返回:那一行是**后发**那次的结论(已就绪)");
  check(!orderedRow.includes("未就绪"), "乱序返回:先发那次的旧结论(未就绪)被丢掉,没盖回来");
  deferPreview = null;

  // ② 通用工具检测:状态重载连续触发两次检测,先发的旧结果最后回来。
  // 环节下拉不会触发检测,这里直接跑两轮 effect,验证的仍是同一个乱序窗口。
  // 上面为读取最终渲染树又 render 过一次,先把那一轮排队的 effect 放干净,免得混进计数。
  fake.runEffects();
  await tick();
  deferDetect = [];
  detectPayload = { found: [] }; // 先发:没找到
  fake.reset();
  captured();
  fake.runEffects();
  detectPayload = {
    found: [
      {
        field: "verilatorPath",
        tool: "verilator",
        label: "Verilator",
        path: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe",
        source: "known"
      }
    ]
  }; // 后发:找到了
  fake.reset();
  captured();
  fake.runEffects();
  check(deferDetect.length === 2, `两次检测请求都发出去了、都停在路上(实际 ${deferDetect.length} 次)`);
  deferDetect[1](); // 最新那次(找到)先回
  await tick();
  deferDetect[0](); // 旧那次(没找到)最后回
  await tick();
  fake.reset();
  const detectRow = JSON.stringify(findByProp(captured(), (props) => props.key === "verilatorPath") ?? {});
  check(detectRow.includes("verilator_bin.exe"), "乱序返回:通用工具行显示后发那次检测到的路径");
  check(!detectRow.includes("没检测到"), "乱序返回:先发的旧结论被丢掉,没盖回来");
  deferDetect = null;

  // ③ 路径状态必须按**页面上这一份**预演,不能按宿主那份已保存的值。
  const previewPath = "C:\\preview\\nothere.exe";
  const mixed = await onePreview(previewAnswer({ configured: true, present: false, path: previewPath }));
  check(mixed.held.length === 1, `缺陷二的预演请求发出去了(实际 ${mixed.held.length} 次)`);
  mixed.held[0]();
  await tick();
  fake.reset();
  const mixedRow = JSON.stringify(findByProp(captured(), (props) => props.key === "verilatorPath") ?? {});
  check(
    mixedRow.includes("路径不可用") && !mixedRow.includes("✓ 已就绪"),
    "页面预演说路径不存在时,通用工具行立即显示不可用"
  );

  // ④ 页面上这条路径**清空了**(未保存):那一行该说"未配置",而不是照宿主那份(配过)说"路径不可用"
  const clearedRow = await onePreview(previewAnswer({ configured: false, present: false, path: "" }));
  check(clearedRow.held.length === 1, `清空路径后的预演请求发出去了(实际 ${clearedRow.held.length} 次)`);
  clearedRow.held[0]();
  await tick();
  fake.reset();
  const clearedText = JSON.stringify(findByProp(captured(), (props) => props.key === "verilatorPath") ?? {});
  check(!clearedText.includes("路径不可用") && !clearedText.includes("✓ 已就绪"), "页面上清空路径后不沿用宿主的就绪或不可用结论");

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
  const afterRevert = JSON.stringify(findByProp(captured(), (props) => props.key === "verilatorPath") ?? {});
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

// ── 主题跟随:原生下拉的弹层必须跟着**实际**主题,而不是系统偏好 ────────────────
//
// 用户实测:页面是暗色,`<select>` 展开的原生下拉却是白底浅字。给容器加 `color-scheme: light dark`
// **没用** —— 那等于把选择权交给浏览器偏好。所以:读**实际渲染出来的**东西,把结论显式声明到
// **容器**和**根元素**上(弹层按根元素渲染,只设容器不生效),卸载时还回去。
//
// 判定是**多信号、按可靠性排序**的(见 lib/client.js 的 themeOf):① 文字颜色(暗色主题下正文是
// **浅色**,方向和背景相反)② 第一个不透明背景色 ③ 宿主的主题标记(class / data-*) ④ 系统偏好。
// 下面每条都对着其中一个信号打靶,并且**故意让别的信号给出相反答案** —— 这样"顺序错了"也会被抓到。
// 另外还盯:两处 color-scheme 声明、卸载恢复、主题变化跟随、自动填充那条规则。
try {
  const themeOf = clientExports.__themeOf;
  check(typeof themeOf === "function", "bundle 导出了主题判定函数(自检要直接打靶)");

  // ①-a 首选信号:**文字颜色**。方向与背景相反 —— 暗色主题下正文是浅色。
  preference.matches = false;
  check(
    themeOf(boxWith(undefined, null, "rgb(249, 250, 251)")) === "dark",
    "判定(文字色):浅色文字 → dark(暗色主题下正文是浅的;方向和背景相反)"
  );
  check(
    themeOf(boxWith(undefined, null, "rgb(32, 32, 32)")) === "light",
    "判定(文字色):深色文字 → light(浅色主题下正文是深的)"
  );

  // ①-b 文字色**优先于**背景色:两个信号给出相反答案时,必须按文字判(两边的方向都试)
  check(
    themeOf(boxWith("rgb(250, 250, 250)", null, "rgb(245, 245, 245)")) === "dark",
    "判定(优先级):文字浅 + 背景浅(矛盾夹具)→ 按**文字**判 dark"
  );
  check(
    themeOf(boxWith("rgb(20, 20, 20)", null, "rgb(30, 30, 30)")) === "light",
    "判定(优先级):文字深 + 背景暗(矛盾夹具)→ 按**文字**判 light"
  );

  // ①-c 文字色要沿祖先链找(元素自己没有文字色时)
  check(
    themeOf(boxWith(undefined, boxWith(undefined, null, "rgb(240, 240, 240)"))) === "dark",
    "判定(文字色):自己没有文字色 → 沿祖先链找到浅字 → dark"
  );

  // ①-d 文字色必须**完全不透明**才算:半透明的字压在什么底色上都说得通,判不出主题 → 交给背景
  check(
    themeOf(boxWith("rgb(250, 250, 250)", null, "rgba(250, 250, 250, 0.5)")) === "light",
    "判定(文字色):半透明文字不算(跳过),按背景判 light —— 否则浅底会被误判成暗色主题"
  );

  // ② 次选信号:第一个不透明背景(文字读不出来时用)。原有那几条全部保留,口径不变。
  check(themeOf(boxWith("rgb(24, 26, 32)")) === "dark", "判定:暗背景 → dark");
  check(themeOf(boxWith("rgb(250, 250, 250)")) === "light", "判定:浅背景 → light");
  check(themeOf(boxWith("rgb(127, 127, 127)")) === "dark", "判定:亮度 127(卡在 128 下面)→ dark");
  check(themeOf(boxWith("rgb(128, 128, 128)")) === "light", "判定:亮度 128 → light(阈值与用户给的口径一致)");
  check(themeOf(boxWith("rgba(0, 0, 0, 0)", boxWith("rgb(20, 20, 20)"))) === "dark", "判定:alpha=0 的层跳过,按暗祖先 → dark");
  check(themeOf(boxWith("transparent", boxWith("rgb(255, 255, 255)"))) === "light", "判定:transparent 跳过,按浅祖先 → light");
  check(themeOf(boxWith("rgb(20, 20, 20)", boxWith("rgb(255, 255, 255)"))) === "dark", "判定:最近那层不透明背景说了算(不看更远的祖先)");

  // ③ 再次:宿主的主题标记。**遍历属性名与值**,不写死属性名 —— 真实宿主至少用了三种写法:
  // `data-ds-dark-theme`(属性名里带 dark、值是**空串**,见 dsh-client-ui-layout)、
  // `class="dark"`、`data-theme`。前两个信号都读不出来(配色写成 oklch 之类抠不出 rgb)时才轮到它。
  /** 摆好假根元素与 body 上的标记(`className` 传 undefined = 摘掉)。 */
  const setMarkers = (rootClass, bodyAttributes) => {
    doc.documentElement.className = rootClass;
    doc.body = bodyAttributes === null ? undefined : { attributes: bodyAttributes, style: {} };
  };
  setMarkers("dark", null);
  preference.matches = false; // 偏好故意说浅色 —— 判出 dark 就说明走的是标记那条,不是兜底
  check(themeOf(boxWith("")) === "dark", '宿主标记:根元素 class="dark" → dark(偏好是浅色,兜底那条被挡在后面)');
  setMarkers(undefined, [{ name: "data-theme", value: "dark" }]);
  check(themeOf(boxWith("")) === "dark", '宿主标记:body 的 data-theme="dark" → dark');
  setMarkers(undefined, [{ name: "data-ds-dark-theme", value: "" }]);
  check(
    themeOf(boxWith("")) === "dark",
    '宿主标记:属性**名**里带 dark、值是空串也认(body[data-ds-dark-theme] 就是这么标的 —— 只扫属性值会漏掉它)'
  );
  setMarkers(undefined, [{ name: "data-color-scheme", value: "dark" }]);
  check(themeOf(boxWith("")) === "dark", '宿主标记:data-color-scheme="dark" → dark(不写死属性名)');
  preference.matches = true; // 反过来:偏好说深色,标记说浅色 → 必须按标记
  setMarkers("theme-light", null);
  check(themeOf(boxWith("")) === "light", '宿主标记:class="theme-light" → light(系统偏好说 dark 也不听它的)');
  setMarkers("lightbox", null);
  check(
    themeOf(boxWith("")) === "dark",
    '"lightbox" 这种**不是**标记:按词边界判(不然一个含 light 的类名就能把主题判反)'
  );
  setMarkers(undefined, null); // 收尾:标记摘掉,后面的挂载断言不受影响

  // ④ 兜底:一路都读不到就走系统偏好;异常也不许抛(设置页不能因此崩)
  preference.matches = true;
  check(themeOf(boxWith("")) === "dark", "判定:一路都读不到 → 回退系统偏好(dark)");
  preference.matches = false;
  check(themeOf(boxWith("")) === "light", "判定:回退到的偏好是浅色 → light");
  check(themeOf(undefined) === "light" && themeOf(null) === "light", "判定:没有元素也不抛错(回退 light)");
  check(themeOf(brokenBox) === "light", "判定:读计算样式抛异常也不抛错(回退 light)—— 设置页不能因此崩");

  // ⑤ 自动填充那条:必须用 inset box-shadow 盖回去,而且颜色**走 CSS 变量、不写死**
  //(写死颜色 = 暗色主题下把框盖成另一种错色,还不如不写)
  const styleText = doc.styles.map((sheet) => String(sheet.textContent)).join("\n");
  check(styleText.includes(":-webkit-autofill"), "样式表里有自动填充(-webkit-autofill)那条处理");
  check(
    /:-webkit-autofill\s*\{[^}]*inset 0 0 0 1000px var\(--fpga-set-field-bg\)/u.test(styleText),
    "自动填充用 inset box-shadow 盖回主题底色,颜色取自 CSS 变量(不是写死的颜色)"
  );
  check(
    /\.fpga-set\s*\{[^}]*--fpga-set-field-bg:/u.test(styleText),
    "那个 CSS 变量有默认值(定义在 .fpga-set 上,宿主也能覆盖)"
  );

  // ⑥ 下拉弹层(base-select):宿主暗色下弹层曾是白底浅字,靠 color-scheme 治不动(实测这套
  // Electron 的原生弹层不吃它),所以改用可自定义 select 让页面自己画弹层。两条硬约束:
  //   · **必须在 @supports 里** —— 不支持的引擎整段不生效,不能因为这条新样式把现状改坏;
  //   · 颜色**走变量/继承,不写死** —— 写死就等于把弹层钉在某一种主题上。
  check(
    /@supports\s*\(appearance:\s*base-select\)\s*\{/u.test(styleText),
    "弹层配色那段包在 @supports (appearance: base-select) 里(不支持的引擎保持现状)"
  );
  check(
    /::picker\(select\)\s*\{[^}]*appearance:\s*base-select[^}]*background-color:\s*var\(--fpga-set-field-bg\)/u.test(styleText),
    "弹层的底色取自 CSS 变量(不是写死的颜色),并且选择器与弹层两处都进了 base-select"
  );
  check(
    /select\.fpga-set-input::picker-icon\s*\{\s*color:\s*inherit/u.test(styleText),
    "箭头颜色继承当前文字色(不自绘第二个箭头,也不写死颜色)"
  );
  check(
    /select\.fpga-set-input\s*\{[^}]*white-space:\s*nowrap/u.test(styleText),
    "收起状态补了单行截断(base-select 默认会把长标签折成两行,原生不会)"
  );

  // ② 挂载:容器与**根元素**都要按判出来的主题显式声明 color-scheme
  //
  // 前面每一轮 runEffects 都跑过这条 effect、却从没有跑过清理函数(替身不自动卸载),所以先收尾:
  // 让根元素上那些旧值还回去、订阅者退掉,下面才数得准、断言才有意义。
  fake.reset();
  captured();
  for (const cleanup of fake.runEffects()) cleanup();
  doc.documentElement.style.colorScheme = "light"; // 宿主页面原本声明的值(改动前)
  preference.matches = false; // 系统偏好故意与**实际底色**相反 —— 靠偏好判就会判错

  const rootBox = boxWith("rgb(20, 22, 28)"); // 暗色主题下容器实际的底色
  fake.reset();
  const mounted = captured();
  mounted.props.ref.current = rootBox; // 替身不会替我们挂 ref(真 React 挂载时自己会挂),手动接上
  const unmount = fake.runEffects();
  check(
    rootBox.style.colorScheme === "dark",
    `挂载后容器声明了判出来的主题(实际 ${String(rootBox.style.colorScheme)})`
  );
  check(
    doc.documentElement.style.colorScheme === "dark",
    `挂载后**根元素**也声明了同一份(实际 ${String(doc.documentElement.style.colorScheme)})` +
      " —— <select> 的弹层按根元素渲染,只设容器它不跟"
  );

  // ③ 卸载:根元素上那个值必须原样还回去(不许插件把宿主页面留在我们设的状态里)
  for (const cleanup of unmount) cleanup();
  check(
    doc.documentElement.style.colorScheme === "light",
    `卸载后根元素恢复成改动前的值(实际 ${String(doc.documentElement.style.colorScheme)})`
  );

  // ④ 主题**变化**时跟得上:订阅 matchMedia 的 change,重新判定(不轮询、不引依赖)
  preference.listeners.length = 0;
  fake.reset();
  const remounted = captured();
  remounted.props.ref.current = rootBox;
  const unmountAgain = fake.runEffects();
  check(preference.listeners.length === 1, `订阅了偏好变化(实际 ${preference.listeners.length} 个订阅者)`);
  backgrounds.set(rootBox, "rgb(245, 245, 245)"); // 主题切成浅色
  flipPreference(false);
  check(rootBox.style.colorScheme === "light", "偏好变化后重新判定:容器跟着变浅");
  check(doc.documentElement.style.colorScheme === "light", "偏好变化后重新判定:根元素也跟着变浅");
  for (const cleanup of unmountAgain) cleanup(); // 收尾:还原 + 退订
  check(preference.listeners.length === 0, "卸载时退订(不留悬挂的监听)");
} catch (error) {
  check(false, "主题跟随能走通", String(error));
}

// ── 版本信息:检测结论那一行要报出**实测版本** ─────────────────────────────────
//
// 光"检测到 C:\...\python.exe"不算报清楚:装的是哪个版本,用户从路径上看不出来。宿主那条检测
// 路由对**会起进程问版本的字段**(现在的 Python 路径)因此多带了 `version` / `versionError` /
// `versionNote`(见 lib/toolchain.js 的 versionInfo)—— 而且**只报实测、不做判定**:本模式现在
// 不把任何版本当硬要求(带 `expected` 的那套判定随终端字段一起删了,2026-09-21)。
// 这一段测的是**客户端把它们渲染出来**:
//   ① versionNote 显示出来;② versionError 时如实说"版本查询失败",但**不**因此说这一行
//   "未就绪"(文件本身是在的);③ 一个版本字段都没有(绝大多数检测项)时不留空标签。
//
// 夹具说明:这里把版本信息搭在 verilatorPath 那条检测结果上；这段只验证版本文字的渲染,
// 这一段渲染与字段键无关。
// 每次渲染前 fake.reset();检测请求走已有的 deferDetect 闸门,resolve 的时机由测试决定。
//
// 辅助函数提取到 try **外面**(纯粹为了让这一段读起来短一些)。
/** 一条检测结果(路径、来源、选项都照假状态表里那份写,只让版本键可变)。 */
const versionHit = (extra) => ({
  field: "verilatorPath",
  tool: "verilator",
  label: "Verilator",
  path: "C:\\msys64\\mingw64\\bin\\verilator_bin.exe",
  source: "known",
  ...extra
});
/**
 * 在渲染树里找节点,**数组也要下钻** —— 检测结论那一段是 `hits.map(...)` 的产物,
 * 在 children 里占一层数组(现成的 findByProp 不下钻数组,取不到里面的东西)。
 * 判断拿到的是**节点**而不是 props:`children` 在替身里挂在节点上(不在 props 上)。
 * @param node - createElement 的产物(或它的 children 里的一层数组)。
 * @param predicate - 对一个节点的判断。
 * @returns 找到的节点,或 undefined。
 */
const findDeep = (node, predicate) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDeep(child, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findDeep(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
};
/** 那一行检测结论(按字段行的 key 取,不靠"树里第几个")。 */
const detectRowOf = (tree, key) =>
  findDeep(findByProp(tree, (props) => props.key === key), (node) => node.props?.className === "fpga-set-detect-row");
/** 那一行里文本恰好是某句话、且带某个 class 的节点(找不到就是 undefined)。 */
const nodeWithText = (row, className, text) =>
  findDeep(row, (node) => node.props?.className === className && (node.children ?? []).includes(text));
/**
 * 受控地跑一次检测:先把积压的 effect 与闸门放干净,再开闸门、渲染一次并触发检测,让这一笔
 * **停在闸门上**;然后放行它,返回**结论落地后**那棵渲染树里对应的一行。
 * @param found - 这一轮 detect 路由的答复。
 * @param label - 这一条的标签(失败时看清是哪一条)。
 * @param key - 取哪一行字段(默认 verilatorPath;末段验别的字段时可换)。
 * @returns `{ tree, row, text, fieldText }`:`tree` 是结论落地后那棵渲染树;`row` 是那一行的
 *   检测结论节点,`text` 是它的 JSON,`fieldText` 是**整个字段行**的 JSON(就绪与否写在
 *   这一行的标签上,"版本没验到不等于未就绪"要对着整行看)。
 */
const detectRowWith = async (found, label, key = "verilatorPath") => {
  deferDetect = null;
  fake.runEffects();
  await tick();
  deferDetect = [];
  detectPayload = { found };
  fake.reset();
  captured();
  fake.runEffects();
  await tick();
  check(deferDetect.length === 1, `${label}检测请求发出去了、停在闸门上(实际 ${deferDetect.length} 次)`);
  deferDetect[0]();
  await tick();
  fake.reset();
  const tree = captured();
  const row = detectRowOf(tree, key);
  return {
    tree,
    row,
    text: JSON.stringify(row ?? {}),
    fieldText: JSON.stringify(findByProp(tree, (props) => props.key === key) ?? {})
  };
};

// 宿主会给的两种 note(照 lib/toolchain.js 里那两句话的措辞,不要另编)。
const okNote = "版本 3.14.0";
const brokenNote = "Python 3 路径可用,但版本查不出来(spawn python.exe ENOENT)";

try {
  // ① 有 versionNote:显示出来(hint 样式 —— 版本查出来了不是问题)
  const noted = await detectRowWith([versionHit({ version: "3.14.0", versionNote: okNote })], "①");
  check(noted.row !== undefined, "①找得到 Verilator 通用路径那一行的检测结论");
  check(
    nodeWithText(noted.row, "fpga-set-hint", okNote) !== undefined,
    `①检测结论里显示了宿主给的 versionNote(实测版本)—— 实际那一行:${noted.text}`
  );

  // ② 版本查不出来(versionError):如实说,但**不**因此把这一行判成未就绪(文件本身是在的)。
  const broken = await detectRowWith(
    [versionHit({ versionError: "spawn python.exe ENOENT", versionNote: brokenNote })],
    "②"
  );
  const brokenRow = JSON.stringify(broken.row ?? {});
  check(brokenRow.includes("版本查询失败:spawn python.exe ENOENT"), `②versionError:如实说「版本查询失败:…」—— 实际那一行:${brokenRow}`);
  check(
    broken.fieldText.includes("已就绪") && !broken.fieldText.includes("未就绪"),
    "②版本没验到不等于未就绪(文件在,这一行照旧是「已就绪」)"
  );

  // ③ 一个版本字段都没有(绝大多数检测项):一个标签都不留,更不许留空壳
  const plain = await detectRowWith([versionHit({})], "③");
  const strays = (plain.row?.children ?? []).filter(
    (child) => child !== null && typeof child === "object" && child.type !== "button"
  );
  check(strays.length === 0, `③没有版本字段时那一行不多任何标签(实际多出 ${strays.length} 个)`);
  check(!JSON.stringify(plain.row ?? {}).includes("版本"), "③没有版本字段时不出现版本文字(不留空标签)");
} catch (error) {
  check(false, "检测结论里的版本信息能走通", String(error));
} finally {
  // 这一段在文件末尾:别把闸门或那份假答复留给后面的人
  deferDetect = null;
  detectPayload = { found: [] };
}

// ── 待清理清单要在设置页看得见(第 4 件) ──────────────────────────────────────
//
// "事实报了、但没人看见"那一类:待清理清单只躺在宿主日志里,设置页一个字都不显示 —— 用户不知道
// 该清什么(而且插件零删除,他不处置就永远留着)。
//
// ⚠ 这一段原来还捎带着验"版本期望进状态"(F-05)与"不采用版本不匹配的候选"(F-06)。那两条守护的
// 是**版本要求**这条能力:终端字段(唯一声明过版本要求的字段)已于 2026-09-21 删掉(理由见
// lib/toolchain.js 的 FIELDS 顶上那段注),`versionExpected` / `versionOk` 这套判定随它一起删除 ——
// 于是那两条自检也没有了被测对象(留着就是拿夹具去测一段永远不执行的分支),一并删掉。
// 仍然在验的是:检测结论照实报**实测版本**(见上面那段)、以及下面这段待清理清单。
try {
  // 待清理清单要在设置页看得见(第 4 件):路径 + 类别 + "只是提示,不会自动删",且没有删除按钮
  const stalePath = "C:\\home\\.agent-presets\\fpga-workbench\\skills\\gone\\SKILL.md";
  const emptyDirPath = "C:\\home\\.agent-presets\\fpga-workbench\\skills\\旧技能";
  statusPreset = {
    state: "synced",
    dir: "C:\\home\\.agent-presets\\fpga-workbench",
    pendingCleanup: [
      { kind: "stale", label: "过期技能/模板", path: stalePath },
      { kind: "emptyDir", label: "空技能目录", path: emptyDirPath }
    ]
  };
  fake.reset();
  captured();
  fake.runEffects();
  await tick();
  fake.reset();
  const cleanupTree = captured();
  const cleanupText = JSON.stringify(cleanupTree ?? {});
  check(
    cleanupText.includes(asJsonText(stalePath)) && cleanupText.includes(asJsonText(emptyDirPath)),
    `第 4 件:两条待清理路径都渲染出来(实际 ${cleanupText.slice(0, 240)})`
  );
  check(cleanupText.includes("过期技能/模板") && cleanupText.includes("空技能目录"), "第 4 件:每条带上类别");
  check(/不会自动删/u.test(cleanupText), "第 4 件:说清这只是提示、不会自动删");
  check(countButtons(cleanupTree, "删除") === 0, "第 4 件:没有任何删除按钮(零删除,不做一键删除)");

  // 条目多时只给条数(不把一屏清单铺出来);前几条照旧全列
  statusPreset = {
    ...statusPreset,
    pendingCleanup: Array.from({ length: 8 }, (_, index) => ({
      kind: "temp",
      label: "临时项",
      path: `C:\\tmp\\leftover-${String(index)}.tmp`
    }))
  };
  fake.reset();
  captured();
  fake.runEffects();
  await tick();
  fake.reset();
  const manyText = JSON.stringify(captured() ?? {});
  check(
    manyText.includes("另有") && !manyText.includes(asJsonText("C:\\tmp\\leftover-7.tmp")),
    "第 4 件:条目多时给条数,不把一屏清单全铺出来"
  );
  check(
    manyText.includes("临时项") && manyText.includes(asJsonText("C:\\tmp\\leftover-0.tmp")),
    "第 4 件:少量时全列(前几条路径照旧显示)"
  );
} catch (error) {
  check(false, "版本期望 / 候选采用 / 待清理清单这几段渲染能走通", String(error));
} finally {
  deferDetect = null;
  detectPayload = { found: [] };
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 加载契约成立,客户端渲染冒烟也过了(重启前可以放心)");
if (failures.length > 0) process.exitCode = 1;
