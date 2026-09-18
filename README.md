# dsh-fpga-workbench

**一个 DSH 的 FPGA 工作模式。**

它只做一件事:往 DSH 的 agent 预设名单里加一个「**FPGA 开发模式**」,于是新建会话时能和
`标准 / 极简 / PTC / 创造` 并列地选它。选中后,这个会话就带着 FPGA 的人设与工具。

**它不注册任何 UI。** 没有侧边栏入口、没有面板、没有替换任何官方组件——你现有的界面
一行都不动。

## 安装

```powershell
# 从工作区(开发时用)
dsh plugin --profile desktop add file:C:\Work\dsh-fpga-workbench
```

装完**重启 DSH Desktop**,新建会话时预设选择器里就会出现「FPGA 开发模式」。

> 刷新安装用 `node C:\Work\dsh-fpga-workbench\tools\install.mjs`(先校验、不一致才重装、
> 并逐字节校验结果)。**必须在你自己的终端里跑** —— 受限沙箱里 pnpm 无法在 profile
> 目录建临时文件。

## 它由什么组成

```
package.json                只有 dsh.bundle.patch,没有 main / exports / dsh.client
cordis.patch.yml            唯一一条:覆盖 agent-presets 的 roots
presets/fpga-workbench/
    preset.yml              选择器里显示的名字与描述
    agent.cordis.yml        这个模式的组装:人设 + 工具行
```

`lib/` 已经被删掉了。这里没有客户端半侧、没有宿主入口 —— 纯模式插件不挂载任何东西。

## 两条必须知道的约束

**一、`files` 白名单必须包含 `presets`。**

pnpm 安装 `file:` 依赖时按 `files` 打包,白名单外的东西**不会被拷进 profile**。踩过这个坑:
`presets/` 没写进 `files` → 安装副本缺预设目录 → 补丁里的 roots 指向空目录 →
**预设列表里永远看不到这个模式,而且没有任何报错**。
`tools/check-installed.mjs` 会断言这条。

**二、覆盖 `agent-presets` 必须重述要保留的字段。**

按 id 定位的 patch 不做深度合并,会**替换整份 config**。所以 `default` /
`includeShippedRoot` / `includeUserRoot` 都必须重述——漏掉 `includeShippedRoot`
会让 `标准 / 极简 / PTC / 创造` 那些官方预设**整个消失**。
`tools/check-preset-root.mjs` 用宿主同一个 loader 的求值器把 `!!js` 算出来,断言
路径真实存在、预设结构合法、字段重述完整。

## 自检

```powershell
node tools/check-preset-root.mjs   # !!js 路径求值 + 预设结构 + 字段重述
node tools/check-patch-file.mjs    # 补丁字节是合法 UTF-8,且形状是纯模式插件该有的
node tools/check-installed.mjs     # 已装副本与源逐字节一致 + files 白名单覆盖预设
```

前两个写死了本机路径(`C:/Program Files/DSH Desktop`、`~/.dsh/profiles/desktop`),
换机器要改;`check-installed.mjs` 支持 `DSH_PROFILE_DIR` 覆盖。

## 现状与下一步

- ✅ 模式本身可用:预设随插件走,选择器里可选
- ⬜ 预设内容:目前人设是 FPGA 模块开发的口径,**工具集仍是 `standard` 那一套**
- ⬜ engine 接入:把旧工具包的脚本(`run_auto.py` / `checks.py` / `submit_review.py`)
  变成这个模式可以调用的能力
- ⬜ 技能(DSH skill):FPGA 流程、RTL/测试平台规范、评审细则

## 关于界面(已放弃的方案,留作记录)

早期版本尝试过在 UI 上加东西:侧边栏入口行、主区域面板、甚至替换官方会话区。
结论:

- **入口行 / 面板**能做,但对"FPGA 工作模式"这个目标来说是多余的
- **替换官方会话区**做过一版,实机效果远不如官方(要追上得复刻它的 CSS 与交互),
  而且必然改掉官方列表的样子 —— 已回退
- **替换整个侧边栏**机制上做不到:声明一个已被声明的子槽会直接抛错
  (`slot "x" is already declared`),那个错发生在插件加载阶段,**会让桌面端起不来**

那些实现都在 git 历史里(`b3781ff` 是替换版,`7560643` 是回退)。
