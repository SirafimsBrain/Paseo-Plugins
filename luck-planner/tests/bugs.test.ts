import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore } from "../server/store";
import type { BugStatus } from "../shared/links";
import type { Node } from "../shared/tree";

/**
 * Stage C2 acceptance (`PLAN.md`): incidents ("bugs") with severity and
 * lifecycle, plus the m2m `bug_nodes` table — one bug blocks a leaf or a
 * group of leaves, and `open`/`investigating` ones surface as blockers in
 * the leaf details. Real SQLite files in a temp directory, no mocks.
 *
 * Two invariants are asserted throughout:
 * - audit: for one bug, `history.revision` is exactly 1..N with no gaps,
 *   strictly increasing, every row carries an actor and a non-empty result,
 *   and the last row matches the bug's current revision (or the final
 *   revision returned by `deleteBug`);
 * - the blocked leaves are never mutated by bug operations — a blocker is
 *   a computed read, not node state.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:planner";

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-bugs-"));
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

/** root → trunk → branch → subbranch; `branch` proves non-leaf rejections. */
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

function leaf(store: LuckPlannerStore, parentId: string, name: string): Node {
  return store.createNode({
    projectKey: P,
    parentId,
    kind: "leaf",
    name,
    actor: ACTOR,
  });
}

/** Three leaves under the skeleton: enough for a "group of leaves". */
function leafGroup(store: LuckPlannerStore): {
  subbranch: Node;
  branch: Node;
  a: Node;
  b: Node;
  c: Node;
} {
  const { branch, subbranch } = skeleton(store);
  return {
    branch,
    subbranch,
    a: leaf(store, subbranch.id, "invoice render"),
    b: leaf(store, subbranch.id, "webhook retry"),
    c: leaf(store, subbranch.id, "pdf layout"),
  };
}

function idsOf<T extends { id: string }>(items: T[]): string[] {
  return items.map((item) => item.id).sort();
}

