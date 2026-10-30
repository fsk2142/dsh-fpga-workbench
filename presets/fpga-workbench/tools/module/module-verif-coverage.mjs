#!/usr/bin/env node
/**
 * 覆盖率统计：从 ModelSim 的 ucdb 提取覆盖率，对照门槛给出判定。
 *
 * ## 为什么需要这个命令
 *
 * `fpga-module-verif` 技能要求「判 `PASS` 必须给出量化覆盖率并达到门槛」，但此前
 * **没有任何命令能算** —— AI 只能手工数行数、估百分比，必然编数字。规范有要求、
 * 工具没支撑，是最容易出假证据的那类缺口。
 *
 * ## 门槛：默认 95%，用户可要求更高
 *
 * | 要求 | 怎么执行 |
 * |---|---|
 * | 用户没提 | **95%**（默认），不自行加码 |
 * | 用户要 98% / 100% | `--threshold 98` / `--threshold 100` |
 *
 * **不加档位规则的理由**：「仿真对、上板错就自动升到 98%」这种规则，等于用历史症状推当前
 * 门槛；该不该加严取决于模块性质与用途，判断权在用户。
 *
 * ## 本工具只算代码覆盖，不算 covergroup
 *
 * `+cover=sbcef` 统计的是**代码**覆盖（语句 / 分支 / 条件 / 表达式 / FSM）。
 * **covergroup（功能覆盖）是另一个开关**，且在 ModelSim 报告里位于独立的
 * `=== Covergroup:` 段 —— 本工具的正则只匹配 `=== File:` 段下的类别行，**读不到它**。
 *
 * 所以：**代码覆盖达标 ≠ 覆盖率达标**。报告里要如实写明功能覆盖率是另外统计的。
 *
 * ## ModelSim 覆盖率的四个步骤（全部实测，2026-10-28）
 *
 * ```
 * ① vlog -sv +cover=sbcef ...        # 编译期开启统计（不在这里做，模板负责）
 * ② vsim -coverage ...               # 运行期收集
 * ③ coverage save -onexit cov.ucdb   # 必须在 run -all **之前**注册
 * ④ vsim -c -viewcov cov.ucdb -do "coverage report -srcfile=*"
 * ```
 *
 * 第 ③ 步为什么是 `-onexit`：`-c` 模式下 TB 的 `$finish` 会**直接结束 vsim 进程**，
 * `run -all` 之后的任何 Tcl 都不执行；而 `onfinish` 只接受
 * `ask/default/exit/final/stop`，不能挂任意命令。所以只能注册"退出时保存"。
 *
 * ## 覆盖率类别
 *
 * `+cover=<spec>` 的字母：`s` 语句、`b` 分支、`c` 条件、`e` 表达式、
 * `f` 状态机、`t` 翻转、`x` 扩展翻转。
 * **门槛只算语句 / 分支 / 状态机状态**；条件 / 表达式 / 状态机迁移 / 翻转仅作参考，
 * 不计入达标判定（与 references/coverage-and-waivers.md 的类别表一致）。
 *
 * ## 用法
 *
 * ```
 * node module-verif-coverage.mjs <模块根>              # 读 verif/coverage.ucdb
 * node module-verif-coverage.mjs <模块根> --ucdb <path>
 * node module-verif-coverage.mjs <模块根> --json       # 机器可读
 * node module-verif-coverage.mjs <模块根> --threshold 90
 * node module-verif-coverage.mjs <模块根> --vsim <vsim 路径>
 * ```
 *
 * 退出码：0 = 达标或例外放行；1 = 低于门槛；2 = 用法/输入错误。
 */
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_THRESHOLD = 95;

/** 覆盖率类别 → 中文名。`+cover` 里的单字母。 */
const CATEGORY_LABELS = {
  Statements: "语句",
  Branches: "分支",
  Conditions: "条件",
  Expressions: "表达式",
  "FSM States": "状态机状态",
  "FSM Transitions": "状态机迁移",
  Toggles: "翻转",
};

