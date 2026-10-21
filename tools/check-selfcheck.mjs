// 设置页自检的**判据自检**:故意缺文件 / 缺整个技能目录,它必须报 fail。
//
// 为什么单独一条:2026-09-29 的复核指出原实现只看"四棵目录在不在",报的数字还来自代码常量 ——
// 删掉一份模板照样显示"通过"。那种检查最坏的地方不是漏报一次,而是**给人已经验过的错觉**。
// 这里用"按清单拷贝、故意漏掉一项"的夹具打靶,证明每一档判据真的会红。
//
// 零删除:夹具是**按清单拷出来的**(不是拷完再删),跑完留在 .tmp/ 下并打印路径,由人处置。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLED_SKILLS, runSelfCheck } from "../lib/selfcheck.js";
import { BUILTIN_TEMPLATES } from "../lib/template-library.js";
import { FIELDS, LEVEL_DIRS, TOOLS } from "../lib/toolchain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRESET = join(ROOT, "presets", "fpga-workbench");
const TMP = join(ROOT, ".tmp");

const failures = [];
const check = (ok, label, detail) => {
  if (ok) {
    console.log(`ok    ${label}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
};

/**
 * 抹掉 JS 源码里的注释,只留代码。
 *
 * 静态守卫("源码里不许再出现某个名字")必须只看代码:注释里常常故意写着"这里曾经错写成 X",
 * 那是留给下一个人的证据。把注释也算进来,断言就会因为**解释自己**而失败。
 *
 * 够用即可:`//` 行注释(允许前面有空白)与 `/* … *\/` 块注释;字符串里的 `//` 可能被误抹,
 * 本文件只用来查标识符,不看字符串。
 * @param source - 源码文本。
 * @returns 去掉注释后的文本。
 */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/([^:"'`/])\/\/[^\n]*/gu, "$1");

/** 递归列出目录下的相对文件路径(用于"照清单拷贝")。 */const listFiles = (root, current = root, out = []) => {
  for (const item of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, item.name);
    if (item.isDirectory()) listFiles(root, full, out);
    else out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
};

/**
 * 按清单造一份夹具:四棵子树 + 补丁。`skip` 里的相对路径(**相对包根**)不造 —— 用"少造"而不是
 * "造完再删"模拟缺文件,这样这条自检自己也不删除任何东西。
 *
 * 体积:templates 放空文件；skills 原样拷(自检要从 SKILL.md 解析显式引用),
 * tools / workspace 也原样拷(要真读它们的 import 图与规则源)。
 * @param skip - 要故意漏掉的相对路径集合。
 * @returns 夹具包根。
 */
let sequence = 0;
const makeFixture = (label, skip) => {
  sequence += 1;
  const root = join(TMP, `selfcheck-fixture-${String(process.pid)}-${String(sequence)}`);
  mkdirSync(root, { recursive: true });
  cpSync(join(ROOT, "cordis.patch.yml"), join(root, "cordis.patch.yml"));
  for (const tree of ["skills", "templates", "tools", "workspace"]) {
    const source = join(PRESET, tree);
    const empty = tree === "templates";
    for (const rel of listFiles(source)) {
      const target = `presets/fpga-workbench/${tree}/${rel}`;
      if (skip.has(target)) continue;
      const destination = join(root, target);
      mkdirSync(dirname(destination), { recursive: true });
      if (empty) writeFileSync(destination, "");
      else cpSync(join(source, rel), destination);
    }
  }
  return { label, root };
};

const statusOf = (report, id) => report.checks.find((item) => item.id === id);

mkdirSync(TMP, { recursive: true });

// ① 完整夹具:八项全 pass(否则后面的红灯说明不了问题)
const clean = makeFixture("clean", new Set());
{
  const report = runSelfCheck({}, clean.root);
  // 空设置下有两项**预期**提醒(模型版本未写、还没登记工具);除它们之外都必须 pass。
  const warnedIds = report.checks
    .filter((item) => item.status === "warn")
    .map((item) => item.id)
    .sort()
    .join(",");
  check(
    report.ok === true && report.failed === 0 && warnedIds === "settings,tools",
    `完整夹具:无 fail,只有两项预期提醒(failed=${String(report.failed)},warn=${warnedIds || "无"})`,
    report.checks.filter((item) => item.status === "fail").map((item) => `${item.label}:${item.detail}`).join(" / ")
  );
  check(report.checks.length === 8, `自检共 8 项(实际 ${String(report.checks.length)})`);
  check(
    statusOf(report, "templates")?.detail.includes(`${String(BUILTIN_TEMPLATES.length)} 份内置模板全在`),
    `模板那一项报的是"逐份核对通过",不是常量数字(${String(statusOf(report, "templates")?.detail)})`
  );
  check(
    /个依赖模块都在/u.test(String(statusOf(report, "commands")?.detail)),
    `命令那一项把辅助模块也走了一遍(${String(statusOf(report, "commands")?.detail)})`
  );
}

// ② 缺一份模板文件 → templates 必须 fail 并点名那份
{
  const victim = BUILTIN_TEMPLATES[0].relativePath;
  const fixture = makeFixture("missing-template", new Set([`presets/fpga-workbench/templates/${victim}`]));
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "templates");
  check(report.ok === false && item?.status === "fail", `缺一份模板 → 自检报 fail(${String(item?.detail)})`);
  check(
    String(item?.detail).includes(victim),
    `缺哪份模板就点名哪份(实际:${String(item?.detail)})`
  );
}

// ③ 缺一个技能目录(该目录下的文件一个都不拷)→ skills 必须 fail 并点名
{
  const victim = BUNDLED_SKILLS[0];
  const skip = new Set(
    listFiles(join(PRESET, "skills", victim)).map((rel) => `presets/fpga-workbench/skills/${victim}/${rel}`)
  );
  const fixture = makeFixture("missing-skill-dir", skip);
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "skills");
  check(
    report.ok === false && item?.status === "fail" && String(item?.detail).includes(victim),
    `整个技能目录缺失 → 报 fail 并点名(实际:${String(item?.detail)})`
  );
}

// ④ 缺一个技能里的 SKILL.md(目录在、文件不在)→ skills 必须 fail
{
  const victim = BUNDLED_SKILLS[1];
  const fixture = makeFixture("missing-skill-file", new Set([`presets/fpga-workbench/skills/${victim}/SKILL.md`]));
  // 目录得**真的在**(否则这一条退化成"缺整个目录",测不到"目录在、文件不在")
  mkdirSync(join(fixture.root, "presets", "fpga-workbench", "skills", victim), { recursive: true });
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "skills");
  check(
    report.ok === false && item?.status === "fail" && String(item?.detail).includes(victim),
    `技能目录在但 SKILL.md 缺失 → 报 fail 并点名(实际:${String(item?.detail)})`
  );
}

// ⑤ 缺一份 SKILL.md 显式引用的参考文件 → skills 必须 fail 并点名
{
  const skill = "fpga-module-rtl";
  const core = readFileSync(join(PRESET, "skills", skill, "SKILL.md"), "utf8");
  const relativePath = /\[[^\]]+\]\((references\/[^)\s]+\.md)\)/u.exec(core)?.[1];
  const victim = `${skill}/${String(relativePath)}`;
  const fixture = makeFixture(
    "missing-skill-reference",
    new Set([`presets/fpga-workbench/skills/${victim}`])
  );
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "skills");
  check(
    relativePath !== undefined && report.ok === false && item?.status === "fail" && String(item?.detail).includes(victim),
    `技能引用资源缺失 → 报 fail 并点名(实际:${String(item?.detail)})`
  );
}

