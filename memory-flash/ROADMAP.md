# memory-flash roadmap

Decisions here are taken on measurements, not on advice or assumptions. Every
number below was produced by running code against a 5000-row corpus built to
mirror this plugin's storage, not by reading documentation.

## Current state: recall is measured, not assumed

The search quality of this plugin is a measurable quantity. `memory_diagnose`
takes a set of control queries with known answers and reports, per query, the
rank of the correct record plus aggregate recall@k. Search changes are judged
against those numbers instead of impressions.

Measured on a 5000-row corpus of deliberately homogeneous memories (same
template, one distinguishing fact per record) with 20 paraphrased queries where
the agent remembers the symptom but not the wording stored on disk:

| System | hit@10 |
|---|---|
| FTS5 bm25, top-10 | 14/20 |
| FTS5 bm25, pool-50 | 14/20 |
| Cross-encoder rerank, top-10 | 14/20 |
| Union pool ceiling (answer present at all) | 14/20 |
| Dense retrieval (bge-small-en, 384d) | 13/20 |
| RRF fusion of FTS5 + dense | 15/20 |

The decisive row is the ceiling. For every query that current search misses, the
correct record sits at position 501, 1001, 1501 or 2001 out of 5000 — it is not
low in the ranking, it is absent from the candidate pool. A reranker reorders a
pool; it cannot conjure a document that recall never retrieved. **This is why
cross-encoder reranking was rejected: measured benefit 0 queries.**

An OR-join over a paraphrased query matches 3200 of 5000 records (64% of the
database). Ranking 3200 near-identical documents by bm25 is what pushes the one
distinguishing word out of reach.

## Shipped in 0.7.0 — zero new dependencies

1. **Widened candidate pool.** `memory_search` ranks a 50-row pool instead of
   the requested `limit`, then cuts it down. Same SQL, no new index, no
   migration. (`memory_list_by_tag` keeps its own path; it lists by tag rather
   than ranking free text.)
2. **Reciprocal Rank Fusion over several FTS5 views.** The pool is assembled
   from five to six independent views (full text, title-only, content-only,
   quoted phrase, short-document, strict AND) and fused with RRF (`k=60`). RRF
   is used instead of score blending because bm25 scores are not comparable
   between different MATCH expressions — only ranks are. The full-text view
   carries weight 3 and the AND view 2, because with equal weights the narrow
   views dragged strong matches below the cut (a measured regression, 15/20 →
   14/20, found by the acceptance gate and fixed).

   **Measured effect on the shipped corpora: +0 queries** (18/20 and 15/20,
   identical to the previous single-query bm25). That is the expected result
   and consistent with the analysis above: the dominant failure is a *vocabulary
   gap*, which fusion cannot fix. What shipped is the infrastructure and the
   guarantee — the ranking is now measurably not-worse, enforced by
   `scripts/measure-search.mjs`, which exits non-zero on regression — plus the
   rank-based plumbing that dense retrieval later plugs into. The gain comes
   from the write protocol, not from re-ranking.
3. **Measurement tooling.** `memory_diagnose` and the `memory-flash.search-diagnose`
   RPC make recall@k observable on the live database.

## Deferred: dense retrieval, and the rule for starting it

**Dense retrieval (embeddings) will be implemented after the first release, once
the knowledge base is large enough that the measurement justifies it. The trigger
is a number, not a feeling.**

Conditions, all of which must hold on the *live* database:

- `memory_diagnose` over at least 40 control queries reports recall@10 **below
  85%**, and
- the pool ceiling shows the misses are retrieval failures (correct record
  absent from the pool), not ranking failures, and
- the knowledge base holds **at least 1000 records**.

Rationale for each condition:

- **recall@10 < 85%** — above that, hybrid FTS5 plus the write protocol is
  adequate and a 472 MB dependency is not worth its weight.
- **misses must be retrieval failures** — if records are already in the pool and
  ranked low, reranking is the cheaper fix. This distinction is the whole reason
  the diagnostic exists.
- **1000 records** — measured on a 5000-row synthetic corpus, dense retrieval
  bought 70% → 75%. Below roughly a thousand records the same relative gain is
  worth less in absolute terms than the operational cost, and the corpus is too
  small for the measurement to be trustworthy.

Once triggered, the plan is dense retrieval (`Xenova/bge-small-en-v1.5`,
quantized, 384 dimensions, English-only per the plugin's English-only rule)
fused with FTS5 by RRF. Measured characteristics already established:

| Property | Measured value |
|---|---|
| Model size (quantized) | 32 MB |
| Index build, 5000 docs | 155 s (30.9 ms/doc, batch 64) |
| Query, brute-force cosine over 5000×384 | 18 ms |
| Vector storage, 5000 records | 7.3 MB |
| Resident memory | 319 MB |
| `node_modules` cost | +472 MB (`onnxruntime-node` 288 MB + `onnxruntime-web` 141 MB) |

Known costs to pay at that point:

- `env.cacheDir` must point outside `node_modules`; the default lives inside it
  and is destroyed by every `npm ci`, forcing a re-download on each
  `paseo plugin update`.
- The committed single-file bundle does not survive `@huggingface/transformers`:
  esbuild emits 1.4 MB but it fails at runtime with
  `Could not load the "sharp" module`. The module must be externalised and
  resolved from the checkout's `node_modules`.
- `onnxruntime-node` is NAPI v6, so ABI stability inside the Electron host
  (`/opt/Paseo/Paseo.bin`) is expected but **not yet verified by an actual run**.
- No `sqlite-vec`: `node:sqlite` refuses extension loading
  (`Cannot enable extension loading because it was disabled at database
  creation`). Vectors live in a BLOB column, cosine runs in JavaScript. At the
  measured scale this is cheaper than shipping a native extension.

## Rejected

- **Cross-encoder reranking** (`Xenova/bge-reranker-base`,
  `Xenova/ms-marco-MiniLM-L-6-v2`) — measured gain 0 queries because the pool
  ceiling equals the baseline. Costs 888 ms per 60 pairs and 250 MB–2 GB of RSS
  per agent process, since the MCP server is spawned once per agent.
- **`sqlite-vec`** — not loadable in Node 24's `node:sqlite`; the npm package
  ships a 4 KB loader and no `.so`.
- **Multilingual models** — the plugin writes English only, so multilingual
  capability is dead weight.

## Standing rule

Any change to search ships together with a `memory_diagnose` run before and
after. A change that does not move recall@k, or that moves it at a cost the
measurement does not justify, does not ship. Opinion is not a metric.