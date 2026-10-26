import { createRequire } from "node:module";

/**
 * DSH 版本兼容范围的**唯一断言口**。
 *
 * ## 为什么单独一个文件
 *
 * 2026-10-24 用户给的规范：`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的兼容声明
 * **统一写一个 `>=` 起点**（如 `>=0.2.0-rc.2`），不累加、不枚举。
 *
 * 这么写成立的前提是：**宿主判定带 `includePrerelease`**。见下。
 *
 * ## 关键事实：宿主用自己的 semver 带 includePrerelease 判定
 *
 * 宿主 `app-boot` 的判定是
 *
 *     semver.satisfies(runtimeVersion, range, { includePrerelease: true })
 *
 * 默认选项下 `>=0.2.0-rc.2` **匹配不到** `0.2.1-rc.3` —— semver 规范第 11 条规定，
 * 范围里出现预发布标记时，只有同一组 [major,minor,patch] 的预发布版才可能满足。
 * 但带上 `includePrerelease` 后，`>=0.2.0-rc.2` 覆盖 `0.2.0-rc.2` 起的**所有**
 * 版本（含后续 minor 的 rc / alpha）。实测（semver 7.x）：
 *
 * | 版本 | 默认 | includePrerelease |
 * | --- | --- | --- |
 * | 0.2.0-rc.2 | true | true |
 * | 0.2.1-rc.3 | **false** | **true** |
 * | 0.2.2 | true | true |
 * | 0.1.7-rc.2 | false | false |
 *
 * 所以**本仓库所有兼容性断言都必须带这个选项**，否则会得出与宿主相反的结论。
 *
 * ## 累加式为什么是冗余的
 *
 * `>=0.1.7-rc.2 || >=0.2.0-rc.1 || >=0.2.0-rc.2` 在 includePrerelease 下等价于
 * `>=0.1.7-rc.2` —— 后面的段全被第一段覆盖。维护成本与精确列表相同，却伪装成范围。
 *
 * ## 第三方库不跟这条规则
 *
 * 判据是**包名**：`@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头 → 跟 DSH 版本走；
 * 其余（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`react` 等）保持各自的独立约束。
 */

/** 宿主判定兼容性时使用的选项。**任何范围判断都必须带上它。** */
export const HOST_SATISFY_OPTIONS = Object.freeze({ includePrerelease: true });


/**
 * 这个包名是不是"跟 DSH 版本走"的宿主包。
 *
 * 判据来自用户 2026-10-24 的规范：包名是 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头。
 * `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 虽然同 scope，但**不是**宿主版本线。
 * @param name - 依赖包名。
 * @returns 是否为 DSH 宿主包。
 */
export const followsDshVersion = (name) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");

/**
 * 校验一个范围是否符合"统一单一起点"规范。
 *
 * 要求（缺一不可）：
 *   · 只有一个 `>=` 项，不允许 `||` 串联；
 *   · 没有上界（不含 `<`）；
 *   · 不是 `*`（那会让"声明支持哪些版本"失去表达力）。
 * @param range - 待检查的范围字符串。
 * @returns `{ ok, problem }`；`problem` 为空表示合规。
 */
export const inspectRange = (range) => {
  const text = String(range ?? "").trim();
  if (text === "") return { ok: false, problem: "范围为空" };
  if (text === "*") return { ok: false, problem: "用了 `*` —— 声明失去表达力" };
  if (text.includes("||")) return { ok: false, problem: "用了 `||` 串联 —— 累加式在 includePrerelease 下是冗余的" };
  if (text.includes("<")) return { ok: false, problem: "含上界 `<` —— 宿主升级后会把插件判成不兼容" };
  if (text.includes("^") || text.includes("~")) {
    return { ok: false, problem: "用了 `^` / `~` —— 宿主版本线要求写明确的 `>=` 起点" };
  }
  if (!/^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(text)) {
    return { ok: false, problem: `不是单个 \`>=x.y.z\` 起点（实际 ${JSON.stringify(text)}）` };
  }
  return { ok: true, problem: undefined };
};

/**
 * **按宿主的判定方式**（`includePrerelease: true`）判断版本是否落在范围内。
 *
 * 自己写比较逻辑会重蹈覆辙（预发布版排序很容易错），所以优先调用 semver。
 *
 * ## 为什么要在多个位置找 semver
 *
 * 本仓库**不直接依赖** semver（它是宿主的依赖）。2026-10-24 实测：从
 * `tools/lib/version-range.mjs` 出发 `createRequire(...).require("semver")` 在
 * 本机**找不到**（MODULE_NOT_FOUND）—— 因为 `dsh-fpga-workbench/node_modules`
 * 里没有它。所以依次试：本模块 → 宿主目录 → profile 目录。
 *
 * ## 退路逻辑为什么必须自己实现 includePrerelease
 *
 * 找不到 semver 时若只比 `major.minor.patch`，会**放大**范围（把 0.1.9 判成满足
 * `>=0.2.0-rc.2` 吗？不会，主版本小就 false；但会把 `0.2.0-rc.1` 判成满足
 * `>=0.2.0-rc.2`，那是错的）。所以退路要按 semver 第 11 条 + includePrerelease 语义：
 *
 *   · 先比 [major, minor, patch]；
 *   · 相等时再比预发布号（缺省 = 正式版，比任何同 tuple 的预发布版**大**）；
 *   · `includePrerelease` 的作用是不额外排除预发布版（默认选项会排除）。
 * @param version - 运行时 DSH 版本。
 * @param range - 兼容范围。
 * @returns 是否满足。
 */
