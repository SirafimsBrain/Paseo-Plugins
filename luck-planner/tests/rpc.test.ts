import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { LuckPlannerStore } from "../server/store";
import {
  UI_ACTOR,
  bugReport,
  dashboardStatus,
  goalApprove,
  goalCreate,
  growthGet,
  nodeDetail,
  nodeSetStatus,
  stats,
  treeGet,
  treeSearch,
} from "../shared/rpc";
import type { Goal, GoalStep } from "../shared/goals";
import type { GrowthStep } from "../shared/growth";
import type { Node } from "../shared/tree";

/**
 * Stage E1 acceptance (`PLAN.md`): the plugin RPC surface over a real store.
 * A minimal fake `PluginServerContext` captures `server.handle`
 * registrations and runs them against a temp-directory SQLite file — no
 * mocks, the same discipline as the dispatch and store tests. Every RPC
 * carries `projectKey`; the suite pins that no read or write crosses it,
 * that write RPCs answer `{ ok, …, error }` instead of throwing, and that
 * `goal.approve` stamps the approving actor into the audit trail.
 */

const P = "/projects/demo";
const OTHER = "/projects/other";
const ACTOR = "agent:coder";

interface FakeServer extends PluginServerContext {
  call<T>(name: string, input: unknown): Promise<T>;
  handlers: Map<string, (input: never, context: never) => unknown>;
}

function createFakeServer(): FakeServer {
  const handlers = new Map<string, (input: never, context: never) => unknown>();
  const server = {
    registerSettings() {
      return {
        async read() {
          return {
            status: "ready" as const,
            revision: "1",
            values: {
              injectIntoAgents: true,
              mcpServerName: "luck-planner",
              // Hermetic: these tests exercise the RPC surface, not the
              // dashboard socket (covered by tests/http-server.test.ts).
              httpEnabled: false,
            },
          };
        },
        subscribe() {
          return () => {};
        },
      };
    },
    handle(
      contract: { name: string },
      handler: (input: never, context: never) => unknown,
    ) {
      handlers.set(contract.name, handler);
    },
    before() {
      return () => {};
    },
    on() {
      return () => {};
    },
    registerProvider() {},
    registerUsageSource() {},
    async call<T>(name: string, input: unknown): Promise<T> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      return (await handler(input as never, undefined as never)) as T;
    },
    handlers,
  };
  return server as unknown as FakeServer;
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

function seedGoal(store: LuckPlannerStore): Goal {
  const plan: GoalStep[] = [
    { id: "step-1", title: "migrate charges table", description: "add retry columns" },
    { id: "step-2", title: "backfill worker", description: "requeue failed charges" },
  ];
  const goal = store.createGoal({
    projectKey: P,
    formalText: "ship billing retries",
    plan,
    actor: ACTOR,
  });
  return store.setGoalStatus({
    projectKey: P,
    id: goal.id,
    status: "proposed",
    actor: ACTOR,
  });
}

function seedGrowth(store: LuckPlannerStore, subjectId: string) {
  const steps: GrowthStep[] = [
    { id: "s1", title: "planned", state: "completed", facts: ["schema drafted"], reason: "" },
    { id: "s2", title: "worker", state: "in_progress", facts: [], reason: "waiting on review" },
  ];
  return store.createGrowth({
    projectKey: P,
    subjectType: "node",
    subjectId,
    steps,
    actor: ACTOR,
  });
}

let dirs: string[] = [];
let previousHome: string | undefined;

beforeEach(() => {
  dirs = [];
  previousHome = process.env.PASEO_HOME;
  const home = mkdtempSync(path.join(tmpdir(), "luck-planner-rpc-"));
  dirs.push(home);
  process.env.PASEO_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("RPC surface", () => {
  it("registers exactly the E1 contract set", () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      expect([...server.handlers.keys()].sort()).toEqual(
        [
          bugReport.name,
          dashboardStatus.name,
          goalApprove.name,
          goalCreate.name,
          growthGet.name,
          nodeDetail.name,
          nodeSetStatus.name,
          stats.name,
          treeGet.name,
          treeSearch.name,
        ].sort(),
      );
    } finally {
      cleanup();
    }
  });
});

