/**
 * Bundles `server/mcp-server.ts` into a standalone `dist/mcp-server.js`.
 *
 * Agents spawn the MCP server with their own Node runtime; a single-file
 * bundle avoids shipping `node_modules` and resolves the ESM extensionless
 * import problem (plain `node --experimental-strip-types` cannot resolve
 * `./providers` without an extension).
 *
 * The bundle depends only on Node built-ins (`fetch`, `AbortController`, …),
 * so agents' own Node runtimes (>= 18) can spawn it without `npm install`.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

mkdirSync(join(root, "dist"), { recursive: true });

// The MCP server reports the plugin version in its `initialize`
// result; inject it from package.json so the two never drift.
const { version } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf-8"),
);

await build({
  entryPoints: [join(root, "server", "mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(root, "dist", "mcp-server.js"),
  define: { __BUNNY_SEARCH_VERSION__: JSON.stringify(version) },
  banner: {
    // ESM shims for CJS built-ins under `esbuild`'s platform=node.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  external: ["node:*"],
  sourcemap: false,
  logLevel: "warning",
});

console.log("dist/mcp-server.js written");
