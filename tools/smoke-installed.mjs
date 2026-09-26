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
// 宿主安装目录:唯一来源在 check-all.mjs(由它用同一个环境变量传下来),这里的默认值
// 只为单独调用(`node tools/smoke-installed.mjs`)兜底。
const APP = process.env.DSH_APP_DIR ?? "C:/Program Files/DSH Desktop/resources/app";

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

let toolchain;
try {
  toolchain = await import(pathToFileURL(`${INSTALLED}\\lib\\toolchain.js`).href);
  check(true, "已装 lib/toolchain.js 能 import");
} catch (error) {
  check(false, "已装 lib/toolchain.js 能 import", String(error));
}

let templateLibrary;
try {
  templateLibrary = await import(pathToFileURL(`${INSTALLED}\\lib\\template-library.js`).href);
  check(true, "已装 lib/template-library.js 能 import");
} catch (error) {
  check(false, "已装 lib/template-library.js 能 import", String(error));
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
//
// js-yaml 只用来读测试夹具里的 settings.yaml,不是插件运行时的依赖。宿主安装目录
// 可能不存在(桌面版是 asar),或者没有把 js-yaml 暴露在宿主 package 的解析根下;
// 那时跳过"读真实设置"这一步,继续用空设置验证导出与载荷,不能因此让安装回滚。
const require = createRequire(`${APP}/package.json`);
let values = {};
let settingsRead = false;
try {
  const yaml = require("js-yaml");
  try {
    values = yaml.load(readFileSync(`${PROFILE}\\..\\..\\settings.yaml`, "utf8"))?.["fpga-workbench"] ?? {};
    settingsRead = true;
    check(true, `读到真实设置(${Object.keys(values).length} 项)`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("      跳过读取真实设置(没有 settings.yaml;它只用于测试,不属于插件运行时)");
    } else {
      check(false, "读到真实设置", String(error));
    }
  }
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.log("      跳过读取真实设置(宿主解析环境没有 js-yaml;它只用于测试,不属于插件运行时)");
}

if (host !== undefined) {
  try {
    const payload = host.statusOf(values);
    const visibleFields = toolchain?.FIELDS?.filter((field) => field.control !== "hidden") ?? [];
    check(
      visibleFields.length > 0 && payload.tools.length === visibleFields.length,
      `设置页载荷覆盖全部可见字段(定义 ${visibleFields.length},实际 ${payload.tools.length})`
    );
    check(
      payload.sections?.map((section) => section.key).join(",") === "common,module,project",
      "设置页载荷含工具设置、模块工具、工程工具三个顶层区"
    );
    check(payload.sections?.[0]?.label === "工具设置", "已装副本第一大块显示为工具设置");
    check(Array.isArray(payload.toolCards) && payload.toolCards.length >= 10, "已装副本逐项提供全部内置与自定义工具卡");
    check(
      payload.capabilities?.filter((capability) => capability.section === "module").length === 4,
      "设置页载荷含四张模块能力卡"
    );
    check(
      payload.capabilities?.filter((capability) => capability.section === "project").length === 3,
      "设置页载荷含三张工程能力卡"
    );
    check(
      payload.capabilities?.every((capability) =>
        typeof capability.toolKey === "string" && Array.isArray(capability.toolOptions) && Array.isArray(capability.templates)
      ),
      "每张能力卡都带工具选择和模板槽位"
    );
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
        ? "      待迁移/规范化的旧设置:无(已处理过,或本来就没填)"
        : `      待迁移/规范化的旧设置:${moving.map(([key, value]) => `${key}=${value}`).join(", ")}`
    );
    const declaredKeys = new Set(toolchain?.FIELDS?.map((field) => field.key) ?? []);
    check(moving.every(([key]) => declaredKeys.has(key)), "迁移补丁只写已声明的设置键");
    check(patch.settingsModelVersion === undefined || patch.settingsModelVersion === "3", "迁移补丁使用设置模型版本 3");
  } catch (error) {
    check(false, "statusOf 能跑通", String(error));
  }
}

if (host !== undefined && toolchain !== undefined && templateLibrary !== undefined) {
  try {
    check(host.TEMPLATE_PATH === "/plugins/fpga-workbench/templates", "已装副本导出分类模板只读接口路径");
    const hostSource = readFileSync(`${INSTALLED}\\lib\\index.js`, "utf8");
    check(hostSource.includes("path: TEMPLATE_PATH"), "已装副本实际注册分类模板接口");
    check(
      templateLibrary.TEMPLATE_CATEGORIES?.map((category) => category.key).join(",") ===
        "rtl,constraints,project-constraints,verification,testbench,sim-run,synthesis,project-synthesis,implementation,programming,linter,bitstream",
      "已装副本包含十二个固定模板分类(仿真编译与运行合并为一类;模块与工程的综合/约束各一份内置)"
    );
    const scan = templateLibrary.scanTemplates({
      capability: "module-rtl",
      capabilities: toolchain.CAPABILITIES,
      libraryRoot: ""
    });
    check(
      scan.groups?.length === 1 && scan.groups[0]?.key === "rtl" &&
        scan.groups[0]?.items?.some((item) => item.source === "builtin" && item.id.startsWith("builtin:rtl/")),
      "已装副本能按能力扫描分类内置模板"
    );
  } catch (error) {
    check(false, "分类模板接口与内置模板能跑通", String(error));
  }
}

if (mode !== undefined) {
  // 直接跑提示段:走的是已装副本里的同一份代码(mode.js 的 sectionText 就调它)
  try {
    const { describeEnv, probeFilesystem } = toolchain;
    const text = describeEnv(values, probeFilesystem);
    check(text.length > 200, `提示段能组装出内容(${text.length} 字符)`);
    check(text.includes("这是能力配置，不是执行顺序"), "提示段明确设置不是自动化流水线");
    if (settingsRead && Object.keys(values).length > 0) {
      check(text.includes("工具设置中已登记且路径可用的工具"), "提示段说明工具设置里已登记的工具");
    } else {
      console.log("      跳过真实工具提示断言(没有读到非空的 FPGA 设置值)");
    }
    check(text.includes("模块工具能力偏好") && text.includes("工程工具能力偏好"), "提示段分别说明模块与工程能力工具");
    check(text.includes("语言与标准"), "提示段含「语言与标准」一节");
    check(text.includes("模板库:"), "提示段说明模板库来源与按需扫描规则");
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
