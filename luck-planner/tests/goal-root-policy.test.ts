/**
 * Which tree an approved goal grows in (PLAN.md stage L10).
 *
 * `parentBranchId` used to be mandatory, which was honest while a project had
 * exactly one tree and an arbitrary choice once it had two. The policy now
 * answers the unnamed case: one tree → its default branch; a forest → a refusal
 * that names every tree; nothing to grow under → a sentence saying so. These
 * tests run it through the real store (real SQLite files, one transaction per
 * write), because what matters is that a refused approval writes **nothing**.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchMcpTool } from "../server/mcp-tools";
import { LuckPlannerStore } from "../server/store";
import type { Node } from "../shared/tree";

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];
const P = "/projects/demo";
const ACTOR = "user";

function openStore(): LuckPlannerStore {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-l10-"));
  dirs.push(dir);
  const store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Skeleton {
  root: Node;
  trunk: Node;
  branch: Node;
}

function skeleton(store: LuckPlannerStore, name: string): Skeleton {
  const root = store.createNode({
    projectKey: P,
    parentId: null,
    kind: "root",
    name,
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
    name: "core",
    actor: ACTOR,
  });
  return { root, trunk, branch };
}

function proposedGoal(store: LuckPlannerStore, text: string): string {
  const created = store.createGoal({
    projectKey: P,
    formalText: text,
    plan: [{ id: "s1", title: "one step", description: "" }],
    actor: ACTOR,
  });
  store.setGoalStatus({
    projectKey: P,
    id: created.id,
    status: "proposed",
    actor: ACTOR,
  });
  return created.id;
}

describe("the approval parent policy", () => {
  it("grows under the default branch when the project has one tree", () => {
    const store = openStore();
    const tree = skeleton(store, "solo");
    const goalId = proposedGoal(store, "ship retries");

    const goal = store.approveGoal({ projectKey: P, id: goalId, actor: ACTOR });
    expect(goal.status).toBe("approved");
    // The materialized side branch hangs under the tree's only branch.
    expect(store.getNode(P, goal.materializedNodeId!)?.parentId).toBe(
      tree.branch.id,
    );
    expect(store.listHistory(P, goalId).at(-1)).toMatchObject({
      action: "materialize",
    });
  });

  it("refuses to guess in a forest, and writes nothing", () => {
    const store = openStore();
    skeleton(store, "alpha");
    skeleton(store, "beta");
    const goalId = proposedGoal(store, "ship retries");
    const nodesBefore = store.listNodes(P).length;

    expect(() =>
      store.approveGoal({ projectKey: P, id: goalId, actor: ACTOR }),
    ).toThrow(/holds 2 trees/);

    // Neither the gate crossing nor the materialization happened.
    expect(store.getGoal(P, goalId)?.status).toBe("proposed");
    expect(store.getGoal(P, goalId)?.materializedNodeId).toBeNull();
    expect(store.listNodes(P)).toHaveLength(nodesBefore);
    expect(store.listHistory(P, goalId).some((row) => row.action === "approve")).toBe(
      false,
    );
  });

  it("grows in whichever tree the caller names", () => {
    const store = openStore();
    skeleton(store, "alpha");
    const beta = skeleton(store, "beta");
    const goalId = proposedGoal(store, "ship retries");

    const goal = store.approveGoal({
      projectKey: P,
      id: goalId,
      parentBranchId: beta.branch.id,
      actor: ACTOR,
    });
    expect(store.getNode(P, goal.materializedNodeId!)?.parentId).toBe(
      beta.branch.id,
    );
  });

  it("asks for a tree, then for a branch, when there is nothing to grow under", () => {
    const store = openStore();
    const goalId = proposedGoal(store, "ship retries");
    // Goals are project-level, so a goal may exist before the first tree.
    expect(() =>
      store.approveGoal({ projectKey: P, id: goalId, actor: ACTOR }),
    ).toThrow(/no live tree yet/);

    const root = store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "bare",
      actor: ACTOR,
    });
    store.createNode({
      projectKey: P,
      parentId: root.id,
      kind: "trunk",
      name: "Platform",
      actor: ACTOR,
    });
    expect(() =>
      store.approveGoal({ projectKey: P, id: goalId, actor: ACTOR }),
    ).toThrow(/has no live branch/);
  });

  it("still refuses an archived or missing parent named by the caller", () => {
    const store = openStore();
    const tree = skeleton(store, "solo");
    const goalId = proposedGoal(store, "ship retries");
    store.archiveNode({ projectKey: P, id: tree.branch.id, actor: ACTOR });

    expect(() =>
      store.approveGoal({
        projectKey: P,
        id: goalId,
        parentBranchId: tree.branch.id,
        actor: ACTOR,
      }),
    ).toThrow(/archived/);
  });
});

describe("the MCP surface", () => {
  it("approves without a parentBranchId in a single-tree project", () => {
    const store = openStore();
    skeleton(store, "solo");
    const goalId = proposedGoal(store, "ship retries");

    const result = dispatchMcpTool(
      "luck_tree_approve_goal",
      { projectKey: P, goalId, actor: ACTOR },
      { store, defaultActor: ACTOR },
    );
    expect(result.isError).toBeFalsy();
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain('"status": "approved"');
  });

  it("reports the forest's refusal as a readable error", () => {
    const store = openStore();
    skeleton(store, "alpha");
    skeleton(store, "beta");
    const goalId = proposedGoal(store, "ship retries");

    const result = dispatchMcpTool(
      "luck_tree_approve_goal",
      { projectKey: P, goalId, actor: ACTOR },
      { store, defaultActor: ACTOR },
    );
    expect(result.isError).toBe(true);
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain("holds 2 trees");
    expect(text).toContain('"alpha"');
  });
});
