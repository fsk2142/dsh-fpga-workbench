# ============================================================================ #
# run_impl.tcl - Project Mode implementation, stops at route_design (impl 环节) #
# ============================================================================ #
# Usage (from the PROJECT root; doc/ prj/ src/ live right here):
#   vivado.bat -mode batch -notrace -source run_impl.tcl -log doc/run_impl.log -journal doc/run_impl.jou
#
# 为什么是 Project Mode(2026-09-24 改;审查报告 T-04/T-05/T-06):旧版走
# `open_checkpoint $SYNTH_DCP` + opt/place/phys_opt/route 的**非工程流**,代价是:
#   1) 它跑完**不会**让工程里的 `impl_1` 变成 Complete! —— 而 bitstream 环节(以及 fpga-project-impl
#      技能)要从 `impl_1` 继续(`launch_runs impl_1 -to_step write_bitstream`),两条路接不上,
#      只能把实现重跑一遍;
#   2) 丢掉 Project Mode 的 run state / NEEDS_REFRESH / 增量 checkpoint / run 报告;
#   3) 它自己还 write_bitstream —— 与 bitstream 环节职责重复,而 **DRC 从来没有真跑过**
#      (两边都只打一句 DRC_AND_ARCHIVE_PENDING)。
# 现在:本文件只把工程跑到 **route_design**,出 post-route 报告,并**跑 DRC 门**;
# bitstream 是 bitstream 环节的事(`bitstream/vivado_bitstream.tcl`)。
# 器件以 doc/spec.md 为权威的核对在综合环节(见 `synthesis/vivado_project_synthesis.tcl`);
# 本文件只要求 **synth_1 已经 Complete!**(实现在它之上,没完成就不该往下走)。
#
# Knobs (edit here; not environment variables):
#   PRJ_DIR           Vivado 工程目录(相对工程根),里面有恰好一个 .xpr
#   PROJECT_FILE      直接指定 .xpr;留空 = 在 PRJ_DIR 里找(0 个或多个都失败)
#   RUN               工程实现 run 名(默认 impl_1)
#   TOP               顶层名;留空 = 用工程里已设的 top;非空则要求二者一致
#   REPORT_DIR        报告目录(相对工程根)—— 工程报告平铺进 `doc/`
#   JOBS              launch_runs -jobs(并行 run/job;**不是**单个 run 的算法线程数,
#                     算法线程由 general.maxThreads 决定)
#   AUTO_INCREMENTAL  1 = 打开 AUTO_INCREMENTAL_CHECKPOINT:小改 RTL 时复用上一轮 place/route,
#                     Vivado 自己判断值不值得复用(改动太大就退回常规流程)。
#                     **正式出图/复验请设 0**,拿一次干净布线的结果。
#   ROUTED_DCP        非空 = 额外把 routed checkpoint 写到这个相对路径。默认留空:
#                     Project Mode 本来就在 `prj/<工程>.runs/<RUN>/` 里留了那一份,不重复写。
#   RESET_POLICY      auto   = 已经 Complete! 且 NEEDS_REFRESH=false 就复用,不重跑(省几十分钟);
#                     always = 先 reset_run 再跑,永远拿新结果。
#
# 产物(run 目录由 Vivado 自己维护,`<TOP>_routed.dcp` 就是 bitstream 环节要认的那份实物):
#   prj/<工程>.runs/<RUN>/<TOP>_routed.dcp      布局布线结果(bitstream 环节据此判断"实现做过了")
#   doc/impl_route_status.rpt / impl_utilization.rpt / impl_timing.rpt / impl_drc.rpt
#
# DRC 的严重度语义(真机 2025.2 实测,别当成 bug):引脚/电平没约束的 NSTD-1 / UCIO-1 在这里是
# **Critical Warning**(本文件只对 error 级判死,但会逐档列出来并点名它们);到 write_bitstream
# 时 Vivado 会把它们升级成 ERROR 并拒绝出图 —— 所以"impl 绿、bitstream 红"时先看这两条。
#
# Console text stays in English: older Vivado builds write the local code page to the log.
# ============================================================================ #

