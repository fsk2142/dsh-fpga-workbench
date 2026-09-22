// 分类模板库:固定分类、内置模板清单、只读扫描与精确选择解析。
//
// 这里刻意不 import toolchain.js:能力定义由调用方传入，避免模板库与设置模型形成循环依赖。
// 扫描只发生在设置页展开能力卡时；状态与会话提示只调用 resolveTemplateSelection 做单文件探测。

import { lstatSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 单个分类最多返回的用户模板数。超过时停止继续收集并明确标记。 */
export const MAX_TEMPLATES_PER_CATEGORY = 500;

/** 插件自带的分类模板根；由 import.meta.url 定位，不受工作目录影响。 */
export const BUNDLED_TEMPLATE_ROOT = fileURLToPath(
  new URL("../presets/fpga-workbench/templates/", import.meta.url)
);

/**
 * 固定模板分类。directory 同时决定内置相对路径与用户库目录，不接受请求方自定义目录。
 * 数组顺序只用于界面稳定展示，不表示执行顺序。
 */
export const TEMPLATE_CATEGORIES = [
  { key: "rtl", label: "RTL 模板", directory: "rtl" },
  { key: "constraints", label: "约束模板", directory: "constraints" },
  { key: "verification", label: "验证脚本模板", directory: "verification" },
  { key: "testbench", label: "Testbench 模板", directory: "simulation/testbench" },
  { key: "sim-compile", label: "仿真编译脚本", directory: "simulation/compile" },
  { key: "sim-run", label: "仿真运行脚本", directory: "simulation/run" },
  { key: "synthesis", label: "综合脚本", directory: "synthesis" },
  { key: "implementation", label: "实现脚本", directory: "implementation" },
  { key: "programming", label: "下载脚本", directory: "programming" }
];

const CATEGORY_BY_KEY = new Map(TEMPLATE_CATEGORIES.map((category) => [category.key, category]));

/**
 * 内置模板。compatibleTools 中的 "*" 表示与具体工具无关；其余项只对明确工具适配。
 * auto 尚未决定具体工具，因此可以看到候选默认；显式 Quartus / 自定义工具则不会误用 Vivado/ModelSim 脚本。
 */
export const BUILTIN_TEMPLATES = [
  builtin("rtl", "builtin:rtl/systemverilog-module.sv", "rtl/systemverilog_module.sv", "SystemVerilog RTL 模块", ["*"]),
  builtin("constraints", "builtin:constraints/vivado-xdc.xdc", "constraints/vivado_xdc.xdc", "Vivado XDC 约束", ["vivado"]),
  builtin("verification", "builtin:verification/python_data_verification.py", "verification/python_data_verification.py", "Python 数据验证", ["python"]),
  builtin("testbench", "builtin:simulation/testbench/systemverilog-testbench.sv", "simulation/testbench/systemverilog_testbench.sv", "SystemVerilog Testbench", ["*"]),
  builtin("sim-compile", "builtin:simulation/compile/modelsim-compile.do", "simulation/compile/modelsim_compile.do", "ModelSim / QuestaSim 编译脚本", ["modelsim", "questa"]),
  builtin("sim-run", "builtin:simulation/run/modelsim-run.do", "simulation/run/modelsim_run.do", "ModelSim / QuestaSim 运行脚本", ["modelsim", "questa"]),
  builtin("synthesis", "builtin:synthesis/vivado-synthesis.tcl", "synthesis/vivado_synthesis.tcl", "Vivado 综合脚本", ["vivado"]),
  builtin("implementation", "builtin:implementation/vivado-implementation.tcl", "implementation/vivado_implementation.tcl", "Vivado 实现脚本", ["vivado"]),
  builtin("programming", "builtin:programming/vivado-program.tcl", "programming/vivado_program.tcl", "Vivado 下载脚本", ["vivado"])
];

/** v1/v2 插件自带的六个平面模板 → 当前分类模板。只认插件目录后缀，不吞用户同名文件。 */
const LEGACY_BUNDLED_TEMPLATES = {
  rtl: { file: "rtl.sv", id: "builtin:rtl/systemverilog-module.sv" },
  constraints: { file: "constraints.xdc", id: "builtin:constraints/vivado-xdc.xdc" },
  verification: { file: "comp.py", id: "builtin:verification/python_data_verification.py" },
  testbench: { file: "tb.sv", id: "builtin:simulation/testbench/systemverilog-testbench.sv" },
  "sim-run": { file: "run.do", id: "builtin:simulation/run/modelsim-run.do" },
  synthesis: { file: "run_synth.tcl", id: "builtin:synthesis/vivado-synthesis.tcl" }
};

function builtin(categoryKey, id, relativePath, label, compatibleTools) {
  return {
    id,
    category: categoryKey,
    label,
    relativePath,
    compatibleTools
  };
}

/** 带 HTTP 建议状态的输入错误；宿主接口据此返回非 2xx。 */
export class TemplateLibraryRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "TemplateLibraryRequestError";
    this.status = status;
  }
}

