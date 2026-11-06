/**
 * Lifecycle writes and the owner's decision (0.51.1).
 *
 * The owner moves statuses from the plain board; an agent may move them too,
 * but not silently on top of a status the person set by hand. The rule is
 * enforced in the store — the one layer the dashboard, the RPC and every MCP
 * tool share — and it keys on the **last status audit row**, not on who wrote
 * the row last: creating a leaf or approving a plan is not a status decision,
 * while a human's "defer this" is, and it must survive with its reason.
 *
 * Real SQLite files in a temp directory, like the rest of this suite: the rule
 * reads the audit trail inside the same transaction as the move.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore, StaleRevisionError } from "../server/store";
import { buildTreeResponse } from "../server/http-server";
import { treeResponseSchema } from "../shared/api";
import {
  UI_ACTOR,
  statusOverrideReason,
  type Node,
} from "../shared/tree";
import type { Bug } from "../shared/links";
import type { Goal } from "../shared/goals";

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const AGENT = "agent:coder";

function openStore(): LuckPlannerStore {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-status-"));
  dirs.push(dir);
  const store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seed(store: LuckPlannerStore): { branch: Node; leaf: Node } {
  const root = store.createNode({
    projectKey: P,
    parentId: null,
    kind: "root",
    name: "Tech stack",
    actor: UI_ACTOR,
  });
  const trunk = store.createNode({
    projectKey: P,
    parentId: root.id,
    kind: "trunk",
    name: "Platform",
    actor: UI_ACTOR,
  });
  const branch = store.createNode({
    projectKey: P,
    parentId: trunk.id,
    kind: "branch",
    name: "billing",
    actor: UI_ACTOR,
  });
  const leaf = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    actor: UI_ACTOR,
  });
  return { branch, leaf };
}

function seedBug(store: LuckPlannerStore, leaf: Node): Bug {
  return store.createBug({
    projectKey: P,
    title: "queue stalls",
    severity: "high",
    nodeIds: [leaf.id],
    actor: UI_ACTOR,
  });
}

function seedGoal(store: LuckPlannerStore): Goal {
  return store.createGoal({
    projectKey: P,
    formalText: "ship billing retries",
    plan: [{ id: "s1", title: "migrate charges", description: "" }],
    actor: UI_ACTOR,
  });
}

describe("an agent overriding the owner's status", () => {
  it("refuses the leaf move without a reason and writes nothing", () => {
    const store = openStore();
    const { leaf } = seed(store);
    store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "deferred",
      actor: UI_ACTOR,
    });
    const historyBefore = store.listHistory(P, leaf.id);

    expect(() =>
      store.setStatus({
        projectKey: P,
        id: leaf.id,
        status: "in_progress",
        actor: AGENT,
      }),
    ).toThrow(/agent override must say why/);

    expect(store.getNode(P, leaf.id)?.status).toBe("deferred");
    expect(store.listHistory(P, leaf.id)).toHaveLength(historyBefore.length);
  });

  it("accepts the move with a reason and keeps the reason in the audit trail", () => {
    const store = openStore();
    const { leaf } = seed(store);
    store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "deferred",
      actor: UI_ACTOR,
    });

    const moved = store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "in_progress",
      actor: AGENT,
      reason: "step 2 unblocks step 1",
    });
    expect(moved.status).toBe("in_progress");
    expect(store.listHistory(P, leaf.id).at(-1)).toMatchObject({
      action: "status",
      actor: AGENT,
      result: "deferred → in_progress — step 2 unblocks step 1",
    });
  });

  it("needs no reason on a row the agent still owns", () => {
    const store = openStore();
    const { leaf } = seed(store);
    store.setStatus({ projectKey: P, id: leaf.id, status: "ready", actor: AGENT });
    const moved = store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "claimed",
      actor: AGENT,
    });
    expect(moved.status).toBe("claimed");
  });

  it("needs no reason when the person only created the row", () => {
    // `create` is not a status decision: the human's will was "this fact
    // exists", not "it is ready", so the agent may plan it without prose.
    const store = openStore();
    const { leaf } = seed(store);
    const moved = store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "ready",
      actor: AGENT,
    });
    expect(moved.status).toBe("ready");
  });

  it("applies the same rule to an incident and to a goal", () => {
    const store = openStore();
    const { leaf } = seed(store);
    const bug = seedBug(store, leaf);
    store.setBugStatus({
      projectKey: P,
      id: bug.id,
      status: "investigating",
      actor: UI_ACTOR,
    });
    expect(() =>
      store.setBugStatus({
        projectKey: P,
        id: bug.id,
        status: "resolved",
        actor: AGENT,
      }),
    ).toThrow(/agent override must say why/);
    expect(
      store.setBugStatus({
        projectKey: P,
        id: bug.id,
        status: "resolved",
        actor: AGENT,
        reason: "retry queue reclaimed the message",
      }).status,
    ).toBe("resolved");

    // A goal: `approve` is not a status row, so an agent may start an approved
    // goal without a note...
    const branch = store.listNodes(P).find((node) => node.kind === "branch")!;
    const approvedOnly = seedGoal(store);
    store.setGoalStatus({
      projectKey: P,
      id: approvedOnly.id,
      status: "proposed",
      actor: UI_ACTOR,
    });
    store.approveGoal({
      projectKey: P,
      id: approvedOnly.id,
      parentBranchId: branch.id,
      actor: UI_ACTOR,
    });
    expect(
      store.setGoalStatus({
        projectKey: P,
        id: approvedOnly.id,
        status: "in_progress",
        actor: AGENT,
      }).status,
    ).toBe("in_progress");

    // ...but once the person set the status by hand, the next agent move has
    // to say why.
    const goal = seedGoal(store);
    store.setGoalStatus({
      projectKey: P,
      id: goal.id,
      status: "proposed",
      actor: UI_ACTOR,
    });
    store.approveGoal({
      projectKey: P,
      id: goal.id,
      parentBranchId: branch.id,
      actor: UI_ACTOR,
    });
    store.setGoalStatus({
      projectKey: P,
      id: goal.id,
      status: "in_progress",
      actor: UI_ACTOR,
    });
    expect(() =>
      store.setGoalStatus({
        projectKey: P,
        id: goal.id,
        status: "done",
        actor: AGENT,
      }),
    ).toThrow(/agent override must say why/);
    expect(
      store.setGoalStatus({
        projectKey: P,
        id: goal.id,
        status: "done",
        actor: AGENT,
        reason: "both plan steps landed in the tree",
      }).status,
    ).toBe("done");
  });
});

describe("the lifecycle writers", () => {
  it("refuses a stale revision on an incident and writes nothing", () => {
    const store = openStore();
    const { leaf } = seed(store);
    const bug = seedBug(store, leaf);
    store.setBugStatus({
      projectKey: P,
      id: bug.id,
      status: "investigating",
      actor: UI_ACTOR,
    });
    const historyBefore = store.listHistory(P, bug.id);

    expect(() =>
      store.setBugStatus({
        projectKey: P,
        id: bug.id,
        status: "resolved",
        actor: UI_ACTOR,
        expectedRevision: bug.revision,
      }),
    ).toThrow(StaleRevisionError);
    expect(store.getBug(P, bug.id)?.status).toBe("investigating");
    expect(store.listHistory(P, bug.id)).toHaveLength(historyBefore.length);
  });

  it("refuses a stale revision on a goal", () => {
    const store = openStore();
    const goal = seedGoal(store);
    store.setGoalStatus({
      projectKey: P,
      id: goal.id,
      status: "proposed",
      actor: UI_ACTOR,
    });
    expect(() =>
      store.setGoalStatus({
        projectKey: P,
        id: goal.id,
        status: "cancelled",
        actor: UI_ACTOR,
        expectedRevision: goal.revision,
      }),
    ).toThrow(StaleRevisionError);
    expect(store.getGoal(P, goal.id)?.status).toBe("proposed");
  });
});

/**
 * The note the board reads (0.51.2).
 *
 * `/api/tree` carries the newest status audit row per entity, and the dashboards
 * turn `deferred → in_progress — step 2 depends on step 1` back into the reason.
 * The parser is shared, so the card, the modal and the 2D panel cannot disagree
 * about which half is the explanation.
 */
