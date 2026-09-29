// 设置页「自检」的只读实现 —— 用户点一下按钮就能看到"这份插件在这台机器上是否完整可用"。
//
// 边界(写清楚,免得越做越大):
//   · **不起任何进程** —— 不跑 verilator / vsim / vivado。那些是真机验收,属于 `tools/` 下的
//     开发自检(发布包里没有 tools/),不该从设置页偷偷拉起几分钟的综合或仿真;
//   · **不写任何东西** —— 不改设置、不建目录、不删文件,重复点也安全;
//   · 结论只针对"**这份已装副本 + 这份设置**",不假装等价于完整 `npm test`,界面上也这么说。
//
// 判据分三档:pass(没问题)/ warn(能用但有要注意的)/ fail(这份副本坏了,模式会缺东西)。
//
// **核对的是清单,不是目录存在性**(2026-09-29 复核意见):模板逐个对 `BUILTIN_TEMPLATES`、
// 命令逐个对 `TOOLS`、技能逐个对 `BUNDLED_SKILLS` —— 少一份文件、少一整个技能目录都报 fail。
// 只看"目录在不在"会漏报,显示的数字还会来自代码常量,看着像通过。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from "./template-library.js";
import { FIELDS, LEVEL_DIRS, SETTINGS_MODEL_VERSION, TOOLS } from "./toolchain.js";

/** 已装包的根(本文件在 <包>/lib/ 下);第二个参数可换成夹具根,便于"故意缺文件"的测试。 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 运行时真正要读的四棵子树 —— 与 package.json 的 files 白名单、打包断言同一份口径。 */
const RUNTIME_TREES = ["skills", "templates", "tools", "workspace"];

/**
 * 应带的自带技能。
 *
 * 目录是真相,这份是**期望**:只有拿它比对,"整个技能目录被删掉"才看得出来(只数目录的话,
 * 16 个变 15 个照样"通过")。删技能必须同时改这里 —— 仓库侧 `check-preset-root.mjs` 断言
 * 两者逐项一致,漏改会在 `npm test` 里红。
 */
export const BUNDLED_SKILLS = [
  "fpga-module-review",
  "fpga-module-rtl",
  "fpga-module-spec",
  "fpga-module-synth",
  "fpga-module-verif",
  "fpga-project-board",
  "fpga-project-constraints",
  "fpga-project-impl",
  "fpga-project-integrate",
  "fpga-project-lint",
  "fpga-project-release",
  "fpga-project-rtl",
  "fpga-project-spec",
  "fpga-project-synth",
  "fpga-project-syssim",
  "fpga-project-timing"
];

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

/** 缺失清单的说明文字:全列前几个,多了给条数(几十条会把设置页撑爆)。 */
const missingNote = (missing) =>
  missing.length <= 6 ? missing.join("、") : `${missing.slice(0, 6).join("、")} 等 ${String(missing.length)} 个`;

/**
 * 跑一遍只读自检。
 * @param values - 当前已保存的设置值(调用方从 settings 服务取)。
 * @param packageRoot - 要检查的包根;默认本文件所在的包(测试夹具可传别的目录)。
 * @returns `{ ranAt, ok, failed, warned, checks }` —— `checks` 每项 `{ id, label, status, detail }`。
 */
