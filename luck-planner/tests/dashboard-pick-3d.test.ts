/**
 * The 3D interaction layer (PLAN.md stage I4): picking, the selection
 * highlight, the camera focus — and the memory of the 2D/3D choice.
 *
 * The acceptance of this stage has three halves, and they are asserted here:
 * 1. **A click in the scene selects a node** — the ray test is exact, the
 *    nearest node in front wins, and a click on empty space clears the
 *    selection (the 2D canvas' pane click). The picking is *ours* (a flat
 *    ray/sphere test) instead of three.js' instance-wise raycast, so the
 *    10 000-instance meshes stay out of the pointer path.
 * 2. **The selection highlights the same relations in both views** — the
 *    nodes sharing a blocking incident, the influence links and the tubes
 *    touching the node. The sets are computed from the *same* overlay the
 *    scene draws, and the test compares them with the 2D adapter's own
 *    `relatedByOpenBug` instead of trusting both.
 * 3. **The 2D/3D choice is remembered** — the URL wins over the stored
 *    preference, an unknown value is ignored, and the token and the project
 *    parameter survive the rewrite.
 *
 * Fixtures come from a real `LuckPlannerStore` (the repo's no-mocks rule):
 * the payload is the very `buildTreeResponse` output `/api/tree` serves, so
 * the bee and incident rows are the store's own.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTreeResponse } from "../server/http-server";
import { LuckPlannerStore } from "../server/store";
import type { TreeResponse } from "../shared/api";
import type { Node as TreeNode } from "../shared/tree";
import { buildGraph, relatedByOpenBug } from "../dashboard/src/graph";
import { buildSceneOverlay } from "../dashboard/src/overlay-3d";
import {
  EMPTY_HIGHLIGHT,
  focusTarget,
  pickCandidates,
  pickNode,
  selectionHighlight,
  type PickCandidate,
  type PickRay,
} from "../dashboard/src/pick-3d";
import { buildScene3D, LAYOUT_3D } from "../dashboard/src/tree-3d";
import {
  initialView,
  readStoredView,
  readViewParam,
  VIEW_STORAGE_KEY,
  viewSearch,
  writeStoredView,
  type ViewStorage,
} from "../dashboard/src/view-state";

const P = "/projects/pick3d";
const ACTOR = "agent:coder";

let dir = "";
let store: LuckPlannerStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "luck-planner-pick3d-"));
  store = new LuckPlannerStore({ dbPath: path.join(dir, "luck.db") });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly response: TreeResponse;
  readonly ids: {
    root: string;
    platform: string;
    api: string;
    rateLimits: string;
    openapi: string;
    retry: string;
    proration: string;
  };
}

/**
 *   Tech stack
 *   └─ platform → api → rate limits, openapi spec
 *   └─ billing → retry failed charges, proration
 *
 * Links: one bee (rate limits → retry), one blocking incident on two leaves
 * (retry, proration). Enough to ask every question the stage asks.
 */
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
  const api = node(platform.id, "branch", "api");
  const rateLimits = node(api.id, "leaf", "rate limits", "in_progress");
  const openapi = node(api.id, "leaf", "openapi spec", "done");
  const billing = node(platform.id, "branch", "billing");
  const retry = node(billing.id, "leaf", "retry failed charges", "blocked");
  const proration = node(billing.id, "leaf", "proration", "ready");

  target.createBee({
    projectKey: P,
    sourceLeafId: rateLimits.id,
    targetLeafId: retry.id,
    status: "active",
    impact: "depends on",
    actor: ACTOR,
  });
  target.createBug({
    projectKey: P,
    title: "charge retries loop",
    severity: "high",
    nodeIds: [retry.id, proration.id],
    actor: ACTOR,
  });

  return {
    response: buildTreeResponse(target, P),
    ids: {
      root: root.id,
      platform: platform.id,
      api: api.id,
      rateLimits: rateLimits.id,
      openapi: openapi.id,
      retry: retry.id,
      proration: proration.id,
    },
  };
}

