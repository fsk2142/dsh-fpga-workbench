// 校验本仓库组合里引用的每个插件名，在新宿主里真的能被解析。
//
// 为什么需要这个：DSH 升级会改包结构（删子路径 / 合并入口）。名字写错或子路径
// 消失时，**不会报错**，只会让 discovery 把整个预设判成 broken，选择器里显示
// 「加载失败 / never started」—— 2026-11-06 就踩了一次
// （`dsh-tool-subagent-control/list-agents` 被合并进主入口）。
//
// 这个脚本读宿主的 asar，对每个 `@deepseek-ai/<pkg>[/<subpath>]` 检查：
//   · 包存在
//   · 有子路径时，该子路径在包 package.json 的 exports 里声明过（或物理文件存在）
//   · 无子路径时，主入口存在
import { openSync, readSync, closeSync } from "node:fs";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";

const ASAR =
  process.env.DSH_ASAR ??
  "C:\\Users\\FSK\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";

/**
 * **两种运行环境，必须分开处理。**
 *
 * `check-all.mjs` 用**桌面端的 Electron 当 Node** 跑宿主检查
 * （`ELECTRON_RUN_AS_NODE=1`），而 Electron 的 fs **内置 asar 支持**：
 * 把 `.asar` 当虚拟目录，`openSync(asarPath)` 直接报
 * `ENOENT, not found in <asar>` —— 这时应该用**普通路径**读里面的文件
 * （`<asar>/dsh/node_modules/...` 就是真实可读路径）。
 *
 * 而单独用系统 Node 跑时没有 asar 支持，必须自己解 asar 头。
 *
 * 所以先探测：能 `statSync(asar)` 且不是目录 → 系统 Node，自己解头；
 * 否则 → Electron，直接走路径。
 */
const ELECTRON_ASAR = (() => {
  try {
    const st = statSync(ASAR);
    // Electron 里 asar 表现为目录；系统 Node 里是普通文件
    return st.isDirectory();
  } catch {
    return false;
  }
})();

/** Electron 环境下 asar 内的路径就是普通路径。 */
const asarPath = (path) => `${ASAR}${path.replace(/\//gu, "\\")}`;

/** 读 asar 里一个条目，返回 Buffer 或 undefined。 */
const readEntry = (() => {
  if (ELECTRON_ASAR) {
    return (path) => {
      try {
        return readFileSync(asarPath(path));
      } catch {
        return undefined;
      }
    };
  }

  let headerCache;
  const open = () => {
    const fd = openSync(ASAR, "r");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const headerBytes = Buffer.alloc(headerSize);
    readSync(fd, headerBytes, 0, headerSize, 16);
    headerCache = { fd, headerSize, tree: JSON.parse(headerBytes.toString("utf8")) };
    return headerCache;
  };
  return (path) => {
    const ctx = headerCache ?? open();
    let node = ctx.tree;
    for (const seg of path.split("/").filter(Boolean)) node = node?.files?.[seg];
    if (node === undefined || node.files !== undefined) return undefined;
    const bytes = Buffer.alloc(Number(node.size));
    readSync(ctx.fd, bytes, 0, bytes.length, 16 + ctx.headerSize + Number(node.offset));
    return bytes;
  };
})();

/** 宿主 node_modules 的根。 */
const NM = "/dsh/node_modules";

const exists = (path) => readEntry(path) !== undefined;

/** 读 JSON 条目。 */
const readJson = (path) => {
  const buf = readEntry(path);
  if (buf === undefined) return undefined;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
};

/**
 * 从两个组合文件里抽出所有**真实引用**的插件名。
 *
 * 只看 `name:` 字段 —— 注释里提到某个名字（比如解释「这一行为什么被删掉」）
 * 不算引用，否则删掉一行、在注释里说明原因，反而会被判成失败。
 */
