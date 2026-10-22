/**
 * The plain board (PLAN.md stage K1, ADR-10): `/api/tree` → the card board.
 *
 * The fourth pure consumer of the composite F1 payload (after `graph.ts`,
 * `tree-3d.ts` and `overlay-3d.ts`) — no React, no DOM, no server changes.
 * The board is a kanban turned 90° left: horizontal zones stacked top to
 * bottom, so the eye reads *priority* instead of geometry:
 *
 * 1. **PLAN** — the high goals and planned work the user must see first:
 *    goals `draft → proposed → approved` (written / under approval /
 *    approved but not started) and leaves `draft → ready`;
 * 2. **ACTIVE** — everything under approval, review or implementation:
 *    goals `in_progress`, leaves `claimed → in_progress → blocked`, bugs
 *    `open → investigating`;
 * 3. **DONE** — finished or processed: goals and leaves
 *    `done → cancelled → superseded`, bugs `resolved → cancelled`.
 *
 * Inside a zone the board breaks down by (entity, status) groups; inside a
 * *leaf* group the cards hang under collapsible **sections** — the branch
 * hierarchy of the tree — which is how the user "expands the structure to
 * the required depth" without the diagram's hairball. Goals and bugs are
 * entities of their own (not nodes), so they render as flat card lists and
 * deliberately ignore the toolbar's node filters (`README` states this); the
 * leaves follow the *same* `matchingWithAncestors` rule the 2D and 3D views
 * use — one interpretation of a filter for three views.
 *
 * Everything here is deterministic (payload order never leaks: children are
 * name-sorted by `indexTree`, goals/bugs are sorted by status rank then id),
 * so an SSE-driven rebuild (H1) cannot make the board dance.
 */
import type { TreeResponse } from "../../shared/api";
import { GOAL_STATUSES } from "../../shared/goals";
import type { GoalStatus } from "../../shared/goals";
import { BUG_STATUSES } from "../../shared/links";
import type { BugSeverity, BugStatus } from "../../shared/links";
import { LEAF_STATUSES } from "../../shared/tree";
import type { LeafStatus, Node as TreeNode, NodeKind } from "../../shared/tree";
import {
  growthRollups,
  indexTree,
  matchingWithAncestors,
  openBugIdsByNode,
  toggleCollapsed,
  type GraphFilter,
  type GrowthRollup,
  type TreeIndex,
} from "./graph";

// ── Zones ─────────────────────────────────────────────────────────────────

/** A horizontal band of the board, in display order (top to bottom). */
export type PlainZoneId = "plan" | "active" | "done";

/** The zones in the order the board shows them. */
export const PLAIN_ZONES: readonly PlainZoneId[] = ["plan", "active", "done"];

/** Human labels of the zones (the band headers). */
export const PLAIN_ZONE_LABELS: Record<PlainZoneId, string> = {
  plan: "Plan",
  active: "In motion",
  done: "Done",
};

/** Zone glyphs — the same "colour is never alone" rule as everywhere else. */
export const PLAIN_ZONE_GLYPHS: Record<PlainZoneId, string> = {
  plan: "🎯",
  active: "🛠",
  done: "✅",
};

/** Shown in a zone that currently holds no cards. */
export const PLAIN_ZONE_EMPTY_HINTS: Record<PlainZoneId, string> = {
  plan: "Nothing planned yet — high goals proposed by agents and draft facts land here first.",
  active: "Nothing in motion — claimed, in-progress and blocked work shows up here.",
  done: "Nothing finished yet — completed and processed items collect at the bottom.",
};

/** Zone of a leaf, by its status (the K1 mapping table, pinned by tests). */
const LEAF_ZONES: Record<LeafStatus, PlainZoneId> = {
  draft: "plan",
  ready: "plan",
  claimed: "active",
  in_progress: "active",
  blocked: "active",
  done: "done",
  cancelled: "done",
  superseded: "done",
};

