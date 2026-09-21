#!/usr/bin/env node
// 结论环节:核对**报告里引用的证据路径是不是真的在**。
//
// 为什么要有它:判定词(`PASS`)的含义是"独立判据已执行且覆盖充分"(见 `fpga-module-verif` 的
// 状态表),而报告里那些路径就是**判据的落点**。路径写在那儿、文件却不在,就是"看着验过了、
// 其实什么都没有" —— 实测踩过:某模块的 spec 把 AC-010 / AC-011 的证据位置写成
// `synth/synth.md` / `synth/timing.md`,而当时这两份根本还没写出来(报告后来自己记了这件事)。
// 本工具**只验路径存在,不判内容**(内容对不对是验证技能与审查的事)。
//
// 判据:
//   ① **AC 声明的证据位置**(`spec/spec.md` 的 AC 表行里用反引号写的 `spec|rtl|verif|synth` 相对路径)
//      必须存在 —— 但**只在这个模块已经写出结论之后**才要求:结论文件(`verif/*.md`、`synth/*.md`)
//      一份都没有时,说明验证还没做,那些位置本来就不该存在,那时红线只会变成噪音
//      (用户定过的教训:一个永远红的检查,人就不看了)。
//   ② **结论文件里引用的路径**必须存在:报告写的是"产物 / 依据"清单,引用了不存在的文件就是谎报。
//   ③ **依据的摘要变了**(警告,不影响退出码):报告里带一处 `--record` 写下的摘要块(见下),
//      这次的 sha256 与块里记的对不上 → 报告写完之后那份依据**内容变了**,结论可能已经不成立。
//
// **为什么是摘要而不是 mtime**(实测踩过):mtime 版会在"重跑一次工具"之后把报告里引用的每个
// 输出文件都报一遍(某模块一次 14 条),而其中绝大多数内容根本没变 —— 那种量级的警告几天就没人看了。
// 摘要只认内容:同样的输出重跑多少遍都不报,真变了才报一条。
//
// 摘要块(由本工具 `--record` 写入报告文件末尾,可恢复覆盖:`<报告>.bak-<时间戳>`):
//
//   <!-- evidence-digest:start -->
//   verif/sim.log  sha256=<64 位十六进制>
//   <!-- evidence-digest:end -->
//
// 容错:含 `<...>`、`*` 或**空白**的当占位 / 命令行,跳过(实测:AC 的证据列里写着
// `verif/comp_line_buffer.py --tap 5`);路径后的 `:行号` 摘掉再核;可再生目录(`work/`)里的东西
// 不在不算错(用户口径:跑一次就重生成)。
//
// 用法:
//   node module-report-check.mjs [<模块目录>] [--json] [--record]
// 模块目录默认当前目录。`--record` 只做一件事:把当前引用的证据的摘要写进报告文件(不动别的)。
// 退出码:0 全过(可以只有警告) / 1 有引用了却不存在的证据路径 / 2 用法或环境错误。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { writeFileRecoverable } from "../lib/stamp.mjs";

/** 结论文件所在的环节目录(只扫顶层 `*.md`;`explore/`、`work/` 那些中间产物不看)。 */
const REPORT_DIRS = ["spec", "verif", "synth"];

/** 报告里会被引用的路径前缀 —— 只认这四个环节目录,别的(如 `C:\...`、`../x`)不当证据路径。 */
const EVIDENCE_PREFIX = /^(?:spec|rtl|verif|synth)\//u;

/** AC 表行:`| AC-001 | … |`。 */
const AC_ROW = /^\s*\|\s*(AC-[0-9]+)\s*\|/u;

/**
 * 报告的写法里路径后面常跟**行号**(`rtl/x.sv:120-140`、`spec/spec.md:69`):判据是"文件在不在",
 * 行号是引用细节(内容对不对不归本工具管),所以核之前先把行号摘掉。
 */
const LINE_SUFFIX = /:\d+(?:[-,]\d+)*$/u;

/**
 * 这些目录里的东西**约定可再生**(跑一次就重新生成,用户自己的口径):引用它们不算错,
 * 只是"当时那份现在没了"。当 info 报,不判 FAIL —— 否则每清一次 work/ 就红一遍。
 */
const REGENERABLE = /(?:^|\/)work\//u;

