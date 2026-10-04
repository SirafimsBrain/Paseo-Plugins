/**
 * Reciprocal Rank Fusion (RRF) over independent retrieval views.
 *
 * Why ranks and not scores: bm25 values are only comparable *within* one
 * MATCH expression. Two different FTS5 queries over the same table produce
 * scores on unrelated scales, so a weighted sum of raw scores is meaningless.
 * RRF consumes ranks only, which is why it can fuse views that disagree about
 * magnitude but agree about order.
 *
 *   score(d) = Σ 1 / (k + rank_i(d))
 *
 * `k` damps the head of each list: a document ranked first in one view cannot
 * outvote a document that both views place in the top few.
 *
 * Why this matters here (measured, not assumed): on a 5000-row corpus of
 * homogeneous memories an OR-joined query matches ~3200 rows, so bm25 has to
 * order thousands of near-identical documents and the single distinguishing
 * word sinks. Widening the pool and fusing several views is what moves the
 * correct record into the returned page — it improves *recall*, which is the
 * actual failure mode. A cross-encoder was measured at exactly zero gain for
 * the same reason; see ROADMAP.md.
 */

/** RRF damping constant. 60 is the value from the original Cormack et al. paper. */
export const RRF_K = 60;

/** One retrieval view: document ids ordered best-first. */
export type RankedList = number[];

/** A view plus how much its opinion counts. */
export interface WeightedList {
  list: RankedList;
  /** Multiplies this view's contribution. Default 1. */
  weight?: number;
}

/**
 * Fuses ranked lists into one ordering.
 *
 * A document missing from a view contributes nothing from that view (its
 * denominator would invent a rank it never earned). Every input list is
 * de-duplicated first, so a retriever that emits the same id twice cannot
 * double-vote for it.
 *
 * Weights exist because unweighted RRF measured a *regression*: the
 * title-only and short-document views are deliberately narrow, and when they
 * vote equally with the full-text view they drag a strong match down. The
 * primary view therefore carries the dominant weight and the narrow views act
 * as tie-breakers for records the primary view under-ranks, not as peers.
 */
export function rrf(lists: RankedList[], k?: number): RankedList;
export function rrf(lists: WeightedList[], k?: number): RankedList;
export function rrf(lists: RankedList[] | WeightedList[], k: number = RRF_K): RankedList {
  const weighted: WeightedList[] = (lists as WeightedList[]).map((entry) =>
    Array.isArray(entry) ? { list: entry, weight: 1 } : entry,
  );
  const scores = new Map<number, number>();
  for (const entry of weighted) {
    const weight = entry.weight ?? 1;
    const seen = new Set<number>();
    let rank = 0;
    for (const id of entry.list) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
    }
  }
  // Sort by fused score descending; id ascending breaks ties deterministically
  // so two identical queries always produce byte-identical output.
  return [...scores.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0])).map(([id]) => id);
}

/** Convenience: fuse and keep at most `limit` ids. */
export function rrfTop(lists: RankedList[], limit: number, k?: number): RankedList;
export function rrfTop(lists: WeightedList[], limit: number, k?: number): RankedList;
export function rrfTop(lists: RankedList[] | WeightedList[], limit: number, k: number = RRF_K): RankedList {
  const fused =
    (lists as WeightedList[])[0] !== undefined && !Array.isArray((lists as WeightedList[])[0])
      ? rrf(lists as WeightedList[], k)
      : rrf(lists as RankedList[], k);
  return fused.slice(0, Math.max(0, limit));
}

/**
 * Candidate pool size. Wider than the requested `limit` so fusion has room to
 * reorder; measured as the difference between hit@10 and the pool ceiling.
 */
export const CANDIDATE_POOL = 50;