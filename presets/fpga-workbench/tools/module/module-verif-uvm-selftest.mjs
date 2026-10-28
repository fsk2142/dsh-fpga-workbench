#!/usr/bin/env node
/**
 * UVM 环境自检：确认「这台机器现在能不能跑 UVM」。
 *
 * ## 为什么需要它
 *
 * UVM 的门槛几乎全在**环境**上，而且失败方式都很不直观。实测踩到的（2026-10-28，
 * ModelSim SE-64 2020.4 + UVM 1.2）：
 *
 * 1. **缺 C 编译器** → `** Fatal: (vsim-7019) Can't locate a C/C++ compiler for
 *    'DPI Export Compilation'`。看着像 UVM 坏了，其实只是 gcc 不在 PATH。
 * 2. **module 里少 `import uvm_pkg::*`** → `Failed to find 'run_test'`。
 *    只写在 package 里不够，这条几乎每个人第一次都踩。
 * 3. **`run_test()` 之前有非零延时** → `[RUNPHSTIME] No non-zero delays are allowed
 *    before run_test()`。复位要放进 phase。
 * 4. **`expect` 当变量名** → `syntax error, unexpected "SystemVerilog keyword 'expect'"`。
 * 5. **`default_nettype none` + interface** → `(vlog-2892) Net type of 'clk' was not
 *    explicitly declared`。
 * 6. **多个 analysis port 接同一个 scoreboard** → 需要 `+uvm_analysis_imp_decl(_in)`。
 * 7. **`-L` 只给 vsim 不给 vlog** → 编译期就找不到 uvm_pkg。
 *
 * 本命令把 1、7 这类**环境**问题一次性查出来，并跑一个内置 demo 确认链路真的通。
 * 业务代码里 2–6 那几条查不出来（那是写法问题），但会在 demo 里以可对照的形式出现。
 *
 * ## 用法
 *
 * ```
 * node module-verif-uvm-selftest.mjs [--uvm <UVM 库目录>] [--json]
 * ```
 *
 * 退出码：0 = 环境可用且 demo 跑通；1 = demo 跑不通；2 = 用法错误；
 *         3 = 环境缺失（BLOCKED：没有 vsim / 没有 UVM 库 / 没有 C 编译器）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** 内置 demo：一个累加器 + 最小可跑 UVM 环境。自检用它证明链路通。 */
