import type { AgentRecordLookup } from "./agent-record";

/**
 * Decision logic for `agent.open.before` — the only hook this plugin registers.
 *
 * The contribution is deliberately inert (`__research.md` §2.7): it adds either
 * an MCP server entry or a fallback agent tool to the launch request, and does
 * nothing else. No probing of Obsidian, no filesystem scan, no environment
 * variables, no daemon round trip unless an MCP contribution is genuinely
 * possible.
 *
 * Two contributions, different failure modes:
 * 1. **MCP server** (launch-only). A name that already exists in the agent's
 *    *saved* configuration aborts the session open, and a provider without MCP
 *    support aborts it too — so this path is taken only when both are known to
 *    be safe.
 * 2. **Attached agent tool** (`obsidian_search`, …). Delivered through Paseo's
 *    own tool transport, never persisted, and safe to attach whenever the MCP
 *    path is unavailable.
 *
 * The rules are pure so the matrix is unit-testable without a daemon.
 */

export interface SessionOpenInput {
  /** `create` | `resume` | `refresh` | `import` */
  reason: string;
  /** `interactive` | `history` */
  purpose: string;
  provider: string;
  /** Host-wide switch (`injectIntoAgents`). */
  injectIntoAgents: boolean;
  /** Name the MCP server is registered under. */
  serverName: string;
  /** Saved `config.mcpServers` of the agent about to open. */
  lookup: AgentRecordLookup;
  /** `capabilities.supportsMcpServers`, or `null` when unknown. */
  supportsMcpServers: boolean | null;
}

export interface SessionOpenDecision {
  injectMcp: boolean;
  attachTool: boolean;
  why: string;
}

/** Whether the hook has to ask the daemon for `supportsMcpServers`. */
export function needsCapabilityProbe(input: SessionOpenInput): boolean {
  if (!input.injectIntoAgents) return false;
  if (input.purpose === "history") return false;
  if (savedServersInclude(input.lookup, input.serverName)) return false;
  return true;
}

function savedServersInclude(lookup: AgentRecordLookup, name: string): boolean {
  return lookup.status === "found" && lookup.savedServers.includes(name);
}

export function decideSessionOpen(input: SessionOpenInput): SessionOpenDecision {
  if (!input.injectIntoAgents) {
    return { injectMcp: false, attachTool: false, why: "skipped: injectIntoAgents is off" };
  }
  if (input.purpose === "history") {
    return { injectMcp: false, attachTool: false, why: "skipped: purpose is history" };
  }
  // Already provisioned by this plugin in the saved configuration: contributing
  // again would either collide or duplicate the same tools.
  if (savedServersInclude(input.lookup, input.serverName)) {
    return {
      injectMcp: false,
      attachTool: false,
      why: `skipped: saved configuration already carries '${input.serverName}'`,
    };
  }

  if (input.supportsMcpServers === false) {
    return { injectMcp: false, attachTool: true, why: "attaching tools: provider has no MCP support" };
  }
  if (input.lookup.status !== "found") {
    return {
      injectMcp: false,
      attachTool: true,
      why:
        input.lookup.status === "missing"
          ? "attaching tools: agent record not found on disk"
          : `attaching tools: agent record unusable (${input.lookup.reason})`,
    };
  }
  if (input.supportsMcpServers === null) {
    return { injectMcp: false, attachTool: true, why: "attaching tools: provider capabilities unknown" };
  }
  return {
    injectMcp: true,
    attachTool: false,
    why: `injecting '${input.serverName}': saved configuration has no such server`,
  };
}