/** Asserts the gapless audit invariant for one bug. */
function expectBugHistory(
  store: LuckPlannerStore,
  bugId: string,
  expectedActions: string[],
  finalRevision?: number,
): void {
  const history = store.listHistory(P, bugId);
  expect(history.map((entry) => entry.action)).toEqual(expectedActions);
  history.forEach((entry, index) => {
    expect(entry.entityType).toBe("bug");
    expect(entry.entityId).toBe(bugId);
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
// createBug
// ---------------------------------------------------------------------------

describe("createBug", () => {
  it("creates an open incident with revision 1 and a create audit row", () => {
    const store = openStore();
    skeleton(store);

    const bug = store.createBug({
      projectKey: P,
      title: "PDF export fails on empty pages",
      severity: "high",
      actor: ACTOR,
    });
    expect(bug.status).toBe("open");
    expect(bug.severity).toBe("high");
    expect(bug.revision).toBe(1);
    expect(bug.description).toBe("");
    expect(bug.createdBy).toBe(ACTOR);

    expect(store.getBug(P, bug.id)).toEqual(bug);
    expect(store.getBug(OTHER, bug.id)).toBeNull();
    expect(store.getBug(P, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expectBugHistory(store, bug.id, ["create"], 1);
    expect(store.listHistory(P, bug.id)[0].result).toBe(
      'created bug "PDF export fails on empty pages" (high)',
    );
  });

  it("attaches its initial leaf set in the same transaction", () => {
    const store = openStore();
    const { a, b, c } = leafGroup(store);
    const before = [a, b, c].map((node) => store.getNode(P, node.id)!.revision);

    const bug = store.createBug({
      projectKey: P,
      title: "Export pipeline is flaky",
      severity: "critical",
      nodeIds: [a.id, b.id],
      actor: ACTOR,
    });

    expect(idsOf(store.listNodesForBug(P, bug.id))).toEqual([a.id, b.id].sort());
    expect(store.listBugsForNode(P, a.id).map((entry) => entry.id)).toEqual([
      bug.id,
    ]);
    expect(store.listBugsForNode(P, c.id)).toEqual([]);
    // One creation = one audit row, attachments included.
    expectBugHistory(store, bug.id, ["create"], 1);
    expect(store.listHistory(P, bug.id)[0].result).toContain(
      "; attached 2 node(s)",
    );

    // The blocked leaves are untouched: a blocker is a computed read.
    [a, b, c].forEach((node, index) => {
      const after = store.getNode(P, node.id)!;
      expect(after.revision).toBe(before[index]);
      expect(store.listHistory(P, node.id)).toHaveLength(1);
    });
  });

  it("requires a title and a severity", () => {
    const store = openStore();
    skeleton(store);

    expect(() =>
      store.createBug({ projectKey: P, title: "   ", severity: "high", actor: ACTOR }),
    ).toThrow(/bug title must not be empty/);
    // A JS caller (RPC/MCP) can simply omit `severity`; the store must
    // reject that at runtime, so the test builds exactly that input.
    expect(() =>
      store.createBug({
        projectKey: P,
        title: "x",
        severity: undefined as unknown as string,
        actor: ACTOR,
      }),
    ).toThrow(/invalid bug severity undefined; expected one of/);
    expect(() =>
      store.createBug({
        projectKey: P,
        title: "x",
        severity: "showstopper",
        actor: ACTOR,
      }),
    ).toThrow(/invalid bug severity "showstopper"; expected one of/);
    expect(() =>
      store.createBug({
        projectKey: P,
        title: "x",
        severity: "low",
        status: "siaa" as BugStatus,
        actor: ACTOR,
      }),
    ).toThrow(/invalid bug status "siaa"; expected one of/);
    expect(() =>
      store.createBug({
        projectKey: P,
        title: "x",
        severity: "low",
        description: 7 as unknown as string,
        actor: ACTOR,
      }),
    ).toThrow(/description must be a string/);
    expect(store.listBugs(P)).toEqual([]);
  });

  it("rejects invalid initial attachments without writing anything", () => {
    const store = openStore();
    const { branch, a } = leafGroup(store);
    const unknown = "00000000-0000-4000-8000-000000000000";
    const base = { projectKey: P, title: "flaky", severity: "medium", actor: ACTOR };

    expect(() => store.createBug({ ...base, nodeIds: [unknown] })).toThrow(
      new RegExp(`bug node ${unknown} not found in project ${P}`),
    );
    expect(() => store.createBug({ ...base, nodeIds: [branch.id] })).toThrow(
      /bug node .* is a branch; bugs block leaves only/,
    );
    store.archiveNode({ projectKey: P, id: a.id, actor: ACTOR });
    expect(() => store.createBug({ ...base, nodeIds: [a.id] })).toThrow(
      /bug node .* is archived/,
    );
    // Rolled back as one unit: no half-created bug anywhere.
    expect(store.listBugs(P)).toEqual([]);
  });

  it("rejects attachments from another project", () => {
    const store = openStore();
    skeleton(store);
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

    expect(() =>
      store.createBug({
        projectKey: P,
        title: "flaky",
        severity: "medium",
        nodeIds: [foreignLeaf.id],
        actor: ACTOR,
      }),
    ).toThrow(/bug node .* not found in project/);
    expect(store.listBugs(P)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateBug
// ---------------------------------------------------------------------------

describe("updateBug", () => {
  it("updates title and severity with one revision and an update audit row", () => {
    const store = openStore();
    skeleton(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export fails",
      severity: "low",
      actor: ACTOR,
    });

    const updated = store.updateBug({
      projectKey: P,
      id: bug.id,
      title: "Export fails on empty pages",
      severity: "critical",
      actor: ACTOR,
    });
    expect(updated.title).toBe("Export fails on empty pages");
    expect(updated.severity).toBe("critical");
    expect(updated.revision).toBe(2);
    expect(updated.status).toBe("open");
    expectBugHistory(store, bug.id, ["create", "update"], 2);
    expect(store.listHistory(P, bug.id)[1].result).toBe(
      "updated title, severity",
    );
  });

  it("walks the lifecycle and records every transition", () => {
    const store = openStore();
    skeleton(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export fails",
      severity: "high",
      actor: ACTOR,
    });

    const investigating = store.updateBug({
      projectKey: P,
      id: bug.id,
      status: "investigating",
      actor: ACTOR,
    });
    expect(investigating.status).toBe("investigating");
    expect(investigating.revision).toBe(2);

    const resolved = store.updateBug({
      projectKey: P,
      id: bug.id,
      status: "resolved",
      actor: ACTOR,
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.revision).toBe(3);

    expectBugHistory(store, bug.id, ["create", "status", "status"], 3);
    expect(store.listHistory(P, bug.id)[1].result).toBe(
      "open → investigating",
    );
    expect(store.listHistory(P, bug.id)[2].result).toBe(
      "investigating → resolved",
    );
  });

  it("rejects a no-op and an illegal transition without changing anything", () => {
    const store = openStore();
    skeleton(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export fails",
      severity: "high",
      status: "resolved" as BugStatus,
      actor: ACTOR,
    });

    expect(() =>
      store.updateBug({ projectKey: P, id: bug.id, status: "resolved", actor: ACTOR }),
    ).toThrow(/already has status "resolved"/);
    // BUG_TRANSITIONS: resolved may only be reopened.
    expect(() =>
      store.updateBug({ projectKey: P, id: bug.id, status: "cancelled", actor: ACTOR }),
    ).toThrow(/invalid status transition resolved → cancelled/);
    expect(() =>
      store.updateBug({ projectKey: P, id: bug.id, status: "cancelled", actor: ACTOR }),
    ).toThrow(/allowed from "resolved": open/);

    const unchanged = store.getBug(P, bug.id)!;
    expect(unchanged.revision).toBe(1);
    expect(unchanged.status).toBe("resolved");
    expectBugHistory(store, bug.id, ["create"], 1);
  });

  it("combines severity and status into a single revision and audit row", () => {
    const store = openStore();
    skeleton(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export fails",
      severity: "low",
      actor: ACTOR,
    });

    const updated = store.updateBug({
      projectKey: P,
      id: bug.id,
      severity: "critical",
      status: "investigating",
      actor: ACTOR,
    });
    expect(updated.revision).toBe(2);
    expect(updated.severity).toBe("critical");
    expect(updated.status).toBe("investigating");
    expectBugHistory(store, bug.id, ["create", "status"], 2);
    expect(store.listHistory(P, bug.id)[1].result).toBe(
      "open → investigating; updated severity",
    );
  });

  it("rejects an empty update, an unknown bug and a foreign scope", () => {
    const store = openStore();
    skeleton(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export fails",
      severity: "low",
      actor: ACTOR,
    });

    expect(() => store.updateBug({ projectKey: P, id: bug.id, actor: ACTOR })).toThrow(
      /requires at least one of: title, description, severity, status/,
    );
    expect(() =>
      store.updateBug({
        projectKey: P,
        id: "00000000-0000-4000-8000-000000000000",
        severity: "high",
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
    expect(() =>
      store.updateBug({ projectKey: OTHER, id: bug.id, severity: "high", actor: ACTOR }),
    ).toThrow(/not found in project/);
    expectBugHistory(store, bug.id, ["create"], 1);
    expect(store.getBug(P, bug.id)!.severity).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// attachBug / detachBug: the group of leaves a bug blocks
// ---------------------------------------------------------------------------

describe("attachBug and detachBug", () => {
  it("grows and shrinks the blocked group with audit rows", () => {
    const store = openStore();
    const { a, b } = leafGroup(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export pipeline is flaky",
      severity: "high",
      actor: ACTOR,
    });

    const withA = store.attachBug({
      projectKey: P,
      bugId: bug.id,
      nodeId: a.id,
      actor: ACTOR,
    });
    expect(withA.revision).toBe(2);
    const withAB = store.attachBug({
      projectKey: P,
      bugId: bug.id,
      nodeId: b.id,
      actor: ACTOR,
    });
    expect(withAB.revision).toBe(3);
    expect(idsOf(store.listNodesForBug(P, bug.id))).toEqual([a.id, b.id].sort());

    const detached = store.detachBug({
      projectKey: P,
      bugId: bug.id,
      nodeId: a.id,
      actor: ACTOR,
    });
    expect(detached.revision).toBe(4);
    expect(idsOf(store.listNodesForBug(P, bug.id))).toEqual([b.id]);
    expect(store.listBugsForNode(P, a.id)).toEqual([]);

    expectBugHistory(store, bug.id, ["create", "link", "link", "unlink"], 4);
    expect(store.listHistory(P, bug.id)[1].result).toBe(`attached node ${a.id}`);
    expect(store.listHistory(P, bug.id)[3].result).toBe(`detached node ${a.id}`);
  });

  it("rejects duplicate, unknown, non-leaf and archived attachments", () => {
    const store = openStore();
    const { branch, a, b } = leafGroup(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export pipeline is flaky",
      severity: "high",
      nodeIds: [a.id],
      actor: ACTOR,
    });
    const unknown = "00000000-0000-4000-8000-000000000000";

    expect(() =>
      store.attachBug({ projectKey: P, bugId: bug.id, nodeId: a.id, actor: ACTOR }),
    ).toThrow(new RegExp(`bug ${bug.id} is already attached to node ${a.id}`));
    expect(() =>
      store.attachBug({ projectKey: P, bugId: bug.id, nodeId: unknown, actor: ACTOR }),
    ).toThrow(/bug node .* not found in project/);
    expect(() =>
      store.attachBug({
        projectKey: P,
        bugId: bug.id,
        nodeId: branch.id,
        actor: ACTOR,
      }),
    ).toThrow(/is a branch; bugs block leaves only/);
    store.archiveNode({ projectKey: P, id: b.id, actor: ACTOR });
    expect(() =>
      store.attachBug({ projectKey: P, bugId: bug.id, nodeId: b.id, actor: ACTOR }),
    ).toThrow(/bug node .* is archived/);
    // Unknown bug is caught before anything else is written.
    expect(() =>
      store.attachBug({
        projectKey: P,
        bugId: "00000000-0000-4000-8000-000000000000",
        nodeId: a.id,
        actor: ACTOR,
      }),
    ).toThrow(/not found in project/);
    expect(() =>
      store.detachBug({ projectKey: P, bugId: bug.id, nodeId: b.id, actor: ACTOR }),
    ).toThrow(new RegExp(`bug ${bug.id} is not attached to node ${b.id}`));

    // None of the rejected attempts changed anything.
    expect(store.getBug(P, bug.id)!.revision).toBe(1);
    expectBugHistory(store, bug.id, ["create"], 1);
    expect(idsOf(store.listNodesForBug(P, bug.id))).toEqual([a.id]);
  });

  it("allows re-attaching after a detach", () => {
    const store = openStore();
    const { a } = leafGroup(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export pipeline is flaky",
      severity: "high",
      nodeIds: [a.id],
      actor: ACTOR,
    });

    store.detachBug({ projectKey: P, bugId: bug.id, nodeId: a.id, actor: ACTOR });
    expect(store.listNodesForBug(P, bug.id)).toEqual([]);
    store.attachBug({ projectKey: P, bugId: bug.id, nodeId: a.id, actor: ACTOR });
    expect(idsOf(store.listNodesForBug(P, bug.id))).toEqual([a.id]);
    expectBugHistory(store, bug.id, ["create", "unlink", "link"], 3);
  });

  it("does not mutate the leaves it blocks", () => {
    const store = openStore();
    const { a, b } = leafGroup(store);
    const before = [a, b].map((node) => store.getNode(P, node.id)!);
    const bug = store.createBug({
      projectKey: P,
      title: "Export pipeline is flaky",
      severity: "high",
      nodeIds: [a.id],
      actor: ACTOR,
    });
    store.attachBug({ projectKey: P, bugId: bug.id, nodeId: b.id, actor: ACTOR });
    store.detachBug({ projectKey: P, bugId: bug.id, nodeId: a.id, actor: ACTOR });

    [a, b].forEach((node, index) => {
      const after = store.getNode(P, node.id)!;
      expect(after.revision).toBe(before[index].revision);
      expect(store.listHistory(P, node.id)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// deleteBug
// ---------------------------------------------------------------------------

describe("deleteBug", () => {
  it("removes the incident and its attachments, keeping a gapless audit trail", () => {
    const store = openStore();
    const { a, b } = leafGroup(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Export pipeline is flaky",
      severity: "high",
      nodeIds: [a.id],
      actor: ACTOR,
    });
    store.attachBug({ projectKey: P, bugId: bug.id, nodeId: b.id, actor: ACTOR });

    const removed = store.deleteBug({ projectKey: P, id: bug.id, actor: ACTOR });
    expect(removed.id).toBe(bug.id);
    expect(removed.revision).toBe(3); // final recorded state, matches history
    expect(store.getBug(P, bug.id)).toBeNull();
    expect(store.listBugs(P)).toEqual([]);
    expect(store.listBugsForNode(P, a.id)).toEqual([]);
    expect(store.listBugsForNode(P, b.id)).toEqual([]);
    expect(() => store.listNodesForBug(P, bug.id)).toThrow(
      /not found in project/,
    );
    expectBugHistory(store, bug.id, ["create", "link", "archive"], 3);
    expect(store.listHistory(P, bug.id)[2].result).toBe(
      'deleted bug "Export pipeline is flaky" (2 attachment(s) removed)',
    );
  });

  it("fails twice on the same bug and leaves its leaves untouched", () => {
    const store = openStore();
    const { a } = leafGroup(store);
    const before = store.getNode(P, a.id)!;
    const bug = store.createBug({
      projectKey: P,
      title: "Export pipeline is flaky",
      severity: "high",
      nodeIds: [a.id],
      actor: ACTOR,
    });

    store.deleteBug({ projectKey: P, id: bug.id, actor: ACTOR });
    expect(() =>
      store.deleteBug({ projectKey: P, id: bug.id, actor: ACTOR }),
    ).toThrow(/not found in project/);

    const after = store.getNode(P, a.id)!;
    expect(after.revision).toBe(before.revision);
    expect(store.listHistory(P, a.id)).toHaveLength(1);
    // The deleted bug's own history survives it.
    expectBugHistory(store, bug.id, ["create", "archive"], 2);
  });
});

// ---------------------------------------------------------------------------
// Reads: blockers and project scoping
// ---------------------------------------------------------------------------

describe("bug reads", () => {
  it("surfaces only blocking incidents as blockers of a leaf", () => {
    const store = openStore();
    const { a } = leafGroup(store);
    const statuses: BugStatus[] = [
      "open",
      "investigating",
      "resolved",
      "cancelled",
    ];
    const created = statuses.map((status) =>
      store.createBug({
        projectKey: P,
        title: `incident ${status}`,
        severity: "medium",
        status,
        nodeIds: [a.id],
        actor: ACTOR,
      }),
    );

    // The leaf sees every incident…
    expect(store.listBugsForNode(P, a.id)).toHaveLength(4);
    // …but only the blocking ones are blockers (isBugBlocking).
    const blockers = store.listBlockingBugs(P, a.id);
    expect(idsOf(blockers)).toEqual(
      [created[0].id, created[1].id].sort(), // open + investigating
    );
    expect(blockers.every((bug) => bug.status !== "resolved")).toBe(true);

    // Resolving a blocker removes it from the blocking set live.
    store.updateBug({
      projectKey: P,
      id: created[0].id,
      status: "investigating",
      actor: ACTOR,
    });
    store.updateBug({
      projectKey: P,
      id: created[1].id,
      status: "resolved",
      actor: ACTOR,
    });
    expect(store.listBlockingBugs(P, a.id).map((bug) => bug.id)).toEqual([
      created[0].id,
    ]);
    expect(store.listBugsForNode(P, a.id)).toHaveLength(4);
  });

  it("represents one incident blocking a group of leaves", () => {
    const store = openStore();
    const { a, b, c } = leafGroup(store);
    const bug = store.createBug({
      projectKey: P,
      title: "Shared timeout misconfiguration",
      severity: "critical",
      nodeIds: [a.id, b.id, c.id],
      actor: ACTOR,
    });

    const blocked = store.listNodesForBug(P, bug.id);
    expect(idsOf(blocked)).toEqual([a.id, b.id, c.id].sort());
    for (const node of [a, b, c]) {
      const blockers = store.listBlockingBugs(P, node.id);
      expect(blockers.map((entry) => entry.id)).toEqual([bug.id]);
    }
    expect(store.listBugs(P)).toHaveLength(1);
  });

  it("keeps bugs of other projects out of every read", () => {
    const store = openStore();
    const { a } = leafGroup(store);
    const mine = store.createBug({
      projectKey: P,
      title: "mine",
      severity: "low",
      nodeIds: [a.id],
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
    const theirs = store.createBug({
      projectKey: OTHER,
      title: "theirs",
      severity: "low",
      nodeIds: [foreignLeaf.id],
      actor: ACTOR,
    });

    expect(store.listBugs(P).map((bug) => bug.id)).toEqual([mine.id]);
    expect(store.listBugs(OTHER).map((bug) => bug.id)).toEqual([theirs.id]);
    expect(store.listBugsForNode(P, foreignLeaf.id)).toEqual([]);
    expect(store.listBlockingBugs(P, foreignLeaf.id)).toEqual([]);
    // In its own project the group reads back normally…
    expect(store.listNodesForBug(OTHER, theirs.id).map((node) => node.id)).toEqual(
      [foreignLeaf.id],
    );
    // …and a P-scoped read of that bug id fails instead of leaking.
    expect(store.getBug(P, theirs.id)).toBeNull();
    expect(() => store.listNodesForBug(P, theirs.id)).toThrow(
      /not found in project/,
    );
  });
});