describe("tree.get", () => {
  it("returns roots with their first level of children", async () => {
    const store = new LuckPlannerStore();
    const { root, trunk } = seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        projectKey: string;
        roots: Array<{ node: Node; children: Node[] }>;
      }>(treeGet.name, { projectKey: P });
      expect(result.projectKey).toBe(P);
      expect(result.roots).toHaveLength(1);
      expect(result.roots[0].node.id).toBe(root.id);
      expect(result.roots[0].children.map((child) => child.id)).toEqual([trunk.id]);
    } finally {
      cleanup();
    }
  });

  it("never sees another project", async () => {
    const store = new LuckPlannerStore();
    seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{ roots: unknown[] }>(treeGet.name, {
        projectKey: OTHER,
      });
      expect(result.roots).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("tree.search", () => {
  it("finds leaves by free text", async () => {
    const store = new LuckPlannerStore();
    const { leafA } = seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        matches: number;
        results: Array<{ node: Node; snippet: string | null }>;
      }>(treeSearch.name, { projectKey: P, query: "retry failed charges" });
      expect(result.matches).toBeGreaterThan(0);
      expect(result.results.some((hit) => hit.node.id === leafA.id)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("supports kind filters", async () => {
    const store = new LuckPlannerStore();
    seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{ results: Array<{ node: Node }> }>(
        treeSearch.name,
        { projectKey: P, query: "", kinds: ["branch"] },
      );
      expect(result.results.length).toBeGreaterThan(0);
      for (const hit of result.results) expect(hit.node.kind).toBe("branch");
    } finally {
      cleanup();
    }
  });
});
describe("node.detail", () => {
  it("returns the node with path, bees, bugs, history and growth", async () => {
    const store = new LuckPlannerStore();
    const { root, leafA, leafB } = seedTree(store);
    const bee = store.createBee({
      projectKey: P,
      sourceLeafId: leafA.id,
      targetLeafId: leafB.id,
      impact: "shares retry queue",
      actor: ACTOR,
    });
    const bug = store.createBug({
      projectKey: P,
      title: "queue stalls",
      severity: "high",
      nodeIds: [leafA.id],
      actor: ACTOR,
    });
    const growth = seedGrowth(store, leafA.id);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        node: Node;
        path: Node[];
        bees: Array<{ id: string }>;
        bugs: Array<{ id: string }>;
        blockingBugs: Array<{ id: string }>;
        history: Array<{ entityId: string }>;
        growth: { id: string } | null;
      }>(nodeDetail.name, { projectKey: P, nodeId: leafA.id });
      expect(result.node.id).toBe(leafA.id);
      expect(result.path[0].id).toBe(root.id);
      expect(result.path[result.path.length - 1].id).toBe(leafA.id);
      expect(result.bees.map((entry) => entry.id)).toEqual([bee.id]);
      expect(result.bugs.map((entry) => entry.id)).toEqual([bug.id]);
      expect(result.blockingBugs.map((entry) => entry.id)).toEqual([bug.id]);
      expect(result.history.length).toBeGreaterThan(0);
      expect(result.growth?.id).toBe(growth.id);
    } finally {
      cleanup();
    }
  });

  it("throws a readable error for an unknown node", async () => {
    const store = new LuckPlannerStore();
    seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      await expect(
        server.call(nodeDetail.name, {
          projectKey: P,
          nodeId: "00000000-0000-4000-8000-000000000000",
        }),
      ).rejects.toThrow(/not found in project/);
    } finally {
      cleanup();
    }
  });
});

describe("node.setStatus", () => {
  it("moves a leaf and stamps the default user actor", async () => {
    const store = new LuckPlannerStore();
    const { leafA } = seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        ok: boolean;
        node: Node | null;
        error: string | null;
      }>(nodeSetStatus.name, { projectKey: P, nodeId: leafA.id, status: "ready" });
      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.node?.status).toBe("ready");
      const check = new LuckPlannerStore();
      try {
        const history = check.listHistory(P, leafA.id);
        const last = history[history.length - 1];
        expect(last.action).toBe("status");
        expect(last.actor).toBe(UI_ACTOR);
      } finally {
        check.close();
      }
    } finally {
      cleanup();
    }
  });

  it("answers ok:false instead of throwing", async () => {
    const store = new LuckPlannerStore();
    const { leafA } = seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        ok: boolean;
        node: Node | null;
        error: string | null;
      }>(nodeSetStatus.name, { projectKey: P, nodeId: leafA.id, status: "done" });
      expect(result.ok).toBe(false);
      expect(result.node).toBeNull();
      expect(result.error).toMatch(/invalid status transition/);
    } finally {
      cleanup();
    }
  });
});

