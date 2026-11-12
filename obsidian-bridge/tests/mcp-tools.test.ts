import { afterEach, describe, expect, it } from "vitest";
import { indexPathFor } from "../server/paths";
import { scanVault } from "../server/scan";
import { BridgeStore } from "../server/store";
import { dispatchTool, MCP_TOOLS } from "../server/mcp-tools";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

const workspaces: TestWorkspace[] = [];

function workspace(notes: Record<string, string>): TestWorkspace {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

describe("tool catalogue", () => {
  it("exposes read-only tools only", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      "obsidian_search",
      "obsidian_read",
      "obsidian_outline",
      "obsidian_list",
      "obsidian_links",
      "obsidian_index",
      "obsidian_status",
    ]);
    for (const tool of MCP_TOOLS) {
      expect(tool.name.startsWith("obsidian_")).toBe(true);
    }
  });

  it("states the explicit-use contract in every content tool", () => {
    const content = MCP_TOOLS.filter((tool) =>
      ["obsidian_search", "obsidian_read", "obsidian_outline", "obsidian_list", "obsidian_links"].includes(
        tool.name,
      ),
    );
    for (const tool of content) {
      expect(tool.description).toContain("only when the user explicitly asks");
      expect(tool.description).toContain("memory-flash");
    }
  });
});

describe("dispatchTool", () => {
  const notes = {
    "Projects/orion/Plan.md": [
      "---",
      "title: Orion plan",
      "tags: [plan, orion]",
      "---",
      "",
      "# Orion plan",
      "",
      "## Milestones",
      "Ship the queue in Q3 with bounded retries.",
      "",
      "See [[Projects/orion/Research/queue]].",
      "",
    ].join("\n"),
    "Projects/orion/Research/queue.md": "# Queue\n\nA bounded queue with retries and metrics.\n",
    "Inbox.md": "# Inbox\n\nLoose thoughts.\n",
  };

  function indexed(): { workspace: TestWorkspace; settings: ReturnType<typeof runtimeSettings> } {
    const created = workspace(notes);
    const settings = runtimeSettings(created.vault);
    const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
    scanVault({ root: created.vault, store, settings, force: true });
    store.close();
    return { workspace: created, settings };
  }

  it("searches, cites the heading and reports backlinks", () => {
    const { settings } = indexed();
    const outcome = dispatchTool("obsidian_search", { query: "bounded retries" }, settings);
    expect(outcome.isError).toBeUndefined();
    expect(outcome.text).toContain("Projects/orion/Research/queue.md");
    const structured = outcome.structuredContent as {
      hits: Array<{ path: string; heading: string; backlinks: number }>;
    };
    expect(structured.hits.length).toBeGreaterThan(0);
    expect(structured.hits[0].path).toContain("queue.md");
    expect(structured.hits[0].heading).toBe("Queue");
  });

  it("filters by folder and tags", () => {
    const { settings } = indexed();
    const byFolder = dispatchTool(
      "obsidian_search",
      { query: "queue", folder: "Projects/orion/Research" },
      settings,
    );
    const folderHits = (byFolder.structuredContent as { hits: Array<{ path: string }> }).hits;
    expect(folderHits.every((hit) => hit.path.startsWith("Projects/orion/Research"))).toBe(true);

    const byTags = dispatchTool("obsidian_search", { query: "queue", tags: "plan" }, settings);
    const tagHits = (byTags.structuredContent as { hits: Array<{ path: string }> }).hits;
    expect(tagHits.every((hit) => hit.path === "Projects/orion/Plan.md")).toBe(true);
  });

  it("reads a whole note and a single heading subtree", () => {
    const { settings } = indexed();
    const whole = dispatchTool("obsidian_read", { path: "Projects/orion/Plan.md" }, settings);
    expect(whole.text).toContain("bounded retries");

    const section = dispatchTool(
      "obsidian_read",
      { path: "Projects/orion/Plan.md", heading: "Milestones" },
      settings,
    );
    expect(section.text).toContain("Ship the queue in Q3");
    expect(section.text).not.toContain("Loose thoughts");

    const missing = dispatchTool("obsidian_read", { path: "Nope.md" }, settings);
    expect(missing.isError).toBe(true);
  });

  it("refuses a path outside the vault", () => {
    const { settings } = indexed();
    const escape = dispatchTool("obsidian_read", { path: "../../etc/passwd" }, settings);
    expect(escape.isError).toBe(true);
    expect(escape.text).toContain("outside the vault");
  });

  it("outlines a note with links and backlinks", () => {
    const { settings } = indexed();
    const outcome = dispatchTool("obsidian_outline", { path: "Projects/orion/Plan.md" }, settings);
    const outline = outcome.structuredContent as {
      headings: Array<{ text: string }>;
      tags: string[];
      links: Array<{ target_path: string | null }>;
      backlinks: string[];
    };
    expect(outline.headings.map((heading) => heading.text)).toEqual(["Orion plan", "Milestones"]);
    expect(outline.tags).toEqual(expect.arrayContaining(["plan", "orion"]));
    expect(outline.links[0].target_path).toBe("Projects/orion/Research/queue.md");
  });

  it("lists notes and reports status", () => {
    const { settings } = indexed();
    const listed = dispatchTool("obsidian_list", { folder: "Projects" }, settings);
    expect((listed.structuredContent as { count: number }).count).toBe(2);

    const status = dispatchTool("obsidian_status", {}, settings);
    const snapshot = status.structuredContent as { notes: number; readOnly: boolean; isObsidianVault: boolean };
    expect(snapshot.notes).toBe(3);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.isObsidianVault).toBe(true);
  });

  it("reindexes through the tool", () => {
    const { workspace: created, settings } = indexed();
    created.write("Later.md", "# Later\n\nAdded after the first scan.\n");
    const outcome = dispatchTool("obsidian_index", {}, settings);
    expect(outcome.isError).toBeUndefined();
    expect((outcome.structuredContent as { notes: number }).notes).toBe(4);
  });

  it("explains how to configure a missing vault instead of failing obscurely", () => {
    const outcome = dispatchTool("obsidian_search", { query: "x" }, runtimeSettings(""));
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Settings → Plugins → Obsidian Bridge");
  });
});
