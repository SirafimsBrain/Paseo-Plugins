// Type-only import: erased at build time, so the plugin never needs this package
// at install time — only the host's own metadata type is reused.
import type { JsonValue } from "@getpaseo/protocol/agent-types";

/**
 * Plugin-owned `metadata` keys (Paseo 0.16.0, plugin 0.13.0).
 *
 * Two keys, deliberately separate:
 *
 * - `command-center` — a stamp on the agent a prompt command created:
 *   `{ commandId, commandName, runId, at }`. It makes the history entry point
 *   at the agent it spawned, lets "repeat" offer the same agent, and tells other
 *   plugins (and a future export) where the agent came from.
 * - `command-center.provisioning` — how the session-open hook provisioned this
 *   agent: `{ mode: "mcp" | "tool" | "skipped", reason, at }`. When it says
 *   `mcp`, the next open skips the daemon capability probe: the provider already
 *   accepted MCP servers for this agent, so the answer cannot change.
 *
 * Paseo never reads either key; unknown or malformed values resolve to "no
 * claim" instead of a guess, and other plugins' keys are never touched.
 */

export type AgentMetadata = Readonly<Record<string, JsonValue>>;

/** Stamp written onto the agent a run created. */
export const RUN_METADATA_KEY = "command-center";

/** Marker written on every session open. */
export const PROVISIONING_METADATA_KEY = "command-center.provisioning";

/** Stamp written onto a workspace the bootstrap automation provisioned. */
export const WORKSPACE_METADATA_KEY = "command-center";

export type ProvisioningMode = "mcp" | "tool" | "skipped";

export interface ProvisioningMarker {
  mode: ProvisioningMode;
  reason: string;
  at: string;
}

export interface RunStamp {
  commandId: string;
  commandName: string;
  runId: string;
  at: string;
}

export interface WorkspaceStamp {
  commandId: string;
  commandName: string;
  bootstrappedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds the value stored under {@link RUN_METADATA_KEY}. */
export function runStamp(input: RunStamp): Record<string, string> {
  return {
    commandId: input.commandId,
    commandName: input.commandName,
    runId: input.runId,
    at: input.at,
  };
}

/** Reads the run stamp of an agent, or null. */
export function readRunStamp(metadata: AgentMetadata | null | undefined): RunStamp | null {
  if (!metadata) return null;
  const raw = metadata[RUN_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const commandId = typeof raw["commandId"] === "string" ? raw["commandId"] : "";
  if (commandId.length === 0) return null;
  return {
    commandId,
    commandName: typeof raw["commandName"] === "string" ? raw["commandName"] : "",
    runId: typeof raw["runId"] === "string" ? raw["runId"] : "",
    at: typeof raw["at"] === "string" ? raw["at"] : "",
  };
}

/** Builds the marker written on every session open. */
export function provisioningMarker(
  mode: ProvisioningMode,
  reason: string,
  at: string = new Date().toISOString(),
): ProvisioningMarker {
  return { mode, reason, at };
}

/** Reads the provisioning marker, or null for anything unexpected. */
export function readProvisioningMarker(
  metadata: AgentMetadata | null | undefined,
): ProvisioningMarker | null {
  if (!metadata) return null;
  const raw = metadata[PROVISIONING_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const mode = raw["mode"];
  if (mode !== "mcp" && mode !== "tool" && mode !== "skipped") return null;
  return {
    mode,
    reason: typeof raw["reason"] === "string" ? raw["reason"] : "",
    at: typeof raw["at"] === "string" ? raw["at"] : "",
  };
}

/**
 * Returns `metadata` with this plugin's marker replaced, leaving every other key
 * (including other plugins' and the run stamp) as it was.
 */
export function withProvisioningMarker(
  metadata: AgentMetadata | null | undefined,
  marker: ProvisioningMarker | null,
): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = { ...(metadata ?? {}) };
  if (marker === null) {
    delete next[PROVISIONING_METADATA_KEY];
    return next;
  }
  // A fresh literal: an interface does not satisfy the index-signature side of
  // `JsonValue`, an inline object does.
  next[PROVISIONING_METADATA_KEY] = {
    mode: marker.mode,
    reason: marker.reason,
    at: marker.at,
  };
  return next;
}

/** Reads the workspace bootstrap stamp, or null. */
export function readWorkspaceStamp(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): WorkspaceStamp | null {
  if (!metadata) return null;
  const raw = metadata[WORKSPACE_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const bootstrappedAt = typeof raw["bootstrappedAt"] === "string" ? raw["bootstrappedAt"] : "";
  if (bootstrappedAt.length === 0) return null;
  return {
    commandId: typeof raw["commandId"] === "string" ? raw["commandId"] : "",
    commandName: typeof raw["commandName"] === "string" ? raw["commandName"] : "",
    bootstrappedAt,
  };
}

/** Builds the value stored under {@link WORKSPACE_METADATA_KEY}. */
export function workspaceStamp(input: WorkspaceStamp): Record<string, string> {
  return {
    commandId: input.commandId,
    commandName: input.commandName,
    bootstrappedAt: input.bootstrappedAt,
  };
}
