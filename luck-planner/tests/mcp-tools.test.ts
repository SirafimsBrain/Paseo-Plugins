import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_TOOLS, dispatchMcpTool } from "../server/mcp-tools";
import { LuckPlannerStore } from "../server/store";
import type { Node } from "../shared/tree";

/**
 * Stage D1 acceptance (`PLAN.md`): one dispatch test per MCP tool — input
 * validation, readable error texts, and the hard rule that nothing reads
 * or writes outside `project_key`. Real SQLite files in a temp directory,
 * no mocks — the same discipline as the store and CRUD tests.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:coder";

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-mcp-"));
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

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function call(
  store: LuckPlannerStore,
  name: string,
  args: Record<string, unknown>,
): ToolResult {
  return dispatchMcpTool(name, args, { store, defaultActor: ACTOR });
}

/** Parses a successful result payload; fails loudly on an error result. */
function payload<T>(result: ToolResult): T {
  if (result.isError) {
    throw new Error(`unexpected tool error: ${result.content[0].text}`);
  }
  return JSON.parse(result.content[0].text) as T;
}

function expectError(result: ToolResult, pattern: RegExp): void {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(pattern);
}

/** root → trunk → branch (+ leafA, leafB) in project P. */
function seedTree(store: LuckPlannerStore): {
  root: Node;
  trunk: Node;
  branch: Node;
  leafA: Node;
  leafB: Node;
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
  const leafA = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    actor: ACTOR,
  });
  const leafB = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "prorate refunds",
    actor: ACTOR,
  });
  return { root, trunk, branch, leafA, leafB };
}

describe("MCP tool surface", () => {
  it("exposes exactly the documented tool set", () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "luck_tree_get_context",
      "luck_tree_search",
      "luck_tree_upsert_leaf",
      "luck_tree_upsert_node",
      "luck_tree_move_node",
      "luck_tree_archive_node",
      "luck_tree_add_bee",
      "luck_tree_report_bug",
      "luck_tree_find_bugs",
      "luck_tree_find_goals",
      "luck_tree_approve_goal",
      "luck_tree_set_goal",
      "luck_tree_update_growth",
      "luck_tree_history",
      "luck_tree_export",
      "luck_tree_import",
    ]);
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.required).toContain("projectKey");
    }
  });

  it("rejects an unknown tool with the list of available ones", () => {
    const store = openStore();
    const result = call(store, "luck_tree_nope", {});
    expectError(result, /Unknown tool: luck_tree_nope/);
    expect(result.content[0].text).toContain("luck_tree_search");
  });

  it("accepts a server-name-prefixed tool name", () => {
    const store = openStore();
    const result = call(store, "luck-planner_luck_tree_search", {
      projectKey: P,
      query: "",
    });
    expect(result.isError).toBeUndefined();
  });
});

