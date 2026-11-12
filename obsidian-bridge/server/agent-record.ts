import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Best-effort read of the agent record Paseo keeps on disk.
 *
 * `agent.open.before` contributes `mcpServers` launch-only, and Paseo merges
 * that map with the agent's **saved** configuration. A name present in both is
 * a hard failure (`MCP server '…' from plugin … collides with agent saved
 * configuration`), and the hook gives no way to see the saved servers. The only
 * collision-safe answer is to read the record the daemon persists:
 *
 * ```text
 * $PASEO_HOME/agents/<workspace-slug>/<agentId>.json   # top-level `config.mcpServers`
 * ```
 *
 * The same lookup, for the same reason, is used by `memory-flash` and
 * `bunny-search` in this repository.
 *
 * Fail-safe contract: every failure mode resolves to "do not inject"
 * (`unusable`/`missing`), so reading the wrong thing can never break an agent.
 */

export type AgentRecordLookup =
  | { status: "found"; savedServers: string[] }
  | { status: "missing" }
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

/** Resolves the agent's persisted `config.mcpServers` keys. */
export function readSavedMcpServers(
  agentId: string,
  root: string = agentsRoot(),
): AgentRecordLookup {
  if (agentId.trim().length === 0) return { status: "unusable", reason: "empty agent id" };

  let workspaces: string[];
  try {
    workspaces = fs
      .readdirSync(root, { withFileTypes: true })
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
      continue;
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
export function savedServersInclude(lookup: AgentRecordLookup, name: string): boolean {
  return lookup.status === "found" && lookup.savedServers.includes(name);
}
