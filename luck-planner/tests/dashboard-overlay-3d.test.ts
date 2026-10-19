/**
 * The pure 3D overlay (PLAN.md stage I3): bee arcs, blocking-incident markers,
 * goal rings, growth halos — and the per-frame animation math the scene runs.
 *
 * The acceptance of this stage has two halves, and they are asserted here:
 * 1. **Each link type is distinguishable** — four projections of the payload,
 *    each with its own shape, its own source rows and its own tooltip text:
 *    a bee is a curved arc between two leaves carrying its status and
 *    revision, a bug is a marker above every leaf it blocks, a goal is a ring
 *    over the subtree it materialized, growth is a halo whose heat *is* the
 *    roll-up ratio the 2D heat layer paints. The cross-checks against
 *    `buildGraph` are deliberate: the two views must never disagree about a
 *    number, so the test compares them instead of trusting both.
 * 2. **Animation does not degrade FPS at 1000 nodes** — the frame cost is
 *    O(bees + bugs) plus one uniform, *not* O(nodes): the scene positions
 *    everything large once and re-uses those matrices. The budget test builds
 *    a 10k-node payload with growth data and measures 60 frames of the pure
 *    animation math, plus a source contract that the scene never walks the
 *    node list.
 *
 * Fixtures come from a real `LuckPlannerStore` (the repo's no-mocks rule):
 * the payload is the very `buildTreeResponse` output `/api/tree` serves, so
 * the bee/bug/goal/growth rows are the store's own, not a hand-written shape
 * that can drift. Hand-crafted payloads appear only where the store refuses
 * to produce the input (a bee to a leaf that left the payload, a goal that
 * never materialized) — the defensive cases, marked as such.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTreeResponse } from "../server/http-server";
import { LuckPlannerStore } from "../server/store";
import type { TreeResponse } from "../shared/api";
import type { Node as TreeNode } from "../shared/tree";
import { buildGraph } from "../dashboard/src/graph";
import {
  beeArcPoint,
  beeProgress,
  beeTipText,
  bugPulseScale,
  bugTipText,
  buildSceneOverlay,
  EMPTY_OVERLAY,
  goalTipText,
  growthGlow,
  haloScale,
  hashUnit,
  OVERLAY_3D,
  truncate,
  type Scene3DOverlay,
} from "../dashboard/src/overlay-3d";
import { buildScene3D } from "../dashboard/src/tree-3d";

const P = "/projects/overlay3d";
const ACTOR = "agent:coder";

let dir = "";
let store: LuckPlannerStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "luck-planner-overlay3d-"));
  store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The fixture project — every link domain in one tree:
 *
 *   Tech stack
 *   ├─ platform → api (2 leaves)      · growth 2/3 on the branch
 *   │             └ storage (1 leaf)
 *   └─ product  → billing (2 leaves)
 *                 └ [goal] Make refunds idempotent (2 draft leaves)
 *
 * Links: two bees on the *same* leaf pair (opposite directions, so the lane
 * rule is exercised), one bee on another pair, one open incident blocking two
 * leaves, one resolved incident (must stay invisible), one materialized goal
 * with its own growth record.
 */
interface Fixture {
  readonly response: TreeResponse;
  readonly ids: {
    root: string;
    platform: string;
    product: string;
    api: string;
    storage: string;
    billing: string;
    rateLimits: string;
    openapi: string;
    pgBackups: string;
    retry: string;
    proration: string;
    goal: string;
    goalRoot: string;
    openBug: string;
    resolvedBug: string;
  };
}