describe("luck_tree_get_context", () => {
  it("returns the overview with roots and their children", () => {
    const store = openStore();
    seedTree(store);
    const result = payload<{
      mode: string;
      roots: Array<{ id: string; name: string; children: Array<{ name: string }> }>;
    }>(call(store, "luck_tree_get_context", { projectKey: P }));
    expect(result.mode).toBe("overview");
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].name).toBe("Tech stack");
    expect(result.roots[0].children.map((child) => child.name)).toEqual([
      "Platform",
    ]);
  });

  it("opens a node: path, children, siblings, bees, blocking bugs, growth", () => {
    const store = openStore();
    const { leafA, leafB } = seedTree(store);
    store.createBee({
      projectKey: P,
      sourceLeafId: leafA.id,
      targetLeafId: leafB.id,
      impact: "refund proration depends on retry outcome",
      actor: ACTOR,
    });
    store.createBug({
      projectKey: P,
      title: "webhook 500s",
      severity: "high",
      nodeIds: [leafA.id],
      actor: ACTOR,
    });
    store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leafA.id,
      steps: [
        { id: "s1", title: "spec", state: "completed", facts: [], reason: "" },
        { id: "s2", title: "code", state: "pending", facts: [], reason: "" },
      ],
      actor: ACTOR,
    });

    const result = payload<{
      mode: string;
      node: { id: string; name: string };
      path: Array<{ kind: string; name: string }>;
      children: unknown[];
      siblings: Array<{ id: string }>;
      bees: Array<{ id: string }>;
      blockingBugs: Array<{ title: string }>;
      growth: { total: number; completed: number; ratio: number } | null;
    }>(
      call(store, "luck_tree_get_context", {
        projectKey: P,
        nodeId: leafA.id,
      }),
    );
    expect(result.mode).toBe("node");
    expect(result.node.id).toBe(leafA.id);
    expect(result.path.map((entry) => entry.kind)).toEqual([
      "root",
      "trunk",
      "branch",
      "leaf",
    ]);
    expect(result.children).toEqual([]);
    expect(result.siblings.map((sibling) => sibling.id)).toEqual([leafB.id]);
    expect(result.bees).toHaveLength(1);
    expect(result.blockingBugs.map((bug) => bug.title)).toEqual([
      "webhook 500s",
    ]);
    expect(result.growth).toMatchObject({ total: 2, completed: 1, ratio: 0.5 });
  });

  it("reports an unknown node id as an error", () => {
    const store = openStore();
    seedTree(store);
    const result = call(store, "luck_tree_get_context", {
      projectKey: P,
      nodeId: "00000000-0000-4000-8000-000000000000",
    });
    expectError(result, /not found in project/);
  });

  it("never crosses the project boundary", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const result = call(store, "luck_tree_get_context", {
      projectKey: OTHER,
      nodeId: leafA.id,
    });
    expectError(result, /not found in project/);
  });

  // Stage L1: sections/depth/limit narrow the answer. Every addition is
  // optional, so the calls above stay the compatibility baseline — these
  // tests pin both halves: the new shapes and "no new keys unless asked".
  it("descends one level per `depth` in the overview", () => {
    const store = openStore();
    seedTree(store);

    const flat = payload<{
      roots: Array<{ name: string; children: Array<Record<string, unknown>> }>;
    }>(call(store, "luck_tree_get_context", { projectKey: P, depth: 1 }));
    expect(flat.roots[0].children[0].name).toBe("Platform");
    expect(flat.roots[0].children[0]).not.toHaveProperty("children");

    const deep = payload<{
      roots: Array<{
        children: Array<{ name: string; children: Array<{ name: string }> }>;
      }>;
    }>(call(store, "luck_tree_get_context", { projectKey: P, depth: 2 }));
    expect(deep.roots[0].children[0].name).toBe("Platform");
    expect(deep.roots[0].children[0].children[0].name).toBe("billing");
  });

  it("caps overview listings with `limit` and reports what it dropped", () => {
    const store = openStore();
    const { root } = seedTree(store);
    store.createNode({
      projectKey: P,
      parentId: root.id,
      kind: "trunk",
      name: "Runtime",
      actor: ACTOR,
    });

    const result = payload<{
      roots: Array<{
        children: Array<{ name: string }>;
        omittedChildren?: number;
      }>;
    }>(call(store, "luck_tree_get_context", { projectKey: P, limit: 1 }));
    expect(result.roots[0].children.map((child) => child.name)).toEqual([
      "Platform",
    ]);
    expect(result.roots[0].omittedChildren).toBe(1);
  });

  it("returns only the requested `sections` of a node", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    store.createBug({
      projectKey: P,
      title: "webhook 500s",
      severity: "high",
      nodeIds: [leafA.id],
      actor: ACTOR,
    });

    const result = payload<Record<string, unknown>>(
      call(store, "luck_tree_get_context", {
        projectKey: P,
        nodeId: leafA.id,
        sections: ["blockingBugs"],
      }),
    );
    expect(result.mode).toBe("node");
    expect(result.parentId).toBeTruthy();
    expect((result.blockingBugs as Array<{ title: string }>)[0].title).toBe(
      "webhook 500s",
    );
    for (const key of ["path", "children", "siblings", "bees", "growth"]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("treats an empty `sections` list as \"the node only\"", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const result = payload<Record<string, unknown>>(
      call(store, "luck_tree_get_context", {
        projectKey: P,
        nodeId: leafA.id,
        sections: [],
      }),
    );
    expect(result.node).toMatchObject({ id: leafA.id });
    expect(Object.keys(result).sort()).toEqual([
      "mode",
      "node",
      "parentId",
      "projectKey",
    ]);
  });

  it("caps node listings with `limit` and reports what it dropped", () => {
    const store = openStore();
    const { branch, leafA, leafB } = seedTree(store);
    for (const name of ["retry receipts", "retry invoices"]) {
      store.createNode({
        projectKey: P,
        parentId: branch.id,
        kind: "leaf",
        name,
        actor: ACTOR,
      });
    }
    store.createBee({
      projectKey: P,
      sourceLeafId: leafA.id,
      targetLeafId: leafB.id,
      impact: "refund proration depends on retry outcome",
      actor: ACTOR,
    });

    const result = payload<{
      siblings: Array<{ id: string }>;
      bees: Array<{ id: string }>;
      truncated?: Record<string, number>;
    }>(
      call(store, "luck_tree_get_context", {
        projectKey: P,
        nodeId: leafA.id,
        sections: ["siblings", "bees"],
        limit: 2,
      }),
    );
    expect(result.siblings).toHaveLength(2);
    expect(result.bees).toHaveLength(1);
    // Only the cut list is reported: a list that fits stays silent.
    expect(result.truncated).toEqual({ siblings: 1 });
  });

  it("keeps the full answer when nothing is narrowed", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const result = payload<Record<string, unknown>>(
      call(store, "luck_tree_get_context", { projectKey: P, nodeId: leafA.id }),
    );
    // L6 added `beeCycle` to the full answer: a leaf in a loop is a fact the
    // agent needs before it sequences anything, and `null` costs one token
    // everywhere else.
    expect(Object.keys(result).sort()).toEqual([
      "beeCycle",
      "bees",
      "blockingBugs",
      "children",
      "growth",
      "mode",
      "node",
      "parentId",
      "path",
      "projectKey",
      "siblings",
    ]);
    expect(result.truncated).toBeUndefined();
  });

  // Stage L6: the influence cycle of a leaf, asked for by section.
  it("answers the influence cycle of a leaf when the section is asked for", () => {
    const store = openStore();
    const { leafA, leafB } = seedTree(store);
    store.createBee({
      projectKey: P,
      sourceLeafId: leafA.id,
      targetLeafId: leafB.id,
      impact: "refund proration depends on retry outcome",
      actor: ACTOR,
    });
    store.createBee({
      projectKey: P,
      sourceLeafId: leafB.id,
      targetLeafId: leafA.id,
      impact: "retry budget depends on refund volume",
      actor: ACTOR,
    });

    const result = payload<{
      beeCycle: {
        nodeIds: string[];
        beeIds: string[];
        walk: string[];
        loop: string;
      } | null;
    }>(
      call(store, "luck_tree_get_context", {
        projectKey: P,
        nodeId: leafA.id,
        sections: ["beeCycle"],
      }),
    );
    expect(result.beeCycle?.nodeIds.sort()).toEqual(
      [leafA.id, leafB.id].sort(),
    );
    expect(result.beeCycle?.beeIds).toHaveLength(2);
    expect(result.beeCycle?.walk[0]).toBe(result.beeCycle?.walk.at(-1));
    // The answer also spells the loop out: an agent reading ids alone would
    // not know which leaves it has to break apart. A loop has no first leaf,
    // so the walk may start at either of them — it must still close.
    const loop = result.beeCycle!.loop.split(" → ");
    expect(loop).toHaveLength(3);
    expect(loop[0]).toBe(loop[2]);
    expect(new Set(loop)).toEqual(
      new Set(["retry failed charges", "prorate refunds"]),
    );
    expect(result).not.toHaveProperty("bees");
  });

  it("answers null for a leaf whose bees do not loop", () => {
    const store = openStore();
    const { leafA, leafB } = seedTree(store);
    store.createBee({
      projectKey: P,
      sourceLeafId: leafA.id,
      targetLeafId: leafB.id,
      impact: "one way only",
      actor: ACTOR,
    });
    const result = payload<{ beeCycle: unknown }>(
      call(store, "luck_tree_get_context", {
        projectKey: P,
        nodeId: leafA.id,
        sections: ["beeCycle"],
      }),
    );
    expect(result.beeCycle).toBeNull();
  });

  it("rejects an unknown section and out-of-range depth/limit", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    expectError(
      call(store, "luck_tree_get_context", {
        projectKey: P,
        nodeId: leafA.id,
        sections: ["nope"],
      }),
      /Invalid input: sections\.0/,
    );
    expectError(
      call(store, "luck_tree_get_context", { projectKey: P, depth: 0 }),
      /Invalid input: depth/,
    );
    expectError(
      call(store, "luck_tree_get_context", { projectKey: P, limit: 0 }),
      /Invalid input: limit/,
    );
  });
});