describe("goal.approve", () => {
  it("materializes the plan and records the approving actor", async () => {
    const store = new LuckPlannerStore();
    const { branch } = seedTree(store);
    const goal = seedGoal(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        ok: boolean;
        goal: Goal | null;
        error: string | null;
      }>(goalApprove.name, {
        projectKey: P,
        goalId: goal.id,
        parentBranchId: branch.id,
        actor: "user:owner",
      });
      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.goal?.status).toBe("approved");
      expect(result.goal?.materializedNodeId).not.toBeNull();
      const check = new LuckPlannerStore();
      try {
        const history = check.listHistory(P, goal.id);
        const approval = history.find((entry) => entry.action === "approve");
        expect(approval?.actor).toBe("user:owner");
        expect(check.listGoalLeaves(P, goal.id)).toHaveLength(2);
      } finally {
        check.close();
      }
    } finally {
      cleanup();
    }
  });

  it("refuses a draft goal with ok:false", async () => {
    const store = new LuckPlannerStore();
    const { branch } = seedTree(store);
    const draft = store.createGoal({
      projectKey: P,
      formalText: "draft plan",
      plan: [{ id: "s1", title: "step", description: "" }],
      actor: ACTOR,
    });
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        ok: boolean;
        goal: Goal | null;
        error: string | null;
      }>(goalApprove.name, {
        projectKey: P,
        goalId: draft.id,
        parentBranchId: branch.id,
      });
      expect(result.ok).toBe(false);
      expect(result.goal).toBeNull();
      expect(result.error).toMatch(/only a proposed goal may be approved/);
    } finally {
      cleanup();
    }
  });
});

describe("goal.create", () => {
  it("creates a draft with the default user actor", async () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        ok: boolean;
        goal: { id: string; status: string; materializedNodeId: string | null } | null;
        error: string | null;
      }>(goalCreate.name, {
        projectKey: P,
        formalText: "ship billing retries",
        plan: [{ id: "s1", title: "step", description: "" }],
      });
      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.goal?.status).toBe("draft");
      // A draft is not in the tree until approved (ADR-7).
      expect(result.goal?.materializedNodeId).toBeNull();
      const store = new LuckPlannerStore();
      try {
        const history = store.listHistory(P, result.goal!.id);
        const last = history[history.length - 1];
        expect(last.action).toBe("create");
        expect(last.actor).toBe(UI_ACTOR);
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });

  it("answers ok:false for an empty plan", async () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{ ok: boolean; goal: null; error: string | null }>(
        goalCreate.name,
        { projectKey: P, formalText: "x", plan: [] },
      );
      expect(result.ok).toBe(false);
      expect(result.goal).toBeNull();
      expect(result.error).toMatch(/at least one step/);
    } finally {
      cleanup();
    }
  });
});

describe("bug.report", () => {
  it("reports an incident with the default severity and actor", async () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        ok: boolean;
        bug: { id: string; title: string; severity: string; status: string } | null;
        error: string | null;
      }>(bugReport.name, { projectKey: P, title: "queue stalls under load" });
      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.bug?.title).toBe("queue stalls under load");
      expect(result.bug?.severity).toBe("medium");
      expect(result.bug?.status).toBe("open");
      const store = new LuckPlannerStore();
      try {
        const history = store.listHistory(P, result.bug!.id);
        expect(history[history.length - 1].actor).toBe(UI_ACTOR);
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });

  it("attaches blocking leaves when nodeIds are given", async () => {
    const store = new LuckPlannerStore();
    const { leafA } = seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        ok: boolean;
        bug: { id: string } | null;
        error: string | null;
      }>(bugReport.name, {
        projectKey: P,
        title: "retry deadlocks",
        severity: "high",
        nodeIds: [leafA.id],
      });
      expect(result.ok).toBe(true);
      const check = new LuckPlannerStore();
      try {
        const blocking = check.listBlockingBugs(P, leafA.id);
        expect(blocking.map((bug) => bug.id)).toEqual([result.bug!.id]);
      } finally {
        check.close();
      }
    } finally {
      cleanup();
    }
  });

  it("answers ok:false for an unknown leaf id", async () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{ ok: boolean; bug: null; error: string | null }>(
        bugReport.name,
        {
          projectKey: P,
          title: "orphan",
          nodeIds: ["00000000-0000-4000-8000-000000000000"],
        },
      );
      expect(result.ok).toBe(false);
      expect(result.bug).toBeNull();
      expect(result.error).toMatch(/not found in project/);
    } finally {
      cleanup();
    }
  });
});

