import * as path from "node:path";
import * as process from "node:process";
import { fileURLToPath } from "node:url";
import { statSync as fsStatSync, readFileSync } from "node:fs";
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
 * Locates the bundled stdio MCP server (`dist/mcp-server.js`).
 *
 * The plugin host bundles this module somewhere internal, so `__dirname`
 * does not point to the plugin source directory. The authoritative location
 * for a directory plugin is the `path` entry in `$PASEO_HOME/config.json`;
 * a few fallbacks cover other install layouts. The first existing candidate
 * wins.
 */
export function resolveMcpEntry(): string {
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
  candidates.push(path.join(paseoHome(), "plugins", "memory-flash", "mcp-server.js"));
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  // Return the primary candidate so a missing entry is reported clearly.
  return candidates[0] ?? path.join(configured ?? ".", "dist", "mcp-server.js");
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
