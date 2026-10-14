/**
 * Bundles the plugin's standalone build outputs into `dist/`.
 *
 * Currently one entry:
 * - `server/mcp-server.ts` → `dist/mcp-server.js` — the stdio MCP server that
 *   coding agents spawn with their own Node runtime. A single-file bundle
 *   avoids shipping `node_modules` next to it and resolves the ESM
 *   extensionless import problem (plain `node` cannot resolve `./store`
 *   without an extension). It depends only on Node built-ins (`node:sqlite`
 *   is built into Node 24 and marked external automatically).
 *
 * The dashboard entries (`dist/dashboard/*`) are added in stage G1 — this
 * script is the single build command referenced by `paseo-plugin.json`
 * `build`, so no manifest change will be needed then.
 *
 * Runs on every plugin install/update via the `build` step, and before the
 * test suite via `pretest`, so the e2e spawn always sees a fresh bundle.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

mkdirSync(join(root, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "server", "mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(root, "dist", "mcp-server.js"),
  banner: {
    // ESM shims for CJS built-ins under esbuild's platform=node.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  external: ["node:*"],
  sourcemap: false,
  logLevel: "warning",
});

console.log("dist/mcp-server.js written");
