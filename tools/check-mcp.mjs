// Vivado MCP 接入层的判定自检 —— `npm test` 的一部分,**不需要**装 Vivado、也不需要那个 exe。
//
// 为什么单独一条:接入逻辑里有三处最容易错、而且错了**不会报错**的地方:
//   1. 设置字段名写错(for=key 对不上)→ 用户填了路径也读不出来,静默不生效;
//   2. 传给 mcp-client 的配置形状不对(缺 transport/command)→ 挂载时抛,但被 catch 吞掉;
//   3. 挂在了插件行而不是模式行 → 普通会话也会看到一组 Vivado 工具。
// 这三条都能用纯静态 + 纯函数的办法钉死,不需要任何厂商工具。
//
// 真机连通性(真的把 exe 拉起来、真的注册出 11 个工具)不在这里 —— 那需要用户自己
// 下载的那个二进制,属于「有则跑、无则 SKIP」的那一档,见文件末尾。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_PATH_KEY, MCP_SERVER_NAME, inspectMcpPath, mcpConfigFor, mcpPathProblem } from "../lib/mcp.js";
import { FIELDS } from "../lib/toolchain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${detail}`}`);
  if (!ok) failures.push(label);
};

// ── 一、设置字段 ─────────────────────────────────────────────────────────────

const field = FIELDS.find((item) => item.key === MCP_PATH_KEY);
check(field !== undefined, `FIELDS 里有 ${MCP_PATH_KEY} 字段(否则用户填了也读不出来)`);
if (field !== undefined) {
  check(field.control === "text", `设置页控件是文本框(实际 ${String(field.control)})`);
  check(field.kind === "file", `路径类型是文件而不是目录(实际 ${String(field.kind)})`);
  check(field.required === false, "该字段是可选的(不填不影响其它功能)");
  check(
    typeof field.hint === "string" && field.hint.includes("LICENSE"),
    "字段说明里点明了「需自行下载并遵守其 LICENSE」—— 许可证边界要写在使用处"
  );
  check(
    typeof field.blankNote === "string" && field.blankNote.includes("不影响"),
    `留空时的提示说明不影响其它功能(实际 ${String(field.blankNote)})`
  );
}

// ── 二、路径判定(纯函数,拿假路径打靶)────────────────────────────────────────

{
  const empty = inspectMcpPath("");
  check(empty.ok === false && empty.reason === "未设置", `空路径 → 未设置(实际 ${empty.reason})`);

  const blank = inspectMcpPath("   ");
  check(blank.ok === false && blank.reason === "未设置", "只填空白字符也按未设置处理");

  const missing = inspectMcpPath(join(ROOT, ".tmp", "definitely-not-here-12345", "x.exe"));
  check(missing.ok === false && missing.reason === "路径不存在", `不存在的路径 → 路径不存在(实际 ${missing.reason})`);

  // 目录不是可执行文件:这条防的是"把安装目录填进文件字段"
  const dir = inspectMcpPath(ROOT);
  check(dir.ok === false && dir.reason === "不是文件", `目录 → 不是文件(实际 ${dir.reason})`);

  // 存在的普通文件 → 通过(用 package.json 当夹具,不依赖任何厂商工具)
  const real = inspectMcpPath(join(ROOT, "package.json"));
  check(real.ok === true, `存在的文件 → 通过(实际 ${real.reason || "ok"})`);
}

// ── 三、mcpPathProblem:自检里"填了但文件不在"要报出来 ───────────────────────

{
  check(mcpPathProblem("") === undefined, "未设置时不算问题(不打扰用户)");
  check(mcpPathProblem(join(ROOT, "package.json")) === undefined, "路径可用时不算问题");
  const problem = mcpPathProblem(join(ROOT, ".tmp", "nope", "x.exe"));
  check(problem === "路径不存在", `填了但不存在 → 报出原因(实际 ${String(problem)})`);
}

// ── 四、传给 mcp-client 的配置形状 ───────────────────────────────────────────