/** 与功能覆盖关系弱的类别：只报告，不计入门槛判定。 */
const ADVISORY = new Set(["Toggles", "Expressions", "Conditions", "FSM Transitions"]);

const usage = () => {
  console.error("用法：node module-verif-coverage.mjs <模块根> [--ucdb <路径>] [--vsim <路径>] [--json] [--threshold <百分比>]");
  console.error("");
  console.error("  <模块根>        含 verif/ 的目录；默认读 verif/coverage.ucdb（其次 verif/work/）");
  console.error("  --ucdb <路径>   显式指定 ucdb 文件");
  console.error("  --vsim <路径>   显式指定 vsim.exe（默认按 MODELSIM 环境变量与常见安装位置探测）");
  console.error("  --json          输出机器可读 JSON");
  console.error("  --threshold N   门槛百分比(默认 95,不自行加码)。用户要求更高时才调:98 / 100");
  console.error("                  注意:本工具只算代码覆盖,+cover=sbcef 不含 covergroup");
  console.error("");
  console.error("前提：模板用 `vsim -coverage` 跑过，且覆盖率为 `coverage save -onexit` 落盘。");
  process.exit(2);
};

/** 解析命令行。 */
const parseArgs = (argv) => {
  const options = { moduleRoot: "", ucdb: "", vsim: "", json: false, threshold: DEFAULT_THRESHOLD };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--ucdb") {
      options.ucdb = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--vsim") {
      options.vsim = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--threshold") {
      const raw = argv[index + 1] ?? "";
      const value = Number(raw);
      // NaN 会让比较恒为 false（永远"未达标"），必须在入口就拒绝，不能静默带下去。
      if (raw === "" || !Number.isFinite(value) || value < 0 || value > 100) {
        console.error(`--threshold 需要一个 0–100 的数字，收到：${JSON.stringify(raw)}`);
        process.exit(2);
      }
      options.threshold = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`未知选项：${arg}`);
      usage();
    }
    if (options.moduleRoot === "") options.moduleRoot = arg;
  }
  if (options.moduleRoot === "") usage();
  return options;
};

/**
 * 找 vsim 可执行文件。
 *
 * 优先级：`--vsim` 显式路径 → `MODELSIM` / `VSIM` 环境变量 → 按安装目录通配扫描。
 *
 * 通配而不是写死 `2020.4`：用户装 2020.1 / 2021.3 / Questa 都能命中，
 * 写死版本号在换机器时必然失效。找不到就明确报错（不猜）。
 * @param explicit - `--vsim` 传进来的路径（可为空）。
 * @returns vsim 路径，找不到为空串。
 */
