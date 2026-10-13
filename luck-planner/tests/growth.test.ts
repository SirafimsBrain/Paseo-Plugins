import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore } from "../server/store";
import type { GrowthStep, GrowthStepState } from "../shared/growth";
import type { Node } from "../shared/tree";

/**
 * Stage C4 acceptance (`PLAN.md`, closes block C): growth rates — one
 * polymorphic progress record per node or goal, ordered steps carrying
 * state/facts/reason, and the aggregate (share of completed steps) for the
 * dashboard growth layer.
 *
 * Acceptance rules asserted literally:
 * 1. binding works for a **node** and for a **goal** (and any node kind);
 * 2. the aggregate reports the share of completed steps;
 * 3. every mutation bumps the revision and leaves a gapless audit trail.
 *
 * Standing rules: the subject itself is never mutated, one record per
 * subject, and nothing crosses `project_key`.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:planner";

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-growth-"));
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

/** root → trunk → branch → subbranch → leaf. */
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

function step(id: string, state: GrowthStepState): GrowthStep {
  return {
    id,
    title: `Step ${id}`,
    state,
    facts: state === "completed" ? [`shipped ${id}`] : [],
    reason: state === "completed" ? "" : "waiting for review",
  };
}

function expectGrowthHistory(
  store: LuckPlannerStore,
  growthId: string,
  expectedActions: string[],
  finalRevision?: number,
): void {
  const history = store.listHistory(P, growthId);
  expect(history.map((entry) => entry.action)).toEqual(expectedActions);
  history.forEach((entry, index) => {
    expect(entry.entityType).toBe("growth");
    expect(entry.entityId).toBe(growthId);
    expect(entry.revision).toBe(index + 1);
    expect(entry.actor).toBeTruthy();
    expect(entry.result.length).toBeGreaterThan(0);
    expect(entry.at).toBeGreaterThan(0);
  });
  if (finalRevision !== undefined) {
    expect(history[history.length - 1]?.revision).toBe(finalRevision);
  }
}

// ---------------------------------------------------------------------------
// createGrowth: the polymorphic binding
// ---------------------------------------------------------------------------

