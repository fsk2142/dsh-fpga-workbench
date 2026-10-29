// 校验补丁里的 !!js 预设路径:用真实 loader 的求值器算出来,必须指向真实的预设目录。
//
// 为什么必须机器验:`!!js` 是字符串表达式,写错了不会有类型错误,只会在启动时静默
// 指向不存在的目录 —— 表现是"预设不见了",而你从界面上看不出原因。
//
// 依据(dsh-app-boot/lib/index.js:140):补丁文件被加载时,
//   this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href
// 也就是说 !!js 在**补丁文件所在目录**的上下文里求值。本包把补丁放在包根,
// 所以 'presets/' 就够了(官方示例写 '../presets/' 是因为它的补丁在下一层)。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BUNDLED_SKILLS, REQUIRED_PRESET_FILES } from "../lib/selfcheck.js";
import { INSTRUCTION_FILE } from "../presets/fpga-workbench/tools/setup-scaffold.mjs";
import { HOST_HINT, hostDir } from "./lib/host.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 宿主安装目录:唯一来源在 check-all.mjs(由它用同一个环境变量传下来),这里的默认值
// 由 tools/lib/host.mjs 推导 —— 不写死任何一台机器的安装路径。
const APP = process.env.DSH_APP_DIR ?? hostDir();
if (APP === "") {
  console.error(`找不到 DSH 宿主目录(要用它自带的 js-yaml 与 cordis-plugin-loader)。\n  ${HOST_HINT}`);
  process.exit(1);
}

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

const require = createRequire(`${APP}/package.json`);
const yaml = require("js-yaml");
const { evaluate, isJsExpr } = require("@deepseek-ai/cordis-plugin-loader");
const { entryListSchema } = require("@deepseek-ai/cordis-plugin-include");

// 1. 解析补丁:官方 0.1.7 registry 只从组合里的 @deepseek-ai/dsh-agent-preset 行收集预设。
const patchPath = join(ROOT, "cordis.patch.yml");
const rows = yaml.load(readFileSync(patchPath, "utf8"), { schema: entryListSchema });
check(
  Array.isArray(rows) && rows.length === 1,
  `顶层是数组且只有 1 个 insert(实际 ${Array.isArray(rows) ? `${rows.length} 条` : "非数组"})`
);
check(!rows.some((row) => row.id === "agent-presets"), "没有旧的 agent-presets 覆盖行");
const inserted = rows.flatMap((row) => row.insert ?? []);
check(inserted.length === 2, `补丁插入宿主行与预设声明行(实际 ${inserted.length})`);
check(inserted[0]?.id === "fpga-workbench" && inserted[0]?.name === "dsh-fpga-workbench", "宿主行按包名挂载");
const presetRow = inserted.find((row) => row.id === "preset-fpga-workbench");
check(presetRow?.name === "@deepseek-ai/dsh-agent-preset", "预设声明行按官方包名挂载");
check(presetRow?.config?.id === "fpga-workbench", "预设 config.id = fpga-workbench");
check(Array.isArray(presetRow?.config?.plugins) && presetRow.config.plugins.length > 0, "预设声明了 plugins 数组");

// 2. 预设文件仍是可编辑源:它必须存在且能解析,并与组合里的声明保持同一份行集合。
const presetDir = join(ROOT, "presets", "fpga-workbench");
check(existsSync(presetDir), "包内 FPGA 预设目录存在");
const compositionPath = join(presetDir, "agent.cordis.yml");
check(existsSync(compositionPath), "fpga-workbench 有 agent.cordis.yml");
const normalizeValue = (value) => {
  if (isJsExpr(value)) return { __jsExpr: value.__jsExpr };
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeValue(value[key])])
  );
};
const normalizeRows = (list) =>
  (Array.isArray(list) ? list : []).map((row) => {
    if (row === null || typeof row !== "object") return normalizeValue(row);
    const normalized = { ...row };
    if (row.group === true) normalized.config = normalizeRows(row.config);
    if (row.id === "skill-filesystem" && row.config !== null && typeof row.config === "object") {
      normalized.config = { ...row.config, customSkillDirs: ["<已单独验证的上下文技能目录>"] };
    }
    return normalizeValue(normalized);
  });
const serializeRows = (list) => JSON.stringify(normalizeRows(list));
if (existsSync(compositionPath)) {
  try {
    const entries = yaml.load(readFileSync(compositionPath, "utf8"), { schema: entryListSchema });
    check(Array.isArray(entries) && entries.length > 0, "FPGA 预设组装是可解析的非空 entry list");
    const sourceRows = serializeRows(entries);
    const patchRows = serializeRows(presetRow?.config?.plugins);
    const driftProbe = structuredClone(entries);
    const driftRow = driftProbe.find((row) => row?.group !== true && row?.config !== undefined);
    if (driftRow !== undefined) driftRow.config.__comparison_probe__ = true;
    check(
      driftRow !== undefined && serializeRows(entries) !== serializeRows(driftProbe),
      "完整一致检查能捕获叶子 config 漂移"
    );
    check(
      sourceRows === patchRows,
      "补丁里的完整预设配置与 agent.cordis.yml 一致(技能目录表达式另行验证)",
      `源 ${entries.length} 个顶层项 / 补丁 ${presetRow?.config?.plugins?.length ?? 0} 个顶层项`
    );
  } catch (error) {
    check(false, "FPGA 预设组装解析失败", error.message);
  }
}

// 2b. 技能目录是 !!js 表达式,求值基准决定它指向哪里。补丁在**包根**,而声明行在预设挂载时
//     又可能用 registry 的 baseUrl 重新求值(实测 dsh-agent-preset 的 mountPreset 传 ctx.baseUrl)
//     —— 所以相对 `skills/` 在两种上下文里都指不到包内技能。这里用宿主同一个求值器按两种
//     上下文各算一次,必须都落在包内 presets/fpga-workbench/skills/ 上。
{
  const findRow = (list, id) => {
    for (const row of Array.isArray(list) ? list : []) {
      if (row === null || typeof row !== "object") continue;
      if (row.id === id) return row;
      if (row.group === true) {
        const hit = findRow(row.config, id);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  let patchSkill;
  let fileSkill;
  try {
    patchSkill = findRow(presetRow?.config?.plugins, "skill-filesystem");
    fileSkill = findRow(
      yaml.load(readFileSync(compositionPath, "utf8"), { schema: entryListSchema }),
      "skill-filesystem"
    );
  } catch (error) {
    check(false, "读取 skill-filesystem 行", error.message);
  }
  const dirExpr = (row) => row?.config?.customSkillDirs?.[0];
  check(isJsExpr(dirExpr(patchSkill)), "补丁里的技能目录是 !!js 表达式");
  check(isJsExpr(dirExpr(fileSkill)), "预设文件里的技能目录是 !!js 表达式");

  const skillsDir = join(presetDir, "skills");
  const strip = (value) => String(value).replace(/[\\/]+$/u, "");
  if (isJsExpr(dirExpr(fileSkill))) {
    // 预设文件自己的基准就是预设目录。
    const fileCtx = { baseUrl: pathToFileURL(`${presetDir}/`).href, loader: {}, get: () => undefined };
    check(
      strip(evaluate(fileCtx, dirExpr(fileSkill).__jsExpr)) === skillsDir,
      "agent.cordis.yml 的技能目录在预设目录基准下指向包内 skills/"
    );
  }
  if (isJsExpr(dirExpr(patchSkill))) {
    // 补丁会被两种上下文求值:补丁加载时(baseUrl = 包根)与预设挂载时(registry 的 baseUrl)。
    const bootCtx = { baseUrl: pathToFileURL(`${ROOT}/`).href, loader: {}, get: () => undefined };
    const fakeProfile = join(ROOT, ".tmp", "fake-profile");
    const registryCtx = {
      baseUrl: "file:///X/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/",
      loader: {},
      get: (name) => (name === "profileContext" ? { dir: fakeProfile } : undefined)
    };
    check(
      strip(evaluate(bootCtx, dirExpr(patchSkill).__jsExpr)) === skillsDir,
      "补丁的技能目录在包根基准下指向包内 skills/"
    );
    check(
      strip(evaluate(registryCtx, dirExpr(patchSkill).__jsExpr)) ===
        join(fakeProfile, "node_modules", "dsh-fpga-workbench", "presets", "fpga-workbench", "skills"),
      "补丁的技能目录在 registry 基准下仍指向已装包的 skills/(不随 baseUrl 漂)"
    );
  }
}

// 3. 可见性只来自组合里的 @deepseek-ai/dsh-agent-preset 行;宿主不再往用户预设目录写副本。
const hostSource = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
const codeOnly = hostSource
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
check(!/ensureUserPreset|USER_PRESET_DIR|presetSyncNeeded/u.test(codeOnly),
  "宿主不再同步用户预设目录(预设由组合里的注册行提供)");

// 4. 显示名只有一处真相:预设的 name 与设置页的 LABEL 必须相同。
//    改名只改一半会让用户看到两个名字(预设选择器一个、设置里一个)。
const presetYml = readFileSync(join(presetDir, "preset.yml"), "utf8");
const presetName = /^\s*name:\s*(.+)$/mu.exec(presetYml)?.[1]?.trim();
const clientLabel = /const LABEL = "([^"]+)"/u.exec(readFileSync(join(ROOT, "lib", "client.js"), "utf8"))?.[1];
check(presetName !== undefined && presetName !== "", `预设声明了显示名(实际 ${String(presetName)})`);
check(
  presetName === clientLabel,
  `预设显示名与设置页名一致(${String(presetName)} vs ${String(clientLabel)})`
);
check(presetName === "FPGA 开发模式", `显示名是「FPGA 开发模式」(实际 ${String(presetName)})`);
// 人设文案里也要用同一个名字 —— 它会进到会话提示里
check(
  readFileSync(join(presetDir, "agent.cordis.yml"), "utf8").includes("FPGA 开发模式"),
  "人设文案用的是同一个显示名"
);

// 7. 预设自己的组装:模式半侧那一行,以及自带的技能目录。
//
//    「选中这个模式才有的东西」全靠这里:预设行只在命名了本预设的会话里挂载。
//    名字写错不会报错 —— discovery 会把整个预设判成 broken、从选择器里消失,
//    所以这一行的解析必须机器验。
let compositionRows = [];
try {
  compositionRows = yaml.load(readFileSync(compositionPath, "utf8"), { schema: entryListSchema });
} catch (error) {
  check(false, "预设组装可解析", error.message);
}
const rowById = new Map((Array.isArray(compositionRows) ? compositionRows : []).map((row) => [row.id, row]));

const modeRow = rowById.get("fpga-workbench-mode");
check(modeRow !== undefined, "预设里有 fpga-workbench-mode 行(模式半侧只从这里挂载)");
check(
  modeRow?.name === "dsh-fpga-workbench/mode",
  `模式行按「包名 + 子路径」挂载(实际 ${JSON.stringify(modeRow?.name)})`
);
check(modeRow?.disabled !== true, "模式行没有被 disabled");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
// `./mode` 的写法在迁移到 tsdown 后变了：原来是裸字符串 `"./lib/mode.js"`，
// 现在是带类型的条件导出 `{ types, default }`。两种都该认 —— 断言要守的是
// 「`./mode` 指向 lib/mode.js 这个文件」，不是某种 JSON 形状。
{
  const modeExport = manifest.exports?.["./mode"];
  const target = typeof modeExport === "string" ? modeExport : modeExport?.default;
  check(
    target === "./lib/mode.js",
    `package.json 声明了 exports['./mode'] 指向 ./lib/mode.js（实际 ${JSON.stringify(modeExport)}）`
  );
}
check((manifest.files ?? []).includes("lib"), "files 白名单含 lib(mode 半侧才装得进去)");

// 自带技能目录用 customSkillDirs 声明;!!js 的 baseUrl 是**预设目录**(与官方 cordis 预设
// 同一写法),所以预设被复制到用户预设目录之后,路径依然指得对。
const presetCtx = { baseUrl: pathToFileURL(`${presetDir}/`).href, loader: {} };
const declared = rowById.get("skill-filesystem")?.config?.customSkillDirs;
check(Array.isArray(declared) && declared.length === 1, `skill-filesystem 声明了自带技能目录(实际 ${Array.isArray(declared) ? declared.length : "无"} 项)`);
const skillDir = (declared ?? []).map((value) => (isJsExpr(value) ? evaluate(presetCtx, value.__jsExpr) : value))[0];
check(typeof skillDir === "string" && existsSync(skillDir), `技能目录由 !!js 求值且存在(${String(skillDir)})`);
// fileURLToPath 对目录 URL 会保留结尾分隔符,比之前去掉再比
check(
  String(skillDir).replace(/[\\/]+$/u, "") === join(presetDir, "skills"),
  `技能目录就是预设自己的 skills/(实际 ${String(skillDir)})`
);

// dsh-skill-filesystem 首次加载只返回 SKILL.md；内容过长时会先经过 8192 字符的工具结果裁剪。
// 核心说明因此要留出渲染包装余量，细节拆进 SKILL.md 显式链接的 references/*.md，按需再读。
const SKILL_BODY_CODEPOINT_LIMIT = 7000;
const readSkillCore = (skill) => readFileSync(join(skillDir, skill, "SKILL.md"), "utf8");
const linkedSkillReferences = (text) => [
  ...new Set(
    [...text.matchAll(/\[[^\]]+\]\((references\/[^)\s]+\.md)\)/gu)].map((match) => match[1])
  )
];
const listReferenceMarkdown = (dir, prefix = "references", out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) listReferenceMarkdown(join(dir, entry.name), relativePath, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(relativePath);
  }
  return out.sort();
};
const readSkillBundle = (skill) => {
  const core = readSkillCore(skill);
  const references = linkedSkillReferences(core)
    .filter((relativePath) => !relativePath.includes("..") && !relativePath.includes("\\"))
    .map((relativePath) => join(skillDir, skill, ...relativePath.split("/")))
    .filter((file) => existsSync(file) && statSync(file).isFile())
    .map((file) => readFileSync(file, "utf8"));
  return [core, ...references].join("\n\n");
};