/**
 * 从一段文本里抽出**当作证据引用**的模块根相对路径。
 *
 * 只认反引号里的(`conf.py` 这种裸词是文件名、不是路径,不当证据);含 `<` 或 `*` 的是占位写法,跳过;
 * 含**空白**的是命令行或说明(实测踩过:AC 的证据列里写着 `verif/comp_line_buffer.py --tap 5`),
 * 不当路径 —— 路径里没有空格。
 * @param text - 文件正文。
 * @returns 去重后的路径数组(保持出现顺序;行号后缀已摘掉)。
 */
export function evidencePaths(text) {
  const out = [];
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    let raw = match[1].trim();
    if (!EVIDENCE_PREFIX.test(raw)) continue;
    if (raw.includes("<") || raw.includes("*") || /\s/u.test(raw)) continue;
    raw = raw.replace(LINE_SUFFIX, "");
    if (raw === "" || out.includes(raw)) continue;
    out.push(raw);
  }
  return out;
}

/**
 * 摘要块:`--record` 写进报告末尾的"依据 + sha256"清单。
 *
 * 为什么不用 mtime(实测):mtime 版会把"重跑了一次工具"之后的每个输出文件都报一遍(某模块一次
 * 14 条),而绝大多数内容根本没变 —— 那种量级的警告几天就没人看了。摘要只认内容。
 */
const DIGEST_BLOCK = /<!-- evidence-digest:start -->([\s\S]*?)<!-- evidence-digest:end -->/u;

/**
 * 一条引用算不算"依据"(摘要只对依据算)。
 *
 * 三条排除,都是实测出来的误报来源:目录(没有"内容"可言)、报告类 `.md`(那是"结论引用结论",
 * 不是依据 —— 报告本来就一直在改)、可再生目录(见 {@link REGENERABLE})。
 * @param moduleRoot - 模块根。
 * @param path - 被引用的模块根相对路径。
 * @returns 是"依据文件"时 true。
 */
function isEvidenceFile(moduleRoot, path) {
  if (REGENERABLE.test(path)) return false;
  if (path.toLowerCase().endsWith(".md")) return false;
  try {
    return statSync(join(moduleRoot, path)).isFile();
  } catch {
    return false;
  }
}

/** 一个文件的 sha256(读不动时 undefined —— 缺文件由别的判据管)。 */
function sha256Of(abs) {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return undefined;
  }
}

/** 从报告正文里读回摘要块(`{ path: sha256 }`)。 */
export function recordedDigests(text) {
  const block = DIGEST_BLOCK.exec(text)?.[1] ?? "";
  const out = new Map();
  for (const line of block.split(/\r?\n/u)) {
    const match = /^\s*(\S+)\s+sha256=([0-9a-f]{64})\s*$/u.exec(line);
    if (match !== null) out.set(match[1], match[2]);
  }
  return out;
}

/** 把摘要块写进报告正文(已有块就替换,没有就追加)。 */
export function withDigests(text, entries) {
  const block = [
    "<!-- evidence-digest:start -->",
    ...entries.map(([path, digest]) => `${path}  sha256=${digest}`),
    "<!-- evidence-digest:end -->",
    ""
  ].join("\n");
  const body = text.replace(DIGEST_BLOCK, "").replace(/\n*$/u, "\n");
  return `${body}\n${block}`;
}

/**
 * 一个模块里被引用的证据路径清单。
 *
 * 扫描范围**刻意收窄**到"给判定词撑腰的那几份":`spec/spec.md` 的 AC 行、`verif/*.md`、`synth/*.md`。
 * 不含 `review.md`(按需报告,写的是**当时**的事)与 `*explore*.md`(探索产物)—— 它们引用后来
 * 被移走/改名的路径是正常的,拿它们判 FAIL 只会变成噪音。
 * @param moduleRoot - 模块根。
 * @returns `{ files, missing, concluded }`:`files` 每项 `{ file, paths }`;
 *   `missing` 每项 `{ file, path, ac, reason, hard }`(`hard=false` 表示"可再生/还没做到")。
 */
