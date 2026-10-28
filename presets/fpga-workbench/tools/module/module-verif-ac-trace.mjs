#!/usr/bin/env node
/**
 * AC（验收条件）覆盖追踪：spec 里的每条 AC 是否在验证报告里有对应用例与证据。
 *
 * ## 为什么需要它
 *
 * 行业签核惯例（ChipVerify 六道门）把「功能覆盖」列为最难通过、也最不能糊弄的一道：
 * 代码覆盖 95% 可以接受（剩余通常是复位 / 防御分支），但**功能点没覆盖就是没验** ——
 * `95% × 10 条 AC = 9.5 条` 这个数字本身不可解释。所以 AC 的门槛是 **100%**
 * （明确标注「不适用于本版本」的条目可剔除，但要写依据）。
 *
 * `module-coverage.mjs` 管代码覆盖，本命令管功能覆盖，两者互补。
 *
 * ## AC 的写法（**宽松解析**，不强制表格）
 *
 * `setup-scaffold` 刻意不预置 spec（报告由讨论产出），所以 AC 没有既定格式。
 * 这里认多种常见写法，只要能识别出「ID + 描述」：
 *
 * ```
 * | ID   | 验收条件            | 验证方法        |     ← 表格（推荐，能带验证方法）
 * | AC-1 | 复位后 q 归零       | 仿真：tb_reset  |
 *
 * - AC-1: 复位后 q 归零                                ← 列表
 * - AC1 —— 复位后 q 归零                               ← 无连字符 + 破折号
 * 1. AC-1 复位后 q 归零                                 ← 有序列表
 * **AC-1** 复位后 q 归零                                ← 加粗
 * ```
 *
 * ## 覆盖判据
 *
 * 一条 AC 算「已覆盖」要**同时**满足：
 *   1. spec 里能解析出这条 AC；
 *   2. `verif/verif.md`（或 `doc/verif.md`）里**提到了它的 ID**。
 *
 * 只验「报告提到过」是必要的下限 —— 报告有没有真的执行、证据是否充分，由技能
 * 按判据判，工具不替它下结论（与 `module-report-check` 同一条口径：只验存在）。
 *
 * ## 用法
 *
 * ```
 * node module-ac-trace.mjs <模块根>              # 读 spec/spec.md + verif/verif.md
 * node module-ac-trace.mjs <模块根> --spec <path> --report <path>
 * node module-ac-trace.mjs <模块根> --json
 * ```
 *
 * 退出码：0 = 全部 AC 有对应记录；1 = 有遗漏（结论应为 UNVERIFIED）；2 = 用法/输入错误。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** spec 的候选位置（模块级 spec/ ，工程级 doc/）。 */
const SPEC_CANDIDATES = ["spec/spec.md", "doc/spec.md", "spec.md"];

/** 验证报告的候选位置。 */
const REPORT_CANDIDATES = ["verif/verif.md", "doc/verif.md", "verif.md"];

/** 「不适用于本版本」的标记：含这些词的 AC 不计入门槛，但会单独列出。 */
const WAIVED = /(?:不适用|不涉及|本版不做|本版本不做|已废弃|N\/A|NA\b|not[ -]applicable|deferred|out[ -]of[ -]scope)/iu;

const usage = () => {
  console.error("用法：node module-ac-trace.mjs <模块根> [--spec <路径>] [--report <路径>] [--json]");
  console.error("");
  console.error("  <模块根>       含 spec/ 与 verif/ 的目录");
  console.error("  --spec        spec 文件路径（默认自动找 spec/spec.md → doc/spec.md）");
  console.error("  --report      验证报告路径（默认 verif/verif.md → doc/verif.md）");
  console.error("  --json        输出机器可读 JSON");
  console.error("");
  console.error("AC 覆盖门槛是 100%：功能点没覆盖就是没验，不能像代码覆盖那样打折。");
  process.exit(2);
};

const parseArgs = (argv) => {
  const options = { root: "", spec: "", report: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--spec") {
      options.spec = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--report") {
      options.report = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--")) {
      console.error(`未知选项：${arg}`);
      usage();
    } else if (options.root === "") {
      options.root = arg;
    }
  }
  if (options.root === "") usage();
  return options;
};

/** 找第一个存在的候选文件。 */
const firstExisting = (root, candidates) => {
  for (const rel of candidates) {
    const full = join(root, rel);
    if (existsSync(full)) return full;
  }
  return "";
};