/** Zone of a high goal, by its status: everything not started stays on top. */
const GOAL_ZONES: Record<GoalStatus, PlainZoneId> = {
  draft: "plan",
  proposed: "plan",
  approved: "plan",
  in_progress: "active",
  done: "done",
  cancelled: "done",
  superseded: "done",
};

/** Zone of an incident, by its status: open bugs are work to do, not plan. */
const BUG_ZONES: Record<BugStatus, PlainZoneId> = {
  open: "active",
  investigating: "active",
  resolved: "done",
  cancelled: "done",
};

/** Zone of a leaf status (exposed for the completeness test). */
export function zoneForLeaf(status: LeafStatus): PlainZoneId {
  return LEAF_ZONES[status];
}

/** Zone of a goal status. */
export function zoneForGoal(status: GoalStatus): PlainZoneId {
  return GOAL_ZONES[status];
}

/** Zone of a bug status. */
export function zoneForBug(status: BugStatus): PlainZoneId {
  return BUG_ZONES[status];
}

// ── Cards ─────────────────────────────────────────────────────────────────

/** What kind of domain entity a card stands for. */
export type PlainCardKind = "goal" | "leaf" | "bug";

/** Fields every card carries to the renderer. */
interface PlainCardBase {
  /** Unique on the board — `<kind>:<entityId>` (also the React key). */
  readonly id: string;
  readonly entityId: string;
  readonly name: string;
  /** Domain status verbatim; the renderer maps it through `colors.ts`. */
  readonly status: string;
  readonly revision: number;
}

/** A planned fact: the work item of the board. */
export interface PlainLeafCard extends PlainCardBase {
  readonly kind: "leaf";
  readonly nodeKind: NodeKind;
  /** Breadcrumb of ancestor names, root first (`"Tech stack › Platform"`). */
  readonly path: string;
  readonly version: string;
  /** Open/investigating incidents on this leaf (the 🐞 badge, same as 2D). */
  readonly openBugCount: number;
  /** Influence links touching this leaf. */
  readonly beeCount: number;
  /** Growth roll-up — the very number the 2D heat layer paints (G5). */
  readonly growth: GrowthRollup | null;
}

/** A high goal: the plan itself, pinned where the eye lands first (ADR-10). */
export interface PlainGoalCard extends PlainCardBase {
  readonly kind: "goal";
  readonly formalText: string;
  /** Number of atomic steps in the agent's plan. */
  readonly planSteps: number;
  /** The subtree grown after approval, or `null` while unmaterialized. */
  readonly materializedNodeId: string | null;
}

/** An incident: its own card, so a blocker cannot hide inside a badge. */
export interface PlainBugCard extends PlainCardBase {
  readonly kind: "bug";
  readonly severity: BugSeverity;
  /** How many leaves this incident is attached to. */
  readonly attachmentCount: number;
}

/** Any card of the board. */
export type PlainCard = PlainLeafCard | PlainGoalCard | PlainBugCard;

// ── Board structure ───────────────────────────────────────────────────────

/**
 * A collapsible tree section inside a leaf status group: the branch the
 * group's cards hang from. Sections nest by tree ancestry, so expanding a
 * section reveals its own cards and, deeper down, its subsections — the
 * "expand the structure to the required depth" requirement.
 */
export interface PlainSection {
  /** Collapse key: `<group id>::<node id>` (unique per group). */
  readonly key: string;
  readonly nodeId: string;
  readonly name: string;
  readonly nodeKind: NodeKind;
  /** Nesting depth inside the group (0 = topmost section). */
  readonly depth: number;
  /** Cards attached directly to this section. */
  readonly cards: readonly PlainLeafCard[];
  /** Direct subsections, in tree order. */
  readonly children: readonly PlainSection[];
}

