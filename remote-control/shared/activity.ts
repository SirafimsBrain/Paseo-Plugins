import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Live activity feed (Paseo 0.16.0 plugin subscriptions, stage 1.1.0).
 *
 * The panel and the screen used to poll `state` + `connections.list` every
 * three seconds. This contract replaces that poll for everything that changes
 * on the daemon side: the SSH terminals this plugin opened, the RDP/VNC
 * windows in the session registry, the vault's lock state and whether the
 * console is listening. One snapshot carries all of it, so a reconnecting
 * subscriber is correct after the next push without a replay window.
 *
 * The standalone console keeps its own SSE bridge: it is a browser page served
 * by the plugin, not a plugin client, and it must keep working with the plugin
 * reloaded.
 */

/** A Paseo terminal this plugin opened (see `server/terminals.ts`). */
export const terminalViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  connectionId: z.string().nullable(),
  kind: z.enum(["local", "ssh"]),
  startedAt: z.number().nullable(),
});

export type TerminalView = z.infer<typeof terminalViewSchema>;

/** An RDP/VNC window spawned on the daemon host (see `server/sessions.ts`). */
export const externalSessionViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["rdp", "vnc"]),
  name: z.string(),
  connectionId: z.string(),
  /** Workspace the console was opened from; null when it was not recorded. */
  workspaceId: z.string().nullable(),
  target: z.string(),
  state: z.enum(["running", "exited"]),
  exitCode: z.number().nullable(),
  startedAt: z.number(),
  exitedAt: z.number().nullable(),
});

export type ExternalSessionView = z.infer<typeof externalSessionViewSchema>;

export const vaultViewSchema = z.object({
  initialized: z.boolean(),
  unlocked: z.boolean(),
  entries: z.number().int().nonnegative(),
});

export type VaultView = z.infer<typeof vaultViewSchema>;

/**
 * Why a snapshot was sent: `snapshot` is the one delivered on subscribe, the
 * rest name what changed. Clients use it only for diagnostics — every field of
 * the snapshot is authoritative.
 */
export const activityReasonSchema = z.enum([
  "snapshot",
  "sessions",
  "terminals",
  "vault",
  "state",
]);

export type ActivityReason = z.infer<typeof activityReasonSchema>;

export const activitySnapshotSchema = z.object({
  at: z.string(),
  reason: activityReasonSchema,
  listening: z.boolean(),
  consoleUrl: z.string().nullable(),
  vault: vaultViewSchema,
  terminals: z.array(terminalViewSchema),
  sessions: z.array(externalSessionViewSchema),
});

export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>;

export const activityStream = defineSubscription({
  name: "remote-control.activity",
  input: z.object({}),
  event: activitySnapshotSchema,
});
