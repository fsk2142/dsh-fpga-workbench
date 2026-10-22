// 预设与补丁里的重复注册检查。
//
// 为什么值得查:两行注册同一个 id 或同一个包时,**功能看起来正常** —— 只是多了一份。
// 表现可能是设置页出现两张一样的卡、同一个工具被注册两次、或某行悄悄覆盖另一行
// 的 config。它不会报错,也不会让任何测试红。
//
// 同时也是**两份文件的一致性检查**:`agent.cordis.yml` 是编辑源,`cordis.patch.yml`
// 是实际加载的运行时副本,漂开就会出现"改了没生效"。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 本文件在 `tools/` 下，仓库根是**上一级**。
// （从 probes/ 复制过来时这一处必须改 —— 写错就是扫不到任何文件、然后安静地报绿。）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 解析一份 cordis 配置里的插件行。
 *
 * **必须按缩进区分角色**：`id:` 不只出现在插件行里，也出现在插件行内部的
 * **配置字段**里 —— 例如预设声明那一行：
 *
 *     - id: preset-fpga-workbench          ← 插件行（外层缩进）
 *       name: '@deepseek-ai/dsh-agent-preset'
 *       config:
 *         id: fpga-workbench               ← 配置字段，不是插件行（更深缩进）
 *
 * 第一版不看缩进，把后者也当成插件行,于是报"`fpga-workbench` 重复注册"。
 *
 * 判据：只认「`- id:` 后紧跟同级 `name:`」的那些行；没有 `name:` 的（分组、
 * 或深层的配置字段）不算插件行。
 */
function parseRows(text) {
  const rows = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) continue;
    // 插件行：`- id: xxx`（带短横线），记下缩进
    const dashId = /^(\s*)-\s+id:\s*(\S+)\s*$/u.exec(line);
    if (dashId !== null) {
      current = { id: dashId[2], name: null, indent: dashId[1].length + 2 };
      rows.push(current);
      continue;
    }
    if (current === null) continue;
    // 同一行内的 name（缩进与 id 内容对齐）
    const nameMatch = /^(\s+)name:\s*['"`]?([^'"`\n]+?)['"`]?\s*$/u.exec(line);
    if (nameMatch !== null && nameMatch[1].length === current.indent && current.name === null) {
      current.name = nameMatch[2].trim();
      continue;
    }
    // 收集 config 里的关键字段，用来区分"同一包的多个实例"：
    // `dsh-tool-subagent` 会被注册两次（provider=spawn / provider=fork），
    // 那是两种配置而不是重复。只看 name 会把它们误判成重复。
    const configField = /^\s+(provider|toolName|kind|mode|platform):\s*['"`]?([^'"`\n]+?)['"`]?\s*$/u.exec(line);
    if (configField !== null) {
      current.configParts ??= [];
      current.configParts.push(`${configField[1]}=${configField[2].trim()}`);
      continue;
    }
    // 遇到比当前插件行更深的行（config 内部）—— 忽略，它不属于插件层
    const indentMatch = /^(\s*)\S/u.exec(line);
    if (indentMatch !== null && current !== null && indentMatch[1].length < current.indent && line.trim() !== "") {
      // 回到上层，当前行结束
      current = null;
    }
  }
  // 只保留真正有 name 的行（没有 name 的不是插件行）
  // 顺带把 config 里区分实例的字段拼成一个 key（同包不同配置不该算重复）。
  return rows
    .filter((row) => row.name !== null)
    .map((row) => ({
      id: row.id,
      name: row.name,
      configKey: (row.configParts ?? []).slice().sort().join("&")
    }));
}

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

