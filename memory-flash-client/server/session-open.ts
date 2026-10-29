/**
 * Decision logic for the `before("agent.session_open")` hook (Paseo 0.14, 0.3.2).
 *
 * The client contributes **HTTP** MCP servers (one per enabled connection) that
 * point at a remote memory-flash host. Like every plugin contribution they are
 * merged into the launch config, and a name that already exists in the agent's
 * *saved* configuration aborts the open (`collides with agent saved
 * configuration`, host `agent-manager.js`) — a failure the hook cannot see coming,
 * because `request.mcpServers` starts empty per plugin and the SDK exposes no way
 * to read or rewrite the saved set. `server/agent-record.ts` reads it from the
 * daemon's own agent record instead; anything unreadable resolves to "do not
 * inject".
 *
 * Deliberately **no attached tool** here, unlike memory-flash: the tools belong to
 * the remote host, and a local read-only copy would give an agent two different
 * answers to "what is in the memory?" depending on which transport answered.
 *
 * The rules are pure so the matrix is unit-testable without a daemon.
 */

import type { AgentRecordLookup } from "./agent-record";

export interface ClientSessionOpenInput {
  /** `create` | `resume` | `refresh` | `import` */
  reason: string;
  /** `interactive` | `history` */
  purpose: string;
  /** `injectIntoAgents` setting — the single switch for "may this plugin reach agents". */
  injectIntoAgents: boolean;
  /** Server names this plugin would register for the current connection set. */
  serverNames: string[];
  /** Saved `config.mcpServers` of the agent about to open. */
  lookup: AgentRecordLookup;
  /** `capabilities.supportsMcpServers`, or `null` when the snapshot was unavailable. */
  supportsMcpServers: boolean | null;
}

export interface ClientSessionOpenDecision {
  /** Names that may be contributed on this open. */
  injectNames: string[];
  /** Human-readable reason, surfaced in `paseo plugin logs memory-flash-client`. */
  why: string;
}

function blockedReason(input: ClientSessionOpenInput): string | null {
  if (!input.injectIntoAgents) return "injectIntoAgents is off";
  if (input.serverNames.length === 0) return "no enabled memory connection";
  if (input.purpose === "history") return "purpose is history";
  if (input.reason === "create") {
    // The `agent.create` hook owns creation: it has just written (or skipped)
    // the saved entries, and the record file may not exist yet. Injecting here
    // would race them and can collide.
    return "reason=create is handled by the agent.create hook";
  }
  if (input.supportsMcpServers === false) return "provider does not support MCP servers";
  if (input.supportsMcpServers === null) return "provider capabilities unknown";
  if (input.lookup.status !== "found") {
    return input.lookup.status === "missing"
      ? "agent record not found on disk"
      : `agent record unusable (${input.lookup.reason})`;
  }
  return null;
}

export function decideClientSessionOpen(input: ClientSessionOpenInput): ClientSessionOpenDecision {
  const blocked = blockedReason(input);
  if (blocked !== null) return { injectNames: [], why: `skipped: ${blocked}` };

  // Safe by construction: every name that already exists in the saved
  // configuration stays out, the rest are launch-only contributions.
  const saved = input.lookup.status === "found" ? input.lookup.savedServers : [];
  const injectNames = input.serverNames.filter((name) => !saved.includes(name));
  const collisions = input.serverNames.filter((name) => saved.includes(name));

  if (injectNames.length === 0) {
    return {
      injectNames,
      why: `skipped: saved configuration already carries ${collisions.map((n) => `'${n}'`).join(", ")}`,
    };
  }
  return {
    injectNames,
    why:
      `injecting ${injectNames.map((n) => `'${n}'`).join(", ")}: absent from the saved configuration` +
      (collisions.length > 0
        ? ` (not re-injecting ${collisions.map((n) => `'${n}'`).join(", ")})`
        : ""),
  };
}
