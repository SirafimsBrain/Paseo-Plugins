/**
 * Picking, selection highlight and camera focus for the 3D view
 * (PLAN.md stage I4).
 *
 * Pure: no three.js, no DOM. The scene turns a pointer position into a world
 * ray — that part needs the camera, which only the renderer has — and hands
 * the plain numbers over; every *decision* is made here and can be tested in
 * plain Node:
 *
 * - **which node a ray hits** (`pickNode`): a ray/sphere test over a flat
 *   candidate list, nearest hit wins;
 * - **which nodes and links belong to the selection** (`selectionHighlight`):
 *   the 3D twin of the 2D canvas' `relatedByOpenBug` + `edgeTouchesNode`
 *   pair, so "select a leaf → see its blockers and its links" reads the same
 *   in both views (the I4 acceptance);
 * - **where the camera should fly** (`focusTarget`): the node's position and
 *   a distance that keeps the tree in frame.
 *
 * Why the picking is ours and not the renderer's: a tree with 10 000 leaves
 * would be re-tested instance by instance on every pointer *move*, and the
 * only pointer event that matters is the click. One ray/sphere test per click
 * over a flat list is exact, cheap and predictable — and it keeps the
 * 10 000-instance meshes out of three.js' raycast path, the rule I3 set and
 * I4 has to honour.
 *
 * The module sits in the eagerly loaded chunk next to `graph.ts` and
 * `tree-3d.ts` (it imports only their types and the layout constants), so the
 * lazy scene chunk pulls in the *decision* code and not the tree.
 */
import { LAYOUT_3D, tubeRadius, type Scene3DModel, type SceneNode3D } from "./tree-3d";
import type { Scene3DOverlay } from "./overlay-3d";

/** A world-space ray: an origin and a direction (normalised on use). */
export interface PickRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/** One pickable node: its position and the radius around it that counts. */
export interface PickCandidate {
  readonly id: string;
  readonly position: readonly [number, number, number];
  /** The pick radius — generous enough to hit a small sprite, tight enough
   *  that a neighbour does not steal the click. */
  readonly radius: number;
}

/** The node a ray hit, and how far along the ray the hit was. */
export interface PickHit {
  readonly id: string;
  /** Distance from the ray origin to the hit. */
  readonly distance: number;
}

/**
 * The nearest node the ray passes through.
 *
 * A plain ray/sphere intersection: the quadratic's near root is the entry
 * point, and a ray that starts *inside* a sphere takes the far root (the
 * user is already "on" that node). The nearest hit wins, so a node in front
 * hides the one behind it — the same rule the renderer's own picking uses.
 */
export function pickNode(
  ray: PickRay,
  candidates: readonly PickCandidate[],
): PickHit | null {
  let dx = ray.direction[0];
  let dy = ray.direction[1];
  let dz = ray.direction[2];
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return null;
  dx /= length;
  dy /= length;
  dz /= length;
  const ox = ray.origin[0];
  const oy = ray.origin[1];
  const oz = ray.origin[2];

  let best: PickHit | null = null;
  for (const candidate of candidates) {
    const mx = ox - candidate.position[0];
    const my = oy - candidate.position[1];
    const mz = oz - candidate.position[2];
    // b = -m·d with m = origin - centre; c = |m|² - r².
    const b = mx * dx + my * dy + mz * dz;
    const c = mx * mx + my * my + mz * mz - candidate.radius * candidate.radius;
    const discriminant = b * b - c;
    if (discriminant < 0) continue;
    const root = Math.sqrt(discriminant);
    let distance = -b - root;
    if (distance < 0) distance = -b + root; // the ray starts inside
    if (distance < 0) continue; // behind the origin
    if (best === null || distance < best.distance) {
      best = { id: candidate.id, distance };
    }
  }
  return best;
}

/**
 * The pick radius of one node: the sprite it is drawn as, the sphere it is
 * drawn as, or — for an internal node, which has no shape of its own — a
 * "joint" around the point where its children hang.
 */
function pickRadius(node: SceneNode3D): number {
  if (node.isLeaf) return LAYOUT_3D.leafMarker * 1.15;
  if (node.isRoot) return LAYOUT_3D.rootRadius * 1.05;
  return Math.max(tubeRadius(node.leaves) * 2.4, 0.3);
}

/**
 * Every node of the layout as a pick candidate.
 *
 * The list is derived from the model, so it is rebuilt only when the model
 * changes — a click costs one pass over this list, not over the scene graph.
 */
export function pickCandidates(model: Scene3DModel): PickCandidate[] {
  return model.nodes.map((node) => ({
    id: node.id,
    position: node.position,
    radius: pickRadius(node),
  }));
}

/**
 * What the selection highlights in the 3D scene — the twin of the 2D
 * canvas' decoration (the selected node, the nodes sharing an open incident
 * with it, the edges touching it).
 */
