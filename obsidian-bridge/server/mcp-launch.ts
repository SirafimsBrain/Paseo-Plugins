import * as path from "node:path";
import * as process from "node:process";
import { readFileSync, statSync as fsStatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paseoHome } from "./paths";
import { currentStableMcpEntry } from "./mcp-stable";

/**
 * Launch configuration for the bundled stdio MCP server.
 *
 * The server is spawned by the agent process itself, not by the plugin host,
 * so prefer a real `node` binary and fall back to `process.execPath` only when
 * nothing better exists.
 */

/** Key the plugin registers its MCP server under. */
export const INJECTED_SERVER_NAME = "obsidian-bridge";

export function mcpServerCommand(): { command: string; args: string[] } {
  return { command: resolveNodeCommand(), args: [resolveMcpEntry()] };
}

export function resolveNodeCommand(): string {
  if (path.basename(process.execPath) === "node" || path.basename(process.execPath) === "node.exe") {
    return process.execPath;
  }
  const sibling = path.join(path.dirname(process.execPath), "node");
  if (isExecutableFile(sibling)) return sibling;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "node");
    if (isExecutableFile(candidate)) return candidate;
  }
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
 * Locates the bundled stdio MCP server (`dist/mcp-server.js`).
 *
 * The plugin host bundles this module internally, so `__dirname` does not point
 * at the plugin source directory. The authoritative location for a Git/npm
 * installation is `plugins.<id>.path` in `$PASEO_HOME/config.json`.
 *
 * Since 0.9.11 the stable copy under `$PASEO_HOME/plugins/obsidian-bridge/` is
 * preferred, because an absolute path saved into an agent's configuration has to
 * survive a plugin update — but only the copy this process made (see
 * `server/mcp-stable.ts`), never a stale one from an older version.
 */
export function resolveMcpEntry(): string {
  const stable = currentStableMcpEntry();
  if (stable !== null && isExecutableFile(stable)) return stable;
  return resolveBundledEntry("mcp-server.js");
}

/**
 * The server inside the installed checkout, ignoring the stable copy.
 *
 * Used once per start to refresh the stable copy from the code that is actually
 * installed, and to heal saved configurations that point at an older checkout.
 */
export function resolveInstalledMcpEntry(): string {
  return resolveBundledEntry("mcp-server.js");
}

/** The short-lived embedding job (`dist/embed-worker.js`, 0.3.0). */
export function resolveEmbedWorker(): string {
  return resolveBundledEntry("embed-worker.js");
}

function resolveBundledEntry(file: string): string {
  const candidates: string[] = [];
  const configured = configuredPluginPath();
  if (configured) {
    candidates.push(path.join(configured, "dist", file));
    candidates.push(path.join(configured, file));
  }
  if (typeof __dirname === "string") candidates.push(path.join(__dirname, file));
  try {
    candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), file));
  } catch {
    // Not an ES module context — ignore.
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return candidates[0] ?? path.join(configured ?? ".", "dist", file);
}

/** Reads the plugin directory from the daemon config (`plugins.<id>.path`). */
export function configuredPluginPath(): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(paseoHome(), "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    const entry = raw.plugins?.["obsidian-bridge"];
    if (entry && typeof entry.path === "string" && entry.path.length > 0) return entry.path;
  } catch {
    // Config unavailable — fall through to the other candidates.
  }
  return null;
}
