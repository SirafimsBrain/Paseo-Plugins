/**
 * Search quality diagnostics: recall@k over control queries.
 *
 * Search quality is a number, not an opinion. This module takes control
 * queries with known answers and reports, per query, where the correct record
 * landed — plus the aggregate that decides whether a change is an improvement.
 *
 * The distinction it exists to expose is *retrieval* failure versus *ranking*
 * failure. Measured on a 5000-row corpus: for every query current search
 * missed, the correct record sat at position 501-2001, i.e. absent from the
 * candidate pool. That is why a cross-encoder reranker measured exactly zero
 * gain, and it is the single most useful thing to know about a search change:
 * a fix for ranking is wasted on a retrieval problem. See ROADMAP.md.
 */
import type { MemoryStore } from "./store";

/** One control query: what an agent would type, and what the right answer is. */
export interface ControlQuery {
  /** The free-text query, exactly as an agent would send it. */
  query: string;
  /**
   * Ids that count as correct. A single id for "one exact record", several for
   * "any of these records answers the question" (e.g. every revision of the
   * same fact).
   */
  expectedIds: number[];
}

export interface QueryOutcome {
  query: string;
  /** Rank (1-based) of the first expected id; null when never retrieved. */
  rank: number | null;
  /** 1-based position of the best-scoring wrong record, for context. */
  topWrongRank: number | null;
  /** Total records the search considered for this query. */
  considered: number;
  /** Verdict: how this query failed, if it did. */
  failure: "none" | "not-retrieved" | "ranked-too-low";
}

export interface DiagnoseOptions {
  /** Cutoffs reported in the summary. Defaults to [1, 5, 10, 50]. */
  cutoffs?: number[];
  /** How many results to request per query. Defaults to the largest cutoff. */
  limit?: number;
  /** Extra store filters applied to every control query. */
  project?: string | null;
  tags?: string[];
  kinds?: never[] | Parameters<MemoryStore["search"]>[0]["kinds"];
}

export interface DiagnoseReport {
  queries: QueryOutcome[];
  /** Share of queries whose answer appeared within each cutoff, 0..1. */
  recallAt: Record<string, number>;
  hitsAt: Record<string, number>;
  total: number;
  /**
   * Largest cutoff at which a correct record was still absent from the pool —
   * the number that distinguishes "wrongly ranked" from "never retrieved".
   */
  poolCeiling: number;
  /** Count of queries where the answer never entered the candidate pool. */
  retrievalFailures: number;
  /** Count of queries retrieved but not shown in the top 10. */
  rankingFailures: number;
  /** Queries that failed, most relevant first — the actual work list. */
  misses: Array<{ query: string; rank: number | null }>;
}

const DEFAULT_CUTOFFS = [1, 5, 10, 50];

/**
 * Runs every control query and reports recall@k.
 *
 * @param store live store (read-only usage; nothing is written)
 * @param control the control set; ids must exist in this database
 */
export function diagnose(store: MemoryStore, control: ControlQuery[], options: DiagnoseOptions = {}): DiagnoseReport {
  const cutoffs = [...(options.cutoffs ?? DEFAULT_CUTOFFS)].sort((a, b) => a - b);
  const limit = options.limit ?? Math.max(...cutoffs);
  const valid = control.filter((q) => q.query.trim().length > 0 && q.expectedIds.length > 0);

  const queries: QueryOutcome[] = [];
  for (const item of valid) {
    const results = store.search({
      query: item.query,
      tags: options.tags ?? [],
      kinds: (options.kinds ?? []) as never,
      project: options.project ?? null,
      agentId: null,
      tagMode: "any",
      limit,
    });
    const expected = new Set(item.expectedIds);
    const ids = results.map((r) => r.memory.id);

    let rank: number | null = null;
    for (let i = 0; i < ids.length; i++) {
      if (expected.has(ids[i])) {
        rank = i + 1;
        break;
      }
    }
    // First wrong record: how far ahead of the answer something else sat.
    let topWrongRank: number | null = null;
    for (let i = 0; i < ids.length; i++) {
      if (!expected.has(ids[i])) {
        topWrongRank = i + 1;
        break;
      }
    }

    // "ranked-too-low" means a wrong record beat the answer; "not-retrieved"
    // means the pool never held it at all. The second is a recall problem and
    // no amount of reordering will fix it.
    const failure: QueryOutcome["failure"] =
      rank === null ? "not-retrieved" : rank > cutoffs[cutoffs.length - 1] ? "ranked-too-low" : "none";

    queries.push({ query: item.query, rank, topWrongRank, considered: ids.length, failure });
  }

  const recallAt: Record<string, number> = {};
  const hitsAt: Record<string, number> = {};
  for (const k of cutoffs) {
    const hits = queries.filter((q) => q.rank !== null && q.rank <= k).length;
    hitsAt[String(k)] = hits;
    recallAt[String(k)] = queries.length === 0 ? 0 : Number((hits / queries.length).toFixed(4));
  }

  const retrievalFailures = queries.filter((q) => q.failure === "not-retrieved").length;
  const topCut = cutoffs[cutoffs.length - 1];
  const rankingFailures = queries.filter((q) => q.rank !== null && q.rank > topCut).length;
  const reachable = queries.filter((q) => q.rank !== null);
  const poolCeiling = reachable.length === 0 ? 0 : Math.max(...reachable.map((q) => q.rank as number));

  return {
    queries,
    recallAt,
    hitsAt,
    total: queries.length,
    poolCeiling,
    retrievalFailures,
    rankingFailures,
    misses: queries
      .filter((q) => q.rank === null || q.rank > topCut)
      .map((q) => ({ query: q.query, rank: q.rank }))
      .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)),
  };
}

/** One-line human summary, used by both the MCP tool and the RPC handler. */
export function formatReport(report: DiagnoseReport): string {
  if (report.total === 0) return "No usable control queries (each needs a query and at least one expected id).";
  const parts = Object.keys(report.recallAt)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => `@${k} ${report.hitsAt[k]}/${report.total} (${Math.round(report.recallAt[k] * 100)}%)`);
  return (
    `recall ${parts.join(", ")} — ` +
    `retrieval failures ${report.retrievalFailures}, ranking failures ${report.rankingFailures}, ` +
    `pool ceiling rank ${report.poolCeiling}`
  );
}