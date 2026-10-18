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
 *
 * Determinism: children are sorted by name before the layout, so the same
 * payload always yields identical positions — required for the fixture tests
 * and for SSE-driven rebuilds (H1) not to make the graph dance.
 */
import type { Edge, Node } from "@xyflow/react";
import { hierarchy, tree } from "d3-hierarchy";
import type { LeafStatus, Node as TreeNode, NodeKind } from "../../shared/tree";
import type { BeeStatus } from "../../shared/links";
import type { TreeResponse } from "../../shared/api";

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
  /** Whether this node currently hides its subtree. */
  collapsed: boolean;
  /** Wired by the Canvas decoration, never by the adapter (see below). */
  onToggle?: () => void;
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

/** A React Flow node positioned by this module. */
export type GraphFlowNode = Node<GraphNodeData>;
/** A React Flow edge produced by this module. */
export type GraphFlowEdge = Edge<TreeEdgeData | BeeEdgeData>;

/** Options of {@link buildGraph}. */
export interface BuildGraphOptions {
  /** Node ids currently hiding their subtree. Defaults to "all expanded". */
  collapsedIds?: ReadonlySet<string>;
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
  const index = indexTree(input.nodes);
  const sizes = subtreeSizes(index);
  const { visible, hiddenCounts } = visibleSet(index, collapsed, sizes);
  const bugCounts = openBugCounts(input);

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
          .filter((child) => visible.has(child.id))
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
    if (!visible.has(node.id)) continue;
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
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
        openBugCount: bugCounts.get(node.id) ?? 0,
        collapsed: collapsed.has(node.id),
      },
      // Positions come from the layout, not from the user (yet).
      draggable: false,
    });
  }

  const edges: GraphFlowEdge[] = [];
  for (const node of input.nodes) {
    if (!visible.has(node.id)) continue;
    if (node.parentId !== null && visible.has(node.parentId)) {
      edges.push({
        id: `t:${node.id}`,
        source: node.parentId,
        target: node.id,
        type: "smoothstep",
        data: { kind: "tree" },
      });
    }
  }
  for (const bee of input.bees) {
    if (!visible.has(bee.sourceLeafId) || !visible.has(bee.targetLeafId)) {
      continue;
    }
    edges.push({
      id: `b:${bee.id}`,
      source: bee.sourceLeafId,
      target: bee.targetLeafId,
      type: "default",
      animated: bee.status === "active",
      data: { kind: "bee", impact: bee.impact, status: bee.status },
    });
  }

  return { nodes, edges };
}


/** Open/investigating incidents per node id — the G3 badge counts. */
function openBugCounts(input: TreeResponse): Map<string, number> {
  const openStatuses = new Set(["open", "investigating"]);
  const bugsById = new Map(input.bugs.map((bug) => [bug.id, bug]));
  const counts = new Map<string, number>();
  for (const attachment of input.bugAttachments) {
    const bug = bugsById.get(attachment.bugId);
    if (!bug || !openStatuses.has(bug.status)) continue;
    counts.set(attachment.nodeId, (counts.get(attachment.nodeId) ?? 0) + 1);
  }
  return counts;
}


/** What {@link buildGraph} hands to the React Flow viewport. */
export interface DashboardGraph {
  nodes: GraphFlowNode[];
  edges: GraphFlowEdge[];
}

/** Empty graph — the state before the first `/api/tree` response lands. */
export const EMPTY_GRAPH: DashboardGraph = { nodes: [], edges: [] };