const findVsim = (explicit) => {
  if (explicit !== undefined && explicit !== "") {
    return existsSync(explicit) ? explicit : "";
  }

  const fromEnv = process.env.MODELSIM ?? process.env.VSIM ?? "";
  if (fromEnv !== "" && existsSync(fromEnv)) return fromEnv;

  // 通配常见安装根：modeltech* / questasim* / intelFPGA* 下的 win64|win32aloem
  const roots = ["C:/", "D:/", "C:/intelFPGA", "C:/intelFPGA_lite"];
  const exeNames = ["vsim.exe", "vsim"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^(?:modeltech|questasim|modelsim)/iu.test(name)) continue;
      for (const sub of ["win64", "win32aloem", "bin"]) {
        for (const exe of exeNames) {
          const candidate = join(root, name, sub, exe);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }

  // 最后试 PATH 上的 vsim
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    for (const exe of exeNames) {
      const candidate = join(dir, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
};

/**
 * 跑 `vsim -viewcov` 把 ucdb 转成文本报告。
 *
 * `-byfile` 在 2020.4 已废弃（会打 warning），用 `-srcfile=*`。报告写到临时文件，
 * 避免 stdout 被 ModelSim 的启动横幅污染。
 * @param vsim - vsim 可执行文件。
 * @param ucdbPath - ucdb 文件。
 * @returns `{ ok, text, problem }`。
 */
const renderReport = (vsim, ucdbPath) => {
  const scratch = mkdtempSync(join(tmpdir(), "fpga-cov-"));
  const reportPath = join(scratch, "coverage.rpt");

  // viewcov 模式：打开数据集 → 出报告 → 退出
  const script = [
    `coverage report -srcfile=* -output ${reportPath.replace(/\\/gu, "/")}`,
    "quit -f"
  ].join("\n");
  const scriptPath = join(scratch, "run.tcl");
  writeFileSync(scriptPath, `${script}\n`, "utf8");

  const result = spawnSync(vsim, ["-c", "-viewcov", ucdbPath.replace(/\\/gu, "/"), "-do", scriptPath], {
    encoding: "utf8",
    timeout: 300_000
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (!existsSync(reportPath)) {
    return {
      ok: false,
      text: "",
      problem: `没能生成报告（退出码 ${String(result.status)}）\n${combined.split("\n").filter((line) => /\S/u.test(line)).slice(-8).join("\n")}`
    };
  }
  return { ok: true, text: readFileSync(reportPath, "utf8"), problem: undefined };
};

/**
 * 从报告文本里抽覆盖率行。
 *
 * 报告形如：
 * ```
 * === File: .../dut.sv
 *     Enabled Coverage              Bins      Hits    Misses  Coverage
 *     Branches                        10         8         2    80.00%
 * ```
 * @param text - 报告全文。
 * @returns `{ files: [{ file, rows: [{ category, bins, hits, misses, percent }] }], total }`。
 */
const parseReport = (text) => {
  const files = [];
  let current = undefined;
  let total;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^#\s?/u, "").trimEnd();
    const fileMatch = /^=== File:\s*(.+)$/u.exec(line.trim());
    if (fileMatch !== null) {
      current = { file: fileMatch[1].trim(), rows: [] };
      files.push(current);
      continue;
    }

    const rowMatch = /^\s{2,}([A-Za-z][A-Za-z ]+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)%$/u.exec(line);
    if (rowMatch !== null && current !== undefined) {
      current.rows.push({
        category: rowMatch[1].trim(),
        bins: Number(rowMatch[2]),
        hits: Number(rowMatch[3]),
        misses: Number(rowMatch[4]),
        percent: Number(rowMatch[5])
      });
      continue;
    }

    const totalMatch = /^Total Coverage By File.*?:\s*([\d.]+)%$/u.exec(line.trim());
    if (totalMatch !== null) total = Number(totalMatch[1]);
  }

  return { files, total };
};

/**
 * 只统计**被测设计文件**的覆盖率（F-06）。
 *
 * ## 原来的 bug（黑名单）
 *
 * 旧实现是「文件名里有 `tb_` 或 `_tb` 就排除」——**黑名单**。于是
 * `scoreboard.sv` / `driver.sv` / `monitor.sv` / `env.sv` 这些 TB 辅助文件都被算进 DUT。
 * 它们的语句覆盖通常接近 100%（每拍都跑），会把低覆盖的 DUT 总百分比**拉高**。
 *
 * ## 现在的做法（正向白名单）
 *
 * 只统计**在 `rtl/` 下**的文件。理由：
 *
 * - 被测设计的定义就是「综合进 FPGA 的那部分」，那正是 `rtl/`
 * - TB、scoreboard、driver、monitor 都在 `verif/`（或 `sim/`），天然被排除
 * - 不需要维护「哪些名字像 TB」的猜想清单
 *
 * 拿不到 `rtl/` 相对路径时（报告里的路径形态不认识）**返回 null**，
 * 由调用方按 `UNVERIFIED` 处理 —— 不猜、不放过。
 *
 * @param files - 解析出的文件列表（每项含 `file`）。
 * @returns `{ dut, unclassified }`：dut 是 RTL 下的文件，unclassified 是判断不了归属的。
 */
const onlyDesignUnderTest = (files) => {
  const dut = [];
  const unclassified = [];
  for (const item of files) {
    // 报告里的路径可能是绝对路径、相对路径、或只有文件名 —— 统一按片段判断
    const normalized = item.file.replace(/\\/gu, "/").toLowerCase();
    // 明确的测试平台目录
    if (/(?:^|\/)(?:verif|sim)\//u.test(normalized)) continue;
    // RTL 目录（`rtl/` 或 `src/rtl/`）
    if (/(?:^|\/)rtl\//u.test(normalized)) {
      // 但 `rtl/` 里的 `tb_*` 仍可能是测试平台（少见，但排除掉更稳）
      if (/(?:^|\/)tb_[^/]*$/u.test(normalized)) continue;
      dut.push(item);
      continue;
    }
    // 路径里既没有 rtl/ 也没有 verif/：判断不了，交给调用方记为未归类
    unclassified.push(item);
  }
  return { dut, unclassified };
};

/**
 * 按 bins 加权算总覆盖率（不是简单平均）。
 *
 * 为什么加权：语句 100 条覆盖 90 条（90%）+ 状态机 3 个覆盖 3 个（100%），
 * 简单平均会得到 95%，但实际有 10 条语句没测。加权才是真实比例。
 * @param rows - 所有类别的行。
 * @returns `{ percent, bins, hits, misses }`。
 */
const weighted = (rows) => {
  let bins = 0;
  let hits = 0;
  for (const row of rows) {
    bins += row.bins;
    hits += row.hits;
  }
  return {
    bins,
    hits,
    misses: bins - hits,
    percent: bins === 0 ? 0 : Number(((hits / bins) * 100).toFixed(2))
  };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const moduleRoot = resolve(options.moduleRoot);
  if (!existsSync(moduleRoot)) {
    console.error(`模块根不存在：${moduleRoot}`);
    process.exit(2);
  }

  // 找 ucdb：显式 > verif/work/ > verif/ 根 > verif/ 下任意
  //
  // 模板在 `verif/` 里跑 vsim，`coverage save -onexit $COVERAGE_UCDB` 的默认值是
  // `coverage.ucdb`（相对当前目录），所以实际落在 `verif/coverage.ucdb`。
  // `verif/work/` 也列进候选：有人会把运行目录切到 work/ 里。
  let ucdbPath = options.ucdb;
  if (ucdbPath === "") {
    const candidates = [
      join(moduleRoot, "verif", "coverage.ucdb"),
      join(moduleRoot, "verif", "work", "coverage.ucdb")
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        ucdbPath = candidate;
        break;
      }
    }
    if (ucdbPath === "") {
      const verifDir = join(moduleRoot, "verif");
      const found = existsSync(verifDir)
        ? readdirSync(verifDir, { recursive: true })
            .filter((name) => typeof name === "string" && name.endsWith(".ucdb"))
            .map((name) => join(verifDir, name))
        : [];
      if (found.length > 0) ucdbPath = found[0];
    }
  }

  if (ucdbPath === "") {
    console.error("找不到覆盖率数据库（*.ucdb）。");
    console.error("");
    console.error("先让模板收集覆盖率：");
    console.error("  1. 模板的 vlog 带 `+cover=sbcef`");
    console.error("  2. 模板在 `run -all` 之前下 `coverage save -onexit <file>`");
    console.error("  3. 跑一次 compile + run");
    console.error("");
    console.error(`期望位置：${join(moduleRoot, "verif", "coverage.ucdb")}（或 verif/work/ 下）`);
    process.exit(2);
  }
  if (!existsSync(ucdbPath)) {
    console.error(`ucdb 不存在：${ucdbPath}`);
    process.exit(2);
  }

  const vsim = findVsim(options.vsim);
  if (vsim === "") {
    console.error("找不到 vsim。用 --vsim <路径> 指定，或设 `MODELSIM` 环境变量指向 vsim.exe。");
    process.exit(2);
  }

  const report = renderReport(vsim, ucdbPath);
  if (!report.ok) {
    console.error(`读取覆盖率失败：${report.problem}`);
    process.exit(2);
  }

  const parsed = parseReport(report.text);
  const classified = onlyDesignUnderTest(parsed.files);
  const dutFiles = classified.dut;

  if (dutFiles.length === 0) {
    console.error("报告里没有被测模块（只有测试平台？）。检查 ucdb 是否包含 rtl/ 下的文件。");
    if (classified.unclassified.length > 0) {
      console.error(`另 ${String(classified.unclassified.length)} 个文件的路径里既没有 rtl/ 也没有 verif/，判断不了归属：`);
      for (const item of classified.unclassified.slice(0, 5)) console.error(`  ? ${item.file}`);
    }
    console.error("提示：覆盖率报告的文件路径要能看出在哪一层 —— 缺 rtl/ 片段时本工具不猜归属。");
    process.exit(2);
  }

  // 有判断不了归属的文件时，在结果里点名（不影响 DUT 统计，但要让人知道）
  if (classified.unclassified.length > 0) {
    console.error(`注意：${String(classified.unclassified.length)} 个文件路径里没有 rtl/verif 片段，已排除在统计外：`);
    for (const item of classified.unclassified.slice(0, 5)) console.error(`  ? ${item.file}`);
  }

  const allRows = dutFiles.flatMap((item) => item.rows);
  const overall = weighted(allRows);

  // 门槛只看「强相关」类别（语句 / 分支 / 状态机状态）
  const gateRows = allRows.filter((row) => !ADVISORY.has(row.category));
  const gate = weighted(gateRows.length > 0 ? gateRows : allRows);
  const passed = gate.percent >= options.threshold;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          moduleRoot,
          ucdb: ucdbPath,
          threshold: options.threshold,
          passed,
          gate,
          overall,
          files: dutFiles,
          advisory: allRows.filter((row) => ADVISORY.has(row.category))
        },
        null,
        2
      )
    );
  } else {
    console.log(`覆盖率报告  ${basename(moduleRoot)}`);
    console.log(`  数据库：${ucdbPath}`);
    console.log("");
    console.log(`  ${"类别".padEnd(14)} ${"Bins".padStart(6)} ${"Hits".padStart(6)} ${"Misses".padStart(7)} ${"覆盖".padStart(8)}`);
    console.log(`  ${"-".repeat(46)}`);
    for (const row of allRows) {
      const label = CATEGORY_LABELS[row.category] ?? row.category;
      const mark = ADVISORY.has(row.category) ? " (仅参考)" : "";
      console.log(
        `  ${`${label}${mark}`.padEnd(14)} ${String(row.bins).padStart(6)} ${String(row.hits).padStart(6)} ${String(row.misses).padStart(7)} ${`${row.percent.toFixed(2)}%`.padStart(8)}`
      );
    }
    console.log("");
    console.log(`  计入门槛的覆盖：${gate.percent.toFixed(2)}%（${String(gate.hits)}/${String(gate.bins)}）`);
    console.log(`  门槛：${String(options.threshold)}%   →  ${passed ? "达标" : "未达标"}`);

    if (!passed) {
      console.log("");
      console.log(`未覆盖 ${String(gate.misses)} 项。按 fpga-module-verif 的要求，逐条标原因：`);
      console.log("  · 不可达 —— 有设计依据说明该分支永不成立");
      console.log("  · 防御性 —— 只在非法输入 / 硬件错误时触发");
      console.log("  · 待补   —— 本可覆盖但没写用例（这种情况不算达标，仍记 UNVERIFIED）");
      console.log("");
      console.log("低于门槛时结论记 `UNVERIFIED`；需要例外放行必须经用户确认，并在 verif.md 里写");
      console.log("「覆盖率例外:<数值>,理由 <具体说明>」。");
    }
  }

  process.exit(passed ? 0 : 1);
};

main();
