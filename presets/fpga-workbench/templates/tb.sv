//==================================================================================//
// File Name    : tb_<module_snake>.sv                                               //
// Module Name  : <ModuleName> Testbench                                              //
// Created Date : <DATE>                                                              //
// Updated Date : <DATE>                                                              //
// Version      : v1.0                                                                //
// Author       : <Author>                                                            //
// Copyright    : Copyright (c) YYYY <Author>. All rights reserved.                   //
// Open Source  : This file is proprietary and NOT open source.                       //
//==================================================================================//
// TB conventions (new workflow):
//  1. Write compare data to the confirmed module-plan comparison_output path
//     (relative to verif/sim/). Its suffix and serialization must match the
//     comparison_input declaration; do not rename it to a guessed .hex file.
//  2. Self-check: $error for each mismatch + err_cnt accumulation; the final
//     verdict MUST escalate to $fatal when err_cnt > 0 (non-zero exit), and
//     print a clear PASS message on success; $display-only FAIL verdicts are
//     forbidden (a failed TB must exit through $fatal)
//  3. Input data: use the module-plan comparison_input only when file-based
//     stimulus is required; otherwise implement the confirmed no-file method.
//  4. Timeout guard: watchdog in initial (#(CLK_PERIOD*N); $fatal(1,"TB TIMEOUT"))
//  5. Simulation models: use the REAL IP simulation models from ip/ (never
//     simplified/fast stubs); dev and review must run the same models
//  6. Complex modules may add tb_sub_*.sv and tb_top_*.sv beside this TB.
//     run_auto.do executes submodule TBs before the top-level TB; each TB must
//     use a unique dump name and the module SPEC selects the final comp dump.
//==================================================================================//
`resetall
`timescale 1ns/1ps
`default_nettype none

module tb_<module_snake>;

  //----------------------------------------------------------------------------//
  // Error counter: every check failure does $error + err_cnt increment; the
  // final verdict escalates to $fatal when err_cnt > 0.
  //----------------------------------------------------------------------------//
  integer err_cnt = 0;

  //----------------------------------------------------------------------------//
  // Clock contract: the scaffold uses 250 MHz (4.000 ns) by default.
  // This is only the TB clock period/protocol pace, not physical timing proof.
  // If the module confirms another target or multiple clocks, update this TB
  // and record the approved periods in doc/main_spec.md and clock_constraints.xdc.
  //----------------------------------------------------------------------------//
  localparam time CLK_PERIOD = 4ns;
  localparam integer WATCHDOG_CYCLES = 2_500_000;
  string comparison_output_file = "<COMPARISON_OUTPUT>";
  logic clk = 1'b0;
  always #(CLK_PERIOD / 2) clk = ~clk;

  // TODO(AI): reset gen, DUT instance, interface drive, SVA asserts, and the
  // verification-contract-defined output dump. Keep checks at this clock rate.
  // The dump format is a red line: $fwrite/$fdisplay must not use %x/%h.
  // Write uppercase hex text with %c + ASCII arithmetic instead, e.g.:
  //   function automatic byte upnib(bit [3:0] n);
  //     upnib = n < 10 ? byte'(n + 8'h30) : byte'(n + 8'h37);
  //   endfunction
  //   $fwrite(fh, "%c%c\n", upnib(value[7:4]), upnib(value[3:0]));
  //----------------------------------------------------------------------------//

  initial begin
    $display("[TB] test start");
    // TODO: stimulus + checks (on mismatch: $error(...); err_cnt = err_cnt + 1;)
    $display("[TB] test done");

    // ---- final verdict (contract: err_cnt>0 must exit non-zero) ----
    if (err_cnt == 0)
      $display("ALL TESTS PASSED (err_cnt=0)");
    else
      $fatal(1, "TB FAILED: err_cnt=%0d", err_cnt);
    $finish;
  end

  // watchdog: prevent hang
  initial begin
    #(CLK_PERIOD * WATCHDOG_CYCLES);
    $fatal(1, "TB TIMEOUT");
  end

endmodule
`resetall
`default_nettype wire
