import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore } from "../server/store";
import type { Goal, GoalStep } from "../shared/goals";
import type { Node } from "../shared/tree";

/**
 * Stage C3 acceptance (`PLAN.md`): high goals with the approval gate.
 *
 * The three acceptance rules of the stage are asserted literally:
 * 1. an unapproved goal is **not** in the tree;
 * 2. materialization is **idempotent** (second approval writes nothing);
 * 3. replacing a plan **extinguishes the derived leaves** (cascade reset).
 *
 * Plus the standing invariants: gapless audit revisions 1..N matching the
 * goal's revision, project scoping everywhere, and one atomic transaction
 * per mutation (a failed approval leaves no half-grown subtree).
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:planner";
const HUMAN = "user";

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-goals-"));
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

/** root → trunk → branch → subbranch + one ordinary leaf. */
function skeleton(store: LuckPlannerStore): {
  root: Node;
  trunk: Node;
  branch: Node;
  subbranch: Node;
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
  const subbranch = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "subbranch",
    name: "payments",
    actor: ACTOR,
  });
  const leaf = store.createNode({
    projectKey: P,
    parentId: subbranch.id,
    kind: "leaf",
    name: "invoice render",
    actor: ACTOR,
  });
  return { root, trunk, branch, subbranch, leaf };
}

function planOf(...steps: Array<[string, string]>): GoalStep[] {
  return steps.map(([id, title]) => ({
    id,
    title,
    description: `what ${title} means`,
  }));
}

const PLAN: GoalStep[] = planOf(
  ["s1", "Design the exporter"],
  ["s2", "Implement the exporter"],
  ["s3", "Test the exporter"],
);

function expectGoalHistory(
  store: LuckPlannerStore,
  goalId: string,
  expectedActions: string[],
  finalRevision?: number,
): void {
  const history = store.listHistory(P, goalId);
  expect(history.map((entry) => entry.action)).toEqual(expectedActions);
  history.forEach((entry, index) => {
    expect(entry.entityType).toBe("goal");
    expect(entry.entityId).toBe(goalId);
    expect(entry.revision).toBe(index + 1);
    expect(entry.actor).toBeTruthy();
    expect(entry.result.length).toBeGreaterThan(0);
    expect(entry.at).toBeGreaterThan(0);
  });
  if (finalRevision !== undefined) {
    expect(history[history.length - 1]?.revision).toBe(finalRevision);
  }
}

function countNodes(store: LuckPlannerStore): number {
  const db = (
    store as unknown as {
      db: { prepare(sql: string): { get(...args: unknown[]): unknown } };
    }
  ).db;
  return (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number })
    .c;
}

// ---------------------------------------------------------------------------
// createGoal: the goal lives outside the tree until approval
// ---------------------------------------------------------------------------

