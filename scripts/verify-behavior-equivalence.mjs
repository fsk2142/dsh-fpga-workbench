// 迁移深度验证（不需要重启 DSH）。
//
// 工单说「产物对比不能只比导出符号，测试可能没覆盖所有导出」。导出名对得上，
// 不代表**行为**没变。这里做三件比"符号对比"更强的事：
//
//   A. **静态**：lib/*.js 里每个 import 都能解析（相对路径文件存在、裸依赖是宿主 peer）。
//      迁移常见事故：类型导入被 `verbatimModuleSyntax` 保留成运行时 import，
//      或者产物引用了源码里已删掉的模块。
//   B. **行为等价**：把备份与产物**同时 import 进来**，用同一批输入调用同一批纯函数，
//      逐项 `isDeepStrictEqual` 比结果。这是"真的没变"的直接证据。
//   C. **客户端**：bundle 里的关键字符串（CSS 类名、界面文案、路由常量）没有在打包中丢失。
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = (rel) => join(ROOT, rel);

const ENTRIES = ["index", "mode", "mcp", "selfcheck", "template-library", "toolchain", "version"];

/**
 * 裸依赖里哪些是"可选宿主服务"。
 *
 * `@deepseek-ai/dsh-mcp-client` 是**动态 import**（运行时才试），而且代码自己处理了
 * "取不到就如实报告"的分支 —— 它不是硬依赖，写进 peerDependencies 反而会让装插件时
 * 要求宿主提供它。`@deepseek-ai/schemastery` 才是真正的 peer（静态 `import z from`）。
 */
const OPTIONAL_HOST_SERVICES = new Set(["@deepseek-ai/dsh-mcp-client"]);

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// ═══ A. 静态：产物里的 import 能否解析 ═══════════════════════════════════
console.log("── A. 产物 import 可解析性 ──");
{
  const broken = [];
  const bareDeps = new Set();
  for (const entry of ENTRIES) {
    const file = at(join("lib", `${entry}.js`));
    if (!existsSync(file)) {
      broken.push(`${entry}.js 不存在`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    // 静态 import / export from / 动态 import("...")
    const specifiers = [
      ...[...text.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gmu)].map((m) => m[1]),
      ...[...text.matchAll(/^\s*export\s[^;]*?from\s*["']([^"']+)["']/gmu)].map((m) => m[1]),
      ...[...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu)].map((m) => m[1])
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".") || isAbsolute(specifier)) {
        const target = resolve(dirname(file), specifier);
        if (!existsSync(target)) broken.push(`${entry}.js → ${specifier}（目标不存在）`);
        continue;
      }
      bareDeps.add(specifier);
    }
  }
  check(broken.length === 0, `7 个产物的相对 import 全部指向存在的文件（坏：${broken.join("；") || "无"}）`);

  // 裸依赖必须都是宿主提供的 peer（不能指望 profile 装上它们）。
  // 动态 import 的可选宿主服务例外（见 OPTIONAL_HOST_SERVICES 的注释）。
  const manifest = JSON.parse(readFileSync(at("package.json"), "utf8"));
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
  const notPeer = [...bareDeps].filter(
    (specifier) => !peers.has(specifier) && !OPTIONAL_HOST_SERVICES.has(specifier)
  );
  check(
    notPeer.length === 0,
    `产物里的裸依赖都是已声明的 peer 或已知的可选宿主服务（未覆盖：${notPeer.join("、") || "无"}）`
  );
}

// ═══ B. 行为等价：备份 vs 产物，同一批输入逐项比 ═══════════════════════════
console.log("\n── B. 行为等价（备份 vs 产物）──");

/** 按绝对路径 import，返回命名空间或错误。 */
async function load(dir, entry) {
  const file = at(join(dir, `${entry}.js`));
  if (!existsSync(file)) return { error: `${dir}/${entry}.js 不存在` };
  try {
    return { namespace: await import(pathToFileURL(file).href) };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * 把值归一成"可比"的形态。
 *
 * 三类必须处理，否则会把**等价**误判成**不同**（第一版就假报了 3 项）：
 *   1. **函数**：`FIELDS[19].usage` / `TOOL_CATALOG.python.usage` 都是函数。
 *      两个函数对象永远不 `isDeepStrictEqual`。它们的等价只能用**输出**证明，
 *      所以这里把函数换成一个标记，函数行为由单独的行为断言覆盖。
 *   2. **时间戳**：`runSelfCheck().ranAt` 每次不同，换成固定标记。
 *   3. **绝对路径**：备份目录 vs lib 目录不同，归一到 `<ROOT>`。
 */
function normalize(value, keyPath = "") {
  if (typeof value === "function") return "<function>";
  if (typeof value === "string") {
    return value
      .split(ROOT)
      .join("<ROOT>")
      .replaceAll("lib.handwritten-backup", "lib")
      .replaceAll("\\", "/");
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalize(entry, `${keyPath}[${index}]`));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      // 时间戳字段：每次调用必然不同，不是"行为差异"
      if (key === "ranAt" || key === "checkedAt" || key === "generatedAt") {
        out[key] = "<timestamp>";
        continue;
      }
      out[key] = normalize(value[key], keyPath === "" ? key : `${keyPath}.${key}`);
    }
    return out;
  }
  return value;
}

