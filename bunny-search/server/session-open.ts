/**
 * Decision logic for the `before("agent.session_open")` hook (Paseo 0.14, 0.5.2).
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
 * 2. **Attached agent tool** (`defineAgentTool`, `bunny_web_search`). Delivered by
 *    Paseo's own tool transport, never persisted, and its collision rule is only
 *    against Paseo's own tools and other plugins' tools — never against MCP servers.
 *    It is therefore safe to attach at any time, and it is the fallback for providers
 *    without MCP support and for agents whose saved server cannot be read.
 *
 * Both are additionally filtered by an **injection gate** (§15.2 item 4): the host-wide
 * `injectIntoAgents` switch, an optional per-agent label gate and an optional provider
 * exclusion list. The gate is evaluated before anything else, so a gated-off agent is
 * never touched and never costs a daemon round trip.
 *
 * The rules below are pure so the whole matrix is unit-testable without a daemon.
 */

import type { AgentRecordLookup } from "./agent-record";

/** Values that mean "this agent is opted out" when the label gate is configured. */
const LABEL_OFF_VALUES = new Set(["", "off", "false", "no", "0"]);

export interface SessionOpenInput {
  /** `create` | `resume` | `refresh` | `import` */
  reason: string;
  /** `interactive` | `history` */
  purpose: string;
  provider: string;
  /** `request.labels` — new on the session-open request in 0.14.0. */
  labels: Readonly<Record<string, string>>;
  /** `injectIntoAgents` setting — the single switch for "may bunny-search reach agents". */
  injectIntoAgents: boolean;
  /** Name the MCP server is registered under (the `agent.create` hook's key). */
  serverName: string;
  /** `labelGateKey` setting — empty means no label gate. */
  labelGateKey: string;
  /** `skipProviders` setting — comma-separated provider ids, may be empty. */
  skipProviders: string;
  /** Saved `config.mcpServers` of the agent about to open. */
  lookup: AgentRecordLookup;
  /** `capabilities.supportsMcpServers`, or `null` when the snapshot was unavailable. */
  supportsMcpServers: boolean | null;
}

export interface SessionOpenDecision {
  /** Contribute the launch-only MCP server for `serverName`. */
  injectMcp: boolean;
  /** Attach the `bunny_web_search` agent tool. */
  attachTool: boolean;
  /** Human-readable reason, surfaced in `paseo plugin logs bunny-search`. */
  why: string;
}

/**
 * `skipProviders` as a set: comma-separated, trimmed, case-insensitive.
 * An empty list excludes nothing.
 */
export function providerExcluded(provider: string, skipProviders: string): boolean {
  const excluded = skipProviders
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return excluded.includes(provider.trim().toLowerCase());
}

/**
 * The label gate. No key configured → everything passes. Otherwise the agent must
 * carry `labels[key]` with a value that is not `off` / `false` / `no` / `0` / empty —
 * so `web-search: "on"` opts an agent in, `web-search: "off"` and an absent key both
 * keep it out.
 */
export function labelGateAllows(
  labels: Readonly<Record<string, string>>,
  key: string,
): boolean {
  const wanted = key.trim();
  if (wanted.length === 0) return true;
  const value = labels[wanted];
  if (value === undefined) return false;
  return !LABEL_OFF_VALUES.has(value.trim().toLowerCase());
}

/**
 * Does the `agent.create` hook own the creation-time injection?
 *
 * It does whenever it can make the decision itself, which is exactly when no label
 * gate is configured: `PluginBeforeRequests["agent.create"]` carries only `config`
 * and `env`, **no labels**, so a configured gate cannot be evaluated there. In that
 * case the create hook deliberately injects nothing and this hook takes over for
 * `reason: "create"` as well, where `request.labels` is available.
 */
export function createHookOwnsCreation(input: Pick<SessionOpenInput, "labelGateKey">): boolean {
  return input.labelGateKey.trim().length === 0;
}

/**
 * The gate that applies to both contributions. Returns `null` when the agent may be
 * touched at all, otherwise the reason it may not.
 */
export function injectionGateBlockReason(
  input: Pick<
    SessionOpenInput,
    "injectIntoAgents" | "provider" | "labels" | "labelGateKey" | "skipProviders"
  >,
): string | null {
  if (!input.injectIntoAgents) return "injectIntoAgents is off";
  if (providerExcluded(input.provider, input.skipProviders)) {
    return `provider '${input.provider}' is excluded by skipProviders`;
  }
  if (!labelGateAllows(input.labels, input.labelGateKey)) {
    return `label gate '${input.labelGateKey.trim()}' not satisfied`;
  }
  return null;
}

/**
 * Whether the hook still has to ask the daemon for `supportsMcpServers`.
 *
 * Only when an MCP contribution is genuinely possible: the gate passes, creation is
 * not owned by the `agent.create` hook, and the saved configuration does not already
 * carry the server. Everything else is decided without touching the daemon, so a
 * gated-off or already-provisioned agent costs no extra round trip on open.
 */
export function needsCapabilityProbe(input: SessionOpenInput): boolean {
  if (injectionGateBlockReason(input) !== null) return false;
  if (input.reason === "create" && createHookOwnsCreation(input)) return false;
  if (input.purpose === "history") return false;
  if (savedHasServer(input)) return false;
  return true;
}

function savedHasServer(input: SessionOpenInput): boolean {
  return (
    input.lookup.status === "found" && input.lookup.savedServers.includes(input.serverName)
  );
}

/**
 * Why the MCP server was not contributed, for an agent the gate already let through.
 * Kept exhaustive so the log line always explains itself instead of silently doing
 * nothing.
 */
function mcpBlockReason(input: SessionOpenInput): string | null {
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
  // A gated-off agent gets nothing at all: the tool must not become a back door
  // around `injectIntoAgents`, the label gate or the provider exclusion list.
  const gate = injectionGateBlockReason(input);
  if (gate !== null) return { injectMcp: false, attachTool: false, why: `skipped: ${gate}` };
  if (input.purpose === "history") {
    return { injectMcp: false, attachTool: false, why: "skipped: purpose is history" };
  }
  if (input.reason === "create" && createHookOwnsCreation(input)) {
    return {
      injectMcp: false,
      attachTool: false,
      why: "skipped: reason=create is handled by the agent.create hook",
    };
  }

  const block = mcpBlockReason(input);
  const injectMcp = block === null;

  // The tool is the guaranteed path: it is attached exactly where MCP is not and the
  // agent does not already carry the server — no saved entry, no config-file cover,
  // and no launch-only contribution being made in this same open (which would give
  // the agent two names for the same search).
  const attachTool = !injectMcp && !savedHasServer(input);

  const why = injectMcp
    ? `injecting '${input.serverName}': saved configuration has no such server (${describeLookup(input)})`
    : `attaching bunny_web_search tool only: ${block}`;

  return { injectMcp, attachTool, why };
}

function describeLookup(input: SessionOpenInput): string {
  return input.lookup.status === "found"
    ? `${input.lookup.savedServers.length} saved server(s)`
    : input.lookup.status;
}
