---
name: fpga-review
description: Use when reviewing a finished FPGA module before accepting it — checking RTL structure and naming, clock/reset and CDC handling, interface handshakes, design assertions, acceptance-criteria coverage, reference-model independence and timing constraints, then recording approved, changes requested or blocked. Also use when re-checking a module that was reviewed earlier, or when the user asks 审一下 / 复查这个模块.
---

# review:代码审查

## 什么时候审

只审**做完了**的模块:`lint`、`sim`、(有比对的)`comp`、(要综合的)`synth` 都已经出了结论。

有阶段还挂着 `BLOCKED`,或者干脆没有结论 → **先别审**。那不是审查能解决的问题,
是前置没满足 —— 如实说明并停下。

## 审什么(按顺序,别跳)

1. **对照规格**:`spec` 里的 AC 逐条问"这一条被谁证明了"。**指不到证据的 AC 就是没做**
2. **RTL 结构**:文件头与九个小节块、命名、复位极性、一个 always 块里有没有混放不相关的信号
3. **时钟与复位**:时钟域怎么划的、复位怎么释放、有跨域的地方有没有同步处理
   —— 跨域不是"看着没事"就算过
4. **接口**:握手是否成对(valid/ready)、反压时会不会丢数据、首尾边界怎么处理
5. **断言**:要紧的不变量有没有断言(不要求全都有)
6. **参考模型独立性**:有没有 import RTL 或实现细节、有没有直接返回输入
7. **约束**:时钟名与器件配置是否一致、有没有未约束的路径
8. **证据能复现**:每条结论能不能指到文件和行,跑过的命令原文在不在

## 怎么给结论

- **`approved`**:上面每一条都过了,没有未解释的 FAIL
- **`changes requested`**:有具体问题 —— **必须带定位(`文件:行`)和"改什么"**
- **`blocked`**:前置本身不成立(工具没就绪、证据缺失、规格自相矛盾)

**缺证据不等于通过。** 没跑过的检查写"未验证"并说清原因,不许当成过。
**审查的人不改代码**:发现问题记下来交回实现方 —— 自己顺手改会让"谁改的、改完还审不审"
说不清楚。

## 产物

写 `<阶段根>/review/review.md`:

- 结论(`approved` / `changes requested` / `blocked`)
- 逐条核对结果(上面八条,一条一行)
- 发现清单,每条:`id`、位置(`文件:行`)、问题、建议怎么改
- 未验证项及原因

发现要能一条条改掉。**不要写"整体感觉还行"** —— 那种结论没法执行,也没法复查。
