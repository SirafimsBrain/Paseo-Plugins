/**
 * 3D layout of the project tree (PLAN.md stage I2).
 *
 * The same model, a new projection: the flat `TreeResponse.nodes` list is
 * indexed by the 2D adapter's own deterministic `indexTree` and fed through a
 * d3-hierarchy radial layout where **depth becomes height** and the sibling
 * axis becomes the angle around the trunk axis — the tree reads as a tree
 * from any orbit angle without a single click (the I2 acceptance).
 *
 * Pure data, no three.js, no DOM — the module lands in the eagerly loaded
 * chunk next to `graph.ts` (d3-hierarchy is already there), and the lazy
 * scene chunk only consumes the arrays. That boundary is what keeps the 3D
 * dependency graph out of the first chunk in both directions: layout logic
 * here stays testable in vitest, and the scene renders, never decides.
 *
 * Geometry decisions, pinned here because the scene obeys them:
 * - the root sphere marks the tech stack at the centre, top of the cone;
 * - every non-root node is joined to its parent by a straight segment whose
 *   radius follows the child's subtree **leaf** count (sqrt-scaled, clamped):
 *   a trunk carrying hundreds of modules is a thick tube, a twig is thin —
 *   the plan's "толщина по числу листьев";
 * - leaves are flat sprites tinted by their status, one instanced draw call
 *   in the scene; the palette itself is *not* duplicated here — the scene
 *   reads `colors.ts`, the same module the 2D legend uses;
 * - radial distance grows ring by ring with depth and each depth level takes
 *   the same vertical step, so the silhouette is a measurable cone with the
 *   deepest facts on the ground plane.
 *
 * Determinism is inherited: `indexTree` sorts siblings by name, d3's tree
 * layout is a pure function, and positions are computed from indices only.
 */
import { hierarchy, tree as d3tree } from "d3-hierarchy";
import type { LeafStatus, Node as TreeNode, NodeKind } from "../../shared/tree";
import { indexTree } from "./graph";

/** Vertical step and ring radii of the cone — the whole silhouette. */
export const LAYOUT_3D = {
  /** Height one depth level costs. */
  levelHeight: 2.4,
  /** Radius of the first ring (the root's direct children). */
  minRadius: 2.6,
  /** Radial growth per level beyond the first ring. */
  ringStep: 3.4,
  /** Radius of the tech-stack sphere. */
  rootRadius: 1.15,
  /** Half-edge of one leaf sprite. */
  leafMarker: 0.62,
  /** Tube radius is clamped into this window (see `tubeRadius`). */
  tubeMin: 0.055,
  tubeMax: 0.62,
  /** Tube radius per √subtree-leaf before clamping (== the floor: a
   *  single-leaf twig sits at `tubeMin` by construction). */
  tubePerSqrtLeaf: 0.055,
} as const;

/** One positioned node of the scene. */
export interface SceneNode3D {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  /** Leaf status as stored (non-leaf nodes carry their own status too). */
  readonly status: LeafStatus;
  /** `[x, y(height), z]`; the root sits at `[0, height, 0]`. */
  readonly position: readonly [number, number, number];
  /** Leaves in this node's subtree (including itself when it is a leaf). */
  readonly leaves: number;
  /**
   * Apex node — the scene draws these as spheres. The forest roots of the
   * payload; a node whose `parentId` dangles (a pruned response) counts as
   * one too, so it renders at the apex instead of vanishing.
   */
  readonly isRoot: boolean;
  /** True for the nodes drawn as an instanced sprite (kind `leaf`). */
  readonly isLeaf: boolean;
}

/** One tube joining a node to its parent. */
export interface SceneEdge3D {
  /** The child's id — the edge belongs to the node it hangs from. */
  readonly id: string;
  readonly kind: NodeKind;
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /** Tube radius — the child's subtree leaf count, sqrt-scaled + clamped. */
  readonly radius: number;
}

/** Everything the scene needs to draw the tree. */
export interface Scene3DModel {
  /** Every node, parents before children (breadth order). */
  readonly nodes: readonly SceneNode3D[];
  /** One tube per non-root node, keyed by that node's id. */
  readonly edges: readonly SceneEdge3D[];
  /** The `kind === "leaf"` subset of `nodes`, for the instanced mesh. */
  readonly leaves: readonly SceneNode3D[];
  /** The apex subset of `nodes`, for the sphere meshes (see `isRoot`). */
  readonly roots: readonly SceneNode3D[];
  /** Vertical extent (ground → root level); 0 for a single-root tree. */
  readonly height: number;
  /** Radius of the outermost ring — the camera frames this. */
  readonly radius: number;
}

/**
 * Tube radius for a subtree carrying `leafCount` leaves: area-proportional
 * (√) so a branch with four times the leaves is twice as thick, clamped so a
 * 10 000-leaf trunk does not swallow the sprites and a twig stays visible.
 */
