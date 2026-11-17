import type { JsonValue } from "@getpaseo/protocol/agent-types";

/**
 * Per-agent injection marker (0.9.11, Paseo 0.16.0 hook `metadata`).
 *
 * The plugin decides at `agent.create.before` and again at `agent.open.before`
 * how a given agent receives the Obsidian tools: a saved MCP server, an MCP
 * server contributed for this launch, the attached fallback tools, or nothing
 * because the provider's own config file carries the server. Those decisions are
 * made in two processes (the hook reads the agent record from disk) and leave no
 * trace the user can inspect, so "does this agent really have the tools?" was a
 * guess.
 *
 * The marker records the decision in the daemon's own agent `metadata`:
 *
 * ```json
 * { "obsidian-bridge": { "mode": "mcp", "reason": "…", "at": "2026-11-17T…" } }
 * ```
 *
 * The key belongs to this plugin; Paseo keeps other plugins' keys untouched, so
 * `withInjectionMarker` only replaces its own entry.
 *
 * Contract detail (Paseo 0.16.0): `agent.create.before` may return `metadata`,
 * so the create hook writes the marker through its result. `agent.open.before`
 * may change only `env`, `tools` and `mcpServers`; returning `metadata` there
 * fails the whole session open (and with it every prompt), so the open hook
 * writes it through `paseo.agents.ref(id).setMetadata(…)` instead.
 */

/** Metadata key this plugin owns. */
export const INJECTION_METADATA_KEY = "obsidian-bridge";

/**
 * How an agent received the tools:
 * - `mcp` — the stdio MCP server (saved at creation or contributed on open);
 * - `tool` — the attached fallback tools (`obsidian_bridge_*`);
 * - `config` — nothing contributed, because OpenCode/Kilo/Cline read the server
 *   from their own config file;
 * - `skipped` — injection is switched off, a history open, or the saved
 *   configuration already carries the server.
 */
export type InjectionMode = "mcp" | "tool" | "config" | "skipped";

/** Agent metadata exactly as the host stores it. */
export type AgentMetadata = Readonly<Record<string, JsonValue>>;
export type MetadataValue = JsonValue;

export interface InjectionMarker {
  mode: InjectionMode;
  reason: string;
  at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds the marker value written into the agent's metadata. */
export function injectionMarker(
  mode: InjectionMode,
  reason: string,
  at: string = new Date().toISOString(),
): InjectionMarker {
  return { mode, reason, at };
}

/**
 * Reads the marker back from an agent's metadata. Anything unexpected — a
 * missing key, a foreign shape, a mode this version does not know — resolves to
 * `null` (no claim), never to a guess.
 */
export function readInjectionMarker(
  metadata: AgentMetadata | null | undefined,
): InjectionMarker | null {
  if (!metadata) return null;
  const raw = metadata[INJECTION_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const mode = raw["mode"];
  if (mode !== "mcp" && mode !== "tool" && mode !== "config" && mode !== "skipped") return null;
  const reason = typeof raw["reason"] === "string" ? raw["reason"] : "";
  const at = typeof raw["at"] === "string" ? raw["at"] : "";
  return { mode, reason, at };
}

/**
 * Returns `metadata` with this plugin's marker replaced, leaving every other
 * key — including other plugins' — as it was. `null` drops the key.
 */
export function withInjectionMarker(
  metadata: AgentMetadata | null | undefined,
  marker: InjectionMarker | null,
): Record<string, MetadataValue> {
  const next: Record<string, JsonValue> = { ...(metadata ?? {}) };
  if (marker === null) delete next[INJECTION_METADATA_KEY];
  else {
    // A fresh literal: an interface does not satisfy the index-signature side of
    // `JsonValue`, an inline object does.
    next[INJECTION_METADATA_KEY] = {
      mode: marker.mode,
      reason: marker.reason,
      at: marker.at,
    };
  }
  return next;
}
