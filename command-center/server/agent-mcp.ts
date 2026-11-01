import * as fs from "node:fs";
import * as path from "node:path";
import { storeRoot } from "./store";

/**
 * Per-agent MCP registry (0.6.0).
 *
 * A prompt command can carry MCP server configs (§5d), which are attached to
 * every agent the command *creates*. Runs against an *existing* agent could
 * not change its MCP configuration at all before 0.14.0 — this registry is
 * the bookkeeping that lets `before("agent.session_open")` contribute them
 * later (launch-only, never saved):
 *
 * - every run against an existing agent stores the command's `mcpServers`
 *   under that agent id (a run with no servers clears the entry — the
 *   registry always reflects the *last* command run against the agent);
 * - the session-open hook re-derives the contribution on every
 *   `resume` / `refresh` reopen, filtered against the agent's saved
 *   configuration for collision safety (`server/session-open.ts`).
 *
 * The file lives next to the other plugin stores in
 * `$PASEO_HOME/plugins/command-center/agent-mcp.json` and is bounded: at
 * most {@link MAX_AGENTS} agent ids are kept (oldest `updatedAt` dropped),
 * because entries for archived agents are worthless.
 *
 * Server-side only — `store.ts` imports `node:fs`.
 */

export interface AgentMcpEntry {
  /** MCP server configs keyed by server name (same shape as `command.mcpServers`). */
  servers: Record<string, unknown>;
  /** Display name of the command that last ran against the agent. */
  commandName: string;
  /** ISO timestamp of the run that wrote this entry. */
  updatedAt: string;
}

interface RegistryFile {
  version: 1;
  agents: Record<string, AgentMcpEntry>;
}

/** Hard cap on tracked agent ids; the oldest entries are dropped on save. */
export const MAX_AGENTS = 200;

function registryFile(): string {
  return path.join(storeRoot(), "agent-mcp.json");
}

function writeJsonAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(temp, target);
}

/** Loads the registry; any unreadable state yields an empty registry. */
export function loadAgentMcpRegistry(): Record<string, AgentMcpEntry> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryFile(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const agents = (parsed as { agents?: unknown }).agents;
    if (typeof agents !== "object" || agents === null || Array.isArray(agents)) return {};
    const result: Record<string, AgentMcpEntry> = {};
    for (const [agentId, entry] of Object.entries(agents as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as { servers?: unknown; commandName?: unknown; updatedAt?: unknown };
      const servers =
        typeof record.servers === "object" && record.servers !== null && !Array.isArray(record.servers)
          ? (record.servers as Record<string, unknown>)
          : null;
      if (!servers) continue;
      result[agentId] = {
        servers,
        commandName: typeof record.commandName === "string" ? record.commandName : "",
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
      };
    }
    return result;
  } catch {
    return {};
  }
}

function saveRegistry(agents: Record<string, AgentMcpEntry>): void {
  let entries = Object.entries(agents);
  if (entries.length > MAX_AGENTS) {
    entries = entries
      .sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
      .slice(entries.length - MAX_AGENTS);
  }
  const file: RegistryFile = { version: 1, agents: Object.fromEntries(entries) };
  writeJsonAtomic(registryFile(), file);
}

/**
 * Remember the MCP servers of the command that just ran against `agentId`.
 * `servers` empty clears the entry — the registry always reflects the last
 * command run against the agent.
 */
export function rememberAgentMcp(
  agentId: string,
  servers: Record<string, unknown>,
  commandName: string,
  now: Date = new Date(),
): void {
  if (agentId.trim().length === 0) return;
  const registry = loadAgentMcpRegistry();
  const names = Object.keys(servers);
  if (names.length === 0) {
    if (agentId in registry) {
      delete registry[agentId];
      saveRegistry(registry);
    }
    return;
  }
  registry[agentId] = { servers, commandName, updatedAt: now.toISOString() };
  saveRegistry(registry);
}

/** Drop the entry for one agent (archived or forgotten). */
export function forgetAgentMcp(agentId: string): void {
  const registry = loadAgentMcpRegistry();
  if (agentId in registry) {
    delete registry[agentId];
    saveRegistry(registry);
  }
}
