/**
 * `/api/tree` → React Flow nodes/edges (PLAN.md stage G2, `__doc.md` §G2).
 *
 * Pure over the F1 graph payload: no React, no DOM, no SDK — only `d3-hierarchy`
 * for the layout and *type-only* React Flow imports for the output shapes, so
 * `tests/dashboard-graph.test.ts` pins the mapping, the positions and the
 * collapse policy in plain Node, the way `shared/panel.ts` pins the native
 * panel. The components in `dashboard/src/components/` render exactly what
 * this module returns.
 *
 * Responsibilities:
 * - **kind → node type**: `root`/`trunk`/`branch`/`subbranch`/`leaf` become the
 *   React Flow `type`, which is how the tech-stack root and the trunk get a
 *   different *shape* from the branches (G3 renders the shapes; this module
 *   only assigns the types);
 * - **layout**: a layered top-down `d3.tree()` over the *visible* subtree, with
 *   node sizes that bake the auto-gaps in — no manual coordinates anywhere;
 * - **collapse/expand**: a node in `collapsedIds` stays visible but hides its
 *   whole subtree; `defaultCollapsedIds` keeps the visible set within a budget
 *   so a 1000-node project opens as a small skeleton instead of a hairball
 *   (the G2 acceptance case);
 * - **edges**: one `smoothstep` tree edge per visible non-root node, plus one
 *   edge per influence bee whose *both* endpoints are visible;
 * - **badges**: per-leaf open-incident counts (open + investigating, the same
 *   definition `store.stats()` uses) ride in node data for the G3 badges.
 * - **growth** (G5): every node carries the roll-up of its own growth record
 *   plus every descendant record, and the toolbar's `layer` option turns that
 *   ratio into the heat value the renderer tints the node with. The layer is a
 *   *display* option only — it never touches the layout, so switching it
 *   cannot move a node (the G5 acceptance rule).
 *
 * Determinism: children are sorted by name before the layout, so the same
 * payload always yields identical positions — required for the fixture tests
 * and for SSE-driven rebuilds (H1) not to make the graph dance. Growth records
 * are sorted by id for the same reason.
 */
import type { Edge, Node } from "@xyflow/react";
import { hierarchy, tree } from "d3-hierarchy";
import type { LeafStatus, Node as TreeNode, NodeKind } from "../../shared/tree";
import type { BeeStatus } from "../../shared/links";
import type { GoalStatus } from "../../shared/goals";
import { growthProgress } from "../../shared/growth";
import type {
  Growth,
  GrowthStatus,
  GrowthSummary,
} from "../../shared/growth";
import type { TreeResponse } from "../../shared/api";
import { KIND_COLORS, withAlpha } from "./colors";

/** React Flow `type` per node kind — the G3 shapes key off these strings. */
export const NODE_KIND_TO_TYPE: Record<NodeKind, NodeKind> = {
  root: "root",
  trunk: "trunk",
  branch: "branch",
  subbranch: "subbranch",
  leaf: "leaf",
};

/**
 * Node geometry. Node size and both gaps live in one place: the layout feeds
 * them to `d3.tree().nodeSize()`, the node components read them for the box
 * size, and the tests assert positions against them.
 */
export const LAYOUT = {
  nodeWidth: 190,
  nodeHeight: 70,
  horizontalGap: 36,
  verticalGap: 90,
} as const;

/** Visible-node budget of the default collapse policy (G2 acceptance). */
export const DEFAULT_VISIBLE_BUDGET = 120;

/**
 * Geometry of a goal frame (stage G3): the dashed rectangle that encloses
 * the subtree a high goal materialized. `labelHeight` is the strip reserved
 * at the top for the 🎯 label, so the frame box itself needs no padding hack
 * in the renderer.
 */
export const GOAL_FRAME = {
  padding: 28,
  labelHeight: 26,
} as const;

