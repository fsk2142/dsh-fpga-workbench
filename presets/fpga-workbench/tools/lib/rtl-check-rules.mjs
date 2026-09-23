// RTL 机械检查的**纯规则**(module-rtl-check / project-rtl-check 共用一份)。
//
// 为什么抽出来(DSH-N06):这两个 checker 的规则部分曾**逐字复制**两份(各 269 行的 checkFile 完全相同),
// 于是每次改规则都要改两遍 —— 历史上已经因为"一边改了另一边漏"被抓过多次,而这一轮搬移时又发现
// `classifyNeq` 两边**真的不一样**:工程版用裸 `EXPECTED_SIGNAL`(与它自己的注释"计数/索引仍静默"矛盾),
// 于是同一句 `exp_cnt != x` 模块判 confirm、工程判 data(硬 FAIL)。现在以模块版为唯一出处。
//
// 共享的只有"纯规则":规则常量、谓词、checkFile。**不共享**两边的入口 ——
// 目录发现 / 角色指派 / IP 卡装配 / JSON 与退出码 / CLI 本来就是两套(那是设计,不是重复)。
// 覆盖判定另在 ./rtl-coverage.mjs;路径与真实落点判定在 ./stamp.mjs。

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 这几条只警告,不阻塞(前三条照抄 run_checks.py 的 WARN_CHECKS)。
 * `!= 待确认` 是新增的取舍:数据比对(`!=` 必须换 `!==`)得阻塞,循环/计数条件不能一起拦死 ——
 * 为什么按"期望值命名"划线,写在 checkFile 里 `!=` 那一段。
 *
 * 划线判据就一句:**"它错了会不会让结论错?"**
 *   · 不会(纯排版/写法:Tab、非英文、行尾、`!=` 待确认、端口类型写全没写全、端口对齐) → 只警告:
 *     照报,但不拦门禁。实测吃过亏:一个跑得通、仿真全过的平台,因为端口写法被报 3 项阻塞 FAIL ——
 *     排版拿到了和功能失败一样的红色,人就不再看这个检查器了。
 *   · 会(复位极性、断言存在、文件头字段、数据比对、成功标记…) → 继续 FAIL:那些错了,
 *     "这模块过了"这个结论本身就不成立。
 * 端口对齐这条规则现在**不存在**(文件里没有),存在的是「端口类型」;哪天加了,按同一判据并进这里。
 */
export const WARN_ONLY = new Set(["Tab 字符", "代码行非英文", "行尾混用", "!= 待确认", "端口类型", "IP 卡", "字面量写法", "内部 wire", "恒真断言"]);

export const PORT_TYPE = /^\s*(input|output|inout)\s+(wire|logic|reg|tri)\b/u;

/** 无宽度的填充写法(`'0` / `'1` / `'x` / `'z`)—— 用户禁止:宽度对不上时是把隐患藏起来。 */
export const FILL_LITERAL = /'[01xz]\b/iu;

/**
 * 基前没写宽度(`'b0` / `'hFF`)。
 *
 * 前面**不能是**标识符字符或 `)`:那样是"用常量表达式当宽度"(`1'b0`、`WIDTH'hFF`、`(W)'d0`),
 * 合法写法,不该报(实测你代码里有 `1'b0` 这种,共 223 处)。
 */
export const WIDTHLESS_BASE = /(?<![\w)\]])'[bhdox]/iu;

/** 断言说明的必填字段:每一处断言各写一遍。 */
export const ASSERT_FIELDS = ["Purpose", "Trigger", "Failure"];

/** 测试平台的成功标记:出现的每一处都要与 err_cnt 挂钩。 */
export const SUCCESS_MARKER = "ALL TESTS PASSED";

/**
 * 期望值命名的信号(`_exp` / `exp_` / `expected` / `_gold` / `gold_` / `_ref` / `ref_` / `reference`)。
 * 按**单个标识符**判定(不拿整行去匹配):命中它才把这一行的 `!=` 当数据比对。
 */
export const EXPECTED_SIGNAL = /(?:^|_)(?:exp|expected|gold|ref|reference)(?:_|$)/iu;

