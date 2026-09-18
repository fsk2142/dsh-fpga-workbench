// 宿主半侧:注册工具链设置、登记预设根、探测路径是否就绪,并给设置页一个只读状态接口。
//
// 四件事:
//   1. ctx.settings.register —— 「设置 → FPGA 开发模式」的字段,存进 settings.yaml。
//   2. ensureUserPreset —— 把本包自带的预设同步进用户预设目录(见那里的长注释)。
//   3. 探测 + 自动建缓存目录 —— 判定哪一项没就绪,并替用户建出缓存目录。
//   4. 只读 HTTP 路由 —— 设置页拿它显示状态(浏览器不能 stat 本地文件)。
//
// **配置全部在宿主侧**,所以图形界面和命令行跑的是同一份设置:CLI/headless 没有
// webServer 时只是少一个设置页,路径本身照常可用,自动建缓存目录也照常生效。
//
// **刻意不往会话提示里注入任何东西。** 提示段注册在插件行(profile 层),作用域是全局,
// 那样普通会话也会看到 FPGA 工具链的信息与警告,与"不影响正常会话"冲突。所以工具链那
// 段提示由 **lib/mode.js** 注册 —— 它只从本预设的组装里挂载,作用域是 agent 作用域。
// 一句话:插件行管"配置 + 探测",模式行管"这个模式知道什么"。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import z from "@deepseek-ai/schemastery";
import {
  FIELDS,
  NS,
  inspectTools,
  legacyMigrationPatch,
  listDirectory,
  pickerCommand,
  pickerSpec,
  probeFilesystem,
  statusOf
} from "./toolchain.js";

export { NS };

/** 设置页读工具状态的路由。与 lib/client.js 里的常量必须一致。 */
export const STATUS_PATH = "/plugins/fpga-workbench/toolchain";

/** 设置页「浏览…」列目录的路由(弹不出系统对话框时的备选)。与 lib/client.js 里的常量必须一致。 */
export const BROWSE_PATH = "/plugins/fpga-workbench/browse";

/** 设置页「浏览…」弹**系统对话框**的路由。与 lib/client.js 里的常量必须一致。 */
export const PICK_PATH = "/plugins/fpga-workbench/pick";

/**
 * 对话框最多等多久。宿主 HTTP 服务的 requestTimeout 默认 300 秒,这里留出余量 ——
 * 否则用户把窗口开着不动,请求会先被服务器掐掉,而不是等到他选完。
 */
const PICK_TIMEOUT_MS = 240_000;

/** 预设 id(= 预设目录名)。 */
const PRESET_ID = "fpga-workbench";

/** 用户预设目录名(harness home 下),与 dsh-agent-presets 的约定一致。 */
const USER_PRESET_DIR = ".agent-presets";

/**
 * 本包自带的预设根。
 *
 * 用 `import.meta.url` 而不是补丁里的 `!!js ... new URL('presets/', baseUrl)`:
 * 后者依赖"补丁 !!js 求值时的 baseUrl 是补丁文件所在目录"这个假设,而实测那个假设
 * 不成立 —— 路径落在别处、目录不存在,scanRoot 对不存在的根**静默返回空**,于是预设
 * 从名单里消失且没有任何报错。模块自身的 URL 不依赖任何假设。
 */
const PRESET_ROOT = fileURLToPath(new URL("../presets/", import.meta.url));

/**
 * 设置 schema:每个字段一个字符串。
 *
 * 默认值来自字段定义 —— 下拉字段(语言/标准/仿真器)有非空默认值,路径字段默认空。
 * 下拉的默认值必须与选项对齐,否则 statusOf 会把它报成"取值不在选项里"。
 */
export const SettingsSchema = z.object(
  Object.fromEntries(FIELDS.map((field) => [field.key, z.string().default(field.default ?? "")]))
);

/**
 * 缓存目录是写入目标,不是已经装好的工具 —— 配置了但还没创建时替用户建出来。
 *
 * 放在宿主侧:图形界面和命令行共用这一份配置,两边都需要那个目录存在。建不出来
 * (权限不足、盘符不存在)就不吭声,交给状态判定如实报"未就绪",而不是假装成功。
 * @param values - 设置解析后的值。
 */
export function ensureCacheDir(values) {
  const path = String(values?.cachePath ?? "").trim();
  if (path === "") return;
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // 建不出来就保持现状,由 statusOf 报未就绪
  }
}