const DEMO_SOURCE = `\`timescale 1ns/1ps

module demo_dut (
  input  logic       clk,
  input  logic       rst,
  input  logic [7:0] din,
  input  logic       valid,
  output logic [7:0] dout,
  output logic       dout_valid
);
  always_ff @(posedge clk or posedge rst) begin
    if (rst) begin dout <= 8'd0; dout_valid <= 1'b0; end
    else begin
      dout_valid <= valid;
      if (valid) dout <= dout + din;
    end
  end
endmodule

interface demo_if (input logic clk);
  logic       rst;
  logic [7:0] din;
  logic       valid;
  logic [7:0] dout;
  logic       dout_valid;
endinterface

package demo_pkg;
  import uvm_pkg::*;
  \`include "uvm_macros.svh"

  \`uvm_analysis_imp_decl(_in)
  \`uvm_analysis_imp_decl(_out)

  class demo_item extends uvm_sequence_item;
    \`uvm_object_utils(demo_item)
    rand bit [7:0] din;
    function new(string name = "demo_item");
      super.new(name);
    endfunction
  endclass

  class demo_seq extends uvm_sequence #(demo_item);
    \`uvm_object_utils(demo_seq)
    function new(string name = "demo_seq");
      super.new(name);
    endfunction
    task body();
      demo_item item;
      repeat (20) begin
        item = demo_item::type_id::create("item");
        start_item(item);
        void'(item.randomize());
        finish_item(item);
      end
    endtask
  endclass

  class demo_driver extends uvm_driver #(demo_item);
    \`uvm_component_utils(demo_driver)
    virtual demo_if vif;
    function new(string name, uvm_component parent);
      super.new(name, parent);
    endfunction
    task run_phase(uvm_phase phase);
      forever begin
        seq_item_port.get_next_item(req);
        @(posedge vif.clk);
        vif.din   <= req.din;
        vif.valid <= 1'b1;
        seq_item_port.item_done();
      end
    endtask
  endclass

  class demo_monitor extends uvm_monitor;
    \`uvm_component_utils(demo_monitor)
    virtual demo_if vif;
    uvm_analysis_port #(demo_item) ap_in;
    uvm_analysis_port #(demo_item) ap_out;
    function new(string name, uvm_component parent);
      super.new(name, parent);
      ap_in  = new("ap_in", this);
      ap_out = new("ap_out", this);
    endfunction
    task run_phase(uvm_phase phase);
      demo_item in_tr, out_tr;
      forever begin
        @(posedge vif.clk);
        if (vif.valid) begin
          in_tr = demo_item::type_id::create("in_tr");
          in_tr.din = vif.din;
          ap_in.write(in_tr);
        end
        if (vif.dout_valid) begin
          out_tr = demo_item::type_id::create("out_tr");
          out_tr.din = vif.dout;
          ap_out.write(out_tr);
        end
      end
    endtask
  endclass

  class demo_scoreboard extends uvm_scoreboard;
    \`uvm_component_utils(demo_scoreboard)
    uvm_analysis_imp_in  #(demo_item, demo_scoreboard) imp_in;
    uvm_analysis_imp_out #(demo_item, demo_scoreboard) imp_out;
    bit [7:0] in_q[$];
    int err_cnt = 0;
    int checks  = 0;
    int exp_acc = 0;   // 不能叫 expect —— SV 关键字
    function new(string name, uvm_component parent);
      super.new(name, parent);
      imp_in  = new("imp_in", this);
      imp_out = new("imp_out", this);
    endfunction
    function void write_in(demo_item tr);
      in_q.push_back(tr.din);
    endfunction
    function void write_out(demo_item tr);
      bit [7:0] expected;
      checks++;
      if (in_q.size() == 0) begin
        err_cnt++;
        \`uvm_error("NOINPUT", "输入队列为空 —— 采集时机对不上")
        return;
      end
      expected = 8'(exp_acc + in_q.pop_front());
      exp_acc  = expected;
      if (tr.din !== expected) begin
        err_cnt++;
        \`uvm_error("MISMATCH", $sformatf("got %0d expected %0d", tr.din, expected))
      end
    endfunction
    function void report_phase(uvm_phase phase);
      if (checks == 0) \`uvm_error("NOCHECK", "0 次比对 —— 不能判通过")
      else if (err_cnt == 0) \`uvm_info("RESULT", $sformatf("ALL TESTS PASSED (err_cnt=0, checks=%0d)", checks), UVM_LOW)
      else \`uvm_error("RESULT", $sformatf("TB FAILED: err_cnt=%0d / checks=%0d", err_cnt, checks))
    endfunction
  endclass

  class demo_env extends uvm_env;
    \`uvm_component_utils(demo_env)
    demo_driver                  drv;
    uvm_sequencer #(demo_item)   sequencer;
    demo_monitor                 mon;
    demo_scoreboard              scb;
    function new(string name, uvm_component parent);
      super.new(name, parent);
    endfunction
    function void build_phase(uvm_phase phase);
      super.build_phase(phase);
      drv       = demo_driver::type_id::create("drv", this);
      mon       = demo_monitor::type_id::create("mon", this);
      scb       = demo_scoreboard::type_id::create("scb", this);
      sequencer = uvm_sequencer #(demo_item)::type_id::create("sequencer", this);
      mon.ap_in.connect(scb.imp_in);
      mon.ap_out.connect(scb.imp_out);
      if (!uvm_config_db #(virtual demo_if)::get(this, "", "vif", drv.vif))
        \`uvm_fatal("NOVIF", "driver 拿不到 vif")
      if (!uvm_config_db #(virtual demo_if)::get(this, "", "vif", mon.vif))
        \`uvm_fatal("NOVIF", "monitor 拿不到 vif")
    endfunction
    function void connect_phase(uvm_phase phase);
      super.connect_phase(phase);
      drv.seq_item_port.connect(sequencer.seq_item_export);
    endfunction
  endclass

  class demo_test extends uvm_test;
    \`uvm_component_utils(demo_test)
    demo_env env;
    function new(string name, uvm_component parent);
      super.new(name, parent);
    endfunction
    function void build_phase(uvm_phase phase);
      super.build_phase(phase);
      env = demo_env::type_id::create("env", this);
    endfunction
    task run_phase(uvm_phase phase);
      demo_seq seq;
      phase.raise_objection(this);
      env.drv.vif.rst <= 1'b1;
      repeat (3) @(posedge env.drv.vif.clk);
      env.drv.vif.rst <= 1'b0;
      seq = demo_seq::type_id::create("seq");
      seq.start(env.sequencer);
      repeat (4) @(posedge env.drv.vif.clk);
      phase.drop_objection(this);
    endtask
  endclass
endpackage

module demo_tb;
  import uvm_pkg::*;
  import demo_pkg::*;
  logic clk = 0;
  demo_if demo_vif (.clk(clk));
  demo_dut demo_dut_i (
    .clk(clk), .rst(demo_vif.rst), .din(demo_vif.din),
    .valid(demo_vif.valid), .dout(demo_vif.dout), .dout_valid(demo_vif.dout_valid)
  );
  always #5 clk = ~clk;
  initial begin
    demo_vif.rst = 1'b1;
    uvm_config_db #(virtual demo_if)::set(null, "*", "vif", demo_vif);
    run_test("demo_test");
  end
  initial begin
    #(10 * 100000);
    \`uvm_fatal("GLOBAL TIMEOUT", "顶层看门狗触发")
  end
endmodule
`;