export function tubeRadius(leafCount: number): number {
  const raw = Math.sqrt(Math.max(1, leafCount)) * LAYOUT_3D.tubePerSqrtLeaf;
  return Math.min(LAYOUT_3D.tubeMax, Math.max(LAYOUT_3D.tubeMin, raw));
}

/**
 * Subtree leaf count per node: a leaf (or any childless node — the model
 * treats a childless non-leaf as a fact, which is what the store can hold)
 * counts 1, everyone else sums its children. Iterative post-order, O(n).
 */
export function subtreeLeafCounts(index: ReturnType<typeof indexTree>): Map<string, number> {
  const counts = new Map<string, number>();
  const childrenOf = index.childrenOf;
  for (const root of index.roots) {
    const order: string[] = [];
    const stack: string[] = [root.id];
    while (stack.length) {
      const id = stack.pop()!;
      order.push(id);
      for (const child of childrenOf.get(id) ?? []) stack.push(child.id);
    }
    for (const id of order.reverse()) {
      const children = childrenOf.get(id) ?? [];
      let count: number;
      if (children.length === 0) count = 1;
      else {
        count = 0;
        for (const child of children) count += counts.get(child.id)!;
      }
      counts.set(id, count);
    }
  }
  return counts;
}

/**
 * Builds the radial 3D layout for a project's nodes.
 *
 * A synthetic invisible root wraps the forest so several roots (and nodes
 * whose `parentId` points at an archived/unknown node — `indexTree`'s
 * defensive rule) still form one hierarchy; the wrap level is dropped again
 * when the model is emitted, so real roots sit at the cone's apex.
 */
export function buildScene3D(nodes: readonly TreeNode[]): Scene3DModel {
  const index = indexTree(nodes);
  const leafCounts = subtreeLeafCounts(index);
  const virtual = { id: "__lp_forest__" } as TreeNode;
  const hroot = hierarchy(virtual, (node) =>
    node.id === virtual.id ? index.roots : index.childrenOf.get(node.id) ?? null,
  );

  // Sibling slots on x, one vertical step per depth on y; the angle is
  // normalised over the widest spread so a narrow tree fans out and a wide
  // one wraps the full circle (the classic radial tree).
  d3tree<TreeNode>().nodeSize([1, LAYOUT_3D.levelHeight])(hroot);

  let maxX = 0;
  let maxDepth = 0;
  hroot.each((node) => {
    // `x` is typed optional until a layout has run; the tree() call above
    // guarantees it, and `?? 0` keeps the type honest anyway.
    const x = node.x ?? 0;
    if (x > maxX) maxX = x;
    if (node.depth > maxDepth) maxDepth = node.depth;
  });

  /** Radial ring radius for a *real* depth (the wrap level costs no ring). */
  const ringRadius = (depth: number): number => {
    if (depth <= 1) return 0; // the apex: real roots at the centre
    return LAYOUT_3D.minRadius + (depth - 2) * LAYOUT_3D.ringStep;
  };

  const positionOf = (
    node: { x?: number; depth: number },
  ): [number, number, number] => {
    const angle = maxX > 0 ? ((node.x ?? 0) / maxX) * Math.PI * 2 : 0;
    const ring = ringRadius(node.depth);
    const y = (maxDepth - node.depth) * LAYOUT_3D.levelHeight;
    return [Math.cos(angle) * ring, y, Math.sin(angle) * ring];
  };

  const sceneNodes: SceneNode3D[] = [];
  const sceneEdges: SceneEdge3D[] = [];

  for (const node of hroot.descendants()) {
    if (node.depth === 0) continue; // the synthetic forest root
    const source = node.data;
    const position = positionOf(node);
    const isLeaf = source.kind === "leaf";
    const parent = node.parent;
    // Apex = no real parent in the payload: drawn as a sphere, joined to
    // nothing (the synthetic forest root is not a node and cannot be drawn).
    const isRoot = parent === null || parent.depth === 0;
    const entry: SceneNode3D = {
      id: source.id,
      kind: source.kind,
      name: source.name,
      status: source.status,
      position,
      leaves: leafCounts.get(source.id) ?? 1,
      isRoot,
      isLeaf,
    };
    sceneNodes.push(entry);

    if (!isRoot && parent !== null) {
      // `positionOf` is a pure function of (x, depth), so the parent's end of
      // the tube is exact without keeping a second map around.
      sceneEdges.push({
        id: entry.id,
        kind: entry.kind,
        from: positionOf(parent),
        to: position,
        radius: tubeRadius(entry.leaves),
      });
    }
  }

  return {
    nodes: sceneNodes,
    edges: sceneEdges,
    leaves: sceneNodes.filter((node) => node.isLeaf),
    roots: sceneNodes.filter((node) => node.isRoot),
    // An empty payload has no depths at all; the cone never goes negative.
    height: Math.max(0, (maxDepth - 1) * LAYOUT_3D.levelHeight),
    radius: ringRadius(maxDepth),
  };
}
