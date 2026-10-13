import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore, ftsQuery, parseQuery } from "../server/store";
import type { LeafStatus, Node, NodeKind } from "../shared/tree";

/**
 * Stage B4 acceptance (`PLAN.md`): FTS5 search with `key=value` filters,
 * OR-tokenization and bm25 ordering, a LIKE fallback when nothing is
 * indexable, and queries that SQLite always accepts. Real SQLite files in a
 * temp directory, no mocks — the discipline of the store and CRUD tests.
 *
 * Two properties are asserted repeatedly because they are the whole point of
 * the stage: search never crosses `project_key`, and a query that SQLite
 * cannot parse must be neutralized (cleaned/quoted) before it reaches MATCH.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:planner";

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-search-"));
  dirs.push(dir);
  return dir;
}

function openStore(): LuckPlannerStore {
  const store = new LuckPlannerStore({
    dbPath: path.join(tempDir(), "luck-planner.db"),
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * Minimal valid skeleton: root → trunk → branch → subbranch. None of these
 * names contain a word the search tests look for, so they never pollute a
 * result set (they only show up in whole-project listings).
 */
function skeleton(store: LuckPlannerStore): {
  root: Node;
  trunk: Node;
  branch: Node;
  subbranch: Node;
} {
  const root = store.createNode({
    projectKey: P,
    parentId: null,
    kind: "root",
    name: "Tech stack",
    actor: ACTOR,
  });
  const trunk = store.createNode({
    projectKey: P,
    parentId: root.id,
    kind: "trunk",
    name: "Platform",
    actor: ACTOR,
  });
  const branch = store.createNode({
    projectKey: P,
    parentId: trunk.id,
    kind: "branch",
    name: "billing",
    actor: ACTOR,
  });
  const subbranch = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "subbranch",
    name: "payments",
    actor: ACTOR,
  });
  return { root, trunk, branch, subbranch };
}

