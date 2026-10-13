import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore } from "../server/store";
import type { Bee, BeeStatus } from "../shared/links";
import type { Node } from "../shared/tree";

/**
 * Stage C1 acceptance (`PLAN.md`): influence links ("bees") between leaves
 * of one project. Real SQLite files in a temp directory, no mocks — the
 * discipline of the store, CRUD and search tests.
 *
 * Audit invariant checked throughout (the B3 rule, applied to bees): for
 * one bee, `history.revision` is exactly 1..N with no gaps or duplicates,
 * strictly increasing across mutations, every row carries an actor and a
 * non-empty result, and the last history revision equals the bee's current
 * revision (or, after `deleteBee`, its returned final revision).
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:planner";

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-bees-"));
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

/**
 * root → trunk → branch → subbranch. The `branch` node exists mainly so a
 * test can prove that non-leaf ends are rejected.
 */
function skeleton(store: LuckPlannerStore): {
  root: Node;
  trunk: Node;
  branch: Node;
  subbranch: Node;
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
  return { root, trunk, branch, subbranch };
}

function leaf(
  store: LuckPlannerStore,
  parentId: string,
  name: string,
): Node {
  return store.createNode({
    projectKey: P,
    parentId,
    kind: "leaf",
    name,
    actor: ACTOR,
  });
}

/** Two leaves under the skeleton, ready to be linked. */
function leafPair(store: LuckPlannerStore): { a: Node; b: Node } {
  const { subbranch } = skeleton(store);
  return {
    a: leaf(store, subbranch.id, "invoice render"),
    b: leaf(store, subbranch.id, "webhook retry"),
  };
}

/**
 * Asserts the audit invariant for one bee: gapless strictly-increasing
 * revisions, actor on every row, `entity_type = bee`, and the last
 * revision matching `finalRevision` when one is given.
 */
function expectBeeHistory(
  store: LuckPlannerStore,
  beeId: string,
  expectedActions: string[],
  finalRevision?: number,
): void {
  const history = store.listHistory(P, beeId);
  expect(history.map((entry) => entry.action)).toEqual(expectedActions);
  history.forEach((entry, index) => {
    expect(entry.entityType).toBe("bee");
    expect(entry.entityId).toBe(beeId);
    expect(entry.revision).toBe(index + 1);
    expect(entry.actor).toBe(ACTOR);
    expect(entry.result.length).toBeGreaterThan(0);
    expect(entry.at).toBeGreaterThan(0);
  });
  if (finalRevision !== undefined) {
    expect(history[history.length - 1]?.revision).toBe(finalRevision);
  }
}

// ---------------------------------------------------------------------------
// createBee: ends, loops, duplicates
// ---------------------------------------------------------------------------

