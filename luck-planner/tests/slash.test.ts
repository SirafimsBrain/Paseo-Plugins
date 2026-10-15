import { describe, expect, it } from "vitest";
import {
  NEW_GOAL_PLACEHOLDER,
  NEW_GOAL_TEXT,
  bugSeverityFromArgs,
  isNodeId,
  parseLuckBug,
  parseLuckStatus,
  resolveLeaf,
  type LeafSearch,
} from "../client/slash";
import type { Node } from "../shared/tree";
import { LEAF_STATUSES } from "../shared/tree";

/**
 * Stage E3 acceptance (`PLAN.md`): slash-command parsing and leaf
 * resolution over injected RPC-shaped callbacks — pure, no React Native,
 * the same discipline as the panel view-model tests.
 */

let seq = 0;

function leaf(overrides: Partial<Node> = {}): Node {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    projectKey: "/projects/demo",
    parentId: null,
    kind: "leaf",
    name: `leaf ${seq}`,
    description: "",
    status: "draft",
    version: "1",
    revision: 1,
    payload: {},
    createdAt: 1,
    updatedAt: 1,
    createdBy: "agent:coder",
    updatedBy: "agent:coder",
    archivedAt: null,
    ...overrides,
  };
}

function searchReturning(nodes: Node[]): LeafSearch {
  return (input) => {
    const filtered = nodes.filter(
      (node) =>
        node.kind === "leaf" &&
        node.name.toLowerCase().includes(input.query.toLowerCase()),
    );
    return Promise.resolve({ results: filtered.map((node) => ({ node })) });
  };
}

describe("parseLuckStatus", () => {
  it("splits the leaf reference from the trailing status", () => {
    const parsed = parseLuckStatus("retry failed charges in_progress");
    expect(parsed).toEqual({
      ok: true,
      value: { leafRef: "retry failed charges", status: "in_progress" },
    });
  });

  it("accepts a single-token reference with a status", () => {
    const parsed = parseLuckStatus("refunds done");
    expect(parsed).toEqual({
      ok: true,
      value: { leafRef: "refunds", status: "done" },
    });
  });

  it("rejects an unknown status and lists the valid ones", () => {
    const parsed = parseLuckStatus("leaf shipped");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('unknown status "shipped"');
      for (const status of LEAF_STATUSES) expect(parsed.error).toContain(status);
    }
  });

  it("rejects missing arguments with the usage line", () => {
    for (const args of ["", "done", "   "]) {
      const parsed = parseLuckStatus(args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("usage: /luck-status");
    }
  });
});

describe("parseLuckBug", () => {
  it("keeps the whole trimmed remainder as the title", () => {
    const parsed = parseLuckBug("  queue stalls under load  ");
    expect(parsed).toEqual({ ok: true, value: { title: "queue stalls under load" } });
  });

  it("rejects an empty title with the usage line", () => {
    const parsed = parseLuckBug("   ");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("usage: /luck-bug");
  });
});

describe("bugSeverityFromArgs", () => {
  it("defaults to medium — the slash command has no severity argument", () => {
    expect(bugSeverityFromArgs("anything")).toBe("medium");
  });
});

describe("isNodeId", () => {
  it("recognizes store-issued uuids only", () => {
    expect(isNodeId("018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c77")).toBe(true);
    expect(isNodeId("retry failed charges")).toBe(false);
    expect(isNodeId("018f47a2-2f4c-7a5e-9c3a")).toBe(false);
  });
});

describe("resolveLeaf", () => {
  it("passes a uuid through without searching", async () => {
    const id = "018f47a2-2f4c-7a5e-9c3a-2f6d3b1a9c77";
    const search: LeafSearch = () => {
      throw new Error("search must not run for a uuid reference");
    };
    await expect(resolveLeaf(search, "/projects/demo", id)).resolves.toEqual({
      ok: true,
      value: { nodeId: id, name: id },
    });
  });

  it("resolves a unique name match", async () => {
    const target = leaf({ name: "retry failed charges" });
    const result = await resolveLeaf(
      searchReturning([target, leaf({ name: "prorate refunds" })]),
      "/projects/demo",
      "retry",
    );
    expect(result).toEqual({
      ok: true,
      value: { nodeId: target.id, name: target.name },
    });
  });

  it("demands specificity on several matches and lists names", async () => {
    const result = await resolveLeaf(
      searchReturning([leaf({ name: "retry A" }), leaf({ name: "retry B" })]),
      "/projects/demo",
      "retry",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("2 leaves match");
      expect(result.error).toContain("retry A");
      expect(result.error).toContain("retry B");
    }
  });

  it("errors when nothing matches", async () => {
    const result = await resolveLeaf(searchReturning([]), "/projects/demo", "ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no leaf matches "ghost"');
  });
});

describe("goal draft placeholders", () => {
  it("carries text and at least one plan step for the ⌘K item", () => {
    expect(NEW_GOAL_TEXT.length).toBeGreaterThan(0);
    expect(NEW_GOAL_PLACEHOLDER.length).toBeGreaterThanOrEqual(1);
    for (const step of NEW_GOAL_PLACEHOLDER) {
      expect(step.id.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
    }
  });
});
