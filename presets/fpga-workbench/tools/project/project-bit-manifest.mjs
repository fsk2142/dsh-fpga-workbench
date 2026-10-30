#!/usr/bin/env node
/**
 * bitstream 来源清单：生成与校验（Q-07）。
 *
 * ## 为什么需要它
 *
 * 上板自检的 P0-4 原来只比**文件修改时间**：bit 比源码新就算"新鲜"。
 * 但时间证明不了来源 ——
 *
 * - 把另一版设计的旧 bit 复制过来，mtime 就变成"今天" → 假新鲜
 * - 同器件、不同设计版本的两份 bit，时间上分不开
 *
 * 真正要回答的是「**这份 bit 是由这份 RTL/XDC/IP 构建出来的吗**」。
 * 那需要构建时把身份记下来，只靠文件系统比不出来。
 *
 * ## 做什么
 *
 * 两个动作：
 *
 * | 动作 | 命令 | 时机 |
 * |---|---|---|
 * | **写** | `--write` | 出完 bit 之后，把身份写进 `bit/<顶层>.manifest.json` |
 * | **核** | 默认 | 上板前（P0-4）核对 manifest 与当前源码是否对得上 |
 *
 * manifest 内容：
 *
 * ```json
 * {
 *   "schema": 1,
 *   "top": "top",
 *   "part": "xc7a100tfgg484-2",
 *   "bit": { "file": "top.bit", "sha256": "...", "bytes": 1234567 },
 *   "inputs": { "sha256": "<所有源文件的合并摘要>", "files": 42 },
 *   "build": { "tool": "Vivado 2025.2", "runId": "impl_1", "at": "2026-10-30T..." },
 *   "commit": "abc1234"
 * }
 * ```
 *
 * 校验时重算 `inputs.sha256` 与 `bit.sha256`，两者都对上才算**来源一致**。
 *
 * ## 为什么是"合并摘要"而不是逐文件列表
 *
 * 逐文件列表会把 manifest 撑到几十 KB，而且换台机器路径就不同。
 * 这里用「按相对路径排序后拼接、再整体算一次 sha256」：
 * 内容或文件集合任何变化都会变，且与绝对路径无关。
 *
 * 用法：
 * ```
 * node project-bit-manifest.mjs <工程根> --write --top <顶层名> [--part <part>]
 * node project-bit-manifest.mjs <工程根> [--json]
 * ```
 *
 * 退出码：0 = 一致（或写入成功）；1 = 不一致；2 = 输入错误；3 = 缺 manifest（无法证明来源）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const MANIFEST_SCHEMA = 1;

/** 参与"源摘要"的目录与扩展名。只收**会影响 bitstream** 的东西。 */
const SOURCE_DIRS = ["src/rtl", "xdc", "ip"];
const SOURCE_EXTS = new Set([".sv", ".v", ".svh", ".vh", ".vhd", ".vhdl", ".xdc", ".tcl", ".xci", ".xcix"]);

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node project-bit-manifest.mjs <工程根> [--write] [--top <名>] [--part <part>] [--json]");
  write("");
  write("  默认：核对 bit/<顶层>.manifest.json 与当前源码是否一致。");
  write("  --write：出完 bit 之后写 manifest（把构建身份记下来）。");
  write("");
  write("  --top <名>    顶层名（写入时必填；校验时缺省则读 manifest 里的）");
  write("  --part <名>   器件型号（写入时可选，缺省读 doc/spec.md 或留空）");
  write("  --json        机器可读输出");
  write("");
  write("退出码：0 一致/写入成功；1 不一致；2 输入错误；3 缺 manifest（来源无法证明）。");
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = { root: "", write: false, top: "", part: "", json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    if (arg === "--top") {
      options.top = argv[++i] ?? "";
      continue;
    }
    if (arg === "--part") {
      options.part = argv[++i] ?? "";
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") usage(0);
    rest.push(arg);
  }
  options.root = rest[0] ?? "";
  return options;
};

