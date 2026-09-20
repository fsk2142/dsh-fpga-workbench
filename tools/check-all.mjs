// 源码自检的唯一入口 —— `npm test` 跑的就是它。
//
// 为什么要有这个东西:以前是"一条条手敲 node tools/check-*.mjs",于是漏掉了**退出码** ——
// 某个 check 打印完 `PASS` 之后又崩了(未导入的 readdirSync),而我只看输出里的 PASS 字样,
// 把退出码 1 当成了终端的假警报,结果这个缺陷在仓库里躺了好几轮。
// 教训:自检的结论必须由**退出码**决定,不能靠 grep 输出里的字样。这个文件就是干这个的。
//
// 两类检查分开:
//   · 源码级:只依赖本仓库 + Node,任何机器上都该跑(跑不了就是真问题)
//   · 环境级:依赖本机装好的 DSH(安装目录的 loader、profile 的 node_modules)
//     —— 缺环境记 SKIP 而不是 FAIL,否则换台机器就一片红,红了就没人看了
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const APP = "C:/Program Files/DSH Desktop/resources/app";

/** 源码级检查:不依赖本机 DSH 安装与 profile。 */
const SOURCE_CHECKS = [
  "check-toolchain.mjs",
  "check-fpga-tools.mjs",
  "check-patch-file.mjs"
];

/** 环境级检查:需要本机装好的 DSH(缺了就 SKIP)。 */
const HOST_CHECKS = [
  { file: "check-load-contract.mjs", needs: APP },
  { file: "check-preset-root.mjs", needs: APP },
  { file: "check-preset-sync.mjs", needs: APP }
];

/** 需要本机 profile(只在 --installed 时跑)。 */
const INSTALLED_CHECKS = ["check-installed.mjs", "smoke-installed.mjs"];

/** 依赖安装实测,要联网跑两次 pnpm,慢 —— 单独一个开关。 */
const SAFETY_CHECK = "check-install-safety.mjs";

const run = (file) => {
  const result = spawnSync(process.execPath, [join(TOOLS, file)], { stdio: "inherit" });
  return result.status === null ? 1 : result.status;
};

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    console.log(`源码级:${SOURCE_CHECKS.join(", ")}`);
    console.log(`环境级:${HOST_CHECKS.map((item) => item.file).join(", ")}`);
    console.log(`安装类(--installed):${INSTALLED_CHECKS.join(", ")}`);
    console.log(`安装安全(--safety,慢):${SAFETY_CHECK}`);
    return 0;
  }

  const withInstalled = argv.includes("--installed");
  const withSafety = argv.includes("--safety");
  const failures = [];
  const skipped = [];

  const plan = [
    ...SOURCE_CHECKS.map((file) => ({ file })),
    ...HOST_CHECKS,
    ...(withInstalled ? INSTALLED_CHECKS.map((file) => ({ file })) : [])
  ];

  for (const item of plan) {
    if (item.needs !== undefined && !existsSync(item.needs)) {
      console.log(`SKIP  ${item.file}(本机没有 ${item.needs})`);
      skipped.push(item.file);
      continue;
    }
    console.log(`\n=== ${item.file} ===`);
    const code = run(item.file);
    if (code !== 0) failures.push(`${item.file}(退出码 ${code})`);
  }

  if (withSafety) {
    console.log(`\n=== ${SAFETY_CHECK} ===`);
    const code = run(SAFETY_CHECK);
    if (code !== 0) failures.push(`${SAFETY_CHECK}(退出码 ${code})`);
  }

  console.log("\n" + "─".repeat(60));
  if (failures.length > 0) {
    console.log(`FAIL: ${failures.length} 项未通过 —— ${failures.join("、")}`);
    process.exitCode = 1;
    return 1;
  }
  const extra = skipped.length > 0 ? `;${skipped.length} 项因缺本机环境跳过` : "";
  console.log(`PASS: 源码自检全通过${extra}`);
  if (!withInstalled) console.log("(已装副本与安装实测未包含:分别用 --installed / --safety 打开)");
  return 0;
}

process.exitCode = main();