describe("luck_tree_search", () => {
  it("finds nodes by text with kind filters", () => {
    const store = openStore();
    seedTree(store);
    const result = payload<{
      matches: number;
      results: Array<{ id: string; name: string; kind: string }>;
    }>(
      call(store, "luck_tree_search", {
        projectKey: P,
        query: "retry",
        kinds: ["leaf"],
      }),
    );
    expect(result.matches).toBe(1);
    expect(result.results[0].kind).toBe("leaf");
    expect(result.results[0].name).toContain("retry");
  });

  it("returns an empty result set for a foreign project", () => {
    const store = openStore();
    seedTree(store);
    const result = payload<{ matches: number }>(
      call(store, "luck_tree_search", { projectKey: OTHER, query: "retry" }),
    );
    expect(result.matches).toBe(0);
  });

  it("validates kinds and statuses", () => {
    const store = openStore();
    const result = call(store, "luck_tree_search", {
      projectKey: P,
      query: "x",
      kinds: ["magic"],
    });
    expectError(result, /Invalid input/);
  });
});

describe("luck_tree_upsert_leaf", () => {
  it("creates a leaf under a branch with payload and version", () => {
    const store = openStore();
    const { branch } = seedTree(store);
    const result = payload<{ created: boolean; leaf: Node }>(
      call(store, "luck_tree_upsert_leaf", {
        projectKey: P,
        parentId: branch.id,
        name: "invoice pdf export",
        description: "plan: template; fact: done",
        version: "v1",
        payload: { plan: "template", fact: "rendered by worker" },
      }),
    );
    expect(result.created).toBe(true);
    expect(result.leaf.kind).toBe("leaf");
    expect(result.leaf.status).toBe("draft");
    expect(result.leaf.version).toBe("v1");
    expect(result.leaf.payload).toMatchObject({
      plan: "template",
      fact: "rendered by worker",
    });
    expect(result.leaf.createdBy).toBe(ACTOR);
  });

  it("updates an existing leaf and drives a status transition in one call", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const result = payload<{ created: boolean; leaf: Node }>(
      call(store, "luck_tree_upsert_leaf", {
        projectKey: P,
        leafId: leafA.id,
        version: "v2",
        payload: { plan: "exponential backoff", fact: "" },
        status: "ready",
      }),
    );
    expect(result.created).toBe(false);
    expect(result.leaf.revision).toBe(3); // create + update + status = three bumps
    expect(result.leaf.status).toBe("ready");
    expect(result.leaf.version).toBe("v2");
    const history = store.listHistory(P, leafA.id);
    expect(history.map((entry) => entry.action)).toEqual([
      "create",
      "update",
      "status",
    ]);
  });

  it("treats stating the current status as a tolerated no-op", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const result = payload<{ leaf: Node }>(
      call(store, "luck_tree_upsert_leaf", {
        projectKey: P,
        leafId: leafA.id,
        status: "draft", // already draft
      }),
    );
    expect(result.leaf.revision).toBe(1);
  });

  it("rejects creating without name, and without parentId once a tree exists", () => {
    const store = openStore();
    const { branch } = seedTree(store);
    // The project already has a tree — a parentless create is refused with
    // guidance instead of silently picking a place for the leaf.
    expectError(
      call(store, "luck_tree_upsert_leaf", { projectKey: P, name: "x" }),
      /parentId is required when the project already has a tree/,
    );
    expectError(
      call(store, "luck_tree_upsert_leaf", {
        projectKey: P,
        parentId: "00000000-0000-4000-8000-000000000000",
      }),
      /name is required/,
    );
    // Neither rejected call wrote anything.
    expect(store.listChildren(P, null)).toHaveLength(1);
    expect(store.listChildren(P, branch.id)).toHaveLength(2);
  });

  it("bootstraps the skeleton for the very first leaf of a fresh project", () => {
    const store = openStore();
    const result = payload<{ created: boolean; leaf: Node }>(
      call(store, "luck_tree_upsert_leaf", {
        projectKey: P,
        name: "first fact",
        description: "the bootstrap leaf",
      }),
    );
    expect(result.created).toBe(true);
    // One call produced root → trunk → branch → leaf (no tool creates
    // roots/branches, so the first leaf has to grow the skeleton itself).
    const path = store.getNodePath(P, result.leaf.id);
    expect(path.map((node) => node.kind)).toEqual([
      "root",
      "trunk",
      "branch",
      "leaf",
    ]);
    // The root is named after the project key: /projects/demo → demo.
    expect(path[0].name).toBe("demo");
    // The skeleton is not a backdoor around the audit rule.
    for (const node of path) {
      const history = store.listHistory(P, node.id);
      expect(history).toHaveLength(1);
      expect(history[0].actor).toBe(ACTOR);
      expect(history[0].action).toBe("create");
    }
    // Now that a tree exists, the next parentless create gets guidance.
    expectError(
      call(store, "luck_tree_upsert_leaf", { projectKey: P, name: "second" }),
      /parentId is required when the project already has a tree/,
    );
  });

  it("refuses to edit a non-leaf node and an unknown leaf", () => {
    const store = openStore();
    const { trunk, branch } = seedTree(store);
    expectError(
      call(store, "luck_tree_upsert_leaf", {
        projectKey: P,
        leafId: trunk.id,
        name: "renamed",
      }),
      /is a trunk, not a leaf/,
    );
    expectError(
      call(store, "luck_tree_upsert_leaf", {
        projectKey: P,
        leafId: "00000000-0000-4000-8000-000000000000",
        name: "x",
      }),
      /not found in project/,
    );
    // The branch row is untouched by the rejected calls.
    expect(store.getNode(P, branch.id)?.name).toBe("billing");
  });

  it("surfaces an illegal status transition as a readable error and writes nothing", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const result = call(store, "luck_tree_upsert_leaf", {
      projectKey: P,
      leafId: leafA.id,
      status: "done", // draft → done is not a legal transition
    });
    expectError(result, /invalid status transition draft → done/);
    expect(store.getNode(P, leafA.id)?.revision).toBe(1);
    expect(store.listHistory(P, leafA.id)).toHaveLength(1);
  });

  it("cannot touch a leaf of another project", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const result = call(store, "luck_tree_upsert_leaf", {
      projectKey: OTHER,
      leafId: leafA.id,
      name: "hijacked",
    });
    expectError(result, /not found in project/);
    expect(store.getNode(P, leafA.id)?.name).toBe("retry failed charges");
  });
});

