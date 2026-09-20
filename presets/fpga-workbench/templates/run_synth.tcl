# ============================================================================ #
# run_synth.tcl - <ModuleName> 的批处理综合(synth 环节)                        #
#                                                                              #
# 跑法(**必须在模块根下跑**,`rtl/` 与 `synth/` 就在当前目录):                  #
#   & "<综合器路径>" -mode batch -source synth/run_synth.tcl \                 #
#       -log synth/run_synth.log -journal synth/run_synth.jou                  #
#                                                                              #
# **`-mode batch` 必须加**:不加会拉起图形界面、停在那儿等人点,无人值守跑不下去。 #
#                                                                              #
# 这是**模板**(从 templates/run_synth.tcl 起一份放进模块根,按工程改)。它把实测  #
# 踩过的坑固化了,下面几段别删:                                                 #
#   * **预检 `.xci` 的器件**:IP 与工程器件不同族,要到综合时才炸,报错还看不出根   #
#     因 —— 所以跑综合前先把两边的器件打出来比一遍。                            #
#   * **失败一律非零退出码**:报 ERROR、出 CRITICAL WARNING、器件不存在、源码缺失, #
#     都不许"看着跑完了"就算过。                                                #
#   * **报告落 `synth/`**;Vivado 工程与中间产物就地落 `synth/vivado_proj/`       #
#     (可再生的,别提交),**不得把工程塞进 `rtl/`**。                            #
#                                                                              #
# **控制台/日志里的消息一律用英文**:Vivado 的输出按本地代码页落盘,写中文会变乱码, #
# 而下面的判定要读这些行。注释用中文没关系(不会被打印)。                        #
#                                                                              #
# 路径全部从当前目录推出来,**不写死任何绝对路径**;也不往工程里拷任何本机配置。   #
# ============================================================================ #

set MODULE_ROOT [file normalize [pwd]]

# ---- 可改的地方(默认就是常规布局,不改也能跑)-------------------------------- #
# 器件型号:从 `spec/spec.md` 抄 —— 那是**唯一来源**;换器件只改那一处,别在这儿另立一份
set PART       "xc7a100tfgg484-2"
# 顶层模块名:必须与 RTL 里的 module 名一致
set TOP        "top"
# RTL 根目录(相对模块根):HDL 与 `ip/` 下的 `.xci` 都从这儿收
set RTL_DIR    "rtl"
# 报告输出目录(相对模块根):报告写进这里;Vivado 工程也就地落在它下面
set REPORT_DIR "synth"
# 要不要另写一份综合用黑盒 stub:1 = 写,0 = 不写
set GEN_STUB   1
# 综合策略:先 "default";不收敛时按技能里的策略阶梯换这一行重跑,每轮都留日志
set STRATEGY   "default"

# ---- 派生路径(不用改)------------------------------------------------------ #
set RTL      [file normalize [file join $MODULE_ROOT $RTL_DIR]]
set RPT      [file normalize [file join $MODULE_ROOT $REPORT_DIR]]
set PROJ_DIR [file join $RPT "vivado_proj"]
set PROJ     "synth_proj"
set RUN_LOG  [file join $PROJ_DIR "${PROJ}.runs" synth_1 "runme.log"]

# 失败一律:英文说清楚 + 非零退出码。所有失败分支都走它。
proc fail {msg} {
    puts "\n\[run_synth\] ERROR: $msg"
    exit 1
}

# 每一步都硬失败:Vivado 的报错不许变成"跑完了"
proc step {what body} {
    if {[catch {uplevel 1 $body} err]} {
        puts "\n\[run_synth\] ERROR: step '$what' failed:"
        puts "  $err"
        exit 1
    }
}

# ---- 收文件 ---------------------------------------------------------------- #
set ::SKIPPED_STUBS {}
# 前缀比较要**分隔符无关**:file normalize 给的是正斜杠路径,而 [file separator]
# 在 Windows 是反斜杠 —— 直接拼会永远对不上(实测踩过:stub 静默不跳了)。
set ::IP_PREFIX "[string map {\\ /} [file normalize [file join $RTL "ip"]]]/"

proc collect_files {dir exts skip_stubs} {
    set out {}
    if {![file isdirectory $dir]} { return $out }
    foreach f [lsort [glob -nocomplain -directory $dir -type f *]] {
        if {[lsearch -exact $exts [string tolower [file extension $f]]] < 0} { continue }
        # `rtl/ip/` 下的 `*_stub.*` **不进综合**:它和 IP 的真模型同名,一起收会重复定义。
        # stub 是留给 lint / 仿真的(见 fpga-module-rtl),原地不动,这里只跳过并打出来。
        if {$skip_stubs && [string match "*_stub.*" [file tail $f]] &&
            [string first $::IP_PREFIX [string map {\\ /} $f]] == 0} {
            lappend ::SKIPPED_STUBS $f
            continue
        }
        lappend out $f
    }
    foreach d [lsort [glob -nocomplain -directory $dir -type d *]] {
        set out [concat $out [collect_files $d $exts $skip_stubs]]
    }
    return $out
}

# ---- 预检 0:布局对得上 ----------------------------------------------------- #
# 跑错目录是最常见的"什么都没跑、看着还像成功";先把它挡掉。
if {![file isdirectory $RTL]} {
    fail "RTL dir not found: $RTL\n         run this script from the module root (cwd = $MODULE_ROOT)"
}
file mkdir $RPT

set HDL  [collect_files $RTL {.v .sv .vhd .vhdl} 1]
set XCIS [collect_files [file join $RTL "ip"] {.xci} 0]
set XDCS [lsort [glob -nocomplain -directory $RPT -type f *.xdc]]