/**
 * 从 spec 文本里解析 AC 条目。
 *
 * 宽松匹配：行内出现 `AC` + 编号（允许 `AC-1` / `AC1` / `AC_1` / `AC 1`），
 * 后面跟分隔符（`:` `：` `|` `——` `-` `)` `.` 空格）再跟描述。
 *
 * 表格行按 `|` 切分后取「含 AC 的格子」当 ID、下一个格子当描述；
 * 非表格行取 AC 之后到行尾当描述。
 * @param text - spec 全文。
 * @returns `[{ id, description, line }]`（按出现顺序、ID 去重）。
 */
const parseAcceptanceCriteria = (text) => {
  const found = [];
  const seen = new Set();

  /**
   * **先统一换行符**（2026-10-28 实测踩到）：
   * CRLF 文件里行尾留下的 `\r` 会让正则末尾的 `(.*)$` 匹配失败 ——
   * JS 的 `$` 只在 `\n` 前成立，`\r` 不是行尾字符，而 `.` 又不匹配它
   * （`.` 排除的是 `\n` `\r` 等行终止符）。表现是「某些行整行解析不出来」，
   * 且只在**最后一行**或 CRLF 文件里出现，极难定位。
   */
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];

    // 表格行：| AC-1 | 描述 | 方法 |
    if (/^\s*\|/u.test(raw)) {
      const cells = raw.split("|").map((cell) => cell.trim());
      const idCell = cells.find((cell) => /^AC[-_ ]?\d+/iu.test(cell));
      if (idCell === undefined) continue;
      const idMatch = /^(AC[-_ ]?\d+)/iu.exec(idCell);
      if (idMatch === null) continue;
      const id = normalizeId(idMatch[1]);
      if (seen.has(id)) continue;
      seen.add(id);

      const inline = idCell.slice(idMatch[0].length).replace(/^[\s:：|—-]+/u, "").trim();
      let description = inline;
      const restCells = cells.slice(cells.indexOf(idCell) + 1).filter((cell) => cell !== "" && !/^:?-+:?$/u.test(cell));
      if (description === "" && restCells.length > 0) {
        description = restCells[0];
      }
      /**
       * 「不适用」标记可能写在**任意一格**里（描述列或验证方法列都常见，
       * 例如 `| AC-5 | 上板指示灯 | 不适用于本版本 |`）。
       * 所以把整行的所有格子拼起来判，不是只看描述。
       */
      const rowText = cells.join(" ");
      found.push({
        id,
        description: description === "" ? "(未写描述)" : description,
        line: index + 1,
        rowText
      });
      continue;
    }

    // 非表格：AC 出现在行内任何位置。
    // 分隔符允许 `-` `_` 空格或不带（`AC-1` / `AC_1` / `AC 1` / `AC1`），
    // 但要求前面是行首或非字母数字，避免把 `MACADDR1` 之类误当成 AC。
    const match = /(?:^|[^A-Za-z0-9])(AC[-_ ]?\d+)\b[\s:：|—–-]*(.*)$/iu.exec(raw);
    if (match === null) continue;
    const id = normalizeId(match[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    const description = match[2].replace(/^\*\*|\*\*$/gu, "").replace(/^[\s:：|—-]+/u, "").trim();
    found.push({
      id,
      description: description === "" ? "(未写描述)" : description,
      line: index + 1,
      // 非表格行整行就是描述 + 可能的备注，直接用整行
      rowText: raw
    });
  }

  return found;
};

/** 统一 ID 形态：`AC 1` / `ac_1` / `AC-1` → `AC-1`。 */
const normalizeId = (raw) => `AC-${/\d+/u.exec(raw)?.[0] ?? "?"}`;

/**
 * 判断一条 AC 在报告里是否**有记录**。
 *
 * 只认「报告里出现该 ID」—— 报告的结论是否可信、证据是否充分由技能判，
 * 工具不越界（与 `module-report-check` 同口径）。
 * @param id - 规范化后的 AC ID。
 * @param reportText - 验证报告全文。
 * @returns 是否提到。
 */