describe("createGoal", () => {
  it("creates a draft that is not in the tree", () => {
    const store = openStore();
    const { root, trunk, branch, subbranch, leaf } = skeleton(store);
    const before = countNodes(store);

    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export to the billing module",
      plan: PLAN,
      actor: ACTOR,
    });

    expect(goal.status).toBe("draft");
    expect(goal.revision).toBe(1);
    expect(goal.materializedNodeId).toBeNull();
    expect(goal.plan).toHaveLength(3);
    expect(goal.createdBy).toBe(ACTOR);

    // Acceptance rule 1: an unapproved goal is NOT in the tree.
    expect(countNodes(store)).toBe(before);
    expect(store.listGoalLeaves(P, goal.id)).toEqual([]);
    for (const node of [root, trunk, branch, subbranch, leaf]) {
      expect(store.getNode(P, node.id)!.revision).toBe(node.revision);
      expect(store.listHistory(P, node.id)).toHaveLength(1);
    }

    expect(store.getGoal(P, goal.id)).toEqual(goal);
    expect(store.getGoal(OTHER, goal.id)).toBeNull();
    expect(store.listGoals(P).map((entry) => entry.id)).toEqual([goal.id]);
    expectGoalHistory(store, goal.id, ["create"], 1);
    expect(store.listHistory(P, goal.id)[0].result).toBe(
      "created goal with 3 plan step(s)",
    );
  });

  it("validates the formal text and the plan readably", () => {
    const store = openStore();
    skeleton(store);

    expect(() =>
      store.createGoal({
        projectKey: P,
        formalText: "   ",
        plan: PLAN,
        actor: ACTOR,
      }),
    ).toThrow(/goal formal text must not be empty/);
    expect(() =>
      store.createGoal({
        projectKey: P,
        formalText: "task",
        plan: "step one" as unknown as GoalStep[],
        actor: ACTOR,
      }),
    ).toThrow(/goal plan must be an array of steps/);
    expect(() =>
      store.createGoal({ projectKey: P, formalText: "task", plan: [], actor: ACTOR }),
    ).toThrow(/must contain at least one step/);
    expect(() =>
      store.createGoal({
        projectKey: P,
        formalText: "task",
        plan: [
          { id: "ok", title: "fine", description: "" },
          { id: "bad", description: "no title" } as GoalStep,
        ],
        actor: ACTOR,
      }),
    ).toThrow(/invalid goal plan step 1: title/);
    expect(store.listGoals(P)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

describe("the approval gate", () => {
  it("refuses every shortcut to approved and superseded", () => {
    const store = openStore();
    skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });

    expect(() =>
      store.approveGoal({
        projectKey: P,
        id: goal.id,
        parentBranchId: "x",
        actor: ACTOR,
      }),
    ).toThrow(/only a proposed goal may be approved; goal .* is draft/);
    expect(() =>
      store.setGoalStatus({ projectKey: P, id: goal.id, status: "approved", actor: ACTOR }),
    ).toThrow(/behind the approval gate; call approveGoal/);
    expect(() =>
      store.setGoalStatus({
        projectKey: P,
        id: goal.id,
        status: "superseded",
        actor: ACTOR,
      }),
    ).toThrow(/only comes from replaceGoalPlan/);

    expect(store.getGoal(P, goal.id)!.status).toBe("draft");
    expectGoalHistory(store, goal.id, ["create"], 1);
    expect(countNodes(store)).toBe(5); // nothing grew
  });

  it("rejects a proposed plan back to draft with a reject audit row", () => {
    const store = openStore();
    skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR });

    const rejected = store.rejectGoal({
      projectKey: P,
      id: goal.id,
      actor: HUMAN,
    });
    expect(rejected.status).toBe("draft");
    expect(rejected.revision).toBe(3);
    expectGoalHistory(store, goal.id, ["create", "status", "reject"], 3);
    expect(store.listHistory(P, goal.id)[2].actor).toBe(HUMAN);
    expect(store.listHistory(P, goal.id)[2].result).toBe(
      "proposed → draft (plan rejected)",
    );

    expect(() =>
      store.rejectGoal({ projectKey: P, id: goal.id, actor: HUMAN }),
    ).toThrow(/only a proposed goal can be rejected; goal .* is draft/);
  });
});

// ---------------------------------------------------------------------------
// approveGoal: materialization
// ---------------------------------------------------------------------------

