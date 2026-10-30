// 针对**已装副本**的冒烟测试 —— 重启 DSH 之前跑。
//
// 和仓库自检的区别:那些跑的是仓库源码;这里跑的是 profile 里那份已装副本,而且是在
// **真实的依赖解析环境**里(裸依赖 @deepseek-ai/schemastery 从 profile 的 node_modules 解析)——
// 也就是宿主启动时走的同一条路。能在这一步发现的问题:import 解析失败、导出名对不上、
// 客户端 bundle 的工厂函数一执行就抛异常。
//
// 用法:node tools/smoke-installed.mjs
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HOST_HINT, PROFILE_HINT, compatibleHostDir, installHostPeerResolution, profileDir } from "./lib/host.mjs";

const PROFILE = profileDir();
const INSTALLED = join(PROFILE, "node_modules", "dsh-fpga-workbench");
// 宿主安装目录:唯一来源在 check-all.mjs(由它用同一个环境变量传下来),这里的默认值
// 由 tools/lib/host.mjs 推导 —— 不写死任何一台机器的安装路径,并且**只挑能提供
// 现代 schemastery 的那份**(否则会拿陈旧的 npm 全局 dsh 验证,报出与插件无关的错)。
const HOST = process.env.DSH_APP_DIR ?? compatibleHostDir();
const APP = typeof HOST === "string" ? HOST : HOST.dir;

/**
 * 宿主目录读不到时（`APP === ""`），冒烟里的**宿主半侧 import** 没法验。
 *
 * ## 为什么这是环境限制而不是插件问题
 *
 * 桌面版 DSH 装在 `app.asar` 里（Electron 的归档格式），**普通 Node 读不到里面的
 * package.json**。而 `@deepseek-ai/schemastery` 这类 peer 依赖由宿主提供 ——
 * 没有宿主目录就没有解析路由，`lib/index.js` 必然 import 失败。
 *
 * ## 怎么处理
 *
 * 不把这条当插件缺陷报红，**明确标 SKIP 并说明原因**；能验的部分（`lib/toolchain.js`
 * 等不依赖 peer 的模块、模式半侧、自检结论）照常验。
 * 真机验证靠 `DSH_APP_DIR` 指向可读的 DSH 安装，或用桌面端实际加载。
 */
const HOST_UNREADABLE = APP === "";
if (HOST_UNREADABLE) {
  const why = typeof HOST === "object" && HOST.problem !== undefined ? HOST.problem : "未找到宿主目录";
  console.log("      SKIP 宿主半侧 import：读不到可用的 DSH 安装目录");
  console.log(`           原因: ${String(why).slice(0, 200)}`);
  console.log("           桌面版在 app.asar 里，普通 Node 读不到；用 DSH_APP_DIR 指定可读目录可解除跳过。");
}

if (PROFILE === "") {
  console.error(
    [
      "读不出 profile 位置(USERPROFILE / HOME 都为空)。",
      `  ${PROFILE_HINT}`,
      ""
    ].join("\n")
  );
  process.exit(1);
}

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// 裸依赖(`@deepseek-ai/schemastery` 等)在真机上由宿主的 profile 解析层路由到宿主目录,
// profile 的 node_modules 里没有它们。这里把那层路由补上,否则这条冒烟只在开发机上碰巧通过。
const peer = installHostPeerResolution(APP);
console.log(
  peer.enabled
    ? `      裸依赖解析:接到宿主 ${peer.moduleRoot}`
    : `      裸依赖解析:未接管(${peer.reason})`
);

