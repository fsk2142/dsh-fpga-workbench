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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { evidencePathInside, realEscape, writeFileRecoverable } from "../lib/stamp.mjs";
// 器件从 spec 里怎么读,**复用综合脚本那一套**(不各写一份,免得两个工具读法不一致)
import { fieldsFromSpec, readSpecFields } from "./module-synth-new.mjs";

/** 结论文件所在的环节目录(只扫顶层 `*.md`;`explore/`、`work/` 那些中间产物不看)。 */
const REPORT_DIRS = ["spec", "verif", "synth"];

/** 报告里会被引用的路径前缀 —— 只认这四个环节目录,别的(如 `C:\...`、`../x`)不当证据路径。 */
const EVIDENCE_PREFIX = /^(?:spec|rtl|verif|synth)[\\/]/u;

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
  // 注意返回的是**字符串数组**(调用方直接 join/存在性判断);带 `safe` 标记的那份是 evidenceTokens
  return evidenceTokens(text).filter((token) => token.safe).map((token) => token.raw);
}

/**
 * 抽反引号里的证据路径,**并标出哪些是"不许引用"的越界写法**。
 *
 * 越界(N-05,第三轮复审):证据路径必须留在模块根里面 —— `verif/../../secrets.txt` 这种以前会被
 * 当普通路径核、`--record` 还会**读模块外的文件**去算摘要。现在:含 `..` 段、绝对路径、含 NUL 的
 * 一律标 `safe: false`,由调用方如实报"不许这样引用"(而不是默默当它存在/不存在)。
 * @param text - 文件正文。
 * @returns `{ raw, safe }[]`(去重,保持出现顺序;行号后缀已摘掉)。
 */
export function evidenceTokens(text) {
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    let raw = match[1].trim();
    if (!EVIDENCE_PREFIX.test(raw)) continue;
    if (raw.includes("<") || raw.includes("*") || /\s/u.test(raw)) continue;
    // Windows 反斜杠写法(`verif\run.do`)也算引用 —— 统一成 `/` 再核(第五轮 2.6:只认正斜杠时,
    // 手写报告里的反斜杠路径整条抽不出来,存在性检查等于没跑)
    raw = raw.replace(/\\/gu, "/").replace(LINE_SUFFIX, "");
    if (raw === "" || seen.has(raw)) continue;
    seen.add(raw);
    out.push({ raw, safe: isSafeRelative(raw) });
  }
  return out;
}

/**
 * 这条相对路径能不能当证据引用:必须是**模块根内部**的相对路径。
 *
 * 判据:非绝对路径(含盘符 / UNC)、任何一段不是 `..`、不含 NUL。`..` 一律拒绝 —— 模块内的证据
 * 引用没有需要往上跳的正当理由,而放行它就能读到模块外(复审 N-05)。
 * @param path - 反引号里摘出来的字符串(模块根相对)。
 * @returns 安全时为 true。
 */
/**
 * 这条相对路径**真实落在模块根里面**吗(junction / symlink 也能识破)。
 *
 * 第四轮复审 Q4-07:词法检查(`isSafeRelative`)挡不住"模块内的链接指向模块外" —— 实测:`verif/linked`
 * 是指向模块外目录的 junction 时,`verif/linked/sample.txt` 字面上没问题,`--record` 却会**读模块外文件**
 * 并给它记摘要。这里复用 `stamp.mjs` 的 `realEscape`(只做两次 realpath:模块根 + 目标最近的已存在父路径),
 * 真实落点在外面就返回 false,调用方据此 FAIL 且**不对它做 existsSync / statSync / readFileSync**。
 * @param moduleRoot - 模块根(词法路径)。
 * @param rel - 模块根相对路径(`/` 分隔,已过 `isSafeRelative`)。
 * @returns 真实落点在模块根内时为 true。
 */
