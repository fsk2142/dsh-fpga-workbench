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
create_clock -name clk -period 10.000 [get_ports clk]
