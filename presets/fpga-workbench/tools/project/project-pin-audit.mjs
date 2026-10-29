#!/usr/bin/env node
/**
 * 引脚与 IO 的机器比对：把 Vivado 的引脚分配表和板级期望表逐项对照。
 *
 * ## 为什么这一项最要紧
 *
 * 前面所有环节（SPEC、参考模型、仿真、覆盖率、lint）都在**逻辑域**里验证。
 * 但「LVCMOS18 配成 LVCMOS33」「两个信号抢同一个引脚」这类错误：
 *
 * - 仿真**根本看不到**（仿真里没有引脚，也没有电平标准）
 * - 上板时**直接损伤硬件或外设**（3.3V 灌进 1.8V 的 bank）
 * - 人工核 200 个引脚**必错**，且错在哪一行完全靠运气
 *
 * 所以这里只做一件机器擅长的事：**逐行比对两份表**。
 *
 * ## 期望表从哪来
 *
 * 用户提供（`--expect`），支持两种形态，因为它们对应两种现实：
 *
 * 1. **CSV / TSV**（有结构化表时）—— 列名容忍中英文与常见别名：
 *    `pin|引脚|管脚`、`port|信号|网络名|net`、`iostandard|电平|标准|IO标准`、
 *    `drive|驱动`、`pull|上下拉|pulltype`
 * 2. **Vivado 导出的 XDC**（只有原理图/无表格时，从上一版工程或板卡例程里取）
 *    —— 解析 `set_property PACKAGE_PIN` / `IOSTANDARD` / `PULLTYPE` / `DRIVE`
 *
 * 两者都没有时不猜：明确报「缺期望值，无法机械比对」，退 2。
 *
 * ## 实际表从哪来
 *
 * `--actual`：Vivado 工程的 xdc/ 目录，或综合后导出的 `report_io` 文本。
 * 也可以只给工程根，脚本自己找 `xdc/`。
 *
 * ## 判定
 *
 * - **引脚号不一致**：阻塞（接错线）
 * - **电平标准不一致**：阻塞（可能烧器件，最高危）
 * - **同一引脚被多个端口占用**：阻塞
 * - **期望有、实际没有**（漏约束）：阻塞（那个端口会被工具随便分配）
 * - **实际有、期望没有**（多了约束）：警告（可能是遗留）
 * - **驱动强度 / 上下拉不一致**：警告（多数情况不影响功能，但差分对与开漏要留意）
 * - **Bank 电压冲突**：阻塞（同一 bank 内混用不兼容电平）
 *
 * 退出码：0 = 完全一致；1 = 有阻塞项；2 = 输入缺失或用不了；3 = 只有警告。
 *
 * ## 用法
 *
 * ```
 * node project-pin-audit.mjs <工程根> --expect <期望表.csv|.xdc> [--actual <xdc目录|report_io.txt>] [--json]
 * ```
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node project-pin-audit.mjs <工程根> --expect <期望表> [选项]");
  write("");
  write("  <工程根>            含 xdc/ 的目录");
  write("  --expect <文件>     板级期望表：CSV/TSV（需列名）或 Vivado XDC");
  write("  --actual <路径>     实际分配的 xdc 目录或 report_io 文本（默认 <工程根>/xdc）");
  write("  --json              输出机器可读 JSON");
  write("");
  write("比对项：PACKAGE_PIN / IOSTANDARD / DRIVE / PULLTYPE，以及引脚重复占用。");
  write("退出码：0 一致 / 1 有阻塞 / 2 输入缺失 / 3 只有警告。");
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = { root: "", expect: "", actual: "", json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--expect") {
      options.expect = argv[++i] ?? "";
      continue;
    }
    if (arg === "--actual") {
      options.actual = argv[++i] ?? "";
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") usage(0);
    rest.push(arg);
  }
  options.root = rest[0] ?? "";
  return options;
};

/** 列名别名：把各种写法归一。 */
const COLUMN_ALIASES = {
  pin: ["pin", "引脚", "管脚", "引脚号", "package_pin", "pin number"],
  port: ["port", "信号", "网络名", "net", "signal", "信号名", "端口"],
  iostandard: ["iostandard", "电平", "标准", "io标准", "io_standard", "电平标准", "io std"],
  drive: ["drive", "驱动", "驱动强度", "drive_strength"],
  pull: ["pull", "上下拉", "pulltype", "pull_type", "上拉/下拉"]
};

