/**
 * Bundles the plugin's standalone build outputs into `dist/`.
 *
 * Two entries:
 * - `server/mcp-server.ts` → `dist/mcp-server.js` — the stdio MCP server that
 *   coding agents spawn with their own Node runtime. A single-file bundle
 *   avoids shipping `node_modules` next to it and resolves the ESM
 *   extensionless import problem (plain `node` cannot resolve `./store`
 *   without an extension). It depends only on Node built-ins (`node:sqlite`
 *   is built into Node 24 and marked external automatically).
 * - `dashboard/src/main.tsx` → `dist/dashboard/assets/dashboard.js` (plus the
 *   emitted `dashboard.css`) — the 2D dashboard web app (stage G1, ADR-1),
 *   served by the loopback HTTP server from `dist/dashboard`. Browser build
 *   (`platform: browser`, ESM, no minify so the committed artifact stays
 *   reviewable), with `dashboard/index.html` copied next to the assets. The
 *   HTTP server already falls back to a placeholder shell when this directory
 *   is missing, so a checkout that only needs the MCP server still works.
 *
 * Runs on every plugin install/update via the `build` step, and before the
 * test suite via `pretest`, so the e2e spawn always sees a fresh bundle.
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
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

// ── Dashboard SPA (stage G1) ──────────────────────────────────────────────

const dashboardAssets = join(root, "dist", "dashboard", "assets");
mkdirSync(dashboardAssets, { recursive: true });

await build({
  entryPoints: [join(root, "dashboard", "src", "main.tsx")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  jsx: "automatic",
  // React reads process.env.NODE_ENV; without this define a browser tab dies
  // with `ReferenceError: process is not defined` before the first render
  // (and the dev build would ship). Pinning production also shrinks the
  // committed bundle to the production react-dom.
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  outfile: join(dashboardAssets, "dashboard.js"),
  // The CSS import in main.tsx makes esbuild emit dashboard.css beside the
  // script; index.html links that exact pair.
  sourcemap: false,
  logLevel: "warning",
});

copyFileSync(
  join(root, "dashboard", "index.html"),
  join(root, "dist", "dashboard", "index.html"),
);

console.log("dist/dashboard written");

