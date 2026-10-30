#!/usr/bin/env node
/**
 * XDC 约束的机械检查：只判「能确定对错」的事，不猜时序意图。
 *
 * ## 为什么只查这几项
 *
 * 约束文件里真正能机械判定对错的只有三类：
 *
 * 1. **有时钟端口却没 `create_clock`** —— 漏了就是整条路径不受约束，
 *    Vivado 只会给个 unconstrained paths 警告，很容易被忽略过去。
 * 2. **时钟周期/名称自相矛盾** —— 同一时钟定义两次周期不同、`-name` 重复。
 * 3. **管脚分配冲突** —— 同一管脚给两个端口、同一端口给两个管脚（后者是
 *    `set_property` 覆盖，静默生效，最难查）。
 *
 * **不能判的**（本命令刻意不碰）：
 * - 时钟频率对不对（要设计知识）
 * - `set_false_path` 该不该有（要协议知识）
 * - IO 延迟数值合不合理（要板级时序模型）
 *
 * 这些工具乱判只会制造误报，比不判更糟。所以命中就报、没命中就说「机械检查通过，
 * 时序意图仍需人工核」—— 不给「约束正确」这种超出能力的结论。
 *
 * ## 用法
 *
 * ```
 * node project-constraints-check.mjs <工程根或 xdc 目录> [--json]
 * ```
 *
 * 退出码：0 = 机械检查通过；1 = 发现冲突；2 = 用法/输入错误。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const usage = () => {
  console.error("用法：node project-constraints-check.mjs <工程根或 xdc 目录> [--json]");
  console.error("");
  console.error("  <工程根>   含 xdc/ 的目录；也可以直接给 xdc/ 目录");
  console.error("  --json     输出机器可读 JSON");
  console.error("");
  console.error("只查机械可判的：缺少 create_clock、时钟定义重复、管脚分配冲突。");
  console.error("时序意图（频率对不对、false_path 该不该有）本命令不判。");
  process.exit(2);
};

const parseArgs = (argv) => {
  const options = { target: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--")) {
      console.error(`未知选项：${arg}`);
      usage();
    } else if (options.target === "") {
      options.target = arg;
    }
  }
  if (options.target === "") usage();
  return options;
};

/** 找 xdc 目录。 */
const resolveXdcDir = (target) => {
  if (!existsSync(target)) return "";
  if (statSync(target).isDirectory()) {
    const direct = join(target, "xdc");
    if (existsSync(direct)) return direct;
    // 本身就是 xdc 目录
    if (readdirSync(target).some((name) => extname(name) === ".xdc")) return target;
  }
  return "";
};

