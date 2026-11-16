import * as fs from "node:fs";
import * as path from "node:path";
import { agentsRoot } from "./agent-record";
import { paseoHome } from "./paths";

/**
 * Stable location of the bundled MCP server, and the repair for agents whose
 * saved configuration points into an older plugin checkout (0.7.6).
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
 * OpenCode MCP server bunny-search failed to connect: … MCP server process exited
 * with code 1: Error: Cannot find module
 * '…/plugins/bunny-search/4b1a20f3-…/checkout/bunny-search/dist/mcp-server.js'
 * ```
 *
 * The session-open hook cannot replace that entry: the name collides with the
 * saved configuration and the host fails the open. So the entry has to keep
 * working, which is what this module provides:
 *
 * 1. **One stable copy.** The bundle is copied on every plugin start into
 *    `$PASEO_HOME/plugins/bunny-search/mcp-server.js` — a directory that survives
 *    reinstalls (the settings mirror lives there too) — and new injections use
 *    that path.
 * 2. **Healing the agents an older version created.** Their saved entry still
 *    points inside the old checkout, so the same start restores the missing file
 *    at exactly that path. Only paths under this plugin's own
 *    `$PASEO_HOME/plugins/bunny-search/` are ever written; a record naming
 *    anything else is left alone and only logged.
 *
 * Both steps are best-effort: a failure leaves the previous behaviour in place
 * and is reported in `paseo plugin logs bunny-search`, never thrown.
 */

/** Stable copy of the bundled server, inside the plugin's data directory. */
export function stableMcpEntryPath(home: string = paseoHome()): string {
  return path.join(home, "plugins", "bunny-search", "mcp-server.js");
}

/** Root that holds one directory per plugin installation. */
function pluginDataRoot(home: string = paseoHome()): string {
  return path.join(home, "plugins", "bunny-search");
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
    console.log(`[bunny-search] stable MCP entry: ${target}`);
    return target;
  } catch (cause) {
    currentStableEntry = null;
    console.warn(
      `[bunny-search] could not write the stable MCP entry (${target}): ${
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
 * Restores the bundled server at every missing path a `bunny-search` saved entry
 * still names. Returns the paths that were written.
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
            `[bunny-search] saved MCP entry of ${file} points outside the plugin directory, left alone: ${candidate}`,
          );
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(candidate), { recursive: true });
          fs.copyFileSync(bundle, candidate);
          healed.push(candidate);
        } catch (cause) {
          console.warn(
            `[bunny-search] could not restore ${candidate}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
    }
  }
  return healed;
}
