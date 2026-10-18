/**
 * The G2 data adapter (PLAN.md stage G2).
 *
 * `dashboard/src/graph.ts` turns one `/api/tree` payload into React Flow
 * nodes/edges: kind -> node type, a d3-hierarchy layout with baked-in gaps,
 * the collapse/expand policy and the open-incident badge counts. All of it is
 * pure, so these tests build fixture payloads in memory and assert the exact
 * types and positions - no DOM, no server, no React (the same style as
 * `tests/tree-panel.test.ts` for the native panel).
 *
 * The last suite is the G2 acceptance case: a synthetic 1000-node project
 * must open under the default collapse policy as a small, cheap-to-render
 * skeleton, and the adapter itself must stay well under interactive latency.
 */
import { describe, expect, it } from "vitest";
import type { TreeResponse } from "../shared/api";
import type { Node as TreeNode } from "../shared/tree";
import type { Goal } from "../shared/goals";
import {
  buildGraph,
  DEFAULT_VISIBLE_BUDGET,
  defaultCollapsedIds,
  EMPTY_GRAPH,
  GOAL_FRAME,
  indexTree,
  LAYOUT,
  NODE_KIND_TO_TYPE,
  toggleCollapsed,
} from "../dashboard/src/graph";
import { KIND_COLORS, withAlpha } from "../dashboard/src/colors";

const P = "/tmp/luck-planner-g2";
const T0 = 1_700_000_000_000;

function mknode(
  id: string,
  parentId: string | null,
  kind: TreeNode["kind"],
  name: string,
  extra: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    projectKey: P,
    parentId,
    kind,
    name,
    description: "",
    status: "draft",
    version: "0.1.0",
    revision: 1,
    payload: {},
    createdAt: T0,
    updatedAt: T0,
    createdBy: "user",
    updatedBy: "user",
    archivedAt: null,
    ...extra,
  };
}

function mkgoal(
  id: string,
  status: Goal["status"],
  materializedNodeId: string | null,
  extra: Partial<Goal> = {},
): Goal {
  return {
    id,
    projectKey: P,
    formalText: `Goal ${id}`,
    plan: [{ id: "s1", title: "step", description: "" }],
    status,
    revision: 1,
    materializedNodeId,
    createdAt: T0,
    updatedAt: T0,
    createdBy: "user",
    updatedBy: "user",
    ...extra,
  };
}

function mktree(nodes: TreeNode[], rest: Partial<TreeResponse> = {}): TreeResponse {
  return {
    projectKey: P,
    generatedAt: T0,
    nodes,
    bees: [],
    bugs: [],
    bugAttachments: [],
    goals: [],
    growth: [],
    ...rest,
  };
}

function fixture(): TreeResponse {
  return mktree([
    mknode("root-1", null, "root", "Tech stack"),
    mknode("trunk-1", "root-1", "trunk", "Platform"),
    mknode("branch-1", "trunk-1", "branch", "billing"),
    mknode("leaf-a", "branch-1", "leaf", "retry failed charges", {
      status: "in_progress",
      version: "2.1.0",
      revision: 7,
    }),
    mknode("leaf-b", "branch-1", "leaf", "prorate refunds", {
      status: "done",
    }),
  ]);
}

describe("NODE_KIND_TO_TYPE", () => {
  it("maps every kind to its own React Flow type", () => {
    expect(NODE_KIND_TO_TYPE).toEqual({
      root: "root",
      trunk: "trunk",
      branch: "branch",
      subbranch: "subbranch",
      leaf: "leaf",
    });
  });
});

describe("indexTree", () => {
  it("sorts children by name for a deterministic layout", () => {
    const index = indexTree(fixture().nodes);
    expect(index.roots.map((n) => n.id)).toEqual(["root-1"]);
    expect(index.childrenOf.get("branch-1")!.map((n) => n.id)).toEqual([
      "leaf-b",
      "leaf-a",
    ]);
  });

  it("treats a node with an unknown parent as a root (defensive)", () => {
    const index = indexTree([mknode("orphan-1", "gone", "leaf", "orphan")]);
    expect(index.roots.map((n) => n.id)).toEqual(["orphan-1"]);
  });
});

