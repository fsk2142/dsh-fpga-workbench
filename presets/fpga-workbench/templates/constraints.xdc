# ============================================================================ #
# clock_constraints.xdc - module timing analysis reference                    #
#                                                                              #
# XDC files are CONSTRAINT files, not Tcl scripts: Vivado only accepts         #
# constraint commands here (create_clock, set_false_path, ...).  Control       #
# flow (if/source/file exists) is rejected with CRITICAL WARNINGs and the     #
# constraints are silently skipped, so a clocked design reports "no_clock".   #
# The period below is an analysis reference selected for this module.  It is   #
# not a universal frequency target or a submission threshold.  Update it for  #
# the module's actual interface and add one create_clock per extra clock        #
# domain (names must match TIMING_CLOCKS in device_config.tcl).                #
#                                                                              #
# This is a module clock constraint only; it is not a board pin constraint.    #
# A valid clock with no internal setup path is reported as                    #
# no_internal_setup_path, not as a missing clock.                             #
# ============================================================================ #
create_clock -name clk_reference -period 10.000 [get_ports clk]