export interface SelectionHighlight {
  /** The selected node, or `null` when nothing is selected. */
  readonly selectedId: string | null;
  /** Nodes blocked by the same incident as the selection. */
  readonly relatedNodeIds: ReadonlySet<string>;
  /** The blocking incidents attached to the selection. */
  readonly incidentIds: ReadonlySet<string>;
  /** The bees attached to the selection (in either direction). */
  readonly beeIds: ReadonlySet<string>;
  /**
   * The tree tubes touching the selection: its own tube (the edge belongs to
   * the child) and the tubes of its children.
   */
  readonly edgeIds: ReadonlySet<string>;
}

/** The highlight of an empty selection. */
export const EMPTY_HIGHLIGHT: SelectionHighlight = {
  selectedId: null,
  relatedNodeIds: new Set<string>(),
  incidentIds: new Set<string>(),
  beeIds: new Set<string>(),
  edgeIds: new Set<string>(),
};

/**
 * Computes the 3D highlight of a selection.
 *
 * The relations are the *same* relations the 2D canvas uses: the incidents
 * are the blocking ones (the overlay only carries those), the bees are the
 * influence links of the node, and the edges are the tubes that touch it.
 * Both views therefore answer "what is this fact connected to" the same way —
 * the I4 acceptance scenario.
 */
export function selectionHighlight(
  model: Scene3DModel,
  overlay: Scene3DOverlay,
  selectedId: string | null,
): SelectionHighlight {
  if (selectedId === null) return EMPTY_HIGHLIGHT;

  const incidentIds = new Set<string>();
  for (const bug of overlay.bugs) {
    if (bug.nodeId === selectedId) incidentIds.add(bug.id);
  }
  const relatedNodeIds = new Set<string>();
  if (incidentIds.size > 0) {
    for (const bug of overlay.bugs) {
      if (bug.nodeId !== selectedId && incidentIds.has(bug.id)) {
        relatedNodeIds.add(bug.nodeId);
      }
    }
  }

  const beeIds = new Set<string>();
  for (const bee of overlay.bees) {
    if (bee.sourceId === selectedId || bee.targetId === selectedId) {
      beeIds.add(bee.id);
    }
  }

  const edgeIds = new Set<string>();
  for (const node of model.nodes) {
    if (node.id === selectedId) {
      edgeIds.add(node.id); // the node's own tube
    } else if (node.parentId === selectedId) {
      edgeIds.add(node.id); // the tube of one of its children
    }
  }

  return { selectedId, relatedNodeIds, incidentIds, beeIds, edgeIds };
}

/**
 * Where the camera should fly to look at one node.
 */
export interface FocusTarget {
  /** The node's position in the scene. */
  readonly position: readonly [number, number, number];
  /** How far from the node the camera should sit. */
  readonly distance: number;
}
/**
 * The focus target of a node (G4 search → the 3D camera flies there).
 *
 * The distance keeps the *whole* tree in frame: a big project needs a wider
 * shot than a small one, otherwise "fly to this leaf" ends up inside a
 * neighbour's sprite.
 */
export function focusTarget(model: Scene3DModel, nodeId: string): FocusTarget | null {
  for (const node of model.nodes) {
    if (node.id !== nodeId) continue;
    return {
      position: node.position,
      distance: Math.min(40, Math.max(2.5, model.radius * 0.45)),
    };
  }
  return null;
}

/**
 * Everything the 3D scene needs to know about the tab's interaction state.
 *
 * The app owns this object (it is the only place that knows the tree, the
 * selection and the search), and the scene *renders* it — the scene never
 * looks a node up by id itself, which keeps it free of the payload and of
 * the "which node is where" questions (the I3 boundary, one layer up).
 */
export interface SceneInteraction {
  /** The selected node id, or `null` when nothing is selected. */
  readonly selectedId: string | null;
  /** The label drawn next to the selected node (the scene does not look names up). */
  readonly selectedLabel: string | null;
  /** The selected node's position — for the selection ring and the label. */
  readonly selectedPosition: readonly [number, number, number] | null;
  /** The pickable nodes: positions and radii for the click test. */
  readonly candidates: readonly PickCandidate[];
  /** What the selection highlights: related nodes, incidents, bees, tubes. */
  readonly highlight: SelectionHighlight;
  /**
   * A camera flight: the node, the position to reach, how far to sit from it
   * and the request counter that makes a repeated request re-trigger.
   */
  readonly focus: {
    readonly nodeId: string;
    readonly seq: number;
    readonly position: readonly [number, number, number];
    readonly distance: number;
  } | null;
}

/** The interaction of a tab that has selected nothing yet. */
export const EMPTY_INTERACTION: SceneInteraction = {
  selectedId: null,
  selectedLabel: null,
  selectedPosition: null,
  candidates: [],
  highlight: EMPTY_HIGHLIGHT,
  focus: null,
};
