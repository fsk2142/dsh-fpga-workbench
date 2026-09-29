# IP / XPM 选型、归位与时序卡

### 需要 IP 核时:先定"用不用 IP",再问归位

**选型顺序(用户口径:能用原语 / XPM 就不用 IP 向导,能脚本化就不在界面上点)**:

1. **自己写**:逻辑简单(一个计数器、一个状态机、一段组合逻辑),或项目里已有同款写法(照它)→
   直接在 `rtl/` 里编写,不走厂商 IP 流程
2. **优先厂商原语 / XPM 参数化宏**(标准构件都属这一档:同步 FIFO、跨时钟 FIFO、CDC 同步器、
   存储器、时钟管理…):
   例:Vivado 的 `xpm_fifo_async` / `xpm_fifo_sync`、`xpm_cdc_single` / `xpm_cdc_gray`、
   `xpm_memory_*`,以及 `BUFG` / `FDRE` / `MMCME*_ADV` 这类原语。它们**直接就是 HDL**:
   可读、可 lint、可移植,**不生成 `.xci`、也不需要图形界面**(仿真侧的库映射见
   `fpga-module-verif` 的「厂商原语仿真」那节,先把 `modelsim.ini` 映射查对再改 RTL)
3. **确实没有等价原语的才用厂商 IP**(硬核与复杂协议:PCIe、DDR 控制器、以太网 MAC、GT 收发器…):
   到这一步才**先问用户** —— 该 IP 由本环节生成,还是由用户提供?不得自行假定,也不得另行实现一个绕过它
   - **由本环节生成** → **脚本化,不许只在图形界面点出来**:用工具生成(如 Vivado 的 `create_ip` +
     `generate_target`),**生成脚本与 `.xci` 一并入档**以保证可复现
     - **器件必须来自 `spec/spec.md`**:`create_ip` **不接受** `-part`(实测 Vivado 2025.2 报
       `Unknown option '-part'`)—— 器件是**工程的 part**:先生成工程(`create_project -part <spec 里的器件>`),
       再 `create_ip` + `generate_target all`。**别把别的器件下生成的 `.xci` 搬进来**:综合时 Vivado 会锁住
       那个 IP、报"模块找不到"这类看不出根因的错(实测踩过)。
     - **IP 一旦生成,器件就写死在 `.xci` 里**(`DEVICE` / `PACKAGE` / `SPEEDGRADE` 三个参数),
       所以**换器件必须重新 `generate_target`** —— 只改工程里的 `set PART` 解决不了。
     - `run_synth.tcl` 里那道 `.xci` 器件预检是**事后保险**;器件真正的唯一来源是 `spec/spec.md`。
   - **用户提供** → 按下面的规则归位,来源与版本写进 spec 的「参考资料」

**为什么把原语 / XPM 排在前面**:IP 向导产出的是 `.xci` 加一堆生成物 —— 界面上点出来的东西改不动、
跨工具与跨版本搬不走,还多一个"IP 与工程器件不同族、要到综合才炸"的坑(见 `run_synth.tcl` 的
`.xci` 器件预检)。原语 / XPM 是同一份可读源码,换器件、换版本照旧能读、能查、能仿真。

**这条例的是"新引 IP 时怎么挑",不是硬性禁令**:不许为了凑原语去重写用户已有的 IP、改掉已有工程里
已经用上的 IP,或把功能降级;确实做不到(没有等价原语、或原语不满足时序/资源要求)就照旧用 IP,
并把理由写进 spec 或 `rtl/lint.md`。

归位规则(生成完或拿到后按用途拆开):

- **仿真用的文件**(仿真模型、厂商仿真库、行为级模型)→ `verif/`
- **RTL 与综合用的部分**(RTL 封装 / wrapper、本环节编写的那部分、`.xci`)→ `rtl/ip/`

同一个 IP 可能同时出现在两处:`verif/` 放仿真模型,`rtl/ip/` 放综合用的实体。归位后在
`rtl/lint.md` 或 spec 里记一句走了哪条路(自建 / 用户提供),便于后续比对与上板核对型号与版本。

### IP 时序卡:`rtl/ip/<ip>/timing.json`(每个 IP 一张)

**厂商 IP 与 XPM 宏的时序前提是"量出来的",不是猜出来的** —— 换实现(比如厂商 FIFO 换成
`xpm_fifo_async`)、换配置、换器件时,延迟与复位行为都可能变,而调用它的 RTL 往往按那个数写死了
(实测:某模块 FIFO 读延迟从 k+2 变成 k+1,输出对齐器就会少一拍)。所以每个 IP 目录里都留一张卡:

- `timing.json` —— **实测**出来的前提:`config`(该 IP 的参数)、`read_latency`(读写延迟怎么算,
  用"第 k 拍采样 → 第 k+n 拍到 dout"这种**可复现的说法**)、`rst_busy_cycles`、`fwft`、
  `dout_reset_value`、`probe`(测它的探针文件路径)、`measured`(日期)、`notes`(为什么这些数
  重要、换哪个值会有什么后果 —— 写清"实测过什么、没测什么")
- `README.md` —— 这个目录里每个文件是什么、**为什么**要这么用、怎么重跑
- 探针(`probe_*.sv` + 日志)与 lint 用的黑盒 `*_stub.v` 一并留在该目录下

**只写测到的**:"没测"就明说没测,不填一个看起来合理但没量过的数 —— 下游(验证与工程级时序)按这张卡
干活,错一个数就是错一条链。`module-rtl-check.mjs` 会检查每个 `rtl/ip/<ip>/`:有没有这张卡、四栏
(`card` / `measured` / `probe` / `config`)齐不齐,**以及能不能复核** ——
`card` / `measured` / `probe` 必须是非空字符串、`config` 必须是非空对象、`probe` 指的探针**文件要真的在**
模块里、卡里至少要有**一个实测数值**(`config` 里的配置值不算)。缺了哪一项或 JSON 解析不了,
报**警告**(不拦门禁,但必须被看见)。

**谁来测、怎么测**:IP 放进 `rtl/ip/<ip>/` 之后,**派一个子代理专门去量**(只做这一件事:写探针 →
跑一遍 → 把结果填进 `timing.json`),不要一边写 RTL 一边猜延迟。做法(实测过的形状):

```systemverilog
// probe_<ip>.sv:黑盒例化被测量的宏 / IP,只喂激励,把 rd_en 与 dout 一起打进日志
`timescale 1ns/1ps
module probe_<ip>;
    logic clk = 0; always #5 clk = ~clk;
    // ...例化被测量对象(不写它的内部逻辑,只连端口)...
    // 激励:拉高读使能,打印每一拍的下标 + dout,数"第 k 拍采样 → 第 k+n 拍到数据"
endmodule
```

```powershell
# 两次独立调用 —— 不要在 .do 里再起一个 vsim(实测嵌套启动会撞 license)
vlog -quiet -sv -L xpm -work work probe_<ip>.sv
vsim -c -L xpm -l probe_<ip>.log -do "onfinish stop; run -all; quit -f" work.probe_<ip>
```

跑完把**实测拍数**(不是估的)写进卡;`README.md` 里写清每个文件是什么、怎么重跑。
