// 加载契约的飞行前检查 —— 重启 DSH 之前跑一次,专门查"会让桌面端起不来"的那类问题。
//
// 为什么单独一个检查:这个插件历史上**两次**让桌面端起不来,根因都不是逻辑错,而是加载契约:
//   · 客户端 bundle 的 exports.inject 写成了对象(应该是服务名数组)→ apply 拿到缺服务的 ctx,
//     第一行抛 TypeError,而宿主只回一句 "did not provide an error message";
//   · loader 的 id 与包名不一致 / bundle 里出现相对 require → 整份组合加载失败。
// 这些错有个共同点:**静态看不出来,一启动就黑屏**。所以用机器逐条钉住。
//
// 查什么:
//   1. 所有会被加载的 .js/.mjs 语法是否通过(node --check)
//   2. lib/ 内部的相对 import 是否指向存在的文件,且导入的名字**真的被那个文件导出**
//      (改了一半的重命名就死在这条上)
//   3. 客户端 bundle 契约:loader id = 包名、exports.inject 是数组、无相对 require、无 static import
//   4. 宿主半侧:导出 apply / inject = ["settings"] / index.js 里不出现 systemPrompt
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const manifest = JSON.parse(read("package.json"));

// ── 1. 语法 ─────────────────────────────────────────────────────────────────
const loadable = [
  ...readdirSync(LIB).filter((name) => name.endsWith(".js")).map((name) => join("lib", name)),
  ...readdirSync(join(ROOT, "presets", "fpga-workbench", "tools")).map((name) => join("presets", "fpga-workbench", "tools", name))
];
const broken = loadable.filter((rel) => spawnSync(process.execPath, ["--check", join(ROOT, rel)], { stdio: "ignore" }).status !== 0);
check(broken.length === 0, `${loadable.length} 个可加载文件语法通过`, broken.join(", "));

// ── 2. lib 内部相对 import 是否真的对得上 ───────────────────────────────────
const linkProblems = [];
for (const name of readdirSync(LIB).filter((entry) => entry.endsWith(".js"))) {
  const source = readFileSync(join(LIB, name), "utf8");
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.\/[^"']+)["']/gu)) {
    const names = match[1].split(",").map((part) => part.trim().split(/\s+as\s+/u)[0]).filter((part) => part !== "");
    const target = join(LIB, match[2]);
    if (!existsSync(target)) {
      linkProblems.push(`${name} → ${match[2]} 不存在`);
      continue;
    }
    const targetSource = readFileSync(target, "utf8");
    for (const imported of names) {
      const declared = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${imported}\\b|export\\s*\\{[^}]*\\b${imported}\\b`, "u");
      if (!declared.test(targetSource)) linkProblems.push(`${name} 导入了 ${imported},但 ${match[2]} 没有导出它`);
    }
  }
}
check(linkProblems.length === 0, "lib/ 内部相对 import 都能解析", linkProblems.join("\n        "));

// ── 3. 客户端 bundle 契约 ───────────────────────────────────────────────────
const client = read("lib/client.js");
const loaderId = /__ModuleLoader__\.load\(\{[\s\S]{0,120}?id:\s*"([^"]+)"/u.exec(client)?.[1];
check(loaderId === manifest.name, `bundle 的 loader id 等于包名(实际 ${String(loaderId)} vs ${manifest.name})`);
check(/exports\.inject\s*=\s*\[/u.test(client), "exports.inject 是数组(写成对象会让整行不激活)");
check(!/exports\.inject\s*=\s*\{/u.test(client), "exports.inject 不是对象字面量");
check(/exports\.apply\s*=/u.test(client), "导出 apply");
check(/exports\.name\s*=/u.test(client), "导出 name");
check(!/require\(\s*["']\./u.test(client), "bundle 内没有相对 require(会被拼进组合后解析失败)");
check(!/^\s*import\s/mu.test(client), "bundle 内没有 static import");
check(/settingsScope/u.test(client) && !/exports\.inject\s*=\s*\[[^\]]*settingsScope/u.test(client),
  "可能不存在的服务(settingsScope)走内部 inject,不放进 exports.inject");

// ── 4. 宿主半侧 ────────────────────────────────────────────────────────────
const host = read("lib/index.js");
check(/export function apply/u.test(host), "宿主导出 apply");
check(/export const inject = \["settings"\]/u.test(host), `宿主 inject 恰好是 ["settings"]`);
check(!/systemPrompt/u.test(host), "index.js 里不出现 systemPrompt(提示只能由模式半侧注册)");
check(/export const name = /u.test(host), "宿主导出 name");
const mode = read("lib/mode.js");
check(/export const inject = \["systemPrompt"\]/u.test(mode), `模式半侧 inject 是 ["systemPrompt"]`);
check(/export function apply/u.test(mode), "模式半侧导出 apply");

console.log(failures.length > 0 ? `\nFAIL (${failures.length}): ${failures.join(" | ")}` : "\nPASS: 加载契约全部成立(重启前可以放心)");
if (failures.length > 0) process.exitCode = 1;
