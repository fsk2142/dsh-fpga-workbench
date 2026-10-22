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
import { spawnSync } from "./lib/spawn.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
check(manifest.dsh?.manifestVersion === 1, `清单声明 dsh.manifestVersion = 1(实际 ${String(manifest.dsh?.manifestVersion)})`);
// 兼容声明：**不写死范围字符串**，只要求"四个版本都声明了、且范围覆盖它们"。
// 写死字面量的后果是"加一个兼容版本就得改两处"，而漏改的一处会让测试红
// （这次就因为给范围补 0.2.0-rc.2 而红过一次）。真正要守的是**一致性**，
// 那条断言在 check-version.mjs 里（dshReleases ⊆ 范围、peer 与范围一致）。
check(
  ["0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2", "0.2.1-rc.2"].every(
    (release) =>
      manifest.dsh?.compatibility?.dshReleases?.[release] === "compatible" &&
      String(manifest.dsh?.compatibility?.dsh ?? "").includes(release)
  ),
  "清单声明兼容 DSH 0.1.7-rc.2、0.2.0-rc.1、0.2.0-rc.2 与 0.2.1-rc.2，且范围覆盖它们"
);
check(
  Array.isArray(manifest.dsh?.client?.inject) &&
    manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-slots") &&
    manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"),
  "客户端清单声明 slots 与 settings 服务模块"
);
check(manifest.dsh?.client?.platform === "web", "客户端清单声明 web 平台");
// 官方启动门禁(dsh-app-boot evaluatePluginCompatibility)只读 peerDependencies 里
// @deepseek-ai/dsh / @deepseek-ai/dsh-* 的范围;dsh.compatibility 不参与拦截。
// 没有这条 peer,未验证的宿主版本照样会加载本插件。
const dshPeers = Object.entries(manifest.peerDependencies ?? {}).filter(
  ([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")
);
check(
  dshPeers.length > 0 &&
    dshPeers.every(([, range]) => range === manifest.dsh?.compatibility?.dsh),
  "peerDependencies 声明了与 compatibility 一致的 DSH 版本范围(官方启动门禁只读 peer)"
);
check(manifest.icon === "icon.svg", `清单声明插件图标 icon.svg(实际 ${String(manifest.icon)})`);
check(existsSync(join(ROOT, "icon.svg")), "插件图标文件存在");
check((manifest.files ?? []).includes("icon.svg"), "files 白名单包含 icon.svg(否则安装副本没有图标)");

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
// 源码文本断言读 **src/**，不读 lib/（2026-10-22 迁移到 tsdown 后调整）。
//
// 这些断言验的是"源码写对了"——比如 `/export function apply/`、`/export const inject =/`。
// 迁移后 lib/ 是编译产物，导出被聚合成 `export { apply, inject, ... }`，源码语法全变了，
// 断言会全部失效（误报"缺失"）。判据本身没错，只是目标该指向源码。
// 客户端有**两类**断言，目标不同，别搞混（2026-10-22 迁移时踩过）：
//
//   · **产物**类：loader id、`exports.apply`、无 static import、CSS 文本 —— 这些
//     只能读 `lib/client.js`。迁移前源码里手写过那层包装，所以读源码也碰巧能过；
//     迁移后源码是标准 ESM、包装由 tsdown 生成，只有产物里才有这些特征。
//   · **源码**类：业务逻辑里的字符串常量（见文件后半段）。
//
// 早先我把这一整段都改成读 src/，结果 5 条产物断言全红 —— 它们本来就该读产物。
const clientBundle = read("lib/client.js");
const clientCode = clientBundle
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
const client = read("src/client/index.ts");
const loaderId = /__ModuleLoader__\.load\(\{[\s\S]{0,120}?id:\s*"([^"]+)"/u.exec(clientBundle)?.[1];
check(loaderId === manifest.name, `bundle 的 loader id 等于包名(实际 ${String(loaderId)} vs ${manifest.name})`);
// `inject` 的**形状**要看源码里的定义。
//
// tsdown 产物里是 `exports.inject = inject`（引用变量），字面量 `[` 不在那儿 ——
// 断言"必须是数组"要查 `const inject = [...]` / `export const inject = [...]`。
// 而"产物里确实导出了 inject 这个名字"由上面那条 `exports.inject =` 守着。
check(/export\s+const\s+inject\s*=\s*\[/u.test(client), "源码里 inject 是数组字面量(写成对象会让整行不激活)");
check(!/export\s+const\s+inject\s*=\s*\{/u.test(client), "源码里 inject 不是对象字面量");
// 2026-10-22（照 dsh-safe-delete）：配置页必须等 `configForms` 就绪再注册。
// 少这一步时「槽位注册成功、但页面上的「配置」入口不出现，且不报错」——
// 从现象看就是"插件页找不到设置"。这条断言防的是以后有人把它删掉。
check(
  /export\s+const\s+inject\s*=\s*\[[^\]]*["']configForms["']/u.test(client),
  "客户端 inject 里带 configForms(否则插件页的「配置」入口不出现且不报错)"
);
check(
  /configForms[\s\S]{0,200}whileServed/u.test(client),
  "客户端用 configForms.whileServed 包住注册(服务撤销时自动注销插槽)"
);
check(/exports\.apply\s*=/u.test(clientBundle), "导出 apply");
check(/exports\.name\s*=/u.test(clientBundle), "导出 name");
check(!/require\(\s*["']\./u.test(clientBundle), "bundle 内没有相对 require(会被拼进组合后解析失败)");
check(!/^\s*import\s/mu.test(clientBundle), "bundle 内没有 static import");
check(
  /\.fpga-set\s+\.fpga-set-collapsed\s*\{\s*display:\s*none/u.test(client),
  "收起样式的优先级高于工具体与能力卡的 display:flex"
);
check(!/settingsScope/u.test(clientCode) && /plugins\.bundle\.config/u.test(clientCode),
  "客户端使用 0.1.7 的 plugins.bundle.config 槽(不再依赖 settingsScope)");
// **不在「设置」侧栏再放一份**（2026-10-22 按用户的取舍）。
//
// 这些配置装一次就不怎么动，宿主也把 `plugins.bundle.config` 定义成"插件自己的配置"，
// 所以只挂在插件详情页。这条断言防的是"以后有人顺手把 settings.section 加回来"。
check(
  !/settings\.section/u.test(clientCode),
  "客户端**不再**注册 settings.section（配置只在「插件 → dsh-fpga-workbench」里改）"
);

// ── 4. 宿主半侧 ────────────────────────────────────────────────────────────
const host = read("src/index.ts");
const hostCode = host
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
check(/export function apply/u.test(host), "宿主导出 apply");
check(/export const inject = \["settings"\]/u.test(host), `宿主 inject 恰好是 ["settings"]`);
check(!/systemPrompt/u.test(host), "index.js 里不出现 systemPrompt(提示只能由模式半侧注册)");
check(!/ctx\.settings\.register/u.test(hostCode), "宿主不再调用 0.1.7 已移除的 settings.register");
check(/export const Config/u.test(host), "宿主导出当前 settings 表单使用的 Config schema");
check(/\.volatile\(\)/u.test(host), "Config 字段标记 volatile(0.1.7 只允许写 volatile 字段)");
check(/service\.describe/u.test(hostCode) && /service\.update\(NS/u.test(hostCode), "宿主使用 0.1.7 的 describe/update settings API");
const patchText = read("cordis.patch.yml");
check(!/- id: agent-presets/u.test(patchText), "补丁不再覆盖已移除的 agent-presets 行");
check(
  /- id: preset-fpga-workbench[\s\S]*?name: '@deepseek-ai\/dsh-agent-preset'/u.test(patchText),
  "补丁按官方 0.1.7 格式插入 @deepseek-ai/dsh-agent-preset 预设行"
);
check(/export const name = /u.test(host), "宿主导出 name");
check(
  /export const TEMPLATE_PATH = "\/plugins\/fpga-workbench\/templates"/u.test(host) &&
    /path:\s*TEMPLATE_PATH/u.test(host),
  "宿主登记分类模板只读接口"
);
check(
  /CAPABILITIES\.some\(\(entry\) => entry\.key === capability\)/u.test(host) &&
    /scanTemplates\(\{[\s\S]{0,240}?capability,[\s\S]{0,240}?capabilities:\s*CAPABILITIES/u.test(host),
  "模板接口只按能力白名单决定扫描分类"
);
check(
  /未知能力，拒绝扫描模板目录[\s\S]{0,80}?400/u.test(host) &&
    /模板读取失败/u.test(host) && /suggested\s*:\s*500/u.test(host),
  "未知能力与模板读取异常返回非 2xx JSON"
);

// 旧版 settings 句柄的调用签名断言已失效:0.1.7 的服务是 describe/update,不是绑定句柄。
// 这里只钉住新接口的两个关键形状,避免把旧 register 契约误当成当前要求。
check(/service\.update\(NS, patch\)/u.test(hostCode), "settings 写入按当前行的 NS 调用 update(NS, patch)");

const mode = read("src/mode.ts");
check(/export const inject = \["systemPrompt"\]/u.test(mode), `模式半侧 inject 是 ["systemPrompt"]`);
check(/export function apply/u.test(mode), "模式半侧导出 apply");
// 0.2.0 的 settings 服务只有 describe/update;会话提示必须从 descriptor 取本插件的真实值。
const modeModule = await import(pathToFileURL(join(LIB, "mode.js")).href);
const modePromptWith = (settings) => {
  let render;
  modeModule.apply({
    get: (name) => name === "settings" ? settings : undefined,
    effect: (register) => register(),
    systemPrompt: { section: ({ text }) => { render = text; } }
  });
  return render();
};
const configuredTool = process.execPath;
check(
  modePromptWith({ describe: () => [{ ns: "fpga-workbench", value: { pythonPath: configuredTool } }] }).includes(configuredTool),
  "0.2.0 模式提示从 settings.describe 读取已保存的工具路径"
);
check(
  modePromptWith({ get: () => ({ pythonPath: configuredTool }) }).includes(configuredTool),
  "旧版模式提示仍能从 settings.get 读取工具路径"
);

// 当前桌面版 standard 已把工作流与插件管理器纳入预设；本插件的复制底座也必须跟上。
const preset = read("presets/fpga-workbench/agent.cordis.yml");
check(/- id: workflow-ptc[\s\S]*?name: '@deepseek-ai\/dsh-workflow-ptc'/u.test(preset), "FPGA 预设包含新版 workflow-ptc 行");
check(!/workflow-worker-thread/u.test(preset), "FPGA 预设不再挂载已移除的 workflow-worker-thread 行");

// 以下两组是**刻意不装**,断言盯的是"别被顺手抄回来"(删掉是有意决定,不是漏抄):
//   · tool-ralph —— 为 fresh-agent 长跑迭代设计,单模块开发不需要;
//   · codex / claude-code 子代理 —— 需另装外部 Bundle 与对应 CLI 环境。
// **注意:goals 与 schedule 不在此列**(2026-10-22 修正)。它们曾被当成"元机制、
// 与 FPGA 无关"删掉 —— 那是判断失误。它们和 todo / ask_user 一样是宿主提供的
// **基础会话能力**,不是垂直领域的附加功能;删掉会造成"别的模式有、本模式没有"的缺口。
// 判据是"这是不是基础能力",不是"这条与 FPGA 有没有直接关系"。
// 断言只看**生效的行**,不看注释 —— 文件里有解释性注释,把它算进来会让断言因为
// "解释自己"而失败(踩过一次)。
const presetActive = preset
  .split(/\r?\n/u)
  .filter((line) => !/^\s*#/u.test(line))
  .join("\n");

check(
  !/- id: tool-ralph/u.test(presetActive) &&
    !/- id: tool-subagent-codex/u.test(presetActive) &&
    !/- id: tool-subagent-claude-code/u.test(presetActive),
  "FPGA 预设刻意不装 ralph / codex / claude-code(精简,不是漏抄)"
);
// goals 与 schedule 相反:**必须装**。这条防的是"又有人把它们当元机制删掉"。
check(
  /- id: command-goal[\s\S]*?name: '@deepseek-ai\/dsh-command-goal'/u.test(presetActive) &&
    /- id: tool-goal[\s\S]*?name: '@deepseek-ai\/dsh-tool-goal'/u.test(presetActive),
  "FPGA 预设装了 goals 两行 —— 目标是基础会话能力,删掉会让用户无法设目标"
);
check(
  /- id: tool-schedule[\s\S]*?name: '@deepseek-ai\/dsh-tool-schedule'/u.test(presetActive),
  "FPGA 预设装了 tool-schedule —— 定时提醒也是基础能力"
);
// 时间上下文相反:**要装** —— 模板文件头的 <DATE> 与"证据是否过期"都要用到"今天"。
check(
  /- id: time-context[\s\S]*?name: '@deepseek-ai\/dsh-time-context'/u.test(presetActive),
  "FPGA 预设装了 time-context(写日期、判证据新鲜度要用)"
);
check(
  /- id: tool-plugin-manager[\s\S]*?name: '@deepseek-ai\/dsh-plugin-manager\/tools'[\s\S]*?disabled: true/u.test(preset),
  "FPGA 预设包含新版插件管理器工具行"
);

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
  moduleRtlTool: "verilator",
  moduleRtlTemplate: "",
  moduleSimulationTool: "auto",
  moduleTestbenchTemplate: "",
  moduleSimulationRunTemplate: "",
  moduleVerificationTool: "auto",
  moduleVerificationTemplate: "",
  moduleGateTool: "auto",
  moduleSynthesisTemplate: "",
  moduleConstraintsTemplate: "",
  projectMainTool: "auto",
  projectRtlTemplate: "",
  projectConstraintsTemplate: "",
  projectSynthesisTemplate: "",
  projectImplementationTemplate: "",
  projectProgrammingTemplate: "",
  projectSimulationTool: "auto",
  projectTestbenchTemplate: "",
  projectSimulationRunTemplate: "",
  projectVerificationTool: "auto",
  projectVerificationTemplate: "",
  xsimPath: "C:\\Vivado\\bin",
  modelsimPath: "C:\\modelsim\\win64\\vsim.exe",
  questaPath: "C:\\questa\\win64\\vsim.exe",
  // 第三个可编辑字段的宿主值:用来验"这次确实存了、期间也没再被改过"的键会正常清掉
  // (与"保存期间又被改过、必须留着"的那个键形成对照)。
  modelsimIniPath: "C:\\modelsim\\modelsim.ini",
  questaIniPath: "C:\\questa\\modelsim.ini",
  templateLibraryPath: ""
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

const readyToolOptions = [
  { value: "auto", label: "由 AI 从已就绪工具中判断", ready: true, disabled: false },
  { value: "verilator", label: "Verilator", ready: true, disabled: false, state: "ready" },
  { value: "iverilog", label: "Icarus Verilog", ready: false, disabled: true, state: "unconfigured" },
  { value: "none", label: "明确不用", ready: true, disabled: false }
];
const autoToolOptions = [
  { value: "auto", label: "由 AI 从已就绪工具中判断", ready: true, disabled: false },
  { value: "modelsim", label: "ModelSim", ready: true, disabled: false, state: "ready" },
  { value: "questa", label: "QuestaSim", ready: true, disabled: false, state: "ready" },
  { value: "xsim", label: "Vivado XSim", ready: true, disabled: false, state: "ready" },
  { value: "vivado", label: "Vivado", ready: false, disabled: true, state: "unconfigured" },
  { value: "python", label: "Python 3", ready: false, disabled: true, state: "unconfigured" },
  { value: "none", label: "明确不用", ready: true, disabled: false }
];
const templateSlot = (key, category, label, name) => ({
  key,
  category,
  label,
  selection: "",
  state: "default",
  present: true,
  source: "builtin",
  id: `builtin:${name}`,
  templateLabel: name.split("/").at(-1),
  summary: "由 AI 自行决定"
});
const capabilityFixtures = [
  {
    key: "module-rtl", section: "module", label: "RTL 编译工具", hint: "用于 RTL 语法、lint 与编译检查。",
    toolKey: "moduleRtlTool", selection: "verilator", state: "ready", toolLabel: "Verilator", present: true,
    toolOptions: readyToolOptions,
    templates: [templateSlot("moduleRtlTemplate", "rtl", "RTL 模板", "rtl/systemverilog_module.sv")]
  },
  {
    key: "module-simulation", section: "module", label: "仿真测试工具", hint: "编译测试平台并运行功能仿真。",
    toolKey: "moduleSimulationTool", selection: "auto", state: "auto", present: true, toolOptions: autoToolOptions,
    templates: [
      templateSlot("moduleTestbenchTemplate", "testbench", "Testbench 模板", "simulation/testbench/systemverilog_testbench.sv"),
      templateSlot("moduleSimulationRunTemplate", "sim-run", "仿真脚本", "simulation/run/modelsim_run.do")
    ]
  },
  {
    key: "module-verification", section: "module", label: "脚本验证工具", hint: "用于参考模型与结果比对。",
    toolKey: "moduleVerificationTool", selection: "auto", state: "auto", present: true, toolOptions: autoToolOptions,
    templates: [templateSlot("moduleVerificationTemplate", "verification", "验证脚本模板", "verification/python_data_verification.py")]
  },
  {
    key: "module-gate", section: "module", label: "综合与门禁工具", hint: "用于模块综合、资源与时序门禁。",
    toolKey: "moduleGateTool", selection: "auto", state: "auto", present: true, toolOptions: autoToolOptions,
    templates: [
      templateSlot("moduleSynthesisTemplate", "synthesis", "综合脚本", "synthesis/vivado_module_synthesis.tcl"),
      templateSlot("moduleConstraintsTemplate", "constraints", "约束模板", "constraints/vivado_module_xdc.xdc")
    ]
  },
  {
    key: "project-main", section: "project", label: "工程主工具", hint: "统一承担综合、实现与下载，但不自动串行执行。",
    toolKey: "projectMainTool", selection: "auto", state: "auto", present: true, toolOptions: autoToolOptions,
    templates: [
      templateSlot("projectRtlTemplate", "rtl", "RTL 模板", "rtl/systemverilog_module.sv"),
      templateSlot("projectConstraintsTemplate", "project-constraints", "约束模板", "constraints/vivado_project_xdc.xdc"),
      templateSlot("projectSynthesisTemplate", "project-synthesis", "综合脚本", "synthesis/vivado_project_synthesis.tcl"),
      templateSlot("projectImplementationTemplate", "implementation", "实现脚本", "implementation/vivado_implementation.tcl"),
      templateSlot("projectProgrammingTemplate", "programming", "下载脚本", "programming/vivado_program.tcl")
    ]
  },
  {
    key: "project-simulation", section: "project", label: "系统仿真工具", hint: "用于系统级测试平台与运行；编译与运行是同一份脚本。",
    toolKey: "projectSimulationTool", selection: "auto", state: "auto", present: true, toolOptions: autoToolOptions,
    templates: [
      templateSlot("projectTestbenchTemplate", "testbench", "Testbench 模板", "simulation/testbench/systemverilog_testbench.sv"),
      templateSlot("projectSimulationRunTemplate", "sim-run", "仿真脚本", "simulation/run/modelsim_run.do")
    ]
  },
  {
    key: "project-verification", section: "project", label: "脚本验证工具", hint: "用于系统级参考模型和结果比对。",
    toolKey: "projectVerificationTool", selection: "auto", state: "auto", present: true, toolOptions: autoToolOptions,
    templates: [templateSlot("projectVerificationTemplate", "verification", "验证脚本模板", "verification/python_data_verification.py")]
  }
];
const capabilityFields = capabilityFixtures.flatMap((capability) => [
  {
    key: capability.toolKey, label: "工具", hint: "只选择顶部已经就绪的工具。", required: false, skips: [],
    section: capability.section, sectionLabel: capability.section === "module" ? "模块工具" : "工程工具",
    capability: capability.key, capabilityLabel: capability.label, group: capability.label,
    control: "select", path: capability.selection, configured: true, present: true, default: "auto",
    options: capability.toolOptions.map(({ value, label }) => ({ value, label }))
  },
  ...capability.templates.map((template) => ({
    key: template.key, label: template.label, hint: "从内置模板与模板库中选择。", required: false, skips: [],
    section: capability.section, sectionLabel: capability.section === "module" ? "模块工具" : "工程工具",
    capability: capability.key, capabilityLabel: capability.label, group: capability.label,
    category: template.category, control: "template", path: template.selection, configured: false, present: true, default: ""
  }))
]);
/** 状态路由的答复(不带查询串那条 = 初次取字段定义)。字段表本身固定。 */
// 假宿主答复里的模板库默认路径:插件真身按包位置算(lib/toolchain.js 的 import.meta.url),
// 这里跟着算 —— 写死成某台机器的绝对路径的话,断言只在那个目录下成立。
const FAKE_TEMPLATE_ROOT = join(ROOT, "presets", "fpga-workbench", "templates");
const payload = {
  values: { ...hostValues },
  sections: [
    { key: "common", label: "工具设置", hint: "逐项登记本机工具" },
    { key: "module", label: "模块工具", hint: "不是流水线" },
    { key: "project", label: "工程工具", hint: "分别设置" }
  ],
  toolGroups: [
    { key: "compiler", label: "编译工具" },
    { key: "simulator", label: "仿真工具" }
  ],
  toolCards: [
    { key: "verilator", role: "compiler", groupLabel: "编译工具", label: "Verilator", pathKey: "verilatorPath", fieldKeys: ["verilatorPath"], kind: "file", path: "C:\\tools\\verilator_bin.exe", configured: true, present: true, detectable: true, state: "ready" },
    { key: "xsim", role: "simulator", groupLabel: "仿真工具", label: "Vivado XSim", pathKey: "xsimPath", fieldKeys: ["xsimPath"], kind: "directory", path: "C:\\Vivado\\bin", configured: true, present: true, detectable: true, state: "ready" },
    { key: "modelsim", role: "simulator", groupLabel: "仿真工具", label: "ModelSim", pathKey: "modelsimPath", fieldKeys: ["modelsimPath"], kind: "file", path: "C:\\modelsim\\win64\\vsim.exe", configured: true, present: true, detectable: true, state: "ready" },
    { key: "questa", role: "simulator", groupLabel: "仿真工具", label: "QuestaSim", pathKey: "questaPath", fieldKeys: ["questaPath"], kind: "file", path: "C:\\questa\\win64\\vsim.exe", configured: true, present: true, detectable: true, state: "ready" }
  ],
  capabilities: capabilityFixtures,
  tools: [
    { key: "verilatorPath", tool: "verilator", label: "Verilator", hint: "填写 verilator_bin.exe", required: false, skips: [], section: "common", sectionLabel: "工具设置", group: "编译工具", control: "text", kind: "file", path: "C:\\tools\\verilator_bin.exe", configured: true, present: true, detectable: true },
    // 目录字段保留浏览分支覆盖；它也是工具设置字段,不会受任何环节选择影响。
    { key: "xsimPath", tool: "xsim", label: "Vivado XSim", hint: "填写 Vivado bin 目录", required: false, skips: [], section: "common", sectionLabel: "工具设置", group: "仿真工具", control: "text", kind: "directory", path: "C:\\Vivado\\bin", configured: true, present: true, detectable: true },
    { key: "modelsimPath", tool: "modelsim", label: "ModelSim", hint: "填写 ModelSim 的 vsim.exe", required: false, skips: [], section: "common", sectionLabel: "工具设置", group: "仿真工具", control: "text", kind: "file", path: "C:\\modelsim\\win64\\vsim.exe", configured: true, present: true, detectable: true },
    { key: "questaPath", tool: "questa", label: "QuestaSim", hint: "填写 QuestaSim 的 vsim.exe", required: false, skips: [], section: "common", sectionLabel: "工具设置", group: "仿真工具", control: "text", kind: "file", path: "C:\\questa\\win64\\vsim.exe", configured: true, present: true, detectable: true },
    // 第三个可编辑字段(键/标签/组名照 lib/toolchain.js 的 FIELDS):一次保存提交**两个**键时,
    // 才分得清"存下去且没人再动它"(该清)和"存下去但期间又被改过"(该留)。
    { key: "modelsimIniPath", label: "ModelSim 库映射文件", hint: "填 ModelSim 的 modelsim.ini", required: false, skips: [], section: "common", sectionLabel: "工具设置", path: "C:\\modelsim\\modelsim.ini", configured: true, present: true, group: "仿真库", control: "text", kind: "file", detectable: false },
    { key: "questaIniPath", label: "QuestaSim 库映射文件", hint: "填 QuestaSim 的 modelsim.ini", required: false, skips: [], section: "common", sectionLabel: "工具设置", path: "C:\\questa\\modelsim.ini", configured: true, present: true, group: "仿真库", control: "text", kind: "file", detectable: false },
    { key: "rtlLangStd", label: "RTL 语言与标准", hint: "语言设置", required: false, skips: [], section: "common", sectionLabel: "工具设置", path: "systemverilog-2017", configured: true, present: true, group: "语言标准", control: "select", default: "systemverilog-2017", options: [{ value: "systemverilog-2017", label: "SystemVerilog 1800-2017" }] },
    { key: "templateLibraryPath", label: "模板库路径", hint: "能力卡展开时扫描固定分类。", required: false, skips: [], section: "common", sectionLabel: "工具设置", path: "", configured: false, present: true, group: "模板库", control: "text", kind: "directory", detectable: false, blankNote: "留空只使用插件内置模板", defaultPath: FAKE_TEMPLATE_ROOT },
    ...capabilityFields,
    { key: "legacyCompiler", label: "旧键", hint: "不显示", section: "common", group: "旧键", control: "hidden", path: "", configured: false, present: false }
  ],
  templateLibrary: { fieldKey: "templateLibraryPath", path: "", configured: false, present: true, defaultPath: FAKE_TEMPLATE_ROOT },
  migrationWarnings: [],
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
 * 检测路由的答复:只检测「工具设置」里各工具自己的路径,不会替环节选择工具或改写其他字段。
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
const detectUrls = [];
let templatePayload = {
  capability: "module-rtl",
  groups: [
    {
      key: "rtl",
      label: "RTL 模板",
      directory: "rtl",
      items: [
        {
          id: "builtin:rtl/systemverilog-module.sv", category: "rtl", label: "SystemVerilog RTL 模块",
          relativePath: "rtl/systemverilog_module.sv", source: "builtin", present: true, compatibleTools: ["*"]
        },
        {
          id: "library:rtl/vendor/custom.sv", category: "rtl", label: "vendor/custom.sv",
          relativePath: "rtl/vendor/custom.sv", source: "library", present: true, compatibleTools: null
        }
      ],
      builtinCount: 1,
      libraryCount: 1,
      truncated: false,
      errors: []
    }
  ],
  library: { path: "C:\\templates", configured: true, present: true },
  errors: [],
  ok: true
};
let templateRequested = 0;
const templateUrls = [];
/** 状态路由带查询串的请求次数 = 客户端为"未保存的改动"预演了几次状态。 */
let previewRequested = 0;
/**
 * 状态路由的答复(预演那条路)。**每次请求发出时取当时的这一份** —— 所以测试可以给先后两次
 * 预演安排不同的答复,用来分辨"最后落在界面上的是哪一次的结果"。
 */
let statusPayload = payload;
/** 预演答复:可同时改字段与对应能力,用来验证未保存状态和乱序保护。 */
const previewAnswer = (fieldOverrides, fieldKey = "verilatorPath", capabilityKey, capabilityOverrides = {}) => ({
  ...payload,
  tools: payload.tools.map((entry) => (entry.key === fieldKey ? { ...entry, ...fieldOverrides } : entry)),
  toolCards: payload.toolCards.map((card) => card.pathKey === fieldKey
    ? {
        ...card,
        configured: fieldOverrides.configured ?? card.configured,
        present: fieldOverrides.present ?? card.present,
        state: (fieldOverrides.configured ?? card.configured) !== true
          ? "unconfigured"
          : (fieldOverrides.present ?? card.present) === true ? "ready" : "invalid"
      }
    : card),
  capabilities: payload.capabilities.map((capability) =>
    capability.key === capabilityKey ? { ...capability, ...capabilityOverrides } : capability
  )
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
let deferTemplate = null;
let rejectTemplate = false;
let malformedTemplate = false;
let rejectDetect = false;
let malformedDetect = false;
/** 自检路由:请求计数 + 可切换的答复(正常 / 有阻塞 / 拉不到)。 */
let selfCheckRequested = 0;
let selfCheckUrls = [];
let rejectSelfCheck = false;
let selfCheckPayload = {
  ranAt: "2026-09-29T00:00:00.000Z",
  ok: true,
  failed: 0,
  warned: 1,
  checks: [
    { id: "package", label: "包内运行时文件", status: "pass", detail: "skills / templates / tools / workspace 都在" },
    { id: "tools", label: "已登记工具路径", status: "warn", detail: "还没有登记任何工具路径" }
  ]
};
/** 让下一轮预演直接拒绝,验证失败不能被静默吞掉。 */
let rejectPreview = false;
const fetchStub = (url, options = {}) => {
  const target = String(url);
  if (target.includes("/settings")) {
    let patch = {};
    try {
      patch = JSON.parse(String(options.body ?? "{}")).patch ?? {};
    } catch {
      patch = {};
    }
    written.push(...Object.entries(patch).map(([key, value]) => ({ op: "set", path: [key], value })));
    const accept = () => {
      if (hostAcceptsSave) Object.assign(hostValues, patch);
    };
    if (deferSaves === null) {
      accept();
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ values: { ...hostValues } }) });
    }
    return new Promise((resolve) => deferSaves.push(() => {
      accept();
      resolve({ ok: true, json: () => Promise.resolve({ values: { ...hostValues } }) });
    }));
  }
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
    detectUrls.push(target);
    if (rejectDetect) return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: "offline" }) });
    if (malformedDetect) return Promise.resolve({ ok: true, json: () => Promise.resolve({ unexpected: true }) });
    // 答复照**发出时**那一份取(与上面预演那条同一套):先发后回的乱序里,先发那笔
    // 带的就是它发出时的数据,不被后来的改动串味。
    const data = detectPayload;
    if (deferDetect !== null) {
      return new Promise((resolve) => deferDetect.push(() => resolve({ ok: true, json: () => Promise.resolve(data) })));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  }
  if (target.includes("/templates")) {
    templateRequested += 1;
    templateUrls.push(target);
    if (rejectTemplate) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "scan failed" }) });
    if (malformedTemplate) return Promise.resolve({ ok: true, json: () => Promise.resolve({ capability: "module-rtl" }) });
    const data = templatePayload;
    if (deferTemplate !== null) {
      return new Promise((resolve) => deferTemplate.push(() => resolve({ ok: true, json: () => Promise.resolve(data) })));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  }
  if (target.includes("/selfcheck")) {
    selfCheckRequested += 1;
    selfCheckUrls.push(target);
    if (rejectSelfCheck) {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "self check offline" }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(selfCheckPayload) });
  }
  if (target.includes("?")) {
    previewRequested += 1;
    if (rejectPreview) return Promise.reject(new Error("preview unavailable"));
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
    slots: {
      inject: (name, register) => {
        if (name === "plugins.bundle.config") register();
      },
      register: (spec, component) => {
        captured = component;
        return { dispose() {} };
      }
    }
  });
  check(typeof captured === "function", "设置页把组件注册到了 plugins.bundle.config 槽");
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

// 打开设置页只列出工具与已保存状态，不做全量检测。
const detectBeforeAuto = detectRequested;
fake.runEffects();
await new Promise((resolve) => setImmediate(resolve));
check(
  detectRequested === detectBeforeAuto,
  `打开设置页不会自动检测所有工具(实际发出 ${detectRequested - detectBeforeAuto} 次检测请求)`
);
check(templateRequested === 0, "能力卡都收起时不会扫描模板库");

const rendered = JSON.stringify(secondTree ?? {});
for (const expected of [
  "工具设置", "模块工具", "工程工具", "RTL 编译工具", "仿真测试工具", "脚本验证工具", "综合与门禁工具",
  "工程主工具", "系统仿真工具", "工具：Verilator", "RTL 模板：由 AI 自行决定",
  "ModelSim", "QuestaSim", "语言标准", "仿真库", "ModelSim 库映射文件", "QuestaSim 库映射文件"
]) {
  check(rendered.includes(expected), `三层设置界面出现「${expected}」`);
}
check(!rendered.includes("开发约定与模板"), "界面不再保留旧的「开发约定与模板」区块");
check(!rendered.includes("本环节覆盖路径"), "能力卡里没有重复的工具路径输入框");
const commonSection = findByProp(secondTree, (props) => props.key === "section-common");
check(
  JSON.stringify(commonSection ?? {}).includes("已就绪 4 / 4") &&
    findByProp(commonSection, (props) => String(props.className ?? "").includes("fpga-set-collapsed")) !== undefined,
  "工具设置整体默认收起并显示就绪数量"
);
findButton(commonSection, "展开设置")?.props?.onClick();
fake.reset();
secondTree = captured();
try {
  // 默认模板库根由插件**自己按包位置**算出来(lib/toolchain.js 的 import.meta.url),
  // 所以这里也从包位置算,不写死任何一台机器的绝对路径。
  const defaultTemplateRoot = join(ROOT, "presets", "fpga-workbench", "templates");
  let templateAux = findByProp(secondTree, (props) => props.key === "aux-模板库");
  findButton(templateAux, "展开设置")?.props.onClick();
  fake.reset();
  let templateTree = captured();
  templateAux = findByProp(templateTree, (props) => props.key === "aux-模板库");
  check(findButton(templateAux, "使用默认路径") === undefined, "额外模板库留空即只用默认库,无需把默认路径填进字段");
  check(findButton(templateAux, "保存路径") !== undefined, "模板库在本组内提供独立保存路径按钮");
  written.length = 0;
  // 不再有「使用默认路径」按钮:默认库始终启用,额外库留空即可
  fake.reset();
  templateTree = captured();
  templateAux = findByProp(templateTree, (props) => props.key === "aux-模板库");
  check(
    findByProp(templateAux, (props) => props.value === defaultTemplateRoot) === undefined,
    "不再把插件模板目录填入额外库草稿"
  );
  check(written.length === 0, "额外库路径仍走确认后写设置");
  // 这条原来写的是 `check(true, "额外库路径由用户自行填写后保存(与其它字段同一套保存逻辑)")`
  // —— 字面恒真，什么也没验（2026-10-22 的「检查本身是否有效」审计抓到）。
  // 真去验一次：在模板库输入框里填字 → 点「保存路径」→ 应当产生**一次**设置写入，
  // 且补丁里带的是刚填的那个值。这才是"与其它字段同一套保存逻辑"。
  {
    const input = findByProp(templateAux, (props) => props.value !== undefined && props.onChange !== undefined
      && typeof props.value === "string");
    const typedPath = join(ROOT, "presets", "fpga-workbench", "templates");
    if (input === undefined) {
      check(false, "模板库输入框存在（否则无法验证它的保存逻辑）");
    } else {
      input.props.onChange({ target: { value: typedPath } });
      written.length = 0;
      fake.reset();
      const typedTree = captured();
      const typedAux = findByProp(typedTree, (props) => props.key === "aux-模板库");
      findButton(typedAux, "保存路径")?.props?.onClick();
      await new Promise((resolve) => setImmediate(resolve));
      check(
        written.length === 1 &&
          written[0]?.op === "set" &&
          Array.isArray(written[0]?.path) &&
          written[0].path[0] === "templateLibraryPath" &&
          written[0]?.value === typedPath,
        `额外库路径由用户自行填写后保存(实际写了 ${written.length} 次:${JSON.stringify(written[0] ?? null)})`
      );
    }
  }
  hostValues.templateLibraryPath = "";
  written.length = 0;
  fake.reset();
  secondTree = captured();
} catch (error) {
  check(false, "模板库默认路径与独立保存交互", String(error));
}
const verilatorCard = findByProp(secondTree, (props) => props.key === "tool-verilator");
check(
  findByProp(verilatorCard, (props) => String(props.className ?? "").includes("fpga-set-collapsed")) !== undefined,
  "工具卡默认收起路径编辑区"
);
findButton(verilatorCard, "修改路径")?.props?.onClick();
await new Promise((resolve) => setImmediate(resolve));
check(detectRequested === detectBeforeAuto + 1, "展开一张工具卡只触发一次检测");
check(detectUrls.at(-1)?.includes("field=verilatorPath"), "检测请求明确带上当前工具路径字段");
fake.reset();
secondTree = captured();
const help = findByProp(secondTree, (props) => props.className === "fpga-set-help");
check(help?.type === "button" && help.children?.[0] === "?", "字段说明以可聚焦的问号按钮显示");
check(findByProp(help, (props) => props.role === "tooltip") !== undefined, "问号说明使用 tooltip 语义");
check(typeof help?.props?.["aria-describedby"] === "string", "问号可通过键盘聚焦读取说明");
check(rendered.includes("填写 verilator_bin.exe"), "完整说明仍存在于 tooltip 中");
check(!rendered.includes("当前阶段") && !rendered.includes("下一阶段") && !rendered.includes("完成百分比"), "界面不引入流水线状态");
check(!rendered.includes("旧键"), "隐藏字段没有被渲染出来");
check(browserRequested === 0, "没点「浏览…」时不会去请求接口(不白跑)");

// 检测入口合并在每张卡的“路径设置/修改路径”里，不另放一组全量检测按钮。
check(
  countButtons(secondTree, "检测本组工具") === 0,
  `页面里没有「检测本组工具」按钮(实际 ${countButtons(secondTree, "检测本组工具")} 个)`
);

check(
  findButton(findByProp(secondTree, (props) => props.key === "tool-verilator"), "保存此工具") !== undefined,
  "每张展开的工具卡有自己的保存按钮"
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
  let picked = captured();
  check(
    findByProp(picked, (props) => props.value === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe") !== undefined,
    "过滤到唯一一项后回车:选中的值出现在输入框里"
  );
  check(written.length === 0, "回车选中**不立刻写设置**(改动先留在页面上)");
  check(JSON.stringify(picked ?? {}).includes("有未保存的改动"), "回车选中后出现「有未保存的改动」");

  // 新路径先由状态接口核验；结果回来前卡片只显示“正在检查”，不能直接保存。
  fake.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 400));
  fake.reset();
  picked = captured();

  // 点这张卡自己的保存:一次原子提交;宿主接受后未保存标记消失
  written.length = 0;
  findButton(findByProp(picked, (props) => props.key === "tool-verilator"), "保存此工具").props.onClick();
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
  captured();
  fake.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 400));
  fake.reset();
  findButton(findByProp(captured(), (props) => props.key === "tool-verilator"), "保存此工具").props.onClick();
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
  findButton(findByProp(rejected, (props) => props.key === "tool-verilator"), "取消").props.onClick();
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

// 能力卡只选择顶部已经就绪的工具；不拥有路径，也不会因为展开或切换选择而重跑工具检测。
try {
  written.length = 0;
  fake.reset();
  const beforeChoice = captured();
  const capabilityCard = findByProp(beforeChoice, (props) => props.key === "capability-module-rtl");
  findButton(capabilityCard, "展开设置")?.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  const openedCapability = captured();
  const selectorRow = findByProp(openedCapability, (props) => props.key === "moduleRtlTool");
  const selectNode = findByProp(selectorRow, (props) => props.value === "verilator" && typeof props.onChange === "function");
  check(selectNode !== undefined, "找得到模块 RTL 能力的工具下拉");
  const unreadyIcarus = findByProp(selectNode, (props) => props.value === "iverilog");
  const autoOption = findByProp(selectNode, (props) => props.value === "auto");
  const noneOption = findByProp(selectNode, (props) => props.value === "none");
  check(unreadyIcarus?.props?.disabled === true, "未就绪工具可见但不可选");
  check(autoOption?.props?.disabled !== true && noneOption?.props?.disabled !== true, "auto 与 none 始终可选");
  const detectsBeforeChoice = detectRequested;
  const previewsBeforeChoice = previewRequested;
  selectNode.props.onChange({ target: { value: "none" } });
  fake.reset();
  const unused = captured();
  check(findByProp(unused, (props) => props.key === "moduleRtlCompilerPath") === undefined, "能力卡始终没有阶段覆盖路径");
  check(
    findByProp(unused, (props) => props.value === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe") !== undefined,
    "能力改成不用时仍保留顶部 Verilator 路径"
  );
  check(detectRequested === detectsBeforeChoice, "展开能力卡和切换选择都不会重跑工具检测");
  check(written.length === 0, "切换能力工具只进入未保存区(不立刻写设置)");

  // 未保存的选择也要预演能力状态，但不保存、不改顶部路径。
  fake.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 400));
  check(previewRequested > previewsBeforeChoice, "未保存的能力选择会预演状态");

  fake.reset();
  const noneTree = captured();
  findByProp(
    findByProp(noneTree, (props) => props.key === "moduleRtlTool"),
    (props) => props.value === "none" && typeof props.onChange === "function"
  )?.props.onChange({ target: { value: "verilator" } });
  fake.reset();
  const restoredChoice = captured();
  check(findByProp(restoredChoice, (props) => props.key === "moduleRtlCompilerPath") === undefined, "显式工具也不会出现第二份路径");
  check(hostValues.verilatorPath === "C:\\msys64\\mingw64\\bin\\verilator_bin.exe", "切换能力选择没有改写已保存的顶部路径");
  findButton(findByProp(restoredChoice, (props) => props.key === "capability-module-rtl"), "取消")?.props.onClick();
} catch (error) {
  check(false, "能力选择与顶部工具路径互不改写", String(error));
}