export const satisfiesHost = (version, range) => {
  const text = String(version ?? "").trim();
  if (text === "") return false;

  /**
   * 依次尝试几个位置找 semver（宿主自己的那份最权威）。
   *
   * ⚠️ **不能硬编码到用户目录**（2026-10-24 审查抓到的隐私泄漏）：原来这里写了
   * `C:/Users/<用户名>/AppData/...`，把本机用户名带进了仓库，而且换台机器就永远
   * 走不到这条分支（等于那段候选形同虚设）。
   *
   * 现在只从**环境变量**推导，三个来源：
   *   · `DSH_APP_DIR` —— 本仓库自己的测试脚本就是这么传宿主路径的；
   *   · `LOCALAPPDATA` —— Windows 上 Programs 安装目录的根，DSH Desktop 的默认位置；
   *   · 都没有就只试裸 `semver`（走下面的退路逻辑）。
   */
  const candidates = ["semver"];
  const explicit = process.env.DSH_APP_DIR;
  if (typeof explicit === "string" && explicit !== "") {
    candidates.push(`${explicit.replace(/\\/gu, "/")}/node_modules/semver`);
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData === "string" && localAppData !== "") {
    candidates.push(
      `${localAppData.replace(/\\/gu, "/")}/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/semver`
    );
  }
  for (const specifier of candidates) {
    try {
      const require = createRequire(import.meta.url);
      const semver = require(specifier);
      if (typeof semver?.satisfies === "function") {
        return semver.satisfies(text, String(range), HOST_SATISFY_OPTIONS) === true;
      }
    } catch {
      /* 试下一个 */
    }
  }

  // ── 退路：按 semver 第 11 条 + includePrerelease 自己比 ──
  const parse = (raw) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u.exec(raw.trim());
    if (match === null) return undefined;
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split(".")
    };
  };

  const floor = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(String(range).trim());
  if (floor === null) return false;
  const low = parse(floor[1]);
  const have = parse(text);
  if (low === undefined || have === undefined) return false;

  // 1. 比主三段
  for (let i = 0; i < 3; i += 1) {
    if (have.parts[i] > low.parts[i]) return true;
    if (have.parts[i] < low.parts[i]) return false;
  }

  // 2. 主三段相等：比预发布号（semver 第 11 条）
  //    没有 pre = 正式版，**大于**任何同 tuple 的预发布版。
  if (low.pre.length === 0) return have.pre.length === 0; // >= 正式版：只有正式版或更大的正式版满足（后者已在第 1 步返回）
  if (have.pre.length === 0) return true; // 正式版 > 同 tuple 的预发布版

  // 3. 两个都是预发布版：逐段比
  for (let i = 0; i < Math.max(low.pre.length, have.pre.length); i += 1) {
    const left = low.pre[i];
    const right = have.pre[i];
    if (left === undefined) return true; // 前缀相同、右边更长 → 右边更大
    if (right === undefined) return false;
    const leftNumber = /^\d+$/u.test(left);
    const rightNumber = /^\d+$/u.test(right);
    if (leftNumber && rightNumber) {
      const delta = Number(right) - Number(left);
      if (delta !== 0) return delta > 0;
    } else if (leftNumber !== rightNumber) {
      return leftNumber; // 数字段 < 字母段
    } else {
      /**
       * 字母段按 **ASCII 逐字节**比较（semver 2.0.0 第 11.4 条）。
       *
       * 原来用 `localeCompare`，它受 ICU 影响：可能做数字感知排序
       * （`"rc2".localeCompare("rc10")` 在部分 ICU 下返回 -1，即 rc2 < rc10），
       * 而 semver 要求按字节序（`"2" > "1"`，所以 rc2 > rc10）。
       *
       * 实测（2026-10-26）：本机 8 个用例的 `localeCompare` 结果恰好与 semver 一致，
       * 分歧**没能复现** —— 但它依赖运行环境的 ICU 数据，换台机器就可能翻转。
       * 既然这里本就该是纯 ASCII 语义，正确性不该押在 locale 上。
       */
      const order = right < left ? -1 : right > left ? 1 : 0;
      if (order !== 0) return order > 0;
    }
  }
  return true; // 完全相等
};