describe("approveGoal", () => {
  it("grows side branch + one draft leaf per plan step in one transaction", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export to billing",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR });
    expect(store.listGoalLeaves(P, goal.id)).toEqual([]);

    const approved = store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: HUMAN,
    });
    expect(approved.status).toBe("approved");
    expect(approved.revision).toBe(4); // create, propose, approve, materialize
    expect(approved.materializedNodeId).not.toBeNull();

    // Structure: side branch named after the task, hanging under the parent.
    const root = store.getNode(P, approved.materializedNodeId!)!;
    expect(root.kind).toBe("subbranch");
    expect(root.name).toBe("Add PDF export to billing");
    expect(root.parentId).toBe(branch.id);
    expect(root.payload).toEqual({ goalId: goal.id });

    // One draft leaf per plan step, order and ids preserved in the payload.
    const leaves = store.listGoalLeaves(P, goal.id);
    expect(leaves).toHaveLength(3);
    for (const [index, step] of PLAN.entries()) {
      const match = leaves.find((node) => node.payload.stepId === step.id);
      expect(match, `leaf for step ${step.id}`).toBeDefined();
      expect(match!.name).toBe(step.title);
      expect(match!.description).toBe(step.description);
      expect(match!.status).toBe("draft");
      expect(match!.payload.goalId).toBe(goal.id);
      expect(match!.payload.stepOrder).toBe(index);
      expect(store.listHistory(P, match!.id).map((e) => e.action)).toEqual([
        "create",
      ]);
    }

    // The parent branch itself was not mutated.
    const parent = store.getNode(P, branch.id)!;
    expect(parent.revision).toBe(branch.revision);
    expect(store.listHistory(P, branch.id)).toHaveLength(1);

    expectGoalHistory(
      store,
      goal.id,
      ["create", "status", "approve", "materialize"],
      4,
    );
    expect(store.listHistory(P, goal.id)[2].actor).toBe(HUMAN);
    expect(store.listHistory(P, goal.id)[3].result).toContain(
      "with 3 step leaf(s)",
    );
  });

  it("is idempotent: approving again writes nothing at all", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR });
    const first = store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: HUMAN,
    });

    const nodesAfterFirst = countNodes(store);
    const second = store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: HUMAN,
    });

    expect(second).toEqual(first);
    expect(second.revision).toBe(first.revision);
    expect(countNodes(store)).toBe(nodesAfterFirst); // no second subtree
    expect(store.listGoalLeaves(P, goal.id)).toHaveLength(3);
    expectGoalHistory(store, goal.id, ["create", "status", "approve", "materialize"], 4);
  });

  it("validates the parent and rolls back the gate crossing on failure", () => {
    const store = openStore();
    const { root, trunk, branch, subbranch, leaf } = skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR });
    // The foreign project's node used as a "wrong parent" case is created
    // up front, so the node-count snapshot below counts only what the
    // rejected approvals could add.
    const foreignRoot = store.createNode({
      projectKey: OTHER,
      parentId: null,
      kind: "root",
      name: "Foreign stack",
      actor: ACTOR,
    });
    const nodesBefore = countNodes(store);
    const base = { projectKey: P, id: goal.id, actor: ACTOR };

    // A trunk cannot take subbranch children; root/leaf cannot either.
    expect(() =>
      store.approveGoal({ ...base, parentBranchId: trunk.id }),
    ).toThrow(/cannot grow under a trunk; it needs a branch or subbranch/);
    expect(() =>
      store.approveGoal({ ...base, parentBranchId: root.id }),
    ).toThrow(/cannot grow under a root/);
    expect(() =>
      store.approveGoal({ ...base, parentBranchId: leaf.id }),
    ).toThrow(/cannot grow under a leaf/);
    expect(() =>
      store.approveGoal({
        ...base,
        parentBranchId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toThrow(/goal parent node .* not found in project/);
    // A foreign project's node is "not found", never a usable parent.
    expect(() =>
      store.approveGoal({ ...base, parentBranchId: foreignRoot.id }),
    ).toThrow(/goal parent node .* not found in project/);

    // Nothing was written: still proposed, no subtree, same history.
    expect(store.getGoal(P, goal.id)!.status).toBe("proposed");
    expect(store.getGoal(P, goal.id)!.materializedNodeId).toBeNull();
    expect(countNodes(store)).toBe(nodesBefore);
    expectGoalHistory(store, goal.id, ["create", "status"], 2);
    // And the parent candidates kept their revisions.
    for (const node of [root, trunk, branch, leaf]) {
      expect(store.getNode(P, node.id)!.revision).toBe(node.revision);
    }
  });

  it("rejects an archived parent", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR });
    store.archiveNode({ projectKey: P, id: branch.id, actor: ACTOR });

    expect(() =>
      store.approveGoal({
        projectKey: P,
        id: goal.id,
        parentBranchId: branch.id,
        actor: ACTOR,
      }),
    ).toThrow(/goal parent node .* is archived/);
    expect(store.getGoal(P, goal.id)!.materializedNodeId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setGoalStatus: the ordinary lifecycle
// ---------------------------------------------------------------------------

describe("setGoalStatus", () => {
  it("walks the machine and records every transition", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR });
    store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: HUMAN,
    });

    const started = store.setGoalStatus({
      projectKey: P,
      id: goal.id,
      status: "in_progress",
      actor: ACTOR,
    });
    expect(started.status).toBe("in_progress");
    const done = store.setGoalStatus({
      projectKey: P,
      id: goal.id,
      status: "done",
      actor: ACTOR,
    });
    expect(done.status).toBe("done");

    expectGoalHistory(
      store,
      goal.id,
      ["create", "status", "approve", "materialize", "status", "status"],
      6,
    );
    expect(store.listHistory(P, goal.id)[4].result).toBe(
      "approved → in_progress",
    );
  });

  it("rejects no-ops and illegal transitions with the allowed list", () => {
    const store = openStore();
    skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });

    expect(() =>
      store.setGoalStatus({ projectKey: P, id: goal.id, status: "draft", actor: ACTOR }),
    ).toThrow(/already has status "draft"/);
    expect(() =>
      store.setGoalStatus({ projectKey: P, id: goal.id, status: "done", actor: ACTOR }),
    ).toThrow(/invalid status transition draft → done/);
    expect(() =>
      store.setGoalStatus({ projectKey: P, id: goal.id, status: "done", actor: ACTOR }),
    ).toThrow(/allowed from "draft": proposed, cancelled/);

    store.setGoalStatus({ projectKey: P, id: goal.id, status: "cancelled", actor: ACTOR });
    expect(() =>
      store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR }),
    ).toThrow(/allowed from "cancelled": none \(terminal status\)/);

    expect(() =>
      store.setGoalStatus({
        projectKey: P,
        id: "00000000-0000-4000-8000-000000000000",
        status: "proposed",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
    expectGoalHistory(store, goal.id, ["create", "status"], 2);
  });
});