/** 列出目录下（含子目录）所有 .xdc 文件。 */
const listXdc = (dir) => {
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (extname(name) === ".xdc") {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found.sort();
};

/**
 * 去掉注释、合并续行，得到"有效约束行"。
 *
 * XDC 的注释是 `#` 到行尾；续行是行尾 `\`。**必须先去掉注释再判**，
 * 否则模板里那些注释掉的示例（`# create_clock -period ...`）会被当成真约束 ——
 * 我们自己的模板就是全部注释掉的，那样会全线误报。
 * @param text - 文件全文。
 * @returns `[{ line, text }]`（line 为原始行号）。
 */
const effectiveLines = (text) => {
  const result = [];
  const rawLines = text.replace(/\r\n?/gu, "\n").split("\n");
  let buffer = "";
  let startLine = 0;

  for (let index = 0; index < rawLines.length; index += 1) {
    let line = rawLines[index];

    // 去注释：只在不在引号内时生效（简化：找第一个不在引号里的 #）
    let inQuote = false;
    let cut = -1;
    for (let pos = 0; pos < line.length; pos += 1) {
      const char = line[pos];
      if (char === '"') inQuote = !inQuote;
      else if (char === "#" && !inQuote) {
        cut = pos;
        break;
      }
    }
    if (cut >= 0) line = line.slice(0, cut);
    line = line.trimEnd();
    if (line.trim() === "" && buffer === "") continue;

    if (buffer === "") startLine = index + 1;
    if (line.endsWith("\\")) {
      buffer += `${line.slice(0, -1)} `;
      continue;
    }
    buffer += line;
    if (buffer.trim() !== "") result.push({ line: startLine, text: buffer.trim() });
    buffer = "";
  }
  if (buffer.trim() !== "") result.push({ line: startLine, text: buffer.trim() });

  return result;
};

/** 从命令行里取某个选项的参数值。 */
const optionValue = (text, option) => {
  const match = new RegExp(`${option}\\s+(?:"([^"]*)"|(\\S+))`, "u").exec(text);
  return match === null ? "" : (match[1] ?? match[2] ?? "");
};

/**
 * 从 `[get_ports ...]` 里取端口名。
 *
 * ## 支持三种形态（F-12）
 *
 * ```
 * [get_ports clk]              → ["clk"]
 * [get_ports {led[0]}]         → ["led[0]"]        ← 花括号里的 [ ] 是端口名的一部分
 * [get_ports {led[0] led[1]}]  → ["led[0]", "led[1]"]
 * [get_ports [get_ports ...]]  → 嵌套时取最内层
 * ```
 *
 * ## 原实现的 bug（已修）
 *
 * 原来用 `/\[get_ports\s+\{?([^\]\}]+)\}?\]/` —— 那个 `[^\]}` 会在**第一个 `]`** 处停下，
 * 于是：
 *
 * | 输入 | 原来 | 现在 |
 * |---|---|---|
 * | `[get_ports {led[0]}]` | `["led[0"]` ← 末尾 `]` 被截掉 | `["led[0]"]` |
 * | `[get_ports {led[0] led[1]}]` | `["led[0"]` ← **第二位完全丢失** | 两个都在 |
 *
 * 漏掉端口意味着检查器以为「这个引脚没被约束」，或者完全不知道它的存在。
 *
 * ## 解析策略
 *
 * 1. 先找**花括号包裹**的形态：`[get_ports { ... }]` —— 花括号内的内容整体取出再按空白拆
 * 2. 没有花括号时取到**配对**的 `]`（按括号深度匹配，不吃掉总线位的 `]`）
 * 3. 解析不出来返回空数组（由调用方按「无法解析」处理，不静默当成功）
 *
 * @param text - 一行 XDC 命令文本。
 * @returns 端口名数组。
 */
const portNames = (text) => {
  const open = /\[get_ports\s+/u.exec(text);
  if (open === null) return [];
  let rest = text.slice(open.index + open[0].length);

  let body;
  if (rest.startsWith("{")) {
    // 花括号形态：取到配对的 }
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "{") depth += 1;
      else if (rest[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return []; // 花括号没闭合：解析失败
    body = rest.slice(1, end);
  } else {
    // 无花括号：取到**配对**的 ]（要算深度，否则 `led[0]` 会提前截断）
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "[") depth += 1;
      else if (rest[i] === "]") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth -= 1;
      }
    }
    if (end < 0) return [];
    body = rest.slice(0, end);
  }

  return body
    .split(/\s+/u)
    .map((name) => name.trim())
    .filter((name) => name !== "" && !name.startsWith("-"));
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const target = resolve(options.target);
  if (!existsSync(target)) {
    console.error(`路径不存在：${target}`);
    process.exit(2);
  }

  const xdcDir = resolveXdcDir(target);
  if (xdcDir === "") {
    console.error(`找不到 xdc 目录：${target}`);
    console.error("");
    console.error("期望 <工程根>/xdc/*.xdc，或直接把 xdc/ 目录作为参数。");
    console.error("先用 `setup-scaffold` 或约束模板建一份，再填实际内容。");
    process.exit(2);
  }

  const files = listXdc(xdcDir);
  if (files.length === 0) {
    console.error(`xdc 目录里没有 .xdc 文件：${xdcDir}`);
    process.exit(2);
  }

  const clocks = [];       // { name, period, port, file, line }
  const pinAssignments = []; // { pin, port, file, line }
  const problems = [];
  const notes = [];

  for (const file of files) {
    const rel = file.slice(xdcDir.length + 1).replace(/\\/gu, "/");
    const lines = effectiveLines(readFileSync(file, "utf8"));
    if (lines.length === 0) {
      notes.push({ file: rel, message: "没有有效约束（全是注释）—— 还没填实际约束" });
      continue;
    }

    for (const { line, text } of lines) {
      // create_clock / create_generated_clock
      if (/^create_clock\b/u.test(text) || /^create_generated_clock\b/u.test(text)) {
        const period = optionValue(text, "-period");
        const name = optionValue(text, "-name");
        const ports = portNames(text);
        /**
         * `-add` 是合法写法：同一端口上挂多个时钟（如主时钟 + 虚拟时钟）时，
         * SDC 要求后续的 `create_clock` 带 `-add`，否则才覆盖前一条。
         * 见 §C8：不豁免它就会把合法约束误报成冲突。
         */
        const hasAdd = /(?:^|\s)-add(?:\s|$)/u.test(text);
        clocks.push({
          kind: /^create_generated_clock/u.test(text) ? "generated" : "base",
          name: name === "" ? (ports[0] ?? "(未命名)") : name,
          period,
          ports,
          hasAdd,
          file: rel,
          line
        });
        // `create_clock` 必须有 -period；`create_generated_clock` 可用 -divide_by 等代替。
        if (period === "" && /^create_clock/u.test(text)) {
          problems.push({ file: rel, line, message: "create_clock 没有 -period" });
        }
      }

      // set_property PACKAGE_PIN <pin> [get_ports <port>]
      if (/^set_property\s+PACKAGE_PIN\b/u.test(text)) {
        const pin = optionValue(text, "PACKAGE_PIN");
        const ports = portNames(text);
        if (pin !== "" && ports.length > 0) {
          pinAssignments.push({ pin, port: ports[0], file: rel, line });
        }
      }
    }
  }

  // ① 有时钟端口却没 create_clock：靠 PACKAGE_PIN 里名字含 clk 的端口推
  const clockPorts = pinAssignments.filter((item) => /clk|clock|osc|clk_in/iu.test(item.port));
  const constrainedPorts = new Set(clocks.flatMap((clock) => clock.ports));
  for (const item of clockPorts) {
    if (!constrainedPorts.has(item.port)) {
      problems.push({
        file: item.file,
        line: item.line,
        message: `时钟端口 ${item.port} 分配了管脚，但没有对应的 create_clock（该路径不受时序约束）`
      });
    }
  }

  // ② 时钟重复定义：同名不同周期；或同端口多个 create_clock
  const byName = new Map();
  for (const clock of clocks) {
    if (!byName.has(clock.name)) byName.set(clock.name, []);
    byName.get(clock.name).push(clock);
  }
  for (const [name, list] of byName) {
    if (list.length > 1) {
      const periods = new Set(list.map((clock) => clock.period));
      if (periods.size > 1) {
        problems.push({
          file: list.map((clock) => `${clock.file}:${String(clock.line)}`).join(", "),
          line: 0,
          message: `时钟 ${name} 定义了 ${String(list.length)} 次且周期不同（${[...periods].join(" / ")}）—— 后者会覆盖前者`
        });
      } else {
        notes.push({ file: list[0].file, message: `时钟 ${name} 重复定义 ${String(list.length)} 次（周期相同，无影响）` });
      }
    }
  }

  const byPort = new Map();
  for (const clock of clocks) {
    for (const port of clock.ports) {
      if (!byPort.has(port)) byPort.set(port, []);
      byPort.get(port).push(clock);
    }
  }
  for (const [port, list] of byPort) {
    if (list.length <= 1) continue;
    // 端口上的每一条（除第一条）都带 `-add` 才是合法的多时钟写法（§C8）。
    // 一条都没带 → 后者覆盖前者，是真冲突。
    const offenders = list.filter((clock, index) => index > 0 && !clock.hasAdd);
    if (offenders.length > 0) {
      problems.push({
        file: list.map((clock) => `${clock.file}:${String(clock.line)}`).join(", "),
        line: 0,
        message: `端口 ${port} 上定义了 ${String(list.length)} 个 create_clock，其中 ${String(offenders.length)} 条没带 -add —— 会让前一条被覆盖`
      });
    } else {
      notes.push({ file: list[0].file, message: `端口 ${port} 上有 ${String(list.length)} 个 create_clock，均带 -add（合法的多时钟写法）` });
    }
  }

  // ③ 管脚冲突：同一 pin 给两个端口；同一 port 给两个 pin
  const byPin = new Map();
  for (const item of pinAssignments) {
    if (!byPin.has(item.pin)) byPin.set(item.pin, []);
    byPin.get(item.pin).push(item);
  }
  for (const [pin, list] of byPin) {
    const ports = [...new Set(list.map((item) => item.port))];
    if (ports.length > 1) {
      problems.push({
        file: list.map((item) => `${item.file}:${String(item.line)}`).join(", "),
        line: 0,
        message: `管脚 ${pin} 分配给了多个端口（${ports.join(", ")})`
      });
    }
  }

  const byPortPin = new Map();
  for (const item of pinAssignments) {
    if (!byPortPin.has(item.port)) byPortPin.set(item.port, []);
    byPortPin.get(item.port).push(item);
  }
  for (const [port, list] of byPortPin) {
    const pins = [...new Set(list.map((item) => item.pin))];
    if (pins.length > 1) {
      problems.push({
        file: list.map((item) => `${item.file}:${String(item.line)}`).join(", "),
        line: 0,
        message: `端口 ${port} 分配了多个管脚（${pins.join(", ")}）—— 后者静默覆盖前者，最难查`
      });
    }
  }

  const passed = problems.length === 0;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          xdcDir,
          files: files.map((file) => file.slice(xdcDir.length + 1).replace(/\\/gu, "/")),
          clocks,
          pinAssignments,
          problems,
          notes,
          passed
        },
        null,
        2
      )
    );
  } else {
    console.log(`约束机械检查  ${basename(target)}`);
    console.log(`  目录：${xdcDir}`);
    console.log(`  文件：${String(files.length)} 个`);
    console.log("");
    console.log(`  时钟定义：${String(clocks.length)} 条`);
    for (const clock of clocks) {
      console.log(`    · ${clock.name}${clock.period === "" ? "" : ` @ ${clock.period}ns`}${clock.ports.length === 0 ? "" : ` → ${clock.ports.join(", ")}`}  (${clock.file}:${String(clock.line)})`);
    }
    console.log(`  管脚分配：${String(pinAssignments.length)} 条`);
    console.log("");

    for (const note of notes) {
      console.log(`  ℹ️  ${note.file}: ${note.message}`);
    }
    if (problems.length === 0) {
      console.log("  ✅ 机械检查通过：没有缺时钟、重复定义或管脚冲突。");
      console.log("");
      console.log("  **但时序意图仍需人工核**，本命令不判：");
      console.log("    · 时钟频率 / 周期对不对（要设计知识）");
      console.log("    · set_false_path / set_clock_groups 该不该有（要协议知识）");
      console.log("    · IO 延迟数值合不合理（要板级时序模型）");
    } else {
      console.log(`  ❌ ${String(problems.length)} 个问题：`);
      for (const problem of problems) {
        console.log(`    · ${problem.file}${problem.line === 0 ? "" : `:${String(problem.line)}`}  ${problem.message}`);
      }
      console.log("");
      console.log("  修完重跑。管脚「同一端口多个 pin」尤其要查 —— 后者静默覆盖，Vivado 不报错。");
    }
  }

  process.exit(passed ? 0 : 1);
};

main();
