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
// 命令逐个对 `TOOLS`(并顺着相对 import 把辅助模块一起走一遍)、技能逐个对 `BUNDLED_SKILLS`,
// 另有按名字读的固定文件(`workspace/AGENTS.fpga.md`)—— 少一份文件、少一整个技能目录都报 fail。
// 只看"目录在不在"会漏报,显示的数字还会来自代码常量,看着像通过。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from "./template-library.js";
import { FIELDS, LEVEL_DIRS, SETTINGS_MODEL_VERSION, TOOLS } from "./toolchain.js";

/** 已装包的根(本文件在 <包>/lib/ 下);第二个参数可换成夹具根,便于"故意缺文件"的测试。 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 运行时真正要读的四棵子树 —— 与 package.json 的 files 白名单、打包断言同一份口径。 */
const RUNTIME_TREES = ["skills", "templates", "tools", "workspace"];
/**
 * 四棵子树里**按名字被运行时读**的固定文件(不只是"目录在不在")。
 *
 * `workspace/AGENTS.fpga.md` 是建骨架时原样复制的模式规则正文(见 setup-scaffold.mjs 的
 * `RULES_SOURCE`);少了它 `setup-scaffold` 直接抛错、工程骨架建不出来 —— 只看目录看不出来。
 * 仓库侧 `check-preset-root.mjs` 用 setup-scaffold 导出的 `INSTRUCTION_FILE` 断言这份清单没写错。
 */
const REQUIRED_PRESET_FILES = ["workspace/AGENTS.fpga.md"];

export { REQUIRED_PRESET_FILES };

/**
 * 应带的自带技能。
 *
 * 目录是真相,这份是**期望**:只有拿它比对,"整个技能目录被删掉"才看得出来(只数目录的话,
 * 16 个变 15 个照样"通过")。删技能必须同时改这里 —— 仓库侧 `check-preset-root.mjs` 断言
 * 两者逐项一致,漏改会在 `npm test` 里红。
 */
export const BUNDLED_SKILLS = [
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

/** 自检单项的三档结论。 */
export type CheckStatus = "pass" | "warn" | "fail";

/** 自检的一项结论（设置页按这个渲染）。 */
export interface CheckEntry {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/** `runSelfCheck` 的完整结论。 */
export interface SelfCheckReport {
  ranAt: string;
  ok: boolean;
  failed: number;
  warned: number;
  checks: CheckEntry[];
}

const entry = (id: string, label: string, status: CheckStatus, detail: string): CheckEntry => ({ id, label, status, detail });

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** 只列目录(不跟随链接、不递归),读不到就当空。 */
const listDirs = (path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort();
  } catch {
    return [];
  }
};

const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** 只认 SKILL.md 里显式链接的 references/*.md；这样资源不会成为加载器永远到不了的孤儿。 */
const linkedSkillReferences = (text: unknown): string[] => [
  ...new Set(
    [...String(text ?? "").matchAll(/\[[^\]]+\]\((references\/[^)\s]+\.md)\)/gu)].map(
      (match) => match[1]
    )
  )
];

/** 缺失清单的说明文字:全列前几个,多了给条数(几十条会把设置页撑爆)。 */
const missingNote = (missing: string[]): string =>
  missing.length <= 6 ? missing.join("、") : `${missing.slice(0, 6).join("、")} 等 ${String(missing.length)} 个`;

/**
 * 顺着**相对 import** 把入口文件的依赖模块递归走一遍,返回缺失的那些。
 *
 * 为什么不能只查入口:7 个命令入口都 import `./lib/*.mjs`(起文件用 stamp、检查用
 * rtl-check-rules / rtl-check-driver / rtl-coverage),辅助模块少一个,命令一跑就
 * `ERR_MODULE_NOT_FOUND` —— 而入口文件本身还在。
 * @param toolRoot - `presets/fpga-workbench/tools` 的绝对路径。
 * @param entries - 入口文件的相对路径(用 `/` 分隔)。
 * @returns `{ missing, count }`:`missing` 是缺失的相对路径,`count` 是走到的依赖模块数。
 */
