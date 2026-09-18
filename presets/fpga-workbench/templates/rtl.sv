//==================================================================================//
// File Name    : <ModuleName>.sv                                                   //
// Module Name  : <ModuleName>                                                      //
// Created Date : <DATE>                                                            //
// Updated Date : <DATE>                                                            //
// Version      : v1.0                                                              //
// Author       : <Author>                                                          //
// Copyright    : Copyright (c) YYYY <Author>. All rights reserved.                 //
// Open Source  : This file is proprietary and NOT open source.                     //
//                Unauthorized copying, modification, or distribution is prohibited.//
//==================================================================================//
// <ModuleName> : TODO describe core function / data flow / output format           //
//              (2-5 lines).                                                        //
//==================================================================================//
`resetall
`timescale 1ns/1ps
`default_nettype none

module <ModuleName> # (
    // TODO: module parameter description
                parameter                                           PIXEL_W =   8
    ) (
    // TODO: add clock and reset
    input       wire                                                clk,
    input       wire                                                rst,
    // TODO: add module ports (input wire / output logic, col69 aligned)
    input       wire    [PIXEL_W-1:0]                               din,
    output      logic   [PIXEL_W-1:0]                               dout
    );

//==================================================================================//
//    Local Parameters                                                              //
//==================================================================================//
// TODO: replace with module-specific localparams
                localparam int unsigned                             DEPTH   =   16;
                localparam int unsigned                             ADDR_W  =   $clog2(DEPTH);

//==================================================================================//
//    Types                                                                         //
//==================================================================================//
// TODO: replace with module-specific typedef / FSM states
                typedef enum logic [1:0] {
                    ST_IDLE,
                    ST_RUN,
                    ST_DONE
                } state_t;

//==================================================================================//
//    Registers                                                                     //
//==================================================================================//
// TODO: replace with module-specific registers / internal signals
                logic   [ADDR_W-1:0]                                rd_ptr_q;
                logic   [ADDR_W-1:0]                                wr_ptr_q;
                logic   [PIXEL_W-1:0]                               din_q;
                state_t                                             state_q;

//==================================================================================//
//    Combinational Logic                                                           //
//==================================================================================//
// TODO: replace with module-specific combinational logic
assign din_q = din;

always_comb begin
    // next-state / data-path muxes go here
end

//==================================================================================//
//    Sequential Logic                                                              //
//==================================================================================//
// TODO: replace with module-specific FSM / datapath registers
always_ff @( posedge clk ) begin
    if (rst) begin
        state_q <= ST_IDLE;
    end else begin
        // state_q <= ...;
    end
end

always_ff @( posedge clk ) begin
    if (rst) begin
        rd_ptr_q <= '{ADDR_W{1'b0}};
        wr_ptr_q <= '{ADDR_W{1'b0}};
    end else begin
        // state_q <= ...;
    end
end

//==================================================================================//
//    Functions Module                                                              //
//==================================================================================//
// TODO: replace with module-specific functions (if needed)
function automatic logic [PIXEL_W-1:0] saturate (
    input       logic   [PIXEL_W:0]                                 x
    );

    if ( x[PIXEL_W] == 1'b1 ) begin
        return  {PIXEL_W{1'b1}};
    end else begin
        return  x[PIXEL_W-1:0];
    end

endfunction

//==================================================================================//
//    Task Module                                                                   //
//==================================================================================//
// TODO: replace with module-specific tasks (if needed)
task automatic do_one_beat (
    input       logic   [PIXEL_W-1:0]                               beat
    );
    // TODO: replace with module-specific procedural body
    // (example: clock/reset wait, drive interface, etc.)
endtask

//==================================================================================//
//    Module Instantiation                                                          //
//==================================================================================//
// TODO: replace with module-specific submodule instantiations
// Use placeholder name 'sub_<role>' (role = functional role of the submodule);
// instantiate by need (1..N copies with u0_/u1_/... prefix per house style).
// Example shape (uncomment + rename + fill port map):

sub_<role>                                            u0_sub_<role> (
    .clk                                                            ( clk   ),
    .rst                                                            ( rst   ),
    .din                                                            ( din   ),
    .dout                                                           ( dout  )
    );

//==================================================================================//
//    Assertions                                                                    //
//==================================================================================//
// --- reset hold guard (placeholder; replace with module-specific assertions) ---
// Purpose : assert the design stays in reset while rst is asserted.
// Trigger : checked every posedge clk.
// Failure : $error flags if reset semantics are violated.
// TODO: replace with module-specific design assertions (FIFO no overflow / FSM one-hot / handshake).
assert property (@( posedge clk ) rst |-> rst)
    else $error("reset semantics violated");

// --- example: FIFO no-overflow (illustrative; remove if not applicable) ---
// Purpose : flag if write pointer catches read pointer while full.
// Trigger : every posedge clk.
// Failure : $error if both pointers equal while full flag asserted.
// SVA template (uncomment + adapt; do NOT keep in production without review):
// @( posedge clk ) disable iff (rst) (wr_full |-> wr_ptr_q != rd_ptr_q)

endmodule

`resetall
`default_nettype wire
