import { describe, expect, it, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore, ftsQuery } from "../server/store";

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-flash-"));
  store = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
});

afterAll(() => {
  try {
    store?.close();
  } catch {
    // Already closed by the reopen test.
  }
});

describe("ftsQuery", () => {
  it("builds AND-ed quoted terms", () => {
    expect(ftsQuery("login bug fix")).toBe('"login" AND "bug" AND "fix"');
  });

  it("keeps quoted phrases and strips punctuation", () => {
    expect(ftsQuery('auth "sign in" flow!')).toBe('"sign in" AND "auth" AND "flow"');
  });

  it("returns null for punctuation-only input", () => {
    expect(ftsQuery("!!! ???")).toBeNull();
  });
});

describe("MemoryStore", () => {
  it("creates and reads memories with normalized tags", () => {
    const memory = store.create({
      kind: "decision",
      title: "Use SQLite FTS5",
      content: "Chose FTS5 over a vector index for local full-text search.",
      tags: ["Storage", "storage", "SQLite"],
      project: null,
      agentId: "opencode-1",
    });
    expect(memory.id).toBeGreaterThan(0);
    expect(memory.tags).toEqual(["sqlite", "storage"]);
    expect(memory.revision).toBe(1);

    const loaded = store.getById(memory.id);
    expect(loaded?.title).toBe("Use SQLite FTS5");
    expect(loaded?.agentId).toBe("opencode-1");
  });

  it("updates bump revision and record history", () => {
    const memory = store.create({
      kind: "note",
      title: "Draft",
      content: "Initial text",
      tags: ["wip"],
      project: null,
      agentId: null,
    });
    const updated = store.update(memory.id, {
      kind: "note",
      title: "Draft v2",
      content: "Improved text",
      tags: ["wip", "done"],
      project: "paseo",
      agentId: "cline-1",
      changedBy: "cline-1",
    });
    expect(updated.revision).toBe(2);
    expect(updated.tags).toEqual(["done", "wip"]);

    const history = store.historyOf(memory.id);
    expect(history).toHaveLength(2);
    expect(history[0].revision).toBe(2);
    expect(history[0].changedBy).toBe("cline-1");
    expect(history[1].changeKind).toBe("create");
  });

  it("deletes keep a tombstone revision", () => {
    const memory = store.create({
      kind: "pitfall",
      title: "Do not X",
      content: "Y breaks when Z",
      tags: [],
      project: null,
      agentId: null,
    });
    expect(store.delete(memory.id, "tester")).toBe(true);
    expect(store.getById(memory.id)).toBeNull();
    const history = store.historyOf(memory.id);
    expect(history[0].changeKind).toBe("delete");
  });

  it("searches with FTS5 across title and content", () => {
    store.create({
      kind: "procedure",
      title: "Deploy checklist",
      content: "Run vitest, then npm run build, then paseo plugin reload.",
      tags: ["deploy"],
      project: null,
      agentId: null,
    });
    store.create({
      kind: "bugfix",
      title: "Port collision",
      content: "The daemon websocket conflicted with Joplin on port 6767.",
      tags: ["network"],
      project: null,
      agentId: null,
    });
    const results = store.search({ query: "websocket", limit: 10, tags: [], kinds: [], project: null, agentId: null, tagMode: "any" });
    expect(results).toHaveLength(1);
    expect(results[0].memory.title).toBe("Port collision");
    expect(results[0].snippet).toBeTruthy();
  });

  it("filters by kind, tag (any/all), project and agent", () => {
    store.create({ kind: "decision", title: "A", content: "alpha", tags: ["one"], project: "p1", agentId: "ag1" });
    store.create({ kind: "bugfix", title: "B", content: "beta", tags: ["one", "two"], project: "p2", agentId: "ag2" });
    store.create({ kind: "decision", title: "C", content: "gamma", tags: ["two"], project: "p2", agentId: "ag2" });

    const base = { query: "", limit: 10, project: null, agentId: null };
    expect(store.search({ ...base, kinds: ["decision"], tags: [], tagMode: "any" })).toHaveLength(2);
    expect(store.search({ ...base, kinds: [], tags: ["one"], tagMode: "any" })).toHaveLength(2);
    expect(store.search({ ...base, kinds: [], tags: ["one", "two"], tagMode: "all" })).toHaveLength(1);
    expect(store.search({ ...base, kinds: [], tags: [], tagMode: "any", project: "p2" })).toHaveLength(2);
    expect(store.search({ ...base, kinds: [], tags: [], tagMode: "any", agentId: "ag1" })).toHaveLength(1);
  });

  it("lists with pagination and total", () => {
    for (let i = 0; i < 5; i += 1) {
      store.create({ kind: "note", title: `N${i}`, content: `c${i}`, tags: [], project: null, agentId: null });
    }
    const page1 = store.list({ query: "", kinds: [], tags: [], project: null, agentId: null, tagMode: "any", limit: 2, offset: 0 });
    const page2 = store.list({ query: "", kinds: [], tags: [], project: null, agentId: null, tagMode: "any", limit: 2, offset: 2 });
    expect(page1.total).toBe(5);
    expect(page1.memories).toHaveLength(2);
    expect(page2.memories).toHaveLength(2);
    expect(page1.memories[0].id).not.toBe(page2.memories[0].id);
  });

  it("restores a past revision", () => {
    const memory = store.create({ kind: "note", title: "v1", content: "one", tags: [], project: null, agentId: null });
    store.update(memory.id, { kind: "note", title: "v2", content: "two", tags: [], project: null, agentId: null, changedBy: null });
    const history = store.historyOf(memory.id);
    const restored = store.restoreRevision(history[history.length - 1].id, "tester");
    expect(restored.title).toBe("v1");
    expect(restored.content).toBe("one");
  });

  it("purges by filter and refuses empty filters", () => {
    store.create({ kind: "note", title: "A", content: "a", tags: ["temp"], project: null, agentId: null });
    store.create({ kind: "decision", title: "B", content: "b", tags: ["keep"], project: null, agentId: null });
    expect(() => store.purge({})).toThrow(/at least one filter/i);
    expect(store.purge({ tags: ["temp"] })).toBe(1);
    expect(store.getById(1)).toBeNull();
    expect(store.getById(2)).not.toBeNull();
  });

  it("reports stats and tags", () => {
    store.create({ kind: "decision", title: "A", content: "a", tags: ["x", "y"], project: "p", agentId: "ag" });
    store.create({ kind: "note", title: "B", content: "b", tags: ["x"], project: null, agentId: null });
    const stats = store.stats();
    expect(stats.total).toBe(2);
    expect(stats.byKind).toEqual([
      { kind: "decision", count: 1 },
      { kind: "note", count: 1 },
    ]);
    expect(stats.topTags[0]).toEqual({ tag: "x", count: 2 });
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
    expect(store.allTags()).toEqual([
      { tag: "x", count: 2 },
      { tag: "y", count: 1 },
    ]);
  });

  it("trims per-memory history to the configured limit", () => {
    store.historyLimitPerMemory = 10;
    const memory = store.create({ kind: "note", title: "t", content: "c", tags: [], project: null, agentId: null });
    for (let i = 2; i <= 30; i += 1) {
      store.update(memory.id, { kind: "note", title: `t${i}`, content: "c", tags: [], project: null, agentId: null, changedBy: null });
    }
    expect(store.historyOf(memory.id).length).toBeLessThanOrEqual(10);
  });

  it("persists across reopen (WAL)", () => {
    const memory = store.create({ kind: "note", title: "durable", content: "still here", tags: ["p"], project: null, agentId: null });
    store.close();
    const reopened = new MemoryStore({ dbPath: path.join(dir, "memory.db") });
    expect(reopened.getById(memory.id)?.title).toBe("durable");
    reopened.close();
    // The shared per-test store is already closed; make afterAll a no-op.
    store = undefined as unknown as MemoryStore;
  });
});