/** Cards of one (entity, status) pair, with their section forest. */
export interface PlainGroup {
  /** `<kind>:<status>` — unique within its zone. */
  readonly id: string;
  readonly cardKind: PlainCardKind;
  readonly status: string;
  /** Cards with no section above them (orphan leaves; goal/bug lists). */
  readonly cards: readonly PlainCard[];
  /** Section forest (leaf groups only; empty for goal/bug groups). */
  readonly sections: readonly PlainSection[];
  /** Total cards in the group (own + every section's). */
  readonly cardCount: number;
}

/** One horizontal band: its groups in display order and its totals. */
export interface PlainZone {
  readonly id: PlainZoneId;
  /** Total cards across the zone's groups. */
  readonly cardCount: number;
  readonly groups: readonly PlainGroup[];
}

/** Where a card lives on the board — the search/selection lookup. */
export interface PlainCardIndexEntry {
  readonly cardId: string;
  readonly kind: PlainCardKind;
  readonly zoneId: PlainZoneId;
  readonly groupId: string;
  /** Section keys from the group root down to the card's own section. */
  readonly sectionKeys: readonly string[];
}

/** The whole board. */
export interface PlainBoard {
  readonly zones: readonly PlainZone[];
  /** Every card by **entity** id (`node.id` / `goal.id` / `bug.id`). */
  readonly index: ReadonlyMap<string, PlainCardIndexEntry>;
}

/** The board before the first `/api/tree` response lands. */
export const EMPTY_PLAIN_BOARD: PlainBoard = {
  zones: PLAIN_ZONES.map((id) => ({ id, cardCount: 0, groups: [] })),
  index: new Map(),
};

/** Visible-card budget of the default section collapse (K1 acceptance). */
export const PLAIN_VISIBLE_BUDGET = 120;

/** Options of {@link buildPlainBoard}. */
export interface PlainBoardOptions {
  /**
   * Toolbar filters (G4). Applied to **leaves** through the very rule the
   * 2D/3D views use; goal and bug cards are separate entities and are not
   * narrowed (asserted in tests, stated in the README).
   */
  readonly filter?: GraphFilter;
}

// ── Build ─────────────────────────────────────────────────────────────────

/** Rank of a status inside the canonical lifecycle order. */
function statusRank(order: readonly string[], status: string): number {
  const index = order.indexOf(status);
  return index === -1 ? order.length : index;
}

/** Severity rank: the loudest incident lists first. */
function severityRank(severity: BugSeverity): number {
  const order: readonly BugSeverity[] = ["critical", "high", "medium", "low"];
  return statusRank(order, severity);
}

/** `"Tech stack › Platform › billing"` — ancestor names, root first. */
function breadcrumb(index: TreeIndex, node: TreeNode): string {
  const names: string[] = [];
  const visited = new Set<string>([node.id]);
  let parentId = node.parentId;
  // Defensive: the payload is hand-editable, so walk cycle-safe.
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = index.byId.get(parentId);
    if (parent === undefined) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" › ");
}

/** Group id: `<kind>:<status>`. */
function groupId(kind: PlainCardKind, status: string): string {
  return `${kind}:${status}`;
}

/** Section collapse key inside a group. */
function sectionKey(group: string, nodeId: string): string {
  return `${group}::${nodeId}`;
}

/** One section under construction while the group is walked. */
interface SectionDraft {
  nodeId: string;
  cards: PlainLeafCard[];
  children: Map<string, SectionDraft>;
}

/**
 * Builds the section forest of one leaf group: a section exists for every
 * internal node that has at least one matching leaf somewhere below it —
 * exactly the ancestors of the group's cards. Sections nest by tree
 * ancestry and are emitted in tree order (name-sorted by `indexTree`).
 */