/** 全大写名字当**参数/常量**看(`C_IMG_WIDTH` / `LINE_D` / `FRAME_SZ`):计数器与参数比,不是数据比对。 */
export const PARAM_LIKE = /^[A-Z][A-Z0-9_]*$/u;

/**
 * 把一行的 `!=` 比较**逐对**分类(第四轮 Q4-08 + 第五轮 2.1)。
 *
 * 判据(三档):
 *   · `"data"` —— 当判定用,且**至少有一对**两侧都是普通信号、其中一侧是期望值命名 → 判 FAIL;
 *   · `"confirm"` —— 当判定用,且**至少有一对**两侧都是普通信号(没命中期望值命名)→ 提醒一句;
 *   · `"quiet"` —— 其余(不是判定用的场合;或每一对都涉及全大写参数 / 数值常量 / 函数返回值)。
 *
 * 为什么逐对而不是整行投票:一行里可以同时有"计数比参数"和"数据比对",
 * `every` 会让前面的参数比较把后面的数据比对一起吞掉(Q4-08 实测)。
 * @param operands - 去掉注释/字符串后的行。
 * @param pairs - 操作数对(`[左, 右]`)。
 * @returns `"data"` / `"confirm"` / `"quiet"`。
 */
export function classifyNeq(operands, pairs) {
  if (pairs.length === 0) return "quiet";
  if (!/\b(?:if|while|for)\s*\(|\bassert\b|\?/u.test(operands)) return "quiet"; // 不是判定:如 `$display(..., a != b)`
  // E8-10:期望值命名(含 EXP_DATA/EXPECTED_*)优先于“全大写像参数”,否则大写期望信号被吞掉
  // E8-10:期望命名的**数据**信号(如 EXP_DATA)优先于“全大写像参数”;计数/索引(exp_cnt)仍静默
  const COUNT_NAME = /(?:^|_)(?:cnt|count|idx|index|num|i|n)(?:_|$)|(?:^|_)(?:cnt|idx)$/iu;
  const isDataExpected = (name) => EXPECTED_SIGNAL.test(name) && !COUNT_NAME.test(name);
  const isPlain = (pair) => isDataExpected(pair[1]) || isDataExpected(pair[2]) || (!PARAM_LIKE.test(pair[1]) && !PARAM_LIKE.test(pair[2]));
  const plain = pairs.filter(isPlain);
  if (plain.length === 0) return "quiet";
  const named = plain.some((pair) => isDataExpected(pair[1]) || isDataExpected(pair[2]));
  return named ? "data" : "confirm";
}

export const NINE_SECTIONS = [
  "Local Parameters", "Types", "Registers", "Combinational Logic", "Sequential Logic",
  "Functions Module", "Task Module", "Module Instantiation", "Assertions"
];

export const HEADER_FIELDS = [
  "file name", "module name", "created date", "updated date",
  "version", "author", "copyright", "open source", "proprietary"
];

/**
 * 跑一个文件上的全部规则。
 *
 * 导出给自检用:沙箱里 node 不能开管道抓子进程输出,所以自检直接 import 调这个函数,
 * 而不是 spawn 一个进程去读它的 stdout。
 * @param file - 文件绝对路径。
 * @param isTestbench - 是否按测试平台检查(多两条规则,少两条 RTL 规则)。
 * @returns 每条问题带级别、行号、说明。
 */
export function checkFile(file, isTestbench) {
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/u);
  const issues = [];
  const add = (rule, line, message) => issues.push({ rule, line, message });

  /** 一行的代码部分(去掉行内注释):注释里出现的字样不算代码。 */
  const codeOf = (line) => line.split("//")[0];
  /**
   * 代码部分再去掉字符串字面量。
   * `$display("ALL TESTS PASSED (err_cnt=0)")` 里那个 `err_cnt=0` 只是字形:
   * 判断"有没有引用 err_cnt / 哪一侧是期望值"时不能把它算进去。
   */
  const codeOnly = (line) => codeOf(line).replace(/"(?:[^"\\]|\\.)*"/gu, '""');

  // ── 行尾统一:全 CRLF 或全 LF 都行,只有混用才报(警告) ──
  const crlf = (raw.match(/\r\n/gu) ?? []).length;
  const lf = (raw.match(/(?<!\r)\n/gu) ?? []).length;
  if (crlf > 0 && lf > 0) add("行尾混用", 0, `同一个文件里既有 CRLF(${crlf})又有 LF(${lf})`);

  // ── 文件头:顶部有分隔条(>=20 个 =) + 前 15 行内字段齐全 ──
  if (lines.length < 8) {
    add("文件头", 1, `文件只有 ${lines.length} 行,文件头至少需要 8 行`);
  } else {
    const banner = /^\s*\/\/={20,}\/\/\s*$/u;
    if (!lines.slice(0, 3).some((line) => banner.test(line))) {
      add("文件头", 1, "开头三行内没有 '//====…====//' 分隔条(至少 20 个 =)");
    }
    const head = lines.slice(0, 15).join("\n").toLowerCase();
    const missing = HEADER_FIELDS.filter((field) => !head.includes(field));
    if (missing.length > 0) add("文件头", 1, `前 15 行缺字段:${missing.join(", ")}`);
  }

  // ── 编译隔离:开头 `resetall + `default_nettype none,结尾收回 ──
  let start = 0;
  while (start < lines.length && (lines[start].trim() === "" || lines[start].trim().startsWith("//"))) start += 1;
  const opening = lines.slice(start, start + 10).join("\n");
  if (!opening.includes("`resetall")) add("编译隔离", start + 1, "文件头之后缺 `resetall");
  if (!opening.includes("`default_nettype none")) add("编译隔离", start + 1, "缺 `default_nettype none");
  const closing = lines.slice(-10).join("\n");
  if (!/`default_nettype\s+(?!none)\w+/u.test(closing)) {
    add("编译隔离", lines.length, "结尾没有把 `default_nettype 收回来(通常 `default_nettype wire)");
  }

  // 实例端口的连接网(`.port(net)` 里的 net):内部 wire 只有出现在这里才算"连接网"
  const connectedNets = new Set([...raw.matchAll(/\.\w+\s*\(\s*(\w+)\s*\)/gu)].map((match) => match[1]));
  /** 内部声明的 wire:`name -> 行号`(后面判它是不是连接网)。 */
  const declaredWires = new Map();
  /** 函数 / 任务体内(那里面 `input logic` 是变量,不按端口判)。 */
  let inSubprogram = false;

  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const stripped = line.trim();

    // 进出函数 / 任务(端口类型那条要在外面)
    if (/^\s*(function|task)\b/u.test(line)) inSubprogram = true;
    if (/^\s*(endfunction|endtask)\b/u.test(line)) inSubprogram = false;

    // 内部 wire 声明(多名字声明 `wire a, b;` 都收)
    const wireDecl = /^\s*wire\b([^;]*)/u.exec(codeOf(line));
    if (wireDecl !== null && !inSubprogram) {
      const body = wireDecl[1].replace(/\[[^\]]*\]/gu, " ");
      for (const part of body.split(",")) {
        const name = /(\w+)\s*$/u.exec(part.trim())?.[1];
        if (name !== undefined && !declaredWires.has(name)) declaredWires.set(name, number);
      }
    }

    // ── Tab(警告) ──
    if (line.includes("\t")) add("Tab 字符", number, "出现 Tab,用空格");

    // ── 代码行非英文(警告):去掉行内注释后仍有非 ASCII ──
    if (stripped !== "" && !stripped.startsWith("//")) {
      const code = line.split("//")[0];
      const bad = [...code].filter((ch) => ch.codePointAt(0) > 0x7f);
      if (bad.length > 0) add("代码行非英文", number, `代码里出现非英文字符:${bad.join("")}`);
    }

    // ── 端口类型:要写全,而且要写对(input wire / output logic / inout tri) ──
    // 纯写法问题,只警告(见 WARN_ONLY):照报,但不拦门禁 —— 它错了不会让"这模块过没过"的结论错。
    // 函数 / 任务的形参不在其内(那里的 `input logic x` 是变量)。
    if (!inSubprogram) {
      const port = /^\s*(input|output|inout)\s+(?!wire\b|logic\b|tri\b|reg\b)(\w+)/u.exec(line);
      const want = (direction) => (direction === "input" ? "wire" : direction === "output" ? "logic" : "tri");
      if (port !== null && !["parameter", "localparam", "genvar"].includes(port[2])) {
        add("端口类型", number, `端口类型要写全:${port[1]} ${port[2]} → ${port[1]} ${want(port[1])}`);
      } else {
        const typed = PORT_TYPE.exec(line);
        if (typed !== null && typed[2] !== want(typed[1])) {
          add("端口类型", number, `端口方向与类型不搭:${typed[1]} ${typed[2]} → ${typed[1]} ${want(typed[1])}`);
        }
      }
    }

    // ── 字面量写法(用户口径):禁止无宽度填充;基前必须带宽度 ──
    const code = codeOnly(line);
    const fill = FILL_LITERAL.exec(code);
    if (fill !== null) {
      add("字面量写法", number, `禁止「${fill[0]}」这种无宽度填充写法:把宽度与基写全(信号类 → \`N'b…\`,数据类 → \`N'h…\`)`);
    } else if (WIDTHLESS_BASE.test(code)) {
      add("字面量写法", number, "字面量没带宽度:写成 `N'b…` / `N'h…`(`1'b0` 这种)");
    }

    // ── always_ff 只用 posedge ──
    if (line.includes("always_ff") && line.includes("negedge")) {
      add("always_ff", number, "always_ff 里用了 negedge(只允许 posedge)");
    }

    // ── 复位一律高有效(2026-09-02 裁决) ──
    const lowReset = /if\s*\(\s*[!~]\s*rst\w*\b|negedge\s+rst\w*\b|if\s*\(\s*~?\s*rst_n\b|posedge\s+rst_n\b/u.exec(line);
    if (lowReset !== null) {
      add("复位极性", number, `低有效复位用法:「${lowReset[0]}」(本项目 rst/rst_* 一律高有效)`);
    }

    // ── 数据比对禁 `!=`(只查测试平台) ──
    //
    // `X != y` 在全 X 时求值为 X,`if (X)` 为假 → 一条错都不报(实测的静默漏检)。客观事实:
    // SystemVerilog 的 `!==` 才是四态精确比较(`!=` 结果未知时返回 1)。
    //
    // 取舍:只有**两侧都是信号**的 `!=` 才算数据比对(`dut_data != exp_data` 这种),且至少要有一侧
    // 是**期望值命名**(`_exp` / `exp_` / `expected` / `_gold` / `_ref` / `reference`)才判 FAIL;
    // 其余的 `!=` 只报警告:不能为了不漏掉数据比对,把循环/计数条件也一起拦死(误报一次,人就再也不
    // 信这个检查器)。
    //
    // **两侧都要是信号**这条是 2026-09-21 补的(实测踩到):原来只要"整行里出现过 exp_ 命名的标识符"
    // 就判 FAIL,于是 `if (exp_pixel_idx != 0 && …)` 这种**计数/索引比常量**被当成数据比对拦住了 ——
    // 而那正是上面那句"循环/计数条件可以保留"要放过的。现在按"操作符紧邻的两个操作数"判。
    //
    // 2026-09-22 再收窄并**逐对分类**(用户口径 + 第四轮 Q4-08 / 第五轮 2.1):
    //   · 一整行里有多个 `!=` 时,**每一对各自分类** —— 不能先对整行投票(`every`):那样一行里
    //     `cnt != MAX_COUNT && dut_data != exp_data` 会因为第一对是"计数比全大写参数"而把后面
    //     真正的数据比对一起吞掉;
    //   · 只有当**当判定用**(`if` / `while` / `for` / 断言 / 三元)**且**这一对两侧都是普通信号时,
    //     才可能是"会漏检"的比较:期望值命名的判 FAIL,其余提醒;涉及全大写参数/数值常量/返回值/
    //     表达式的一律静默(计数/索引/返回值比较按既定口径不该提醒)。
    if (isTestbench && line.includes("!=")) {
      const operands = codeOnly(line);
      // **一行里所有** `a != b` 都要看(第三轮复审 N-06:只取第一个的话,
      // `i != 0 && dut_data != exp_data` 会把真正的数据比对漏成"待确认")
      const pairs = [...operands.matchAll(/([A-Za-z_]\w*(?:\s*\[[^\]]*\])?)\s*(?<![=!])!=(?!=)\s*([A-Za-z_]\w*(?:\s*\[[^\]]*\])?)/gu)];
      const verdict = classifyNeq(operands, pairs);
      if (verdict === "data") {
        add("数据比对", number, "数据比对用了 '!='(全 X 时 X != y 求值为 X,if (X) 为假 → 一条错都不报):改用 '!=='");
      } else if (verdict === "confirm") {
        add("!= 待确认", number, "这一行有 '!=':确认是数据比对就改 '!=='(否则全 X 会漏检);循环/计数条件可以保留");
      }
    }

    // ── 恒真断言(`X |-> X`):"有断言"不等于"有设计检查"(第三轮复审 N-07)──
    //
    // 判据:`assert property` 的**前件与后件是同一个标识符** —— 不管设计怎样都成立,是恒真式。
    // 只警告(不拦门禁):模板里的占位断言就长这样;但必须被看见,别把"有断言"当成"验过了"。
    const vacuous = /assert\s+property\s*\([^;]*?\b([A-Za-z_]\w*)\s*\|->\s*\1\b/u.exec(codeOnly(line));
    if (vacuous !== null) {
      add("恒真断言", number, `恒真断言(\`${vacuous[1]} |-> ${vacuous[1]}\`):它不管设计怎样都通过,不是设计检查 —— 换成真正要守的性质`);
    }

    // ── end 与 else begin 同行 ──
    if (stripped === "end") {
      for (let j = index + 1; j < Math.min(index + 3, lines.length); j += 1) {
        const next = lines[j].trim();
        if (next === "") continue;
        if (next.startsWith("else") && next.includes("begin")) {
          add("end/else", number, "'end' 与 'else begin' 应写在同一行");
        }
        break;
      }
    }
  }

  // ── 九个小节块:只要求名字作为 banner 存在(宽度容忍 84-86) ──
  //
  // 测试平台跳过这一条:九个小节(Local Parameters / Combinational Logic / …)是 RTL 的
  // 结构,模板里的 tb.sv 本来就没有它们 —— 照旧包一律套用,会让我们自己发的模板过不了
  // 我们自己的检查器。断言那一条对 TB 也是放宽的(写了的断言才要求说明),这里同理。
  if (!isTestbench) {
    const banners = lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith("//") && line.endsWith("//") && line.length >= 84 && line.length <= 86)
      .map((line) => line.slice(2, -2).trim());
    const absent = NINE_SECTIONS.filter((name) => !banners.includes(name));
    if (absent.length > 0) add("九个小节块", 0, `缺小节 banner:${absent.join(" / ")}`);
  }

  // ── 设计断言:代码里有 assert/assume/cover,且说明写清 Purpose/Trigger/Failure ──
  //     (测试平台不要求"必须有断言",与旧包一致;但**写了的**断言一样要逐条写清说明)
  //
  //     逐条查:原来只查"整个文件文本里出现过这三个词",于是删掉第一条断言的说明也照样报 ok
  //     (实测)。现在对每一处断言各自回溯它正上方紧邻的 `//` 注释块(中间只允许空行),缺哪个
  //     字段就点出断言所在行 —— "说明写在断言正上方"是本仓库的房风格(自带模板即如此)。
  const text = lines.join("\n");
  const assertLines = [];
  for (const [index, line] of lines.entries()) {
    if (/\b(assert|assume|cover)\s*(property|\()/u.test(codeOf(line))) assertLines.push(index);
  }
  if (!isTestbench && assertLines.length === 0) {
    add("设计断言", 0, "没有设计断言(Assertions 小节里要有 assert/assume/cover)");
    // 一条断言都没有:按原行为查整份文件里有没有这三个词(不新造失败)
    for (const field of ASSERT_FIELDS) {
      if (!new RegExp(`\\b${field}\\b`, "u").test(text)) add("设计断言", 0, `断言说明缺 ${field}`);
    }
  }
  for (const index of assertLines) {
    const block = [];
    for (let j = index - 1; j >= 0; j -= 1) {
      const above = lines[j].trim();
      if (above === "") continue;
      if (!above.startsWith("//")) break;
      block.unshift(above);
    }
    const missing = ASSERT_FIELDS.filter((field) => !new RegExp(`\\b${field}\\b`, "u").test(block.join("\n")));
    if (missing.length > 0) {
      add("设计断言", index + 1, `这条断言正上方的说明块缺:${missing.join(" / ")}(每条断言各写一遍 Purpose / Trigger / Failure)`);
    }
  }

  // ── 测试平台额外两条:失败能自动抓住,且成功有固定标记 ──
  if (isTestbench) {
    if (!text.includes("$fatal") && !text.includes("$error")) {
      add("测试平台自检", 0, "没有 $fatal/$error:仿真失败不会让退出码非零");
    }
    if (!text.includes(SUCCESS_MARKER)) {
      add("测试平台自检", 0, `没有 '${SUCCESS_MARKER}' 成功标记,批量判据说不清`);
    }
    // 成功标记必须与 err_cnt 挂钩:原来只查"文件里有没有这个字符串",于是"打印了
    // ALL TESTS PASSED"和"成百条断言违例"可以同时成立(实测) —— 只看字符串就是只看字形。
    // 判据 = 标记所在的那条**语句**(含上方的 `if (...)` 控制头与向下的续行;去注释、去字符串)
    // 里出现 err_cnt:模板的 `if (err_cnt == 0)` + 下一行 $display 就是把标记挂在 err_cnt 上。
    /** 标记所在的那条语句:本行 + 向上的控制头(`if (...)` / `begin`)+ 向下的续行。 */
    const statementAt = (index) => {
      const parts = [codeOnly(lines[index])];
      for (let j = index - 1; j >= 0 && parts.length < 4; j -= 1) {
        const above = lines[j].trim();
        if (above === "" || above.startsWith("//")) continue; // 空行/说明文字:语句还是同一句
        if (above.endsWith(";")) break;                      // 上一条语句:到头了
        parts.unshift(codeOnly(lines[j]));
      }
      for (let j = index + 1; j < lines.length && parts.length < 6; j += 1) {
        if (/;\s*$/u.test(parts[parts.length - 1])) break; // 语句已经写完
        parts.push(codeOnly(lines[j]));
      }
      return parts.join("\n");
    };
    for (const [index, line] of lines.entries()) {
      if (!codeOf(line).includes(SUCCESS_MARKER)) continue; // 注释里提到这个标记不算打印
      if (/\berr_cnt\b/u.test(statementAt(index))) continue;
      add("测试平台自检", index + 1, "成功标记必须与 err_cnt 挂钩(如 if (err_cnt == 0) $display(\"ALL TESTS PASSED...\") 或 $display(\"ALL TESTS PASSED (err_cnt=%0d)\", err_cnt));无条件打印就只是字形");
    }
  }

  // ── 内部 wire:只该用于**实例与实例之间的连接网**(用户口径 2026-09-21) ──
  // 判据(保守,只挑"明确不是连接网"的):内部声明的 wire,如果整个文件里**除声明外还在用**、
  // 却**从没出现在任何 `.port(net)` 连接里**,那它不是连接网 —— 该用 logic。
  // 声明了但没再用到的**不报**(那是"没用上",不是类型问题;混进来就变成噪音)。
  for (const [name, line] of declaredWires) {
    if (connectedNets.has(name)) continue;
    const uses = (raw.match(new RegExp(`\\b${name}\\b`, "gu")) ?? []).length;
    if (uses > 1) {
      add(
        "内部 wire",
        line,
        `内部 signal '${name}' 用了 wire,但它没有出现在任何实例端口连接里 —— 内部信号用 logic;wire 只留给实例之间的连接网`
      );
    }
  }

  return issues;
}