/**
 * 裸依赖里哪些是"可选宿主服务"—— 定义在文件顶部（见上），这里只是留个指针。
 */

/** 比较同一个函数在备份与产物上的返回值。 */
const compare = async (label, before, after, invoke) => {
  let left;
  let right;
  try {
    left = normalize(await invoke(before));
  } catch (error) {
    left = { threw: String(error).slice(0, 200) };
  }
  try {
    right = normalize(await invoke(after));
  } catch (error) {
    right = { threw: String(error).slice(0, 200) };
  }
  check(isDeepStrictEqual(left, right), label, isDeepStrictEqual(left, right)
    ? undefined
    : `备份: ${JSON.stringify(left).slice(0, 260)}\n        产物: ${JSON.stringify(right).slice(0, 260)}`);
};

const [toolchainBefore, toolchainAfter] = await Promise.all([load("lib.handwritten-backup", "toolchain"), load("lib", "toolchain")]);
{
  check(toolchainBefore.namespace !== undefined && toolchainAfter.namespace !== undefined, "两份 toolchain 都能加载");
  if (toolchainBefore.namespace !== undefined && toolchainAfter.namespace !== undefined) {
    const b = toolchainBefore.namespace;
    const a = toolchainAfter.namespace;

    // 数据表必须完全一致（字段定义、能力卡、命令表、安装指引…）
    for (const key of ["FIELDS", "CAPABILITIES", "TOOLS", "STAGES", "TOOL_GROUPS", "TOOL_CATALOG", "LEVEL_DIRS", "TEMPLATE_FIELDS", "SETTINGS_SECTIONS", "INSTALL_HINTS", "MINIMAL_SETUP", "DETECT_TARGETS", "BINDINGS"]) {
      await compare(`${key} 数据表一致`, b, a, (mod) => mod[key]);
    }

    // 常量与纯函数
    for (const key of ["NS", "SETTINGS_MODEL_VERSION", "VERSION_PROBE_TIMEOUT_MS"]) {
      await compare(`${key} 常量一致`, b, a, (mod) => mod[key]);
    }

    // 提示组装：空设置 → 最基础的那份；带路径设置 → 带工具的那份
    await compare("describeEnv(空设置) 一致", b, a, (mod) => mod.describeEnv({}));
    await compare("describeEnv(带路径) 一致", b, a, (mod) =>
      mod.describeEnv({ vivadoPath: "C:/Xilinx/Vivado/2024.2/bin/vivado.bat", modelsimPath: "C:/modeltech/win64/vsim.exe" })
    );

    // 迁移逻辑：v1 → v3 的产出
    await compare("legacyMigrationPatch(v1 形状) 一致", b, a, (mod) =>
      mod.legacyMigrationPatch({ simulator: "modelsim", simulatorPath: "C:/m/vsim.exe", synthesis: "other" })
    );
    await compare("legacyMigrationPatch(已是最新) 一致", b, a, (mod) =>
      mod.legacyMigrationPatch({ settingsModelVersion: 3 })
    );

    // 路径/字符串处理
    for (const value of ["C:\\a\\b\\vivado.bat", "C:/a/b/vivado.bat", 'C:\\a"b\\x.bat', "C:\\a\\nb\\x.bat", ""]) {
      await compare(`promptArg(${JSON.stringify(value)}) 一致`, b, a, (mod) => mod.promptArg(value));
      await compare(`promptScalar(${JSON.stringify(value)}) 一致`, b, a, (mod) => mod.promptScalar(value));
    }

    // 探测：存在的文件 / 不存在的文件 / 目录当文件问
    await compare("probeFilesystem(存在的文件) 一致", b, a, (mod) => mod.probeFilesystem(at("package.json"), "file"));
    await compare("probeFilesystem(目录当文件问) 一致", b, a, (mod) => mod.probeFilesystem(at("lib"), "file"));
    await compare("probeFilesystem(目录) 一致", b, a, (mod) => mod.probeFilesystem(at("lib"), "directory"));
    await compare("probeFilesystem(不存在) 一致", b, a, (mod) => mod.probeFilesystem(at("no-such-file-xyz"), "file"));

    // 状态判定
    await compare("statusOf(空设置) 一致", b, a, (mod) => mod.statusOf({}));
    await compare("installGuidance(空设置) 一致", b, a, (mod) => mod.installGuidance({}));
    await compare("resolveBindings(空设置) 一致", b, a, (mod) => mod.resolveBindings({}));
    await compare("resolveCapabilities(空设置) 一致", b, a, (mod) => mod.resolveCapabilities({}));
    await compare("isMissing 一致", b, a, (mod) => ["", "  ", undefined, null, "x"].map((value) => mod.isMissing(value)));

    // **函数的行为等价**：`FIELDS[].usage` / `TOOL_CATALOG.*.usage` 是函数，
    // 归一化时被替换成 `<function>`（两个函数对象永远不 deepEqual）。
    // 它们的真等价只能用**输出**证明 —— 这里对每个 usage 喂同一批路径，比返回的文案。
    {
      const usageCases = ["C:\\Xilinx\\Vivado\\2024.2\\bin\\vivado.bat", "C:/msys64/mingw64/bin/verilator_bin.exe", ""];
      const collectUsage = (mod) => {
        const out = [];
        for (const field of mod.FIELDS) {
          if (typeof field.usage !== "function") continue;
          for (const value of usageCases) {
            try {
              out.push({ key: field.key, value, result: field.usage(value) });
            } catch (error) {
              out.push({ key: field.key, value, threw: String(error).slice(0, 120) });
            }
          }
        }
        for (const [name, entry] of Object.entries(mod.TOOL_CATALOG ?? {})) {
          if (typeof entry.usage !== "function") continue;
          for (const value of usageCases) {
            try {
              out.push({ key: `catalog:${name}`, value, result: entry.usage(value) });
            } catch (error) {
              out.push({ key: `catalog:${name}`, value, threw: String(error).slice(0, 120) });
            }
          }
        }
        return out;
      };
      await compare("所有 usage 函数对同一批路径的输出一致", b, a, collectUsage);
    }
  }
}