describe("luck_tree_upsert_node, luck_tree_move_node, luck_tree_archive_node", () => {
  it("creates a trunk, a branch and a subbranch — the structure a project needs", () => {
    // The gap the stage-D4 test pass found: with the leaf-level tool alone
    // an agent could add facts but not shape the tree, so a project with
    // several functional areas could only be a flat list of leaves.
    const store = openStore();
    const { root } = seedTree(store);
    const trunk = payload<{ created: boolean; node: { id: string; kind: string; name: string } }>(
      call(store, "luck_tree_upsert_node", {
        projectKey: P,
        kind: "trunk",
        parentId: root.id,
        name: "Provider adapters",
      }),
    );
    expect(trunk.created).toBe(true);
    expect(trunk.node.kind).toBe("trunk");
    const branch = payload<{ created: boolean; node: { id: string; kind: string } }>(
      call(store, "luck_tree_upsert_node", {
        projectKey: P,
        kind: "branch",
        parentId: trunk.node.id,
        name: "Cline",
      }),
    );
    expect(branch.node.kind).toBe("branch");
    const subbranch = payload<{ created: boolean; node: { id: string; kind: string } }>(
      call(store, "luck_tree_upsert_node", {
        projectKey: P,
        kind: "subbranch",
        parentId: branch.node.id,
        name: "Store layout",
      }),
    );
    expect(subbranch.node.kind).toBe("subbranch");
  });

  it("renames the auto-created skeleton", () => {
    const store = openStore();
    const { trunk } = seedTree(store);
    const renamed = payload<{ created: boolean; node: { name: string } }>(
      call(store, "luck_tree_upsert_node", {
        projectKey: P,
        nodeId: trunk.id,
        name: "Session manager plugin",
      }),
    );
    expect(renamed.created).toBe(false);
    expect(renamed.node.name).toBe("Session manager plugin");
  });

  it("places a node under the first suitable parent when none is named", () => {
    const store = openStore();
    const { root } = seedTree(store);
    const branch = payload<{ node: { id: string; parentId: string } }>(
      call(store, "luck_tree_upsert_node", {
        projectKey: P,
        kind: "branch",
        name: "Guessed parent",
      }),
    );
    // The first trunk of the root.
    const trunks = store.listChildren(P, root.id);
    expect(branch.node.parentId).toBe(trunks[0]?.id);
  });

  it("refuses an impossible shape with a readable reason", () => {
    const store = openStore();
    const { root } = seedTree(store);
    const result = call(store, "luck_tree_upsert_node", {
      projectKey: P,
      kind: "leaf",
      parentId: root.id,
      name: "Not allowed here",
    });
    expectError(result, /cannot be a child of a root/);
  });

  it("asks for the kind and the name when a node is created", () => {
    const store = openStore();
    seedTree(store);
    expectError(
      call(store, "luck_tree_upsert_node", { projectKey: P, name: "No kind" }),
      /kind is required/,
    );
    expectError(
      call(store, "luck_tree_upsert_node", { projectKey: P, kind: "branch" }),
      /name is required/,
    );
  });

  it("moves a node with its subtree", () => {
    const store = openStore();
    const { branch, leafA } = seedTree(store);
    const other = payload<{ node: { id: string } }>(
      call(store, "luck_tree_upsert_node", {
        projectKey: P,
        kind: "branch",
        name: "Other branch",
      }),
    );
    const moved = payload<{ node: { parentId: string } }>(
      call(store, "luck_tree_move_node", {
        projectKey: P,
        nodeId: leafA.id,
        newParentId: other.node.id,
      }),
    );
    expect(moved.node.parentId).toBe(other.node.id);
    expect(store.getNode(P, branch.id)?.id).toBe(branch.id);
  });

  it("refuses a move that would break the kind rules", () => {
    const store = openStore();
    const { root, leafA } = seedTree(store);
    const result = call(store, "luck_tree_move_node", {
      projectKey: P,
      nodeId: leafA.id,
      newParentId: root.id,
    });
    expectError(result, /cannot be a child of a root/);
  });

  it("archives a node and its whole subtree, and the tree stops showing them", () => {
    const store = openStore();
    const { branch, leafA } = seedTree(store);
    const archived = payload<{ archived: string[] }>(
      call(store, "luck_tree_archive_node", {
        projectKey: P,
        nodeId: branch.id,
      }),
    );
    expect(archived.archived).toContain(branch.id);
    expect(archived.archived).toContain(leafA.id);
    // The live tree no longer shows them; the rows are still in the database.
    const live = store.listChildren(P, branch.id);
    expect(live).toEqual([]);
    const stored = store.listNodes(P, { includeArchived: true });
    expect(stored.some((node) => node.id === leafA.id)).toBe(true);
  });

  it("never touches another project", () => {
    const store = openStore();
    const { branch } = seedTree(store);
    const other = store.createNode({
      projectKey: "/projects/other",
      parentId: null,
      kind: "root",
      name: "Other root",
      actor: ACTOR,
    });
    const result = call(store, "luck_tree_archive_node", {
      projectKey: "/projects/other",
      nodeId: branch.id,
    });
    expectError(result, /not found|does not exist/i);
    // The node of the first project is untouched.
    expect(store.getNode(P, branch.id)?.archivedAt ?? null).toBeNull();
    expect(other.id).not.toBe(branch.id);
  });
});