const usage = () => {
  console.error("用法：node module-verif-uvm-selftest.mjs [--uvm <UVM 库目录>] [--json]");
  console.error("");
  console.error("  --uvm <目录>   显式指定 UVM 预编译库（默认在 ModelSim 安装目录下找 uvm-1.*）");
  console.error("  --json         输出机器可读 JSON");
  console.error("");
  console.error("查什么：vsim 在不在、UVM 库在不在、C 编译器在不在（UVM 1.2 的 DPI 需要），");
  console.error("        然后编译并跑一个 demo，确认整条链路真的通。");
  console.error("退出码：0 可用 / 1 demo 跑不通 / 2 用法错 / 3 环境缺失（BLOCKED）");
  process.exit(2);
};

const parseArgs = (argv) => {
  const options = { uvm: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--uvm") {
      options.uvm = argv[index + 1] ?? "";
      index += 1;
    } else usage();
  }
  return options;
};

/** 找 vsim（通配 modeltech* / questasim*，不写死版本）。 */
const findVsim = () => {
  const fromEnv = process.env.MODELSIM ?? "";
  if (fromEnv !== "" && existsSync(fromEnv)) return fromEnv;
  for (const root of ["C:/", "D:/"]) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^(?:modeltech|questasim|modelsim)/iu.test(name)) continue;
      for (const sub of ["win64", "win32aloem", "bin"]) {
        for (const exe of ["vsim.exe", "vsim"]) {
          const candidate = join(root, name, sub, exe);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return "";
};

/**
 * 找 UVM 预编译库。
 *
 * ModelSim 自带多份（uvm-1.1c / 1.1d / 1.2）。优先取版本号最大的 1.2 ——
 * 1.2 的 DPI 需要 C 编译器，但功能最完整；1.1d 不需要编译器但较旧。
 * 判断「是库」的依据是目录里有 `_info`（ModelSim 的库标记）。
 *
 * **但有个坑**（实测 2026-10-28）：`modelsim.ini` 里通常已经有
 * `mtiUvm = $MODEL_TECH/../uvm-1.1d`。如果 `-L` 用 1.2 而 ini 仍映射 1.1d，
 * 两边的 DPI 声明签名不同，运行时报
 * `** Error: (vsim-7015) Signature mismatch (0 parameters vs. 1 parameters)`。
 *
 * 所以：**先查 ini 里的 mtiUvm**，用它说的那一份，与 ini 保持一致；没有才按版本挑。
 * @param vsimPath - vsim 路径，用于推 ModelSim 安装根。
 * @returns `{ dir, fromIni }`。
 */
const findUvm = (vsimPath) => {
  const installRoot = resolve(vsimPath, "..", "..");

  // ① ini 里的 mtiUvm（版本与 ini 一致，最安全）
  const iniPath = join(installRoot, "modelsim.ini");
  if (existsSync(iniPath)) {
    const iniText = readFileSync(iniPath, "utf8");
    const match = /^\s*mtiUvm\s*=\s*(.+)$/mu.exec(iniText);
    if (match !== null) {
      const raw = match[1].trim().replace(/\$MODEL_TECH/gu, join(installRoot, "win64"));
      const resolved = resolve(raw.replace(/[\\/]/gu, "/"));
      if (existsSync(join(resolved, "_info"))) return { dir: resolved, fromIni: true };
    }
  }

  // ② 按版本挑最大的
  const candidates = [];
  if (existsSync(installRoot)) {
    let entries = [];
    try {
      entries = readdirSync(installRoot);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!/^uvm-\d/iu.test(name)) continue;
      const libDir = join(installRoot, name);
      if (existsSync(join(libDir, "_info"))) candidates.push(libDir);
    }
  }
  if (candidates.length === 0) return { dir: "", fromIni: false };
  candidates.sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
  return { dir: candidates[0], fromIni: false };
};

