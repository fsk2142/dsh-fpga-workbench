// 一致性检查:插件注册的槽、测试页断言的槽、Node 自检断言的槽必须是同一组。
//
// 为什么需要它:我已经犯过一次——bundle 换成会话头部槽之后,测试页还在断言
// sidebar.panellist。那种"验证代码自己过期"的错最危险,因为它会给出假绿。
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

// 1. 每个注册的槽都要被两处断言覆盖
for (const slot of registered) {
  check(page.includes(slot), `测试页断言了 ${slot}`);
  check(nodeCheck.includes(slot), `Node 自检断言了 ${slot}`);
}

// 2. 两处都不能再引用已经废弃的槽
for (const [label, text] of [["测试页", page], ["Node 自检", nodeCheck]]) {
  check(!text.includes("sidebar.panellist"), `${label} 未残留旧的 sidebar.panellist`);
}

// 3. 入口槽必须是 list 槽(单占槽再注册会顶掉官方插件)
const ENTRY_SLOT = "conversation.session.header.actions";
check(registered.has(ENTRY_SLOT), `入口挂在 ${ENTRY_SLOT}`);
check(registered.has("main"), "面板挂在 main");

// 4. bundle 的模块 id 必须等于 package.json 的包名
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const moduleId = /load\(\{\s*id:\s*"([^"]+)"/.exec(bundle)?.[1];
check(moduleId === manifest.name, `模块 id 等于包名(${moduleId} === ${manifest.name})`);

// 5. 面板 id 与 main 面板的 key 必须指向同一个常量。
//
// 代码里两侧都写成 `PANEL_ID`,所以断言的是"两处引用了同一个常量",而不是
// 抓字面量 —— 抓字面量的正则永远抓不到 `key: PANEL_ID`,只会给出假失败。
const panelId = /const PANEL_ID = "([^"]+)"/.exec(bundle)?.[1];
const mainKeySource = /name:\s*"main",\s*key:\s*([A-Za-z_$][\w$]*)\s*\}/.exec(bundle)?.[1];
check(panelId !== undefined, `能读出 PANEL_ID(${panelId})`);
check(mainKeySource === "PANEL_ID", `main 面板的 key 引用 PANEL_ID(实际 ${mainKeySource})`);

// 入口行的 id 也必须引用同一个常量
const entryRegistration = /slots\.register\(\s*\{\s*name:\s*"conversation\.session\.header\.actions",\s*id:\s*([A-Za-z_$][\w$]*)/.exec(bundle)?.[1];
check(entryRegistration === "PANEL_ID", `入口行的 id 引用 PANEL_ID(实际 ${entryRegistration})`);

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 插件、测试页、自检三者引用同一组槽与标识符"
);
if (failures.length > 0) process.exitCode = 1;