// ⑥ 缺一个自带命令 → commands 必须 fail 并点名
{
  const tool = TOOLS[0];
  const relative = join(LEVEL_DIRS[tool.level] ?? "", tool.file).split("\\").join("/");
  const fixture = makeFixture("missing-command", new Set([`presets/fpga-workbench/tools/${relative}`]));
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "commands");
  check(
    report.ok === false && item?.status === "fail" && String(item?.detail).includes(tool.file),
    `缺一个自带命令 → 报 fail 并点名(实际:${String(item?.detail)})`
  );
}

// ⑦ 缺一个**辅助模块**(入口都在,只是它 import 的 lib/*.mjs 少一个)→ commands 必须 fail
{
  const victim = "lib/rtl-coverage.mjs";
  const fixture = makeFixture("missing-helper", new Set([`presets/fpga-workbench/tools/${victim}`]));
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "commands");
  check(
    report.ok === false && item?.status === "fail" && String(item?.detail).includes(victim),
    `缺一个命令依赖的辅助模块 → 报 fail 并点名(实际:${String(item?.detail)})`
  );
}

// ⑧ 缺"按名字读"的固定文件(workspace/AGENTS.fpga.md)→ package 必须 fail
//    (旧实现只看 workspace 目录在不在,这个文件没了照样全绿)
{
  const fixture = makeFixture(
    "missing-rules",
    new Set(["presets/fpga-workbench/workspace/AGENTS.fpga.md"])
  );
  // 目录得**真的在**(workspace 整棵树只有这一个文件,不建目录的话这一条会退化成 ⑧ 的"缺整树",
  // 红灯就说明不了"按名字读的文件没了"这件事)
  mkdirSync(join(fixture.root, "presets", "fpga-workbench", "workspace"), { recursive: true });
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "package");
  check(
    report.ok === false &&
      item?.status === "fail" &&
      String(item?.detail).includes("AGENTS.fpga.md") &&
      // 缺失清单只能有这一个文件(若含整棵 workspace,开头会是"缺少 workspace、")
      String(item?.detail).startsWith("缺少 workspace/"),
    `缺模式规则文件 → package 报 fail 且只点名这一个文件(实际:${String(item?.detail)})`
  );
}

