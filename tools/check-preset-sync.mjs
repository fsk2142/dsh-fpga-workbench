// 校验「本预设 = 官方 standard 预置 + 本插件自己加的行」这个前提还成立。
//
// 为什么必须机器验:本预设的工具底座是从官方 standard 逐行复制来的(预设之间不继承,
// 不复制就会缺工具)。DSH 升级后 standard 若增删行、或改了某个包的**名字**,这份复制
// 不会跟着变:
//   - 少了行 → 本模式悄悄少一项能力,没人会发现;
//   - 名字对不上 → 该行解析失败,discovery 会把整个预设判成 broken、从选择器里消失
//     (不报错、只在日志里留一行)。
//
// 这两件事都只能靠比对发现。比对**只在名字层面**做:config 允许不同(人设文案、
// customSkillDirs 都是本插件故意加的),行 id 与包名必须一致。
//
// 本插件自己加的行写进 ADDED 白名单 —— 白名单外的"多出来的行"也会报出来,免得
// 哪天有人往预设里塞了行却没人知道它是干什么的。
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "C:/Program Files/DSH Desktop/resources/app";
const SHIPPED = join(APP, "node_modules", "@deepseek-ai", "dsh-agent-presets", "presets", "standard", "agent.cordis.yml");

/** 本插件在 standard 之上自己加的行(有意为之,不是漂移)。 */
const ADDED = new Set(["fpga-workbench-mode"]);

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

const require = createRequire(`${APP}/package.json`);
const yaml = require("js-yaml");
const { entryListSchema } = require("@deepseek-ai/cordis-plugin-include");

/**
 * 把组装摊平成 id → 行。组行(cordis:group)的子行也是行,一样要跟。
 * @param path - 组装文件。
 * @returns id 到 `{ name, disabled }` 的映射;文件读不到时为 undefined。
 */
function rowsOf(path) {
  if (!existsSync(path)) return undefined;
  const entries = yaml.load(readFileSync(path, "utf8"), { schema: entryListSchema });
  const out = new Map();
  const visit = (list) => {
    for (const row of Array.isArray(list) ? list : []) {
      if (row === null || typeof row !== "object") continue;
      if (typeof row.id === "string") out.set(row.id, { name: row.name, disabled: row.disabled });
      if (Array.isArray(row.config)) visit(row.config);
    }
  };
  visit(entries);
  return out;
}

const mine = rowsOf(join(ROOT, "presets", "fpga-workbench", "agent.cordis.yml"));
const shipped = rowsOf(SHIPPED);

check(mine !== undefined, "本插件的预设组装可读");
check(
  shipped !== undefined,
  `官方 standard 预设可读(${SHIPPED})`,
  "换机器/换 DSH 版本时这个路径要改"
);

if (mine !== undefined && shipped !== undefined) {
  check(mine.size > 0 && shipped.size > 0, `两侧都解析出行(本插件 ${mine.size} 行 / standard ${shipped.size} 行)`);

  // 1. standard 有的行,本预设必须都有 —— 否则本模式悄悄少能力
  const missing = [...shipped.keys()].filter((id) => !mine.has(id));
  check(missing.length === 0, `standard 的每一行都在本预设里(缺 ${missing.length} 行)`, missing.join(", "));

  // 2. 包名必须一致 —— 名字变了那一行就解析不到,预设会被判 broken
  const renamed = [...shipped.entries()]
    .filter(([id, row]) => mine.has(id) && mine.get(id).name !== row.name)
    .map(([id, row]) => `${id}: ${String(mine.get(id).name)} ≠ ${String(row.name)}`);
  check(renamed.length === 0, `同 id 的行指向同一个包(漂移 ${renamed.length} 处)`, renamed.join("\n        "));

  // 3. 本预设多出来的行必须都在白名单里 —— 否则是没人认领的东西
  const extra = [...mine.keys()].filter((id) => !shipped.has(id));
  const unclaimed = extra.filter((id) => !ADDED.has(id));
  check(unclaimed.length === 0, `多出来的行都已在白名单里(未认领 ${unclaimed.length} 行)`, unclaimed.join(", "));
  console.log(`      本预设自己加的行:${extra.join(", ") || "(无)"}`);

  // 4. disabled 只提示,不算失败:它是平台判断,改了不影响能不能挂载,但值得知道
  const flipped = [...shipped.entries()]
    .filter(([id, row]) => mine.has(id) && JSON.stringify(mine.get(id).disabled) !== JSON.stringify(row.disabled))
    .map(([id]) => id);
  if (flipped.length > 0) console.log(`      注意:disabled 与 standard 不同 —— ${flipped.join(", ")}(不影响挂载,自己确认是否有意)`);
}

console.log(
  failures.length > 0
    ? `\nFAIL (${failures.length}): ${failures.join(" | ")}`
    : "\nPASS: 预设底座与官方 standard 没有漂移"
);
if (failures.length > 0) process.exitCode = 1;