describe("createBee", () => {
  it("creates an active edge with revision 1 and a link audit row", () => {
    const store = openStore();
    const { a, b } = leafPair(store);

    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });
    expect(bee.status).toBe("active");
    expect(bee.revision).toBe(1);
    expect(bee.impact).toBe("");
    expect(bee.sourceLeafId).toBe(a.id);
    expect(bee.targetLeafId).toBe(b.id);
    expect(bee.createdBy).toBe(ACTOR);

    expect(store.getBee(P, bee.id)).toEqual(bee);
    expect(store.getBee(OTHER, bee.id)).toBeNull();
    expect(store.getBee(P, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expectBeeHistory(store, bee.id, ["link"], 1);
  });

  it("accepts an explicit initial status and impact", () => {
    const store = openStore();
    const { a, b } = leafPair(store);

    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      status: "watching" as BeeStatus,
      impact: "blocks the same pipeline",
      actor: ACTOR,
    });
    expect(bee.status).toBe("watching");
    expect(bee.impact).toBe("blocks the same pipeline");
    expect(store.listBees(P)).toHaveLength(1);
  });

  it("rejects a self-loop without writing anything", () => {
    const store = openStore();
    const { a } = leafPair(store);

    expect(() =>
      store.createBee({
        projectKey: P,
        sourceLeafId: a.id,
        targetLeafId: a.id,
        actor: ACTOR,
      }),
    ).toThrow(/cannot connect a leaf to itself/);
    expect(store.listBees(P)).toEqual([]);
    // The rejected attempt left no bee-shaped history anywhere.
    expect(store.listHistory(P, a.id)).toHaveLength(1); // only the node create
  });

  it("requires both ends to exist in the same project", () => {
    const store = openStore();
    const { a } = leafPair(store);
    const foreign = store.createNode({
      projectKey: OTHER,
      parentId: null,
      kind: "root",
      name: "Foreign stack",
      actor: ACTOR,
    });
    const unknown = "00000000-0000-4000-8000-000000000000";

    expect(() =>
      store.createBee({
        projectKey: P,
        sourceLeafId: unknown,
        targetLeafId: a.id,
        actor: ACTOR,
      }),
    ).toThrow(new RegExp(`bee source node ${unknown} not found in project ${P}`));
    // A real leaf of another project is just as invisible.
    expect(() =>
      store.createBee({
        projectKey: P,
        sourceLeafId: a.id,
        targetLeafId: foreign.id,
        actor: ACTOR,
      }),
    ).toThrow(/bee target node .* not found in project/);
    expect(store.listBees(P)).toEqual([]);
  });

  it("requires both ends to be leaves", () => {
    const store = openStore();
    const { branch, subbranch } = skeleton(store);
    const fact = leaf(store, subbranch.id, "invoice render");

    expect(() =>
      store.createBee({
        projectKey: P,
        sourceLeafId: branch.id,
        targetLeafId: fact.id,
        actor: ACTOR,
      }),
    ).toThrow(/bee source node .* is a branch; bees connect leaves only/);
    expect(() =>
      store.createBee({
        projectKey: P,
        sourceLeafId: fact.id,
        targetLeafId: branch.id,
        actor: ACTOR,
      }),
    ).toThrow(/bee target node .* is a branch; bees connect leaves only/);
    expect(store.listBees(P)).toEqual([]);
  });

  it("rejects archived ends", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    store.archiveNode({ projectKey: P, id: b.id, actor: ACTOR });

    expect(() =>
      store.createBee({
        projectKey: P,
        sourceLeafId: a.id,
        targetLeafId: b.id,
        actor: ACTOR,
      }),
    ).toThrow(/bee target node .* is archived/);
    expect(store.listBees(P)).toEqual([]);
  });

  it("rejects a duplicate ordered pair but allows the reverse", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const first = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    expect(() =>
      store.createBee({
        projectKey: P,
        sourceLeafId: a.id,
        targetLeafId: b.id,
        actor: ACTOR,
      }),
    ).toThrow(new RegExp(`already exists \\(${first.id}\\)`));
    // The reverse direction is a different, legitimate relation.
    const reverse = store.createBee({
      projectKey: P,
      sourceLeafId: b.id,
      targetLeafId: a.id,
      actor: ACTOR,
    });
    expect(reverse.id).not.toBe(first.id);
    expect(store.listBees(P)).toHaveLength(2);
  });

  it("validates status, impact and actor input readably", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const base = { projectKey: P, sourceLeafId: a.id, targetLeafId: b.id };

    expect(() =>
      store.createBee({ ...base, status: "bogus" as BeeStatus, actor: ACTOR }),
    ).toThrow(/invalid bee status "bogus"; expected one of/);
    expect(() =>
      store.createBee({ ...base, impact: 42 as unknown as string, actor: ACTOR }),
    ).toThrow(/impact must be a string/);
    expect(() => store.createBee({ ...base, actor: "   " })).toThrow(
      /actor must not be empty/,
    );
    expect(store.listBees(P)).toEqual([]);
  });

  it("does not modify the leaves it links", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const beforeA = store.getNode(P, a.id)!;
    const beforeB = store.getNode(P, b.id)!;

    store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    const afterA = store.getNode(P, a.id)!;
    const afterB = store.getNode(P, b.id)!;
    expect(afterA.revision).toBe(beforeA.revision);
    expect(afterB.revision).toBe(beforeB.revision);
    expect(store.listHistory(P, a.id)).toHaveLength(1);
    expect(store.listHistory(P, b.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateBee: impact and the bee status machine
// ---------------------------------------------------------------------------

describe("updateBee", () => {
  it("updates impact with one revision bump and an update audit row", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    const updated = store.updateBee({
      projectKey: P,
      id: bee.id,
      impact: "retries delay the invoice export",
      actor: ACTOR,
    });
    expect(updated.impact).toBe("retries delay the invoice export");
    expect(updated.revision).toBe(2);
    expect(updated.status).toBe("active");
    expectBeeHistory(store, bee.id, ["link", "update"], 2);
    expect(store.listHistory(P, bee.id)[1].result).toBe("updated impact");
  });

  it("walks the status machine and records every transition", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    const watching = store.updateBee({
      projectKey: P,
      id: bee.id,
      status: "watching",
      actor: ACTOR,
    });
    expect(watching.status).toBe("watching");
    expect(watching.revision).toBe(2);

    const resolved = store.updateBee({
      projectKey: P,
      id: bee.id,
      status: "resolved",
      actor: ACTOR,
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.revision).toBe(3);

    expectBeeHistory(store, bee.id, ["link", "status", "status"], 3);
    expect(store.listHistory(P, bee.id)[1].result).toBe("active → watching");
    expect(store.listHistory(P, bee.id)[2].result).toBe("watching → resolved");
  });

  it("rejects a no-op and an illegal transition without changing anything", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      status: "resolved" as BeeStatus,
      actor: ACTOR,
    });

    expect(() =>
      store.updateBee({
        projectKey: P,
        id: bee.id,
        status: "resolved",
        actor: ACTOR,
      }),
    ).toThrow(/already has status "resolved"/);
    // BEE_TRANSITIONS: resolved may only go back to active.
    expect(() =>
      store.updateBee({
        projectKey: P,
        id: bee.id,
        status: "cancelled",
        actor: ACTOR,
      }),
    ).toThrow(/invalid status transition resolved → cancelled/);

    const unchanged = store.getBee(P, bee.id)!;
    expect(unchanged.revision).toBe(1);
    expect(unchanged.status).toBe("resolved");
    expectBeeHistory(store, bee.id, ["link"], 1);
  });

  it("reports the legal transitions in the rejection message", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      status: "resolved" as BeeStatus,
      actor: ACTOR,
    });

    expect(() =>
      store.updateBee({
        projectKey: P,
        id: bee.id,
        status: "cancelled",
        actor: ACTOR,
      }),
    ).toThrow(/allowed from "resolved": active/);
  });

  it("combines impact and status into a single revision and audit row", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    const updated = store.updateBee({
      projectKey: P,
      id: bee.id,
      impact: "blocks release",
      status: "watching",
      actor: ACTOR,
    });
    expect(updated.revision).toBe(2);
    expect(updated.status).toBe("watching");
    expect(updated.impact).toBe("blocks release");
    expectBeeHistory(store, bee.id, ["link", "status"], 2);
    expect(store.listHistory(P, bee.id)[1].result).toBe(
      "active → watching; updated impact",
    );
  });

  it("rejects an empty update and an unknown bee", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    expect(() =>
      store.updateBee({ projectKey: P, id: bee.id, actor: ACTOR }),
    ).toThrow(/requires at least one of: impact, status/);
    expect(() =>
      store.updateBee({
        projectKey: P,
        id: "00000000-0000-4000-8000-000000000000",
        impact: "x",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
    expectBeeHistory(store, bee.id, ["link"], 1);
  });

  it("scopes updates by project", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    expect(() =>
      store.updateBee({
        projectKey: OTHER,
        id: bee.id,
        impact: "hijacked",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
    expect(store.getBee(P, bee.id)!.impact).toBe("");
  });
});

// ---------------------------------------------------------------------------
// deleteBee
// ---------------------------------------------------------------------------

describe("deleteBee", () => {
  it("removes the edge and keeps a gapless audit trail", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });
    store.updateBee({
      projectKey: P,
      id: bee.id,
      impact: "blocks release",
      actor: ACTOR,
    });

    const removed = store.deleteBee({ projectKey: P, id: bee.id, actor: ACTOR });
    expect(removed.id).toBe(bee.id);
    expect(removed.revision).toBe(3); // final recorded state, matches history
    expect(store.getBee(P, bee.id)).toBeNull();
    expect(store.listBees(P)).toEqual([]);
    expect(store.listBeesForNode(P, a.id)).toEqual([]);
    expectBeeHistory(store, bee.id, ["link", "update", "unlink"], 3);
    expect(store.listHistory(P, bee.id)[2].result).toBe(
      `unlinked ${a.id} → ${b.id}`,
    );
  });

  it("fails twice on the same bee and allows re-linking the pair", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    store.deleteBee({ projectKey: P, id: bee.id, actor: ACTOR });
    expect(() =>
      store.deleteBee({ projectKey: P, id: bee.id, actor: ACTOR }),
    ).toThrow(/not found in project/);

    // The pair is free again: the duplicate check sees live rows only.
    const replacement = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      impact: "relinked after the incident",
      actor: ACTOR,
    });
    expect(replacement.id).not.toBe(bee.id);
    expect(store.listBees(P)).toEqual([replacement]);
    expectBeeHistory(store, replacement.id, ["link"], 1);
    // The old bee's history survives its own deletion.
    expectBeeHistory(store, bee.id, ["link", "unlink"], 2);
  });
});

