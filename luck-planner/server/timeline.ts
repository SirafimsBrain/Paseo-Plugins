import { UI_ACTOR } from "../shared/rpc";
import {
  buildTimelineItem,
  type TimelineItem,
  type TimelineRowInput,
} from "../shared/timeline";
import type { HistoryEntry } from "../shared/tree";
import type { TreeChange } from "./change-feed";
import type { LuckPlannerStore } from "./store";

/**
 * Agent timeline rows (PLAN.md stage H2, `__doc.md` §6).
 *
 * **Where the trigger comes from.** The facts this stage reports are written
 * from two processes: the native panel through plugin RPCs, and agents
 * through the bundled MCP server — a *separate* process with its own
 * connection to the same SQLite file (ADR-3). Stage H1 already solved that
 * shape by polling the append-only `history` trail instead of hooking an
 * in-process write, so H2 rides the same journal: a dedicated {@link ChangeFeed}
 * (see `index.server.ts`) hands each batch of audit rows to
 * {@link notifyTimelineChange}, which turns the two key facts into one
 * timeline row each.
 *
 * **Which agent gets the row.** `paseo.agents.ref(id)` needs a real agent id,
 * and the audit actor is free text: agents stamp `LUCK_PLANNER_AGENT_ID`
 * unless a tool call passes its own `actor`, while approvals and panel moves
 * stamp `user`. The responsible agent is therefore resolved as
 * *the acting agent, otherwise the last agent that touched the same entity* —
 * which is exactly who cares: the agent that proposed a goal learns that a
 * human approved it, and the agent that worked on a leaf learns it reached
 * `done`. Candidates are checked against the daemon (`sink.isAgent`), so a
 * human actor or a decorative string never becomes an append target, and a
 * fact with no live agent is skipped silently — the timeline is a live view,
 * not a queue (rows do not survive a daemon restart anyway).
 *
 * Nothing here throws into the feed: a failed lookup or append is logged and
 * the next row is still processed.
 */

/**
 * The SDK handle as this stage needs it. Structural on purpose: the daemon
 * hands the full `PaseoApi` to hook and RPC contexts, and `server/` importing
 * `@getpaseo/client` types directly would add a dependency the plugin never
 * declares.
 */
export interface TimelinePaseo {
  agents: {
    ref(id: string): {
      refresh(): Promise<unknown>;
      timeline: {
        append(item: TimelineItem): Promise<unknown>;
      };
    };
  };
}

/** The two boundaries this module talks to — tests fake exactly this much. */
export interface TimelineSink {
  /** Whether `candidate` is a real agent on this daemon. */
  isAgent(candidate: string): Promise<boolean>;
  /** Appends one row to that agent's timeline. */
  append(agentId: string, item: TimelineItem): Promise<void>;
}

/** Adapts `PaseoApi` to {@link TimelineSink}. */
export function timelineSink(paseo: TimelinePaseo): TimelineSink {
  return {
    async isAgent(candidate: string): Promise<boolean> {
      try {
        const snapshot = await paseo.agents.ref(candidate).refresh();
        return snapshot !== null && snapshot !== undefined;
      } catch {
        // An unknown id rejects rather than resolving to null on some hosts;
        // either way it is not an agent we can write to.
        return false;
      }
    },
    async append(agentId: string, item: TimelineItem): Promise<void> {
      await paseo.agents.ref(agentId).timeline.append(item);
    },
  };
}

/** The facts worth a timeline row (PLAN.md H2: goal approved, leaf done). */
export type TimelineKeyFact = "goal-approved" | "leaf-done";

/**
 * Classifies one audit row. Only two rows qualify, and both are recognised
 * structurally — never by free text:
 * - `node` + `status` whose recorded transition ends in `done`;
 * - `goal` + `approve` (the gate crossing in `store.approveGoal`).
 */
export function keyFactFor(entry: HistoryEntry): TimelineKeyFact | null {
  if (entry.entityType === "node" && entry.action === "status") {
    // `store.setStatus` records `${from} → ${to}`; only the target matters.
    const arrow = entry.result.lastIndexOf("→");
    if (arrow >= 0 && entry.result.slice(arrow + 1).trim() === "done") {
      return "leaf-done";
    }
    return null;
  }
  if (entry.entityType === "goal" && entry.action === "approve") {
    return "goal-approved";
  }
  return null;
}