describe("the status note", () => {
  it("extracts an agent's reason and ignores a person's move", () => {
    expect(
      statusOverrideReason({
        entityType: "node",
        entityId: "n1",
        actor: "agent:coder",
        revision: 3,
        result: "deferred → in_progress — step 2 depends on step 1",
        at: 1,
      }),
    ).toBe("step 2 depends on step 1");

    expect(
      statusOverrideReason({
        entityType: "node",
        entityId: "n1",
        actor: UI_ACTOR,
        revision: 3,
        result: "deferred → in_progress — a human's own note",
        at: 1,
      }),
    ).toBeNull();

    expect(
      statusOverrideReason({
        entityType: "node",
        entityId: "n1",
        actor: "agent:coder",
        revision: 3,
        result: "draft → ready",
        at: 1,
      }),
    ).toBeNull();
  });

  it("keeps a reason that itself contains the separator", () => {
    expect(
      statusOverrideReason({
        entityType: "bug",
        entityId: "b1",
        actor: "agent:coder",
        revision: 2,
        result: "open → investigating — blocked by schema — retry later",
        at: 1,
      }),
    ).toBe("blocked by schema — retry later");
  });

  it("reports the newest status row per entity, and only status rows", () => {
    const store = openStore();
    const { leaf } = seed(store);
    const bug = seedBug(store, leaf);
    store.setStatus({ projectKey: P, id: leaf.id, status: "ready", actor: UI_ACTOR });
    store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "claimed",
      actor: AGENT,
      reason: "taking this one",
    });
    store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "in_progress",
      actor: AGENT,
    });
    store.setBugStatus({
      projectKey: P,
      id: bug.id,
      status: "investigating",
      actor: UI_ACTOR,
    });
    // A rename bumps the revision but is not a status row: it must not hide the
    // status note the card shows.
    store.updateNode({
      projectKey: P,
      id: leaf.id,
      name: "retry failed charges (v2)",
      actor: AGENT,
    });

    const notes = store.latestStatusNotes(P);
    const leafNote = notes.find(
      (note) => note.entityType === "node" && note.entityId === leaf.id,
    )!;
    expect(leafNote.result).toBe("claimed → in_progress");
    expect(leafNote.actor).toBe(AGENT);
    expect(leafNote.revision).toBe(4);
    expect(
      notes.find((note) => note.entityType === "bug" && note.entityId === bug.id),
    ).toMatchObject({ result: "open → investigating", actor: UI_ACTOR });
    // The bug's `create` row is not a status note, and neither is the rename.
    expect(notes).toHaveLength(2);
  });

  it("carries the override reason into the tree payload", () => {
    const store = openStore();
    const { leaf } = seed(store);
    store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "deferred",
      actor: UI_ACTOR,
    });
    store.setStatus({
      projectKey: P,
      id: leaf.id,
      status: "in_progress",
      actor: AGENT,
      reason: "step 2 depends on step 1",
    });

    const tree = buildTreeResponse(store, P);
    const parsed = treeResponseSchema.parse(tree);
    const note = parsed.statusNotes!.find((entry) => entry.entityId === leaf.id)!;
    expect(statusOverrideReason(note)).toBe("step 2 depends on step 1");
  });
});