// 模板库只在能力卡展开时按需扫描；关闭重开必须重新扫描，旧请求不能覆盖新请求。
try {
  const beforeTemplates = templateRequested;
  fake.reset();
  let tree = captured();
  let card = findByProp(tree, (props) => props.key === "capability-module-rtl");
  findButton(card, "展开设置").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  check(templateRequested === beforeTemplates + 1, "展开能力卡才扫描一次模板库");
  check(templateUrls.at(-1)?.includes("capability=module-rtl"), "模板扫描请求只携带当前能力标识");
  fake.reset();
  tree = captured();
  card = findByProp(tree, (props) => props.key === "capability-module-rtl");
  const cardText = JSON.stringify(card ?? {});
  check(cardText.includes("vendor/custom.sv") && !cardText.includes("仿真脚本"), "展开卡只显示当前能力需要的模板分类");
  findButton(card, "收起").props.onClick();
  fake.reset();
  tree = captured();
  card = findByProp(tree, (props) => props.key === "capability-module-rtl");
  findButton(card, "展开设置").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  check(templateRequested === beforeTemplates + 2, "能力卡关闭后重开会重新扫描模板库");
  fake.reset();
  findButton(findByProp(captured(), (props) => props.key === "capability-module-rtl"), "收起").props.onClick();
} catch (error) {
  check(false, "能力卡按展开状态扫描模板库", String(error));
}

