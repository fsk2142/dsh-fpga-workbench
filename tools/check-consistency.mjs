// 一致性检查:插件注册的槽、测试页断言的槽、Node 自检断言的槽必须是同一组,
// 且标识符必须引向同一个常量。
//
// 为什么需要它:这类"验证代码自己过期"的错最危险——它给出假绿。我已经犯过两次:
// 一次是入口槽从侧边栏换到会话头部之后测试页没跟上,一次是反过来换回去之后
// 这个检查本身还把新槽名当成"残留"。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
const page = readFileSync(join(ROOT, "tools", "harness", "index.html"), "utf8");
const nodeCheck = readFileSync(join(ROOT, "tools", "check-harness.mjs"), "utf8");

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

/** 插件实际注册的槽名:从 bundle 的 slots.register 调用里取。 */
const registered = new Set();
for (const match of bundle.matchAll(/slots\.register\(\s*\{\s*name:\s*"([^"]+)"/g)) {
  registered.add(match[1]);
}
console.log(`bundle 注册的槽:${[...registered].join(", ")}`);
check(registered.size === 2, `bundle 注册了 2 个槽(实际 ${registered.size})`);

// 1. 每个注册的槽都要被两处测试覆盖
for (const slot of registered) {
  check(page.includes(slot), `测试页断言了 ${slot}`);
  check(nodeCheck.includes(slot), `Node 自检断言了 ${slot}`);
}

// 2. 已废弃的槽不能在任何一处的**代码**里残留。
//
// 只看代码,不看注释:注释里提到旧槽名往往是"为什么不用它"的解释,那是有价值的
// 记录,不该被判失败(这个假失败已经犯过一次)。
const RETIRED = ["conversation.session.header.actions"];
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ");
for (const [label, text] of [["测试页", page], ["Node 自检", nodeCheck], ["bundle", bundle]]) {
  for (const slot of RETIRED) {
    check(!codeOnly(text).includes(slot), `${label} 的代码里未残留已废弃的 ${slot}`);
  }
}

// 3. 入口槽必须是 list 槽。sidebar.panellist 是侧边栏给第三方预留的分区行槽,
//    目前无官方插件占用;hero 那一行的槽都是 single 且已被官方占满,不能碰。
const ENTRY_SLOT = "sidebar.panellist";
check(registered.has(ENTRY_SLOT), `入口挂在 ${ENTRY_SLOT}`);
check(registered.has("main"), "面板挂在 main");
for (const single of ["conversation.hero.workspace", "conversation.hero.agentPreset", "conversation.hero.brand.mark"]) {
  check(!registered.has(single), `没有注册 ${single}(single 槽,会被官方占用)`);
}

// 3b. **不要**去替换官方的会话区(`sidebar.workspaces`)。
//
// 这是一条已经用代价换来的决定:
//   - 替换它必然改掉官方会话列表的样子(用户明确不接受:"官方的工作区不变")
//   - 而"盖掉整个 sidebar 再复用官方子槽"做不到:声明已被声明的子槽会直接抛错
//     (`slot "x" is already declared`),那个错发生在插件加载阶段 → 桌面端起不来
//   - 官方那套(搜索、右键菜单、未读点、行样式)是一份成熟实现,我们不重写它
// 所以这里把它固化成断言:谁再往这个槽里注册,自检会拦住并留下原因。
check(!registered.has("sidebar.workspaces"), "没有替换官方会话区(sidebar.workspaces)");
check(!/slots\.register\(\{\s*name:\s*"sidebar\.workspaces"/.test(bundle), "代码里也没有注册 sidebar.workspaces");

// 4. bundle 的模块 id 必须等于 package.json 的包名
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const moduleId = /load\(\{\s*id:\s*"([^"]+)"/.exec(bundle)?.[1];
check(moduleId === manifest.name, `模块 id 等于包名(${moduleId} === ${manifest.name})`);

// 5. 面板 id 与两处注册必须指向同一个常量。
//
// 断言的是"引用了同一个常量",不是抓字面量:代码里两侧都写 `PANEL_ID`,
// 抓字面量的正则永远抓不到 `key: PANEL_ID`,只会给出假失败(已犯过)。
const panelId = /const PANEL_ID = "([^"]+)"/.exec(bundle)?.[1];
check(panelId !== undefined, `能读出 PANEL_ID(${panelId})`);

/** 从某个槽的注册里取出它的 id/key 表达式。 */
function entryExpr(slot, field) {
  const source = bundle.replace(/\s+/g, " ");
  const re = new RegExp(`name: "${slot.replace(/[.]/gu, "\\.")}", ${field}: ([A-Za-z_$][\\w$]*)`);
  return re.exec(source)?.[1];
}

check(entryExpr(ENTRY_SLOT, "id") === "PANEL_ID", `入口行的 id 引用 PANEL_ID(实际 ${entryExpr(ENTRY_SLOT, "id")})`);
check(entryExpr("main", "key") === "PANEL_ID", `main 面板的 key 引用 PANEL_ID(实际 ${entryExpr("main", "key")})`);

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 插件、测试页、自检三者引用同一组槽与标识符"
);
if (failures.length > 0) process.exitCode = 1;
