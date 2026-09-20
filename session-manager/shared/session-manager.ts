import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const acpxSessionSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  cwd: z.string(),
  agentCommand: z.string(),
  closed: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  streamExists: z.boolean(),
});

export type AcpSession = z.infer<typeof acpxSessionSchema>;

export const listSessions = defineRpc({
  name: "session-manager.list",
  input: z.object({}),
  output: z.object({
    sessions: z.array(acpxSessionSchema),
  }),
});

export const deleteSession = defineRpc({
  name: "session-manager.delete",
  input: z.object({
    id: z.string(),
  }),
  output: z.object({
    deleted: z.boolean(),
  }),
});

export const deleteSessions = defineRpc({
  name: "session-manager.delete-batch",
  input: z.object({
    ids: z.array(z.string()),
  }),
  output: z.object({
    deleted: z.number(),
  }),
});