function leaf(
  store: LuckPlannerStore,
  parentId: string,
  options: {
    name: string;
    description?: string;
    status?: LeafStatus;
    payload?: Record<string, unknown>;
  },
): Node {
  return store.createNode({
    projectKey: P,
    parentId,
    kind: "leaf",
    actor: ACTOR,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// parseQuery: key=value filters split from the free text
// ---------------------------------------------------------------------------

describe("parseQuery", () => {
  it("extracts kind, status and project filters, leaving the free text", () => {
    const parsed = parseQuery(
      'kind=leaf status=in_progress project="/projects/one" "pdf export"',
    );
    expect(parsed.filters).toEqual({
      kinds: ["leaf"],
      statuses: ["in_progress"],
      project: "/projects/one",
    });
    expect(parsed.match).toBe('"pdf export"');
  });

  it("keeps unknown pairs as two separate search terms, never glued", () => {
    const parsed = parseQuery("version=beta export");
    expect(parsed.filters.kinds).toEqual([]);
    expect(parsed.filters.project).toBeNull();
    expect(parsed.match).toBe('"version" OR "beta" OR "export"');
  });

  it("lowercases kind and status values and collects repeats", () => {
    const parsed = parseQuery("Kind=Leaf Status=DONE kind=branch");
    expect(parsed.filters.kinds).toEqual(["leaf", "branch"]);
    expect(parsed.filters.statuses).toEqual(["done"]);
  });

  it("falls back to LIKE terms when only filters remain", () => {
    const parsed = parseQuery("kind=leaf");
    expect(parsed.match).toBeNull();
    expect(parsed.freeText.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ftsQuery: what actually reaches SQLite's MATCH
// ---------------------------------------------------------------------------

describe("ftsQuery", () => {
  it("OR-joins single terms so a natural query still matches", () => {
    expect(ftsQuery("login bug fix")).toBe('"login" OR "bug" OR "fix"');
  });

  it("preserves quoted phrases verbatim, ahead of loose terms", () => {
    expect(ftsQuery('auth "sign in" flow')).toBe(
      '"sign in" OR "auth" OR "flow"',
    );
  });

  it("drops English stop words that would drown the ranking", () => {
    expect(ftsQuery("the bug where login fails")).toBe(
      '"bug" OR "login" OR "fails"',
    );
  });

  it("drops Russian stop words so Cyrillic queries stay precise", () => {
    expect(ftsQuery("где ошибка экспорта в отчёте")).toBe(
      '"ошибка" OR "экспорта" OR "отчёте"',
    );
  });

  it("returns null when nothing indexable remains", () => {
    expect(ftsQuery("!!! ???")).toBeNull();
    expect(ftsQuery("a I x")).toBeNull();
    expect(ftsQuery("---")).toBeNull();
    expect(ftsQuery("__")).toBeNull();
    expect(ftsQuery("the")).toBeNull();
    expect(ftsQuery("")).toBeNull();
  });

  it("strips FTS syntax so no token can become an operator", () => {
    const match = ftsQuery("description:bug NEAR(1,foo) a*");
    expect(match).toBe('"descriptionbug" OR "NEAR1foo"');
    expect(match).not.toMatch(/[():*]/);
  });

  it("produces only MATCH expressions SQLite accepts", () => {
    const fts = new DatabaseSync(":memory:");
    try {
      fts.exec(
        "CREATE VIRTUAL TABLE t USING fts5(name, description, tokenize='porter unicode61')",
      );
      const probe = fts.prepare("SELECT rowid FROM t WHERE t MATCH ?");
      const battery = [
        "login bug",
        '"exact phrase"',
        "the a of",
        "---",
        "!!! ???",
        "description:bug",
        "NEAR(1,foo)",
        "a*",
        '"foo:bar"',
        "kind=leaf export",
        "экспорт отчёта",
        "café naïve",
        "1.2.3",
        "don't stop",
        '"say ""hi"""',
        "payload.file",
        "*:*",
        '"',
        "(((((",
        "tag:#hash",
        "status=*",
        "a AND b OR c",
        "%_",
      ];
      for (const raw of battery) {
        const match = ftsQuery(raw);
        if (match === null) continue;
        expect(
          () => probe.all(match),
          `ftsQuery(${JSON.stringify(raw)}) = ${match}`,
        ).not.toThrow();
        // The query string itself must survive parsing too.
        const parsed = parseQuery(raw);
        if (parsed.match !== null) {
          expect(
            () => probe.all(parsed.match!),
            `parseQuery(${JSON.stringify(raw)}).match`,
          ).not.toThrow();
        }
      }
    } finally {
      fts.close();
    }
  });
});

// ---------------------------------------------------------------------------
// search: the acceptance criteria of PLAN.md stage B4
// ---------------------------------------------------------------------------

describe("search", () => {
  it("ranks the strongest bm25 match first", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const strong = leaf(store, subbranch.id, {
      name: "PDF export",
      description: "",
    });
    const short = leaf(store, subbranch.id, {
      name: "export",
      description: "",
    });
    const long = leaf(store, subbranch.id, {
      name: "pipeline notes",
      description:
        "the export of documents is handled here among a long pile of unrelated filler words that make this record heavy",
    });

    const hits = store.search("pdf export", { projectKey: P });
    // Both terms + short document beats one term; short beats long.
    expect(hits.map((hit) => hit.node.id)).toEqual([
      strong.id,
      short.id,
      long.id,
    ]);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].score).toBeGreaterThanOrEqual(hits[i - 1].score);
    }
    expect(hits[0].score).toBeLessThan(0);
  });

  it("includes and excludes nodes by kind filter", () => {
    const store = openStore();
    const { trunk, subbranch } = skeleton(store);
    const tooling = store.createNode({
      projectKey: P,
      parentId: trunk.id,
      kind: "branch",
      name: "export tooling",
      actor: ACTOR,
    });
    const fact = leaf(store, subbranch.id, { name: "PDF export" });

    const all = store.search("export", { projectKey: P });
    expect(all.map((hit) => hit.node.id).sort()).toEqual(
      [tooling.id, fact.id].sort(),
    );
    expect(
      store.search("export", { projectKey: P, kinds: ["branch"] }).map(
        (hit) => hit.node.id,
      ),
    ).toEqual([tooling.id]);
    expect(
      store.search("export", { projectKey: P, kinds: ["leaf"] }).map(
        (hit) => hit.node.id,
      ),
    ).toEqual([fact.id]);
    // The same filter expressed inside the query text.
    expect(
      store.search("export kind=branch", { projectKey: P }).map(
        (hit) => hit.node.id,
      ),
    ).toEqual([tooling.id]);
  });

  it("filters by leaf status, from options and from key=value", () => {
    const store = openStore();
    const { root, trunk, branch, subbranch } = skeleton(store);
    const done = leaf(store, subbranch.id, {
      name: "invoice render",
      status: "done",
    });
    const draft = leaf(store, subbranch.id, {
      name: "invoice draft",
      status: "draft",
    });

    expect(
      store.search("", { projectKey: P, statuses: ["done"] }).map(
        (hit) => hit.node.id,
      ),
    ).toEqual([done.id]);
    expect(
      store.search("invoice status=done", { projectKey: P }).map(
        (hit) => hit.node.id,
      ),
    ).toEqual([done.id]);
    // The whole skeleton is created with the default status `draft`, plus
    // the explicit draft leaf above.
    expect(
      store.search("", { projectKey: P, statuses: ["draft"] }).map(
        (hit) => hit.node.id,
      ).sort(),
    ).toEqual(
      [root.id, trunk.id, branch.id, subbranch.id, draft.id].sort(),
    );
  });

  it("never returns nodes from another project", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const mine = leaf(store, subbranch.id, { name: "PDF export" });
    const theirs = store.createNode({
      projectKey: OTHER,
      parentId: null,
      kind: "root",
      name: "PDF export",
      actor: ACTOR,
    });

    expect(
      store.search("pdf export", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([mine.id]);
    expect(
      store
        .search("pdf export", { projectKey: OTHER })
        .map((hit) => hit.node.id),
    ).toEqual([theirs.id]);
    // A project= filter that points elsewhere yields nothing, not a leak.
    expect(
      store.search(`pdf project=${OTHER}`, { projectKey: P }),
    ).toEqual([]);
  });

  it("excludes archived nodes unless they are asked for", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const fact = leaf(store, subbranch.id, { name: "PDF export" });
    store.archiveNode({ projectKey: P, id: fact.id, actor: ACTOR });

    expect(store.search("pdf", { projectKey: P })).toEqual([]);
    const withArchived = store.search("pdf", {
      projectKey: P,
      includeArchived: true,
    });
    expect(withArchived.map((hit) => hit.node.id)).toEqual([fact.id]);
    expect(withArchived[0].node.archivedAt).not.toBeNull();
  });

  it("keeps the index in sync when a node is renamed", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const fact = leaf(store, subbranch.id, { name: "Invoice renderer" });

    expect(
      store.search("renderer", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([fact.id]);
    store.updateNode({
      projectKey: P,
      id: fact.id,
      name: "Report generator",
      actor: ACTOR,
    });
    expect(store.search("renderer", { projectKey: P })).toEqual([]);
    const renamed = store.search("generator", { projectKey: P });
    expect(renamed.map((hit) => hit.node.id)).toEqual([fact.id]);
    expect(renamed[0].node.name).toBe("Report generator");
  });

  it("searches in Cyrillic, including a capitalized query", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const report = leaf(store, subbranch.id, {
      name: "Отчёт по экспорту",
      description: "библиотека экспорта отчётов",
    });

    expect(
      store.search("экспорту", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([report.id]);
    // unicode61 case folding applies to Cyrillic too.
    expect(
      store.search("Экспорту", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([report.id]);
    // A Russian stop word in the query does not hide the hit.
    expect(
      store.search("где экспорту", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([report.id]);
  });

  it("falls back to a LIKE scan when no term is indexable", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const fact = leaf(store, subbranch.id, {
      name: "retry policy",
      description: "the quick fox retries",
    });
    leaf(store, subbranch.id, {
      name: "unrelated",
      description: "nothing here",
    });

    const hits = store.search("the", { projectKey: P }); // stop word only
    expect(hits.map((hit) => hit.node.id)).toEqual([fact.id]);
    expect(hits[0].score).toBe(0);
    expect(hits[0].snippet).toBeNull();
  });

  it("falls back to LIKE for punctuation-only queries", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const fact = leaf(store, subbranch.id, {
      name: "retry policy",
      description: "failed??? really",
    });
    leaf(store, subbranch.id, { name: "unrelated", description: "plain" });

    expect(
      store.search("???", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([fact.id]);
  });

  it("treats LIKE wildcards as literal text in the fallback", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const underscored = leaf(store, subbranch.id, {
      name: "snake_case helper",
    });
    leaf(store, subbranch.id, { name: "plain helper" });

    expect(
      store.search("_", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([underscored.id]);
    expect(store.search("__", { projectKey: P })).toEqual([]);
    expect(
      store.search("%", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([]);
  });

  it("lists by filters alone when the query has no free text", () => {
    const store = openStore();
    const { root, trunk, branch, subbranch } = skeleton(store);
    const done = leaf(store, subbranch.id, {
      name: "invoice render",
      status: "done",
    });

    const leaves = store.search("kind=leaf", { projectKey: P });
    expect(leaves.map((hit) => hit.node.id)).toEqual([done.id]);
    expect(leaves[0].score).toBe(0);
    expect(leaves[0].snippet).toBeNull();

    const everything = store.search("", { projectKey: P });
    expect(everything.map((hit) => hit.node.id).sort()).toEqual(
      [root.id, trunk.id, branch.id, subbranch.id, done.id].sort(),
    );
  });

  it("searches the indexed JSON payload", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const fact = leaf(store, subbranch.id, {
      name: "invoice render",
      payload: { file: "src/ledger/invoice.ts" },
    });
    leaf(store, subbranch.id, { name: "other fact" });

    expect(
      store.search("ledger", { projectKey: P }).map((hit) => hit.node.id),
    ).toEqual([fact.id]);
  });

  it("returns a description snippet with the match highlighted", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    leaf(store, subbranch.id, {
      name: "invoice render",
      description: "handles export of reports",
    });

    const hits = store.search("export", { projectKey: P });
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("[…]export[…]");
  });

  it("clamps the limit and rejects a nonsense one", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    leaf(store, subbranch.id, { name: "export one" });
    leaf(store, subbranch.id, { name: "export two" });
    leaf(store, subbranch.id, { name: "export three" });

    expect(
      store.search("export", { projectKey: P, limit: 2 }),
    ).toHaveLength(2);
    expect(store.search("export", { projectKey: P, limit: 0 })).toHaveLength(1);
    expect(
      store.search("export", { projectKey: P, limit: 9999 }),
    ).toHaveLength(3);
    expect(() =>
      store.search("export", { projectKey: P, limit: Number.NaN }),
    ).toThrow(/finite number/);
  });

  it("reports readable errors for invalid filters", () => {
    const store = openStore();
    skeleton(store);
    expect(() =>
      store.search("x", {
        projectKey: P,
        kinds: ["bogus" as NodeKind],
      }),
    ).toThrow(/invalid node kind/);
    expect(() => store.search("kind=bogus", { projectKey: P })).toThrow(
      /invalid node kind/,
    );
    expect(() => store.search("status=nope", { projectKey: P })).toThrow(
      /invalid status/,
    );
    expect(() => store.search("x", { projectKey: "   " })).toThrow(
      /project key must not be empty/,
    );
  });

  it("never throws on hostile free-text queries", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    leaf(store, subbranch.id, { name: "export one" });
    const hostile = [
      '"',
      "(((((",
      "*",
      ":",
      "NEAR(",
      "''",
      "\\",
      "%",
      "a AND b OR c",
      '"unterminated',
      "payload:*",
      "100%_-",
      "kind:::",
      "::::",
      '"""',
      "- - -",
    ];
    for (const query of hostile) {
      expect(
        () => store.search(query, { projectKey: P }),
        `query ${JSON.stringify(query)}`,
      ).not.toThrow();
    }
  });

  it("reads without touching revisions, history or the index", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const fact = leaf(store, subbranch.id, {
      name: "export one",
      description: "the one",
    });
    const before = store.getNode(P, fact.id)!;

    store.search("export", { projectKey: P });
    store.search("the", { projectKey: P });
    store.search("", { projectKey: P });

    const after = store.getNode(P, fact.id)!;
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(store.listHistory(P, fact.id)).toHaveLength(1); // only the create
  });
});