describe("buildGraph positions", () => {
  it("maps kinds to types, keeps data and lays levels one step apart", () => {
    const graph = buildGraph(fixture());
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    expect(byId.get("root-1")!.type).toBe("root");
    expect(byId.get("trunk-1")!.type).toBe("trunk");
    expect(byId.get("branch-1")!.type).toBe("branch");
    expect(byId.get("leaf-a")!.type).toBe("leaf");

    expect(byId.get("leaf-a")!.data).toMatchObject({
      name: "retry failed charges",
      kind: "leaf",
      status: "in_progress",
      version: "2.1.0",
      revision: 7,
      childCount: 0,
      hiddenDescendantCount: 0,
      collapsed: false,
    });

    const level = LAYOUT.nodeHeight + LAYOUT.verticalGap;
    expect(byId.get("root-1")!.position.y).toBe(level);
    expect(byId.get("trunk-1")!.position.y).toBe(2 * level);
    expect(byId.get("branch-1")!.position.y).toBe(3 * level);
    expect(byId.get("leaf-a")!.position.y).toBe(4 * level);
    expect(byId.get("leaf-b")!.position.y).toBe(4 * level);

    const a = byId.get("leaf-a")!.position.x;
    const b = byId.get("leaf-b")!.position.x;
    expect(b).toBeLessThan(a);
    expect(a - b).toBeGreaterThanOrEqual(LAYOUT.nodeWidth + LAYOUT.horizontalGap);

    expect(byId.get("branch-1")!.position.x).toBeCloseTo((a + b) / 2, 5);
  });

  it("emits a tree edge per visible non-root node", () => {
    const graph = buildGraph(fixture());
    const treeEdges = graph.edges.filter((e) => e.data?.kind === "tree");
    expect(treeEdges.map((e) => e.id).sort()).toEqual([
      "t:branch-1",
      "t:leaf-a",
      "t:leaf-b",
      "t:trunk-1",
    ]);
    const trunkEdge = treeEdges.find((e) => e.id === "t:trunk-1")!;
    expect(trunkEdge.source).toBe("root-1");
    expect(trunkEdge.target).toBe("trunk-1");
  });

  it("hides a collapsed subtree but keeps the collapsed node itself", () => {
    const graph = buildGraph(fixture(), { collapsedIds: new Set(["branch-1"]) });
    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["branch-1", "root-1", "trunk-1"]);

    const branch = graph.nodes.find((n) => n.id === "branch-1")!;
    expect(branch.data.collapsed).toBe(true);
    expect(branch.data.childCount).toBe(2);
    expect(branch.data.hiddenDescendantCount).toBe(2);

    for (const edge of graph.edges) {
      expect(["root-1", "trunk-1", "branch-1"]).toContain(edge.source);
      expect(["root-1", "trunk-1", "branch-1"]).toContain(edge.target);
    }
  });
});

