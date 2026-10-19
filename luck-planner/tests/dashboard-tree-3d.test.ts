/**
 * The pure 3D layout (PLAN.md stage I2): the same tree model, projected as a
 * radial cone — depth becomes height, siblings fan around the trunk axis and
 * a branch's tube radius follows its subtree leaf count.
 *
 * Fixtures come from a real `LuckPlannerStore` (the repo's no-mocks rule —
 * these are the very `Node` rows `/api/tree` serves); the 10k perf fixture is
 * built from plain objects because the point there is the *layout* budget,
 * not the store's insert speed. The scene's rendering side (instanced
 * sprites, draw calls) is pinned by the bundle markers in
 * `tests/dashboard-3d.test.ts` and measured in the J2 acceptance.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LuckPlannerStore } from "../server/store";
import type { LeafStatus, Node as TreeNode, NodeKind } from "../shared/tree";
import {
  buildScene3D,
  LAYOUT_3D,
  subtreeLeafCounts,
  tubeRadius,
  type Scene3DModel,
} from "../dashboard/src/tree-3d";
import { indexTree } from "../dashboard/src/graph";

const P = "/projects/scene3d";
const ACTOR = "agent:coder";

let dir = "";
let store: LuckPlannerStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "luck-planner-scene3d-"));
  store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The fixture tree — the acceptance shape ("readable as a tree"):
 *
 * root
 * ├─ platform (trunk)      → api (branch, 2 leaves), storage (branch, 1 leaf)
 * └─ product  (trunk)      → billing (branch, 4 leaves)
 */
function seedTree(target: LuckPlannerStore): void {
  const root = target.createNode({
    projectKey: P,
    parentId: null,
    kind: "root",
    name: "Tech stack",
    actor: ACTOR,
  });
  const platform = target.createNode({
    projectKey: P,
    parentId: root.id,
    kind: "trunk",
    name: "platform",
    actor: ACTOR,
  });
  const product = target.createNode({
    projectKey: P,
    parentId: root.id,
    kind: "trunk",
    name: "product",
    actor: ACTOR,
  });
  const api = target.createNode({
    projectKey: P,
    parentId: platform.id,
    kind: "branch",
    name: "api",
    actor: ACTOR,
  });
  const storage = target.createNode({
    projectKey: P,
    parentId: platform.id,
    kind: "branch",
    name: "storage",
    actor: ACTOR,
  });
  const billing = target.createNode({
    projectKey: P,
    parentId: product.id,
    kind: "branch",
    name: "billing",
    actor: ACTOR,
  });
  const addLeaf = (
    parentId: string,
    name: string,
    status: LeafStatus,
  ): void => {
    target.createNode({
      projectKey: P,
      parentId,
      kind: "leaf",
      name,
      actor: ACTOR,
      status,
    });
  };
  // Two leaves under api, one under storage, four under billing.
  addLeaf(api.id, "rate limits", "in_progress");
  addLeaf(api.id, "openapi spec", "done");
  addLeaf(storage.id, "pg backups", "blocked");
  addLeaf(billing.id, "retry failed charges", "ready");
  addLeaf(billing.id, "proration", "draft");
  addLeaf(billing.id, "dunning emails", "claimed");
  addLeaf(billing.id, "tax rules", "superseded");
}

function modelOf(target: LuckPlannerStore = store): Scene3DModel {
  return buildScene3D(target.listNodes(P));
}

/**
 * A hand-crafted `Node` row — the only way to build the payload shapes the
 * store itself refuses (an orphaned `parentId`), which is exactly what a
 * partially-pruned `/api/tree` response can contain.
 */
