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
# E8-11: one knob for vendor / precompiled libraries (space separated names -> vsim -L <lib>).
# Precompiled XPM or a project's own vendor library. Empty = exactly the old behaviour.
set VENDOR_LIBS   {}
set RESULT_LOG    {sim.log}
# E8(item A-3): the same HDL root compile.do used (project sim/ layout: {../src/rtl}).
set RTL_DIR       {../rtl}

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
# E8-07: work/ existing is not enough - it must match the CURRENT sources. compile.do writes a
# stamp (mtime + size per input); re-check every entry here and refuse to run on a mismatch.
set STAMP [file join work ".fpga-compile-stamp"]
if {![file isfile $STAMP]} {
  puts "\n\[ME\] ERROR: no compile stamp in work/ ($STAMP) - run the compile template first"
  puts "\[ME\] (without it the library cannot be tied to the current sources; no simulation verdict)"
  quit -f -code 1
}
set stamp_fh [open $STAMP r]
set stamp_text [read $stamp_fh]
close $stamp_fh
set stale {}
foreach line [split $stamp_text "\n"] {
  set line [string trim $line]
  if {$line eq "" || [string match "#*" $line]} continue
  lassign [split $line "\t"] path mtime size
  if {![file isfile $path]} {
    lappend stale "$path (gone)"
    continue
  }
  if {[file mtime $path] != $mtime || [file size $path] != $size} {
    lappend stale "$path (changed after compile)"
  }
  lappend stamped $path
}
# E8(item A-3): the per-file check above cannot notice a NEWLY ADDED source (it only walks the
# stamped list). Re-collect the current set and compare SETS first. Keep this collection rule
# identical to compile.do's collect_hdl (linked dirs skipped, rtl/ip stubs excluded).
proc collect_hdl {dir} {
  set out {}
  if {![file isdirectory $dir]} { return $out }
  foreach ext {.sv .v .vhd .vhdl} {
    foreach f [lsort [glob -nocomplain -directory $dir -type f *$ext]] { lappend out $f }
  }
  foreach sub [lsort [glob -nocomplain -directory $dir -type d *]] {
    if {[file type $sub] eq "link"} { continue }
    foreach f [collect_hdl $sub] { lappend out $f }
  }
  return $out
}
set verif_root_norm [string map {\\ /} $VERIF_ROOT]
set ip_prefix [string map {\\ /} [file normalize [file join $VERIF_ROOT $RTL_DIR ip]]]/
set current {}
foreach f [collect_hdl [file normalize [file join $VERIF_ROOT $RTL_DIR]]] {
  set f_norm [string map {\\ /} $f]
  if {[string match "*_stub.*" [file tail $f]] && [string first $ip_prefix $f_norm] == 0} { continue }
  lappend current $f
}
foreach pat $TB_PATTERN {
  foreach f [lsort [glob -nocomplain -directory $VERIF_ROOT -type f $pat]] { lappend current $f }
}
set cur_sorted [lsort -unique $current]
set stp_sorted [lsort -unique $stamped]
if {$cur_sorted ne $stp_sorted} {
  puts "\n\[ME\] ERROR: the source set changed since the last compile - re-run compile.do:"
  foreach f $cur_sorted {
    if {[lsearch -exact $stp_sorted $f] < 0} { puts "\[ME\]   + $f (added)" }
  }
  foreach f $stp_sorted {
    if {[lsearch -exact $cur_sorted $f] < 0} { puts "\[ME\]   - $f (no longer collected)" }
  }
  quit -f -code 1
}
if {[llength $stale] > 0} {
  puts "\n\[ME\] ERROR: work/ does not match the current sources - re-run compile.do first:"
  foreach f $stale { puts "\[ME\]   $f" }
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

# E8(item A-1): same rule as compile.do - an EXPLICITLY given mapping file must exist.
# Silently falling back here would let compile use A/modelsim.ini while run uses B/modelsim.ini.
set INI $INI_OVERRIDE
set INI_EXPLICIT [expr {$INI ne ""}]
foreach var {MODELSIM_INI MODELSIM} {
  if {$INI eq "" && [info exists ::env($var)]} {
    set INI [string trim [set ::env($var)]]
    set INI_EXPLICIT [expr {$INI ne ""}]
  }
}
if {$INI_EXPLICIT && ![file isfile $INI]} {
  puts "\n\[ME\] ERROR: modelsim.ini not found: $INI"
  puts "\[ME\] This was given explicitly (INI_OVERRIDE / MODELSIM_INI / MODELSIM); refusing"
  puts "\[ME\] to fall back to the install default. Fix the path, or clear it to use the default."
  quit -f -code 1
}
if {$INI eq "" || ![file isfile $INI]} {
  set MTI_ROOT [file dirname [file dirname [file normalize [info nameofexecutable]]]]
  set INI [file join $MTI_ROOT modelsim.ini]
}
set INI_FWD [string map {\\ /} $INI]
puts "\[ME\] modelsim.ini: $INI_FWD"

if {[catch {
  set vendor_args {}
foreach lib [split $VENDOR_LIBS " "] {
  if {$lib ne ""} { lappend vendor_args -L $lib }
}
vsim -c -modelsimini $INI_FWD -lib work {*}$vendor_args -l $RESULT_LOG -voptargs=+acc=rn $TOP
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
