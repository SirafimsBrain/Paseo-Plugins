/**
 * Decision logic for the `before("agent.session_open")` hook (0.6.0).
 *
 * The hook contributes two things, both re-derived on every reopen:
 *
 * 1. **The `command_center_run` agent tool.** Delivered by Paseo's own tool
 *    transport, never persisted, and its only collision rule is against
 *    Paseo's own tools and other plugins' tools — so it is attached on every
 *    interactive open with no further checks.
 * 2. **Launch-only MCP servers** of the last command run against this agent
 *    (the registry, `server/agent-mcp.ts`). Paseo merges `request.mcpServers`
 *    into the agent's launch config, and a name that already exists in the
 *    *saved* config aborts the open (`collides with agent saved
 *    configuration`, host `agent-manager.js`); a provider without MCP support
 *    aborts it too. So servers are contributed only when the saved
 *    configuration provably lacks them (`server/agent-record.ts`) and the
 *    provider reports MCP capability — every other state fails safe to
 *    *skip*.
 *
 * The rules below are pure so the whole matrix is unit-testable without a daemon.
 */

import type { AgentRecordLookup } from "./agent-record";

export interface SessionOpenInput {
  /** `create` | `resume` | `refresh` | `import` */
  reason: string;
  /** `interactive` | `history` */
  purpose: string;
  /** Saved `config.mcpServers` keys of the agent about to open. */
  lookup: AgentRecordLookup;
  /** `capabilities.supportsMcpServers`, or `null` when the snapshot was unavailable. */
  supportsMcpServers: boolean | null;
  /** Registry entry for this agent, or `null` when the agent never ran a command with servers. */
  registry: { servers: Record<string, unknown>; commandName: string } | null;
}

export interface SessionOpenDecision {
  /** Server names to contribute launch-only (a subset of the registry entry). */
  contribute: string[];
  /** Why nothing was contributed, when `contribute` is empty. */
  why: string;
}

/** Only these reopen reasons are command-center's business. */
export function contributesForReason(reason: string): boolean {
  return reason === "resume" || reason === "refresh";
}

/**
 * May the plugin still contribute servers to this open at all? Pure mirror of
 * the cheap short-circuits, so `needsCapabilityProbe` can avoid the daemon
 * round trip whenever the answer is already no.
 */
export function mayContribute(input: Pick<SessionOpenInput, "reason" | "purpose" | "registry">): boolean {
  if (input.purpose !== "interactive") return false;
  if (!contributesForReason(input.reason)) return false;
  return input.registry !== null && Object.keys(input.registry.servers).length > 0;
}

/**
 * Whether the hook has to ask the daemon for `supportsMcpServers`. Only when a
 * contribution is genuinely possible: everything else is decided without
 * touching the daemon, so an agent with no registry entry (or one whose saved
 * config already carries every server) costs no extra round trip on open.
 */
export function needsCapabilityProbe(input: SessionOpenInput): boolean {
  return mayContribute(input);
}

/**
 * Decide which registry servers may be contributed launch-only.
 *
 * Fail-safe: an unusable or missing agent record contributes nothing (the
 * launch set is unknown, and guessing could abort the session open); names
 * already present in the saved configuration are dropped individually, so a
 * partially colliding registry entry contributes only the missing subset.
 */
export function decideSessionOpen(input: SessionOpenInput): SessionOpenDecision {
  if (!mayContribute(input)) {
    return {
      contribute: [],
      why: input.purpose !== "interactive"
        ? "skipped: purpose is history"
        : !contributesForReason(input.reason)
          ? `skipped: reason '${input.reason}' is not a command-center reopen`
          : "skipped: no registry entry for this agent",
    };
  }

  if (input.supportsMcpServers === false) {
    return { contribute: [], why: "skipped: provider does not support MCP servers" };
  }
  if (input.supportsMcpServers === null) {
    return { contribute: [], why: "skipped: provider capabilities unknown" };
  }

  if (input.lookup.status !== "found") {
    return {
      contribute: [],
      why: input.lookup.status === "missing"
        ? "skipped: agent record not found on disk"
        : `skipped: agent record unusable (${input.lookup.reason})`,
    };
  }

  const saved = new Set(input.lookup.savedServers);
  const contribute = Object.keys(input.registry!.servers).filter((name) => !saved.has(name));

  if (contribute.length === 0) {
    return {
      contribute: [],
      why: "skipped: saved configuration already carries every registry server",
    };
  }

  const dropped = Object.keys(input.registry!.servers).length - contribute.length;
  return {
    contribute,
    why: `contributing ${contribute.join(", ")} from command '${input.registry!.commandName}'` +
      (dropped > 0 ? ` (${dropped} already saved, dropped)` : ""),
  };
}
