/**
 * Where the plugin's own files live (stage J2 — the live-daemon acceptance).
 *
 * A plugin runs in two places at once: its **code** is loaded by the host
 * (transpiled, from wherever the host's loader puts it) and its **files** —
 * the built dashboard, the manifest — stay in the checkout the daemon
 * installed. Resolving a file relative to the *running module* is therefore
 * unreliable: the host's CommonJS build has no `import.meta.url`
 * (`server/module-dir.ts`), and even where it does, the module may not live
 * next to the files.
 *
 * The daemon knows the truth: `$PASEO_HOME/config.json` records the
 * installed directory of every plugin (`plugins["luck-planner"].path` — the
 * checkout with `package.json` and `dist/dashboard` inside). That is the
 * primary source here; the module-relative path is the fallback for a
 * development checkout that was never installed.
 *
 * The live acceptance found this the hard way: the first install logged
 * "dashboard listening on …" while the tab showed the placeholder page
 * ("the dashboard web app is not built in this checkout"), because the
 * resolved directory was the host's loader directory instead of the checkout.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleDirectory } from "./module-dir";
import { paseoHome } from "./store";

/** The plugin id the daemon records under. */
const PLUGIN_ID = "luck-planner";

/**
 * The installed plugin directory, as the daemon's own config records it —
 * `null` when the plugin was never installed through the daemon (a
 * development checkout) or the config cannot be read.
 */
export function configuredPluginRoot(): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(paseoHome(), "config.json"), "utf8"),
    ) as { plugins?: Record<string, { path?: unknown }> };
    const entry = raw.plugins?.[PLUGIN_ID];
    if (entry && typeof entry.path === "string" && entry.path.length > 0) {
      return entry.path;
    }
  } catch {
    // No config (or an unreadable one): the module-relative path is next.
  }
  return null;
}

/**
 * The candidate roots of the plugin's files.
 *
 * The **module's own root first**: in a development checkout the module lives
 * inside the plugin, so its `dist/dashboard` is the one the developer just
 * built. The **installed directory** (from the daemon's config) is the
 * fallback: on a live install the host loads the plugin's code from its own
 * directory, so only the configured path points at the files.
 */
function candidateRoots(): string[] {
  const roots: string[] = [];
  // The module lives in `<root>/server/` in a checkout and in `<root>/dist/`
  // in the ESM bundle; both are one level below the root.
  roots.push(path.join(moduleDirectory(), ".."));
  const configured = configuredPluginRoot();
  if (configured !== null) roots.push(configured);
  return roots;
}

/**
 * The directory of the built dashboard app.
 *
 * A candidate counts as *usable* when it holds the app's `index.html`; a
 * directory without it would only make the server answer with its "not built
 * in this checkout" placeholder. The first usable candidate wins; a directory
 * that merely exists is the fallback, so the answer is never a path that
 * does not exist at all.
 */
export function resolveDashboardDir(): string {
  const candidates = candidateRoots().map((root) => path.join(root, "dist", "dashboard"));
  let existing: string | null = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    if (existing === null) existing = candidate;
  }
  // Nothing usable: the first candidate is the honest answer, and the HTTP
  // server answers with its "not built in this checkout" placeholder.
  return existing ?? candidates[0] ?? path.join(process.cwd(), "dist", "dashboard");
}

/** The plugin's manifest (`package.json`) — the first candidate that exists. */
export function resolveManifestPath(): string {
  const candidates = candidateRoots().map((root) => path.join(root, "package.json"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? path.join(process.cwd(), "package.json");
}

/**
 * The plugin version, for `GET /health` and the MCP handshake. A missing or
 * unreadable manifest degrades to `0.0.0` instead of failing the endpoint.
 */
export function resolvePluginVersion(): string {
  try {
    const raw = fs.readFileSync(resolveManifestPath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