function seedFixture(target: LuckPlannerStore): Fixture {
  const node = (
    parentId: string | null,
    kind: TreeNode["kind"],
    name: string,
    status?: TreeNode["status"],
  ): TreeNode =>
    target.createNode({
      projectKey: P,
      parentId,
      kind,
      name,
      actor: ACTOR,
      ...(status === undefined ? {} : { status }),
    });

  const root = node(null, "root", "Tech stack");
  const platform = node(root.id, "trunk", "platform");
  const product = node(root.id, "trunk", "product");
  const api = node(platform.id, "branch", "api");
  const storage = node(platform.id, "branch", "storage");
  const billing = node(product.id, "branch", "billing");
  const rateLimits = node(api.id, "leaf", "rate limits", "in_progress");
  const openapi = node(api.id, "leaf", "openapi spec", "done");
  const pgBackups = node(storage.id, "leaf", "pg backups", "blocked");
  const retry = node(billing.id, "leaf", "retry failed charges", "ready");
  const proration = node(billing.id, "leaf", "proration", "draft");

  // Two bees on the same pair (A→B and B→A) plus one on another pair.
  target.createBee({
    projectKey: P,
    sourceLeafId: rateLimits.id,
    targetLeafId: retry.id,
    status: "active",
    impact: "depends on",
    actor: ACTOR,
  });
  target.createBee({
    projectKey: P,
    sourceLeafId: retry.id,
    targetLeafId: rateLimits.id,
    status: "watching",
    impact: "watched by",
    actor: ACTOR,
  });
  target.createBee({
    projectKey: P,
    sourceLeafId: pgBackups.id,
    targetLeafId: openapi.id,
    status: "active",
    impact: "shares storage",
    actor: ACTOR,
  });

  // One blocking incident on two leaves, one resolved incident (invisible).
  const openBug = target.createBug({
    projectKey: P,
    title: "charge retries loop",
    severity: "high",
    nodeIds: [retry.id, proration.id],
    actor: ACTOR,
  });
  const resolvedBug = target.createBug({
    projectKey: P,
    title: "disk full on replica",
    severity: "critical",
    status: "resolved",
    nodeIds: [pgBackups.id],
    actor: ACTOR,
  });

  // A goal that crossed the approval gate and grew its side branch.
  const goal = target.createGoal({
    projectKey: P,
    formalText: "Make refunds idempotent",
    plan: [
      { id: "s1", title: "draft idempotency key", description: "" },
      { id: "s2", title: "migrate refund rows", description: "" },
    ],
    actor: ACTOR,
  });
  target.setGoalStatus({ projectKey: P, id: goal.id, status: "proposed", actor: ACTOR });
  const materialized = target.approveGoal({
    projectKey: P,
    id: goal.id,
    parentBranchId: billing.id,
    actor: ACTOR,
  });
  const goalRoot = materialized.materializedNodeId!;

  // Growth: 2/3 on the api branch (rolls up to platform and the root), 1/2 on
  // the goal (rolls into the node the goal materialized).
  target.createGrowth({
    projectKey: P,
    subjectType: "node",
    subjectId: api.id,
    steps: [
      { id: "g1", title: "split the handler", state: "completed", facts: [], reason: "" },
      { id: "g2", title: "add the retry", state: "completed", facts: [], reason: "" },
      { id: "g3", title: "cover the edge", state: "in_progress", facts: [], reason: "" },
    ],
    actor: ACTOR,
  });
  target.createGrowth({
    projectKey: P,
    subjectType: "goal",
    subjectId: goal.id,
    steps: [
      { id: "p1", title: "key", state: "completed", facts: [], reason: "" },
      { id: "p2", title: "migrate", state: "pending", facts: [], reason: "" },
    ],
    actor: ACTOR,
  });

  return {
    response: buildTreeResponse(target, P),
    ids: {
      root: root.id,
      platform: platform.id,
      product: product.id,
      api: api.id,
      storage: storage.id,
      billing: billing.id,
      rateLimits: rateLimits.id,
      openapi: openapi.id,
      pgBackups: pgBackups.id,
      retry: retry.id,
      proration: proration.id,
      goal: goal.id,
      goalRoot,
      openBug: openBug.id,
      resolvedBug: resolvedBug.id,
    },
  };
}

/** The I2 layout + the I3 overlay of a payload, as `app.tsx` builds them. */
function sceneOf(
  response: TreeResponse,
  layer: "status" | "growth" = "status",
): { overlay: Scene3DOverlay; positions: Map<string, readonly [number, number, number]> } {
  const model = buildScene3D(response.nodes);
  return {
    overlay: buildSceneOverlay(response, model, { layer }),
    positions: new Map(model.nodes.map((node) => [node.id, node.position])),
  };
}

