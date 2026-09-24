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
#   LINT_RPT     - Vivado RTL Linter 报告落点(相对工程根;工程约定:报告平铺在 doc/) #
#                                                                              #
# English console text: older Vivado builds emit local-codepage logs.          #

set MODULE_ROOT [file normalize [pwd]]
set SRC_DIR     "src/rtl"
set TOP         "REPLACE_TOP"
set PART        "REPLACE_PART"
set LINT_RPT    "doc/vivado_rtl_lint.rpt"

if {$TOP eq "REPLACE_TOP" || $PART eq "REPLACE_PART"} {
  puts "\[ME\] ERROR: fill TOP and PART from doc/spec.md before running lint"
  exit 2
}

set SRC [file normalize [file join $MODULE_ROOT $SRC_DIR]]
# DSH-N01:根目录自己也不能是链接(同上)。
if {[file type $SRC] eq "link"} {
  puts "\n\[ME\] ERROR: HDL root is a symlink/Junction; refusing to follow it: $SRC"
  exit 2
}
if {![file isdirectory $SRC]} {
  puts "\[ME\] ERROR: HDL root not found: $SRC"
  exit 2
}

# Linter 报告落点:接受相对工程根的写法(工程约定 doc/),目录不存在就建。
set LINT_RPT [file normalize [file join $MODULE_ROOT $LINT_RPT]]
if {![file isdirectory [file dirname $LINT_RPT]]} { file mkdir [file dirname $LINT_RPT] }

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
  exit 2
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
    exit 1
  }
}
# IP: read .xci when present (project ip/<name>/*.xci)
foreach xci [lsort [glob -nocomplain -directory [file join $MODULE_ROOT ip] -types f */*.xci]] {
  puts "\[ME\] read_xci $xci"
  if {[catch {read_xci $xci} message]} {
    puts "\[ME\] ERROR: read_xci failed for $xci"
    puts $message
    exit 1
  }
}

# 第 1 步:**Vivado RTL Linter**(2026-09-24;复核报告第 3 项)。
# 为什么和下一步分开调用:-lint 与 -rtl 在 2025.2 **互斥**(实测
# `ERROR: [Common 17-69] Command failed: -lint and -rtl are mutually exclusive`),
# 照抄 `synth_design -rtl -lint ...` 会直接失败;分开先后跑实测可行。
# Linter 的 14 条规则(-help 里那份清单)管的是可综合性风险:ASSIGN-1~7(算术溢出 / 混合符号 /
# 移位溢出 / 未用标量 / 数组位未置未用 / 多驱动)、QOR-1、INFER-1~3(推断 latch / case 不完整 /
# case 相等)、CLOCK-1、RESET-1~2。与 `module-rtl-check.mjs` 分工:那边管命名/格式/自定义约定,
# 这边管可综合性风险;命名与格式规则不在这里重复。
if {[catch {synth_design -lint -top $TOP -part $PART -file $LINT_RPT} message]} {
  puts "\[ME\] ERROR: synth_design -lint failed"
  puts $message
  exit 1
}
# 消息计数**分两步各报一次**:`get_msg_config -count` 反映的是当前这一步的数,
# 跑到下一步再读就看不到上一步的 CRITICAL WARNING 了(实测:lint 报 1 条 CW,elaborate 后读回 0)。
puts "\[ME\] lint messages: ERROR=[get_msg_config -count -severity {ERROR}] CRITICAL WARNING=[get_msg_config -count -severity {CRITICAL WARNING}]"

# 报告必须真的落地:读不到就说"没查到",不许把"没跑成"说成"干净"(与主日志 NOT_INSPECTED 同一条口径)。
if {![file isfile $LINT_RPT]} {
  puts "\n\[ME\] ERROR: lint report not found: [string map {\\ /} $LINT_RPT]"
  puts "\[ME\] synth_design -lint did not write it -- cannot judge the lint result; refusing to report PASS"
  exit 1
}
set lfh [open $LINT_RPT r]
set ltext [read $lfh]
close $lfh
# 从报告的 Summary 表里抽规则(**不写死规则清单**:实测报告里出现过 -help 清单里没有的
# ASSIGN-10,硬编码一份清单就会漏报)。表行形如:
#   | INFER-1   | CRITICAL WARNING | 1            | 0        | Inferred latch for signal ... |
set lint_findings {}
foreach line [split $ltext "\n"] {
  if {[regexp {^\|\s*([A-Z]+-[0-9]+)\s*\|\s*([A-Z][A-Z ]*)\|\s*([0-9]+)\s*\|} $line -> rid sev num]} {
    lappend lint_findings "[string trim $rid] ([string trim $sev] x [string trim $num])"
  }
}

# 第 2 步:elaboration(语法 / 连接性)—— 这是原来那一步,保持不变。
# RTL elaborate only — this is the elaboration half, not full synth
if {[catch {synth_design -rtl -top $TOP -part $PART -name rtl_lint} message]} {
  puts "\[ME\] ERROR: synth_design -rtl failed"
  puts $message
  exit 1
}

set err_n  [get_msg_config -count -severity {ERROR}]
set crit_n [get_msg_config -count -severity {CRITICAL WARNING}]
puts "\[ME\] elaboration messages: ERROR=$err_n CRITICAL WARNING=$crit_n"
if {$err_n > 0} {
  puts "\[ME\] LINT FAILED: $err_n error(s)"
  exit 1
}

# Linter 的发现**不直接判死**:RESET-1/RESET-2(混用 / 缺异步复位)这类在纯同步复位的设计里
# 是正常的,判死只会变成噪声。但每一条都要在结论里逐条说明来源 —— 所以这里全部列出来
# (来源是 lint 报告,不是消息计数:严重度与条数都从报告里带出来)。
if {[llength $lint_findings] > 0} {
  puts "\[ME\] lint findings ([llength $lint_findings]): [join $lint_findings {, }] -- explain each in the conclusion"
} else {
  puts "\[ME\] lint: no violations reported by the RTL Linter rules"
}
puts "\[ME\] lint report: [string map {\\ /} $LINT_RPT]"
puts "\[ME\]   (waiver recipe is printed at the end of that report: create_waiver -type LINT ...)"
puts "\[ME\] LINT OUTPUT GENERATED (errors=0; review $crit_n critical warning(s), the lint findings above and the report before calling PASS)"
exit 0
