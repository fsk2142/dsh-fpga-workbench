/**
 * 构建配置：宿主侧 ESM 多入口 + 客户端 CJS 单入口。
 *
 * ## 与模板的差别
 *
 * 模板只有一个 `src/index.ts`，本插件有 **8 个入口**（迁移前 `lib/` 下就是 8 个
 * 平铺文件，宿主与包内相对导入都按文件名找它们）。所以 `hostConfig.entry` 要列全，
 * 少一个就会让某个 `import "./xxx.js"` 在运行时 `ERR_MODULE_NOT_FOUND`。
 *
 * ## 产物布局
 *
 * ```
 * lib/
 * ├── index.js / index.d.ts            宿主入口（ESM）
 * ├── mode.js / mode.d.ts              预设行 dsh-fpga-workbench/mode
 * ├── mcp.js / mcp.d.ts                包内相对导入
 * ├── selfcheck.js / selfcheck.d.ts    同上
 * ├── template-library.js / .d.ts      同上
 * ├── toolchain.js / toolchain.d.ts    同上
 * ├── version.js / version.d.ts        同上
 * └── client.js                        客户端入口（CJS + loader 包装，无 d.ts）
 * ```
 *
 * 类型与 `.js` 平铺 —— 这是 `dsh-context` 的做法；tsdown 的 `dts` 没有 `dir` 选项。
 *
 * ## 环境变量
 *
 * `BUILD_VERSION`：版本号。CI 里从 tag 传；本地缺省读 package.json。
 */
import { readFileSync } from "node:fs";

import { defineConfig, type UserConfig } from "tsdown";

const PACKAGE_NAME = "dsh-fpga-workbench";

/** 宿主提供的模块：客户端 bundle 不能 inline（loader 用 require 从自己的表里取）。 */
const CLIENT_EXTERNALS = ["react", "react/jsx-runtime"];

/**
 * 读版本号：优先环境变量（CI 从 tag 传），否则读 package.json。
 * @returns 语义化版本字符串；读不到时 `"0.0.0-unknown"`。
 */
function buildVersion(): string {
  const fromEnv = process.env.BUILD_VERSION;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  try {
    const raw = readFileSync(new URL("./package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version =
      typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
    return typeof version === "string" && version !== "" ? version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

const hostConfig: UserConfig = {
  name: `${PACKAGE_NAME}/host`,
  entry: {
    index: "src/index.ts",
    mode: "src/mode.ts",
    mcp: "src/mcp.ts",
    selfcheck: "src/selfcheck.ts",
    "template-library": "src/template-library.ts",
    toolchain: "src/toolchain.ts",
    version: "src/version.ts"
  },
  outDir: "lib",
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  // **只有宿主侧负责清目录**：客户端配置也 clean 的话会把宿主产物删掉。
  clean: true,
  // tsdown 的 node 默认强制 .mjs；包是 type: module 且宿主加载 lib/*.js，
  // 所以关掉它，让扩展名跟随包类型。
  fixedExtension: false,
  // **必须 external 的宿主包**：inline 进去会让类身份不同，宿主的绑定校验会失败。
  // `@deepseek-ai/schemastery` 是 peerDependency，运行时由宿主提供。
  deps: {
    neverBundle: ["@deepseek-ai/schemastery"]
  }
};

const clientConfig: UserConfig = {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  // **别漏 target**：漏了会按 engines.node（22）编译，浏览器跑不了。
  target: "es2022",
  dts: false,
  clean: false,
  outputOptions: {
    entryFileNames: "client.js",
    /**
     * 这三段复现宿主的 loader 协议。`dsh.client` 存在，所以客户端 bundle
     * **必须**保留这层包装 —— 漏了会加载失败（不是构建失败，是运行时白屏）。
     */
    banner: [
      "window.__ModuleLoader__.load({",
      `\tid: ${JSON.stringify(PACKAGE_NAME)},`,
      "\tfactory: (require) => {"
    ].join("\n"),
    intro: "\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;",
    footer: "\t\treturn module.exports;\n\t}\n});"
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS]
  },
  /**
   * **构建期注入版本号。**
   *
   * 浏览器读不到 package.json，而宿主更新 API 只暴露 commit SHA、不暴露版本号，
   * 所以界面上要显示版本号只能构建期烧进去。编译期常量替换，运行时零开销。
   *
   * ⚠️ 注意 `src/client/index.ts` 现在**没有**引用 `__PLUGIN_VERSION__`
   * （它通过宿主路由 `/plugins/fpga-workbench/version` 拿版本）。
   * 保留这个 define 是为了将来切过去时不用改构建配置。
   */
  define: {
    __PLUGIN_VERSION__: JSON.stringify(buildVersion())
  }
};

export default defineConfig([hostConfig, clientConfig]);
