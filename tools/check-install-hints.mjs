// 「没装工具时怎么装」的自检 —— `npm test` 的一部分,不需要任何厂商工具。
//
// 这条管的是**新机器上的第一公里**:一个工具都没装的人打开会话,如果只被告知
// "当前没有核验到可用路径",他知道缺,但不知道装什么、从哪儿装、要不要花钱。
// 换设备重装时卡住的往往就是这一步。
//
// 判据分三层:
//   1. 每个可检测的工具都有安装指引(漏一个,那个工具就退回"只说缺、不说怎么装");
//   2. 指引本身是**可执行的**(有渠道、有"填什么"、有官网),不是空壳;
//   3. 提示词按"缺什么"给建议 —— 全空走起步组合,部分缺只列缺的那几条。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DETECT_TARGETS,
  INSTALL_HINTS,
  MINIMAL_SETUP,
  TOOL_CATALOG,
  describeEnv,
  installGuidance,
  statusOf
} from "../lib/toolchain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// ── 一、覆盖:每个能检测到的工具都要有安装指引 ───────────────────────────────

{
  const detectable = DETECT_TARGETS.map((target) => target.tool);
  const missing = detectable.filter((tool) => INSTALL_HINTS[tool] === undefined);
  check(
    missing.length === 0,
    `每个可检测工具都有安装指引(缺:${missing.length === 0 ? "无" : missing.join("、")})`,
    missing.length === 0 ? undefined : `这些工具只会说"缺",不会说"怎么装":${missing.join("、")}`
  );
  // 反过来:指引里的键必须真在 TOOL_CATALOG 里,否则是留在表里的死条目
  const orphan = Object.keys(INSTALL_HINTS).filter((tool) => TOOL_CATALOG[tool] === undefined);
  check(orphan.length === 0, `指引里没有指向不存在工具的条目(多余:${orphan.length === 0 ? "无" : orphan.join("、")})`);
}

// ── 二、内容:每条指引都要能照着做 ───────────────────────────────────────────

{
  const problems = [];
  for (const [tool, hint] of Object.entries(INSTALL_HINTS)) {
    if (typeof hint.where !== "string" || hint.where.trim() === "") problems.push(`${tool}.where 为空`);
    if (typeof hint.note !== "string" || hint.note.trim() === "") problems.push(`${tool}.note 为空`);
    if (typeof hint.url !== "string" || !/^https:\/\//u.test(hint.url)) problems.push(`${tool}.url 不是 https 链接`);
    if (typeof hint.free !== "boolean") problems.push(`${tool}.free 必须是布尔(要用来标"免费/商业授权")`);
    if (typeof hint.account !== "boolean") problems.push(`${tool}.account 必须是布尔(要用来标"是否需账号")`);
  }
  check(problems.length === 0, `每条指引都有渠道/填什么/官网/成本标记(问题:${problems.length === 0 ? "无" : problems.join(";")})`);

  // 「填什么」必须真的提到该填的东西,不能只写"填路径"
  const vague = Object.entries(INSTALL_HINTS)
    .filter(([, hint]) => hint.note.trim().length < 10)
    .map(([tool]) => tool);
  check(vague.length === 0, `「填什么」不是敷衍的一句话(过短:${vague.length === 0 ? "无" : vague.join("、")})`);
}

// ── 三、渲染:installGuidance 的输出可直接读 ──────────────────────────────────

{
  const lines = installGuidance("vivado");
  check(Array.isArray(lines) && lines.length === 3, `每个工具渲染成三行(实际 ${String(lines.length)} 行)`);
  check(
    lines.some((line) => line.includes("AMD")) && lines.some((line) => line.includes("vivado.bat")),
    `渲染结果里真的写了从哪儿装、填什么(${lines.join(" | ").slice(0, 120)})`
  );
  check(installGuidance("nope").length === 0, "没有指引的工具返回空数组,不编内容");
  // 商业工具必须标出来,免得用户以为免费
  const modelsim = installGuidance("modelsim").join(" ");
  check(/商业授权/u.test(modelsim), "商业工具标注了「商业授权」,不会让人误以为免费");
  const python = installGuidance("python").join(" ");
  check(/免费/u.test(python), "免费工具标注了「免费」");
}

// ── 四、两个提示场景:全空 vs 部分缺 ─────────────────────────────────────────

{
  const empty = describeEnv({});
  check(empty.includes("起步建议"), "一个工具都没装时,提示里给了起步建议");
  for (const line of MINIMAL_SETUP) {
    const keyword = line.slice(0, 12).replace(/\*/gu, "");
    check(empty.includes(keyword), `起步建议里含「${keyword}」那一条`);
  }
  // 全空时不该再出现"还缺这些工具"那一段(会与起步建议重复)
  check(!empty.includes("还缺这些工具"), "全空时不再另列「还缺这些工具」,避免与起步建议重复");

  // 只装 Python:应当点名 Verilator / Vivado / ModelSim
  const partial = describeEnv({ pythonPath: join(ROOT, "package.json") });
  check(partial.includes("还缺这些工具"), "装了一个工具后,提示里列出还缺哪些");
  check(partial.includes("verilator_bin.exe"), "缺 Verilator 时给出该填哪个文件");
  check(partial.includes("vivado.bat"), "缺 Vivado 时给出该填哪个文件");
  check(partial.includes("https://"), "给出的官网是可点的链接");

  // 已经装好的工具不该被念叨怎么装
  check(!partial.includes("安装:python.org"), "已就绪的 Python 不再出现安装指引");
}

// ── 五、设置页载荷:只在没就绪时带安装信息 ───────────────────────────────────

{
  const empty = statusOf({});
  const verilator = empty.tools.find((tool) => tool.key === "verilatorPath");
  check(
    verilator?.install !== undefined && verilator.install !== null,
    "未就绪的字段在设置页载荷里带 install(界面才能显示从哪儿装)"
  );
  check(
    typeof verilator?.install?.url === "string" && verilator.install.url.startsWith("https://"),
    "载荷里的官网是 https 链接"
  );

  const ready = statusOf({ verilatorPath: join(ROOT, "package.json") });
  const readyField = ready.tools.find((tool) => tool.key === "verilatorPath");
  check(readyField?.install === undefined, "已就绪的字段不带 install(装好的人不必再看下载指引)");

  // 自定义工具没有安装指引(用户自己指定),不能凭空造一段
  const custom = empty.tools.find((tool) => tool.key === "customCompilerPath");
  check(custom?.install === undefined, "自定义工具没有安装指引(它本来就不对应某个具体产品)");
}

// ── 六、客户端真的把它渲染出来 ───────────────────────────────────────────────

{
  const clientSource = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  check(clientSource.includes("fpga-set-install"), "客户端有安装指引的样式类");
  check(/install\.where/u.test(clientSource) && /install\.note/u.test(clientSource), "客户端渲染了「从哪儿装」与「填什么」");
  check(/install\.url/u.test(clientSource), "客户端把官网渲染成链接");
}

console.log(
  failures.length > 0
    ? `\nFAIL (${String(failures.length)}): ${failures.join(" | ")}`
    : "\nPASS: 缺工具时会给「从哪儿装、填什么、免费与否」,全空与部分缺两种场景都覆盖"
);
if (failures.length > 0) process.exitCode = 1;
