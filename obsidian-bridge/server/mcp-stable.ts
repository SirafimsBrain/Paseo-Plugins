import * as fs from "node:fs";
import * as path from "node:path";
import { agentsRoot } from "./agent-record";
import { paseoHome } from "./paths";

/**
 * Stable location of the bundled MCP server, and the repair for agents whose
 * saved configuration points into an older plugin checkout (0.9.11).
 *
 * ## Why the path has to be stable
 *
 * `agent.create.before` writes an absolute path into the agent's *saved*
 * configuration. Paseo installs a plugin into
 * `$PASEO_HOME/plugins/<id>/<install-uuid>/checkout/<id>/`, so a reinstall or an
 * update moves the bundled `dist/mcp-server.js`, while every already-created
 * agent keeps launching the path it was saved with:
 *
 * ```text
 * MCP server obsidian-bridge failed to connect: … MCP server process exited
 * with code 1: Error: Cannot find module
 * '…/plugins/obsidian-bridge/831faa67-…/checkout/obsidian-bridge/dist/mcp-server.js'
 * ```
 *
 * The session-open hook cannot replace that entry: the name collides with the
 * saved configuration and the host fails the open. So the entry has to keep
 * working, which is what this module provides:
 *
 * 1. **One stable copy.** The bundle is copied on every plugin start into
 *    `$PASEO_HOME/plugins/obsidian-bridge/mcp-server.js` — the directory that
 *    already holds the settings mirror and the model cache, and survives
 *    reinstalls — and new injections and config registrations use that path.
 * 2. **Healing the agents an older version created.** Their saved entry still
 *    points inside the old checkout, so the same start restores the missing file
 *    at exactly that path. Only paths under this plugin's own
 *    `$PASEO_HOME/plugins/obsidian-bridge/` are ever written; a record naming
 *    anything else is left alone and only logged.
 *
 * Both steps are best-effort: a failure leaves the previous behaviour in place
 * and is reported in `paseo plugin logs obsidian-bridge`, never thrown.
 *
 * ## A copy that follows the installed version (0.21.17)
 *
 * `paseo plugin update` replaces the checkout but does not restart the plugin
 * process, so the stable copy kept serving the previous version until
 * `paseo plugin reload` — an update that looked half-applied (live test U7).
 * The MCP server now compares the version it runs with the version the
 * installed checkout ships and rewrites the stable copy when they differ, so
 * the next agent launch gets the installed version without a reload. It never
 * copies on content alone: a same-version rebuild stays a development case for
 * `paseo plugin reload`, and rewriting the file on every start would race the
 * agent that is starting from it.
 */

/** Stable copy of the bundled server, inside the plugin's data directory. */
export function stableMcpEntryPath(home: string = paseoHome()): string {
  return path.join(home, "plugins", "obsidian-bridge", "mcp-server.js");
}

/** Root that holds this plugin's data (settings mirror, models, stable bundle). */
function pluginDataRoot(home: string = paseoHome()): string {
  return path.join(home, "plugins", "obsidian-bridge");
}

/**
 * Path of the stable copy created by this process, or `null`.
 *
 * A path is only reported when the copy succeeded in this run: an old copy from
 * a previous plugin version must never be preferred over the bundle that is
 * actually installed now.
 */
let currentStableEntry: string | null = null;