export function runSelfCheck(values = {}, packageRoot = PACKAGE_ROOT) {
  const presetRoot = join(packageRoot, "presets", "fpga-workbench");
  const checks = [];

  // 1) 四棵运行时子树在不在 —— 少一棵,对应能力整块静默消失。
  const missingTrees = RUNTIME_TREES.filter((tree) => !existsSync(join(presetRoot, tree)));
  checks.push(
    entry(
      "package",
      "包内运行时文件",
      missingTrees.length === 0 ? "pass" : "fail",
      missingTrees.length === 0
        ? "skills / templates / tools / workspace 四棵子树都在"
        : `缺少 ${missingTrees.join("、")} —— 安装副本不完整,请重新安装本插件`
    )
  );

  // 2) 预设声明行:模式能不能在选择器里出现,全靠补丁里那一行 @deepseek-ai/dsh-agent-preset。
  const patch = readText(join(packageRoot, "cordis.patch.yml"));
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

  // 3) 模板:逐个核对 BUILTIN_TEMPLATES 的文件是否真的在(不是看目录、也不是报常量数字)。
  const templateRoot = join(presetRoot, "templates");
  const missingTemplates = BUILTIN_TEMPLATES.map((item) => item.relativePath).filter(
    (relativePath) => !existsSync(join(templateRoot, ...relativePath.split("/")))
  );
  checks.push(
    entry(
      "templates",
      "内置模板文件",
      missingTemplates.length === 0 ? "pass" : "fail",
      missingTemplates.length === 0
        ? `${String(BUILTIN_TEMPLATES.length)} 份内置模板全在(${String(TEMPLATE_CATEGORIES.length)} 个分类)`
        : `缺 ${String(missingTemplates.length)} 份内置模板:${missingNote(missingTemplates)} —— 用到它的环节会起不出文件`
    )
  );

  // 4) 自带命令:逐个核对 TOOLS 登记的文件(骨架 / 起文件 / 检查 / 验收各命令的入口)。
  const toolRoot = join(presetRoot, "tools");
  const missingTools = TOOLS.map((tool) => join(LEVEL_DIRS[tool.level] ?? "", tool.file)).filter(
    (relativePath) => !existsSync(join(toolRoot, relativePath))
  );
  checks.push(
    entry(
      "commands",
      "自带命令文件",
      missingTools.length === 0 ? "pass" : "fail",
      missingTools.length === 0
        ? `${String(TOOLS.length)} 个自带命令都在(模块 / 工程 / 两级共用)`
        : `缺 ${String(missingTools.length)} 个自带命令:${missingNote(missingTools)} —— 会话里点名这些命令会直接报找不到`
    )
  );

  // 5) 自带技能:目录清单与 BUNDLED_SKILLS 逐项比对(整目录被删也看得出来),且每个都要有 SKILL.md。
  const skillRoot = join(presetRoot, "skills");
  const skillDirs = listDirs(skillRoot);
  const missingSkills = BUNDLED_SKILLS.filter((name) => !skillDirs.includes(name));
  const unexpectedSkills = skillDirs.filter((name) => !BUNDLED_SKILLS.includes(name));
  const withoutSkill = skillDirs.filter((name) => !existsSync(join(skillRoot, name, "SKILL.md")));
  const skillProblems = [...missingSkills, ...withoutSkill];
  checks.push(
    entry(
      "skills",
      "自带技能",
      skillProblems.length > 0 ? "fail" : unexpectedSkills.length > 0 ? "warn" : "pass",
      missingSkills.length > 0
        ? `缺 ${String(missingSkills.length)} 个技能目录:${missingNote(missingSkills)} —— 那个技能的按需加载会失效`
        : withoutSkill.length > 0
          ? `${String(withoutSkill.length)} 个技能目录缺 SKILL.md:${missingNote(withoutSkill)}`
          : `${String(BUNDLED_SKILLS.length)} 个技能都在,每个都有 SKILL.md${
              unexpectedSkills.length === 0 ? "" : `(另有 ${String(unexpectedSkills.length)} 个未登记目录:${missingNote(unexpectedSkills)})`
            }`
    )
  );

  // 6) 设置模型版本:旧版本号说明还没迁移过,保存一次设置就会迁移(不阻塞使用,所以是 warn)。
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

  // 7) 已登记的工具路径:填了但文件不在,对应的能力卡会判不可用。
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

  // 8) 用户模板库(可选):留空就用包内模板库;填了但目录不在才是问题。
  const libraryField = FIELDS.find((field) => field.key === "templateLibraryRoot");
  const libraryRoot = libraryField === undefined ? "" : String(values[libraryField.key] ?? "").trim();
  checks.push(
    entry(
      "library",
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
