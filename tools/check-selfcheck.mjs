// 设置页自检的**判据自检**:故意缺文件 / 缺整个技能目录,它必须报 fail。
//
// 为什么单独一条:2026-09-29 的复核指出原实现只看"四棵目录在不在",报的数字还来自代码常量 ——
// 删掉一份模板照样显示"通过"。那种检查最坏的地方不是漏报一次,而是**给人已经验过的错觉**。
// 这里用"按清单拷贝、故意漏掉一项"的夹具打靶,证明每一档判据真的会红。
//
// 零删除:夹具是**按清单拷出来的**(不是拷完再删),跑完留在 .tmp/ 下并打印路径,由人处置。
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLED_SKILLS, runSelfCheck } from "../lib/selfcheck.js";
import { BUILTIN_TEMPLATES } from "../lib/template-library.js";
import { LEVEL_DIRS, TOOLS } from "../lib/toolchain.js";

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

/** 递归列出目录下的相对文件路径(用于"照清单拷贝")。 */
const listFiles = (root, current = root, out = []) => {
  for (const item of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, item.name);
    if (item.isDirectory()) listFiles(root, full, out);
    else out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
};

/**
 * 按清单拷一份夹具:四棵子树 + 补丁。`skip` 里的相对路径(**相对包根**)不拷 —— 用"少拷"而不是
 * "拷完再删"模拟缺文件,这样这条自检自己也不删除任何东西。
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
    for (const rel of listFiles(source)) {
      const target = `presets/fpga-workbench/${tree}/${rel}`;
      if (skip.has(target)) continue;
      const destination = join(root, target);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(source, rel), destination);
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

// ⑤ 缺一个自带命令 → commands 必须 fail 并点名
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

// ⑥ 缺一棵整树(workspace 整个不拷)→ package 必须 fail
{
  const fixture = makeFixture("missing-tree", new Set(listFiles(join(PRESET, "workspace")).map((rel) => `presets/fpga-workbench/workspace/${rel}`)));
  const report = runSelfCheck({}, fixture.root);
  const item = statusOf(report, "package");
  check(
    report.ok === false && item?.status === "fail" && String(item?.detail).includes("workspace"),
    `整棵子树缺失 → package 报 fail 并点名(实际:${String(item?.detail)})`
  );
}

// ⑦ 设置模型版本没写 → warn(不是 fail:保存一次设置就会迁移)
{
  const report = runSelfCheck({}, clean.root);
  const item = statusOf(report, "settings");
  check(item?.status === "warn" && report.ok === true, `设置模型未写 → warn 但不阻塞(${String(item?.detail)})`);
}

console.log(`夹具留在:${TMP}(本脚本不删任何文件,请自行处置)`);
// 兜底:夹具根必须真的存在(否则上面的"缺文件"其实是"夹具没造出来",红灯就成了假象)
check(existsSync(clean.root) && statSync(clean.root).isDirectory(), "完整夹具真的建出来了");

console.log(
  failures.length > 0
    ? `\nFAIL (${String(failures.length)}): ${failures.join(" | ")}`
    : "\nPASS: 设置页自检的判据成立(缺模板 / 缺技能 / 缺命令 / 缺整树都会红)"
);
if (failures.length > 0) process.exitCode = 1;
