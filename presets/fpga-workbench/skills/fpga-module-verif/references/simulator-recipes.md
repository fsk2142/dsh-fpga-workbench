# 仿真器与厂商库配方

## 第二步:跑出来(全程命令行,不弹图形界面)

下面的例子按 **SystemVerilog**(`.sv`)写;选了 Verilog / VHDL 就把扩展名换成 `.v` / `.vhd`,
编译命令也换成对应语言的形式(`vcom` 对应 VHDL,`vlog`/`xvlog -sv` 对应 SV)。

**先用设置里选定的仿真器** —— 看会话开头「本机 FPGA 工具链」的**已就绪清单**:仿真器是
ModelSim / QuestaSim / Vivado XSim / Verilator、路径是什么,都写在那里。**不得另行挑选一个。**

**ModelSim / QuestaSim(默认)**

编译与运行使用**同一份**模板 `verif/run.do`,按模式调用:`do run.do compile` 只收集并编译,`do run.do run` 只加载已编译的
`work/`、运行并判定。这样可反复改激励/换顶层而不把两个职责混成一份不可复核的大脚本。

**模板自己管新鲜度与配置身份(2026-09-25 起)** —— 遇到这几条报错不要手改 stamp、不要绕过:

- 改 `.svh`/`.vh` → `compile` **全量重编** Verilog/SystemVerilog(谁 include 了它推不出来);VHDL 一变 → 全量重编
  `vcom`;`.sv`/`.v` 交**全量**给 `vlog -incr`(由 ModelSim 决定重编谁);一个文件都没变时整段跳过 vlog。
- **编译配置身份**(仿真器、`modelsim.ini` 路径+mtime+size、`TB_DEFINES`、`EXTRA_INCDIRS`、`VENDOR_LIBS`、
  `OPT_LEVEL`)也进 stamp。改了任一项,`run` 会**退 1 并点名是哪一项**;这时要重跑 `compile`,而它会
  **清空 `work/` + 全量重编**(不是"什么都没变")。旧版模板写的 stamp 没有这些行 → 同样会被拒。
- 编译失败会**自动重试一次**:顺序依赖(package/entity 先后)的形态是"先缺后补",失败那趟已把后一个
  unit 编进库,重试即过(实测反序报 `Could not find the package` → 同命令重跑 0 error)。
- **批处理不带 `+acc`**(本机实测快 2.3~2.6×):要加 `+acc` 或看内部信号/波形,走第三个模式 `load`。

**别手抄脚本**:从设置里选中的那份**仿真脚本**模板起一份(编译与运行本来就是同一份脚本,起第二次会被
「已存在、不覆盖」挡下 —— 不要起两次),起完按当前模块改旋钮:

```powershell
node "<自带命令目录>\module\module-verif-new.mjs" <模块根> --kind sim-run --template "<仿真脚本模板路径>"
cd <模块根>/verif
# 编译与运行**两步**都带上设置里的库映射(F5-06):路径见会话「库映射文件」
# 例:$env:MODELSIM_INI = "C:\...\modelsim.ini"  —— 用完在同一 try/finally 里恢复
& "<仿真器路径>" -c -do "do run.do compile; quit -f"
& "<仿真器路径>" -c -do "do run.do run; quit -f"
```

模板里这几段**别删**(删了就退回"看着跑完了、其实没跑"的形态):

- compile 模式收集时**跳过 `rtl/ip/` 下的 `*_stub.*`**:IP 自带的黑盒 stub 与真模型**同名**,放它进编译会
  **静默覆盖真模型**(vlog 只给 Warning),整轮仿真跑在空模块上还打印成功标记;跳过了要打印出来。
- compile 模式对 VHDL/Verilog 分派并用 `catch` 判定,失败即 `quit -f -code 1`;
- run 模式的 **`onfinish stop` 必须在 elaborate 之后**,否则 `$finish`/`$fatal` 直接结束会话;
- run 模式结尾的 **run-level gate** 扫 `sim.log`:有 `Error`/`Fatal` 或缺成功标记 → `-code 1`。

**判据:先要求 compile 模式退出 0，再看 run 模式的退出码** —— 裸 `vsim` 的退出码**不可信**
(实测 2020.4:`$fatal` 之后 `run -all` 既不抛错也不改退出码,退出码仍是 0),是**模板里的 gate**
把它变成可靠判据的。**没有 gate 的脚本不能按退出码判。**

- 想清库重跑:`vdel` 要先判一下 `if {[file exists work]} { catch {vdel -lib work -all} }` ——
  裸的 `vdel` 在没有 work 库时会报错并中止整个脚本、而退出码仍是 0(表现为"已跑过",实际什么都没跑)

