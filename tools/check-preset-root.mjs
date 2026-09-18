// 校验补丁里的 !!js 预设路径:用真实 loader 的求值器算出来,必须指向真实的预设目录。
//
// 为什么必须机器验:`!!js` 是字符串表达式,写错了不会有类型错误,只会在启动时静默
// 指向不存在的目录 —— 表现是"预设不见了",而你从界面上看不出原因。
//
// 依据(dsh-app-boot/lib/index.js:140):补丁文件被加载时,
//   this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href
// 也就是说 !!js 在**补丁文件所在目录**的上下文里求值。本包把补丁放在包根,
// 所以 'presets/' 就够了(官方示例写 '../presets/' 是因为它的补丁在下一层)。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "C:/Program Files/DSH Desktop/resources/app";

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

const require = createRequire(`${APP}/package.json`);
const yaml = require("js-yaml");
const { evaluate, isJsExpr } = require("@deepseek-ai/cordis-plugin-loader");
const { entryListSchema } = require("@deepseek-ai/cordis-plugin-include");

// 1. 解析补丁
const patchPath = join(ROOT, "cordis.patch.yml");
const rows = yaml.load(readFileSync(patchPath, "utf8"), { schema: entryListSchema });
check(
  Array.isArray(rows) && rows.some((row) => row.id === "agent-presets"),
  `顶层是数组且含 agent-presets 覆盖行(实际 ${Array.isArray(rows) ? `${rows.length} 条` : "非数组"})`
);

// 2. 找到 agent-presets 那条覆盖
const row = rows.find((r) => r.id === "agent-presets");
check(row !== undefined, "补丁里有 agent-presets 覆盖行");
if (row === undefined) {
  process.exitCode = 1;
  process.exit();
}

// 3. 关键:把 config 里的 !!js 求值出来。
//    evaluate 需要 loader ctx;baseUrl 设为补丁文件所在目录,与宿主一致。
const baseUrl = pathToFileURL(`${dirname(patchPath)}/`).href;
const ctx = { baseUrl, loader: {} };
const resolved = {};
for (const [key, value] of Object.entries(row.config)) {
  if (isJsExpr(value)) {
    resolved[key] = evaluate(ctx, value.__jsExpr);
    const prefix = `${key}.path`;
    console.log(`      ${prefix} 由 !!js 求值`);
  } else if (Array.isArray(value)) {
    resolved[key] = value.map((item) => {
      const out = { ...item };
      for (const [k, v] of Object.entries(item)) {
        if (isJsExpr(v)) out[k] = evaluate(ctx, v.__jsExpr);
      }
      return out;
    });
  } else {
    resolved[key] = value;
  }
}

const roots = resolved.roots ?? [];
check(roots.length === 1, `roots 求值后有 1 项(实际 ${roots.length})`);
for (const entry of roots) {
  console.log(`      path = ${String(entry.path)}`);
  check(typeof entry.path === "string" && entry.path.length > 0, "roots 项的 path 是字符串");
  check(existsSync(entry.path), `roots 路径存在(${String(entry.path)})`);
  if (existsSync(entry.path)) {
    const presets = readdirSync(entry.path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    console.log(`      发现的预设:${presets.join(", ") || "(无)"}`);
    check(presets.includes("fpga-workbench"), "该目录里有 fpga-workbench 预设");

    // 每个预设必须有 agent.cordis.yml(缺了会被报成 broken 并让选择器显示不出)
    for (const preset of presets) {
      const composition = join(entry.path, preset, "agent.cordis.yml");
      check(existsSync(composition), `${preset} 有 agent.cordis.yml`);
      // 组合必须是可解析的 entry list
      if (existsSync(composition)) {
        try {
          const entries = yaml.load(readFileSync(composition, "utf8"), { schema: entryListSchema });
          check(Array.isArray(entries) && entries.length > 0, `${preset} 的组装是可解析的非空 entry list(${Array.isArray(entries) ? entries.length : "非数组"} 行)`);
        } catch (error) {
          check(false, `${preset} 的组装解析失败`, error.message);
        }
      }
    }
  }
}

// 4. 覆盖行必须重述要保留的字段 —— 按 id 定位的 patch 不做深度合并
for (const kept of ["default", "includeShippedRoot", "includeUserRoot"]) {
  check(kept in resolved, `覆盖行重述了 ${kept}(否则该字段会丢)`);
}
check(resolved.includeShippedRoot === true, "保留内置预设根(否则 standard 等官方预设会消失)");

// 5. 运行时登记:补丁里那行 roots 实测**没生效**(名单里看不到本预设,且无任何报错 ——
//    不存在的根会被静默跳过)。所以真正让预设出现的是 lib/index.js 里的 ensurePresetRoot,
//    它把自己登记进最权威的用户层。这里守住它的两条性质:
//      - 路径来自 import.meta.url,不依赖"!!js 求值时的 baseUrl 是补丁所在目录"这个假设
//      - 追加而不覆盖:用户自己配的预设根不能被我们清掉
const hostSource = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
const codeOnly = hostSource
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
check(
  /new URL\("\.\.\/presets\/", import\.meta\.url\)/u.test(codeOnly),
  "预设根由 import.meta.url 求值(不依赖 baseUrl 语义)"
);
check(/settings\.update\(ROSTER_NS/u.test(codeOnly), "运行时把自己登记进预设名单");
check(/\[\.\.\.roots, \{ path: PRESET_ROOT/u.test(codeOnly), "追加到已有 roots 之后,不覆盖用户自己配的根");
check(/roots\.some\(\(entry\) => samePath/u.test(codeOnly), "已登记过就跳过(幂等)");
check(!/roots: \[\{ path: PRESET_ROOT/u.test(codeOnly), "没有出现直接覆盖 roots 的写法");

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: !!js 预设路径求值正确,指向真实且结构合法的预设目录"
);
if (failures.length > 0) process.exitCode = 1;
