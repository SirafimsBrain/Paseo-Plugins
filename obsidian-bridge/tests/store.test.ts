import { afterEach, describe, expect, it } from "vitest";
import { parseNote } from "../server/parse";
import { BridgeStore, chunkTextHash, toFtsQuery } from "../server/store";

const workspaces: Array<{ cleanup(): void }> = [];

function makeStore(): { store: BridgeStore; dbPath: string; home: string; cleanup(): void } {
  const root = `${process.env.TMPDIR ?? "/tmp"}/obsidian-bridge-store-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  // The store only needs a writable directory; it creates the file itself.
  const dbPath = `${root}/index.db`;
  const store = new BridgeStore(dbPath, { stemming: false });
  const workspace = {
    store,
    dbPath,
    home: root,
    cleanup() {
      try {
        store.close();
      } catch {
        // already closed
      }
    },
  };
  workspaces.push(workspace);
  return workspace;
}

function add(store: BridgeStore, relPath: string, text: string): void {
  store.upsertNote({
    relPath,
    parsed: parseNote(text, relPath),
    mtimeMs: 1,
    size: text.length,
    hash: relPath,
  });
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

describe("toFtsQuery", () => {
  it("quotes terms and joins them with OR by default", () => {
    expect(toFtsQuery("queue design")).toBe('"queue" OR "design"');
  });

  it("joins terms with AND for the strict pass", () => {
    expect(toFtsQuery("queue design", "AND")).toBe('"queue" AND "design"');
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(toFtsQuery("   ")).toBe("");
    expect(toFtsQuery("!!! ???")).toBe("");
  });
});

describe("BridgeStore", () => {
  it("matches every word with AND and any word with OR", () => {
    const { store } = makeStore();
    add(store, "Projects/both.md", "# Both\n\nquadratic smoothing explained\n");
    add(store, "Projects/quadratic.md", "# Quadratic\n\ncomplex numbers\n");
    add(store, "Projects/smoothing.md", "# Smoothing\n\nchart colours\n");

    const strict = store.searchChunks("quadratic smoothing", 10, "AND");
    expect(strict.map((row) => row.path)).toEqual(["Projects/both.md"]);

    const relaxed = store.searchChunks("quadratic smoothing", 10, "OR");
    expect(relaxed.map((row) => row.path).sort()).toEqual([
      "Projects/both.md",
      "Projects/quadratic.md",
      "Projects/smoothing.md",
    ]);
  });

  it("counts only vectors whose chunk still exists", () => {
    const { store } = makeStore();
    add(store, "Projects/a.md", "# A\n\ntext\n");
    const chunk = store.chunksToEmbed("m")[0];
    store.putEmbedding({
      chunkId: chunk.id,
      path: chunk.path,
      modelId: "m",
      dim: 2,
      textHash: chunkTextHash(chunk.text),
      vec: new Float32Array([1, 0]),
    });
    store.putEmbedding({
      chunkId: 999_999,
      path: "Projects/gone.md",
      modelId: "m",
      dim: 2,
      textHash: "orphan",
      vec: new Float32Array([1, 0]),
    });

    expect(store.embeddingStats("m")).toMatchObject({ chunks: 1, embedded: 1 });
    expect(store.clearOrphanEmbeddings()).toBe(1);
    expect(store.embeddingStats("m")).toMatchObject({ chunks: 1, embedded: 1 });
  });

  it("indexes notes and answers full-text queries", () => {
    const { store } = makeStore();
    add(store, "Projects/orion/Research/queue.md", "# Queue design\n\nA bounded queue with retries.\n");
    add(store, "Projects/orion/Plan.md", "# Plan\n\nShip the queue in Q3.\n");
    add(store, "Projects/orion/Research/очередь.md", "# Очередь\n\nОграниченная очередь с повторами.\n");

    expect(store.counts().notes).toBe(3);
    const hits = store.searchChunks("bounded queue", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe("Projects/orion/Research/queue.md");

    // Russian text is searchable through the same unicode61 tokenizer.
    const russian = store.searchChunks("очередь", 10);
    expect(russian.some((hit) => hit.path.includes("очередь.md"))).toBe(true);
  });

  it("ranks title matches and reports backlinks", () => {
    const { store } = makeStore();
    add(store, "Roadmap.md", "# Roadmap\n\nMilestones for the year.\n");
    add(store, "Index.md", "# Index\n\nSee [[Roadmap]] for the plan.\n");
    store.resolveLinks();

    const titles = store.searchTitles("Roadmap", 5);
    expect(titles[0].path).toBe("Roadmap.md");
    expect(store.backlinksOf("Roadmap.md")).toEqual(["Index.md"]);
    expect(store.outgoingLinks("Index.md")[0].target_path).toBe("Roadmap.md");
  });

  it("resolves wikilinks by path, basename and alias, and reports unresolved ones", () => {
    const { store } = makeStore();
    add(store, "Areas/Queue.md", "# Queue\n");
    add(
      store,
      "Notes/Aliased.md",
      "---\naliases: [QD, QueueDoc]\n---\n# Aliased\n",
    );
    add(
      store,
      "Index.md",
      "# Index\n[[Areas/Queue]] [[Queue]] [[QD]] [[Missing note]]\n",
    );
    store.resolveLinks();

    const targets = store.outgoingLinks("Index.md").map((link) => link.target_path);
    expect(targets).toEqual(["Areas/Queue.md", "Areas/Queue.md", "Notes/Aliased.md", null]);
    expect(store.counts().unresolvedLinks).toBe(1);
    expect(store.unresolvedLinks(10)).toEqual([
      { source_path: "Index.md", raw_target: "Missing note" },
    ]);
  });

  it("removes every derived row when a note is deleted", () => {
    const { store } = makeStore();
    add(store, "A.md", "# A\n[[B]] #alpha\n");
    add(store, "B.md", "# B\n");
    store.resolveLinks();
    expect(store.counts()).toMatchObject({ notes: 2, unresolvedLinks: 0 });

    store.deleteNote("B.md");
    expect(store.counts().notes).toBe(1);
    expect(store.counts().unresolvedLinks).toBe(1);
    expect(store.searchChunks("B", 5).every((hit) => hit.path !== "B.md")).toBe(true);
  });

  it("re-indexes a note whose chunks share text without a UNIQUE failure", () => {
    const { store } = makeStore();
    const text = "# A\n\nSame paragraph.\n\n## B\n\nSame paragraph.\n";
    add(store, "Duplicate.md", text);
    const chunks = store.chunksToEmbed("model", 10);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      // Same text in both chunks, so both vectors carry the same text hash.
      store.putEmbedding({
        chunkId: chunk.id,
        path: chunk.path,
        modelId: "model",
        dim: 2,
        textHash: chunkTextHash(chunk.text),
        vec: new Float32Array([1, 0]),
      });
    }

    // A rewrite recreates the chunks; carrying the vectors must not insert two
    // rows for one new chunk id (the `obsidian_index` rebuild failure).
    expect(() => add(store, "Duplicate.md", `${text}\n`)).not.toThrow();
    expect(store.embeddingStats("model")).toMatchObject({ chunks: 2, embedded: 2 });
  });

  it("finds one-hop neighbours through the link graph", () => {
    const { store } = makeStore();
    add(store, "Seed.md", "# Seed\n[[Related]]\n");
    add(store, "Related.md", "# Related\n");
    add(store, "Far.md", "# Far\n");
    store.resolveLinks();

    const neighbours = store.graphNeighbours(["Seed.md"], 5);
    expect(neighbours.map((entry) => entry.path)).toContain("Related.md");
  });
});