/** A ray from `from` towards `to` (unit direction). */
function rayBetween(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): PickRay {
  const direction: [number, number, number] = [
    to[0] - from[0],
    to[1] - from[1],
    to[2] - from[2],
  ];
  return { origin: from, direction };
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

describe("I4: picking a node in the 3D scene", () => {
  it("hits the node the ray points at", () => {
    const candidates: PickCandidate[] = [
      { id: "a", position: [0, 0, 0], radius: 0.5 },
      { id: "b", position: [10, 0, 0], radius: 0.5 },
    ];
    const hit = pickNode(rayBetween([0, 0, 5], [0, 0, 0]), candidates);
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe("a");
    // The distance is along the ray: 5 units from the origin to the sphere.
    expect(hit?.distance).toBeCloseTo(4.5, 6);
  });

  it("returns nothing when the ray misses every node", () => {
    const candidates: PickCandidate[] = [
      { id: "a", position: [0, 0, 0], radius: 0.5 },
    ];
    expect(pickNode(rayBetween([0, 5, 0], [10, 5, 0]), candidates)).toBeNull();
  });

  it("prefers the nearest node in front of the camera", () => {
    const candidates: PickCandidate[] = [
      { id: "far", position: [0, 0, -5], radius: 0.5 },
      { id: "near", position: [0, 0, -1], radius: 0.5 },
    ];
    const hit = pickNode(rayBetween([0, 0, 0], [0, 0, -1]), candidates);
    expect(hit?.id).toBe("near");
  });

  it("ignores a node behind the ray's origin", () => {
    const candidates: PickCandidate[] = [
      { id: "behind", position: [0, 0, 5], radius: 0.5 },
    ];
    expect(pickNode(rayBetween([0, 0, 0], [0, 0, -1]), candidates)).toBeNull();
  });

  it("normalises the direction and hits a node on a non-unit ray", () => {
    const candidates: PickCandidate[] = [
      { id: "a", position: [0, 0, 0], radius: 0.5 },
    ];
    const hit = pickNode(
      { origin: [0, 0, 10], direction: [0, 0, -30] },
      candidates,
    );
    expect(hit?.id).toBe("a");
    expect(hit?.distance).toBeCloseTo(9.5, 6);
  });

  it("hits a node the ray already starts inside", () => {
    const candidates: PickCandidate[] = [
      { id: "a", position: [0, 0, 0], radius: 2 },
    ];
    const hit = pickNode(rayBetween([0, 0, 0], [0, 0, -1]), candidates);
    expect(hit?.id).toBe("a");
  });

  it("never divides by a zero-length direction", () => {
    const candidates: PickCandidate[] = [
      { id: "a", position: [0, 0, 0], radius: 2 },
    ];
    expect(
      pickNode({ origin: [0, 0, 0], direction: [0, 0, 0] }, candidates),
    ).toBeNull();
  });

  it("offers one candidate per node, sized by what the node looks like", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    const candidates = pickCandidates(model);
    expect(candidates).toHaveLength(model.nodes.length);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const leaf = byId.get(fixture.ids.rateLimits)!;
    const root = byId.get(fixture.ids.root)!;
    const branch = byId.get(fixture.ids.api)!;
    // A leaf is a sprite, an apex is a sphere, an inner node is a joint.
    expect(leaf.radius).toBeCloseTo(LAYOUT_3D.leafMarker * 1.15, 6);
    expect(root.radius).toBeCloseTo(LAYOUT_3D.rootRadius * 1.05, 6);
    expect(branch.radius).toBeGreaterThanOrEqual(0.3);
  });

  it("picks the node a click aimed at, using the real layout", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    const candidates = pickCandidates(model);
    const leaf = model.leaves.find((node) => node.id === fixture.ids.rateLimits)!;
    // A ray straight down at the leaf (from above): nothing else is on that
    // line, so the leaf is the only possible hit.
    const from: [number, number, number] = [
      leaf.position[0],
      leaf.position[1] + 5,
      leaf.position[2],
    ];
    const hit = pickNode(
      rayBetween(from, leaf.position as [number, number, number]),
      candidates,
    );
    expect(hit?.id).toBe(fixture.ids.rateLimits);
  });
});

// ---------------------------------------------------------------------------
// The selection highlight — the 3D twin of the 2D decoration
// ---------------------------------------------------------------------------

describe("I4: the selection highlight", () => {
  it("finds the nodes that share a blocking incident with the selection", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    const overlay = buildSceneOverlay(fixture.response, model);
    const highlight = selectionHighlight(model, overlay, fixture.ids.retry);
    // The incident blocks `retry` and `proration`: the sibling is related.
    expect(highlight.relatedNodeIds.has(fixture.ids.proration)).toBe(true);
    expect(highlight.relatedNodeIds.has(fixture.ids.rateLimits)).toBe(false);
    expect(highlight.incidentIds.size).toBe(1);
  });

  it("agrees with the 2D adapter about the shared incident", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    const overlay = buildSceneOverlay(fixture.response, model);
    const graph = buildGraph(fixture.response);
    const twoD = relatedByOpenBug(graph, fixture.ids.retry);
    const threeD = selectionHighlight(model, overlay, fixture.ids.retry)
      .relatedNodeIds;
    expect([...threeD].sort()).toEqual([...twoD].sort());
  });

  it("finds the influence links of the selection, in both directions", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    const overlay = buildSceneOverlay(fixture.response, model);
    const highlight = selectionHighlight(model, overlay, fixture.ids.rateLimits);
    expect(highlight.beeIds.size).toBe(1);
    // The same link is found from its other end.
    const other = selectionHighlight(model, overlay, fixture.ids.retry);
    expect([...other.beeIds]).toEqual([...highlight.beeIds]);
  });

  it("finds the tubes that touch the selection: its own and its children's", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    const overlay = buildSceneOverlay(fixture.response, model);
    const highlight = selectionHighlight(model, overlay, fixture.ids.api);
    // The api branch's own tube and the tubes of its two leaves.
    expect(highlight.edgeIds.has(fixture.ids.api)).toBe(true);
    expect(highlight.edgeIds.has(fixture.ids.rateLimits)).toBe(true);
    expect(highlight.edgeIds.has(fixture.ids.openapi)).toBe(true);
    expect(highlight.edgeIds.has(fixture.ids.platform)).toBe(false);
  });

  it("is empty without a selection", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    const overlay = buildSceneOverlay(fixture.response, model);
    const highlight = selectionHighlight(model, overlay, null);
    expect(highlight.selectedId).toBeNull();
    expect(highlight.relatedNodeIds.size).toBe(0);
    expect(highlight.beeIds.size).toBe(0);
    expect(highlight.edgeIds.size).toBe(0);
    expect(highlight).toBe(EMPTY_HIGHLIGHT);
  });
});

