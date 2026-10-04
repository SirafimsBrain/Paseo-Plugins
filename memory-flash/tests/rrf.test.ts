import { describe, expect, it, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, ftsViews, ftsQuery } from "../server/store";
import { rrf, rrfTop, RRF_K, CANDIDATE_POOL } from "../server/rrf";
import { diagnose, formatReport, type ControlQuery } from "../server/diagnose";
import type { MemoryInput, MemoryKind } from "../shared/memories";

let dir: string;
let store: MemoryStore;

/** Create with defaults so each test only states what it cares about. */
function make(
  kind: MemoryKind,
  title: string,
  content: string,
  extra: Partial<MemoryInput> = {},
): { id: number } {
  return store.create({ kind, title, content, tags: [], project: null, agentId: null, ...extra }, "test");
}

/** Search with defaults; the store wants the fully-normalized shape. */
function search(query: string, limit = 10, extra: Record<string, unknown> = {}) {
  return store.search({
    query,
    tags: [],
    kinds: [],
    project: null,
    agentId: null,
    tagMode: "any",
    limit,
    ...extra,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-flash-rrf-"));
  store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
});

afterAll(() => {
  try {
    store?.close();
  } catch {
    // A test may already have closed it.
  }
});

describe("rrf", () => {
  it("sums reciprocal ranks across views", () => {
    const lists = [
      [1, 2, 3],
      [2, 4, 1],
    ];
    const score = (id: number) =>
      lists.reduce((sum, l) => sum + (l.includes(id) ? 1 / (RRF_K + l.indexOf(id) + 1) : 0), 0);
    const fused = rrf(lists);
    expect(fused.slice(0, 2).sort()).toEqual([1, 2]);
    // Ordering must match the fused arithmetic, not incidental array order.
    expect(score(fused[0])).toBeGreaterThanOrEqual(score(fused[1]));
  });

  it("rewards appearing in more views than being early in one", () => {
    // doc 2 sits in two views (1st and 2nd) and must outrank doc 1, which is
    // 1st in a single view only: 1/61 + 1/62 > 1/61.
    const spread = rrf([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(spread[0]).toBe(2);
    // doc 9 is present in every view, so nothing can outvote it.
    const consensus = rrf([[9], [9, 2], [9, 2]]);
    expect(consensus[0]).toBe(9);
  });

  it("does not invent a rank for a document one view omitted", () => {
    const fused = rrf([
      [1, 7],
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(fused).toContain(7);
    expect(fused.indexOf(3)).toBeLessThan(fused.indexOf(7));
  });

  it("de-duplicates ids inside a view so a retriever cannot double-vote", () => {
    expect(rrf([[1, 1, 1, 2]])).toEqual(rrf([[1, 2]]));
  });

  it("is deterministic", () => {
    const lists = [
      [5, 6, 7],
      [7, 6, 5],
    ];
    expect(rrf(lists)).toEqual(rrf(lists));
  });

  it("handles empty input and a limit", () => {
    expect(rrf([])).toEqual([]);
    expect(rrfTop([[1, 2, 3], [3, 2, 1]], 2)).toHaveLength(2);
    expect(rrfTop([[1, 2]], 0)).toEqual([]);
  });

  it("keeps the pool wider than a typical limit", () => {
    expect(CANDIDATE_POOL).toBeGreaterThanOrEqual(50);
  });
});

describe("ftsViews", () => {
  it("builds several independent MATCH expressions", () => {
    const views = ftsViews('"login" OR "token"');
    expect(views.length).toBeGreaterThanOrEqual(3);
    for (const v of views) expect(v.match.length).toBeGreaterThan(0);
  });

  it("separates title-only and content-only retrieval", () => {
    const views = ftsViews('"login"');
    expect(views.some((v) => v.match.includes("title :"))).toBe(true);
    expect(views.some((v) => v.match.includes("content :"))).toBe(true);
  });

  it("adds a strict AND view only for multi-term queries", () => {
    expect(ftsViews('"one"').some((v) => v.match.includes(" AND "))).toBe(false);
    expect(ftsViews('"one" OR "two"').some((v) => v.match.includes(" AND "))).toBe(true);
  });

  it("keeps a quoted phrase verbatim in the phrase view", () => {
    const views = ftsViews('"connection refused" OR "pool"');
    expect(views.some((v) => v.match.includes('"connection refused"'))).toBe(true);
  });

  it("produces only MATCH expressions SQLite accepts", () => {
    // A view that throws would be silently dropped by search(), so validate
    // every one against the real index.
    const db = new DatabaseSync(path.join(dir, "views.db"), { readOnly: false });
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(title, content, tokenize='porter unicode61');" +
        "INSERT INTO t VALUES('login returns 401','the token was cached without expiry');",
    );
    for (const v of ftsViews('"alpha" OR "beta gamma"')) {
      expect(() => db.prepare("SELECT rowid FROM t WHERE t MATCH ? LIMIT 1").get(v.match)).not.toThrow();
    }
    db.close();
  });
});

describe("fused search", () => {
  it("finds an exact match and still returns a snippet", () => {
    const safari = make("bugfix", "Safari file:// blocked", "Safari refuses local file URLs because of CSP.");
    make("note", "Unrelated", "Coffee machine is broken.");
    const results = search("Safari file URLs", 10);
    expect(results[0].memory.id).toBe(safari.id);
    expect(results[0].snippet).toBeTruthy();
  });

  it("keeps structured filters working under fusion", () => {
    make("decision", "Use SQLite WAL", "WAL mode chosen for the store.", { project: "core" });
    const other = make("decision", "Use SQLite WAL too", "WAL mode chosen elsewhere.", { project: "web" });
    const results = search("WAL mode", 10, { project: "web" });
    expect(results.map((r) => r.memory.id)).toEqual([other.id]);
  });

  it("honours the requested limit despite a wider pool", () => {
    for (let i = 0; i < 12; i++) {
      make("note", `Note ${i}`, `shared token keyword number ${i}`);
    }
    for (const limit of [1, 3, 5, 10]) {
      expect(search("token keyword", limit)).toHaveLength(limit);
    }
  });

  it("keeps tag filters applied to fused results", () => {
    make("note", "tagged zebra", "shared content", { tags: ["alpha"] });
    make("note", "untagged zebra", "shared content", { tags: ["beta"] });
    const results = search("shared content", 10, { tags: ["alpha"] });
    expect(results).toHaveLength(1);
    expect(results[0].memory.tags).toContain("alpha");
  });

  it("rescues a distinguishing title term that homogeneous content buries", () => {
    // The measured failure mode: many near-identical bodies, one record whose
    // only distinguishing word lives in the title.
    const filler = "Verification: reproduced on staging and covered by a regression test in the suite.";
    for (let i = 0; i < 40; i++) {
      make("bugfix", `auth: generic failure ${i}`, `${filler} Cause ${i}.`);
    }
    const target = make("bugfix", "auth: oauth refresh token rotation", `${filler} Rotating the refresh token fixed it.`);
    const results = search("oauth refresh token rotation", 5);
    expect(results.map((r) => r.memory.id)).toContain(target.id);
  });

  it("falls back to LIKE when only stop words remain", () => {
    make("note", "the a of", "content words here");
    expect(search("the a of", 5)).toHaveLength(1);
  });

  it("lists newest first for an empty query", () => {
    // Both rows are written inside the same second and `updated_at` is a
    // second-resolution timestamp, so this also pins the id tie-breaker that
    // makes the ordering deterministic instead of arbitrary.
    const first = make("note", "first", "a");
    const second = make("note", "second", "b");
    const results = search("", 5);
    expect(results.map((r) => r.memory.id)).toEqual([second.id, first.id]);
  });

  it("returns nothing when the query matches nothing", () => {
    make("note", "alpha", "alpha");
    expect(search("zzzzznotpresent", 5)).toEqual([]);
  });
});

describe("diagnose", () => {
  it("reports perfect recall when every query hits rank 1", () => {
    const a = make("note", "WAL checkpoint", "WAL checkpoint timer.");
    const b = make("note", "API keys", "Key deletion frees the label.");
    const control: ControlQuery[] = [
      { query: "WAL checkpoint", expectedIds: [a.id] },
      { query: "key deletion", expectedIds: [b.id] },
    ];
    const report = diagnose(store, control);
    expect(report.recallAt["1"]).toBe(1);
    expect(report.retrievalFailures).toBe(0);
    expect(report.rankingFailures).toBe(0);
    expect(report.poolCeiling).toBe(1);
    expect(formatReport(report)).toContain("2/2");
  });

  it("separates a retrieval failure from a ranking failure", () => {
    const hidden = make("note", "unrelated", "nothing shared in common");
    const filler = "Verification: reproduced on staging with a regression test.";
    for (let i = 0; i < 60; i++) {
      make("note", `token ${i}`, filler);
    }
    const found = make("note", "rare zebra phrase", "unique marker");

    const report = diagnose(store, [
      { query: "totally different vocabulary", expectedIds: [hidden.id] },
      { query: "rare zebra", expectedIds: [found.id] },
    ]);
    const missed = report.queries.find((q) => q.failure === "not-retrieved");
    expect(missed).toBeDefined();
    expect(missed?.rank).toBeNull();
    expect(report.retrievalFailures).toBeGreaterThanOrEqual(1);
    expect(report.misses.some((m) => m.rank === null)).toBe(true);
  });

  it("lists never-retrieved misses before ranked-low ones", () => {
    make("note", "only record", "content");
    const report = diagnose(store, [
      { query: "absent words entirely", expectedIds: [9999] },
      { query: "record", expectedIds: [1] },
    ]);
    expect(report.misses[0].rank).toBeNull();
  });

  it("accepts several expected ids for equivalent records", () => {
    const a = make("note", "revision one", "same fact token");
    const b = make("note", "revision two", "same fact token");
    const report = diagnose(store, [{ query: "same fact", expectedIds: [a.id, b.id] }]);
    expect(report.recallAt["10"]).toBe(1);
  });

  it("ignores control entries without a query or ids", () => {
    const report = diagnose(store, [
      { query: "", expectedIds: [1] },
      { query: "x", expectedIds: [] },
    ]);
    expect(report.total).toBe(0);
    expect(formatReport(report)).toContain("No usable control queries");
  });

  it("writes nothing while measuring", () => {
    make("note", "counted", "value");
    const before = store.stats().total;
    diagnose(store, [{ query: "counted", expectedIds: [1] }]);
    expect(store.stats().total).toBe(before);
  });

  it("survives a reopen — real usage is a long-lived database", () => {
    const m = make("note", "persisted title", "persisted content");
    store.close();
    const reopened = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
    try {
      const report = diagnose(reopened, [{ query: "persisted title", expectedIds: [m.id] }]);
      expect(report.recallAt["1"]).toBe(1);
    } finally {
      reopened.close();
    }
  });
});

describe("ftsQuery regression", () => {
  it("returns null when nothing is indexable", () => {
    expect(ftsQuery("")).toBeNull();
    expect(ftsQuery("the a of")).toBeNull();
  });

  it("OR-joins single terms", () => {
    expect(ftsQuery("auth token")).toBe('"auth" OR "token"');
  });
});