/** 递归列文件（相对路径，正斜杠）。 */
const walk = (dir, base, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, base, out);
    else if (stat.isFile()) {
      if (SOURCE_EXTS.has(extname(name).toLowerCase())) {
        out.push(relative(base, full).replace(/\\/gu, "/"));
      }
    }
  }
  return out;
};

/**
 * 算"源摘要"。
 *
 * 顺序要紧：**按相对路径排序后拼接**，保证同一份源码在任何机器上得到同一个值。
 * 拼接格式 `路径\0内容\0` —— 用 NUL 分隔，避免路径与内容的边界被伪造混淆。
 *
 * @param root - 工程根。
 * @returns `{ sha256, files, list }`。
 */
const sourceDigest = (root) => {
  const files = [];
  for (const rel of SOURCE_DIRS) files.push(...walk(join(root, rel), root));
  files.sort();

  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    try {
      hash.update(readFileSync(join(root, rel)));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), files: files.length, list: files };
};

/** 算文件摘要。 */
const fileDigest = (path) => {
  try {
    const buf = readFileSync(path);
    return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  } catch {
    return undefined;
  }
};

/**
 * 从 `doc/spec.md` 里读器件型号（写入时缺 --part 的兜底）。
 * 读不到就留空 —— **不猜**。
 */