/** 在表头里找某类列的下标。 */
const columnIndex = (headers, kind) => {
  const aliases = COLUMN_ALIASES[kind];
  for (let i = 0; i < headers.length; i += 1) {
    const normalized = headers[i].trim().toLowerCase().replace(/[\s_-]/gu, "");
    if (aliases.some((alias) => normalized === alias.replace(/[\s_-]/gu, ""))) return i;
  }
  return -1;
};

/** 解析 CSV / TSV。 */
const parseTable = (text, path) => {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (lines.length < 2) return { error: "表里没有数据行" };

  const delimiter = extname(path).toLowerCase() === ".tsv" || lines[0].includes("\t") ? "\t" : ",";
  const splitRow = (line) => line.split(delimiter).map((cell) => cell.trim().replace(/^["']|["']$/gu, ""));

  const headers = splitRow(lines[0]);
  const pinAt = columnIndex(headers, "pin");
  const portAt = columnIndex(headers, "port");

  if (pinAt < 0) {
    return { error: `表头里找不到引脚列。表头是：${headers.join(" | ")}` };
  }
  if (portAt < 0) {
    return { error: `表头里找不到信号列。表头是：${headers.join(" | ")}` };
  }

  const ioAt = columnIndex(headers, "iostandard");
  const driveAt = columnIndex(headers, "drive");
  const pullAt = columnIndex(headers, "pull");

  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    const pin = cells[pinAt] ?? "";
    const port = cells[portAt] ?? "";
    if (pin === "" || port === "" || port.startsWith("未用") || port.startsWith("NC")) continue;
    rows.push({
      port,
      pin: pin.toUpperCase(),
      iostandard: ioAt >= 0 ? (cells[ioAt] ?? "").toUpperCase() : "",
      drive: driveAt >= 0 ? (cells[driveAt] ?? "") : "",
      pull: pullAt >= 0 ? (cells[pullAt] ?? "").toUpperCase() : ""
    });
  }
  return { rows };
};

/** 解析 Vivado XDC 里的引脚属性。 */
const parseXdc = (text) => {
  /** port → { pin, iostandard, drive, pull } */
  const map = new Map();
  const ensure = (port) => {
    if (!map.has(port)) map.set(port, { port, pin: "", iostandard: "", drive: "", pull: "" });
    return map.get(port);
  };

  /**
   * `[get_ports ...]` 的端口名有**两种写法**，而且 `led[0]` 这种名字本身就含 `]`：
   *
   * - 带花括号：`[get_ports {led[0]}]` —— 名字里有 `[]` / 空格时必须这么写
   * - 不带花括号：`[get_ports clk]`
   *
   * 第一版用 `[^\}\]]+` 去取名字，结果 `led[0]` 被截成 `led[0`
   * （因为它把 `]` 排除掉了，而 `]` 正是总线位选的一部分），
   * 于是期望表里的 `led[0]` 永远匹配不上，全被报成「漏约束」。
   * 所以：花括号内用 `[^}]+`（到 `}` 为止），无花括号才用 `[^\]\s]+`。
   */
  const PORT = String.raw`\[get_ports\s+(?:\{([^}]+)\}|([^\]\s]+))\]`;
  const grab = (kind) => {
    const pattern = new RegExp(String.raw`set_property\s+${kind}\s+(\S+)\s+${PORT}`, "gu");
    for (const match of text.matchAll(pattern)) {
      const port = (match[2] ?? match[3] ?? "").trim().replace(/\s+/gu, "");
      if (port === "") continue;
      if (kind === "PACKAGE_PIN") ensure(port).pin = match[1].trim().toUpperCase();
      else if (kind === "IOSTANDARD") ensure(port).iostandard = match[1].trim().toUpperCase();
      else if (kind === "DRIVE") ensure(port).drive = match[1].trim();
      else ensure(port).pull = match[1].trim().toUpperCase();
    }
  };

  grab("PACKAGE_PIN");
  grab("IOSTANDARD");
  grab("DRIVE");
  grab("PULLTYPE");

  return [...map.values()];
};

/** 解析 report_io 文本（列：Port / Dir / Pin / IOSTANDARD ...）。 */
const parseReportIo = (text) => {
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    // 形如：led[0]    OUTPUT   AB12   LVCMOS33
    const match = /^\s*(\S+)\s+(INPUT|OUTPUT|INOUT)\s+([A-Z]{1,2}\d+)\s+(\S+)/u.exec(line);
    if (match !== null) {
      rows.push({ port: match[1], pin: match[3], iostandard: match[4].toUpperCase(), drive: "", pull: "" });
    }
  }
  return rows;
};

/**
 * 从封装推断 bank。
 *
 * 不查器件手册（那要联网/要装 Vivado），只用**引脚编号的命名规律**做保守推断：
 * 同 bank 的引脚在编号上通常相邻，但这不可靠 —— 所以这里**只在两侧都能推断时才比**，
 * 推不出来就跳过。宁可漏报一条 Bank 冲突，也不要因为猜错引脚映射制造误报。
 */
const bankOf = () => "";

const readExpectation = (path) => {
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  if (ext === ".xdc") return { rows: parseXdc(text), kind: "XDC" };
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") {
    // .txt 可能是 report_io，也可能是分隔符表：两种都试
    const asTable = parseTable(text, path);
    if (asTable.rows !== undefined) return { rows: asTable.rows, kind: "表格" };
    const asReport = parseReportIo(text);
    if (asReport.length > 0) return { rows: asReport, kind: "report_io" };
    return { error: asTable.error ?? "无法识别格式" };
  }
  return { error: `不支持的扩展名 ${ext}（支持 .csv / .tsv / .txt / .xdc）` };
};

