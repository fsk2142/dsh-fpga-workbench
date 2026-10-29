// 源码自检的唯一入口 —— `npm test` 跑的就是它。
//
// 为什么要有这个东西:以前是"一条条手敲 node tools/check-*.mjs",于是漏掉了**退出码** ——
// 某个 check 打印完 `PASS` 之后又崩了(未导入的 readdirSync),而我只看输出里的 PASS 字样,
// 把退出码 1 当成了终端的假警报,结果这个缺陷在仓库里躺了好几轮。
// 教训:自检的结论必须由**退出码**决定,不能靠 grep 输出里的字样。这个文件就是干这个的。
//
// 分层记账,收尾也分行说 —— 不然"npm test 绿了"很容易被概括成"已安装、已实测兼容",
// 而实际上有些层可能**根本没跑**:
//   · 源码检查:只依赖本仓库 + Node,任何机器上都该跑(跑不了就是真问题)
//   · 宿主检查:依赖本机装好的 DSH(安装目录的 loader 与 @deepseek-ai/* 包、profile 的 node_modules)
//     —— 缺环境记 SKIP 而不是 FAIL,否则换台机器就一片红,红了就没人看了
//   · 厂商工具检查(--vivado,按需):装了 Vivado 就真跑一次模块综合;没装时**由脚本自己**
//     打印 SKIP 并退 0 —— 摘要照实写"脚本内部 SKIP 不是通过",免得被读成"厂商工具验过了"
//   · 安装副本检查(--installed):profile 里那份已装副本与源是否逐字节一致、能否加载
//   · 真实客户端集成:目前**没有**自动化检查,永远记"未检",并在摘要里写清人工怎么检
// 任一层有跳过/未跑/未检,收尾就不准说"全部通过"。
import { spawnSync } from "./lib/spawn.mjs";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = dirname(fileURLToPath(import.meta.url));

// 宿主解析环境的选择规则(按优先级):
//   1. `DSH_APP_DIR` 显式指定 —— 尊重用户选择(版本没声明过也会跑,但结论要打折);
//   2. 官方桌面端 `%LOCALAPPDATA%\Programs\DeepSeek Harness` —— 用户实际在跑的宿主;
//   3. npm 全局 `@deepseek-ai/dsh` —— 本机实测可能是旧版本(0.1.1-rc.2);
//   4. 旧桌面版默认路径。
//
// 两条硬要求:
//   · 版本必须命中 dsh.compatibility.dshReleases —— 否则 `npm test` 会在旧运行时上
//     显示"宿主检查通过",版本一升级就漏检;
//   · 桌面端运行时装在 app.asar 里,普通 Node require 不了 —— 选中桌面端时改用它的
//     Electron 可执行文件(ELECTRON_RUN_AS_NODE=1)跑子检查,asar 内的 js-yaml /
//     cordis-plugin-include 就能正常解析。
const MANIFEST = JSON.parse(readFileSync(join(TOOLS, "..", "package.json"), "utf8"));
const COMPATIBLE_VERSIONS = new Set(Object.keys(MANIFEST.dsh?.compatibility?.dshReleases ?? {}));
const versionOf = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
};