/**
 * 扫描一张能力卡允许使用的固定分类。
 * @param options - `{ capability, capabilities, libraryRoot }`。
 * @returns 各分类的内置项、用户库项、错误与截断信息。
 */
export function scanTemplates({ capability, capabilities, libraryRoot = "" }) {
  const definition = resolveCapabilityDefinition(capability, capabilities);
  const categoryKeys = unique(
    (definition.templates ?? []).map((template) => template?.category).filter((key) => typeof key === "string")
  );
  if (categoryKeys.length === 0 || categoryKeys.some((key) => !CATEGORY_BY_KEY.has(key))) {
    throw new TemplateLibraryRequestError("能力没有登记有效的模板分类");
  }

  const root = String(libraryRoot ?? "").trim();
  const rootState = inspectLibraryRoot(root);
  const groups = categoryKeys.map((key) => scanCategory(CATEGORY_BY_KEY.get(key), root, rootState));
  return {
    capability: definition.key,
    groups,
    library: {
      path: root,
      configured: root !== "",
      present: rootState.present
    },
    errors: groups.flatMap((group) => group.errors.map((error) => `${group.label}: ${error}`)),
    ok: true
  };
}

function resolveCapabilityDefinition(capability, capabilities) {
  const allowed = Array.isArray(capabilities) ? capabilities : [];
  const key = typeof capability === "string" ? capability : capability?.key;
  const definition = allowed.find((entry) => entry?.key === key);
  if (definition === undefined) throw new TemplateLibraryRequestError("未知能力，拒绝扫描模板目录");
  return definition;
}

function unique(items) {
  return [...new Set(items)];
}

function inspectLibraryRoot(root) {
  if (root === "") return { configured: false, present: false };
  try {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return { configured: true, present: false, error: "模板库路径不是可读取的普通目录" };
    }
    return { configured: true, present: true };
  } catch (error) {
    return { configured: true, present: false, error: `模板库路径无法读取：${errorMessage(error)}` };
  }
}

function scanCategory(category, libraryRoot, rootState) {
  const builtinItems = BUILTIN_TEMPLATES.filter((item) => item.category === category.key).map(builtinScanItem);
  const errors = [];
  let userItems = [];
  let truncated = false;

  if (rootState.configured) {
    if (!rootState.present) {
      errors.push(rootState.error ?? "模板库路径不可用");
    } else {
      const result = scanUserCategory(libraryRoot, category);
      // 额外库若指到插件内置根，内置文件仍只显示一次；同目录里
      // 另外加入的文件照常作为“模板库”候选出现。
      const builtinPaths = new Set(builtinItems.map((item) => item.relativePath));
      userItems = samePath(libraryRoot, BUNDLED_TEMPLATE_ROOT)
        ? result.items.filter((item) => !builtinPaths.has(item.relativePath))
        : result.items;
      truncated = result.truncated;
      errors.push(...result.errors);
    }
  }

  return {
    key: category.key,
    label: category.label,
    directory: category.directory,
    items: [...builtinItems, ...userItems],
    builtinCount: builtinItems.length,
    libraryCount: userItems.length,
    truncated,
    errors
  };
}

function builtinScanItem(item) {
  const path = join(BUNDLED_TEMPLATE_ROOT, ...item.relativePath.split("/"));
  return {
    ...item,
    source: "builtin",
    path,
    present: ordinaryFile(path)
  };
}

