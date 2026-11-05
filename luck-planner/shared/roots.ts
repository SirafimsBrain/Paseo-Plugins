/**
 * Several trees in one project (PLAN.md stage L10).
 *
 * The schema never forbade a second root — `luck_tree_upsert_node` can create
 * one, the 2D layout already lays a forest out side by side and the import
 * format validates "exactly one root" only because merging two projects would
 * *silently* produce two. What was missing is the part that makes a forest
 * usable: a way to see the trees, a way to look at one of them, and a rule for
 * the one decision that has to name a tree — where an approved goal's side
 * branch grows.
 *
 * This module is that rule, as data. It is pure (no store, no DOM, no SDK) so
 * the server and the tab share one implementation instead of drifting: the
 * store asks `pickGoalParent` before it grows a goal, and the dashboard builds
 * the same `Forest` from the payload it already has to render the root strip
 * and to preselect the same branch.
 *
 * Ordering is the one the rest of the dashboard uses (`indexTree`): roots and
 * siblings sorted by name, ties by id. Without it the "default branch" of a
 * tree would depend on insert order, i.e. on who happened to write first.
 */
import type { TreeResponse } from "./api";
import type { Node } from "./tree";

/** One tree of the forest, with the numbers a surface needs to show it. */
export interface ForestRoot {
  readonly id: string;
  readonly name: string;
  /** Live nodes in this tree, the root included. */
  readonly nodeCount: number;
  readonly leafCount: number;
  readonly branchCount: number;
  /**
   * The first live branch/subbranch in tree order — the branch the goal policy
   * picks when the project holds exactly one tree, and the one a surface
   * preselects. `null` means the tree has nowhere to grow a side branch.
   */
  readonly defaultBranchId: string | null;
}

export interface Forest {
  /** Trees, by name (ties by id). Empty when the project has no live node. */
  readonly roots: ForestRoot[];
  /**
   * Live nodes whose parent is not in the payload — a defensive count, never a
   * tree. The store cannot produce one (foreign keys), a filtered payload can.
   */
  readonly orphanCount: number;
}

export const EMPTY_FOREST: Forest = { roots: [], orphanCount: 0 };

/** Sort by name, ties by id — the dashboard's tree order. */
function byNameThenId(a: Node, b: Node): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Groups the live nodes into trees. Iterative on purpose: a chain of ten
 * thousand nodes is a legal tree, and a recursive walk would be a stack
 * overflow in the dashboard rather than a diagram.
 */
export function buildForest(nodes: readonly Node[]): Forest {
  const live = nodes.filter((node) => node.archivedAt === null);
  if (live.length === 0) return EMPTY_FOREST;

  const byId = new Map<string, Node>();
  for (const node of live) byId.set(node.id, node);
  const childrenOf = new Map<string, Node[]>();
  const roots: Node[] = [];
  let orphanCount = 0;
  for (const node of live) {
    if (node.parentId === null || !byId.has(node.parentId)) {
      // A node with a parent the payload does not contain is counted, not
      // invented into a tree: the surface must not show a fake root.
      if (node.parentId === null) roots.push(node);
      else orphanCount += 1;
      continue;
    }
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node);
    childrenOf.set(node.parentId, list);
  }
  roots.sort(byNameThenId);
  for (const list of childrenOf.values()) list.sort(byNameThenId);

  const summaries: ForestRoot[] = [];
  for (const root of roots) {
    let nodeCount = 0;
    let leafCount = 0;
    let branchCount = 0;
    let defaultBranchId: string | null = null;
    // Breadth-first, children in name order: the first branch met is the
    // shallowest one, and among equals the alphabetically first.
    const queue: string[] = [root.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const node = byId.get(id)!;
      nodeCount += 1;
      if (node.kind === "leaf") leafCount += 1;
      if (node.kind === "branch" || node.kind === "subbranch") {
        branchCount += 1;
        if (defaultBranchId === null) defaultBranchId = node.id;
      }
      for (const child of childrenOf.get(id) ?? []) queue.push(child.id);
    }
    summaries.push({
      id: root.id,
      name: root.name,
      nodeCount,
      leafCount,
      branchCount,
      defaultBranchId,
    });
  }
  return { roots: summaries, orphanCount };
}