set PROJECT_ROOT [file normalize [pwd]]

set PRJ_DIR          "prj"
set PROJECT_FILE     ""
set RUN              "impl_1"
set TOP              ""
set REPORT_DIR       "doc"
set JOBS             4
set AUTO_INCREMENTAL 1
set ROUTED_DCP       ""
set RESET_POLICY     "auto"

# ---- 两个失败出口:英文说清楚 + 非零退出码 ---------------------------------- #
proc fail {msg} {
  puts "\n\[run_impl\] ERROR: $msg"
  exit 1
}

proc step {what body} {
  if {[catch {uplevel 1 $body} err]} {
    puts "\n\[run_impl\] ERROR: step '$what' failed:"
    puts "  $err"
    exit 1
  }
}

# ---- 派生路径 + 预检 0:工程目录与报告目录 ----------------------------------- #
set PRJ_ROOT [file normalize [file join $PROJECT_ROOT $PRJ_DIR]]
if {[file type $PRJ_ROOT] eq "link"} {
  fail "prj dir is a symlink/Junction; refusing to follow it: $PRJ_ROOT"
}
if {![file isdirectory $PRJ_ROOT]} {
  fail "prj dir not found: $PRJ_ROOT
         run this script from the PROJECT root (cwd = $PROJECT_ROOT)"
}
set RPT [file normalize [file join $PROJECT_ROOT $REPORT_DIR]]
if {![file isdirectory $RPT]} { file mkdir $RPT }