foreach s $::SKIPPED_STUBS { puts "\[run_synth\] skip stub (not a synthesis source): $s" }
puts "\[run_synth\] sources: [llength $HDL] HDL, [llength $XCIS] xci, [llength $XDCS] xdc"

if {[llength $HDL] == 0} {
    fail "no HDL sources under $RTL -- nothing to synthesize"
}

# ---- 预检 1:`.xci` 里的器件必须与上面那个器件一致 --------------------------- #
# 为什么要提前查:IP 与器件不同族,要到综合时才炸,而报错看不出根因。
foreach xci $XCIS {
    set fh [open $xci r]
    set txt [read $fh]
    close $fh
    # `.xci` 有的版本是 JSON、有的是 XML;两边都是 `xxx_part... ` 后面跟器件串,
    # 而 Xilinx 器件串一律以 `xc` 开头 —— 拿它当锚,比按格式解析稳。
    if {![regexp -nocase {part[^A-Za-z0-9]{0,8}(xc[a-z0-9]+[a-z0-9\-]*)} $txt -> xpart]} {
        puts "\[run_synth\] WARN: no part found in $xci -- part check skipped for this file"
        continue
    }
    if {![string equal -nocase $xpart $PART]} {
        fail "part mismatch: IP and project target different devices\n         xci      : $xci\n         xci part : $xpart\n         project  : $PART\n         IP built for another part/family blows up only at synthesis time and the error does not point at the root cause.\n         Re-generate the IP for '$PART', or fix PART here (spec/spec.md is the single source)."
    }
    puts "\[run_synth\] OK: [file tail $xci] part = $xpart"
}

# ---- 建工程(就地落在报告目录下,别塞进 rtl/)-------------------------------- #
step "create_project" {
    create_project -force $PROJ $PROJ_DIR -part $PART
}
step "add HDL" {
    add_files -fileset sources_1 $HDL
}
if {[llength $XCIS]} {
    step "add IP" {
        add_files -fileset sources_1 $XCIS
    }
}
if {[llength $XDCS]} {
    # 约束按技能约定放 `synth/<模块名>.xdc`,这里按目录收,不用再改脚本
    step "add XDC" {
        add_files -fileset constrs_1 $XDCS
    }
} else {
    puts "\[run_synth\] WARN: no *.xdc in $RPT -- this run is unconstrained, the timing/clock reports mean nothing"
}
step "set top" {
    set_property top $TOP [current_fileset]
    update_compile_order -fileset sources_1
    set_property STEPS.SYNTH_DESIGN.ARGS.DIRECTIVE $STRATEGY [get_runs synth_1]
}

# ---- 跑综合(批处理,全程不弹图形界面)-------------------------------------- #
step "launch_runs synth_1" {
    launch_runs synth_1
    wait_on_run synth_1
}

# ---- 收尾判定:别静默通过 --------------------------------------------------- #
# 分三层,缺一层就会漏:任务状态、综合任务自己的日志、主进程的消息计数。
set status   [get_property STATUS   [get_runs synth_1]]
set progress [get_property PROGRESS [get_runs synth_1]]
if {$progress ne "100%" || ![string match "*Complete!*" $status]} {
    fail "synthesis did not complete: status='$status' progress='$progress'\n         run log: $RUN_LOG"
}
if {![file exists $RUN_LOG]} {
    fail "run log not found: $RUN_LOG -- cannot judge the run, refusing to pass"
}
set fh [open $RUN_LOG r]
set log [read $fh]
close $fh
set errs  {}
set crits {}
foreach line [split $log "\n"] {
    set line [string trim $line]
    if {[regexp {^ERROR:} $line]} { lappend errs $line }
    if {[string first "CRITICAL WARNING" $line] >= 0} { lappend crits $line }
}
if {[llength $errs]} {
    fail "synthesis log has [llength $errs] ERROR line(s), first ones:\n         [join [lrange $errs 0 4] "\n         "]\n         run log: $RUN_LOG"
}
if {[llength $crits]} {
    fail "synthesis log has [llength $crits] CRITICAL WARNING line(s), first ones:\n         [join [lrange $crits 0 4] "\n         "]\n         run log: $RUN_LOG"
}
# 建工程 / 收文件阶段的 CRITICAL WARNING 不进 runme.log,单独按消息计数再查一遍
set crit_n [string trim [get_msg_config -severity {CRITICAL WARNING} -count]]
if {![regexp {^[0-9]+$} $crit_n]} {
    puts "\[run_synth\] WARN: cannot read the CRITICAL WARNING count (got '$crit_n')"
} elseif {$crit_n > 0} {
    fail "$crit_n CRITICAL WARNING message(s) before synthesis completed -- see the log next to this script's -log argument"
}
puts "\[run_synth\] gate: status='$status', no ERROR / CRITICAL WARNING"

# ---- 报告与 stub ----------------------------------------------------------- #
step "open_run synth_1" {
    open_run synth_1
}
step "report_utilization" {
    report_utilization -file [file join $RPT "utilization.rpt"]
}
step "report_timing_summary" {
    report_timing_summary -file [file join $RPT "timing_summary.rpt"]
}
if {$GEN_STUB} {
    # stub **必须落在 `rtl/ip/<顶层>/` 下**:仿真的 run.do 只跳过 `rtl/ip/` 下的
    # `*_stub.*`,放到别处就会和真模型同名打架(见 fpga-module-rtl / fpga-module-verif)。
    set stub [file join $RTL "ip" $TOP "${TOP}_stub.v"]
    file mkdir [file dirname $stub]
    step "write_verilog -mode synth_stub" {
        write_verilog -force -mode synth_stub $stub
    }
    puts "\[run_synth\] stub: $stub"
}

puts "\n\[run_synth\] PASS: synthesis completed, reports in $RPT"
exit 0
