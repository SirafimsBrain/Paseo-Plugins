import { z } from "zod";

/**
 * Shared domain schemas for the planning tree (PLAN.md stage B1,
 * `__doc.md` §4.1 and §5). One source of truth for the server store,
 * the MCP tools, and the plugin RPCs — this module must stay importable
 * from both runtimes: no Node, no React, no DOM.
 */

// ── Primitives ───────────────────────────────────────────────────────────

/** Node / entity identifier (uuid issued by the store). */
export const idSchema = z.uuid();

/**
 * Canonical project key — the absolute path of the project the tree
 * belongs to. Every row of every table is scoped by it (ADR-2).
 */
export const projectKeySchema = z.string().min(1);

/** Epoch milliseconds. */
export const timestampSchema = z.number().int().nonnegative();

/** Who performed the mutation: an agent id or the literal `user`. */
export const actorSchema = z.string().min(1);

/** Monotonic per-entity revision, bumped on every mutation (ADR-6). */
export const revisionSchema = z.number().int().positive();

// ── Node kinds ───────────────────────────────────────────────────────────

/**
 * Tree element kinds, mirroring the requirement vocabulary:
 * root = tech stack, trunk = platform↔code link, branch = module/package,
 * subbranch = functions/classes, leaf = a fact (planned / in-dev / done code).
 */
export const nodeKindSchema = z.enum([
  "root",
  "trunk",
  "branch",
  "subbranch",
  "leaf",
]);
export type NodeKind = z.infer<typeof nodeKindSchema>;
export const NODE_KINDS = nodeKindSchema.options;

/**
 * Allowed parent→child kind pairs. The requirement describes a strict
 * hierarchy (root → trunk → branches → side branches → leaves); leaves may
 * also hang directly off a main branch, and side branches may nest.
 */
export const ALLOWED_CHILD_KINDS: Record<NodeKind, readonly NodeKind[]> = {
  root: ["trunk"],
  trunk: ["branch"],
  branch: ["subbranch", "leaf"],
  subbranch: ["subbranch", "leaf"],
  leaf: [],
};

/** Whether a node of `parentKind` may have a child of `childKind`. */
export function canHaveChild(
  parentKind: NodeKind,
  childKind: NodeKind,
): boolean {
  return ALLOWED_CHILD_KINDS[parentKind].includes(childKind);
}

// ── Leaf statuses (exact requirement vocabulary) ─────────────────────────

export const leafStatusSchema = z.enum([
  "draft",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
  "superseded",
]);
export type LeafStatus = z.infer<typeof leafStatusSchema>;
export const LEAF_STATUSES = leafStatusSchema.options;

/**
 * Allowed status transitions (ADR-6). The happy path is
 * draft → ready → claimed → in_progress → done; `blocked` hangs off
 * `in_progress` and resumes back to it. `cancelled` and `superseded` are
 * terminal. `done` may only be superseded (a confirmed fact is replaced by
 * a new plan, never silently cancelled), which is what the goal-replacement
 * cascade (stage C3) relies on.
 */
export const LEAF_TRANSITIONS: Record<LeafStatus, readonly LeafStatus[]> = {
  draft: ["ready", "cancelled", "superseded"],
  ready: ["claimed", "cancelled", "superseded"],
  claimed: ["in_progress", "cancelled", "superseded"],
  in_progress: ["blocked", "done", "cancelled", "superseded"],
  blocked: ["in_progress", "cancelled", "superseded"],
  done: ["superseded"],
  cancelled: [],
  superseded: [],
};

/**
 * Whether a leaf may move from `from` to `to`. A no-op (same status) is
 * reported as `false` — the store treats it as a rejected write, not a
 * revision bump. The state machine is enforced for `kind === "leaf"` only.
 */
export function canTransitionLeaf(from: LeafStatus, to: LeafStatus): boolean {
  return LEAF_TRANSITIONS[from].includes(to);
}

// ── Node ─────────────────────────────────────────────────────────────────

/**
 * A tree node. `payload` is kind-dependent JSON: the tech-stack entry for
 * the root, file/function locations for branches, the plan/fact pair for a
 * leaf (`__doc.md` §5).
 */
export const nodeSchema = z.object({
  id: idSchema,
  projectKey: projectKeySchema,
  parentId: idSchema.nullable(),
  kind: nodeKindSchema,
  name: z.string().min(1),
  description: z.string(),
  status: leafStatusSchema,
  version: z.string(),
  revision: revisionSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  createdBy: actorSchema.nullable(),
  updatedBy: actorSchema.nullable(),
  archivedAt: timestampSchema.nullable(),
});
export type Node = z.infer<typeof nodeSchema>;

// ── Append-only audit (who/when/what/result — mandatory) ─────────────────

export const historyEntityTypeSchema = z.enum([
  "node",
  "bee",
  "bug",
  "goal",
  "growth",
]);
export type HistoryEntityType = z.infer<typeof historyEntityTypeSchema>;

export const historyActionSchema = z.enum([
  "create",
  "update",
  "status",
  "link",
  "unlink",
  "approve",
  "reject",
  "materialize",
  "supersede",
  "archive",
  "restore",
]);
export type HistoryAction = z.infer<typeof historyActionSchema>;

/** One audit row (`history` table, `__doc.md` §5). */
export const historyEntrySchema = z.object({
  id: z.number().int().positive(),
  projectKey: projectKeySchema,
  entityType: historyEntityTypeSchema,
  entityId: idSchema,
  action: historyActionSchema,
  revision: revisionSchema,
  actor: actorSchema.nullable(),
  result: z.string(),
  at: timestampSchema,
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
