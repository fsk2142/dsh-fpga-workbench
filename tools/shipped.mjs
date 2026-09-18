// "这个包该装进去哪些文件"的唯一来源。
//
// 为什么单独成文件:install.mjs(装之前/之后校验)与 check-installed.mjs(事后比对)必须
// 按**同一份清单**判断,否则会出现"一个说一致、另一个说不一致"。
//
// 而且清单不能再写死:曾经写死 4 个文件,于是只改技能/模板时,install.mjs 会回答
// "已装副本与源一致,无需重装" —— 静默不生效,正是这个脚本要防的事。
// 现在从 package.json 的 files 白名单推:白名单加了什么,校验就跟着覆盖什么。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * npm/pnpm 打包时**总会**带上、不必写进 `files` 的根文件。
 *
 * 不能漏掉 package.json:它不在 files 白名单里却会被装进去,而 `exports['./mode']`
 * 这种关键字段就在里面 —— 漏比对等于白比对(预设行正是靠它解析的)。
 */
const ALWAYS_PACKED = /^(package\.json|readme(\..*)?|licen[cs]e(\..*)?|changelog(\..*)?|notice(\..*)?)$/iu;

/**
 * 列出一个包按 `files` 白名单会装进去的全部文件。
 * @param root - 包根目录。
 * @returns 相对路径数组(用 `/` 分隔,已排序);读不到清单时为空数组。
 */
export function shippedFiles(root) {
  let manifest;
  let rootEntries = [];
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    rootEntries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  const walk = (dir, base) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, base);
      else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
    }
  };
  for (const entry of manifest.files ?? []) {
    const full = join(root, entry);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, root);
    else out.push(entry.split(sep).join("/"));
  }
  for (const entry of rootEntries) {
    if (entry.isFile() && ALWAYS_PACKED.test(entry.name)) out.push(entry.name);
  }
  return [...new Set(out)].sort();
}

/**
 * 文件的 sha256。
 * @param file - 文件路径。
 * @returns 十六进制摘要;读不到时为 null。
 */
export function hashOf(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * 比对源与已装副本。
 * @param sourceRoot - 源包根目录。
 * @param installedRoot - 已装副本目录。
 * @returns 失败项说明数组;空数组表示逐字节一致。
 */
export function compareTree(sourceRoot, installedRoot) {
  if (!existsSync(installedRoot)) return [`未安装到 ${installedRoot}`];
  const failures = [];
  const expected = shippedFiles(sourceRoot);
  for (const rel of expected) {
    const installed = join(installedRoot, rel);
    if (!existsSync(installed)) {
      failures.push(`已装缺 ${rel}`);
      continue;
    }
    if (hashOf(join(sourceRoot, rel)) !== hashOf(installed)) failures.push(`${rel} 与源不一致`);
  }
  // 反过来:已装副本里多出来的文件 = 上次安装的残留(白名单外的旧文件)
  for (const rel of shippedFiles(installedRoot)) {
    if (!expected.includes(rel)) failures.push(`已装多出 ${rel}(旧副本残留)`);
  }
  return failures;
}
