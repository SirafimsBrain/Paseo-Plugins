import { z } from "zod";
import {
  actorSchema,
  idSchema,
  leafStatusSchema,
  nodeKindSchema,
  projectKeySchema,
} from "./tree";
import { beeStatusSchema, bugSeveritySchema, bugStatusSchema } from "./links";
import { goalStepSchema } from "./goals";
import {
  growthStatusSchema,
  growthStepSchema,
  growthSubjectTypeSchema,
} from "./growth";

/**
 * Shared input contracts for the agent-facing MCP tools (PLAN.md stage D1,
 * `__doc.md` §6, ADR-3). One source of truth: the stdio server validates
 * with these schemas and the dispatch tests assert against them. Client/
 * server neutral — no Node, no React.
 *
 * Every input carries `projectKey`: agents address the tree of one concrete
 * project, and the store scopes every read and write by it (ADR-2), so a
 * tool call can never reach across a project boundary. `actor` is optional
 * here and falls back to the dispatch context's default (the agent id the
 * MCP server was launched with) — the audit trail must never be empty.
 */

export const MCP_TOOL_NAMES = [
  "luck_tree_get_context",
  "luck_tree_search",
  "luck_tree_upsert_leaf",
  "luck_tree_upsert_node",
  "luck_tree_move_node",
  "luck_tree_archive_node",
  "luck_tree_add_bee",
  "luck_tree_report_bug",
  "luck_tree_find_bugs",
  "luck_tree_find_goals",
  "luck_tree_approve_goal",
  "luck_tree_set_goal",
  "luck_tree_update_growth",
  "luck_tree_history",
  "luck_tree_export",
  "luck_tree_import",
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Optional blocks of a node-mode `luck_tree_get_context` answer. The names
 * are the response keys, so `sections: ["blockingBugs"]` asks for exactly
 * one block and the answer omits the rest — on a large node the full answer
 * is mostly irrelevant to the agent asking, and context is the budget that
 * matters. `node` and `parentId` are always present.
 */
export const contextSectionSchema = z.enum([
  "path",
  "children",
  "siblings",
  "bees",
  "blockingBugs",
  "growth",
  "beeCycle",
]);
export type ContextSection = z.infer<typeof contextSectionSchema>;
export const CONTEXT_SECTIONS = contextSectionSchema.options;

/**
 * `luck_tree_get_context`: the "where am I / what is around" call. Without
 * `nodeId` it answers with the project overview — roots and their first
 * level of children — so an agent starting a session can pick a trunk to
 * descend into. With `nodeId` it answers with the full path
 * root → … → node, the node's children, its sibling leaves, the bees
 * touching it, its blocking bugs and its growth progress.
 *
 * Three optional fields narrow that answer (stage L1, additive — a call
 * without them answers exactly as before):
 *
 * - `sections` picks blocks of a node answer (ignored for the overview);
 * - `depth` descends below each root in the overview (1 = the classic
 *   roots + first level);
 * - `limit` caps every listing and reports what it dropped.
 */
export const getContextInputSchema = z.object({
  projectKey: projectKeySchema,
  nodeId: idSchema.optional(),
  sections: z.array(contextSectionSchema).optional(),
  depth: z.number().int().min(1).max(3).optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type GetContextInput = z.infer<typeof getContextInputSchema>;

/** `luck_tree_search`: FTS5 search with optional kind/status filters. */
export const searchInputSchema = z.object({
  projectKey: projectKeySchema,
  query: z.string(),
  kinds: z.array(nodeKindSchema).optional(),
  statuses: z.array(leafStatusSchema).optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

/**
 * `luck_tree_upsert_leaf`: one call to record a planned or confirmed fact.
 * With `leafId` it updates that leaf (any mutable field plus an optional
 * status transition in the same call); without it, it creates a leaf under
 * `parentId` — `name` is required for a create, and omitting `parentId` is
 * allowed only for the very first leaf of a fresh project (the store then
 * bootstraps the skeleton root → trunk → branch, stage D3). `payload`
 * carries the plan/fact pair, `version` the code/fact version
 * (`__doc.md` §5).
 */
export const upsertLeafInputSchema = z.object({
  projectKey: projectKeySchema,
  leafId: idSchema.optional(),
  parentId: idSchema.optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  status: leafStatusSchema.optional(),
  actor: actorSchema.optional(),
});
export type UpsertLeafInput = z.infer<typeof upsertLeafInputSchema>;

/** `luck_tree_add_bee`: a directed influence edge between two leaves. */
export const addBeeInputSchema = z.object({
  projectKey: projectKeySchema,
  sourceLeafId: idSchema,
  targetLeafId: idSchema,
  impact: z.string().optional(),
  status: beeStatusSchema.optional(),
  actor: actorSchema.optional(),
});
export type AddBeeInput = z.infer<typeof addBeeInputSchema>;

/** `luck_tree_report_bug`: an incident, optionally blocking leaves now. */
export const reportBugInputSchema = z.object({
  projectKey: projectKeySchema,
  title: z.string().min(1),
  description: z.string().optional(),
  severity: bugSeveritySchema,
  /** Initial status (defaults to `open`). */
  status: bugStatusSchema.optional(),
  nodeIds: z.array(idSchema).optional(),
  actor: actorSchema.optional(),
});
export type ReportBugInput = z.infer<typeof reportBugInputSchema>;

/** `luck_tree_find_bugs`: list incidents of a project, optionally filtered by status. */
export const findBugsInputSchema = z.object({
  projectKey: projectKeySchema,
  /** Filter by bug status: `open`, `investigating`, `resolved`, `cancelled`. Omit for all. */
  status: z.enum(["open", "investigating", "resolved", "cancelled"]).optional(),
  /** Maximum number of incidents to return (default 50). */
  limit: z.number().int().positive().max(200).optional(),
  actor: actorSchema.optional(),
});
export type FindBugsInput = z.infer<typeof findBugsInputSchema>;

/** `luck_tree_find_goals`: list high goals of a project, optionally filtered by status. */
export const findGoalsInputSchema = z.object({
  projectKey: projectKeySchema,
  /** Filter by goal status: `draft`, `proposed`, `approved`, `in_progress`, `done`, `cancelled`, `superseded`. Omit for all. */
  status: z.enum([
    "draft",
    "proposed",
    "approved",
    "in_progress",
    "done",
    "cancelled",
    "superseded",
  ]).optional(),
  /** Maximum number of goals to return (default 50). */
  limit: z.number().int().positive().max(200).optional(),
  actor: actorSchema.optional(),
});
export type FindGoalsInput = z.infer<typeof findGoalsInputSchema>;

/** `luck_tree_approve_goal`: cross the approval gate and materialize the goal's subtree. */
export const approveGoalInputSchema = z.object({
  projectKey: projectKeySchema,
  goalId: idSchema,
  /**
   * Live branch (or subbranch) the goal's side branch grows under. Omitted
   * (stage L10) means the policy decides: the default branch of the project's
   * only tree. A project with several trees refuses and names them — the
   * caller must say which tree the goal belongs to.
   */
  parentBranchId: idSchema.nullable().optional(),
  actor: actorSchema.optional(),
});
export type ApproveGoalInput = z.infer<typeof approveGoalInputSchema>;

/**
 * `luck_tree_set_goal`: agents manage a high goal only **before** the
 * approval gate — `create` a draft, `update` a draft/proposed plan, or
 * `propose` it for human review. There is deliberately no `approve`
 * action: approval is the human's (or the managing agent's) call through
 * the native panel/RPC, and the store refuses `approved` from any other
 * path (ADR-7, stage C3).
 */
export const setGoalActionSchema = z.enum(["create", "update", "propose"]);
export type SetGoalAction = z.infer<typeof setGoalActionSchema>;

export const setGoalInputSchema = z.object({
  projectKey: projectKeySchema,
  action: setGoalActionSchema,
  goalId: idSchema.optional(),
  formalText: z.string().min(1).optional(),
  plan: z.array(goalStepSchema).optional(),
  actor: actorSchema.optional(),
});
export type SetGoalInput = z.infer<typeof setGoalInputSchema>;

/**
 * `luck_tree_update_growth`: upsert of the progress record of one subject
 * (a node or a goal). With `growthId` it updates that record; otherwise it
 * resolves the subject's record — updating it when one exists, attaching a
 * fresh one (steps required) when none does.
 */
export const updateGrowthInputSchema = z.object({
  projectKey: projectKeySchema,
  subjectType: growthSubjectTypeSchema,
  subjectId: idSchema,
  growthId: idSchema.optional(),
  steps: z.array(growthStepSchema).optional(),
  status: growthStatusSchema.optional(),
  actor: actorSchema.optional(),
});
export type UpdateGrowthInput = z.infer<typeof updateGrowthInputSchema>;

/** `luck_tree_history`: the append-only audit trail of one entity. */
export const historyInputSchema = z.object({
  projectKey: projectKeySchema,
  entityId: idSchema,
});
export type HistoryInput = z.infer<typeof historyInputSchema>;

/**
 * `luck_tree_upsert_node`: create or update a node of **any** kind.
 *
 * The leaf-level tool (`luck_tree_upsert_leaf`) is deliberately narrow, and
 * that narrowness has a cost the stage-D4 test pass made visible: an agent
 * could add facts but could not shape the *structure* — the auto-created
 * skeleton stayed "Trunk → General" forever, and a project with four
 * functional areas could only be described as one flat list of leaves. The
 * store has always supported the structural kinds; this tool exposes them:
 *
 * - **create** — `kind` plus `name` (and optionally `parentId`): a trunk
 *   under a root, a branch under a trunk, a side branch under a branch. The
 *   store validates the parent/child kinds, so an impossible shape is
 *   refused with the reason.
 * - **update** — `nodeId` plus any of `name`, `description`, `version`,
 *   `payload`: the way the generic skeleton names ("Trunk", "General") get
 *   their real names.
 */
export const upsertNodeInputSchema = z.object({
  projectKey: projectKeySchema,
  /** The node to update; omit it to create a new one. */
  nodeId: idSchema.optional(),
  /** The kind of the created node (ignored when updating). */
  kind: nodeKindSchema.optional(),
  /** The parent of the created node; `null` is valid for a root only. */
  parentId: idSchema.nullable().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  status: leafStatusSchema.optional(),
  actor: actorSchema.optional(),
});
export type UpsertNodeInput = z.infer<typeof upsertNodeInputSchema>;

/**
 * `luck_tree_move_node`: re-parents a node (with its whole subtree).
 *
 * The tree's shape is a decision an agent revisits: the area a fact belongs
 * to changes when the project is understood better. The store validates the
 * new parent/child kinds and refuses a move that would create a cycle.
 */
export const moveNodeInputSchema = z.object({
  projectKey: projectKeySchema,
  nodeId: idSchema,
  newParentId: idSchema,
  actor: actorSchema.optional(),
});
export type MoveNodeInput = z.infer<typeof moveNodeInputSchema>;

/**
 * `luck_tree_archive_node`: soft-deletes a node **and its whole subtree**.
 *
 * Archiving, not deleting: the audit trail keeps the row and the history
 * stays readable, while the tree (and every diagram built from it) stops
 * showing it. It is the way an agent cleans up a fact it wrote in the wrong
 * place — and it is reversible for a human through the panel.
 */
export const archiveNodeInputSchema = z.object({
  projectKey: projectKeySchema,
  nodeId: idSchema,
  actor: actorSchema.optional(),
});
export type ArchiveNodeInput = z.infer<typeof archiveNodeInputSchema>;

/**
 * `luck_tree_export`: one project as a portable `.json.zip`.
 *
 * The counterpart of the dashboard's download link: an agent that is about to
 * restructure a large subtree, or a user asking for a copy of what is known,
 * gets a single archive instead of a dump of tool output. The document itself
 * is described in `shared/export.ts`.
 *
 * - `includeHistory` (default `true`) carries the audit trail; turning it off
 *   drops rows the importer cannot use anyway when only the tree is wanted.
 * - `path` must be absolute. Omitted, the archive lands in the plugin's
 *   `backups/` directory under a date-stamped name, so an agent never has to
 *   guess where the user keeps files.
 */
export const exportInputSchema = z.object({
  projectKey: projectKeySchema,
  includeHistory: z.boolean().optional(),
  path: z.string().min(1).optional(),
});
export type ExportInput = z.infer<typeof exportInputSchema>;

/**
 * `luck_tree_import` (stage L5): the way back from an export.
 *
 * - `file` must be absolute: the agent writes into the user's filesystem, and
 *   a relative path would resolve against an agent working directory nobody
 *   chose.
 * - `projectKey` is required, like every other write tool: an agent that is
 *   about to add a whole tree names where it goes instead of inheriting the
 *   file's key by accident.
 * - `dryRun` defaults to **true** here, unlike the RPC: an agent asking to
 *   import is about to add a whole tree it has never seen, so the first call
 *   answers `would this work, and how big is it` for free, and the write needs
 *   an explicit `dryRun: false`.
 * - `includeArchived` (default true) is the policy the export deliberately did
 *   not decide: a tree-only copy skips soft-deleted nodes and the rows that
 *   hang off them, and says so in `warnings`.
 */
export const importInputSchema = z.object({
  projectKey: projectKeySchema,
  file: z.string().min(1),
  includeArchived: z.boolean().optional(),
  includeHistory: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});
export type ImportInput = z.infer<typeof importInputSchema>;
