//==================================================================================//
// File Name    : <ModuleName>.sv                                                   //
// Module Name  : <ModuleName>                                                      //
// Created Date : <DATE>                                                            //
// Updated Date : <DATE>                                                            //
// Version      : v1.0                                                              //
// Author       : <Author>                                                          //
// Copyright    : Copyright (c) YYYY <Author>. All rights reserved.                 //
// Open Source  : This file is proprietary and NOT open source.                     //
//==================================================================================//
// <ModuleName> : TODO describe function, interfaces, latency, and reset behavior.  //
//==================================================================================//
`resetall
`timescale 1ns/1ps
`default_nettype none

module <ModuleName> # (
                parameter int unsigned                              DATA_W  =   8
    ) (
    input       wire                                                clk,
    input       wire                                                rst,
    input       wire    [DATA_W-1:0]                                din,
    output      logic   [DATA_W-1:0]                                dout
    );

//==================================================================================//
//    Local Parameters                                                              //
//==================================================================================//
                localparam int unsigned                             DEPTH   =   16;

//==================================================================================//
//    Types                                                                         //
//==================================================================================//
                typedef enum logic [0:0] {
                    ST_IDLE,
                    ST_RUN
                } state_t;

//==================================================================================//
//    Registers                                                                     //
//==================================================================================//
                logic   [DATA_W-1:0]                                dout_r;
                state_t                                             state_r;

//==================================================================================//
//    Combinational Logic                                                           //
//==================================================================================//
always_comb begin
    dout = dout_r;
end

//==================================================================================//
//    Sequential Logic                                                              //
//==================================================================================//
always_ff @( posedge clk ) begin
    if (rst) begin
        dout_r  <= {DATA_W{1'b0}};
        state_r <= ST_IDLE;
    end else begin
        dout_r  <= din;
        state_r <= ST_RUN;
    end
end

//==================================================================================//
//    Functions Module                                                              //
//==================================================================================//
function automatic logic [DATA_W-1:0] pass_value (
    input       logic   [DATA_W-1:0]                               value
    );
    return value;
endfunction

//==================================================================================//
//    Task Module                                                                   //
//==================================================================================//
// Add module-local tasks here only when they improve clarity.

//==================================================================================//
//    Module Instantiation                                                          //
//==================================================================================//
// Add reviewed submodule instances here.

//==================================================================================//
//    Assertions                                                                    //
//==================================================================================//
// Purpose : reset must clear the output register.
// Trigger : a rising clock edge while rst is asserted.
// Failure : the output register was not cleared on the following cycle.
a_reset_clears_output : assert property (@( posedge clk ) rst |=> dout_r == {DATA_W{1'b0}})
    else $error("reset did not clear dout_r");

endmodule

`resetall
`default_nettype wire
