/**
 * Link, incident, goal and progress overlays of the 3D scene (PLAN.md
 * stage I3).
 *
 * Stage I2 drew the tree. This module computes everything that is *attached*
 * to it — the four domain layers the 3D view must show, each in its own
 * shape so they cannot be confused by eye (the I3 acceptance):
 *
 * - **bees** (`links.ts`) — one particle per influence link, flying a
 *   quadratic Bézier arc between the two leaves it connects. An *arc* is the
 *   point: the tree itself is straight tubes, so a curved flight path reads
 *   as a relation, not as a branch. Bees sharing the same pair of leaves get
 *   separate lanes (the same collision rule the 2D bee edges need);
 * - **bugs** (`links.ts`) — one floating octahedron per *blocking* incident
 *   per attached node, pulsing. The "blocking" pair (`open` + `investigating`)
 *   comes from `graph.ts`, never re-invented here;
 * - **goals** (`goals.ts`) — a ring floating above the bounding box of the
 *   subtree a goal materialized (ADR-7). Its radius follows the subtree, so
 *   the ring covers exactly what the goal grew;
 * - **growth** (`growth.ts`) — a glow halo on every node whose subtree carries
 *   growth data, tinted by the shared heat ramp. The ratios are the ones
 *   `graph.ts#growthRollups` computes for the 2D heat layer; the layer switch
 *   decides *whether* the halos exist at all, exactly as in 2D.
 *
 * The module is pure and three-free, so it lands in the eagerly loaded chunk
 * next to `graph.ts` (`tests/dashboard-3d.test.ts` pins that split) and is
 * testable in plain Node: the scene *renders* these arrays, it never computes
 * geometry — the I2 boundary, kept.
 *
 * **Animation is here too, and it is the reason the frame budget holds.** The
 * scene does not decide where a particle is at time `t`; it calls
 * {@link beeProgress} + {@link beeArcPoint} for each bee and
 * {@link bugPulseScale} for each bug — pure functions over a preallocated
 * out-vector, with per-frame cost O(bees + bugs) and no allocation. Everything
 * larger (leaf sprites, growth halos) is positioned once and drawn in one
 * instanced call, so the per-frame work does not grow with the node count at
 * all: 1000 nodes animate for the price of their links (the I3 acceptance,
 * measured in `tests/dashboard-overlay-3d.test.ts`).
 *
 * Determinism: every phase comes from {@link hashUnit} of a stable id, never
 * from `Math.random()`, so the same payload always animates the same way (and
 * the SSE refetches of stage H1 do not reshuffle the swarm).
 */
import type { TreeResponse } from "../../shared/api";
import type { BeeStatus, BugSeverity, BugStatus } from "../../shared/links";
import type { GoalStatus } from "../../shared/goals";
import {
  growthRollups,
  indexTree,
  type GraphLayer,
  type GrowthRollup,
} from "./graph";
import type { Scene3DModel } from "./tree-3d";

/** Immutable scene position: `[x, y(height), z]`. */
export type Vec3 = readonly [number, number, number];