// ── 作用域:这些东西只在 FPGA 模式下生效,别的模式一点都别沾 ──────────────────
//
// 用户的原话:"一定是开发模式采用这些东西,不是开发模式不要用这些"。
// 机制上靠**两层分工**:
//   · profile 层(cordis.patch.yml 的宿主行,全局):只挂插件行(设置读写 + 状态/浏览路由);
//   · 预设层(@deepseek-ai/dsh-agent-preset 的 config.plugins,只有点名本预设的会话挂载):
//     人设、工具链提示、15 个技能。
// 官方 registry 用 @deepseek-ai/dsh-agent-preset 的 isolate 语义隔离这些行;宿主行里出现
// 提示/技能/模式半侧才会泄漏给所有会话。所以这里只检查**宿主 insert 行**。
const hostRowText = JSON.stringify(inserted[0] ?? {});
check(!/systemPrompt/u.test(hostRowText), "全局层(宿主行)不注册任何会话提示 —— 提示只能来自预设层");
check(!/customSkillDirs|skill-filesystem/u.test(hostRowText), "全局层不注册技能目录 —— 技能只在预设层可见");
check(!/能力地图|实现思路/u.test(hostRowText), "全局层不含本模式的人设文字(那是预设 persona 的事)");
check(
  !/dsh-fpga-workbench\/mode/u.test(hostRowText),
  "全局层不挂模式半侧(它必须待在预设声明里,否则每个会话都会加载那段工具链提示)"
);
// 反过来:预设层必须有这三样,缺一样本模式就残废
check(rowById.get("persona") !== undefined, "预设层有 persona 行(能力地图随模式走)");
check(/dsh-persona/u.test(String(rowById.get("persona")?.name ?? "")), "persona 行挂的是 dsh-persona");
// 工作区指令:本模式要有一份**自己的**指令文件,排在最前(用户口径 2026-09-19)。
// 候选名给了就以给的为准 —— 漏掉 AGENTS.md 会静默不再加载它,所以两条都要断言。
const instructionsRow = rowById.get("agent-instructions");
const candidates = instructionsRow?.config?.instructionFileCandidates;
check(Array.isArray(candidates), "agent-instructions 行声明了 instructionFileCandidates");
check(candidates?.[0] === "AGENTS.fpga.md", `本模式自有的指令文件排在最前(实际 ${String(candidates?.[0])})`);
check(
  candidates?.includes("AGENTS.md") && candidates?.includes("CLAUDE.md"),
  "候选名里保留 AGENTS.md / CLAUDE.md(给了候选就按给的算,漏了就不再加载)"
);
check(
  rowById.get("skill-filesystem") !== undefined,
  "预设层有 skill-filesystem 行(技能目录只在预设层声明)"
);

// 每个技能必须能被 dsh-skill-filesystem 认出来:目录名 = frontmatter 的 name,且是
// kebab-case;name/description 缺任何一个,技能会被**静默忽略**(只留一条 warn)。
const skillNames = existsSync(skillDir)
  ? readdirSync(skillDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [];
const skillDescriptions = new Map();
check(skillNames.length > 0, `预设带了至少一个技能(实际 ${skillNames.length} 个)`);
// 设置页自检按 BUNDLED_SKILLS 这份期望清单核对已装副本(只数目录的话,"15 个变 14 个"照样通过)。
// 两边必须一致:删技能就得同时改清单,漏改在这里红。
check(
  BUNDLED_SKILLS.length === skillNames.length && BUNDLED_SKILLS.every((name) => skillNames.includes(name)),
  `lib/selfcheck.js 的技能期望清单与目录逐项一致(清单 ${BUNDLED_SKILLS.length} / 目录 ${skillNames.length})`,
  `只在清单里:${BUNDLED_SKILLS.filter((name) => !skillNames.includes(name)).join("、") || "无"};` +
    `只在目录里:${skillNames.filter((name) => !BUNDLED_SKILLS.includes(name)).join("、") || "无"}`
);
for (const skill of skillNames) {
  const file = join(skillDir, skill, "SKILL.md");
  if (!existsSync(file)) {
    check(false, `${skill} 缺 SKILL.md`);
    continue;
  }
  const core = readSkillCore(skill);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(core);
  const block = frontmatter?.[1];
  if (block === undefined) {
    check(false, `${skill} 缺 YAML frontmatter(会被静默忽略)`);
    continue;
  }
  let meta;
  try {
    meta = yaml.load(block);
  } catch (error) {
    check(false, `${skill} 的 frontmatter 不是合法 YAML`, error.message);
    continue;
  }
  skillDescriptions.set(skill, String(meta?.description ?? ""));
  check(meta?.name === skill, `${skill} 的 frontmatter name 与目录名一致(实际 ${JSON.stringify(meta?.name)})`);
  check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(meta?.name)), `${skill} 的名字是 kebab-case(技能名的合法字符集)`);
  // 命名统一:模块类 fpga-module-*、工程类 fpga-project-*(用户要求对称);
  // 一级标题去掉 fpga- 前缀,与技能名一致(`# module-lint:…` / `# project-impl:…`)
  check(
    /^fpga-(module|project)-/u.test(skill),
    `${skill} 带级别前缀(module- 或 project-)`
  );
  const heading = /^# ([a-z-]+):/mu.exec(core)?.[1];
  check(heading === skill.replace(/^fpga-/u, ""), `${skill} 的一级标题与技能名一致(实际 ${String(heading)})`);
  check(typeof meta?.description === "string" && meta.description.length > 0, `${skill} 写了 description(否则加载器直接忽略)`);
  // 触发场景要写在 description 里(那张能力地图靠它选技能),不能只写"某阶段之后使用"
  check(
    /时用|时候用/u.test(String(meta?.description)),
    `${skill} 的 description 说清了"什么时候用"(不是只写阶段顺序)`
  );
  check(
    // `阶段 ?[0-9]` 收的是"阶段 0 / 阶段 2"这种编号标题 —— 它暗示存在一条编号流水线,
    // 而技能是按需取用的能力(各技能的一级标题统一写成 `名字:做什么`)。
    !/第一阶段|第二阶段|阶段 ?[0-9]|下一阶段|一口气写完|这一关过了才进|流程必须跑完并通过确认|OBSERVE_ONLY/u.test(core),
    `${skill} 里没有残留的"阶段链/硬门禁"口气`
  );
  const bodyCodepoints = Array.from(core.slice(frontmatter?.[0].length ?? 0)).length;
  check(
    bodyCodepoints <= SKILL_BODY_CODEPOINT_LIMIT,
    `${skill} 的核心正文不超过 ${String(SKILL_BODY_CODEPOINT_LIMIT)} 个 Unicode 字符(实际 ${String(bodyCodepoints)})`
  );
  const references = linkedSkillReferences(core);
  if (skill === "fpga-module-rtl" || skill === "fpga-module-verif") {
    check(references.length >= 2, `${skill} 把大段细节拆到至少 2 份显式引用的 references/*.md`);
  }
  const invalidReferences = references.filter(
    (relativePath) =>
      relativePath.includes("..") ||
      relativePath.includes("\\") ||
      !existsSync(join(skillDir, skill, ...relativePath.split("/"))) ||
      !statSync(join(skillDir, skill, ...relativePath.split("/"))).isFile()
  );
  check(
    invalidReferences.length === 0,
    `${skill} 显式链接的参考文件都存在且是普通文件(异常:${invalidReferences.join("、") || "无"})`
  );
  const orphanReferences = listReferenceMarkdown(join(skillDir, skill, "references")).filter(
    (relativePath) => !references.includes(relativePath)
  );
  check(
    orphanReferences.length === 0,
    `${skill} 的 references/*.md 都能从 SKILL.md 到达(孤儿:${orphanReferences.join("、") || "无"})`
  );
  for (const relativePath of references.filter((item) => !invalidReferences.includes(item))) {
    const size = Array.from(readFileSync(join(skillDir, skill, ...relativePath.split("/")), "utf8")).length;
    check(
      size <= SKILL_BODY_CODEPOINT_LIMIT,
      `${skill}/${relativePath} 不超过 ${String(SKILL_BODY_CODEPOINT_LIMIT)} 个 Unicode 字符(实际 ${String(size)})`
    );
  }
}

// 入口技能是按需整份加载的运行时上下文。给总量设预算，防止修一条规则就继续堆一段解释。
//
// **这个数字是我们自己定的，不是宿主或任何外部规范的要求**（2026-10-28 复核时确认：
// 宿主 `app.asar` 里没有任何技能大小限制）。查证过之后把上限从 100000 提到 150000，
// 并改成两档：
//
//   · 超过 150000 只**警告** —— 提醒「该考虑压缩了」，但不阻塞
//   · 超过 200000 才 FAIL —— 那时确实会吃掉可观的上下文
//
// 为什么改：贴着 100000 跑的那几轮，为了「不超」做了把速记括号去掉、在技能之间
// 反复搬同一份内容这类**指标替代目的**的优化，反而牺牲了可读性。这个约束的价值是
// 「提醒别膨胀」，不是「精确到字节」。
const SKILL_ENTRY_BYTES_WARN = 150_000;
const SKILL_ENTRY_BYTES_LIMIT = 200_000;
const skillEntryBytes = skillNames.reduce(
  (total, skill) => total + statSync(join(skillDir, skill, "SKILL.md")).size,
  0
);
if (skillEntryBytes > SKILL_ENTRY_BYTES_WARN && skillEntryBytes <= SKILL_ENTRY_BYTES_LIMIT) {
  console.warn(
    `WARN  15 个入口 SKILL.md 总计 ${String(skillEntryBytes)} B，已超过 ${String(SKILL_ENTRY_BYTES_WARN)} B 的建议值 —— 考虑把细节挪进 references（不阻塞）`
  );
}
check(
  skillEntryBytes <= SKILL_ENTRY_BYTES_LIMIT,
  `15 个入口 SKILL.md 总计不超过 ${String(SKILL_ENTRY_BYTES_LIMIT)} B(实际 ${String(skillEntryBytes)} B;建议值 ${String(SKILL_ENTRY_BYTES_WARN)} B)`
);

