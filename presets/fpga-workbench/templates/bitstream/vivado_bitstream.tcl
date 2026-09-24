# ============================================================================ #
# run_bitstream.tcl - Project Mode bitstream from a finished impl_1 (bit 环节)  #
# ============================================================================ #
# Usage (from the PROJECT root; doc/ prj/ bit/ live right here):
#   vivado.bat -mode batch -notrace -source run_bitstream.tcl -log bit/run_bitstream.log -journal bit/run_bitstream.jou
#
# 只做一件事:**从已经完成(且没过期)的 `impl_1` 继续到 `write_bitstream`**,再把 .bit/.ltx
# 归档到 `bit/`。为什么这么改(2026-09-24;审查报告 T-04/T-06):
#   * 旧的实现模板(非工程流)自己也 write_bitstream —— 两个环节职责重复,而且它不会让 impl_1
#     变成 Complete!,于是本文件"要求 impl_1 100% 完成"永远不成立,两条路接不上;
#   * 加速的关键**不是**优化 write_bitstream,而是**别为了出 bit 再做一次实现**:
#     Project Mode 的 step continuation(`launch_runs <run> -to_step write_bitstream`)干的就是这件事;
#   * DRC 已经在实现环节真跑过(见 implementation/vivado_implementation.tcl),这里不重复。
#
# Knobs (edit here; not environment variables):
#   PRJ_DIR / PROJECT_FILE / RUN / TOP / BIT_DIR / JOBS
#
# 前置与判据(**认实物,不认状态串**):run 目录里有 `<TOP>_routed.dcp` = 布局布线真的做过
# (真机 2025.2 实测:`-to_step route_design` 跑完 STATUS 是 `route_design Complete!`;出 bit 失败后
# STATUS 变成 `write_bitstream ERROR`、PROGRESS 退到 83.33% —— 都是同一份 routed 设计,所以这里不抠
# 状态串,出 bit 失败可以**直接重跑本文件**续跑,不必把实现整个重跑)。`NEEDS_REFRESH=1` 时拒绝继续
# (源码在实现之后又改过)。`bit/` 由工程骨架建好;手工建工程时先 `file mkdir bit`(否则 -log 写不进去)。
#
# Console text stays in English: older Vivado builds write the local code page to the log.
# ============================================================================ #

set PROJECT_ROOT [file normalize [pwd]]

set PRJ_DIR      "prj"
set PROJECT_FILE ""
set RUN          "impl_1"
set TOP          ""
set BIT_DIR      "bit"
set JOBS         4

proc fail {msg} {
  puts "\n\[run_bitstream\] ERROR: $msg"
  exit 1
}

proc step {what body} {
  if {[catch {uplevel 1 $body} err]} {
    puts "\n\[run_bitstream\] ERROR: step '$what' failed:"
    puts "  $err"
    exit 1
  }
}

# ---- 派生路径 + 预检 0:工程目录与归档目录 ----------------------------------- #
set PRJ_ROOT [file normalize [file join $PROJECT_ROOT $PRJ_DIR]]
if {[file type $PRJ_ROOT] eq "link"} {
  fail "prj dir is a symlink/Junction; refusing to follow it: $PRJ_ROOT"
}
if {![file isdirectory $PRJ_ROOT]} {
  fail "prj dir not found: $PRJ_ROOT
         run this script from the PROJECT root (cwd = $PROJECT_ROOT)"
}
set BIT_ROOT [file normalize [file join $PROJECT_ROOT $BIT_DIR]]
if {![file isdirectory $BIT_ROOT]} { file mkdir $BIT_ROOT }

