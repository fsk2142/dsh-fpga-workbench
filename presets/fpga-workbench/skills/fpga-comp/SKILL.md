---
name: fpga-comp
description: Use when verifying an FPGA module against a reference model or golden data — writing the independent reference model, running the sample-by-sample or pixel-by-pixel comparison, deciding whether a mismatch means the RTL is wrong, or working out why the comparison is blocked. Covers the three comparison formats, reference-model independence, and how to attribute mismatches. Comparison is its own stage; functional simulation, synthesis, timing and review have their own skills.
---

# comp:算法验证(与参考模型比对)

## 前置

1. 找约定文件 `.fpga-workbench.json`(模块根),见 `fpga-spec`
2. `spec/spec.md` 里必须有三件:**比对输入路径、输出路径、格式**
3. `sim/sim.md` 是 PASS —— 先让自己的仿真过,再谈跟参考模型比
4. spec 里三件都写 `none` → 本阶段是 **NOT_APPLICABLE**,如实记下。**不要硬造一个比对**

## 参考模型必须独立(这一阶段唯一的硬要求)

- **不许** import RTL、仿真输出、生成的 IP,或任何实现细节
- 从 spec 描述的行为写起,不是从 RTL 抄起 —— 抄 RTL 的模型只能证明"它等于它自己"
- 跑之前先自查两条:模型**不能改写输入样本**;**不能把输入直接当输出返回**
- 参考模型模板里 `predict` 不改就是 `NotImplementedError`,那是**故意的**:宁可比对被挡住,
  也不要拿输入当期望、然后报"通过"

## 三种比对格式

| 格式 | 期望值谁出 | 用在 |
|---|---|---|
| `hex_words` | 通用整数词比对器 | 逐拍 / 逐字的整数流 |
| `text_exact` / `binary_exact` | 参考模型实现 `build_expected_bytes` | 文本或二进制逐字节 |
| `custom` | 模块自己的比对器 | 上面都不合适 |

## 跑法

1. 跑仿真,产出 DUT 输出文件(路径与格式**照 spec**,不要自己改名字或后缀)
2. 参考模型按同一批输入算出期望
3. 逐词 / 逐字节比对;**不一致的位置全部列出**,不要只报第一个
4. 有差异 → 先判归属,再动东西

## 差异归属(最容易出错的地方)

- 差在**固定偏移或固定拍数** → 多半是流水线延迟没对齐,不是逻辑错
- 只差开头或结尾几拍 → 复位没放干净、使能或首尾握手
- 整体差一倍、或位宽对不上 → 格式或符号位的问题
- 模型改写了输入、或直接返回输入 → **独立性问题**,先修模型,别的都别谈
- 全部一致但**样本数为 0** → 根本没比上,别当通过

## 判据

- **PASS**:样本数 > 0,不一致数为 0
- **FAIL**:存在不一致(给数量与位置)
- **BLOCKED**:参考模型没实现(`NotImplementedError`)、输入文件缺失、输出文件没生成
- **NOT_APPLICABLE**:spec 声明无文件比对

## 产物

写 `<阶段根>/comp/comp.md`:结论 + 输入/输出/格式 + 样本数 + 不一致数与位置 + 归属判断 +
参考模型版本。差异多时附一小段前后对比(头几个不一致的上下文)。

**别把"参考模型这么算"写成"RTL 是对的"。** 两边不一致时,两边都可能错 —— 结论要写清你
凭什么判断是哪边。
