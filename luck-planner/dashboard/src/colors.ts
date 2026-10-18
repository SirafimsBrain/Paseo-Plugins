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
 * Both enums must stay covered: an entry added to `shared/tree.ts` without a
 * colour would render as an invisible shape and only be noticed by eye.
 */
export function paletteIsComplete(): boolean {
  return (
    NODE_KINDS.every((kind) => KIND_COLORS[kind] !== undefined) &&
    LEAF_STATUSES.every((status) => STATUS_COLORS[status] !== undefined)
  );
}