{
  const config = mcpConfigFor("C:/tools/vivado-mcp-server.exe");
  check(config.transport === "stdio", `transport 是 stdio(实际 ${String(config.transport)})`);
  check(config.serverName === MCP_SERVER_NAME, `serverName 固定为 ${MCP_SERVER_NAME}(工具名前缀依赖它)`);
  check(
    /^[A-Za-z0-9_-]{1,32}$/u.test(MCP_SERVER_NAME),
    `serverName 符合 mcp-client 的命名约束(实际 ${MCP_SERVER_NAME})`
  );
  check(config.command === "C:/tools/vivado-mcp-server.exe", "command 用的是用户填的路径");
  check(
    Array.isArray(config.args) && config.args.includes("--stdio"),
    "--stdio 必须显式传:不带这个参数服务器会去起 HTTP 服务,而不是我们需要的由宿主拉起的形态"
  );
  check(config.failOnStartupError === false, "启动失败不拒绝插件激活(用户可能先填路径后装 Vivado)");
  check(
    Number.isFinite(config.toolCallTimeoutMs) && config.toolCallTimeoutMs >= 60_000,
    `单次工具调用超时不低于 60s(实际 ${String(config.toolCallTimeoutMs)})`
  );
  check(
    config.reconnect !== undefined && config.reconnect.enabled === true,
    "开启了自动重连(服务器崩了不会让这组工具永久消失)"
  );
}

// ── 五、挂载位置:必须挂在**模式行**,不能挂在插件行 ─────────────────────────
//
// 挂到插件行(lib/index.js)会变成全局:普通会话也会看到一组 Vivado 工具,
// 与"不影响正常会话"的设计冲突。这条用源码断言钉死。

{
  const modeSource = readFileSync(join(ROOT, "lib", "mode.js"), "utf8");
  const indexSource = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  check(modeSource.includes("syncMcpClient"), "模式行(mode.js)是挂载 MCP 的地方");
  check(!indexSource.includes("syncMcpClient"), "插件行(index.js)不挂 MCP —— 否则普通会话也会看到");
  check(
    !indexSource.includes("@deepseek-ai/dsh-mcp-client") && !indexSource.includes("./mcp.js"),
    "插件行完全不引用 MCP 接入层"
  );
}

// ── 六、许可证边界:仓库里不许出现那个二进制 ─────────────────────────────────
//
// AMD 的 LICENSE 第 3.2 条禁止向第三方分发。这条断言盯的是"别再手滑提交进来"。

{
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  check(
    /vivado-plugin\//u.test(gitignore),
    ".gitignore 忽略了 vivado-plugin/(用户自己放的二进制目录)"
  );
  check(/vivado-mcp-server-\*\.exe/u.test(gitignore), ".gitignore 忽略了 vivado-mcp-server-*.exe");
  check(/\.vsix/u.test(gitignore), ".gitignore 忽略了 .vsix(AMD 扩展包)");

  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  check(
    !files.some((entry) => /vivado-plugin|\.exe$|\.vsix$/u.test(entry)),
    "发布包 files 白名单不含任何 AMD 二进制"
  );
}

// ── 七、真机连通性:有那个 exe 就实测,没有就如实记 SKIP ──────────────────────

{
  const configured = process.env.VIVADO_MCP_EXE ?? "";
  const candidate = configured !== ""
    ? configured
    : join(ROOT, "vivado-plugin", "vivado-mcp-server-windows-amd64-2026.9.1.exe");
  const inspection = inspectMcpPath(candidate);
  if (!inspection.ok) {
    // **不是通过**:如实说明这一项没跑,别让 SKIP 看起来像绿的。
    console.log(
      `SKIP  真机连通性(Vivado MCP 可执行文件不在:${inspection.reason})` +
        `\n        要跑这条:设 VIVADO_MCP_EXE 指向你从 AMD 下载的那个 exe`
    );
  } else if (existsSync(candidate)) {
    console.log(
      `      真机连通性:发现 ${candidate}\n` +
        `      这一层要真的拉起服务器才会产生证据,不在本脚本里做 ——` +
        `\n      手工验证:node .tmp/probe-dsh-mcp-client.mjs(需要桌面端 Electron)`
    );
  }
}

console.log(
  failures.length > 0
    ? `\nFAIL (${String(failures.length)}): ${failures.join(" | ")}`
    : "\nPASS: Vivado MCP 接入层的字段/判定/配置/挂载位置与许可证边界都成立"
);
if (failures.length > 0) process.exitCode = 1;
