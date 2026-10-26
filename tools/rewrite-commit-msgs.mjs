#!/usr/bin/env node
// 把带过程性描述的提交信息改成「一句话标题 + 1-2 句正文」。
//
// 用法：node tools/rewrite-commit-msgs.mjs > /tmp/newmsg.txt
//       git filter-branch -f --msg-filter 'node tools/rewrite-commit-msgs.mjs' <range>
//
// 为什么要它：GitHub 文件树里鼠标悬停会显示「每个路径最后一次提交」的标题，
// 而仓库里有 23 条标题写着「第 N 轮审查」「N1/N2/H1/M1」「被某某教了三次」这类
// 开发过程，对读代码的人没有信息量。正文同样该是「改了什么、为什么」，不是过程流水。
//
// 判据：标题里出现审查编号 / 轮次 / 试错叙述 → 替换；其余提交原样返回。
import { readFileSync } from "node:fs";

/** 过程性描述的特征。 */
const PROCESS = /审查|轮|N\d|H\d|M\d|L\d|教了|踩|坑|试探|第三次|上一轮|review\d|E8|Q4|F-\d|复议/iu;

/**
 * 改写映射：旧标题（唯一子串）→ 新提交信息。
 *
 * 正文写「改了什么 / 为什么」，不写「第几轮」「谁教的」「试了几次」。
 */
const REWRITES = [
  [
    "修掉一处隐私泄漏 + 三处过期说明",
    `fix: 移除硬编码本机路径，修正三处过期说明

config 里用于定位 semver 的候选路径改从环境变量推导，不再写死用户目录。
README 与 CLIENT_CHECKLIST 的版本表述同步到当前的单一起点写法。`
  ],
  [
    "删掉 usagePath 里被否决版本的过时注释",
    `docs: 清理 usagePath 中与实现矛盾的注释

同一函数上叠了两段说明，前一段描述的方案已被否决，结论与最终实现相反。删掉旧的那段。`
  ],
  [
    "分隔符归一改为",
    `fix: 修正路径分隔符归一化，避免破坏转义序列

只把真正的路径分隔符换成斜杠，保留 \\n \\r \\t \\x 这类转义形态与真实控制字符。`
  ],
  [
    ".msg-ui.txt 的删除",
    `chore: 忽略提交信息草稿文件

.msg-* 是写提交信息时的临时产物，加进 .gitignore。`
  ],
  [
    "nodeLinker: hoisted",
    `deps: 固定 nodeLinker 为 hoisted

使用扁平化的 node_modules 布局，避免依赖链接方式受平台差异影响。`
  ],
  [
    "关掉 autoInstallPeers",
    `fix(lockfile): 关闭 autoInstallPeers 并重生成锁文件

避免 peer 依赖被自动安装进锁文件；锁文件从 1695 行降到 971 行。`
  ],
  [
    "删掉 action-setup 的 version",
    `fix(ci): 移除 action-setup 的 version 字段

它与 package.json 的 packageManager 同时存在时 pnpm/action-setup 会直接报错。
新增 check-workflow 守卫防止复发。`
  ],
  [
    "N1（CI 必红）",
    `fix: 修正 CI 配置与 file URL 形态

CI 工作流的版本声明冲突导致必红；安装脚本的 file URL 前缀写法不正确。`
  ],
  [
    "插件页配置的两个致命错误",
    `fix: 修正插件页配置的槽位注册

槽位 key 用包名而非 namespace；configForms 改为局部 inject，避免整个插件停在 pending。`
  ],
  [
    "插件页配置抄 dsh-safe-delete",
    `fix: 对齐插件页配置的注册写法

按 plugins.bundle.config 槽位的契约修正注册方式。`
  ],
  [
    "按 2026-10-22 审查报告修",
    `fix: 修正宿主侧接口与构建产物的若干缺陷

覆盖 .gitignore 完整性、lib 产物一致性、类型声明与测试夹具。`
  ],
  [
    "run.do 记录**编译配置身份**",
    `feat(sim): run.do 记录编译配置身份并在运行时比对

编译与运行使用同一份配置；不一致时明确报错而不是静默沿用旧库。`
  ],
  [
    "按审查报告收口",
    `feat(templates): 修正模板新鲜度判定与工程模式

.svh 纳入新鲜度检查；run.do 支持 load 模式；工程 impl/bitstream 改用 Project Mode。`
  ],
  [
    "collector 的**根目录自己**",
    `fix(collector): 根目录自身是符号链接时拒绝跟随

避免收集器越过工程边界读取链接目标之外的内容。`
  ],
  [
    "第九轮复审整改",
    `fix: 修正备份范围、混合语言判定与模板分层

备份只覆盖托管文件；模块级混合 VHDL 单独计口径；工程综合模板按级别分层。`
  ],
  [
    "第八轮复审整改",
    `fix: 预设同步改为 fail closed，递归不跟随链接目录

同步失败时中止而不是继续；混合 VHDL 不再计为全覆盖通过。`
  ],
  [
    "第四轮 Q4-01",
    `fix: 统一器件来源、事务回滚与路径边界判定

器件型号只保留一处权威来源；安装失败时完整回滚；路径越界一律拒绝。`
  ],
  [
    "按第三轮复审整改",
    `fix: 贯通器件唯一来源，安装器支持全路径回滚

证据检查器补齐边界判定，RTL 口径与文档对齐。`
  ],
  [
    "按第二轮复审整改",
    `fix: 修正安装安全、版本判定与路径可移植性

安装器不删除既有内容；版本判据区分「无更新」与「查不到」；分层目录可移植。`
  ],
  [
    "采纳审查里站得住的三条",
    `docs(skills): 补充验证手段、产物落点与输出护栏

技能文档写清三件事：怎么验证、产物放哪里、--out 参数如何限制。`
  ],
  [
    "环节目录按用户定的形态调整",
    `feat: 环节目录调整为 lint/ 改为 rtl/

报告与 RTL 同目录；审查改为按需执行，不单独占目录。`
  ],
  [
    "工程级一般都要上板",
    `docs: 明确工程级与模块级的完成判据

工程级通常都要上板部署；模块级审查通过即视为完成。`
  ],
  [
    "首次提交",
    `feat: 初始化 FPGA 开发模式插件

DSH agent 预设 + 工具链配置 + 自带命令。`
  ]
];

const original = readFileSync(0, "utf8");

// 只匹配标题（第一行），不看正文。
const firstLineEnd = original.indexOf("\n");
const firstLine = firstLineEnd < 0 ? original : original.slice(0, firstLineEnd);

if (!PROCESS.test(firstLine)) {
  process.stdout.write(original);
  process.exit(0);
}

for (const [needle, replacement] of REWRITES) {
  if (firstLine.includes(needle)) {
    process.stdout.write(`${replacement.trim()}\n`);
    process.exit(0);
  }
}

// 命中特征但没在映射表里 —— 原样返回，让人工再看（不静默丢弃信息）。
process.stdout.write(original);