describe("luck_tree_add_bee", () => {
  it("creates an influence edge with the calling actor", () => {
    const store = openStore();
    const { leafA, leafB } = seedTree(store);
    const result = payload<{ bee: { id: string; impact: string; createdBy: string } }>(
      call(store, "luck_tree_add_bee", {
        projectKey: P,
        sourceLeafId: leafA.id,
        targetLeafId: leafB.id,
        impact: "retry outcome decides proration",
      }),
    );
    expect(result.bee.impact).toBe("retry outcome decides proration");
    expect(result.bee.createdBy).toBe(ACTOR);
  });

  it("rejects self-loops and non-leaf ends with readable messages", () => {
    const store = openStore();
    const { trunk, leafA, leafB } = seedTree(store);
    expectError(
      call(store, "luck_tree_add_bee", {
        projectKey: P,
        sourceLeafId: leafA.id,
        targetLeafId: leafA.id,
      }),
      /cannot connect a leaf to itself/,
    );
    expectError(
      call(store, "luck_tree_add_bee", {
        projectKey: P,
        sourceLeafId: trunk.id,
        targetLeafId: leafB.id,
      }),
      /is a trunk; bees connect leaves only/,
    );
  });

  it("rejects an end from another project", () => {
    const store = openStore();
    const { leafA, leafB } = seedTree(store);
    const foreignLeaf = store.createNode({
      projectKey: OTHER,
      parentId: null,
      kind: "root",
      name: "foreign root",
      actor: ACTOR,
    });
    const result = call(store, "luck_tree_add_bee", {
      projectKey: P,
      sourceLeafId: leafA.id,
      targetLeafId: foreignLeaf.id,
    });
    expectError(result, /not found in project/);
    expect(store.listBees(P)).toHaveLength(0);
    expect(leafB.id).toBeTruthy();
  });
});

describe("luck_tree_report_bug", () => {
  it("creates an incident with immediate leaf attachments", () => {
    const store = openStore();
    const { leafA, leafB } = seedTree(store);
    const result = payload<{
      bug: { id: string; severity: string; status: string; createdBy: string };
      blockedLeaves: number;
    }>(
      call(store, "luck_tree_report_bug", {
        projectKey: P,
        title: "webhook 500s",
        description: "retries exhaust and the customer is not billed",
        severity: "high",
        nodeIds: [leafA.id, leafB.id],
      }),
    );
    expect(result.bug.severity).toBe("high");
    expect(result.bug.status).toBe("open");
    expect(result.bug.createdBy).toBe(ACTOR);
    expect(result.blockedLeaves).toBe(2);
    expect(store.listBlockingBugs(P, leafA.id)).toHaveLength(1);
  });

  it("validates severity and rejects unknown attachment nodes without writing", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    expectError(
      call(store, "luck_tree_report_bug", {
        projectKey: P,
        title: "x",
        severity: "blocker",
      }),
      /Invalid input/,
    );
    const result = call(store, "luck_tree_report_bug", {
      projectKey: P,
      title: "x",
      severity: "low",
      nodeIds: ["00000000-0000-4000-8000-000000000000"],
    });
    expectError(result, /not found in project/);
    expect(store.listBugs(P)).toHaveLength(0);
    expect(store.listBlockingBugs(P, leafA.id)).toHaveLength(0);
  });
});