export function staysInsideModule(moduleRoot, rel) {
  // E8-01:最终文件 symlink 也要拒;不存在的路径只做形式/父目录检查
  return evidencePathInside(moduleRoot, rel);
}
export function isSafeRelative(path) {
  if (path.includes("\u0000")) return false;
  if (isAbsolute(path) || /^[A-Za-z]:/u.test(path) || path.startsWith("\\\\")) return false;
  return !path.split(/[\\/]+/u).includes("..");
}

/**
 * 摘要块:`--record` 写进报告末尾的"依据 + sha256"清单。
 *
 * 为什么不用 mtime(实测):mtime 版会把"重跑了一次工具"之后的每个输出文件都报一遍(某模块一次
 * 14 条),而绝大多数内容根本没变 —— 那种量级的警告几天就没人看了。摘要只认内容。
 */
/**
 * 摘要块:**单次读取**用不带 `g` 的实例,**整段删除**用带 `g` 的实例。
 *
 * 第五轮 F5-01:带 `g` 的正则 `exec()`/`test()` 共享 `lastIndex`,同一文本连续调用会
 * `true → false → true → false` 静默漏读(实测)。读摘要与清摘要必须拆开,且每份报告
 * 只解析一次(调用方先取 Map,循环里查 Map,不要在证据循环里反复 exec)。
 */
const DIGEST_BLOCK_ONE = /<!-- evidence-digest:start -->([\s\S]*?)<!-- evidence-digest:end -->/u;
const DIGEST_BLOCK_ALL = /<!-- evidence-digest:start -->([\s\S]*?)<!-- evidence-digest:end -->/gu;

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

/**
 * 从报告正文里读回摘要块(`{ path: sha256 }`)。
 *
 * 多块时**全部合并**(后块覆盖前块同名路径);写回时 `withDigests` 会收成一块。
 * 连续调用结果必须稳定 —— 不用带 `g` 的共享实例做 `.exec()`(F5-01)。
 */
export function recordedDigests(text) {
  const out = new Map();
  for (const match of String(text ?? "").matchAll(DIGEST_BLOCK_ALL)) {
    const block = match[1] ?? "";
    for (const line of block.split(/\r?\n/u)) {
      const parsed = /^\s*(\S+)\s+sha256=([0-9a-f]{64})\s*$/u.exec(line);
      if (parsed !== null) out.set(parsed[1], parsed[2]);
    }
  }
  return out;
}

/** 把摘要块写进报告正文(已有块就替换,没有就追加;多块收成一块)。 */
export function withDigests(text, entries) {
  const block = [
    "<!-- evidence-digest:start -->",
    ...entries.map(([path, digest]) => `${path}  sha256=${digest}`),
    "<!-- evidence-digest:end -->",
    ""
  ].join("\n");
  const body = String(text ?? "").replace(DIGEST_BLOCK_ALL, "").replace(/\n*$/u, "\n");
  return `${body}\n${block}`;
}

