// 源码自检的唯一入口 —— `npm test` 跑的就是它。
//
// 为什么要有这个东西:以前是"一条条手敲 node tools/check-*.mjs",于是漏掉了**退出码** ——
// 某个 check 打印完 `PASS` 之后又崩了(未导入的 readdirSync),而我只看输出里的 PASS 字样,
// 把退出码 1 当成了终端的假警报,结果这个缺陷在仓库里躺了好几轮。
// 教训:自检的结论必须由**退出码**决定,不能靠 grep 输出里的字样。这个文件就是干这个的。
//
// 四层分开记,收尾也分四行说 —— 不然"npm test 绿了"很容易被概括成"已安装、已实测兼容",
// 而实际上后两层可能**根本没跑**:
//   · 源码检查:只依赖本仓库 + Node,任何机器上都该跑(跑不了就是真问题)
//   · 宿主检查:依赖本机装好的 DSH(安装目录的 loader 与 @deepseek-ai/* 包、profile 的 node_modules)
//     —— 缺环境记 SKIP 而不是 FAIL,否则换台机器就一片红,红了就没人看了
//   · 安装副本检查(--installed):profile 里那份已装副本与源是否逐字节一致、能否加载
//   · 真实客户端集成:目前**没有**自动化检查,永远记"未检",并在摘要里写清人工怎么检
// 任一层有跳过/未跑/未检,收尾就不准说"全部通过"。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = dirname(fileURLToPath(import.meta.url));

// 宿主解析环境:优先 `DSH_APP_DIR`;没给时按常见安装位置探测第一个真实存在的。
// 桌面预览版把代码装在 asar 里,而宿主检查要的是**能被 Node require 到 js-yaml /
// cordis-plugin-include 的目录**,所以 npm 全局装的 `@deepseek-ai/dsh` 也在候选里。
// 子检查是各自独立的 Node 进程,run() 会用同一个环境变量把它传下去。
const APP_CANDIDATES = [
  process.env.DSH_APP_DIR,
  process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh"),
  "C:/Program Files/DSH Desktop/resources/app"
].filter((candidate) => typeof candidate === "string" && candidate !== "");
const APP = APP_CANDIDATES.find((candidate) => existsSync(join(candidate, "package.json"))) ?? APP_CANDIDATES.at(-1);

/** 源码级检查:不依赖本机 DSH 安装与 profile。 */
const SOURCE_CHECKS = ["check-toolchain.mjs", "check-fpga-tools.mjs", "check-package.mjs"];

/** 环境级检查:需要本机装好的 DSH(缺了就 SKIP)。
 *  check-patch-file 用的是**宿主那份** js-yaml 与 cordis-plugin-include schema,
 *  所以它属于这一层:宿主不在时该记 SKIP,而不是让「源码检查」报 FAIL。 */
const HOST_CHECKS = [
  { file: "check-patch-file.mjs", needs: APP },
  { file: "check-load-contract.mjs", needs: APP },
  { file: "check-preset-root.mjs", needs: APP }
];

/** 需要本机 profile(只在 --installed 时跑)。 */
const INSTALLED_CHECKS = ["check-installed.mjs", "smoke-installed.mjs"];

/** 依赖安装实测,要联网跑两次 pnpm,慢 —— 单独一个开关。 */
const SAFETY_CHECK = "check-install-safety.mjs";

/**
 * 第四层「真实客户端集成」没有自动化检查:本文件跑的每个子检查都在 Node 进程内
 * (加载契约、渲染冒烟、已装副本 import),没有一个真的起 DSH 客户端、真的走一次会话。
 * 所以它永远记「未检」,并把"人该怎么检"写在这里 —— 免得被读成"真实客户端已经实测过"。
 */
  // 第四轮 Q4-13:不做端到端框架,但把"人该怎么检"写成**可照着走的清单**,并要求每次发布把结果
  // 记进 `docs/CLIENT_CHECKLIST.md`(填过的就替换掉 TODO)—— 免得"自检全绿"被读成"真机验收过了"。
  const CLIENT_INTEGRATION_HOWTO = [
    "本自检不起真实客户端。发布前请手动走一遍清单(逐条记结果;真机结果按版本记进 docs/CLIENT_CHECKLIST.md):",
    "  1) 重启 DSH Desktop(让已装副本生效)→ 新建会话选「FPGA 开发模式」",
    "  2) 设置页:字段能读能写、保存后重开仍在;工具路径显示正常",
    "  3) 会话提示:带上本机工具路径与「本模式自带的命令」(含 module-report-check.mjs / project-rtl-check.mjs)",
    "  4) 技能按需加载:让它读一个技能,内容与 presets/ 下的一致",
    "  5) 起文件:module-rtl-new / module-verif-new / module-synth-new 各跑一次,落点正确",
    "  6) 退出码与错误状态:故意让检查失败(删掉一个被引用的证据文件),确认退非零且点名",
    "  7) 有厂商工具时:综合与仿真各跑一次真实夹具；ModelSim / QuestaSim 先 compile.do 再 run.do,不能用 Node 单测替代",
    "  8) 工程骨架:对一个空目录跑 setup-scaffold.mjs <目录> --kind project(目录本身就是工程根;三个 module-*-new.mjs 都不支持 --kind project),核对只生成 .fpga-workbench.json、AGENTS.fpga.md 与 doc/sch/prj/src/{rtl,sim}/ip/sim/xdc/bit"
  ].join("\\n");