describe("luck_tree_find_bugs", () => {
  it("lists all bugs of a project, optionally filtered by status", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    call(store, "luck_tree_report_bug", {
      projectKey: P,
      title: "webhook 500s",
      description: "retries exhaust",
      severity: "high",
      nodeIds: [leafA.id],
    });
    call(store, "luck_tree_report_bug", {
      projectKey: P,
      title: "db connection pool",
      description: "exhausted under load",
      severity: "medium",
      status: "investigating",
    });
    call(store, "luck_tree_report_bug", {
      projectKey: P,
      title: "typo in docs",
      description: "fix later",
      severity: "low",
      status: "resolved",
    });

    const all = payload<{ bugs: Array<{ id: string; title: string; status: string }>; total: number; returned: number }>(
      call(store, "luck_tree_find_bugs", { projectKey: P }),
    );
    expect(all.total).toBe(3);
    expect(all.returned).toBe(3);
    expect(all.bugs.map((b) => b.status).sort()).toEqual([
      "investigating",
      "open",
      "resolved",
    ]);

    const onlyOpen = payload<{ bugs: Array<{ id: string; title: string; status: string }>; total: number }>(
      call(store, "luck_tree_find_bugs", { projectKey: P, status: "open" }),
    );
    expect(onlyOpen.total).toBe(1);
    expect(onlyOpen.bugs[0].title).toBe("webhook 500s");

    const onlyResolved = payload<{ bugs: Array<{ id: string; title: string; status: string }>; total: number }>(
      call(store, "luck_tree_find_bugs", { projectKey: P, status: "resolved" }),
    );
    expect(onlyResolved.total).toBe(1);
    expect(onlyResolved.bugs[0].title).toBe("typo in docs");
  });

  it("returns empty list for project without bugs", () => {
    const store = openStore();
    seedTree(store);
    const result = payload<{ bugs: unknown[]; total: number }>(
      call(store, "luck_tree_find_bugs", { projectKey: P }),
    );
    expect(result.bugs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("rejects unknown status", () => {
    const store = openStore();
    expectError(
      call(store, "luck_tree_find_bugs", {
        projectKey: P,
        status: "ciao" as any,
      }),
      /Invalid input/,
    );
  });
});

describe("luck_tree_find_goals", () => {
  it("lists all goals of a project, optionally filtered by status", () => {
    const store = openStore();
    seedTree(store);
    call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "create",
      formalText: "Goal one",
      plan: [{ id: "s1", title: "step one", description: "" }],
    });
    call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "create",
      formalText: "Goal two",
      plan: [{ id: "s2", title: "step two", description: "" }],
    });
    call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "create",
      formalText: "Goal three",
      plan: [{ id: "s3", title: "step three", description: "" }],
    });

    const all = payload<{ goals: Array<{ id: string; status: string }>; total: number; returned: number }>(
      call(store, "luck_tree_find_goals", { projectKey: P }),
    );
    expect(all.total).toBe(3);
    expect(all.returned).toBe(3);
    expect(all.goals.map((g) => g.status).sort()).toEqual(["draft", "draft", "draft"]);

    const onlyDraft = payload<{ goals: Array<{ id: string; status: string }>; total: number }>(
      call(store, "luck_tree_find_goals", { projectKey: P, status: "draft" }),
    );
    expect(onlyDraft.total).toBe(3);

    const onlyProposed = payload<{ goals: Array<{ id: string; status: string }>; total: number }>(
      call(store, "luck_tree_find_goals", { projectKey: P, status: "proposed" }),
    );
    expect(onlyProposed.total).toBe(0);
  });

  it("returns empty list for project without goals", () => {
    const store = openStore();
    seedTree(store);
    const result = payload<{ goals: unknown[]; total: number }>(
      call(store, "luck_tree_find_goals", { projectKey: P }),
    );
    expect(result.goals).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("rejects unknown status", () => {
    const store = openStore();
    expectError(
      call(store, "luck_tree_find_goals", {
        projectKey: P,
        status: "ciao" as any,
      }),
      /Invalid input/,
    );
  });
});

describe("luck_tree_approve_goal", () => {
  it("approves a proposed goal and materializes its subtree", () => {
    const store = openStore();
    const { branch } = seedTree(store);
    call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "create",
      formalText: "Goal to approve",
      plan: [{ id: "s1", title: "step one", description: "" }],
    });

    const created = payload<{ goal: { id: string; status: string } }>(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "create",
        formalText: "Goal to approve",
        plan: [{ id: "s1", title: "step one", description: "" }],
      }),
    );
    const goalId = created.goal.id;

    call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "propose",
      goalId,
    });

    const result = payload<{ goal: { id: string; status: string; materializedNodeId: string | null } }>(
      call(store, "luck_tree_approve_goal", {
        projectKey: P,
        goalId,
        parentBranchId: branch.id,
      }),
    );
    expect(result.goal.status).toBe("approved");
    expect(result.goal.materializedNodeId).not.toBeNull();

    const goal = store.getGoal(P, goalId);
    expect(goal?.status).toBe("approved");
    expect(goal?.materializedNodeId).not.toBeNull();
  });

  it("rejects approving a non-proposed goal", () => {
    const store = openStore();
    const { branch } = seedTree(store);
    const created = payload<{ goal: { id: string; status: string } }>(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "create",
        formalText: "Draft goal",
        plan: [{ id: "s1", title: "step one", description: "" }],
      }),
    );
    expectError(
      call(store, "luck_tree_approve_goal", {
        projectKey: P,
        goalId: created.goal.id,
        parentBranchId: branch.id,
      }),
      /only a proposed goal may be approved/,
    );
  });

  it("rejects unknown parent branch", () => {
    const store = openStore();
    seedTree(store);
    const created = payload<{ goal: { id: string } }>(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "create",
        formalText: "Goal with bad parent",
        plan: [{ id: "s1", title: "step one", description: "" }],
      }),
    );
    call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "propose",
      goalId: created.goal.id,
    });

    expectError(
      call(store, "luck_tree_approve_goal", {
        projectKey: P,
        goalId: created.goal.id,
        parentBranchId: "00000000-0000-4000-8000-000000000000",
      }),
      /not found/,
    );
  });
});

