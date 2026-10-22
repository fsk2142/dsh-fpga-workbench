// 实测 engines.dsh 各种无上界写法的真实行为（用宿主自带的 semver）。
//
// 背景：宿主 `app-boot` 的 `unmetRequirements()` 在 `engines.dsh` 存在时**只看它**，
// 不满足就把插件标记为 disabled → 界面空白，只有一行 stderr。
//
// 所以这个字段既要「当前宿主可用」，又要「宿主升级后不至于立刻失效」。
// semver 第 11 条（预发布版）让这件事不直观，必须实测。
const path = require("node:path");
// asar 路径经环境变量传入：用 `-e` 执行时 argv[1] 不是我们想要的。
const APP_DIR = process.env.DSH_APP_DIR ?? "";
if (APP_DIR === "") {
  console.error("需要 DSH_APP_DIR 指向 asar 内的 dsh 目录");
  process.exit(1);
}
const semver = require(path.join(APP_DIR, "node_modules", "semver"));

/** 需要覆盖的版本：当前宿主 + 历史 + 未来可能出现的。 */
const VERSIONS = [
  "0.1.7-rc.2",
  "0.2.0-rc.1",
  "0.2.0-rc.2",
  "0.2.1-rc.1",
  "0.2.1-rc.2",
  "0.2.2-rc.1",
  "0.2.1",
  "0.2.5",
  "0.3.0-rc.1",
  "0.3.0",
  "1.0.0"
];

const CANDIDATES = [
  "0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.2",
  ">=0.1.7-rc.2 || >=0.2.0-rc.1 || >=0.2.0-rc.2 || >=0.2.1-rc.2"
];

const width = 22;
const header = ["版本".padEnd(14), ...CANDIDATES.map((_, index) => `#${index + 1}`.padEnd(4))].join("");
console.log(header);
console.log("─".repeat(14 + CANDIDATES.length * 4));
for (const version of VERSIONS) {
  const cells = CANDIDATES.map((range) => (semver.satisfies(version, range) ? " ✓ " : " · "));
  const mark = version === "0.2.1-rc.2" ? " ← 当前宿主" : "";
  console.log(version.padEnd(14) + cells.join(" ") + mark);
}
console.log("");
CANDIDATES.forEach((range, index) => {
  const accepts = VERSIONS.filter((version) => semver.satisfies(version, range));
  console.log(`#${index + 1} ${JSON.stringify(range)}`);
  console.log(`   接受 ${String(accepts.length)}/${String(VERSIONS.length)}：${accepts.join(", ")}`);
});