const run = (file) => {
  const result = spawnSync(process.execPath, [join(TOOLS, file)], {
    stdio: "inherit",
    // 子检查是独立进程:把上面解析好的宿主目录传下去,它们才和这里找的是**同一个**目录。
    env: { ...process.env, DSH_APP_DIR: APP }
  });
  return result.status === null ? 1 : result.status;
};

/** 逐层记账:跑了几个、哪几个没过、哪几个因缺环境跳过(以及原因)。 */
const freshTier = () => ({ ran: 0, failed: [], skipped: [], skipReason: "" });

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    console.log(`源码检查:${SOURCE_CHECKS.join(", ")}`);
    console.log(`宿主检查(缺本机 DSH 就跳过):${HOST_CHECKS.map((item) => item.file).join(", ")}`);
    console.log(`安装副本检查(--installed):${INSTALLED_CHECKS.join(", ")}`);
    console.log(`安装实测(--safety,慢):${SAFETY_CHECK}`);
    return 0;
  }

  const withInstalled = argv.includes("--installed");
  const withSafety = argv.includes("--safety");
  const failures = [];

  const tiers = {
    source: freshTier(),
    host: freshTier(),
    installed: freshTier(),
    safety: freshTier()
  };

  const plan = [
    ...SOURCE_CHECKS.map((file) => ({ file, tier: "source" })),
    ...HOST_CHECKS.map((item) => ({ ...item, tier: "host" })),
    ...(withInstalled ? INSTALLED_CHECKS.map((file) => ({ file, tier: "installed" })) : [])
  ];

  for (const item of plan) {
    if (item.needs !== undefined && !existsSync(item.needs)) {
      // 打印**实际找过的路径** —— 装到别处时这一行就是线索(README 那种换机器场景)。
      console.log(`SKIP  ${item.file}(宿主目录不存在:${item.needs};装在别处就用 DSH_APP_DIR 指过去)`);
      tiers[item.tier].skipped.push(item.file);
      tiers[item.tier].skipReason = `宿主目录不存在:${item.needs}`;
      continue;
    }
    console.log(`\n=== ${item.file} ===`);
    const code = run(item.file);
    tiers[item.tier].ran += 1;
    if (code !== 0) {
      failures.push(`${item.file}(退出码 ${code})`);
      tiers[item.tier].failed.push(item.file);
    }
  }

  if (withSafety) {
    console.log(`\n=== ${SAFETY_CHECK} ===`);
    const code = run(SAFETY_CHECK);
    tiers.safety.ran += 1;
    if (code !== 0) {
      failures.push(`${SAFETY_CHECK}(退出码 ${code})`);
      tiers.safety.failed.push(SAFETY_CHECK);
    }
  }

  console.log("\n" + "─".repeat(60));

  // 每层一行:说清"跑了几个、跳过几个、为什么跳过"。跳过与未跑都是**覆盖缺口** ——
  // 退出码 0 只代表"跑了的都过了",不代表没跑的也算过了。
  const failedIn = (tier) => (tier.failed.length === 0 ? "" : ` —— 未通过:${tier.failed.join("、")}`);
  const skippedIn = (tier) =>
    tier.skipped.length === 0
      ? "跳过 0 项"
      : `跳过 ${tier.skipped.length} 项(${tier.skipReason}:${tier.skipped.join("、")})`;

  console.log(
    `源码检查:${tiers.source.failed.length === 0 ? "通过" : "失败"}(已检 ${tiers.source.ran} 项)${failedIn(tiers.source)}`
  );
  console.log(`宿主检查:已检 ${tiers.host.ran} 项 / ${skippedIn(tiers.host)}${failedIn(tiers.host)}`);
  console.log(
    withInstalled
      ? `安装副本检查:已检 ${tiers.installed.ran} 项 / ${skippedIn(tiers.installed)}${failedIn(tiers.installed)}`
      : "安装副本检查:跳过(未加 --installed;打开用 npm run test:installed)"
  );
  console.log(`真实客户端集成:未检 —— ${CLIENT_INTEGRATION_HOWTO}`);
  if (withSafety) {
    console.log(
      `安装实测(--safety,要跑两次 pnpm):已检 ${tiers.safety.ran} 项 / ${skippedIn(tiers.safety)}${failedIn(tiers.safety)}`
    );
  }

  if (failures.length > 0) {
    console.log(`FAIL: ${failures.length} 项未通过 —— ${failures.join("、")}`);
    process.exitCode = 1;
    return 1;
  }

  // 到这里退出码是 0,但退出码 0 只说"跑了的都过了"。把没跑的列出来,免得被概括成
  // "全部通过"或"已安装、已实测兼容" —— 有跳过/未检时那句话就是错的。
  const notRun = [];
  for (const [label, tier] of [
    ["源码检查", tiers.source],
    ["宿主检查", tiers.host],
    ["安装副本检查", tiers.installed]
  ]) {
    if (tier.skipped.length > 0) notRun.push(`${label}跳过 ${tier.skipped.length} 项`);
  }
  if (!withInstalled) notRun.push("安装副本检查未跑(--installed)");
  if (!withSafety) notRun.push("安装实测未跑(--safety)");
  notRun.push("真实客户端集成未检");

  console.log(`PASS: 已跑的检查都通过 —— 但这不是「全部通过」:${notRun.join("、")}`);
  return 0;
}

process.exitCode = main();
