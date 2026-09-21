import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * A single persisted agent session discovered on the daemon machine.
 *
 * `provider` is the stable store id (cline, opencode, kilo, qwen-code, acpx),
 * not the Paseo provider label, so the UI can group and filter reliably.
 */
export const agentSessionSchema = z.object({
  provider: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  /** True while the owning agent process is still running the session. */
  running: z.boolean(),
  /** Set when a Paseo agent record references this session. */
  paseoAgent: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      archived: z.boolean(),
    })
    .nullable(),
});

export type AgentSession = z.infer<typeof agentSessionSchema>;

export const providerStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The store exists or the agent CLI was found on this machine. */
  detected: z.boolean(),
  /** Deletion is implemented and usable for this provider. */
  deletable: z.boolean(),
  /** Human readable source: session directory, database, or CLI path. */
  detail: z.string(),
  count: z.number(),
  /**
   * Size of the whole store. Database-backed agents keep every transcript in one
   * SQLite file, so per-session sizes are unknown and this is what the panel
   * shows instead.
   */
  storeBytes: z.number().nullable(),
  error: z.string().nullable(),
});

export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const sessionTargetSchema = z.object({
  provider: z.string(),
  id: z.string(),
});

export type SessionTarget = z.infer<typeof sessionTargetSchema>;

export const listSessions = defineRpc({
  name: "session-manager.list",
  input: z.object({
    /** Ignore the short-lived listing cache and rescan every provider. */
    refresh: z.boolean().optional(),
  }),
  output: z.object({
    sessions: z.array(agentSessionSchema),
    providers: z.array(providerStatusSchema),
    scannedAt: z.string(),
  }),
});

export const deleteSession = defineRpc({
  name: "session-manager.delete",
  input: z.object({
    provider: z.string(),
    id: z.string(),
    /** Delete even when the session is running or referenced by an open Paseo agent. */
    force: z.boolean().optional(),
  }),
  output: z.object({
    deleted: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const deleteSessions = defineRpc({
  name: "session-manager.delete-batch",
  input: z.object({
    targets: z.array(sessionTargetSchema),
    force: z.boolean().optional(),
  }),
  output: z.object({
    deleted: z.number(),
    failures: z.array(
      z.object({
        provider: z.string(),
        id: z.string(),
        error: z.string(),
      }),
    ),
  }),
});

export const exportSession = defineRpc({
  name: "session-manager.export",
  input: z.object({
    provider: z.string(),
    id: z.string(),
  }),
  output: z.object({
    exported: z.boolean(),
    /** Absolute path of the written export, on the daemon host. */
    path: z.string().nullable(),
    bytes: z.number().nullable(),
    error: z.string().nullable(),
  }),
});