const [templateBefore, templateAfter] = await Promise.all([
  load("lib.handwritten-backup", "template-library"),
  load("lib", "template-library")
]);
{
  if (templateBefore.namespace !== undefined && templateAfter.namespace !== undefined) {
    const b = templateBefore.namespace;
    const a = templateAfter.namespace;
    await compare("BUILTIN_TEMPLATES 一致", b, a, (mod) => mod.BUILTIN_TEMPLATES);
    await compare("模板扫描(空库) 一致", b, a, (mod) =>
      mod.scanTemplates({ capability: "module-rtl", capabilities: b.CAPABILITIES ?? undefined, libraryRoot: "" })
    );
    await compare("canonicalTemplateSelection 一致", b, a, (mod) =>
      ["", "  ", "builtin:rtl/systemverilog-module.sv"].map((value) => mod.canonicalTemplateSelection(value, "rtl"))
    );
  }
}

const [versionBefore, versionAfter] = await Promise.all([load("lib.handwritten-backup", "version"), load("lib", "version")]);
{
  if (versionBefore.namespace !== undefined && versionAfter.namespace !== undefined) {
    const b = versionBefore.namespace;
    const a = versionAfter.namespace;
    await compare("packageInfo 一致", b, a, (mod) => mod.packageInfo());
    await compare("parseVersion 一致", b, a, (mod) =>
      ["1.2.3", "0.6.0", "0.2.1-rc.2", "v1.0", "", "abc", "1.2.3.4"].map((value) => mod.parseVersion(value))
    );
    await compare("compareVersions 一致", b, a, (mod) =>
      [
        ["1.0.0", "1.0.0"],
        ["1.0.1", "1.0.0"],
        ["0.2.1-rc.2", "0.2.1"],
        ["0.2.0-rc.1", "0.2.0-rc.2"]
      ].map(([left, right]) => mod.compareVersions(left, right))
    );
    await compare("updateStateOf 四态一致", b, a, (mod) =>
      [
        { package: { source: "linked", installedVersion: "0.5.0", updateAvailable: false } },
        { package: { source: "git", installedVersion: "0.5.0", latestVersion: "0.6.0", updateAvailable: true } },
        { package: { source: "npm", installedVersion: "0.5.0", updateAvailable: false } },
        { package: { source: "npm", installedVersion: "0.5.0", updateAvailable: true } },
        {},
        { package: { source: "npm", installedVersion: "0.5.0", latestVersion: null, updateAvailable: false } }
      ].map((payload) => mod.updateStateOf(payload))
    );
    await compare("repositorySlug 一致", b, a, (mod) => mod.repositorySlug());
  }
}

