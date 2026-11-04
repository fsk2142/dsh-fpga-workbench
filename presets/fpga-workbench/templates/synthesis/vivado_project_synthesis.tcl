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
# 7) JOBS          并行任务数。8) RESET_POLICY  跑之前怎么处理 run 的已有状态:
#    auto   —— 已经 Complete! 且 NEEDS_REFRESH 为假 → **复用**(出报告,不重跑;Project Mode
#              本来就在管 run state,没必要每次自己 reset);
#    always —— 先 reset_run 再跑(正式复验 / 想拿一次干净结果时用)。
set PRJ_DIR      "prj"
set PROJECT_FILE ""
set RUN          "synth_1"
set TOP          ""
set STUB_DIR     ""
set REPORT_DIR   "doc"
set JOBS         4
set RESET_POLICY "auto"

# ---- 两个失败出口:英文说清楚 + 非零退出码 ---------------------------------- #
# ⚠️ 必须定义在任何调用之前:Tcl 自上而下解释,下面派生路径段里就有一处 `fail`
# (工程目录是 junction 时)。写在使用之后会报 `invalid command name "fail"`,
# 护栏文案失效。2026-10-22 审查(L2)。
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

# ---- 派生路径(不用改) ------------------------------------------------------ #
set PRJ_ROOT [file normalize [file join $PROJECT_ROOT $PRJ_DIR]]
# DSH-N01:工程目录自己也不能是链接(否则整个工程都在工程根外)。
if {[file type $PRJ_ROOT] eq "link"} {
  fail "prj dir is a symlink/Junction; refusing to follow it: $PRJ_ROOT"
}
set RPT      [file normalize [file join $PROJECT_ROOT $REPORT_DIR]]
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
  # doc/spec.md 是用户手写的 UTF-8 文本。Tcl 的 `open $path r` 用系统编码
  # (中文 Windows 上是 cp936),不显式指定时「器件」会被解成乱码,于是这一行
  # 明明写着器件也会被判成"规格里没有器件"。
  set fh [open $path r]
  fconfigure $fh -encoding utf-8
  set text [read $fh]
  close $fh
  foreach line [split $text "\n"] {
    # 模式本身也要用 ASCII 的 \u 转义写:脚本文件同样被 Tcl 按系统编码读取,
    # 直接写中文的话,内存里的模式就已经是乱码了 —— 文件读对了也匹配不上。
    if {[regexp "\u5668\u4ef6|Device|Part" $line] && [regexp {xc[a-z0-9-]+} $line part]} { return $part }
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

# ---- 综合前的 RTL 检查（必跑，两道）----------------------------------------- #
#
# 仿真通过只说明「功能对」，不说明「能综合成你想要的电路」。
# 综合器跑的是**行为模型**，允许很多综合器不接受、或不按你想的方式实现的东西
# （initial 块、锁存器、无复位寄存器、多驱动）。这些在仿真里完全正常，
# 综合时才暴露 —— 而那时往往已经花了几十分钟。
#
# 两道互补，**顺序不能反、不能合并**：
#   ① `synth_design -lint` —— Vivado RTL Linter 的 14 条可综合性规则
#   ② `synth_design -rtl`  —— elaboration：查连通性/结构错误
#
# **2026-11-04 真机验证过**（Vivado 2025.2，工程模式下实测）：
#   · 两道在工程模式下都合法可用
#   · `-lint` 与 `-rtl` **互斥**（同时给报 `-lint and -rtl are mutually exclusive`）
#   · `-lint` 之后**立即**读消息才拿得到计数；跑到下一步就归零
#   · `get_msg_config -count -severity {...}` **返回单个整数，不是列表** ——
#     实测 ERROR→`0`、CRITICAL WARNING→`1`、WARNING→`2`。
#     所以用 `string trim` 取整数；**用 `llength` 会数错**
#     （`llength 0` = 1 误报，`llength 2` = 1 少报）。
#
# **放在复用判断之前**：否则 RESET_POLICY=auto 复用旧 run 时会整个跳过检查。
step "synth_design -lint (Vivado RTL Linter)" {
  set lint_rpt [file join $RPT "rtl_lint.rpt"]
  if {[catch { synth_design -lint -top $TOP -part $PART -file $lint_rpt } lint_err]} {
    fail "Vivado RTL linter failed: $lint_err
          this is the lint pass, before any elaboration. Fix the RTL or the lint
          invocation (see templates/linter/vivado_rtl_lint.tcl) and re-run."
  }
  if {![file exists $lint_rpt]} {
    fail "RTL linter did not write $lint_rpt -- cannot judge the result, refusing to pass."
  }
  set n_err  0
  set n_crit 0
  if {![catch { set n_err [expr {int([string trim [get_msg_config -count -severity {ERROR}]])}] }]} {} else { set n_err 0 }
  if {![catch { set n_crit [expr {int([string trim [get_msg_config -count -severity {CRITICAL WARNING}]])}] }]} {} else { set n_crit 0 }

  if {$n_err > 0} {
    fail "RTL linter reported $n_err ERROR(s) -- see $lint_rpt
          these are hard problems (unparsable / unsupported constructs), not style."
  }
  if {$n_crit > 0} {
    puts "\[run_prj_synth\] WARN: RTL linter reported $n_crit CRITICAL WARNING(s) -- see $lint_rpt"
    puts "\[run_prj_synth\]       （不判死，但必须逐条列进结论：可综合性风险要人判）"
  } else {
    puts "\[run_prj_synth\] RTL linter: no error, no critical warning -> $lint_rpt"
  }
}

step "synth_design -rtl (RTL elaboration check)" {
  if {[catch { synth_design -rtl -top $TOP -part $PART -name rtl_check } rtl_err]} {
    fail "RTL elaboration check failed before synthesis: $rtl_err
          this usually means non-synthesizable constructs or width/connection errors.
          The simulator accepts behaviour models that Vivado rejects --
          fix it here, do not just run synthesis and hope."
  }
  puts "\[run_prj_synth\] RTL elaboration check: PASSED"
}

# 回到干净的工程状态，让后面的 launch_runs 从头跑
step "reset after rtl checks" {
  catch { close_design }
}

# ---- 跑综合:auto 下先看 run 状态,能复用就不重跑(Project Mode 自己管 run state)- #
# 为什么不再默认每次 reset_run(2026-09-24;审查报告 T-07):reset 之后**一定**重新综合一遍,
# 源码/约束/IP 都没动也一样 —— 反复迭代时每次白等;而"可靠"不等于"每次重跑"。
# 证明不了新鲜(NEEDS_REFRESH 读不到、状态不是 Complete!)就重跑,所以复用不会拿旧结果交差。
set REUSED 0
if {$RESET_POLICY eq "auto"} {
  set status  [get_property STATUS   [get_runs $RUN]]
  set prog    [get_property PROGRESS [get_runs $RUN]]
  set refresh 1
  catch { set refresh [get_property NEEDS_REFRESH [get_runs $RUN]] }
  set fresh 0
  if {[catch { set fresh [expr {!$refresh}] }]} { set fresh 0 }
  if {$fresh && $prog eq "100%" && [string match "*Complete!*" $status]} {
    set REUSED 1
    puts "\[run_prj_synth\] RESET_POLICY=auto: '$RUN' is Complete! and NEEDS_REFRESH=false -> reusing it (set RESET_POLICY always to rebuild)"
  } else {
    puts "\[run_prj_synth\] RESET_POLICY=auto: '$RUN' is stale (status='$status' progress='$prog' needs_refresh='$refresh') -> reset + relaunch"
  }
} elseif {$RESET_POLICY ne "always"} {
  fail "RESET_POLICY must be auto or always (got '$RESET_POLICY')"
}

if {!$REUSED} {
  step "launch_runs $RUN" {
    if {$RESET_POLICY eq "always" || [get_property STATUS [get_runs $RUN]] ne "Not started"} {
      reset_run $RUN
    }
    launch_runs $RUN -jobs $JOBS
    wait_on_run $RUN
  }
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

# ---- 注意：这里**故意不做 DRC** --------------------------------------------- #
#
# 工程流的分工是：**synth 只做综合，DRC 属于 impl**（见 `fpga-project-synth` 技能：
# 「只做 synthesis。布局布线、DRC、出 bit 在 fpga-project-impl」）。
#
# `vivado_implementation.tcl` 里已有完整的 DRC 门，而且比这里能写的更准确 ——
# 它专门处理了 NSTD-1 / UCIO-1 在 `write_bitstream` 阶段会被升级成 ERROR 这件事
# （综合阶段的它们只是 Critical Warning，判据不同）。
#
# 所以这里不重复实现：在综合阶段拿 Critical Warning 判死会**误杀**
# （综合后没约束引脚是常见的中间状态，impl 补上约束是正常流程）。
#
# 模块级不同：模块只到综合为止，没有 impl 环节，所以那边必须有 DRC。

puts "\n\[run_prj_synth\] PASS: project synthesis completed (reports in [string map {\\ /} $RPT])"
exit 0
