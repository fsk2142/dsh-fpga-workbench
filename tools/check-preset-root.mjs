// 校验补丁里的 !!js 预设路径:用真实 loader 的求值器算出来,必须指向真实的预设目录。
//
// 为什么必须机器验:`!!js` 是字符串表达式,写错了不会有类型错误,只会在启动时静默
// 指向不存在的目录 —— 表现是"预设不见了",而你从界面上看不出原因。
//
// 依据(dsh-app-boot/lib/index.js:140):补丁文件被加载时,
//   this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href
// 也就是说 !!js 在**补丁文件所在目录**的上下文里求值。本包把补丁放在包根,
// 所以 'presets/' 就够了(官方示例写 '../presets/' 是因为它的补丁在下一层)。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "C:/Program Files/DSH Desktop/resources/app";

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

const require = createRequire(`${APP}/package.json`);
const yaml = require("js-yaml");
const { evaluate, isJsExpr } = require("@deepseek-ai/cordis-plugin-loader");
const { entryListSchema } = require("@deepseek-ai/cordis-plugin-include");

// 1. 解析补丁
const patchPath = join(ROOT, "cordis.patch.yml");
const rows = yaml.load(readFileSync(patchPath, "utf8"), { schema: entryListSchema });
check(
  Array.isArray(rows) && rows.some((row) => row.id === "agent-presets"),
  `顶层是数组且含 agent-presets 覆盖行(实际 ${Array.isArray(rows) ? `${rows.length} 条` : "非数组"})`
);

// 2. 找到 agent-presets 那条覆盖
const row = rows.find((r) => r.id === "agent-presets");
check(row !== undefined, "补丁里有 agent-presets 覆盖行");
if (row === undefined) {
  process.exitCode = 1;
  process.exit();
}

// 3. 关键:把 config 里的 !!js 求值出来。
//    evaluate 需要 loader ctx;baseUrl 设为补丁文件所在目录,与宿主一致。
const baseUrl = pathToFileURL(`${dirname(patchPath)}/`).href;
const ctx = { baseUrl, loader: {} };
const resolved = {};
for (const [key, value] of Object.entries(row.config)) {
  if (isJsExpr(value)) {
    resolved[key] = evaluate(ctx, value.__jsExpr);
    const prefix = `${key}.path`;
    console.log(`      ${prefix} 由 !!js 求值`);
  } else if (Array.isArray(value)) {
    resolved[key] = value.map((item) => {
      const out = { ...item };
      for (const [k, v] of Object.entries(item)) {
        if (isJsExpr(v)) out[k] = evaluate(ctx, v.__jsExpr);
      }
      return out;
    });
  } else {
    resolved[key] = value;
  }
}

