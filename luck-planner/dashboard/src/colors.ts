/**
 * Semantic colour palette of the diagram (PLAN.md stage G1).
 *
 * One module, two consumers: the legend renders it now, and the custom nodes
 * and edges of stage G3 read the very same hexes, so a legend swatch can never
 * drift from the shape it describes. Colours are chosen for a dark canvas but
 * work on the light theme too (all pairs clear 3:1 against both backgrounds);
 * every status is additionally labelled in text wherever it is shown — colour
 * alone never carries state (accessibility rule, asserted in the G3 review).
 *
 * Pure data, no DOM: `tests/dashboard-theme.test.ts` checks that every kind
 * and status has an entry, which is what would otherwise silently break the
 * legend the first time an enum grows.
 */
import { LEAF_STATUSES, NODE_KINDS } from "../../shared/tree";
import type { LeafStatus, NodeKind } from "../../shared/tree";
import { GOAL_STATUSES } from "../../shared/goals";
import type { GoalStatus } from "../../shared/goals";
import { BEE_STATUSES, BUG_STATUSES } from "../../shared/links";
import type { BeeStatus, BugStatus } from "../../shared/links";
import { GROWTH_STATUSES } from "../../shared/growth";
import type { GrowthStatus } from "../../shared/growth";

/** Fill colour of a node shape, by node kind. */
export const KIND_COLORS: Record<NodeKind, string> = {
  root: "#8b7cf6", // tech-stack root — the one purple shape
  trunk: "#5b9dff", // trunk
  branch: "#3fa796", // branch
  subbranch: "#2f855a", // side branch — quieter than its parent
  leaf: "#4c5666", // leaves are the work surface, not a signal
};

/** Accent colour of a leaf's status bar, by leaf status. */
export const STATUS_COLORS: Record<LeafStatus, string> = {
  draft: "#8b93a3",
  ready: "#5b9dff",
  claimed: "#b48ddb",
  in_progress: "#e0a84f",
  blocked: "#e05d5d",
  done: "#4fa860",
  cancelled: "#5c6470",
  superseded: "#6b7280",
};

/** Short human labels, shown in the legend and node captions. */
export const KIND_LABELS: Record<NodeKind, string> = {
  root: "Tech-stack root",
  trunk: "Trunk",
  branch: "Branch",
  subbranch: "Side branch",
  leaf: "Leaf (fact)",
};

/** Human labels of the leaf statuses (the exact domain vocabulary). */
export const STATUS_LABELS: Record<LeafStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  claimed: "Claimed",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

/** Emoji glyph of a node kind, mirroring the native panel's vocabulary. */
export const KIND_GLYPHS: Record<NodeKind, string> = {
  root: "⚙️",
  trunk: "🪵",
  branch: "📦",
  subbranch: "📂",
  leaf: "🍃",
};

/**
 * Lifecycle fraction a leaf's status bar fills up to (stage G3). The bar is
 * the *position* in plan → work → done; the status colour and the status
 * text next to it carry which status it actually is, so the bar never has to
 * invent a meaning of its own. Capped at 1, monotonically ordered along the
 * happy path (`tests/dashboard-theme.test.ts` pins both properties).
 */
export const STATUS_PROGRESS: Record<LeafStatus, number> = {
  draft: 0.1, // planned fact, barely started
  ready: 0.3, // planned and queued
  claimed: 0.5, // picked up
  in_progress: 0.7, // work underway
  blocked: 0.7, // stopped mid-work — the red colour says blocked, not the bar
  done: 1, // finished
  cancelled: 0.15, // abandoned where it stood
  superseded: 0.15, // replaced by a newer plan
};

/** Border colour of a goal frame (stage G3), by goal status. */
export const GOAL_STATUS_COLORS: Record<GoalStatus, string> = {
  draft: "#8b93a3", // not a decision yet
  proposed: "#b48ddb", // waiting for the approval gate (ADR-7)
  approved: "#5b9dff", // approved, materialization pending
  in_progress: "#e0a84f", // being grown
  done: "#4fa860",
  cancelled: "#5c6470",
  superseded: "#6b7280",
};

/** Human labels of the goal statuses (shown inside the frame, in text). */
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  draft: "Draft",
  proposed: "Proposed",
  approved: "Approved",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

/** Stroke colour of a bee edge, by bee status (stage G3). */
export const BEE_STATUS_COLORS: Record<BeeStatus, string> = {
  active: "#f0b429", // honey — the live influence, animated
  watching: "#5b9dff",
  resolved: "#4fa860",
  cancelled: "#5c6470",
};

