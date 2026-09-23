# ============================================================================ #
# ModelSim / QuestaSim compile template (run from the module verif/ directory)  #
# ============================================================================ #
# This file only discovers and compiles sources. It never starts simulation.
# Console text stays in English because older ModelSim releases write the local
# code page to transcripts and Chinese gate messages become unreadable.
#
# Settings passed through the environment:
#   Template knobs (edit the script; not env vars):
#     RTL_DIR       - HDL root relative to this script (VERIF_ROOT = pwd).
#                     module verif/ layout: {../rtl}
#                     project sim/ layout:  {../src/rtl}
#     INI_OVERRIDE  - force a library mapping file (else MODELSIM_INI env, else install default)
#   Environment inputs:
#     MODELSIM_INI / MODELSIM / TB_DEFINES
#   TB_DEFINES   - space-separated defines, for example "TB_TAP=7 TB_BP=1"
#
# Edit only these knobs when the normal module layout is not enough.
set RTL_DIR        {../rtl}
set TB_PATTERN     {tb_*.sv tb_*.v tb_*.vhd tb_*.vhdl}
set INI_OVERRIDE   {}
set EXTRA_INCDIRS  {}

onbreak { resume }
onerror { quit -f -code 1 }

set VERIF_ROOT [file normalize [pwd]]
set RTL_ROOT   [file normalize [file join $VERIF_ROOT $RTL_DIR]]
set ::SKIPPED_STUBS {}
set ::IP_PREFIX "[string map {\\ /} [file normalize [file join $RTL_ROOT "ip"]]]/"

proc collect_hdl {dir} {
  set result {}
  if {![file isdirectory $dir]} { return $result }
  foreach ext {.sv .v .vhd .vhdl} {
    foreach f [lsort [glob -nocomplain -directory $dir -type f *$ext]] {
      if {[string match "*_stub.*" [file tail $f]]
          && [string first $::IP_PREFIX [string map {\\ /} $f]] == 0} {
        lappend ::SKIPPED_STUBS $f
        continue
      }
      lappend result $f
    }
  }
  foreach sub [lsort [glob -nocomplain -directory $dir -type d *]] {
    # 第八轮复审 E8-04:`glob -type d` 会把**链接目录**(symlink / Junction)也算进来 —— 顺着它们
    # 会把工程外的 HDL 收进编译清单(源码来源不受控、证据不可复核),循环链接还会让递归打转。
    # 判据:链接目录**跳过并点名**;跳过链接也就天然断了环,所以不需要额外的 visited 集合。
    if {[file type $sub] eq "link"} {
      puts "\[ME\] SKIP linked dir (not followed): $sub"
      continue
    }
    foreach f [collect_hdl $sub] { lappend result $f }
  }
  return $result
}

proc same_file_content {a b} {
  if {[file size $a] != [file size $b]} { return 0 }
  set fa [open $a r]
  fconfigure $fa -translation binary
  set da [read $fa]
  close $fa
  set fb [open $b r]
  fconfigure $fb -translation binary
  set db [read $fb]
  close $fb
  return [expr {$da eq $db}]
}

set rtl_src   [collect_hdl $RTL_ROOT]
set verif_src [collect_hdl $VERIF_ROOT]
# 只认 HDL 测试平台(F5-03):tb_notes.txt / 备份 / 笔记不算 TB
set tb_files {}
foreach pat $TB_PATTERN {
  foreach f [lsort [glob -nocomplain -directory $VERIF_ROOT -type f $pat]] {
    lappend tb_files $f
  }
}
set tb_files [lsort -unique $tb_files]

if {[llength $rtl_src] == 0} {
  puts "\n\[ME\] ERROR: no HDL source found under rtl/"
  quit -f -code 1
}
if {[llength $tb_files] == 0} {
  puts "\n\[ME\] ERROR: no $TB_PATTERN testbench in $VERIF_ROOT"
  quit -f -code 1
}

set stub_n [llength $::SKIPPED_STUBS]
if {$stub_n > 0} {
  puts "\n\[ME\] skipped $stub_n stub file(s) under rtl/ip/ (lint use, not simulated):"
  foreach f $::SKIPPED_STUBS { puts "\[ME\]   $f" }
}

# A duplicate basename is safe to drop only when both files are byte-identical.
set seen {}
set kept {}
foreach f [concat [lsort $rtl_src] [lsort $verif_src]] {
  set base [file tail $f]
  set at [lsearch -exact $seen $base]
  if {$at < 0} {
    lappend seen $base
    lappend kept $f
    continue
  }
  set first [lindex $kept $at]
  if {[same_file_content $first $f]} {
    puts "\[ME\] duplicate basename skipped (identical content): $f"
    continue
  }
  puts "\n\[ME\] ERROR: duplicate basename with DIFFERENT content: $base"
  puts "\[ME\]   $first"
  puts "\[ME\]   $f"
  puts "\[ME\] rename one file or remove the stale copy; refusing to hide either source."
  quit -f -code 1
}

set vhdl_src {}
set vlog_src {}
foreach f $kept {
  if {[string match "*.vhd" $f] || [string match "*.vhdl" $f]} {
    lappend vhdl_src $f
  } else {
    lappend vlog_src $f
  }
}

# Mapping priority: explicit knob -> selected environment mapping -> simulator install.
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

set define_args {}
if {[info exists ::env(TB_DEFINES)]} {
  foreach d [split $::env(TB_DEFINES) " "] {
    if {$d ne ""} { lappend define_args "+define+$d" }
  }
}
set inc_args {}
foreach d [string map {\\ /} $EXTRA_INCDIRS] {
  if {$d ne ""} { lappend inc_args "+incdir+$d" }
}

if {![file isdirectory work]} { vlib work }
puts "\n\[ME\] Compiling [llength $kept] file(s) into local work/"
foreach f $kept { puts "\[ME\]   $f" }

if {[llength $vhdl_src] > 0} {
  if {[catch { vcom -quiet -2008 -modelsimini $INI_FWD -work work {*}$vhdl_src } message]} {
    puts "\n\[ME\] ERROR: VHDL compilation failed - refusing to use a stale library"
    puts "\[ME\] $message"
    quit -f -code 1
  }
}
if {[llength $vlog_src] > 0} {
  if {[catch {
    vlog -quiet -modelsimini $INI_FWD -sv {*}$define_args {*}$inc_args -work work {*}$vlog_src
  } message]} {
    puts "\n\[ME\] ERROR: Verilog compilation failed - refusing to use a stale library"
    puts "\[ME\] $message"
    quit -f -code 1
  }
}

puts "\n\[ME\] COMPILE PASSED: local work/ is ready"
quit -f -code 0