const mentionedInReport = (id, reportText) => {
  const number = /\d+/u.exec(id)?.[0] ?? "";
  if (number === "") return false;
  // 报告里可能写 AC-1 / AC1 / ac_1 —— 用宽松正则，但要求是独立编号
  return new RegExp(`\\bAC[-_ ]?${number}\\b`, "iu").test(reportText);
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root);
  if (!existsSync(root)) {
    console.error(`模块根不存在：${root}`);
    process.exit(2);
  }

  const specPath = options.spec !== "" ? resolve(options.spec) : firstExisting(root, SPEC_CANDIDATES);
  if (specPath === "" || !existsSync(specPath)) {
    console.error("找不到 spec。候选位置：");
    for (const rel of SPEC_CANDIDATES) console.error(`  ${join(root, rel)}`);
    console.error("");
    console.error("用 `--spec <路径>` 显式指定，或先把 AC 写进 spec（见 fpga-module-spec）。");
    process.exit(2);
  }

  const reportPath = options.report !== "" ? resolve(options.report) : firstExisting(root, REPORT_CANDIDATES);
  const reportText = reportPath !== "" && existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";

  const specText = readFileSync(specPath, "utf8");
  const criteria = parseAcceptanceCriteria(specText);

  if (criteria.length === 0) {
    console.error(`spec 里没解析出任何 AC：${specPath}`);
    console.error("");
    console.error("AC 要能识别出 ID，常见写法都支持：");
    console.error("  | ID   | 验收条件        | 验证方法 |");
    console.error("  | AC-1 | 复位后 q 归零   | 仿真     |");
    console.error("  - AC-1: 复位后 q 归零");
    console.error("");
    console.error("没有 AC 就无法判「功能是否验全」—— 先补 spec，再谈覆盖。");
    process.exit(2);
  }

  const rows = criteria.map((item) => {
    // 「不适用」标记可能落在描述列或验证方法列 —— 用整行文本判（见 parseAcceptanceCriteria）。
    const waived = WAIVED.test(item.rowText ?? item.description);
    const mentioned = mentionedInReport(item.id, reportText);
    return {
      id: item.id,
      description: item.description,
      line: item.line,
      waived,
      mentioned,
      covered: waived || mentioned
    };
  });

  const gated = rows.filter((row) => !row.waived);
  const covered = gated.filter((row) => row.mentioned);
  const missing = gated.filter((row) => !row.mentioned);
  const waived = rows.filter((row) => row.waived);
  const passed = missing.length === 0;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          root,
          spec: specPath,
          report: reportPath === "" ? null : reportPath,
          total: rows.length,
          gated: gated.length,
          covered: covered.length,
          missing: missing.map((row) => ({ id: row.id, description: row.description })),
          waived: waived.map((row) => ({ id: row.id, description: row.description })),
          passed
        },
        null,
        2
      )
    );
  } else {
    console.log(`AC 覆盖追踪  ${basename(root)}`);
    console.log(`  spec：${specPath}`);
    console.log(`  报告：${reportPath === "" ? "（找不到验证报告）" : reportPath}`);
    console.log("");
    for (const row of rows) {
      const mark = row.waived ? "⊘" : row.mentioned ? "✅" : "❌";
      const suffix = row.waived ? "  [不适用，已剔除]" : row.mentioned ? "" : "  ← 报告里没有记录";
      console.log(`  ${mark} ${row.id}  ${row.description.slice(0, 60)}${suffix}`);
    }
    console.log("");
    console.log(`  计入门槛：${String(gated.length)} 条（另有 ${String(waived.length)} 条标注不适用，已剔除）`);
    console.log(`  已覆盖：${String(covered.length)}/${String(gated.length)}`);
    console.log("");

    if (passed) {
      console.log("  ✅ AC 覆盖 100% —— 功能覆盖这道门可以过。");
      if (waived.length > 0) {
        console.log("");
        console.log(`  被剔除的 ${String(waived.length)} 条要在 verif.md 里写明依据（为什么本版本不适用）。`);
      }
    } else {
      console.log(`  ❌ 未达 100%：${String(missing.length)} 条 AC 在报告里没有记录。`);
      console.log("");
      console.log("  行业惯例：功能覆盖必须关闭，不能像代码覆盖那样打折 ——");
      console.log("  `95% × 10 条 AC = 9.5 条` 这个数字本身不可解释。");
      console.log("");
      console.log("  处理方式（二选一）：");
      console.log("    · 补用例，并在 verif.md 里写清该 AC 由哪个用例 / 证据覆盖；");
      console.log("    · 确认它对本版本确实不适用，在 spec 的 AC 描述里标注");
      console.log("      「不适用于本版本」+ 依据，工具会把它剔除（而不是当成已覆盖）。");
      console.log("");
      console.log("  注意：「实际使用中不太可能」不是有效理由 —— 行业规范明确这一点。");
    }
  }

  process.exit(passed ? 0 : 1);
};

main();