// 技能目录会把全部 description 放进模型可见的能力目录。description 只负责触发、边界与移交，
// 详细步骤留在按需加载的 SKILL.md；否则 15 个技能会在每轮都占用不必要的上下文。
const SKILL_DESCRIPTION_CODEPOINT_LIMIT = 220;
const SKILL_CATALOG_CODEPOINT_LIMIT = 1300;
const descriptionCodepoints = [...skillDescriptions.entries()].map(([skill, description]) => [
  skill,
  Array.from(description).length,
]);
const longDescriptions = descriptionCodepoints.filter(([, size]) => size > SKILL_DESCRIPTION_CODEPOINT_LIMIT);
const catalogCodepoints = descriptionCodepoints.reduce((total, [, size]) => total + size, 0);
check(
  longDescriptions.length === 0,
  `每个技能 description 不超过 ${String(SKILL_DESCRIPTION_CODEPOINT_LIMIT)} 个 Unicode 字符`,
  `超限:${longDescriptions.map(([skill, size]) => `${skill}=${String(size)}`).join("、") || "无"}`
);
check(
  catalogCodepoints <= SKILL_CATALOG_CODEPOINT_LIMIT,
  `技能 description 目录总长不超过 ${String(SKILL_CATALOG_CODEPOINT_LIMIT)} 个 Unicode 字符(实际 ${String(catalogCodepoints)})`
);

const releaseDescription = skillDescriptions.get("fpga-project-release") ?? "";
check(
  /只在用户明确[\s\S]{0,20}(交付|发布)/u.test(releaseDescription),
  "release 的 description 直接声明只在用户明确要求交付或发布时使用"
);
const integrateDescription = skillDescriptions.get("fpga-project-integrate") ?? "";
check(
  /只接已有源/u.test(integrateDescription) && /fpga-project-rtl/u.test(integrateDescription) &&
    !/专用模块在 src\/rtl 直接写/u.test(integrateDescription),
  "integrate 的 description 写明只接已有源,缺失专用 RTL 移交 project-rtl"
);

const implDescription = skillDescriptions.get("fpga-project-impl") ?? "";
const implScopeText = readSkillBundle("fpga-project-impl");
check(
  /route_design/u.test(implDescription) && /需要 bitstream/u.test(implDescription),
  "impl 的 description 区分 route_design 与按需 bitstream"
);
check(
  /请求范围[\s\S]{0,160}`route`[\s\S]{0,160}`bitstream`/u.test(implScopeText),
  "impl 正文先记录 route / bitstream 请求范围"
);
check(
  /`route` 范围[\s\S]{0,160}`PASS`/u.test(implScopeText) &&
    /`bitstream` 范围[\s\S]{0,160}`PASS`/u.test(implScopeText),
  "impl 的 PASS 按 route / bitstream 范围分别判定"
);
check(!/NOT_APPLICABLE[^\n]*不需要 bitstream/u.test(implScopeText), "route-only 成功不会被误记为 NOT_APPLICABLE");

const syssimScopeText = readSkillBundle("fpga-project-syssim");
check(
  /复用[\s\S]{0,50}(可信|已有|现有)[\s\S]{0,20}证据/u.test(syssimScopeText) &&
    /当前任务|任务需要/u.test(syssimScopeText),
  "syssim 复用可信既有证据,再按当前任务补覆盖"
);
check(!/单模块仿真\(先做完这个\)/u.test(syssimScopeText), "syssim 不强制每次先重跑全部单模块仿真");
check(
  /正式工程级 `PASS`[\s\S]{0,120}至少一次根 `sim\/` 实跑/u.test(syssimScopeText) &&
    /模块级证据不能单独产出正式 `PASS`/u.test(syssimScopeText),
  "syssim 的正式 PASS 必须有根 sim/ 实跑,模块证据只能作为前置证据"
);

const projectRtlScopeText = readSkillBundle("fpga-project-rtl");
check(
  /write_bd_tcl/u.test(projectRtlScopeText) && /manual integration required/u.test(projectRtlScopeText),
  "project-rtl 写明 Block Design 的复现脚本与人工集成边界"
);
check(
  /elaborate 由 `fpga-project-integrate`/u.test(projectRtlScopeText) &&
    /project-rtl 的 `PASS` 不以 elaborate 为条件/u.test(projectRtlScopeText),
  "project-rtl 只判 BD 文件与复现步骤,elaborate 结论归 project-integrate"
);

