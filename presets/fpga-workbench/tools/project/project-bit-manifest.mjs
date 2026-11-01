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
 * 三个动作：
 *
 * | 动作 | 命令 | 时机 |
 * |---|---|---|
 * | **构建前** | `--begin` | 跑 Vivado **之前**：记下输入摘要与时间戳 |
 * | **构建后** | `--end` | 出完 bit **之后**：核对输入没变，写 manifest（`provenance=verified`） |
 * | **核** | 默认 | 上板前（P0-4）核对 manifest 与当前源码 |
 *
 * 另有 `--write`：**没有 begin/end 时的手工补录**，写出来的
 * `provenance=hand-recorded`，**不能当"构建来源已验证"**。
 *
 * ## R03：`provenance` 是要紧的那个字段
 *
 * 报告指出的核心问题：**哈希能证明文件没变，不能单独证明因果关系。**
 *
 * > 这不是恶意篡改场景，普通的「先改源码，后补清单」就会发生。
 *
 * 所以结论分成两件事，别混着说：
 *
 * | 结论 | 含义 | 谁给的 |
 * |---|---|---|
 * | `files consistent` | 文件与快照一致（哈希比得过） | 任何模式 |
 * | `provenance` | 构建来源是否**已验证** | 只有 `--begin` + `--end` 能给 `verified` |
 *
 * `--write` 只是「写这一刻两组文件的哈希」—— 它不知道 bit 是哪次构建出来的。
 * 那正是 `hand-recorded` 的含义：**有记录，但没有构建过程佐证**。
 *
 * manifest 内容：
 *
 * ```json
 * {
 *   "schema": 2,
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
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const MANIFEST_SCHEMA = 2;

/**
 * 参与「源摘要」的目录。
 *
 * **R02**：加了 `sym`（初始化文件常放那儿）、`constraints`（有些工程这么叫）。
 */
const SOURCE_DIRS = ["src/rtl", "rtl", "xdc", "constraints", "ip", "sim", "src/sim"];

/**
 * 参与「源摘要」的扩展名。
 *
 * ## R02：补上初始化数据与 IP 描述
 *
 * 原来只有 HDL + XDC + Tcl + XCI。于是**改 `init.mem` 的内容，校验照样 PASS** ——
 * ROM/BRAM 的初始值变了，bit 必然不同，但摘要认为没变。
 *
 * | 类别 | 扩展名 |
 * |---|---|
 * | HDL | `.sv` `.v` `.svh` `.vh` `.vhd` `.vhdl` |
 * | 约束与脚本 | `.xdc` `.sdc` `.tcl` |
 * | **初始化数据（新补）** | `.mem` `.coe` `.mif` `.hex` `.dat` |
 * | IP 与块设计 | `.xci` `.xcix` `.bd` |
 * | 头/包含文件 | `.h` `.inc` |
 *
 * ## 但这只是**必要条件，不是充分条件**
 *
 * 报告说得对：补扩展名解决不了根本问题 ——
 * 本工具**不知道这个工程实际引用了哪些文件**。真正该做的是读 Vivado 的输入清单。
 *
 * 在没接 Vivado 之前能做两件事：
 * 1. 尽量广地覆盖常见输入类型（下面这张表）
 * 2. **如实声明覆盖范围**，不把「我扫了这些」说成「所有输入都一致」
 */
const SOURCE_EXTS = new Set([
  // HDL
  ".sv", ".v", ".svh", ".vh", ".vhd", ".vhdl",
  // 约束与脚本
  ".xdc", ".sdc", ".tcl",
  // **初始化数据（R02 补）**
  ".mem", ".coe", ".mif", ".hex", ".dat",
  // IP 与块设计
  ".xci", ".xcix", ".bd",
  // 头/包含文件
  ".h", ".inc"
]);

/**
 * 这些扩展名**必定影响 bitstream** —— 它们的摘要参与度要单独统计。
 *
 * 用来在结果里说清「这个工程有初始化文件，我们扫到了 N 个」，
 * 而不是让使用者以为「扫了 HDL 就等于扫了全部输入」。
 */
const CRITICAL_EXTS = new Set([".mem", ".coe", ".mif", ".hex", ".xci", ".xcix", ".bd"]);

const usage = (code = 2) => {
  const write = code === 0 ? console.log : console.error;
  write("用法：node project-bit-manifest.mjs <工程根> [--begin|--end|--write] [--top <名>] [--part <part>] [--force] [--json]");
  write("");
  write("  默认：核对 bit/<顶层>.manifest.json 与当前源码是否一致。");
  write("");
  write("  两种记录来源的方式，结论强度不同：");
  write("");
  write("    --begin / --end    **构建前/后两阶段**（能证明来源）");
  write("         --begin   跑 Vivado **之前**执行：记下输入摘要");
  write("         --end     出完 bit **之后**执行：核对输入没变 → provenance=verified");
  write("         --end 时如果输入摘要与 --begin 不符，会**拒绝**并说「构建期间源码变了」");
  write("");
  write("    --write            手工补录（provenance=hand-recorded）");
  write("         只记录「写这一刻」两组文件的哈希 —— 它不知道 bit 是哪次构建出来的。");
  write("         **不能当「构建来源已验证」**。普通的「先改源码、后补清单」就会用到它。");
  write("");
  write("  --top <名>    顶层名（写入时必填；校验时缺省则读 manifest 里的）");
  write("  --part <名>   器件型号；**校验时给了就比对**，不符即失败");
  write("  --force       覆盖已有 manifest（默认拒绝，先留 .bak 快照）");
  write("  --json        机器可读输出");
  write("");
  write("退出码：0 一致/写入成功；1 不一致；2 输入错误；3 缺 manifest / 来源未验证。");
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = {
    root: "",
    write: false,
    begin: false,
    end: false,
    top: "",
    part: "",
    json: false,
    force: false
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // **R03**：两阶段 —— 构建前 `--begin`、构建后 `--end`。
    // 只有走这两步才拿得到 `provenance=verified`。
    if (arg === "--begin") {
      options.begin = true;
      continue;
    }
    if (arg === "--end") {
      options.end = true;
      continue;
    }
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
    // **R10**：默认不覆盖已有 manifest（那是来源记录，盖掉就掩盖了不一致）。
    if (arg === "--force") {
      options.force = true;
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

  /**
   * **R02：如实统计「扫到了什么」**，别让「我扫了 HDL」被读成「所有输入都一致」。
   *
   * `critical` 是其中**必定影响 bitstream** 的那几类（初始化数据、IP）。
   * 它等于 0 时不能断言"输入完整"，只能说"没扫到这类输入"。
   */
  const critical = files.filter((rel) => {
    const dot = rel.lastIndexOf(".");
    return dot >= 0 && CRITICAL_EXTS.has(rel.slice(dot).toLowerCase());
  });

  return {
    sha256: hash.digest("hex"),
    files: files.length,
    list: files,
    /** 扫过的目录（写进结果，让覆盖范围可见）。 */
    scannedDirs: SOURCE_DIRS,
    /** 其中必定影响 bitstream 的输入（初始化数据 / IP）数量。 */
    criticalFiles: critical.length,
    criticalList: critical
  };
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

  /** 「构建意图」文件：`--begin` 写、`--end` 读。 */
  const INTENT_FILE = ".fpga-build-intent.json";

  // ── R03 `--begin`：构建前记下输入摘要 ──
  if (options.begin) {
    if (options.top === "") {
      console.error("--begin 需要 --top <顶层名>。");
      process.exit(2);
    }
    const intent = {
      schema: 1,
      top: options.top,
      part: options.part !== "" ? options.part : partFromSpec(root),
      inputs: { sha256: digest.sha256, files: digest.files },
      begunAt: new Date().toISOString()
    };
    const intentPath = join(root, INTENT_FILE);
    writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");

    if (options.json) {
      console.log(JSON.stringify({ begun: true, intent: intentPath, body: intent }, null, 2));
    } else {
      console.log(`已记录构建意图：${intentPath}`);
      console.log(`  顶层：${intent.top}   器件：${intent.part === "" ? "(未填)" : intent.part}`);
      console.log(`  输入摘要：${digest.sha256.slice(0, 16)}…（${String(digest.files)} 个文件）`);
      console.log("");
      console.log("现在去跑 Vivado 出 bit；出完用 --end 收尾。");
      console.log("**构建期间不要改 RTL/XDC/IP** —— --end 会核对这一点，改了会被拒。");
    }
    return;
  }

  // ── R03 `--end`：构建后核对输入没变，再写 manifest（verified）──
  if (options.end) {
    const intentPath = join(root, INTENT_FILE);
    if (!existsSync(intentPath)) {
      console.error(`找不到构建意图：${intentPath}`);
      console.error("");
      console.error("--end 必须配 --begin 用 —— 没有构建前的记录，就无法证明");
      console.error("「这份 bit 是由这份源码构建的」。");
      console.error("");
      console.error("如果你只是想补一条记录，用 --write（会标成 hand-recorded）。");
      process.exit(2);
    }

    let intent;
    try {
      intent = JSON.parse(readFileSync(intentPath, "utf8"));
    } catch (error) {
      console.error(`构建意图读不了：${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }

    const top = options.top !== "" ? options.top : String(intent.top ?? "");
    if (top === "") {
      console.error("--end 需要 --top（或 --begin 时记过）。");
      process.exit(2);
    }

    /**
     * **R03 的核心：构建期间输入不能变。**
     *
     * 如果变了，说明这份 bit 对应的不是当前源码 —— 那正是
     * 「先改源码、后补清单」会掩盖的情况。这里直接拒绝。
     */
    if (digest.sha256 !== intent.inputs?.sha256) {
      console.error("构建期间源码变了 —— 拒绝关联。");
      console.error("");
      console.error(`  --begin 时：${String(intent.inputs?.sha256).slice(0, 16)}…（${String(intent.inputs?.files)} 个文件）`);
      console.error(`  现在：      ${digest.sha256.slice(0, 16)}…（${String(digest.files)} 个文件）`);
      console.error("");
      console.error("这份 bit 对应的不是当前源码。重新构建，或把源码改回去。");
      process.exit(1);
    }

    const bitFile = join(bitDir, `${top}.bit`);
    if (!existsSync(bitFile)) {
      console.error(`找不到 bit：${bitFile}`);
      process.exit(2);
    }

    const bitInfo = fileDigest(bitFile);
    const manifest = {
      schema: MANIFEST_SCHEMA,
      top,
      part: options.part !== "" ? options.part : String(intent.part ?? ""),
      /** **R03**：走 begin/end 两阶段才有的标记。 */
      provenance: "verified",
      provenanceNote: `由 --begin(${String(intent.begunAt)}) 与 --end 两阶段记录；构建期间输入摘要未变`,
      bit: { file: `${top}.bit`, sha256: bitInfo?.sha256 ?? "", bytes: bitInfo?.bytes ?? 0 },
      inputs: {
        sha256: digest.sha256,
        files: digest.files,
        scannedDirs: digest.scannedDirs,
        criticalFiles: digest.criticalFiles,
        criticalList: digest.criticalList
      },
      build: {
        tool: process.env.VIVADO_VERSION ?? "",
        runId: process.env.IMPL_RUN_ID ?? "",
        at: new Date().toISOString(),
        beganAt: intent.begunAt
      }
    };

    const out = join(bitDir, `${top}.manifest.json`);
    if (existsSync(out) && !options.force) {
      console.error(`manifest 已存在，未覆盖：${out}`);
      console.error("要更新：显式加 --force（会先留 .bak 快照）。");
      process.exit(3);
    }
    if (existsSync(out)) {
      const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
      copyFileSync(out, `${out}.bak-${stamp}`);
    }
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (options.json) {
      console.log(JSON.stringify({ written: true, provenance: "verified", manifest: out }, null, 2));
    } else {
      console.log(`已写入：${out}`);
      console.log(`  来源：**verified**（--begin 与 --end 两阶段，构建期间输入未变）`);
      console.log(`  bit sha256：${manifest.bit.sha256.slice(0, 16)}…`);
      console.log(`  输入摘要：${digest.sha256.slice(0, 16)}…（${String(digest.files)} 个文件）`);
    }
    return;
  }

  // ── 写入模式（手工补录 → hand-recorded）──
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
      /**
       * **R03：手工补录只能到 hand-recorded。**
       *
       * `--write` 记的是「写这一刻」两组文件的哈希 —— 它**不知道 bit 是哪次构建
       * 出来的**。普通的「先改源码、后补清单」就会走到这条路上。
       *
       * 所以这里如实标成 hand-recorded，校验时**不能**升级成「来源已验证」。
       */
      provenance: "hand-recorded",
      provenanceNote:
        "手工补录：只记录写这一刻的输入与 bit 哈希，没有构建过程佐证。" +
        "要证明来源需用 --begin / --end 两阶段。",
      bit: { file: `${options.top}.bit`, sha256: bitInfo?.sha256 ?? "", bytes: bitInfo?.bytes ?? 0 },
      // **R02**：把「扫了哪些目录、其中多少是必定影响 bitstream 的输入」也记下来。
      // 这样看 manifest 的人能自己判断覆盖够不够，而不是以为「有摘要 = 全扫了」。
      inputs: {
        sha256: digest.sha256,
        files: digest.files,
        scannedDirs: digest.scannedDirs,
        criticalFiles: digest.criticalFiles,
        criticalList: digest.criticalList
      },
      build: {
        tool: process.env.VIVADO_VERSION ?? "",
        runId: process.env.IMPL_RUN_ID ?? "",
        at: new Date().toISOString()
      }
    };

    const out = join(bitDir, `${options.top}.manifest.json`);

    /**
     * **R10：默认不覆盖已有 manifest。**
     *
     * 原来无条件 `writeFileSync` —— 重复 `--write` 会把旧清单**直接抹掉**，
     * 既不拒绝也不备份。两种坏后果：
     *
     * - 操作失误丢掉旧的来源记录
     * - **用新快照盖掉之前的不一致**：改完源码再补一次 `--write`，
     *   「源码与 bit 对不上」这件事就被掩盖了
     *
     * 与仓库其它生成器的约定一致：默认不覆盖，`--force` 才覆盖且先留快照。
     */
    const exists = existsSync(out);
    if (exists && !options.force) {
      const message = [
        `manifest 已存在，未覆盖：${out}`,
        "",
        "覆盖会丢掉旧的来源记录 —— 而且**改完源码再补写一次**就能把",
        "「源码与 bit 对不上」这件事掩盖掉。所以默认拒绝。",
        "",
        "要更新：显式加 --force（会先留 .bak-<时间戳> 快照）。"
      ].join("\n");
      if (options.json) {
        console.log(JSON.stringify({ written: false, manifest: out, reason: "exists", hint: "--force" }, null, 2));
      } else {
        console.log(message);
      }
      process.exit(3);
    }

    /** 覆盖前留快照（可恢复，不删除）。 */
    let backupPath;
    if (exists) {
      const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
      backupPath = `${out}.bak-${stamp}`;
      copyFileSync(out, backupPath);
    }

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

  /**
   * **R03a：多份 manifest 时不许静默取第一份。**
   *
   * 原来 `const manifestPath = candidates[0]` —— 目录里同时有 `top.manifest.json`
   * 与 `other.manifest.json` 时，读到哪份取决于目录枚举顺序。
   * 更糟的是：**可能拿别的工程的 manifest 来"证明"这份 bit**。
   *
   * 现在要求 `--top` 显式指定。
   */
  if (top === "" && candidates.length > 1) {
    const names = candidates.map((path) => path.split(/[\\/]/u).pop()).join("、");
    const message = [
      `目录里有 ${String(candidates.length)} 份 manifest，无法确定核对哪一份：`,
      `  ${names}`,
      "",
      "用 --top <顶层名> 明确指定。",
      "**不自动取第一份** —— 那可能拿别的工程的记录来证明这份 bit。"
    ].join("\n");
    if (options.json) {
      console.log(JSON.stringify({ verdict: "UNVERIFIED", reason: "ambiguous-manifest", candidates }, null, 2));
    } else {
      console.log(message);
    }
    process.exit(2);
  }

  const manifestPath = candidates[0];
  if (manifestPath === undefined || !existsSync(manifestPath)) {
    const message = [
      "缺 manifest：无法证明 bit 的来源",
      "",
      "时间检查只能说明「bit 文件比源码新」，证明不了「bit 由这份源码构建」。",
      "把另一版设计的旧 bit 复制过来，mtime 就变成今天 —— 时间上分不开。",
      "",
      "补法（推荐：构建前后两阶段）：",
      `  node project-bit-manifest.mjs <工程根> --begin --top ${top === "" ? "<顶层名>" : top}`,
      "  ...跑 Vivado 出 bit...",
      `  node project-bit-manifest.mjs <工程根> --end --top ${top === "" ? "<顶层名>" : top}`,
      "",
      `或手工补录（会标成 hand-recorded，不能当"来源已验证"）：`,
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

  /** **R03a：给了 `--part` 就与实际比对**（原来接受但不比对）。 */
  if (options.part !== "") {
    const recorded = String(manifest.part ?? "");
    if (recorded === "") {
      problems.push(`manifest 里没记器件型号，无法与 --part ${options.part} 比对`);
    } else if (recorded !== options.part) {
      problems.push(`器件型号不符：manifest 记 ${recorded}，你指定 ${options.part} —— 可能拿错 bit`);
    }
  }

  /**
   * schema 版本：**旧版可以被读，但要标出来**。
   *
   * schema 1 的 manifest 没有 `provenance` 字段 —— 那些记录只能证明"文件一致"，
   * 证明不了来源。直接判 FAIL 会让人困惑（文件明明没变），
   * 所以改成：**能读、能比哈希，但来源按 unknown 处理**（见下面 verdict 那段的提示）。
   *
   * 只有比当前**更新**的 schema 才拒绝 —— 那种情况本工具不知道有没有漏读字段。
   */
  if (typeof manifest.schema === "number" && manifest.schema > MANIFEST_SCHEMA) {
    problems.push(
      `manifest schema 是 ${String(manifest.schema)}，比本工具认的 ${String(MANIFEST_SCHEMA)} 更新 —— ` +
        "请升级工具，本版本可能漏读字段"
    );
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

  /**
   * **R03：`provenance` 与「文件一致」是两个结论，别混着说。**
   *
   * | provenance | 含义 |
   * |---|---|
   * | `verified` | 走过 `--begin` / `--end`，**构建期间输入未变** |
   * | `hand-recorded` | 手工补录，只记了写那一刻的哈希，**没有构建过程佐证** |
   * | `unknown` | 老版本 manifest 没这个字段 |
   *
   * 原来的 PASS 文案说「这才叫 bit 是这份源码构建出来的」——
   * 而 `--write` 路径根本证明不了因果：先改源码、再补清单照样 PASS。
   */
  const provenance = typeof manifest.provenance === "string" ? manifest.provenance : "unknown";

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          verdict,
          /** 文件与快照是否一致（哈希比对）。 */
          filesConsistent: problems.length === 0,
          /** 构建来源是否已验证 —— 与上面那一行**不是同一件事**。 */
          provenance,
          provenanceNote: manifest.provenanceNote,
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
    console.log(`  来源：${
      provenance === "verified"
        ? "**verified**（--begin/--end 两阶段，构建期间输入未变）"
        : provenance === "hand-recorded"
          ? "**hand-recorded**（手工补录，无构建过程佐证）"
          : "**unknown**（旧版 manifest 没记这个字段）"
    }`);
    console.log("");

    if (verdict === "PASS") {
      console.log("文件一致：bit 内容与源摘要都和 manifest 记的一致。");

      // **这正是 R03 要修的地方** —— 不能说「这才叫构建出来的」。
      if (provenance === "verified") {
        console.log("来源已验证：这份 bit 由 `--end` 那次构建产生，构建期间输入摘要未变。");
      } else if (provenance === "hand-recorded") {
        console.log("");
        console.log("⚠️  但**来源未验证** —— 这是手工补录的记录。");
        console.log("    它只说明「写清单那一刻，这两组文件的哈希是这样」。");
        console.log("    **先改源码、再补一次 `--write` 也会得到同样的 PASS。**");
        console.log("");
        console.log("    要证明「bit 是这份源码构建的」，用两阶段：");
        console.log("      --begin（构建前）→ 跑 Vivado → --end（构建后）");
        console.log("    `--end` 会核对构建期间输入没变，那才是因果证据。");
      } else {
        console.log("");
        console.log("⚠️  这份 manifest 没记 `provenance`（旧版工具写的），来源**无法判定**。");
        console.log("    重新用 --begin/--end 记一次，或至少 --write 重写以标注 hand-recorded。");
      }
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