describe("luck_tree_set_goal", () => {
  const PLAN = [
    { id: "step-1", title: "collect failed charges", description: "" },
    { id: "step-2", title: "retry with backoff", description: "" },
  ];

  it("creates a draft that is not in the tree", () => {
    const store = openStore();
    seedTree(store);
    const before = store.listChildren(P, null).length;
    const result = payload<{
      goal: { id: string; status: string; plan: unknown[] };
      note: string;
    }>(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "create",
        formalText: "Automate dunning for failed charges",
        plan: PLAN,
      }),
    );
    expect(result.goal.status).toBe("draft");
    expect(result.goal.plan).toHaveLength(2);
    expect(result.note).toContain("NOT in the tree");
    expect(store.listChildren(P, null)).toHaveLength(before);
  });

  it("validates create/update/propose arguments", () => {
    const store = openStore();
    expectError(
      call(store, "luck_tree_set_goal", { projectKey: P, action: "create" }),
      /formalText is required/,
    );
    expectError(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "update",
        formalText: "x",
      }),
      /goalId is required/,
    );
    expectError(
      call(store, "lust_tree_set_goal" as string, { projectKey: P }),
      /Unknown tool/,
    );
  });

  it("edits a draft and proposes it; a second propose is a readable no-op", () => {
    const store = openStore();
    const created = payload<{ goal: { id: string } }>(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "create",
        formalText: "Automate dunning",
        plan: PLAN,
      }),
    );
    const updated = payload<{ goal: { status: string; plan: unknown[] } }>(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "update",
        goalId: created.goal.id,
        plan: [...PLAN, { id: "step-3", title: "notify customer", description: "" }],
      }),
    );
    expect(updated.goal.plan).toHaveLength(3);
    const proposed = payload<{ goal: { status: string }; note: string }>(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "propose",
        goalId: created.goal.id,
      }),
    );
    expect(proposed.goal.status).toBe("proposed");
    expect(proposed.note).toContain("approves");
    const again = call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "propose",
      goalId: created.goal.id,
    });
    expectError(again, /already has status "proposed"/);
  });

  it("never exposes approval: agents cannot move a goal past proposed", () => {
    const store = openStore();
    const created = payload<{ goal: { id: string } }>(
      call(store, "luck_tree_set_goal", {
        projectKey: P,
        action: "create",
        formalText: "Automate dunning",
        plan: PLAN,
      }),
    );
    call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "propose",
      goalId: created.goal.id,
    });
    // No tool path sets approved — even a direct status write is blocked.
    const result = call(store, "luck_tree_set_goal", {
      projectKey: P,
      action: "update",
      goalId: created.goal.id,
      formalText: "edited while proposed",
    });
    expect(result.isError).toBeUndefined();
    expect(store.getGoal(P, created.goal.id)?.status).toBe("proposed");
  });
});

describe("luck_tree_update_growth", () => {
  const STEPS = [
    { id: "s1", title: "spec", state: "completed", facts: ["rfc"], reason: "" },
    { id: "s2", title: "code", state: "pending", facts: [], reason: "waiting for approval" },
  ];

  it("attaches a fresh record, then updates it by subject", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const created = payload<{ created: boolean; growth: { id: string; revision: number } }>(
      call(store, "luck_tree_update_growth", {
        projectKey: P,
        subjectType: "node",
        subjectId: leafA.id,
        steps: STEPS,
      }),
    );
    expect(created.created).toBe(true);
    expect(created.growth.revision).toBe(1);
    const updated = payload<{ created: boolean; growth: { revision: number; status: string } }>(
      call(store, "luck_tree_update_growth", {
        projectKey: P,
        subjectType: "node",
        subjectId: leafA.id,
        status: "stalled",
      }),
    );
    expect(updated.created).toBe(false);
    expect(updated.growth.status).toBe("stalled");
    expect(updated.growth.revision).toBe(2);
  });

  it("requires steps when the subject has no record yet", () => {
    const store = openStore();
    const { leafB } = seedTree(store);
    const result = call(store, "luck_tree_update_growth", {
      projectKey: P,
      subjectType: "node",
      subjectId: leafB.id,
      status: "active",
    });
    expectError(result, /steps are required/);
  });

  it("demands steps and/or status when a record already exists", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    call(store, "luck_tree_update_growth", {
      projectKey: P,
      subjectType: "node",
      subjectId: leafA.id,
      steps: STEPS,
    });
    const result = call(store, "luck_tree_update_growth", {
      projectKey: P,
      subjectType: "node",
      subjectId: leafA.id,
    });
    expectError(result, /pass steps and\/or status/);
  });

  it("validates step shape and rejects an unknown subject", () => {
    const store = openStore();
    expectError(
      call(store, "luck_tree_update_growth", {
        projectKey: P,
        subjectType: "node",
        subjectId: "00000000-0000-4000-8000-000000000000",
        steps: STEPS,
      }),
      /not found in project/,
    );
    const { leafA } = seedTree(store);
    expectError(
      call(store, "luck_tree_update_growth", {
        projectKey: P,
        subjectType: "node",
        subjectId: leafA.id,
        steps: [{ id: "s1", title: "x", state: "done", facts: [], reason: "" }],
      }),
      /Invalid input/,
    );
  });
});

