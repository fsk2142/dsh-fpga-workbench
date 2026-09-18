---
name: fpga-synth
description: Use when synthesizing an FPGA module with Vivado in batch mode — creating the module project, running synth_design, judging whether synthesis actually passed, or explaining synthesis errors, resource numbers and reported Fmax. Also use when a module's target device, part or synthesis strategy has to be decided or changed. Timing analysis of the report, implementation/bitstream and review have their own skills.
---

# synth:工程综合

## 前置

1. 找约定文件 `.fpga-workbench.json`(模块根),见 `fpga-spec`
2. `spec/spec.md` 里要有**目标器件与封装** —— 没定就别开综合
3. `lint` 必须 PASS;`sim` 应该是 PASS(没仿真就综合,等于把问题推到时序那一关才发现)
4. 约束文件按模板写(约束模板路径看会话开头那段「本机 FPGA 工具链」的模板那节)

> ⚠️ **XDC 里不能写 Tcl 控制流**(`if` / `source` / `file` 这些)。
> XDC 会给一条 CRITICAL WARNING 然后**静默跳过**那条约束,最终现象是"没有时钟"——
> 这个坑很难查,因为它不报错,只是没生效。

## 器件与参考时钟只写一处

一个模块只有**一个**器件与时钟参考的来源(你旧包里是 `device_config.tcl`):

- 器件型号 + 器件族
- 分析参考周期(只是分析输入,**不是性能目标**)
- 每个时钟的参考周期 —— 时钟名必须与约束文件里的**完全一致**

换器件只改这一处,不要去改综合脚本。

## 怎么跑(全程批处理,不弹界面)

```powershell
& "<vivadoPath>" -mode batch -source <综合脚本.tcl> -log <日志路径> -journal <记录路径>
```

- **`-mode batch` 必须加** —— 不加会拉起图形界面等人操作,无人值守就跑不下去
- 流程:建模块本地工程 → 加 `rtl/` 与 `ip/*.xci` → 跑 `synth_design` → 写报告
- 报告落 `<阶段根>/synth/`;Vivado 工程与中间产物落缓存目录,**不要把工程塞进源码目录**

## 策略要有界,不要无限重试

按轮数上限换策略(默认 3 轮):

```
default → AreaOptimized_high → AlternateRoutability → PerformanceOptimized → RuntimeOptimized
```

**每一轮都要留日志**,别只留最后那轮 —— 否则"换策略试过"这句话没有证据。

## 判据

- **PASS**:综合无 error,资源占用与时钟都报得出来
- **FAIL**:综合报 error(先看前 5 条,后面多半是级联出来的)
- **BLOCKED**:Vivado 没就绪(设置里标了「未就绪」)/ 器件型号没填 / 没有可综合的源码
- **NOT_APPLICABLE**:这个模块不做综合

**频率不是这一关的门禁。** 综合阶段只**记录实测结果**(策略名就叫 OBSERVE_ONLY):
没有"必须跑到 250MHz"这种统一阈值,也没有 200/300MHz 分档。频率是**观察值**,不是通过条件。

## 产物

写 `<阶段根>/synth/synth.md`:

- 结论 + 跑过的**命令原文**
- 器件型号、用的策略与轮数
- 资源占用(LUT / FF / BRAM / DSP)
- 综合后估计的 Fmax 与报出来的时钟
- error / warning 的处理;报告文件名写清(结论要能指回去)
