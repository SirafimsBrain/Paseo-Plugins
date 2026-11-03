/**
 * Decision logic for the `agent.open.before` hook (0.35.1, recommendation
 * §10.8 item 1; `before("agent.session_open")` before 0.15.0 renamed it).
 *
 * Two independent contributions can reach an agent on every session open:
 *
 * 1. **MCP server (launch-only).** Paseo merges the plugin's `request.mcpServers`
 *    into the agent's launch config, and a name that already exists in the *saved*
 *    config aborts the open (`collides with agent saved configuration`, host
 *    `agent-manager.js`). Providers that do not support MCP abort it as well. So
 *    this path is only taken when the contribution is provably absent everywhere
 *    else — see `readSavedMcpServers` in `agent-record.ts` and the config-file
 *    cover of stage D4 in `agent-mcp-config.ts`.
 * 2. **Attached native tool** (`defineAgentTool`, `luck_tree_upsert_leaf`).
 *    Delivered by Paseo's own tool transport, never persisted, and its collision
 *    rule is only against Paseo's own tools and other plugins' tools — never
 *    against MCP servers. It is therefore safe to attach at any time, and it is
 *    the fallback for providers without MCP support and for agents whose saved
 *    server state cannot be read.
 *
 * The gate is a single host-wide switch for luck-planner (`injectIntoAgents`) —
 * there is no label gate or provider exclusion list in this plugin. Everything
 * below is pure so the whole matrix is unit-testable without a daemon.
 *
 * What is deliberately **not** here: `reason: "create"` never contributes. The
 * `agent.create.before` hook owns creation-time injection (stage D4: config-file cover
 * first, saved config otherwise), and by the time the first session opens the
 * record already reflects its decision — re-deriving here would only race it.
 *
 * 0.15.0 adds a third, host-level blocker (0.40.8, §10.11 item 1): an
 * `opencode` agent carrying custom MCP servers is rejected outright while the
 * host reuses a discovered OpenCode v2 service (`server/opencode-service.ts`).
 * The probe answers that question for this open, and a shared service is
 * treated exactly like a provider without MCP support — no server, native tool
 * instead — so the agent still opens and still records facts.
 */

import type { AgentRecordLookup } from "./agent-record";

export interface SessionOpenInput {
  /** `create` | `resume` | `refresh` | `import` */
  reason: string;
  /** `interactive` | `history` */
  purpose: string;
  /** `injectIntoAgents` setting — the single switch for "may luck-planner reach agents". */
  injectIntoAgents: boolean;
  /** Config key the server is registered under (the `agent.create.before` hook's key). */
  serverName: string;
  /** The agent's own config file already carries a current registration (stage D4). */
  configCovered: boolean;
  /** Saved `config.mcpServers` of the agent about to open. */
  lookup: AgentRecordLookup;
  /** `capabilities.supportsMcpServers`, or `null` when the snapshot was unavailable. */
  supportsMcpServers: boolean | null;
  /**
   * OpenCode shared-service gate (0.15.0). Absent means "no shared service",
   * which is also every other provider's answer.
   */
  sharedOpenCodeService?: { shared: boolean; why: string };
}

export interface SessionOpenDecision {
  /** Contribute the launch-only MCP server for `serverName`. */
  injectMcp: boolean;
  /** Attach the native `luck_tree_upsert_leaf` agent tool. */
  attachTool: boolean;
  /** Human-readable reason, surfaced in `paseo plugin logs luck-planner`. */
  why: string;
}

function savedHasServer(input: SessionOpenInput): boolean {
  return (
    input.lookup.status === "found" && input.lookup.savedServers.includes(input.serverName)
  );
}

/**
 * Whether the hook still has to ask the daemon for `supportsMcpServers`.
 *
 * Only when an MCP contribution is genuinely possible: the gate passes, the open
 * is not a create (the create hook owns those) and not a history fetch, the config
 * file does not already own the server, and the saved configuration does not
 * already carry it. Everything else is decided without touching the daemon, so a
 * gated-off or already-provisioned agent costs no extra round trip on open.
 */
export function needsCapabilityProbe(input: SessionOpenInput): boolean {
  if (!input.injectIntoAgents) return false;
  if (input.purpose === "history") return false;
  if (input.reason === "create") return false;
  if (input.configCovered) return false;
  if (savedHasServer(input)) return false;
  // A shared OpenCode service rules the contribution out on its own: the
  // capability probe cannot change that answer, so it is not worth a round
  // trip to the daemon.
  if (input.sharedOpenCodeService?.shared === true) return false;
  return true;
}

/**
 * Why the MCP server was not contributed, for an agent the early checks already
 * let through. Kept exhaustive so the log line always explains itself instead of
 * silently doing nothing.
 */
function mcpBlockReason(input: SessionOpenInput): string | null {
  // Strongest fact first: it is the host, not the provider, that would fail.
  if (input.sharedOpenCodeService?.shared === true) {
    return `shared OpenCode service (${input.sharedOpenCodeService.why})`;
  }
  if (input.supportsMcpServers === false) return "provider does not support MCP servers";
  if (input.supportsMcpServers === null) return "provider capabilities unknown";
  if (input.lookup.status === "missing") return "agent record not found on disk";
  if (input.lookup.status === "unusable") {
    return `agent record unusable (${input.lookup.reason})`;
  }
  if (input.lookup.savedServers.includes(input.serverName)) {
    return `saved configuration already carries '${input.serverName}' (collision)`;
  }
  return null;
}

export function decideSessionOpen(input: SessionOpenInput): SessionOpenDecision {
  const skip = (why: string): SessionOpenDecision => ({
    injectMcp: false,
    attachTool: false,
    why: `skipped: ${why}`,
  });

  if (!input.injectIntoAgents) return skip("injectIntoAgents is off");
  if (input.purpose === "history") return skip("purpose is history");
  // The create hook owns creation-time injection — *unless* the host gate
  // stopped it (0.40.8): a shared OpenCode service made the create hook
  // contribute nothing, so this open is the only chance to attach the native
  // tool and the agent must not be left without a way to write.
  if (input.reason === "create" && input.sharedOpenCodeService?.shared !== true) {
    return skip("reason=create is handled by the agent.create.before hook");
  }
  if (input.configCovered) {
    return skip("the agent's config file already registers the server (D4)");
  }

  const block = mcpBlockReason(input);
  const injectMcp = block === null;

  // The tool is the guaranteed path: it is attached exactly where MCP is not and
  // the agent does not already carry the server — no saved entry, no config-file
  // cover, and no launch-only contribution being made in this same open (which
  // would give the agent two ways to record the same fact).
  const attachTool = !injectMcp && !savedHasServer(input);

  const why = injectMcp
    ? `injecting '${input.serverName}': saved configuration has no such server (${describeLookup(input)})`
    : attachTool
      ? `attaching native luck_tree_upsert_leaf tool only: ${block}`
      : input.sharedOpenCodeService?.shared === true
        ? // The saved entry keeps the host's rejection alive whatever this hook
          // does — the name lives in the agent's own configuration.
          `skipped: the agent already carries '${input.serverName}' in its saved configuration; ` +
          `${block} — the host may still reject this open`
        : `skipped: the agent already carries '${input.serverName}' in its saved configuration`;

  return { injectMcp, attachTool, why };
}

function describeLookup(input: SessionOpenInput): string {
  return input.lookup.status === "found"
    ? `${input.lookup.savedServers.length} saved server(s)`
    : input.lookup.status;
}
