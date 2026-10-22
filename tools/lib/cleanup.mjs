// 开发脚本的临时目录工具。
//
// 两条原则,别混:
//   · **用户的文件零删除** —— 已装副本里多出来的旧文件、备份、半成品,只列不删。
//   · **测试自己造的临时夹具自己清** —— 那些目录是本次运行新建的、跑完就没用了。
//     留着它们会让 `.tmp/` 每次跑测试就涨一百多 MB,还会因为被占用/撞名让测试
//     变得**偶发失败**(2026-10-22 实测:改完源码后的一次 `npm test` 失败,之后连跑
//     4 次都过 —— 根因就是历史夹具太多)。
//
// `listTempLeftovers` 仍然保留,给"别人的 / 上次留下的"条目用(只列不删)。
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const CLEANUP_KINDS = {
  temp: "临时项",
  partial: "半成品",
  installedExtra: "已装副本多余文件",
  backup: "备份(保留)"
};

/** 造一条带类别与绝对路径的待清理报告项。 */
export function cleanupEntry(kind, path) {
  return { kind, label: CLEANUP_KINDS[kind] ?? kind, path };
}

/** 把待清理清单排成可直接打印的行。 */
export function formatCleanup(entries) {
  return (Array.isArray(entries) ? entries : []).map((item) => `  [${item.label}] ${item.path}`);
}

/** 并行自检的宽限窗口；较新的 fixture 只报告为仍在使用。 */
export const TEMP_GRACE_MS = 10 * 60 * 1000;

/**
 * 列出临时根目录下命中指定前缀的第一层条目，一个都不删。
 * 空前缀清单表示无法确认归属，直接返回空数组。
 */
export function listTempLeftovers(dir, prefixes, minAgeMs = 0) {
  const wanted = (Array.isArray(prefixes) ? prefixes : []).filter(
    (prefix) => typeof prefix === "string" && prefix !== ""
  );
  const out = [];
  if (wanted.length === 0) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!wanted.some((prefix) => entry.name.startsWith(prefix))) continue;
    const full = join(dir, entry.name);
    let pending = true;
    let reason;
    try {
      if (minAgeMs > 0 && Date.now() - statSync(full).mtimeMs < minAgeMs) {
        pending = false;
        reason = "还在宽限期内(可能是并行那次正在用的 fixture),不算待清理";
      }
    } catch (error) {
      reason = `读不到时间(${String(error?.code ?? error?.message ?? error)}),按待清理列出`;
    }
    out.push({ ...cleanupEntry("temp", full), name: entry.name, pending, reason });
  }
  return out;
}

/**
 * 让一个脚本在退出时删掉**它自己这次建的**临时目录。
 *
 * 只删传进来的那些路径 —— 调用方必须显式列出自己的夹具,不搞"扫一遍 .tmp 全删"
 * (那会误伤并行跑的另一个检查,也会误伤用户手工放在那里的东西)。
 *
 * 失败静默:删不掉(被占用 / 权限)不该让测试本身变红 —— 那和"测试没通过"是两回事。
 * 但会打印一行说明,免得又变成"悄悄堆积"。
 * @param paths - 本次运行创建的临时目录/文件绝对路径。
 * @returns `{ removed, failed }` —— 各是路径数组。
 */
export function cleanupOwnFixtures(paths) {
  const removed = [];
  const failed = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== "string" || path === "" || !existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      failed.push({ path, reason: String(error?.code ?? error?.message ?? error) });
    }
  }
  return { removed, failed };
}