/** 报告里是否已有摘要块(单次判断,不用共享 `g` 实例的 `.test()`)。 */
export function hasDigestBlock(text) {
  return DIGEST_BLOCK_ONE.test(String(text ?? ""));
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
  // "已经写出结论" = `verif/` 或 `synth/` 里有一份**真的写了结论**的报告 —— 判据是文件里有 `结论:` 行
  // (用户口径:结论文件的判据就是那一行)。只有 `debug.md` 这种草稿、或空文件时不算"已经写出结论"。
  // (第三轮复审 N-09:以前只要有 `verif/` 或 `synth/` 下任何 .md,AC 里缺证据就直接判 FAIL —— 草稿也会触发。)
  const concluded = conclusions.some(
    (rel) => !rel.startsWith("spec/") && /^\s*结论\s*[:：]/mu.test(readIf(rel) ?? "")
  );

  // 越界引用(含 `..` / 绝对路径):一律如实报,不算"存在与否"的问题(复审 N-05)
  const invalid = [];
  const noteInvalid = (file, token, ac, reason) => {
    invalid.push({ file, path: token.raw, ac, reason: reason ?? "证据路径必须留在模块根里面(不许 `..` / 绝对路径)" });
  };

  // ── ① spec 的 AC 行:证据位置是**声明**;声明的落点不存在时,只有"已经写出结论"才算问题 ──
  const specText = readIf("spec/spec.md");
  if (specText !== undefined) {
    const acLines = specText.split(/\r?\n/u).filter((line) => AC_ROW.test(line));
    for (const line of acLines) {
      const ac = AC_ROW.exec(line)?.[1] ?? "AC";
      for (const token of evidenceTokens(line)) {
        if (!token.safe) {
          noteInvalid("spec/spec.md", token, ac);
          continue;
        }
        const path = token.raw;
        // 真实落点也必须在模块里(junction / symlink 能骗过词法检查 —— 第四轮复审 Q4-07)
        if (!staysInsideModule(moduleRoot, path)) {
          noteInvalid("spec/spec.md", token, ac, `证据路径的真实落点越出模块根(junction/symlink):${path}`);
          continue;
        }
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
    const paths = [];
    // 这份报告**写出结论**了吗:写了才算"给判定撑腰的文档",它引用的路径缺失才是错。
    // 草稿(没有 `结论:` 行)里引用还没落地的路径是正常的 —— 以前不分青红皂白判 FAIL(复审 N-09)。
    const isConclusion = /^\s*结论\s*[:：]/mu.test(text);
    // 每份报告只解析一次摘要(F5-01):循环里反复 exec 共享 /g 正则会交替漏读
    const digests = recordedDigests(text);
    for (const token of evidenceTokens(text)) {
      if (!token.safe) {
        noteInvalid(rel, token, "");
        continue;
      }
      if (!staysInsideModule(moduleRoot, token.raw)) {
        noteInvalid(rel, token, "", `证据路径的真实落点越出模块根(junction/symlink):${token.raw}`);
        continue;
      }
      paths.push(token.raw);
      const path = token.raw;
      const abs = join(moduleRoot, path);
      if (!existsSync(abs)) {
        const soft = !isConclusion || REGENERABLE.test(path);
        missing.push({
          file: rel,
          path,
          ac: "",
          hard: !soft,
          reason: !isConclusion
            ? `${rel} 引用的路径现在不在 —— 这份还没写结论(草稿),只提示、不判错`
            : REGENERABLE.test(path)
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
    files.push({ file: rel, paths });
  }

  return { files, missing, changed, invalid, concluded, checkedPaths: files.reduce((sum, entry) => sum + entry.paths.length, 0) };
}

/**
 * 器件一致性(用户口径 2026-09-21):模块 spec 与它所属**工程 spec** 写的器件必须一致。
 *
 * 为什么:器件只该有一处来源(工程 spec),模块 spec 重述一份迟早对不上 —— 而 RTL 与 IP 都按那个
 * 串生成(实测踩过:模块按 xcku3p 综合、IP 却是在 xc7a100t 工程里定制的 → IP 被锁、`module not found`)。
 * 工程根按锚点找:从模块根向上找到 `kind: project`,再读该工程的 `doc/spec.md`。
 * @param moduleRoot - 模块根。
 * @returns `{ module?, project?, ok }`;两边都没写器件时为 `{ ok: true }`。
 */
export function deviceConsistency(moduleRoot) {
  // 读法与综合脚本**共用**(`fieldsFromSpec`):先认写着「器件 / device / part」的字段行、只认唯一候选。
  // 老写法是"全文第一条 xc…",两个毛病(第三轮复审 N-04):① `xcku040-ffva1156-2-e` 这类
  // UltraScale 型号(字母两三位)匹配不上,解析结果 undefined → 检查**静默不报**;
  // ② 全文第一条未必是目标器件(附录、备选、引用别的工程都会先出现)。
  const mine = fieldsFromSpec(join(moduleRoot, "spec", "spec.md")).part;
  const projectSpecPath = readSpecFields(moduleRoot).projectSpecPath;
  const theirs = projectSpecPath === undefined ? undefined : fieldsFromSpec(projectSpecPath).part;
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
    //
    // **先看再写**(第三轮复审 N-08):已经记过摘要、而那份依据**内容变了**时,直接 `--record` 等于
    // 把"变了"这件事一笔勾销 —— 那正是本工具要抓的"结论还成立吗"。这种文件默认**不写**,
    // 列出来让人先判断;确实确认过、要接受新版本,再加 `--accept-changed`。
    const acceptChanged = args.includes("--accept-changed");
    // 第四轮 Q4-10:`--record` 先做与检查模式**同一套**的路径合法性预检 —— 报告里有字面越界或
    // 真实落点越界的引用时**拒绝写入**,别让"记录成功"掩盖"报告里有不合法引用"
    // (命令成功 ≠ 报告合规)。顺带把"引用了但找不到"的条数报出来(info,不拦)。
    const illegalRefs = [];
    let absentRefs = 0;
    const scanRel = ["spec/spec.md"];
    for (const dir of REPORT_DIRS) {
      try {
        for (const name of readdirSync(join(moduleRoot, dir))) {
          if (name.toLowerCase().endsWith(".md") && !/explore/iu.test(name)) scanRel.push(`${dir}/${name}`);
        }
      } catch {
        /* 目录不在:没有可扫的 */
      }
    }
    for (const rel of scanRel) {
      if (!existsSync(join(moduleRoot, rel))) continue;
      const text = readFileSync(join(moduleRoot, rel), "utf8");
      for (const token of evidenceTokens(text)) {
        if (!token.safe || !staysInsideModule(moduleRoot, token.raw)) {
          illegalRefs.push(`${rel} → ${token.raw}`);
          continue;
        }
        if (!existsSync(join(moduleRoot, token.raw))) absentRefs += 1;
      }
    }
    if (illegalRefs.length > 0) {
      console.error("报告里有**不合法/越界**的证据引用,--record 拒绝写入(先修引用再记摘要):");
      for (const item of illegalRefs) console.error(`  ${item}`);
      return 1;
    }
    if (absentRefs > 0) {
      console.error(`注意:有 ${absentRefs} 条引用的路径现在找不到 —— 摘要只记**存在的**那些(不存在的仍旧不记)。`);
    }
    const targets = [];
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
        const text = readFileSync(join(moduleRoot, rel), "utf8");
        const entries = [];
        const stale = [];
        const skippedUnsafe = [];
        const digests = recordedDigests(text); // 每份报告只解析一次(F5-01)
        for (const path of evidencePaths(text)) {
          // --record 同样**不许读模块外**(Q4-07):真实落点越界就跳过,不 stat、不 readFileSync
          if (!staysInsideModule(moduleRoot, path)) {
            skippedUnsafe.push(path);
            continue;
          }
          if (!isEvidenceFile(moduleRoot, path)) continue;
          const digest = sha256Of(join(moduleRoot, path));
          if (digest === undefined) continue;
          entries.push([path, digest]);
          const recorded = digests.get(path);
          if (recorded !== undefined && recorded !== digest) stale.push(path);
        }
        if (entries.length === 0 && !hasDigestBlock(text)) continue;
        targets.push({ rel, text, entries, stale, skippedUnsafe });
      }
    }
    const unsafe = targets.filter((item) => item.skippedUnsafe.length > 0);
    if (unsafe.length > 0) {
      console.error("这些报告引用了**越出模块根**的路径(真实落点在外面),不记摘要:");
      for (const item of unsafe) console.error(`  ${item.rel} → ${item.skippedUnsafe.join("、")}`);
    }
    const blocked = targets.filter((item) => item.stale.length > 0);
    if (blocked.length > 0 && !acceptChanged) {
      console.error("这些报告引用的依据**内容变了**,不自动盖章(先确认结论还成不成立):");
      for (const item of blocked) console.error(`  ${item.rel} → ${item.stale.join("、")}`);
      console.error("确认过、要接受新版本:再加 --accept-changed 重跑。");
      return 1;
    }
    const written = [];
    for (const item of targets) {
      const next = withDigests(item.text, item.entries);
      if (next === item.text) continue;
      const snapshot = writeFileRecoverable(join(moduleRoot, item.rel), next);
      written.push({ file: item.rel, count: item.entries.length, backup: snapshot, acceptedChanged: item.stale });
    }
    if (asJson) console.log(JSON.stringify({ recorded: written, acceptedChanged: blocked.map((item) => item.rel) }, null, 2));
    else if (written.length === 0) console.log("没有可记录的依据(报告里没有引用到具体证据文件)。");
    else for (const item of written) console.log(`已记录 ${item.count} 条摘要 → ${item.file}${item.backup === undefined ? "" : `(旧版本留在 ${item.backup})`}${item.acceptedChanged.length === 0 ? "" : `(**接受**了变更的依据:${item.acceptedChanged.join("、")})`}`);
    return 0;
  }

  const { files, missing, changed, invalid, concluded, checkedPaths } = auditReports(moduleRoot);
  const device = deviceConsistency(moduleRoot);
  const hard = [...invalid, ...missing.filter((entry) => entry.hard)];
  const soft = missing.filter((entry) => !entry.hard);
  // 一份"什么都没有"的检查**不是通过**(第三轮复审 N-03):没报告、或有报告但一条证据都没引用,
  // 都要有自己的一句话,不能说 PASS。
  const status = files.length === 0 ? "no-reports" : checkedPaths === 0 ? "no-evidence" : "checked";

  if (asJson) {
    console.log(JSON.stringify({
      module: moduleRoot, status, concluded, checkedPaths, files, missing, invalid, changed, device, failures: hard.length
    }, null, 2));
  } else {
    for (const entry of files) {
      const bad = [...invalid, ...missing].filter((item) => item.file === entry.file && (item.hard ?? true)).length;
      const moved = changed.filter((item) => item.file === entry.file).length;
      const notes = [bad === 0 ? "" : `缺 ${bad} 条`, moved === 0 ? "" : `${moved} 条依据的摘要变了`].filter((s) => s !== "");
      console.log(`${bad === 0 ? "ok  " : "FAIL"}  ${entry.file}  (引用 ${entry.paths.length} 条路径${notes.length === 0 ? "" : ` / ${notes.join(" / ")}`})`);
    }
    for (const item of invalid) {
      console.log(`        FAIL  ${item.file} → ${item.path}  ${item.reason}`);
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
    const summary = [
      `${hard.length} 条:报告/AC 引用了不存在或越界的证据路径`,
      invalid.length > 0 ? `其中 ${invalid.length} 条越界(不许 \`..\` / 绝对路径 / junction 真实落点)` : ""
    ].filter((s) => s !== "").join(",");
    console.log(
      hard.length === 0
        ? status === "no-reports"
          ? "\nNO_REPORTS: 这个模块还没有 spec / 结论文件 —— 没有证据路径可核(这**不是**通过)"
          : status === "no-evidence"
            ? "\nNO_EVIDENCE: 有文件,但一条证据路径都没引用 —— 没有可核的东西(**不是**通过;要么还没写证据,要么写法不对)"
            : `\nPASS: 引用到的 ${checkedPaths} 条证据路径都在 —— 只证明"路径存在"(内容对不对、功能过没过不归本工具判)${notes.length > 0 ? `(另有 ${notes.join("、")},见上面 info/warn)` : ""}`
        : `\nFAIL (${summary})`
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
