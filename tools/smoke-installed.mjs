// 针对**已装副本**的冒烟测试 —— 重启 DSH 之前跑。
//
// 和仓库自检的区别:那些跑的是仓库源码;这里跑的是 profile 里那份已装副本,而且是在
// **真实的依赖解析环境**里(裸依赖 @deepseek-ai/schemastery 从 profile 的 node_modules 解析)——
// 也就是宿主启动时走的同一条路。能在这一步发现的问题:import 解析失败、导出名对不上、
// 客户端 bundle 的工厂函数一执行就抛异常。
//
// 用法:node tools/smoke-installed.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROFILE = process.env.DSH_PROFILE_DIR
  ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ""}\\.dsh\\profiles\\desktop`;
const INSTALLED = `${PROFILE}\\node_modules\\dsh-fpga-workbench`;

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// ── 1. 宿主半侧:在 profile 的解析环境里真的 import 得动 ────────────────────
let host;
try {
  host = await import(pathToFileURL(`${INSTALLED}\\lib\\index.js`).href);
  check(true, "已装 lib/index.js 能 import(裸依赖从 profile 解析)");
} catch (error) {
  check(false, "已装 lib/index.js 能 import", String(error));
}
if (host !== undefined) {
  // 宿主半侧的 name 是 **cordis 插件名**(与补丁里那一行的 id 对应),不是包名 ——
  // 必须是包名的是**客户端 loader 的 id**(下面第 4 步验),两者是两回事。
  check(host.name === "fpga-workbench", `宿主 name = 插件名(实际 ${String(host.name)},应与补丁行的 id 一致)`);
  check(Array.isArray(host.inject) && host.inject.includes("settings"), "inject 是数组且含 settings");
  check(typeof host.apply === "function", "导出 apply");
  check(host.SettingsSchema !== undefined, "导出 SettingsSchema(宿主注册设置命名空间要用)");
  check(typeof host.statusOf === "function", "导出 statusOf(设置页字段定义靠它)");
}

// ── 2. 模式半侧:同样 import 得动 ───────────────────────────────────────────
let mode;
try {
  mode = await import(pathToFileURL(`${INSTALLED}\\lib\\mode.js`).href);
  check(true, "已装 lib/mode.js 能 import");
} catch (error) {
  check(false, "已装 lib/mode.js 能 import", String(error));
}
if (mode !== undefined) {
  check(Array.isArray(mode.inject) && mode.inject.join(",") === "systemPrompt", `模式半侧 inject = ["systemPrompt"](实际 ${String(mode.inject)})`);
  check(typeof mode.apply === "function", "模式半侧导出 apply");
}

// ── 3. 真设置跑一遍:设置页载荷 + 会话提示段 ─────────────────────────────────
const require = createRequire("C:/Program Files/DSH Desktop/resources/app/package.json");
const yaml = require("js-yaml");
let values = {};
try {
  values = yaml.load(readFileSync(`${PROFILE}\\..\\..\\settings.yaml`, "utf8"))?.["fpga-workbench"] ?? {};
  check(true, `读到真实设置(${Object.keys(values).length} 项)`);
} catch (error) {
  check(false, "读到真实设置", String(error));
}

if (host !== undefined) {
  try {
    const payload = host.statusOf(values);
    check(payload.tools.length === 19, `设置页载荷含 19 个可见字段(实际 ${payload.tools.length})`);
    check(payload.tools.every((tool) => tool.group && tool.control), "每个字段都带分组与控件类型");
    check(payload.tools.every((tool) => tool.control !== "hidden"), "载荷里没有隐藏字段(改名前的旧键不发给设置页)");
    check(payload.tools.filter((tool) => tool.control === "select").every((tool) => tool.options.length > 1), "下拉字段带选项");
    check(!("usage" in payload.tools[0]), "载荷里没有 usage");
    console.log(`      就绪 ${payload.tools.filter((t) => t.present).length}/${payload.tools.length},缺失 ${payload.missing.join(", ") || "无"}`);

    // 迁移:设置里若还留着改名前的旧键,启动时会被搬进新键。
    // 只兜底不搬的话,设置页的框会是空的、状态却"已就绪"(用户实际抓到的 bug)。
    const patch = host.legacyMigrationPatch(values);
    const moving = Object.entries(patch).filter(([, value]) => value !== "");
    console.log(
      moving.length === 0
        ? "      待迁移的旧键:无(已迁移过,或本来就没填)"
        : `      待迁移的旧键:${moving.map(([key, value]) => `${key}=${value}`).join(", ")}`
    );
    check(
      moving.every(([key]) => ["compilerPath", "simulatorPath", "synthesizerPath"].includes(key)),
      "迁移补丁只写这三个新键"
    );
  } catch (error) {
    check(false, "statusOf 能跑通", String(error));
  }
}

if (mode !== undefined) {
  // 直接跑提示段:走的是已装副本里的同一份代码(mode.js 的 sectionText 就调它)
  try {
    const { describeEnv, probeFilesystem } = await import(pathToFileURL(`${INSTALLED}\\lib\\toolchain.js`).href);
    const text = describeEnv(values, probeFilesystem);
    check(text.length > 200, `提示段能组装出内容(${text.length} 字符)`);
    check(text.includes("编译器") && text.includes("仿真器") && text.includes("综合器"), "提示段按工具给出三类工具与路径");
    check(text.includes("语言与标准"), "提示段含「语言与标准」一节");
    check(text.includes("模块模板"), "提示段含「模块模板」一节");
    check(text.includes("自带的命令"), "提示段含「自带的命令」一节");
  } catch (error) {
    check(false, "提示段能组装", String(error));
  }
}

// ── 4. 客户端 bundle:喂假 loader + 假 react,执行工厂函数 ───────────────────
try {
  const source = readFileSync(`${INSTALLED}\\lib\\client.js`, "utf8");
  let registered;
  const h = () => undefined;
  const react = {
    createElement: h,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: undefined })
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (spec) => {
          registered = spec;
        }
      }
    }
  };
  const run = new Function("window", "require", `${source}\nreturn window.__ModuleLoader__;`);
  const loader = run(sandbox.window, (id) => (id === "react" ? react : undefined));
  check(loader !== undefined && registered !== undefined, "bundle 调用了 __ModuleLoader__.load");
  check(registered?.id === "dsh-fpga-workbench", `loader id = 包名(实际 ${String(registered?.id)})`);
  const exports_ = registered?.factory((id) => (id === "react" ? react : undefined));
  check(typeof exports_.apply === "function", "工厂函数跑通并导出 apply");
  check(Array.isArray(exports_.inject), "exports.inject 是数组");
  check(exports_.inject.includes("slots"), "exports.inject 含 slots");
  check(!exports_.inject.includes("settingsScope"), "settingsScope 不在 exports.inject 里(它可能不存在)");
} catch (error) {
  check(false, "客户端 bundle 能加载并执行工厂", String(error));
}

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 已装副本在真实解析环境里能加载(重启前检查通过)");
if (failures.length > 0) process.exitCode = 1;
