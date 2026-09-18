// 极简静态服务器:只服务测试页与 bundle 两个文件,不接触 DSH。
//
// 为什么需要服务器而不是直接双击 index.html:bundle 用 <script src="/lib/client.js">
// 加载,file:// 下绝对路径会被解析到盘根,跨源也会被拦。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** 允许的请求路径 → 文件位置。只放行这两个,不做目录遍历。 */
const ROUTES = new Map([
  ["/", join(HERE, "index.html")],
  ["/index.html", join(HERE, "index.html")],
  ["/kernel.js", join(HERE, "kernel.js")],
  ["/lib/client.js", join(ROOT, "lib", "client.js")]
]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"]
]);

const HOST = "127.0.0.1";
const FIRST_PORT = Number(process.env.HARNESS_PORT ?? 43121);

/** 在候选端口上尝试监听,占用则顺延。 */
function listen(server, port, attemptsLeft = 10) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
        resolve(listen(server, port + 1, attemptsLeft - 1));
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;
  const file = ROUTES.get(path);
  if (file === undefined) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`404 ${path}\n可用的路径: ${[...ROUTES.keys()].join(", ")}\n`);
    return;
  }
  readFile(file).then(
    (body) => {
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, {
        "content-type": CONTENT_TYPES.get(ext) ?? "application/octet-stream",
        "content-length": body.byteLength,
        "cache-control": "no-store"
      });
      res.end(body);
    },
    (error) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`读不到 ${file}\n${error.message}\n`);
    }
  );
});

const port = await listen(server, FIRST_PORT);
console.log(`测试页已启动:http://${HOST}:${port}/`);
console.log("在浏览器里打开它,把页面上的结果贴回来。按 Ctrl+C 结束。");
