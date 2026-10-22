// 改写前彻底验证:标题必须保持原样、正文必须清干净、提交信息不能变空。
//
// 为什么单独成文件:同样的循环写成 PowerShell 时,`-match` 对中文与 `%B` 输出里的
// CRLF 处理不一致 —— 我因此得到过"含痕迹 1 个"这种明显错误的数字。交给 Node 才可信。
import { execFileSync } from "node:child_process";

const TRACE = /用户|原话|报障/u;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** 用 scrub-commit-msg.mjs 改写一条信息(与 filter-branch 走同一条路)。 */
function scrub(message) {
  return execFileSync(process.execPath, ["scripts/scrub-commit-msg.mjs"], {
    input: message,
    encoding: "utf8"
  });
}

const shas = git(["log", "--all", "--format=%H"]).split("\n").filter(Boolean);
const traced = [];
const problems = [];
/**
 * 标题里允许保留的痕迹：泛指/术语，不是"与某个具体用户对话"。
 *
 * ⚠️ **不加 `g` 标志**。带 `g` 的正则对象有 `lastIndex` 状态：`replace()` 用过之后
 * 再调 `.test()` 会从上次位置继续找 —— 于是同一个正则在不同调用点给出矛盾结果
 * （我因此多查了一轮，以为是替换规则的问题）。需要全局替换时在调用处现建一个。
 */
const REAL_PATH = /(?:\\?[A-Za-z]:)?[\\/]+Users[\\/]+[^\\/\s]+/u;

for (const sha of shas) {
  const body = git(["show", sha, "--format=%B", "--no-patch"]);
  if (!TRACE.test(body)) continue;
  traced.push(sha);
  const out = scrub(body);
  const partsBefore = body.split("\n\n");
  const partsAfter = out.split("\n\n");
  const titleBefore = partsBefore[0].trimEnd();
  // 改写后信息末尾总带一个换行（git 惯例），标题里也可能被带上 —— 比较前统一去掉。
  const titleAfter = partsAfter[0].trimEnd();
  // 标题**只允许**一种改动：真实用户路径 → `<用户目录>`。
  //
  // 检查办法：把「改后」里的占位符**还原成正则**，用它去匹配「改前」——
  // 能匹配上就说明差异只有路径那一处。早先用「两边都做替换再比」是错的：
  // 改后已经不含路径，替换不会再发生，两边必然不等（白查了一轮）。
  const escaped = titleAfter
    .split("<用户目录>")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("(?:\\\\?[A-Za-z]:)?(?:\\\\|/)+Users(?:\\\\|/)+[^\\\\/\\s]+");
  if (!new RegExp(`^${escaped}$`, "u").test(titleBefore)) {
    problems.push(`${sha.slice(0, 7)} 标题被超出预期的改动: "${titleAfter.slice(0, 60)}"`);
  }
  // 标题里不许残留真实路径。
  if (REAL_PATH.test(titleAfter)) {
    problems.push(`${sha.slice(0, 7)} 标题里仍有真实用户路径`);
  }
  // **正文**必须清干净（标题允许保留泛指的用户/术语）。
  const bodyAfter = partsAfter.slice(1).join("\n\n");
  if (TRACE.test(bodyAfter)) {
    const line = bodyAfter.split("\n").find((l) => TRACE.test(l)) ?? "";
    problems.push(`${sha.slice(0, 7)} 正文仍有痕迹: ${line.trim().slice(0, 60)}`);
  }
  if (out.trim() === "") problems.push(`${sha.slice(0, 7)} 改写后变成空提交信息`);
}

console.log(`提交总数: ${shas.length}`);
console.log(`含痕迹: ${traced.length}`);
console.log(problems.length === 0 ? "✅ 全部通过:标题只做路径替换、正文清干净、无空提交" : `❌ ${problems.length} 个问题:`);
for (const p of problems.slice(0, 15)) console.log("  " + p);
