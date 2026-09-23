# ============================================================================ #
# run_synth.tcl - <ModuleName> 的批处理综合(synth 环节)                       #
# ============================================================================ #
# 跑法(**必须在模块根下跑**,`rtl/` 与 `synth/` 就在当前目录):
#   & "<综合器路径>" -mode batch -source synth/run_synth.tcl \
#       -log synth/run_synth.log -journal synth/run_synth.jou
#
# **`-mode batch` 必须加**:不加会拉起图形界面、停在那儿等人点,无人值守跑不下去。
#
# 这是分类模板库里的综合模板(起到模块根 `synth/run_synth.tcl` 后按当前模块改)。下面几段的
# "为什么这么写"都是实测踩出来的,别删:
#   * **预检 `.xci` 的器件**:IP 与工程器件不同族,要到综合时才炸,报错还看不出根因 ——
#     所以跑综合前先把两边的器件打出来比一遍。**器件有两种写法,两种都要认**(见下面
#     `xci_part`):2025.x 生成的 `.xci` 把器件拆成 DEVICE/PACKAGE/SPEEDGRADE 三段,只认
#     `part = xc…` 那种整串的话真文件一个都匹配不上 —— 预检会**静默跳过**(实测 9 个真文件)。
#   * **proc 体内别在注释里写花括号**:注释同样参与括号配对,一个裸花括号就把 proc 拆散,
#     里面的语句跑到顶层执行,报的错还看不出根因(实测踩过)。
#   * **失败一律非零退出码**:报 ERROR、出 CRITICAL WARNING、器件不存在、源码缺失,都
#     不许"看着跑完了"就算过。
#   * **报告落 `synth/`**;Vivado 工程与中间产物就地落 `synth/vivado_proj/`(可再生的,
#     别提交),**不得把工程塞进 `rtl/`**。
#
# **控制台/日志里的消息一律用英文**:Vivado 的输出按本地代码页落盘,写中文会变乱码,
# 而下面的判定要读这些行。注释写中文没关系 —— 但要知道**注释也会被回显进日志**(实测:中文
# 在日志里是乱码,不影响执行,只是不好读),所以判定要读的行与关键说明都用英文。
#
# 路径全部从当前目录推出来,**不写死任何绝对路径**;也不往工程里拷任何本机配置。
# ============================================================================ #

set MODULE_ROOT [file normalize [pwd]]

# ---- 旋钮:默认就是常规布局,不改也能跑 -------------------------------------- #
# 1) PART          器件型号:从包含本模块的工程 `doc/spec.md`(按 project 锚点定位)或本模块
#                  的 `spec/spec.md` 读,整条链上只该有一处;别在这儿另立一份。
# 2) TOP           顶层模块名:必须与 RTL 里的 module 名一致。
# 3) RTL_DIR       RTL 根目录(相对模块根):HDL 与 `ip/` 下的 `.xci` 都从这儿收。
# 4) REPORT_DIR    报告输出目录(相对模块根):报告写进这里;Vivado 工程就地落在它下面。
# 5) GEN_STUB      要不要另写一份综合用黑盒 stub:1 = 写,0 = 不写。
# 6) STRATEGY      综合策略:先 "default";不收敛时按技能里的策略阶梯换这一行重跑,
#                  每轮都留日志。
set PART       "xc7a100tfgg484-2"
set TOP        "top"
set RTL_DIR    "rtl"
set REPORT_DIR "synth"
set GEN_STUB   1
set STRATEGY   "default"

# ---- 派生路径(不用改) ------------------------------------------------------ #
set RTL      [file normalize [file join $MODULE_ROOT $RTL_DIR]]
set RPT      [file normalize [file join $MODULE_ROOT $REPORT_DIR]]
set PROJ_DIR [file join $RPT "vivado_proj"]
set PROJ     "synth_proj"
set RUN_LOG  [file join $PROJ_DIR "${PROJ}.runs" synth_1 "runme.log"]

# ---- 两个失败出口:英文说清楚 + 非零退出码 ---------------------------------- #
# fail:所有失败分支都走它。step:每一步都硬失败,Vivado 的报错不许变成"跑完了"。
proc fail {msg} {
  puts "\n\[run_synth\] ERROR: $msg"
  exit 1
}

proc step {what body} {
  if {[catch {uplevel 1 $body} err]} {
    puts "\n\[run_synth\] ERROR: step '$what' failed:"
    puts "  $err"
    exit 1
  }
}

# ---- 收文件 ---------------------------------------------------------------- #
set ::SKIPPED_STUBS {}
# 前缀比较要**分隔符无关**:file normalize 给的是正斜杠路径,而 [file separator] 在
# Windows 是反斜杠 —— 直接拼会永远对不上(实测踩过:stub 静默不跳了)。
set ::IP_PREFIX "[string map {\\ /} [file normalize [file join $RTL "ip"]]]/"