**Vivado XSim**(选了它就用 Vivado bin 目录下的这三个命令)

```powershell
$oldLocalUserData = $env:XILINX_LOCAL_USER_DATA
try {
  $env:XILINX_LOCAL_USER_DATA = "NO" # 工作区规则的唯一口径:XILINX_LOCAL_USER_DATA=NO
  cd <模块根>/verif
  xvlog -sv ../rtl/<源码...> tb_<snake>.sv
  xelab -debug typical tb_<模块名> -s tb_sim
  xsim tb_sim -runall
} finally {
  if ($null -eq $oldLocalUserData) { Remove-Item Env:XILINX_LOCAL_USER_DATA -ErrorAction SilentlyContinue }
  else { $env:XILINX_LOCAL_USER_DATA = $oldLocalUserData }
}
```

只写各仿真器**通用**的几条(各工具自己的坑写在该选项的说明里,见会话开头的调用姿势):

- **编译顺序:被例化的在前**,按层级自底向上排;顺序错了会报未解析的模块
- 多个测试平台**一个平台一个进程**跑(`tb_sub_*` → 其余 `tb_*` → `tb_top_*`),`$finish` 结束一个进程

## 模板的旋钮(改行为不用改脚本体)

自带模板 `modelsim_run.do` 已经把常用场景固化了。**要改行为先看这张表**,
别去改脚本正文 —— 改正文会在下次安装模板时被覆盖,而且容易破坏新鲜度判定。

