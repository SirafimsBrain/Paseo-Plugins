import { z } from "zod";
import { idSchema } from "./tree";
import type { Bee, BeeStatus } from "./links";

/**
 * Influence cycles (PLAN.md stage L6, `__doc.md` §4.2).
 *
 * A bee is a *directed* influence link between two leaves: "working on this
 * leaf affects that one". A set of legal links can still loop — A affects B,
 * B affects C, C affects A — and a loop has no honest execution order: no leaf
 * in it can be called "first", so a planner must break it before the work can
 * be sequenced. Nothing in the schema forbids a loop (every single link is
 * legal), and nothing is stored for it (the loop is a property of the graph,
 * not of a row), so it is computed here, once, and shared by the dashboard,
 * the details panel and the MCP tools.
 *
 * The detector is Tarjan's strongly-connected-component search over the
 * **live** bees (`active` and `watching`): resolved and cancelled links
 * describe a relationship that is over, and counting them would report a loop
 * nobody has to break any more. Every leaf inside a component of two or more
 * leaves sits on a cycle, and every live bee whose ends are in that component
 * closes one — for a directed graph, an edge inside an SCC lies on a cycle by
 * definition, so no edge needs to be guessed.
 *
 * Determinism: components, members and bees are sorted by id, and the
 * readable `walk` is the shortest cycle through the component's first member.
 * The same bees always produce the same report, whatever order the payload
 * (or a rewrite by an MCP client) delivers them in — a live refetch or a
 * filter change must not make the loop change shape on screen.
 */

/**
 * The fields the detector reads. Accepted as a structural subset of
 * {@link Bee} so callers can pass the payload rows (and tests their own
 * minimal fixtures) without building a whole bee.
 */
export type BeeLink = Pick<
  Bee,
  "id" | "sourceLeafId" | "targetLeafId" | "status"
>;

/**
 * One influence cycle: the leaves in it, the bees that close it, and one
 * readable loop through it.
 */
export const beeCycleSchema = z.object({
  /** Members of the strongly-connected component, sorted by id. */
  nodeIds: z.array(idSchema),
  /** Live bees with both ends in the component, sorted by id. */
  beeIds: z.array(idSchema),
  /**
   * One real cycle through the first member, as a closed walk of leaf ids:
   * `[a, b, c, a]`. The first and the last entry are the same leaf, which is
   * what makes it a loop rather than a path.
   */
  walk: z.array(idSchema),
});
export type BeeCycle = z.infer<typeof beeCycleSchema>;

/** Every cycle of a project, with the aggregates the callers mark with. */
export const beeCycleReportSchema = z.object({
  /** Number of cycles — the project-level `0` is the healthy answer. */
  count: z.number().int().nonnegative(),
  /** Every leaf that sits on a cycle, sorted by id (no duplicates). */
  nodeIds: z.array(idSchema),
  /** Every bee that closes a cycle, sorted by id (no duplicates). */
  beeIds: z.array(idSchema),
  /** The cycles themselves, ordered by their first member id. */
  cycles: z.array(beeCycleSchema),
});
export type BeeCycleReport = z.infer<typeof beeCycleReportSchema>;

/** An empty report — a project without a single cycle. */
export const NO_BEE_CYCLES: BeeCycleReport = {
  count: 0,
  nodeIds: [],
  beeIds: [],
  cycles: [],
};

/**
 * Whether a bee still describes a live influence. `resolved` and `cancelled`
 * are the end of the relationship (`BEE_TRANSITIONS` lets them come back, but
 * while they are there the link is history), so they do not take part in
 * cycles — the same split the bee edge renderer makes when it dashes them.
 */
export function isBeeLive(status: BeeStatus): boolean {
  return status === "active" || status === "watching";
}

/** Ids are opaque strings: compare them, never parse them. */
const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Finds every influence cycle of a project. Linear in leaves plus bees, so it
 * is cheap enough to run on each `/api/tree` rebuild and each node details
 * open — no caching, hence no cache to invalidate.
 */
