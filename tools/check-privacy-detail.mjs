// 隐私审查：把每个命中本机特征串的位置**分类**，判断是否真的该改。
//
// 不是所有本机路径都要删：
//   · 「注释里举的例子」→ 无害，但可以脱敏成通用路径
//   · 「代码里的探测候选」→ **必要**（要探测就得有候选路径）
//   · 「测试夹具」→ 必要（要测 ModelSim 探测就得给真实形态的路径）
//   · 「验证记录」→ 记录当时机器状态，属文档性质
//   · 「真实用户名 / 邮箱 / 密钥」→ **必须删**
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/u)
  .filter((line) => line.trim() !== "");

/** 真正的隐私泄露（必须修）。 */
const LEAKS = [
  { name: "真实用户名", re: /C:[\\/]Users[\\/](?!<|John|username|user\b|xxx)[A-Za-z0-9_.-]{2,}/u },
  { name: "主机名", re: /DESKTOP-[A-Z0-9]{7}|LAPTOP-[A-Z0-9]{7}/u },
  { name: "真实邮箱", re: /[a-z0-9._%+-]+@(?:qq|gmail|163|126|outlook|hotmail|foxmail)\.com/iu },
  { name: "密钥前缀", re: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/u }
];

/** 机器特定但**有正当理由**的路径（探测候选 / 测试夹具），只报告不改。 */
const JUSTIFIED = [
  { name: "ModelSim 安装路径", re: /C:[\\/]modeltech64_2020\.4/u },
  { name: "Vivado 安装路径", re: /C:[\\/]AMDDesignTools/u },
  { name: "仓库自身路径", re: /C:[\\/]Work[\\/]dsh-plug-in/u }
];

const leaks = [];
const justified = [];

for (const rel of tracked) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of LEAKS) {
      if (rule.re.test(line)) leaks.push({ rel, line: i + 1, kind: rule.name, text: line.trim().slice(0, 90) });
    }
    for (const rule of JUSTIFIED) {
      if (rule.re.test(line)) justified.push({ rel, line: i + 1, kind: rule.name });
    }
  }
}

console.log("=== 必须修的隐私泄露 ===");
if (leaks.length === 0) {
  console.log("  ✅ 无");
} else {
  for (const item of leaks) {
    console.log(`  ❌ ${item.rel}:${String(item.line)}  [${item.kind}]`);
    console.log(`       ${item.text}`);
  }
}

console.log("\n=== 机器特定但有正当理由（报告，不改）===");
const grouped = new Map();
for (const item of justified) {
  const key = item.kind;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(`${item.rel}:${String(item.line)}`);
}
for (const [kind, places] of grouped) {
  console.log(`  ${kind}: ${String(places.length)} 处`);
  for (const place of places.slice(0, 4)) console.log(`      ${place}`);
  if (places.length > 4) console.log(`      …另有 ${String(places.length - 4)} 处`);
}

console.log("");
console.log(leaks.length === 0 ? "  ✅ 隐私审查通过" : `  ❌ ${String(leaks.length)} 处需修`);
process.exit(leaks.length === 0 ? 0 : 1);
