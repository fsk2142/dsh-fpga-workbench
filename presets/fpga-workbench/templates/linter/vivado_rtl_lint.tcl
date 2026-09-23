# Vivado RTL lint (project) — elaborate only, no full synthesis / no bitstream  #
#                                                                              #
# Usage (from project root):                                                   #
#   vivado.bat -mode batch -notrace -source lint.tcl -log lint.log             #
#                                                                              #
# Template knobs (edit the script; not env vars):                              #
#   MODULE_ROOT  - project root (default: pwd)                                 #
#   SRC_DIR      - HDL root relative to MODULE_ROOT (project layout: src/rtl)  #
#   TOP          - top module name (from doc/spec.md)                          #
#   PART         - full device string (from doc/spec.md)                       #
#                                                                              #
# English console text: older Vivado builds emit local-codepage logs.          #

set MODULE_ROOT [file normalize [pwd]]
set SRC_DIR     "src/rtl"
set TOP         "REPLACE_TOP"
set PART        "REPLACE_PART"

if {$TOP eq "REPLACE_TOP" || $PART eq "REPLACE_PART"} {
  puts "\[ME\] ERROR: fill TOP and PART from doc/spec.md before running lint"
  quit -f -code 2
}

set SRC [file normalize [file join $MODULE_ROOT $SRC_DIR]]
if {![file isdirectory $SRC]} {
  puts "\[ME\] ERROR: HDL root not found: $SRC"
  quit -f -code 2
}

proc collect_hdl {dir} {
  set result {}
  foreach ext {.sv .v .vhd .vhdl} {
    foreach f [lsort [glob -nocomplain -directory $dir -type f *$ext]] {
      lappend result $f
    }
  }
  foreach sub [lsort [glob -nocomplain -directory $dir -type d *]] {
    set name [file tail $sub]
    if {$name in {ip work .git}} { continue }
    if {[catch {file type $sub} t] || $t eq "link"} {
      puts "\[ME\] skip symlink/odd dir: $sub"
      continue
    }
    foreach f [collect_hdl $sub] { lappend result $f }
  }
  return $result
}

set hdl [collect_hdl $SRC]
if {[llength $hdl] == 0} {
  puts "\[ME\] ERROR: no .sv/.v under $SRC"
  quit -f -code 2
}
puts "\[ME\] lint inputs ([llength $hdl] files) from $SRC"

create_project -in_memory -part $PART
foreach f $hdl {
  # 第九轮复审④:**按扩展名分流读**,不要一律 `read_verilog -sv`:
  #   .sv        → `read_verilog -sv`(SystemVerilog 编译组);
  #   .v         → 普通 `read_verilog`(Verilog-2001;强加 -sv 会按 SV 编译组解释,
  #                Verilog 标识符撞上 SV 保留字时语义会变 —— AMD 文档明确区分);
  #   .vhd/.vhdl → `read_vhdl -vhdl2008`。
  set ext [string tolower [file extension $f]]
  if {[catch {
    if {$ext in {.vhd .vhdl}} {
      read_vhdl -vhdl2008 $f
    } elseif {$ext eq ".sv"} {
      read_verilog -sv $f
    } else {
      read_verilog $f
    }
  } message]} {
    puts "\[ME\] ERROR: read failed for $f"
    puts $message
    quit -f -code 1
  }
}
# IP: read .xci when present (project ip/<name>/*.xci)
foreach xci [lsort [glob -nocomplain -directory [file join $MODULE_ROOT ip] -types f */*.xci]] {
  puts "\[ME\] read_xci $xci"
  if {[catch {read_xci $xci} message]} {
    puts "\[ME\] ERROR: read_xci failed for $xci"
    puts $message
    quit -f -code 1
  }
}

# RTL elaborate only — this is the lint/elaboration step, not full synth
if {[catch {synth_design -rtl -top $TOP -part $PART -name rtl_lint} message]} {
  puts "\[ME\] ERROR: synth_design -rtl failed"
  puts $message
  quit -f -code 1
}

set err_n  [get_msg_config -count -severity {ERROR}]
set crit_n [get_msg_config -count -severity {CRITICAL WARNING}]
puts "\[ME\] messages: ERROR=$err_n CRITICAL WARNING=$crit_n"
if {$err_n > 0} {
  puts "\[ME\] LINT FAILED: $err_n error(s)"
  quit -f -code 1
}
puts "\[ME\] LINT OUTPUT GENERATED (errors=0; review $crit_n critical warning(s) before calling PASS)"
quit -f -code 0
