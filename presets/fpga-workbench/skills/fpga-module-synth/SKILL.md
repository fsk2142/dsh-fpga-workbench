---
name: fpga-module-synth
description: 综合 FPGA 模块并判定"综合门禁 + 综合后时序"能否通过时用:建模块工程、跑综合、解释综合报错、看资源占用与估时、判断综合后时序是否干净(constraint_status、missing_clock / unconstrained_path / no_clock 计数、CDC 计数)、解释 WNS/TNS 或"没有时钟"。支持探索性评估(只记录、不当门禁);模块级只到综合,布局布线与板级签核属工程级。
---

# module-synth:综合与综合后时序

本环节管两件事,**都通过才算这个环节过**:

1. **综合门禁**:代码能不能综合出来 —— 报错为零、资源与时钟报得出来
2. **综合后时序**:约束干不干净 —— `constraint_status`、时钟齐不齐、有没有未约束路径、跨时钟是否处理

模块级只到这里。**布局布线与真实板级时序属工程级**(`fpga-project-impl` / `fpga-project-timing`),
所以这里量的是 `analysis_stage = post_synth`(估计值),**不得说成"时序收敛了"**。

**两种用法,不得混为一谈:**

- **探索性评估**:只看资源量、能否收敛、某个写法合不合工具口味。随时可跑,不必等其他环节都出
  结论;结论只能算"估算",不得当作正式通过
- **正式结论**:要有完整成功报告;`synth/synth.md` 里那行 `结论:` 才算数

## 前置

1. 找约定文件 `.fpga-workbench.json`(模块根),见 `fpga-module-spec`
2. `spec/spec.md`:目标器件与封装(**未定即不得开综合**)、时钟与参考周期(来自指标)
3. 约束文件按模板写,放 `<模块根>/synth/<模块名>.xdc`(用 `module-synth-new.mjs` 起文件,见「本环节要跑的命令」)
4. **建议**机械检查(`rtl/lint.md`)与 `verif` 都已 PASS —— 没验证就综合,问题容易拖到时序才暴露;
   但正在定位综合报错、或用户只想要一次资源评估时,不必先回去补前面的环节

> ⚠️ **XDC 里不能写 Tcl 控制流**(`if` / `source` / `file` 这些)。
> XDC 会给一条 CRITICAL WARNING 然后**静默跳过**那条约束,最终现象是"没有时钟"或管脚没生效 ——
> 这个坑很难查,因为它不报错,只是没生效。

## 器件与参考时钟只写一处

一个模块只有**一处**器件与时钟参考来源 —— `spec/spec.md` 里这几条:

- 器件型号 + 器件族
- 分析参考周期(只是分析输入,**不是性能目标**)
- 每个时钟的参考周期 —— 时钟名必须与约束文件里的**完全一致**

换器件只改这一处,不要去改综合脚本;约束文件名与里面的时钟名也跟着这一处走。

## 约束只要时钟(模块级)

模块级没有管脚,所以这里**只写时钟约束**,其余都不属于本环节:

- **每个时钟域一条 `create_clock`**;分频/倍频出来的时钟另写 `create_generated_clock`
- 几个时钟之间没有真实时序关系时,加 `set_clock_groups -asynchronous` ——
  否则工具会把跨域路径算成未约束(判据要求 `unconstrained_path_count = 0`)
- **不写**:管脚分配、IO 标准与电平、input/output delay —— 那些是板子的事,
  在工程级 `fpga-project-constraints` 里
- 模块级 I/O 延迟不适用,判据里记 `MODULE_SCOPE_NOT_APPLICABLE`

## 本环节要跑的命令

**先起约束文件**(按模板复制,只替模块名):

```
node "<自带命令目录>\module\module-synth-new.mjs" <模块根> <模块名> --template "<约束模板路径>"
```

**再起综合脚本**(不用给模块名 —— 顶层模块名在脚本里,由脚本从 spec 填):

```
node "<自带命令目录>\module\module-synth-new.mjs" <模块根> <模块名> --kind synth-script
```