function scanUserCategory(libraryRoot, category) {
  const categoryRoot = join(libraryRoot, ...category.directory.split("/"));
  const errors = [];
  const items = [];
  let truncated = false;

  try {
    const info = lstatSync(categoryRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return { items, truncated, errors: ["用户模板分类不是可读取的普通目录"] };
    }
  } catch (error) {
    return { items, truncated, errors: [`用户模板分类无法读取：${errorMessage(error)}`] };
  }

  const visit = (directory) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      errors.push(`部分目录无法读取：${displayRelative(categoryRoot, directory)}（${errorMessage(error)}）`);
      return;
    }

    for (const entry of entries) {
      if (truncated) break;
      if (ignoredName(entry.name)) continue;
      const path = join(directory, entry.name);
      // Dirent 与 lstat 双重守卫：Windows junction 和普通符号链接都不能递归进入。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        try {
          const info = lstatSync(path);
          if (!info.isSymbolicLink() && info.isDirectory()) visit(path);
        } catch (error) {
          errors.push(`部分目录无法读取：${displayRelative(categoryRoot, path)}（${errorMessage(error)}）`);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (items.length >= MAX_TEMPLATES_PER_CATEGORY) {
        truncated = true;
        break;
      }
      const fromLibrary = toPosix(relative(libraryRoot, path));
      const fromCategory = toPosix(relative(categoryRoot, path));
      items.push({
        id: `library:${fromLibrary}`,
        category: category.key,
        label: fromCategory,
        relativePath: fromLibrary,
        source: "library",
        path,
        present: true,
        compatibleTools: null
      });
    }
  };

  visit(categoryRoot);
  return { items, truncated, errors };
}

function ignoredName(name) {
  const lower = name.toLowerCase();
  return (
    name.startsWith(".") ||
    name.startsWith("~") ||
    name.startsWith("#") ||
    name.endsWith("~") ||
    lower.endsWith(".tmp") ||
    lower.endsWith(".temp") ||
    lower.endsWith(".swp") ||
    lower.endsWith(".swo") ||
    lower.endsWith(".bak")
  );
}

/**
 * 精确解析一项已保存选择。这里绝不枚举目录；只探测最终文件。
 * @param options - `{ selection, category, tool, libraryRoot, probe }`。
 */
export function resolveTemplateSelection({ selection = "", category, tool = "auto", libraryRoot = "", probe } = {}) {
  const definition = CATEGORY_BY_KEY.get(category);
  if (definition === undefined) {
    return templateProblem(selection, category, "invalid", "模板分类无效");
  }

  const chosen = String(selection ?? "").trim();
  const selectedTool = String(tool ?? "auto").trim() || "auto";
  if (chosen === "") {
    if (selectedTool === "none") {
      return {
        id: "",
        selection: "",
        category,
        label: "未使用模板",
        path: "",
        source: "none",
        state: "unused",
        present: true,
        default: false,
        summary: "工具已明确不用"
      };
    }
    const candidate = BUILTIN_TEMPLATES.find(
      (item) => item.category === category && compatibleWith(item, selectedTool)
    );
    if (candidate === undefined) {
      return {
        id: "",
        selection: "",
        category,
        label: definition.label,
        path: "",
        source: "default",
        state: "unsupported-default",
        present: false,
        default: true,
        summary: "没有适配的内置默认模板",
        warning: `当前工具没有适配的${definition.label}；请选择用户模板或调整工具。`
      };
    }
    const path = join(BUNDLED_TEMPLATE_ROOT, ...candidate.relativePath.split("/"));
    const present = fileExists(probe, path);
    return {
      ...candidate,
      selection: "",
      path,
      source: "builtin",
      state: present ? "default" : "missing-default",
      present,
      default: true,
      summary: present ? `当前使用：${candidate.label}` : `内置默认模板缺失：${candidate.label}`,
      warning: present ? undefined : "插件内置默认模板缺失，请修复插件安装。"
    };
  }

  if (chosen.startsWith("builtin:")) return resolveBuiltinSelection(chosen, category, selectedTool, probe);
  if (chosen.startsWith("library:")) return resolveLibrarySelection(chosen, category, libraryRoot, probe);

  const migratedBuiltin = legacyBundledTemplate(chosen, category);
  if (migratedBuiltin !== undefined) {
    const resolved = resolveBuiltinSelection(migratedBuiltin.id, category, selectedTool, probe);
    return {
      ...resolved,
      selection: chosen,
      summary: resolved.present
        ? `旧版插件模板已映射为内置模板：${resolved.label}`
        : resolved.summary
    };
  }

  // v1/v2 的六个模板字段保存的是路径。即使路径已不存在也保留，绝不退回内置模板。
  const present = fileExists(probe, chosen);
  return {
    id: chosen,
    selection: chosen,
    category,
    label: basename(chosen) || chosen,
    path: chosen,
    source: "legacy",
    state: present ? "selected" : "missing",
    present,
    default: false,
    summary: present ? `已选择旧版路径：${chosen}` : `已选择模板失效：${chosen}`,
    warning: present ? undefined : "已选择的旧版模板路径不存在；原选择已保留。"
  };
}