# ---- 预检 1:定位 .xpr(不猜;与工程综合同一口径) ---------------------------- #
if {$PROJECT_FILE eq ""} {
  set candidates [lsort [concat \
    [glob -nocomplain -directory $PRJ_ROOT -type f *.xpr] \
    [glob -nocomplain -directory $PRJ_ROOT -type f */*.xpr]]]
  if {[llength $candidates] == 0} {
    fail "no .xpr under $PRJ_ROOT -- create/open the Vivado project first, or set PROJECT_FILE"
  }
  if {[llength $candidates] > 1} {
    puts "\n\[run_impl\] ERROR: found [llength $candidates] .xpr under $PRJ_ROOT; refusing to pick one:"
    foreach f $candidates { puts "\[run_impl\]   $f" }
    fail "set PROJECT_FILE to the one you mean"
  }
  set PROJECT_FILE [lindex $candidates 0]
} elseif {![file isfile $PROJECT_FILE]} {
  fail "PROJECT_FILE not found: $PROJECT_FILE"
}
puts "\[run_impl\] project: [string map {\\ /} $PROJECT_FILE]"
puts "\[run_impl\] reports: [string map {\\ /} $RPT]"

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

# ---- 预检 3:综合必须先完成(实现在它之上) ---------------------------------- #
set SYNTH_RUN "synth_1"
if {[llength [get_runs -quiet $SYNTH_RUN]] == 0} {
  puts "\n\[run_impl\] ERROR: synthesis run '$SYNTH_RUN' not found. Existing runs:"
  foreach r [get_runs -quiet] { puts "\[run_impl\]   $r" }
  fail "run the synthesis stage first (see fpga-project-synth)"
}
set s_status [get_property STATUS   [get_runs $SYNTH_RUN]]
set s_prog   [get_property PROGRESS [get_runs $SYNTH_RUN]]
if {$s_prog ne "100%" || ![string match "*Complete!*" $s_status]} {
  fail "synthesis run '$SYNTH_RUN' is not complete (status='$s_status' progress='$s_prog') -- run the synthesis stage first"
}
puts "\[run_impl\] synth: $SYNTH_RUN complete   top: $TOP"

# ---- 预检 4:实现 run 必须存在 ---------------------------------------------- #
if {[llength [get_runs -quiet $RUN]] == 0} {
  puts "\n\[run_impl\] ERROR: implementation run '$RUN' not found. Existing runs:"
  foreach r [get_runs -quiet] { puts "\[run_impl\]   $r" }
  fail "set RUN to one of the runs above (or create the run in the project)"
}

# ---- 增量实现旋钮:显式设 0/1,别让 .xpr 里上一轮的值留着说话 ---------------- #
if {$AUTO_INCREMENTAL} {
  step "set AUTO_INCREMENTAL_CHECKPOINT 1" {
    set_property AUTO_INCREMENTAL_CHECKPOINT 1 [get_runs $RUN]
  }
  puts "\[run_impl\] incremental implementation ENABLED (AUTO_INCREMENTAL=1; set 0 for a clean/final run)"
} else {
  step "set AUTO_INCREMENTAL_CHECKPOINT 0" {
    set_property AUTO_INCREMENTAL_CHECKPOINT 0 [get_runs $RUN]
  }
  puts "\[run_impl\] incremental implementation DISABLED (AUTO_INCREMENTAL=0 -> full place & route)"
}

# ---- 跑实现:auto 下先看 run state,能复用就不重跑 -------------------------- #
set REUSED 0
if {$RESET_POLICY eq "auto"} {
  set status [get_property STATUS   [get_runs $RUN]]
  set prog   [get_property PROGRESS [get_runs $RUN]]
  # 读不到 NEEDS_REFRESH 就**算脏**(fail-closed:证明不了新鲜就重跑,别拿旧结果交差)。
  set refresh 1
  catch { set refresh [get_property NEEDS_REFRESH [get_runs $RUN]] }
  set fresh 0
  if {[catch { set fresh [expr {!$refresh}] }]} { set fresh 0 }
  if {$fresh && $prog eq "100%" && [string match "*Complete!*" $status]} {
    set REUSED 1
    puts "\[run_impl\] RESET_POLICY=auto: '$RUN' is Complete! and NEEDS_REFRESH=false -> reusing it (use RESET_POLICY always to rebuild)"
  } else {
    puts "\[run_impl\] RESET_POLICY=auto: '$RUN' is stale (status='$status' progress='$prog' needs_refresh='$refresh') -> reset + relaunch"
  }
} elseif {$RESET_POLICY ne "always"} {
  fail "RESET_POLICY must be auto or always (got '$RESET_POLICY')"
}

if {!$REUSED} {
  step "launch_runs $RUN -to_step route_design" {
    if {$RESET_POLICY eq "always" || [get_property STATUS [get_runs $RUN]] ne "Not started"} {
      reset_run $RUN
    }
    launch_runs $RUN -to_step route_design -jobs $JOBS
    wait_on_run $RUN
  }
}

set status   [get_property STATUS   [get_runs $RUN]]
set progress [get_property PROGRESS [get_runs $RUN]]
if {$progress ne "100%" || ![string match "*Complete!*" $status]} {
  fail "implementation run did not complete: run='$RUN' status='$status' progress='$progress'"
}

# ---- post-route 报告(工程约定:平铺进 doc/) -------------------------------- #
step "open_run $RUN"          { open_run $RUN }
step "report_route_status"    { report_route_status   -file [file join $RPT "impl_route_status.rpt"] }
step "report_utilization"     { report_utilization    -file [file join $RPT "impl_utilization.rpt"] }
step "report_timing_summary"  { report_timing_summary -file [file join $RPT "impl_timing.rpt"] }
step "report_drc"             { report_drc            -file [file join $RPT "impl_drc.rpt"] }

# ---- DRC 门:这份 routed 设计能不能用 --------------------------------------- #
# 判据:DRC 违规里只要有一条 Error 级 → FAIL。**读不出严重度也判死**(不当干净):
# 与主日志 NOT_INSPECTED 同一条口径 —— 宁可让人去翻报告,也不能把"没查清"说成"没问题"。
set drc_violations {}
if {[catch { set drc_violations [get_drc_violations -quiet] } drc_err]} {
  fail "cannot enumerate DRC violations ($drc_err) -- open [file join $RPT impl_drc.rpt] and confirm manually"
}
set drc_errors {}
set drc_unreadable {}
set drc_waived {}
set drc_by_sev [dict create]
foreach v $drc_violations {
  set sev ""
  if {[catch { set sev [get_property SEVERITY $v] }]} {
    lappend drc_unreadable $v
    continue
  }
  # 真机实测(2025.2):violation 对象的属性是 CHECK / SEVERITY / IS_WAIVED / NAME ... ——
  # 规则名在 **CHECK** 上(`get_property RULE` 取到空串,写成 RULE 会静默丢掉规则名)。
  set rule ""
  catch { set rule [get_property CHECK $v] }
  # 工程里显式豁免(waiver)过的不判死 —— 那是用户写下来的决定;但条数要如实报出来。
  set waived 0
  catch { set waived [get_property IS_WAIVED $v] }
  if {$waived} {
    lappend drc_waived $rule
    continue
  }
  dict lappend drc_by_sev $sev $rule
  if {[string match -nocase "*error*" $sev]} { lappend drc_errors "$rule (severity=$sev)" }
}
if {[llength $drc_unreadable] > 0} {
  puts "\n\[run_impl\] ERROR: cannot read the severity of [llength $drc_unreadable] DRC violation(s):"
  foreach v [lrange $drc_unreadable 0 9] { puts "\[run_impl\]   $v" }
  fail "DRC severity not readable -- see [file join $RPT impl_drc.rpt]; refusing to call this routed design clean"
}
# 严重度分布逐档列出来(把事实摆出来,判定仍由人/AI 做):真机实测 2025.2 里,引脚/电平没约束的
# NSTD-1 / UCIO-1 在 report_drc 里只是 **Critical Warning**,但 write_bitstream 会把它们**升级成
# ERROR** 并拒绝出图 —— 不点名它们,这份 impl 门就会"绿着"而 bitstream 环节必然失败。
foreach sev [lsort [dict keys $drc_by_sev]] {
  set rules [lsort -unique [dict get $drc_by_sev $sev]]
  puts "\[run_impl\]   DRC $sev: [llength $rules] rule(s) - [join [lrange $rules 0 5] {, }]"
}
if {[llength $drc_waived] > 0} {
  puts "\[run_impl\]   DRC waived in the project (not judged here): [join [lsort -unique $drc_waived] {, }]"
}
if {[dict exists $drc_by_sev "Critical Warning"]} {
  set cw [lsort -unique [dict get $drc_by_sev "Critical Warning"]]
  if {[lsearch -exact $cw "NSTD-1"] >= 0 || [lsearch -exact $cw "UCIO-1"] >= 0} {
    puts "\[run_impl\] NOTE: NSTD-1/UCIO-1 present (pins / IOSTANDARD not fully constrained). write_bitstream"
    puts "\[run_impl\]       escalates these to ERROR and refuses to generate -- fix them in the constraints stage."
  }
}
if {[llength $drc_errors] > 0} {
  puts "\n\[run_impl\] ERROR: [llength $drc_errors] DRC error-severity violation(s):"
  foreach v [lrange $drc_errors 0 9] { puts "\[run_impl\]   $v" }
  fail "DRC errors must be resolved before this routed design is usable (report: [file join $RPT impl_drc.rpt])"
}
puts "\[run_impl\] DRC: [llength $drc_violations] violation(s) reported, none of error severity"

# ---- 可选:额外归档 routed checkpoint(默认不写,工程自己那份就够了) -------- #
if {$ROUTED_DCP ne ""} {
  set dcp [file normalize [file join $PROJECT_ROOT $ROUTED_DCP]]
  step "write_checkpoint" { write_checkpoint -force $dcp }
  puts "\[run_impl\] routed checkpoint: [string map {\\ /} $dcp]"
} else {
  puts "\[run_impl\] routed checkpoint stays in the project run dir (prj/<project>.runs/$RUN/)"
}

puts "\n\[run_impl\] IMPLEMENTATION_ROUTED: run=$RUN top=$TOP (reports in [string map {\\ /} $RPT])"
puts "\[run_impl\] this is NOT the project PASS by itself -- timing judgement (fpga-project-timing) and bitstream (fpga-project-impl) come next"
exit 0