function buildSections(
  group: string,
  cards: readonly PlainLeafCard[],
  nodesByCard: ReadonlyMap<string, TreeNode>,
  index: TreeIndex,
  sectioned: Set<string>,
): PlainSection[] {
  const roots = new Map<string, SectionDraft>();
  const drafts = new Map<string, SectionDraft>();
  const draftFor = (nodeId: string): SectionDraft => {
    let draft = drafts.get(nodeId);
    if (draft === undefined) {
      draft = { nodeId, cards: [], children: new Map() };
      drafts.set(nodeId, draft);
    }
    return draft;
  };
  const byName = (a: PlainLeafCard, b: PlainLeafCard): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;

  for (const card of cards) {
    const node = nodesByCard.get(card.entityId);
    // An orphan (unknown parent) has no section: it stays a group-level card.
    const parentId = node?.parentId ?? null;
    if (parentId === null || !index.byId.has(parentId)) continue;
    sectioned.add(card.entityId);
    // Every internal ancestor qualifies (it has this leaf below it).
    const chain: string[] = [];
    const visited = new Set<string>([card.entityId]);
    let cursor: string | null = parentId;
    while (cursor !== null && !visited.has(cursor) && index.byId.has(cursor)) {
      visited.add(cursor);
      chain.push(cursor);
      cursor = index.byId.get(cursor)?.parentId ?? null;
    }
    let parentDraft: SectionDraft | null = null;
    for (const ancestorId of chain.reverse()) {
      const draft = draftFor(ancestorId);
      if (parentDraft !== null) {
        parentDraft.children.set(ancestorId, draft);
      } else {
        roots.set(ancestorId, draft);
      }
      parentDraft = draft;
    }
    parentDraft?.cards.push(card);
  }

  // Name order inside every section — the payload order must not leak (the
  // same determinism rule `indexTree` follows for children).
  for (const draft of drafts.values()) draft.cards.sort(byName);

  // Emit in tree order: children follow their parent in `childrenOf` order.
  const emit = (draft: SectionDraft, depth: number): PlainSection => {
    const node = index.byId.get(draft.nodeId);
    const children: PlainSection[] = [];
    for (const child of node === undefined ? [] : index.childrenOf.get(draft.nodeId) ?? []) {
      const childDraft = draft.children.get(child.id);
      if (childDraft !== undefined) children.push(emit(childDraft, depth + 1));
    }
    return {
      key: sectionKey(group, draft.nodeId),
      nodeId: draft.nodeId,
      name: node?.name ?? draft.nodeId,
      nodeKind: node?.kind ?? "branch",
      depth,
      cards: draft.cards,
      children,
    };
  };

  const ordered: PlainSection[] = [];
  for (const root of index.roots) {
    const draft = roots.get(root.id);
    if (draft !== undefined) ordered.push(emit(draft, 0));
  }
  return ordered;
}

/**
 * Builds the whole board from one `/api/tree` payload. Deterministic: goal
 * and bug lists are sorted by (status rank, id / severity, id), leaves come
 * in `indexTree` order, and the payload order never leaks.
 */