describe("luck_tree_history", () => {
  it("returns the append-only audit trail of an entity", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    call(store, "luck_tree_upsert_leaf", {
      projectKey: P,
      leafId: leafA.id,
      status: "ready",
    });
    const result = payload<{
      entries: Array<{ action: string; revision: number; actor: string | null }>;
    }>(
      call(store, "luck_tree_history", {
        projectKey: P,
        entityId: leafA.id,
      }),
    );
    expect(result.entries.map((entry) => entry.action)).toEqual([
      "create",
      "status",
    ]);
    expect(result.entries[1].revision).toBe(2);
    expect(result.entries[0].actor).toBe(ACTOR);
  });

  it("returns an empty trail for an unknown entity", () => {
    const store = openStore();
    const result = payload<{ entries: unknown[] }>(
      call(store, "luck_tree_history", {
        projectKey: P,
        entityId: "00000000-0000-4000-8000-000000000000",
      }),
    );
    expect(result.entries).toEqual([]);
  });
});

describe("luck_tree_export", () => {
  it("writes the archive where asked and reports where it landed", () => {
    const store = openStore();
    seedTree(store);
    const file = path.join(tempDir(), "tree.json.zip");
    const result = payload<{
      created: boolean;
      file: string;
      bytes: number;
      exportedAt: number;
      counts: { nodes: number; archivedNodes: number; history: number | null };
    }>(call(store, "luck_tree_export", { projectKey: P, path: file }));

    expect(result.created).toBe(true);
    expect(result.file).toBe(file);
    expect(existsSync(file)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.counts.nodes).toBe(5);
    expect(result.counts.archivedNodes).toBe(0);
    expect(result.counts.history).toBeGreaterThan(0);
  });

  it("lands in the plugin's backups/ directory by default", () => {
    const store = openStore();
    seedTree(store);
    const result = payload<{ file: string }>(
      call(store, "luck_tree_export", { projectKey: P, includeHistory: false }),
    );
    expect(result.file).toContain(`${path.sep}backups${path.sep}`);
    expect(path.basename(result.file)).toMatch(/\.json\.zip$/);
  });

  it("refuses an empty project, a relative path and a taken file", () => {
    const store = openStore();
    seedTree(store);
    expectError(
      call(store, "luck_tree_export", { projectKey: OTHER }),
      /has no nodes to export/,
    );
    expectError(
      call(store, "luck_tree_export", { projectKey: P, path: "relative.json.zip" }),
      /must be absolute/,
    );
    const taken = path.join(tempDir(), "taken.json.zip");
    writeFileSync(taken, "x");
    expectError(
      call(store, "luck_tree_export", { projectKey: P, path: taken }),
      /refusing to overwrite/,
    );
  });
});

describe("luck_tree_import", () => {
  interface Imported {
    dryRun: boolean;
    imported: boolean;
    projectKey: string;
    counts: { nodes: number; bees: number; bugs: number; goals: number };
    warnings: string[];
    hint?: string;
  }

  it("is a dry run unless the agent says otherwise", () => {
    const store = openStore();
    const { leafA, leafB } = seedTree(store);
    store.createBee({
      projectKey: P,
      sourceLeafId: leafA.id,
      targetLeafId: leafB.id,
      actor: ACTOR,
    });
    const file = path.join(tempDir(), "tree.json.zip");
    payload(call(store, "luck_tree_export", { projectKey: P, path: file }));

    const dry = payload<Imported>(
      call(store, "luck_tree_import", { projectKey: OTHER, file }),
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.imported).toBe(false);
    expect(dry.counts.nodes).toBe(5);
    expect(dry.counts.bees).toBe(1);
    expect(dry.hint).toMatch(/dryRun: false/);
    expect(store.listNodes(OTHER, { includeArchived: true })).toHaveLength(0);

    const written = payload<Imported>(
      call(store, "luck_tree_import", { projectKey: OTHER, file, dryRun: false }),
    );
    expect(written.dryRun).toBe(false);
    expect(written.imported).toBe(true);
    expect(written.hint).toBeUndefined();
    expect(written.counts).toEqual(dry.counts);
    expect(store.listNodes(OTHER).map((node) => node.name).sort()).toEqual(
      store.listNodes(P).map((node) => node.name).sort(),
    );
  });

  it("explains a refusal instead of throwing", () => {
    const store = openStore();
    seedTree(store);
    expectError(
      call(store, "luck_tree_import", {
        projectKey: OTHER,
        file: path.join(tmpdir(), "absent.json.zip"),
      }),
      /not found/,
    );
    expectError(
      call(store, "luck_tree_import", { projectKey: OTHER, file: "relative.json.zip" }),
      /must be absolute/,
    );
    // The tool has no target default: a write names its project.
    expectError(call(store, "luck_tree_import", { file: "x.json.zip" }), /projectKey/);
  });

  it("can leave the archived past behind", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    store.archiveNode({ projectKey: P, id: leafA.id, actor: ACTOR });
    const file = path.join(tempDir(), "tree.json.zip");
    payload(call(store, "luck_tree_export", { projectKey: P, path: file }));

    const withPast = payload<Imported>(
      call(store, "luck_tree_import", { projectKey: OTHER, file, dryRun: false }),
    );
    expect(withPast.counts.nodes).toBe(5);

    const liveOnly = payload<Imported>(
      call(store, "luck_tree_import", {
        projectKey: "/projects/third",
        file,
        dryRun: false,
        includeArchived: false,
      }),
    );
    expect(liveOnly.counts.nodes).toBe(4);
    expect(store.listNodes("/projects/third").map((node) => node.name)).not.toContain(
      "retry failed charges",
    );
  });
});
