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
                parameter int unsigned                              PIXEL_W =   8
    ) (
    //--- clock and reset ---
    input       wire                                                clk,
    input       wire                                                rst,
    //--- payload ---
    // TODO: replace with module-specific ports (input wire / output logic, col69 aligned)
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
// ---- Registers (sequential state) ----
//--- pointers ---
                logic   [ADDR_W-1:0]                                rd_ptr_r;
                logic   [ADDR_W-1:0]                                wr_ptr_r;
//--- data path (`_r` / `_d` mark registered values only) ---
                logic   [PIXEL_W-1:0]                               din_d;
                state_t                                             state_r;

// ---- Combinational ----
//--- next values (plain name or a meaningful suffix; `_r` / `_d` stay on registers) ---
                logic   [PIXEL_W-1:0]                               din_nxt;

//==================================================================================//
//    Combinational Logic                                                           //
//==================================================================================//
// TODO: replace with module-specific combinational logic
// `_r` / `_d` stay on registers: a combinational next value uses its plain name (or a meaningful suffix)
assign din_nxt = din;

// Stub combinational block: replace with the module-specific next-value logic.
always_comb begin
    // next-state / data-path muxes go here
end

//==================================================================================//
//    Sequential Logic                                                              //
//==================================================================================//
// TODO: replace with module-specific FSM / datapath registers
// Stub state register: replace with the module-specific FSM state.
always_ff @( posedge clk ) begin
    if (rst) begin
        state_r <= ST_IDLE;
    end else begin
        // state_r <= ...;
    end
end

// Stub datapath registers (pointers + the registered data value): reset to zero, then advance.
always_ff @( posedge clk ) begin
    if (rst) begin
        rd_ptr_r <= '{ADDR_W{1'b0}};
        wr_ptr_r <= '{ADDR_W{1'b0}};
        din_d    <= '{PIXEL_W{1'b0}};
    end else begin
        din_d <= din_nxt;
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
// Synthesis rules for this section: zero-time, synthesizable helpers only.
// No #delay, @(event), wait, force/release, file I/O or interface stimulus -
// those are testbench behaviour and belong in verif/, not in design RTL.
task automatic do_one_beat (
    input       logic   [PIXEL_W-1:0]                               beat
    );
    // TODO: replace with module-specific procedural body (combinational / zero-time only)
endtask

//==================================================================================//
//    Module Instantiation                                                          //
//==================================================================================//
// TODO: replace with module-specific submodule instantiations
// Use placeholder name 'sub_<role>' (role = functional role of the submodule);
// instantiate by need (1..N copies with u0_/u1_/... prefix per house style).
// Example shape (uncomment + rename + fill port map):
//
// sub_<role>                                          u0_sub_<role> (
//     .clk                                                            ( clk   ),
//     .rst                                                            ( rst   ),
//     .din                                                            ( din   ),
//     .dout                                                           ( dout  )
//     );

//==================================================================================//
//    Assertions                                                                    //
//==================================================================================//
// --- reset actually clears the FSM (example; replace with module-specific assertions) ---
// Guarded with `ifndef SYNTHESIS: Vivado synthesis ignores concurrent assertions anyway (it reports
// "ignoring concurrent assertion"), and only the simulator should evaluate them. Synthesis tools
// define SYNTHESIS; simulators do not, so the assertion stays live in simulation.
// (Purpose/Trigger/Failure 必须紧贴断言写 —— 检查器只往上收**连续**的 // 注释块。)
`ifndef SYNTHESIS
// Purpose : assert that an asserted rst really clears the state register next cycle
//           (a tautology like `rst |-> rst` would pass no matter how the logic is wired).
// Trigger : every posedge clk with rst asserted.
// Failure : $error flags if the state register is not ST_IDLE one cycle after reset.
// TODO: replace with module-specific design assertions (FIFO no overflow / FSM one-hot / handshake).
assert property (@( posedge clk ) rst |=> state_r == ST_IDLE)
    else $error("reset did not clear the FSM state");
`endif

// --- example: FIFO no-overflow (illustrative; remove if not applicable) ---
// Purpose : flag if write pointer catches read pointer while full.
// Trigger : every posedge clk.
// Failure : $error if both pointers equal while full flag asserted.
// SVA template (uncomment + adapt; do NOT keep in production without review):
// @( posedge clk ) disable iff (rst) (wr_full |-> wr_ptr_r != rd_ptr_r)

endmodule

`resetall
`default_nettype wire