/** The root a node belongs to, or `null` when it is not in any live tree. */
export function rootIdOf(nodes: readonly Node[], nodeId: string): string | null {
  const byId = new Map<string, Node>();
  for (const node of nodes) {
    if (node.archivedAt === null) byId.set(node.id, node);
  }
  let current = byId.get(nodeId);
  // A legal tree has no cycles, but the walk must still terminate on a broken
  // payload (a hand-edited export): the visited set is cheaper than trust.
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === null) return current.id;
    current = byId.get(current.parentId);
  }
  return null;
}

/** Whether the project is a single tree (the pre-L10 shape, still the norm). */
export function forestIsSingleRoot(forest: Forest): boolean {
  return forest.roots.length === 1;
}

/** The policy's answer, or the sentence that says why there is none. */
export type GoalParentDecision =
  | { readonly ok: true; readonly branchId: string; readonly rootId: string }
  | {
      readonly ok: false;
      readonly reason: "empty" | "ambiguous" | "no-branch";
      readonly message: string;
      readonly roots: readonly ForestRoot[];
    };

/**
 * Where an approved goal grows its side branch when the caller named nothing.
 *
 * The rule, in order: one tree → its default branch; no tree → grow the
 * skeleton first; several trees → refuse and name them. The last case is the
 * whole point of the stage: the model may hold a forest, but **no process may
 * guess** which tree a goal belongs to, because a goal that lands in the wrong
 * tree is a plan nobody will find. So the answer is a question, and the
 * question lists the trees (and their default branches) to answer with.
 */
export function pickGoalParent(nodes: readonly Node[]): GoalParentDecision {
  const forest = buildForest(nodes);
  if (forest.roots.length === 0) {
    return {
      ok: false,
      reason: "empty",
      roots: forest.roots,
      message:
        "the project has no live tree yet — create the skeleton first (a leaf " +
        "without parentId bootstraps root → trunk → branch), then approve the goal",
    };
  }
  if (forest.roots.length > 1) {
    const named = forest.roots
      .map((root) =>
        root.defaultBranchId === null
          ? `"${root.name}" (no branch yet)`
          : `"${root.name}" (default branch ${root.defaultBranchId})`,
      )
      .join(", ");
    return {
      ok: false,
      reason: "ambiguous",
      roots: forest.roots,
      message:
        `the project holds ${forest.roots.length} trees — name parentBranchId: ` +
        `the branch the goal's side branch grows under. Trees: ${named}`,
    };
  }
  const root = forest.roots[0]!;
  if (root.defaultBranchId === null) {
    return {
      ok: false,
      reason: "no-branch",
      roots: forest.roots,
      message:
        `tree "${root.name}" has no live branch — create a branch under it ` +
        "first, then approve the goal",
    };
  }
  return { ok: true, branchId: root.defaultBranchId, rootId: root.id };
}

/**
 * The project narrowed to one tree (stage L10 "explicit surface").
 *
 * Everything that hangs off a dropped node is dropped with it — bees, bug
 * attachments, growth records — because a link with one end outside the view
 * cannot be drawn and cannot be trusted. Bugs themselves and goals that have
 * not materialized yet stay: neither belongs to a tree (a bug is a project
 * incident, a unmaterialized goal is a proposal with no root), and hiding them
 * under every tree would make them disappear from the whole projection.
 */
export function restrictToRoot(
  tree: TreeResponse,
  rootId: string | null,
): TreeResponse {
  if (rootId === null) return tree;
  // A root the payload does not hold means the caller's choice went stale
  // between its render and this build: show everything rather than a void.
  if (!tree.nodes.some((node) => node.id === rootId)) return tree;
  const keep = new Set<string>();
  const childrenOf = new Map<string, Node[]>();
  for (const node of tree.nodes) {
    if (node.archivedAt !== null || node.parentId === null) continue;
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node);
    childrenOf.set(node.parentId, list);
  }
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const child of childrenOf.get(id) ?? []) queue.push(child.id);
  }
  return {
    ...tree,
    nodes: tree.nodes.filter((node) => keep.has(node.id)),
    bees: tree.bees.filter(
      (bee) => keep.has(bee.sourceLeafId) && keep.has(bee.targetLeafId),
    ),
    bugAttachments: tree.bugAttachments.filter((link) => keep.has(link.nodeId)),
    growth: tree.growth.filter(
      (record) =>
        record.subjectType !== "node" || keep.has(record.subjectId),
    ),
    goals: tree.goals.filter(
      (goal) =>
        goal.materializedNodeId === null || keep.has(goal.materializedNodeId),
    ),
  };
}