describe("buildGraph collapse and payloads", () => {
  it("returns the empty graph for an empty payload", () => {
    expect(buildGraph(mktree([]))).toEqual(EMPTY_GRAPH);
  });

  it("re-lays the visible subtree so no gap is left by a collapse", () => {
    const graph = buildGraph(fixture(), { collapsedIds: new Set(["branch-1"]) });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const level = LAYOUT.nodeHeight + LAYOUT.verticalGap;
    expect(byId.get("root-1")!.position.y).toBe(level);
    expect(byId.get("trunk-1")!.position.y).toBe(2 * level);
    expect(byId.get("branch-1")!.position.y).toBe(3 * level);
  });

  it("renders a bee edge only when both endpoints are visible", () => {
    const bee = {
      id: "bee-1",
      projectKey: P,
      sourceLeafId: "leaf-a",
      targetLeafId: "leaf-b",
      status: "active" as const,
      revision: 1,
      impact: "shares the retry queue",
      createdAt: T0,
      updatedAt: T0,
      createdBy: "agent-1",
      updatedBy: "agent-1",
    };
    const withBee = { ...fixture(), bees: [bee] };

    const openGraph = buildGraph(withBee);
    const beeEdge = openGraph.edges.find((e) => e.data?.kind === "bee")!;
    expect(beeEdge.source).toBe("leaf-a");
    expect(beeEdge.target).toBe("leaf-b");
    expect(beeEdge.animated).toBe(true);
    expect(beeEdge.data).toMatchObject({
      kind: "bee",
      impact: "shares the retry queue",
      status: "active",
    });

    const collapsedGraph = buildGraph(withBee, { collapsedIds: new Set(["branch-1"]) });
    expect(collapsedGraph.edges.some((e) => e.data?.kind === "bee")).toBe(false);
  });

  it("counts open incidents per node (open plus investigating only)", () => {
    const withBugs = {
      ...fixture(),
      bugs: [
        {
          id: "bug-1",
          projectKey: P,
          title: "queue stalls",
          description: "",
          severity: "high" as const,
          status: "open" as const,
          revision: 1,
          createdAt: T0,
          updatedAt: T0,
          createdBy: "user",
          updatedBy: "user",
        },
        {
          id: "bug-2",
          projectKey: P,
          title: "flaky clock",
          description: "",
          severity: "low" as const,
          status: "investigating" as const,
          revision: 1,
          createdAt: T0,
          updatedAt: T0,
          createdBy: "user",
          updatedBy: "user",
        },
        {
          id: "bug-3",
          projectKey: P,
          title: "already fixed",
          description: "",
          severity: "high" as const,
          status: "resolved" as const,
          revision: 1,
          createdAt: T0,
          updatedAt: T0,
          createdBy: "user",
          updatedBy: "user",
        },
      ],
      bugAttachments: [
        { bugId: "bug-1", nodeId: "leaf-a" },
        { bugId: "bug-2", nodeId: "leaf-a" },
        { bugId: "bug-3", nodeId: "leaf-a" },
        { bugId: "bug-1", nodeId: "leaf-b" },
      ],
    };
    const byId = new Map(buildGraph(withBugs).nodes.map((n) => [n.id, n]));
    expect(byId.get("leaf-a")!.data.openBugCount).toBe(2);
    expect(byId.get("leaf-b")!.data.openBugCount).toBe(1);
    expect(byId.get("branch-1")!.data.openBugCount).toBe(0);
  });

  it("lays a forest under one coordinate space without a phantom node", () => {
    const forest = mktree([
      mknode("root-x", null, "root", "X stack"),
      mknode("root-y", null, "root", "Y stack"),
      mknode("leaf-x", "root-x", "leaf", "fact x"),
      mknode("leaf-y", "root-y", "leaf", "fact y"),
    ]);
    const graph = buildGraph(forest);
    expect(graph.nodes).toHaveLength(4);
    const level = LAYOUT.nodeHeight + LAYOUT.verticalGap;
    const roots = graph.nodes.filter((n) => n.type === "root");
    expect(roots.map((n) => n.position.y)).toEqual([level, level]);
    expect(
      Math.abs(roots[0].position.x - roots[1].position.x),
    ).toBeGreaterThanOrEqual(LAYOUT.nodeWidth + LAYOUT.horizontalGap);
  });
});