| 旋钮 | 默认 | 什么时候改 |
| --- | --- | --- |
| `RTL_DIR` | `{../rtl}` | HDL 不在 `../rtl` 时（工程布局会自动切到 `../src/rtl`） |
| `TB_PATTERN` | `{tb_*.sv tb_*.v tb_*.vhd tb_*.vhdl}` | 测试平台不叫 `tb_*` 时 |
| `TOP_OVERRIDE` | `{}` | **多个 TB 匹配**时指定跑哪个，不写会报歧义 |
| `FULL_REBUILD` | `0` | 怀疑 `work/` 里残留旧 design unit 时；设 1 清库全量重编 |
| `OPT_LEVEL` | `{-O5}` | 要 `vopt` 别的优化级别；设 `{}` 退回工具默认（-O4） |
| `BATCH_VOPT_ARGS` | `{}` | 批处理要事后从 wlf 出波形时设 `{+acc=rn}`（代价：慢 2.3–2.6×） |
| `DEBUG_VOPT_ARGS` | `{+acc=rn}` | GUI `load` 的可见性；想要更快可设 `{}` |
| `EXTRA_INCDIRS` | `{}` | 源码用 `` `include `` 且不在当前目录时 |
| `INI_OVERRIDE` | `{}` | 要指定另一份库映射文件（不必设环境变量，用完即弃） |
| `VENDOR_LIBS` | `{unisim unimacro}` | 用原语时保持默认；换别的厂商库时替换 |
| `GLBL_TOP` | `1` | 用 XPM 时保持默认；确定不用 XPM 且找不到 `glbl.v` 时设 0 消掉提示 |
| `COVERAGE` | `1` | 不关心覆盖率时设 0 换速度（编译 + 运行都快些） |
| `COVERAGE_SPEC` | `{sbcef}` | 要换统计类别时（s 语句 b 分支 c 条件 e 表达式 f 状态机） |
| `COVERAGE_UCDB` | `{coverage.ucdb}` | 要改覆盖率数据库文件名时；`module-verif-coverage.mjs` 默认找 `verif/coverage.ucdb` |
| `RESULT_LOG` | `{sim.log}` | 要换仿真日志名时；gate 靠读它判成功标记 |

改法：在 `verif/run.do` 里改对应的 `set` 行，或从模板复制一份另存（模板每次安装会覆盖）。
`verif/work/` 与 `*.ucdb` 是可再生产物，不要提交。

## 厂商原语仿真:先查库映射,别先怀疑 RTL

用到 `IBUF` / `BUFG` / `FDRE` 这类厂商原语、或 IP 核的仿真模型时,下面四条是**实测**出来的
(ModelSim 2020.4 + Vivado 2025.2 的库),照做,不要自己推:

1. **`-L` 接的是「库名」,不是目录** —— `vlog -L unisims_ver` / `vsim -L unisims_ver` 对;
   写绝对路径就报 `Unable to find library` 或 `Module 'IBUF' is not defined`。
   库名从哪来:`modelsim.ini` 的 `[Library]` 段(`库名 = 目录`,一行一条;本机那份在
   ModelSim 安装目录下,几百条映射指向厂商**编译好的**库)。
2. **编译与仿真两头都要带 `-L`** —— 只给 `vsim` 不给 `vlog`,照样报未定义。
3. **带 GSR(全局置位)的原语要配 `glbl`**,而且仿真必须**跑过 GSR 释放**(标准 `glbl.v`
   是 100 ns)。没跑过去会看到"寄存器恒 0" —— 那是**假象**,不得据此判成设计错。
   `glbl` 的加载方式见第 5 条。
4. **`modelsim.ini` 的搜索顺序**:`MODELSIM` 环境变量 → **当前目录的 `modelsim.ini`** →
   安装目录那份。工作目录里若冒出一份(工具生成的、从别处拷来的),它会**盖掉**安装目录
   那份,表现是"库突然全找不到"而那份 ini 单看没毛病 —— 先看有没有这个文件,再怀疑别的。
5. **`glbl` 必须作为第二个顶层传给 vsim,不能在 TB 里实例化**(2026-10-28 实测):

   ```
   vsim -L xpm work.tb_top work.glbl     ← 对
   vsim work.tb_top                      ← 错:找不到 glbl.GSR
   ```

   TB 里写 `glbl u_glbl();` **也不行** —— 路径会变成 `tb_top.u_glbl.GSR`,而 XPM 引用的是
   **绝对层次名** `glbl.GSR`(`xpm_cdc.sv:213` 的 `tri0 glblGSR_xpmcdc = glbl.GSR;`)。
   `glbl.v` 在 Vivado 安装目录 `data/verilog/src/glbl.v`,**要和设计一起编进 work**。
   五种写法都试过:双顶层 ✅ / TB 实例化 ❌ / glbl 编进别的库 ❌ / `+define+ONESPIN` ❌ /
   只加 `-L xpm` 单顶层 ❌。
6. **编译通过 ≠ 能仿真**。`vlog` 只查语法,**不解析模块引用**:库没挂时它也报 0 error,
   直到 `vsim`(elaborate)才说 `Module 'FDRE' is not defined`。判"库能不能用"必须跑到
   elaborate,不能看编译日志。

**XPM 宏同属这条路**:`xpm_fifo_*` / `xpm_cdc_*` / `xpm_memory_*` 在 **`xpm`** 库里 ——
`vlog -L xpm` / `vsim -L xpm`。本机的 `modelsim.ini`(**编译与运行都要**传给进程:`$env:MODELSIM_INI` 或 `.do` 里的 `INI_OVERRIDE`;路径见会话开头「本机 FPGA 工具链」的库映射项)
`[Library]` 段里**通常已经有** `xpm = <…>/xpm` 这条,指向一份**早先编译好的**库:`vmap xpm`
核一下,在就直接用,**不要重编**。

**XPM 比普通原语多一个要求:还要 `glbl`**(见上面第 5 条)。普通原语只要 `-L unisim`,
XPM 还要第二个顶层 `work.glbl`。

> **自带模板已处理**(2026-10-28):`modelsim_run.do` 的 `VENDOR_LIBS` 默认
> `{unisim unimacro}`、`GLBL_TOP` 默认 1 —— 会自动找 `glbl.v`、编进 `work/`、
> 并作为第二顶层传给 `vsim`。**不用手写这些**。
>
> 前提是能找到 `glbl.v`:设 `XILINX_VIVADO` 环境变量,或让 `modelsim.ini` 的库映射
> 指向 `vivado<ver>_lib` 那种固定布局(模板会从 ini 反推)。
> 找不到时日志打印 `glbl.v not found ... XPM macros will fail at elaboration` ——
> 看到这句先配 `XILINX_VIVADO`,不要去改 RTL。

只有"映射对、库也在、`glbl` 也配了、却仍报未定义"这种硬问题,才退到
**用原厂源码自己编一份** —— Vivado 安装目录 `data/ip/xpm/**` 下的 `.sv`
(或用它的 `compile_simlib`),编完在结论里写清用的是哪一份。
**这是退路,不是首选动作**。

**"库"和"映射"是两件事**:编译好的库是东西本身(每个库目录里有 ModelSim 的 `_info` 标记),
`modelsim.ini` 只是"名字 → 目录"的表;缺哪个都跑不起来,但**哪个都不该由本环节去重建**。
自己新编的库(`work`)默认就建在当前目录(而且 `work` 这一条也是可以在 ini 里被映射走的)——
**动手前先跑一次 `vmap work` 看它到底落在哪**,不要假定它在 `verif/work`。