for (const [label, file] of [
  ["预设 agent.cordis.yml", "presets/fpga-workbench/agent.cordis.yml"],
  ["运行时补丁 cordis.patch.yml", "cordis.patch.yml"]
]) {
  const rows = parseRows(readFileSync(join(ROOT, file), "utf8"));
  console.log(`\n── ${label}: ${String(rows.length)} 行 ──`);

  // ① 同一份文件里 id 不能重复
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  const dupIds = [...byId.entries()].filter(([, list]) => list.length > 1);
  check(
    dupIds.length === 0,
    `${label}: 没有重复的 id（重复:${dupIds.map(([id, list]) => `${id}×${String(list.length)}`).join("、") || "无"}）`
  );

  // ② 同一个包 + 同一份 config 才算重复注册
  //
  // **不能只按包名判**：`@deepseek-ai/dsh-tool-subagent` 在预设里被注册两次是
  // **标准版就这么做的** —— 同一个包、两种 provider（`spawn` 与 `fork`），
  // 各给一个工具名（`subagent` / `subagent_fork`）。那是"同一模块的两种配置"，
  // 不是重复注册。第一版按包名判，在这里假报了一次。
  const byName = new Map();
  for (const row of rows) {
    if (row.name === null || row.name.startsWith("cordis:")) continue;
    const key = `${row.name}\u0000${row.configKey ?? ""}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row.id);
  }
  const dupNames = [...byName.entries()].filter(([, ids]) => ids.length > 1);
  check(
    dupNames.length === 0,
    `${label}: 没有「同一个包 + 同一份 config」被重复注册（重复:${dupNames
      .map(([key, ids]) => `${key.split("\u0000")[0]}←${ids.join(",")}`)
      .join("、") || "无"}）`
  );

  // ③ 有名字的行必须真的解析出了 name（解析失败会让检查 ② 空转）
  const named = rows.filter((row) => row.name !== null && !row.name.startsWith("cordis:")).length;
  check(named > 0, `${label}: 解析出 ${String(named)} 个包名（0 个说明解析器坏了，检查 ② 在空转）`);
}

// ── ④ 两份文件的预设行必须一一对应（补丁是预设的运行时副本）─────────────────
{
  const preset = parseRows(readFileSync(join(ROOT, "presets/fpga-workbench/agent.cordis.yml"), "utf8"));
  const patch = parseRows(readFileSync(join(ROOT, "cordis.patch.yml"), "utf8"));
  const presetIds = new Set(preset.map((row) => row.id));
  const patchIds = new Set(patch.map((row) => row.id));
  // 补丁里多出的是插件层（插件本体 + 预设声明），不算漂移
  const pluginLayer = new Set(["fpga-workbench", "preset-fpga-workbench"]);
  const onlyInPatch = [...patchIds].filter((id) => !presetIds.has(id) && !pluginLayer.has(id));
  const onlyInPreset = [...presetIds].filter((id) => !patchIds.has(id));
  check(
    onlyInPatch.length === 0 && onlyInPreset.length === 0,
    `两份文件的预设行一一对应（只在补丁:${onlyInPatch.join("、") || "无"}；只在预设:${onlyInPreset.join("、") || "无"}）`
  );

  // 同名行的包名也要一致（id 对得上但 name 写错，等于换了个插件）
  const patchByName = new Map(patch.map((row) => [row.id, row.name]));
  const nameDrift = preset
    .filter((row) => patchByName.has(row.id) && patchByName.get(row.id) !== row.name)
    .map((row) => `${row.id}: 预设=${String(row.name)} 补丁=${String(patchByName.get(row.id))}`);
  check(
    nameDrift.length === 0,
    `两份文件里同一 id 的包名一致（漂移:${nameDrift.join("；") || "无"}）`,
    nameDrift.slice(0, 6).join("\n")
  );
}

console.log("");
// 兜底:先确认两个文件真的读进来且有内容 —— 路径写错时 readFileSync 会抛，
// 但如果哪天改成"读到空就跳过"，这条能防住"安静地报绿"。
{
  const presetText = readFileSync(join(ROOT, "presets/fpga-workbench/agent.cordis.yml"), "utf8");
  const patchText = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
  check(
    presetText.length > 500 && patchText.length > 500,
    `两份配置文件都真的读到了（预设 ${String(presetText.length)} 字节 / 补丁 ${String(patchText.length)} 字节）`
  );
}

if (failures.length === 0) {
  console.log("PASS: 没有重复注册，两份文件一一对应");
} else {
  console.log(`FAIL (${String(failures.length)}): ${failures.join(" | ")}`);
  process.exitCode = 1;
}