const roots = resolved.roots ?? [];
check(roots.length === 1, `roots 求值后有 1 项(实际 ${roots.length})`);
for (const entry of roots) {
  console.log(`      path = ${String(entry.path)}`);
  check(typeof entry.path === "string" && entry.path.length > 0, "roots 项的 path 是字符串");
  check(existsSync(entry.path), `roots 路径存在(${String(entry.path)})`);
  if (existsSync(entry.path)) {
    const presets = readdirSync(entry.path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    console.log(`      发现的预设:${presets.join(", ") || "(无)"}`);
    check(presets.includes("fpga-workbench"), "该目录里有 fpga-workbench 预设");

    // 每个预设必须有 agent.cordis.yml(缺了会被报成 broken 并让选择器显示不出)
    for (const preset of presets) {
      const composition = join(entry.path, preset, "agent.cordis.yml");
      check(existsSync(composition), `${preset} 有 agent.cordis.yml`);
      // 组合必须是可解析的 entry list
      if (existsSync(composition)) {
        try {
          const entries = yaml.load(readFileSync(composition, "utf8"), { schema: entryListSchema });
          check(Array.isArray(entries) && entries.length > 0, `${preset} 的组装是可解析的非空 entry list(${Array.isArray(entries) ? entries.length : "非数组"} 行)`);
        } catch (error) {
          check(false, `${preset} 的组装解析失败`, error.message);
        }
      }
    }
  }
}

// 4. 覆盖行必须重述要保留的字段 —— 按 id 定位的 patch 不做深度合并
for (const kept of ["default", "includeShippedRoot", "includeUserRoot"]) {
  check(kept in resolved, `覆盖行重述了 ${kept}(否则该字段会丢)`);
}
check(resolved.includeShippedRoot === true, "保留内置预设根(否则 standard 等官方预设会消失)");

// 5. 真正让预设出现的是 lib/index.js 里的 ensureUserPreset —— 它把预设同步进**用户预设
//    目录** `$DSH_HOME/.agent-presets/`。
//
//    为什么不是"给预设名单加一个 roots":dsh-agent-presets 的构造函数里
//    `resolvedRoots = [内置根] + config.roots + [用户根]`,也就是 roots **只从行 config 取,
//    不读设置值**;而给行 config 加根的补丁覆盖实测没生效(名单里看不到本预设,且不存在的
//    根会被 scanRoot 静默跳过 —— 完全没有报错)。用户根则无条件扫描,放进去就行。
const hostSource = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
const codeOnly = hostSource
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
check(
  /new URL\("\.\.\/presets\/", import\.meta\.url\)/u.test(codeOnly),
  "预设根由 import.meta.url 求值(不依赖补丁 !!js 的 baseUrl 语义)"
);
check(/function ensureUserPreset/u.test(codeOnly), "有用例把预设同步进用户预设目录");
check(/USER_PRESET_DIR/u.test(codeOnly) && codeOnly.includes('".agent-presets"'),
  "用的是 dsh-agent-presets 约定的用户预设目录名");
check(/process\.env\.DSH_HOME \?\? join\(homedir\(\), "\.dsh"\)/u.test(codeOnly),
  "harness home 取 DSH_HOME,退回 ~/.dsh");
check(/cpSync\(source, destination/u.test(codeOnly), "复制预设(而不是只登记路径)");
check(/sameTree\(source, destination\)/u.test(codeOnly), "内容一致就跳过(幂等,不每次重写)");
// 曾经写过 settings.yaml 的 agent-presets.roots —— 实测那层根本不参与 roots 解析,是无用写入,
// 还污染了用户配置。断言的是**别去写别人的设置**,而不是禁用 settings.update:
// 本插件自己的字段迁移(改名的旧键 → 新键)要用它,而且 `register()` 返回的句柄已经绑定了
// 命名空间(update(patch) 只接补丁)。所以真正要守的是这两条:
check(/ctx\.settings\.register\(NS,/u.test(codeOnly), "设置句柄只从本插件的命名空间(NS)注册");
check(
  !/settings\.(update|replace|mutate)\(\s*["']/u.test(codeOnly),
  "没有按名字去写别的设置命名空间(句柄已绑定,不该再传 ns)"
);

// 6. 显示名只有一处真相:预设的 name 与设置页的 LABEL 必须相同。
//    改名只改一半会让用户看到两个名字(预设选择器一个、设置里一个)。
const presetDir = join(ROOT, "presets", "fpga-workbench");
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
const compositionPath = join(presetDir, "agent.cordis.yml");
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
check(manifest.exports?.["./mode"] === "./lib/mode.js", "package.json 声明了 exports['./mode']");
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

// ── 作用域:这些东西只在 FPGA 模式下生效,别的模式一点都别沾 ──────────────────
//
// 用户的原话:"一定是开发模式采用这些东西,不是开发模式不要用这些"。
// 机制上靠**两层分工**:
//   · profile 层(cordis.patch.yml,全局):只挂插件行(设置读写 + 状态/浏览路由)与预设名单;
//   · 预设层(agent.cordis.yml,只被点名本预设的会话挂载):人设、工具链提示、16 个技能。
// 这条分工很容易在以后挪一行时被破坏(把提示或技能目录挪到全局层),那时**所有会话**都会看到
// FPGA 的东西。所以按"全局层不许出现什么"来断言,而不是只断言"预设层有这些"。
const patchText = readFileSync(patchPath, "utf8");
check(!/systemPrompt/u.test(patchText), "全局层(补丁)不注册任何会话提示 —— 提示只能来自预设层");
check(!/customSkillDirs|skill-filesystem/u.test(patchText), "全局层不注册技能目录 —— 技能只在预设层可见");
check(!/能力地图|实现思路/u.test(patchText), "全局层不含本模式的人设文字(那是预设 persona 的事)");
check(
  !/dsh-fpga-workbench\/mode/u.test(patchText),
  "全局层不挂模式半侧(它必须待在内置预设里,否则每个会话都会加载那段工具链提示)"
);
// 反过来:预设层必须有这三样,缺一样本模式就残废
check(rowById.get("persona") !== undefined, "预设层有 persona 行(能力地图随模式走)");
check(/dsh-persona/u.test(String(rowById.get("persona")?.name ?? "")), "persona 行挂的是 dsh-persona");
check(
  rowById.get("skill-filesystem") !== undefined,
  "预设层有 skill-filesystem 行(技能目录只在预设层声明)"
);

// 每个技能必须能被 dsh-skill-filesystem 认出来:目录名 = frontmatter 的 name,且是
// kebab-case;name/description 缺任何一个,技能会被**静默忽略**(只留一条 warn)。
const skillNames = existsSync(skillDir)
  ? readdirSync(skillDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [];
check(skillNames.length > 0, `预设带了至少一个技能(实际 ${skillNames.length} 个)`);
for (const skill of skillNames) {
  const file = join(skillDir, skill, "SKILL.md");
  if (!existsSync(file)) {
    check(false, `${skill} 缺 SKILL.md`);
    continue;
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(readFileSync(file, "utf8"))?.[1];
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
  check(meta?.name === skill, `${skill} 的 frontmatter name 与目录名一致(实际 ${JSON.stringify(meta?.name)})`);
  check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(meta?.name)), `${skill} 的名字是 kebab-case(技能名的合法字符集)`);
  // 命名统一:模块类 fpga-module-*、工程类 fpga-project-*(用户要求对称);
  // 一级标题去掉 fpga- 前缀,与技能名一致(`# module-lint:…` / `# project-impl:…`)
  check(
    /^fpga-(module|project)-/u.test(skill),
    `${skill} 带级别前缀(module- 或 project-)`
  );
  const heading = /^# ([a-z-]+):/mu.exec(readFileSync(file, "utf8"))?.[1];
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
    !/第一阶段|第二阶段|阶段 ?[0-9]|下一阶段|一口气写完|这一关过了才进|流程必须跑完并通过确认|OBSERVE_ONLY/u.test(readFileSync(file, "utf8")),
    `${skill} 里没有残留的"阶段链/硬门禁"口气`
  );
}

// ── 级别划分清楚:模块 6 个 / 工程 9 个 ──────────────────────────────────────
// 模块级五个 = 四个环节(spec/rtl/verif/synth)+ 审查(按需能力,不占目录)
const moduleSkills = skillNames.filter((name) => name.startsWith("fpga-module-"));
const projectSkills = skillNames.filter((name) => name.startsWith("fpga-project-"));
check(
  moduleSkills.length + projectSkills.length === skillNames.length,
  `每个技能都能看出属于哪一级(没前缀的:${skillNames.filter((name) => !/^fpga-(module|project)-/u.test(name)).join("、") || "无"})`
);
check(moduleSkills.length === 5, `模块级 5 个(实际 ${moduleSkills.length}:${moduleSkills.join("、")})`);
check(projectSkills.length === 9, `工程级 9 个(实际 ${projectSkills.length}:${projectSkills.join("、")})`);

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
const specSkill = readFileSync(join(skillDir, "fpga-module-spec", "SKILL.md"), "utf8");
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
const rtlText = readFileSync(join(skillDir, "fpga-module-rtl", "SKILL.md"), "utf8");
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
    /参考资料/u.test(readFileSync(join(skillDir, reader, "SKILL.md"), "utf8")),
    `${reader} 会去 spec 的「参考资料」取参照(参考链不能断)`
  );
}

// 收尾(用户要求):产物除 spec.md 外,流程图要单独成文;骨架用自带脚本一次建好,不手工建目录
check(/flow\.md/u.test(specSkill), "模块级写明流程图单独存成 spec/flow.md(不只塞在 spec.md 里)");
check(/spec-scaffold\.mjs/u.test(specSkill), "模块级写明用自带脚本一次性建骨架");
check(/--dry-run/u.test(specSkill), "模块级提示先 --dry-run 看一眼");
const projectSpec = readFileSync(join(skillDir, "fpga-project-spec", "SKILL.md"), "utf8");
check(/flow\.md/u.test(projectSpec), "工程级写明框图单独存成 project/spec/flow.md");
check(/spec-scaffold\.mjs/u.test(projectSpec), "工程级写明用自带脚本建骨架");
check(
  /--kind project/u.test(projectSpec) && /--modules/u.test(projectSpec),
  "工程级调用脚本时带上 --kind project 与 --modules(给每个模块建一套)"
);
check(existsSync(join(presetDir, "tools", "spec-scaffold.mjs")), "自带 spec-scaffold.mjs 确实在包里");

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
    /原型/u.test(readFileSync(join(skillDir, downstream, "SKILL.md"), "utf8")),
    `${downstream} 去到 spec 里的原型拿参考(不然这条参考链是断的)`
  );
}