/**
 * 当前状态:每项的存在情况 + 给设置页用的汇总。
 *
 * 实现在 lib/toolchain.js(纯逻辑,自检能直接跑它);这里只是转出去,保持原有导入路径可用,
 * 顺便让冒烟测试能在**已装副本**上验这两件事。
 */
export { legacyMigrationPatch, statusOf } from "./toolchain.js";

/** 记一条日志;没有 logger 就退回 console。 */
function note(ctx, level, message) {
  try {
    const logger = ctx?.logger;
    if (logger !== undefined && typeof logger[level] === "function") logger[level](message);
    else console[level === "warn" ? "warn" : "log"](message);
  } catch {
    // 日志本身不该影响功能
  }
}

/**
 * 把本包自带的预设放进**用户预设目录** `$DSH_HOME/.agent-presets/<id>/`。
 *
 * 为什么走这里,而不是给预设名单加一个根 —— `dsh-agent-presets` 的构造函数里:
 *
 *     resolvedRoots = [内置根] + **config.roots** + [用户根]
 *
 * 也就是说 `roots` **只从行 config 取,不读设置值**(它的设置命名空间只接 `default`)。
 * 而给行 config 加根的补丁覆盖实测没有生效:名单里看不到本预设,并且不存在的根会被
 * scanRoot 静默跳过 —— 完全没有报错,所以查了很久。
 *
 * 用户根不一样:`includeUserRoot` 默认打开,**无条件扫描**。把预设放进去不需要任何配置,
 * 也不需要覆盖任何行。
 *
 * 幂等:内容一致就不动(升级后预设变了会刷新)。写失败只记日志,不影响插件其余功能。
 * @param ctx - host plugin context(用于记日志)。
 */
