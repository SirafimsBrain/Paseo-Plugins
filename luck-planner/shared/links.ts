import { z } from "zod";
import {
  actorSchema,
  idSchema,
  projectKeySchema,
  revisionSchema,
  timestampSchema,
} from "./tree";

/**
 * Shared schemas for the two link domains (PLAN.md stage B1,
 * `__doc.md` §4.2): "bees" — influence links between leaves; "bugs" —
 * incidents blocking a leaf or a group of leaves. Client/server neutral.
 */

// ── Bees: influence links between leaves ─────────────────────────────────

/**
 * Bee status describes whether the influence is still relevant. Kept
 * separate from leaf statuses on purpose: a bee's lifecycle is about the
 * relationship, not about the code fact at either end.
 */
export const beeStatusSchema = z.enum([
  "active",
  "watching",
  "resolved",
  "cancelled",
]);
export type BeeStatus = z.infer<typeof beeStatusSchema>;
export const BEE_STATUSES = beeStatusSchema.options;

/** Allowed bee status transitions. */
export const BEE_TRANSITIONS: Record<BeeStatus, readonly BeeStatus[]> = {
  active: ["watching", "resolved", "cancelled"],
  watching: ["active", "resolved", "cancelled"],
  resolved: ["active"],
  cancelled: ["active"],
};

export function canTransitionBee(from: BeeStatus, to: BeeStatus): boolean {
  return BEE_TRANSITIONS[from].includes(to);
}

/**
 * A bee connects two leaves of the same project; `impact` describes the
 * influence and its degree (`__doc.md` §4.2). Self-loops are rejected by
 * `beeSchema`'s refinement — the store double-checks leaf kinds.
 */
export const beeSchema = z
  .object({
    id: idSchema,
    projectKey: projectKeySchema,
    sourceLeafId: idSchema,
    targetLeafId: idSchema,
    status: beeStatusSchema,
    revision: revisionSchema,
    impact: z.string(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: actorSchema.nullable(),
    updatedBy: actorSchema.nullable(),
  })
  .refine((bee) => bee.sourceLeafId !== bee.targetLeafId, {
    message: "A bee cannot connect a leaf to itself",
    path: ["targetLeafId"],
  });
export type Bee = z.infer<typeof beeSchema>;

// ── Bugs: problems/incidents blocking leaves ─────────────────────────────

export const bugSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type BugSeverity = z.infer<typeof bugSeveritySchema>;
export const BUG_SEVERITIES = bugSeveritySchema.options;

/**
 * Bug lifecycle. `open` bugs attached to a leaf are surfaced as blockers
 * in the leaf details (`__doc.md` §4.2).
 */
export const bugStatusSchema = z.enum([
  "open",
  "investigating",
  "resolved",
  "cancelled",
]);
export type BugStatus = z.infer<typeof bugStatusSchema>;
export const BUG_STATUSES = bugStatusSchema.options;

export const BUG_TRANSITIONS: Record<BugStatus, readonly BugStatus[]> = {
  open: ["investigating", "resolved", "cancelled"],
  investigating: ["open", "resolved", "cancelled"],
  resolved: ["open"],
  cancelled: ["open"],
};

export function canTransitionBug(from: BugStatus, to: BugStatus): boolean {
  return BUG_TRANSITIONS[from].includes(to);
}

/** `open` and `investigating` both block the leaves they are attached to. */
export function isBugBlocking(status: BugStatus): boolean {
  return status === "open" || status === "investigating";
}

export const bugSchema = z.object({
  id: idSchema,
  projectKey: projectKeySchema,
  title: z.string().min(1),
  description: z.string(),
  severity: bugSeveritySchema,
  status: bugStatusSchema,
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  createdBy: actorSchema.nullable(),
  updatedBy: actorSchema.nullable(),
});
export type Bug = z.infer<typeof bugSchema>;

/** m2m attachment: one bug may block a leaf or a group of leaves. */
export const bugNodeSchema = z.object({
  bugId: idSchema,
  nodeId: idSchema,
});
export type BugNode = z.infer<typeof bugNodeSchema>;