落 `<模块根>/synth/run_synth.tcl`,**器件型号与顶层模块名从 `spec/spec.md` 读出来填进那两行** ——
器件只写一处,别再手抄;spec 里读不到就不填(保留模板原样并提示),这时按 spec 手填那两行。
已存在不覆盖(`--force` 才覆盖);换自己的脚本用 `--template`。

**再跑综合**(全程批处理,不弹界面):

```powershell
& "<综合器路径>" -mode batch -source <综合脚本.tcl> -log <日志路径> -journal <记录路径>
```

- **`-mode batch` 必须加** —— 不加会拉起图形界面等人操作,无人值守就跑不下去
- **别手抄**:用上面那条 `--kind synth-script` 起一份,再按工程改(器件预检、失败判定都固化在里面了)
- 流程:建模块本地工程 → 加 `rtl/`(含 `rtl/ip/` 下的 IP 与 `.xci`)→ 跑 `synth_design` → 写报告
- 报告落 `<模块根>/synth/`;Vivado 工程与中间产物**就地落在 `synth/` 下**(可再生的,别提交),**不得把工程塞进 `rtl/`**

## 综合门禁的判据

- **PASS**:综合报错为零,资源占用与时钟都报得出来
- **FAIL**:综合报错(先看前 5 条,后面多半是级联出来的)
- **BLOCKED**:综合器没就绪(设置里标「未就绪」)/ 器件型号没填 / 没有可综合的源码
- **NOT_APPLICABLE**:这个模块不做综合

## 综合后时序的判据:不是"频率达标",是"约束干净"

接受条件只有三条:

1. `constraint_status = PASS` —— 约束确实被应用上了
2. 需要的时钟**都在**(缺一个都不行)
3. `missing_clock_count`、`unconstrained_path_count`、`no_clock_path_count` **全为 0**

`timing_exception_count` 记下来供后续查看;模块级 I/O 延迟属 `MODULE_SCOPE_NOT_APPLICABLE`。

**没有统一的 200 / 250 / 300 MHz 阈值。** 实测 Fmax 是**记录下来的观察值**,不是门禁 ——
因此不得为了让某个数字好看去改约束。

三种容易混的结果:

- **有合法时钟、但模块内部没有 setup 路径** → `NOT_APPLICABLE / no_internal_setup_path`。
  这属正常情况(纯组合或纯寄存直通的模块就是这样),不是失败
- **报 `no_clock`** → 多半是约束没被应用:先查 XDC 里有没有 Tcl 控制流;其次查时钟名是否与约束文件
  里的写法完全一致
- **`unconstrained_path_count > 0`** → 有路径没被约束。这算**失败**,不是提醒

CDC(跨时钟域):综合后跑 `report_cdc`,记下未解决跨时钟、不安全跨时钟、被豁免的跨时钟、时钟域数量。

- **当前不接受 CDC 豁免**:有 waived 计数也算失败
- 命令不可用 → 记 `BLOCKED`,不得当成"没有跨域"
- **CDC 永不降级成"提醒"** —— 跨域没处理就是没处理

## 策略要有界,不得无限重试

按轮数上限换策略(默认 3 轮):

```
default → AreaOptimized_high → AlternateRoutability → PerformanceOptimized → RuntimeOptimized
```

**每一轮都要留日志**,不得只留最后那轮 —— 否则"换策略试过"这句话没有证据。

## 产物

写 `<模块根>/synth/synth.md`(**本环节的结论行在这里**,它同时覆盖门禁与时序):

- 结论(`PASS` / `FAIL` / `BLOCKED` / `NOT_APPLICABLE`)+ 跑过的**命令原文**
- 器件型号、用的策略与轮数
- 资源占用(LUT / FF / BRAM / DSP)
- 综合后估计的 Fmax 与报出来的时钟

时序明细另写 `<模块根>/synth/timing.md`:时钟清单(名字、周期、是否被约束到)、WNS / TNS、
`unconstrained` / `no_clock` 计数、CDC 计数、违例路径简表(起点 → 终点 → 裕量;太长就挑最差的几条
并说明挑法)。

**时序不过时结论就是 FAIL**,不得只写"综合通过"把时序问题留在报告角落里。
**违例不达标时不得改约束去凑数字** —— 先判断是设计问题还是约束问题,并说清依据。