# ---- 预检 1:定位 .xpr(不猜;与工程综合/实现同一口径) ----------------------- #
if {$PROJECT_FILE eq ""} {
  set candidates [lsort [concat \
    [glob -nocomplain -directory $PRJ_ROOT -type f *.xpr] \
    [glob -nocomplain -directory $PRJ_ROOT -type f */*.xpr]]]
  if {[llength $candidates] == 0} {
    fail "no .xpr under $PRJ_ROOT -- create/open the Vivado project first, or set PROJECT_FILE"
  }
  if {[llength $candidates] > 1} {
    puts "\n\[run_bitstream\] ERROR: found [llength $candidates] .xpr under $PRJ_ROOT; refusing to pick one:"
    foreach f $candidates { puts "\[run_bitstream\]   $f" }
    fail "set PROJECT_FILE to the one you mean"
  }
  set PROJECT_FILE [lindex $candidates 0]
} elseif {![file isfile $PROJECT_FILE]} {
  fail "PROJECT_FILE not found: $PROJECT_FILE"
}
puts "\[run_bitstream\] project: [string map {\\ /} $PROJECT_FILE]"
puts "\[run_bitstream\] archive dir: [string map {\\ /} $BIT_ROOT]"

# ---- 预检 2:打开工程 + 顶层名 ---------------------------------------------- #
step "open_project" {
  open_project $PROJECT_FILE
  if {[llength [get_projects -quiet]] == 0} { error "open_project produced no project" }
}
set PRJ_TOP [get_property TOP [get_filesets sources_1]]
if {$TOP eq ""} {
  set TOP $PRJ_TOP
} elseif {$PRJ_TOP ne "" && $TOP ne $PRJ_TOP} {
  fail "top mismatch: knob TOP='$TOP' but the project top is '$PRJ_TOP'"
}
if {$TOP eq ""} { fail "empty top: set it in the project (sources_1) or pass TOP" }

# ---- 预检 3:布局布线**真的做过**(认实物,不认状态串) ---------------------- #
# 2026-09-24 真机实测(2025.2):`-to_step route_design` 跑完,run 的 STATUS 是
# `route_design Complete!`;一旦出 bit 失败,STATUS 变成 `write_bitstream ERROR`、PROGRESS 退到
# 83.33% —— **同一份 routed 设计**,只是状态串不同。所以判据是"run 目录里有没有 routed
# checkpoint",而不是抠状态串;这样"出 bit 失败后重试"不必再把实现整个重跑一遍。
if {[llength [get_runs -quiet $RUN]] == 0} {
  puts "\n\[run_bitstream\] ERROR: implementation run '$RUN' not found. Existing runs:"
  foreach r [get_runs -quiet] { puts "\[run_bitstream\]   $r" }
  fail "run the implementation stage first (see fpga-project-impl)"
}
set status  [get_property STATUS [get_runs $RUN]]
set RUN_DIR [get_property DIRECTORY [get_runs $RUN]]
if {$RUN_DIR eq "" || ![file isdirectory $RUN_DIR]} {
  fail "run dir not found (DIRECTORY='$RUN_DIR') -- cannot locate anything for run '$RUN'"
}
set routed_dcp [file join $RUN_DIR "${TOP}_routed.dcp"]
set bit_done 0
if {[string match "*write_bitstream Complete!*" $status]} { set bit_done 1 }

if {!$bit_done} {
  if {![file isfile $routed_dcp]} {
    fail "no routed checkpoint in the run dir ($routed_dcp; run status='$status') -- run the implementation stage first"
  }
  # NEEDS_REFRESH=true 意味着源码/约束在实现之后又变了 —— 那种情况继续出 bit 就等于拿旧布局布线
  # 交差,或者让 Vivado 偷偷重跑一遍实现(几十分钟的意外)。两条都不接受:退回实现环节。
  set refresh 1
  catch { set refresh [get_property NEEDS_REFRESH [get_runs $RUN]] }
  set fresh 0
  if {[catch { set fresh [expr {!$refresh}] }]} { set fresh 0 }
  if {!$fresh} {
    fail "run '$RUN' NEEDS_REFRESH=$refresh: the sources/constraints changed after implementation. Re-run the implementation stage, then come back (refusing to place/route again just to get a bitstream)."
  }
  puts "\[run_bitstream\] routed: [string map {\\ /} $routed_dcp] (run status='$status') -> running the remaining write_bitstream step"

  # ---- 只跑**剩下的那一步**:write_bitstream(不重新 place/route) ----------- #
  step "launch_runs $RUN -to_step write_bitstream" {
    launch_runs $RUN -to_step write_bitstream -jobs $JOBS
    wait_on_run $RUN
  }
  set status [get_property STATUS [get_runs $RUN]]
  if {![string match "*write_bitstream Complete!*" $status]} {
    fail "write_bitstream did not complete: run='$RUN' status='$status' -- see the run log ($RUN_DIR/runme.log); DRC pre-checks (NSTD-1/UCIO-1: pins / IOSTANDARD) are the usual cause"
  }
} else {
  puts "\[run_bitstream\] run '$RUN' already has write_bitstream Complete! -- only archiving the existing output"
}

# ---- 从 run 目录取 Vivado 自己写出来的 .bit(不另起一次 write_bitstream) ---- #
set bit_src [file join $RUN_DIR "${TOP}.bit"]
if {![file isfile $bit_src]} {
  set found [lsort [glob -nocomplain -directory $RUN_DIR -type f *.bit]]
  if {[llength $found] == 1} {
    set bit_src [lindex $found 0]
  } else {
    puts "\n\[run_bitstream\] ERROR: expected [string map {\\ /} [file join $RUN_DIR "${TOP}.bit"]]; found [llength $found] .bit file(s):"
    foreach f $found { puts "\[run_bitstream\]   $f" }
    fail "cannot decide which bitstream is this project's (set TOP to the real top module name)"
  }
}
puts "\[run_bitstream\] generated: [string map {\\ /} $bit_src]"

# ---- 归档到 bit/(约定的唯一覆盖点:覆盖、不改名) --------------------------- #
set bit_keep [file join $BIT_ROOT "${TOP}.bit"]
step "archive bitstream to bit/" { file copy -force $bit_src $bit_keep }
if {![file isfile $bit_keep] || [file size $bit_keep] == 0} {
  fail "archived bitstream missing or empty: $bit_keep"
}
set ltx_src [file join $RUN_DIR "${TOP}.ltx"]
if {[file isfile $ltx_src]} {
  step "archive debug probes to bit/" { file copy -force $ltx_src [file join $BIT_ROOT "${TOP}.ltx"] }
  puts "\[run_bitstream\] debug probes: [string map {\\ /} [file join $BIT_ROOT "${TOP}.ltx"]]"
} else {
  puts "\[run_bitstream\] no .ltx (no ILA/VIO debug probes in this build)"
}

puts "\n\[run_bitstream\] BITSTREAM_OUTPUT_GENERATED: [string map {\\ /} $bit_keep]"
puts "\[run_bitstream\] BITSTREAM_ARCHIVED: bit/${TOP}.bit (+ .ltx when debug probes exist)"
puts "\[run_bitstream\] this is NOT the project PASS by itself -- record the source run in doc/impl.md (see fpga-project-impl)"
exit 0
