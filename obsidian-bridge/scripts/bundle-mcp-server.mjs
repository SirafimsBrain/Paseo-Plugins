/**
 * Bundles the two entry points agents and the plugin spawn:
 *
 * - `dist/mcp-server.js` — the stdio MCP server;
 * - `dist/embed-worker.js` — the short-lived embedding process (0.3.0).
 *
 * Everything except the embedding stack is inlined (`node:*` and the
 * `@huggingface/transformers` / `onnxruntime-node` pair stay external: their
 * native `.node` binaries cannot be bundled, and they are ordinary runtime
 * dependencies of the plugin checkout). Without semantic search the MCP server
 * still runs on Node built-ins alone, so an agent's runtime needs nothing more.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

mkdirSync(join(root, "dist"), { recursive: true });

// The MCP server reports the plugin version in its `initialize` result;
// inject it from package.json so the two never drift.
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  define: { __OBSIDIAN_BRIDGE_VERSION__: JSON.stringify(version) },
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __ftp } from 'node:url';",
      "import { dirname as __dp } from 'node:path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __ftp(import.meta.url);",
      "const __dirname = __dp(__filename);",
    ].join("\n"),
  },
  external: ["node:*", "@huggingface/transformers", "onnxruntime-node", "sharp"],
  sourcemap: false,
  logLevel: "warning",
};

await build({
  ...shared,
  entryPoints: [join(root, "server", "mcp-server.ts")],
  outfile: join(root, "dist", "mcp-server.js"),
});

await build({
  ...shared,
  entryPoints: [join(root, "server", "embed-worker.ts")],
  outfile: join(root, "dist", "embed-worker.js"),
});

// Mark the output directory as ESM so Node stops auto-detecting the module
// type (and warning about it) for both entry points.
writeFileSync(join(root, "dist", "package.json"), '{"type":"module"}\n');

console.log("dist/mcp-server.js and dist/embed-worker.js written");