function ensureUserPreset(ctx) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const source = join(PRESET_ROOT, PRESET_ID);
    const destination = join(home, USER_PRESET_DIR, PRESET_ID);
    if (!existsSync(source)) {
      note(ctx, "warn", `fpga-workbench: 包里没有预设目录 ${source}`);
      return;
    }
    if (sameTree(source, destination)) return;
    cpSync(source, destination, { recursive: true, force: true });
    note(ctx, "info", `fpga-workbench: 已把预设同步到用户预设目录:${destination}`);
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 同步预设到用户目录失败:${error.message}`);
  }
}

/**
 * 递归比较两棵目录树是否一致(只比相对路径与文件内容)。
 * @param left - 源目录。
 * @param right - 目标目录,可能不存在。
 * @returns 完全一致时为 true。
 */
function sameTree(left, right) {
  try {
    if (!existsSync(right)) return false;
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() ? [[relative(left, full), readFileSync(full)]] : [];
      });
    const mine = walk(left);
    const theirs = new Map(walk(right));
    if (mine.length !== theirs.size) return false;
    return mine.every(([name, content]) => {
      const other = theirs.get(name);
      return other !== undefined && Buffer.compare(content, other) === 0;
    });
  } catch {
    return false;
  }
}

/**
 * 把改名前的旧键搬进新键。
 *
 * 三个路径字段改过名(verilatorPath → compilerPath 等)。只在 valueOf 里兜底是不够的:
 * 那样宿主认旧值、设置页读新值,就会出现"框是空的、状态却已就绪"。这里把值真的搬过去。
 *
 * 幂等:没有可迁移的项时什么都不写。失败只记日志 —— 迁移不成功顶多是路径要重填,
 * 不该影响插件其余部分。
 * @param settings - 已注册的设置命名空间句柄(`register()` 的返回值)。
 * @param ctx - host plugin context(用于记日志)。
 */
function migrateLegacyKeys(settings, ctx) {
  try {
    const patch = legacyMigrationPatch(settings.get());
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    Promise.resolve(
      // ⚠️ `register()` 返回的是**已绑定命名空间**的句柄,它的 update 只接补丁。
      // 多传一个 ns 会被当成补丁本身,报 "must be a plain object" —— 踩过。
      settings.update(patch)
    ).then(
      () => note(ctx, "info", `fpga-workbench: 已迁移旧字段到新字段(${keys.join(", ")})`),
      (error) => note(ctx, "warn", `fpga-workbench: 旧字段迁移失败,请重新填一次路径:${error.message}`)
    );
  } catch (error) {
    note(ctx, "warn", `fpga-workbench: 旧字段迁移失败,请重新填一次路径:${String(error)}`);
  }
}

/**
 * 弹一次系统对话框,返回用户选的路径;用户取消时返回 undefined。
 *
 * 为什么是"另外起一个 PowerShell 进程"而不是用现成的选择器:DSH 的 `ctx.directoryPicker`
 * **只能选目录**(而且它的接缝是给工作区切换器占位的,没有"谁都能调一次"的接口),而这里
 * 大多数要选的是 .exe / .bat 文件。平台自己的原生选择器也是起一个 worker 进程弹 Win32
 * 对话框(koffi 调 user32),这里用系统自带的 PowerShell 达到同样效果,且零依赖。
 *
 * 脚本以 base64 传(见 pickerCommand)、起始目录与标题走环境变量,不做字符串拼接 ——
 * 那些值来自用户输入。
 * @param spec - {@link pickerSpec} 的结果。
 * @param options - `{ title, start }`。
 * @returns 选中的路径,或 undefined(取消)。
 */
function runPicker(spec, options) {
  const command = pickerCommand(spec, options);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      env: { ...process.env, ...command.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("对话框超时未响应"));
    }, PICK_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const picked = stdout.trim();
      if (picked !== "") resolve(picked);
      else if (code === 0 || code === null) resolve(undefined); // 取消
      else reject(new Error(stderr.trim() || `powershell 退出码 ${String(code)}`));
    });
  });
}

/**
 * 挂载宿主半侧。
 * @param ctx - host plugin context carrying `settings`.
 */
export function apply(ctx) {
  const settings = ctx.settings.register(NS, SettingsSchema, { base: {} });

  // 把改名前的旧键搬进新键(一次性,幂等)。必须在设置页读值之前做 ——
  // 否则会出现"输入框是空的、状态却显示已就绪"这种自相矛盾的画面。
  migrateLegacyKeys(settings, ctx);

  // 让「FPGA 开发模式」出现在新建会话的预设选择器里。
  ensureUserPreset(ctx);

  // 开一次就先把缓存目录建出来,用户第一次打开设置页看到的就是就绪状态。
  ensureCacheDir(settings.get());

  // 设置页的两条只读接口。webServer 在 headless/CLI 部署里不存在 —— 拿不到就不注册这一步,
  // 设置项本身照常可读写,只是没有状态提示与浏览按钮(GUI 与 CLI 共用同一份配置)。
  ctx.inject(["webServer"], (webCtx) => {
    const json = (res, payload) => {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(payload));
    };

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: STATUS_PATH,
          handler: (_req, res) => {
            const values = settings.get();
            // 每次查询都补一次:用户可能刚改了缓存路径,或手工删掉了那个目录
            ensureCacheDir(values);
            json(res, statusOf(values));
          }
        }),
      "fpga-workbench: toolchain status route"
    );

    // 「浏览…」的首选:弹系统对话框(用户在资源管理器式的窗口里挑)。
    // 一次只开一个 —— 否则连点两下会叠两个窗口,谁也说不清哪个结果算数。
    let picking = false;
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: PICK_PATH,
          handler: async (req, res) => {
            let key = "";
            try {
              key = new URL(req.url ?? "", "http://localhost").searchParams.get("key") ?? "";
            } catch {
              key = "";
            }
            const spec = pickerSpec(key);
            if (spec === undefined) {
              json(res, { error: "unknown-field" });
              return;
            }
            if (picking) {
              json(res, { busy: true });
              return;
            }
            picking = true;
            try {
              const values = settings.get();
              const label = FIELDS.find((field) => field.key === key)?.label ?? "";
              const chosen = await runPicker(spec, {
                title: `选择${label.replace(/路径$/u, "")}`,
                start: String(values[key] ?? "")
              });
              json(res, chosen === undefined ? { cancelled: true } : { path: chosen });
            } catch (error) {
              // 弹不出来(没有 PowerShell、被策略挡住等)→ 交给客户端退回面板内浏览,
              // 而不是让按钮点了没反应。
              json(res, { error: String(error?.message ?? error) });
            } finally {
              picking = false;
            }
          }
        }),
      "fpga-workbench: native picker route"
    );

    // 「浏览…」用:列一个目录,让用户在界面上点选文件/目录,而不是手打路径。
    // 只读 —— 不创建、不删除、不改名;鉴权与状态路由相同(桌面端自带 Host/Origin 围栏)。
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: BROWSE_PATH,
          handler: (req, res) => {
            let requested = "";
            try {
              requested = new URL(req.url ?? "", "http://localhost").searchParams.get("path") ?? "";
            } catch {
              requested = "";
            }
            json(res, listDirectory(requested));
          }
        }),
      "fpga-workbench: directory browse route"
    );
  });
}

export const name = "fpga-workbench";
export const inject = ["settings"];
