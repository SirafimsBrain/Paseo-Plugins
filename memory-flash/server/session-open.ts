/**
 * Decision logic for the `before("agent.session_open")` hook (Paseo 0.14, 0.9.4).
 *
 * Two independent contributions can reach an agent on every session open, and they
 * have very different failure modes:
 *
 * 1. **MCP server (launch-only).** Paseo merges the plugin's `request.mcpServers`
 *    into the agent's launch config, and a name that already exists in the *saved*
 *    config aborts the open (`collides with agent saved configuration`, host
 *    `agent-manager.js`). Providers that do not support MCP abort it as well. So this
 *    path is only taken when the contribution is provably absent everywhere else —
 *    see `readSavedMcpServers` in `agent-record.ts`.
 * 2. **Attached agent tool** (`defineAgentTool`). Delivered by Paseo's own tool
 *    transport, never persisted, and its collision rule is only against Paseo's own
 *    tools and other plugins' tools — never against MCP servers. It is therefore safe
 *    to attach at any time, and it is used as the guaranteed read path for agents that
 *    have no memory-flash MCP server at all.
 *
 * The rules below are pure so the whole matrix is unit-testable without a daemon.
 */

import type { AgentRecordLookup } from "./agent-record";

export interface SessionOpenInput {
  /** `create` | `resume` | `refresh` | `import` */
  reason: string;
  /** `interactive` | `history` */
  purpose: string;
  provider: string;
  /** `injectIntoAgents` setting — the single switch for "may memory-flash reach agents". */
  injectIntoAgents: boolean;
  /** Configured MCP server name (default `memory-flash`). */
  serverName: string;
  /** `agentConfigCoversProvider(provider)` — the 0.8.2 config-file guard. */
  configCovered: boolean;
  /** Saved `config.mcpServers` of the agent about to open. */
  lookup: AgentRecordLookup;
  /** `capabilities.supportsMcpServers`, or `null` when the snapshot was unavailable. */
  supportsMcpServers: boolean | null;
}

export interface SessionOpenDecision {
  /** Contribute the launch-only MCP server for `serverName`. */
  injectMcp: boolean;
  /** Attach the read-only `memory_flash_recall` tool. */
  attachTool: boolean;
  /** Human-readable reason, surfaced in `paseo plugin logs memory-flash`. */
  why: string;
}

/**
 * Why an MCP injection was not taken. Kept exhaustive so the log line always
 * explains itself instead of silently doing nothing.
 */
function mcpBlockReason(input: SessionOpenInput): string | null {
  if (!input.injectIntoAgents) return "injectIntoAgents is off";
  if (input.purpose === "history") return "purpose is history";
  if (input.reason === "create") {
    // The `agent.create` hook owns creation: it has just written (or deliberately
    // skipped) the saved entry, and the record file may not exist yet. Injecting
    // here would race the saved entry and can collide with it.
    return "reason=create is handled by the agent.create hook";
  }
  if (input.configCovered) return "config-file registration covers the provider (0.8.2)";
  if (input.supportsMcpServers === false) return "provider does not support MCP servers";
  if (input.supportsMcpServers === null) return "provider capabilities unknown";
  if (input.lookup.status !== "found") {
    return input.lookup.status === "missing"
      ? "agent record not found on disk"
      : `agent record unusable (${input.lookup.reason})`;
  }
  if (input.lookup.savedServers.includes(input.serverName)) {
    return `saved configuration already carries '${input.serverName}' (collision)`;
  }
  return null;
}

export function decideSessionOpen(input: SessionOpenInput): SessionOpenDecision {
  const block = mcpBlockReason(input);
  const injectMcp = block === null;

  // The tool is the guaranteed read path, so it is attached exactly where MCP is
  // not: no config-file cover, no saved entry, and no launch-only contribution
  // being made in this same open (which would duplicate it).
  const savedHasServer =
    input.lookup.status === "found" && input.lookup.savedServers.includes(input.serverName);
  const attachTool =
    input.injectIntoAgents &&
    input.purpose !== "history" &&
    input.reason !== "create" &&
    !input.configCovered &&
    !savedHasServer &&
    !injectMcp;

  const why = injectMcp
    ? `injecting '${input.serverName}': saved configuration has no such server (${describeLookup(input)})`
    : attachTool
      ? `attaching recall tool only: ${block}`
      : `skipped: ${block}`;

  return { injectMcp, attachTool, why };
}

function describeLookup(input: SessionOpenInput): string {
  return input.lookup.status === "found"
    ? `${input.lookup.savedServers.length} saved server(s)`
    : input.lookup.status;
}
