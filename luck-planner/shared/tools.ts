import { z } from "zod";
import {
  actorSchema,
  idSchema,
  leafStatusSchema,
  nodeKindSchema,
  projectKeySchema,
} from "./tree";
import { beeStatusSchema, bugSeveritySchema } from "./links";
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
  "luck_tree_add_bee",
  "luck_tree_report_bug",
  "luck_tree_set_goal",
  "luck_tree_update_growth",
  "luck_tree_history",
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * `luck_tree_get_context`: the "where am I / what is around" call. Without
 * `nodeId` it answers with the project overview — roots and their first
 * level of children — so an agent starting a session can pick a trunk to
 * descend into. With `nodeId` it answers with the full path
 * root → … → node, the node's children, its sibling leaves, the bees
 * touching it, its blocking bugs and its growth progress.
 */
export const getContextInputSchema = z.object({
  projectKey: projectKeySchema,
  nodeId: idSchema.optional(),
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
  nodeIds: z.array(idSchema).optional(),
  actor: actorSchema.optional(),
});
export type ReportBugInput = z.infer<typeof reportBugInputSchema>;

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
