import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore } from "../server/store";
import { LEAF_TRANSITIONS, type LeafStatus, type Node } from "../shared/tree";

/**
 * Stage B3 acceptance (`PLAN.md`): node CRUD + leaf state machine +
 * revisions + append-only audit. Real SQLite files in a temp directory,
 * no mocks — the same discipline as the store tests.
 *
 * History consistency invariant checked throughout: for one node, the
 * `history.revision` sequence is exactly 1..N with no gaps or duplicates,
 * matches the node's current `revision`, and every row carries an actor.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const ACTOR = "agent:planner";

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-crud-"));
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
 * Asserts the append-only audit invariant for one entity: revisions are
 * exactly 1..N, actions are plausible, and every row has an actor and a
 * non-empty result.
 */
function expectHistoryConsistent(
  store: LuckPlannerStore,
  entityId: string,
  expectedActions: string[],
): void {
  const history = store.listHistory(P, entityId);
  expect(history.map((entry) => entry.action)).toEqual(expectedActions);
  history.forEach((entry, index) => {
    expect(entry.revision).toBe(index + 1);
    expect(entry.actor).toBe(ACTOR);
    expect(entry.result.length).toBeGreaterThan(0);
    expect(entry.at).toBeGreaterThan(0);
  });
}

/** Builds root → trunk → branch → subbranch → leafA, plus leafB. */
function seedTree(store: LuckPlannerStore): {
  root: Node;
  trunk: Node;
  branch: Node;
  subbranch: Node;
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
  const subbranch = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "subbranch",
    name: "invoices",
    actor: ACTOR,
  });
  const leafA = store.createNode({
    projectKey: P,
    parentId: subbranch.id,
    kind: "leaf",
    name: "PDF export",
    actor: ACTOR,
  });
  const leafB = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "CSV export",
    actor: ACTOR,
  });
  return { root, trunk, branch, subbranch, leafA, leafB };
}

describe("createNode", () => {
  it("creates a root node with revision 1 and a create audit row", () => {
    const store = openStore();
    const root = store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "Tech stack",
      description: "languages, libs, tools",
      version: "2026.1",
      payload: { runtime: "node" },
      actor: ACTOR,
    });
    expect(root.revision).toBe(1);
    expect(root.parentId).toBeNull();
    expect(root.status).toBe("draft");
    expect(root.createdBy).toBe(ACTOR);
    expect(root.updatedBy).toBe(ACTOR);
    expect(root.archivedAt).toBeNull();
    expect(root.payload).toEqual({ runtime: "node" });
    expectHistoryConsistent(store, root.id, ["create"]);
  });

  it("scopes reads by project key", () => {
    const store = openStore();
    const root = store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "Tech stack",
      actor: ACTOR,
    });
    expect(store.getNode(P, root.id)?.name).toBe("Tech stack");
    expect(store.getNode("/other/project", root.id)).toBeNull();
    expect(store.listHistory("/other/project", root.id)).toEqual([]);
  });

  it("rejects a child whose kind cannot hang off the parent", () => {
    const store = openStore();
    const root = store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "Tech stack",
      actor: ACTOR,
    });
    expect(() =>
      store.createNode({
        projectKey: P,
        parentId: root.id,
        kind: "leaf",
        name: "too deep",
        actor: ACTOR,
      }),
    ).toThrow(/a leaf cannot be a child of a root/);
  });

  it("rejects missing parents, empty names and empty actors", () => {
    const store = openStore();
    expect(() =>
      store.createNode({
        projectKey: P,
        parentId: null,
        kind: "trunk",
        name: "Platform",
        actor: ACTOR,
      }),
    ).toThrow(/requires a parent/);
    const root = store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "Tech stack",
      actor: ACTOR,
    });
    expect(() =>
      store.createNode({
        projectKey: P,
        parentId: root.id,
        kind: "root",
        name: "second root",
        actor: ACTOR,
      }),
    ).toThrow(/root node must not have a parent/);
    expect(() =>
      store.createNode({
        projectKey: P,
        parentId: null,
        kind: "root",
        name: "   ",
        actor: ACTOR,
      }),
    ).toThrow(/node name must not be empty/);
    expect(() =>
      store.createNode({
        projectKey: P,
        parentId: null,
        kind: "root",
        name: "Tech stack",
        actor: "",
      }),
    ).toThrow(/actor must not be empty/);
    expect(() =>
      store.createNode({
        projectKey: P,
        parentId: "00000000-0000-4000-8000-000000000000",
        kind: "branch",
        name: "orphan",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
  });

  it("writes no history when validation fails", () => {
    const store = openStore();
    const root = store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "Tech stack",
      actor: ACTOR,
    });
    expect(() =>
      store.createNode({
        projectKey: P,
        parentId: root.id,
        kind: "leaf",
        name: "rejected",
        actor: ACTOR,
      }),
    ).toThrow();
    // Only the root's create row exists; the rejected child wrote nothing.
    expect(store.listHistory(P, root.id)).toHaveLength(1);
  });
});

