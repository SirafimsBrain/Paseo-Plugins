/**
 * The plain board adapter (PLAN.md stage K1, ADR-10).
 *
 * `dashboard/src/plain.ts` turns one `/api/tree` payload into the card
 * board: zones (plan → active → done) → (entity, status) groups →
 * collapsible tree sections → cards. All of it is pure, so these tests
 * build fixture payloads in memory and assert the exact mapping, ordering
 * and collapse policy — no DOM, no server, no React (the same style as
 * `tests/dashboard-graph.test.ts` for the 2D adapter).
 *
 * The last suite is the K1 acceptance case: a synthetic 1000-leaf project
 * must open within the visible-card budget, and the PLAN zone must claim
 * that budget first — the goal is what the user has to see.
 */
import { describe, expect, it } from "vitest";
import type { TreeResponse } from "../shared/api";
import { GOAL_STATUSES } from "../shared/goals";
import type { Goal } from "../shared/goals";
import { BUG_STATUSES } from "../shared/links";
import type { Bug } from "../shared/links";
import { LEAF_STATUSES } from "../shared/tree";
import type { Node as TreeNode } from "../shared/tree";
import type { Growth, GrowthStep, GrowthStepState } from "../shared/growth";
import { buildGraph } from "../dashboard/src/graph";
import {
  buildPlainBoard,
  defaultPlainCollapse,
  EMPTY_PLAIN_BOARD,
  PLAIN_VISIBLE_BUDGET,
  PLAIN_ZONE_GLYPHS,
  PLAIN_ZONE_LABELS,
  PLAIN_ZONES,
  plainReveal,
  plainVisibleCardCount,
  togglePlainSection,
  zoneForBug,
  zoneForGoal,
  zoneForLeaf,
  type PlainBoard,
  type PlainCard,
  type PlainGoalCard,
  type PlainLeafCard,
  type PlainSection,
} from "../dashboard/src/plain";

const P = "/tmp/luck-planner-k1";
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
    plan: [
      { id: "s1", title: "step", description: "" },
      { id: "s2", title: "step two", description: "" },
    ],
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