/** Payload every graph node carries to its renderer. */
export type GraphNodeData = {
  id: string;
  name: string;
  kind: NodeKind;
  /** Leaf status; non-leaf nodes carry their stored status verbatim. */
  status: LeafStatus;
  version: string;
  revision: number;
  /** Direct children in the *full* tree (a collapsed node still shows it). */
  childCount: number;
  /** Descendants hidden by collapse; 0 when expanded or childless. */
  hiddenDescendantCount: number;
  /** Open/investigating incidents attached to this node (G3 badge). */
  openBugCount: number;
  /** Ids behind the badge, sorted — the G4 selection uses them. */
  openBugIds: string[];
  /** Whether this node currently hides its subtree. */
  collapsed: boolean;
  /**
   * Growth roll-up of this node's own record plus every descendant record
   * (G5); `null` means "no growth data anywhere in this subtree" — which the
   * heat layer keeps distinct from "0 % done".
   */
  growth: GrowthRollup | null;
  /**
   * Heat ratio in `[0, 1]` when the growth layer is active, `null` otherwise
   * (or without growth data). The renderer converts it with `heatColor`.
   */
  heat: number | null;
  /** Wired by the Canvas decoration, never by the adapter (see below). */
  onToggle?: () => void;
  /** Whether this node is the current selection (Canvas, stage G4). */
  selected?: boolean;
  /** Shares an open incident with the selection (Canvas, stage G4). */
  bugLinked?: boolean;
};

/**
 * Growth roll-up of one subject (stage G5): its own record merged with the
 * records of everything below it. Extends the shared {@link GrowthSummary}
 * (the same aggregate `shared/growth.ts` defines for the panel and any RPC),
 * so the dashboard can never compute a different "share of completed steps".
 */
export interface GrowthRollup extends GrowthSummary {
  /** Whether the subject itself carries a growth record. */
  hasOwn: boolean;
  /** Status of the subject's own record (the first by id), or `null`. */
  ownStatus: GrowthStatus | null;
}

/**
 * Diagram layers the toolbar switches between (stage G5). `status` is the
 * default G3/G4 view (kind shapes, status bars, badges); `growth` adds the
 * heat tint of the whole tree by its growth ratio. The layer is purely
 * presentational: {@link buildGraph} produces identical positions and types
 * for both.
 */
export type GraphLayer = "status" | "growth";

/** Every layer of the toolbar switch, in display order. */
export const GRAPH_LAYERS: readonly GraphLayer[] = ["status", "growth"];

/** Human labels of the layers (the toolbar buttons). */
export const GRAPH_LAYER_LABELS: Record<GraphLayer, string> = {
  status: "Status",
  growth: "Growth heat",
};

/** Tree edge payload: which of the two graph layers the edge belongs to. */
export type TreeEdgeData = {
  kind: "tree";
};

/** Bee edge payload: the influence link the G3 edge renderer styles. */
export type BeeEdgeData = {
  kind: "bee";
  impact: string;
  status: BeeStatus;
};

/**
 * Payload of a *synthetic* goal-frame node (stage G3): a dashed rectangle
 * around the visible subtree a high goal materialized (`ADR-7`). Frames are
 * never part of the layout — they are computed from the positions of the
 * tree nodes they enclose and kept in their own array on
 * {@link DashboardGraph}, so the G2 node type and its tests stay untouched.
 */
export type GoalFrameData = {
  goalId: string;
  /** The goal's formal task text (the renderer truncates it for the label). */
  name: string;
  status: GoalStatus;
  /** Frame box in layout coordinates (position is its top-left corner). */
  width: number;
  height: number;
  /** How many visible tree nodes the frame encloses. */
  nodeCount: number;
  /**
   * Growth roll-up of the goal's own record plus the records of every node in
   * its materialized subtree (G5); `null` when neither carries growth data.
   */
  growth: GrowthRollup | null;
  /** Heat ratio when the growth layer is active, `null` otherwise (G5). */
  heat: number | null;
};

/** A React Flow node positioned by this module. */
export type GraphFlowNode = Node<GraphNodeData>;
/** A synthetic goal-frame node (rendered behind the tree). */
export type GoalFrameNode = Node<GoalFrameData>;
/** A React Flow edge produced by this module. */
export type GraphFlowEdge = Edge<TreeEdgeData | BeeEdgeData>;

/**
 * Toolbar filters (stage G4). An empty/absent field matches everything; a
 * version filter is a case-insensitive prefix of the node's stored version.
 */
export interface GraphFilter {
  kind?: NodeKind | "";
  status?: LeafStatus | "";
  version?: string;
}

/** Whether at least one field of the filter narrows the graph. */
export function isFilterActive(filter: GraphFilter | undefined): filter is GraphFilter {
  if (filter === undefined) return false;
  return (
    (filter.kind !== undefined && filter.kind !== "") ||
    (filter.status !== undefined && filter.status !== "") ||
    (filter.version !== undefined && filter.version.trim() !== "")
  );
}

