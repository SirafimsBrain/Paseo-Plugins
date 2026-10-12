import { z } from "zod";
import {
  actorSchema,
  idSchema,
  projectKeySchema,
  revisionSchema,
  timestampSchema,
} from "./tree";

/**
 * Shared schemas for high goals (PLAN.md stage B1, `__doc.md` §4.3). A goal
 * holds the formal natural-language task plus the agent's broken-down plan;
 * it enters the project tree only after the plan is approved (ADR-7).
 * Client/server neutral.
 */

export const goalStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "in_progress",
  "done",
  "cancelled",
  "superseded",
]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;
export const GOAL_STATUSES = goalStatusSchema.options;

/**
 * Allowed goal status transitions (ADR-7). Approval happens only from
 * `proposed` and only through the native panel/RPC (the enforcing call
 * records the approving actor). `superseded` is how a replaced plan marks
 * itself; the store cascades a reset to derived leaves (stage C3,
 * MetaGPT `reset_task` semantics).
 */
export const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  draft: ["proposed", "cancelled"],
  proposed: ["approved", "draft", "cancelled"],
  approved: ["in_progress", "cancelled", "superseded"],
  in_progress: ["done", "cancelled", "superseded"],
  done: ["superseded"],
  cancelled: [],
  superseded: [],
};

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

/** Only a `proposed` goal may be approved. */
export function canApproveGoal(status: GoalStatus): boolean {
  return status === "proposed";
}

/** One atomic step of the agent's plan (`plan_json` entry). */
export const goalStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
});
export type GoalStep = z.infer<typeof goalStepSchema>;

/**
 * A high goal. `materializedNodeId` points at the subtree grown when the
 * plan was approved; it is null until materialization (idempotent, stage
 * C3) and is what a cascading reset follows back to the derived leaves.
 */
export const goalSchema = z.object({
  id: idSchema,
  projectKey: projectKeySchema,
  formalText: z.string().min(1),
  plan: z.array(goalStepSchema),
  status: goalStatusSchema,
  revision: revisionSchema,
  materializedNodeId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  createdBy: actorSchema.nullable(),
  updatedBy: actorSchema.nullable(),
});
export type Goal = z.infer<typeof goalSchema>;