const collectNames = (file) => {
  const text = readFileSync(file, "utf8");
  const names = new Set();
  for (const line of text.split(/\r?\n/u)) {
    // 去掉行尾注释后再判断，避免 `name: '...'  # 以前叫 xxx` 误匹配
    const withoutComment = line.replace(/\s+#.*$/u, "");
    const m = withoutComment.match(/^\s*-?\s*name:\s*['"]?(@deepseek-ai\/[^'"\s]+)['"]?/u);
    if (m !== null) names.add(m[1]);
  }
  return names;
};

/** 检查一个插件名能否解析。返回 null 表示 OK，否则返回原因。 */
const check = (spec) => {
  const m = spec.match(/^(@deepseek-ai\/[^/]+)(?:\/(.+))?$/u);
  if (m === null) return "不是 @deepseek-ai/<pkg>[/<sub>] 形式";
  const [, pkg, sub] = m;
  const pkgDir = `${NM}/${pkg}`;

  if (!exists(`${pkgDir}/package.json`)) return `宿主里没有这个包（${pkgDir}）`;
  const manifest = readJson(`${pkgDir}/package.json`);
  if (manifest === undefined) return "package.json 读不出来";

  if (sub === undefined) {
    const main = manifest.main ?? "index.js";
    if (!exists(`${pkgDir}/${main.replace(/^\.\//u, "")}`)) return `主入口不存在（${main}）`;
    return null;
  }

  // 有子路径：先看 exports 声明
  const exportsField = manifest.exports;
  if (exportsField !== undefined && typeof exportsField === "object") {
    const keys = Object.keys(exportsField);
    const want = `./${sub}`;
    const hit = keys.some((k) => k === want || (k.includes("*") && matchesStar(k, want)));
    if (!hit) return `exports 未声明 ${want}（现有：${keys.join(", ")}）`;
    return null;
  }

  // 没有 exports 字段：退回物理文件检查
  const cands = [`${pkgDir}/${sub}`, `${pkgDir}/${sub}.js`, `${pkgDir}/lib/${sub}.js`];
  if (cands.some(exists)) return null;
  return `没有 exports 字段，且物理文件不存在（试过 ${cands.join(" / ")}）`;
};

/** `./src/*` 这类通配是否匹配目标。 */
const matchesStar = (pattern, target) => {
  const star = pattern.indexOf("*");
  if (star < 0) return false;
  return target.startsWith(pattern.slice(0, star)) && target.endsWith(pattern.slice(star + 1));
};

/**
 * 默认扫本仓库自己的两个组合文件。
 *
 * `check-all.mjs` 调用各个检查时**不传参数**（其它检查也都是零参数的），
 * 所以默认值必须能让它独立跑通；显式给参数时仍按给的来（便于单独排查）。
 */
const DEFAULT_FILES = ["presets/fpga-workbench/agent.cordis.yml", "cordis.patch.yml"];

const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES;

const all = new Map(); // name -> 出现的文件
for (const file of files) {
  for (const name of collectNames(file)) {
    if (!all.has(name)) all.set(name, []);
    all.get(name).push(file);
  }
}

console.log(`  宿主: ${ASAR}`);
console.log(`  从 ${files.length} 个文件里抽到 ${all.size} 个插件名`);

const bad = [];
for (const [name, where] of all) {
  const problem = check(name);
  if (problem !== null) bad.push({ name, problem, where });
}

// 通配名（如 ./src/*）不当作真实引用
const realBad = bad.filter((b) => !b.name.includes("*"));

if (realBad.length === 0) {
  console.log(`  PASS: ${all.size} 个插件名全部能在当前宿主里解析`);
  process.exit(0);
}

console.error(`  FAIL: ${realBad.length} 个插件名解析不了 —— 预设会被判成 broken：`);
for (const b of realBad) {
  console.error(`    · ${b.name}`);
  console.error(`      原因: ${b.problem}`);
  console.error(`      出现在: ${b.where.join(", ")}`);
}
process.exit(1);
