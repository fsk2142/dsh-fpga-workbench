// 工具链提示渲染的行为检查 —— 这一版唯一的非平凡纯逻辑。
//
// 断言的是两条会真出错的性质:
//   1. 只列**填过**的字段 —— 把空字段也列出来,agent 会看到一个空路径并照着它去调工具
//   2. 一项都没填时返回**空串** —— system-prompt 只丢弃 text 为空的段;若这里返回一段
//      标题而无内容,每个会话的提示里都会多出一句废话
//
// 只 import 零依赖的 lib/toolchain.js:lib/index.js 要 schemastery,而它只在 profile
// 的 node_modules 里,从仓库 import 会解析失败。
import { readFileSync } from "node:fs";
import { FIELDS, NS, renderToolchain } from "../lib/toolchain.js";

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// 1. 全空 → 空串
check(renderToolchain({}) === "", "全空时返回空串");
check(renderToolchain(undefined) === "", "值为 undefined 时返回空串");
check(
  renderToolchain(Object.fromEntries(FIELDS.map(([key]) => [key, "   "]))) === "",
  "全空白字符串时返回空串"
);

// 2. 只列填过的
const partial = renderToolchain({ vivadoPath: "C:\\X\\vivado.bat", modelsimPath: "", libraryPath: "C:\\libs" });
check(partial.includes("C:\\X\\vivado.bat"), "列出填过的 Vivado 路径");
check(partial.includes("C:\\libs"), "列出填过的库目录");
check(!partial.includes("ModelSim"), "未填的字段不出现在提示里");
check(!partial.includes("Verilator（"), "未填的 Verilator 不出现在提示里");
check(partial.includes("Vivado") && partial.includes("库目录"), "填过的字段带名字");

// 3. 四个都填 → 四条,且每条一个字段
const all = renderToolchain(
  Object.fromEntries(FIELDS.map(([key], index) => [key, `C:\\tool${index}`]))
);
const bullets = all.split("\n").filter((line) => line.startsWith("- "));
check(bullets.length === FIELDS.length, `四项都填 → ${FIELDS.length} 条(实际 ${bullets.length})`);
check(all.split("\n").length === FIELDS.length + 1, "只有一行引导语加四行路径");

// 4. 值与键的对应不能错位(错位会让 agent 用错工具)
for (const [index, [key, label]] of FIELDS.entries()) {
  const expected = `- ${label}: C:\\tool${index}`;
  check(all.includes(expected), `字段与值对应正确:${expected}`);
}

// 5. 命名空间两边必须写同一个值 —— 客户端 bundle 里是硬编码的,这里比对源码
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
check(clientSource.includes(`"${NS}"`), `客户端 bundle 里的命名空间与宿主一致(${NS})`);

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 工具链提示渲染的边界行为全部正确");
if (failures.length > 0) process.exitCode = 1;