proc collect_files {dir exts skip_stubs} {
  set out {}
  if {![file isdirectory $dir]} { return $out }
  foreach f [lsort [glob -nocomplain -directory $dir -type f *]] {
    if {[lsearch -exact $exts [string tolower [file extension $f]]] < 0} { continue }
    # `rtl/ip/` 下的 `*_stub.*` **不进综合**:它和 IP 的真模型同名,一起收会重复定义。
    # stub 是留给 lint / 仿真的(见 fpga-module-rtl),原地不动,这里只跳过并打出来。
    if {$skip_stubs && [string match "*_stub.*" [file tail $f]]
        && [string first $::IP_PREFIX [string map {\\ /} $f]] == 0} {
      lappend ::SKIPPED_STUBS $f
      continue
    }
    lappend out $f
  }
  foreach d [lsort [glob -nocomplain -directory $dir -type d *]] {
    # 第八轮复审 E8-04:与 compile.do 的 collect_hdl 同一条判据 —— `glob -type d` 会把**链接目录**
    # (symlink / Junction)算进来,顺着走会把工程外的源码收进综合、来源不可复核;跳过链接即断环。
    if {[file type $d] eq "link"} {
      puts "\[run_synth\] SKIP linked dir (not followed): $d"
      continue
    }
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

# ---- 预检 1:`.xci` 里的器件必须与上面那个器件一致 -------------------------- #
# 为什么要提前查:IP 与器件不同族,要到综合时才炸,而报错看不出根因。
# 器件的两种写法**都要认** —— 只认一种的话,另一种会被当成"文件里没写器件"而**静默跳过预检**。
# 实测(2026-09-21,9 个真实 `.xci`,Vivado 2025.2 生成):它们全是下面第 ① 种,旧写法一条都
# 匹配不上,预检其实一直没跑。所以从 ① 开始试:
#   ① 2025.x 的 JSON(`xilinx.com:schema:json_instance:1.0`):器件被拆成三个参数 ——
#      `"DEVICE": [ { "value": "<器件>" } ]`、`"PACKAGE": … "<封装>"`、`"SPEEDGRADE": … "<速度等级>"`
#      —— 拼起来才是 Vivado 的器件串(拼法就是 `xci_part` 里那句 `"$dev$pkg$spd"`)。
#   ② 老写法 / XML:某个 part 引用后面直接跟整条器件串(即与上面那个 `set PART` 同形的一串)。
# 返回 `{器件串 是否完整}`:拿不到速度等级时只拼到封装(那就只能按前缀比,不能因此判成不匹配)。
proc xci_part {txt} {
  set dev ""
  regexp -nocase {"DEVICE"[ \t]*:[ \t]*\[[ \t]*\{[ \t]*"value"[ \t]*:[ \t]*"([^"]+)"} $txt -> dev
  if {$dev ne ""} {
    set pkg ""
    regexp -nocase {"PACKAGE"[ \t]*:[ \t]*\[[ \t]*\{[ \t]*"value"[ \t]*:[ \t]*"([^"]+)"} $txt -> pkg
    if {$pkg ne ""} {
      set spd ""
      # 写法与上面两条**同形**(锚定到 value 键)。别用"排除花括号"那种正则:braced 字符串
      # 里出现裸花括号会提前结束它 —— 实测:proc 被拆散、里面的语句跑到顶层执行。注意
      # **注释也一样**:proc 体内的注释同样参与括号配对,所以注释里也不要花括号。
      regexp -nocase {"SPEEDGRADE"[ \t]*:[ \t]*\[[ \t]*\{[ \t]*"value"[ \t]*:[ \t]*"([^"]*)"} $txt -> spd
      return [list "$dev$pkg$spd" [expr {$spd ne ""}]]
    }
  }
  if {[regexp -nocase {part[^A-Za-z0-9]{0,8}(xc[a-z0-9]+[a-z0-9\-]*)} $txt -> whole]} {
    return [list $whole 1]
  }
  return [list "" 0]
}

foreach xci $XCIS {
  set fh [open $xci r]
  set txt [read $fh]
  close $fh
  lassign [xci_part $txt] xpart xcomplete
  if {$xpart eq ""} {
    puts "\[run_synth\] WARN: no part found in $xci -- part check skipped for this file"
    continue
  }
  # 器件串不完整(缺速度等级)时按**前缀**比:比不出来就说比不出来,不据此判成不匹配。
  set same [expr {$xcomplete
    ? [string equal -nocase $xpart $PART]
    : [string equal -nocase -length [string length $xpart] $PART $xpart]}]
  if {!$same} {
    fail "part mismatch: IP and project target different devices
         xci      : $xci
         xci part : $xpart
         project  : $PART
         IP built for another part/family blows up only at synthesis time and the error does\
         not point at the root cause.
         Re-generate the IP for '$PART', or fix PART here (the project spec is the single source of the device)."
  }
  if {$xcomplete} {
    puts "\[run_synth\] OK: [file tail $xci] part = $xpart"
  } else {
    # 器件串不全(缺速度等级)时只比到前缀 —— **不能打成 OK**(第三轮复审 N-13):那会让人以为
    # "器件核对过了",而实际上速度等级没核。如实说清比到了什么、什么没核。
    puts "\[run_synth\] WARN: [file tail $xci] part = $xpart INCOMPLETE: only device+package known, speed grade missing -- prefix compare against $PART passed"
  }
}

# ---- 建工程(就地落在报告目录下,别塞进 rtl/) -------------------------------- #
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
  puts "\[run_synth\] WARN: no *.xdc in $RPT -- this run is unconstrained,\
        the timing/clock reports mean nothing"
}
step "set top" {
  set_property top $TOP [current_fileset]
  update_compile_order -fileset sources_1
  set_property STEPS.SYNTH_DESIGN.ARGS.DIRECTIVE $STRATEGY [get_runs synth_1]
}

# ---- 跑综合(批处理,全程不弹图形界面) --------------------------------------- #
step "launch_runs synth_1" {
  launch_runs synth_1
  wait_on_run synth_1
}

# ---- 收尾判定:别静默通过(四层,缺一层就会漏) -------------------------------- #
# 1) 任务状态(status / progress);2) 综合任务自己的 runme.log;3) 主进程的消息计数;
# 4) **主日志**里的 CRITICAL WARNING(建工程 / 收文件阶段的那几条不进 runme.log,得单独再扫一遍)。
set status   [get_property STATUS   [get_runs synth_1]]
set progress [get_property PROGRESS [get_runs synth_1]]
if {$progress ne "100%" || ![string match "*Complete!*" $status]} {
  fail "synthesis did not complete: status='$status' progress='$progress'
         run log: $RUN_LOG"
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
  set head "synthesis log has [llength $errs] ERROR line(s), first ones:"
  fail "$head\n         [join [lrange $errs 0 4] "\n         "]\n         run log: $RUN_LOG"
}
if {[llength $crits]} {
  set head "synthesis log has [llength $crits] CRITICAL WARNING line(s), first ones:"
  fail "$head\n         [join [lrange $crits 0 4] "\n         "]\n         run log: $RUN_LOG"
}
set crit_n [string trim [get_msg_config -severity {CRITICAL WARNING} -count]]
if {![regexp {^[0-9]+$} $crit_n]} {
  puts "\[run_synth\] WARN: cannot read the CRITICAL WARNING count (got '$crit_n')"
} elseif {$crit_n > 0} {
  fail "$crit_n CRITICAL WARNING message(s) before synthesis completed --\
        see the log next to this script's -log argument"
}
# 第 4 层:主日志里可能有 runme.log 看不到的 CRITICAL WARNING。实测踩过 —— 真综合跑出 PASS,
# 而主日志里躺着一条 filemgmt 20-742(can not be validated);只报消息计数会漏掉它。
# 这些**不一定致命**(多数是建工程阶段的提示),所以这里**逐条列出来 + 计数**,不直接判死;
# 按 skill 的判据,出现的任何 CRITICAL WARNING 都要在人/AI 的结论里逐条说明来源。
# (路径从 `-log` 参数取;取不到就退回 `synth/run_synth.log` —— 本脚本约定在模块根下跑。)
set mainlog ""
foreach {flag value} $argv {
  if {$flag eq "-log"} { set mainlog $value }
}
if {$mainlog eq "" || ![file exists $mainlog]} {
  set mainlog [file join [pwd] "synth" "run_synth.log"]
}
set main_crits {}
set MAIN_LOG_SEEN 0
if {[file exists $mainlog]} {
  set MAIN_LOG_SEEN 1
  set fh2 [open $mainlog r]
  set main_text [read $fh2]
  close $fh2
  foreach line [split $main_text "\n"] {
    set line [string trim $line]
    # Vivado 会把被 source 的脚本**逐行回显**进主日志(前缀 `# `)—— 本脚本自己的注释与 puts 里
    # 就写着 "CRITICAL WARNING" 这几个字,不过滤就会"自己吵自己"(实测:列出的 7 条里 6 条是回显)。
    if {[string match "#*" $line]} continue
    if {[string first "CRITICAL WARNING" $line] >= 0} { lappend main_crits $line }
  }
}
if {[llength $main_crits]} {
  puts "\[run_synth\] WARN: main log has [llength $main_crits] CRITICAL WARNING line(s) (not in runme.log) -- list and explain each:"
  foreach line [lrange $main_crits 0 9] { puts "\[run_synth\]   $line" }
  if {[llength $main_crits] > 10} {
    puts "\[run_synth\]   ...([expr {[llength $main_crits] - 10}] more)"
  }
} elseif {$MAIN_LOG_SEEN == 0} {
  puts "\[run_synth\] MAIN LOG NOT INSPECTED (looked for [string map {\\ /} $mainlog]) -- this is NOT the same as clean"
} else {
  puts "\[run_synth\] main log inspected ([string map {\\ /} $mainlog]): no CRITICAL WARNING"
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