function fixtureNode(input: {
  kind: NodeKind;
  name: string;
  parentId?: string | null;
  status?: LeafStatus;
}): TreeNode {
  return {
    id: `fixture-${input.name}`,
    projectKey: P,
    parentId: input.parentId ?? null,
    kind: input.kind,
    name: input.name,
    description: "",
    status: input.status ?? "draft",
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

/** Angle around the trunk axis, radians — the radial half of the layout. */
function angleOf(node: { position: readonly [number, number, number] }): number {
  return Math.atan2(node.position[2], node.position[0]);
}

/** Radial distance from the axis. */
function ringOf(node: { position: readonly [number, number, number] }): number {
  return Math.hypot(node.position[0], node.position[2]);
}

describe("buildScene3D — the cone", () => {
  it("puts the root at the centre, top of the cone, and drops every level", () => {
    seedTree(store);
    const model = modelOf();
    const root = model.roots[0]!;
    // Three real levels under the apex (root → trunk → branch → leaf), one
    // vertical step each.
    expect(root.position).toEqual([0, LAYOUT_3D.levelHeight * 3, 0]);

    // Depth → height: every child sits exactly one level below its parent,
    // and the deepest facts rest on the ground plane (the grid).
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    const nodes = store.listNodes(P);
    for (const node of nodes) {
      if (node.parentId === null) continue;
      const parent = byId.get(node.parentId)!;
      const child = byId.get(node.id)!;
      expect(child.position[1]).toBeCloseTo(parent.position[1] - LAYOUT_3D.levelHeight, 9);
    }
    const leaves = model.leaves;
    expect(leaves.length).toBe(7);
    for (const leaf of leaves) expect(leaf.position[1]).toBe(0);

    // Rings: first ring for the root's children, growing per level.
    for (const node of model.nodes) {
      const ring = ringOf(node);
      if (node.id === root.id) expect(ring).toBe(0);
      else expect(ring).toBeGreaterThanOrEqual(LAYOUT_3D.minRadius);
    }
    expect(model.height).toBe(LAYOUT_3D.levelHeight * 3);
    // Trunk on the first ring, branch on the second, leaves on the third.
    expect(model.radius).toBe(LAYOUT_3D.minRadius + 2 * LAYOUT_3D.ringStep);
  });

  it("fans siblings into distinct angles on a shared ring", () => {
    seedTree(store);
    const model = modelOf();
    const trunks = model.nodes.filter((node) => node.kind === "trunk");
    expect(trunks).toHaveLength(2);

    // Same depth → same ring and height; different name → different angle.
    expect(ringOf(trunks[0]!)).toBeCloseTo(ringOf(trunks[1]!), 9);
    expect(trunks[0]!.position[1]).toBe(trunks[1]!.position[1]);
    const spread = Math.abs(angleOf(trunks[0]!) - angleOf(trunks[1]!));
    expect(Math.min(spread, Math.PI * 2 - spread)).toBeGreaterThan(0.5);

    // The hierarchy is readable without clicks: all seven leaves fan into
    // seven distinct angles on the outer ring, resting on the ground plane.
    const angles = model.leaves.map(angleOf);
    expect(angles.length).toBe(7);
    for (let i = 0; i < angles.length; i += 1) {
      for (let j = i + 1; j < angles.length; j += 1) {
        const delta = Math.abs(angles[i]! - angles[j]!);
        expect(Math.min(delta, Math.PI * 2 - delta)).toBeGreaterThan(0.05);
      }
    }
  });

  it("joins every non-root node to its parent with one tube", () => {
    seedTree(store);
    const model = modelOf();
    const nodes = store.listNodes(P);
    const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));

    // One edge per non-root node, endpoints exactly the node positions.
    expect(model.edges).toHaveLength(nodes.length - 1);
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    for (const edge of model.edges) {
      const child = byId.get(edge.id)!;
      const parent = byId.get(parentOf.get(edge.id)!)!;
      expect(edge.to).toEqual(child.position);
      expect(edge.from).toEqual(parent.position);
      expect(edge.kind).toBe(child.kind);
      expect(edge.radius).toBeGreaterThan(0);
    }
  });

  it("thickens a branch's tube with its subtree leaf count", () => {
    seedTree(store);
    const model = modelOf();
    const nodes = store.listNodes(P);
    const byName = (name: string): string =>
      nodes.find((node) => node.name === name)!.id;
    const edge = (id: string) => model.edges.find((item) => item.id === id)!;

    const api = edge(byName("api")); // 2 leaves
    const storage = edge(byName("storage")); // 1 leaf
    const billing = edge(byName("billing")); // 4 leaves
    const platform = edge(byName("platform")); // 3 leaves below

    // Exactly the subtree leaf count, monotone — a trunk carrying many facts
    // is a thick tube, a single-leaf twig sits at the floor.
    expect(billing.radius).toBeGreaterThan(platform.radius);
    expect(platform.radius).toBeGreaterThan(api.radius);
    expect(api.radius).toBeGreaterThan(storage.radius);
    expect(storage.radius).toBe(LAYOUT_3D.tubeMin);
    // The node data carries the same count the radius was derived from.
    const billingNode = model.nodes.find((node) => node.id === byName("billing"))!;
    expect(billingNode.leaves).toBe(4);
  });

  it("marks the sprite and sphere subsets the scene renders", () => {
    seedTree(store);
    const model = modelOf();
    expect(model.roots.map((node) => node.kind)).toEqual(["root"]);
    expect(model.leaves).toHaveLength(7);
    expect(model.leaves.every((node) => node.isLeaf)).toBe(true);
    // Leaf statuses survive the projection — the scene tints by them.
    const statuses = new Set(model.leaves.map((node) => node.status));
    expect(statuses).toEqual(
      new Set(["ready", "in_progress", "done", "blocked", "draft", "claimed", "superseded"]),
    );
    expect(model.nodes.every((node) => !node.isRoot || node.kind === "root")).toBe(true);
  });

  it("is a pure function of the payload — two builds are identical", () => {
    seedTree(store);
    expect(modelOf()).toEqual(modelOf());
  });
});

