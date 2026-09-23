# ------------------------------------------------------------------------------
# File Name    : vivado_bitstream.tcl
# Level        : project only
# Description  : Generate bitstream from a completed implementation run
#                - open routed run / DCP
#                - write_bitstream (+ optional debug probes)
#                - copy .bit/.ltx into bit/ (archive point; recoverable)
#
# Usage (from the project root):
#   vivado.bat -mode batch -notrace -source <this>.tcl -log bit/run_bitstream.log
#
# Knobs (edit here; not environment variables):
#   MODULE_ROOT   project root (default: pwd)
#   PROJ_DIR      Vivado project dir (default: prj)
#   PROJ_NAME     Vivado project name
#   RUN_NAME      implementation run (default: impl_1)
#   TOP           top module name (bit file stem)
#   BIT_DIR       archive directory (default: bit)
#
# Status words (not project PASS by themselves):
#   BITSTREAM_OUTPUT_GENERATED
#   DRC_AND_ARCHIVE_PENDING  -- DRC + source-run record still required
# ------------------------------------------------------------------------------

set MODULE_ROOT [file normalize [pwd]]
set PROJ_DIR    [file join $MODULE_ROOT "prj"]
set PROJ_NAME   "REPLACE_PROJ"
set RUN_NAME    "impl_1"
set TOP         "REPLACE_TOP"
set BIT_DIR     [file join $MODULE_ROOT "bit"]

if {$PROJ_NAME eq "REPLACE_PROJ" || $TOP eq "REPLACE_TOP"} {
  puts "\[ME\] ERROR: fill PROJ_NAME and TOP (from doc/spec.md) before writing bitstream"
  quit -f -code 2
}

set xpr [file join $PROJ_DIR ${PROJ_NAME}.xpr]
if {![file isfile $xpr]} {
  puts "\[ME\] ERROR: project not found: $xpr"
  quit -f -code 2
}

open_project $xpr
set runs [get_runs -quiet $RUN_NAME]
if {[llength $runs] == 0} {
  puts "\[ME\] ERROR: implementation run not found: $RUN_NAME"
  quit -f -code 1
}

set status   [get_property STATUS   [get_runs $RUN_NAME]]
set progress [get_property PROGRESS [get_runs $RUN_NAME]]
puts "\[ME\] run $RUN_NAME status=$status progress=$progress"
if {$progress ne "100%" || ![string match "*Complete!*" $status]} {
  puts "\[ME\] ERROR: implementation run is not complete -- run implementation first"
  quit -f -code 1
}

open_run $RUN_NAME

file mkdir $BIT_DIR
set bitOut [file join $BIT_DIR ${TOP}.bit]
if {[catch {write_bitstream -force $bitOut} message]} {
  puts "\[ME\] ERROR: write_bitstream failed"
  puts $message
  quit -f -code 1
}

# optional debug probes
if {[llength [get_debug_cores -quiet]] > 0} {
  if {[catch {write_debug_probes -force [file join $BIT_DIR ${TOP}.ltx]} message]} {
    puts "\[ME\] WARN: write_debug_probes failed (bit still written)"
    puts $message
  }
}

if {![file isfile $bitOut]} {
  puts "\[ME\] ERROR: bitstream file missing after write: $bitOut"
  quit -f -code 1
}

set err_n  [get_msg_config -count -severity {ERROR}]
set crit_n [get_msg_config -count -severity {CRITICAL WARNING}]
puts "\[ME\] messages: ERROR=$err_n CRITICAL WARNING=$crit_n"
if {$err_n > 0} {
  puts "\[ME\] BITSTREAM FAILED: $err_n error(s)"
  quit -f -code 1
}

puts "\[ME\] BITSTREAM_OUTPUT_GENERATED: $bitOut"
puts "\[ME\] DRC_AND_ARCHIVE_PENDING: confirm DRC and record source run in doc/impl.md (see fpga-project-impl)"
quit -f -code 0
