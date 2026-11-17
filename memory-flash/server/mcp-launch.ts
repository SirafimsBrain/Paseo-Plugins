import * as path from "node:path";
import * as process from "node:process";
import { fileURLToPath } from "node:url";
import {
  statSync as fsStatSync,
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { paseoHome } from "./store";

/**
 * Launch configuration for the bundled stdio MCP server.
 *
 * The MCP server is spawned by the agent process itself (OpenCode,
 * Kilo, Cline, ...), not by the plugin host. The plugin host binary
 * is an Electron binary run in node mode (ELECTRON_RUN_AS_NODE=1),
 * but agents do not necessarily inherit that variable — so prefer a
 * real `node` binary and only fall back to `process.execPath` when
 * nothing better exists.
 *
 * The same launch configuration is reused for two integration paths:
 * - injection into every Paseo-created agent (`agent.create` hook),
 * - direct registration in Cline's own MCP settings file (Cline
 *   ignores MCP servers delivered through the agent session).
 */

/** The command that spawns the MCP server, as given to agents. */
export function mcpServerCommand(): { command: string; args: string[] } {
  const entry = resolveMcpEntry();
  const command = resolveNodeCommand();
  return { command, args: [entry] };
}

function resolveNodeCommand(): string {
  // A plain node binary — the ideal case (plugin host run by node).
  if (path.basename(process.execPath) === "node" || path.basename(process.execPath) === "node.exe") {
    return process.execPath;
  }
  // Electron distributions sometimes sit next to a node binary.
  const sibling = path.join(path.dirname(process.execPath), "node");
  if (isExecutableFile(sibling)) return sibling;
  // Scan PATH for a real Node.js binary and return its absolute path. The
  // plugin host runs on Electron, but the agent that spawns the MCP server
  // needs plain Node — an absolute path avoids relying on the agent's PATH.
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "node");
    if (isExecutableFile(candidate)) return candidate;
  }
  // Last resort: plain `node` resolved by the spawning agent's PATH.
  return "node";
}

export function isExecutableFile(candidate: string): boolean {
  try {
    return fsStatSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Revision-independent location of the spawned MCP server.
 *
 * The install directory holds a per-revision uuid
 * (`plugins/<id>/<uuid>/checkout/<plugin>`) which the daemon deletes on
 * every plugin update. A path that goes into an agent's config is baked in
 * at `agent.create` time and re-used on every later turn, so the first
 * plugin update after an agent was created deletes the entry out from under
 * it: the spawn then fails with ENOENT and the agent reports
 * `Failed to add <provider> MCP server 'memory-flash': MCP error -32000:
 * Connection closed` on every turn, with nothing wrong in the agent itself.
 *
 * Publishing the bundle under the plugin's data directory — which survives
 * updates — keeps already-created agents working. The data directory is the
 * right home for it: it is where `memory.db` and `settings.json` live, it is
 * removed only when the plugin itself is removed, and the bundle is a single
 * self-contained file that needs no `node_modules` beside it.
 */
export function publishedMcpEntry(): string {
  return path.join(paseoHome(), "plugins", "memory-flash", "mcp-server.js");
}

/**
 * Locates the bundled stdio MCP server (`dist/mcp-server.js`) inside the
 * current install and publishes it at {@link publishedMcpEntry}.
 *
 * The plugin host bundles this module somewhere internal, so `__dirname`
 * does not point at the plugin source directory. The authoritative location
 * for a directory plugin is the `path` entry in `$PASEO_HOME/config.json`;
 * a few fallbacks cover other install layouts. The first existing candidate
 * wins.
 */
export function resolveMcpEntry(): string {
  const source = resolveBundleSource();
  if (!isExecutableFile(source)) {
    // Nothing to publish (no build ran, or the install is broken) — return
    // the expected path so the spawn failure names a concrete file.
    return source;
  }
  return publishMcpEntry(source) ?? source;
}

/** The bundle inside the current install directory. */
function resolveBundleSource(): string {
  const candidates: string[] = [];
  const configured = configuredPluginPath();
  if (configured) {
    candidates.push(path.join(configured, "dist", "mcp-server.js"));
    candidates.push(path.join(configured, "mcp-server.js"));
  }
  if (typeof __dirname === "string") candidates.push(path.join(__dirname, "mcp-server.js"));
  try {
    candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.js"));
  } catch {
    // Not an ES module context — ignore.
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  // Return the primary candidate so a missing entry is reported clearly.
  return candidates[0] ?? path.join(configured ?? ".", "dist", "mcp-server.js");
}

/**
 * Copies the bundle to `target`, atomically.
 *
 * The published path must own its bytes rather than point at the install
 * directory: this plugin used a symlink at first, and `paseo plugin update`
 * deletes the revision directory *after* the new plugin instance has already
 * republished, so the stable path was left dangling and every agent holding it
 * failed to spawn the server (`MCP error -32000: Connection closed`) until the
 * plugin happened to restart again. A copy survives the deletion, and the
 * temporary-name-plus-`rename` swap means an agent spawning mid-update reads
 * either the old or the new bundle, never a partial file. A legacy symlink at
 * the target is replaced by the `rename`.
 *
 * Returns `null` when the data directory cannot be written at all.
 */
function publishMcpEntry(source: string): string | null {
  const target = publishedMcpEntry();
  if (isPublishedCopyOf(target, source)) return target;
  const staging = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    removeQuietly(staging);
    copyFileSync(source, staging);
    renameSync(staging, target);
    return target;
  } catch {
    removeQuietly(staging);
    return null;
  }
}

/**
 * True when `target` is already a regular file holding the current bundle.
 *
 * The copy is written after the source, so a published file with the same size
 * and a not-older mtime came from this build. A symlink (or a dangling one) is
 * never "current": it has to be replaced by a copy.
 */
function isPublishedCopyOf(target: string, source: string): boolean {
  try {
    const published = fsStatSync(target);
    const original = fsStatSync(source);
    return (
      published.isFile() &&
      published.size === original.size &&
      published.mtimeMs >= original.mtimeMs
    );
  } catch {
    return false;
  }
}

function removeQuietly(target: string): void {
  try {
    unlinkSync(target);
  } catch {
    // Already gone — nothing to clean up.
  }
}

/** Reads the plugin directory from the daemon config (`plugins.<id>.path`). */
function configuredPluginPath(): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(paseoHome(), "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    const entry = raw.plugins?.["memory-flash"];
    if (entry && typeof entry.path === "string" && entry.path.length > 0) return entry.path;
  } catch {
    // Config unavailable — fall through to the other candidates.
  }
  return null;
}
