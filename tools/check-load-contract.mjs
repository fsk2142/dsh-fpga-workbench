// 加载契约验证:这个插件必须能在**任何加载方式**下被 import。
//
// 为什么需要它:ESM 的裸依赖从模块自身位置向上解析,不看宿主锚点。所以只要包不是被
// 物理拷进 profile 的 node_modules,任何 dependencies 都会解析失败 —— 而插件加载失败
// 会把整个组合拖崩,代价是用户的桌面端起不来。
//
//   绝对路径挂载   (cordis.patch.yml 里 name: 'C:\...\lib\index.js')  裸依赖必失败
//   file: 链接     (dsh plugin add file:...)                          裸依赖必失败
//   github:/npm:   (物理拷进 profile/node_modules)                     裸依赖可解析
//
// 所以这里断言:lib/ 下的文件只 import node: 内置模块与相对路径。这样三种加载方式
// 都成立。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LIB = join(ROOT, "lib");

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

/** 递归列出目录下的文件。 */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** 找出一个文件里所有 import/require 的裸说明符(排掉 node: 与相对路径)。 */
function bareSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      const builtin = specifier.startsWith("node:");
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!builtin && !relative) found.add(specifier);
    }
  }
  return found;
}

// ── 1. 源码里不能有裸依赖 ────────────────────────────────────────────────────

const files = walk(LIB).filter((file) => file.endsWith(".js"));
check(files.length > 0, `lib/ 下有文件(${files.length} 个)`);

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const bare = [...bareSpecifiers(source)];
  const relative = file.slice(ROOT.length + 1);
  if (file.endsWith("client.js")) {
    // 浏览器 bundle 例外:它的 require 由内核的模块表回答(react 来自冻结的基座
    // 模块表),不经过 Node 解析,所以那里的裸说明符是正常的。
    console.log(`      ${relative}: 浏览器 bundle,require 由内核模块表回答 [${bare.join(", ") || "无"}]`);
    continue;
  }
  check(bare.length === 0, `${relative} 无裸依赖${bare.length > 0 ? ` —— 发现 [${bare.join(", ")}]` : ""}`);
}

// ── 2. package.json 不能声明运行时依赖 ──────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const deps = Object.keys(manifest.dependencies ?? {});
check(deps.length === 0, `package.json 无 dependencies${deps.length > 0 ? ` —— 发现 [${deps.join(", ")}]` : ""}`);

// ── 3. 宿主入口真的能被 import 并导出 apply ─────────────────────────────────

let host = null;
try {
  host = await import(pathToFileURL(join(LIB, "index.js")).href);
} catch (error) {
  check(false, `import lib/index.js:${error.code ?? error.message}`);
}
if (host !== null) {
  check(typeof host.apply === "function", "导出 apply(否则 cordis 不启动这一行)");
  check(typeof host.readRegistry === "function", "导出 readRegistry");
}

// ── 4. 浏览器 bundle 的导出面(用内核的懒 CJS 语义物化) ────────────────────

let registration = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } };
await import(pathToFileURL(join(LIB, "client.js")).href);
if (registration === null) {
  check(false, "client.js 注册了 factory");
} else {
  check(registration.id === manifest.name, `bundle id 与包名一致(${registration.id})`);
  const platform = { react: { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} } };
  const exports = registration.factory((specifier) => {
    if (specifier in platform) return platform[specifier];
    throw new Error(`bundle 请求了基座模块表之外的模块:${specifier}`);
  });
  check(typeof exports.apply === "function", "bundle 导出 apply");
  check(
    Array.isArray(exports.inject) && exports.inject.every((name) => typeof name === "string"),
    "bundle 的 inject 是服务名数组(客户端契约:不是对象)"
  );
}

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}):\n - ${failures.join("\n - ")}`
    : "\nPASS: 无裸依赖,三种加载方式下都能 import,导出面正确"
);
if (failures.length > 0) process.exitCode = 1;
