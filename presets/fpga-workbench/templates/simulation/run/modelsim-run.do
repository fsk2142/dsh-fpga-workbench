# ModelSim / Questa run-only template.
# Required caller variables:
#   TB_TOP      - compiled testbench top-level name
# Optional caller variables:
#   WORK_LIB    - compiled library name (default: work)
#   RESULT_LOG  - transcript used for result gating (default: sim-result.log)
#
# This script deliberately does not compile sources.

onerror { quit -code 2 -force }

if {![info exists TB_TOP] || $TB_TOP eq ""} {
    error "TB_TOP is required; do not guess the testbench top"
}
if {![info exists WORK_LIB] || $WORK_LIB eq ""} {
    set WORK_LIB "work"
}
if {![info exists RESULT_LOG] || $RESULT_LOG eq ""} {
    set RESULT_LOG "sim-result.log"
}

transcript file $RESULT_LOG
transcript on
vsim -lib $WORK_LIB $TB_TOP
run -all
transcript off

if {![file isfile $RESULT_LOG]} {
    error "simulation result log was not created: $RESULT_LOG"
}
set result_handle [open $RESULT_LOG r]
set result_text [read $result_handle]
close $result_handle

if {[regexp {TB FAILED|TB TIMEOUT|Fatal:|Error:} $result_text]} {
    puts stderr "SIMULATION FAILED: failure marker found in $RESULT_LOG"
    quit -code 1 -force
}
if {![regexp {ALL TESTS PASSED} $result_text]} {
    puts stderr "SIMULATION FAILED: PASS marker not found in $RESULT_LOG"
    quit -code 1 -force
}

puts "SIMULATION PASSED: $TB_TOP"
quit -code 0 -force
