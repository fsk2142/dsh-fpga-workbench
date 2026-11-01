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
 * `module-verif-coverage.mjs` 管代码覆盖，本命令管功能覆盖，两者互补。
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
 * node module-verif-ac-trace.mjs <模块根>              # 读 spec/spec.md + verif/verif.md
 * node module-verif-ac-trace.mjs <模块根> --spec <path> --report <path>
 * node module-verif-ac-trace.mjs <模块根> --json
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

/**
 * 「不适用于本版本」的标记：含这些词的 AC 不计入门槛，但会单独列出。
 *
 * ## R06：两道修正
 *
 * **① `NA` 必须有左边界。**
 * 原来是 `NA\b` —— `\b` 只管右边，于是 `DNA` 尾部的 `NA` 也命中，
 * 「对 DNA 输入做校验」这种**正经需求**被当成"不适用"豁免掉了。
 * 现在两侧都要边界：`\bNA\b`。
 *
 * **② 不从任意描述词推断豁免。**
 * `不适用` / `不涉及` 这类词在自然语言里太容易出现在**肯定句**中：
 *
 * ```
 * AC-1: 非法输入不适用正常路径，必须报错
 * ```
 *
 * 这句**要求报错**，却因为含「不适用」被豁免 —— 完全没有用例、没有记录，
 * 需求就从门槛里消失了。
 *
 * 豁免必须**显式标记**。支持两种写法（见 `isExplicitlyWaived`）：
 * - 行内标记：`AC-1: ... [不适用]` / `[NOT_APPLICABLE]` / `[N/A]`
 * - 状态词开头：`AC-1（不适用）: ...`
 *
 * 光凭句子里出现「不适用」三个字不算。
 */
const WAIVED = /(?:\[(?:不适用|不涉及|NOT[ _-]?APPLICABLE|N\/A)\]|[（(](?:不适用|不涉及|NOT[ _-]?APPLICABLE|N\/A)[)）]|\bNA\b|not[ -]applicable|out[ -]of[ -]scope)/iu;

const usage = () => {
  console.error("用法：node module-verif-ac-trace.mjs <模块根> [--spec <路径>] [--report <路径>] [--json]");
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

    // 非表格行：**只认「结构化上下文」里的 AC**（§C7）。
    //
    // 为什么收紧：早期版本接受行内任意位置的 `AC 3`，于是散文
    // 「…满足 AC 3 项指标…」会被解析成一条幻影 AC-3，计入门槛后造成假 FAIL。
    //
    // 现在要求 AC 编号出现在行首（可带列表/引用/加粗等前缀），且后面紧跟分隔符
    // （`:` `：` 或至少一个空格再跟正文）。这样：
    //   `- AC-1: 复位后归零`         ✅ 列表项
    //   `**AC-4** 参数化位宽`        ✅ 加粗开头
    //   `AC 5 上电自检`              ✅ 行首
    //   `…满足 AC 3 项指标…`         ❌ 散文中间，不收
    const leading = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)?\**\s*(AC[-_ ]?\d+)\**\s*[:：]\s*(.*)$/iu.exec(raw)
      ?? /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)?\**\s*(AC[-_ ]?\d+)\**\s+(.*)$/iu.exec(raw);
    if (leading === null) continue;
    const id = normalizeId(leading[1]);
    if (seen.has(id)) continue;

    // 描述为空的（只有 `AC-1` 单独一行）也收 —— 那是占位待填，不是幻影。
    const description = leading[2].replace(/^\*\*|\*\*$/gu, "").replace(/^[\s:：|—-]+/u, "").trim();
    seen.add(id);
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

  /**
   * **R06 第二半：全豁免不能冒充"完成验证"。**
   *
   * 原来 `passed = missing.length === 0`。当所有 AC 都被标成"不适用"时，
   * `gated` 为空 → `missing` 也为空 → `passed = true`、退 0，
   * 还打印「功能覆盖这道门可以过」。
   *
   * 但那时**一条 AC 都没验**。这与技能里「AC 追溯不等于功能覆盖」的说法
   * 也直接冲突 —— 用户看到 100% 会以为功能覆盖过了。
   *
   * 现在分三档：
   *   - 有条目且全被豁免（gated === 0 && waived > 0）→ NOT_APPLICABLE，退 3
   *   - spec 里一条 AC 都没解析出来 → 输入不足，退 2
   *   - 其余按 missing 判
   */
  const allWaived = gated.length === 0 && waived.length > 0;
  const noAcceptance = rows.length === 0;
  const passed = !allWaived && !noAcceptance && missing.length === 0;

  /** 结论三档：PASS / NOT_APPLICABLE（全豁免）/ UNVERIFIED（有遗漏）。 */
  const verdict = passed ? "PASS" : allWaived ? "NOT_APPLICABLE" : "UNVERIFIED";

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
          /** 全部 AC 都被标成不适用 —— 这不是"通过"，是"没验"。 */
          allWaived,
          verdict,
          passed
        },
        null,
        2
      )
    );
  } else {
    console.log(`AC 记录追溯  ${basename(root)}`);
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
      // **不再说「功能覆盖这道门可以过」** —— 本工具只核"每条 AC 在报告里有记录"，
      // 不核功能覆盖（那是 covergroup 的事，见 fpga-module-verif 的覆盖率一节）。
      console.log("  ✅ AC 记录追溯完整 —— 每条 AC 在验证报告里都有记录。");
      console.log("     注意：这只证明「记录在」，不证明「功能覆盖到」—— 功能覆盖看 covergroup。");
    } else if (allWaived) {
      console.log("  ⊘ NOT_APPLICABLE：所有 AC 都标注了不适用，**一条都没验**。");
      console.log("     这不是「通过」。要么补真实的验证记录，要么确认这些 AC 确实不适用并说明理由。");
    } else if (noAcceptance) {
      console.log("  ⚠️ spec 里没解析出任何 AC 条目 —— 无法判断覆盖，先补 `AC-N:` 条目。");
    } else {
      console.log(`  ❌ ${String(missing.length)} 条 AC 在报告里没有记录（结论应为 UNVERIFIED）。`);
      console.log("     在验证报告里逐条写清怎么验的；确不适用要显式标 [不适用] 并给理由。");
    }
  }

  // 退出码：0 追溯完整 / 1 有遗漏 / 3 全豁免（NOT_APPLICABLE，不能当通过）/ 2 输入不足
  if (noAcceptance) process.exit(2);
  process.exit(passed ? 0 : allWaived ? 3 : 1);
};

main();
