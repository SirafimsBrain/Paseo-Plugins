/**
 * Bundles the plugin's standalone build outputs into `dist/`.
 *
 * Entries:
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
 * - `dashboard/src/dashboard-3d.tsx` → `dist/dashboard/assets/dashboard-3d.js`
 *   — the lazy 3D scene (stage I1), loaded only when the toolbar's 3D button
 *   is pressed. Code splitting (`splitting: true`) is what keeps `three`,
 *   `@react-three/fiber` and `@react-three/drei` out of the first chunk while
 *   both entries share **one** React — two copies of React in a page break
 *   every hook — so shared modules land in `chunk-*.js` files that both
 *   entries import.
 *
 * Runs on every plugin install/update via the `build` step, and before the
 * test suite via `pretest`, so the e2e spawn always sees a fresh bundle.
 *
 * `--outdir <dir>` redirects the whole output tree (both entries) to another
 * root, keeping the `dist/` layout underneath it. The determinism test uses
 * it to build into a temp directory: a test that rewrote the shared
 * `dist/dashboard` while sibling test files were reading it raced the chunk
 * sweep (vitest runs files in parallel), so no test writes the committed
 * artifact any more — the default path is what installs and `pretest` use.
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Output root: the plugin itself, or whatever `--outdir` names. */
const outFlag = process.argv.indexOf("--outdir");
const outRoot =
  outFlag >= 0 && process.argv[outFlag + 1] !== undefined
    ? resolve(process.argv[outFlag + 1])
    : root;

mkdirSync(join(outRoot, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "server", "mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(outRoot, "dist", "mcp-server.js"),
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

const dashboardAssets = join(outRoot, "dist", "dashboard", "assets");
mkdirSync(dashboardAssets, { recursive: true });

// Stage I2: code splitting names chunks by content hash, and esbuild never
// removes the previous build's files — without this sweep every rebuild
// would leave the old `chunk-*.js` on disk, dirtying installs and the
// committed artifact. The two entries below are rewritten unconditionally.
for (const file of readdirSync(dashboardAssets)) {
  if (file.startsWith("chunk-")) {
    rmSync(join(dashboardAssets, file), { force: true });
  }
}

await build({
  entryPoints: {
    dashboard: join(root, "dashboard", "src", "main.tsx"),
    "dashboard-3d": join(root, "dashboard", "src", "dashboard-3d.tsx"),
  },
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  // Stage I1: split the graph so `dashboard-3d.js` (and the React it shares
  // with the app) stays out of the file index.html loads eagerly.
  splitting: true,
  jsx: "automatic",
  // React reads process.env.NODE_ENV; without this define a browser tab dies
  // with `ReferenceError: process is not defined` before the first render
  // (and the dev build would ship). Pinning production also shrinks the
  // committed bundle to the production react-dom.
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  outdir: dashboardAssets,
  // Stable names: the shell links /assets/dashboard.js, the app imports
  // ./dashboard-3d, and the committed artifacts stay reviewable (the chunk
  // hash in chunk-*.js is content-derived, so rebuilds stay byte-identical).
  entryNames: "[name]",
  chunkNames: "chunk-[name]-[hash]",
  // The CSS import in main.tsx makes esbuild emit dashboard.css beside the
  // script; index.html links that exact pair.
  sourcemap: false,
  logLevel: "warning",
});

copyFileSync(
  join(root, "dashboard", "index.html"),
  join(outRoot, "dist", "dashboard", "index.html"),
);

console.log("dist/dashboard written");