// ── 环节契约(用户定过的形态) ──────────────────────────────────────────────
//
// 模块级就是四个环节:**规格(讨论)→ RTL(编写)→ 验证(跑出数据 + 独立比对)→ 综合(门禁 + 综合后时序)**。
// 仿真与比对合成一个环节(用户口径 2026-09-19):测试平台只负责把数据跑出来,判"对不对"要拿独立
// 参照比 —— 劈成两半会让人以为"仿真跑绿了"就等于"对了"。骨架里因此没有 sim/。
// 这里钉死名字与顺序,防止以后漂回 lint/comp/timing 那套旧名,或又冒出一个"审核环节"。
const scaffoldSource = readFileSync(join(presetDir, "tools", "spec-scaffold.mjs"), "utf8");
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
  /rtl\/lint\.md/u.test(readFileSync(join(skillDir, "fpga-module-rtl", "SKILL.md"), "utf8")),
  "机械检查报告写在 rtl/lint.md"
);
check(
  /<模块根>\/review\.md/u.test(readFileSync(join(skillDir, "fpga-module-review", "SKILL.md"), "utf8")),
  "审查报告写在 <模块根>/review.md"
);
// 综合环节要同时管门禁与时序(用户口径);验证环节的产物落 verif/
const synthSkillText = readFileSync(join(skillDir, "fpga-module-synth", "SKILL.md"), "utf8");
check(
  /综合门禁/.test(synthSkillText) && /时序/.test(synthSkillText),
  "综合环节同时管综合门禁与综合后时序"
);
const verifSkillText = readFileSync(join(skillDir, "fpga-module-verif", "SKILL.md"), "utf8");
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
  !/(^|[^a-z])sim\//u.test(readFileSync(join(presetDir, "tools", "rtl-check.mjs"), "utf8")),
  "rtl-check 里没有 sim/ 残留(测试平台现在在 verif/ 下找)"
);
// 文件名跟着设置里选的语言走:TB 的扩展名不能写死 .sv(选 VHDL 就是 .vhd),
// 而 VHDL 本检查器不覆盖 —— 必须说清"记 NOT_APPLICABLE",不能静默当通过
check(/仿真语言/u.test(verifSkillText) && /\.vhd/u.test(verifSkillText), "验证技能写明 TB 扩展名跟仿真语言走(含 .vhd)");
// ModelSim 的跑法:run -all / quit -f 是仿真器命令,得放进 .do 再一次调用(-c -do run.do)。
// 写成"逐行 shell 命令"跑不通,而退出码判据也不成立:实测 $fatal 之后 vsim 退出码仍是 0,
// 所以技能必须写明"看日志里的成功标记,不是看退出码"。
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
  "验证技能写明:$fatal 不改 vsim 退出码,判成败靠日志"
);

