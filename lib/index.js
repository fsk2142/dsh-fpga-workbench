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
//
// NO BARE IMPORTS, deliberately. A bare specifier resolves from this module's own
// location, not from the harness, so it only works when the package physically
// sits inside the profile's `node_modules`. Mounted by absolute path or through a
// `file:` link it would fail to resolve and take the whole composition down with
// it. Node builtins are always available; a config schema from
// `@deepseek-ai/schemastery` is not, so the single string setting is validated by
// hand rather than by a schema.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Exact path the panel fetches its data from. */
const DATA_PATH = "/plugins/fpga-workbench/data";

/** Largest registry accepted, so a runaway file cannot be streamed into the tab. */
const MAX_REGISTRY_BYTES = 256 * 1024;

/**
 * Default registry location: the file beside this package.
 *
 * Right for a checkout used in place, wrong after a profile install — the package
 * then lives in the profile's `node_modules`, and editing a file there is not
 * something a user would think to do. That is what `config.registry` is for.
 * @returns an absolute path.
 */
function defaultRegistryPath() {
  return fileURLToPath(new URL("../workbench.json", import.meta.url));
}

/**
 * Resolve the configured registry path.
 *
 * An absent, blank, or non-string setting falls back to the default rather than
 * failing the plugin: a bad option should not cost the user their sidebar entry.
 * @param config - the row's `config`, as the loader resolved it.
 * @returns an absolute path.
 */
export function registryPathFrom(config) {
  const configured = config?.registry;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  return defaultRegistryPath();
}

/**
 * Read the project registry.
 *
 * Every failure comes back as data rather than as a thrown error: the panel
 * renders the reason next to whatever else it has, and a missing registry is a
 * normal first run rather than a fault.
 * @param path - absolute path of the registry file.
 * @returns the parsed registry, or a description of why it is not there.
 */
export async function readRegistry(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { registry: path, workspace: null, projects: [] };
    return { registry: path, workspace: null, projects: [], error: `读不到 ${path}:${error.message}` };
  }
  if (Buffer.byteLength(text) > MAX_REGISTRY_BYTES) {
    return { registry: path, workspace: null, projects: [], error: `${path} 超过 ${MAX_REGISTRY_BYTES} 字节` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { registry: path, workspace: null, projects: [], error: `${path} 不是合法 JSON:${error.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { registry: path, workspace: null, projects: [], error: `${path} 的顶层必须是一个对象` };
  }
  return { projects: [], ...parsed, registry: path };
}

/**
 * Mount the plugin: serve the registry to the panel.
 * @param ctx - host plugin context carrying `webServer`.
 * @param config - the row's `config`; only `registry` is read.
 */
export function apply(ctx, config) {
  const registry = registryPathFrom(config);

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
            readRegistry(registry).then(
              (payload) => {
                const body = JSON.stringify(payload, null, 2);
                res.writeHead(200, {
                  "content-type": "application/json; charset=utf-8",
                  "content-length": Buffer.byteLength(body),
                  "cache-control": "no-store"
                });
                res.end(req.method === "HEAD" ? undefined : body);
              },
              (error) => {
                const body = JSON.stringify({ registry, projects: [], error: String(error?.message ?? error) });
                res.writeHead(500, {
                  "content-type": "application/json; charset=utf-8",
                  "content-length": Buffer.byteLength(body)
                });
                res.end(body);
              }
            );
          }
        }),
      "fpga-workbench: registry route"
    );
  });
}