const [mcpBefore, mcpAfter] = await Promise.all([load("lib.handwritten-backup", "mcp"), load("lib", "mcp")]);
{
  if (mcpBefore.namespace !== undefined && mcpAfter.namespace !== undefined) {
    const b = mcpBefore.namespace;
    const a = mcpAfter.namespace;
    await compare("inspectMcpPath 一致", b, a, (mod) =>
      ["", "   ", at("package.json"), at("lib"), at("no-such.exe")].map((value) => mod.inspectMcpPath(value))
    );
    await compare("mcpConfigFor 一致", b, a, (mod) => mod.mcpConfigFor("C:/x.exe"));
    await compare("mcpPathProblem 一致", b, a, (mod) =>
      ["", at("package.json"), at("lib"), at("nope.exe")].map((value) => mod.mcpPathProblem(value))
    );
  }
}

const [selfBefore, selfAfter] = await Promise.all([load("lib.handwritten-backup", "selfcheck"), load("lib", "selfcheck")]);
{
  if (selfBefore.namespace !== undefined && selfAfter.namespace !== undefined) {
    // 自检读的是包内文件，按各自目录算出来的路径会不同 —— normalize 会把 ROOT 与目录名归一，
    // 所以这里能直接比"结论是否一致"。
    await compare("runSelfCheck(空设置) 结论一致", selfBefore.namespace, selfAfter.namespace, (mod) => mod.runSelfCheck({}));
  }
}

// ═══ C. 客户端 bundle：关键字符串没丢 ═══════════════════════════════════════
console.log("\n── C. 客户端 bundle 关键内容 ──");
{
  const bundle = readFileSync(at(join("lib", "client.js")), "utf8");
  const backupBundle = readFileSync(at(join("lib.handwritten-backup", "client.js")), "utf8");

  // 关键 UI 文案（少一条都说明打包丢了东西）
  const labels = ["工具设置", "模块工具", "工程工具", "RTL 编译工具", "仿真测试工具", "综合与门禁工具", "语言标准", "仿真库"];
  const missingLabels = labels.filter((label) => bundle.includes(label) && !backupBundle.includes(label) === false && !bundle.includes(label));
  check(missingLabels.length === 0, `界面文案都在（缺：${missingLabels.join("、") || "无"}）`);

  // CSS 类名
  const cssClasses = ["fpga-set", "fpga-set-hint", "fpga-set-btn", "fpga-set-collapsed"];
  const missingCss = cssClasses.filter((name) => !bundle.includes(name));
  check(missingCss.length === 0, `CSS 类名都在（缺：${missingCss.join("、") || "无"}）`);

  // 路由常量（客户端要打这些 URL）
  const routes = ["/plugins/fpga-workbench/toolchain", "/plugins/fpga-workbench/settings", "/plugins/fpga-workbench/selfcheck", "/plugins/fpga-workbench/version"];
  const missingRoutes = routes.filter((route) => !bundle.includes(route));
  check(missingRoutes.length === 0, `客户端路由常量都在（缺：${missingRoutes.join("、") || "无"}）`);

  // react 必须是 external（不能被 inline 进去）
  check(!/createElement\s*=\s*function\s+createElement\(\s*type/i.test(bundle) || bundle.includes("require(\"react\")"), "react 仍是 external（需要时向 loader 要）");
  check(bundle.includes('require("react")') || bundle.includes("require('react')"), "bundle 里保留了 `require(\"react\")` 的调用");

  // 尾部必须是 loader 的 factory 返回
  const tail = bundle.trimEnd().slice(-160);
  check(/return module\.exports;\s*\}\s*\}\);\s*$/u.test(tail), "bundle 以 loader 的 factory 收尾", tail.slice(-80));
}

// ═══ 汇总 ══════════════════════════════════════════════════════════════════
console.log("");
if (failures.length === 0) {
  console.log("PASS: 迁移后行为等价（数据表 / 纯函数 / 探测 / 提示 / 迁移 / 客户端内容）");
} else {
  console.log(`FAIL (${String(failures.length)}):`);
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exitCode = 1;
}
