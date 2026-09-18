// 校验插件声明的服务名是真实存在的服务,而不是我编出来的。
//
// 为什么必须做:客户端插件的 inject 是服务名数组,cordis 靠它把服务装进 ctx 再调 apply。
// 名字写错不会报「未知服务」,只会让 apply 拿到一个缺服务的 ctx,第一行抛 TypeError,
// 而宿主只回一句「did not provide an error message」并拒绝启动整个桌面端 ——
// 这条链路上没有任何一环会告诉我名字写错了。
//
// 做法:把已安装的每个客户端插件声明的 inject 收集成"已知服务名"集合,我的 inject
// 必须全部落在里面。这是从真实安装物里推出来的事实,不是我的假设。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai";

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

/** 从已安装包中收集所有被声明过的客户端服务名。 */
const known = new Map();
for (const pkg of readdirSync(APP)) {
  const file = join(APP, pkg, "lib", "client.js");
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  // 形如:const inject = ["a", "b"]; exports.inject = inject;
  for (const match of text.matchAll(/const\s+inject\s*=\s*\[([^\]]*)\]/g)) {
    for (const name of match[1].matchAll(/"([^"]+)"/g)) {
      if (!known.has(name[1])) known.set(name[1], []);
      known.get(name[1]).push(pkg);
    }
  }
}
console.log(`从 ${known.size} 个服务名中收集到已知服务(来自已安装客户端插件)\n`);

// 我的插件声明的服务名
const bundle = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
const injectSource = /exports\.inject\s*=\s*(\[[^\]]*\])/.exec(bundle)?.[1];
check(injectSource !== undefined, "bundle 导出了 inject");
const mine = injectSource === undefined ? [] : [...injectSource.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
console.log(`我的 inject: ${JSON.stringify(mine)}\n`);

check(mine.length > 0, "inject 不为空");
for (const name of mine) {
  check(known.has(name), `服务名 "${name}" 在已安装插件里被声明过${known.has(name) ? ` (${[...new Set(known.get(name))].slice(0, 3).join(", ")})` : " —— 拼错或不存在"}`);
}

// 反向防呆:名字里不该出现包名(包名是 dsh.client.inject / external 那种,不是服务名)
for (const name of mine) {
  check(!name.includes("/"), `服务名 "${name}" 不是包名形状`);
}

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: inject 里的每个服务名都来自真实安装物"
);
if (failures.length > 0) process.exitCode = 1;