// ⑨ 缺一棵整树(workspace 整个不造)→ package 必须 fail
{
  const fixture = makeFixture("missing-tree", new Set(listFiles(join(PRESET, "workspace")).map((rel) => `presets/fpga-workbench/workspace/${rel}`)));
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "package");
  check(
    report.ok === false && item?.status === "fail" && String(item?.detail).includes("workspace"),
    `整棵子树缺失 → package 报 fail 并点名(实际:${String(item?.detail)})`
  );
}

// ⑩ 设置模型版本没写 → warn(不是 fail:保存一次设置就会迁移)
{
  const report = runSelfCheck({}, clean.root);
  const item = statusOf(report, "settings");
  check(item?.status === "warn" && report.ok === true, `设置模型未写 → warn 但不阻塞(${String(item?.detail)})`);
}

// ⑪ 模板库路径填了但目录不存在 → library 必须 warn 并点名(2026-10-21 回归)
//
//    这一档曾经**恒为 pass**:实现里 find(field => field.key === "templateLibraryRoot") 找的是
//    一个不存在的字段名,于是 libraryRoot 永远是空串,走"用包内模板库"那条绿分支。用户把模板库
//    路径填错,自检照样报"通过"。判据整个失效,不是漏报一次。
{
  // 路径必须**保证不存在**,但本脚本零删除 —— 所以用一次性名字而不是先删再造。
  const bogus = join(TMP, `definitely-not-a-template-library-${String(process.pid)}-${String(Date.now())}`);
  const report = runSelfCheck({ templateLibraryPath: bogus }, clean.root);
  const item = statusOf(report, "library");
  check(
    item?.status === "warn" && String(item?.detail).includes(bogus),
    `模板库路径不存在 → library 报 warn 并点名(实际:${String(item?.detail)})`
  );

  // 目录真的存在 → pass,并且说明里点出这个路径(证明读的是填进去的值,不是恒空)
  const real = join(TMP, `selfcheck-library-${String(process.pid)}`);
  mkdirSync(real, { recursive: true });
  const good = statusOf(runSelfCheck({ templateLibraryPath: real }, clean.root), "library");
  check(
    good?.status === "pass" && String(good?.detail).includes(real),
    `模板库路径存在 → library 报 pass 并点名称该路径(实际:${String(good?.detail)})`
  );

  // 字段定义没了要说 fail,不能静默退化成"没填" —— 用一份没有该字段的来源不可能造,
  // 所以退而求其次:静态守住"实现里用的字段名真的在 FIELDS 里"。
  check(
    FIELDS.some((field) => field.key === "templateLibraryPath"),
    "selfcheck 读的模板库字段名在 FIELDS 里确实存在"
  );
  // 静态守卫只扫**代码**,不扫注释 —— 注释里会写"这里曾经错写成 X"来解释来龙去脉,
  // 那是要留的证据,不是要清掉的残留。早先版本的断言连注释一起算了,于是它一修好
  // 就被自己的说明文字绊倒(2026-10-21)。
  const codeOnly = stripComments(readFileSync(join(ROOT, "lib", "selfcheck.js"), "utf8"));
  check(
    !codeOnly.includes("templateLibraryRoot"),
    "lib/selfcheck.js 的**代码**里不再引用写错的字段名(注释里说明来龙去脉不算)"
  );
}

console.log(`夹具留在:${TMP}(本脚本不删任何文件,请自行处置)`);
// 兜底:夹具根必须真的存在(否则上面的"缺文件"其实是"夹具没造出来",红灯就成了假象)
check(existsSync(clean.root) && statSync(clean.root).isDirectory(), "完整夹具真的建出来了");

console.log(
  failures.length > 0
    ? `\nFAIL (${String(failures.length)}): ${failures.join(" | ")}`
    : "\nPASS: 设置页自检的判据成立(缺模板 / 缺技能 / 缺技能引用 / 缺命令 / 缺辅助模块 / 缺模式规则文件 / 缺整树都会红)"
);
if (failures.length > 0) process.exitCode = 1;
