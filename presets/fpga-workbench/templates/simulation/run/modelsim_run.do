# ============================================================================ #
# ModelSim / QuestaSim run template (run from the module verif/ directory)      #
# ============================================================================ #
# Run the compile template first. This file loads the existing local work/
# library, runs exactly one testbench, and converts transcript evidence into a
# trustworthy process exit code. It deliberately contains no compile command.
#
# ModelSim 2020.4 does not reliably turn SystemVerilog $fatal into a non-zero
# process exit code. Therefore the gate below checks Error/Fatal lines and the
# exact ALL TESTS PASSED marker before it returns success.
set TB_PATTERN    {tb_*.sv tb_*.v tb_*.vhd tb_*.vhdl}
set TOP_OVERRIDE  {}
set INI_OVERRIDE  {}
set RESULT_LOG    {sim.log}

onbreak { resume }
onerror { quit -f -code 1 }

set VERIF_ROOT [file normalize [pwd]]
# 只认 HDL 测试平台(F5-03):tb_notes.txt / tb_*.md / *.bak 不算 TB
set TB_FILE {}
foreach pat $TB_PATTERN {
  foreach f [lsort [glob -nocomplain -directory $VERIF_ROOT -type f $pat]] {
    lappend TB_FILE $f
  }
}
set TB_FILE [lsort -unique $TB_FILE]

if {![file isdirectory work]} {
  puts "\n\[ME\] ERROR: local work/ library is missing - run the compile template first"
  quit -f -code 1
}
if {[llength $TB_FILE] == 0} {
  puts "\n\[ME\] ERROR: no $TB_PATTERN testbench in $VERIF_ROOT"
  quit -f -code 1
}
if {[llength $TB_FILE] > 1 && $TOP_OVERRIDE eq ""} {
  puts "\n\[ME\] ERROR: $TB_PATTERN matched [llength $TB_FILE] testbenches, but TOP_OVERRIDE is empty - refusing to pick one:"
  foreach f $TB_FILE { puts "\[ME\]   $f" }
  puts "\[ME\] set TOP_OVERRIDE to the compiled testbench module for this run."
  quit -f -code 1
}

if {$TOP_OVERRIDE ne ""} {
  set TOP $TOP_OVERRIDE
} else {
  set TOP [file rootname [file tail [lindex $TB_FILE 0]]]
}

set INI $INI_OVERRIDE
foreach var {MODELSIM_INI MODELSIM} {
  if {$INI eq "" && [info exists ::env($var)]} {
    set INI [string trim [set ::env($var)]]
  }
}
if {$INI eq "" || ![file isfile $INI]} {
  set MTI_ROOT [file dirname [file dirname [file normalize [info nameofexecutable]]]]
  set INI [file join $MTI_ROOT modelsim.ini]
}
set INI_FWD [string map {\\ /} $INI]
puts "\[ME\] modelsim.ini: $INI_FWD"

if {[catch {
  vsim -c -modelsimini $INI_FWD -lib work -l $RESULT_LOG -voptargs=+acc=rn $TOP
} message]} {
  puts "\n\[ME\] ERROR: vsim failed to start: $message"
  quit -f -code 1
}

# Must be set after elaboration. Otherwise $finish/$fatal terminates the session
# before this run-level gate can inspect the transcript.
onfinish stop
run -all

set errors 0
set passed 0
if {[file isfile $RESULT_LOG]} {
  set fh [open $RESULT_LOG r]
  set text [read $fh]
  close $fh
  foreach line [split $text "\n"] {
    if {[string match "** Error*" $line] || [string match "** Fatal*" $line]} {
      incr errors
    }
    # E8-03:只认**完整成功行**;否定句/自述“没看到 marker”不得算通过
    set raw [string trim $line]
    if {[string match "# *" $raw]} { set raw [string trim [string range $raw 2 end]] }
    if {$raw eq "ALL TESTS PASSED (err_cnt=0)" || $raw eq "ALL TESTS PASSED"} { incr passed }
  }
}

if {$errors > 0} {
  puts "\n\[ME\] ERROR: $errors Error/Fatal line(s) in $RESULT_LOG - FAILED"
  quit -f -code 1
}
if {$passed == 0} {
  puts "\n\[ME\] ERROR: no success marker (ALL TESTS PASSED) in $RESULT_LOG - FAILED"
  quit -f -code 1
}

puts "\n\[ME\] SIMULATION PASSED: $TOP ($RESULT_LOG)"
quit -f -code 0
