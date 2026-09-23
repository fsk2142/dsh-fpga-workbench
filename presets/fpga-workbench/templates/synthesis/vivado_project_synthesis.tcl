# ============================================================================ #
# prj_synth.tcl - 工程的批处理综合(工程 synth 环节)                          #
# ============================================================================ #
# 跑法(**必须在**工程根下跑,`doc/`、`prj/`、`src/` 就在当前目录):
#   & "<综合器路径>" -mode batch -source prj_synth.tcl \
#       -log doc/run_prj_synth.log -journal doc/run_prj_synth.jou
#
# **`-mode batch` 必须加**:不加会拉起图形界面、停在那儿等人点,无人值守跑不下去。
#
# 与模块版(分类模板库里的 `synthesis/vivado_module_synthesis.tcl`)**不是同一份**,别互抄:
#   * 模块版:在**模块根**跑,自己 `create_project` 到 `synth/vivado_proj/`,RTL 收 `rtl/`,
#     顶层名来自模块 spec。它写的是 `<ModuleName>`,工程里照抄会另建一套 `synth/` 目录树。
#   * 工程版(本文件):在**工程根**跑,打开**已经存在的** `prj/<工程>.xpr`,只跑它自己的
#     `synth_1`;报告按工程约定平铺进 `doc/`;Vivado 工程本体留在 `prj/`,本文件**不新建工程**。
#
# 为什么这么写(实测踩出来的,别删):
#   * **预检器件**:`doc/spec.md` 里的器件与工程 `part` 不一致时直接失败 —— 器件以
#     工程 spec 为准,工程实际用的却是另一个,这种不一致不能"看着跑完了"就放过。
#   * **proc 体内别在注释里写花括号**:注释同样参与括号配对,一个裸花括号就把 proc 拆散,
#     里面的语句跑到顶层执行,报的错还看不出根因(实测踩过)。
#   * **失败一律非零退出码**:报 ERROR、出 CRITICAL WARNING、跑没跑完,都不许算通过。
#   * **控制台/日志里的消息一律用英文**:Vivado 按本地代码页落盘,中文会变乱码,而下面的
#     判定要读这些行。注释写中文没关系(注释也会被回显进日志,乱码但不影响执行)。
#
# 路径全部从当前目录推出来,**不写死任何绝对路径**。
# ============================================================================ #

set PROJECT_ROOT [file normalize [pwd]]

# ---- 旋钮:默认就是常规工程布局,不改也能跑 ---------------------------------- #
# 1) PRJ_DIR       Vivado 工程目录(相对工程根):里面应当有恰好一个 .xpr。
# 2) PROJECT_FILE  指定 .xpr(留空 = 自动在 PRJ_DIR 里找;找到 0 个或多个都失败)。
# 3) RUN           要跑的 run 名:工程综合默认 `synth_1`。
# 4) TOP           顶层名:留空 = 用工程里已设的 top;非空则要求二者一致。
# 5) STUB_DIR      RTL 黑盒 stub 所在目录(相对工程根):留空 = 不写 stub。
# 6) REPORT_DIR    报告目录(相对工程根):**工程报告平铺进 `doc/`**(与工程约定一致)。
# 7) JOBS          并行任务数。8) RESET_RUN  跑之前先 reset_run(保证不是拿旧结果交差)。
set PRJ_DIR      "prj"
set PROJECT_FILE ""
set RUN          "synth_1"
set TOP          ""
set STUB_DIR     ""
set REPORT_DIR   "doc"
set JOBS         4
set RESET_RUN    1

# ---- 派生路径(不用改) ------------------------------------------------------ #
set PRJ_ROOT [file normalize [file join $PROJECT_ROOT $PRJ_DIR]]
set RPT      [file normalize [file join $PROJECT_ROOT $REPORT_DIR]]

# ---- 两个失败出口:英文说清楚 + 非零退出码 ---------------------------------- #
proc fail {msg} {
  puts "\n\[run_prj_synth\] ERROR: $msg"
  exit 1
}

proc step {what body} {
  if {[catch {uplevel 1 $body} err]} {
    puts "\n\[run_prj_synth\] ERROR: step '$what' failed:"
    puts "  $err"
    exit 1
  }
}

# ---- 预检 0:工程与报告目录 ------------------------------------------------ #
if {![file isdirectory $PRJ_ROOT]} {
  fail "prj dir not found: $PRJ_ROOT
         run this script from the PROJECT root (cwd = $PROJECT_ROOT)"
}
if {![file isdirectory $RPT]} {
  file mkdir $RPT
}