/** All fields of the filter must hold (AND), the way the FTS options merge. */
export function matchesFilter(node: TreeNode, filter: GraphFilter): boolean {
  if (filter.kind !== undefined && filter.kind !== "" && node.kind !== filter.kind) {
    return false;
  }
  if (
    filter.status !== undefined &&
    filter.status !== "" &&
    node.status !== filter.status
  ) {
    return false;
  }
  const version = filter.version?.trim().toLowerCase();
  if (version !== undefined && version.length > 0) {
    if (!node.version.toLowerCase().startsWith(version)) return false;
  }
  return true;
}

/** Options of {@link buildGraph}. */
export interface BuildGraphOptions {
  /** Node ids currently hiding their subtree. Defaults to "all expanded". */
  collapsedIds?: ReadonlySet<string>;
  /**
   * Toolbar filters (G4). A node survives when it matches *or* has a
   * matching descendant — the path to the root stays as context, so a
   * filtered leaf is still readable as a tree instead of floating alone.
   */
  filter?: GraphFilter;
  /**
   * Active diagram layer (G5). `growth` fills each node's `heat` with its
   * growth ratio; `status` (the default) leaves it `null`. Positions, types
   * and edges are identical in both layers by construction.
   */
  layer?: GraphLayer;
}
/** Flat index of the tree: roots, sorted children and the node lookup. */
interface TreeIndex {
  byId: Map<string, TreeNode>;
  childrenOf: Map<string, TreeNode[]>;
  roots: TreeNode[];
}

/**
 * Indexes the flat adjacency list. A node whose `parentId` is unknown is
 * treated as a root (defensive: the payload excludes archived nodes, so this
 * only fires on a hand-crafted or corrupted response — the graph must still
 * render instead of dropping the subtree).
 */
export function indexTree(nodes: readonly TreeNode[]): TreeIndex {
  const byId = new Map<string, TreeNode>();
  for (const node of nodes) byId.set(node.id, node);

  const childrenOf = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  for (const node of nodes) {
    if (node.parentId === null || !byId.has(node.parentId)) {
      roots.push(node);
      continue;
    }
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node);
    childrenOf.set(node.parentId, list);
  }

  // Name order makes the layout (and therefore every test) deterministic.
  const byName = (a: TreeNode, b: TreeNode): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  roots.sort(byName);
  for (const list of childrenOf.values()) list.sort(byName);

  return { byId, childrenOf, roots };
}

/** Subtree sizes (the node itself included), iterative post-order. */
function subtreeSizes(index: TreeIndex): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const root of index.roots) {
    const order: string[] = [];
    const stack: string[] = [root.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      order.push(id);
      for (const child of index.childrenOf.get(id) ?? []) stack.push(child.id);
    }
    // Pre-order reversed: children always come before their parent.
    for (const id of order.reverse()) {
      let size = 1;
      for (const child of index.childrenOf.get(id) ?? []) {
        size += sizes.get(child.id)!;
      }
      sizes.set(id, size);
    }
  }
  return sizes;
}

/**
 * The default collapse policy (G2): breadth-first from the roots, expanding
 * whole levels while the visible set stays within `budget` nodes; the first
 * level that would overflow is collapsed instead. A small tree ends fully
 * expanded (empty set); a 1000-node project opens as its top levels only —
 * which is what keeps the canvas responsive.
 */
export function defaultCollapsedIds(
  nodes: readonly TreeNode[],
  options: { budget?: number } = {},
): Set<string> {
  const budget = options.budget ?? DEFAULT_VISIBLE_BUDGET;
  const index = indexTree(nodes);
  const collapsed = new Set<string>();
  const queue = index.roots.map((root) => root.id);
  let visible = queue.length;
  while (queue.length > 0) {
    const id = queue.shift()!;
    const children = index.childrenOf.get(id) ?? [];
    if (children.length === 0) continue;
    if (visible + children.length <= budget) {
      visible += children.length;
      for (const child of children) queue.push(child.id);
    } else {
      collapsed.add(id);
    }
  }
  return collapsed;
}

