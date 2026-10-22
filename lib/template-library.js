import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// src/template-library.ts
/**
* 用户模板可以(不必)在文件头声明自己属于哪一层:
*   `# fpga-workbench-level: module`   /   `// fpga-workbench-level: project`
*
* 为什么需要它(DSH-N02):模块与工程的综合/约束**共享同一个用户库目录**(按用户要求不拆目录),
* 于是「工程综合」卡也会列出模块用的 Tcl。规则只有内置默认区分层级,用户自己放的没法区分。
* 声明了就只在该层级的卡里显示;**没声明**的照旧两层都显示,并在设置页标「未声明层级」—— 兼容旧模板。
*/
const LEVEL_MARKER = /fpga-workbench-level\s*:\s*(module|project)/iu;
/**
* 只读文件头。
*
* 为什么不是 `readFileSync(...).slice(0, 4096)`:那是先把**整个文件**读成 JS 字符串再丢掉 99.999%
* —— 用户模板库里放一个几百 MB 的源文件,单次调用就是几百毫秒加上整份文件的内存。
* 层级声明就写在文件最前面,读 4 KB 足够。
*/
function readHead(path, bytes = 4096) {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(bytes);
		const read = readSync(fd, buffer, 0, bytes, 0);
		return buffer.toString("utf8", 0, read);
	} finally {
		closeSync(fd);
	}
}
/** 读文件头判断用户模板声明的层级;没声明或读不到就是 undefined(未声明)。 */
function declaredLevel(path) {
	try {
		return LEVEL_MARKER.exec(readHead(path))?.[1]?.toLowerCase();
	} catch {
		return;
	}
}
/** 能力属于哪一层:能力键是 module-* / project-*(其余按 undefined 处理,不做过滤)。 */
function capabilityLevel(definition) {
	const key = String(definition?.key ?? "");
	if (key.startsWith("module-")) return "module";
	if (key.startsWith("project-")) return "project";
}
/** 单个分类最多返回的用户模板数。超过时停止继续收集并明确标记。 */
const MAX_TEMPLATES_PER_CATEGORY = 500;
/** 插件自带的分类模板根；由 import.meta.url 定位，不受工作目录影响。 */
const BUNDLED_TEMPLATE_ROOT = fileURLToPath(new URL("../presets/fpga-workbench/templates/", import.meta.url));
/**
* 固定模板分类。directory 同时决定内置相对路径与用户库目录，不接受请求方自定义目录。
* 数组顺序只用于界面稳定展示，不表示执行顺序。
*/
const TEMPLATE_CATEGORIES = [
	{
		key: "rtl",
		label: "RTL 模板",
		directory: "rtl",
		extensions: [
			".sv",
			".v",
			".vhd",
			".vhdl"
		]
	},
	{
		key: "constraints",
		label: "约束模板",
		directory: "constraints",
		extensions: [".xdc"]
	},
	{
		key: "project-constraints",
		label: "工程约束模板",
		directory: "constraints",
		extensions: [".xdc"]
	},
	{
		key: "verification",
		label: "验证脚本模板",
		directory: "verification",
		extensions: [".py"]
	},
	{
		key: "testbench",
		label: "Testbench 模板",
		directory: "simulation/testbench",
		extensions: [
			".sv",
			".v",
			".vhd",
			".vhdl"
		]
	},
	{
		key: "sim-run",
		label: "仿真脚本",
		directory: "simulation/run",
		extensions: [".do", ".tcl"]
	},
	{
		key: "synthesis",
		label: "综合脚本",
		directory: "synthesis",
		extensions: [".tcl"]
	},
	{
		key: "project-synthesis",
		label: "工程综合脚本",
		directory: "synthesis",
		extensions: [".tcl"]
	},
	{
		key: "implementation",
		label: "实现脚本",
		directory: "implementation",
		extensions: [".tcl"]
	},
	{
		key: "programming",
		label: "下载脚本",
		directory: "programming",
		extensions: [".tcl"]
	},
	{
		key: "linter",
		label: "Linter 脚本",
		directory: "linter",
		extensions: [".tcl"]
	},
	{
		key: "bitstream",
		label: "Bitstream 脚本",
		directory: "bitstream",
		extensions: [".tcl"]
	}
];
const CATEGORY_BY_KEY = new Map(TEMPLATE_CATEGORIES.map((category) => [category.key, category]));
/**
* 内置模板。compatibleTools 中的 "*" 表示与具体工具无关；其余项只对明确工具适配。
* auto 尚未决定具体工具，因此可以看到候选默认；显式 Quartus / 自定义工具则不会误用 Vivado/ModelSim 脚本。
*/
const BUILTIN_TEMPLATES = [
	builtin("rtl", "builtin:rtl/systemverilog-module.sv", "rtl/systemverilog_module.sv", "SystemVerilog RTL 模块", ["*"]),
	builtin("constraints", "builtin:constraints/vivado-module-xdc.xdc", "constraints/vivado_module_xdc.xdc", "Vivado 模块约束(XDC)", ["vivado"]),
	builtin("verification", "builtin:verification/python_data_verification.py", "verification/python_data_verification.py", "Python 数据验证", ["python"]),
	builtin("testbench", "builtin:simulation/testbench/systemverilog-testbench.sv", "simulation/testbench/systemverilog_testbench.sv", "SystemVerilog Testbench", ["*"]),
	builtin("sim-run", "builtin:simulation/modelsim-run.do", "simulation/run/modelsim_run.do", "ModelSim / QuestaSim 仿真脚本", ["modelsim", "questa"]),
	builtin("synthesis", "builtin:synthesis/vivado-module-synthesis.tcl", "synthesis/vivado_module_synthesis.tcl", "Vivado 模块综合脚本", ["vivado"]),
	builtin("project-synthesis", "builtin:project-synthesis/vivado-project-synthesis.tcl", "synthesis/vivado_project_synthesis.tcl", "Vivado 工程综合脚本", ["vivado"]),
	builtin("project-constraints", "builtin:project-constraints/vivado-project-xdc.xdc", "constraints/vivado_project_xdc.xdc", "Vivado 工程约束(XDC)", ["vivado"]),
	builtin("implementation", "builtin:implementation/vivado-implementation.tcl", "implementation/vivado_implementation.tcl", "Vivado 实现脚本", ["vivado"]),
	builtin("programming", "builtin:programming/vivado-program.tcl", "programming/vivado_program.tcl", "Vivado 下载脚本", ["vivado"]),
	builtin("linter", "builtin:linter/vivado-rtl-lint.tcl", "linter/vivado_rtl_lint.tcl", "Vivado RTL Linter 脚本", ["vivado"]),
	builtin("bitstream", "builtin:bitstream/vivado-bitstream.tcl", "bitstream/vivado_bitstream.tcl", "Vivado Bitstream 脚本", ["vivado"])
];
/** v1/v2 插件自带的六个平面模板 → 当前分类模板。只认插件目录后缀，不吞用户同名文件。 */
const LEGACY_BUNDLED_TEMPLATES = {
	rtl: {
		file: "rtl.sv",
		id: "builtin:rtl/systemverilog-module.sv"
	},
	constraints: {
		file: "constraints.xdc",
		id: "builtin:constraints/vivado-module-xdc.xdc"
	},
	verification: {
		file: "comp.py",
		id: "builtin:verification/python_data_verification.py"
	},
	testbench: {
		file: "tb.sv",
		id: "builtin:simulation/testbench/systemverilog-testbench.sv"
	},
	"sim-run": {
		file: "run.do",
		id: "builtin:simulation/modelsim-run.do"
	},
	synthesis: {
		file: "run_synth.tcl",
		id: "builtin:synthesis/vivado-module-synthesis.tcl"
	}
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
var TemplateLibraryRequestError = class extends Error {
	/** HTTP 状态码：路由层直接用它回响应。 */
	status;
	constructor(message, status = 400) {
		super(message);
		this.name = "TemplateLibraryRequestError";
		this.status = status;
	}
};
/**
* 扫描一张能力卡允许使用的固定分类。
* @param options - `{ capability, capabilities, libraryRoot }`。
* @returns 各分类的内置项、用户库项、错误与截断信息。
*/
function scanTemplates({ capability, capabilities, libraryRoot = "" }) {
	const definition = resolveCapabilityDefinition(capability, capabilities);
	const categoryKeys = unique((definition.templates ?? []).map((template) => template?.category).filter((key) => typeof key === "string"));
	if (categoryKeys.length === 0 || categoryKeys.some((key) => !CATEGORY_BY_KEY.has(key))) throw new TemplateLibraryRequestError("能力没有登记有效的模板分类");
	const root = String(libraryRoot ?? "").trim();
	const rootState = inspectLibraryRoot(root);
	const groups = categoryKeys.map((key) => CATEGORY_BY_KEY.get(key)).filter((entry) => entry !== void 0).map((entry) => scanCategory(entry, root, rootState));
	const level = capabilityLevel(definition);
	for (const group of groups) {
		const kept = [];
		let hiddenByLevel = 0;
		for (const item of group.items) {
			if (item.source === "library" && item.level !== void 0 && level !== void 0 && item.level !== level) {
				hiddenByLevel += 1;
				continue;
			}
			kept.push(item);
		}
		group.items = kept;
		group.hiddenByLevel = hiddenByLevel;
	}
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
	const key = capability;
	const definition = allowed.find((entry) => entry?.key === key);
	if (definition === void 0) throw new TemplateLibraryRequestError("未知能力，拒绝扫描模板目录");
	return definition;
}
function unique(items) {
	return [...new Set(items)];
}
function inspectLibraryRoot(root) {
	if (root === "") return {
		configured: false,
		present: false
	};
	try {
		const info = lstatSync(root);
		if (!info.isDirectory() || info.isSymbolicLink()) return {
			configured: true,
			present: false,
			error: "模板库路径不是可读取的普通目录"
		};
		return {
			configured: true,
			present: true
		};
	} catch (error) {
		return {
			configured: true,
			present: false,
			error: `模板库路径无法读取：${errorMessage(error)}`
		};
	}
}
function scanCategory(category, libraryRoot, rootState) {
	const builtinItems = BUILTIN_TEMPLATES.filter((item) => item.category === category.key).map(builtinScanItem);
	const errors = [];
	let userItems = [];
	let truncated = false;
	if (rootState.configured) {
		if (!rootState.present) errors.push(rootState.error ?? "模板库路径不可用");
		else {
			const result = scanUserCategory(libraryRoot, category);
			const builtinPaths = new Set(builtinItems.map((item) => item.relativePath));
			userItems = samePath(libraryRoot, BUNDLED_TEMPLATE_ROOT) ? result.items.filter((item) => !builtinPaths.has(item.relativePath)) : result.items;
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
		if (!info.isDirectory() || info.isSymbolicLink()) return {
			items,
			truncated,
			errors: ["用户模板分类不是可读取的普通目录"]
		};
	} catch (error) {
		return {
			items,
			truncated,
			errors: [`用户模板分类无法读取：${errorMessage(error)}`]
		};
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
			if (!allowedTemplateExtension(category, entry.name)) continue;
			if (items.length >= 500) {
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
				level: declaredLevel(path),
				source: "library",
				path,
				present: true,
				compatibleTools: null
			});
		}
	};
	visit(categoryRoot);
	return {
		items,
		truncated,
		errors
	};
}
function ignoredName(name) {
	const lower = name.toLowerCase();
	return name.startsWith(".") || name.startsWith("~") || name.startsWith("#") || name.endsWith("~") || lower.endsWith(".tmp") || lower.endsWith(".temp") || lower.endsWith(".swp") || lower.endsWith(".swo") || lower.endsWith(".bak");
}
/**
* 精确解析一项已保存选择。这里绝不枚举目录；只探测最终文件。
* @param options - `{ selection, category, tool, libraryRoot, probe }`。
*/
function resolveTemplateSelection({ selection = "", category, tool = "auto", libraryRoot = "", probe } = {}) {
	const definition = CATEGORY_BY_KEY.get(category);
	if (definition === void 0) return templateProblem(selection, category, "invalid", "模板分类无效");
	const check = probe ?? ((target) => existsSync(target));
	const chosen = String(selection ?? "").trim();
	const selectedTool = String(tool ?? "auto").trim() || "auto";
	if (chosen === "") {
		if (selectedTool === "none") return {
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
		const candidate = BUILTIN_TEMPLATES.find((item) => item.category === category && compatibleWith(item, selectedTool));
		if (candidate === void 0) return {
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
		const path = join(BUNDLED_TEMPLATE_ROOT, ...candidate.relativePath.split("/"));
		const present = fileExists(check, path);
		return {
			...candidate,
			selection: "",
			path,
			source: "builtin",
			state: present ? "default" : "missing-default",
			present,
			default: true,
			summary: present ? "由 AI 自行决定" : "由 AI 自行决定（内置参考缺失，请修复插件安装）",
			warning: present ? `内置参考模板：${candidate.label}` : "插件内置参考模板缺失，请修复插件安装。"
		};
	}
	if (chosen.startsWith("builtin:")) return resolveBuiltinSelection(chosen, category, selectedTool, check);
	if (chosen.startsWith("library:")) return resolveLibrarySelection(chosen, category, libraryRoot, check);
	const migratedBuiltin = legacyBundledTemplate(chosen, category);
	if (migratedBuiltin !== void 0) {
		const resolved = resolveBuiltinSelection(migratedBuiltin.id, category, selectedTool, check);
		return {
			...resolved,
			selection: chosen,
			summary: resolved.present ? `旧版插件模板已映射为内置模板：${resolved.label}` : resolved.summary
		};
	}
	const present = fileExists(check, chosen);
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
		warning: present ? void 0 : "已选择的旧版模板路径不存在；原选择已保留。"
	};
}
function legacyBundledTemplate(path, category) {
	const definition = LEGACY_BUNDLED_TEMPLATES[category];
	if (definition === void 0) return void 0;
	const normalized = String(path ?? "").replace(/\\/gu, "/").toLowerCase();
	const suffix = `/presets/fpga-workbench/templates/${definition.file.toLowerCase()}`;
	if (!normalized.endsWith(suffix)) return void 0;
	return BUILTIN_TEMPLATES.find((item) => item.id === definition.id);
}
/**
* 把旧版插件自带的平面模板路径规范化成稳定的分类模板 ID。
* 用户自己的绝对路径、library: 选择和已经规范化的 builtin: ID 原样保留。
*/
function canonicalTemplateSelection(selection, category) {
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
	if (candidate === void 0) return templateProblem(selection, category, "missing", "已选择的内置模板不存在");
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
		warning: !present ? "已选择的内置模板缺失；原选择已保留。" : compatible ? void 0 : "已选择的内置模板与当前工具不兼容；原选择已保留。"
	};
}
function resolveLibrarySelection(selection, category, libraryRoot, probe) {
	const definition = CATEGORY_BY_KEY.get(category);
	const relativePath = selection.slice(8);
	const expectedPrefix = `${definition.directory}/`;
	if (!safeLibraryRelative(relativePath) || !relativePath.startsWith(expectedPrefix)) return templateProblem(selection, category, "invalid", "用户模板选择不属于当前分类");
	if (definition === void 0 || !allowedTemplateExtension(definition, relativePath)) return templateProblem(selection, category, "invalid", "已保存模板的扩展名不属于当前分类", "library");
	const root = String(libraryRoot ?? "").trim();
	if (root === "") return templateProblem(selection, category, "missing", "模板库路径尚未设置", "library");
	const path = join(root, ...relativePath.split("/"));
	if (!inside(root, path)) return templateProblem(selection, category, "invalid", "用户模板路径越出模板库", "library");
	const present = librarySelectionOk(root, path, probe);
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
		warning: present ? void 0 : "已选择的用户模板不存在或不在模板库内；原选择已保留。"
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
	return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function inside(root, path) {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
/** 真实落点也必须在库根内(父目录 junction / symlink 逃逸,F5-04)。 */
function realPathInside(root, path) {
	try {
		const realRoot = realpathSync(root);
		const real = realpathSync(path);
		const rel = relative(realRoot, real);
		return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
	} catch {
		return false;
	}
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
function allowedTemplateExtension(category, path) {
	const allowed = category?.extensions;
	if (!Array.isArray(allowed) || allowed.length === 0) return true;
	const ext = `.${String(path).split(".").pop()?.toLowerCase() ?? ""}`;
	return allowed.includes(ext);
}
function librarySelectionOk(root, path, probe) {
	if (!fileExists(probe, path)) return false;
	try {
		lstatSync(path);
	} catch {
		return true;
	}
	return ordinaryFile(path) && realPathInside(root, path);
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
export { BUILTIN_TEMPLATES, BUNDLED_TEMPLATE_ROOT, MAX_TEMPLATES_PER_CATEGORY, TEMPLATE_CATEGORIES, TemplateLibraryRequestError, canonicalTemplateSelection, resolveTemplateSelection, scanTemplates };