# ---- 预检 1:定位 .xpr(不猜) ---------------------------------------------- #
if {$PROJECT_FILE eq ""} {
  # 工程可以直接放 `prj/<工程>.xpr`,也可以放在一层子目录里(`prj/<目录>/<工程>.xpr`)——
  # Vivado 的 `create_project <名> prj/<目录>` 就是后一种。两种都认;**多于一个就拒绝挑**。
  set candidates [lsort [concat \
    [glob -nocomplain -directory $PRJ_ROOT -type f *.xpr] \
    [glob -nocomplain -directory $PRJ_ROOT -type f */*.xpr]]]
  if {[llength $candidates] == 0} {
    fail "no .xpr under $PRJ_ROOT -- create/open the Vivado project first, or set PROJECT_FILE"
  }
  if {[llength $candidates] > 1} {
    puts "\n\[run_prj_synth\] ERROR: found [llength $candidates] .xpr under $PRJ_ROOT; refusing to pick one:"
    foreach f $candidates { puts "\[run_prj_synth\]   $f" }
    fail "set PROJECT_FILE to the one you mean"
  }
  set PROJECT_FILE [lindex $candidates 0]
} elseif {![file isfile $PROJECT_FILE]} {
  fail "PROJECT_FILE not found: $PROJECT_FILE"
}
set XPR_FWD [string map {\\ /} $PROJECT_FILE]
puts "\[run_prj_synth\] project: $XPR_FWD"
puts "\[run_prj_synth\] reports: [string map {\\ /} $RPT]"

# ---- 预检 2:器件一致性(工程 spec 为准) ------------------------------------ #
proc spec_part {path} {
  if {![file isfile $path]} { return "" }
  set fh [open $path r]
  set text [read $fh]
  close $fh
  foreach line [split $text "\n"] {
    if {[regexp {器件|Device|Part} $line] && [regexp {xc[a-z0-9-]+} $line part]} { return $part }
  }
  return ""
}

set SPEC_PART [spec_part [file join $PROJECT_ROOT "doc" "spec.md"]]
set PRJ_PART  ""
if {[catch {
  open_project $PROJECT_FILE
  if {[llength [get_projects -quiet]] == 0} { error "open_project produced no project" }
  set PRJ_PART [get_property PART [current_project]]
} err]} {
  fail "cannot open project: $err"
}
set PRJ_PART_FWD [string map {\\ /} $PRJ_PART]
puts "\[run_prj_synth\] project part: $PRJ_PART_FWD"
# DSH-05:器件以 doc/spec.md 为权威 —— 读不到就不能算「器件已核对」,更不许静默 PASS。
if {![file isfile [file join $PROJECT_ROOT "doc" "spec.md"]]} {
  fail "doc/spec.md not found under $PROJECT_ROOT -- the project spec is the authority for the device; create it before running project synthesis"
}
if {$SPEC_PART eq ""} {
  fail "no device part found in doc/spec.md -- write the device there first (spec is authoritative); refusing to report PASS without the spec/project device check"
}
puts "\[run_prj_synth\] spec part: $SPEC_PART"
if {[string tolower $SPEC_PART] ne [string tolower $PRJ_PART]} {
  fail "device mismatch: doc/spec.md says '$SPEC_PART' but the project part is '$PRJ_PART' -- fix one of them first (spec is authoritative)"
}

# ---- 预检 3:run 与顶层名 -------------------------------------------------- #
if {[llength [get_runs -quiet $RUN]] == 0} {
  set all_runs [get_runs -quiet]
  puts "\n\[run_prj_synth\] ERROR: run '$RUN' not found in the project. Existing runs:"
  foreach r $all_runs { puts "\[run_prj_synth\]   $r" }
  fail "set RUN to one of the runs above (or create the run in the project)"
}
set PRJ_TOP [get_property TOP [get_filesets sources_1]]
if {$TOP eq ""} {
  set TOP $PRJ_TOP
} elseif {$PRJ_TOP ne "" && $TOP ne $PRJ_TOP} {
  fail "top mismatch: knob TOP='$TOP' but the project top is '$PRJ_TOP'"
}
if {$TOP eq ""} { fail "empty top: set it in the project (sources_1) or pass TOP" }
puts "\[run_prj_synth\] run: $RUN   top: $TOP"

# ---- 可选:写综合用黑盒 stub(与模块版同口径:只有明确要求才写) ------------- #
if {$STUB_DIR ne ""} {
  set STUB_ROOT [file normalize [file join $PROJECT_ROOT $STUB_DIR]]
  file mkdir $STUB_ROOT
  step "write_verilog -mode synth_stub" {
    write_verilog -force -mode synth_stub [file join $STUB_ROOT "${TOP}_stub.v"]
  }
  puts "\[run_prj_synth\] stub: [string map {\\ /} [file join $STUB_ROOT "${TOP}_stub.v"]]"
}

# ---- 跑综合(先 reset,免得拿旧结果交差) ---------------------------------- #
step "launch_runs $RUN" {
  if {$RESET_RUN} { reset_run $RUN }
  launch_runs $RUN -jobs $JOBS
  wait_on_run $RUN
}

# ---- 收尾判定:四层,缺一层就会漏 ------------------------------------------ #
set status   [get_property STATUS   [get_runs $RUN]]
set progress [get_property PROGRESS [get_runs $RUN]]
if {$progress ne "100%" || ![string match "*Complete!*" $status]} {
  fail "run did not complete: run='$RUN' status='$status' progress='$progress'"
}

set RUN_LOG [file join [file dirname $PROJECT_FILE] "[file rootname [file tail $PROJECT_FILE]].runs" $RUN "runme.log"]
if {![file exists $RUN_LOG]} {
  fail "run log not found: $RUN_LOG -- cannot judge the run, refusing to pass"
}
set fh [open $RUN_LOG r]
set log [read $fh]
close $fh
set errs  {}
set crits {}
foreach line [split $log "\n"] {
  set trimmed [string trim $line]
  if {[regexp {^ERROR:} $trimmed]} { lappend errs $trimmed }
  if {[string first "CRITICAL WARNING" $trimmed] >= 0} { lappend crits $trimmed }
}
if {[llength $errs]} {
  fail "run log has [llength $errs] ERROR line(s), first ones:\n         [join [lrange $errs 0 4] "\n         "]\n         run log: $RUN_LOG"
}
if {[llength $crits]} {
  fail "run log has [llength $crits] CRITICAL WARNING line(s), first ones:\n         [join [lrange $crits 0 4] "\n         "]\n         run log: $RUN_LOG"
}
set crit_n [string trim [get_msg_config -severity {CRITICAL WARNING} -count]]
if {![regexp {^[0-9]+$} $crit_n]} {
  puts "\[run_prj_synth\] WARN: cannot read the CRITICAL WARNING count (got '$crit_n')"
} elseif {$crit_n > 0} {
  fail "$crit_n CRITICAL WARNING message(s) before synthesis completed -- see this run's -log argument"
}

# 第 4 层:主日志里可能有 runme.log 看不到的 CRITICAL WARNING(建工程/收文件阶段的)。
# 逐条列出来 + 计数,不直接判死(多数是提示);按 skill 的判据,出现的每条都要在结论里说明来源。
# DSH-02:-log 是 Vivado **launcher** 参数,普通 $argv 里未必有它,不能靠它猜。三条来源,按序取:
#   ① 旋钮 MAIN_LOG   ② -tclargs 的第一个参数(像 .log 路径就用)   ③ 本工程的约定路径。
set MAIN_LOG ""
if {$MAIN_LOG eq "" && [llength $argv] > 0} {
  set first [lindex $argv 0]
  if {[string match "*.log" $first] || [file isfile $first]} { set MAIN_LOG $first }
}
if {$MAIN_LOG eq ""} { set MAIN_LOG [file join $RPT "run_prj_synth.log"] }
set mainlog $MAIN_LOG
set MAIN_LOG_SEEN 0
set main_crits {}
if {$mainlog ne "" && [file exists $mainlog]} {
  set MAIN_LOG_SEEN 1
  set fh2 [open $mainlog r]
  set main_text [read $fh2]
  close $fh2
  foreach line [split $main_text "\n"] {
    set trimmed [string trim $line]
    # 被 source 的脚本会**逐行回显**进主日志(前缀 # );不过滤就会"自己吵自己"。
    if {[string match "#*" $trimmed]} continue
    if {[string first "CRITICAL WARNING" $trimmed] >= 0} { lappend main_crits $trimmed }
  }
}
if {[llength $main_crits]} {
  puts "\[run_prj_synth\] WARN: main log has [llength $main_crits] CRITICAL WARNING line(s) (not in runme.log) -- list and explain each:"
  foreach line [lrange $main_crits 0 9] { puts "\[run_prj_synth\]   $line" }
} elseif {$MAIN_LOG_SEEN} {
  puts "\[run_prj_synth\] main log inspected ([string map {\\ /} $mainlog]): no CRITICAL WARNING"
} else {
  puts "\[run_prj_synth\] MAIN LOG NOT INSPECTED (looked for [string map {\\ /} $mainlog]) -- this is NOT the same as clean"
  puts "\[run_prj_synth\]   pass the launcher log explicitly: -tclargs <path>, or set the MAIN_LOG knob"
}
puts "\[run_prj_synth\] gate: status='$status', no ERROR / CRITICAL WARNING"

# ---- 报告(工程约定:平铺进 doc/) ------------------------------------------ #
step "open_run $RUN" { open_run $RUN }
step "report_utilization" { report_utilization -file [file join $RPT "utilization.rpt"] }
step "report_timing_summary" { report_timing_summary -file [file join $RPT "timing_summary.rpt"] }
puts "\[run_prj_synth\] reports: [string map {\\ /} [file join $RPT "utilization.rpt"]] / [string map {\\ /} [file join $RPT "timing_summary.rpt"]]"

puts "\n\[run_prj_synth\] PASS: project synthesis completed (reports in [string map {\\ /} $RPT])"
exit 0