// TB 落点是 `verif/tb_<snake>`(stamp.mjs 的 defaultDestination 把驼峰转下划线,UartRx → tb_uart_rx,
// check-fpga-tools 也在断言这一点)。技能里曾写成 `tb_<模块名>`,照着找会找错文件。
check(
  /verif\/tb_<snake>/u.test(verifSkillText) && /--out/u.test(verifSkillText),
  "验证技能写明 TB 落在 verif/tb_<snake>.sv(模块名转下划线),且可用 --out 另指定"
);
check(
  /verif-new\.mjs/u.test(verifSkillText),
  "验证技能写明用 verif-new.mjs 起测试平台(命令名与环节名一致)"
);
// 用户明确要求过:说"要看波形"时必须真有手段 —— 技能里得有这条命令与用法,不能只有批处理
check(
  /verif-wave\.mjs/u.test(verifSkillText) && /波形/u.test(verifSkillText),
  "验证技能写明看波形的手段(verif-wave:开 GUI、加波形、不自动 run)"
);
// 比对方式本身有疑问时(格式对不上 / 容差拿不准 / golden 来路不明)要**回去问用户**,
// 不许自己改比对口径把结论凑过去 —— 判据一松,后面所有结论都不作数。
check(
  /比对方式[\s\S]{0,40}问用户|问用户[\s\S]{0,40}比对/u.test(verifSkillText),
  "验证技能写明:比对方式有问题就回去问用户"
);
check(
  /(不得|不许|不要)[\s\S]{0,20}(自行|自己)?改比对口径/u.test(verifSkillText),
  "验证技能写明:不得自行改比对口径(判据一松,后续结论都不作数)"
);
check(
  /格式对不上|容差/u.test(verifSkillText) && /golden[\s\S]{0,30}(来路|版本)/u.test(verifSkillText),
  "验证技能点名三类要问用户的比对问题(格式 / 容差 / golden 来路)"
);

