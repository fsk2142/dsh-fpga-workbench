//==================================================================================//
// File Name    : tb_<module_snake>.sv                                              //
// Module Name  : <ModuleName> Testbench                                            //
// Created Date : <DATE>                                                            //
// Updated Date : <DATE>                                                            //
// Version      : v1.0                                                              //
// Author       : <Author>                                                          //
// Copyright    : Copyright (c) YYYY <Author>. All rights reserved.                 //
// Open Source  : This file is proprietary and NOT open source.                     //
//==================================================================================//
// TB conventions (current workflow) - every item is measured, keep all six:
//  1. Write compare data to the output path confirmed in spec/spec.md (the
//     verification plan), relative to verif/ - the TB runs with cwd = verif/.
//     Its suffix and serialization must match the comparison input file
//     declared there; do not rename it to a guessed .hex file.
//  2. Self-check: $error for each mismatch + err_cnt accumulation; the final
//     verdict MUST escalate to $fatal when err_cnt > 0, and print a clear PASS
//     message on success; $display-only FAIL verdicts are forbidden.
//     NOTE: $fatal alone does NOT make vsim exit non-zero (measured 2020.4) -
//     the exit code comes from the run-level gate in verif/run.do; keep it.
//  3. Input data: use the comparison input file declared in spec/spec.md only
//     when file-based stimulus is required; otherwise implement the confirmed
//     no-file method.
//  4. Timeout guard: watchdog in initial (#(CLK_PERIOD*N); $fatal(1,"TB TIMEOUT")).
//  5. Simulation models: use the REAL IP simulation models under verif/
//     (never simplified/fast stubs); dev and review must run the same models.
//  6. Complex modules may add tb_sub_*.sv and tb_top_*.sv beside this TB; run
//     each TB in its own process, the tb_sub_* ones before the top-level TB.
//     Each TB must use a unique dump name (dumps land in verif/).
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
  // Clock contract: the scaffold uses 100 MHz (10.000 ns) by default — **the same
  // number as `synth/<ModuleName>.xdc`**(`create_clock -period`). Two templates must
  // not disagree: a 250 MHz TB driving a design that is timed at 100 MHz makes any
  // post-synthesis timing conclusion meaningless. (Fifth review 2.2; guarded by
  // check-fpga-tools so the two stay equal.)
  // This is only the TB clock period/protocol pace, not physical timing proof.
  // If the module confirms another target or multiple clocks, change **both** files
  // together and record the approved periods in spec/spec.md.
  //----------------------------------------------------------------------------//
  localparam time CLK_PERIOD = 10ns;
  localparam integer WATCHDOG_CYCLES = 2_500_000;
  string comparison_output_file = "<COMPARISON_OUTPUT>";
  logic clk = 1'b0;
  always #(CLK_PERIOD / 2) clk = ~clk;

  //----------------------------------------------------------------------------//
  // TODO(AI): reset gen, DUT instance, interface drive, SVA asserts, and the
  // verification-contract-defined output dump. Keep checks at this clock rate.
  // The dump format is a red line: $fwrite/$fdisplay must not use %x/%h.
  // Write uppercase hex text with %c + ASCII arithmetic instead, e.g.:
  //   function automatic byte upnib(bit [3:0] n);
  //     upnib = n < 10 ? byte'(n + 8'h30) : byte'(n + 8'h37);
  //   endfunction
  //   $fwrite(fh, "%c%c\n", upnib(value[7:4]), upnib(value[3:0]));
  //----------------------------------------------------------------------------//

  //----------------------------------------------------------------------------//
  // Stimulus + checks. On mismatch: $error(...); err_cnt = err_cnt + 1;
  //----------------------------------------------------------------------------//
  initial begin
    $display("[TB] test start");
    // TODO: stimulus + checks
    $display("[TB] test done");

    // ---- final verdict ----
    // Keep both strings exactly as printed below: the run scripts grep for them,
    // and the FAIL verdict only becomes a non-zero exit code through the
    // run-level gate in verif/run.do, not through vsim itself (conventions #2).
    if (err_cnt == 0)
      $display("ALL TESTS PASSED (err_cnt=0)");
    else
      $fatal(1, "TB FAILED: err_cnt=%0d", err_cnt);
    $finish;
  end

  //----------------------------------------------------------------------------//
  // Watchdog: prevent hang (a hung TB must FAIL, not run forever).
  //----------------------------------------------------------------------------//
  initial begin
    #(CLK_PERIOD * WATCHDOG_CYCLES);
    $fatal(1, "TB TIMEOUT");
  end

endmodule
`resetall
`default_nettype wire