// ---------------------------------------------------------------------------
// updateGoal: pre-approval edits
// ---------------------------------------------------------------------------

describe("updateGoal", () => {
  it("edits the task and the plan before approval", () => {
    const store = openStore();
    skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });

    const retitled = store.updateGoal({
      projectKey: P,
      id: goal.id,
      formalText: "Add PDF export to the billing module",
      actor: ACTOR,
    });
    expect(retitled.formalText).toBe("Add PDF export to the billing module");
    expect(retitled.revision).toBe(2);

    const replanned = store.updateGoal({
      projectKey: P,
      id: goal.id,
      plan: planOf(["n1", "Redesign the format"], ["n2", "Ship it"]),
      actor: ACTOR,
    });
    expect(replanned.plan.map((step) => step.id)).toEqual(["n1", "n2"]);
    expect(replanned.revision).toBe(3);

    expectGoalHistory(store, goal.id, ["create", "update", "update"], 3);
    expect(store.listHistory(P, goal.id)[1].result).toBe("updated formal text");
    expect(store.listHistory(P, goal.id)[2].result).toBe(
      "updated plan (2 step(s))",
    );
  });

  it("refuses edits after materialization and on terminal goals", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const approved = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({
      projectKey: P,
      id: approved.id,
      status: "proposed",
      actor: ACTOR,
    });
    store.approveGoal({
      projectKey: P,
      id: approved.id,
      parentBranchId: branch.id,
      actor: HUMAN,
    });
    expect(() =>
      store.updateGoal({
        projectKey: P,
        id: approved.id,
        formalText: "sneaky edit",
        actor: ACTOR,
      }),
    ).toThrow(/already grew a subtree; replace its plan through replaceGoalPlan/);

    const cancelled = store.createGoal({
      projectKey: P,
      formalText: "Never mind",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({
      projectKey: P,
      id: cancelled.id,
      status: "cancelled",
      actor: ACTOR,
    });
    expect(() =>
      store.updateGoal({
        projectKey: P,
        id: cancelled.id,
        formalText: "too late",
        actor: ACTOR,
      }),
    ).toThrow(/is cancelled and can no longer be updated/);

    expect(() =>
      store.updateGoal({ projectKey: P, id: approved.id, actor: ACTOR }),
    ).toThrow(/requires at least one of: formalText, plan/);
    expect(() =>
      store.updateGoal({
        projectKey: P,
        id: "00000000-0000-4000-8000-000000000000",
        formalText: "x",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
  });
});

// ---------------------------------------------------------------------------
// replaceGoalPlan: the cascade (MetaGPT reset_task)
// ---------------------------------------------------------------------------

describe("replaceGoalPlan", () => {
  it("supersedes the goal and extinguishes every movable derived leaf", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: planOf(
        ["s1", "Design"],
        ["s2", "Implement"],
        ["s3", "Test"],
        ["s4", "Document"],
      ),
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR });
    const approved = store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: HUMAN,
    });
    const leaves = store.listGoalLeaves(P, goal.id);
    expect(leaves).toHaveLength(4);
    const byStep = (id: string): Node =>
      leaves.find((node) => node.payload.stepId === id)!;
    const inProgress = byStep("s1");
    const draftLeaf = byStep("s2");
    const cancelledLeaf = byStep("s3");
    const archivedLeaf = byStep("s4");

    // Drive leaf 1 to in_progress, cancel leaf 3, archive leaf 4.
    store.setStatus({ projectKey: P, id: inProgress.id, status: "ready", actor: ACTOR });
    store.setStatus({ projectKey: P, id: inProgress.id, status: "claimed", actor: ACTOR });
    store.setStatus({
      projectKey: P,
      id: inProgress.id,
      status: "in_progress",
      actor: ACTOR,
    });
    store.setStatus({
      projectKey: P,
      id: cancelledLeaf.id,
      status: "cancelled",
      actor: ACTOR,
    });
    store.archiveNode({ projectKey: P, id: archivedLeaf.id, actor: ACTOR });
    const inProgressRevision = store.getNode(P, inProgress.id)!.revision;
    const cancelledRevision = store.getNode(P, cancelledLeaf.id)!.revision;
    const cancelledHistory = store.listHistory(P, cancelledLeaf.id).length;

    const superseded = store.replaceGoalPlan({
      projectKey: P,
      id: goal.id,
      plan: planOf(["n1", "Redesign the format"]),
      actor: ACTOR,
    });

    expect(superseded.status).toBe("superseded");
    expect(superseded.plan.map((step) => step.id)).toEqual(["n1"]);
    expect(superseded.materializedNodeId).toBe(approved.materializedNodeId);
    expect(superseded.revision).toBe(5); // create, propose, approve, materialize, supersede
    expectGoalHistory(
      store,
      goal.id,
      ["create", "status", "approve", "materialize", "supersede"],
      5,
    );
    expect(store.listHistory(P, goal.id)[4].result).toBe(
      "plan replaced (1 step(s)); 2/3 derived leaf(s) reset",
    );

    // Movable leaves are extinguished, each with its own audit row.
    const resetInProgress = store.getNode(P, inProgress.id)!;
    expect(resetInProgress.status).toBe("superseded");
    expect(resetInProgress.revision).toBe(inProgressRevision + 1);
    const inProgressHistory = store.listHistory(P, inProgress.id);
    expect(inProgressHistory[inProgressHistory.length - 1].action).toBe(
      "supersede",
    );
    expect(inProgressHistory[inProgressHistory.length - 1].result).toContain(
      `goal ${goal.id} plan replaced`,
    );
    expect(store.getNode(P, draftLeaf.id)!.status).toBe("superseded");

    // Terminal and archived leaves are left exactly as they were.
    expect(store.getNode(P, cancelledLeaf.id)!.status).toBe("cancelled");
    expect(store.getNode(P, cancelledLeaf.id)!.revision).toBe(
      cancelledRevision,
    );
    expect(store.listHistory(P, cancelledLeaf.id)).toHaveLength(
      cancelledHistory,
    );
    const gone = store.getNode(P, archivedLeaf.id)!;
    expect(gone.archivedAt).not.toBeNull();
    expect(gone.status).toBe("draft"); // archived before the cascade
    expect(store.listHistory(P, archivedLeaf.id)).toHaveLength(2); // create+archive

    // The subtree stays reachable as the historical record.
    const remaining = store.listGoalLeaves(P, goal.id);
    expect(remaining).toHaveLength(3); // archived leaf is not "live"
    expect(remaining.every((node) => ["superseded", "cancelled"].includes(node.status))).toBe(
      true,
    );
  });

  it("refuses replacement before approval and on terminal goals", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const draft = store.createGoal({
      projectKey: P,
      formalText: "Draft goal",
      plan: PLAN,
      actor: ACTOR,
    });
    expect(() =>
      store.replaceGoalPlan({ projectKey: P, id: draft.id, plan: PLAN, actor: ACTOR }),
    ).toThrow(/has not grown a subtree yet \(status draft\); edit its plan with updateGoal/);

    const proposed = store.createGoal({
      projectKey: P,
      formalText: "Proposed goal",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: proposed.id, status: "proposed", actor: ACTOR });
    expect(() =>
      store.replaceGoalPlan({ projectKey: P, id: proposed.id, plan: PLAN, actor: ACTOR }),
    ).toThrow(/has not grown a subtree yet \(status proposed\)/);

    const cancelled = store.createGoal({
      projectKey: P,
      formalText: "Cancelled goal",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: cancelled.id, status: "cancelled", actor: ACTOR });
    expect(() =>
      store.replaceGoalPlan({ projectKey: P, id: cancelled.id, plan: PLAN, actor: ACTOR }),
    ).toThrow(/invalid status transition cancelled → superseded/);
    expect(() =>
      store.replaceGoalPlan({ projectKey: P, id: cancelled.id, plan: PLAN, actor: ACTOR }),
    ).toThrow(/none \(terminal status\)/);

    // An empty replacement plan fails before anything is written.
    const approved = store.createGoal({
      projectKey: P,
      formalText: "Approved goal",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({ projectKey: P, id: approved.id, status: "proposed", actor: ACTOR });
    store.approveGoal({
      projectKey: P,
      id: approved.id,
      parentBranchId: branch.id,
      actor: HUMAN,
    });
    const revisionBefore = store.getGoal(P, approved.id)!.revision;
    expect(() =>
      store.replaceGoalPlan({ projectKey: P, id: approved.id, plan: [], actor: ACTOR }),
    ).toThrow(/must contain at least one step/);
    expect(store.getGoal(P, approved.id)!.revision).toBe(revisionBefore);
    expect(store.getGoal(P, approved.id)!.status).toBe("approved");

    // Replacing twice: the second hits the terminal state.
    store.replaceGoalPlan({ projectKey: P, id: approved.id, plan: PLAN, actor: ACTOR });
    expect(() =>
      store.replaceGoalPlan({ projectKey: P, id: approved.id, plan: PLAN, actor: ACTOR }),
    ).toThrow(/invalid status transition superseded → superseded/);
  });
});

