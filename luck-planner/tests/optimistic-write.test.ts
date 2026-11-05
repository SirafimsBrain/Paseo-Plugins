/**
 * Optimistic concurrency for the dashboard's writes (PLAN.md stage L8).
 *
 * The dashboard is the first surface where a person and an agent move the same
 * leaf within seconds. The tab sends the revision it rendered, and the store
 * checks it **inside the transaction** — the only place that sees the race —
 * answering with a named error instead of overwriting a change the user never
 * saw. Absent `expectedRevision` keeps the old contract for the MCP tools and
 * the native panel, so the check is purely additive.
 *
 * Real SQLite files in a temp directory, as everywhere in this suite: the check
 * lives in the same transaction as the write, and a mock would test neither.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore, StaleRevisionError } from "../server/store";
import type { Node } from "../shared/tree";

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const ACTOR = "user";

function openStore(): LuckPlannerStore {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-l8-"));
  dirs.push(dir);
  const store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seed(store: LuckPlannerStore): {
  branch: Node;
  leaf: Node;
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
  const leaf = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    actor: ACTOR,
  });
  return { branch, leaf };
}

describe("setStatus with an expectedRevision", () => {
  it("accepts the write when the revision still matches", () => {
    const store = openStore();
    const { leaf } = seed(store);
    const node = store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "ready",
      actor: ACTOR,
      expectedRevision: leaf.revision,
    });
    expect(node.status).toBe("ready");
    expect(node.revision).toBe(leaf.revision + 1);
  });

  it("refuses a stale revision, writes nothing and audits nothing", () => {
    const store = openStore();
    const { leaf } = seed(store);
    // Somebody else moves it first.
    store.setStatus({ projectKey: P, id: leaf.id, status: "ready", actor: "agent:coder" });
    const historyBefore = store.listHistory(P, leaf.id);

    expect(() =>
      store.setStatus({
        projectKey: P,
        id: leaf.id,
        status: "claimed",
        actor: ACTOR,
        expectedRevision: leaf.revision,
      }),
    ).toThrow(StaleRevisionError);

    const after = store.getNode(P, leaf.id)!;
    expect(after.status).toBe("ready");
    expect(after.revision).toBe(leaf.revision + 1);
    expect(store.listHistory(P, leaf.id)).toHaveLength(historyBefore.length);
  });

  it("names the entity, the expected and the current revision", () => {
    const store = openStore();
    const { leaf } = seed(store);
    store.setStatus({ projectKey: P, id: leaf.id, status: "ready", actor: ACTOR });
    try {
      store.setStatus({
        projectKey: P,
        id: leaf.id,
        status: "claimed",
        actor: ACTOR,
        expectedRevision: leaf.revision,
      });
      expect.unreachable("a stale write must not succeed");
    } catch (cause) {
      expect(cause).toBeInstanceOf(StaleRevisionError);
      const error = cause as StaleRevisionError;
      expect(error.entityType).toBe("node");
      expect(error.entityId).toBe(leaf.id);
      expect(error.expected).toBe(leaf.revision);
      expect(error.current).toBe(leaf.revision + 1);
      expect(error.message).toMatch(/moved to revision/);
    }
  });

  it("keeps the old behaviour when no revision is sent", () => {
    // The MCP tools and the native panel write without one: their contract
    // must not change with this stage.
    const store = openStore();
    const { leaf } = seed(store);
    store.setStatus({ projectKey: P, id: leaf.id, status: "ready", actor: "agent:coder" });
    const node = store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "claimed",
      actor: ACTOR,
    });
    expect(node.status).toBe("claimed");
  });
});

describe("approveGoal with an expectedRevision", () => {
  function seedGoal(store: LuckPlannerStore): { branch: Node; goalId: string; revision: number } {
    const { branch } = seed(store);
    const created = store.createGoal({
      projectKey: P,
      formalText: "ship billing retries",
      plan: [
        { id: "s1", title: "migrate charges", description: "" },
        { id: "s2", title: "backfill worker", description: "" },
      ],
      actor: ACTOR,
    });
    const proposed = store.setGoalStatus({
      projectKey: P,
      id: created.id,
      status: "proposed",
      actor: ACTOR,
    });
    return { branch, goalId: created.id, revision: proposed.revision };
  }

  it("crosses the gate when the revision matches", () => {
    const store = openStore();
    const { branch, goalId, revision } = seedGoal(store);
    const goal = store.approveGoal({
      projectKey: P,
      id: goalId,
      parentBranchId: branch.id,
      actor: ACTOR,
      expectedRevision: revision,
    });
    expect(goal.status).toBe("approved");
    expect(goal.materializedNodeId).not.toBeNull();
    expect(store.listChildren(P, goal.materializedNodeId!)).toHaveLength(2);
  });

  it("refuses a stale approval even when the goal is already approved", () => {
    const store = openStore();
    const { branch, goalId, revision } = seedGoal(store);
    store.approveGoal({
      projectKey: P,
      id: goalId,
      parentBranchId: branch.id,
      actor: ACTOR,
    });
    const nodesBefore = store.listNodes(P).length;

    expect(() =>
      store.approveGoal({
        projectKey: P,
        id: goalId,
        parentBranchId: branch.id,
        actor: ACTOR,
        expectedRevision: revision,
      }),
    ).toThrow(StaleRevisionError);

    // The plan was not grown a second time: the check comes before the early
    // "already approved" return.
    expect(store.listNodes(P)).toHaveLength(nodesBefore);
  });
});
