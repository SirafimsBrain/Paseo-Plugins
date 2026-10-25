#!/usr/bin/env node
/**
 * Stage A3 spike runner: bundle `scripts/spike-server.ts` (plus the server
 * modules it pulls in) with esbuild and start it, so the transport probe
 * page can be opened in the real Paseo workspace browser.
 *
 * Usage:
 *   node scripts/spike-transport.mjs [--port 8891] [--host 127.0.0.1]
 *   With no arguments it serves on a random loopback port.
 *
 * The printed URL carries the token; open it in the workspace browser and
 * read the DOM probe results (`#run-state[data-state]`). Ctrl-C stops it.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(join(import.meta.dirname, ".."));
const outDir = join(root, "dist", "spike");
const outFile = join(outDir, "spike-server.mjs");

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const portRaw = flag("port");
if (portRaw !== undefined && !/^\d+$/.test(portRaw)) {
  console.error(`--port expects a number, got: ${portRaw}`);
  process.exit(2);
}

// Stage guard: the bundle is a throwaway artifact, always regenerate it.
mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [join(root, "scripts", "spike-server.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // `ws` ships its own CJS entry and is otherwise fine bundled; keep it
  // external so the spike process uses the installed package directly.
  external: ["ws"],
  sourcemap: false,
  logLevel: "warning",
});

try {
  const spike = await import(`${pathToFileURL(outFile).href}?ts=${Date.now()}`);
  const handle = await spike.startSpikeServer({
    port: portRaw === undefined ? 0 : Number(portRaw),
    host: flag("host"),
  });
  console.log(`spike console: ${handle.url}`);
  console.log("open it in the Paseo workspace browser; the page self-reports probe results");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