/** Returns a new collapsed set with `id` toggled; the input is untouched. */
export function toggleCollapsed(
  collapsed: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(collapsed);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The visible node ids plus the hidden-descendant count per collapsed node. */
function visibleSet(
  index: TreeIndex,
  collapsed: ReadonlySet<string>,
  sizes: Map<string, number>,
): { visible: Set<string>; hiddenCounts: Map<string, number> } {
  const visible = new Set<string>();
  const hiddenCounts = new Map<string, number>();
  const queue = index.roots.map((root) => root.id);
  for (const id of queue) visible.add(id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (collapsed.has(id)) {
      hiddenCounts.set(id, (sizes.get(id) ?? 1) - 1);
      continue;
    }
    for (const child of index.childrenOf.get(id) ?? []) {
      visible.add(child.id);
      queue.push(child.id);
    }
  }
  return { visible, hiddenCounts };
}

/**
 * Builds the React Flow graph for one `/api/tree` payload. An empty payload
 * yields {@link EMPTY_GRAPH}; a forest (several roots) is laid out under an
 * invisible virtual root so the real roots share one coordinate space without
 * a phantom node being rendered.
 */
export function buildGraph(
  input: TreeResponse,
  options: BuildGraphOptions = {},
): DashboardGraph {
  if (input.nodes.length === 0) return EMPTY_GRAPH;

  const collapsed = options.collapsedIds ?? new Set<string>();
  const layer = options.layer ?? "status";
  const index = indexTree(input.nodes);
  const sizes = subtreeSizes(index);
  const { visible, hiddenCounts } = visibleSet(index, collapsed, sizes);
  // Visibility (collapse) is then narrowed by the toolbar filters (G4).
  const shown = applyFilter(input.nodes, visible, index, options.filter);
  const bugIdsByNode = openBugIdsByNode(input);
  // Growth roll-ups (G5) are computed over the *full* tree: a collapsed
  // branch still reports the progress of what it hides. A goal's own record
  // joins the roll-up at the node it materialized, so the heat map covers
  // plan progress and fact progress with one number.
  const nodeGrowth = nodeGrowthRollups(
    index,
    growthRecordsBySubject(input.growth, "node"),
    goalRecordsByMaterializedRoot(input),
  );

  // Nested layout input, visible nodes only.
  interface LayoutInput {
    id: string;
    children: LayoutInput[];
  }
  const VIRTUAL_ROOT = "";
  const makeLayout = (id: string): LayoutInput => ({
    id,
    children: collapsed.has(id)
      ? []
      : (index.childrenOf.get(id) ?? [])
          .filter((child) => shown.has(child.id))
          .map((child) => makeLayout(child.id)),
  });
  const layoutInput: LayoutInput = {
    id: VIRTUAL_ROOT,
    children: index.roots.map((root) => makeLayout(root.id)),
  };

  const layout = tree<LayoutInput>();
  layout.nodeSize([
    LAYOUT.nodeWidth + LAYOUT.horizontalGap,
    LAYOUT.nodeHeight + LAYOUT.verticalGap,
  ]);
  const laidOut = layout(hierarchy(layoutInput, (d) => d.children));

  const positions = new Map<string, { x: number; y: number }>();
  laidOut.each((d) => {
    if (d.data.id !== VIRTUAL_ROOT) {
      positions.set(d.data.id, { x: d.x, y: d.y });
    }
  });

  const nodes: GraphFlowNode[] = [];
  for (const node of input.nodes) {
    if (!shown.has(node.id)) continue;
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    const openBugIds = bugIdsByNode.get(node.id) ?? [];
    const growth = nodeGrowth.get(node.id) ?? null;
    nodes.push({
      id: node.id,
      type: NODE_KIND_TO_TYPE[node.kind],
      position,
      data: {
        id: node.id,
        name: node.name,
        kind: node.kind,
        status: node.status,
        version: node.version,
        revision: node.revision,
        childCount: index.childrenOf.get(node.id)?.length ?? 0,
        hiddenDescendantCount: hiddenCounts.get(node.id) ?? 0,
        openBugCount: openBugIds.length,
        openBugIds,
        collapsed: collapsed.has(node.id),
        growth,
        heat: heatFor(growth, layer),
      },
      // Positions come from the layout, not from the user (yet).
      draggable: false,
    });
  }

  const edges: GraphFlowEdge[] = [];
  for (const node of input.nodes) {
    if (!shown.has(node.id)) continue;
    if (node.parentId !== null && shown.has(node.parentId)) {
      const parent = index.byId.get(node.parentId);
      edges.push({
        id: `t:${node.id}`,
        source: node.parentId,
        target: node.id,
        type: "smoothstep",
        // The stroke echoes the parent kind's colour, softened so the node
        // shapes stay the primary signal (G3).
        style: parent
          ? { stroke: withAlpha(KIND_COLORS[parent.kind], 0.5) }
          : undefined,
        data: { kind: "tree" },
      });
    }
  }
  for (const bee of input.bees) {
    if (!shown.has(bee.sourceLeafId) || !shown.has(bee.targetLeafId)) {
      continue;
    }
    edges.push({
      id: `b:${bee.id}`,
      source: bee.sourceLeafId,
      target: bee.targetLeafId,
      // Custom renderer (`dashboard/src/components/graph-edges.tsx`): the
      // bee edge draws its own stroke, colour and status label.
      type: "bee",
      animated: bee.status === "active",
      data: { kind: "bee", impact: bee.impact, status: bee.status },
    });
  }

  return {
    nodes,
    edges,
    goalFrames: buildGoalFrames(input, shown, positions, index, {
      layer,
      nodeGrowth,
    }),
  };
}

/** The heat ratio of a roll-up in the active layer, or `null` (G5). */
function heatFor(growth: GrowthRollup | null, layer: GraphLayer): number | null {
  if (layer !== "growth" || growth === null) return null;
  return growth.ratio;
}

/**
 * Growth records grouped by their subject id, one map per subject type
 * (`node`/`goal`), each list sorted by record id so the payload order cannot
 * leak into the numbers (the determinism rule of this module). Records whose
 * subject is not in the payload are kept: they simply never get looked up.
 */
function growthRecordsBySubject(
  growth: readonly Growth[],
  subjectType: Growth["subjectType"],
): Map<string, Growth[]> {
  const bySubject = new Map<string, Growth[]>();
  for (const record of growth) {
    if (record.subjectType !== subjectType) continue;
    const list = bySubject.get(record.subjectId);
    if (list === undefined) bySubject.set(record.subjectId, [record]);
    else list.push(record);
  }
  const byId = (a: Growth, b: Growth): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  for (const list of bySubject.values()) list.sort(byId);
  return bySubject;
}

/**
 * The goal records re-keyed by the node the goal materialized (G5): that is
 * where a goal's plan becomes part of the tree, so its steps join the
 * subtree roll-up at exactly that point. Goals that never materialized
 * (ADR-7) contribute nothing — they are not part of the tree at all.
 */
function goalRecordsByMaterializedRoot(
  input: TreeResponse,
): Map<string, Growth[]> {
  const byGoal = growthRecordsBySubject(input.growth, "goal");
  const byRoot = new Map<string, Growth[]>();
  for (const goal of input.goals) {
    const rootId = goal.materializedNodeId;
    if (rootId === null) continue;
    const records = byGoal.get(goal.id);
    if (records === undefined || records.length === 0) continue;
    byRoot.set(rootId, [...(byRoot.get(rootId) ?? []), ...records]);
  }
  for (const list of byRoot.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return byRoot;
}

/** Step counters accumulated for one subtree. */
interface GrowthCounters {
  total: number;
  completed: number;
  failed: number;
  records: number;
}

/** Folds one record list onto its counters (via the shared step arithmetic). */
function addRecords(
  counters: GrowthCounters,
  records: readonly Growth[],
): GrowthCounters {
  let { total, completed, failed, records: count } = counters;
  for (const record of records) {
    const progress = growthProgress(record.steps);
    total += progress.total;
    completed += progress.completed;
    failed += progress.failed;
  }
  count += records.length;
  return { total, completed, failed, records: count };
}

/**
 * One roll-up per node that has growth data in its subtree (G5): the node's
 * own records — plus any goal materialized *at* this node — merged with the
 * roll-ups of its children, computed in one iterative post-order pass. Nodes
 * without any record anywhere below them are absent from the map — the
 * renderer shows *no* bar and *no* heat for them, which is how "no data"
 * stays distinct from "0 % done".
 *
 * `hasOwn`/`ownStatus` describe the node's *own* growth record only: a
 * goal's plan steps roll into the numbers but never claim to be the node's
 * own record (the goal status is shown on its frame).
 */
function nodeGrowthRollups(
  index: TreeIndex,
  byNode: Map<string, Growth[]>,
  byMaterializedRoot: ReadonlyMap<string, Growth[]>,
): Map<string, GrowthRollup> {
  const rollups = new Map<string, GrowthRollup>();
  const counters = new Map<string, GrowthCounters>();
  for (const root of index.roots) {
    // Pre-order over a stack, then reversed: every child runs before its
    // parent, so the child counters are ready when the parent is folded.
    const order: string[] = [];
    const stack: string[] = [root.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      order.push(id);
      for (const child of index.childrenOf.get(id) ?? []) stack.push(child.id);
    }
    for (const id of order.reverse()) {
      const own = byNode.get(id) ?? [];
      const materialized = byMaterializedRoot.get(id) ?? [];
      let accumulated = addRecords(
        { total: 0, completed: 0, failed: 0, records: 0 },
        own,
      );
      accumulated = addRecords(accumulated, materialized);
      for (const child of index.childrenOf.get(id) ?? []) {
        const below = counters.get(child.id);
        if (below === undefined) continue;
        accumulated = {
          total: accumulated.total + below.total,
          completed: accumulated.completed + below.completed,
          failed: accumulated.failed + below.failed,
          records: accumulated.records + below.records,
        };
      }
      counters.set(id, accumulated);
      if (accumulated.records === 0) continue;
      rollups.set(id, {
        ...accumulated,
        ratio:
          accumulated.total === 0
            ? 0
            : accumulated.completed / accumulated.total,
        hasOwn: own.length > 0,
        ownStatus: own.length > 0 ? own[0].status : null,
      });
    }
  }
  return rollups;
}

/**
 * Applies the toolbar filters (G4) on top of the collapse visibility: a node
 * survives when it matches *or* has a matching descendant, so the path to
 * the root always stays as context. With no active filter this is the plain
 * visible set, and the layout code below sees one set either way.
 */
function applyFilter(
  nodes: readonly TreeNode[],
  visible: ReadonlySet<string>,
  index: TreeIndex,
  filter: GraphFilter | undefined,
): Set<string> {
  if (!isFilterActive(filter)) return new Set(visible);

  const keep = new Set<string>();
  for (const node of nodes) {
    if (!visible.has(node.id)) continue;
    if (!matchesFilter(node, filter)) continue;
    keep.add(node.id);
    let parentId = node.parentId;
    while (parentId !== null && visible.has(parentId) && !keep.has(parentId)) {
      keep.add(parentId);
      parentId = index.byId.get(parentId)?.parentId ?? null;
    }
  }
  return keep;
}

/**
 * The synthetic goal frames (stage G3) with their growth roll-up (G5): one
 * dashed rectangle per goal whose materialized subtree has visible nodes,
 * sized to the bounding box of that subtree in layout coordinates. A goal
 * that never materialized (draft / proposed, ADR-7) or whose subtree is
 * currently hidden by collapse gets no frame — the frame always describes
 * exactly what is on screen.
 *
 * The frame's growth is the roll-up of its materialized subtree root, which
 * already carries the goal's own record (it is keyed to that node) plus every
 * node record below it — so the frame and the tree can never report two
 * different totals for the same subtree.
 */
function buildGoalFrames(
  input: TreeResponse,
  visible: ReadonlySet<string>,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  index: TreeIndex,
  growth: {
    layer: GraphLayer;
    nodeGrowth: ReadonlyMap<string, GrowthRollup>;
  },
): GoalFrameNode[] {
  const frames: GoalFrameNode[] = [];
  // Sorted by id: the payload order must not leak into the output (the same
  // determinism rule the layout follows).
  const goals = [...input.goals].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const goal of goals) {
    const rootId = goal.materializedNodeId;
    if (rootId === null || !visible.has(rootId)) continue;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let nodeCount = 0;
    const stack: string[] = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (!visible.has(id)) continue;
      const position = positions.get(id);
      if (position !== undefined) {
        minX = Math.min(minX, position.x);
        minY = Math.min(minY, position.y);
        maxX = Math.max(maxX, position.x + LAYOUT.nodeWidth);
        maxY = Math.max(maxY, position.y + LAYOUT.nodeHeight);
        nodeCount += 1;
      }
      for (const child of index.childrenOf.get(id) ?? []) stack.push(child.id);
    }
    if (nodeCount === 0) continue;

    const rollup = growth.nodeGrowth.get(rootId) ?? null;

    frames.push({
      id: `goal:${goal.id}`,
      type: "goalFrame",
      position: {
        x: minX - GOAL_FRAME.padding,
        y: minY - GOAL_FRAME.padding - GOAL_FRAME.labelHeight,
      },
      data: {
        goalId: goal.id,
        name: goal.formalText,
        status: goal.status,
        width: maxX - minX + 2 * GOAL_FRAME.padding,
        height: maxY - minY + 2 * GOAL_FRAME.padding + GOAL_FRAME.labelHeight,
        nodeCount,
        growth: rollup,
        heat: heatFor(rollup, growth.layer),
      },
      // Behind every real node; purely visual, so it never steals a click
      // or a canvas pan from the subtree it encloses.
      zIndex: -1,
      draggable: false,
      selectable: false,
      style: { pointerEvents: "none" },
    });
  }
  return frames;
}


