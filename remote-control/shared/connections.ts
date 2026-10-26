// Connection model (stage D1). Groups form an arbitrary hierarchy (adjacency
// list); connections belong to a group (or the root when groupId is null) and
// carry protocol-specific payload + secret references (names only, never
// values — those live in the pass vault).

import { z } from "zod";

export const groupSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  name: z.string().min(1),
  sortOrder: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  archivedAt: z.number().int().nullable(),
});
export type Group = z.infer<typeof groupSchema>;

export const connectionProtocolSchema = z.enum(["ssh", "rdp", "vnc"]);
export type ConnectionProtocol = z.infer<typeof connectionProtocolSchema>;

export const connectionSchema = z.object({
  id: z.string().min(1),
  groupId: z.string().nullable(),
  name: z.string().min(1),
  protocol: connectionProtocolSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable(),
  username: z.string(),
  payload: z.record(z.string(), z.unknown()),
  secretRefs: z.record(z.string(), z.string()),
  sortOrder: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  archivedAt: z.number().int().nullable(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const newGroupInputSchema = z.object({
  parentId: z.string().nullable().optional(),
  name: z.string().min(1),
});
export type NewGroupInput = z.infer<typeof newGroupInputSchema>;

export const newConnectionInputSchema = z.object({
  groupId: z.string().nullable().optional(),
  name: z.string().min(1),
  protocol: connectionProtocolSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  username: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  secretRefs: z.record(z.string(), z.string()).optional(),
});
export type NewConnectionInput = z.infer<typeof newConnectionInputSchema>;