try {
  const savedTemplatePayload = templatePayload;
  deferTemplate = [];
  templatePayload = {
    ...savedTemplatePayload,
    groups: savedTemplatePayload.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, label: `旧请求-${item.label}` }))
    }))
  };
  fake.reset();
  let tree = captured();
  let card = findByProp(tree, (props) => props.key === "capability-module-rtl");
  findButton(card, "展开设置").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  templatePayload = {
    ...savedTemplatePayload,
    groups: savedTemplatePayload.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, label: `新请求-${item.label}` }))
    }))
  };
  fake.reset();
  tree = captured();
  card = findByProp(tree, (props) => props.key === "capability-module-rtl");
  findButton(card, "收起").props.onClick();
  fake.reset();
  tree = captured();
  card = findByProp(tree, (props) => props.key === "capability-module-rtl");
  findButton(card, "展开设置").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  check(deferTemplate.length === 2, `模板竞态:两次扫描都已挂起(实际 ${deferTemplate.length} 次)`);
  deferTemplate[1]();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  let settled = findByProp(captured(), (props) => props.key === "capability-module-rtl");
  check(JSON.stringify(settled ?? {}).includes("新请求-vendor/custom.sv"), "模板竞态:后发扫描先显示");
  deferTemplate[0]();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  settled = findByProp(captured(), (props) => props.key === "capability-module-rtl");
  check(!JSON.stringify(settled ?? {}).includes("旧请求-vendor/custom.sv"), "模板竞态:先发旧扫描不会盖回界面");
  findButton(settled, "收起").props.onClick();
  templatePayload = savedTemplatePayload;
} catch (error) {
  check(false, "模板扫描具备乱序保护", String(error));
} finally {
  deferTemplate = null;
}

