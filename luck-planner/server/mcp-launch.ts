import * as path from "node:path";
import * as process from "node:process";
import { fileURLToPath } from "node:url";
import {
  statSync as fsStatSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
  realpathSync,
  copyFileSync,
} from "node:fs";
import { paseoHome } from "./store";
import { configuredPluginRoot } from "./plugin-paths";

/**
 * Launch configuration for the bundled stdio MCP server (PLAN.md stage D2).
 *
 * The MCP server is spawned by the *agent* process, not by the plugin host.
 * The plugin host binary is an Electron binary run in node mode
 * (`ELECTRON_RUN_AS_NODE=1`), but agents do not necessarily inherit that
 * variable — so prefer a real `node` binary and only fall back to
 * `process.execPath` when nothing better exists.
 *
 * Two problems live here, both inherited from the memory-flash 0.7.x
 * lessons (documented in `__doc.md` §6):
 * - *Where the bundle is* — the plugin host bundles this module somewhere
 *   internal, so `__dirname` does not point at the plugin source directory.
 *   The authoritative location of a directory plugin is `plugins.<id>.path`
 *   in `$PASEO_HOME/config.json`; `__dirname`/`import.meta.url` are
 *   fallbacks, first existing `dist/mcp-server.js` wins.
 * - *Which path is handed to the agent* — the install directory carries a
 *   per-revision uuid the daemon deletes on every plugin update, while an
 *   agent re-spawns the entry path baked into its config on every turn. The
 *   entry is therefore published at a revision-independent path in the
 *   plugin's data directory (see {@link publishedMcpEntry}).
 */

/** The command that spawns the MCP server, as given to agents. */
export function mcpServerCommand(): { command: string; args: string[] } {
  return { command: resolveNodeCommand(), args: [resolveMcpEntry()] };
}

/**
 * Config key the server is registered under in `request.config.mcpServers`
 * (stage D3). The key becomes the host's tool-name prefix — agents call
 * `luck-planner_luck_tree_*` — which `dispatchMcpTool` normalizes back to
 * the bare tool name, so the key must keep matching
 * `/^luck[-_]planner_/` in `server/mcp-tools.ts`.
 */
export const MCP_SERVER_KEY = "luck-planner";

/**
 * The `mcpServers` entry injected into every Paseo-created agent
 * (`agent.create` before-hook, stage D3).
 *
 * Env semantics verified against the installed daemon (`app.asar`): the
 * stdio transport is spawned with `env: { ...sessionEnv, ...config.env }`,
 * i.e. the session environment (which carries `LUCK_PLANNER_AGENT_ID` from
 * the `agent.session_open` hook) is the base and this map only adds to it.
 * `PASEO_HOME` is forwarded when set so a non-default daemon home survives
 * even a provider that passes `config.env` through on its own.
 */
export function injectedMcpConfig(options: {
  serverName: string;
}): {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  alwaysLoad: true;
} {
  const { command, args } = mcpServerCommand();
  const env: Record<string, string> = {
    LUCK_PLANNER_SERVER_NAME: options.serverName,
  };
  if (process.env.PASEO_HOME) env.PASEO_HOME = process.env.PASEO_HOME;
  return { type: "stdio", command, args, env, alwaysLoad: true };
}

/**
 * Session environment that identifies the agent to the MCP server
 * (`agent.session_open` before-hook, stage D3): the spawned server reads it
 * as `LUCK_PLANNER_AGENT_ID` and stamps every audit row it writes with the
 * agent that called the tool. `agent.create` cannot carry it — the agent id
 * does not exist yet when the create request is intercepted.
 */
export function sessionActorEnv(agentId: string): Record<string, string> {
  return { LUCK_PLANNER_AGENT_ID: agentId };
}

function resolveNodeCommand(): string {
  // A plain node binary — the ideal case (plugin host run by node).
  if (
    path.basename(process.execPath) === "node" ||
    path.basename(process.execPath) === "node.exe"
  ) {
    return process.execPath;
  }
  // Electron distributions sometimes sit next to a node binary.
  const sibling = path.join(path.dirname(process.execPath), "node");
  if (isExecutableFile(sibling)) return sibling;
  // Scan PATH for a real Node.js binary and return its absolute path: the
  // agent that spawns the MCP server needs plain Node, and an absolute
  // path avoids relying on the agent's own PATH.
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
 * `Connection closed` on every turn, with nothing wrong in the agent itself
 * (the exact failure measured in memory-flash 0.7.1).
 *
 * Publishing the bundle under the plugin's data directory — which survives
 * updates — keeps already-created agents working. It is removed only when
 * the plugin itself is removed, and the bundle is a single self-contained
 * file that needs no `node_modules` beside it.
 */
export function publishedMcpEntry(): string {
  return path.join(paseoHome(), "plugins", "luck-planner", "mcp-server.js");
}

/**
 * Locates the bundled stdio MCP server (`dist/mcp-server.js`) inside the
 * current install and publishes it at {@link publishedMcpEntry}.
 *
 * Returns the expected publish path even when no bundle exists (no build
 * ran, or the install is broken), so a spawn failure names a concrete file
 * instead of a mystery.
 */
export function resolveMcpEntry(): string {
  const source = resolveBundleSource();
  if (!isExecutableFile(source)) return source;
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
  if (typeof __dirname === "string") {
    candidates.push(path.join(__dirname, "mcp-server.js"));
  }
  try {
    candidates.push(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.js"),
    );
  } catch {
    // Not an ES module context — ignore.
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  // Return the primary candidate so a missing entry is reported clearly.
  return (
    candidates[0] ?? path.join(configured ?? ".", "dist", "mcp-server.js")
  );
}

/**
 * Copies the bundle to its revision-independent path, atomically.
 *
 * A **copy**, not a symlink into the revision directory. The daemon deletes
 * the previous revision's directory right after the new one is loaded — and a
 * symlink into it dangles from that moment on, so every agent that then
 * spawns the MCP server gets `Cannot find module`. The live-daemon
 * acceptance (stage J2) found exactly that: the entry was a link to the
 * revision that the update had just removed.
 *
 * The copy is written to a temporary name and renamed over the target, so a
 * server spawned mid-write reads either the old file or the new one, never a
 * half-written one. It is refreshed on every resolution, which happens on
 * plugin load and on every `agent.create` — so the entry is current by the
 * time an agent actually needs it, whatever order the daemon installs in.
 */
function publishMcpEntry(source: string): string | null {
  const target = publishedMcpEntry();
  // A development checkout that publishes onto itself: nothing to copy.
  if (sameFile(target, source)) return target;
  const staging = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    removeQuietly(staging);
    copyFileSync(source, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, target);
    return target;
  } catch {
    removeQuietly(staging);
    return null;
  }
}

/**
 * True when both paths are the same existing file.
 *
 * With a *copy* as the published entry this is never true for the published
 * path (a copy is a different file with the same content) — the check stays
 * for the one case where the target *is* the source, so the copy is not
 * written onto itself.
 */
function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    // A missing file still needs to be replaced.
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
  return configuredPluginRoot();
}