describe("createGrowth", () => {
  it("attaches to a leaf without touching it", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const steps = [step("a", "completed"), step("b", "pending"), step("c", "pending")];

    const growth = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps,
      actor: ACTOR,
    });
    expect(growth.subjectType).toBe("node");
    expect(growth.subjectId).toBe(leaf.id);
    expect(growth.status).toBe("active");
    expect(growth.revision).toBe(1);
    expect(growth.steps).toHaveLength(3);
    expect(growth.steps[0].facts).toEqual(["shipped a"]);

    expect(store.getGrowth(P, growth.id)).toEqual(growth);
    expect(
      store.getGrowthForSubject(P, "node", leaf.id),
    ).toEqual(growth);
    expect(store.listGrowth(P).map((entry) => entry.id)).toEqual([growth.id]);
    expectGrowthHistory(store, growth.id, ["create"], 1);
    expect(store.listHistory(P, growth.id)[0].result).toBe(
      `created growth for node ${leaf.id} with 3 step(s)`,
    );

    // The subject is never mutated: growth rides on its own row.
    const after = store.getNode(P, leaf.id)!;
    expect(after.revision).toBe(leaf.revision);
    expect(store.listHistory(P, leaf.id)).toHaveLength(1);
  });

  it("attaches to a goal and to a non-leaf node", () => {
    const store = openStore();
    const { branch } = skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: [
        { id: "s1", title: "Design", description: "" },
        { id: "s2", title: "Ship", description: "" },
      ],
      actor: ACTOR,
    });

    const forGoal = store.createGrowth({
      projectKey: P,
      subjectType: "goal",
      subjectId: goal.id,
      steps: [step("s1", "in_progress"), step("s2", "pending")],
      actor: ACTOR,
    });
    // §4.4: growth attaches to ANY tree element — a branch included.
    const forBranch = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: branch.id,
      steps: [step("x", "pending")],
      actor: ACTOR,
    });

    expect(forGoal.subjectType).toBe("goal");
    expect(
      store.getGrowthForSubject(P, "goal", goal.id)!.id,
    ).toBe(forGoal.id);
    expect(
      store.getGrowthForSubject(P, "node", branch.id)!.id,
    ).toBe(forBranch.id);
    expect(store.listGrowth(P)).toHaveLength(2);
    // The goal itself is untouched too (still revision 1, one history row).
    expect(store.getGoal(P, goal.id)!.revision).toBe(1);
    expect(store.listHistory(P, goal.id)).toHaveLength(1);
  });

  it("rejects bad subjects and bad steps without writing anything", () => {
    const store = openStore();
    const { branch, leaf } = skeleton(store);
    const unknown = "00000000-0000-4000-8000-000000000000";
    const base = {
      projectKey: P,
      subjectType: "node" as const,
      subjectId: leaf.id,
      steps: [step("a", "pending")],
      actor: ACTOR,
    };

    expect(() =>
      store.createGrowth({ ...base, subjectId: unknown }),
    ).toThrow(new RegExp(`growth subject node ${unknown} not found in project ${P}`));
    store.archiveNode({ projectKey: P, id: leaf.id, actor: ACTOR });
    expect(() => store.createGrowth(base)).toThrow(
      /growth subject node .* is archived/,
    );
    expect(() =>
      store.createGrowth({
        ...base,
        subjectId: unknown,
      }),
    ).toThrow(/not found in project/);

    const live = { ...base, subjectId: branch.id };
    expect(() =>
      store.createGrowth({
        ...live,
        subjectType: "task" as unknown as "node",
      }),
    ).toThrow(/invalid growth subject type "task"; expected one of: node, goal/);
    expect(() => store.createGrowth({ ...live, steps: [] })).toThrow(
      /growth steps must contain at least one step/,
    );
    expect(() =>
      store.createGrowth({ ...live, steps: "a" as unknown as GrowthStep[] }),
    ).toThrow(/growth steps must be an array/);
    expect(() =>
      store.createGrowth({
        ...live,
        steps: [
          step("ok", "pending"),
          step("bad", "nonsense" as GrowthStepState),
        ],
      }),
    ).toThrow(/invalid growth step 1: state/);
    expect(() =>
      store.createGrowth({
        ...live,
        steps: [
          { id: "a", title: "A", state: "pending", facts: [] } as unknown as GrowthStep,
        ],
      }),
    ).toThrow(/invalid growth step 0: reason/);

    expect(store.listGrowth(P)).toEqual([]);
    expect(store.listHistory(P, branch.id)).toHaveLength(1);
    expect(store.getNode(P, branch.id)!.revision).toBe(branch.revision);
  });

  it("allows exactly one record per subject", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const first = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [step("a", "pending")],
      actor: ACTOR,
    });

    expect(() =>
      store.createGrowth({
        projectKey: P,
        subjectType: "node",
        subjectId: leaf.id,
        steps: [step("b", "pending")],
        actor: ACTOR,
      }),
    ).toThrow(
      new RegExp(
        `growth for node ${leaf.id} already exists \\(${first.id}\\); update it instead`,
      ),
    );
    expect(store.listGrowth(P)).toHaveLength(1);
    expectGrowthHistory(store, first.id, ["create"], 1);
  });

  it("accepts an explicit initial status", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const growth = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [step("a", "pending")],
      status: "stalled",
      actor: ACTOR,
    });
    expect(growth.status).toBe("stalled");
    // Field validation runs before any write: a bad status fails even when
    // the subject is already tracked (no duplicate check is reached).
    expect(() =>
      store.createGrowth({
        projectKey: P,
        subjectType: "node",
        subjectId: leaf.id,
        steps: [step("a", "pending")],
        status: "nonsense" as "active",
        actor: ACTOR,
      }),
    ).toThrow(
      /invalid growth status "nonsense"; expected one of: active, stalled, done, cancelled/,
    );
    expect(store.listGrowth(P)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateGrowth
// ---------------------------------------------------------------------------

describe("updateGrowth", () => {
  it("replaces the step array with one revision and an update audit row", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const growth = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [step("a", "completed"), step("b", "pending")],
      actor: ACTOR,
    });

    const updated = store.updateGrowth({
      projectKey: P,
      id: growth.id,
      steps: [step("a", "completed"), step("b", "completed"), step("c", "pending")],
      actor: ACTOR,
    });
    expect(updated.revision).toBe(2);
    expect(updated.steps).toHaveLength(3);
    expect(updated.steps[1].state).toBe("completed");
    expectGrowthHistory(store, growth.id, ["create", "update"], 2);
    expect(store.listHistory(P, growth.id)[1].result).toBe("updated 3 step(s)");
  });

  it("walks the status machine and combines both changes in one row", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const growth = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [step("a", "pending")],
      actor: ACTOR,
    });

    const stalled = store.updateGrowth({
      projectKey: P,
      id: growth.id,
      status: "stalled",
      actor: ACTOR,
    });
    expect(stalled.status).toBe("stalled");
    expect(stalled.revision).toBe(2);

    const combined = store.updateGrowth({
      projectKey: P,
      id: growth.id,
      status: "active",
      steps: [step("a", "in_progress")],
      actor: ACTOR,
    });
    expect(combined.status).toBe("active");
    expect(combined.revision).toBe(3);

    const done = store.updateGrowth({
      projectKey: P,
      id: growth.id,
      status: "done",
      actor: ACTOR,
    });
    expect(done.status).toBe("done");
    // done → active is a legal reactivation.
    const reactivated = store.updateGrowth({
      projectKey: P,
      id: growth.id,
      status: "active",
      actor: ACTOR,
    });
    expect(reactivated.status).toBe("active");

    expectGrowthHistory(
      store,
      growth.id,
      ["create", "status", "status", "status", "status"],
      5,
    );
    expect(store.listHistory(P, growth.id)[1].result).toBe("active → stalled");
    expect(store.listHistory(P, growth.id)[2].result).toBe(
      "stalled → active; updated 1 step(s)",
    );
    expect(store.listHistory(P, growth.id)[3].result).toBe("active → done");
  });

  it("rejects no-ops, illegal transitions and empty updates", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const growth = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [step("a", "pending")],
      actor: ACTOR,
    });

    expect(() =>
      store.updateGrowth({ projectKey: P, id: growth.id, status: "active", actor: ACTOR }),
    ).toThrow(/already has status "active"/);
    store.updateGrowth({
      projectKey: P,
      id: growth.id,
      status: "cancelled",
      actor: ACTOR,
    });
    expect(() =>
      store.updateGrowth({
        projectKey: P,
        id: growth.id,
        status: "stalled",
        actor: ACTOR,
      }),
    ).toThrow(/invalid status transition cancelled → stalled/);
    expect(() =>
      store.updateGrowth({
        projectKey: P,
        id: growth.id,
        status: "stalled",
        actor: ACTOR,
      }),
    ).toThrow(/allowed from "cancelled": active/);

    expect(() =>
      store.updateGrowth({ projectKey: P, id: growth.id, actor: ACTOR }),
    ).toThrow(/requires at least one of: steps, status/);
    expect(() =>
      store.updateGrowth({
        projectKey: P,
        id: "00000000-0000-4000-8000-000000000000",
        status: "active",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
    // Invalid steps are rejected before any write.
    expect(() =>
      store.updateGrowth({
        projectKey: P,
        id: growth.id,
        steps: [],
        actor: ACTOR,
      }),
    ).toThrow(/must contain at least one step/);

    expect(store.getGrowth(P, growth.id)!.status).toBe("cancelled");
    expect(store.getGrowth(P, growth.id)!.revision).toBe(2);
    expectGrowthHistory(store, growth.id, ["create", "status"], 2);
  });
});