// ── 1. 宿主半侧:在 profile 的解析环境里真的 import 得动 ────────────────────
let host;
if (HOST_UNREADABLE) {
  // 宿主不可读 → peer 依赖没有解析路由，import 必然失败。那不是插件的问题，
  // 所以**不报红**，只在上面说明跳过原因（见 HOST_UNREADABLE 的注释）。
  check(true, "SKIP 已装 lib/index.js 的 import(宿主目录不可读，见上方原因)");
} else {
  try {
    host = await import(pathToFileURL(join(INSTALLED, "lib", "index.js")).href);
    check(true, "已装 lib/index.js 能 import(裸依赖从 profile 解析)");
  } catch (error) {
    check(false, "已装 lib/index.js 能 import", String(error));
  }
}
if (host !== undefined) {
  // 宿主半侧的 name 是 **cordis 插件名**(与补丁里那一行的 id 对应),不是包名 ——
  // 必须是包名的是**客户端 loader 的 id**(下面第 4 步验),两者是两回事。
  check(host.name === "fpga-workbench", `宿主 name = 插件名(实际 ${String(host.name)},应与补丁行的 id 一致)`);
  check(Array.isArray(host.inject) && host.inject.includes("settings"), "inject 是数组且含 settings");
  check(typeof host.apply === "function", "导出 apply");
  check(host.SettingsSchema !== undefined, "导出 SettingsSchema(宿主注册设置命名空间要用)");
  check(typeof host.statusOf === "function", "导出 statusOf(设置页字段定义靠它)");
  check(
    host.SELFCHECK_PATH === "/plugins/fpga-workbench/selfcheck",
    `导出 SELFCHECK_PATH(设置页「运行自检」用;实际 ${String(host.SELFCHECK_PATH)})`
  );
}

let toolchain;
try {
  toolchain = await import(pathToFileURL(join(INSTALLED, "lib", "toolchain.js")).href);
  check(true, "已装 lib/toolchain.js 能 import");
} catch (error) {
  check(false, "已装 lib/toolchain.js 能 import", String(error));
}

let templateLibrary;
try {
  templateLibrary = await import(pathToFileURL(join(INSTALLED, "lib", "template-library.js")).href);
  check(true, "已装 lib/template-library.js 能 import");
} catch (error) {
  check(false, "已装 lib/template-library.js 能 import", String(error));
}

