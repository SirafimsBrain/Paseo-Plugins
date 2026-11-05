/**
 * Several trees in one project (PLAN.md stage L10).
 *
 * `shared/roots.ts` is the forest model: which trees a project holds, what is
 * in them, how to look at one of them, and — the decision the stage is really
 * about — which branch an approved goal grows under when the caller names none.
 * It is pure, so these tests are plain data: no store, no server, no DOM.
 *
 * The two properties that must not erode: a forest is never guessed at (an
 * unnamed approval in a project with two trees is a refusal that names both),
 * and narrowing to one tree never leaves a link hanging off a node that is no
 * longer in the answer.
 */
import { describe, expect, it } from "vitest";
import type { TreeResponse } from "../shared/api";
import type { Node as TreeNode } from "../shared/tree";
import {
  buildForest,
  EMPTY_FOREST,
  forestIsSingleRoot,
  pickGoalParent,
  restrictToRoot,
  rootIdOf,
} from "../shared/roots";

const P = "/tmp/luck-planner-l10";
const T0 = 1_700_000_000_000;

function node(
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

/** Two trees: "alpha" (root → trunk → 2 branches, 2 leaves) and "beta". */
const ALPHA = [
  node("a-root", null, "root", "alpha"),
  node("a-trunk", "a-root", "trunk", "Platform"),
  node("a-b1", "a-trunk", "branch", "api"),
  node("a-b2", "a-trunk", "branch", "web"),
  node("a-l1", "a-b1", "leaf", "retry"),
  node("a-l2", "a-b2", "leaf", "cache"),
];
const BETA = [
  node("b-root", null, "root", "beta"),
  node("b-trunk", "b-root", "trunk", "Platform"),
  node("b-b1", "b-trunk", "branch", "cli"),
  node("b-l1", "b-b1", "leaf", "flags"),
];

describe("the forest", () => {
  it("is empty for a project without live nodes", () => {
    expect(buildForest([])).toEqual(EMPTY_FOREST);
    expect(buildForest([node("gone", null, "root", "old", { archivedAt: T0 })])).toEqual(
      EMPTY_FOREST,
    );
  });

  it("groups the nodes into trees, counted and ordered by name", () => {
    const forest = buildForest([...BETA, ...ALPHA]);
    expect(forest.roots.map((root) => root.name)).toEqual(["alpha", "beta"]);
    expect(forest.roots[0]).toMatchObject({
      id: "a-root",
      nodeCount: 6,
      leafCount: 2,
      branchCount: 2,
    });
    expect(forest.roots[1]).toMatchObject({
      id: "b-root",
      nodeCount: 4,
      leafCount: 1,
      branchCount: 1,
    });
    expect(forest.orphanCount).toBe(0);
  });

  it("is a single tree for one root, a forest for two, and counts strays", () => {
    expect(forestIsSingleRoot(buildForest(ALPHA))).toBe(true);
    expect(forestIsSingleRoot(buildForest([...ALPHA, ...BETA]))).toBe(false);
    // A node whose parent is missing from the payload is counted, never a root.
    const broken = buildForest([...ALPHA, node("stray", "ghost", "leaf", "lost")]);
    expect(broken.roots).toHaveLength(1);
    expect(broken.orphanCount).toBe(1);
  });

  it("picks the shallowest branch, alphabetically first, as the default", () => {
    const forest = buildForest(ALPHA);
    // Both branches sit under the trunk; "api" < "web".
    expect(forest.roots[0]!.defaultBranchId).toBe("a-b1");
    // A branch deeper than another never wins the default.
    const nested = buildForest([
      node("r", null, "root", "r"),
      node("t", "r", "trunk", "t"),
      node("b-outer", "t", "branch", "outer"),
      node("b-inner", "b-outer", "subbranch", "inner"),
    ]);
    expect(nested.roots[0]!.defaultBranchId).toBe("b-outer");
  });

  it("has no default branch when the tree has none", () => {
    const forest = buildForest([
      node("r", null, "root", "r"),
      node("t", "r", "trunk", "t"),
    ]);
    expect(forest.roots[0]!.defaultBranchId).toBeNull();
  });

  it("says which tree a node belongs to", () => {
    const nodes = [...ALPHA, ...BETA];
    expect(rootIdOf(nodes, "a-l2")).toBe("a-root");
    expect(rootIdOf(nodes, "b-l1")).toBe("b-root");
    expect(rootIdOf(nodes, "ghost")).toBeNull();
  });
});

describe("the goal-parent policy", () => {
  it("uses the default branch of a single tree", () => {
    const decision = pickGoalParent(ALPHA);
    expect(decision).toEqual({ ok: true, branchId: "a-b1", rootId: "a-root" });
  });

  it("refuses to guess in a forest, naming every tree", () => {
    const decision = pickGoalParent([...ALPHA, ...BETA]);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("ambiguous");
    expect(decision.roots.map((root) => root.name)).toEqual(["alpha", "beta"]);
    // The message is the one the server throws: it has to be actionable, so it
    // names the trees and each one's default branch.
    expect(decision.message).toContain("parentBranchId");
    expect(decision.message).toContain('"alpha"');
    expect(decision.message).toContain('"beta"');
    expect(decision.message).toContain("a-b1");
    expect(decision.message).toContain("b-b1");
  });

  it("asks for a skeleton when there is no tree at all", () => {
    const decision = pickGoalParent([]);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("empty");
    expect(decision.message).toContain("no live tree");
  });

  it("asks for a branch when the only tree has none", () => {
    const decision = pickGoalParent([
      node("r", null, "root", "solo"),
      node("t", "r", "trunk", "t"),
    ]);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("no-branch");
    expect(decision.message).toContain("solo");
  });

  it("ignores archived branches", () => {
    // An archived branch cannot take a child, so it cannot be the policy's pick.
    const decision = pickGoalParent([
      node("r", null, "root", "solo"),
      node("t", "r", "trunk", "t"),
      node("b-old", "t", "branch", "old", { archivedAt: T0 }),
      node("b-live", "t", "branch", "live"),
    ]);
    expect(decision).toEqual({ ok: true, branchId: "b-live", rootId: "r" });
  });
});

describe("looking at one tree", () => {
  const tree: TreeResponse = {
    projectKey: P,
    generatedAt: T0,
    nodes: [...ALPHA, ...BETA],
    bees: [
      {
        id: "bee-1",
        projectKey: P,
        sourceLeafId: "a-l1",
        targetLeafId: "a-l2",
        status: "active",
        revision: 1,
        impact: "",
        createdAt: T0,
        updatedAt: T0,
        createdBy: "user",
        updatedBy: "user",
      },
      {
        id: "bee-cross",
        projectKey: P,
        sourceLeafId: "a-l1",
        targetLeafId: "b-l1",
        status: "active",
        revision: 1,
        impact: "",
        createdAt: T0,
        updatedAt: T0,
        createdBy: "user",
        updatedBy: "user",
      },
    ],
    bugs: [
      {
        id: "bug-1",
        projectKey: P,
        title: "stall",
        description: "",
        severity: "high",
        status: "open",
        revision: 1,
        createdAt: T0,
        updatedAt: T0,
        createdBy: "user",
        updatedBy: "user",
      },
    ],
    bugAttachments: [
      { bugId: "bug-1", nodeId: "a-l1" },
      { bugId: "bug-1", nodeId: "b-l1" },
    ],
    goals: [
      {
        id: "goal-grown",
        projectKey: P,
        formalText: "grow alpha",
        plan: [],
        status: "approved",
        revision: 1,
        materializedNodeId: "a-b2",
        createdAt: T0,
        updatedAt: T0,
        createdBy: "user",
        updatedBy: "user",
      },
      {
        id: "goal-proposed",
        projectKey: P,
        formalText: "not yet",
        plan: [],
        status: "proposed",
        revision: 1,
        materializedNodeId: null,
        createdAt: T0,
        updatedAt: T0,
        createdBy: "user",
        updatedBy: "user",
      },
    ],
    growth: [
      {
        id: "g-row",
        projectKey: P,
        subjectType: "node",
        subjectId: "a-l1",
        steps: [],
        status: "active",
        revision: 1,
        createdAt: T0,
        updatedAt: T0,
        createdBy: "user",
        updatedBy: "user",
      },
      {
        id: "g-beta",
        projectKey: P,
        subjectType: "node",
        subjectId: "b-l1",
        steps: [],
        status: "active",
        revision: 1,
        createdAt: T0,
        updatedAt: T0,
        createdBy: "user",
        updatedBy: "user",
      },
    ],
  };

  it("keeps the whole payload when no tree is chosen", () => {
    expect(restrictToRoot(tree, null)).toBe(tree);
  });

  it("keeps one tree and every link that has both ends in it", () => {
    const alpha = restrictToRoot(tree, "a-root");
    expect(alpha.nodes.map((entry) => entry.id).sort()).toEqual([
      "a-b1",
      "a-b2",
      "a-l1",
      "a-l2",
      "a-root",
      "a-trunk",
    ]);
    expect(alpha.bees.map((bee) => bee.id)).toEqual(["bee-1"]);
    expect(alpha.bugAttachments.map((link) => link.nodeId)).toEqual(["a-l1"]);
    expect(alpha.growth.map((record) => record.id)).toEqual(["g-row"]);
  });

  it("drops a goal that grew in the other tree, keeps one that grew nowhere", () => {
    const beta = restrictToRoot(tree, "b-root");
    expect(beta.goals.map((goal) => goal.id)).toEqual(["goal-proposed"]);
    // A bug is a project incident, not a tree's property: it stays.
    expect(beta.bugs.map((bug) => bug.id)).toEqual(["bug-1"]);
  });

  it("returns the payload untouched for a root it does not hold", () => {
    const answer = restrictToRoot(tree, "ghost");
    expect(answer.nodes).toHaveLength(tree.nodes.length);
  });
});
