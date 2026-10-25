/**
 * Builds the console web app (stage A3) into `dist/console` for the
 * loopback HTTP server, following the `luck-planner/dashboard` layout:
 *
 * - `console/src/main.ts` → `dist/console/main.js` — the browser bundle
 *   (`platform: browser`, ESM, no minify so the committed artifact stays
 *   reviewable). Later stages append entries (terminal, views) here.
 * - `console/index.html` is copied next to the bundle; the server falls
 *   back to a placeholder shell when `dist/console` is missing, so a
 *   checkout that only needs the server still works.
 *
 * Runs on every plugin install/update via the `build` step, and before the
 * test suite via `pretest`, so probes and tests always see a fresh bundle.
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

mkdirSync(join(root, "dist", "console"), { recursive: true });

await build({
  entryPoints: [join(root, "console", "src", "main.ts")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  outfile: join(root, "dist", "console", "main.js"),
  // No `process`/`Buffer` shims needed yet; enabled per-entry in later stages.
  sourcemap: false,
  logLevel: "warning",
});

copyFileSync(
  join(root, "console", "index.html"),
  join(root, "dist", "console", "index.html"),
);

console.log("dist/console written");