// ── 2. 模式半侧:同样 import 得动 ───────────────────────────────────────────
let mode;
try {
  mode = await import(pathToFileURL(join(INSTALLED, "lib", "mode.js")).href);
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
// 0.2.0 把设置写在 profile 的 cordis.patch.yml;旧版 settings.yaml 只作回退。
// 这里只读取配置,不借用插件运行时的设置服务。
const require = createRequire(`${APP}/package.json`);
let values = {};
let settingsRead = false;
try {
  const yaml = require("js-yaml");
  const { entryListSchema } = require("@deepseek-ai/cordis-plugin-include");
  try {
    const rows = yaml.load(readFileSync(join(PROFILE, "cordis.patch.yml"), "utf8"), { schema: entryListSchema });
    const row = rows?.find((entry) => entry?.id === "fpga-workbench");
    if (row !== undefined) {
      values = row.config ?? {};
      settingsRead = true;
      check(true, `从 profile 补丁读到真实设置(${Object.keys(values).length} 项)`);
    } else {
      console.log("      profile 补丁没有 FPGA 设置行,用默认值检查");
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      try {
        // 用 `join` 而不是写死 `\\..\\..\\`（2026-10-22 审查 L5）：
        // 反斜杠是 Windows 专用，POSIX 上这个回退路径会静默失效。
        // 本仓库定位 Windows-only，但一行 `join` 就能不写死平台。
        const legacySettings = join(PROFILE, "..", "..", "settings.yaml");
        values = yaml.load(readFileSync(legacySettings, "utf8"))?.["fpga-workbench"] ?? {};
        settingsRead = true;
        check(true, `从旧 settings.yaml 读到真实设置(${Object.keys(values).length} 项)`);
      } catch (legacyError) {
        if (legacyError?.code === "ENOENT") console.log("      未找到已保存的 FPGA 设置,用默认值检查");
        else check(false, "读到旧 settings.yaml", String(legacyError));
      }
    } else {
      check(false, "读到真实设置", String(error));
    }
  }
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.log("      跳过读取真实设置(宿主解析环境没有 js-yaml;它只用于测试,不属于插件运行时)");
}

// 设置页「运行自检」的宿主实现:在**已装副本**上真跑一遍(只读、不起进程)。
// 这是这项功能唯一的端到端证据 —— 客户端那边只验渲染,判据本身在这里。
let selfCheckModule;
try {
  selfCheckModule = await import(pathToFileURL(join(INSTALLED, "lib", "selfcheck.js")).href);
  check(true, "已装 lib/selfcheck.js 能 import");
} catch (error) {
  check(false, "已装 lib/selfcheck.js 能 import", String(error));
}
if (selfCheckModule !== undefined) {
  try {
    const report = selfCheckModule.runSelfCheck(values);
    const byId = Object.fromEntries(report.checks.map((item) => [item.id, item]));
    // **不写死项数**：自检项会因为新增检查而增加（这次从 8 变 9）。
    // 写死数字只会导致「每加一项检查就得改这个测试」，而它想守的是「自检能跑出结论」。
    check(report.checks.length >= 6, `自检给出足够多的结论(实际 ${String(report.checks.length)} 项)`);
    check(
      report.checks.every((item) => typeof item.id === "string" && item.id !== "" && typeof item.status === "string"),
      "每项结论都有 id 与 status"
    );
    check(
      report.ok === true && report.failed === 0,
      `已装副本自检无阻塞项(failed=${String(report.failed)},warn=${String(report.warned)}` +
        `;${report.checks.filter((item) => item.status === "fail").map((item) => `${item.label}:${item.detail}`).join(" / ")}`
    );
    check(byId.package?.status === "pass", `包内运行时文件检查通过(${String(byId.package?.detail)})`);
    check(byId.preset?.status === "pass", "预设声明行检查通过");
    // 这三项是**逐份核对**:模板 / 技能 / 命令各一个清单,少一份就 fail(数字来自实际核对,不是常量打印)
    check(
      byId.templates?.status === "pass" && /份内置模板全在/u.test(String(byId.templates?.detail)),
      `内置模板逐份核对通过(${String(byId.templates?.detail)})`
    );
    check(
      byId.commands?.status === "pass" && /个自带命令与 \d+ 个依赖模块都在/u.test(String(byId.commands?.detail)),
      `自带命令(含辅助模块)核对通过(${String(byId.commands?.detail)})`
    );
    check(
      byId.skills?.status === "pass" &&
        /个技能及 \d+ 份显式引用的参考文件都在/u.test(String(byId.skills?.detail)),
      `自带技能逐项核对通过(${String(byId.skills?.detail)})`
    );
    check(
      report.checks.every(
        (item) => ["pass", "warn", "fail"].includes(item.status) && typeof item.detail === "string" && item.detail !== ""
      ),
      "每项自检都有状态与说明(不留空壳)"
    );
  } catch (error) {
    check(false, "已装副本能跑一次自检", String(error));
  }
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
    const hostSource = readFileSync(join(INSTALLED, "lib", "index.js"), "utf8");
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
    let render;
    mode.apply({
      get: (name) => name === "settings"
        ? { describe: () => [{ ns: "fpga-workbench", value: { ...values, pythonPath: process.execPath } }] }
        : undefined,
      effect: (register) => register(),
      systemPrompt: { section: ({ text: sectionText }) => { render = sectionText; } }
    });
    check(render().includes(process.execPath), "已装模式从 0.2.0 settings descriptor 生成带工具路径的会话提示");
  } catch (error) {
    check(false, "提示段能组装", String(error));
  }
}

// ── 4. 客户端 bundle:喂假 loader + 假 react,执行工厂函数 ───────────────────
try {
  const source = readFileSync(join(INSTALLED, "lib", "client.js"), "utf8");
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