function mkbug(
  id: string,
  status: Bug["status"],
  severity: Bug["severity"] = "medium",
  extra: Partial<Bug> = {},
): Bug {
  return {
    id,
    projectKey: P,
    title: `Bug ${id}`,
    description: "",
    severity,
    status,
    revision: 1,
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

function mksteps(states: GrowthStepState[]): GrowthStep[] {
  return states.map((state, index) => ({
    id: `step-${index + 1}`,
    title: `step ${index + 1}`,
    state,
    facts: [],
    reason: "",
  }));
}

function mkgrowth(
  id: string,
  subjectId: string,
  states: GrowthStepState[],
): Growth {
  return {
    id,
    projectKey: P,
    subjectType: "node",
    subjectId,
    steps: mksteps(states),
    status: "active",
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    createdBy: "agent-1",
    updatedBy: "agent-1",
  };
}

/** root → trunk → branch → two leaves, one in progress and one done. */
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

/** The cards of one group of the board. */
function groupOf(board: PlainBoard, id: string) {
  for (const zone of board.zones) {
    for (const group of zone.groups) {
      if (group.id === id) return group;
    }
  }
  throw new Error(`no group ${id} on the board`);
}

/** Flattens every card of a group (own cards + every section's). */
function groupCards(group: ReturnType<typeof groupOf>): PlainCard[] {
  const cards: PlainCard[] = [...group.cards];
  const walk = (sections: readonly PlainSection[]): void => {
    for (const section of sections) {
      cards.push(...section.cards);
      walk(section.children);
    }
  };
  walk(group.sections);
  return cards;
}

/** Every section of a group, top-level and nested. */
function allSections(sections: readonly PlainSection[]): PlainSection[] {
  const out: PlainSection[] = [];
  const walk = (list: readonly PlainSection[]): void => {
    for (const section of list) {
      out.push(section);
      walk(section.children);
    }
  };
  walk(sections);
  return out;
}

describe("K1: the zone mapping", () => {
  it("covers every leaf, goal and bug status — no status without a zone", () => {
    const zones = new Set(PLAIN_ZONES);
    for (const status of LEAF_STATUSES) {
      expect(zones.has(zoneForLeaf(status)), `leaf ${status}`).toBe(true);
    }
    for (const status of GOAL_STATUSES) {
      expect(zones.has(zoneForGoal(status)), `goal ${status}`).toBe(true);
    }
    for (const status of BUG_STATUSES) {
      expect(zones.has(zoneForBug(status)), `bug ${status}`).toBe(true);
    }
  });

  it("places the planned work on top, the finished at the bottom", () => {
    // The acceptance rule of ADR-10, spelled out per status.
    expect(zoneForGoal("draft")).toBe("plan");
    expect(zoneForGoal("proposed")).toBe("plan");
    expect(zoneForGoal("approved")).toBe("plan");
    expect(zoneForGoal("in_progress")).toBe("active");
    expect(zoneForGoal("done")).toBe("done");
    expect(zoneForGoal("cancelled")).toBe("done");
    expect(zoneForGoal("superseded")).toBe("done");

    expect(zoneForLeaf("draft")).toBe("plan");
    expect(zoneForLeaf("ready")).toBe("plan");
    expect(zoneForLeaf("claimed")).toBe("active");
    expect(zoneForLeaf("in_progress")).toBe("active");
    expect(zoneForLeaf("blocked")).toBe("active");
    expect(zoneForLeaf("done")).toBe("done");
    expect(zoneForLeaf("cancelled")).toBe("done");
    expect(zoneForLeaf("superseded")).toBe("done");

    expect(zoneForBug("open")).toBe("active");
    expect(zoneForBug("investigating")).toBe("active");
    expect(zoneForBug("resolved")).toBe("done");
    expect(zoneForBug("cancelled")).toBe("done");
  });

  it("names and glyphs every zone", () => {
    for (const id of PLAIN_ZONES) {
      expect(PLAIN_ZONE_LABELS[id], id).toBeTruthy();
      expect(PLAIN_ZONE_GLYPHS[id], id).toBeTruthy();
    }
    expect(PLAIN_ZONES).toEqual(["plan", "active", "done"]);
  });
});

describe("buildPlainBoard: zones and groups", () => {
  it("returns the empty board for an empty payload", () => {
    expect(buildPlainBoard(mktree([]))).toEqual(EMPTY_PLAIN_BOARD);
  });

  it("builds zones top to bottom with goals before leaves (the plan first)", () => {
    const withGoals = mktree(fixture().nodes, {
      goals: [
        mkgoal("goal-draft", "draft", null),
        mkgoal("goal-app", "approved", "branch-1"),
        mkgoal("goal-run", "in_progress", "branch-1"),
        mkgoal("goal-done", "done", null),
      ],
    });
    const board = buildPlainBoard(withGoals);
    expect(board.zones.map((zone) => zone.id)).toEqual([
      "plan",
      "active",
      "done",
    ]);

    const plan = board.zones[0];
    // Goal groups come before leaf groups — the goal is the plan the user
    // must see first (ADR-10), not one card among many facts.
    expect(plan.groups.map((group) => group.id)).toEqual([
      "goal:draft",
      "goal:approved",
    ]);
    // The approved goal sits in the plan zone with its two-step plan.
    const goalCard = plan.groups
      .flatMap((group) => group.cards)
      .find((card) => card.entityId === "goal-app") as PlainGoalCard;
    expect(goalCard).toMatchObject({
      id: "goal:goal-app",
      kind: "goal",
      name: "Goal goal-app",
      status: "approved",
      planSteps: 2,
      materializedNodeId: "branch-1",
    });

    // in_progress goal + in_progress leaf in the middle; done at the bottom.
    expect(board.zones[1].groups.map((group) => group.id)).toEqual([
      "goal:in_progress",
      "leaf:in_progress",
    ]);
    expect(board.zones[2].groups.map((group) => group.id)).toEqual([
      "goal:done",
      "leaf:done",
    ]);
    expect(plan.cardCount).toBe(2);
    expect(board.zones[1].cardCount).toBe(2);
    expect(board.zones[2].cardCount).toBe(2);
  });

  it("gives every leaf card the important facts, text status included", () => {
    const withBugs = {
      ...fixture(),
      bugs: [mkbug("bug-1", "open", "high"), mkbug("bug-2", "resolved")],
      bugAttachments: [
        { bugId: "bug-1", nodeId: "leaf-a" },
        { bugId: "bug-2", nodeId: "leaf-a" },
      ],
      bees: [
        {
          id: "bee-1",
          projectKey: P,
          sourceLeafId: "leaf-a",
          targetLeafId: "leaf-b",
          status: "active" as const,
          revision: 1,
          impact: "",
          createdAt: T0,
          updatedAt: T0,
          createdBy: null,
          updatedBy: null,
        },
      ],
    };
    const board = buildPlainBoard(withBugs);
    const card = groupCards(groupOf(board, "leaf:in_progress")).find(
      (candidate) => candidate.entityId === "leaf-a",
    ) as PlainLeafCard;

    expect(card).toMatchObject({
      id: "leaf:leaf-a",
      kind: "leaf",
      nodeKind: "leaf",
      name: "retry failed charges",
      status: "in_progress",
      revision: 7,
      version: "2.1.0",
      // Breadcrumb of ancestor names, root first.
      path: "Tech stack › Platform › billing",
      // Only the open incident counts — resolved ones are done (same
      // definition `openBugIdsByNode` and the 2D badge use).
      openBugCount: 1,
      beeCount: 1,
    });
  });

  it("gives incident cards severity and attachment counts", () => {
    const withBugs = mktree(fixture().nodes, {
      bugs: [
        mkbug("bug-low", "open", "low"),
        mkbug("bug-crit", "investigating", "critical"),
      ],
      bugAttachments: [
        { bugId: "bug-crit", nodeId: "leaf-a" },
        { bugId: "bug-crit", nodeId: "leaf-b" },
      ],
    });
    const board = buildPlainBoard(withBugs);
    const group = groupOf(board, "bug:investigating");
    expect(group.cards).toHaveLength(1);
    expect(group.cards[0]).toMatchObject({
      id: "bug:bug-crit",
      kind: "bug",
      name: "Bug bug-crit",
      status: "investigating",
      severity: "critical",
      attachmentCount: 2,
    });
    // Severity ranks the open group: the loudest incident lists first.
    const open = groupOf(board, "bug:open");
    expect(open.cards[0].entityId).toBe("bug-low");
  });

  it("keeps goal and bug cards out of the node filters", () => {
    // Goals and bugs are entities of their own: the toolbar filters speak
    // leaf statuses and kinds, so they must not narrow these cards.
    const payload = mktree(fixture().nodes, {
      goals: [mkgoal("goal-1", "approved", null)],
      bugs: [mkbug("bug-1", "open")],
      bugAttachments: [{ bugId: "bug-1", nodeId: "leaf-a" }],
    });
    const board = buildPlainBoard(payload, { filter: { status: "done" } });
    expect(board.index.has("goal-1")).toBe(true);
    expect(board.index.has("bug-1")).toBe(true);
    // …and the leaves follow the filter (only the done one survives).
    const leaves = [...board.index.values()].filter((entry) => entry.kind === "leaf");
    expect(leaves.map((entry) => entry.cardId)).toEqual(["leaf:leaf-b"]);
  });
});

describe("buildPlainBoard: filters, parity and determinism", () => {
  it("shows exactly the leaves the 2D adapter keeps for the same filter", () => {
    const payload = mktree(fixture().nodes, {
      goals: [mkgoal("goal-1", "approved", null)],
    });
    for (const filter of [
      undefined,
      { kind: "leaf" as const },
      { status: "in_progress" as const },
      { version: "2.1" },
      { status: "superseded" as const },
    ]) {
      const board = buildPlainBoard(payload, { filter });
      const graph = buildGraph(payload, { filter });
      const boardLeaves = [...board.index.values()]
        .filter((entry) => entry.kind === "leaf")
        .map((entry) => entry.cardId)
        .sort();
      const graphLeaves = graph.nodes
        .filter((node) => node.type === "leaf")
        .map((node) => `leaf:${node.id}`)
        .sort();
      expect(boardLeaves, JSON.stringify(filter)).toEqual(graphLeaves);
    }
  });

  it("numbers growth and open bugs exactly like the 2D adapter", () => {
    const payload = mktree(fixture().nodes, {
      growth: [
        mkgrowth("growth-a", "leaf-a", ["completed", "completed"]),
        mkgrowth("growth-b", "branch-1", ["completed", "pending"]),
      ],
      bugs: [mkbug("bug-1", "open", "high")],
      bugAttachments: [{ bugId: "bug-1", nodeId: "leaf-a" }],
    });
    const board = buildPlainBoard(payload);
    const graph = buildGraph(payload, { layer: "growth" });
    const card = groupCards(groupOf(board, "leaf:in_progress")).find(
      (candidate) => candidate.entityId === "leaf-a",
    ) as PlainLeafCard;
    const node = graph.nodes.find((candidate) => candidate.id === "leaf-a")!;

    // The mini growth bar and the 2D heat read the very same roll-up:
    // a leaf's roll-up is its own record (the branch record rolls *up* to
    // the branch, not down to its children).
    expect(card.growth).toEqual(node.data.growth);
    expect(card.growth).toMatchObject({ total: 2, completed: 2, ratio: 1 });
    expect(card.openBugCount).toBe(node.data.openBugCount);
  });

  it("is deterministic: a shuffled payload yields the same board", () => {
    const payload = mktree(fixture().nodes, {
      goals: [mkgoal("goal-b", "proposed", null), mkgoal("goal-a", "draft", null)],
      bugs: [mkbug("bug-b", "open", "low"), mkbug("bug-a", "open", "critical")],
      bugAttachments: [
        { bugId: "bug-b", nodeId: "leaf-a" },
        { bugId: "bug-a", nodeId: "leaf-b" },
      ],
    });
    const shuffled: TreeResponse = {
      ...payload,
      nodes: [...payload.nodes].reverse(),
      goals: [...payload.goals].reverse(),
      bugs: [...payload.bugs].reverse(),
    };
    expect(buildPlainBoard(shuffled)).toEqual(buildPlainBoard(payload));

    // Goal order: lifecycle status, then id. Bug order: severity, then id.
    const board = buildPlainBoard(payload);
    expect(groupOf(board, "goal:draft").cards.map((card) => card.entityId)).toEqual([
      "goal-a",
    ]);
    expect(groupOf(board, "goal:proposed").cards.map((card) => card.entityId)).toEqual([
      "goal-b",
    ]);
    expect(groupOf(board, "bug:open").cards.map((card) => card.entityId)).toEqual([
      "bug-a", // critical before low
      "bug-b",
    ]);
  });
});

describe("buildPlainBoard: sections", () => {
  it("hangs the leaf cards under the branch hierarchy, nested by depth", () => {
    const board = buildPlainBoard(fixture());
    const group = groupOf(board, "leaf:in_progress");
    // Every internal ancestor of the leaf qualifies as a section: the leaf
    // hangs at its own parent, the chain above is the nesting.
    expect(group.sections).toHaveLength(1);
    expect(group.sections[0]).toMatchObject({
      key: "leaf:in_progress::root-1",
      nodeId: "root-1",
      name: "Tech stack",
      depth: 0,
      cards: [],
    });
    const trunk = group.sections[0].children[0];
    expect(trunk).toMatchObject({
      key: "leaf:in_progress::trunk-1",
      name: "Platform",
      depth: 1,
      cards: [],
    });
    const branch = trunk.children[0];
    // The deepest section is the leaf's own parent — and it holds the card.
    expect(branch).toMatchObject({
      key: "leaf:in_progress::branch-1",
      name: "billing",
      depth: 2,
      children: [],
    });
    expect(branch.cards.map((card) => card.entityId)).toEqual(["leaf-a"]);
    expect(group.cards).toEqual([]);
  });

  it("keeps an orphan leaf as a group-level card (no phantom section)", () => {
    const orphan = mktree([
      mknode("lost-1", "ghost", "leaf", "lost leaf", { status: "ready" }),
    ]);
    const group = groupOf(buildPlainBoard(orphan), "leaf:ready");
    expect(group.sections).toEqual([]);
    expect(group.cards.map((card) => card.entityId)).toEqual(["lost-1"]);
  });

  it("indexes each card with the section chain down to it", () => {
    const board = buildPlainBoard(fixture());
    const entry = board.index.get("leaf-a")!;
    expect(entry).toMatchObject({
      cardId: "leaf:leaf-a",
      kind: "leaf",
      zoneId: "active",
      groupId: "leaf:in_progress",
    });
    expect(entry.sectionKeys).toEqual([
      "leaf:in_progress::root-1",
      "leaf:in_progress::trunk-1",
      "leaf:in_progress::branch-1",
    ]);
    // A goal card needs no section: its group is always visible.
    const goals = buildPlainBoard(
      mktree(fixture().nodes, { goals: [mkgoal("goal-1", "draft", null)] }),
    );
    expect(goals.index.get("goal-1")!.sectionKeys).toEqual([]);
  });
});

describe("collapse: defaults, toggle and reveal", () => {
  it("leaves a small tree fully expanded", () => {
    const board = buildPlainBoard(fixture());
    expect(defaultPlainCollapse(board)).toEqual(new Set());
    expect(plainVisibleCardCount(board, new Set())).toBe(board.index.size);
  });

  it("toggles a section without mutating the input set", () => {
    const original: ReadonlySet<string> = new Set(["a"]);
    const next = togglePlainSection(original, "b");
    expect([...next].sort()).toEqual(["a", "b"]);
    expect([...original]).toEqual(["a"]);
    expect([...togglePlainSection(next, "a")]).toEqual(["b"]);
  });

  it("opens the sections a found card hides (the search reveal)", () => {
    const board = buildPlainBoard(fixture());
    const reveal = plainReveal(board, "leaf-a");
    expect(reveal.cardId).toBe("leaf:leaf-a");
    // Every ancestor section is included: collapsing them all hides the
    // card (the done leaf of the other group stays visible).
    const collapsed = new Set(reveal.sectionKeys);
    expect(plainVisibleCardCount(board, collapsed)).toBe(1);
    let opened = collapsed;
    for (const key of reveal.sectionKeys) opened = togglePlainSection(opened, key);
    expect(plainVisibleCardCount(board, opened)).toBe(board.index.size);
  });

  it("reveals goal cards without touching any section", () => {
    const board = buildPlainBoard(
      mktree(fixture().nodes, { goals: [mkgoal("goal-1", "draft", null)] }),
    );
    expect(plainReveal(board, "goal-1")).toEqual({ sectionKeys: [], cardId: "goal:goal-1" });
    expect(plainReveal(board, "nope")).toEqual({ sectionKeys: [], cardId: null });
  });
});

describe("K1 acceptance: a 1000-leaf project", () => {
  function synthetic(): TreeResponse {
    const nodes: TreeNode[] = [mknode("root-1", null, "root", "Tech stack")];
    for (let t = 0; t < 4; t += 1) {
      const trunkId = `trunk-${t}`;
      nodes.push(mknode(trunkId, "root-1", "trunk", `platform ${t}`));
      for (let b = 0; b < 10; b += 1) {
        const branchId = `${trunkId}-branch-${b}`;
        nodes.push(mknode(branchId, trunkId, "branch", `module ${t}.${b}`));
        for (let l = 0; l < 25; l += 1) {
          nodes.push(
            mknode(`${branchId}-leaf-${l}`, branchId, "leaf", `fact ${t}.${b}.${l}`, {
              // Every third leaf is planned (the plan zone must have weight).
              status: l % 3 === 0 ? "ready" : "in_progress",
            }),
          );
        }
      }
    }
    return mktree(nodes);
  }

  it("opens within the visible-card budget, PLAN claiming it first", () => {
    const board = buildPlainBoard(synthetic());
    expect(board.index.size).toBe(1000);

    const collapsed = defaultPlainCollapse(board);
    const visible = plainVisibleCardCount(board, collapsed);
    expect(visible).toBeLessThanOrEqual(PLAIN_VISIBLE_BUDGET);
    expect(visible).toBeGreaterThan(0);

    // The PLAN zone claims the budget first: its root and trunk sections
    // stay open and some of its card-bearing sections survived …
    const planGroup = board.zones[0].groups.find(
      (group) => group.id === "leaf:ready",
    )!;
    expect(planGroup).toBeDefined();
    expect(collapsed.has(planGroup.sections[0].key)).toBe(false);
    for (const trunk of planGroup.sections[0].children) {
      expect(collapsed.has(trunk.key), `trunk ${trunk.name}`).toBe(false);
    }
    const openPlanCards = allSections(planGroup.sections)
      .filter((section) => !collapsed.has(section.key))
      .reduce((sum, section) => sum + section.cards.length, 0);
    expect(openPlanCards).toBeGreaterThan(0);

    // …and by then the budget is spent: every card-bearing section of the
    // middle zone starts collapsed (zero-card ancestors still open — they
    // cost nothing and keep the skeleton readable).
    const activeGroup = board.zones[1].groups.find(
      (group) => group.id === "leaf:in_progress",
    )!;
    const activeCardSections = allSections(activeGroup.sections).filter(
      (section) => section.cards.length > 0,
    );
    expect(activeCardSections.length).toBeGreaterThan(0);
    expect(
      activeCardSections.every((section) => collapsed.has(section.key)),
      "the middle zone's tree starts collapsed under a small budget",
    ).toBe(true);
  }, 30000);

  it("builds the whole board well under interactive latency", () => {
    const payload = synthetic();
    const started = Date.now();
    for (let i = 0; i < 5; i += 1) buildPlainBoard(payload);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