// 非 2xx 与畸形答复都必须明确报错，不能伪装成“扫描为空”或“没检测到”。
try {
  rejectTemplate = true;
  fake.reset();
  let tree = captured();
  let card = findByProp(tree, (props) => props.key === "capability-module-rtl");
  findButton(card, "展开设置").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  tree = captured();
  check(JSON.stringify(tree ?? {}).includes("模板读取失败"), "模板接口非 2xx 时明确显示读取失败");
  findButton(findByProp(tree, (props) => props.key === "capability-module-rtl"), "收起").props.onClick();
  rejectTemplate = false;

  malformedTemplate = true;
  fake.reset();
  tree = captured();
  card = findByProp(tree, (props) => props.key === "capability-module-rtl");
  findButton(card, "展开设置").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  tree = captured();
  check(JSON.stringify(tree ?? {}).includes("模板读取失败"), "模板接口畸形答复时明确显示读取失败");
  findButton(findByProp(tree, (props) => props.key === "capability-module-rtl"), "收起").props.onClick();
} catch (error) {
  check(false, "模板接口异常可见", String(error));
} finally {
  rejectTemplate = false;
  malformedTemplate = false;
}

try {
  rejectDetect = true;
  fake.reset();
  let tree = captured();
  let card = findByProp(tree, (props) => props.key === "tool-verilator");
  if (findButton(card, "收起") !== undefined) {
    findButton(card, "收起").props.onClick();
    fake.reset();
    tree = captured();
    card = findByProp(tree, (props) => props.key === "tool-verilator");
  }
  findButton(card, "修改路径").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  tree = captured();
  check(JSON.stringify(tree ?? {}).includes("工具检测失败") && !JSON.stringify(tree ?? {}).includes("没检测到(Verilator)"), "工具接口非 2xx 不会伪装成没检测到");
  findButton(findByProp(tree, (props) => props.key === "tool-verilator"), "收起").props.onClick();
  rejectDetect = false;

  malformedDetect = true;
  fake.reset();
  tree = captured();
  card = findByProp(tree, (props) => props.key === "tool-verilator");
  findButton(card, "修改路径").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  fake.reset();
  tree = captured();
  check(JSON.stringify(tree ?? {}).includes("工具检测失败") && !JSON.stringify(tree ?? {}).includes("没检测到(Verilator)"), "工具接口畸形答复不会伪装成没检测到");
  findButton(findByProp(tree, (props) => props.key === "tool-verilator"), "收起").props.onClick();
} catch (error) {
  check(false, "工具检测接口异常可见", String(error));
} finally {
  rejectDetect = false;
  malformedDetect = false;
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
  const discard = findButton(captured(), "取消");
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

  // 1) 在独立的「仿真库」组里同时修改 ModelSim 与 QuestaSim 两份映射文件。
  const midA = "C:\\mid\\modelsim.ini";
  const savedC = "C:\\lib\\questa-modelsim.ini";
  inputOf("modelsimIniPath").props.onChange({ target: { value: midA } });
  inputOf("questaIniPath").props.onChange({ target: { value: savedC } });
  fake.runEffects();
  await new Promise((resolve) => setTimeout(resolve, 400));
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
  inputOf("modelsimIniPath").props.onChange({ target: { value: "C:\\late\\modelsim.ini" } });

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
    findByProp(rowOf("modelsimIniPath"), (props) => props.value === "C:\\late\\modelsim.ini") !== undefined,
    "保存期间又被改过的 A 显示用户最后敲的那个新值(不是刚保存的中间值)"
  );
  check(
    JSON.stringify(rowOf("modelsimIniPath") ?? {}).includes("未保存"),
    "A 仍然带「未保存」标记(它和刚存下去的那份已经不一样了)"
  );
  // ③ 这次确实存了、期间也没人再动它的 C 正常清掉
  check(
    findByProp(rowOf("questaIniPath"), (props) => props.value === savedC) !== undefined,
    "C 显示的就是刚保存下去的那份"
  );
  check(
    !JSON.stringify(rowOf("questaIniPath") ?? {}).includes("未保存"),
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

  // ② 单工具检测:连续两次展开同一张卡,先发的旧结果最后回来。
  fake.runEffects();
  await tick();
  deferDetect = [];
  detectPayload = { found: [] }; // 先发:没找到
  fake.reset();
  let detectTree = captured();
  findButton(findByProp(detectTree, (props) => props.key === "tool-verilator"), "修改路径").props.onClick();
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
  detectTree = captured();
  findButton(findByProp(detectTree, (props) => props.key === "tool-verilator"), "收起").props.onClick();
  fake.reset();
  detectTree = captured();
  findButton(findByProp(detectTree, (props) => props.key === "tool-verilator"), "修改路径").props.onClick();
  check(deferDetect.length === 2, `两次检测请求都发出去了、都停在路上(实际 ${deferDetect.length} 次)`);
  deferDetect[1](); // 最新那次(找到)先回
  await tick();
  deferDetect[0](); // 旧那次(没找到)最后回
  await tick();
  fake.reset();
  const detectRow = JSON.stringify(findByProp(captured(), (props) => props.key === "verilatorPath") ?? {});
  check(detectRow.includes("verilator_bin.exe"), "乱序返回:工具设置行显示后发那次检测到的路径");
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
    "页面预演说路径不存在时,工具设置行立即显示不可用"
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
  const optionalRow = await onePreview(previewAnswer({ configured: false, present: false }, "questaIniPath"));
  check(optionalRow.held.length === 1, `可选字段的预演请求发出去了(实际 ${optionalRow.held.length} 次)`);
  optionalRow.held[0]();
  await tick();
  fake.reset();
  const optionalText = JSON.stringify(findByProp(captured(), (props) => props.key === "questaIniPath") ?? {});
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
  findButton(findByProp(tree, (props) => props.key === "tool-verilator"), "取消").props.onClick(); // 在**已经渲染好的**树上点,免得又排一次防抖
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

// 检测请求发出后用户又手填了路径:晚回来的候选只能显示,不能覆盖这笔更新。
// 检测本身可能因为版本探测等几秒,这不是理论窗口。
try {
  fake.runEffects();
  await sleep(400);
  fake.reset();
  const before = captured();
  const discard = findButton(before, "取消");
  if (discard !== undefined && discard.props.disabled !== true) discard.props.onClick();

  const field = payload.tools.find((entry) => entry.key === "verilatorPath");
  const savedHostPath = hostValues.verilatorPath;
  const savedField = { path: field.path, configured: field.configured, present: field.present };
  const manualPath = "D:\\manual\\verilator_bin.exe";
  try {
    hostValues.verilatorPath = "";
    field.path = "";
    field.configured = false;
    field.present = false;
    detectPayload = {
      found: [
        {
          field: "verilatorPath",
          tool: "verilator",
          label: "Verilator",
          path: "C:\\detected\\verilator_bin.exe",
          source: "known"
        }
      ]
    };
    deferDetect = [];
    fake.reset();
    let detecting = captured();
    const currentCard = findByProp(detecting, (props) => props.key === "tool-verilator");
    const close = findButton(currentCard, "收起");
    if (close !== undefined) {
      close.props.onClick();
      fake.reset();
      detecting = captured();
    }
    findButton(findByProp(detecting, (props) => props.key === "tool-verilator"), "修改路径").props.onClick();
    fake.reset();
    detecting = captured();
    await tick();
    check(deferDetect.length >= 1, `手填竞态:检测请求已挂起(实际 ${deferDetect.length} 次)`);
    const input = findByProp(
      findByProp(detecting, (props) => props.key === "verilatorPath"),
      (props) => props.type === "text" && typeof props.onChange === "function"
    );
    input.props.onChange({ target: { value: manualPath } });
    for (const release of deferDetect) release();
    await tick();
    fake.reset();
    const settled = findByProp(captured(), (props) => props.key === "verilatorPath");
    check(
      findByProp(settled, (props) => props.value === manualPath) !== undefined,
      "检测晚返回不会覆盖请求期间的新手填路径"
    );
  } finally {
    deferDetect = null;
    hostValues.verilatorPath = savedHostPath;
    Object.assign(field, savedField);
    fake.reset();
    const tree = captured();
    const discardAfter = findButton(tree, "取消");
    if (discardAfter !== undefined && discardAfter.props.disabled !== true) discardAfter.props.onClick();
  }
} catch (error) {
  check(false, "检测晚返回不会覆盖请求期间的新手填路径", String(error));
} finally {
  deferDetect = null;
}

// 预演 A 已在路上时把草稿改成 B,但尚未等到 B 的 250ms 防抖请求:此时 A 就必须立即失效。
try {
  fake.runEffects();
  await sleep(400);
  statusPayload = previewAnswer(
    {},
    "verilatorPath",
    "module-rtl",
    { selection: "auto", state: "auto", present: true }
  );
  deferPreview = [];
  fake.reset();
  let clean = captured();
  const cleanCard = findByProp(clean, (props) => props.key === "capability-module-rtl");
  if (findButton(cleanCard, "展开设置") !== undefined) {
    findButton(cleanCard, "展开设置").props.onClick();
    await tick();
    fake.reset();
    clean = captured();
  }
  const cleanSelect = findByProp(
    findByProp(clean, (props) => props.key === "moduleRtlTool"),
    (props) => props.value === "verilator" && typeof props.onChange === "function"
  );
  cleanSelect.props.onChange({ target: { value: "auto" } });
  fake.reset();
  const draftA = captured();
  fake.runEffects();
  await sleep(300);
  check(deferPreview.length >= 1, `草稿竞态:预演 A 已挂起(实际 ${deferPreview.length} 次)`);

  const selectA = findByProp(
    findByProp(draftA, (props) => props.key === "moduleRtlTool"),
    (props) => props.value === "auto" && typeof props.onChange === "function"
  );
  // 改回已保存的 verilator 会清掉这条草稿；故意不跑 effect,直接放行旧的 A。
  selectA.props.onChange({ target: { value: "verilator" } });
  for (const release of deferPreview) release();
  await tick();
  fake.reset();
  const afterB = captured();
  const capabilityText = JSON.stringify(findByProp(afterB, (props) => props.key === "capability-tool-summary-module-rtl") ?? {});
  check(!capabilityText.includes("由 AI 从已就绪工具中判断"), "草稿一变,旧能力预演在新防抖请求启动前就立即失效");
  check(capabilityText.includes("Verilator"), "旧预演不会把当前能力摘要盖回旧选择");
} catch (error) {
  check(false, "草稿变化会立即作废旧预演", String(error));
} finally {
  deferPreview = null;
  statusPayload = payload;
  fake.reset();
  captured();
  fake.runEffects();
}

// 最新预演自身失败时要留下一条可见错误,不能继续显示旧结论或安静地停在 pending。
try {
  rejectPreview = true;
  fake.reset();
  const tree = captured();
  const input = findByProp(
    findByProp(tree, (props) => props.key === "verilatorPath"),
    (props) => props.type === "text" && typeof props.onChange === "function"
  );
  input.props.onChange({ target: { value: "C:\\preview-failure\\verilator_bin.exe" } });
  fake.reset();
  captured();
  fake.runEffects();
  await sleep(300);
  await tick();
  fake.reset();
  check(JSON.stringify(captured() ?? {}).includes("路径检查接口不可用"), "最新预演失败会在设置页明确显示");
} catch (error) {
  check(false, "最新预演失败会在设置页明确显示", String(error));
} finally {
  rejectPreview = false;
  fake.reset();
  const tree = captured();
  const discard = findButton(tree, "取消");
  if (discard !== undefined && discard.props.disabled !== true) discard.props.onClick();
  fake.runEffects();
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
  let opening = captured();
  let card = findByProp(opening, (props) => props.key === "tool-verilator");
  const close = findButton(card, "收起");
  if (close !== undefined) {
    close.props.onClick();
    fake.reset();
    opening = captured();
    card = findByProp(opening, (props) => props.key === "tool-verilator");
  }
  findButton(card, "修改路径").props.onClick();
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

// ── 设置页「运行自检」:点了才请求,结果逐条渲染,失败要看得见 ──────────────────
try {
  selfCheckRequested = 0;
  selfCheckUrls = [];
  rejectSelfCheck = false;
  selfCheckPayload = {
    ranAt: "2026-09-29T00:00:00.000Z",
    ok: true,
    failed: 0,
    warned: 1,
    checks: [
      { id: "package", label: "包内运行时文件", status: "pass", detail: "skills / templates / tools / workspace 都在" },
      { id: "tools", label: "已登记工具路径", status: "warn", detail: "还没有登记任何工具路径" }
    ]
  };
  fake.reset();
  captured();
  fake.runEffects();
  await tick();
  fake.reset();
  const mounted = captured();
  check(findButton(mounted, "运行自检") !== undefined, "设置页有「运行自检」按钮");
  check(
    selfCheckRequested === 0,
    `挂载时**不**请求自检接口(只读自检也要用户点了才跑;实际 ${String(selfCheckRequested)} 次)`
  );

  // ① 点一次:恰好一次请求,结论逐条渲染,三档标记各按状态走
  // 注意:替身 React 每次渲染前必须 reset 游标,否则 hook 槽位整体错位(状态写到别处)。
  fake.reset();
  findButton(captured(), "运行自检").props.onClick();
  await tick();
  check(selfCheckRequested === 1, `点一次只请求一次(实际 ${String(selfCheckRequested)} 次)`);
  // 断言**恰好是宿主那条路径**:替身按子串命中,只数次数的话,路由写错也照样"通过"。
  check(
    selfCheckUrls.length === 1 && selfCheckUrls[0] === "/plugins/fpga-workbench/selfcheck",
    `请求打到宿主那条自检路径(实际 ${selfCheckUrls.join("、") || "没发出去"})`
  );
  fake.reset();
  const passed = captured();
  const passedText = JSON.stringify(passed ?? {});
  check(/通过:共 2 项/u.test(passedText) && /0 项失败、1 项提醒/u.test(passedText), "结论行给出总数与失败/提醒计数");
  check(passedText.includes("包内运行时文件") && passedText.includes("skills / templates / tools / workspace 都在"), "逐条列出每项检查与详情");
  check(passedText.includes("✓") && passedText.includes("!"), "pass 与 warn 各有标记(pass 勾、warn 叹号)");
  check(
    findDeep(
      passed,
      (node) => node.props?.className === "fpga-set-warn" && JSON.stringify(node).includes("已登记工具路径")
    ) !== undefined,
    "warn 那一行走 warn 样式(不是当成失败,也不是当成全绿)"
  );

  // ② 有阻塞项:结论行与标记都要变,不能仍显示"通过"
  selfCheckPayload = {
    ranAt: "2026-09-29T00:00:01.000Z",
    ok: false,
    failed: 1,
    warned: 0,
    checks: [{ id: "preset", label: "预设声明行", status: "fail", detail: "补丁里找不到预设声明行" }]
  };
  fake.reset();
  findButton(captured(), "运行自检").props.onClick();
  await tick();
  fake.reset();
  const failedText = JSON.stringify(captured() ?? {});
  check(/有阻塞项/u.test(failedText) && /1 项失败/u.test(failedText), "有阻塞项时结论行如实写「有阻塞项」并给出失败数");
  check(failedText.includes("✗") && failedText.includes("补丁里找不到预设声明行"), "失败项带叉号与原因");

  // ③ 拉不到:说清是"没跑成",**不许**显示成通过
  rejectSelfCheck = true;
  selfCheckRequested = 0;
  fake.reset();
  findButton(captured(), "运行自检").props.onClick();
  await tick();
  fake.reset();
  const errorText = JSON.stringify(captured() ?? {});
  check(/自检没跑成/u.test(errorText) && /HTTP 500/u.test(errorText), "接口失败时显示「自检没跑成」与原因");
  check(!/通过:共/u.test(errorText), "接口失败时不留下「通过」的假结论");
} catch (error) {
  check(false, "设置页自检的渲染与请求能走通", String(error));
} finally {
  // 别把假答复与闸门留给后面的人
  rejectSelfCheck = false;
  selfCheckRequested = 0;
  selfCheckUrls = [];
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 加载契约成立,客户端渲染冒烟也过了(重启前可以放心)");
if (failures.length > 0) process.exitCode = 1;