export function buildPlainBoard(
  input: TreeResponse,
  options: PlainBoardOptions = {},
): PlainBoard {
  if (input.nodes.length === 0 && input.goals.length === 0 && input.bugs.length === 0) {
    return EMPTY_PLAIN_BOARD;
  }

  const index = indexTree(input.nodes);
  // One filter interpretation for three views (G4/I4): the toolbar rule.
  const surviving = matchingWithAncestors(input.nodes, options.filter, { index });
  const openBugs = openBugIdsByNode(input);
  const growth = growthRollups(input);

  const beeCounts = new Map<string, number>();
  for (const bee of input.bees) {
    beeCounts.set(bee.sourceLeafId, (beeCounts.get(bee.sourceLeafId) ?? 0) + 1);
    beeCounts.set(bee.targetLeafId, (beeCounts.get(bee.targetLeafId) ?? 0) + 1);
  }

  interface DraftGroup {
    cardKind: PlainCardKind;
    status: string;
    cards: PlainCard[];
    nodesByCard: Map<string, TreeNode>;
  }
  const groups = new Map<string, DraftGroup>();
  const groupOf = (kind: PlainCardKind, status: string): DraftGroup => {
    const id = groupId(kind, status);
    let group = groups.get(id);
    if (group === undefined) {
      group = { cardKind: kind, status, cards: [], nodesByCard: new Map() };
      groups.set(id, group);
    }
    return group;
  };

  // Leaves — the only cards the toolbar filters narrow.
  for (const node of input.nodes) {
    if (node.kind !== "leaf" || !surviving.has(node.id)) continue;
    const card: PlainLeafCard = {
      id: `leaf:${node.id}`,
      entityId: node.id,
      kind: "leaf",
      nodeKind: node.kind,
      name: node.name,
      status: node.status,
      revision: node.revision,
      path: breadcrumb(index, node),
      version: node.version,
      openBugCount: openBugs.get(node.id)?.length ?? 0,
      beeCount: beeCounts.get(node.id) ?? 0,
      growth: growth.get(node.id) ?? null,
    };
    const group = groupOf("leaf", node.status);
    group.cards.push(card);
    group.nodesByCard.set(node.id, node);
  }

  // Goals — their own entity, never filtered by the node filters.
  const sortedGoals = [...input.goals].sort(
    (a, b) =>
      statusRank(GOAL_STATUSES, a.status) - statusRank(GOAL_STATUSES, b.status) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const goal of sortedGoals) {
    const card: PlainGoalCard = {
      id: `goal:${goal.id}`,
      entityId: goal.id,
      kind: "goal",
      name: goal.formalText,
      status: goal.status,
      revision: goal.revision,
      formalText: goal.formalText,
      planSteps: goal.plan.length,
      materializedNodeId: goal.materializedNodeId,
    };
    groupOf("goal", goal.status).cards.push(card);
  }

  // Bugs — their own entity: a blocker must be readable as a card, not only
  // as a badge on a leaf.
  const attachmentCounts = new Map<string, number>();
  for (const attachment of input.bugAttachments) {
    attachmentCounts.set(
      attachment.bugId,
      (attachmentCounts.get(attachment.bugId) ?? 0) + 1,
    );
  }
  const sortedBugs = [...input.bugs].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const bug of sortedBugs) {
    const card: PlainBugCard = {
      id: `bug:${bug.id}`,
      entityId: bug.id,
      kind: "bug",
      name: bug.title,
      status: bug.status,
      revision: bug.revision,
      severity: bug.severity,
      attachmentCount: attachmentCounts.get(bug.id) ?? 0,
    };
    groupOf("bug", bug.status).cards.push(card);
  }

  // Assemble zones: groups in (kind, lifecycle-status) order, leaf sections
  // built per group. The canonical status arrays are already in lifecycle
  // order, so filtering them by the group's zone yields the display order.
  const KIND_ORDER: readonly PlainCardKind[] = ["goal", "leaf", "bug"];

  const indexEntries = new Map<string, PlainCardIndexEntry>();
  const zones: PlainZone[] = PLAIN_ZONES.map((zoneId) => {
    const zoneGroups: PlainGroup[] = [];
    let zoneCount = 0;
    for (const kind of KIND_ORDER) {
      const statuses: readonly string[] =
        kind === "leaf"
          ? LEAF_STATUSES
          : kind === "goal"
            ? GOAL_STATUSES
            : BUG_STATUSES;
      // Keep only statuses of this zone, in lifecycle order — and only the
      // groups that actually hold cards.
      const zoneStatuses = statuses.filter((status) =>
        kind === "leaf"
          ? zoneForLeaf(status as LeafStatus) === zoneId
          : kind === "goal"
            ? zoneForGoal(status as GoalStatus) === zoneId
            : zoneForBug(status as BugStatus) === zoneId,
      );
      for (const status of zoneStatuses) {
        const draft = groups.get(groupId(kind, status));
        if (draft === undefined) continue;
        const sectioned = new Set<string>();
        const sections =
          kind === "leaf"
            ? buildSections(
                groupId(kind, status),
                draft.cards as PlainLeafCard[],
                draft.nodesByCard,
                index,
                sectioned,
              )
            : [];
        const group: PlainGroup = {
          id: groupId(kind, status),
          cardKind: kind,
          status,
          // Orphans (no reachable parent) are the only cards without a
          // section above them.
          cards: draft.cards
            .filter((card) => !sectioned.has(card.entityId))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          sections,
          cardCount: draft.cards.length,
        };
        zoneCount += group.cardCount;
        zoneGroups.push(group);

        // Index every card with the section chain leading to it.
        const walk = (section: PlainSection, chain: readonly string[]): void => {
          const nextChain = [...chain, section.key];
          for (const card of section.cards) {
            indexEntries.set(card.entityId, {
              cardId: card.id,
              kind: card.kind,
              zoneId,
              groupId: group.id,
              sectionKeys: nextChain,
            });
          }
          for (const child of section.children) walk(child, nextChain);
        };
        for (const section of sections) walk(section, []);
        for (const card of group.cards) {
          indexEntries.set(card.entityId, {
            cardId: card.id,
            kind: card.kind,
            zoneId,
            groupId: group.id,
            sectionKeys: [],
          });
        }
      }
    }
    return { id: zoneId, cardCount: zoneCount, groups: zoneGroups };
  });

  return { zones, index: indexEntries };
}

