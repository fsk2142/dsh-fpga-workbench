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
// Self-checking testbench: every mismatch increments err_cnt and the final verdict //
// is either ALL TESTS PASSED or a fatal TB FAILED.                                 //
//==================================================================================//
`resetall
`timescale 1ns/1ps
`default_nettype none

module tb_<module_snake>;

    localparam time CLK_PERIOD = 10ns;
    localparam int unsigned WATCHDOG_CYCLES = 1_000_000;

    integer err_cnt = 0;
    logic clk = 1'b0;
    logic rst = 1'b1;

    always #(CLK_PERIOD / 2) clk = ~clk;

    // TODO: declare interface signals and instantiate the real DUT.

    initial begin
        repeat (4) @(posedge clk);
        rst <= 1'b0;

        // TODO: drive confirmed stimulus and perform self-checking comparisons.
        // On mismatch:
        //   $error("descriptive mismatch");
        //   err_cnt = err_cnt + 1;

        if (err_cnt == 0)
            $display("ALL TESTS PASSED (err_cnt=0)");
        else
            $fatal(1, "TB FAILED: err_cnt=%0d", err_cnt);
        $finish;
    end

    initial begin
        #(CLK_PERIOD * WATCHDOG_CYCLES);
        $fatal(1, "TB TIMEOUT");
    end

endmodule

`resetall
`default_nettype wire