export function findBeeCycles(
  bees: readonly BeeLink[],
): BeeCycleReport {
  const live = bees.filter(
    (bee) =>
      isBeeLive(bee.status) && bee.sourceLeafId !== bee.targetLeafId,
  );
  if (live.length === 0) return NO_BEE_CYCLES;

  const leaves = [
    ...new Set(
      live.flatMap((bee) => [bee.sourceLeafId, bee.targetLeafId]),
    ),
  ].sort(compareIds);
  const adjacency = new Map<string, string[]>(
    leaves.map((leaf) => [leaf, []]),
  );
  for (const bee of live) {
    const targets = adjacency.get(bee.sourceLeafId);
    if (targets === undefined || targets.includes(bee.targetLeafId)) continue;
    targets.push(bee.targetLeafId);
  }
  for (const targets of adjacency.values()) targets.sort(compareIds);

  const cycles: BeeCycle[] = [];
  for (const component of stronglyConnected(leaves, adjacency)) {
    // A component of one leaf is a leaf that merely influences others: no
    // loop, nothing to break.
    if (component.length < 2) continue;
    const members = new Set(component);
    const beeIds = live
      .filter(
        (bee) =>
          members.has(bee.sourceLeafId) && members.has(bee.targetLeafId),
      )
      .map((bee) => bee.id);
    cycles.push({
      nodeIds: component,
      beeIds: [...new Set(beeIds)].sort(compareIds),
      walk: shortestCycle(component[0]!, adjacency, members),
    });
  }
  cycles.sort((a, b) => compareIds(a.nodeIds[0]!, b.nodeIds[0]!));

  return {
    count: cycles.length,
    nodeIds: [...new Set(cycles.flatMap((cycle) => cycle.nodeIds))].sort(
      compareIds,
    ),
    beeIds: [...new Set(cycles.flatMap((cycle) => cycle.beeIds))].sort(
      compareIds,
    ),
    cycles,
  };
}

/** The cycle that contains `nodeId`, or `null` when it is not on one. */
export function beeCycleOf(
  report: BeeCycleReport,
  nodeId: string,
): BeeCycle | null {
  return (
    report.cycles.find((cycle) => cycle.nodeIds.includes(nodeId)) ?? null
  );
}

/**
 * The loop as one readable line — `A → B → C → A` — for the details panel and
 * the MCP answers, where a list of ids would say nothing. `nameOf` resolves a
 * leaf id; an unknown id falls back to the id itself, so a cycle can never
 * render as an empty arrow chain.
 */
export function beeCycleLabel(
  cycle: BeeCycle,
  nameOf: (nodeId: string) => string,
): string {
  return cycle.walk
    .map((nodeId) => {
      const name = nameOf(nodeId);
      return name.length > 0 ? name : nodeId;
    })
    .join(" → ");
}

/**
 * Tarjan's SCC search, iterative: the depth of the recursion would otherwise
 * follow the length of an influence chain, and a long chain is exactly what a
 * big project has. Components come back with their members sorted by id.
 */
function stronglyConnected(
  leaves: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const frames: Array<{ leaf: string; edge: number }> = [];

  for (const root of leaves) {
    if (index.has(root)) continue;
    frames.push({ leaf: root, edge: 0 });
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.edge === 0) {
        index.set(frame.leaf, counter);
        low.set(frame.leaf, counter);
        counter += 1;
        stack.push(frame.leaf);
        onStack.add(frame.leaf);
      }
      const targets = adjacency.get(frame.leaf) ?? [];
      if (frame.edge < targets.length) {
        const next = targets[frame.edge]!;
        frame.edge += 1;
        if (!index.has(next)) {
          frames.push({ leaf: next, edge: 0 });
        } else if (onStack.has(next)) {
          low.set(
            frame.leaf,
            Math.min(low.get(frame.leaf)!, index.get(next)!),
          );
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]!;
        low.set(parent.leaf, Math.min(low.get(parent.leaf)!, low.get(frame.leaf)!));
      }
      if (low.get(frame.leaf) === index.get(frame.leaf)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.leaf) break;
        }
        components.push(component.sort(compareIds));
      }
    }
  }
  return components;
}

/**
 * The shortest cycle through `start`, breadth-first over the component's own
 * edges. Inside an SCC of two or more leaves such a cycle always exists; the
 * neighbours are pre-sorted, so the walk is the lexicographically first
 * shortest one rather than whichever edge the payload happened to list first.
 */
function shortestCycle(
  start: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  members: ReadonlySet<string>,
): string[] {
  const parent = new Map<string, string | null>([[start, null]]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const leaf = queue.shift()!;
    for (const next of adjacency.get(leaf) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        const walk: string[] = [];
        let cursor: string | null = leaf;
        while (cursor !== null) {
          walk.push(cursor);
          cursor = parent.get(cursor) ?? null;
        }
        walk.reverse();
        walk.push(start);
        return walk;
      }
      if (parent.has(next)) continue;
      parent.set(next, leaf);
      queue.push(next);
    }
  }
  // Unreachable for a component of two or more leaves; a lone leaf is not a
  // loop, and saying so is better than inventing an edge.
  return [start];
}
