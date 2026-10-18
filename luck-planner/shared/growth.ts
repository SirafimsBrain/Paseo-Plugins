import { z } from "zod";
import {
  actorSchema,
  idSchema,
  projectKeySchema,
  revisionSchema,
  timestampSchema,
} from "./tree";

/**
 * Shared schemas for growth rates (PLAN.md stage B1, `__doc.md` §4.4): the
 * goal → steps → facts structure measuring how far a tree element is from
 * its expected result. Attachable to any element — a node or a goal.
 * Client/server neutral.
 */

export const growthSubjectTypeSchema = z.enum(["node", "goal"]);
export type GrowthSubjectType = z.infer<typeof growthSubjectTypeSchema>;

/** State of one growth step: the fact of completion or non-completion. */
export const growthStepStateSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "skipped",
  "failed",
]);
export type GrowthStepState = z.infer<typeof growthStepStateSchema>;
export const GROWTH_STEP_STATES = growthStepStateSchema.options;

/**
 * One step of a growth record. `reason` carries why the step was not
 * completed or why work stopped (pause, waiting for approval, blocked —
 * required by the "growth rates" spec); `facts` records what was actually
 * done or tried.
 */
export const growthStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  state: growthStepStateSchema,
  facts: z.array(z.string()),
  reason: z.string(),
});
export type GrowthStep = z.infer<typeof growthStepSchema>;

export const growthStatusSchema = z.enum([
  "active",
  "stalled",
  "done",
  "cancelled",
]);
export type GrowthStatus = z.infer<typeof growthStatusSchema>;
export const GROWTH_STATUSES = growthStatusSchema.options;

export const GROWTH_TRANSITIONS: Record<GrowthStatus, readonly GrowthStatus[]> =
  {
    active: ["stalled", "done", "cancelled"],
    stalled: ["active", "done", "cancelled"],
    done: ["active"],
    cancelled: ["active"],
  };

export function canTransitionGrowth(
  from: GrowthStatus,
  to: GrowthStatus,
): boolean {
  return GROWTH_TRANSITIONS[from].includes(to);
}

/** A growth record attached to one node or one goal. */
export const growthSchema = z.object({
  id: idSchema,
  projectKey: projectKeySchema,
  subjectType: growthSubjectTypeSchema,
  subjectId: idSchema,
  steps: z.array(growthStepSchema),
  status: growthStatusSchema,
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  createdBy: actorSchema.nullable(),
  updatedBy: actorSchema.nullable(),
});
export type Growth = z.infer<typeof growthSchema>;

/**
 * Aggregate progress of a growth record — the number the dashboard growth
 * layer renders (share of completed steps; skipped steps do not count as
 * completed but do leave the denominator).
 */
export function growthProgress(steps: readonly GrowthStep[]): {
  total: number;
  completed: number;
  failed: number;
  ratio: number;
} {
  const total = steps.length;
  const completed = steps.filter((s) => s.state === "completed").length;
  const failed = steps.filter((s) => s.state === "failed").length;
  return { total, completed, failed, ratio: total === 0 ? 0 : completed / total };
}

/**
 * Roll-up of one or more growth records — the number the dashboard growth
 * layer (stage G5) paints as a bar and as heat, and the same shape the native
 * panel can use once it shows subtree progress. `records` tells "no data"
 * (`0`) apart from "not a single step completed" (`0/N` completed), which is
 * the distinction the heatmap must not lose.
 */
export interface GrowthSummary {
  total: number;
  completed: number;
  failed: number;
  ratio: number;
  /** How many growth records went into the numbers (0 = no data at all). */
  records: number;
}

/**
 * Aggregates several growth records into one summary, delegating the
 * per-record arithmetic to {@link growthProgress} so a subtree roll-up and a
 * single record can never disagree about what a completed step is.
 */
export function summarizeGrowth(records: readonly Growth[]): GrowthSummary {
  let total = 0;
  let completed = 0;
  let failed = 0;
  for (const record of records) {
    const progress = growthProgress(record.steps);
    total += progress.total;
    completed += progress.completed;
    failed += progress.failed;
  }
  return {
    total,
    completed,
    failed,
    ratio: total === 0 ? 0 : completed / total,
    records: records.length,
  };
}