describe("buildScene3D — degenerate payloads", () => {
  it("answers an empty project with an empty model", () => {
    const model = modelOf();
    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.leaves).toEqual([]);
    expect(model.roots).toEqual([]);
    expect(model.height).toBe(0);
    expect(model.radius).toBe(0);
  });

  it("centres a lone root with nothing to fan out", () => {
    store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "Tech stack",
      actor: ACTOR,
    });
    const model = modelOf();
    expect(model.roots).toHaveLength(1);
    expect(model.roots[0]!.position).toEqual([0, 0, 0]);
    expect(model.edges).toEqual([]);
    expect(model.height).toBe(0);
    expect(model.radius).toBe(0);
  });

  it("treats an orphaned parentId as a root, like the 2D adapter", () => {
    // The store refuses to create such a row, but the payload excludes
    // archived nodes — a hand-crafted or partially-pruned response can still
    // carry a dangling parentId, and the subtree must render, not vanish.
    const model = buildScene3D([
      fixtureNode({ kind: "root", name: "Tech stack" }),
      fixtureNode({ kind: "trunk", name: "stray trunk", parentId: "missing" }),
    ]);
    expect(model.roots).toHaveLength(2);
    // Both roots at the apex centre; the stray one has no tube to nothing.
    expect(model.roots.map((node) => ringOf(node))).toEqual([0, 0]);
    expect(model.edges).toEqual([]);
  });
});

describe("tubeRadius", () => {
  it("clamps both ends and grows monotonically in between", () => {
    expect(tubeRadius(1)).toBe(LAYOUT_3D.tubeMin);
    expect(tubeRadius(0)).toBe(LAYOUT_3D.tubeMin);
    expect(tubeRadius(100_000)).toBe(LAYOUT_3D.tubeMax);
    let previous = 0;
    for (const leaves of [1, 2, 5, 12, 40]) {
      const radius = tubeRadius(leaves);
      expect(radius).toBeGreaterThanOrEqual(previous);
      previous = radius;
    }
  });

  it("scales by area: four times the leaves, twice the radius", () => {
    // √-scaling is what makes the trunk readable next to a twig without the
    // thick branch swallowing the sprites.
    expect(tubeRadius(16) / tubeRadius(4)).toBeCloseTo(2, 5);
  });
});

describe("subtreeLeafCounts", () => {
  it("counts leaves only, ignoring internal nodes", () => {
    seedTree(store);
    const counts = subtreeLeafCounts(indexTree(store.listNodes(P)));
    const nodes = store.listNodes(P);
    const byName = (name: string): string =>
      nodes.find((node) => node.name === name)!.id;
    expect(counts.get(byName("Tech stack"))).toBe(7);
    expect(counts.get(byName("platform"))).toBe(3);
    expect(counts.get(byName("billing"))).toBe(4);
    expect(counts.get(byName("pg backups"))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The I2 budget: 5–10k nodes stay cheap to lay out.
// ---------------------------------------------------------------------------

/** Synthetic forest: one root, breadth-first until `total` nodes exist. */
function syntheticTree(total: number): TreeNode[] {
  const kinds: NodeKind[] = ["root", "trunk", "branch", "subbranch", "leaf"];
  const nodes: TreeNode[] = [
    {
      id: "n0",
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "root-0",
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
    },
  ];
  let cursor = 1;
  let parents = ["n0"];
  let level = 1;
  while (cursor < total) {
    const next: string[] = [];
    for (const parentId of parents) {
      for (let sibling = 0; sibling < 10 && cursor < total; sibling += 1) {
        const id = `n${cursor}`;
        // Levels 1–3 are trunk/branch/subbranch; everything deeper is a fact.
        const kind: NodeKind = level >= 4 ? "leaf" : kinds[level]!;
        nodes.push({
          id,
          projectKey: P,
          parentId,
          kind,
          name: `node-${String(cursor).padStart(6, "0")}`,
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
        next.push(id);
        cursor += 1;
      }
    }
    parents = next;
    level += 1;
  }
  return nodes;
}

describe("the I2 budget", () => {
  it("lays out 10k nodes well inside a frame-friendly budget", () => {
    const nodes = syntheticTree(10_000);
    expect(nodes).toHaveLength(10_000);

    const started = performance.now();
    const model = buildScene3D(nodes);
    const elapsed = performance.now() - started;

    expect(model.nodes).toHaveLength(10_000);
    expect(model.edges).toHaveLength(9_999);
    // The sprite subset is what the scene instances into one draw call.
    expect(model.leaves.length).toBeGreaterThan(6_000);
    // Generous ceiling for CI variance: the layout is O(n) and normally
    // finishes in the tens of milliseconds.
    expect(elapsed).toBeLessThan(500);
  }, 30_000);
});