describe("defaultCollapsedIds", () => {
  it("leaves a small tree fully expanded", () => {
    expect(defaultCollapsedIds(fixture().nodes)).toEqual(new Set());
  });

  it("collapses the first level that would overflow the budget", () => {
    const nodes: TreeNode[] = [mknode("root-1", null, "root", "Tech stack")];
    for (let b = 0; b < 5; b += 1) {
      const branchId = `branch-${b}`;
      nodes.push(mknode(branchId, "root-1", "branch", `module ${b}`));
      for (let l = 0; l < 5; l += 1) {
        nodes.push(mknode(`${branchId}-leaf-${l}`, branchId, "leaf", `fact ${b}.${l}`));
      }
    }
    const collapsed = defaultCollapsedIds(nodes, { budget: 10 });
    expect([...collapsed].sort()).toEqual([
      "branch-0",
      "branch-1",
      "branch-2",
      "branch-3",
      "branch-4",
    ]);
  });
});

describe("toggleCollapsed", () => {
  it("adds and removes without mutating the input", () => {
    const original: ReadonlySet<string> = new Set(["a"]);
    const added = toggleCollapsed(original, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect([...original]).toEqual(["a"]);
    const removed = toggleCollapsed(added, "a");
    expect([...removed]).toEqual(["b"]);
  });
});

describe("G3: goal frames", () => {
  it("draws a frame that encloses the visible materialized subtree", () => {
    const withGoal = mktree(fixture().nodes, {
      goals: [mkgoal("goal-1", "approved", "branch-1")],
    });
    const graph = buildGraph(withGoal);
    expect(graph.goalFrames).toHaveLength(1);

    const frame = graph.goalFrames[0];
    expect(frame.id).toBe("goal:goal-1");
    expect(frame.type).toBe("goalFrame");
    expect(frame.zIndex).toBe(-1);
    expect(frame.selectable).toBe(false);
    expect(frame.data).toMatchObject({
      goalId: "goal-1",
      name: "Goal goal-1",
      status: "approved",
      nodeCount: 3,
    });

    // The box wraps branch + both leaves in layout coordinates.
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const box = ["branch-1", "leaf-a", "leaf-b"].map((id) => byId.get(id)!);
    const minX = Math.min(...box.map((n) => n.position.x));
    const minY = Math.min(...box.map((n) => n.position.y));
    const maxX = Math.max(...box.map((n) => n.position.x + LAYOUT.nodeWidth));
    const maxY = Math.max(...box.map((n) => n.position.y + LAYOUT.nodeHeight));

    expect(frame.position.x).toBeCloseTo(minX - GOAL_FRAME.padding, 5);
    expect(frame.position.y).toBeCloseTo(
      minY - GOAL_FRAME.padding - GOAL_FRAME.labelHeight,
      5,
    );
    expect(frame.data.width).toBeCloseTo(
      maxX - minX + 2 * GOAL_FRAME.padding,
      5,
    );
    expect(frame.data.height).toBeCloseTo(
      maxY - minY + 2 * GOAL_FRAME.padding + GOAL_FRAME.labelHeight,
      5,
    );
  });

  it("gives no frame to a goal that never materialized (ADR-7)", () => {
    const withGoal = mktree(fixture().nodes, {
      goals: [mkgoal("goal-draft", "proposed", null)],
    });
    expect(buildGraph(withGoal).goalFrames).toEqual([]);
  });

  it("shrinks the frame to the root itself when its subtree is collapsed", () => {
    const withGoal = mktree(fixture().nodes, {
      goals: [mkgoal("goal-1", "in_progress", "branch-1")],
    });
    const graph = buildGraph(withGoal, { collapsedIds: new Set(["branch-1"]) });
    expect(graph.goalFrames).toHaveLength(1);
    const frame = graph.goalFrames[0];
    expect(frame.data.nodeCount).toBe(1);
    // Exactly the collapsed root's box, no ghost of the hidden leaves.
    const branch = graph.nodes.find((n) => n.id === "branch-1")!;
    expect(frame.position.x).toBeCloseTo(
      branch.position.x - GOAL_FRAME.padding,
      5,
    );
    expect(frame.data.width).toBeCloseTo(LAYOUT.nodeWidth + 2 * GOAL_FRAME.padding, 5);
  });

  it("keeps frames sorted by goal id (payload order must not leak)", () => {
    const withGoals = mktree(fixture().nodes, {
      goals: [
        mkgoal("goal-b", "approved", "branch-1"),
        mkgoal("goal-a", "done", "leaf-a"),
      ],
    });
    expect(buildGraph(withGoals).goalFrames.map((f) => f.id)).toEqual([
      "goal:goal-a",
      "goal:goal-b",
    ]);
  });

  it("drops the frame when an ancestor collapse hides the subtree root", () => {
    const withGoal = mktree(fixture().nodes, {
      goals: [mkgoal("goal-1", "approved", "branch-1")],
    });
    const graph = buildGraph(withGoal, { collapsedIds: new Set(["trunk-1"]) });
    expect(graph.goalFrames).toEqual([]);
  });
});

describe("G3: edge styling", () => {
  it("routes bees through the custom `bee` renderer type", () => {
    const bee = {
      id: "bee-1",
      projectKey: P,
      sourceLeafId: "leaf-a",
      targetLeafId: "leaf-b",
      status: "watching" as const,
      revision: 1,
      impact: "shares the retry queue",
      createdAt: T0,
      updatedAt: T0,
      createdBy: "agent-1",
      updatedBy: "agent-1",
    };
    const graph = buildGraph({ ...fixture(), bees: [bee] });
    const beeEdge = graph.edges.find((e) => e.data?.kind === "bee")!;
    expect(beeEdge.type).toBe("bee");
    // Only a live (`active`) influence animates — watching must not dance.
    expect(beeEdge.animated).toBe(false);
  });

  it("tints each tree edge with its parent kind colour, softened", () => {
    const graph = buildGraph(fixture());
    const trunkEdge = graph.edges.find((e) => e.id === "t:trunk-1")!;
    expect(trunkEdge.style?.stroke).toBe(withAlpha(KIND_COLORS.root, 0.5));
    expect(trunkEdge.style?.stroke).toMatch(/^rgba\(/);

    const leafEdge = graph.edges.find((e) => e.id === "t:leaf-a")!;
    expect(leafEdge.style?.stroke).toBe(withAlpha(KIND_COLORS.branch, 0.5));
  });
});

describe("G2 acceptance: a 1000-node project", () => {
  function synthetic(): TreeNode[] {
    const nodes: TreeNode[] = [mknode("root-1", null, "root", "Tech stack")];
    for (let t = 0; t < 4; t += 1) {
      const trunkId = `trunk-${t}`;
      nodes.push(mknode(trunkId, "root-1", "trunk", `platform ${t}`));
      for (let b = 0; b < 10; b += 1) {
        const branchId = `${trunkId}-branch-${b}`;
        nodes.push(mknode(branchId, trunkId, "branch", `module ${t}.${b}`));
        for (let l = 0; l < 25; l += 1) {
          nodes.push(
            mknode(`${branchId}-leaf-${l}`, branchId, "leaf", `fact ${t}.${b}.${l}`),
          );
        }
      }
    }
    return nodes;
  }

  it("opens as a small skeleton and stays well under interactive latency", () => {
    const nodes = synthetic();
    expect(nodes.length).toBeGreaterThan(1000);

    const collapsed = defaultCollapsedIds(nodes);
    const graph = buildGraph(mktree(nodes), { collapsedIds: collapsed });

    expect(graph.nodes.length).toBeLessThanOrEqual(DEFAULT_VISIBLE_BUDGET);
    expect(graph.nodes.length).toBeGreaterThan(1);
    const visibleIds = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(visibleIds.has(edge.source)).toBe(true);
      expect(visibleIds.has(edge.target)).toBe(true);
    }

    const started = Date.now();
    for (let i = 0; i < 10; i += 1) {
      buildGraph(mktree(nodes), { collapsedIds: collapsed });
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
