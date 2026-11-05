/**
 * Influence cycles, server side (PLAN.md stage L6).
 *
 * Two surfaces answer with a node's cycle — `luck-planner.node-detail` (the
 * details panel and `/api/node/:id`) and the `beeCycle` section of
 * `luck_tree_get_context` — and they must never disagree, so the walk from
 * the store to the shared detector lives here once.
 *
 * The detector itself is `shared/bees.ts`: pure, framework-free and pinned by
 * `tests/bee-cycles.test.ts`, exactly like the other domain modules. This file
 * only adds the two things a server has and the shared module must not know:
 * the store and the cheap guard.
 */
import {
  beeCycleOf,
  findBeeCycles,
  isBeeLive,
  type BeeCycle,
  type BeeCycleReport,
} from "../shared/bees";
import type { LuckPlannerStore } from "./store";

/** Every live influence cycle of one project, deterministically ordered. */
export function projectBeeCycles(
  store: LuckPlannerStore,
  projectKey: string,
): BeeCycleReport {
  return findBeeCycles(store.listBees(projectKey));
}

/**
 * The cycle the leaf sits on, or `null`.
 *
 * A node that no live bee touches cannot be part of a loop, so that case
 * answers without loading the project's bees at all: the details panel asks
 * this on every open — every 2 s while it is pinned — and most nodes in a big
 * project are branches or unlinked leaves.
 */
export function nodeBeeCycle(
  store: LuckPlannerStore,
  projectKey: string,
  nodeId: string,
): BeeCycle | null {
  const touching = store.listBeesForNode(projectKey, nodeId);
  if (!touching.some((bee) => isBeeLive(bee.status))) return null;
  return beeCycleOf(projectBeeCycles(store, projectKey), nodeId);
}