/** 找 C 编译器（UVM 1.2 的 DPI Export 需要）。返回目录，找不到为空串。 */
const findCompilerDir = () => {
  const candidates = [
    "C:/msys64/mingw64/bin",
    "C:/msys64/ucrt64/bin",
    "C:/mingw64/bin",
    "C:/MinGW/bin"
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "gcc.exe"))) return dir;
  }
  // PATH 里已有也行
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir !== "" && existsSync(join(dir, "gcc.exe"))) return dir;
  }
  return "";
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // ① vsim
  const vsim = findVsim();
  add("vsim", vsim !== "", vsim === "" ? "找不到 vsim（设 MODELSIM 环境变量或装 ModelSim）" : vsim);
  if (vsim === "") return report(options, checks, 3, { vsim, uvm: "", compiler: "" });

  // ② UVM 库
  const uvmFound = options.uvm !== "" ? { dir: options.uvm, fromIni: false } : findUvm(vsim);
  const uvm = uvmFound.dir;
  const uvmOk = uvm !== "" && existsSync(join(uvm, "_info"));
  add("UVM 预编译库", uvmOk, uvm === "" ? "安装目录下没有 uvm-1.*（ModelSim 通常自带）" : `${uvm}${uvmFound.fromIni ? "（与 modelsim.ini 的 mtiUvm 一致）" : ""}`);
  if (!uvmOk) return report(options, checks, 3, { vsim, uvm, compiler: "" });

  // ③ C 编译器（UVM 1.2 的 DPI 需要；缺了会报 vsim-7019）
  const compiler = findCompilerDir();
  add("C 编译器", compiler !== "", compiler === "" ? "没有 gcc —— UVM 1.2 的 DPI Export 会报 vsim-7019" : compiler);

  // ④ 跑 demo（缺编译器也试试：1.1d 不需要 DPI，可能仍能跑）
  const scratch = mkdtempSync(join(tmpdir(), "uvm-selftest-"));
  writeFileSync(join(scratch, "demo.sv"), DEMO_SOURCE, "utf8");
  writeFileSync(join(scratch, "compile.tcl"), `vlib work\nvlog -sv -L ${uvm} -work work demo.sv\n`, "utf8");
  writeFileSync(join(scratch, "run.tcl"), "run -all\nquit -f\n", "utf8");

  const env = {
    ...process.env,
    PATH: compiler === "" ? (process.env.PATH ?? "") : `${compiler}${delimiter}${process.env.PATH ?? ""}`
  };
  /**
   * 光把 gcc 加进 PATH **不够** —— ModelSim 仍然报 `vsim-7019 Can't locate a
   * C/C++ compiler`（实测 2026-10-28）。它读的是 `MTI_C_COMPILER` 这个显式变量，
   * 所以必须一起设上，否则 DPI Export 永远编不了。
   */
  if (compiler !== "") {
    env.MTI_C_COMPILER = join(compiler, "gcc.exe");
    env.MTI_CXX_COMPILER = join(compiler, "g++.exe");
    env.MTI_CPLUSPLUS_COMPILER = env.MTI_CXX_COMPILER;
  }

  const compile = spawnSync(vsim, ["-c", "-do", join(scratch, "compile.tcl")], {
    cwd: scratch,
    encoding: "utf8",
    env,
    timeout: 300_000
  });
  const compileOut = `${compile.stdout ?? ""}${compile.stderr ?? ""}`;
  const compileErrors = compileOut.split("\n").filter((line) => /\*\* Error/u.test(line));
  add("编译 demo", compileErrors.length === 0, compileErrors.length === 0 ? "无错误" : compileErrors[0].replace(/^#\s?/u, "").trim().slice(0, 120));

  if (compileErrors.length > 0) return report(options, checks, 1, { vsim, uvm, compiler }, compileOut);

  const run = spawnSync(vsim, ["-c", "-L", uvm, "-work", "work", "-do", join(scratch, "run.tcl"), "demo_tb"], {
    cwd: scratch,
    encoding: "utf8",
    env,
    timeout: 300_000
  });
  const runOut = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const passed = /ALL TESTS PASSED/u.test(runOut);
  const fatal = runOut.split("\n").find((line) => /UVM_FATAL|Fatal:/u.test(line));
  add("运行 demo", passed, passed ? "ALL TESTS PASSED（链路真通）" : (fatal ?? "没看到成功标记").replace(/^#\s?/u, "").trim().slice(0, 120));

  return report(options, checks, passed ? 0 : 1, { vsim, uvm, compiler }, runOut);
};

/**
 * 打印结果并退出。
 * @param options - 命令行选项。
 * @param checks - 每项检查结果。
 * @param code - 退出码。
 * @param paths - 探测到的路径。
 * @param raw - 原始输出（失败时附上，便于对照）。
 */
const report = (options, checks, code, paths, raw) => {
  const verdict = code === 0 ? "可用" : code === 3 ? "环境缺失（BLOCKED）" : "不可用";

  if (options.json) {
    console.log(JSON.stringify({ verdict, code, paths, checks }, null, 2));
    process.exit(code);
  }

  console.log("UVM 环境自检");
  console.log("");
  for (const check of checks) {
    console.log(`  ${check.ok ? "✅" : "❌"} ${check.name.padEnd(16)} ${check.detail}`);
  }
  console.log("");
  console.log(`  结论：${verdict}`);

  if (code === 3) {
    console.log("");
    console.log("  怎么修：");
    console.log("    · 没有 vsim → 装 ModelSim，或设 MODELSIM 环境变量指向 vsim.exe");
    console.log("    · 没有 UVM 库 → ModelSim 通常自带 uvm-1.2；用 --uvm <目录> 指定");
    console.log("    · 没有 C 编译器 → 装 MSYS2 的 mingw-w64-gcc，或把 gcc 目录加进 PATH");
    console.log("      （UVM 1.2 用 DPI Export，缺编译器会报 vsim-7019）");
  } else if (code === 1 && raw !== undefined) {
    console.log("");
    console.log("  demo 失败的原始输出（末 12 行）：");
    for (const line of raw.split("\n").filter((item) => /\S/u.test(item)).slice(-12)) {
      console.log(`    ${line.replace(/^#\s?/u, "").trim().slice(0, 110)}`);
    }
  } else if (code === 0) {
    console.log("");
    console.log("  可以开始写 UVM 了。骨架与「什么时候用它」见");
    console.log("  fpga-module-verif 的 references/uvm-when-and-how.md。");
  }

  process.exit(code);
};

main();
