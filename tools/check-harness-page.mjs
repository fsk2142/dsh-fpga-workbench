// 静态检查测试页:它的脚本块是否合法、引用的资源是否都能取到且能解析。
//
// 起因:用户第一次跑测试页得到「bundle 注册了 0 个 factory」。那意味着 bundle 的顶层
// 没有执行,而原因只可能是「脚本没取到」或「脚本有语法错误」。这两条都可以离线验证,
// 不必再让用户当试错工具。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

const html = readFileSync(join(HERE, "harness", "index.html"), "utf8");

// 1. 抽出 <script> 块:有 src 的检查文件存在,内联的检查语法
const inlineScripts = [];
const externalScripts = [];
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  const attrs = match[1];
  const body = match[2];
  const src = /src="([^"]+)"/.exec(attrs)?.[1];
  if (src !== undefined) externalScripts.push(src);
  else if (body.trim() !== "") inlineScripts.push(body);
}

console.log(`内联脚本块: ${inlineScripts.length} 个;外部脚本: ${externalScripts.join(", ") || "(无)"}`);
check(inlineScripts.length >= 2, "页面至少有两个内联脚本块(加载器与断言)");

inlineScripts.forEach((body, index) => {
  try {
    // 只编译不执行:执行需要 DOM,这里要的是「浏览器能解析它」
    new Script(body, { filename: `inline-${index + 1}.js` });
    check(true, `内联脚本块 ${index + 1} 语法合法`);
  } catch (error) {
    check(false, `内联脚本块 ${index + 1} 语法非法`, error.message);
  }
});

// 2. 外部脚本必须存在
for (const src of externalScripts) {
  const file = join(HERE, "harness", src.replace(/^\.\//, "").replace(/^\//, ""));
  try {
    readFileSync(file);
    check(true, `外部脚本存在: ${src}`);
  } catch {
    check(false, `外部脚本缺失: ${src} (${file})`);
  }
}

// 3. bundle 必须能解析 —— 这是「顶层没执行」的第一嫌疑
const bundle = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
try {
  new Script(bundle, { filename: "client.js" });
  check(true, "bundle 语法合法(浏览器可解析)");
} catch (error) {
  check(false, "bundle 语法非法 —— 顶层永远不会执行", error.message);
}

// 4. 两个宿主脚本也要能解析
for (const rel of ["kernel.js", "serve.mjs"]) {
  const file = join(HERE, "harness", rel);
  if (rel.endsWith(".mjs")) {
    check(true, `跳过 ESM 编译检查: ${rel}(由 node 直接跑)`);
    continue;
  }
  try {
    new Script(readFileSync(file, "utf8"), { filename: rel });
    check(true, `${rel} 语法合法`);
  } catch (error) {
    check(false, `${rel} 语法非法`, error.message);
  }
}

// 5. 页面里不应残留已被放弃的 document.write 注入方式
check(!html.includes("document.write"), "页面不再使用 document.write 注入");
check(html.includes("loadBundle("), "页面用显式的 loadBundle() 等待脚本加载");

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 测试页自身合法,且它引用的资源都能取到、都能解析"
);
if (failures.length > 0) process.exitCode = 1;
