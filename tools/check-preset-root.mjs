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
// 曾经写过 settings.yaml 的 agent-presets.roots —— 实测那层根本不参与 roots 解析,是无用写入
check(!/settings\.update\(/u.test(codeOnly), "不再往 settings.yaml 写 roots(那层不参与 roots 解析)");

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
  check(typeof meta?.description === "string" && meta.description.length > 0, `${skill} 写了 description(否则加载器直接忽略)`);
}

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 预设路径、模式行与自带技能都正确"
);
if (failures.length > 0) process.exitCode = 1;