/** Mutable position the animation helpers write into (no per-frame garbage). */
export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Geometry and timing constants of the overlay. The scene obeys them; the
 * tests assert against them, so a shape described in prose ("the arc stays
 * above the chord") is a number here, not a hope.
 */
export const OVERLAY_3D = {
  /** Bee arc lift, as a fraction of the chord between the two leaves. */
  beeArcFraction: 0.22,
  /** …clamped so a short link is still visible and a long one stays sane. */
  beeMinLift: 0.5,
  beeMaxLift: 4,
  /** Vertical separation between bees sharing one pair of leaves. */
  beeLaneSpacing: 0.4,
  /** How much of the chord a bee's arc bulges *outward* from the trunk axis. */
  beeOutwardFraction: 0.12,
  /** Cycles per second a particle travels its arc. */
  beeSpeed: 0.18,
  /** Radius of one bee particle (the instanced sphere the scene draws). */
  beeRadius: 0.16,
  /** A blocking incident's marker floats this far above the node it blocks. */
  bugLift: 0.55,
  /** Pulse amplitude of the marker scale (1 ± amplitude) and its period. */
  bugPulse: 0.28,
  bugPeriod: 1.6,
  /** Radius of one bug marker. */
  bugRadius: 0.3,
  /** Ring margin around the materialized subtree's bounding circle. */
  goalMargin: 1.3,
  /** …with a floor, so a single-node goal still gets a readable ring. */
  goalMinRadius: 1.6,
  /** How high above the highest node of the subtree the ring floats. */
  goalLift: 1.5,
  /** Tube radius of the goal ring. */
  goalTube: 0.08,
  /** Growth halo scale at ratio 0 and the span added at ratio 1. */
  haloMinScale: 0.7,
  haloScaleSpan: 0.9,
  /** Breathing glow of the growth layer: base opacity and amplitude. */
  glowBase: 0.3,
  glowAmplitude: 0.12,
  glowPeriod: 3,
} as const;

/** One influence link, as the scene animates it. */
export interface SceneBee3D {
  readonly id: string;
  readonly status: BeeStatus;
  /** The link's meaning ("depends on", "supersedes", …) — the tooltip text. */
  readonly impact: string;
  readonly revision: number;
  /**
   * The source leaf's node id. Added in stage I4: the selection highlight
   * needs to know *which* node a link hangs off (the 2D canvas emphasises
   * the edges touching the selection), and the arc itself only carries
   * positions.
   */
  readonly sourceId: string;
  /** The target leaf's node id (see `sourceId`). */
  readonly targetId: string;
  /** The source leaf's scene position (the arc's start). */
  readonly from: Vec3;
  /** The target leaf's scene position (the arc's end). */
  readonly to: Vec3;
  /** The Bézier control point — the apex the particle curves through. */
  readonly control: Vec3;
  /** Starting offset in `[0, 1)` so the swarm is never in lockstep. */
  readonly phase: number;
}

/** One blocking incident on one node, as the scene pulses it. */
export interface SceneBug3D {
  readonly id: string;
  readonly nodeId: string;
  readonly title: string;
  readonly severity: BugSeverity;
  readonly status: BugStatus;
  /** Marker position: the node's position, lifted clear of its shape. */
  readonly position: Vec3;
  /** Pulse offset in `[0, 1)` — the same incident pulses in sync. */
  readonly phase: number;
}

/** One materialized goal, as the scene floats its ring. */
export interface SceneGoal3D {
  readonly id: string;
  /** The formal task text (the tooltip; truncated for display). */
  readonly name: string;
  readonly status: GoalStatus;
  /** Ring centre: the middle of the subtree box, lifted above its top. */
  readonly center: Vec3;
  /** Ring radius: half the subtree box's diagonal, plus a margin. */
  readonly radius: number;
  /** How many nodes of the payload the ring encloses. */
  readonly nodeCount: number;
  /** Roll-up of the goal's subtree, or `null` without growth data. */
  readonly growth: GrowthRollup | null;
  /** Rotation offset in `[0, 1)` (reserved for the I4 hover highlight). */
  readonly phase: number;
}

/** One node's growth roll-up, as the scene glows it. */
export interface SceneGrowth3D {
  readonly nodeId: string;
  readonly position: Vec3;
  /** Completed share of the subtree's growth steps, in `[0, 1]`. */
  readonly heat: number;
  readonly completed: number;
  readonly total: number;
  readonly failed: number;
  readonly records: number;
  /** Breathing offset in `[0, 1)` so the halos do not blink in unison. */
  readonly phase: number;
}

/** Everything the scene draws on top of the I2 tree. */
export interface Scene3DOverlay {
  readonly bees: readonly SceneBee3D[];
  readonly bugs: readonly SceneBug3D[];
  readonly goals: readonly SceneGoal3D[];
  /**
   * Growth halos — **empty** while the diagram layer is `status`: the layer
   * switch is the one place that decides whether growth is on screen (the G5
   * rule), and 3D follows it instead of inventing a second switch.
   */
  readonly growth: readonly SceneGrowth3D[];
}

/** Overlay of a project with no links, incidents, goals or growth. */
export const EMPTY_OVERLAY: Scene3DOverlay = {
  bees: [],
  bugs: [],
  goals: [],
  growth: [],
};

/** Options of {@link buildSceneOverlay}. */
export interface BuildOverlayOptions {
  /**
   * Active diagram layer (G5). `growth` emits the glow halos; `status` (the
   * default) leaves them out. Bees, bugs and goals are links, not a layer —
   * they are always drawn, exactly as the 2D canvas always draws them.
   */
  layer?: GraphLayer;
}

/**
 * Builds the whole overlay for one `/api/tree` payload and its I2 layout.
 *
 * `model` supplies the positions (the overlay never lays anything out itself)
 * and `input` the links. Anything whose endpoint is not in the layout —
 * an archived node, a bee to a leaf that has left the payload, a goal that
 * never materialized — is dropped rather than drawn at the origin: the overlay
 * describes what is on screen, never a phantom.
 */
export function buildSceneOverlay(
  input: TreeResponse,
  model: Scene3DModel,
  options: BuildOverlayOptions = {},
): Scene3DOverlay {
  const positions = new Map<string, Vec3>();
  for (const node of model.nodes) positions.set(node.id, node.position);
  return {
    bees: buildBeeArcs(input, positions),
    bugs: buildBugMarkers(input, positions),
    goals: buildGoalRings(input, positions),
    growth:
      options.layer === "growth"
        ? buildGrowthHalos(model, growthRollups(input))
        : [],
  };
}

// ---------------------------------------------------------------------------
// Bees
// ---------------------------------------------------------------------------

/**
 * One particle per influence link whose *both* leaves are in the layout.
 *
 * The control point sits above the chord's midpoint by a distance proportional
 * to the chord (clamped) and is pushed slightly away from the trunk axis, so
 * arcs bow outward around the tree instead of slicing through it. Bees that
 * share a pair of leaves — the same relation stated twice, or both directions
 * of it — take successive lanes so their arcs stay apart.
 */
function buildBeeArcs(
  input: TreeResponse,
  positions: ReadonlyMap<string, Vec3>,
): SceneBee3D[] {
  // Id order, so the lane assignment cannot depend on payload order.
  const bees = [...input.bees].sort(byId);
  const lanes = new Map<string, number>();
  const arcs: SceneBee3D[] = [];
  for (const bee of bees) {
    const from = positions.get(bee.sourceLeafId);
    const to = positions.get(bee.targetLeafId);
    if (from === undefined || to === undefined) continue;
    // A pair key, not a direction: A→B and B→A share the lane space.
    const key =
      bee.sourceLeafId < bee.targetLeafId
        ? `${bee.sourceLeafId}|${bee.targetLeafId}`
        : `${bee.targetLeafId}|${bee.sourceLeafId}`;
    const lane = lanes.get(key) ?? 0;
    lanes.set(key, lane + 1);
    arcs.push(
      beeArc(
        bee.id,
        bee.sourceLeafId,
        bee.targetLeafId,
        bee.status,
        bee.impact,
        bee.revision,
        from,
        to,
        lane,
      ),
    );
  }
  return arcs;
}

/** The arc of one bee, given its endpoints and its lane on that pair. */
function beeArc(
  id: string,
  sourceId: string,
  targetId: string,
  status: BeeStatus,
  impact: string,
  revision: number,
  from: Vec3,
  to: Vec3,
  lane: number,
): SceneBee3D {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const chord = Math.hypot(dx, dy, dz);
  const lift = Math.min(
    OVERLAY_3D.beeMaxLift,
    Math.max(OVERLAY_3D.beeMinLift, chord * OVERLAY_3D.beeArcFraction),
  );
  const midX = (from[0] + to[0]) / 2;
  const midY = (from[1] + to[1]) / 2;
  const midZ = (from[2] + to[2]) / 2;
  // Outward from the trunk axis, so the arc bows away from the tree.
  const axis = Math.hypot(midX, midZ);
  const outward = axis === 0 ? 0 : OVERLAY_3D.beeOutwardFraction * chord;
  const control: Vec3 = [
    midX + (axis === 0 ? 0 : (midX / axis) * outward),
    midY + lift + lane * OVERLAY_3D.beeLaneSpacing,
    midZ + (axis === 0 ? 0 : (midZ / axis) * outward),
  ];
  return {
    id,
    status,
    impact,
    revision,
    sourceId,
    targetId,
    from,
    to,
    control,
    phase: hashUnit(id),
  };
}

/**
 * Where a bee's particle is at time `t` seconds, as a fraction of its arc in
 * `[0, 1)`. Cycles at {@link OVERLAY_3D.beeSpeed}; each bee is offset by its
 * own phase, so a swarm reads as many travellers, not one pulse.
 */
export function beeProgress(
  bee: SceneBee3D,
  t: number,
  speed: number = OVERLAY_3D.beeSpeed,
): number {
  const travelled = t * speed + bee.phase;
  return travelled - Math.floor(travelled);
}

/**
 * The point at fraction `u` of a bee's arc, written into `out` (quadratic
 * Bézier: `(1-u)²·from + 2(1-u)u·control + u²·to`).
 *
 * Allocation-free on purpose: the scene calls this once per bee per frame, and
 * a fresh array per particle per frame is exactly the kind of garbage that
 * turns 60 fps into 45.
 */
export function beeArcPoint(bee: SceneBee3D, u: number, out: MutableVec3): MutableVec3 {
  const inverse = 1 - u;
  const a = inverse * inverse;
  const b = 2 * inverse * u;
  const c = u * u;
  out.x = a * bee.from[0] + b * bee.control[0] + c * bee.to[0];
  out.y = a * bee.from[1] + b * bee.control[1] + c * bee.to[1];
  out.z = a * bee.from[2] + b * bee.control[2] + c * bee.to[2];
  return out;
}

/**
 * Samples of a bee's arc, from its start to its end.
 *
 * Stage I4 draws the *link* of the selected node as a curve (the 3D twin of
 * the 2D canvas' emphasised edge): a particle alone says "something flies
 * here", a curve says "this fact depends on that one".
 */
export function beeArcPoints(bee: SceneBee3D, samples: number): Vec3[] {
  const count = Math.max(2, Math.floor(samples));
  const points: Vec3[] = [];
  const scratch: MutableVec3 = { x: 0, y: 0, z: 0 };
  for (let index = 0; index < count; index += 1) {
    const u = index / (count - 1);
    beeArcPoint(bee, u, scratch);
    points.push([scratch.x, scratch.y, scratch.z]);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Bugs
// ---------------------------------------------------------------------------

/**
 * One marker per blocking incident per attached node. "Blocking" is the
 * `open` + `investigating` pair (the same definition the 2D badge and
 * `store.stats()` use); resolved and cancelled incidents leave the view alone.
 *
 * A bug attached to several leaves marks each of them — the 2D badge counts
 * per node for the same reason. The *same* incident pulses in phase on every
 * leaf (`hashUnit(bug.id)`), so one problem reads as one problem; markers
 * differ only by their position.
 */
function buildBugMarkers(
  input: TreeResponse,
  positions: ReadonlyMap<string, Vec3>,
): SceneBug3D[] {
  const blocking = new Set(["open", "investigating"]);
  const bugsById = new Map(input.bugs.map((bug) => [bug.id, bug]));
  const attachments = [...input.bugAttachments].sort((a, b) =>
    a.bugId === b.bugId ? compareText(a.nodeId, b.nodeId) : compareText(a.bugId, b.bugId),
  );
  const markers: SceneBug3D[] = [];
  for (const attachment of attachments) {
    const bug = bugsById.get(attachment.bugId);
    if (bug === undefined || !blocking.has(bug.status)) continue;
    const at = positions.get(attachment.nodeId);
    if (at === undefined) continue;
    markers.push({
      id: bug.id,
      nodeId: attachment.nodeId,
      title: bug.title,
      severity: bug.severity,
      status: bug.status,
      position: [at[0], at[1] + OVERLAY_3D.bugLift, at[2]],
      phase: hashUnit(bug.id),
    });
  }
  return markers;
}

/**
 * Pulse scale of a bug marker at time `t`: `1 ± bugPulse`, period
 * {@link OVERLAY_3D.bugPeriod}, offset per incident. A blocked leaf visibly
 * throbs; a static red dot would be easy to miss among the sprites.
 */
export function bugPulseScale(bug: SceneBug3D, t: number): number {
  const angle = (t / OVERLAY_3D.bugPeriod + bug.phase) * Math.PI * 2;
  return 1 + OVERLAY_3D.bugPulse * Math.sin(angle);
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/**
 * One floating ring per goal that materialized. The ring is derived from the
 * *bounding circle* of the materialized subtree (ADR-7): centre in the middle
 * of its box, radius half its diagonal plus a margin, floating above the
 * highest node it covers — so the ring visibly owns that subtree and nothing
 * else. Its growth roll-up is the one at the materialized root — the very
 * number the 2D goal frame and the node heat use, since a goal's own record
 * joins the roll-up at exactly that node.
 */
function buildGoalRings(
  input: TreeResponse,
  positions: ReadonlyMap<string, Vec3>,
): SceneGoal3D[] {
  const index = indexTree(input.nodes);
  const rollups = growthRollups(input);
  const rings: SceneGoal3D[] = [];
  for (const goal of [...input.goals].sort(byId)) {
    const rootId = goal.materializedNodeId;
    if (rootId === null || !positions.has(rootId)) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let top = -Infinity;
    let nodeCount = 0;
    const seen = new Set<string>();
    const stack: string[] = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue; // cycle-safe: the payload is hand-editable
      seen.add(id);
      const position = positions.get(id);
      if (position !== undefined) {
        minX = Math.min(minX, position[0]);
        maxX = Math.max(maxX, position[0]);
        minZ = Math.min(minZ, position[2]);
        maxZ = Math.max(maxZ, position[2]);
        top = Math.max(top, position[1]);
        nodeCount += 1;
      }
      for (const child of index.childrenOf.get(id) ?? []) stack.push(child.id);
    }
    if (nodeCount === 0) continue;

    const halfDiagonal = Math.hypot(maxX - minX, maxZ - minZ) / 2;
    rings.push({
      id: goal.id,
      name: goal.formalText,
      status: goal.status,
      center: [(minX + maxX) / 2, top + OVERLAY_3D.goalLift, (minZ + maxZ) / 2],
      radius: Math.max(OVERLAY_3D.goalMinRadius, halfDiagonal + OVERLAY_3D.goalMargin),
      nodeCount,
      growth: rollups.get(rootId) ?? null,
      phase: hashUnit(goal.id),
    });
  }
  return rings;
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

/**
 * One glow halo per node whose subtree carries growth data, in the layout's
 * own breadth order (deterministic by construction). The heat is the shared
 * roll-up ratio; nodes with no growth data anywhere below them get no halo at
 * all, which keeps "no data" (nothing on screen) distinct from "0 % done"
 * (a dim ring) — the G5 rule the 2D heat layer follows too.
 */
function buildGrowthHalos(
  model: Scene3DModel,
  rollups: ReadonlyMap<string, GrowthRollup>,
): SceneGrowth3D[] {
  const halos: SceneGrowth3D[] = [];
  for (const node of model.nodes) {
    const rollup = rollups.get(node.id);
    if (rollup === undefined) continue;
    halos.push({
      nodeId: node.id,
      position: node.position,
      heat: rollup.ratio,
      completed: rollup.completed,
      total: rollup.total,
      failed: rollup.failed,
      records: rollup.records,
      phase: hashUnit(node.id),
    });
  }
  return halos;
}

/**
 * Halo scale of a growth ratio: a ring around a node grows with the share of
 * its subtree's steps that are done (`haloMinScale … haloMinScale + span`), so
 * size carries the same story the colour does.
 */
export function haloScale(heat: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(heat) ? heat : 0));
  return OVERLAY_3D.haloMinScale + clamped * OVERLAY_3D.haloScaleSpan;
}

/**
 * One breathing-opacity value for the whole growth layer at time `t`: the
 * scene writes it to a single material, so a thousand halos glow for the price
 * of one uniform (never a per-halo frame loop).
 */
export function growthGlow(t: number): number {
  const angle = (t / OVERLAY_3D.glowPeriod) * Math.PI * 2;
  return OVERLAY_3D.glowBase + OVERLAY_3D.glowAmplitude * Math.sin(angle);
}

// ---------------------------------------------------------------------------
// Tooltips (the I3 acceptance: a bee names its status and revision)
// ---------------------------------------------------------------------------

/** Longest text the tooltip copies from the payload, in characters. */
export const TOOLTIP_NAME_LIMIT = 70;

/** Truncates a payload string for a tooltip, with an explicit ellipsis. */
export function truncate(text: string, limit = TOOLTIP_NAME_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** Tooltip of a bee: status, revision and what the influence means. */
export function beeTipText(bee: SceneBee3D): string {
  const impact = bee.impact.trim();
  return `Bee · ${bee.status} · r${bee.revision}${impact.length > 0 ? ` · ${truncate(impact, 48)}` : ""}`;
}

/** Tooltip of a blocking incident: severity, status and its title. */
export function bugTipText(bug: SceneBug3D): string {
  return `Bug · ${bug.severity} · ${bug.status} · ${truncate(bug.title)}`;
}

/** Tooltip of a goal: status, progress and the formal task. */
export function goalTipText(goal: SceneGoal3D): string {
  const steps =
    goal.growth === null || goal.growth.records === 0
      ? "no growth data"
      : `${goal.growth.completed}/${goal.growth.total} steps`;
  return `Goal · ${goal.status} · ${steps} · ${truncate(goal.name)}`;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * A stable value in `[0, 1)` for an id (FNV-1a, then normalised). Phases must
 * be *deterministic*: `Math.random()` would reshuffle the swarm on every SSE
 * refetch (H1), and a fixture test could never pin an animation.
 */
export function hashUnit(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100_000 / 100_000;
}

/** Id order (the determinism rule of `graph.ts`, reused here). */
function byId<T extends { id: string }>(a: T, b: T): number {
  return compareText(a.id, b.id);
}

/** Locale-free string order — `localeCompare` would differ per environment. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