/** Copies `bundle` to the stable location and returns it, or `null` on failure. */
export function ensureStableEntry(
  bundle: string,
  home: string = paseoHome(),
): string | null {
  const target = stableMcpEntryPath(home);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(bundle, target);
    currentStableEntry = target;
    console.log(`[obsidian-bridge] stable MCP entry: ${target}`);
    return target;
  } catch (cause) {
    currentStableEntry = null;
    console.warn(
      `[obsidian-bridge] could not write the stable MCP entry (${target}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return null;
  }
}

/** The stable entry created by this run, or `null` — consumed by `mcp-launch.ts`. */
export function currentStableMcpEntry(): string | null {
  return currentStableEntry;
}

export interface StableRefresh {
  target: string;
  /** True when the file on disk was rewritten in this call. */
  updated: boolean;
  /** Version this process runs (the bundle it was launched from). */
  running: string;
  /** Version the installed checkout ships. */
  installed: string;
}

/** `version` from the checkout's own `package.json` (agents read the bundle, not a manifest). */
function checkoutVersion(bundle: string): string | null {
  const dir = path.dirname(bundle);
  for (const candidate of [path.join(dir, "..", "package.json"), path.join(dir, "package.json")]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === "obsidian-bridge" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // `dist/package.json` carries only the module type; the checkout one follows.
    }
  }
  return null;
}

/**
 * Rewrites the stable copy when the installed checkout ships another version
 * than the one this process runs (0.21.17).
 *
 * Returns `null` when the refresh could not be attempted (no readable
 * version), and `{ updated: false }` when the copy already matches. The caller
 * logs the result; this module never writes to stdout, which is the MCP
 * transport when it runs inside the bundled server.
 */
export function refreshStableEntry(
  installedBundle: string,
  runningVersion: string,
  home: string = paseoHome(),
): StableRefresh | null {
  const target = stableMcpEntryPath(home);
  try {
    if (path.resolve(installedBundle) === path.resolve(target)) {
      return { target, updated: false, running: runningVersion, installed: runningVersion };
    }
    const installed = checkoutVersion(installedBundle);
    if (installed === null) return null;

    const missing = !fs.existsSync(target);
    if (installed === runningVersion && !missing) {
      return { target, updated: false, running: runningVersion, installed };
    }

    const source = fs.readFileSync(installedBundle);
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(target);
    } catch {
      current = null; // first start after an install
    }
    if (current !== null && current.equals(source)) {
      return { target, updated: false, running: runningVersion, installed };
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(installedBundle, target);
    return { target, updated: true, running: runningVersion, installed };
  } catch (cause) {
    console.warn(
      `[obsidian-bridge] could not refresh the stable MCP entry (${target}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return null;
  }
}

/** True when `candidate` is inside the plugin's own data directory. */
function insidePluginData(candidate: string, home: string): boolean {
  const root = path.resolve(pluginDataRoot(home));
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Every `args`/`command` string of one saved stdio entry that looks like the server. */
function entryPaths(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
  const record = entry as { command?: unknown; args?: unknown; type?: unknown };
  if (record.type !== undefined && record.type !== "stdio") return [];
  const paths: string[] = [];
  if (typeof record.command === "string" && record.command.endsWith("mcp-server.js")) {
    paths.push(record.command);
  }
  if (Array.isArray(record.args)) {
    for (const arg of record.args) {
      if (typeof arg === "string" && arg.endsWith("mcp-server.js")) paths.push(arg);
    }
  }
  return paths;
}

/**
 * Restores the bundled server at every missing path an `obsidian-bridge` saved
 * entry still names. Returns the paths that were written.
 *
 * `serverName` is the key this plugin registers; only that entry is inspected, so
 * another plugin's (or a user's own) server is never touched.
 */
export function healStaleSavedEntries(
  bundle: string,
  serverName: string,
  home: string = paseoHome(),
): string[] {
  const healed: string[] = [];
  const root = agentsRoot(home);
  let workspaces: string[];
  try {
    workspaces = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return healed; // no agents on this daemon: nothing to heal
  }

  for (const workspace of workspaces) {
    const dir = path.join(root, workspace);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      } catch {
        continue;
      }
      const config = (parsed as { config?: unknown } | null)?.config;
      const servers = (config as { mcpServers?: unknown } | undefined)?.mcpServers;
      if (typeof servers !== "object" || servers === null || Array.isArray(servers)) continue;
      const entry = (servers as Record<string, unknown>)[serverName];
      for (const candidate of entryPaths(entry)) {
        if (fs.existsSync(candidate)) continue;
        if (!insidePluginData(candidate, home)) {
          console.warn(
            `[obsidian-bridge] saved MCP entry of ${file} points outside the plugin directory, left alone: ${candidate}`,
          );
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(candidate), { recursive: true });
          fs.copyFileSync(bundle, candidate);
          healed.push(candidate);
        } catch (cause) {
          console.warn(
            `[obsidian-bridge] could not restore ${candidate}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
    }
  }
  return healed;
}
