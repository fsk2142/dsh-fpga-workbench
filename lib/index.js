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

/** The registry file beside this package, independent of the working directory. */
const REGISTRY_URL = new URL("../workbench.json", import.meta.url);

/** Largest registry accepted, so a runaway file cannot be streamed into the tab. */
const MAX_REGISTRY_BYTES = 256 * 1024;

/**
 * Read the project registry, reporting failures as data rather than as a broken
 * panel: the surface renders `error` next to whatever else it has.
 * @returns the parsed registry, or an error description.
 */
async function readRegistry() {
  let text;
  try {
    text = await readFile(REGISTRY_URL, "utf8");
  } catch (error) {
    return { error: `cannot read workbench.json: ${error.message}`, projects: [] };
  }
  if (Buffer.byteLength(text) > MAX_REGISTRY_BYTES) {
    return { error: `workbench.json exceeds ${MAX_REGISTRY_BYTES} bytes`, projects: [] };
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: `workbench.json is not valid JSON: ${error.message}`, projects: [] };
  }
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
