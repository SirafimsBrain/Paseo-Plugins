// Acceptance check: does the shipped fused search actually beat the previous
// single-query bm25 on the failure mode it was built for?
//
// Builds the same kind of homogeneous corpus the analysis measured (one
// distinguishing fact per record, 5000 rows), then compares:
//   - baseline: single OR-joined bm25 over top-`limit`   (memory-flash <= 0.6.0)
//   - shipped : multi-view RRF over a pool of 50          (memory-flash 0.7.0)
// on queries where the agent remembers the symptom, not the wording.
//
// Run: node scripts/measure-search.mjs
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The store is TypeScript, so compile it (and the rrf helper it pulls in) into
// a temporary ESM bundle first — the same esbuild the plugin already ships.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-measure-build-"));
const outFile = path.join(tmpDir, "store.mjs");
await build({
  entryPoints: [path.join(root, "server", "store.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: outFile,
  external: ["node:*"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
const { MemoryStore, ftsViews, parseQuery } = await import(outFile);

const N = Number(process.env.ROWS ?? 5000);

// --- corpus: the shape that actually loses records -------------------------
// One template for every record, so the ONLY distinguishing words live in the
// cause (content) and the ticket. Titles repeat the component and symptom, as
// agents actually write them. This is what makes an OR query match thousands of
// near-identical rows and buries the one record that differs.
const FACTS = [
  ['auth-service', 'login returns 401 after a token refresh', 'the bearer token was cached without expires_at', 'MF-1180'],
  ['session-store', 'the connection pool is exhausted', 'a client leaked in the health check handler', 'MF-1181'],
  ['search-index', 'search returns nothing after a bulk edit', 'the FTS index was not rebuilt in the migration', 'MF-1182'],
  ['uploader', 'uploads stall near the end of large files', 'the timeout was shorter than the slowest request', 'MF-1183'],
  ['queue', 'repeated failures hammer the service', 'the retry loop had no backoff', 'MF-1184'],
  ['cache', 'users see old data until they refresh', 'the response was cached before the write committed', 'MF-1185'],
  ['csv-import', 'import creates duplicate rows', 'the duplicate check ran outside the insert transaction', 'MF-1186'],
  ['sync-engine', 'timestamps drift by a few hours', 'timestamps were stored in local time instead of UTC', 'MF-1187'],
  ['worker', 'queue items vanish before they finish', 'the ack was sent before the handler returned', 'MF-1188'],
  ['canvas', 'the canvas is blank after moving the window', 'devicePixelRatio was read once at mount', 'MF-1189'],
];
// Paraphrases: some share words with the record, some share none. The latter
// is the honest hard case — no ranking system can retrieve a record whose
// vocabulary the query does not share at all.
const QUERIES = [
  ['why does auth break after token refresh', 'MF-1180'],
  ['api returns 401 right after refreshing', 'MF-1180'],
  ['server runs out of database connections', 'MF-1181'],
  ['health check seems to leak something', 'MF-1181'],
  ['search finds nothing after a bulk edit', 'MF-1182'],
  ['search is stale after a migration', 'MF-1182'],
  ['large file transfer cuts off near the end', 'MF-1183'],
  ['timeouts are too aggressive for slow requests', 'MF-1183'],
  ['repeated failures hammer the service', 'MF-1184'],
  ['retry storms overload the backend', 'MF-1184'],
  ['stale data served right after a write', 'MF-1185'],
  ['users see old data until refresh', 'MF-1185'],
  ['same record imported twice', 'MF-1186'],
  ['duplicate rows appear on re-import', 'MF-1186'],
  ['timestamps drift by a few hours', 'MF-1187'],
  ['events land at the wrong local time', 'MF-1187'],
  ['messages marked done before they finish', 'MF-1188'],
  ['work disappears from the queue too early', 'MF-1188'],
  ['blank canvas after moving the window', 'MF-1189'],
  ['rendering breaks on high-dpi screens', 'MF-1189'],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-measure-"));
const store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
console.log(`building ${N} homogeneous records...`);
for (let i = 0; i < N; i++) {
  const [component, symptom, cause, ticket] = FACTS[i % FACTS.length];
  store.create(
    {
      kind: "bugfix",
      title: `${component}: ${symptom}`,
      content:
        `Ticket ${ticket}. Symptom: ${symptom}.\nRoot cause: ${cause}.\n` +
        `Fix: corrected in ${component}.\nVerification: reproduced on staging, regression test added in 0.${1 + (i % 9)}.${i % 20}.`,
    },
    "measure",
  );
}

// --- baseline: exactly what <= 0.6.0 did -----------------------------------
const db = new DatabaseSync(store.dbPath, { readOnly: true });
const bm = db.prepare(
  `SELECT m.id AS id FROM memories m JOIN memories_fts ON memories_fts.rowid = m.id
   WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`,
);
function baselineSearch(query, limit) {
  const match = parseQuery(query).match;
  if (match === null) return [];
  try {
    return bm.all(match, limit).map((r) => Number(r.id));
  } catch {
    return [];
  }
}
const baselineRanks = QUERIES.map(([q, ticket]) => {
  const ids = baselineSearch(q, 10);
  return { ticket, rank: ids.length ? findRank(db, ids, ticket) : null };
});

// --- shipped: the real store ---------------------------------------------
const shippedRanks = QUERIES.map(([q, ticket]) => {
  const results = store.search({ query: q, tags: [], kinds: [], limit: 10 });
  const ids = results.map((r) => r.memory.id);
  return { ticket, rank: ids.length ? findRank(db, ids, ticket) : null };
});

/** Rank of the first record of `ticket` in `ids` (1-based), or null. */
function findRank(database, ids, ticket) {
  const marks = new Map();
  const stmt = database.prepare("SELECT id FROM memories WHERE content LIKE ?");
  for (const row of stmt.all(`%Ticket ${ticket}.%`)) marks.set(Number(row.id), true);
  const pos = ids.findIndex((id) => marks.get(id));
  return pos >= 0 ? pos + 1 : null;
}

/** The pre-0.7.0 ranking: one OR-joined bm25 over the bare index. */
function baselineSearch2(database, query, limit) {
  const match = parseQuery(query).match;
  if (match === null) return [];
  try {
    return database
      .prepare(
        `SELECT m.id AS id FROM memories m JOIN memories_fts ON memories_fts.rowid = m.id
         WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(match, limit)
      .map((r) => Number(r.id));
  } catch {
    return [];
  }
}

function report(label, data) {
  const hits = data.filter((d) => d.rank !== null && d.rank <= 10).length;
  const mean = (() => {
    const found = data.filter((d) => d.rank !== null);
    return found.length ? (found.reduce((s, d) => s + d.rank, 0) / found.length).toFixed(1) : "—";
  })();
  console.log(`${label.padEnd(26)} hit@10 ${String(hits).padStart(2)}/${data.length}  (${Math.round((100 * hits) / data.length)}%)  mean rank ${mean}`);
  return hits;
}

console.log(`\ncorpus: ${N} records, ${QUERIES.length} paraphrased queries, answer = the ticket's records\n`);
console.log(`views fused per query: ${ftsViews('"a" OR "b"').length}`);
const base = report("baseline bm25 (0.6.0)", baselineRanks);
const ship = report("shipped RRF pool (0.7.0)", shippedRanks);

console.log("\nper-query rank (baseline -> shipped):");
for (let i = 0; i < QUERIES.length; i++) {
  const b = baselineRanks[i].rank;
  const s = shippedRanks[i].rank;
  const mark = b === s ? "=" : (s !== null && (b === null || s < b) ? "better" : "worse");
  console.log(`  ${QUERIES[i][0].slice(0, 42).padEnd(43)} ${String(b ?? "—").padStart(5)} -> ${String(s ?? "—").padStart(5)}  ${mark}`);
}

const regressions = shippedRanks.filter((d, i) => d.rank !== null && baselineRanks[i].rank !== null && d.rank > baselineRanks[i].rank).length;
console.log(`\ndelta: ${ship - base >= 0 ? "+" : ""}${ship - base} queries, regressions among found: ${regressions}`);

// --- second corpus: the case fusion is actually built for ------------------
// Here the query DOES share vocabulary with the record, but the shared words
// also occur in hundreds of others, so single-query bm25 ranks them below the
// cut while the title-only / short-document views pull the record up. This is
// the ranking problem RRF addresses, as opposed to the vocabulary gap above
// that nothing can fix.
console.log("\n=== case 2: shared vocabulary, diluted across many records ===");
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "mf-measure2-"));
const store2 = new MemoryStore({ dbPath: path.join(dir2, "memory.db") });
const COMMON = "the service returned an error while handling the request and the client retried";
for (let i = 0; i < N; i++) {
  const [symptom, cause, , ticket] = FACTS[i % FACTS.length];
  // Every record shares the common filler, so common words are worth nothing.
  store2.create(
    {
      kind: "bugfix",
      title: `incident ${i}: ${symptom}`,
      content: `${COMMON}. ${COMMON}. Ticket ${ticket}. Root cause: ${cause}. Fix applied. Verified on staging.`,
    },
    "measure",
  );
}
const db2 = new DatabaseSync(store2.dbPath, { readOnly: true });
const base2 = QUERIES.map(([q, ticket]) => {
  const ids = baselineSearch2(db2, q, 10);
  return { ticket, rank: ids.length ? findRank(db2, ids, ticket) : null };
});
const ship2 = QUERIES.map(([q, ticket]) => {
  const results = store2.search({ query: q, tags: [], kinds: [], limit: 10 });
  const ids = results.map((r) => r.memory.id);
  return { ticket, rank: ids.length ? findRank(db2, ids, ticket) : null };
});
const base2h = report("baseline bm25 (0.6.0)", base2);
const ship2h = report("shipped RRF pool (0.7.0)", ship2);
console.log("\nper-query rank (baseline -> shipped):");
for (let i = 0; i < QUERIES.length; i++) {
  const b = base2[i].rank;
  const s = ship2[i].rank;
  if (b === s) continue;
  console.log(`  ${QUERIES[i][0].slice(0, 42).padEnd(43)} ${String(b ?? "—").padStart(5)} -> ${String(s ?? "—").padStart(5)}`);
}
console.log(`\ndelta: ${ship2h - base2h >= 0 ? "+" : ""}${ship2h - base2h} queries`);
store2.close();
db2.close();
fs.rmSync(dir2, { recursive: true, force: true });

store.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(tmpDir, { recursive: true, force: true });
// Acceptance gate: fusion must not lose to the baseline it replaces.
if (ship < base || ship2h < base2h) {
  console.error(`REGRESSION: fused search is worse than baseline (${base}/${base2h} vs ${ship}/${ship2h}).`);
  process.exit(1);
}
console.log("OK: fused search is at least as good as the previous single-query ranking.");