// ---------------------------------------------------------------------------
// getGrowthProgress: the aggregate
// ---------------------------------------------------------------------------

describe("getGrowthProgress", () => {
  it("aggregates the share of completed steps", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const growth = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [
        step("a", "completed"),
        step("b", "completed"),
        step("c", "pending"),
        step("d", "skipped"), // stays in the denominator, never "completed"
      ],
      actor: ACTOR,
    });

    const progress = store.getGrowthProgress(P, "node", leaf.id)!;
    expect(progress.total).toBe(4);
    expect(progress.completed).toBe(2);
    expect(progress.failed).toBe(0);
    expect(progress.ratio).toBeCloseTo(0.5, 10);
    expect(progress.status).toBe("active");
    expect(progress.revision).toBe(1);
    expect(progress.subjectId).toBe(leaf.id);

    // Finish the work: the ratio reaches 1.
    store.updateGrowth({
      projectKey: P,
      id: growth.id,
      steps: [
        step("a", "completed"),
        step("b", "completed"),
        step("c", "completed"),
        step("d", "skipped"),
      ],
      actor: ACTOR,
    });
    const finished = store.getGrowthProgress(P, "node", leaf.id)!;
    expect(finished.completed).toBe(3);
    expect(finished.ratio).toBeCloseTo(0.75, 10);
    expect(finished.revision).toBe(2);
  });

  it("counts failed steps separately from completed ones", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [
        step("a", "completed"),
        step("b", "failed"),
        step("c", "completed"),
        step("d", "failed"),
      ],
      actor: ACTOR,
    });

    const progress = store.getGrowthProgress(P, "node", leaf.id)!;
    expect(progress.total).toBe(4);
    expect(progress.completed).toBe(2);
    expect(progress.failed).toBe(2);
    expect(progress.ratio).toBeCloseTo(0.5, 10);
  });

  it("reports progress for a goal subject and null when untracked", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const goal = store.createGoal({
      projectKey: P,
      formalText: "Add PDF export",
      plan: [
        { id: "s1", title: "Design", description: "" },
        { id: "s2", title: "Ship", description: "" },
      ],
      actor: ACTOR,
    });

    expect(store.getGrowthProgress(P, "goal", goal.id)).toBeNull();
    expect(store.getGrowthProgress(P, "node", leaf.id)).toBeNull();

    store.createGrowth({
      projectKey: P,
      subjectType: "goal",
      subjectId: goal.id,
      steps: [step("s1", "completed"), step("s2", "pending")],
      actor: ACTOR,
    });
    const progress = store.getGrowthProgress(P, "goal", goal.id)!;
    expect(progress.total).toBe(2);
    expect(progress.completed).toBe(1);
    expect(progress.ratio).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// deleteGrowth and project scoping
// ---------------------------------------------------------------------------

describe("deleteGrowth", () => {
  it("removes the record, keeps a gapless audit trail and frees the subject", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const growth = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [step("a", "completed"), step("b", "pending")],
      actor: ACTOR,
    });
    store.updateGrowth({
      projectKey: P,
      id: growth.id,
      status: "stalled",
      actor: ACTOR,
    });

    const removed = store.deleteGrowth({
      projectKey: P,
      id: growth.id,
      actor: ACTOR,
    });
    expect(removed.id).toBe(growth.id);
    expect(removed.revision).toBe(3); // final recorded state, matches history
    expect(store.getGrowth(P, growth.id)).toBeNull();
    expect(store.getGrowthProgress(P, "node", leaf.id)).toBeNull();
    expect(store.listGrowth(P)).toEqual([]);
    expectGrowthHistory(store, growth.id, ["create", "status", "archive"], 3);
    expect(store.listHistory(P, growth.id)[2].result).toBe(
      `deleted growth for node ${leaf.id} (2 step(s))`,
    );

    expect(() =>
      store.deleteGrowth({ projectKey: P, id: growth.id, actor: ACTOR }),
    ).toThrow(/not found in project/);

    // The subject is free for a fresh record.
    const fresh = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [step("a", "pending")],
      actor: ACTOR,
    });
    expect(fresh.revision).toBe(1);
    expect(store.listGrowth(P).map((entry) => entry.id)).toEqual([fresh.id]);
    // The deleted record's own history survives it.
    expectGrowthHistory(store, growth.id, ["create", "status", "archive"], 3);
  });

  it("keeps growth records of other projects out of every read", () => {
    const store = openStore();
    const { leaf } = skeleton(store);
    const mine = store.createGrowth({
      projectKey: P,
      subjectType: "node",
      subjectId: leaf.id,
      steps: [step("a", "pending")],
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
    const foreignLeaf = store.createNode({
      projectKey: OTHER,
      parentId: foreignBranch.id,
      kind: "leaf",
      name: "foreign fact",
      actor: ACTOR,
    });
    const theirs = store.createGrowth({
      projectKey: OTHER,
      subjectType: "node",
      subjectId: foreignLeaf.id,
      steps: [step("a", "completed")],
      actor: ACTOR,
    });

    expect(store.listGrowth(P).map((entry) => entry.id)).toEqual([mine.id]);
    expect(store.listGrowth(OTHER).map((entry) => entry.id)).toEqual([
      theirs.id,
    ]);
    expect(store.getGrowth(P, theirs.id)).toBeNull();
    expect(store.getGrowthForSubject(P, "node", foreignLeaf.id)).toBeNull();
    expect(store.getGrowthProgress(P, "node", foreignLeaf.id)).toBeNull();
    // Cross-scope mutations fail instead of leaking.
    expect(() =>
      store.updateGrowth({
        projectKey: P,
        id: theirs.id,
        status: "done",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
    expect(() =>
      store.deleteGrowth({ projectKey: P, id: theirs.id, actor: ACTOR }),
    ).toThrow(/not found in project/);
    // A foreign subject cannot be attached from this project either.
    expect(() =>
      store.createGrowth({
        projectKey: P,
        subjectType: "node",
        subjectId: foreignLeaf.id,
        steps: [step("a", "pending")],
        actor: ACTOR,
      }),
    ).toThrow(/growth subject node .* not found in project/);

    expect(store.getGrowth(OTHER, theirs.id)!.revision).toBe(1);
    expect(store.getGrowthProgress(OTHER, "node", foreignLeaf.id)!.ratio).toBe(
      1,
    );
  });
});