/** Human labels of the bee statuses (rendered on the edge, in text). */
export const BEE_STATUS_LABELS: Record<BeeStatus, string> = {
  active: "Active",
  watching: "Watching",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

/** Incident badge (🐞 ×N) painted on nodes with open incidents. */
export const BUG_BADGE_COLOR = "#e05d5d";

/** Accent colour of an incident card, by bug status (stage K1). */
export const BUG_STATUS_COLORS: Record<BugStatus, string> = {
  open: "#e05d5d", // the same red as the node badge it echoes
  investigating: "#e0a84f", // being looked at — the in-progress amber
  resolved: "#4fa860",
  cancelled: "#5c6470",
};

/** Human labels of the bug statuses (rendered in text on the cards). */
export const BUG_STATUS_LABELS: Record<BugStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

/**
 * The selected node in the 3D scene (stage I4): its marker, its ring and the
 * tubes that touch it. A bright, near-white tone — the scene is always dark,
 * and the selection must be the first thing the eye finds.
 */
export const SELECTION_COLOR = "#eef2ff";

/**
 * Stroke/label colour of a growth record's own status (stage G5), next to the
 * step counter — the same vocabulary the rest of the diagram uses: blue while
 * growing, amber when stalled, green when done.
 */
export const GROWTH_STATUS_COLORS: Record<GrowthStatus, string> = {
  active: "#5b9dff",
  stalled: "#e0a84f",
  done: "#4fa860",
  cancelled: "#5c6470",
};

/** Human labels of the growth statuses (rendered in text). */
export const GROWTH_STATUS_LABELS: Record<GrowthStatus, string> = {
  active: "Active",
  stalled: "Stalled",
  done: "Done",
  cancelled: "Cancelled",
};

/**
 * Heat ramp of the growth layer (stage G5): the colour a node is tinted with
 * as its share of completed growth steps rises. Three stops, deliberately the
 * palette's own semantics rather than an arbitrary gradient — nothing done is
 * the muted grey, half-way is the in-progress amber, done is the done green —
 * so heat and status colours tell the same story. `at` runs from 0 to 1 and
 * must stay sorted (`tests/dashboard-theme.test.ts` pins it).
 */
export const HEAT_RAMP: readonly { at: number; color: string }[] = [
  { at: 0, color: "#5c6470" },
  { at: 0.5, color: "#e0a84f" },
  { at: 1, color: "#4fa860" },
];

/** Parses `#rrggbb` into its three channels. */
function hexChannels(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace(/^#/, "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** Formats three channels back into `#rrggbb`. */
function hexFromChannels(r: number, g: number, b: number): string {
  const channel = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * The heat colour of a progress ratio in `[0, 1]` (clamped): interpolates
 * linearly between the {@link HEAT_RAMP} stops in RGB. Pure and total — a
 * ratio outside the range (a hand-edited payload) still yields a valid hex.
 */
export function heatColor(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  let lower = HEAT_RAMP[0];
  let upper = HEAT_RAMP[HEAT_RAMP.length - 1];
  for (let i = 0; i < HEAT_RAMP.length - 1; i += 1) {
    if (clamped >= HEAT_RAMP[i].at && clamped <= HEAT_RAMP[i + 1].at) {
      lower = HEAT_RAMP[i];
      upper = HEAT_RAMP[i + 1];
      break;
    }
  }
  const span = upper.at - lower.at;
  const t = span === 0 ? 0 : (clamped - lower.at) / span;
  const from = hexChannels(lower.color);
  const to = hexChannels(upper.color);
  return hexFromChannels(
    from.r + (to.r - from.r) * t,
    from.g + (to.g - from.g) * t,
    from.b + (to.b - from.b) * t,
  );
}

/**
 * Blends a `#rrggbb` hex with an alpha channel — used for tree-edge strokes
 * that echo the parent kind's colour without competing with the nodes.
 */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace(/^#/, "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Every enum the diagram paints must stay covered: an entry added to
 * `shared/*.ts` without a colour or a label would render as an invisible
 * shape (or a blank caption) and only be noticed by eye.
 */
export function paletteIsComplete(): boolean {
  return (
    NODE_KINDS.every((kind) => KIND_COLORS[kind] !== undefined) &&
    LEAF_STATUSES.every(
      (status) =>
        STATUS_COLORS[status] !== undefined &&
        STATUS_LABELS[status] !== undefined &&
        STATUS_PROGRESS[status] !== undefined,
    ) &&
    BEE_STATUSES.every(
      (status) =>
        BEE_STATUS_COLORS[status] !== undefined &&
        BEE_STATUS_LABELS[status] !== undefined,
    ) &&
    GOAL_STATUSES.every(
      (status) =>
        GOAL_STATUS_COLORS[status] !== undefined &&
        GOAL_STATUS_LABELS[status] !== undefined,
    ) &&
    GROWTH_STATUSES.every(
      (status) =>
        GROWTH_STATUS_COLORS[status] !== undefined &&
        GROWTH_STATUS_LABELS[status] !== undefined,
    ) &&
    BUG_STATUSES.every(
      (status) =>
        BUG_STATUS_COLORS[status] !== undefined &&
        BUG_STATUS_LABELS[status] !== undefined,
    )
  );
}