/**
 * Open/investigating incident ids per node id (sorted, deduplicated) — the
 * G3 badge count is the array length and the G4 selection follows them to
 * the other leaves the incident touches.
 */
function openBugIdsByNode(input: TreeResponse): Map<string, string[]> {
  const openStatuses = new Set(["open", "investigating"]);
  const bugsById = new Map(input.bugs.map((bug) => [bug.id, bug]));
  const ids = new Map<string, Set<string>>();
  for (const attachment of input.bugAttachments) {
    const bug = bugsById.get(attachment.bugId);
    if (!bug || !openStatuses.has(bug.status)) continue;
    const set = ids.get(attachment.nodeId) ?? new Set<string>();
    set.add(attachment.bugId);
    ids.set(attachment.nodeId, set);
  }
  const sorted = new Map<string, string[]>();
  for (const [nodeId, set] of ids) {
    sorted.set(nodeId, [...set].sort());
  }
  return sorted;
}


/**
 * The ancestor chain of `id` (nearest ancestor first — immediate parent,
 * then upwards to the root); empty for a root or an unknown id.
 * Cycle-safe — the payload is hand-editable.
 */
export function ancestorsOf(
  nodes: readonly TreeNode[],
  id: string,
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chain: string[] = [];
  const visited = new Set<string>([id]);
  let current = byId.get(id);
  while (current?.parentId !== null && current?.parentId !== undefined) {
    const parentId = current.parentId;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    chain.push(parentId);
    current = byId.get(parentId);
  }
  return chain;
}