function collectMissingImports(toolRoot: string, entries: string[]): { missing: string[]; count: number } {
  const seen = new Set(entries);
  const queue: string[] = [...entries];
  const missing: string[] = [];
  while (queue.length > 0) {
    const relativePath = queue.shift();
    if (relativePath === undefined) break;
    const text = readText(join(toolRoot, ...relativePath.split("/")));
    if (text === undefined) continue; // 入口自己缺:由调用方单独报,这里不重复
    for (const match of text.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/gu)) {
      const target = normalize(join(dirname(relativePath), match[1])).split("\\").join("/");
      if (seen.has(target)) continue;
      seen.add(target);
      if (existsSync(join(toolRoot, ...target.split("/")))) queue.push(target);
      else missing.push(target);
    }
  }
  return { missing, count: seen.size - entries.length };
}

/**
 * 跑一遍只读自检。
 * @param values - 当前已保存的设置值(调用方从 settings 服务取)。
 * @param packageRoot - 要检查的包根;默认本文件所在的包(测试夹具可传别的目录)。
 * @returns `{ ranAt, ok, failed, warned, checks }` —— `checks` 每项 `{ id, label, status, detail }`。
 */
export function runSelfCheck(
  values: Record<string, unknown> = {},
  packageRoot: string = PACKAGE_ROOT
): SelfCheckReport {
  const presetRoot = join(packageRoot, "presets", "fpga-workbench");
  const checks: CheckEntry[] = [];

  // 1) 四棵运行时子树 + 按名字读的固定文件 —— 少了哪一样,对应能力就静默失效。
  const missingTrees = RUNTIME_TREES.filter((tree) => !existsSync(join(presetRoot, tree)));
  const missingFiles = REQUIRED_PRESET_FILES.filter(
    (relativePath) => !existsSync(join(presetRoot, ...relativePath.split("/")))
  );
  const packageMissing = [...missingTrees, ...missingFiles];
  checks.push(
    entry(
      "package",
      "包内运行时文件",
      packageMissing.length === 0 ? "pass" : "fail",
      packageMissing.length === 0
        ? "skills / templates / tools / workspace 四棵子树与模式规则文件都在"
        : `缺少 ${packageMissing.join("、")} —— 安装副本不完整,请重新安装本插件`
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

  // 2b) **PTY 后端重名**（2026-10-28 真机崩溃的防线）。
  //
  // `terminal_store` 注册 PTY 后端时是「重名就抛」：
  //     if (this.backends.has(backend.type)) throw new TerminalError(
  //       `a PTY backend named "${backend.type}" is already registered`)
  // 而这些工具注册的类型就是 `"shell"`。抛错发生在 composition 装载期 ——
  // 那时插件已激活失败，**DSH 直接起不来、连界面都没有**，用户只能手动改 YAML。
  //
  // 所以在这里提前算出来：预设启用 `tool-bash`/`tool-pwsh` 之一，而 profile 的
  // 补丁里把 `optional-terminal-bash` 也打开了，就是确定的冲突。
  // 报 warn 而不是 fail：用户可能确实想让预设提供终端（那种情况该关 profile 那行）。
  {
    const presetText = readText(join(packageRoot, "presets", "fpga-workbench", "agent.cordis.yml")) ?? "";
    /** 预设里某个 id 的行是否处于启用态（`disabled: true` 才算停用）。 */
    const rowEnabled = (id: string): boolean => {
      const block = new RegExp(`^- id: ${id}\\s*$([\\s\\S]*?)(?=^- id: |(?![\\s\\S]))`, "mu").exec(presetText);
      if (block === null) return false;
      return !/^\s+disabled:\s*true\s*$/mu.test(block[1]);
    };
    const presetShellOn = rowEnabled("tool-bash") || rowEnabled("tool-pwsh");

    // profile 补丁：`optional-terminal-bash` 显式 enabled（`disabled: false` 或没写 disabled 行）
    //
    // **不能写死 `profiles/desktop`**（第十三轮复审指出）：profile 名因机器而异，
    // 写死会让防线在非 desktop 环境完全失效 —— 那正是最需要它的场景。
    // 顺序：`DSH_PROFILE_DIR` 显式指定 → `DSH_PROFILE` 名 → `profiles/desktop` 兜底。
    const profileCandidates: string[] = [];
    const dshHome = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");
    if (process.env.DSH_PROFILE_DIR !== undefined && process.env.DSH_PROFILE_DIR !== "") {
      profileCandidates.push(process.env.DSH_PROFILE_DIR);
    }
    if (process.env.DSH_PROFILE !== undefined && process.env.DSH_PROFILE !== "") {
      profileCandidates.push(join(dshHome, "profiles", process.env.DSH_PROFILE));
    }
    profileCandidates.push(join(dshHome, "profiles", "desktop"));

    // profile 补丁里**两条**终端后端行都要看：它们加载的是**同一个包**
    // `@deepseek-ai/dsh-terminal-bash`，各自注册一个名为 `shell` 的 PTY 后端。
    // 宿主的意图是按平台二选一（`disabled: !!js process.platform === 'win32'` /
    // `!== 'win32'`），但 patch 里若把两条都硬写成 `disabled: false`，
    // 它们就同时激活 → 第二个抛 TerminalError → DSH 起不来。
    //
    // 2026-10-28 真机就撞在这个形态上：报错从 `optional-terminal-bash` 变成
    // `optional-terminal-pwsh`，因为它们互相抢 —— 只查其中一条会漏。
    const TERMINAL_ROWS = ["optional-terminal-bash", "optional-terminal-pwsh"];

    let profileShellOn = false;
    let profileShellDetail = "";
    /** profile 里是否**至少有一条**终端行在启用（不论几条）。 */
    let profileProvidesTerminal = false;
    for (const dir of profileCandidates) {
      const profilePatch = readText(join(dir, "cordis.patch.yml"));
      if (profilePatch === undefined) continue;

      const enabledRows: string[] = [];
      for (const rowId of TERMINAL_ROWS) {
        const block = new RegExp(`^- id: ${rowId}\\s*$([\\s\\S]*?)(?=^- id: |(?![\\s\\S]))`, "mu").exec(profilePatch);
        if (block === null) continue;
        if (!/^\s+disabled:\s*true\s*$/mu.test(block[1])) enabledRows.push(rowId);
      }
      if (enabledRows.length === 0) break;

      profileProvidesTerminal = true;
      // 两条同时启用 = 确定的冲突（它们注册同一个 `shell` 后端）；只有一条 = 正常。
      profileShellOn = enabledRows.length > 1;
      profileShellDetail = enabledRows.join(" + ");
      if (profileShellOn) break;
    }

    // 冲突有两种形态：
    //   A. profile 自己两条终端行同时启用 —— 与插件无关，但一样会让 DSH 起不来
    //   B. 预设提供终端 + profile 也提供 —— 两层抢同一个后端（真机上出现过）
    const ptyConflict = profileShellOn || (presetShellOn && profileProvidesTerminal);
    checks.push(
      entry(
        "pty",
        "PTY 后端不重复注册",
        ptyConflict ? "warn" : "pass",
        ptyConflict
          ? profileShellOn
            ? `profile 里 ${profileShellDetail} 两条终端行同时启用 —— 它们加载同一个包、`
              + "都注册名为 shell 的 PTY 后端,启动时会抛 TerminalError 让 DSH 打不开。"
              + "按平台只留一条:Windows 留 optional-terminal-pwsh,另一条设 disabled: true"
            : "预设的 tool-bash/tool-pwsh 与 profile 的终端行都在启用 —— 两者都注册名为 shell 的 "
              + "PTY 后端,启动时会抛 TerminalError 导致 DSH 打不开。"
              + "二选一:停用预设里那两个,或在 profile 里把终端行设成 disabled: true"
          : presetShellOn
            ? "由本预设提供终端后端(profile 的终端行未启用)"
            : "由 profile 提供终端后端(预设的 tool-bash/tool-pwsh 已停用)"
      )
    );
  }

  // 3) 模板:**双向**核对。
  //
  // 一开始只做了"清单 → 文件"这一个方向（清单里有、文件在不在）。那个方向有个盲区:
  // **清单少了条目时,要查的也少了,于是永远通过**。2026-10-22 的反向验证抓到了 ——
  // 从 BUILTIN_TEMPLATES 里删掉一条,自检照样报 pass。
  //
  // 现在两个方向都查:
  //   · 清单里有 → 文件必须在（否则用到它的环节起不出文件）;
  //   · 磁盘上有 → 清单里必须有（否则那份模板谁也选不到,是死文件,而且发版会多带一个）。
  const templateRoot = join(presetRoot, "templates");
  const listedTemplates = new Set(BUILTIN_TEMPLATES.map((item) => item.relativePath));
  const missingTemplates = [...listedTemplates].filter(
    (relativePath) => !existsSync(join(templateRoot, ...relativePath.split("/")))
  );
  /** 磁盘上真实存在的模板文件（按 templates/ 下的相对路径）。 */
  const onDiskTemplates = (() => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of entries) {
        const full = join(dir, item.name);
        const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
        if (item.isDirectory()) walk(full, rel);
        else if (item.isFile()) out.push(rel);
      }
    };
    walk(templateRoot, "");
    return out;
  })();
  const orphanTemplates = onDiskTemplates.filter((rel) => !listedTemplates.has(rel));
  const templateProblem = missingTemplates.length > 0 || orphanTemplates.length > 0;
  checks.push(
    entry(
      "templates",
      "内置模板文件",
      templateProblem ? "fail" : "pass",
      !templateProblem
        ? `${String(BUILTIN_TEMPLATES.length)} 份内置模板全在(${String(TEMPLATE_CATEGORIES.length)} 个分类)`
        : [
            missingTemplates.length > 0
              ? `缺 ${String(missingTemplates.length)} 份内置模板:${missingNote(missingTemplates)} —— 用到它的环节会起不出文件`
              : "",
            orphanTemplates.length > 0
              ? `有 ${String(orphanTemplates.length)} 份模板文件不在清单里:${missingNote(orphanTemplates)} —— 编辑源与清单不一致`
              : ""
          ]
            .filter((line) => line !== "")
            .join(";")
    )
  );

  // 4) 自带命令:逐个核对 TOOLS 登记的文件(骨架 / 起文件 / 检查 / 验收各命令的入口)。
  const toolRoot = join(presetRoot, "tools");
  // `TOOLS[].level` 在 toolchain 里的推断类型是 `string`（数组字面量里混了三种字面量），
  // 而 `LEVEL_DIRS` 的键只有那三个。这里用一个窄函数收口，避免每处索引都 TS7053。
  // 行为完全不变：未知 level 仍然落到 `?? ""`。
  const levelDir = (level: string): string => LEVEL_DIRS[level as keyof typeof LEVEL_DIRS] ?? "";
  const missingTools = TOOLS.map((tool) => join(levelDir(tool.level), tool.file)).filter(
    (relativePath) => !existsSync(join(toolRoot, relativePath))
  );
  // 入口在、它 import 的辅助模块不在 —— 命令一跑就 import 失败。顺着相对 import 递归走一遍,
  // 不另立一份"辅助模块清单"(那种清单会跟真实依赖各漂各的)。
  const { missing: missingHelpers, count: helperCount } = collectMissingImports(
    toolRoot,
    TOOLS.map((tool) => join(levelDir(tool.level), tool.file).split("\\").join("/"))
  );
  const commandProblems = [...missingTools, ...missingHelpers];
  checks.push(
    entry(
      "commands",
      "自带命令文件",
      commandProblems.length === 0 ? "pass" : "fail",
      commandProblems.length === 0
        ? `${String(TOOLS.length)} 个自带命令与 ${String(helperCount)} 个依赖模块都在(模块 / 工程 / 两级共用)`
        : `缺 ${String(commandProblems.length)} 个命令相关文件:${missingNote(commandProblems)} —— 会话里点名这些命令会直接报找不到`
    )
  );

  // 5) 自带技能:目录清单与 BUNDLED_SKILLS 逐项比对；SKILL.md 显式引用的资源也必须存在。
  const skillRoot = join(presetRoot, "skills");
  const skillDirs = listDirs(skillRoot);
  const missingSkills = BUNDLED_SKILLS.filter((name) => !skillDirs.includes(name));
  const unexpectedSkills = skillDirs.filter((name) => !BUNDLED_SKILLS.includes(name));
  const withoutSkill = skillDirs.filter((name) => !isRegularFile(join(skillRoot, name, "SKILL.md")));
  const references = skillDirs.flatMap((name) => {
    const core = readText(join(skillRoot, name, "SKILL.md"));
    return linkedSkillReferences(core).map((relativePath) => ({ name, relativePath }));
  });
  const missingReferences = references
    .filter(({ name, relativePath }) =>
      relativePath.includes("..") ||
      relativePath.includes("\\") ||
      !isRegularFile(join(skillRoot, name, ...relativePath.split("/")))
    )
    .map(({ name, relativePath }) => `${name}/${relativePath}`);
  const skillProblems = [...missingSkills, ...withoutSkill, ...missingReferences];
  checks.push(
    entry(
      "skills",
      "自带技能",
      skillProblems.length > 0 ? "fail" : unexpectedSkills.length > 0 ? "warn" : "pass",
      missingSkills.length > 0
        ? `缺 ${String(missingSkills.length)} 个技能目录:${missingNote(missingSkills)} —— 那个技能的按需加载会失效`
        : withoutSkill.length > 0
          ? `${String(withoutSkill.length)} 个技能目录缺 SKILL.md:${missingNote(withoutSkill)}`
          : missingReferences.length > 0
            ? `缺 ${String(missingReferences.length)} 份技能参考文件:${missingNote(missingReferences)} —— 技能正文会指向不存在的资源`
            : `${String(BUNDLED_SKILLS.length)} 个技能及 ${String(references.length)} 份显式引用的参考文件都在${
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
  //
  // `FIELDS` 是若干对象的联合（工具字段 / 模板字段 / 其他），**不是每个成员都有**
  // `tool` 与 `kind` —— 直接 `field.tool` 会 TS2339。用 `in` 收窄即可，运行时等价。
  const toolFields = FIELDS.filter(
    (field) => "tool" in field && "kind" in field && field.tool !== undefined && field.kind !== undefined
  );
  const registered = toolFields.filter((field) => String(values[String(field.key)] ?? "").trim() !== "");
  const broken = registered.filter((field) => !existsSync(String(values[String(field.key)]).trim()));
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
  //
  // ⚠️ 字段名必须是 `templateLibraryPath`(见 toolchain.js 的 FIELDS)。这里曾经写成
  // `templateLibraryRoot`,find() 恒返回 undefined → libraryRoot 恒为空 → **这一项永远是 pass**,
  // 用户把模板库路径填错也收不到任何提示。自检里"配置填错了会告诉你"的就只有这一项,
  // 所以它不是"少查一条",而是这一档判据整个失效(2026-10-21 修正,回归断言在
  // tools/check-selfcheck.mjs 的 ⑪)。
  const libraryField = FIELDS.find((field) => field.key === "templateLibraryPath");
  const libraryRoot = libraryField === undefined ? "" : String(values[String(libraryField.key)] ?? "").trim();
  /** 字段定义没了就说明模型自己漂了 —— 报出来,别静默退化成"没填"。 */
  const libraryFieldMissing = libraryField === undefined;
  checks.push(
    entry(
      "library",
      "模板库目录",
      libraryFieldMissing ? "fail" : libraryRoot === "" || existsSync(libraryRoot) ? "pass" : "warn",
      libraryFieldMissing
        ? "设置模型里找不到 templateLibraryPath 字段 —— 模板库这一项没法核对,请重装本插件"
        : libraryRoot === ""
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
