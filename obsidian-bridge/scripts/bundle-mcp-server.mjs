/**
 * Bundles `server/mcp-server.ts` into a standalone `dist/mcp-server.js`.
 *
 * Agents spawn the MCP server with their own Node runtime, so a single-file
 * bundle avoids shipping `node_modules` and resolves extensionless ESM
 * imports. The bundle depends only on Node built-ins (`node:sqlite`,
 * `node:fs`, …), so agents' Node runtimes (>= 22.5 for `node:sqlite`) can
 * spawn it without `npm install`.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

mkdirSync(join(root, "dist"), { recursive: true });

// The MCP server reports the plugin version in its `initialize` result;
// inject it from package.json so the two never drift.
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

await build({
  entryPoints: [join(root, "server", "mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(root, "dist", "mcp-server.js"),
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
  external: ["node:*"],
  sourcemap: false,
  logLevel: "warning",
});

console.log("dist/mcp-server.js written");
