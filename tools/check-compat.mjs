// 版本兼容性检查:确认插件依赖的是目标 DSH **实际提供**的契约,而不是版本号猜测。
//
// 每条断言都读本机已安装的 DSH 源码,所以它验证的是运行时事实。任何一条失败都
// 意味着这个插件在当前 DSH 上不可靠,不要安装。
//
// 注意 dsh.client 的两种字段语义不同(dsh-client-modules/lib/index.js:139-152):
//   external —— 基座之外的**模块请求**,组合阶段校验提供方,缺失或自引用即抛错;
//   inject   —— 浏览器侧的 **Cordis 服务名**。
// 这个插件不需要 external(只用基座里的 react),也不声明 inject:它在 apply 里
// 通过 ctx.slots 工作,而 apply 是必需的导出。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = "C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai";

const failures = [];
const note = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

/** 读一个已安装包的 package.json;读不到就返回 null,由调用方断言。 */
function pkg(name) {
  const file = join(APP, name, "package.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * 断言一个字面量存在于某个已安装文件里。
 *
 * 文件缺失时直接判失败,绝不在空字符串上做 includes:空串含任意子串,那样的断言
 * 永远通过,是一句假话。
 */
function hasLiteral(relFile, literal) {
  const file = join(APP, relFile);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  if (text.length === 0) return false;
  return text.includes(literal);
}

// ── 1. DSH 包层的版本面 ──────────────────────────────────────────────────────

const DSH_PACKAGE = /^dsh(-|$)/;
const versions = new Map();
for (const dir of readdirSync(APP)) {
  if (!DSH_PACKAGE.test(dir)) continue;
  const manifest = pkg(dir);
  if (manifest?.version !== undefined) {
    versions.set(manifest.version, (versions.get(manifest.version) ?? 0) + 1);
  }
}

const spread = [...versions.entries()].sort((a, b) => b[1] - a[1]);
console.log("DSH 包版本分布:", spread.map(([v, n]) => `${v}×${n}`).join(", ") || "(none)");
note(spread.length === 1, "DSH 包层版本统一(我的契约验证对象唯一)");

// ── 2. 插件运行路径上的每个提供方 ────────────────────────────────────────────

note(pkg("dsh-client-ui-renderer") !== null, "存在 dsh-client-ui-renderer(提供 ctx.slots 服务)");
note(pkg("dsh-client-ui-layout") !== null, "存在 dsh-client-ui-layout(提供 ctx.layout.selectPanel)");
note(pkg("dsh-client-ui-sidebar") !== null, "存在 dsh-client-ui-sidebar(提供 sidebar.panellist 槽)");
note(pkg("dsh-client-modules") !== null, "存在 dsh-client-modules(把 dsh.client 变成浏览器 bundle)");
note(pkg("dsh-host-webserver") !== null, "存在 dsh-host-webserver(宿主侧路由)");

// ── 3. 插件实际调用的接口 ────────────────────────────────────────────────────

note(
  hasLiteral("dsh-client-ui-renderer/lib/client.js", 'super(ctx, "slots")'),
  'renderer 以服务名 "slots" 发布 SlotRegistry'
);
note(
  hasLiteral("dsh-client-ui-renderer/lib/client.js", "inject(key, callback)"),
  "slots.inject(key, callback) 存在(父槽未声明时会等待,不抛错)"
);
note(
  hasLiteral("dsh-client-ui-renderer/lib/client.js", "subscribeDeclaration"),
  "slots 会订阅槽声明变化并对账(后注册的槽也能被接上)"
);
note(
  hasLiteral("dsh-client-ui-sidebar/lib/client.js", "sidebar.panellist"),
  "sidebar.panellist 槽存在"
);
note(
  hasLiteral("dsh-client-ui-sidebar/lib/client.js", "ctx.layout.selectPanel"),
  "侧边栏点击时调用 selectPanel(id)"
);
note(
  hasLiteral("dsh-client-ui-layout/lib/client.js", "entry.options.key === id"),
  "layout 按 key 匹配 main 面板(所以入口行 id 必须等于面板 key)"
);
note(
  hasLiteral("dsh-client-ui-layout/lib/client.js", "is not registered"),
  "layout 对未注册面板抛错(配对写错会在控制台暴露)"
);
note(
  hasLiteral("dsh-client-modules/lib/index.js", "clientExportOf"),
  "client-modules 解析 exports['./client']"
);
note(
  hasLiteral("dsh-client-modules/lib/index.js", "nearestPackage"),
  "client-modules 按行名向上找最近 package.json(绝对路径加载成立)"
);
note(
  hasLiteral("dsh-host-webserver/lib/index.js", 'route.kind === "exact"'),
  "webServer.register 支持 kind: exact"
);

// ── 4. 插件自己的 dsh.client 声明必须合法 ────────────────────────────────────

const mine = JSON.parse(readFileSync("package.json", "utf8"));
const client = mine.dsh?.client ?? {};
console.log("我的 dsh.client 声明:", JSON.stringify(client));
note(client.platform === "web", "dsh.client.platform 为 web");
note(
  client.external === undefined || client.external.length === 0,
  "未声明 external(只用基座模块,不需要额外提供方)"
);
note(
  (client.external ?? []).every((name) => !name.startsWith("@deepseek-ai/dsh-client-ui-slots")),
  "external 里没有列出无浏览器面的宿主包(那会让组合阶段直接失败)"
);
note(typeof mine.exports?.["./client"] === "string", "导出 ./client bundle");
note(mine.private !== true, "没有 private:true(pnpm 才会把它当依赖安装)");

console.log(
  failures.length > 0
    ? `FAIL (${failures.length}):\n - ${failures.join("\n - ")}`
    : "PASS: 插件用到的契约在当前 DSH 版本上全部存在,声明合法"
);
if (failures.length > 0) process.exitCode = 1;