export function auditReports(moduleRoot) {
  const files = [];
  const missing = [];
  const seen = new Set();

  const readIf = (rel) => {
    const abs = join(moduleRoot, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  };

  const mdIn = (dir) => {
    try {
      return readdirSync(join(moduleRoot, dir))
        .filter((name) => name.toLowerCase().endsWith(".md") && !/explore/iu.test(name))
        .map((name) => `${dir}/${name}`);
    } catch {
      return [];
    }
  };

  const conclusions = REPORT_DIRS.flatMap((dir) => mdIn(dir));
  // "已经写出结论" = 除 spec 的规划文档以外,还有别的环节报告(那时 AC 声明的落点才该真的在)
  const concluded = conclusions.some((rel) => !rel.startsWith("spec/"));

  // ── ① spec 的 AC 行:证据位置是**声明**;声明的落点不存在时,只有"已经写出结论"才算问题 ──
  const specText = readIf("spec/spec.md");
  if (specText !== undefined) {
    const acLines = specText.split(/\r?\n/u).filter((line) => AC_ROW.test(line));
    for (const line of acLines) {
      const ac = AC_ROW.exec(line)?.[1] ?? "AC";
      for (const path of evidencePaths(line)) {
        if (existsSync(join(moduleRoot, path))) continue;
        const soft = !concluded || REGENERABLE.test(path);
        missing.push({
          file: "spec/spec.md",
          path,
          ac,
          hard: !soft,
          reason: !concluded
            ? `AC 声明的证据位置还不存在(${ac})—— 模块还没有结论文件,属"还没做到",不算错`
            : REGENERABLE.test(path)
              ? `AC 声明的证据位置现在不在(${ac})—— 那是可再生目录(约定跑一次就重生成),不判错`
              : `AC 声明的证据位置不存在(${ac})`
        });
      }
    }
  }

  // ── ② 结论文件(verif/*.md、synth/*.md)里引用的路径:报告写的"产物 / 依据"必须真的在 ──
  const changed = [];
  for (const rel of conclusions) {
    if (seen.has(rel) || rel === "spec/spec.md") continue;
    seen.add(rel);
    const text = readIf(rel);
    if (text === undefined) continue;
    const paths = evidencePaths(text);
    const digests = recordedDigests(text);
    files.push({ file: rel, paths });
    for (const path of paths) {
      const abs = join(moduleRoot, path);
      if (!existsSync(abs)) {
        missing.push({
          file: rel,
          path,
          ac: "",
          hard: !REGENERABLE.test(path),
          reason: REGENERABLE.test(path)
            ? `${rel} 引用的路径现在不在 —— 可再生目录,不判错`
            : `${rel} 引用了不存在的路径`
        });
        continue;
      }
      // ── ③ 依据的摘要对不上:报告写完之后那份依据**内容**变了(只警告,不判错)──
      if (!isEvidenceFile(moduleRoot, path)) continue;
      const recorded = digests.get(path);
      if (recorded === undefined) continue; // 没记过摘要 = 还没启用这一步,不猜
      const current = sha256Of(abs);
      if (current !== undefined && current !== recorded) changed.push({ file: rel, path, recorded, current });
    }
  }

  return { files, missing, changed, concluded };
}

/**
 * 器件一致性(用户口径 2026-09-21):模块 spec 与它所属**工程 spec** 写的器件必须一致。
 *
 * 为什么:器件只该有一处来源(工程 spec),模块 spec 重述一份迟早对不上 —— 而 RTL 与 IP 都按那个
 * 串生成(实测踩过:模块按 xcku3p 综合、IP 却是在 xc7a100t 工程里定制的 → IP 被锁、`module not found`)。
 * 工程根按本模式的布局找:模块根的**兄弟** `../project/spec/spec.md`(见 `setup-scaffold` 的工程骨架)。
 * @param moduleRoot - 模块根。
 * @returns `{ module?, project?, ok }`;两边都没写器件时为 `{ ok: true }`。
 */
export function deviceConsistency(moduleRoot) {
  const deviceIn = (path) => {
    try {
      const text = readFileSync(path, "utf8");
      // 器件串一律以 xc/zynq/… 开头?不猜:抓 "xc<字母数字>" 这种 Xilinx 器件串(AMD 也用它)
      return /(?:^|[^\w])(x[a-z]?\d[a-z0-9]*[a-z0-9-]*)/iu.exec(text)?.[1];
    } catch {
      return undefined;
    }
  };
  const moduleSpec = join(moduleRoot, "spec", "spec.md");
  const projectSpec = join(moduleRoot, "..", "project", "spec", "spec.md");
  const mine = existsSync(moduleSpec) ? deviceIn(moduleSpec) : undefined;
  const theirs = existsSync(projectSpec) ? deviceIn(projectSpec) : undefined;
  if (mine === undefined || theirs === undefined) return { module: mine, project: theirs, ok: true };
  return { module: mine, project: theirs, ok: mine.toLowerCase() === theirs.toLowerCase() };
}

/** 入口。 */
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法:node module-report-check.mjs [<模块目录>] [--json] [--record]");
    console.log("  --record  把当前引用的证据的 sha256 摘要写进报告文件末尾(可恢复覆盖,先留 .bak)");
    return 0;
  }
  const asJson = args.includes("--json");
  const record = args.includes("--record");
  const moduleRoot = args.find((arg) => !arg.startsWith("-")) ?? process.cwd();
  if (!existsSync(moduleRoot)) {
    console.error(`找不到模块目录:${moduleRoot}`);
    return 2;
  }

  if (record) {
    // 只做一件事:给每份结论文件写回"当前引用的证据 + 摘要"。不动别的,覆盖走可恢复写(留 .bak)。
    const written = [];
    for (const dir of REPORT_DIRS) {
      for (const rel of (() => {
        try {
          return readdirSync(join(moduleRoot, dir))
            .filter((name) => name.toLowerCase().endsWith(".md") && !/explore/iu.test(name))
            .map((name) => `${dir}/${name}`);
        } catch {
          return [];
        }
      })()) {
        const abs = join(moduleRoot, rel);
        const text = readFileSync(abs, "utf8");
        const entries = [];
        for (const path of evidencePaths(text)) {
          if (!isEvidenceFile(moduleRoot, path)) continue;
          const digest = sha256Of(join(moduleRoot, path));
          if (digest !== undefined) entries.push([path, digest]);
        }
        if (entries.length === 0 && !DIGEST_BLOCK.test(text)) continue;
        const next = withDigests(text, entries);
        if (next === text) continue;
        const snapshot = writeFileRecoverable(abs, next);
        written.push({ file: rel, count: entries.length, backup: snapshot });
      }
    }
    if (asJson) console.log(JSON.stringify({ recorded: written }, null, 2));
    else if (written.length === 0) console.log("没有可记录的依据(报告里没有引用到具体证据文件)。");
    else for (const item of written) console.log(`已记录 ${item.count} 条摘要 → ${item.file}${item.backup === undefined ? "" : `(旧版本留在 ${item.backup})`}`);
    return 0;
  }

  const { files, missing, changed, concluded } = auditReports(moduleRoot);
  const device = deviceConsistency(moduleRoot);
  const hard = missing.filter((entry) => entry.hard);
  const soft = missing.filter((entry) => !entry.hard);

  if (asJson) {
    console.log(JSON.stringify({ module: moduleRoot, concluded, files, missing, changed, device, failures: hard.length }, null, 2));
  } else {
    for (const entry of files) {
      const bad = missing.filter((item) => item.file === entry.file && item.hard).length;
      const moved = changed.filter((item) => item.file === entry.file).length;
      const notes = [bad === 0 ? "" : `缺 ${bad} 条`, moved === 0 ? "" : `${moved} 条依据的摘要变了`].filter((s) => s !== "");
      console.log(`${bad === 0 ? "ok  " : "FAIL"}  ${entry.file}  (引用 ${entry.paths.length} 条路径${notes.length === 0 ? "" : ` / ${notes.join(" / ")}`})`);
    }
    for (const item of missing) {
      console.log(`        ${item.hard ? "FAIL" : "info"}  ${item.file} → ${item.path}  ${item.reason}`);
    }
    for (const item of changed) {
      console.log(`        warn  ${item.file} → ${item.path}  依据的摘要变了(内容与记录不符)—— 确认结论是否还成立,确认后跑 --record 更新`);
    }
    if (!device.ok) {
      console.log(`        warn  spec/spec.md 器件(${String(device.module)})与工程 spec 器件(${String(device.project)})不一致 —— 器件以工程 spec 为准(模块 spec 不重述)`);
    }
    const notes = [];
    if (soft.length > 0) notes.push(`${soft.length} 条"可再生 / 还没做到"`);
    if (changed.length > 0) notes.push(`${changed.length} 条"摘要变了"`);
    if (!device.ok) notes.push("器件两处不一致");
    console.log(
      hard.length === 0
        ? `\nPASS: 引用的证据路径都在${notes.length > 0 ? `(另有 ${notes.join("、")},见上面 info/warn)` : ""}`
        : `\nFAIL (${hard.length} 条:报告/AC 引用了不存在的证据路径)`
    );
  }
  return hard.length === 0 ? 0 : 1;
}

/** 直接跑本文件时才进 CLI;被 import 时只导出上面的函数。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main();
}