// ── Collapse / reveal ─────────────────────────────────────────────────────

/** Returns a new collapsed set with one section key toggled (pure). */
export function togglePlainSection(
  collapsed: ReadonlySet<string>,
  key: string,
): Set<string> {
  return toggleCollapsed(collapsed, key);
}

/**
 * The default collapse policy: zones and groups start expanded (the board
 * shows its breakdown on the first frame), while the tree sections open
 * breadth-first — shallowest first, the PLAN zone claiming the budget
 * first — until the visible-card budget would overflow; the section that
 * would overflow (and everything below it) starts collapsed.
 */
export function defaultPlainCollapse(
  board: PlainBoard,
  options: { budget?: number } = {},
): Set<string> {
  const budget = options.budget ?? PLAIN_VISIBLE_BUDGET;
  const collapsed = new Set<string>();
  let visible = 0;
  for (const zone of board.zones) {
    for (const group of zone.groups) {
      const queue: PlainSection[] = [...group.sections];
      let cursor = 0;
      while (cursor < queue.length) {
        const section = queue[cursor];
        cursor += 1;
        if (visible + section.cards.length <= budget) {
          visible += section.cards.length;
          queue.push(...section.children);
        } else {
          // The section that would overflow starts collapsed — and takes
          // its subsections with it (they were never enqueued; a renderer
          // walking the tree stops at the closed header, and the visible
          // count below reads the same set).
          collapsed.add(section.key);
        }
      }
    }
  }
  return collapsed;
}

/** How many cards a collapse state leaves visible (own cards counted once). */
export function plainVisibleCardCount(
  board: PlainBoard,
  collapsed: ReadonlySet<string>,
): number {
  let count = 0;
  for (const entry of board.index.values()) {
    if (entry.sectionKeys.every((key) => !collapsed.has(key))) count += 1;
  }
  return count;
}

/** What the search needs to bring a found entity on screen (K1). */
export interface PlainReveal {
  /** Section keys to remove from the collapsed set (ancestors included). */
  readonly sectionKeys: readonly string[];
  /** The card's id, or `null` when the entity has no card on the board. */
  readonly cardId: string | null;
}

/**
 * The sections to open so `entityId`'s card is on screen. Goal and bug
 * cards need no expansion (their groups are always visible); a leaf card
 * opens the chain of sections that hides it.
 */
export function plainReveal(board: PlainBoard, entityId: string): PlainReveal {
  const entry = board.index.get(entityId);
  if (entry === undefined) return { sectionKeys: [], cardId: null };
  return { sectionKeys: [...entry.sectionKeys], cardId: entry.cardId };
}
