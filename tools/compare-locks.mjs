// 对比镜像里加重前后两份锁文件:既有依赖的锁定版本有没有位移。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIRROR = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp", "install-mirror");

/** 解析锁文件里每个包的锁定版本。 */
function lockVersions(file) {
  const text = readFileSync(file, "utf8");
  const found = new Map();
  const section = text.split(/\n(?=\S)/).find((part) => part.startsWith("packages:"));
  if (section === undefined) return found;
  for (const match of section.matchAll(/^\s{2}\/?((?:@[^/\s]+\/)?[^@\s/]+)@([^\s:(]+)/gm)) {
    const key = match[1];
    const version = match[2];
    if (!found.has(key)) found.set(key, version);
  }
  return found;
}

const before = lockVersions(join(MIRROR, "lock-before.yaml"));
const after = lockVersions(join(MIRROR, "pnpm-lock.yaml"));

console.log(`加重前锁定包数 = ${before.size}`);
console.log(`加重后锁定包数 = ${after.size}`);

const moved = [];
for (const [name, version] of before) {
  const next = after.get(name);
  if (next === undefined) moved.push(`${name}: ${version} -> 被移除`);
  else if (next !== version) moved.push(`${name}: ${version} -> ${next}`);
}
const added = [...after.keys()].filter((name) => !before.has(name));
const removed = [...before.keys()].filter((name) => !after.has(name));

console.log("");
if (moved.length === 0) console.log("既有依赖的锁定版本:无一发生位移。");
else {
  console.log("发生位移的既有依赖:");
  for (const line of moved) console.log("  " + line);
}
console.log("新增的包:", added.length === 0 ? "(无)" : added.join(", "));
console.log("移除的包:", removed.length === 0 ? "(无)" : removed.join(", "));

const ok = moved.length === 0 && removed.length === 0 && added.length === 1 && added[0] === "dsh-fpga-workbench";
console.log("");
console.log(ok ? "PASS: 加入本插件只新增它自己,不动任何既有依赖。" : "FAIL: 安装会扰动既有依赖树。");
if (!ok) process.exitCode = 1;
