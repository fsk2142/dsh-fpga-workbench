// 真跑一次 Vivado 模块综合 —— 人工清单第 8 项的 Vivado 半边,默认自检的一部分。
//
// 为什么值得自动化:check-fpga-tools 对五份 Vivado Tcl 只做**文本/形状**断言(旋钮、exit N、
// 收尾判定四层),证不了"这套脚本真能被 Vivado 跑完并出报告"。本文件用插件自己的
// `module-synth-new.mjs` 起 `synth/run_synth.tcl`,再用真 Vivado batch 跑一遍,读它的 PASS 行
// 与两份报告。2026-09-24 抓到的 `quit -f -code` 真 bug 就是这一类:文本全对、真跑必败。
//
// 找不到 Vivado 时记 SKIP 并退出 0(**不视作通过**):不是每台机器都装厂商工具,缺工具变红
// 就没人看了。器件型号从 `get_parts` 探针里取第一个可用件,避免写死一个本机没装的型号。
//
// 零删除:夹具建在系统临时目录,跑完留在原地并打印路径,由人处置。
import { spawnSync } from "./lib/spawn.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { partLooksComplete } from "../presets/fpga-workbench/tools/module/module-synth-new.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "presets", "fpga-workbench", "tools");

const failures = [];
const check = (ok, label, detail) => {
  if (ok) {
    console.log(`ok    ${label}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
};

/** Vivado 的 bin 下同时有 `vivado`(bash 启动器)与 `vivado.bat`;Windows 上必须取后者。 */
function preferBatch(file) {
  if (/\.(?:bat|cmd|exe)$/iu.test(file)) return file;
  for (const extension of [".bat", ".cmd", ".exe"]) {
    if (existsSync(file + extension)) return file + extension;
  }
  return file;
}

/** 找 Vivado:显式环境变量 → PATH → 常见安装根下逐个版本目录。 */
function findVivado() {
  const explicit = process.env.DSH_VIVADO;
  if (typeof explicit === "string" && explicit !== "" && existsSync(explicit)) return preferBatch(explicit);
  const found = spawnSync("where.exe", ["vivado"], { encoding: "utf8", windowsHide: true });
  if (found.status === 0) {
    const first = String(found.stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== "");
    if (first !== undefined && existsSync(first)) return preferBatch(first);
  }
  const candidates = [];
  for (const base of ["C:/AMDDesignTools", "C:/Xilinx/Vivado"]) {
    let versions = [];
    try {
      versions = readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      versions = [];
    }
    for (const version of versions) {
      candidates.push(join(base, version, "Vivado", "bin", "vivado.bat"));
      candidates.push(join(base, version, "bin", "vivado.bat"));
    }
  }
  return candidates.find((candidate) => existsSync(candidate));
}

const vivado = findVivado();
if (vivado === undefined) {
  console.log("SKIP  未找到 Vivado(设 DSH_VIVADO 或把它放进 PATH 再跑)—— 这不是通过");
  process.exit(0);
}
console.log(`      使用 Vivado:${vivado}`);

const fixture = join(tmpdir(), `dsh-vivado-check-${String(process.pid)}-${String(Date.now())}`);
const env = { ...process.env, XILINX_LOCAL_USER_DATA: "NO" };
/**
 * Vivado 在 Windows 上是 `vivado.bat` —— Node 不能直接 spawn 批处理文件(会 EINVAL),
 * 必须经 `cmd.exe /c`。参数里可能带空格,所以逐个加引号并把整条命令再包一层。
 */
const run = (command, args, cwd) => {
  const batch = /\.(?:bat|cmd)$/iu.test(command);
  const quoted = args.map((arg) => (/\s/u.test(arg) ? `"${arg}"` : arg)).join(" ");
  const spawnCommand = batch ? (process.env.ComSpec ?? "cmd.exe") : command;
  const spawnArgs = batch ? ["/d", "/s", "/c", `"${command}" ${quoted}`] : args;
  return spawnSync(spawnCommand, spawnArgs, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: batch,
    maxBuffer: 64 * 1024 * 1024
  });
};

// ── 1. 探针:列出本机已安装的器件,再用插件自己的判据筛一个 ──────────────────
mkdirSync(fixture, { recursive: true });
const probePath = join(fixture, "probe_part.tcl");
writeFileSync(
  probePath,
  [
    "set parts [lsort [get_parts -quiet]]",
    'set fh [open "parts.txt" w]',
    "foreach p $parts { puts $fh $p }",
    "close $fh",
    'puts "PART_PROBE_DONE: [llength $parts] parts"',
    "exit 0",
    ""
  ].join("\n"),
  "utf8"
);
const probe = run(vivado, ["-mode", "batch", "-notrace", "-nolog", "-nojournal", "-source", "probe_part.tcl"], fixture);
const partsFile = join(fixture, "parts.txt");
const installedParts = existsSync(partsFile)
  ? readFileSync(partsFile, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "")
  : [];
// 与插件解析器同口径:PRE 只认 `xc…`(module-synth-new 的 PART_RE),形状还要过 partLooksComplete。
// 有些机器只装了 XA/XQ 之类的车规件 —— 那种情况记 SKIP,不用"器件没选出来"去误伤自检。
const part = installedParts.find((candidate) => /^xc[a-z]{0,3}[0-9]/iu.test(candidate) && partLooksComplete(candidate));
check(
  probe.status === 0 && installedParts.length > 0,
  `探针列出本机已安装器件(实际 ${String(installedParts.length)} 个)`,
  `${probe.error === undefined ? "" : `${probe.error.message}\n        `}${String(probe.stdout ?? "").slice(-800)}${String(probe.stderr ?? "").slice(-400)}`
);
if (part === undefined) {
  console.log("SKIP  本机器件表里没有插件解析器认得的 `xc…` 完整型号(只有车规/其它族)—— 这不是通过");
  console.log(`      （共 ${String(installedParts.length)} 个器件,前几个:${installedParts.slice(0, 3).join("、")}）`);
  process.exit(0);
}
console.log(`      选用器件:${part}（本机共 ${String(installedParts.length)} 个）`);

// ── 2. 夹具:一个最小可综合模块 + 写明器件的 spec ────────────────────────────
mkdirSync(join(fixture, "rtl"), { recursive: true });
mkdirSync(join(fixture, "spec"), { recursive: true });
writeFileSync(
  join(fixture, "rtl", "uart_rx.sv"),
  [
    "`resetall",
    "`default_nettype none",
    "module uart_rx (",
    "  input  wire        clk,",
    "  input  wire        rst_n,",
    "  input  wire        rx,",
    "  output logic [7:0] data,",
    "  output logic       valid",
    ");",
    "  logic [3:0] bit_cnt_q;",
    "  logic [7:0] shift_q;",
    "  always_ff @(posedge clk) begin",
    "    if (!rst_n) begin",
    "      bit_cnt_q <= 4'd0;",
    "      shift_q   <= 8'd0;",
    "      data      <= 8'd0;",
    "      valid     <= 1'b0;",
    "    end else begin",
    "      shift_q <= {rx, shift_q[7:1]};",
    "      if (bit_cnt_q == 4'd7) begin",
    "        bit_cnt_q <= 4'd0;",
    "        data      <= shift_q;",
    "        valid     <= 1'b1;",
    "      end else begin",
    "        bit_cnt_q <= bit_cnt_q + 4'd1;",
    "        valid     <= 1'b0;",
    "      end",
    "    end",
    "  end",
    "endmodule",
    "`default_nettype wire",
    ""
  ].join("\n"),
  "utf8"
);
writeFileSync(
  join(fixture, "spec", "spec.md"),
  ["# uart_rx", "", `- 目标器件:${part}`, "- 顶层模块:uart_rx", ""].join("\n"),
  "utf8"
);

// ── 3. 用插件自己的命令起综合脚本(顺带验这条命令的真落点) ────────────────────
const newRun = run(process.execPath, [join(TOOLS, "module", "module-synth-new.mjs"), fixture, "uart_rx", "--kind", "synth-script"], ROOT);
const runScript = join(fixture, "synth", "run_synth.tcl");
check(
  newRun.status === 0 && existsSync(runScript),
  `module-synth-new 起出 synth/run_synth.tcl(退出码 ${String(newRun.status)})`,
  `${String(newRun.stdout ?? "")}${String(newRun.stderr ?? "")}`
);
if (!existsSync(runScript)) {
  console.log(`\nFAIL (${String(failures.length)}): Vivado 综合自检没跑成`);
  console.log(`夹具留在:${fixture}(本脚本不删任何文件,请自行处置)`);
  process.exit(1);
}

// ── 4. 真跑综合:判定只看脚本自己的 PASS 行 + 两份报告 ───────────────────────
const synth = run(
  vivado,
  ["-mode", "batch", "-source", "synth/run_synth.tcl", "-log", "synth/run_synth.log", "-journal", "synth/run_synth.jou"],
  fixture
);
const stdout = String(synth.stdout ?? "");
const stderr = String(synth.stderr ?? "");
const mainLog = join(fixture, "synth", "run_synth.log");
const logText = existsSync(mainLog) ? readFileSync(mainLog, "utf8") : "";
const combined = `${stdout}\n${logText}`;

check(synth.status === 0, `Vivado batch 综合退出码 0(实际 ${String(synth.status)})`, `${stdout.slice(-1200)}${stderr.slice(-600)}`);
check(/\[run_synth\] PASS: synthesis completed/u.test(combined), "综合脚本自己打了 PASS(收尾判定四层都过)");
check(!/^\s*ERROR:/mu.test(logText), "综合日志里没有 ERROR 行");
const utilization = join(fixture, "synth", "utilization.rpt");
const timing = join(fixture, "synth", "timing_summary.rpt");
const utilText = existsSync(utilization) ? readFileSync(utilization, "utf8") : "";
check(
  existsSync(utilization) && /LUT/u.test(utilText) && /Register|FF/u.test(utilText),
  "synth/utilization.rpt 有资源报告(LUT 与寄存器)"
);
check(existsSync(timing), "synth/timing_summary.rpt 有时序报告");
const luts = /Slice LUTs\*?\s*\|\s*(\d+)/u.exec(utilText)?.[1] ?? /CLB LUTs\*?\s*\|\s*(\d+)/u.exec(utilText)?.[1];
const ffs = /Slice Registers\s*\|\s*(\d+)/u.exec(utilText)?.[1] ?? /CLB Registers\s*\|\s*(\d+)/u.exec(utilText)?.[1];
if (luts !== undefined || ffs !== undefined) {
  console.log(`      器件 ${part}:LUT ${String(luts ?? "?")} / 寄存器 ${String(ffs ?? "?")}`);
}

console.log(`夹具留在:${fixture}(本脚本不删任何文件,请自行处置)`);
if (failures.length > 0) {
  console.log(`\nFAIL (${String(failures.length)}): ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("\nPASS: Vivado 真跑模块综合通过(起脚本 → batch 综合 → PASS 行 + 资源/时序报告)");