/**
 * A hand-crafted `/api/tree` payload for the shapes the store refuses to
 * produce — a link to a leaf that left the payload, a goal that never
 * materialized. Marked as defensive: this is exactly the partially-pruned
 * response a filtered server could serve.
 */
function handcrafted(rest: Partial<TreeResponse>): TreeResponse {
  return {
    projectKey: P,
    generatedAt: 0,
    nodes: [],
    bees: [],
    bugs: [],
    bugAttachments: [],
    goals: [],
    growth: [],
    ...rest,
  };
}

function fixtureNode(input: {
  id: string;
  kind: TreeNode["kind"];
  name: string;
  parentId?: string | null;
}): TreeNode {
  return {
    id: input.id,
    projectKey: P,
    parentId: input.parentId ?? null,
    kind: input.kind,
    name: input.name,
    description: "",
    status: "draft",
    version: "1.0",
    revision: 1,
    payload: {},
    createdAt: 0,
    updatedAt: 0,
    createdBy: null,
    updatedBy: null,
    archivedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Bees
// ---------------------------------------------------------------------------

describe("bee arcs", () => {
  it("connects the two leaves it links, with a control point above the chord", () => {
    const { response } = seedFixture(store);
    const { overlay, positions } = sceneOf(response);

    expect(overlay.bees).toHaveLength(3);
    for (const bee of overlay.bees) {
      const row = response.bees.find((candidate) => candidate.id === bee.id)!;
      // Endpoints are the layout positions of the leaves, not copies.
      expect(bee.from).toEqual(positions.get(row.sourceLeafId));
      expect(bee.to).toEqual(positions.get(row.targetLeafId));
      // The arc bows *up*: the apex is above the chord's midpoint.
      expect(bee.control[1]).toBeGreaterThan((bee.from[1] + bee.to[1]) / 2);
    }
  });

  it("carries status, revision and impact for the tooltip", () => {
    const { response } = seedFixture(store);
    const { overlay } = sceneOf(response);
    const active = overlay.bees.find((bee) => bee.impact === "depends on")!;
    expect(active.status).toBe("active");
    expect(active.revision).toBe(1);
    expect(active.impact).toBe("depends on");
    expect(beeTipText(active)).toContain("active");
    expect(beeTipText(active)).toContain("r1");
    expect(beeTipText(active)).toContain("depends on");
    // The second bee of the pair is the watching one, and its text says so.
    const watching = overlay.bees.find((bee) => bee.status === "watching")!;
    expect(beeTipText(watching)).toContain("watching");
  });

  it("gives bees that share a leaf pair separate lanes", () => {
    const { response } = seedFixture(store);
    const { overlay } = sceneOf(response);
    // A→B and B→A are the same pair: one canonical key, two lanes, so their
    // arcs leave the leaves at the same two points but fly a lane step apart.
    const forward = overlay.bees.find((bee) => bee.impact === "depends on")!;
    const reverse = overlay.bees.find((bee) => bee.impact === "watched by")!;
    expect(forward.from).toEqual(reverse.to);
    expect(forward.to).toEqual(reverse.from);
    // Both ends are leaves (y = 0), so the lift difference is the lane itself.
    expect(Math.abs(forward.control[1] - reverse.control[1])).toBeCloseTo(
      OVERLAY_3D.beeLaneSpacing,
      9,
    );
  });

  it("drops a bee whose leaf is not in the layout", () => {
    // Defensive: a bee pointing at a leaf that has left the payload must not
    // be drawn at the origin — the overlay describes what is on screen.
    const response = handcrafted({
      nodes: [
        fixtureNode({ id: "leaf-1", kind: "leaf", name: "only leaf" }),
      ],
      bees: [
        {
          id: "bee-ghost",
          projectKey: P,
          sourceLeafId: "leaf-1",
          targetLeafId: "leaf-gone",
          status: "active",
          revision: 1,
          impact: "",
          createdAt: 0,
          updatedAt: 0,
          createdBy: null,
          updatedBy: null,
        },
      ],
    });
    expect(sceneOf(response).overlay.bees).toEqual([]);
  });
});

describe("bee animation math", () => {
  it("cycles the arc fraction in [0, 1) and starts from the bee's own phase", () => {
    const { response } = seedFixture(store);
    const bee = sceneOf(response).overlay.bees[0]!;
    expect(bee.phase).toBeGreaterThanOrEqual(0);
    expect(bee.phase).toBeLessThan(1);
    // t = 0 → the phase itself: two bees are not in lockstep.
    expect(beeProgress(bee, 0)).toBeCloseTo(bee.phase, 9);
    for (const t of [0, 0.5, 3, 17.25, 1000]) {
      const u = beeProgress(bee, t);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
    // Deterministic: the same time always answers the same fraction.
    expect(beeProgress(bee, 7.5)).toBe(beeProgress(bee, 7.5));
    // …and a full cycle later it is where it was.
    const cycle = 1 / OVERLAY_3D.beeSpeed;
    expect(beeProgress(bee, 4 + cycle)).toBeCloseTo(beeProgress(bee, 4), 9);
  });

  it("leaves the source at u=0, reaches the target at u=1 and arcs above both", () => {
    const { response } = seedFixture(store);
    const bee = sceneOf(response).overlay.bees[0]!;
    const start = beeArcPoint(bee, 0, { x: 0, y: 0, z: 0 });
    expect([start.x, start.y, start.z]).toEqual([...bee.from]);
    const end = beeArcPoint(bee, 1, { x: 0, y: 0, z: 0 });
    expect([end.x, end.y, end.z]).toEqual([...bee.to]);
    const middle = beeArcPoint(bee, 0.5, { x: 0, y: 0, z: 0 });
    expect(middle.y).toBeGreaterThan(Math.max(bee.from[1], bee.to[1]));
  });

  it("writes into the out-vector without allocating a new one", () => {
    const { response } = seedFixture(store);
    const bee = sceneOf(response).overlay.bees[0]!;
    const out = { x: 1, y: 2, z: 3 };
    const returned = beeArcPoint(bee, 0.25, out);
    expect(returned).toBe(out);
  });
});

// ---------------------------------------------------------------------------
// Bugs
// ---------------------------------------------------------------------------

describe("blocking-incident markers", () => {
  it("marks every leaf a blocking incident is attached to, and no resolved one", () => {
    const { response, ids } = seedFixture(store);
    const { overlay, positions } = sceneOf(response);

    // One open incident on two leaves; the resolved one stays invisible.
    expect(overlay.bugs).toHaveLength(2);
    expect(overlay.bugs.every((bug) => bug.id === ids.openBug)).toBe(true);
    expect(overlay.bugs.map((bug) => bug.nodeId).sort()).toEqual(
      [ids.proration, ids.retry].sort(),
    );
    for (const marker of overlay.bugs) {
      const at = positions.get(marker.nodeId)!;
      expect(marker.position).toEqual([at[0], at[1] + OVERLAY_3D.bugLift, at[2]]);
      expect(marker.severity).toBe("high");
      expect(marker.status).toBe("open");
      expect(bugTipText(marker)).toContain("charge retries loop");
      expect(bugTipText(marker)).toContain("high");
    }
    // The same incident pulses in phase wherever it is attached — and not in
    // phase with a different incident.
    expect(overlay.bugs[0]!.phase).toBe(overlay.bugs[1]!.phase);
  });

  it("pulses within its amplitude window and repeats every period", () => {
    const { response } = seedFixture(store);
    const marker = sceneOf(response).overlay.bugs[0]!;
    for (const t of [0, 0.3, 1.1, 5, 42.7]) {
      const scale = bugPulseScale(marker, t);
      expect(scale).toBeGreaterThanOrEqual(1 - OVERLAY_3D.bugPulse - 1e-9);
      expect(scale).toBeLessThanOrEqual(1 + OVERLAY_3D.bugPulse + 1e-9);
    }
    expect(bugPulseScale(marker, 2.4)).toBeCloseTo(
      bugPulseScale(marker, 2.4 + OVERLAY_3D.bugPeriod),
      9,
    );
  });

  it("ignores an incident attached to a node outside the layout", () => {
    // Defensive: a hand-edited attachment to a node that is not in the payload.
    const response = handcrafted({
      nodes: [fixtureNode({ id: "leaf-1", kind: "leaf", name: "leaf" })],
      bugs: [
        {
          id: "bug-1",
          projectKey: P,
          title: "gone",
          description: "",
          severity: "low",
          status: "open",
          revision: 1,
          createdAt: 0,
          updatedAt: 0,
          createdBy: null,
          updatedBy: null,
        },
      ],
      bugAttachments: [{ bugId: "bug-1", nodeId: "leaf-gone" }],
    });
    expect(sceneOf(response).overlay.bugs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

describe("goal rings", () => {
  it("floats one ring over the subtree the goal materialized", () => {
    const { response, ids } = seedFixture(store);
    const { overlay, positions } = sceneOf(response);

    expect(overlay.goals).toHaveLength(1);
    const ring = overlay.goals[0]!;
    expect(ring.id).toBe(ids.goal);
    expect(ring.status).toBe("approved");
    expect(ring.name).toBe("Make refunds idempotent");
    // The materialized side branch plus its two step leaves.
    expect(ring.nodeCount).toBe(3);
    expect(ring.radius).toBeGreaterThanOrEqual(OVERLAY_3D.goalMinRadius);

    // Above the highest node of its own subtree, not of the project.
    const subtree = positions.get(ids.goalRoot)!;
    expect(ring.center[1]).toBeGreaterThan(subtree[1]);
    const others = [...positions.entries()]
      .filter(([id]) => id === ids.rateLimits || id === ids.retry)
      .map(([, position]) => position[1]);
    expect(ring.center[1]).toBeGreaterThan(Math.max(...others));
  });

  it("reports the same growth as the 2D goal frame", () => {
    const { response } = seedFixture(store);
    const { overlay } = sceneOf(response);
    const ring = overlay.goals[0]!;
    // The goal's own record (1 of 2 steps) rolls into the node it materialized.
    expect(ring.growth?.records).toBe(1);
    expect(ring.growth?.completed).toBe(1);
    expect(ring.growth?.total).toBe(2);

    const graph = buildGraph(response);
    const frame = graph.goalFrames.find((item) => item.data.goalId === ring.id)!;
    expect(frame.data.growth?.ratio).toBe(ring.growth?.ratio);
    expect(frame.data.nodeCount).toBe(ring.nodeCount);
    expect(goalTipText(ring)).toContain("approved");
    expect(goalTipText(ring)).toContain("1/2 steps");
    expect(goalTipText(ring)).toContain("Make refunds idempotent");
  });

  it("draws nothing for a goal that never materialized", () => {
    // A draft goal is not part of the tree at all (ADR-7).
    const goal = {
      id: "goal-draft",
      projectKey: P,
      formalText: "Never approved",
      plan: [],
      status: "draft" as const,
      revision: 1,
      materializedNodeId: null,
      createdAt: 0,
      updatedAt: 0,
      createdBy: null,
      updatedBy: null,
    };
    const response = handcrafted({
      nodes: [fixtureNode({ id: "root-1", kind: "root", name: "Tech stack" })],
      goals: [goal],
    });
    expect(sceneOf(response).overlay.goals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

describe("growth halos", () => {
  it("stays out of the view in the status layer", () => {
    const { response } = seedFixture(store);
    expect(sceneOf(response, "status").overlay.growth).toEqual([]);
  });

  it("heats exactly the nodes the 2D growth layer heats, with the same ratios", () => {
    const { response, ids } = seedFixture(store);
    const { overlay, positions } = sceneOf(response, "growth");
    expect(overlay.growth.length).toBeGreaterThan(0);

    // One rule, two views: every halo ratio equals the heat of the same node
    // in the 2D adapter, and the node sets match exactly.
    const graph = buildGraph(response, { layer: "growth" });
    const heat2d = new Map(
      graph.nodes
        .filter((node) => node.data.heat !== null)
        .map((node) => [node.id, node.data.heat!]),
    );
    expect(new Set(overlay.growth.map((halo) => halo.nodeId))).toEqual(
      new Set(heat2d.keys()),
    );
    for (const halo of overlay.growth) {
      expect(halo.heat).toBeCloseTo(heat2d.get(halo.nodeId)!, 9);
      expect(halo.position).toEqual(positions.get(halo.nodeId));
      expect(halo.heat).toBeGreaterThanOrEqual(0);
      expect(halo.heat).toBeLessThanOrEqual(1);
    }

    // The api branch carries its own 2/3 record; the goal's 1/2 rolls into the
    // node it materialized; a leaf with neither stays dark.
    const byNode = new Map(overlay.growth.map((halo) => [halo.nodeId, halo]));
    expect(byNode.get(ids.api)!.heat).toBeCloseTo(2 / 3, 9);
    expect(byNode.get(ids.api)!.completed).toBe(2);
    expect(byNode.get(ids.api)!.total).toBe(3);
    expect(byNode.get(ids.goalRoot)!.heat).toBeCloseTo(0.5, 9);
    expect(byNode.has(ids.proration)).toBe(false);
    // The parent of api rolls its child's steps up (2D does the same).
    expect(byNode.get(ids.platform)!.heat).toBeCloseTo(2 / 3, 9);
  });

  it("scales the halo with the ratio and clamps out-of-range heat", () => {
    expect(haloScale(0)).toBe(OVERLAY_3D.haloMinScale);
    expect(haloScale(1)).toBeCloseTo(
      OVERLAY_3D.haloMinScale + OVERLAY_3D.haloScaleSpan,
      9,
    );
    expect(haloScale(0.5)).toBeCloseTo(
      OVERLAY_3D.haloMinScale + OVERLAY_3D.haloScaleSpan / 2,
      9,
    );
    expect(haloScale(-3)).toBe(OVERLAY_3D.haloMinScale);
    expect(haloScale(9)).toBeCloseTo(
      OVERLAY_3D.haloMinScale + OVERLAY_3D.haloScaleSpan,
      9,
    );
    expect(haloScale(Number.NaN)).toBe(OVERLAY_3D.haloMinScale);
  });

  it("breathes the whole layer with one value, inside its window", () => {
    const values = [0, 0.4, 1.2, 3, 12.5].map(growthGlow);
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
    expect(growthGlow(1)).not.toBe(growthGlow(2));
    expect(growthGlow(0.5)).toBeCloseTo(growthGlow(0.5 + OVERLAY_3D.glowPeriod), 9);
  });
});

// ---------------------------------------------------------------------------
// Determinism, degenerate payloads, tooltip text
// ---------------------------------------------------------------------------

describe("determinism and degenerate payloads", () => {
  it("is a pure function of the payload — two builds are identical", () => {
    const { response } = seedFixture(store);
    const model = buildScene3D(response.nodes);
    const first = buildSceneOverlay(response, model, { layer: "growth" });
    const second = buildSceneOverlay(response, model, { layer: "growth" });
    expect(first).toEqual(second);
    // Phases come from the ids, never from `Math.random()`.
    expect(first.bees.map((bee) => bee.phase)).toEqual(
      second.bees.map((bee) => bee.phase),
    );
  });

  it("answers an empty project with an empty overlay", () => {
    const response = handcrafted({});
    expect(sceneOf(response, "growth").overlay).toEqual(EMPTY_OVERLAY);
  });

  it("hashes ids deterministically into [0, 1)", () => {
    for (const id of ["a", "leaf-1", "goal-9f2", "🐝", ""]) {
      const value = hashUnit(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(hashUnit(id)).toBe(value);
    }
    expect(hashUnit("bee-1")).not.toBe(hashUnit("bee-2"));
  });

  it("truncates long tooltip names instead of overflowing", () => {
    expect(truncate("  short  ")).toBe("short");
    const long = "x".repeat(200);
    const shortened = truncate(long, 20);
    expect(shortened).toHaveLength(20);
    expect(shortened.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The I3 frame budget: animation is O(links), not O(nodes)
// ---------------------------------------------------------------------------

/** Synthetic payload: a 5-kind forest of `total` nodes, breadth-first. */
function syntheticPayload(total: number): TreeResponse {
  const kinds: TreeNode["kind"][] = ["root", "trunk", "branch", "subbranch", "leaf"];
  const nodes: TreeNode[] = [];
  const ids: string[] = [];
  const push = (id: string, parentId: string | null, kind: TreeNode["kind"]): void => {
    nodes.push({
      id,
      projectKey: P,
      parentId,
      kind,
      name: `node-${id}`,
      description: "",
      status: "draft",
      version: "1.0",
      revision: 1,
      payload: {},
      createdAt: 0,
      updatedAt: 0,
      createdBy: null,
      updatedBy: null,
      archivedAt: null,
    });
    ids.push(id);
  };
  push("n0", null, "root");
  let cursor = 1;
  let parents = ["n0"];
  let level = 1;
  while (cursor < total) {
    const next: string[] = [];
    for (const parentId of parents) {
      for (let sibling = 0; sibling < 10 && cursor < total; sibling += 1) {
        const id = `n${cursor}`;
        push(id, parentId, level >= 4 ? "leaf" : kinds[level]!);
        next.push(id);
        cursor += 1;
      }
    }
    parents = next;
    level += 1;
  }

  const leaves = nodes.filter((node) => node.kind === "leaf").map((node) => node.id);
  const bees = Array.from({ length: 200 }, (_, index) => ({
    id: `bee-${index}`,
    projectKey: P,
    sourceLeafId: leaves[index % leaves.length]!,
    targetLeafId: leaves[(index * 7 + 3) % leaves.length]!,
    status: "active" as const,
    revision: 1,
    impact: "depends on",
    createdAt: 0,
    updatedAt: 0,
    createdBy: null,
    updatedBy: null,
  })).filter((bee) => bee.sourceLeafId !== bee.targetLeafId);
  const bugs = Array.from({ length: 50 }, (_, index) => ({
    id: `bug-${index}`,
    projectKey: P,
    title: `incident ${index}`,
    description: "",
    severity: "high" as const,
    status: "open" as const,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    createdBy: null,
    updatedBy: null,
  }));
  const bugAttachments = bugs.map((bug, index) => ({
    bugId: bug.id,
    nodeId: leaves[(index * 11) % leaves.length]!,
  }));
  // Growth on the first 1000 nodes, so the halo build is part of the budget.
  const growth = nodes.slice(0, 1000).map((node, index) => ({
    id: `growth-${index}`,
    projectKey: P,
    subjectType: "node" as const,
    subjectId: node.id,
    steps: [
      { id: "s1", title: "one", state: "completed" as const, facts: [], reason: "" },
      { id: "s2", title: "two", state: "pending" as const, facts: [], reason: "" },
    ],
    status: "active" as const,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    createdBy: null,
    updatedBy: null,
  }));

  return {
    projectKey: P,
    generatedAt: 0,
    nodes,
    bees,
    bugs,
    bugAttachments,
    goals: [],
    growth,
  };
}

describe("the I3 frame budget", () => {
  it("animates a 10k-node scene at the price of its links", () => {
    const response = syntheticPayload(10_000);
    const model = buildScene3D(response.nodes);
    expect(model.nodes).toHaveLength(10_000);

    const buildStart = performance.now();
    const overlay = buildSceneOverlay(response, model, { layer: "growth" });
    const buildElapsed = performance.now() - buildStart;
    expect(overlay.bees).toHaveLength(200);
    expect(overlay.bugs).toHaveLength(50);
    expect(overlay.growth).toHaveLength(1000);
    // Generous ceiling for CI variance; the build is O(nodes + links).
    expect(buildElapsed).toBeLessThan(500);

    // 60 frames of the *pure* animation math the scene runs per frame: one
    // arc point per bee plus one pulse per bug. The node count is not an
    // input — that is what keeps FPS flat when the tree grows.
    const point = { x: 0, y: 0, z: 0 };
    const frameStart = performance.now();
    let sink = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      const t = frame / 60;
      for (const bee of overlay.bees) {
        beeArcPoint(bee, beeProgress(bee, t), point);
        sink += point.x + point.y + point.z;
      }
      for (const bug of overlay.bugs) {
        sink += bugPulseScale(bug, t);
      }
      sink += growthGlow(t);
    }
    const frameElapsed = performance.now() - frameStart;
    expect(Number.isFinite(sink)).toBe(true);
    // 60 frames of 250 links: comfortably under a second even on slow CI,
    // and three orders of magnitude below the I2 layout budget.
    expect(frameElapsed).toBeLessThan(300);
  }, 30_000);
});