function legacyBundledTemplate(path, category) {
  const definition = LEGACY_BUNDLED_TEMPLATES[category];
  if (definition === undefined) return undefined;
  const normalized = String(path ?? "").replace(/\\/gu, "/").toLowerCase();
  const suffix = `/presets/fpga-workbench/templates/${definition.file.toLowerCase()}`;
  if (!normalized.endsWith(suffix)) return undefined;
  return BUILTIN_TEMPLATES.find((item) => item.id === definition.id);
}

/**
 * 把旧版插件自带的平面模板路径规范化成稳定的分类模板 ID。
 * 用户自己的绝对路径、library: 选择和已经规范化的 builtin: ID 原样保留。
 */
export function canonicalTemplateSelection(selection, category) {
  const chosen = String(selection ?? "").trim();
  return legacyBundledTemplate(chosen, category)?.id ?? chosen;
}

function samePath(left, right) {
  const leftPath = resolve(String(left ?? ""));
  const rightPath = resolve(String(right ?? ""));
  return process.platform === "win32" ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

function resolveBuiltinSelection(selection, category, tool, probe) {
  const candidate = BUILTIN_TEMPLATES.find((item) => item.id === selection && item.category === category);
  if (candidate === undefined) return templateProblem(selection, category, "missing", "已选择的内置模板不存在");
  const path = join(BUNDLED_TEMPLATE_ROOT, ...candidate.relativePath.split("/"));
  const present = fileExists(probe, path);
  const compatible = compatibleWith(candidate, tool);
  return {
    ...candidate,
    selection,
    path,
    source: "builtin",
    state: !present ? "missing" : compatible ? "selected" : "incompatible",
    present,
    default: false,
    summary: !present ? `已选择模板失效：${candidate.label}` : compatible ? `当前使用：${candidate.label}` : `已选择模板不适配：${candidate.label}`,
    warning: !present
      ? "已选择的内置模板缺失；原选择已保留。"
      : compatible ? undefined : "已选择的内置模板与当前工具不兼容；原选择已保留。"
  };
}

function resolveLibrarySelection(selection, category, libraryRoot, probe) {
  const definition = CATEGORY_BY_KEY.get(category);
  const relativePath = selection.slice("library:".length);
  const expectedPrefix = `${definition.directory}/`;
  if (!safeLibraryRelative(relativePath) || !relativePath.startsWith(expectedPrefix)) {
    return templateProblem(selection, category, "invalid", "用户模板选择不属于当前分类");
  }
  const root = String(libraryRoot ?? "").trim();
  if (root === "") return templateProblem(selection, category, "missing", "模板库路径尚未设置", "library");
  const path = join(root, ...relativePath.split("/"));
  if (!inside(root, path)) return templateProblem(selection, category, "invalid", "用户模板路径越出模板库", "library");
  const present = fileExists(probe, path);
  return {
    id: selection,
    selection,
    category,
    label: relativePath.slice(expectedPrefix.length),
    relativePath,
    path,
    source: "library",
    state: present ? "selected" : "missing",
    present,
    default: false,
    summary: present ? `当前使用：${relativePath}` : `已选择模板失效：${relativePath}`,
    warning: present ? undefined : "已选择的用户模板不存在；原选择已保留。"
  };
}

function templateProblem(selection, category, state, warning, source = "unknown") {
  return {
    id: String(selection ?? ""),
    selection: String(selection ?? ""),
    category,
    label: String(selection ?? "") || CATEGORY_BY_KEY.get(category)?.label || String(category ?? ""),
    path: "",
    source,
    state,
    present: false,
    default: false,
    summary: warning,
    warning
  };
}

function compatibleWith(template, tool) {
  const compatibleTools = template.compatibleTools ?? [];
  if (compatibleTools.includes("*")) return true;
  if (tool === "auto" || tool === "") return true;
  if (tool === "none") return false;
  return compatibleTools.includes(tool);
}

function safeLibraryRelative(path) {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes(":")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function ordinaryFile(path) {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function fileExists(probe, path) {
  if (typeof probe !== "function") return ordinaryFile(path);
  try {
    return probe(path, "file") === true;
  } catch {
    return false;
  }
}

function displayRelative(root, path) {
  const rel = toPosix(relative(root, path));
  return rel === "" ? "." : rel;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function errorMessage(error) {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}