check(
  /VHDL/u.test(readFileSync(join(skillDir, "fpga-module-rtl", "SKILL.md"), "utf8")),
  "检查技能写明 VHDL 源码不覆盖(记 NOT_APPLICABLE)"
);
// 判定词是给"接手的人"读的,所以文件里宣称的判定词集合必须真的覆盖所有会出现的结论 ——
// sim 曾经自相矛盾:正文说"没有测试平台 ≠ 不适用",判据那行却写着 NOT_APPLICABLE。
const VERDICTS = /PASS|FAIL|BLOCKED|NOT_APPLICABLE|UNVERIFIED|APPROVED|CHANGES_REQUESTED/gu;
const verdictWords = (text) => [...text.matchAll(VERDICTS)].map((m) => m[0]);
// 每个技能的判定词集合是**自己的**口径:审查用 approved/changes requested/blocked,
// 环节报告用 PASS/FAIL/BLOCKED/NOT_APPLICABLE/UNVERIFIED。审查正文里提到下游的 FAIL
// (说某个环节挂 FAIL)不算它的判定词,所以按技能限定可用的词,而不是全文搜大写词。
const MODULE_VERDICT_SETS = {
  "fpga-module-rtl": ["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"],
  "fpga-module-synth": ["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"],
  "fpga-module-verif": ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_APPLICABLE"],
  "fpga-module-review": ["APPROVED", "CHANGES_REQUESTED", "BLOCKED"],
};
for (const [skill, allowed] of Object.entries(MODULE_VERDICT_SETS)) {
  const text = readFileSync(join(skillDir, skill, "SKILL.md"), "utf8");
  // 取的是"把判定词一次列全"的那一处:sim/synth/verif 写成 `结论(PASS / FAIL / …)`,
  // rtl/review 写成 `- **结论**:`PASS` / `FAIL` / …`。同一文件里前面可能还有别的 `结论:` 提法
  // (synth 就有一句),所以扫全部匹配、挑出真的带判定词的那一处。
  const candidates = [...text.matchAll(/结论[^\n]*?(?:\(([^)]*)\)|:((?:[^`\n]*`[^`]+`[^\n]*)+))/gu)].map(
    (m) => m[1] ?? m[2] ?? ""
  );
  const listed = verdictWords(candidates.find((line) => verdictWords(line).length > 1) ?? "");
  check(listed.length > 0, `${skill} 的结论行列出了判定词(实际:${listed.join(" / ") || "无"})`);
  const used = allowed.filter((word) => text.includes(word));
  const missing = used.filter((word) => !listed.includes(word));
  check(missing.length === 0, `${skill} 的结论行没有漏掉它用到的判定词(漏:${missing.join("、") || "无"})`);
  const extra = listed.filter((word) => !allowed.includes(word));
  check(extra.length === 0, `${skill} 的结论行只用自己的判定词(多出:${extra.join("、") || "无"})`);
}
// 工程级的集成环节同样有判定词,产物那行原来只写"结论 + …",词一个没列 —— 同样补齐。
// (工程级其余八篇还没逐篇过,这里只钉这篇已改的,免得把还没审的也一起断言成现状。)
const integrateText = readFileSync(join(skillDir, "fpga-project-integrate", "SKILL.md"), "utf8");
const integrateListed = verdictWords(
  [...integrateText.matchAll(/结论[^\n]*?(?:\(([^)]*)\)|:((?:[^`\n]*`[^`]+`[^\n]*)+))/gu)]
    .map((m) => m[1] ?? m[2] ?? "")
    .find((line) => verdictWords(line).length > 1) ?? ""
);
check(integrateListed.length > 0, `fpga-project-integrate 的结论行列出了判定词(实际:${integrateListed.join(" / ") || "无"})`);
// 集成时"模块从哪来"也要先问用户(与 rtl 的现成子模块同一条口径):用户已有一律直接用,
// 不要集成时自己另写一个顶上 —— 那样模块自己那边的结论就对不上了。
check(
  /模块从哪来|模块来源/u.test(integrateText) &&
    /先问用户/u.test(integrateText) &&
    /(整理|另写|自己写)[\s\S]{0,24}(一个)?(顶上|替代)/u.test(integrateText),
  "集成技能写明:模块来源先问用户,不在集成时自己另写一个顶上"
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
  ...skillNames.map((skill) => [`${skill}/SKILL.md`, readFileSync(join(skillDir, skill, "SKILL.md"), "utf8")]),
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
const lintText = readFileSync(join(skillDir, "fpga-module-rtl", "SKILL.md"), "utf8");
check(
  /写完[\s\S]{0,16}检查/u.test(lintText) && !/随时可跑/u.test(lintText),
  "检查技能按用户节奏:写完再统一检查(不是'随时可跑'/'边写边跑')"
);
const runSection = /## 本环节要跑的命令([\s\S]*?)(?=\n## )/u.exec(lintText)?.[1] ?? "";
check(runSection !== "", "检查技能有一节专讲『本环节要跑的命令』(命令与时机写在一起)");
check(
  /写完之后|三步都写完之后/u.test(runSection) && /rtl-check\.mjs/u.test(runSection),
  "那一节里同时写明时机(写完之后)与要跑的命令(rtl-check.mjs),不是只提'跑全量'"
);
check(
  /--lint-only/u.test(runSection),
  "那一节里也点名编译器那条命令(不是只说'跑检查')"
);
const checkRtlText = readFileSync(join(presetDir, "tools", "rtl-check.mjs"), "utf8");
check(/\(sv\|v\)/u.test(checkRtlText) && /VHDL/u.test(checkRtlText), "rtl-check 认 .v 的 TB,并对 VHDL 有明确交代");
// 外来代码(厂商 IP / 他人模块)不按本模块规范检查:检查器要跳过 ip/,技能里也要写明这一点
check(/"ip"/u.test(/const SKIP_DIRS = new Set\(\[[\s\S]*?\]\)/u.exec(checkRtlText)[0]), "rtl-check 跳过 ip/ 目录(外来代码不按本规范查)");
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
  /rtl-new\.mjs/u.test(lintText) && /只替模块名/u.test(lintText),
  "rtl 技能写明用 rtl-new.mjs 复制模板,且只替模块名"
);
// 路径口径统一:IP 实体写 rtl/ip/、仿真模型写 verif/ —— 不许再出现裸的 `ip/` 路径
const bareIp = skillNames.filter((skill) => /`ip\//u.test(readFileSync(join(skillDir, skill, "SKILL.md"), "utf8")));
check(bareIp.length === 0, `技能里没有裸的 \`ip/\` 路径(应写 rtl/ip/ 或 verif/;实际 ${bareIp.join("、") || "无"})`);
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
  const text = readFileSync(join(skillDir, skill, "SKILL.md"), "utf8");
  check(/^```mermaid$/mu.test(text), `${skill} 里有**独立的** Mermaid 围栏块(不是只在句子里提了句 mermaid)`);
  check(/流程图|框图/u.test(text), `${skill} 要求把实现思路画出来`);
  // 确认必须与"图"绑在一起(只说"确认"可能是确认别的);措辞不限,断言的是这条关系
  check(
    /图[^。]{0,30}确认|确认[^。]{0,30}图/u.test(text),
    `${skill} 要求画完让用户确认(确认与流程图绑在一起)`
  );
  check(/5~15|5-15|5～15/u.test(text), `${skill} 给了规模上限(图太大反而看不清)`);
}

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 预设路径、模式行与自带技能都正确"
);
if (failures.length > 0) process.exitCode = 1;