describe("updateNode", () => {
  it("bumps revision once per call and audits the changed fields", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const updated = store.updateNode({
      projectKey: P,
      id: leafA.id,
      description: "fact: uses pdfkit",
      version: "1.2.0",
      payload: { plan: "install pdfkit", fact: "shipped" },
      actor: ACTOR,
    });
    expect(updated.revision).toBe(2);
    expect(updated.description).toBe("fact: uses pdfkit");
    expect(updated.version).toBe("1.2.0");
    expect(updated.payload).toEqual({ plan: "install pdfkit", fact: "shipped" });
    expectHistoryConsistent(store, leafA.id, ["create", "update"]);
    expect(store.listHistory(P, leafA.id)[1].result).toBe(
      "updated description, version, payload",
    );
  });

  it("rejects an empty patch and a missing node", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    expect(() => store.updateNode({ projectKey: P, id: leafA.id, actor: ACTOR })).toThrow(
      /requires at least one of/,
    );
    expect(() =>
      store.updateNode({
        projectKey: P,
        id: "00000000-0000-4000-8000-000000000000",
        name: "ghost",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
  });
});

describe("setStatus (leaf state machine)", () => {
  it("walks the happy path and bumps revision on every transition", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    const path: LeafStatus[] = ["ready", "claimed", "in_progress", "done"];
    let current: Node = leafA;
    for (const status of path) {
      current = store.setStatus({ projectKey: P, id: leafA.id, status, actor: ACTOR });
      expect(current.status).toBe(status);
    }
    expect(current.revision).toBe(1 + path.length);
    expectHistoryConsistent(store, leafA.id, [
      "create",
      "status",
      "status",
      "status",
      "status",
    ]);
    const history = store.listHistory(P, leafA.id);
    expect(history[1].result).toBe("draft → ready");
    expect(history[4].result).toBe("in_progress → done");
  });

  it("supports blocked and its resume back to in_progress", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    store.setStatus({ projectKey: P, id: leafA.id, status: "ready", actor: ACTOR });
    store.setStatus({ projectKey: P, id: leafA.id, status: "claimed", actor: ACTOR });
    store.setStatus({ projectKey: P, id: leafA.id, status: "in_progress", actor: ACTOR });
    const blocked = store.setStatus({
      projectKey: P,
      id: leafA.id,
      status: "blocked",
      actor: ACTOR,
    });
    expect(blocked.status).toBe("blocked");
    const resumed = store.setStatus({
      projectKey: P,
      id: leafA.id,
      status: "in_progress",
      actor: ACTOR,
    });
    expect(resumed.status).toBe("in_progress");
    // create (r1) + ready, claimed, in_progress, blocked, in_progress = r6.
    expect(resumed.revision).toBe(6);
    expectHistoryConsistent(store, leafA.id, [
      "create",
      "status",
      "status",
      "status",
      "status",
      "status",
    ]);
  });

  it("rejects an invalid transition without bumping anything", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    expect(() =>
      store.setStatus({ projectKey: P, id: leafA.id, status: "in_progress", actor: ACTOR }),
    ).toThrow(/invalid status transition draft → in_progress/);
    const after = store.getNode(P, leafA.id)!;
    expect(after.revision).toBe(1);
    expect(after.status).toBe("draft");
    expectHistoryConsistent(store, leafA.id, ["create"]);
  });

  it("rejects a no-op (same status) as a rejected write", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    expect(() =>
      store.setStatus({ projectKey: P, id: leafA.id, status: "draft", actor: ACTOR }),
    ).toThrow(/already has status "draft"/);
    expect(store.getNode(P, leafA.id)!.revision).toBe(1);
    expect(store.listHistory(P, leafA.id)).toHaveLength(1);
  });

  it("rejects transitions out of terminal statuses", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    store.setStatus({ projectKey: P, id: leafA.id, status: "cancelled", actor: ACTOR });
    expect(() =>
      store.setStatus({ projectKey: P, id: leafA.id, status: "ready", actor: ACTOR }),
    ).toThrow(/allowed from "cancelled": none \(terminal status\)/);
    expect(store.getNode(P, leafA.id)!.status).toBe("cancelled");
  });

  it("allows only supersede from done (a confirmed fact is replaced, not cancelled)", () => {
    const store = openStore();
    const { leafA } = seedTree(store);
    for (const status of ["ready", "claimed", "in_progress", "done"] as const) {
      store.setStatus({ projectKey: P, id: leafA.id, status, actor: ACTOR });
    }
    expect(() =>
      store.setStatus({ projectKey: P, id: leafA.id, status: "cancelled", actor: ACTOR }),
    ).toThrow(/invalid status transition done → cancelled/);
    const superseded = store.setStatus({
      projectKey: P,
      id: leafA.id,
      status: "superseded",
      actor: ACTOR,
    });
    expect(superseded.status).toBe("superseded");
  });

  it("rejects setStatus on non-leaf nodes and on unknown ids", () => {
    const store = openStore();
    const { branch } = seedTree(store);
    expect(() =>
      store.setStatus({ projectKey: P, id: branch.id, status: "ready", actor: ACTOR }),
    ).toThrow(/state machine applies to leaf nodes only/);
    expect(() =>
      store.setStatus({
        projectKey: P,
        id: "00000000-0000-4000-8000-000000000000",
        status: "ready",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
  });

  it("enforces the full transition table for every (from, to) pair", () => {
    const store = openStore();
    const { subbranch } = seedTree(store);
    const all: LeafStatus[] = [
      "draft",
      "ready",
      "claimed",
      "in_progress",
      "blocked",
      "done",
      "cancelled",
      "superseded",
    ];
    for (const from of all) {
      for (const to of all) {
        // A fresh leaf starting at `from` — one pair per node, no carry-over.
        const leaf = store.createNode({
          projectKey: P,
          parentId: subbranch.id,
          kind: "leaf",
          name: `pair ${from} → ${to}`,
          status: from,
          actor: ACTOR,
        });
        expect(leaf.status).toBe(from);
        const allowed =
          from !== to && LEAF_TRANSITIONS[from].includes(to);
        if (allowed) {
          const moved = store.setStatus({
            projectKey: P,
            id: leaf.id,
            status: to,
            actor: ACTOR,
          });
          expect(moved.status).toBe(to);
          expect(moved.revision).toBe(2);
          expect(store.listHistory(P, leaf.id)).toHaveLength(2);
        } else {
          const expected =
            from === to ? /already has status/ : /invalid status transition/;
          expect(() =>
            store.setStatus({ projectKey: P, id: leaf.id, status: to, actor: ACTOR }),
          ).toThrow(expected);
          // The rejected write bumped nothing.
          expect(store.getNode(P, leaf.id)!.revision).toBe(1);
          expect(store.listHistory(P, leaf.id)).toHaveLength(1);
        }
      }
    }
  });
});

describe("moveNode", () => {
  it("re-parents a node, bumps revision and audits both ends", () => {
    const store = openStore();
    const { branch, leafA, leafB, subbranch } = seedTree(store);
    // Move leafB (on branch) next to leafA (in subbranch).
    const moved = store.moveNode({
      projectKey: P,
      id: leafB.id,
      newParentId: subbranch.id,
      actor: ACTOR,
    });
    expect(moved.parentId).toBe(subbranch.id);
    expect(moved.revision).toBe(2);
    const entry = store.listHistory(P, leafB.id)[1];
    expect(entry.action).toBe("update");
    expect(entry.result).toBe(`moved from ${branch.id} to ${subbranch.id}`);
    expectHistoryConsistent(store, leafB.id, ["create", "update"]);
    expect(store.getNode(P, leafA.id)!.parentId).toBe(subbranch.id);
  });

  it("rejects cycles, self-parenting and kind violations", () => {
    const store = openStore();
    const { root, trunk, branch, subbranch } = seedTree(store);
    expect(() =>
      store.moveNode({ projectKey: P, id: trunk.id, newParentId: trunk.id, actor: ACTOR }),
    ).toThrow(/under itself/);
    expect(() =>
      store.moveNode({ projectKey: P, id: root.id, newParentId: trunk.id, actor: ACTOR }),
    ).toThrow(/root node has no parent/);
    // Kind check fires before the cycle walk: a trunk may only hang off a root.
    expect(() =>
      store.moveNode({ projectKey: P, id: trunk.id, newParentId: branch.id, actor: ACTOR }),
    ).toThrow(/a trunk cannot be a child of a branch/);
    // A kind-valid cycle: subbranch nests under subbranch, so moving the
    // ancestor beneath its own descendant must still be rejected.
    const nested = store.createNode({
      projectKey: P,
      parentId: subbranch.id,
      kind: "subbranch",
      name: "nested",
      actor: ACTOR,
    });
    expect(() =>
      store.moveNode({
        projectKey: P,
        id: subbranch.id,
        newParentId: nested.id,
        actor: ACTOR,
      }),
    ).toThrow(/would create a cycle/);
    // Nothing changed: revisions and history untouched by the rejections.
    expect(store.getNode(P, trunk.id)!.revision).toBe(1);
    expect(store.getNode(P, trunk.id)!.parentId).toBe(root.id);
    expectHistoryConsistent(store, trunk.id, ["create"]);
    expect(store.getNode(P, branch.id)!.parentId).toBe(trunk.id);
  });

  it("rejects moving under an archived parent", () => {
    const store = openStore();
    const { branch, subbranch, leafA, leafB } = seedTree(store);
    // Archives subbranch and its child leafA; leafB stays live on branch.
    store.archiveNode({ projectKey: P, id: subbranch.id, actor: ACTOR });
    expect(() =>
      store.moveNode({ projectKey: P, id: leafB.id, newParentId: subbranch.id, actor: ACTOR }),
    ).toThrow(new RegExp(`parent node ${subbranch.id} is archived`));
    // leafA itself is archived, so it cannot move at all.
    expect(() =>
      store.moveNode({ projectKey: P, id: leafA.id, newParentId: branch.id, actor: ACTOR }),
    ).toThrow(/archived and cannot be moved/);
  });
});

describe("archiveNode (subtree cascade)", () => {
  it("archives the whole subtree, bumping revision and auditing each node", () => {
    const store = openStore();
    const { root, trunk, branch, subbranch, leafA, leafB } = seedTree(store);
    const archived = store.archiveNode({ projectKey: P, id: branch.id, actor: ACTOR });
    expect(archived.sort()).toEqual(
      [branch.id, subbranch.id, leafA.id, leafB.id].sort(),
    );
    for (const id of [branch.id, subbranch.id, leafA.id, leafB.id]) {
      const node = store.getNode(P, id)!;
      expect(node.archivedAt).toBeGreaterThan(0);
      expect(node.revision).toBe(2);
      expect(store.listHistory(P, id)[1].action).toBe("archive");
    }
    // Outside the subtree: untouched.
    for (const id of [root.id, trunk.id]) {
      expect(store.getNode(P, id)!.archivedAt).toBeNull();
      expect(store.getNode(P, id)!.revision).toBe(1);
      expect(store.listHistory(P, id)).toHaveLength(1);
    }
    expectHistoryConsistent(store, branch.id, ["create", "archive"]);
    expect(store.listHistory(P, subbranch.id)[1].result).toBe(
      `archived with ancestor ${branch.id}`,
    );
  });

  it("rejects double-archive and blocks mutations on archived nodes", () => {
    const store = openStore();
    const { branch, leafA } = seedTree(store);
    store.archiveNode({ projectKey: P, id: branch.id, actor: ACTOR });
    expect(() => store.archiveNode({ projectKey: P, id: branch.id, actor: ACTOR })).toThrow(
      /already archived/,
    );
    expect(() =>
      store.setStatus({ projectKey: P, id: leafA.id, status: "ready", actor: ACTOR }),
    ).toThrow(/archived and cannot change status/);
    expect(() =>
      store.updateNode({ projectKey: P, id: leafA.id, name: "renamed", actor: ACTOR }),
    ).toThrow(/archived and cannot be modified/);
    expect(() =>
      store.createNode({
        projectKey: P,
        parentId: leafA.id,
        kind: "leaf",
        name: "child of archived",
        actor: ACTOR,
      }),
    ).toThrow(/archived/);
    // Rejections changed nothing.
    expect(store.getNode(P, leafA.id)!.name).toBe("PDF export");
    expect(store.listHistory(P, leafA.id)).toHaveLength(2);
  });

  it("keeps the audit consistent after a mixed workload", () => {
    const store = openStore();
    const { branch, leafA, leafB } = seedTree(store);
    store.setStatus({ projectKey: P, id: leafA.id, status: "ready", actor: ACTOR });
    store.updateNode({ projectKey: P, id: leafA.id, version: "1.0.0", actor: ACTOR });
    store.setStatus({ projectKey: P, id: leafA.id, status: "claimed", actor: ACTOR });
    store.setStatus({ projectKey: P, id: leafB.id, status: "ready", actor: ACTOR });
    store.moveNode({ projectKey: P, id: leafA.id, newParentId: branch.id, actor: ACTOR });
    store.archiveNode({ projectKey: P, id: branch.id, actor: ACTOR });

    expectHistoryConsistent(store, leafA.id, [
      "create",
      "status",
      "update",
      "status",
      "update",
      "archive",
    ]);
    expectHistoryConsistent(store, leafB.id, ["create", "status", "archive"]);
    expect(store.getNode(P, leafA.id)!.revision).toBe(6);
    expect(store.getNode(P, leafB.id)!.revision).toBe(3);
  });
});
