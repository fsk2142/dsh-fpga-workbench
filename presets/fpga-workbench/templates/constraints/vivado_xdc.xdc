# ============================================================================ #
# constraints.xdc - module clock constraints (reference for synth timing)      #
#                                                                              #
# XDC files are CONSTRAINT files, not Tcl scripts: Vivado only accepts         #
# constraint commands here (create_clock, set_false_path, ...).  Control flow  #
# (if/source/file exists) is rejected with CRITICAL WARNINGs and the           #
# constraints are silently skipped, so a clocked design reports "no_clock".    #
#                                                                              #
# Module level needs CLOCKS ONLY -- the module has no pins, so pin assignment, #
# IO standard and input/output delay belong to the project level.  Add one     #
# create_clock per clock domain; a generated clock gets its own                #
# create_generated_clock; clocks with no real timing relation to each other    #
# get set_clock_groups -asynchronous (otherwise the tool reports unconstrained #
# or cross-domain paths).                                                      #
#                                                                              #
# The period is an ANALYSIS REFERENCE for this module, not a frequency target  #
# and not a submission threshold.  Take it from the clock section of           #
# spec/spec.md -- the module's single place for device and clock reference --  #
# and keep the names identical there and here.                                 #
#                                                                              #
# A valid clock with no internal setup path is reported as                     #
# no_internal_setup_path, not as a missing clock.                              #
# ============================================================================ #
#
# SECTION ORDER -- one xdc file, four sections, always in this order:
#
#   1. I/O constraints         pin assignment, IO standard, input/output delay
#   2. Clock constraints       create_clock / create_generated_clock / clock groups
#   3. Configuration commands  CFGBVS, CONFIG_VOLTAGE, other config properties
#   4. Debug constraints       ILA / VIO (create_debug_core, connect_debug_port)
#
# Keep this order and do not interleave the sections: the file is read top to
# bottom, and the pin and voltage settings of sections 1 and 3 have to be in
# place before the debug cores of section 4 are inserted.  At MODULE level only
# section 2 is filled in (see above, CLOCKS ONLY); sections 1, 3 and 4 belong to
# the project level.
#
# ---------------------------------------------------------------------------- #
# 1. I/O constraints -- PROJECT level (a module has no pins)                   #
# ---------------------------------------------------------------------------- #
# Pin assignment, IO standard and input/output delay are written at PROJECT
# level; leave this section empty in a module's xdc.
#
# Write them PER INTERFACE, one group after another -- clk, uart, pcie, spi ...
# -- not scattered pin by pin.  A group keeps that interface's pins, IO standard
# and input/output delay together, so a change to one interface lands in exactly
# one place and the group can be checked against the schematic as a unit.
#
#   # --- clk ---
#   set_property PACKAGE_PIN <pin> [get_ports clk]
#   set_property IOSTANDARD LVCMOS33 [get_ports clk]
#   # --- uart ---
#   set_property PACKAGE_PIN <pin> [get_ports uart_txd]
#   set_property IOSTANDARD LVCMOS33 [get_ports uart_txd]
#   # --- pcie ---
#   # --- spi ---
#   ...
#
# ---------------------------------------------------------------------------- #
# 2. Clock constraints -- MODULE level (the one section a module fills in)     #
# ---------------------------------------------------------------------------- #
create_clock -name clk -period 10.000 [get_ports clk]   ;# 与 simulation/testbench/systemverilog_testbench.sv 的 CLK_PERIOD 同源:改一个必须改另一个
#
# ---------------------------------------------------------------------------- #
# 3. Configuration commands (CFG) -- PROJECT level                             #
# ---------------------------------------------------------------------------- #
# Nothing to fill in at module level: CFGBVS, CONFIG_VOLTAGE and the other
# configuration properties are written at PROJECT level.
#
# ---------------------------------------------------------------------------- #
# 4. Debug constraints -- PROJECT level                                        #
# ---------------------------------------------------------------------------- #
# Nothing to fill in at module level: the ILA / VIO cores (create_debug_core,
# connect_debug_port) are inserted at PROJECT level.
