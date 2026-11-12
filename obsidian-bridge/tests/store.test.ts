import { afterEach, describe, expect, it } from "vitest";
import { parseNote } from "../server/parse";
import { BridgeStore, toFtsQuery } from "../server/store";

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
  it("quotes terms and joins them with OR", () => {
    expect(toFtsQuery("queue design")).toBe('"queue" OR "design"');
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(toFtsQuery("   ")).toBe("");
    expect(toFtsQuery("!!! ???")).toBe("");
  });
});

describe("BridgeStore", () => {
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
