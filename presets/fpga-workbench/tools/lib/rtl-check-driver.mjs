// 两个 RTL 检查器(module-rtl-check / project-rtl-check)共用的**稳定 primitives**。
//
// 为什么不做成"一个万能 driver"(复核 2026-09-25 的结论):module 与 project 的 target 构造、
// 角色区分(`sim-support`)、coverage 口径、JSON 顶层键(`module:` / `project:`)、summary 文案
// 与退出码判定都不一样 —— 全塞进一个参数对象只会把语义藏进一堆 option/callback。所以这里**只放
// 逐字相同、或只差"路径前缀 + 模块/工程两个字"的那几块**:
//   · SKIP_DIRS / MEASURED_FIELDS:两份曾各写一份,改一处就漂
//   · collectHdl / isFailure:逐字相同
//   · IP 时序卡校验:同一套判据(栏目齐不齐 / 值合不合法 / 探针在不在根内 / 有没有**可识别的**
//     实测字段),只在"模块根/工程根"与"格式见哪份技能"上不同
//   · printEntryLines:逐条 ok/FAIL 的打印骨架
// 各自保留在入口里:扫哪些目录、角色怎么分、coverage 怎么算、JSON 怎么拼、summary 与退出码。
//
// **输出必须逐字不变**是被钉着的,不是靠眼看:tools/check-fpga-tools.mjs 对两种模式各有多条断言
// (PASS / FAIL / 缺 rtl/ / 纯 VHDL / partial coverage / IP 卡 / sim-support / JSON 字段 /
//  退出码 0-1-2),任何一条变化都会红。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { evidenceFileInside } from "./stamp.mjs";
import { WARN_ONLY } from "./rtl-check-rules.mjs";

/**
 * 与旧包一致的跳过目录:生成物、仿真库、版本控制等。
 *
 * `ip` 是刻意加的:外来代码(厂商 IP、他人提供的模块)放在 `ip/` 下,它们不按本工程的格式
 * 规范书写(文件头、九个小节块、断言都不是厂商的写法)。不跳过就会成片误报,而"为让检查过就
 * 重排厂商代码"是绝对不能做的事。检查器只管**自有代码**。
 */
export const SKIP_DIRS = new Set([
  "history", ".xil", ".git", "__pycache__", "work", "_synth_gate", "_ip_gen",
  "synth_gate.gen", ".srcs", ".runs", ".hw", ".ip_user_files", ".sim", ".cache",
  ".nano", "rerun", "node_modules", "ip"
]);

/**
 * IP 时序卡里**可识别的测量字段**白名单(第四轮 Q4-12)。
 *
 * 为什么要有它:判据原来是"除 `config` 外存在任意 number" → `{"dummy": 1}` 也算过。那只能证明
 * **结构完整**,证明不了"测过"。这里按现役卡的实际字段收敛(延迟/占用拍/边界/跨口正确性几类),
 * 值还要合法(有限、非负)。脚本不假装懂物理意义 —— 最终"这个数是不是真测出来的"由 agent 查日志或重跑判定。
 */
export const MEASURED_FIELDS = [
  "read_latency", "read_latency_a", "read_latency_b", "write_latency", "pop_latency", "push_latency",
  "addr_to_dout_edges", "addr_to_doutb_edges", "push_to_dout", "rd_en_to_next", "empty_lag",
  "rst_busy_cycles", "cross_port_correct", "underflow_seen", "overflow_seen", "fwft", "dout_reset_value"
];

/**
 * 递归收集 HDL 源文件。
 * @param dir - 起始目录。
 * @param pattern - 文件名匹配(默认 SystemVerilog / Verilog;另用它来找 VHDL)。
 * @returns 文件绝对路径列表(已排序)。
 */
