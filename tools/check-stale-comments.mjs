// 注释时效性检查：找出「注释说的」与「代码实际做的」不一致的地方。
//
// 这是用户反复强调的一条（"不要留下与当前内容不符的注释"）。真机上已经踩过的形态：
//   · 注释说「默认读 verif/work/」，实现是先读 verif/       （第十三轮 C2）
//   · 注释说「关心前五类」，门槛实际只算三类               （第十三轮 C3）
//   · 旧的 URL / 版本号 / 命令名（改名后注释没跟上）
//   · 被否决方案的注释残留（描述的是已经删掉的写法）
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/u)
  .filter((line) => /\.(?:ts|mjs|js|md|yml|yaml|do|sv|py)$/u.test(line));

const findings = [];

for (const rel of tracked) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, "utf8");
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // ① 提到「已改名的命令」—— 旧名会让人照敲 404
    //    只查注释行（// * # 开头），代码里的字符串由别的检查器管
    const isComment = /^\s*(?:\/\/|\*|#)/u.test(line);
    if (!isComment) continue;

    const STALE_COMMANDS = [
      ["module-coverage.mjs", "module-verif-coverage.mjs"],
      ["module-ac-trace.mjs", "module-verif-ac-trace.mjs"],
      ["module-lint-verilator.mjs", "module-rtl-lint.mjs"]
    ];
    for (const [stale, current] of STALE_COMMANDS) {
      // 避免把当前名里的后缀误判（module-ac-trace 是 module-verif-ac-trace 的子串）
      const re = new RegExp(`(?<!verif-)(?<!rtl-)(?<!-)${stale.replace(".", "\\.")}`, "u");
      if (re.test(line)) {
        findings.push({ rel, line: i + 1, kind: "旧命令名", stale, current, text: line.trim().slice(0, 88) });
      }
    }

    // ② 提到已被删掉的类型/行为
    const STALE_CLAIMS = [
      { re: /关心前五类/u, why: "门槛实际只算语句/分支/状态机状态（三类），其余仅参考" },
      { re: /默认读 verif\/work\//u, why: "实现先读 verif/coverage.ucdb，其次 verif/work/" },
      { re: /改映射用 vmap(?!\s*;.*不带参数)/u, why: "现在应提示「不要用 vmap 建工程库」" },
      { re: /coverage 命令(?:在|位于)\s*\$\?finish/u, why: "coverage save 必须在 run -all 之前" }
    ];
    for (const claim of STALE_CLAIMS) {
      if (claim.re.test(line)) {
        findings.push({ rel, line: i + 1, kind: "过时说明", why: claim.why, text: line.trim().slice(0, 88) });
      }
    }
  }
}

console.log(`=== 扫描 ${String(tracked.length)} 个文件 ===\n`);

if (findings.length === 0) {
  console.log("  ✅ 未发现注释与实际不符的地方");
} else {
  const byKind = new Map();
  for (const item of findings) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, []);
    byKind.get(item.kind).push(item);
  }
  for (const [kind, items] of byKind) {
    console.log(`=== ${kind}：${String(items.length)} 处 ===`);
    for (const item of items) {
      console.log(`  ${item.rel}:${String(item.line)}`);
      console.log(`      ${item.text}`);
      if (item.why !== undefined) console.log(`      → ${item.why}`);
      if (item.current !== undefined) console.log(`      → 应改为 ${item.current}`);
    }
    console.log("");
  }
}

process.exit(findings.length === 0 ? 0 : 1);