/**
 * Row payload for one fact, or `null` when the entity is gone or is not what
 * the fact claims (a non-leaf cannot carry a `done` transition, but the guard
 * keeps a future store change from producing a misleading row).
 */
export function rowFor(
  store: LuckPlannerStore,
  fact: TimelineKeyFact,
  entry: HistoryEntry,
): TimelineRowInput | null {
  if (fact === "leaf-done") {
    const node = store.getNode(entry.projectKey, entry.entityId);
    if (!node || node.kind !== "leaf") return null;
    return {
      event: fact,
      projectKey: entry.projectKey,
      entityId: entry.entityId,
      revision: entry.revision,
      name: node.name,
      actor: entry.actor ?? UI_ACTOR,
      at: entry.at,
      // `in_progress → done` — the transition itself, audit-accurate.
      note: entry.result,
    };
  }
  const goal = store.getGoal(entry.projectKey, entry.entityId);
  if (!goal) return null;
  const steps = goal.plan.length;
  return {
    event: fact,
    projectKey: entry.projectKey,
    entityId: entry.entityId,
    revision: entry.revision,
    name: goal.formalText,
    actor: entry.actor ?? UI_ACTOR,
    at: entry.at,
    note: `${steps} step${steps === 1 ? "" : "s"}`,
  };
}

/** Candidate cap: every candidate costs at most one daemon round trip. */
const MAX_CANDIDATES = 8;

/**
 * Agent ids to try for this fact, best first: the acting agent, then — newest
 * first — every distinct non-`user` actor from the same entity's earlier
 * audit rows (the goal's proposer, the leaf's last worker). `user` is
 * filtered here so the common panel approval does not pay a round trip for a
 * known non-agent.
 */
export function agentCandidates(
  store: LuckPlannerStore,
  entry: HistoryEntry,
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const consider = (actor: string | null): void => {
    if (candidates.length >= MAX_CANDIDATES || actor === null) return;
    const value = actor.trim();
    if (value.length === 0 || value === UI_ACTOR || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  consider(entry.actor);
  const trail = store.listHistory(entry.projectKey, entry.entityId);
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    if (candidates.length >= MAX_CANDIDATES) break;
    // Only history written *before* this fact may name the responsible agent.
    if (trail[i].id >= entry.id) continue;
    consider(trail[i].actor);
  }
  return candidates;
}

export interface TimelineNotifyOptions {
  store: LuckPlannerStore;
  /** `null` while no hook or RPC context has handed over the SDK handle. */
  sink: TimelineSink | null;
  /** Info line: a skipped fact is worth seeing in `paseo plugin logs`. */
  log?: (message: string) => void;
  /** Failures: logged, never rethrown — the feed must keep its cursor. */
  logError?: (message: string) => void;
}

/**
 * Turns one change-feed batch into timeline rows. Row by row, sequentially:
 * batches are small, and order keeps "approved" ahead of anything the same
 * tick appended after it.
 */
export async function notifyTimelineChange(
  change: TreeChange,
  options: TimelineNotifyOptions,
): Promise<void> {
  for (const entry of change.changes) {
    try {
      await notifyEntry(entry, options);
    } catch (cause) {
      options.logError?.(
        `timeline row for ${entry.entityType} ${entry.entityId} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
}

async function notifyEntry(
  entry: HistoryEntry,
  options: TimelineNotifyOptions,
): Promise<void> {
  const fact = keyFactFor(entry);
  if (fact === null) return;
  const { store, sink, log } = options;
  if (sink === null) {
    // No context has arrived yet (fresh load, no hook/RPC call). The journal
    // cursor still advances: rows written before the first handle cannot be
    // delivered later anyway — an agent timeline is daemon-local memory.
    log?.(
      `[luck-planner] timeline: no Paseo SDK handle yet, skipped ${fact} (${entry.entityId})`,
    );
    return;
  }
  const input = rowFor(store, fact, entry);
  if (input === null) {
    log?.(
      `[luck-planner] timeline: entity for ${fact} unavailable (${entry.entityId})`,
    );
    return;
  }
  for (const candidate of agentCandidates(store, entry)) {
    if (!(await sink.isAgent(candidate))) continue;
    await sink.append(candidate, buildTimelineItem(input));
    return;
  }
  log?.(
    `[luck-planner] timeline: no live agent for ${fact} (${entry.entityId})`,
  );
}
