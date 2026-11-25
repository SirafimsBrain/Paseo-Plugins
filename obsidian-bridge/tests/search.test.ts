import { afterEach, describe, expect, it } from "vitest";
import { indexPathFor } from "../server/paths";
import { scanVault } from "../server/scan";
import { searchIndex } from "../server/search";
import { BridgeStore } from "../server/store";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/**
 * Lexical retrieval, 0.26.24: the strict `AND` pass answers the query, and the
 * recall `OR` pass only tops the page up when the strict one is thin. The bug
 * these cases lock in: a long note sharing one word outranked the note that
 * contained every word, because FTS5 was asked for `OR` only.
 */

const workspaces: TestWorkspace[] = [];

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function indexedWorkspace(notes: Record<string, string>): TestWorkspace {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  const settings = runtimeSettings(created.vault);
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  scanVault({ root: created.vault, settings, store, force: true });
  store.close();
  return created;
}

function search(created: TestWorkspace, query: string, limit = 10) {
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  const result = searchIndex(store, { query, limit });
  store.close();
  return result;
}

describe("AND-first lexical search", () => {
  it("ranks the note that contains every word above a one-word note", () => {
    const created = indexedWorkspace({
      "Projects/kilo-standalone.md":
        "# Kilo standalone\n\nThe standalone MCP build runs on port 7734.\n",
      "Projects/journal.md":
        "# Journal\n\n" + "kilo ".repeat(200) + "\n",
    });

    const result = search(created, "kilo standalone 7734", 5);
    expect(result.hits[0].path).toBe("Projects/kilo-standalone.md");
    expect(result.hits[0].weakMatch).toBeUndefined();
    const journal = result.hits.find((hit) => hit.path === "Projects/journal.md");
    expect(journal?.weakMatch).toBe(true);
    expect(journal?.score).toBeLessThan(result.hits[0].score);
  });

  it("does not run the OR top-up when the strict pass fills the page", () => {
    const created = indexedWorkspace({
      "Projects/queue-a.md": "# Queue A\n\nA bounded queue with retries.\n",
      "Projects/queue-b.md": "# Queue B\n\nThe queue retries three times.\n",
      "Projects/queue-c.md": "# Queue C\n\nQueue metrics and retries.\n",
      "Projects/garden.md": "# Garden\n\nTomatoes and basil.\n",
    });

    const result = search(created, "queue retries", 10);
    expect(result.signals).toContain("chunks");
    expect(result.signals).not.toContain("chunks-or");
    expect(result.hits.every((hit) => hit.weakMatch === undefined)).toBe(true);
    expect(result.note).toBeNull();
  });

  it("marks every hit weak and says so when no note has all the words", () => {
    const created = indexedWorkspace({
      "Projects/journal.md": "# Journal\n\nOnly kilo appears here.\n",
      "Documentation/notes.md": "# Notes\n\nUnrelated prose about gardens.\n",
    });

    const result = search(created, "kilo standalone 7734", 5);
    expect(result.signals).toContain("chunks-or");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.weakMatch === true)).toBe(true);
    expect(result.note).toContain("weak match");
  });

  it("still answers an empty query from recency", () => {
    const created = indexedWorkspace({ "Inbox/note.md": "# Note\n\nText.\n" });
    const result = search(created, "");
    expect(result.signals).toEqual(["recent"]);
    expect(result.hits[0].path).toBe("Inbox/note.md");
  });
});
