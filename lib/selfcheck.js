// 设置页「自检」的只读实现 —— 用户点一下按钮就能看到"这份插件在这台机器上是否完整可用"。
//
// 边界(写清楚,免得越做越大):
//   · **不起任何进程** —— 不跑 verilator / vsim / vivado。那些是真机验收,属于 `tools/` 下的
//     开发自检(发布包里没有 tools/),不该从设置页偷偷拉起几分钟的综合或仿真;
//   · **不写任何东西** —— 不改设置、不建目录、不删文件,重复点也安全;
//   · 结论只针对"**这份已装副本 + 这份设置**",不假装等价于完整 `npm test`,界面上也这么说。
//
// 判据分三档:pass(没问题)/ warn(能用但有要注意的)/ fail(这份副本坏了,模式会缺东西)。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from "./template-library.js";
import { FIELDS, SETTINGS_MODEL_VERSION } from "./toolchain.js";

/** 已装包的根(本文件在 <包>/lib/ 下)。 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRESET_ROOT = join(PACKAGE_ROOT, "presets", "fpga-workbench");
/** 运行时真正要读的四棵子树 —— 与 package.json 的 files 白名单、打包断言同一份口径。 */
const RUNTIME_TREES = ["skills", "templates", "tools", "workspace"];

const entry = (id, label, status, detail) => ({ id, label, status, detail });

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** 只列目录(不跟随链接、不递归),读不到就当空。 */
const listDirs = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort();
  } catch {
    return [];
  }
};

/**
 * 跑一遍只读自检。
 * @param values - 当前已保存的设置值(调用方从 settings 服务取)。
 * @returns `{ ranAt, ok, failed, warned, checks }` —— `checks` 每项 `{ id, label, status, detail }`。
 */
export function runSelfCheck(values = {}) {
  const checks = [];

  // 1) 发布包完整性:四棵运行时子树少一棵,对应能力就静默消失(技能 / 模板 / 自带命令 / 骨架规则)。
  const missing = RUNTIME_TREES.filter((tree) => !existsSync(join(PRESET_ROOT, tree)));
  checks.push(
    entry(
      "package",
      "包内运行时文件",
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0
        ? `skills / templates / tools / workspace 都在(内置模板 ${String(BUILTIN_TEMPLATES.length)} 份、分类 ${String(TEMPLATE_CATEGORIES.length)} 个)`
        : `缺少 ${missing.join("、")} —— 安装副本不完整,请重新安装本插件`
    )
  );

  // 2) 预设声明行:模式能不能在选择器里出现,全靠补丁里那一行 @deepseek-ai/dsh-agent-preset。
  const patch = readText(join(PACKAGE_ROOT, "cordis.patch.yml"));
  const declared =
    patch !== undefined &&
    patch.includes("@deepseek-ai/dsh-agent-preset") &&
    /id:\s*preset-fpga-workbench/u.test(patch);
  checks.push(
    entry(
      "preset",
      "预设声明行",
      declared ? "pass" : "fail",
      declared
        ? "cordis.patch.yml 里有 @deepseek-ai/dsh-agent-preset 声明(重启后「FPGA 开发模式」应出现在选择器里)"
        : "补丁里找不到预设声明行 —— 模式会从选择器里消失,请重新安装本插件"
    )
  );

  // 3) 自带技能:每个技能目录都该有 SKILL.md,否则那个技能加载不到。
  const skillRoot = join(PRESET_ROOT, "skills");
  const skillDirs = listDirs(skillRoot);
  const withoutSkill = skillDirs.filter((name) => !existsSync(join(skillRoot, name, "SKILL.md")));
  checks.push(
    entry(
      "skills",
      "自带技能",
      skillDirs.length === 0 ? "fail" : withoutSkill.length === 0 ? "pass" : "warn",
      skillDirs.length === 0
        ? "包内一个技能目录都没有 —— 技能不会被加载,请重新安装本插件"
        : `共 ${String(skillDirs.length)} 个技能目录${withoutSkill.length === 0 ? ",每个都有 SKILL.md" : `,其中 ${String(withoutSkill.length)} 个缺 SKILL.md:${withoutSkill.join("、")}`}`
    )
  );

  // 4) 设置模型版本:旧版本号说明还没迁移过,保存一次设置就会迁移(不阻塞使用,所以是 warn)。
  const version = String(values.settingsModelVersion ?? "");
  checks.push(
    entry(
      "settings",
      "设置模型",
      version === SETTINGS_MODEL_VERSION ? "pass" : "warn",
      version === SETTINGS_MODEL_VERSION
        ? `模型版本 ${version},与当前插件一致`
        : `模型版本 ${version === "" ? "未写" : version};保存一次设置会迁移到 ${SETTINGS_MODEL_VERSION}(旧选择会保留)`
    )
  );

  // 5) 已登记的工具路径:填了但文件不在,对应的能力卡会判不可用。
  const toolFields = FIELDS.filter((field) => field.tool !== undefined && field.kind !== undefined);
  const registered = toolFields.filter((field) => String(values[field.key] ?? "").trim() !== "");
  const broken = registered.filter((field) => !existsSync(String(values[field.key]).trim()));
  checks.push(
    entry(
      "tools",
      "已登记工具路径",
      broken.length > 0 ? "fail" : registered.length === 0 ? "warn" : "pass",
      registered.length === 0
        ? "还没有登记任何工具路径 —— 展开「工具设置」里的工具卡登记本机工具"
        : broken.length === 0
          ? `${String(registered.length)} 项已登记,路径都存在`
          : `${String(broken.length)} 项路径不存在:${broken.map((field) => field.label).join("、")}`
    )
  );

  // 6) 用户模板库(可选):留空就用包内模板库;填了但目录不在才是问题。
  const libraryField = FIELDS.find((field) => field.key === "templateLibraryRoot");
  const libraryRoot = libraryField === undefined ? "" : String(values[libraryField.key] ?? "").trim();
  checks.push(
    entry(
      "templates",
      "模板库目录",
      libraryRoot === "" || existsSync(libraryRoot) ? "pass" : "warn",
      libraryRoot === ""
        ? "用包内模板库(未指定用户模板库)"
        : existsSync(libraryRoot)
          ? `用户模板库存在:${libraryRoot}`
          : `指定的模板库不存在:${libraryRoot} —— 展开能力卡时会报读取失败`
    )
  );

  const failed = checks.filter((item) => item.status === "fail").length;
  const warned = checks.filter((item) => item.status === "warn").length;
  return {
    ranAt: new Date().toISOString(),
    ok: failed === 0,
    failed,
    warned,
    checks
  };
}
