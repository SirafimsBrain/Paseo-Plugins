import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { beeSchema, bugSchema, bugSeveritySchema } from "./links";
import { goalSchema, goalStepSchema } from "./goals";
import { growthSchema, growthSubjectTypeSchema } from "./growth";
import {
  actorSchema,
  historyEntrySchema,
  idSchema,
  leafStatusSchema,
  nodeKindSchema,
  nodeSchema,
  projectKeySchema,
} from "./tree";

/**
 * Plugin RPC surface for the Paseo UI ↔ plugin server (PLAN.md stage E1,
 * `__doc.md` §6).
 *
 * One source of truth: the server registers handlers with these contracts in
 * `index.server.ts`, and the native panel (E2), Command Center items (E3) and
 * the settings screen (E4) call them through `useRpc`. Client/server neutral
 * — no Node, no React, no DOM.
 *
 * Every contract carries `projectKey`: the store scopes every read and write
 * by it (ADR-2), so an RPC call can never reach across a project boundary.
 * `actor` defaults to `user` — the audit trail must name who approved or
 * changed something, and the panel acts on behalf of the human.
 */

export const UI_ACTOR = "user";

/** `luck-planner.tree-get`: project overview — roots with their children. */
export const treeGet = defineRpc({
  name: "luck-planner.tree-get",
  input: z.object({
    projectKey: projectKeySchema,
  }),
  output: z.object({
    projectKey: projectKeySchema,
    roots: z.array(
      z.object({
        node: nodeSchema,
        children: z.array(nodeSchema),
      }),
    ),
  }),
});

/** `luck-planner.tree-search`: FTS5 search with optional kind/status filters. */
export const treeSearch = defineRpc({
  name: "luck-planner.tree-search",
  input: z.object({
    projectKey: projectKeySchema,
    query: z.string(),
    kinds: z.array(nodeKindSchema).optional(),
    statuses: z.array(leafStatusSchema).optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  output: z.object({
    matches: z.number().int().nonnegative(),
    results: z.array(
      z.object({
        node: nodeSchema,
        score: z.number(),
        snippet: z.string().nullable(),
      }),
    ),
  }),
});

/** `luck-planner.node-detail`: one node with its history, bees and bugs. */
export const nodeDetail = defineRpc({
  name: "luck-planner.node-detail",
  input: z.object({
    projectKey: projectKeySchema,
    nodeId: idSchema,
  }),
  output: z.object({
    node: nodeSchema,
    path: z.array(nodeSchema),
    children: z.array(nodeSchema),
    bees: z.array(beeSchema),
    bugs: z.array(bugSchema),
    blockingBugs: z.array(bugSchema),
    history: z.array(historyEntrySchema),
    growth: growthSchema.nullable(),
  }),
});

/** `luck-planner.node-set-status`: move a leaf through the state machine. */
export const nodeSetStatus = defineRpc({
  name: "luck-planner.node-set-status",
  input: z.object({
    projectKey: projectKeySchema,
    nodeId: idSchema,
    status: leafStatusSchema,
    actor: actorSchema.optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    node: nodeSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** `luck-planner.goal-approve`: cross the approval gate and materialize. */
export const goalApprove = defineRpc({
  name: "luck-planner.goal-approve",
  input: z.object({
    projectKey: projectKeySchema,
    goalId: idSchema,
    parentBranchId: idSchema,
    actor: actorSchema.optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    goal: goalSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/**
 * `luck-planner.goal-create`: a draft high goal (stage E3 — the ⌘K "New
 * high goal" item). The goal starts as a `draft` and is **not** in the
 * tree (ADR-7); the SDK has no dialog API, so the ⌘K item seeds a draft
 * with placeholder text/steps that the user refines with an agent
 * (`luck_tree_set_goal`) or a later UI stage. The store requires at least
 * one plan step, so the contract does too.
 */
export const goalCreate = defineRpc({
  name: "luck-planner.goal-create",
  input: z.object({
    projectKey: projectKeySchema,
    formalText: z.string().min(1),
    plan: z.array(goalStepSchema).min(1),
    actor: actorSchema.optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    goal: goalSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/**
 * `luck-planner.bug-report`: report an incident from the composer (stage
 * E3 — the `/luck-bug` slash command) or the panel. Severity defaults to
 * `medium`; `nodeIds` attach blocking leaves immediately.
 */
export const bugReport = defineRpc({
  name: "luck-planner.bug-report",
  input: z.object({
    projectKey: projectKeySchema,
    title: z.string().min(1),
    description: z.string().optional(),
    severity: bugSeveritySchema.default("medium"),
    nodeIds: z.array(idSchema).optional(),
    actor: actorSchema.optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    bug: bugSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** `luck-planner.growth-get`: the progress record of one subject. */
export const growthGet = defineRpc({
  name: "luck-planner.growth-get",
  input: z.object({
    projectKey: projectKeySchema,
    subjectType: growthSubjectTypeSchema,
    subjectId: idSchema,
  }),
  output: z.object({
    growth: growthSchema.nullable(),
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    ratio: z.number(),
  }),
});

/** `luck-planner.stats`: panel counters for one project. */
export const stats = defineRpc({
  name: "luck-planner.stats",
  input: z.object({
    projectKey: projectKeySchema,
  }),
  output: z.object({
    projectKey: projectKeySchema,
    nodes: z.object({
      total: z.number().int().nonnegative(),
      byKind: z.array(
        z.object({ kind: nodeKindSchema, count: z.number().int().nonnegative() }),
      ),
      byStatus: z.array(
        z.object({ status: leafStatusSchema, count: z.number().int().nonnegative() }),
      ),
    }),
    leaves: z.object({
      total: z.number().int().nonnegative(),
      inProgress: z.number().int().nonnegative(),
      done: z.number().int().nonnegative(),
    }),
    bees: z.number().int().nonnegative(),
    bugs: z.object({
      total: z.number().int().nonnegative(),
      open: z.number().int().nonnegative(),
    }),
    goals: z.object({
      total: z.number().int().nonnegative(),
      proposed: z.number().int().nonnegative(),
      approved: z.number().int().nonnegative(),
    }),
    growthRecords: z.number().int().nonnegative(),
  }),
});

export const RPC_CONTRACT_NAMES = [
  treeGet.name,
  treeSearch.name,
  nodeDetail.name,
  nodeSetStatus.name,
  goalApprove.name,
  goalCreate.name,
  bugReport.name,
  growthGet.name,
  stats.name,
] as const;
