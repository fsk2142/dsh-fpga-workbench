// 校验 CI workflow 的关键约束（2026-10-22 审查 N3 后加的守卫）。
//
// 为什么不用 YAML 解析器：仓库没有 yaml 依赖，而"只跑 CI 的配置"不该为此加依赖
// （CI 文件不进 npm 包）。这些约束是**结构性**的，用行扫描足够可靠，且能给出
// 比"YAML 语法错误"更有用的诊断。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "test.yml");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const failures = [];
const ok = (condition, label) => {
  if (condition) console.log(`ok    ${label}`);
  else {
    console.log(`FAIL  ${label}`);
    failures.push(label);
  }
};

let text;
try {
  text = readFileSync(WORKFLOW, "utf8");
} catch {
  console.log("FAIL  找不到 .github/workflows/test.yml");
  process.exit(1);
}

const lines = text.split(/\r?\n/u);

// ── 1. 缩进里不能有 tab（YAML 明确禁止）──────────────────────────────
const tabLines = lines.map((line, index) => ({ line, index: index + 1 })).filter((item) => /\t/u.test(item.line));
ok(tabLines.length === 0, `workflow 里没有 Tab 缩进（${String(tabLines.length)} 处）`);

// ── 2. N3：pnpm/action-setup 的 `with.version` 与 packageManager 不能并存 ──
const actionIndex = lines.findIndex((line) => /uses:\s*pnpm\/action-setup/u.test(line));
ok(actionIndex >= 0, "workflow 里有 pnpm/action-setup 步骤");
if (actionIndex >= 0) {
  // 该步骤的 with 块 = 后续缩进更深的行，直到下一个同级 `- ` 或同级键
  const baseIndent = /^(\s*)/u.exec(lines[actionIndex])[1].length;
  const stepLines = [];
  for (let i = actionIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      stepLines.push(line);
      continue;
    }
    const indent = /^(\s*)/u.exec(line)[1].length;
    if (indent <= baseIndent) break;
    stepLines.push(line);
  }
  const stepBody = stepLines.join("\n");
  const hasVersion = /^\s+version:/mu.test(stepBody);
  const packageManager = typeof PKG.packageManager === "string" ? PKG.packageManager : "";

  if (hasVersion && packageManager.startsWith("pnpm@")) {
    // action-setup 的判定是字符串全等：version 与 packageManager 的版本必须逐字相同，
    // 否则它抛 "Multiple versions of pnpm specified"。
    const declared = /^\s+version:\s*["']?([^"'\s]+)["']?/mu.exec(stepBody)?.[1] ?? "";
    const fromPackageManager = packageManager.replace(/^pnpm@/u, "");
    ok(
      declared === fromPackageManager,
      `action-setup 的 version(${declared}) 与 packageManager(${fromPackageManager}) 逐字相同` +
        (declared === fromPackageManager ? "" : " —— 不写 version: 才是最省心的做法")
    );
  } else {
    ok(true, "action-setup 不写 version（版本来源只有 package.json 的 packageManager 一处）");
  }
}

// ── 3. lockfile 必须入库，否则 --frozen-lockfile 与 npm ci 都不可能成功 ──
ok(text.includes("--frozen-lockfile"), "workflow 用 --frozen-lockfile 安装（版本可复现）");
const ignoreText = readFileSync(join(ROOT, ".gitignore"), "utf8");
const lockIgnored = ignoreText
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .some((line) => line === "pnpm-lock.yaml");
ok(!lockIgnored, ".gitignore 没有忽略 pnpm-lock.yaml（否则 frozen 安装无从校验）");

// ── 4. N1/H3：必须有 build + lib 同步断言 ────────────────────────────
ok(/run:\s*pnpm\s+run\s+build/u.test(text) || /run:\s*npm\s+run\s+build/u.test(text), "workflow 会构建");
ok(
  /git\s+diff\s+--exit-code\s+--\s+lib/u.test(text),
  "workflow 断言「重建后 lib/ 无差异」（防止改了 src 忘 build 就发布）"
);
ok(
  /run:\s*pnpm\s+run\s+typecheck/u.test(text) || /run:\s*npm\s+run\s+typecheck/u.test(text),
  "workflow 会跑 typecheck"
);

// ── 5. 装了依赖就该跑测试 ─────────────────────────────────────────────
ok(/run:\s*pnpm\s+test/u.test(text) || /run:\s*npm\s+test/u.test(text), "workflow 会跑测试");

// ── 6. N4：lockfile 的 importers 段不能把 peerDependencies 当实依赖 ──────
//
// 2026-10-22 第五轮审查发现：pnpm 默认 `autoInstallPeers: true`，生成 lockfile 时
// 把 3 个 peerDependencies 连同**整个宿主依赖树**写进 `importers..dependencies`
// —— 当时 lockfile 1695 行、"cordis" 出现 271 次。
//
// 危害不只是文件大：插件包会连宿主一起被安装（重复 cordis 实例 → 挂不到同一个插件
// 系统），而且 `--frozen-lockfile` 校验的是一份其实不需要的依赖图。
//
// 关掉 `autoInstallPeers` 的正确位置是 `pnpm-workspace.yaml` 顶层（pnpm 11 起不再读
// `.npmrc`，实测放 `settings:` 子键也无效）。这条断言同时守住"配置在了"与"结果对了"。
const peers = Object.keys(PKG.peerDependencies ?? {});
const lockPath = join(ROOT, "pnpm-lock.yaml");
let lockText = "";
try {
  lockText = readFileSync(lockPath, "utf8");
} catch {
  // 没有 lockfile 时由上面第 3 条断言负责报错，这里不重复 FAIL。
}
if (lockText !== "") {
  ok(/autoInstallPeers:\s*false/u.test(lockText), "pnpm-lock.yaml 的 settings 里 autoInstallPeers=false");

  // 取 importers 的 `.:` 段（到下一个顶层键为止）。
  const importersAt = lockText.search(/^importers:/mu);
  const nextTopAt = lockText.slice(importersAt + 1).search(/^\S/mu);
  const importerBlock =
    importersAt < 0
      ? ""
      : lockText.slice(importersAt, nextTopAt < 0 ? undefined : importersAt + 1 + nextTopAt);
  const depLine = importerBlock.search(/^ {4}dependencies:/mu);
  const depSection =
    depLine < 0 ? "" : importerBlock.slice(depLine).split(/^ {4}devDependencies:/mu)[0];
  const leakedPeers = peers.filter((name) => depSection.includes(`'${name}'`) || depSection.includes(`"${name}"`));

  ok(
    leakedPeers.length === 0,
    `lockfile 的 dependencies 段不含 peerDependencies（泄漏 ${String(leakedPeers.length)} 个：${leakedPeers.join(", ") || "无"}）`
  );
  ok(
    !/cordis/iu.test(lockText),
    `lockfile 里没有宿主依赖树（"cordis" 命中 ${String((lockText.match(/cordis/giu) ?? []).length)} 次）`
  );

  // 防复发：开关必须真的写在 pnpm-workspace.yaml 顶层。
  let workspaceText = "";
  try {
    workspaceText = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  } catch {
    workspaceText = "";
  }
  ok(
    /^autoInstallPeers:\s*false/mu.test(workspaceText),
    "pnpm-workspace.yaml 顶层写着 autoInstallPeers: false（pnpm 11 只从这里读）"
  );
}

console.log("");
if (failures.length === 0) {
  console.log("PASS: CI workflow 关键约束全部成立");
  process.exit(0);
}
console.log(`FAIL (${String(failures.length)}): ${failures.join(" | ")}`);
process.exit(1);
