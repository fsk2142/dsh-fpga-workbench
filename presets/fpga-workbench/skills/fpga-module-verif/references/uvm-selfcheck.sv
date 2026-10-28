//==================================================================================//
// File Name    : uvm_env.sv
// 用途         : UVM 验证环境骨架（**可自检**，见文件末尾的 self_test）
//
// 这份骨架的设计原则（重要，别改）：
//
//   1. **自带一个 demo DUT 并自己跑通**。`uvm_self_test()` 会用内置的 `uvm_demo_dut`
//      跑一遍完整链路（driver→DUT→monitor→scoreboard），打印 SELFTEST PASS/FAIL。
//      这样你能确认「环境是好的」，再往里换自己的 DUT —— 而不是拿到一份需要填
//      5 处占位符、填错就满屏报错的模板。
//
//   2. **参考模型与 RTL 走不同路径**。demo 的期望值用「累加历史输入队列」算，
//      与 DUT 的 `always_ff` 实现无关；绝不直接取 DUT 输出当期望值。
//
//   3. **零样本必须报错**。scoreboard 收到的 checks 为 0 时打 NOCHECK 错误 ——
//      空跑通过是最危险的假绿。
//
// 五个实测坑（ModelSim SE-64 2020.4 + UVM 1.2，2026-10-28，都踩过）：
//
//   ① **需要 C 编译器**：UVM 1.2 用 DPI Export，缺编译器报
//      `** Fatal: (vsim-7019) Can't locate a C/C++ compiler`
//      本机解法：`C:\msys64\mingw64\bin` 加进 PATH（gcc 16.2.0 可用）
//   ② **module 里必须 `import uvm_pkg::*`**：只写在 package 里不够，
//      否则 `run_test()` 报 `Failed to find 'run_test'`
//   ③ **`run_test()` 之前不能有任何非零延时**：UVM 硬规则
//      `No non-zero delays are allowed before run_test()`；
//      复位必须放进 phase 里
//   ④ **`expect` 是 SystemVerilog 关键字**：不能当变量名
//   ⑤ **`default_nettype none` 与 interface 冲突**：interface 端口声明会被当成
//      未声明网络，报 `(vlog-2892) Net type of 'clk' was not explicitly declared`
//
// 库位置：`C:\modeltech64_2020.4\uvm-1.2`（预编译，含 win64/uvm_dpi.dll）。
// 编译与运行**都要** `-L`：`vlog -sv -L <uvm-1.2> …` / `vsim -L <uvm-1.2> …`
//
// 判据不变：UVM 只是把激励组织得更好，它不判断设计对不对。成功标记、零样本检查、
// 覆盖率、PASS/FAIL 的判法仍走 fpga-module-verif。
//==================================================================================//
`timescale 1ns/1ps

//----------------------------------------------------------------------------------
// demo DUT：一个累加器。**只用于自检**，换成自己的模块时删掉这一段。
//
// 它故意做得很简单 —— 自检要验证的是「UVM 链路通不通」，不是这个模块对不对。
//----------------------------------------------------------------------------------
module uvm_demo_dut (
  input  logic       clk,
  input  logic       rst,
  input  logic [7:0] din,
  input  logic       valid,
  output logic [7:0] dout,
  output logic       dout_valid
);
  always_ff @(posedge clk or posedge rst) begin
    if (rst) begin
      dout       <= 8'd0;
      dout_valid <= 1'b0;
    end else begin
      dout_valid <= valid;
      if (valid) dout <= dout + din;
    end
  end
endmodule

//----------------------------------------------------------------------------------
// 接口：DUT 端口集中一处。driver / monitor 通过 virtual interface 拿到它。
//----------------------------------------------------------------------------------
interface uvm_demo_if (input logic clk);
  logic       rst;
  logic [7:0] din;
  logic       valid;
  logic [7:0] dout;
  logic       dout_valid;
endinterface

package uvm_demo_pkg;

  import uvm_pkg::*;
  `include "uvm_macros.svh"

  // 一个 scoreboard 要接多个 analysis port 时，UVM 要求先用这个宏声明带后缀的
  // imp 类型（`uvm_analysis_imp_in` / `_out`）。不加这两行会报
  // `uvm_analysis_imp_in is not defined`。
  `uvm_analysis_imp_decl(_in)
  `uvm_analysis_imp_decl(_out)

  // ── 事务对象 ────────────────────────────────────────────────────────────────
  class uvm_demo_item extends uvm_sequence_item;
    `uvm_object_utils(uvm_demo_item)

    rand bit [7:0] din;

    function new(string name = "uvm_demo_item");
      super.new(name);
    endfunction
  endclass

  // ── Sequence：激励写法。可被不同 test 复用 —— 这是 UVM 相对定向 TB 的核心收益 ──
  class uvm_demo_seq extends uvm_sequence #(uvm_demo_item);
    `uvm_object_utils(uvm_demo_seq)

    int count = 20;

    function new(string name = "uvm_demo_seq");
      super.new(name);
    endfunction

    task body();
      uvm_demo_item item;
      repeat (count) begin
        item = uvm_demo_item::type_id::create("item");
        start_item(item);
        void'(item.randomize());
        finish_item(item);
      end
    endtask
  endclass

  // ── Driver：把 item 变成端口时序 ────────────────────────────────────────────
  class uvm_demo_driver extends uvm_driver #(uvm_demo_item);
    `uvm_component_utils(uvm_demo_driver)

    virtual uvm_demo_if vif;

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

  // ── Monitor：只观察、不驱动。**同时采输入与输出** ──────────────────────────
  //
  // 为什么连输入一起采：scoreboard 要独立算期望值，就必须知道「当时送进去的是什么」。
  // 只采输出的话，期望值只能靠猜或退回「拿 DUT 输出当期望值」（那就永远通过）。
  class uvm_demo_monitor extends uvm_monitor;
    `uvm_component_utils(uvm_demo_monitor)

    virtual uvm_demo_if vif;
    uvm_analysis_port #(uvm_demo_item) ap_in;    // 送出：本次输入
    uvm_analysis_port #(uvm_demo_item) ap_out;   // 送出：本次输出

    bit [7:0] last_din;

    function new(string name, uvm_component parent);
      super.new(name, parent);
      ap_in  = new("ap_in", this);
      ap_out = new("ap_out", this);
    endfunction

    task run_phase(uvm_phase phase);
      uvm_demo_item in_tr;
      uvm_demo_item out_tr;
      forever begin
        @(posedge vif.clk);
        if (vif.valid) begin
          in_tr = uvm_demo_item::type_id::create("in_tr");
          in_tr.din = vif.din;
          ap_in.write(in_tr);
        end
        if (vif.dout_valid) begin
          out_tr = uvm_demo_item::type_id::create("out_tr");
          out_tr.din = vif.dout;
          ap_out.write(out_tr);
        end
      end
    endtask
  endclass

  // ── Scoreboard：**独立参考模型** ────────────────────────────────────────────
  //
  // 期望值算法走「输入队列 + 累加」，与 DUT 的 always_ff 实现路径完全不同。
  // 换自己的模块时，这里必须换成 spec 对应的参考算法 ——
  // **绝不能** `exp = dut_out`（那就等于自己跟自己比，永远通过）。
  class uvm_demo_scoreboard extends uvm_scoreboard;
    `uvm_component_utils(uvm_demo_scoreboard)

    uvm_analysis_imp_in  #(uvm_demo_item, uvm_demo_scoreboard) imp_in;
    uvm_analysis_imp_out #(uvm_demo_item, uvm_demo_scoreboard) imp_out;

    bit [7:0] in_q[$];       // 期望输入队列
    int err_cnt = 0;
    int checks  = 0;
    int exp_acc = 0;         // 注意：不能叫 expect —— 那是 SV 关键字

    function new(string name, uvm_component parent);
      super.new(name, parent);
      imp_in  = new("imp_in", this);
      imp_out = new("imp_out", this);
    endfunction

    function void write_in(uvm_demo_item tr);
      in_q.push_back(tr.din);
    endfunction

    function void write_out(uvm_demo_item tr);
      bit [7:0] expected;

      checks++;
      if (in_q.size() == 0) begin
        err_cnt++;
        `uvm_error("NOINPUT", $sformatf("收到输出 %0d 但输入队列是空的 —— 采集时机对不上", tr.din))
        return;
      end

      // 参考模型：累加历史输入（与 DUT 的 always_ff 是两条不同的路）
      expected = 8'(exp_acc + in_q.pop_front());
      exp_acc  = expected;

      if (tr.din !== expected) begin
        err_cnt++;
        `uvm_error("MISMATCH", $sformatf("got %0d expected %0d", tr.din, expected))
      end
    endfunction

    // report_phase 是 UVM 里天然的成功/失败出口，等价于定向 TB 的 $fatal。
    function void report_phase(uvm_phase phase);
      if (checks == 0) begin
        // **零样本不算通过** —— 与 fpga-module-verif 的判据一致。
        `uvm_error("NOCHECK", "0 次比对 —— 不能判通过")
      end else if (err_cnt == 0) begin
        `uvm_info("RESULT", $sformatf("ALL TESTS PASSED (err_cnt=0, checks=%0d)", checks), UVM_LOW)
      end else begin
        `uvm_error("RESULT", $sformatf("TB FAILED: err_cnt=%0d / checks=%0d", err_cnt, checks))
      end
    endfunction
  endclass

  // ── Env：装配与连线 ────────────────────────────────────────────────────────
  class uvm_demo_env extends uvm_env;
    `uvm_component_utils(uvm_demo_env)

    uvm_demo_driver                drv;
    uvm_sequencer #(uvm_demo_item) sequencer;
    uvm_demo_monitor               mon;
    uvm_demo_scoreboard            scb;

    function new(string name, uvm_component parent);
      super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
      super.build_phase(phase);
      drv       = uvm_demo_driver::type_id::create("drv", this);
      mon       = uvm_demo_monitor::type_id::create("mon", this);
      scb       = uvm_demo_scoreboard::type_id::create("scb", this);
      sequencer = uvm_sequencer #(uvm_demo_item)::type_id::create("sequencer", this);

      mon.ap_in.connect(scb.imp_in);
      mon.ap_out.connect(scb.imp_out);

      // vif 取不到必须 fatal —— 否则仿真空跑，最后误以为「通过」。
      if (!uvm_config_db #(virtual uvm_demo_if)::get(this, "", "vif", drv.vif))
        `uvm_fatal("NOVIF", "driver 拿不到 virtual interface")
      if (!uvm_config_db #(virtual uvm_demo_if)::get(this, "", "vif", mon.vif))
        `uvm_fatal("NOVIF", "monitor 拿不到 virtual interface")
    endfunction

    function void connect_phase(uvm_phase phase);
      super.connect_phase(phase);
      drv.seq_item_port.connect(sequencer.seq_item_export);
    endfunction
  endclass

  // ── Test：选 sequence、管复位 ──────────────────────────────────────────────
  //
  // 复位放在 run_phase 里做 —— **不能放顶层 initial 里延时**（坑③）。
  class uvm_demo_test extends uvm_test;
    `uvm_component_utils(uvm_demo_test)

    uvm_demo_env env;

    function new(string name, uvm_component parent);
      super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
      super.build_phase(phase);
      env = uvm_demo_env::type_id::create("env", this);
    endfunction

    task run_phase(uvm_phase phase);
      uvm_demo_seq seq;

      phase.raise_objection(this);

      // 复位（在 phase 内，所以有延时是允许的）
      env.drv.vif.rst <= 1'b1;
      repeat (3) @(posedge env.drv.vif.clk);
      env.drv.vif.rst <= 1'b0;

      seq = uvm_demo_seq::type_id::create("seq");
      seq.start(env.sequencer);

      // 等 DUT 把流水线排空，再放 objection
      repeat (4) @(posedge env.drv.vif.clk);

      phase.drop_objection(this);
    endtask
  endclass

endpackage

//----------------------------------------------------------------------------------
// 顶层：**必须 import uvm_pkg 与测试 package**（坑②）
//----------------------------------------------------------------------------------
module uvm_demo_tb;

  import uvm_pkg::*;
  import uvm_demo_pkg::*;

  logic clk = 0;

  uvm_demo_if demo_vif (.clk(clk));

  uvm_demo_dut demo_dut (
    .clk        (clk),
    .rst        (demo_vif.rst),
    .din        (demo_vif.din),
    .valid      (demo_vif.valid),
    .dout       (demo_vif.dout),
    .dout_valid (demo_vif.dout_valid)
  );

  always #5 clk = ~clk;

  // **run_test() 之前不能有任何非零延时**（坑③）：
  // 所以这里只做 0 时刻的事 —— 拉复位、set config_db、启动。
  initial begin
    demo_vif.rst = 1'b1;
    uvm_config_db #(virtual uvm_demo_if)::set(null, "*", "vif", demo_vif);
    run_test("uvm_demo_test");
  end

  // 顶层兜底看门狗：UVM 的 objection 机制失效时也能终止。
  // 时长要比正常仿真长得多，否则正常用例会被它误杀。
  initial begin
    #(10 * 100000);
    `uvm_fatal("GLOBAL TIMEOUT", "顶层看门狗触发")
  end

endmodule