/** 读 asar 里某个 package.json(普通 Node 直接读字节,不依赖 Electron)。 */
function asarJson(asarPath, entryPath) {
  let fd;
  try {
    fd = openSync(asarPath, "r");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const headerBytes = Buffer.alloc(headerSize);
    readSync(fd, headerBytes, 0, headerSize, 16);
    let node = JSON.parse(headerBytes.toString("utf8"));
    for (const segment of entryPath.split("/").filter(Boolean)) node = node?.files?.[segment];
    if (node === undefined || node.files !== undefined) return undefined;
    const offset = Number(node.offset);
    const bytes = Buffer.alloc(Number(node.size));
    // ASAR entry offsets are exact byte offsets from the end of the header. Entries are
    // concatenated and need not start on a four-byte boundary (the current host's dsh/package.json is one example).
    readSync(fd, bytes, 0, bytes.length, 16 + headerSize + offset);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 官方桌面端;存在时优先于 npm 全局安装。 */
const DESKTOP = (() => {
  if (process.env.LOCALAPPDATA === undefined) return undefined;
  const root = join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness");
  const exe = join(root, "DeepSeek Harness.exe");
  const asar = join(root, "resources", "app.asar");
  if (!existsSync(exe) || !existsSync(asar)) return undefined;
  return { exe, asar, dshDir: join(asar, "dsh"), version: asarJson(asar, "/dsh/package.json")?.version };
})();
const DESKTOP_PROBLEM =
  DESKTOP !== undefined && DESKTOP.version === undefined
    ? `检测到官方桌面端,但无法从 ${DESKTOP.asar} 读取内置 DSH 版本 —— 不允许静默跳过宿主检查`
    : undefined;

/** 把一个候选目录变成"用哪个版本、用哪个解释器跑"的描述。 */
const candidateOf = (dir) => {
  if (typeof dir !== "string" || dir === "") return undefined;
  const onDesktop = DESKTOP !== undefined && dir.startsWith(DESKTOP.asar);
  const version = onDesktop ? DESKTOP.version : versionOf(dir);
  return { dir, version, runner: onDesktop ? DESKTOP.exe : process.execPath, electron: onDesktop };
};

const CANDIDATES = [
  process.env.DSH_APP_DIR,
  DESKTOP?.dshDir,
  process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh"),
  "C:/Program Files/DSH Desktop/resources/app"
]
  .map(candidateOf)
  .filter((candidate) => candidate !== undefined && candidate.version !== undefined);

/** DSH_APP_DIR 是显式指定:给了就用它(哪怕版本没声明过),但结论要打折。 */
const EXPLICIT_HOST = CANDIDATES.find((candidate) => candidate.dir === process.env.DSH_APP_DIR);
/**
 * 显式指定却解析不出来 → **直接报错**,不许悄悄换宿主。
 *
 * 以前这里会退回自动探测:用户写了 `DSH_APP_DIR=<某个版本>` 却打错路径时,检查照跑、还全绿,
 * 而实际测的是另一个版本 —— 这种"看着测了指定版本"的假象比不跑更坏。
 */
const EXPLICIT_PROBLEM =
  process.env.DSH_APP_DIR === undefined || process.env.DSH_APP_DIR === ""
    ? undefined
    : EXPLICIT_HOST !== undefined
      ? undefined
      : (() => {
          const dir = String(process.env.DSH_APP_DIR);
          const why = existsSync(join(dir, "package.json"))
            ? "它的 package.json 读不出 version"
            : "这个目录下没有 package.json";
          return `DSH_APP_DIR 指向的目录用不了:${dir}(${why})—— 它可能不是 DSH 安装目录(桌面端在 asar 里,普通 Node 读不了)`;
        })();
/** 自动探测:只认兼容声明里列过的版本;候选顺序把桌面端排在 npm 全局之前。 */
const MATCHED_HOST = CANDIDATES.find((candidate) => COMPATIBLE_VERSIONS.has(candidate.version));
const HOST = EXPLICIT_HOST ?? MATCHED_HOST;
const APP = HOST?.dir ?? CANDIDATES[0]?.dir ?? "C:/Program Files/DSH Desktop/resources/app";

/** 宿主检查能不能跑;不能跑时给出原因(不假装通过)。 */
const HOST_SKIP =
  HOST !== undefined
    ? undefined
    : [
        `本机没有可解析、且版本命中兼容声明的宿主(声明:${[...COMPATIBLE_VERSIONS].join("、")})`,
        CANDIDATES.length === 0
          ? "一个候选目录都没找到"
          : `找到的候选:${CANDIDATES.map((candidate) => `${candidate.dir} → ${candidate.version}`).join(";")}`,
        "用 DSH_APP_DIR 指向要验证的 DSH 环境(桌面端在 asar 里,普通 Node 读不了)"
      ].join(";");
/** 显式指定的版本没在声明里:照跑,但提醒结论不能当"已验证版本"用。 */
const HOST_WARN =
  EXPLICIT_HOST !== undefined && !COMPATIBLE_VERSIONS.has(EXPLICIT_HOST.version)
    ? `注意:DSH_APP_DIR 指向的宿主版本 ${EXPLICIT_HOST.version} 不在兼容声明(${[...COMPATIBLE_VERSIONS].join("、")})里 —— 这次的宿主检查不能当作已验证版本的结论`
    : undefined;

/** 源码级检查:不依赖本机 DSH 安装与 profile。 */
const SOURCE_CHECKS = ["check-toolchain.mjs", "check-fpga-tools.mjs", "check-selfcheck.mjs", "check-mcp.mjs", "check-mcp-mount.mjs", "check-version.mjs", "check-install-hints.mjs", "check-skill-docs.mjs", "check-preset-duplicates.mjs", "check-docs.mjs", "check-package.mjs", "check-workflow.mjs", "check-load-safety.mjs", "check-privacy.mjs", "check-privacy-detail.mjs", "check-stale-comments.mjs", "check-redundancy.mjs", "check-real-load.mjs"];

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

/** 厂商工具真跑:默认**不跑**(要真起 Vivado,分钟级),用 `--vivado` / `npm run test:vivado` 打开;
 *  脚本自己在"没装工具"时记 SKIP(不是通过、也不算失败)。 */
const VENDOR_CHECKS = ["check-vivado.mjs"];

/** 依赖安装实测,要联网跑两次 pnpm,慢 —— 单独一个开关。 */
const SAFETY_CHECK = "check-install-safety.mjs";

/**
 * 第四层「真实客户端集成」没有自动化检查:本文件跑的每个子检查都在 Node 进程内
 * (加载契约、渲染冒烟、已装副本 import),没有一个真的起 DSH 客户端、真的走一次会话。
 * 所以它永远记「未检」,并把"人该怎么检"写在这里 —— 免得被读成"真实客户端已经实测过"。
 */
  // 第四轮 Q4-13:不做端到端框架,但把"人该怎么检"写成**可照着走的清单** ——
  // 免得"自检全绿"被读成"真机验收过了"。
  //
  // 逐版本的验证结果**不写进仓库**(那是内部台账,含作者环境与协作细节);
  // 对外只维护 `docs/COMPATIBILITY.md` 里的「已验证 / 未验证 / 已知限制」。
  const CLIENT_INTEGRATION_HOWTO = [
    "本自检不起真实客户端。发布前请手动走一遍下面的清单:",
    "  1) 重启 DSH Desktop(让已装副本生效)→ 新建会话选「FPGA 开发模式」",
    "  2) 设置页:字段能读能写、保存后重开仍在;工具路径显示正常",
    "  3) 会话提示:带上本机工具路径与「本模式自带的命令」(含 module-report-check.mjs / project-rtl-check.mjs)",
    "  4) 技能按需加载:让它读一个技能,内容与 presets/ 下的一致",
    "  5) 起文件:module-rtl-new / module-verif-new / module-synth-new 各跑一次,落点正确",
    "  6) 退出码与错误状态:故意让检查失败(删掉一个被引用的证据文件),确认退非零且点名",
    "  7) 有厂商工具时:综合与仿真各跑一次真实夹具；ModelSim / QuestaSim 依次执行 do run.do compile、do run.do run,不能用 Node 单测替代",
    "  8) 工程骨架:对一个空目录跑 setup-scaffold.mjs <目录> --kind project(目录本身就是工程根;三个 module-*-new.mjs 都不支持 --kind project),核对只生成 .fpga-workbench.json、AGENTS.fpga.md 与 doc/sch/prj/src/{rtl,sim}/ip/sim/xdc/bit"
  ].join("\n");

const run = (file) => {
  // 选中桌面端时用它的 Electron 当 Node(ELECTRON_RUN_AS_NODE),否则 asar 里的包解析不了。
  const result = spawnSync(HOST?.runner ?? process.execPath, [join(TOOLS, file)], {
    stdio: "inherit",
    // 子检查是独立进程:把上面解析好的宿主目录传下去,它们才和这里找的是**同一个**目录。
    env: {
      ...process.env,
      DSH_APP_DIR: APP,
      ...(HOST?.electron === true ? { ELECTRON_RUN_AS_NODE: "1" } : {})
    }
  });
  return result.status === null ? 1 : result.status;
};

/** 逐层记账:跑了几个、哪几个没过、哪几个因缺环境跳过(以及原因)。 */
const freshTier = () => ({ ran: 0, failed: [], skipped: [], skipReason: "" });

function main() {
  const argv = process.argv.slice(2);
  if (DESKTOP_PROBLEM !== undefined) {
    console.error(`FAIL  ${DESKTOP_PROBLEM}`);
    return 1;
  }
  // 显式指定的宿主用不了:立刻失败。继续跑只会测到别的版本,还让人以为测的是指定版本。
  if (EXPLICIT_PROBLEM !== undefined) {
    console.error(`FAIL  ${EXPLICIT_PROBLEM}`);
    console.error("      (去掉 DSH_APP_DIR 让它自动探测,或改成真正能解析的安装目录)");
    return 1;
  }
  if (argv.includes("--list")) {
    console.log(`源码检查:${SOURCE_CHECKS.join(", ")}`);
    console.log(`宿主检查(缺本机 DSH 就跳过):${HOST_CHECKS.map((item) => item.file).join(", ")}`);
    console.log(`厂商工具检查(--vivado,慢;没装工具时脚本内部 SKIP):${VENDOR_CHECKS.join(", ")}`);
    console.log(`安装副本检查(--installed):${INSTALLED_CHECKS.join(", ")}`);
    console.log(`安装实测(--safety,慢):${SAFETY_CHECK}`);
    return 0;
  }

  const withInstalled = argv.includes("--installed");
  const withSafety = argv.includes("--safety");
  const withVivado = argv.includes("--vivado");
  const failures = [];

  const tiers = {
    source: freshTier(),
    host: freshTier(),
    vendor: freshTier(),
    installed: freshTier(),
    safety: freshTier()
  };

  const plan = [
    ...SOURCE_CHECKS.map((file) => ({ file, tier: "source" })),
    ...HOST_CHECKS.map((item) => ({ ...item, tier: "host" })),
    ...(withVivado ? VENDOR_CHECKS.map((file) => ({ file, tier: "vendor" })) : []),
    ...(withInstalled ? INSTALLED_CHECKS.map((file) => ({ file, tier: "installed" })) : [])
  ];

  if (HOST !== undefined) {
    console.log(`宿主检查使用:${APP}(版本 ${HOST.version}${EXPLICIT_HOST === HOST ? ",DSH_APP_DIR 指定" : ""})`);
  }
  if (HOST_WARN !== undefined) console.log(`WARN  ${HOST_WARN}`);

  for (const item of plan) {
    if (item.tier === "host" && HOST_SKIP !== undefined) {
      console.log(`SKIP  ${item.file}(${HOST_SKIP})`);
      tiers[item.tier].skipped.push(item.file);
      tiers[item.tier].skipReason = HOST_SKIP;
      continue;
    }
    // HOST 已经验证过候选可用;asar 里的目录 existsSync 看不到,不能再按普通路径判存在。
    if (HOST === undefined && item.needs !== undefined && !existsSync(item.needs)) {
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
    withVivado
      ? `厂商工具检查(Vivado 真综合):已检 ${tiers.vendor.ran} 项 / ${skippedIn(tiers.vendor)}${failedIn(tiers.vendor)}` +
          "(脚本内部在没装工具时记 SKIP —— 那一行不是通过)"
      : "厂商工具检查:跳过(未加 --vivado;要跑用 npm run test:vivado)"
  );
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
  if (!withVivado) notRun.push("厂商工具检查未跑(--vivado)");
  if (!withSafety) notRun.push("安装实测未跑(--safety)");
  notRun.push("真实客户端集成未检");

  console.log(`PASS: 已跑的检查都通过 —— 但这不是「全部通过」:${notRun.join("、")}`);
  return 0;
}

process.exitCode = main();