const partFromSpec = (root) => {
  for (const rel of ["doc/spec.md", "spec/spec.md"]) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    // 常见写法：`器件：xc7a100tfgg484-2` / `PART: xc7a100t...`
    const match = /(?:器件|part|PART|型号)\s*[:：]\s*`?([A-Za-z0-9][\w.+-]{4,})`?/u.exec(text);
    if (match !== null) return match[1];
  }
  return "";
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.root === "") usage();

  const root = resolve(options.root);
  if (!existsSync(root)) {
    console.error(`工程根不存在：${root}`);
    process.exit(2);
  }

  const bitDir = join(root, "bit");
  const digest = sourceDigest(root);

  // ── 写入模式 ──
  if (options.write) {
    if (options.top === "") {
      console.error("写入模式需要 --top <顶层名>（manifest 要按顶层名找 manifest 文件）。");
      process.exit(2);
    }
    const bitFile = join(bitDir, `${options.top}.bit`);
    if (!existsSync(bitFile)) {
      console.error(`找不到 bit：${bitFile}`);
      console.error("先把 bitstream 生成并拷进 bit/，再写 manifest —— 否则记的是假的来源。");
      process.exit(2);
    }

    const bitInfo = fileDigest(bitFile);
    const part = options.part !== "" ? options.part : partFromSpec(root);

    const manifest = {
      schema: MANIFEST_SCHEMA,
      top: options.top,
      part,
      bit: { file: `${options.top}.bit`, sha256: bitInfo?.sha256 ?? "", bytes: bitInfo?.bytes ?? 0 },
      inputs: { sha256: digest.sha256, files: digest.files },
      build: {
        tool: process.env.VIVADO_VERSION ?? "",
        runId: process.env.IMPL_RUN_ID ?? "",
        at: new Date().toISOString()
      }
    };

    const out = join(bitDir, `${options.top}.manifest.json`);
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (options.json) {
      console.log(JSON.stringify({ written: true, manifest: out, manifestBody: manifest }, null, 2));
    } else {
      console.log(`已写入：${out}`);
      console.log(`  顶层：${manifest.top}`);
      console.log(`  器件：${part === "" ? "(未填写 —— 建议用 --part 补上)" : part}`);
      console.log(`  bit  sha256：${manifest.bit.sha256.slice(0, 16)}…（${String(manifest.bit.bytes)} 字节）`);
      console.log(`  源摘要：${digest.sha256.slice(0, 16)}…（${String(digest.files)} 个文件）`);
      console.log("");
      console.log("注意：manifest 记录的是**写入这一刻**的源码状态。");
      console.log("      之后改任何 RTL/XDC/IP，校验都会报「来源不一致」——那正是它该做的事。");
    }
    return;
  }

  // ── 校验模式 ──
  const top = options.top;
  const candidates = top === ""
    ? readdirSync(existsSync(bitDir) ? bitDir : root)
        .filter((name) => name.endsWith(".manifest.json"))
        .map((name) => join(existsSync(bitDir) ? bitDir : root, name))
    : [join(bitDir, `${top}.manifest.json`)];

  const manifestPath = candidates[0];
  if (manifestPath === undefined || !existsSync(manifestPath)) {
    const message = [
      "缺 manifest：无法证明 bit 的来源",
      "",
      "时间检查只能说明「bit 文件比源码新」，证明不了「bit 由这份源码构建」。",
      "把另一版设计的旧 bit 复制过来，mtime 就变成今天 —— 时间上分不开。",
      "",
      "补法（出完 bit 之后跑一次）：",
      `  node project-bit-manifest.mjs <工程根> --write --top ${top === "" ? "<顶层名>" : top}`,
      "",
      "在此之前，P0-4 只能报「时间新鲜」，**不能报「来源一致」**。"
    ].join("\n");
    if (options.json) {
      console.log(JSON.stringify({ verdict: "UNVERIFIED", reason: "missing-manifest", hint: message }, null, 2));
    } else {
      console.log(message);
    }
    process.exit(3);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`manifest 读不了（${manifestPath}）：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  /** 逐项核对，收集不一致。 */
  const problems = [];

  if (manifest.schema !== MANIFEST_SCHEMA) {
    problems.push(`manifest schema 是 ${String(manifest.schema)}，本工具认 ${String(MANIFEST_SCHEMA)} —— 请重新生成`);
  }

  // ① bit 内容
  const bitPath = join(bitDir, manifest.bit?.file ?? "");
  const bitInfo = existsSync(bitPath) ? fileDigest(bitPath) : undefined;
  if (bitInfo === undefined) {
    problems.push(`bit 文件不在了：${bitPath}`);
  } else if (bitInfo.sha256 !== manifest.bit?.sha256) {
    problems.push(
      `bit 内容变了（manifest 记 ${String(manifest.bit?.sha256).slice(0, 12)}…，实际 ${bitInfo.sha256.slice(0, 12)}…）` +
        " —— 这份 bit 不是 manifest 记录的那份"
    );
  }

  // ② 源摘要
  if (digest.sha256 !== manifest.inputs?.sha256) {
    problems.push(
      `源码与 manifest 对不上（manifest 记 ${String(manifest.inputs?.sha256).slice(0, 12)}…，` +
        `现在 ${digest.sha256.slice(0, 12)}…，${String(digest.files)} 个文件）` +
        " —— 出完 bit 之后改过 RTL/XDC/IP"
    );
  }
  if (manifest.inputs?.files !== undefined && manifest.inputs.files !== digest.files) {
    problems.push(`源文件数变了（manifest 记 ${String(manifest.inputs.files)}，现在 ${String(digest.files)}）`);
  }

  const verdict = problems.length === 0 ? "PASS" : "FAIL";

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          verdict,
          manifest: manifestPath,
          top: manifest.top,
          part: manifest.part,
          bitSha256: bitInfo?.sha256,
          sourceSha256: digest.sha256,
          problems
        },
        null,
        2
      )
    );
  } else {
    console.log(`manifest：${manifestPath}`);
    console.log(`  顶层：${manifest.top ?? "(未记)"}   器件：${manifest.part === "" ? "(未记)" : (manifest.part ?? "(未记)")}`);
    console.log(`  写于：${manifest.build?.at ?? "(未记)"}${manifest.build?.tool === "" ? "" : `  工具：${manifest.build?.tool}`}`);
    console.log("");
    if (verdict === "PASS") {
      console.log("PASS：bit 内容与源摘要都和 manifest 一致 —— **来源一致**。");
      console.log("      这才叫「bit 是这份源码构建出来的」，时间新鲜只是必要条件。");
    } else {
      console.log(`FAIL：${String(problems.length)} 项对不上：`);
      for (const problem of problems) console.log(`  ✗ ${problem}`);
      console.log("");
      console.log("这份 bit **不能**当作当前源码的产物。要么重新构建，要么确认拿错了文件。");
    }
  }

  process.exit(verdict === "PASS" ? 0 : 1);
};

main();