describe("growth.get", () => {
  it("returns the record with its aggregate", async () => {
    const store = new LuckPlannerStore();
    const { leafA } = seedTree(store);
    const growth = seedGrowth(store, leafA.id);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        growth: { id: string } | null;
        total: number;
        completed: number;
        ratio: number;
      }>(growthGet.name, {
        projectKey: P,
        subjectType: "node",
        subjectId: leafA.id,
      });
      expect(result.growth?.id).toBe(growth.id);
      expect(result.total).toBe(2);
      expect(result.completed).toBe(1);
      expect(result.ratio).toBe(0.5);
    } finally {
      cleanup();
    }
  });

  it("answers null with zero progress when nothing is attached", async () => {
    const store = new LuckPlannerStore();
    const { leafA } = seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        growth: null;
        total: number;
        ratio: number;
      }>(growthGet.name, {
        projectKey: P,
        subjectType: "node",
        subjectId: leafA.id,
      });
      expect(result.growth).toBeNull();
      expect(result.total).toBe(0);
      expect(result.ratio).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("stats", () => {
  it("counts the project for the panel", async () => {
    const store = new LuckPlannerStore();
    const { leafA, leafB } = seedTree(store);
    store.createBee({
      projectKey: P,
      sourceLeafId: leafA.id,
      targetLeafId: leafB.id,
      actor: ACTOR,
    });
    store.createBug({
      projectKey: P,
      title: "stall",
      severity: "high",
      nodeIds: [leafA.id],
      actor: ACTOR,
    });
    seedGoal(store);
    seedGrowth(store, leafA.id);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        projectKey: string;
        nodes: { total: number };
        leaves: { total: number; inProgress: number; done: number };
        bees: number;
        bugs: { total: number; open: number };
        goals: { total: number; proposed: number };
        growthRecords: number;
      }>(stats.name, { projectKey: P });
      expect(result.projectKey).toBe(P);
      expect(result.nodes.total).toBe(5);
      expect(result.leaves).toEqual({ total: 2, inProgress: 0, done: 0 });
      expect(result.bees).toBe(1);
      expect(result.bugs).toEqual({ total: 1, open: 1 });
      expect(result.goals.total).toBe(1);
      expect(result.goals.proposed).toBe(1);
      expect(result.growthRecords).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("is empty for an unknown project", async () => {
    const store = new LuckPlannerStore();
    seedTree(store);
    store.close();
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      const result = await server.call<{
        nodes: { total: number };
        bees: number;
        bugs: { total: number };
        goals: { total: number };
        growthRecords: number;
      }>(stats.name, { projectKey: OTHER });
      expect(result.nodes.total).toBe(0);
      expect(result.bees).toBe(0);
      expect(result.bugs.total).toBe(0);
      expect(result.goals.total).toBe(0);
      expect(result.growthRecords).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("dashboard.status (stage F2)", () => {
  it("reports the endpoint as off when the setting is off", async () => {
    const server = createFakeServer();
    const cleanup = contribute(server);
    try {
      // The fake settings doc has `httpEnabled: false` — no socket is started
      // here (the listening case is covered by tests/http-lifecycle.test.ts).
      const result = await server.call<{
        enabled: boolean;
        listening: boolean;
        url: string | null;
        port: number | null;
        portFallback: boolean;
        error: string | null;
      }>(dashboardStatus.name, { projectKey: P });
      expect(result).toEqual({
        enabled: false,
        listening: false,
        url: null,
        port: null,
        portFallback: false,
        error: null,
      });
    } finally {
      cleanup();
    }
  });
});
