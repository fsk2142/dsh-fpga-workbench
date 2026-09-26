import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_FILES = ["README.md", "package.json", "cordis.patch.yml"];
const REQUIRED_PREFIXES = ["lib/", "presets/"];
const FORBIDDEN_PREFIXES = ["tools/"];

const npmExecPath = process.env.npm_execpath ?? (() => {
  if (process.platform !== "win32") return null;
  const found = spawnSync("where.exe", ["npm"], { encoding: "utf8", windowsHide: true });
  for (const line of `${found.stdout ?? ""}`.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const candidate = join(dirname(line), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) return candidate;
  }
  return null;
})();
const command = npmExecPath ? process.execPath : "npm";
const args = npmExecPath
  ? [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];
const result = spawnSync(command, args, {
  cwd: ROOT,
  encoding: "utf8",
  windowsHide: true
});

const failures = [];
const fail = (message) => failures.push(message);

if (result.error) {
  fail(`无法启动 npm pack:${result.error.message}`);
} else if (result.status !== 0) {
  fail(`npm pack 退出码 ${String(result.status)}`);
}

let files = [];
if (result.status === 0 && !result.error) {
  try {
    const report = JSON.parse(result.stdout);
    const pack = Array.isArray(report) ? report[0] : report;
    if (!Array.isArray(pack?.files)) throw new Error("npm pack 输出没有 files 数组");
    files = pack.files.map((entry) => String(entry.path).replaceAll("\\", "/"));
  } catch (error) {
    fail(`npm pack JSON 无法解析:${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const required of REQUIRED_FILES) {
  if (!files.includes(required)) fail(`缺少 ${required}`);
}
for (const prefix of REQUIRED_PREFIXES) {
  if (!files.some((file) => file.startsWith(prefix))) fail(`缺少 ${prefix} 内容`);
}
for (const prefix of FORBIDDEN_PREFIXES) {
  const leaked = files.filter((file) => file.startsWith(prefix));
  if (leaked.length > 0) fail(`包内混入开发目录 ${prefix}:${leaked.join("、")}`);
}

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL  ${message}`);
  if (result.stderr) console.error(String(result.stderr).trim());
  console.error(`\nFAIL (${failures.length}): npm 包内容不符合运行时最小清单`);
  process.exitCode = 1;
} else {
  console.log(`ok    npm pack --dry-run 包含运行时文件 (${files.length} 项)`);
  console.log(`ok    包含 ${REQUIRED_FILES.join("、")} 与 ${REQUIRED_PREFIXES.join("、")}`);
  console.log(`ok    不含 ${FORBIDDEN_PREFIXES.join("、")}`);
  console.log("\nPASS: npm 包内容检查通过");
}
