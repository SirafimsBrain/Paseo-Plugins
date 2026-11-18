/**
 * Planning model: the vocabulary of a plan file, ported from
 * `luck-planner`'s `shared/tree.ts` so the migration keeps every status and
 * transition exactly as the source plugin enforced them.
 *
 * This module is pure data and pure functions: no filesystem, no YAML, no
 * Obsidian. Stage 2 uses it to type a parsed frontmatter; later stages use it to
 * validate a transition or a parent-child pair before writing anything.
 */

/** Every file kind the planning model knows. */
export const PLAN_KINDS = [
  "root",
  "trunk",
  "branch",
  "subbranch",
  "leaf",
  "incident",
  "goal",
] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

/** Tree kinds that form the hierarchy; `incident` and `goal` live beside it. */
export const NODE_KINDS = ["root", "trunk", "branch", "subbranch", "leaf"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Allowed parent→child pairs. A leaf ends the chain; branches may hang leaves
 * directly; side branches may nest without a depth limit.
 */
export const ALLOWED_CHILD_KINDS: Record<NodeKind, readonly NodeKind[]> = {
  root: ["trunk"],
  trunk: ["branch"],
  branch: ["subbranch", "leaf"],
  subbranch: ["subbranch", "leaf"],
  leaf: [],
};

export function canHaveChild(parentKind: NodeKind, childKind: NodeKind): boolean {
  return ALLOWED_CHILD_KINDS[parentKind].includes(childKind);
}

/** Statuses every tree node carries (the source schema uses one dictionary). */
export const LEAF_STATUSES = [
  "draft",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "deferred",
  "done",
  "cancelled",
  "superseded",
] as const;
export type LeafStatus = (typeof LEAF_STATUSES)[number];

/**
 * Allowed status transitions. A no-op (same status) is not a transition: the
 * writer treats it as a rejected write rather than a revision bump.
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

export function canTransitionLeaf(from: LeafStatus, to: LeafStatus): boolean {
  return LEAF_TRANSITIONS[from].includes(to);
}

/** Bees: a directed influence from one leaf onto another. */
export const BEE_STATUSES = ["active", "watching", "resolved", "cancelled"] as const;
export type BeeStatus = (typeof BEE_STATUSES)[number];

/** A resolved or cancelled influence can be revived; nothing else moves. */
export const BEE_TRANSITIONS: Record<BeeStatus, readonly BeeStatus[]> = {
  active: ["watching", "resolved", "cancelled"],
  watching: ["active", "resolved", "cancelled"],
  resolved: ["active"],
  cancelled: ["active"],
};

export function canTransitionBee(from: BeeStatus, to: BeeStatus): boolean {
  return BEE_TRANSITIONS[from].includes(to);
}

/** incidents: a defect that blocks one or more leaves. */
export const INCIDENT_STATUSES = ["open", "investigating", "resolved", "cancelled"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Only these incident statuses block their leaves. */
export const BLOCKING_INCIDENT_STATUSES: readonly IncidentStatus[] = ["open", "investigating"];

/** `resolved`/`cancelled` reopen as `open`: a regression is a new investigation. */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ["investigating", "resolved", "cancelled"],
  investigating: ["open", "resolved", "cancelled"],
  resolved: ["open"],
  cancelled: ["open"],
};

export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** goals: a formal task with a step plan, materialised into the tree on approval. */
export const GOAL_STATUSES = [
  "draft",
  "proposed",
  "approved",
  "in_progress",
  "done",
  "cancelled",
  "superseded",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * A goal is approved only from `proposed`; `approved` starts work, `done` may
 * only be superseded. `draft` may be proposed or cancelled, nothing more.
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

/** growth: a progress record attached to one node or goal. */
export const GROWTH_STATUSES = ["active", "stalled", "done", "cancelled"] as const;
export type GrowthStatus = (typeof GROWTH_STATUSES)[number];

export const GROWTH_STEP_STATES = [
  "pending",
  "in_progress",
  "completed",
  "skipped",
  "failed",
] as const;
export type GrowthStepState = (typeof GROWTH_STEP_STATES)[number];

/** A growth record can be revived from `done`/`cancelled`, like a bee. */
export const GROWTH_TRANSITIONS: Record<GrowthStatus, readonly GrowthStatus[]> = {
  active: ["stalled", "done", "cancelled"],
  stalled: ["active", "done", "cancelled"],
  done: ["active"],
  cancelled: ["active"],
};

export function canTransitionGrowth(from: GrowthStatus, to: GrowthStatus): boolean {
  return GROWTH_TRANSITIONS[from].includes(to);
}

/** Why a snapshot was taken; stored as `snapshot_reason`. */
export const SNAPSHOT_REASONS = [
  "status_change",
  "content_update",
  "version_bump",
  "move",
  "archive",
  "restore",
  "link_update",
] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/** The status dictionary that belongs to one kind. */
export function statusesOfKind(kind: PlanKind): readonly string[] {
  if (kind === "incident") return INCIDENT_STATUSES;
  if (kind === "goal") return GOAL_STATUSES;
  return LEAF_STATUSES;
}

/**
 * Whether `from → to` is allowed for a file of this kind. Unknown statuses and
 * a no-op move are always refused: the writer treats them as a rejected write,
 * not as a revision bump.
 */
export function canTransitionStatus(kind: PlanKind, from: string, to: string): boolean {
  if (from === to) return false;
  if (!statusesOfKind(kind).includes(to)) return false;
  if (kind === "incident") {
    return (
      (INCIDENT_STATUSES as readonly string[]).includes(from) &&
      canTransitionIncident(from as IncidentStatus, to as IncidentStatus)
    );
  }
  if (kind === "goal") {
    return (
      (GOAL_STATUSES as readonly string[]).includes(from) &&
      canTransitionGoal(from as GoalStatus, to as GoalStatus)
    );
  }
  return (
    (LEAF_STATUSES as readonly string[]).includes(from) &&
    canTransitionLeaf(from as LeafStatus, to as LeafStatus)
  );
}

export function isPlanKind(value: unknown): value is PlanKind {
  return typeof value === "string" && (PLAN_KINDS as readonly string[]).includes(value);
}

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && (NODE_KINDS as readonly string[]).includes(value);
}

/**
 * Canonical key order of a plan file.
 *
 * Identity and lifecycle first, then the hierarchy and the kind-specific
 * payload, then bookkeeping. Reading never reorders a file (the order in the
 * document is the order the user sees); this order is used when a file is
 * **created** and when a snapshot is written, so new files are predictable.
 */
export const PLAN_KEY_ORDER = [
  "id",
  "schema",
  "kind",
  "name",
  "description",
  "status",
  "version",
  "revision",
  "project_key",
  "parent",
  "children",
  "stack",
  "brief",
  "influences",
  "blocked_by",
  "goal",
  "project",
  "blocks",
  "severity",
  "formal_text",
  "plan",
  "materialized",
  "growth",
  "payload",
  "journal",
  "created",
  "updated",
  "created_by",
  "updated_by",
  "restored_from",
  "aliases",
  "tags",
  "archived",
  "is_snapshot",
  "snapshot_of",
  "snapshot_reason",
  "snapshot_op",
] as const;

/** Orders keys by {@link PLAN_KEY_ORDER}; unknown keys keep their own order at the end. */
export function orderPlanKeys(
  record: Record<string, unknown>,
  order: readonly string[] = PLAN_KEY_ORDER,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of order) {
    if (Object.prototype.hasOwnProperty.call(record, key)) result[key] = record[key];
  }
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = record[key];
  }
  return result;
}

/** `[[Workspaces/a/b|b]]` → `b`; `[[Workspaces/a/b]]` → `b`; anything else as-is. */
export function linkLabel(value: string): string {
  const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(value.trim());
  if (!match) return value;
  if (match[2] && match[2].trim().length > 0) return match[2].trim();
  const target = match[1].split("#")[0];
  const segment = target.split("/").pop() ?? target;
  return segment.replace(/\.md$/i, "");
}