// ---------------------------------------------------------------------------
// Reads: both directions, group influence, project scoping
// ---------------------------------------------------------------------------

describe("bee reads", () => {
  it("returns a bee from either end, and nothing for a stranger", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const stranger = leaf(store, a.parentId!, "unrelated");
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
      actor: ACTOR,
    });

    const fromSource = store.listBeesForNode(P, a.id);
    expect(fromSource.map((entry) => entry.id)).toEqual([bee.id]);
    expect(fromSource[0].sourceLeafId).toBe(a.id);

    const fromTarget = store.listBeesForNode(P, b.id);
    expect(fromTarget.map((entry) => entry.id)).toEqual([bee.id]);
    expect(fromTarget[0].targetLeafId).toBe(b.id);

    expect(store.listBeesForNode(P, stranger.id)).toEqual([]);
    expect(store.listBeesForNode(P, "00000000-0000-4000-8000-000000000000")).toEqual(
      [],
    );
  });

  it("expresses influence over a group as a set of bees", () => {
    const store = openStore();
    const { subbranch } = skeleton(store);
    const hub = leaf(store, subbranch.id, "export pipeline");
    const y = leaf(store, subbranch.id, "invoice render");
    const z = leaf(store, subbranch.id, "pdf layout");
    const w = leaf(store, subbranch.id, "retry policy");

    // The hub influences a group of two leaves; a third bee lands on it.
    store.createBee({
      projectKey: P,
      sourceLeafId: hub.id,
      targetLeafId: y.id,
      impact: "regenerating exports invalidates renders",
      actor: ACTOR,
    });
    store.createBee({
      projectKey: P,
      sourceLeafId: hub.id,
      targetLeafId: z.id,
      impact: "layout depends on the export schema",
      actor: ACTOR,
    });
    store.createBee({
      projectKey: P,
      sourceLeafId: w.id,
      targetLeafId: hub.id,
      impact: "retries re-run the pipeline",
      actor: ACTOR,
    });

    const touchingHub = store.listBeesForNode(P, hub.id);
    expect(touchingHub).toHaveLength(3);
    expect(
      touchingHub.filter((entry) => entry.sourceLeafId === hub.id),
    ).toHaveLength(2); // the group it influences
    expect(
      touchingHub.filter((entry) => entry.targetLeafId === hub.id),
    ).toHaveLength(1); // the influence landing on it

    // Group membership is per edge: a group member sees only its own bee.
    expect(store.listBeesForNode(P, y.id)).toHaveLength(1);
    expect(store.listBees(P)).toHaveLength(3);
    expect(store.listBees(P).every((entry: Bee) => entry.revision === 1)).toBe(
      true,
    );
  });

  it("keeps bees of other projects out of every read", () => {
    const store = openStore();
    const { a, b } = leafPair(store);
    const mine = store.createBee({
      projectKey: P,
      sourceLeafId: a.id,
      targetLeafId: b.id,
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
    const foreignLeafA = store.createNode({
      projectKey: OTHER,
      parentId: foreignBranch.id,
      kind: "leaf",
      name: "foreign fact one",
      actor: ACTOR,
    });
    const foreignLeafB = store.createNode({
      projectKey: OTHER,
      parentId: foreignBranch.id,
      kind: "leaf",
      name: "foreign fact two",
      actor: ACTOR,
    });
    const theirs = store.createBee({
      projectKey: OTHER,
      sourceLeafId: foreignLeafA.id,
      targetLeafId: foreignLeafB.id,
      actor: ACTOR,
    });

    expect(store.listBees(P).map((entry) => entry.id)).toEqual([mine.id]);
    expect(store.listBees(OTHER).map((entry) => entry.id)).toEqual([
      theirs.id,
    ]);
    expect(store.listBeesForNode(P, foreignLeafA.id)).toEqual([]);
  });
});
