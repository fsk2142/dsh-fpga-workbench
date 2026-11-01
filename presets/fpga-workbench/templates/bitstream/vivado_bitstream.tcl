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

# ---- **R01：刷新状态必须在两个分支之前核** -------------------------------- #
#
# 原来 NEEDS_REFRESH 的检查整段写在 `if {!$bit_done}` 里面 —— 于是：
#
#   STATUS = "write_bitstream Complete!"  且  NEEDS_REFRESH = 1
#
# 时走的是"已完成"分支，**既不查 routed checkpoint，也不查刷新状态**，
# 直接把 run 目录里那份**旧 bit** 当成本次产物归档。
#
# 「已经生成过 bit」和「这份 bit 仍然有效」是两件事。源码/约束在实现之后
# 改过（NEEDS_REFRESH=1），那份 bit 就不代表当前设计。
#
# 读不到属性时**当"新鲜性未知"处理**：报 WARN 并继续（不默认放行也不误杀），
# 结论由下游按「未验证」对待 —— 见最后一段输出里的 REFRESH_UNKNOWN 标记。
set refresh       1
set refresh_known 0
if {[catch {
  set refresh [get_property NEEDS_REFRESH [get_runs $RUN]]
  set refresh_known 1
} err]} {
  puts "\[run_bitstream\] WARN: 读不到 NEEDS_REFRESH ($err) —— 新鲜性未知"
}

#
# **N06：读不到刷新属性时不能当作"新鲜"继续归档。**
#
# 上一版这里只打 WARN 就往下走 —— 于是属性缺失/不可读的情况下
# 照样复制旧 bit、照样输出 BITSTREAM_OUTPUT_GENERATED、照样退 0。
# 那等于把「不知道新不新鲜」当成了「新鲜」。
#
# 现在明确分三态：
#   fresh      好
#   stale      拒绝（上面 fail）
#   unknown    **不写有效归档**，退 3，并输出机器可读的 REFRESH_UNKNOWN
#
# 要人工覆盖时不该复用正常成功路径 —— 那种覆盖本身就不该被下游当成功。
if {!$refresh_known} {
  puts "\[run_bitstream\] REFRESH_UNKNOWN: 读不到 NEEDS_REFRESH —— 无法确认这份 bit 仍然有效"
  puts "\[run_bitstream\] 不写归档。要强制出 bit，请先修好 run 状态或显式处理这个 run。"
  # 收尾：不把"什么都没验成"当成功
  catch { close_project }
  exit 3
}

if {$refresh_known} {
  #
  # **语义**：NEEDS_REFRESH=1 表示「需要刷新」= 陈旧。
  # 这里直接用 refresh 本身当 is_stale，不要再取反 ——
  # 取反会把「过期」判成「新鲜」，正是这条 bug 的反向版本。
  #
  if {[catch { set is_stale [expr {$refresh ? 1 : 0}] }]} { set is_stale 1 }
  if {$is_stale} {
    fail "run '$RUN' NEEDS_REFRESH=$refresh: the sources/constraints changed after implementation. Re-run the implementation stage (see fpga-project-impl); do NOT archive the stale bitstream."
  }
  puts "\[run_bitstream\] refresh check: NEEDS_REFRESH=$refresh（新鲜，允许归档）"
}

if {!$bit_done} {
  if {![file isfile $routed_dcp]} {
    fail "no routed checkpoint in the run dir ($routed_dcp; run status='$status') -- run the implementation stage first"
  }
  # 刷新状态已经在上面统一核过了（R01）—— 这里不再重复读一次。
  # 重复读的后果是两处判断可能不一致：上面放行、下面拒绝（或相反）。
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
set ltx_keep [file join $BIT_ROOT "${TOP}.ltx"]
if {[file isfile $ltx_src]} {
  step "archive debug probes to bit/" { file copy -force $ltx_src $ltx_keep }
  puts "\[run_bitstream\] debug probes: [string map {\\ /} $ltx_keep]"
} else {
  puts "\[run_bitstream\] no .ltx (no ILA/VIO debug probes in this build)"
  #
  # **R14：本次没有 ltx 时，别让旧 ltx 冒充「当前探针」。**
  #
  # bit 是新的、ltx 是上一版留下的 —— 下游（Vivado 硬件管理器 auto-detect、
  # 或按约定读 bit/<TOP>.ltx 的脚本）会加载**与新 bit 不匹配的探针表**。
  # 现象是「探针连上了但信号全错 / 全 0」，极难查。
  #
  # 按项目「不永久删除」的约定：**改名保留成带时间戳的失效备份**，不删。
  # 旧文件还能恢复，而 bit/<TOP>.ltx 这个名字不再指向过期内容。
  #
  if {[file isfile $ltx_keep]} {
    set stale_name "${ltx_keep}.stale-[clock format [clock seconds] -format %Y%m%d-%H%M%S]"
    if {[catch {file rename $ltx_keep $stale_name} err]} {
      puts "\[run_bitstream\] WARN: 旧 .ltx 改名失败($err) —— 它可能被当成当前探针，请手工处理: $ltx_keep"
    } else {
      puts "\[run_bitstream\] 旧 .ltx 已标记失效: [string map {\\ /} $stale_name]"
      puts "\[run_bitstream\] 本次构建没有调试探针；旧探针表与新 bit 不匹配，不要使用"
    }
  }
}

puts "\n\[run_bitstream\] BITSTREAM_OUTPUT_GENERATED: [string map {\\ /} $bit_keep]"
puts "\[run_bitstream\] BITSTREAM_ARCHIVED: bit/${TOP}.bit (+ .ltx when debug probes exist)"
puts "\[run_bitstream\] this is NOT the project PASS by itself -- record the source run in doc/impl.md (see fpga-project-impl)"
exit 0