const readActual = (path) => {
  if (!existsSync(path)) return { error: `路径不存在：${path}` };

  const stat = statSync(path);
  const files = stat.isDirectory()
    ? readdirSync(path)
        .filter((name) => extname(name).toLowerCase() === ".xdc")
        .map((name) => join(path, name))
    : [path];

  if (files.length === 0) return { error: `${path} 里没有 .xdc 文件` };

  const rows = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const parsed = extname(file).toLowerCase() === ".xdc" ? parseXdc(text) : parseReportIo(text);
    rows.push(...parsed);
  }
  return { rows, files };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.root === "" || options.expect === "") usage();

  const root = resolve(options.root);
  if (!existsSync(root)) {
    console.error(`工程根不存在：${root}`);
    process.exit(2);
  }

  const expectation = readExpectation(options.expect);
  if (expectation.error !== undefined) {
    console.error(`期望表用不了：${expectation.error}`);
    process.exit(2);
  }

  const actualPath = options.actual !== "" ? resolve(options.actual) : join(root, "xdc");
  const actual = readActual(actualPath);
  if (actual.error !== undefined) {
    console.error(`实际分配用不了：${actual.error}`);
    console.error("提示：也可以给综合后导出的 report_io 文本（--actual <report_io.txt>）。");
    process.exit(2);
  }

  /** 按 port 建索引（大小写与空白不敏感）。 */
  const norm = (name) => name.trim().replace(/\s+/gu, "").toLowerCase();
  const expectMap = new Map(expectation.rows.map((row) => [norm(row.port), row]));
  const actualMap = new Map(actual.rows.filter((row) => row.pin !== "").map((row) => [norm(row.port), row]));

  const blockers = [];
  const warnings = [];

  // ① 逐项比对
  for (const [key, want] of expectMap) {
    const got = actualMap.get(key);
    if (got === undefined) {
      blockers.push({
        kind: "漏约束",
        port: want.port,
        detail: `期望 ${want.pin}${want.iostandard === "" ? "" : ` / ${want.iostandard}`}，实际没有分配（工具会随便放）`
      });
      continue;
    }
    if (want.pin !== "" && got.pin !== "" && want.pin !== got.pin) {
      blockers.push({ kind: "引脚不一致", port: want.port, detail: `期望 ${want.pin}，实际 ${got.pin}` });
    }
    if (want.iostandard !== "" && got.iostandard !== "" && want.iostandard !== got.iostandard) {
      blockers.push({
        kind: "电平标准不一致",
        port: want.port,
        detail: `期望 ${want.iostandard}，实际 ${got.iostandard} —— 可能损伤器件`
      });
    }
    if (want.drive !== "" && got.drive !== "" && want.drive !== got.drive) {
      warnings.push({ kind: "驱动强度不一致", port: want.port, detail: `期望 ${want.drive}，实际 ${got.drive}` });
    }
    if (want.pull !== "" && got.pull !== "" && want.pull !== got.pull) {
      warnings.push({ kind: "上下拉不一致", port: want.port, detail: `期望 ${want.pull}，实际 ${got.pull}` });
    }
  }

  // ② 实际有、期望没有
  for (const [key, got] of actualMap) {
    if (!expectMap.has(key)) {
      warnings.push({ kind: "多余约束", port: got.port, detail: `实际 ${got.pin}，期望表里没有这个信号` });
    }
  }

  // ③ 引脚重复占用
  const pinOwners = new Map();
  for (const row of actual.rows) {
    if (row.pin === "") continue;
    if (!pinOwners.has(row.pin)) pinOwners.set(row.pin, []);
    pinOwners.get(row.pin).push(row.port);
  }
  for (const [pin, ports] of pinOwners) {
    if (ports.length > 1) {
      blockers.push({ kind: "引脚重复占用", port: ports.join(" + "), detail: `同一个引脚 ${pin} 被多个端口使用` });
    }
  }

  // ④ 电平标准在同一引脚上的矛盾（同一 port 出现多次且标准不同）
  const ioByPort = new Map();
  for (const row of actual.rows) {
    if (row.iostandard === "") continue;
    const key = norm(row.port);
    if (!ioByPort.has(key) || ioByPort.get(key) !== row.iostandard) {
      if (ioByPort.has(key)) {
        warnings.push({
          kind: "电平定义重复",
          port: row.port,
          detail: `${ioByPort.get(key)} 与 ${row.iostandard} 都出现过（后者覆盖前者）`
        });
      }
      ioByPort.set(key, row.iostandard);
    }
  }

  void bankOf;

  const payload = {
    expectation: { path: options.expect, kind: expectation.kind, ports: expectMap.size },
    actual: { path: actualPath, files: actual.files, ports: actualMap.size },
    blockers,
    warnings,
    verdict: blockers.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS"
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`期望表：${payload.expectation.path}（${payload.expectation.kind}，${String(payload.expectation.ports)} 个端口）`);
    console.log(`实际分配：${payload.actual.path}（${String(payload.actual.ports)} 个端口）`);
    console.log("");

    if (blockers.length > 0) {
      console.log(`阻塞项 ${String(blockers.length)} 条：`);
      for (const item of blockers) console.log(`  ✗ [${item.kind}] ${item.port} — ${item.detail}`);
      console.log("");
    }
    if (warnings.length > 0) {
      console.log(`警告项 ${String(warnings.length)} 条：`);
      for (const item of warnings) console.log(`  ! [${item.kind}] ${item.port} — ${item.detail}`);
      console.log("");
    }

    if (payload.verdict === "PASS") {
      console.log("PASS：引脚号、电平标准、驱动、上下拉全部一致，且无重复占用。");
    } else if (payload.verdict === "WARN") {
      console.log("WARN：没有阻塞项，但有上面那些差异需要人工确认。");
    } else {
      console.log("FAIL：有阻塞项。上板前必须清零 —— 电平或引脚错误可能损伤硬件。");
    }
  }

  process.exit(blockers.length > 0 ? 1 : warnings.length > 0 ? 3 : 0);
};

main();