// ── 级别划分清楚:模块 4 个 / 工程 11 个 ─────────────────────────────────────
// 模块级四个 = 四个环节(spec/rtl/verif/synth)。审查环节已移除(2026-10-29 用户定案:
// 判定只看仿真验证与测试能否通过)。
const moduleSkills = skillNames.filter((name) => name.startsWith("fpga-module-"));
const projectSkills = skillNames.filter((name) => name.startsWith("fpga-project-"));
check(
  moduleSkills.length + projectSkills.length === skillNames.length,
  `每个技能都能看出属于哪一级(没前缀的:${skillNames.filter((name) => !/^fpga-(module|project)-/u.test(name)).join("、") || "无"})`
);
check(moduleSkills.length === 4, `模块级 4 个(实际 ${moduleSkills.length}:${moduleSkills.join("、")})`);
check(projectSkills.length === 11, `工程级 11 个(实际 ${projectSkills.length}:${projectSkills.join("、")})`);
// 工程级各篇都要有「前置」与「产物」两节:前置条件不该散在正文里,
// 产物是这一环节的交付物。审计那一篇按用户口径删掉了(验证已经覆盖它),所以不在这里。
for (const skill of projectSkills) {
  const text = readSkillBundle(skill);
  check(/^## 前置/mu.test(text), `${skill} 有「前置」一节`);
  check(/^## 产物/mu.test(text), `${skill} 有「产物」一节`);
  // `module-*` 命令的参数是**模块根**,不是用户指定工程根 —— 两类根各有独立锚点与目录树,
  // 把工程根传给模块命令只会扫到不相干的东西。
  const wrongModuleArg = /module-(?:rtl-check|verif-new|synth-new|rtl-new)\.mjs"?\s*<?工作区根/u.test(text);
  check(!wrongModuleArg, `${skill} 没有把工作区根当 module 命令的参数`);
}
// 厂商命令的选项要**查过命令帮助**才能写。踩过一次:board 技能写了
// `program_hw_devices -verify` —— Vivado 2025.2 的 program_hw_devices 根本没有这个选项
// (verify_hw_devices 是给 eFUSE 器件做掩码比对的,不是通用回读)。
// 所以这里钉一条:那条不存在的写法不许再出现在任何技能里。
for (const skill of skillNames) {
  const text = readSkillBundle(skill);
  // 允许在同一行里**否定**它(说明"没有这个选项"),所以要求它不出现在肯定语境里:
  // 出现的行若带"没有/不是/错"等否定词,视为纠正性说明,放行。
  const lines = text.split("\n").filter((line) => /program_hw_devices\s+-verify/u.test(line));
  const wrong = lines.filter((line) => !/没有|不是|错的|不存在/u.test(line));
  check(wrong.length === 0, `${skill} 没有写不存在的 program_hw_devices -verify 选项`);
}

// ── fpga-module-spec 的提问顺序(用户明确要求过) ────────────────────────────────────
//
// 顺序:① 先定做模块还是做工程(没说就问) → ② 问器件(器件决定写法) →
// ③ 讨论方案(含"要不要用 Python 写参考模型") → ④ 画实现思路流程图让用户确认 →
// ⑤ 明确验证要求与对照数据(测试平台怎么搭 / 输入数据 / 对照数据 / 比对格式)。
// (⑤ 是"有要求就按用户的,没有就自己定"。)
//
// 原来是六步(测试平台与数据 / 比对各一步);仿真与比对合成 verif 环节后合并成第五步 ——
// 两件事本来是一件事,分两步问会出现"没有比对对象却先定了测试平台"这种半截结论。
// 顺序错了等于第一句话就问偏(比如先问功能、把方向与器件留到最后),所以按位置钉住。
const specSkill = readSkillBundle("fpga-module-spec");
const STEPS = ["第一步", "第二步", "第三步", "第四步", "第五步"];
const stepAt = STEPS.map((step) => specSkill.indexOf(`## ${step}:`));
check(
  stepAt.every((at) => at >= 0),
  `fpga-module-spec 写明了一到五步(缺:${STEPS.filter((_, index) => stepAt[index] < 0).join("、") || "无"})`
);
check(
  !/## 第六步:/u.test(specSkill),
  "没有残留的第六步(测试平台与比对已合并成第五步)"
);
check(stepAt.every((at, index) => index === 0 || at > stepAt[index - 1]), "五步按顺序排列");
const stepText = (index) => specSkill.slice(stepAt[index], stepAt[index + 1] ?? specSkill.length);
check(stepText(0).includes("模块") && stepText(0).includes("工程"), "第一步先定「做模块还是做工程」");
check(stepText(0).includes("fpga-project-spec"), "第一步把「做工程」指向 fpga-project-spec");
check(
  stepText(1).includes("器件") && /写法/u.test(stepText(1)),
  "第二步确定器件,并说明为什么(器件决定写法)"
);
check(stepText(2).includes("参考"), "第三步里有「先建参考,再定方案」");
check(/Python/u.test(stepText(2)), "第三步问用户要不要用 Python 写参考模型");
check(/流程图/u.test(stepText(3)), "第四步画实现思路流程图");
// 拍数/延迟要写成可判定的拍数(实测教训:只验数值的判据挡不住"结果晚一拍"这类错位)
check(
  /拍数\/延迟类判据要写成拍数/u.test(specSkill) && /不比对时机的判据挡不住时序错位|只比对数值/u.test(specSkill),
  "规格技能要求:延迟/拍数类判据写成具体拍数,并说明只验数值挡不住时序错位"
);
// 第五步:测试平台 + 输入数据 + 对照数据 + 比对格式(有则请用户给,没有则自己定)
const dataStep = stepText(4);
check(/测试平台/u.test(dataStep), "第五步问测试平台的实现要求");
check(/输入数据/u.test(dataStep) && /对照数据/u.test(dataStep), "第五步问输入数据与对照数据");
check(
  /请用户提供|请其提供|由用户提供/u.test(dataStep) && /自己确定|本环节确定|由本环节决定/u.test(dataStep),
  "第五步写明:用户有要求就按用户的,没有就自己定"
);
// 五个步骤是讨论环节,不是问卷:每步都要先写清"要定下来的结论",再写讨论内容与注意事项
check(/讨论的顺序,不是问卷|不是问卷/u.test(specSkill), "开篇点明五步是讨论顺序、不是问卷");
for (const [index, step] of STEPS.entries()) {
  check(
    /要定下来的/u.test(stepText(index)),
    `${step} 写清了这一步要定下来的结论(而不是只列问题)`
  );
}
check(
  STEPS.every((_, index) => /注意/.test(stepText(index)) || index === 0),
  "各步把易错点放在「注意」里,与讨论内容分开"
);
// 第五步也要问比对那一半(合并的是步骤,不是内容)
const compStep = stepText(4);
check(/比对/u.test(compStep), "第五步问比对的要求");
check(
  /golden|对照数据/u.test(compStep) && /请用户提供|请其提供/u.test(compStep),
  "第五步问对照数据从哪来、用户有就请他给"
);
check(/NOT_APPLICABLE/u.test(compStep), "第五步说明:不需要比对的模块记 NOT_APPLICABLE");
check(/样本/u.test(compStep), "第五步明确样本规模(0 样本不得判 PASS)");
// 器件必须先于流程图:器件会影响流程图里的原语/资源选择
check(stepAt[1] < stepAt[3], "问器件排在画流程图之前");

// 编写要有依据:接口照 spec、路径照 flow.md 的图、参数照参考资料 —— 少哪一条,写出来的东西
// 就没人能对着图复核(用户指出过:原来这一环根本没写"照着什么写")
const rtlText = readSkillBundle("fpga-module-rtl");
check(/flow\.md/u.test(rtlText), "rtl 技能写明实现路径照 spec/flow.md(不是凭想象写)");
check(/参考资料/u.test(rtlText), "rtl 技能写明参数与算法照 spec 的「参考资料」");
check(
  /接口[^。]{0,24}spec\/spec\.md|spec\/spec\.md[^。]{0,24}接口/u.test(rtlText),
  "rtl 技能写明接口照 spec/spec.md 抄准"
);
check(
  /走不通|不可行/u.test(rtlText) && /改[^。]{0,8}(图|spec)/u.test(rtlText),
  "rtl 技能写明:图走不通要回去改图/规格并重新确认,不得默默换路径"
);
for (const reader of ["fpga-module-rtl", "fpga-module-verif"]) {
  check(
    /参考资料/u.test(readSkillBundle(reader)),
    `${reader} 会去 spec 的「参考资料」取参照(参考链不能断)`
  );
}

// 收尾(用户要求):产物除 spec.md 外,流程图要单独成文;骨架用自带脚本一次建好,不手工建目录
check(/flow\.md/u.test(specSkill), "模块级写明流程图单独存成 spec/flow.md(不只塞在 spec.md 里)");
check(/setup-scaffold\.mjs/u.test(specSkill), "模块级写明用自带脚本一次性建骨架");
check(/--dry-run/u.test(specSkill), "模块级提示先 --dry-run 看一眼");
const projectSpec = readSkillBundle("fpga-project-spec");
check(/doc\/flow\.md/u.test(projectSpec), "工程级写明框图单独存成 doc/flow.md");
check(/setup-scaffold\.mjs/u.test(projectSpec), "工程级写明用自带脚本建骨架");
check(
  /--kind project/u.test(projectSpec) && /<用户指定工程目录>/u.test(projectSpec) &&
    /--modules[^\n]{0,40}(停用|拒绝|不能|不要)/u.test(projectSpec),
  "工程级把用户指定目录直接作为根,带 --kind project,并明确拒绝旧 --modules"
);
check(existsSync(join(presetDir, "tools", "setup-scaffold.mjs")), "自带 setup-scaffold.mjs 确实在包里");
// 模式规则的唯一真相源是 preset 内的模板文件；骨架直接复制它。
const rulesSource = join(ROOT, "presets", "fpga-workbench", "workspace", "AGENTS.fpga.md");
check(existsSync(rulesSource), `模式规则模板存在:${rulesSource}`);
// 设置页自检按 REQUIRED_PRESET_FILES 核对"按名字读的固定文件"。这份清单必须与 setup-scaffold
// 真正读的那个文件对得上(名字来自它导出的 INSTRUCTION_FILE),否则自检会保护错文件。
check(
  REQUIRED_PRESET_FILES.map((rel) => rel.split("/").at(-1)).includes(INSTRUCTION_FILE) &&
    REQUIRED_PRESET_FILES.includes(`workspace/${INSTRUCTION_FILE}`),
  `自检的固定文件清单与 setup-scaffold 读的文件一致(清单:${REQUIRED_PRESET_FILES.join("、")};INSTRUCTION_FILE:${INSTRUCTION_FILE})`
);
const rulesBody = existsSync(rulesSource) ? readFileSync(rulesSource, "utf8") : "";
check(rulesBody.includes("FPGA 开发模式的工作区规则"), "规则区块里有正文(不是空壳)");
check(rulesBody.split("\n").length >= 10, `规则区块够实(${rulesBody.split("\n").length} 行)`);
const readmeText = readFileSync(join(ROOT, "README.md"), "utf8");
const compositionText = readFileSync(compositionPath, "utf8");
const patchText = readFileSync(patchPath, "utf8");
const ruleConsumers = [readmeText, compositionText, patchText, readSkillCore("fpga-module-rtl"), readSkillCore("fpga-module-spec")];
check(
  ruleConsumers.every((text) => !text.includes("fpga-mode-rules")),
  "README、人设与技能不再引用已废弃的 fpga-mode-rules 标记"
);
check(
  compositionText.includes("presets/fpga-workbench/workspace/AGENTS.fpga.md") &&
    patchText.includes("presets/fpga-workbench/workspace/AGENTS.fpga.md"),
  "编辑源与运行时补丁都点名唯一规则源 workspace/AGENTS.fpga.md"
);
check(
  /原样复制/u.test(rulesBody) && !/抽出来|抽取/u.test(rulesBody),
  "规则源说明骨架会原样复制文件"
);
check(
  !/开发自检目录 `tools\/` 与 `\.tmp\/` 也会被一起取下来/u.test(readmeText) &&
    !/`README\.md`\(`files` 白名单\)/u.test(readmeText),
  "README 准确描述 git 安装内容与 npm 自动包含 README 的行为"
);
check(
  readmeText.includes("docs/DEVELOPMENT.md") && !readmeText.includes("## 关于界面(已放弃的方案,留作记录)"),
  "README 把开发自检细节与历史方案移到 docs/DEVELOPMENT.md"
);
check(!/^\s*#/mu.test(patchText), "运行时 cordis.patch.yml 不含只供维护者阅读的注释行");

// 原型是 RTL 与验证共同的参考(用户明确要求):写 RTL 照它,验证拿它当 golden 来源与参考模型。
// 仿真与比对合成 verif 之后,这两处落点没变,只是"测试平台"与"比对"归了同一篇。
const prototypeText = stepText(2);
check(/原型/u.test(prototypeText), "第三步讲了 Python 原型");
check(
  ["RTL", "验证"].every((word) => prototypeText.includes(word)),
  "第三步写明原型是 RTL / 验证共同的参考(参考模型与 golden 的来源)"
);
for (const downstream of ["fpga-module-verif"]) {
  check(
    /原型/u.test(readSkillBundle(downstream)),
    `${downstream} 去到 spec 里的原型拿参考(不然这条参考链是断的)`
  );
}

// ── 环节契约(用户定过的形态) ──────────────────────────────────────────────
//
// 模块级就是四个环节:**规格(讨论)→ RTL(编写)→ 验证(跑出数据 + 独立比对)→ 综合(门禁 + 综合后时序)**。
// 仿真与比对合成一个环节(用户口径 2026-09-19):测试平台只负责把数据跑出来,判"对不对"要拿独立
// 参照比 —— 劈成两半会让人以为"仿真跑绿了"就等于"对了"。骨架里因此没有 sim/。
// 这里钉死名字与顺序,防止以后漂回 lint/comp/timing 那套旧名,或又冒出一个"审核环节"。
const scaffoldSource = readFileSync(join(presetDir, "tools", "setup-scaffold.mjs"), "utf8");
const scaffoldStages = JSON.parse(/MODULE_STAGES = (\[[^\]]*\])/u.exec(scaffoldSource)[1]);
check(
  scaffoldStages.join(",") === "spec,rtl,verif,synth",
  `模块级环节固定为 spec,rtl,verif,synth(实际 ${scaffoldStages.join("、")})`
);
check(!scaffoldStages.includes("lint"), "骨架不建 lint/ 目录(机械检查报告跟 RTL 放一起)");
check(!scaffoldStages.includes("timing"), "模块级不单设 timing/ 目录(综合后时序归综合环节)");
check(!scaffoldStages.includes("review"), "骨架不建 review/ 目录(审查是按需能力,不占目录)");
check(!scaffoldStages.includes("sim"), "骨架不建 sim/ 目录(仿真与比对合成 verif/,测试平台不再单占一个目录)");
check(
  /rtl\/lint\.md/u.test(readSkillBundle("fpga-module-rtl")),
  "机械检查报告写在 rtl/lint.md"
);
// 综合环节要同时管门禁与时序(用户口径);验证环节的产物落 verif/
const synthSkillText = readSkillBundle("fpga-module-synth");
check(
  /综合门禁/.test(synthSkillText) && /时序/.test(synthSkillText),
  "综合环节同时管综合门禁与综合后时序"
);
const verifSkillText = readSkillBundle("fpga-module-verif");
check(
  /<模块根>\/verif\/verif\.md/u.test(verifSkillText),
  "验证报告写在 verif/verif.md"
);
// 验证环节现在是"跑出来 + 比对"两件事:缺了哪一半这条断言都会红
check(
  /测试平台/.test(verifSkillText) && /参考模型|golden/.test(verifSkillText) && /比对/.test(verifSkillText),
  "验证技能同时管测试平台(跑出数据)与独立比对(判对不对)"
);
check(
  /归属/.test(verifSkillText) && /找用户|请用户/.test(verifSkillText),
  "验证技能写明:不一致时自己判归属(RTL / 测试平台 / 模型),判不了找用户"
);
// 旧布局的残留:sim/ 已并入 verif/,检查器与技能里都不该再从 sim/ 找测试平台
check(
  !/(^|[^a-z])sim\//u.test(readFileSync(join(presetDir, "tools", "module", "module-rtl-check.mjs"), "utf8")),
  "module-rtl-check 里没有 sim/ 残留(测试平台现在在 verif/ 下找)"
);
// 文件名跟着设置里选的语言走:TB 的扩展名不能写死 .sv(选 VHDL 就是 .vhd),
// 而 VHDL 本检查器不覆盖 —— 必须说清"记 NOT_APPLICABLE",不能静默当通过
check(/仿真语言/u.test(verifSkillText) && /\.vhd/u.test(verifSkillText), "验证技能写明 TB 扩展名跟仿真语言走(含 .vhd)");
// ModelSim 的跑法:run -all / quit -f 是仿真器命令,得放进 .do 再一次调用(-c -do run.do)。
// 判据升级(2026-09-20 实测):裸 vsim 的退出码不可信($fatal 之后仍是 0),所以 run.do 模板里的
// **run-level gate** 把日志条目变成退出码 —— 技能必须同时写明这两件事,不许退回"只看日志/只看退出码"。
check(
  /-c -do/u.test(verifSkillText) && /run -all/u.test(verifSkillText),
  "验证技能给出 ModelSim 的一次调用形态(把 run -all/quit 放进 .do,再 -c -do 跑)"
);
check(
  /vdel[\s\S]{0,80}(catch|判|先判|file exists)/u.test(verifSkillText),
  "验证技能写明 vdel 要防住'没有 work 库时报错中止脚本'"
);
check(
  /退出码[\s\S]{0,60}(仍是 0|不是 0|看日志)/u.test(verifSkillText),
  "验证技能写明:裸 vsim 的退出码不可信($fatal 之后仍是 0)"
);
check(
  /gate[\s\S]{0,80}退出码|退出码[\s\S]{0,80}gate/u.test(verifSkillText),
  "验证技能写明:退出码由 run.do 的 gate 决定(所以跑 run.do 的退出码才是判据)"
);

// 工程级的系统联仿**不许写死某个仿真器**(用户口径 2026-09-20):设置里本来就有仿真器下拉
// (ModelSim / XSim / 其他 / 不用),会话提示的「已就绪」段已经把选中工具的调用姿势交出来了 ——
// 技能再自己挑一个就是错的。原来这里贴的是 ModelSim 专用跑法(`& "<仿真器路径>" -c -do run.do`):
// 选了 XSim 时那条命令根本跑不起来(XSim 要的是 Vivado bin 目录下的 xvlog/xelab/xsim)。
// 所以钉两条:
//   · 技能必须写明"跑法用设置里选中的那个仿真器走",并把调用姿势指回会话提示的已就绪段;
//   · `vsim` 与 `-c -do` 只许出现在条件语境里(= 写的是 ModelSim/Questa 那一支)。
//     两个方言并列写是允许的(这是脚本格式的差别),把 ModelSim 当成唯一跑法不行。
const syssimText = readSkillBundle("fpga-project-syssim");
check(/跑法用设置里选中的/u.test(syssimText), "syssim 技能写明跑法用设置里选中的那个仿真器(不写死某一个)");
check(
  /已就绪/u.test(syssimText) && /调用姿势/u.test(syssimText),
  "syssim 技能把调用姿势指回会话提示的「已就绪」段(而不是自己拼一条命令)"
);
check(
  /xvlog/u.test(syssimText) && /xelab/u.test(syssimText) && /xsim/u.test(syssimText),
  "syssim 技能写明选了 XSim 用 xvlog / xelab / xsim 那一套"
);
check(
  /(不要|不得|别)[^。\n]{0,12}\.do/u.test(syssimText),
  "syssim 技能写明选了 XSim 不要跑 .do(ModelSim 的方言)"
);
// 条件语境的判定照上面 program_hw_devices -verify 那条:命中该写法的行必须带条件词 ——
// 没有条件词就是把某个仿真器的跑法当成了唯一做法。
const hardcodedSim = syssimText
  .split("\n")
  .filter((line) => /vsim|-c -do/u.test(line))
  .filter((line) => !/ModelSim|Questa|选中|XSim|已就绪/u.test(line));
check(
  hardcodedSim.length === 0,
  `syssim 技能没有把 ModelSim 的跑法写成唯一做法(无条件行:${hardcodedSim.join(" / ") || "无"})`
);

// TB 落点是 `verif/tb_<snake>`(stamp.mjs 的 defaultDestination 把驼峰转下划线,UartRx → tb_uart_rx,
// check-fpga-tools 也在断言这一点)。技能里曾写成 `tb_<模块名>`,照着找会找错文件。
check(
  /verif\/tb_<snake>/u.test(verifSkillText) && /--out/u.test(verifSkillText),
  "验证技能写明 TB 落在 verif/tb_<snake>.sv(模块名转下划线),且可用 --out 另指定"
);
check(
  /verif-new\.mjs/u.test(verifSkillText),
  "验证技能写明用 module-verif-new.mjs 起测试平台(命令名与环节名一致)"
);
// 用户明确要求过:说"要看波形"时必须真有手段 —— 手段是**用已经确认过的 run.do 起 GUI**,
// 不是自己另编一套编译/顶层/仿真器流程(那条会替 AI 拍板的脚本已删)。同时要点明反面:
// 不要在环节目录里直接开 GUI 加载设计 —— TB 在时刻 0 就把 dump 文件清零了。
check(
  /run\.do[\s\S]{0,40}GUI/u.test(verifSkillText) && /波形/u.test(verifSkillText),
  "验证技能写明看波形的手段(用已经确认过的 run.do 起 GUI)"
);
check(
  /不要在[\s\S]{0,40}加载设计/u.test(verifSkillText),
  "验证技能写明:不要在 verif/ 里直接开 GUI 加载设计(dump 文件会被清零)"
);
// 验证**不只有文件 golden 一种**(审查指出,2026-09-19):FIFO / UART / 握手这类常靠独立
// scoreboard、断言与协议检查。技能要把这些手段列全,同时守住独立性底线。
check(
  /scoreboard/u.test(verifSkillText) && /协议检查/u.test(verifSkillText),
  "验证技能列出文件比对之外的手段(独立 scoreboard / 协议检查等)"
);
check(
  /没有 golden 但有[\s\S]{0,60}不是不适用/u.test(verifSkillText),
  "验证技能写明:没有 golden 不等于本环节不适用(两者都拿不出来才算)"
);
// F-07(第二轮复审):光说"没有手段也不算不适用"不够 —— 得说清"那算什么"。拿不出判据/手段是
// UNVERIFIED,N/A 只留给"本来就不适用(有设计依据)"。旧文案"两者都拿不出来才算 N/A"读起来像
// 把"没法验"记成 N/A,与状态表那行直接打架,所以连旧写法一起钉住。
// 断言要**分两处**钉(开头引子 + 判据那条):只查全文的话,状态表自己那句"有明确的设计依据说明
// 确实不适用"会把断言喂饱 —— 判据那条仍然可以继续跟表打架。
const verifIntro = verifSkillText.split("\n## ")[0];
check(
  /拿不出(判据|手段)[\s\S]{0,40}UNVERIFIED/u.test(verifIntro) &&
    /确实(本来就不适用|不适用)[\s\S]{0,40}设计依据|设计依据[\s\S]{0,40}确实不适用/u.test(verifIntro),
  "验证技能开头把 N/A 与'拿不出手段'分开(有设计依据才记 N/A,拿不出判据记 UNVERIFIED)"
);
const naBullet = /- `NOT_APPLICABLE`:([\s\S]*?)(?=\r?\n\r?\n)/u.exec(verifSkillText)?.[1] ?? "";
check(naBullet !== "", "验证技能的判据节能定位到 NOT_APPLICABLE 那一条");
check(
  /拿不出(判据|手段)[\s\S]{0,60}(UNVERIFIED|不是 ?N\/A)/u.test(naBullet) &&
    /设计依据[\s\S]{0,40}确实不适用|确实不适用[\s\S]{0,40}设计依据/u.test(naBullet),
  "NOT_APPLICABLE 那一条与状态表同口径(有设计依据才记 N/A,拿不出手段记 UNVERIFIED)"
);
check(
  !/都拿不出来[\s\S]{0,40}才算/u.test(verifSkillText),
  "验证技能没有留下旧的'两种手段都拿不出来才算 N/A'口径"
);
// 比对口径上确实拿不准时(读不出样本 / 容差 / golden 来路)要**回去问用户**,
// 不许自己改比对口径把结论凑过去 —— 判据一松,后面所有结论都不作数。
check(
  /无法判定[\s\S]{0,30}问用户|拿不准[\s\S]{0,40}问用户/u.test(verifSkillText),
  "验证技能写明:自己无法判定时回去问用户"
);
check(
  /(不得|不许|不要)[\s\S]{0,20}(自行|自己)?改比对口径/u.test(verifSkillText),
  "验证技能写明:不得自行改比对口径(判据一松,后续结论都不作数)"
);
check(
  /格式对不上|容差/u.test(verifSkillText) && /golden[\s\S]{0,30}(来路|版本)/u.test(verifSkillText),
  "验证技能点名要问用户的比对问题(格式读不出 / 容差 / golden 来路)"
);
// 用户口径(2026-09-19):**格式对不上不等于数据错** —— 只是写法不同(进制 / 大小写 / 分隔符)、
// 取值等价就是功能正确,不许在格式上反复纠缠;同时不许拿"只是格式问题"当借口跳过实际比对。
check(
  /格式对不上不代表数据错|写法不同[\s\S]{0,20}取值等价|取值等价[\s\S]{0,20}算/.test(verifSkillText),
  "验证技能写明:格式对不上不等于数据错(取值等价就算功能正确)"
);
check(
  /必须实际比过再放过|必须实际比过/u.test(verifSkillText),
  "验证技能写明:说'只是格式问题'之前必须真的转成同一口径比过"
);
check(
  /取值真的不同才算 FAIL|取值[\s\S]{0,10}不同才算 FAIL/u.test(verifSkillText),
  "验证技能写明:只有取值真的不同才算 FAIL(位宽/字节序导致数值变了属功能问题)"
);
// 金标 CRLF、输出 LF → 逐字节比会"每行都不一致",一个排版差异冒充功能失败(实测踩过)。
// 所以技能必须写明"先归一化再比"+"格式差异不单独判 FAIL",两条缺一不可。
check(
  /CRLF[\s\S]{0,60}LF/u.test(verifSkillText) && /格式差异[\s\S]{0,20}永不单独/u.test(verifSkillText),
  "验证技能写明:比对前先归一化行尾(CRLF/LF)/空白/大小写,格式差异不单独判 FAIL"
);

check(
  /VHDL/u.test(readSkillBundle("fpga-module-rtl")),
  "检查技能写明 VHDL 源码不覆盖(记 NOT_APPLICABLE)"
);
// 判定词是给"接手的人"读的,所以文件里宣称的判定词集合必须真的覆盖所有会出现的结论 ——
// sim 曾经自相矛盾:正文说"没有测试平台 ≠ 不适用",判据那行却写着 NOT_APPLICABLE。
const VERDICTS = /PASS|FAIL|BLOCKED|NOT_APPLICABLE|UNVERIFIED|APPROVED|CHANGES_REQUESTED/gu;
const verdictWords = (text) => [...text.matchAll(VERDICTS)].map((m) => m[0]);
// 每个技能的判定词集合是**自己的**口径:审查用 approved/changes requested/blocked,
// 环节报告用 PASS/FAIL/BLOCKED/NOT_APPLICABLE/UNVERIFIED。审查正文里提到下游的 FAIL
// (说某个环节挂 FAIL)不算它的判定词,所以按技能限定可用的词,而不是全文搜大写词。
const VERDICT_SETS = {
  "fpga-module-rtl": ["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"],
  "fpga-module-synth": ["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"],
  "fpga-module-verif": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  // 工程级各篇环节报告都用同一套五个词
  "fpga-project-spec": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-integrate": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-constraints": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-syssim": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-impl": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-timing": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-board": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-release": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-rtl": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-lint": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-project-synth": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
};
for (const [skill, allowed] of Object.entries(VERDICT_SETS)) {
  const text = readSkillBundle(skill);
  // 取的是"把判定词列得最全"的那一处:大多数写成 `结论(PASS / FAIL / …)`,
  // rtl/review 写成 `- **结论**:`PASS` / `FAIL` / …`。
  // **不能取"第一个含 ≥2 个词的候选"** —— 正文里解释某两个词的句子(PASS/BLOCKED、UNVERIFIED
  // 之类)会排在产物行前面,一取就取错(实测踩过:integrate 新加一句解释后守卫误报)。
  // 所以扫全部匹配、取词数最多的那一段;并列时取靠后的(产物节在后面)。
  const candidates = [...text.matchAll(/结论[^\n]*?(?:\(([^)]*)\)|:((?:[^`\n]*`[^`]+`[^\n]*)+))/gu)].map(
    (m) => m[1] ?? m[2] ?? ""
  );
  let listed = [];
  for (const line of candidates) {
    const words = verdictWords(line);
    if (words.length >= listed.length && words.length > 1) listed = words;
  }
  check(listed.length > 0, `${skill} 的结论行列出了判定词(实际:${listed.join(" / ") || "无"})`);
  const used = allowed.filter((word) => text.includes(word));
  const missing = used.filter((word) => !listed.includes(word));
  check(missing.length === 0, `${skill} 的结论行没有漏掉它用到的判定词(漏:${missing.join("、") || "无"})`);
  const extra = listed.filter((word) => !allowed.includes(word));
  check(extra.length === 0, `${skill} 的结论行只用自己的判定词(多出:${extra.join("、") || "无"})`);
}
// 工程级**每篇都要有自己的判定词清单**(审计那一篇 2026-09-19 按用户口径删掉了:验证已经覆盖它)
for (const skill of skillNames.filter((name) => name.startsWith("fpga-project-"))) {
  const text = readSkillBundle(skill);
  check(/结论\(`PASS`/u.test(text), `${skill} 的产物写明了结论取值`);
}
// 集成时"模块从哪来"也要先问用户(与 rtl 的现成子模块同一条口径):用户已有一律直接用,
// 不要集成时自己另写一个顶上 —— 那样模块自己那边的结论就对不上了。
const integrateText = readSkillBundle("fpga-project-integrate");
check(
  /模块从哪来|模块来源/u.test(integrateText) &&
    /停止并报告/u.test(integrateText) &&
    /(不要|不得)[\s\S]{0,24}(自己)?另写一个顶上/u.test(integrateText),
  "集成技能写明:可复用模块缺失时停止并报告,不在集成时另写替代品"
);
// 验证环节的"没有测试平台"必须记 UNVERIFIED/NOT_APPLICABLE 二选一里正确的那一个:
// 用户口径是"要验证功能却没平台 = 未验证",只有本来就无可验证行为的模块才算不适用。
check(
  /没有测试平台[\s\S]{0,40}(UNVERIFIED|BLOCKED)/u.test(verifSkillText),
  "验证技能写明:没有测试平台记 UNVERIFIED/BLOCKED,不是 NOT_APPLICABLE"
);
// 已删除的能力不许在文案里复活:stage-status 是用户明确去掉的(记录进度意义不大),
// 但"自带的汇总命令"这类说法会留在技能与提示词里,读了会去找一个不存在的命令。
// agent.cordis.yml 是预设的组装,预设被复制到用户预设目录后它才生效 —— 里面的文案同样要查。
const shippedTexts = [
  ["README.md", readFileSync(join(ROOT, "README.md"), "utf8")],
  ["agent.cordis.yml", readFileSync(join(presetDir, "agent.cordis.yml"), "utf8")],
  ...skillNames.map((skill) => [`${skill}/SKILL.md`, readSkillBundle(skill)]),
];
for (const [name, text] of shippedTexts) {
  const dead = ["stage-status", "汇总命令"].filter((word) => text.includes(word));
  check(dead.length === 0, `${name} 没有引用已删除的进度汇总命令(实际:${dead.join("、") || "无"})`);
}
// 节奏按用户的习惯:写完再统一检查(边写边跑效率低);只保留"排查具体报错时可单查"这个例外。
//
// 断言不能只看"写完…检查"这几个字:那句话原先写在开头的引子里,读者(和人设)读到"一次跑全量"
// 时还不知道**跑什么** —— 真正的命令在两步之后。用户指出过这一点,所以钉两件事:
//   · 有一节专讲"跑哪些命令、什么时候跑";
//   · 那一节里同时出现"写完之后"与两条命令(run 名),即命令在"跑什么"这一节里被点名。
const lintText = readSkillBundle("fpga-module-rtl");
check(
  /写完[\s\S]{0,16}检查/u.test(lintText) && !/随时可跑/u.test(lintText),
  "检查技能按用户节奏:写完再统一检查(不是'随时可跑'/'边写边跑')"
);
const runSection = /## 本环节要跑的命令([\s\S]*?)(?=\n## )/u.exec(lintText)?.[1] ?? "";
check(runSection !== "", "检查技能有一节专讲『本环节要跑的命令』(命令与时机写在一起)");
check(
  /写完之后|三步都写完之后/u.test(runSection) && /module-rtl-check\.mjs/u.test(runSection),
  "那一节里同时写明时机(写完之后)与要跑的命令(`module-rtl-check.mjs`),不是只提'跑全量'"
);
check(
  // 2026-10-28：lint 从「直接敲 verilator --lint-only」改成走封装命令
  // `module-rtl-lint.mjs`（Windows 上 Verilator 是 msys2 包，必须经 bash 驱动）。
  // 判据不变：这一节要点名那条具体命令，不能只说「跑检查」。
  /module-rtl-lint\.mjs|--lint-only/u.test(runSection),
  "那一节里也点名 lint 那条命令(不是只说'跑检查')"
);
const checkRtlText = readFileSync(join(presetDir, "tools", "module", "module-rtl-check.mjs"), "utf8");
// TB 扩展名判据现在在共享 driver 里(TESTBENCH),VHDL 那句交代仍在入口 —— 两边都算,才算这条不变式。
const rtlDriverEntry = readFileSync(join(presetDir, "tools", "lib", "rtl-check-driver.mjs"), "utf8");
check(
  /\(sv\|v\)/u.test(rtlDriverEntry) && /VHDL/u.test(checkRtlText) && /TESTBENCH/u.test(checkRtlText),
  "module-rtl-check 认 .v 的 TB(判据在共享 driver 里,入口确实引用),并对 VHDL 有明确交代"
);
// 外来代码(厂商 IP / 他人模块)不按本模块规范检查:检查器要跳过 ip/,技能里也要写明这一点。
// SKIP_DIRS 自 2026-09-25 起与 project-rtl-check 共用一份(tools/lib/rtl-check-driver.mjs),
// 所以这条断言要**两个文件都看**:入口确实用了共享 driver,且 driver 的清单里有 ip/。
// 为什么加 `?? ""`:形状断言落空时要**报 FAIL**,不是让脚本崩在 `.exec(...)[0]` 上。
const rtlDriverText = readFileSync(join(presetDir, "tools", "lib", "rtl-check-driver.mjs"), "utf8");
const skipDirsBlock = /const SKIP_DIRS = new Set\(\[[\s\S]*?\]\)/u.exec(rtlDriverText)?.[0] ?? "";
check(
  /"ip"/u.test(skipDirsBlock) && /from "\.\.\/lib\/rtl-check-driver\.mjs"/u.test(checkRtlText),
  "两个 RTL 检查器跳过 ip/ 目录(SKIP_DIRS 在共享 driver 里,两个入口都从那里 import)"
);
check(/rtl\/ip\//u.test(lintText), "检查技能写明外来代码放 rtl/ip/,检查会跳过");
// IP 流程(用户要求):用到 IP 先问用户"自建还是他提供";生成/拿到后按用途归位 ——
// 仿真文件 → verif/,RTL 与综合用的部分(含 .xci)→ rtl/ip/
// 断言用"问用户 + 生成/提供"这组语义,不钉具体措辞:文案会随精炼改词(如"不要"→"不得")
check(
  /问用户/u.test(lintText) && /(由本环节生成|自己生成|你生成)/u.test(lintText),
  "rtl 技能写明:用到 IP 核先问用户是自建还是他提供"
);
check(
  /rtl\/ip\//u.test(lintText) && /仿真用的文件|仿真模型/u.test(lintText),
  "rtl 技能写明 IP 的归位规则(实体与 .xci → rtl/ip/,仿真模型 → verif/)"
);
// IP 的**选型顺序**(用户口径 2026-09-21):能用厂商原语 / XPM 参数化宏表达的就不用 IP 向导生成,
// 更不在图形界面上点 —— 原语就是 HDL(可读、可 lint、可移植),`.xci` 是界面产物(改不动、跨版本
// 搬不走,还多一个"器件不同族到综合才炸"的坑)。顺序是"自己写 → 原语/XPM → 确实没有等价原语才引 IP",
// 所以优先那档与例外那档都要钉住,免得被改成"一律不许用 IP"或退回"随便点一个 IP"。
check(
  /原语/u.test(lintText) && /XPM|参数化宏/u.test(lintText),
  "rtl 技能的 IP 选型顺序里点出厂商原语与 XPM 参数化宏"
);
check(
  /优先[\s\S]{0,40}(原语|XPM)/u.test(lintText) &&
    /(不用|减少|避免|不许)[\s\S]{0,30}(IP 向导|图形界面|界面)/u.test(lintText),
  "rtl 技能写明:能用原语 / XPM 就不用 IP 向导,不在图形界面上点"
);
check(
  /没有等价原语/u.test(lintText) && /硬核/u.test(lintText),
  "rtl 技能写明例外:确实没有等价原语的(硬核 / 复杂协议)才用厂商 IP(不是一律禁用)"
);
// 工程级 IP 策略也要同一口径,但不另立一套:指回 rtl 技能那节(同"判定词指向唯一状态表"的做法)
check(
  /XPM|原语/u.test(projectSpec) && /fpga-module-rtl/u.test(projectSpec),
  "工程级 IP 策略写明同一口径,并把判据指回 rtl 技能那节"
);
// 生成 IP 那一步也要把器件钉住(**根因**,不只靠事后预检):2026-09-21 实测 `create_ip` **不接受**
// `-part`(Vivado 2025.2 报 Unknown option),器件来自**工程的 part** —— 所以技能必须写明"先
// create_project -part <spec 里的器件>",以及"IP 生成后器件写死在 .xci 里,换器件要重新 generate_target"。
check(
  /create_ip[\s\S]{0,200}?不接受[\s\S]{0,80}?-part/u.test(lintText) &&
    /create_project[\s\S]{0,60}-part[\s\S]{0,60}spec/u.test(lintText),
  "rtl 技能写明:create_ip 不接受 -part(器件是工程的 part,来自 spec)"
);
check(
  /generate_target/u.test(lintText) &&
    /(换器件|改器件)[\s\S]{0,60}(重新|重跑)[\s\S]{0,30}generate_target/u.test(lintText),
  "rtl 技能写明换器件必须重新生成 IP(器件写死在 .xci 里)"
);
// IP 时序卡:作者**实际在用**的约定(2026-09-21 照他工程里 rtl/ip/<ip>/{timing.json,README.md,
// probe_*.*,*_stub.v} 的样子落进技能)—— 每个 IP 目录一张卡,写**实测**出来的时序前提;只认测到的。
check(
  /timing\.json/u.test(lintText) && /rtl\/ip\//u.test(lintText) && /实测/u.test(lintText),
  "rtl 技能写明 IP 时序卡(rtl/ip/<ip>/timing.json,只写实测到的)"
);
check(
  /timing\.json/u.test(rtlDriverText) && /IP 卡/u.test(rtlDriverText) && /ipCardEntries/u.test(checkRtlText),
  "module-rtl-check 检查每个 rtl/ip/<ip>/ 的 timing.json(缺卡/解析不了 → 警告;判据在共享 driver 里,入口确实调用)"
);
// 端口方向与类型(用户 2026-09-21 定):input wire / output logic / inout tri;内部信号 logic,
// 只有"实例之间的连接网"用 wire;函数 / 任务形参不受限。断言钉在"方向 + 类型 + 例外"三件一起。
check(
  /input\*\*[\s\S]{0,40}wire/u.test(lintText) && /output\*\*[\s\S]{0,40}logic/u.test(lintText),
  "rtl 技能写明:模块 input 用 wire、output 用 logic"
);
check(
  /内部信号\*\*[\s\S]{0,30}logic/u.test(lintText) && /实例与实例之间的连接网/u.test(lintText),
  "rtl 技能写明:内部信号用 logic,只有实例之间的连接网用 wire"
);
check(
  /函数 \/ 任务的形参不受/u.test(lintText),
  "rtl 技能写明例外:函数 / 任务的形参不按端口类型判"
);
// 字面量(用户 2026-09-21 定):禁止 `'0` 这种不带宽度的填充写法;都要写 `N'基值`;
// 信号类统一 `'b`、数据类统一 `'h`。机械检查只查"带没带宽度与基"。
check(
  /禁止 `'0`/u.test(lintText) && /信号类[\s\S]{0,40}`'b`/u.test(lintText) && /数据类[\s\S]{0,40}`'h`/u.test(lintText),
  "rtl 技能写明字面量口径:禁止 `'0`;信号类用 `'b`、数据类用 `'h`"
);
check(
  /只查"带没带"宽度与基|判不了这个信号是数据类还是信号类/u.test(lintText),
  "rtl 技能写明:机械检查只查有没有带宽度与基(数据/信号靠读代码判)"
);
// 信号名后缀口径(用户 2026-10-10 更新):`_r` = 单个(控制)信号的打拍 / `_d` = 数据信号的打拍 ——
// 两者**只能加在寄存器上**;`_c` / `_v` 不用。旧口径(`_d` = 组合侧的数据类)已被推翻:M04/M06 按旧
// 口径改名当场撞名(`Duplicate declaration`),所以这里钉的是新口径。断言仍钉"后缀 + 含义 + 例子"
// 三件一起,而不是挑关键词 —— 否则注释里出现过这几个词就能把断言喂饱(这类教训本仓库已经踩过)。
check(
  /`_r`[\s\S]{0,80}单个[\s\S]{0,40}打拍/u.test(lintText) && /tvalid_r|tlast_r/u.test(lintText),
  "rtl 技能写明 `_r` = 单个(控制)信号的打拍(带 `tvalid_r` / `tlast_r` 这种例子)"
);
check(
  /`_d`[\s\S]{0,60}数据类[\s\S]{0,30}打拍/u.test(lintText) && /crc_d|da_captured_d/u.test(lintText),
  "rtl 技能写明 `_d` = 数据类信号的打拍(带 `crc_d` / `da_captured_d` 这种例子)"
);
check(
  /`_r`\s*\/\s*`_d`[\s\S]{0,80}只能加在寄存器上/u.test(lintText),
  "rtl 技能写明 `_r` / `_d` 都是打拍、只能加在寄存器上(组合信号不许加)"
);
// 多级打拍与"严禁随意加后缀"(用户 2026-10-10 的加严口径):多级写 `_rr` / `_dd` 或并成多位宽;
// 没有必要的后缀一律不加 —— 这两条把"随手加后缀"这条老毛病钉死。
check(
  /多级打拍[\s\S]{0,60}`_rr`[\s\S]{0,20}`_dd`/u.test(lintText) && /多位宽/u.test(lintText),
  "rtl 技能写明多级打拍用 `_rr` / `_dd`(或并成多位宽形式)"
);
check(
  /严禁加后缀/u.test(lintText) && /精准而简练/u.test(lintText),
  "rtl 技能写明:命名精准简练,没有必要严禁加后缀、严禁另造后缀形式"
);
// 写法总纲(用户 2026-10-10):一切编写格式以时序最优为先 —— 格式与时序冲突时格式让步;
// 组合逻辑尽量用 `assign` 而不是 `always_comb`,前提是时序不退化。
check(
  /一切编写格式以时序最优为先/u.test(lintText) && /让格式让步/u.test(lintText),
  "rtl 技能写明总纲:一切编写格式以时序最优为先(与时序冲突时格式让步)"
);
check(
  /尽量用 `assign` 而不是 `always_comb`/u.test(lintText) && /时序不退化/u.test(lintText),
  "rtl 技能写明组合逻辑尽量用 `assign` 而不是 `always_comb`(前提是时序不退化)"
);
// 注释与声明区形制(用户 2026-10-10):每个块一条块首注释;声明区先寄存器后组合、按功能分组。
check(
  /每个 `always` \/ `always_ff` \/ `always_comb` \/ `initial` 块有且仅有一条块首注释/u.test(lintText),
  "rtl 技能写明:每个 always / always_ff / always_comb / initial 块有且仅有一条块首注释"
);
check(
  /先寄存器、后组合/u.test(lintText) &&
    /`\/\/--- 组名 ---`/u.test(lintText) &&
    /新增信号归到对应的组里/u.test(lintText),
  "rtl 技能写明声明区位置与分组:先寄存器后组合、一组一条 `//--- 组名 ---`、新增信号归组"
);
check(
  /`_c`\s*\/\s*`_v`[\s\S]{0,40}不用/u.test(lintText) &&
    /不看后缀猜/u.test(lintText) &&
    /同名孪生/u.test(lintText),
  "rtl 技能写明 `_c` / `_v` 不用,以及判据:看赋值不看后缀猜、同名孪生取组合朴素名 + 寄存器后缀"
);
// `_q` 与 `_r` 功能重复,按用户口径去掉:新代码不再用,已有代码不动 —— 断言钉住"写明了不再用"
check(
  /`_q`[\s\S]{0,80}(不再用|不用)/u.test(lintText) && /`_r`/u.test(lintText),
  "rtl 技能写明 `_q` 新代码不再用、统一写 `_r`(与 `_r` 功能重复)"
);
check(
  /别自己另造后缀/u.test(lintText) && /_reg/u.test(lintText) && /_ff/u.test(lintText),
  "rtl 技能写明:别自己另造后缀(`_reg` / `_ff` / `_next` 这类)"
);
// 旧口径的第二出处必须清掉:工程级技能只准引用唯一出处,不许再复述后缀含义(否则改一处漏一处)
check(
  !/数据类暂存/u.test(projectRtlScopeText) && !/寄存后的值/u.test(projectRtlScopeText),
  "fpga-project-rtl 不再复述旧后缀口径,只引用 fpga-module-rtl 规范清单那处唯一出处"
);
// Vivado/XSim 统一继承工作区规则的单一策略。不得再保留重定向 APPDATA 的旧配方，
// 否则同一次会话会收到两套相反指令。
const synthSkillForVivadoEnv = readSkillBundle("fpga-module-synth");
check(
  /XILINX_LOCAL_USER_DATA\s*=\s*NO/u.test(synthSkillForVivadoEnv) &&
    !/\$env:APPDATA\s*=/u.test(synthSkillForVivadoEnv),
  "综合技能只保留 XILINX_LOCAL_USER_DATA=NO,不再重定向 APPDATA"
);
const verifSkillText2 = readSkillBundle("fpga-module-verif");
check(
  /XILINX_LOCAL_USER_DATA\s*=\s*NO/u.test(verifSkillText2) &&
    !/\$env:APPDATA\s*=/u.test(verifSkillText2),
  "XSim 配方只保留 XILINX_LOCAL_USER_DATA=NO,不再重定向 APPDATA"
);
// IP 卡的四栏之外,检查器还会查"能不能复核"(N-12):技能里必须写明这几条,不然口径又变成两处
check(
  /非空字符串/u.test(lintText) && /非空对象/u.test(lintText) &&
    /探针\*\*文件要真的在\*\*/u.test(lintText) && /一个实测数值/u.test(lintText),
  "rtl 技能写明 IP 卡的可复核条件(非空字符串/非空 config/探针文件真在/至少一个实测数值)"
);
// XPM 的**仿真侧**要跟上:上面那几条把大家推向 XPM,那 verif 技能就得说清 `-L xpm`,
// 以及"先用 modelsim.ini 里已编好的那份、别重编;真不行才拿原厂源码自编"——
// 否则照着"优先 XPM"改完 RTL,第一次跑仿真就撞上未定义,而技能里只有 unisims 那一档。
const verifText = readSkillBundle("fpga-module-verif");
check(
  /xpm/u.test(verifText) && /-L xpm/u.test(verifText),
  "verif 技能写明 XPM 仿真要 -L xpm(与 unisims 那档同一套做法)"
);
check(
  /(别重编|不要重编|不重编)/u.test(verifText) &&
    /原厂源码|data\/ip\/xpm|compile_simlib/u.test(verifText) &&
    /退路/u.test(verifText),
  "verif 技能写明:先用已编好的那份,原厂源码自编只是退路(不是首选动作)"
);
// 测试平台里写死的延迟/复位拍数必须来自 IP 卡(否则仿真与 RTL 一起错、而仿真还是绿的)
check(
  /timing\.json/u.test(verifText) && /(延迟|拍数)/u.test(verifText),
  "verif 技能写明:测试平台里的延迟/拍数照 IP 卡来,不凭印象"
);
// 证据路径校验(用户认可的"AC 证据位置"那件):verif 技能要求在写 PASS 前跑它,review 技能把它
// 收进审查清单 —— 少了它,"报告指着已退役 IP / 还没生成的文件"就没人管。
check(
  /module-report-check\.mjs/u.test(verifText) && /只验路径存在/u.test(verifText),
  "verif 技能写明:写 PASS 前跑 module-report-check(只验证据路径存在,不判内容)"
);
check(
  /摘要/u.test(verifText) && /--record/u.test(verifText),
  "verif 技能写明:检查也看「依据的摘要变没变」,以及 --record 怎么记"
);
// 一个文件写不下就拆子模块(用户 2026-09-19 指出原来缺这条):要写明**什么时候拆**
// (一个文件写不完整块逻辑就拆),而且**判据是功能、不是代码行数**(用户当场点明),
// 以及要用现成的子模块时先问用户"他提供还是本环节写" —— 与 IP 那条同一套问法。
// 只断言"拆"不够:曾经只有"拆了之后放哪",没有触发条件。
const splitSection = /### 一个模块拆多个文件时([\s\S]*?)\n### /u.exec(lintText)?.[1] ?? "";
check(splitSection !== "", "rtl 技能有「一个模块拆多个文件时」一节");
check(
  /什么时候拆/u.test(splitSection) && /写不完整块逻辑/u.test(splitSection),
  "那一节写明拆子模块的触发条件(一个文件写不完整块逻辑就拆)"
);
check(
  /判据是功能|按功能|依据是功能/u.test(splitSection) && !/行数[\s\S]{0,12}(就拆|作为判据)/u.test(splitSection),
  "那一节的判据写在功能上,不是代码行数"
);
check(
  /子模块[\s\S]{0,80}先问用户|先问用户[\s\S]{0,80}子模块/u.test(splitSection) &&
    /(用户提供|你提供|你来提供)/u.test(splitSection),
  "那一节写明:要用现成的子模块,先问用户是他提供还是由本环节写"
);
// 起文件靠复制模板,不靠手抄:脚本只替模块名,内容原样保留(用户定的口径)
check(
  /module-rtl-new\.mjs/u.test(lintText) && /只替模块名/u.test(lintText),
  "rtl 技能写明用 module-rtl-new.mjs 复制模板,且只替模块名"
);
// 路径口径统一:IP 实体写 rtl/ip/、仿真模型写 verif/ —— 不许再出现裸的 `ip/` 路径
const bareIp = moduleSkills.filter((skill) => /`ip\//u.test(readSkillBundle(skill)));
check(bareIp.length === 0, `模块技能里没有裸的 \`ip/\` 路径(应写 rtl/ip/ 或 verif/;实际 ${bareIp.join("、") || "无"})`);
// 技能里写的命令**名字必须自带级别前缀**(module- / project-),两级共用的不加 ——
// 用户口径:靠名字防误用,而不是靠路径(只抄命令、没抄路径时也抄不错)。
const moduleTools = readdirSync(join(presetDir, "tools", "module"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
  .map((entry) => entry.name);
const projectTools = readdirSync(join(presetDir, "tools", "project"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
  .map((entry) => entry.name);
const knownTools = new Set([...moduleTools, ...projectTools, "setup-scaffold.mjs"]);
const levelProblems = [];
for (const skill of skillNames) {
  const text = readSkillBundle(skill);
  for (const match of text.matchAll(/自带命令目录>\\(?:(module|project)\\)?([a-z-]+\.mjs)/gu)) {
    const [, dir, file] = match;
    if (!knownTools.has(file)) {
      levelProblems.push(`${skill}:${file}(未登记)`);
      continue;
    }
    const isShared = file === "setup-scaffold.mjs";
    if (isShared && dir !== undefined) {
      levelProblems.push(`${skill}:${file}(两级共用的不该放进级别目录)`);
      continue;
    }
    if (!isShared) {
      // 名字带级别前缀 ⇔ 目录也是那一级:两处都要对
      const level = file.split("-")[0];
      if (dir !== level) levelProblems.push(`${skill}:${file}(写在 ${dir ?? "顶层"},应在 ${level}/)`);
      if (!/^(module|project)-/u.test(file)) levelProblems.push(`${skill}:${file}(名字没带级别前缀)`);
    }
  }
}
check(
  levelProblems.length === 0,
  `技能里的命令都带对级别前缀与目录(问题:${levelProblems.join("、") || "无"})`
);
// 三个"跑命令"的模块级环节(rtl / verif / synth)结构一致:都要有「前置」与
// 「本环节要跑的命令」两节 —— 用命令的人该在同一处找得到,而不是满篇翻。
for (const skill of ["fpga-module-rtl", "fpga-module-verif", "fpga-module-synth"]) {
  const text = readSkillBundle(skill);
  check(/^## 前置$/mu.test(text), `${skill} 有「前置」一节`);
  check(/^## 本环节要跑的命令$/mu.test(text), `${skill} 把要跑的命令集中成一节`);
}
// 第一步必须是"用模板生成文件再编写"(用户要求):先落模板骨架,再填逻辑
check(
  /第一步:用模板生成文件/u.test(lintText) && /第二步:编译器检查/u.test(lintText) && /第三步:逐条核对规范/u.test(lintText),
  "检查技能的三步顺序:用模板编写 → 编译器检查 → 逐条核对规范"
);

//
// 这一条是那份《轻量化优化建议》的核心诉求:技能是按需取用的能力地图,不是必经流水线。
// 口气很容易在以后改文案时长回来,所以钉两条:
// - 提示词里不许出现阶段箭头链(曾经是 `fpga-module-spec → fpga-module-rtl → …`)
// - 提示词必须写明"能力地图 / 不是必经流水线"
const persona = /prefix: \|-([\s\S]*?)\n\n- id: /u.exec(readFileSync(join(presetDir, "agent.cordis.yml"), "utf8"))?.[1] ?? "";
check(persona !== "", "读得到 persona 的 prefix");
check(!/fpga-[a-z-]+ → fpga-[a-z-]+/u.test(persona), "提示词里没有阶段箭头链(技能是能力地图,不是流水线)");
check(/能力地图/u.test(persona), "提示词点明技能是'能力地图'");
check(/不是必经的阶段流水线|不是必经流水线/u.test(persona), "提示词点明不是必经的阶段流水线");
check(/用户当前的问题|用户当前任务/u.test(persona), "提示词把'用户当前的问题'定为本次任务");
// 方案要先画出来确认:这是用户明确要求提高 spec 分量的落点
check(/流程图/u.test(persona) && /确认/u.test(persona), "提示词要求'把实现思路画成图给他确认'");

// 两个 spec 技能都要真的要求画图(不是只在提示词里提一句)
for (const skill of ["fpga-module-spec", "fpga-project-spec"]) {
  const text = readSkillBundle(skill);
  check(/^```mermaid$/mu.test(text), `${skill} 里有**独立的** Mermaid 围栏块(不是只在句子里提了句 mermaid)`);
  check(/流程图|框图/u.test(text), `${skill} 要求把实现思路画出来`);
  // 确认必须与"图"绑在一起(只说"确认"可能是确认别的);措辞不限,断言的是这条关系
  check(
    /图[^。]{0,30}确认|确认[^。]{0,30}图/u.test(text),
    `${skill} 要求画完让用户确认(确认与流程图绑在一起)`
  );
  check(/5~15|5-15|5～15/u.test(text), `${skill} 给了规模上限(图太大反而看不清)`);
}

// ── R-02:"先画图确认 / 先补规格"的门槛按任务风险放宽 ────────────────────────────
//
// 旧口径按"是否新增功能"决定要不要先画图确认 —— 结果是修一个语法错、处理一条 lint 告警,也被要求
// 先补一整套规格、先批准流程图。用户已同意放宽:判据改成**任务风险**(重大架构 / 公共接口 / 跨时钟
// 方案 / 关键数据通路 / 用户可见的算法决策且尚未确定才要先确认图);已有批准方案里的普通实现与
// **局部修复**直接动手,只要求读相关代码与项目约束 + 改完做聚焦验证。
//
// 这几条同时也把 R-09 的"唯一权威"钉住:动手规则只维护在 workspace/AGENTS.fpga.md
// (骨架原样复制为 AGENTS.fpga.md)一处,人设与技能只引用 —— 免得「人设放宽了、技能还强制」。
check(/任务风险/u.test(rulesBody), "工作区规则写明门槛按任务风险判");
// 判据必须写成**否定旧口径**的样子:"按是否新增功能判"这种正向写法才是要防的那条
check(/不是按"是否新增功能"/u.test(rulesBody), "工作区规则写明判据不是'是否新增功能'");
for (const word of ["重大架构", "公共接口", "跨时钟", "关键数据通路", "用户可见"]) {
  check(rulesBody.includes(word), `工作区规则的风险清单里有「${word}」`);
}
check(
  /局部修复[\s\S]{0,100}直接动手/u.test(rulesBody),
  "工作区规则写明局部修复直接动手(不要求先出图 / 先补规格)"
);
check(
  /局部修复[\s\S]{0,200}不要求[\s\S]{0,40}规格/u.test(rulesBody),
  "工作区规则写明局部修复不要求先补一整套规格"
);
check(
  /唯一出处/u.test(rulesBody),
  "工作区规则声明动手规则的唯一出处就是本区块(人设与技能只引用)"
);
check(
  /唯一出处[\s\S]{0,80}工作区规则|工作区规则[\s\S]{0,24}唯一出处/u.test(persona) &&
    /不另立|只引用|不重复/u.test(persona),
  "人设把动手规则指回工作区规则(只引用,不另立一套)"
);
check(!/是否新增功能/u.test(persona), "人设里没有留下旧的'是否新增功能才要确认图'口径");
check(/不是按"有没有新功能"/u.test(persona), "人设同样写明不是按'有没有新功能'判");
check(/任务风险/u.test(persona), "人设与工作区规则同步写明按任务风险判");
// "缺规格文件"与"缺关键决策依据"分开:前者不必然阻塞局部任务,后者影响结果时才问用户
check(
  /缺规格文件[\s\S]{0,20}缺关键决策依据/u.test(rulesBody) && /不阻塞|不必然阻塞/u.test(rulesBody),
  "工作区规则把'缺规格文件'与'缺关键决策依据'分开,并写明前者不必然阻塞"
);
check(
  /缺规格文件[\s\S]{0,80}不阻塞/u.test(lintText) && /关键决策/u.test(lintText),
  "rtl 技能前置同样把这两件事分开(缺文件不阻塞局部任务)"
);
// 复位/事件沿:模板默认可用高有效;已有工程按实际接口与项目约定,要改必须说明并取得确认
check(
  /复位与事件沿[\s\S]{0,80}实际工程/u.test(rulesBody) && /事件沿[\s\S]{0,60}确认/u.test(rulesBody),
  "工作区规则写明复位/事件沿以实际工程为准,要改需说明并确认"
);
check(
  /复位与事件沿[\s\S]{0,140}实际工程/u.test(lintText) && /事件沿[\s\S]{0,60}确认/u.test(lintText),
  "rtl 技能同样写明复位/事件沿以实际工程为准(要改需说明并确认)"
);
// rtl 技能开头就分开两条路径:局部那条**不要求**先建 spec/flow.md、也不要求先批准流程图
check(
  /两条适用路径|两条路径/u.test(lintText) && /新设计|重大变更/u.test(lintText),
  "rtl 技能开头写明两条适用路径(新设计/重大变更 与 局部调查与修复)"
);
check(
  /局部[\s\S]{0,200}?不要求[\s\S]{0,20}flow\.md/u.test(lintText) &&
    /不要求先批准流程图/u.test(lintText),
  "rtl 技能写明局部路径不要求先建 spec/flow.md、也不要求先批准流程图"
);
for (const skill of ["fpga-module-spec", "fpga-module-rtl"]) {
  const text = readSkillBundle(skill);
  check(
    /workspace\/AGENTS\.fpga\.md[^。\n]{0,24}第 2 条|工作区规则第 2 条/u.test(text),
    `${skill} 把'先确认图'的判据指回唯一出处(不自己另立)`
  );
}

// ── R-07:状态语义集中成一张五行表(唯一权威),且"脚本相等 ≠ PASS" ──────────────
//
// `comp.py` 被改成"两边都空 → 0 样本也算相等、退出码 0"之后,agent 侧更容易把"脚本说相等"当成
// 验证通过。所以:定义只留一份,并且明说**零样本 / 脚本判相等只是数据层事实,不是 PASS**。
const STATUS_HEADER = "| 状态 | 含义(唯一权威) |";
check(
  verifSkillText.includes(STATUS_HEADER),
  "验证技能里有状态表(判定词的唯一权威)"
);
const statusRowsMissing = ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"].filter(
  (word) => !new RegExp(`^\\| \`${word}\` \\|`, "mu").test(verifSkillText)
);
check(
  statusRowsMissing.length === 0,
  `状态表是五行 PASS / FAIL / BLOCKED / UNVERIFIED / NOT_APPLICABLE(缺:${statusRowsMissing.join("、") || "无"})`
);
check(/不得用来掩盖/u.test(verifSkillText), "状态表写明 NOT_APPLICABLE 不得用来掩盖'无法验证'");
check(
  /零样本/u.test(verifSkillText) && /脚本[^。\n]{0,40}(≠|不等于)[^。\n]{0,16}PASS/u.test(verifSkillText),
  "验证技能写明:零样本 / 脚本判'相等'不等于验证 PASS"
);
check(
  /充分验证[\s\S]{0,20}证据/u.test(verifSkillText) && /真实不符/u.test(verifSkillText) &&
    /覆盖不足/u.test(verifSkillText) && /无法继续/u.test(verifSkillText),
  "状态表的五条定义都在(PASS 有证据 / FAIL 真实不符 / BLOCKED 无法继续 / UNVERIFIED 覆盖不足)"
);
// 唯一权威:这张表全仓只有一份,其余技能只引用
const tableCopies = skillNames.filter((skill) =>
  readSkillBundle(skill).includes(STATUS_HEADER)
);
check(
  tableCopies.length === 1 && tableCopies[0] === "fpga-module-verif",
  `五行状态表只有一份权威(实际:${tableCopies.join("、") || "无"})`
);
// 每个会写判定词结论的技能都要引这张表(verif 自己是权威,不用引自己)
const verdictRefSkills = Object.keys(VERDICT_SETS).filter((skill) => skill !== "fpga-module-verif");
for (const skill of verdictRefSkills) {
  const text = readSkillBundle(skill);
  check(
    /fpga-module-verif[^。\n]{0,12}状态表|状态表[^。\n]{0,24}唯一权威/u.test(text),
    `${skill} 提到判定词时引用唯一权威状态表(不各自复述定义)`
  );
}
check(/fpga-module-verif[\s\S]{0,30}状态表/u.test(rulesBody), "工作区规则提到判定词时也指向那张状态表");
check(/fpga-module-verif[\s\S]{0,30}状态表/u.test(persona), "人设提到判定词时也指向那张状态表");

// ── F-07 / F-08 / F-09 / F-16(第二轮复审:状态表写对了,别处还有旧文字与它打架)──────
//
// F-07:PASS 的权威定义要写全 —— 独立判据(文件比对,或 scoreboard / 断言 / 定向用例)真的执行过且
// 覆盖充分;走文件比对时样本数 > 0。少写"样本数 > 0",comp.py 那句"两边都空也算相等、退 0"就
// 会被读成通过。
const passBullet = /- `PASS`:([\s\S]*?)\n- `FAIL`:/u.exec(verifSkillText)?.[1] ?? "";
check(passBullet !== "", "验证技能的判据节能定位到 PASS 那一条");
check(
  /独立判据/u.test(passBullet) && /文件比对/u.test(passBullet) && /scoreboard/u.test(passBullet) &&
    /定向用例/u.test(passBullet),
  "PASS 的定义写明独立判据的两种形态(文件比对,或 scoreboard / 断言 / 定向用例)"
);
check(
  /已执行且覆盖充分/u.test(passBullet) && /样本数 ?[>＞] ?0/u.test(passBullet),
  "PASS 的定义写明:独立判据已执行且覆盖充分,走文件比对时样本数 > 0"
);

// F-08:发布的准入与集成的正式验收是同一条口径 —— 上游"都是 PASS,或是有依据的 NOT_APPLICABLE"。
// 旧文案"上游都有结论、而且不是 FAIL"把 BLOCKED / UNVERIFIED 也放进了"有结论",比集成那篇松。
const releaseText2 = readSkillBundle("fpga-project-release");
check(
  /都是 `PASS`[\s\S]{0,40}有依据的 `NOT_APPLICABLE`/u.test(releaseText2),
  "发布技能的前置与集成同口径(上游都是 PASS,或是有依据的 NOT_APPLICABLE)"
);
check(!/不是 FAIL/u.test(releaseText2), "发布技能没有留下旧的'上游不是 FAIL 就行'口径");
check(
  /fpga-project-integrate/u.test(releaseText2),
  "发布技能把这条口径指回集成技能的正式验收(两处不各自解释)"
);

// F-09:技能开头声明了两条路径,正文就得真的分流,B 路径不许再按"新建文件 + 完整规格"叙述。
check(
  /路径 B 跳过[\s\S]{0,20}起文件|跳过第一步的「起文件」/u.test(lintText),
  "rtl 技能写明路径 B 跳过'起文件'这一步"
);
check(
  /仅新建文件时/u.test(lintText),
  "rtl 技能写明'用模板起文件'只在新建文件时适用"
);
check(
  /找不到锚点不阻塞/u.test(lintText),
  "rtl 技能写明:B 路径找不到 .fpga-workbench.json 锚点不阻塞、不作为问用户的理由"
);
const onlyAPath = (lintText.match(/仅路径 A/gu) ?? []).length;
check(
  onlyAPath >= 3,
  `rtl 技能逐条标出 A 路径专属要求(接口照 spec / 路径照 flow / 参数照参考资料;实际标了 ${onlyAPath} 处)`
);
check(
  /`always_ff`[\s\S]{0,40}新代码照模板/u.test(lintText) && /`always_ff`[\s\S]{0,60}已有工程/u.test(lintText),
  "rtl 技能的 always_ff 口径与'已有工程按现有约定'一致(新代码照模板)"
);

// F-16:删除边界要有一句话 —— 第三方工具自管的可再生物由工具自己清理;用户的源码与产物不得由
// 代理主动永久删除;清库/擦除前先取得确认。写在工作区规则(唯一出处)那一块里。
check(
  /第三方工具自管的可再生物[\s\S]{0,40}工具自己清理/u.test(rulesBody) &&
    /用户的源码与产物不得由代理主动永久删除/u.test(rulesBody) &&
    /清库 ?\/ ?擦除[\s\S]{0,20}确认/u.test(rulesBody),
  "工作区规则写明删除边界(工具自管产物归工具清理 / 不得主动永久删除用户源码与产物 / 清库前先确认)"
);

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 预设路径、模式行与自带技能都正确"
);
if (failures.length > 0) process.exitCode = 1;