// ---------------------------------------------------------------------------
// The camera focus
// ---------------------------------------------------------------------------

describe("I4: the camera focus", () => {
  it("aims at the node and keeps a sensible distance", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    const target = focusTarget(model, fixture.ids.rateLimits);
    expect(target).not.toBeNull();
    const node = model.nodes.find((candidate) => candidate.id === fixture.ids.rateLimits)!;
    expect(target?.position).toEqual(node.position);
    expect(target?.distance).toBeGreaterThan(0);
    expect(target?.distance).toBeLessThanOrEqual(40);
  });

  it("has no target for a node that is not on screen", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    expect(focusTarget(model, "nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The filters reach the 3D tree
// ---------------------------------------------------------------------------

describe("I4: the toolbar filters narrow the 3D tree", () => {
  it("shows the same nodes the 2D diagram shows", () => {
    const fixture = seedFixture(store);
    const filter = { status: "in_progress" as const };
    const graph = buildGraph(fixture.response, { filter });
    const model = buildScene3D(fixture.response.nodes, { filter });
    const shown2d = new Set(graph.nodes.map((node) => node.id));
    const shown3d = new Set(model.nodes.map((node) => node.id));
    expect([...shown3d].sort()).toEqual([...shown2d].sort());
    // The matching leaf is in, its unrelated siblings are out.
    expect(shown3d.has(fixture.ids.rateLimits)).toBe(true);
    expect(shown3d.has(fixture.ids.proration)).toBe(false);
  });

  it("keeps the path to the root as context", () => {
    const fixture = seedFixture(store);
    const filter = { status: "in_progress" as const };
    const model = buildScene3D(fixture.response.nodes, { filter });
    const ids = new Set(model.nodes.map((node) => node.id));
    expect(ids.has(fixture.ids.root)).toBe(true);
    expect(ids.has(fixture.ids.platform)).toBe(true);
    expect(ids.has(fixture.ids.api)).toBe(true);
  });

  it("keeps every node when no filter narrows the tree", () => {
    const fixture = seedFixture(store);
    const model = buildScene3D(fixture.response.nodes);
    expect(model.nodes).toHaveLength(fixture.response.nodes.length);
  });
});

// ---------------------------------------------------------------------------
// The 2D/3D choice is remembered
// ---------------------------------------------------------------------------

describe("I4/K1: remembering the Plain/2D/3D choice", () => {
  it("reads the view from the URL", () => {
    expect(readViewParam("?token=t&view=3d")).toBe("3d");
    expect(readViewParam("?token=t&view=2d")).toBe("2d");
    // K1: the plain board is a first-class URL value.
    expect(readViewParam("?token=t&view=plain")).toBe("plain");
    // Nothing, something unknown, a broken value: no view.
    expect(readViewParam("?token=t")).toBeNull();
    expect(readViewParam("?view=4d")).toBeNull();
    expect(readViewParam("")).toBeNull();
  });

  it("remembers the choice in the tab's storage", () => {
    const memory = new Map<string, string>();
    const storage: ViewStorage = {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    };
    expect(readStoredView(storage)).toBeNull();
    writeStoredView(storage, "3d");
    expect(memory.get(VIEW_STORAGE_KEY)).toBe("3d");
    expect(readStoredView(storage)).toBe("3d");
  });

  it("survives a storage that refuses to work", () => {
    const hostile: ViewStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredView(hostile)).toBeNull();
    expect(() => writeStoredView(hostile, "3d")).not.toThrow();
    expect(readStoredView(null)).toBeNull();
    expect(() => writeStoredView(null, "3d")).not.toThrow();
  });

  it("prefers the URL over the stored choice and defaults to plain", () => {
    const memory = new Map<string, string>([[VIEW_STORAGE_KEY, "2d"]]);
    const storage: ViewStorage = {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    };
    expect(initialView("?view=3d", storage)).toBe("3d");
    // An explicit earlier choice is honoured — the default only decides
    // when nothing else does.
    expect(initialView("", storage)).toBe("2d");
    // K1: a tab that says nothing opens the plain board.
    expect(initialView("", null)).toBe("plain");
    expect(initialView("?view=plain", null)).toBe("plain");
  });

  it("writes the view into the URL without losing the token or the project", () => {
    const search = viewSearch("?token=abc&project=%2Fprojects%2Fx", "3d");
    expect(search).toContain("token=abc");
    expect(search).toContain("project=%2Fprojects%2Fx");
    expect(search).toContain("view=3d");
    // And the round trip: what it writes, it reads.
    expect(readViewParam(search)).toBe("3d");
  });
});
