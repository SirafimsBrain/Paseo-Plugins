import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Shared contracts for the memory-flash-client plugin (Paseo UI ↔ plugin
 * server).
 *
 * A "connection" is one remote memory host: a machine running the
 * memory-flash plugin with its HTTP MCP endpoint enabled. The connection
 * carries the endpoint URL and the API key generated there; the key is
 * shown once on the memory host and pasted here by the user.
 *
 * The client identity (UUID + hostname) lives in plugin settings, not in
 * the connection, so every connection of this host presents the same
 * identity to the memory host.
 */

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** Health of a connection, as observed by the last check. */
export const connectionStatusSchema = z
  .enum(["unknown", "ok", "error"])
  .default("unknown");

/** One remote memory host as shown in the UI. Never carries the full key. */
export const connectionSchema = z.object({
  id: z.string(),
  /** Human-readable name, e.g. "office-memory" or the host address. */
  label: z.string().min(1).max(80),
  /**
   * MCP endpoint URL of the memory host, e.g. `http://100.64.0.2:8787/mcp`.
   * The memory-flash plugin's HTTP server serves MCP at `/mcp`.
   */
  url: z.string().trim().min(1).max(500),
  /**
   * The API key (`mf_live_…`) generated on the memory host. The plugin
   * stores it verbatim in its private `connections.json` (mode 600) so it
   * can authenticate the injected MCP config; it is never sent to an
   * agent prompt, written to git, or logged. The UI shows only the prefix.
   */
  secret: z.string().min(1),
  /** First characters of the secret, for recognizing it in the UI. */
  keyPrefix: z.string(),
  /** Injected into agents when the connection is enabled. */
  enabled: z.boolean().default(true),
  status: connectionStatusSchema,
  lastError: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
});

/** A connection as returned to the UI: the secret is stripped. */
export const connectionViewSchema = connectionSchema.omit({ secret: true });

export type Connection = z.infer<typeof connectionSchema>;
export type ConnectionView = z.infer<typeof connectionViewSchema>;

// ---------------------------------------------------------------------------
// Connection check (verify a host running memory-flash is reachable)
// ---------------------------------------------------------------------------

/**
 * Result of probing a memory host: `GET /healthz` (liveness) plus
 * `POST /mcp` `initialize` and `tools/list` with the Bearer key (the
 * handshake a real agent performs). All steps must pass for `ok`.
 */
export const connectionCheckSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["ok", "error"]),
  latencyMs: z.number().int().nullable(),
  /** First failure, human-readable (401 → "the API key was rejected"). */
  error: z.string().nullable(),
  /** Server name reported by the memory host in the MCP handshake. */
  serverName: z.string().nullable(),
  /** Number of tools the memory host exposed to this key. */
  toolCount: z.number().int().nullable(),
  checkedAt: z.string(),
});

export type ConnectionCheck = z.infer<typeof connectionCheckSchema>;

// ---------------------------------------------------------------------------
// Conflict check (memory-flash-client next to memory-flash on one host)
// ---------------------------------------------------------------------------

/**
 * Coexistence report. memory-flash-client and memory-flash are *not*
 * mutually exclusive: the client may sit on the same machine as a memory
 * host, or next to a second memory-flash instance. The check makes the
 * situation explicit so a user who expected only a client (or expected a
 * memory host) sees why two plugins are present.
 */
export const conflictCheckSchema = z.object({
  /**
   * Always false today — the two plugins have disjoint surfaces and
   * store data. It is computed rather than hard-coded so that a future
   * real overlap (same MCP server name, same port, same store) has a
   * place to surface as a blocking conflict.
   */
  conflict: z.boolean(),
  /** Whether the memory-flash plugin is installed on this host. */
  memoryFlashInstalled: z.boolean(),
  /** Whether this client is the only memory-flash on the host (always true). */
  singleMemoryHost: z.boolean(),
  /**
   * Advisory note rendered in the UI when both plugins are present, e.g.
   * "memory-flash and memory-flash-client run on this host — this is
   * allowed; agents get the local stdio server and the remote HTTP one."
   */
  note: z.string().nullable(),
});

export type ConflictCheck = z.infer<typeof conflictCheckSchema>;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Runtime status of this client: identity + connection summary. */
export const clientStatusSchema = z.object({
  clientId: z.string(),
  hostname: z.string(),
  /** Effective host label shown to memory hosts (hostname override or OS name). */
  identityHost: z.string(),
  totalConnections: z.number().int(),
  enabledConnections: z.number().int(),
  okConnections: z.number().int(),
  injectIntoAgents: z.boolean(),
  mcpServerName: z.string(),
  /** Where the connections file lives (diagnostic; contains no secret). */
  connectionsPath: z.string(),
});

export type ClientStatus = z.infer<typeof clientStatusSchema>;

// ---------------------------------------------------------------------------
// RPC surface (Paseo UI ↔ plugin server)
// ---------------------------------------------------------------------------

export const listConnections = defineRpc({
  name: "memory-flash-client.connections",
  input: z.object({}),
  output: z.object({ connections: z.array(connectionViewSchema) }),
});

/** Create or update a connection. The secret is written, never returned. */
export const saveConnection = defineRpc({
  name: "memory-flash-client.connections-save",
  input: z.object({ connection: connectionSchema.omit({ keyPrefix: true, status: true, lastError: true, checkedAt: true }) }),
  output: z.object({ ok: z.boolean(), id: z.string(), error: z.string().nullable() }),
});

export const deleteConnection = defineRpc({
  name: "memory-flash-client.connections-delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

/** Probe a connection (health + MCP handshake with the stored key). */
export const checkConnection = defineRpc({
  name: "memory-flash-client.connections-check",
  input: z.object({ id: z.string() }),
  output: connectionCheckSchema,
});

/** Probe an unsaved URL + key pair (the "Test" button in the add form). */
export const checkConnectionDraft = defineRpc({
  name: "memory-flash-client.connections-check-draft",
  input: z.object({ url: z.string().trim().min(1).max(500), secret: z.string().min(1).max(400) }),
  output: connectionCheckSchema,
});

export const clientStatus = defineRpc({
  name: "memory-flash-client.status",
  input: z.object({}),
  output: clientStatusSchema,
});

export const conflictCheck = defineRpc({
  name: "memory-flash-client.conflict-check",
  input: z.object({}),
  output: conflictCheckSchema,
});

/**
 * Regenerates the client UUID. Rarely needed (e.g. the identity leaked);
 * the hostname is left untouched. Returns the new UUID.
 */
export const regenerateClientId = defineRpc({
  name: "memory-flash-client.regenerate-id",
  input: z.object({}),
  output: z.object({ clientId: z.string() }),
});
