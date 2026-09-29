// 开发脚本的零删除报告工具。这里只列出待人工处置的路径，不删除、移动或回收任何文件。
import { readdirSync, statSync } from "node:fs";
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
