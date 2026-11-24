import * as fs from "node:fs";
import * as path from "node:path";
import { agentsRoot } from "./agent-record";
import { removeAgentSkill } from "./agent-skill";
import { pruneClineMcp } from "./cline-mcp";
import { INJECTED_SERVER_NAME } from "./mcp-launch";
import { pruneKiloMcp, pruneOpencodeMcp } from "./opencode-mcp";
import { isPluginOwnedLaunch } from "./owned-entry";

/**
 * Removal of everything this plugin wrote into the agents' configuration.
 *
 * The Installation card shows where the plugin registered itself, but until
 * 0.26.22 it could not take any of it back: the three MCP config files, the
 * four installed skill directories and the MCP server saved into every agent
 * this plugin created all stayed until the switches were flipped one by one (or
 * forever, when a rename moved the key the plugin looks for). This module is
 * the single removal path behind the settings screen's *Remove agent
 * integration* action.
 *
 * Ownership, not the name, decides what is removed: a config entry is this
 * plugin's when it is registered under the plugin's server name or when its
 * launch points into `$PASEO_HOME/plugins/obsidian-bridge`. That is what makes
 * the action work after the server or a skill was renamed — the name the old
 * version used is gone from the code, the path it wrote is not.
 *
 * Every writer is best-effort and atomic, and a file that cannot be parsed is
 * reported instead of being rewritten. Nothing outside the known agent
 * configuration surfaces is touched.
 */

export interface AgentIntegrationRemoval {
  /** One human-readable line per removed registration, skill or saved entry. */
  removed: string[];
  errors: string[];
}

interface SavedEntry {
  command?: unknown;
  args?: unknown;
  type?: unknown;
}

/** Launch parts of one saved stdio entry, or `null` for another transport. */
function savedLaunch(entry: unknown): { command: string | null; args: string[] } | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const record = entry as SavedEntry;
  if (record.type !== undefined && record.type !== "stdio") return null;
  const command = typeof record.command === "string" ? record.command : null;
  const args = Array.isArray(record.args)
    ? record.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  if (command === null && args.length === 0) return null;
  return { command, args };
}

function writeRecord(file: string, document: Record<string, unknown>): void {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : undefined;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  if (mode !== undefined) fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

/**
 * Removes the plugin's saved MCP server from the agent records Paseo persists.
 *
 * `agent.create.before` writes an absolute stdio entry into each agent it
 * creates. Flipping the injection switch only affects agents created
 * afterwards, so an existing agent would keep launching the old server — and
 * after a rename that entry is invisible to every name-based lookup. Paseo
 * keeps the record on disk under `$PASEO_HOME/agents/<workspace>/<agentId>.json`
 * (the same file `agent-record.ts` reads), and a running session is not
 * disturbed: the entry decides what the next open launches.
 *
 * A record that is unreadable or not JSON is skipped silently — it is not this
 * plugin's to repair. Write failures are reported.
 */
export function removeSavedMcpEntries(
  serverName: string = INJECTED_SERVER_NAME,
  root: string = agentsRoot(),
): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  let workspaces: string[];
  try {
    workspaces = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { removed, errors }; // no agents on this daemon
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
      const target = path.join(dir, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const document = parsed as Record<string, unknown>;
      const config = document.config;
      if (typeof config !== "object" || config === null || Array.isArray(config)) continue;
      const servers = (config as { mcpServers?: unknown }).mcpServers;
      if (typeof servers !== "object" || servers === null || Array.isArray(servers)) continue;
      const entries = servers as Record<string, unknown>;
      const names = Object.keys(entries).filter((name) => {
        if (name === serverName) return true;
        const launch = savedLaunch(entries[name]);
        return launch !== null && isPluginOwnedLaunch(launch.command, launch.args);
      });
      if (names.length === 0) continue;
      try {
        const remaining = { ...entries };
        for (const name of names) delete remaining[name];
        const nextConfig: Record<string, unknown> = { ...(config as Record<string, unknown>) };
        if (Object.keys(remaining).length > 0) nextConfig.mcpServers = remaining;
        else delete nextConfig.mcpServers;
        writeRecord(target, { ...document, config: nextConfig });
        for (const name of names) removed.push(`Agent ${path.parse(file).name} mcpServers.${name}: ${target}`);
      } catch (cause) {
        errors.push(`${target}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  return { removed, errors };
}

/**
 * Removes the plugin's integration from every agent-facing surface.
 *
 * Order matters only for the report: config files first, then skills, then the
 * saved per-agent entries. The caller flips the integration switches off, so
 * the loader and the five-minute check do not write it all back.
 */
export function removeAgentIntegration(): AgentIntegrationRemoval {
  const removed: string[] = [];
  const errors: string[] = [];

  for (const outcome of [pruneOpencodeMcp(), pruneKiloMcp(), pruneClineMcp()]) {
    removed.push(...outcome.removed);
    if (outcome.error !== null) errors.push(outcome.error);
  }

  const skills = removeAgentSkill();
  removed.push(...skills.removed.map((dir) => `Skill ${path.basename(dir)}: ${dir}`));
  errors.push(...skills.errors);

  const saved = removeSavedMcpEntries();
  removed.push(...saved.removed);
  errors.push(...saved.errors);

  return { removed, errors };
}
