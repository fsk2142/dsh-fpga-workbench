// Host half of the FPGA workbench plugin.
//
// The browser half is the whole feature: it registers a sidebar panel row and
// the main-region panel that row selects. What this half owes the loader is a
// resolvable module that exports `apply`, because `dsh-client-modules` reflects
// on the host import before it serves any client bundle; without an `apply` the
// plugin fails to load and the panel never reaches the browser.
//
// It serves the project registry over one exact route. The route sits under the
// `/plugins` prefix `dsh-client-modules` already owns, but route ownership is
// per exact pathname, so this claims only its own and leaves bundle serving
// untouched.

import { readFile } from "node:fs/promises";

/** Exact path the panel fetches its data from. */
const DATA_PATH = "/plugins/fpga-workbench/data";

/**
 * The registry file lives beside this package but is deliberately NOT shipped
 * inside it: a profile install copies the package into `node_modules`, so a
 * bundled copy would freeze the project list at install time and leave no file
 * to edit. Resolving it against this module points at the working copy, and
 * every request re-reads it.
 */
const REGISTRY_URL = new URL("../workbench.json", import.meta.url);

/** Largest registry accepted, so a runaway file cannot be streamed into the tab. */
const MAX_REGISTRY_BYTES = 256 * 1024;

/**
 * Read the project registry.
 *
 * Every failure comes back as data rather than as a thrown error: the panel
 * renders the reason next to whatever else it has, and a missing registry is a
 * normal first run rather than a fault.
 * @returns the parsed registry, or a description of why it is not there.
 */
async function readRegistry() {
  let text;
  try {
    text = await readFile(REGISTRY_URL, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { workspace: null, projects: [] };
    return { workspace: null, projects: [], error: `读不到 workbench.json:${error.message}` };
  }
  if (Buffer.byteLength(text) > MAX_REGISTRY_BYTES) {
    return { workspace: null, projects: [], error: `workbench.json 超过 ${MAX_REGISTRY_BYTES} 字节` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { workspace: null, projects: [], error: `workbench.json 不是合法 JSON:${error.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { workspace: null, projects: [], error: "workbench.json 的顶层必须是一个对象" };
  }
  return { projects: [], ...parsed };
}

/**
 * Mount the plugin: serve the registry to the panel.
 * @param ctx - host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: DATA_PATH,
          handler: (req, res) => {
            if (req.method !== "GET" && req.method !== "HEAD") {
              res.writeHead(405, { allow: "GET, HEAD" });
              res.end();
              return;
            }
            readRegistry().then((registry) => {
              const body = JSON.stringify(registry, null, 2);
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "content-length": Buffer.byteLength(body),
                "cache-control": "no-store"
              });
              res.end(req.method === "HEAD" ? undefined : body);
            });
          }
        }),
      "fpga-workbench: registry route"
    );
  });
}