export function collectHdl(dir, pattern = /\.(sv|v)$/iu) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        if (SKIP_DIRS.has(name) || name.endsWith("_prj") || name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * 一条问题是否阻塞门禁。
 * @param issue - `checkFile` 的产出。
 * @returns 是 FAIL 时为 true。
 */
export const isFailure = (issue) => !WARN_ONLY.has(issue.rule);

/**
 * 一个 IP 目录的时序卡(见 `fpga-module-rtl` / `fpga-project-rtl` 的「IP 时序卡」)。
 *
 * 卡是"给人看的前提"(实测出来的读/写延迟、复位占用拍、配置、探针),**缺了不拦门禁** ——
 * 所以它是警告;但它必须被看见:换实现/换器件时读的正是这张卡(实测踩过:FIFO 从厂商 IP 换成
 * XPM 宏,读延迟从 k+2 变 k+1,输出对齐器会少一拍)。只认 `timing.json` 这个名字。
 * @param {{shownDir:string, ipDir:string, name:string, probeRoot:string, scope:"模块"|"工程",
 *          skillHint:string}} options
 *   `shownDir` 只影响打印里显示的相对路径(如 `rtl/ip/fifo`);`probeRoot` 是探针相对路径的根;
 *   `skillHint` 是**整句**技能引用(形如 `fpga-module-rtl 的「IP 时序卡」`)—— 传整句而不是技能名,
 *   是为了让两个入口拼出来的文案与重构前**逐字相同**。
 * @returns 与 `checkFile` 同形的 `{ file, issues }`,便于和文件项一起打印。
 */
export function checkIpCard({ shownDir, ipDir, name, probeRoot, scope, skillHint }) {
  const shown = `${shownDir}/timing.json`;
  const card = join(ipDir, name, "timing.json");
  const warn = (message) => ({ file: shown, issues: [{ rule: "IP 卡", line: 0, message }] });
  if (!existsSync(card)) {
    return warn(`${shownDir}/ 下没有 timing.json —— 这个 IP 的时序前提(读/写延迟、复位占用拍、配置)没有实测记录;测一份再往下走(格式见 ${skillHint})`);
  }
  try {
    const parsed = JSON.parse(readFileSync(card, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return warn("timing.json 的顶层要是一个对象(键值对);数组/标量读不出前提,等于没有卡");
    }
    // 卡里必须有这四栏 —— 缺哪一栏,这张卡就说不清"它是什么 / 什么时候测的 / 怎么复核 / 什么配置"
    const missingFields = ["card", "measured", "probe", "config"].filter((key) => !(key in parsed));
    if (missingFields.length > 0) {
      return warn(`timing.json 缺栏目:${missingFields.join("、")} —— card(这是什么)/ measured(哪天测的)/ probe(拿什么测的)/ config(什么配置)都要有,否则别人没法复核`);
    }
    // 光"键在"还不够(第三轮复审 N-12):空串 / 空对象 / 指向不存在的探针,都是"有张卡但复核不了"。
    const problems = [];
    for (const key of ["card", "measured", "probe"]) {
      if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
        problems.push(`${key} 要是非空字符串(现在是 ${JSON.stringify(parsed[key])})`);
      }
    }
    if (typeof parsed.config !== "object" || parsed.config === null || Object.keys(parsed.config).length === 0) {
      problems.push("config 要是非空对象(不写配置,这卡就说不清是在什么配置下测的)");
    }
    // 探针必须真的在根里(相对模块根 / 工程根):不然这张卡说的"谁测的"没法复核
    if (typeof parsed.probe === "string" && parsed.probe.trim() !== "") {
      const probeRel = parsed.probe.split(/\s+/u)[0];
      // F6-01/F7-04:词法 + realpath 不越根 + 必须是普通文件(目录/junction 不算探针)
      if (!evidenceFileInside(probeRoot, probeRel)) {
        problems.push(`probe 指的探针不可用:${probeRel}(要写${scope}根相对的**普通文件**,且真实落点仍在${scope}内)`);
      }
    }
    // "有实测数值"才是卡的意义 —— 而且要是**可识别的测量字段**(第四轮 Q4-12:光"有个数字"的话
    // `dummy: 1` 也能过,那只是**结构完整**,不是"测过"。脚本不假装懂物理意义,但至少要认得出
    // 它写的是哪一类量,并且值合法(有限、非负)。`config` 里的是配置值(几路、什么模式),不算数。
    const measuredOk = MEASURED_FIELDS.some(
      (key) => typeof parsed[key] === "number" && Number.isFinite(parsed[key]) && parsed[key] >= 0
    );
    if (!measuredOk) {
      problems.push(
        `没有任何**可识别的实测字段**(白名单:${MEASURED_FIELDS.slice(0, 8).join(" / ")} …)—— ` +
          "写个普通数字不算「测过」:结构完整 ≠ 测量已核验"
      );
    }
    if (problems.length > 0) return warn(`timing.json 不完整:${problems.join(";")}`);
  } catch (error) {
    return warn(`timing.json 解析不了(${String(error?.message ?? error)}) —— 卡读不出来等于没有卡`);
  }
  return { file: shown, issues: [] };
}

/**
 * `ip/` 下每个 IP 目录一张时序卡;目录不存在就当"没有 IP"(不是错)。
 * @param {{ipDir:string, shownPrefix:string, probeRoot:string, scope:"模块"|"工程", skillHint:string}} options
 * @returns 每个 IP 目录一条检查结果(形状与 `checkFile` 的文件项一致)。
 */
export function ipCardEntries({ ipDir, shownPrefix, probeRoot, scope, skillHint }) {
  let names;
  try {
    names = readdirSync(ipDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .map((name) => checkIpCard({ shownDir: `${shownPrefix}/${name}`, ipDir, name, probeRoot, scope, skillHint }));
}

/**
 * 逐条打印 `ok` / `FAIL` 与每条问题的缩进 —— 两个入口逐字相同的骨架。
 * 标题行之后的 summary(PASS / FAIL / PARTIAL)与退出码各入口自己决定,不进这里。
 * @param report - `{ file, issues }` 列表(可带 `role`,只用于调用方自己的输出)。
 */
export function printEntryLines(report) {
  for (const entry of report) {
    const bad = entry.issues.filter(isFailure).length;
    console.log(`${bad === 0 ? "ok  " : "FAIL"}  ${entry.file}${entry.issues.length === 0 ? "" : `  (${bad} 项阻塞 / ${entry.issues.length - bad} 项警告)`}`);
    for (const issue of entry.issues) {
      console.log(`        ${isFailure(issue) ? "FAIL" : "warn"}  ${issue.line > 0 ? `第 ${issue.line} 行:` : ""}${issue.message}`);
    }
  }
}