// ---------------------------------------------------------------------------
// Reads and scoping
// ---------------------------------------------------------------------------

describe("goal reads", () => {
  it("keeps goals of other projects out of every read", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const mine = store.createGoal({
      projectKey: P,
      formalText: "mine",
      plan: PLAN,
      actor: ACTOR,
    });

    const foreignRoot = store.createNode({
      projectKey: OTHER,
      parentId: null,
      kind: "root",
      name: "Foreign stack",
      actor: ACTOR,
    });
    const foreignTrunk = store.createNode({
      projectKey: OTHER,
      parentId: foreignRoot.id,
      kind: "trunk",
      name: "Foreign platform",
      actor: ACTOR,
    });
    const foreignBranch = store.createNode({
      projectKey: OTHER,
      parentId: foreignTrunk.id,
      kind: "branch",
      name: "Foreign module",
      actor: ACTOR,
    });
    const theirs = store.createGoal({
      projectKey: OTHER,
      formalText: "theirs",
      plan: PLAN,
      actor: ACTOR,
    });
    store.setGoalStatus({
      projectKey: OTHER,
      id: theirs.id,
      status: "proposed",
      actor: ACTOR,
    });
    store.approveGoal({
      projectKey: OTHER,
      id: theirs.id,
      parentBranchId: foreignBranch.id,
      actor: HUMAN,
    });

    expect(store.listGoals(P).map((goal) => goal.id)).toEqual([mine.id]);
    expect(store.listGoals(OTHER).map((goal) => goal.id)).toEqual([theirs.id]);
    expect(store.getGoal(P, theirs.id)).toBeNull();
    expect(() => store.listGoalLeaves(P, theirs.id)).toThrow(
      /not found in project/,
    );
    // The foreign subtree is visible only in its own project.
    expect(store.listGoalLeaves(OTHER, theirs.id)).toHaveLength(3);
    expect(store.listGoalLeaves(P, mine.id)).toEqual([]);
    // A P-scope approval cannot borrow a foreign parent.
    store.setGoalStatus({ projectKey: P, id: mine.id, status: "proposed", actor: ACTOR });
    expect(() =>
      store.approveGoal({
        projectKey: P,
        id: mine.id,
        parentBranchId: foreignBranch.id,
        actor: ACTOR,
      }),
    ).toThrow(/goal parent node .* not found in project/);
  });
});
