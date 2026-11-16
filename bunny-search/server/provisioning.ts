// Type-only import: erased at build time, so the bundled plugin never needs this
// package at install time — only the host's own metadata type is reused here.
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProvisioningEvent } from "../shared/contracts";

/**
 * Per-agent provisioning marker and the small event log behind the live status
 * stream (0.7.5).
 *
 * ## The marker
 *
 * Paseo 0.16.0 lets `agent.create.before` and `agent.open.before` return
 * `metadata`, stores it on the agent, and exposes it back to the plugin through
 * `PluginHookAgent.metadata` / `PluginSessionOpenRequest.metadata`. This plugin
 * writes one key there — `bunny-search: { mode, reason, at }` — so the daemon
 * itself records *how* an agent was provisioned:
 *
 * - `mcp` — the launch-only MCP server was contributed;
 * - `tool` — only the attached `bunny_web_search` tool was (the shared OpenCode
 *   service, or a provider/session where MCP could not be used);
 * - `skipped` — a gate excluded the agent.
 *
 * The session-open hook reads it back and, when the marker says `mcp`, skips the
 * daemon capability probe it would otherwise need — the provider's answer cannot
 * have changed for an agent it already provisioned. Paseo never reads the key.
 *
 * ## The event log
 *
 * A bounded newest-first ring (20 entries) plus a change listener, so the
 * subscription handler can push a fresh snapshot whenever a decision happens.
 * It is process-local and disposable by design: nothing here is authoritative
 * state, the daemon's agent metadata is.
 */

/** Metadata key this plugin owns. Paseo keeps other plugins' keys untouched. */
export const PROVISIONING_METADATA_KEY = "bunny-search";

export type ProvisioningMode = "mcp" | "tool" | "skipped";

/** Agent metadata exactly as the host stores it. */
export type AgentMetadata = Readonly<Record<string, JsonValue>>;
export type MetadataValue = JsonValue;

export interface ProvisioningMarker {
  mode: ProvisioningMode;
  reason: string;
  at: string;
}

/** Size of the in-memory log and of the snapshot the screen receives. */
export const PROVISIONING_LOG_LIMIT = 20;

const log: ProvisioningEvent[] = [];
/** Listeners get the event that just happened, or null for a status-only change. */
type ProvisioningListener = (event: ProvisioningEvent | null) => void;
const listeners = new Set<ProvisioningListener>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds the marker value written into the agent's metadata. */
export function provisioningMarker(
  mode: ProvisioningMode,
  reason: string,
  at: string = new Date().toISOString(),
): ProvisioningMarker {
  return { mode, reason, at };
}

/**
 * Reads the marker back from an agent's metadata. Anything unexpected — a
 * missing key, a foreign shape, a mode this version does not know — resolves to
 * `null` (no claim), never to a guess.
 */
export function readProvisioningMarker(
  metadata: AgentMetadata | null | undefined,
): ProvisioningMarker | null {
  if (!metadata) return null;
  const raw = metadata[PROVISIONING_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const mode = raw["mode"];
  if (mode !== "mcp" && mode !== "tool" && mode !== "skipped") return null;
  const reason = typeof raw["reason"] === "string" ? raw["reason"] : "";
  const at = typeof raw["at"] === "string" ? raw["at"] : "";
  return { mode, reason, at };
}

/**
 * Returns `metadata` with this plugin's marker replaced, leaving every other
 * key — including other plugins' — as it was. `null` drops the key.
 */
export function withProvisioningMarker(
  metadata: AgentMetadata | null | undefined,
  marker: ProvisioningMarker | null,
): Record<string, MetadataValue> {
  const next: Record<string, JsonValue> = { ...(metadata ?? {}) };
  if (marker === null) delete next[PROVISIONING_METADATA_KEY];
  else {
    // A fresh literal: an interface does not satisfy the index-signature side of
    // `JsonValue`, an inline object does.
    next[PROVISIONING_METADATA_KEY] = {
      mode: marker.mode,
      reason: marker.reason,
      at: marker.at,
    };
  }
  return next;
}

/** Records one decision and wakes every listener. */
export function recordProvisioning(event: ProvisioningEvent): void {
  log.unshift(event);
  if (log.length > PROVISIONING_LOG_LIMIT) log.length = PROVISIONING_LOG_LIMIT;
  for (const listener of listeners) listener(event);
}

/**
 * Wakes every listener without a new decision — used when a connection test or a
 * settings edit changes the status half of the snapshot.
 */
export function notifyStatusChange(): void {
  for (const listener of listeners) listener(null);
}

/** Newest-first copy of the recent decisions. */
export function recentProvisioning(limit: number = PROVISIONING_LOG_LIMIT): ProvisioningEvent[] {
  return log.slice(0, Math.max(0, limit));
}

/** Empties the log (tests, and a settings change that invalidates its meaning). */
export function clearProvisioningLog(): void {
  log.length = 0;
  notifyStatusChange();
}

/** Subscribes to "something changed"; returns the unsubscribe function. */
export function subscribeProvisioning(listener: ProvisioningListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