/**
 * Canvas centre of a positioned node in layout coordinates (the node
 * position is its top-left corner, the same convention the layout and the
 * goal frames use).
 */
export function graphNodeCenter(node: {
  position: { x: number; y: number };
}): { x: number; y: number } {
  return {
    x: node.position.x + LAYOUT.nodeWidth / 2,
    y: node.position.y + LAYOUT.nodeHeight / 2,
  };
}

/**
 * Nodes the current selection is tied to through a shared open incident
 * (G4): selecting a blocked leaf highlights every other leaf the same
 * 🐞 touches, which is the "all its blockers" half of the acceptance
 * scenario. The selected node itself is not in the set.
 */
export function relatedByOpenBug(
  graph: DashboardGraph,
  selectedId: string | null,
): Set<string> {
  const related = new Set<string>();
  if (selectedId === null) return related;
  const selected = graph.nodes.find((node) => node.id === selectedId);
  if (selected === undefined || selected.data.openBugIds.length === 0) {
    return related;
  }
  const shared = new Set(selected.data.openBugIds);
  for (const node of graph.nodes) {
    if (node.id === selectedId) continue;
    if (node.data.openBugIds.some((bugId) => shared.has(bugId))) {
      related.add(node.id);
    }
  }
  return related;
}

/**
 * A request to fly the camera to one node (G4 search): `seq` makes repeated
 * requests for the same node re-trigger the effect.
 */
export interface FocusRequest {
  nodeId: string;
  seq: number;
}

/** Whether an edge (tree or bee) is attached to the given node. */
export function edgeTouchesNode(
  edge: GraphFlowEdge,
  nodeId: string | null,
): boolean {
  if (nodeId === null) return false;
  return edge.source === nodeId || edge.target === nodeId;
}

/** What {@link buildGraph} hands to the React Flow viewport. */
export interface DashboardGraph {
  nodes: GraphFlowNode[];
  edges: GraphFlowEdge[];
  /** Synthetic goal frames (G3), rendered behind `nodes`. */
  goalFrames: GoalFrameNode[];
}

/** Empty graph — the state before the first `/api/tree` response lands. */
export const EMPTY_GRAPH: DashboardGraph = {
  nodes: [],
  edges: [],
  goalFrames: [],
};
