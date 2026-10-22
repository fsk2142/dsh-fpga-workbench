// 第 3 步：产物等价验证（工单里最重要的一步）。
//
// 逐个入口对比导出符号：新产物必须**覆盖**手写备份的全部导出。
// 光跑 tools/check-all.mjs 不够 —— 它不一定覆盖所有导出（工单明确提醒）。
//
// 备份目录里的 `.js` 是 ESM（包是 type: module），`require()` 会失败，所以用 `import()`。
// 另外包内相对导入（`./mcp.js`）在有 node_modules 的环境里可能解析到别处，
// 所以这里**按文件 URL 直接 import**，绕开包解析。
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ENTRIES = ["index", "mode", "mcp", "selfcheck", "template-library", "toolchain", "version"];

/** 按绝对路径 import 一个模块，失败返回 undefined。 */
async function loadModule(dir, entry) {
  const file = join(ROOT, dir, `${entry}.js`);
  if (!existsSync(file)) return { missing: true, file };
  try {
    const namespace = await import(pathToFileURL(file).href);
    return { namespace, file };
  } catch (error) {
    return { error: String(error), file };
  }
}

/** 取一个模块**对外可见的导出名**（排除 `default`，它对 ESM 互操作没有比较价值）。 */
function exportNames(namespace) {
  return Object.keys(namespace).filter((key) => key !== "default" || namespace[key] !== undefined);
}

const rows = [];
let failed = 0;

for (const entry of ENTRIES) {
  const before = await loadModule("lib.handwritten-backup", entry);
  const after = await loadModule("lib", entry);

  if (before.missing) {
    rows.push({ entry, verdict: "SKIP", detail: "备份里没有这个入口" });
    continue;
  }
  if (before.error !== undefined) {
    rows.push({ entry, verdict: "FAIL", detail: `备份读不了：${before.error}` });
    failed += 1;
    continue;
  }
  if (after.missing) {
    rows.push({ entry, verdict: "**缺产物**", detail: "lib/ 里没有这个文件" });
    failed += 1;
    continue;
  }
  if (after.error !== undefined) {
    rows.push({ entry, verdict: "**读不了**", detail: after.error.slice(0, 160) });
    failed += 1;
    continue;
  }

  const beforeNames = exportNames(before.namespace);
  const afterNames = exportNames(after.namespace);
  const missing = beforeNames.filter((name) => !afterNames.includes(name));
  const added = afterNames.filter((name) => !beforeNames.includes(name));

  if (missing.length === 0) {
    rows.push({
      entry,
      verdict: "OK",
      detail: `${String(beforeNames.length)} 个导出全覆盖${added.length > 0 ? `（新增 ${added.length}：${added.join(", ")}）` : ""}`
    });
  } else {
    failed += 1;
    rows.push({
      entry,
      verdict: `**缺 ${String(missing.length)}**`,
      detail: `缺：${missing.join(", ")}`
    });
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log("第 3 步：逐入口产物等价对比\n");
console.log("入口".padEnd(18) + "结论".padEnd(14) + "细节");
console.log("─".repeat(110));
for (const row of rows) {
  console.log(row.entry.padEnd(18) + row.verdict.padEnd(14) + row.detail);
}
console.log("─".repeat(110));

// 客户端单独看：它是 CJS + loader 包装，不能当 ESM import。
{
  const clientFile = join(ROOT, "lib", "client.js");
  if (!existsSync(clientFile)) {
    console.log("\n客户端 client.js：**缺产物**");
    failed += 1;
  } else {
    const { readFileSync } = await import("node:fs");
    const first = readFileSync(clientFile, "utf8").split("\n")[0] ?? "";
    const ok = first.includes("window.__ModuleLoader__.load({");
    console.log(`\n客户端 client.js 首行：${ok ? "OK（loader 包装在）" : "**不是 loader 包装**"}`);
    console.log(`  ${first}`);
    if (!ok) failed += 1;
  }
}

console.log("");
if (failed === 0) {
  console.log("PASS: 7 个宿主入口的导出全部被新产物覆盖，客户端 loader 包装完好");
} else {
  console.log(`FAIL: ${String(failed)} 处不等价 —— 回去补 tsdown entry 或修该文件的类型错误`);
  process.exitCode = 1;
}
