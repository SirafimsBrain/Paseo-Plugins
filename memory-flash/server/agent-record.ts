import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Best-effort read of the agent record Paseo keeps on disk (0.9.4).
 *
 * ## Why this exists
 *
 * Paseo 0.14 lets a plugin contribute MCP servers in `before("agent.session_open")`,
 * but that map is merged with the agent's **saved** configuration at launch and a
 * name present in both is a hard failure:
 *
 * ```text
 * MCP server 'memory-flash' from plugin memory-flash collides with agent saved configuration
 * ```
 *
 * (`resolveProviderLaunchConfig` in the host's `agent-manager.js`.) The host gives
 * the hook no way to see the saved servers — `request.mcpServers` starts empty per
 * plugin, `AgentSnapshotPayload` carries no `config`, and neither `PaseoApi.agents`
 * nor `updateAgent` can read or rewrite it. So the only collision-safe way to
 * decide "may I contribute this server here?" is to look at the record the daemon
 * itself persists:
 *
 * ```text
 * $PASEO_HOME/agents/<workspace-slug>/<agentId>.json   # top-level `config.mcpServers`
 * ```
 *
 * The layout above was verified on this machine on 2026-10-29 (Paseo 0.14.0).
 *
 * ## Fail-safe contract
 *
 * Every failure mode resolves to **"do not inject"**: a missing directory, a missing
 * record, an unparseable file, or a record whose `config` is not an object all return
 * `unusable`/`missing`, and the caller then leaves the session open untouched. Reading
 * the wrong thing can therefore never break an agent — at worst the feature no-ops,
 * which is exactly the behaviour the plugin had before it existed. The file is opened
 * read-only and never written.
 *
 * The workspace directory name is a host-internal slug of the agent's cwd, so we do
 * not try to reproduce it: agent ids are UUIDs, and a scan of the (few) workspace
 * directories for `<agentId>.json` is both exact and cheap.
 */

export type AgentRecordLookup =
  /** Record found and `config` is an object; `savedServers` are its MCP keys. */
  | { status: "found"; savedServers: string[] }
  /** No `<agentId>.json` anywhere under the agents root. */
  | { status: "missing" }
  /** Record unreadable, or `config` missing/not an object — unknown state. */
  | { status: "unusable"; reason: string };

/** `$PASEO_HOME` when set, else `~/.paseo` — the same rule the daemon uses. */
export function paseoHome(): string {
  const configured = process.env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured.trim()
    : path.join(os.homedir(), ".paseo");
}

/** Root holding one directory per workspace: `<home>/agents`. */
export function agentsRoot(home: string = paseoHome()): string {
  return path.join(home, "agents");
}

/**
 * Resolve the agent's persisted `config.mcpServers` keys.
 *
 * @param agentId agent whose saved configuration should be inspected
 * @param root    agents root; injectable so tests never touch a real daemon home
 */
export function readSavedMcpServers(
  agentId: string,
  root: string = agentsRoot(),
): AgentRecordLookup {
  if (agentId.trim().length === 0) return { status: "unusable", reason: "empty agent id" };

  let workspaces: string[];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { status: "unusable", reason: `agents root unreadable: ${message}` };
  }

  for (const workspace of workspaces) {
    const file = path.join(root, workspace, `${agentId}.json`);
    let raw: string;
    try {
      if (!fs.statSync(file).isFile()) continue;
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // another workspace directory may still hold it
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "unusable", reason: "agent record is not valid JSON" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "unusable", reason: "agent record is not an object" };
    }
    const config = (parsed as { config?: unknown }).config;
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      // The record exists but carries no persisted config: the host is storing
      // configuration somewhere we cannot see, so its launch set is unknown.
      return { status: "unusable", reason: "agent record has no config object" };
    }
    const servers = (config as { mcpServers?: unknown }).mcpServers;
    if (servers === undefined || servers === null) return { status: "found", savedServers: [] };
    if (typeof servers !== "object" || Array.isArray(servers)) {
      return { status: "unusable", reason: "agent record mcpServers is not an object" };
    }
    return { status: "found", savedServers: Object.keys(servers as Record<string, unknown>) };
  }

  return { status: "missing" };
}

/** True when `name` is already part of the agent's saved MCP configuration. */
export function savedServersInclude(
  lookup: AgentRecordLookup,
  name: string,
): boolean {
  return lookup.status === "found" && lookup.savedServers.includes(name);
}
