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

/**
 * The actor recorded when a **person** writes: the dashboard and the native
 * panel act on the owner's behalf. Lives here rather than in `rpc.ts` so the
 * store can compare against it without importing the RPC/SDK layer (0.51.1
 * added the agent-override reason rule, which the store enforces).
 */
export const UI_ACTOR = "user";

// ── Leaf statuses (exact requirement vocabulary) ─────────────────────────

export const leafStatusSchema = z.enum([
  "draft",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "deferred",
  "done",
  "cancelled",
  "superseded",
]);
export type LeafStatus = z.infer<typeof leafStatusSchema>;
export const LEAF_STATUSES = leafStatusSchema.options;

/**
 * Allowed status transitions (ADR-6). The happy path is
 * draft → ready → claimed → in_progress → done; `blocked` hangs off
 * `in_progress` and resumes back to it. `deferred` (0.51.1) is the owner's
 * "not now": any started-but-unfinished state can be set aside and picked up
 * again, which `blocked` cannot express — a blocker is a fact about the work,
 * a deferral is a decision about the schedule. `cancelled` and `superseded`
 * are terminal. `done` may only be superseded (a confirmed fact is replaced by
 * a new plan, never silently cancelled), which is what the goal-replacement
 * cascade (stage C3) relies on.
 */
export const LEAF_TRANSITIONS: Record<LeafStatus, readonly LeafStatus[]> = {
  draft: ["ready", "deferred", "cancelled", "superseded"],
  ready: ["claimed", "deferred", "cancelled", "superseded"],
  claimed: ["in_progress", "deferred", "cancelled", "superseded"],
  in_progress: ["blocked", "deferred", "done", "cancelled", "superseded"],
  blocked: ["in_progress", "deferred", "cancelled", "superseded"],
  deferred: ["ready", "claimed", "in_progress", "cancelled", "superseded"],
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

/**
 * The latest **status** audit row of one entity (0.51.2).
 *
 * The board needs to say "an agent moved this, and here is why" without asking
 * for one history page per card, so `/api/tree` carries the newest status row
 * per entity: a handful of rows, not the whole trail. `result` keeps the store's
 * exact wording (`deferred → in_progress — step 2 depends on step 1`), and
 * {@link statusOverrideReason} is the one place that reads the reason out of it.
 */
export const statusNoteSchema = z.object({
  entityType: historyEntityTypeSchema,
  entityId: idSchema,
  actor: actorSchema.nullable(),
  revision: revisionSchema,
  result: z.string(),
  at: timestampSchema,
});
export type StatusNote = z.infer<typeof statusNoteSchema>;

/**
 * The reason an agent gave for a status move, or `null` when there is none.
 *
 * A person's own move never carries a reason (they answer to themselves), and
 * the audit row is the authority on the rest: the store writes
 * `<from> → <to> — <reason>` for an override, so the first em dash separates
 * the transition from the explanation. A reason that itself contains the
 * separator survives: only the first one is split on.
 */
export function statusOverrideReason(note: StatusNote): string | null {
  if (note.actor === UI_ACTOR) return null;
  const separator = " — ";
  const index = note.result.indexOf(separator);
  if (index < 0) return null;
  const reason = note.result.slice(index + separator.length).trim();
  return reason.length > 0 ? reason : null;
}
