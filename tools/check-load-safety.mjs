// 装载期安全清单：我的插件里每一个「可能让 DSH 起不来」的点，逐项断言。
//
// ## 为什么要这个检查器
//
// 我造成的 DSH 崩溃次数最多，根因不是某一行代码写错，而是**没有清单**：
// 每次都是真机崩了 → 定位一个症状 → 修那一处 → 下次换个地方再崩。
//
// 真机上已经崩过的形态（全部来自实际报错）：
//   ① PTY 后端重名          `a PTY backend named "shell" is already registered`
//   ② ctx.inject 不存在     `ctx.inject is not a function`
//   ③ webCtx.effect 不存在  `webCtx.effect is not a function`
//   ④ client.define 缺失    `TerminalError` / 客户端渲染冒烟失败
//
// 这个检查器把这四类 + 新增的第五类固化成断言，改代码时立刻会红。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "C:/Work/dsh-plug-in/dsh-fpga-workbench";
const failures = [];
let total = 0;

const check = (ok, label, detail) => {
  total += 1;
  if (!ok) failures.push({ label, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : `\n        ${detail}`}`);
};

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

console.log("=== ① PTY 后端：不得与宿主/其他插件抢注 ===");
{
  const preset = read("presets/fpga-workbench/agent.cordis.yml");
  /** 取某个 row 的 disabled 值。 */
  const rowDisabled = (id) => {
    const block = new RegExp(`^- id: ${id}\\s*$([\\s\\S]*?)(?=^- id: |(?![\\s\\S]))`, "mu").exec(preset);
    if (block === null) return "(无此行)";
    const m = /^\s+disabled:\s*(.+)$/mu.exec(block[1]);
    return m === null ? "(未写)" : m[1].trim();
  };
  check(rowDisabled("tool-bash") === "true", "预设的 tool-bash 已禁用", `实际: ${rowDisabled("tool-bash")}`);
  check(rowDisabled("tool-pwsh") === "true", "预设的 tool-pwsh 已禁用", `实际: ${rowDisabled("tool-pwsh")}`);
}

console.log("\n=== ② 装载期宿主服务调用必须有守卫 ===");
{
  const index = read("src/index.ts");
  // ctx.inject 用法必须走 typeof 检查
  const injectGuard = /typeof\s+injectWebService\s*!==\s*["']function["']/u.test(index);
  check(injectGuard, "ctx.inject 有 typeof 守卫");
  // webCtx.effect 必须走 typeof 检查
  const effectGuard = /typeof\s+effect\s*===\s*["']function["']/u.test(index);
  check(effectGuard, "webCtx.effect 有 typeof 守卫");
  // ctx.plugin 必须在 try 里
  const mcp = read("src/mcp.ts");
  const hasTry = /try\s*\{[\s\S]{0,400}ctx\.plugin\(/u.test(mcp);
  check(hasTry, "MCP 的 ctx.plugin 包在 try 里");
}

console.log("\n=== ③ 自检覆盖了所有已知冲突形态 ===");
{
  const selfcheck = read("src/selfcheck.ts");
  check(/optional-terminal-bash/u.test(selfcheck), "自检查 optional-terminal-bash");
  check(/optional-terminal-pwsh/u.test(selfcheck), "自检查 optional-terminal-pwsh（两条同包，都会注册 shell）");
  check(/profileShellOn\s*\|\|\s*\(presetShellOn/u.test(selfcheck), "自检能识别「profile 内部两条同开」这种形态");
  check(/DSH_PROFILE_DIR/u.test(selfcheck), "自检的 profile 路径不写死 desktop");
}

console.log("\n=== ④ 预设里登记的行都真实存在 ===");
{
  const index = read("src/index.ts");
  const preset = read("presets/fpga-workbench/agent.cordis.yml");
  // 本插件自己的 mode 入口必须被预设挂载
  check(/dsh-fpga-workbench\/mode/u.test(preset), "预设挂载了本插件的 mode 入口");
  // 它的包名与 package.json name 一致
  const pkg = JSON.parse(read("package.json"));
  check(preset.includes(`'${pkg.name}/mode'`), `预设里的包名与 package.json 一致（${pkg.name}）`);
  void index;
}

console.log("\n=== ⑤ 补丁与预设一致（漂移会让旧内容覆盖回去）===");
{
  const patch = read("cordis.patch.yml");
  const preset = read("presets/fpga-workbench/agent.cordis.yml");

  /**
   * 取某个 row 的 disabled 值。
   *
   * 不能用一个跨多行的正则去做整段匹配 —— `[\\s\\S]*?` 配上全局标志会在
   * 「第一个 - id:」 到「最后一个 disabled」之间随意落点，误判成没禁用
   * （本检查器第一版就是这么错的）。按行扫描最稳。
   */
  /**
   * 取某个 row 的 disabled 值。
   *
   * 用**字符串包含**判断而不是正则：entry list 里的缩进深浅不一
   * （预设里 `- id:` 顶格，补丁里嵌在 `insert:` 下带 10 空格缩进），
   * 用 `^\s*- id: ${id}$` 这种模板正则既容易被转义坑到，也容易误伤
   * `tool-bash` 与 `tool-bash-extra` 这类前缀相同的行。
   * 本检查器第一版就同时在两个地方踩到，所以改成最笨也最稳的写法。
   */
  const rowDisabled = (text, id) => {
    const lines = text.split("\n");
    const isRowStart = (line) => /^\s*- id:\s*/u.test(line);
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed !== `- id: ${id}`) continue;
      // 往下读，直到下一个 `- id:` 行为止
      for (let j = i + 1; j < lines.length; j += 1) {
        if (isRowStart(lines[j])) break;
        const m = /^\s+disabled:\s*(.+)$/u.exec(lines[j]);
        if (m !== null) return m[1].trim();
      }
      return "(未写)";
    }
    return "(无此行)";
  };

  for (const id of ["tool-bash", "tool-pwsh"]) {
    const inPreset = rowDisabled(preset, id);
    const inPatch = rowDisabled(patch, id);
    check(
      inPreset === inPatch,
      `${id} 在预设与补丁里状态一致`,
      `预设=${inPreset} 补丁=${inPatch}`
    );
  }
}

console.log("\n=== ⑥ 客户端入口不会在渲染期抛 ===");
{
  // client bundle 必须自带 window.__ModuleLoader__ 包装（宿主按这个取 factory）
  const clientPath = join(ROOT, "lib/client.js");
  if (existsSync(clientPath)) {
    const client = readFileSync(clientPath, "utf8");
    check(/__ModuleLoader__/u.test(client), "lib/client.js 带 __ModuleLoader__ 包装");
  } else {
    console.log("  skip lib/client.js 不存在（未构建）");
  }
}

console.log("");
console.log(`  共 ${String(total)} 项，失败 ${String(failures.length)} 项`);
if (failures.length > 0) {
  console.log("\n  失败项：");
  for (const item of failures) console.log(`    · ${item.label}`);
  process.exit(1);
}
console.log("  ✅ 装载期安全清单全部通过");
