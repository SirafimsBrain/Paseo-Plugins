/**
 * The 3D scene (PLAN.md stages I1–I4).
 *
 * The scene is a **renderer**, never a decision maker: the layout arrives
 * ready-made from the eager chunk (`dashboard/src/tree-3d.ts`), the links
 * arrive ready-made from `dashboard/src/overlay-3d.ts`, and the interaction
 * state arrives ready-made from `dashboard/src/pick-3d.ts`. The scene draws
 * them, animates them and reports what the user did.
 *
 * That boundary is what keeps the first chunk small (the lazy entry carries
 * three.js and nothing else) and what makes the whole 3D behaviour testable
 * without a DOM: every rule — where a node is, which link belongs to the
 * selection, what a click hits, where the camera flies — lives in a pure
 * module next to it.
 *
 * What the scene owns:
 * - the **drawing**: one instanced mesh for the leaves, one for the tubes,
 *   one for the bees, one for the incident markers, one for the growth
 *   halos, plus the few goal rings (stage I2/I3). The tube mesh is the I4
 *   change: one draw call for the whole tree instead of one per edge, which
 *   is what keeps a 10 000-node scene cheap;
 * - the **animation**: the per-frame work is O(links), never O(nodes) — the
 *   node positions are written once, and only the bees, the incident
 *   markers and one shared opacity move;
 * - the **interaction** (stage I4): a click is turned into a ray and handed
 *   to the pure picker (the 10 000-instance meshes stay out of three.js'
 *   raycast path — they are `raycast={() => null}`), the selection is drawn
 *   as a ring, a label and the highlighted links, and a search request flies
 *   the camera to the node;
 * - the **lifecycle**: `mountScene3D` returns a handle, `dispose()` unmounts
 *   the root and empties the cell, so switching back to 2D leaves no
 *   renderer, no animation loop and no canvas behind.
 *
 * The mount is a plain ReactDOM root around r3f's `<Canvas>` — r3f's own
 * `createRoot` is a different API (it expects a *canvas* element), and
 * `<Canvas>` is the component that creates the canvas, measures its parent
 * and keeps the renderer in step with resizes.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import * as THREE from "three";
import {
  BEE_STATUS_COLORS,
  BUG_BADGE_COLOR,
  GOAL_STATUS_COLORS,
  heatColor,
  KIND_COLORS,
  SELECTION_COLOR,
  STATUS_COLORS,
} from "./colors";
import {
  beeArcPoint,
  beeArcPoints,
  beeProgress,
  beeTipText,
  bugPulseScale,
  bugTipText,
  EMPTY_OVERLAY,
  goalTipText,
  growthGlow,
  haloScale,
  OVERLAY_3D,
  type Scene3DOverlay,
  type SceneBee3D,
  type SceneBug3D,
  type SceneGoal3D,
  type SceneGrowth3D,
} from "./overlay-3d";
import {
  EMPTY_INTERACTION,
  pickNode,
  type PickCandidate,
  type SceneInteraction,
  type SelectionHighlight,
} from "./pick-3d";
import {
  LAYOUT_3D,
  type Scene3DModel,
  type SceneEdge3D,
  type SceneNode3D,
} from "./tree-3d";

/** Handle returned to the caller; `dispose()` is idempotent. */
export interface Scene3DHandle {
  /**
   * Hands the tree layout and its overlay to the scene; a `null` model shows
   * the spike scene until the first payload arrives.
   *
   * `fitKey` identifies the *data*, not the layout: the camera re-frames when
   * it changes (a new tree) and stays where the user put it when it does not
   * (a live refetch, a filter that narrows the tree). Passing the model
   * object itself would re-frame on every rebuild — the camera would fight
   * the mouse on every SSE update.
   */
  setScene(model: Scene3DModel | null, overlay: Scene3DOverlay | null, fitKey: string): void;
  /**
   * Hands the interaction state over: the selection, the pickable nodes and
   * a possible camera flight. One object, one update — the scene renders it.
   */
  setInteraction(interaction: SceneInteraction): void;
  dispose(): void;
}

/** Options of {@link mountScene3D}. */
export interface SceneMountOptions {
  /**
   * Reports a renderer failure (a lost context, a driver that refuses one).
   * The app turns it into the status line and the 2D fallback.
   */
  readonly onError?: (detail: string) => void;
  /**
   * Reports a picked node — `null` when the user clicked empty space. The app
   * selects it, and the *same* details panel answers in both views.
   */
  readonly onSelect?: (id: string | null) => void;
}

/** What a hover reports: where to put the tooltip and what it says. */
interface HoverInfo {
  readonly position: [number, number, number];
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Scene store: `setScene` from the outside, React state on the inside.
// ---------------------------------------------------------------------------

interface SceneState {
  readonly model: Scene3DModel | null;
  readonly overlay: Scene3DOverlay;
  readonly interaction: SceneInteraction;
  /**
   * Identifies the *data* the model was built from. A change re-frames the
   * camera; an unchanged key keeps it where the user put it (a live refetch,
   * a filter that narrows the tree).
   */
  readonly fitKey: string;
}

interface SceneStore {
  get(): SceneState;
  subscribe(listener: () => void): () => void;
  set(state: SceneState): void;
  /** The callbacks the scene calls back into (kept out of React state). */
  readonly callbacks: {
    onSelect: (id: string | null) => void;
    onError: (detail: string) => void;
  };
}

function createSceneStore(initial: SceneState): SceneStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(state) {
      if (current === state) return;
      current = state;
      for (const listener of [...listeners]) listener();
    },
    callbacks: {
      onSelect: () => {},
      onError: () => {},
    },
  };
}

/** Routes the store's current scene into the right view. */
function SceneView(props: { store: SceneStore }): ReactElement {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get);
  const onSelect = useCallback(
    (id: string | null): void => {
      props.store.callbacks.onSelect(id);
    },
    [props.store],
  );
  return state.model === null ? (
    <SpikeScene />
  ) : (
    <TreeScene
      model={state.model}
      overlay={state.overlay}
      interaction={state.interaction}
      fitKey={state.fitKey}
      onSelect={onSelect}
    />
  );
}

// ---------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------

/** Lights + orbit controls; the spike scene doubles as the "no model yet" state. */
function SpikeScene(): ReactElement {
  return (
    <>
      <color attach="background" args={["#10131a"]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 8, 4]} intensity={1.2} />
      <gridHelper args={[20, 20]} />
      <axesHelper args={[2]} />
      <OrbitControls makeDefault target={[0, 0, 0]} />
    </>
  );
}

/**
 * The tree (I2), its four overlays (I3) and the interaction (I4).
 *
 * The hover tooltip is owned here, not by each overlay: only one can be under
 * the pointer, and one `<Html>` mount per hover keeps the per-frame cost of
 * the label at zero (it follows its position because the overlay hands over a
 * *static* point — bees freeze while hovered, bugs and rings do not move).
 */
function TreeScene(props: {
  model: Scene3DModel;
  overlay: Scene3DOverlay;
  interaction: SceneInteraction;
  fitKey: string;
  onSelect: (id: string | null) => void;
}): ReactElement {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const onHover = useCallback((info: HoverInfo | null): void => {
    setHover(info);
  }, []);
  // The HTML overlays (the label of the selected node, the hover tooltip)
  // are mounted only after the scene has drawn its first frame — see
  // `SceneReady` for why.
  const [sceneReady, setSceneReady] = useState(false);
  const onSceneReady = useCallback((): void => {
    setSceneReady(true);
  }, []);

  const grid = useMemo(() => {
    const size = Math.max(20, Math.ceil((props.model.radius * 2.2) / 10) * 10);
    return { size, divisions: size / 2 };
  }, [props.model]);
  const highlight = props.interaction.highlight;
  return (
    <>
      <color attach="background" args={["#10131a"]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 8, 4]} intensity={1.2} />
      <gridHelper args={[grid.size, grid.divisions]} />
      <CameraFit model={props.model} fitKey={props.fitKey} />
      <CameraFocus focus={props.interaction.focus} />
      <SceneReady onReady={onSceneReady} />
      <Picker candidates={props.interaction.candidates} onSelect={props.onSelect} />
      {props.model.roots.map((root) => (
        <RootSphere key={root.id} node={root} />
      ))}
      <Tubes edges={props.model.edges} highlighted={highlight.edgeIds} />
      <LeafSprites nodes={props.model.leaves} highlight={highlight} />
      <HighlightedLinks bees={props.overlay.bees} ids={highlight.beeIds} />
      <GoalRings goals={props.overlay.goals} onHover={onHover} />
      <GrowthHalos halos={props.overlay.growth} />
      <BugMarkers bugs={props.overlay.bugs} onHover={onHover} />
      <BeeSwarm bees={props.overlay.bees} onHover={onHover} />
      <SelectionMarker
        position={props.interaction.selectedPosition}
        label={props.interaction.selectedLabel}
        ready={sceneReady}
      />
      {hover === null || !sceneReady ? null : (
        <Html position={hover.position} center distanceFactor={18} className="lp-tip">
          {hover.text}
        </Html>
      )}
      <OrbitControls makeDefault target={[0, props.model.height * 0.45, 0]} />
    </>
  );
}

/**
 * Frames the model once, when the data changes — not per frame: after the
 * user has orbited, a re-frame would fight the hand on the mouse, so the fit
 * runs only when the tree itself is replaced (a refetch of the same tree
 * keeps the camera).
 */
function CameraFit(props: { model: Scene3DModel; fitKey: string }): null {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update(): void }
    | null;
  const fitKey = props.fitKey;
  useEffect(() => {
    const model = props.model;
    const span = Math.max(model.radius, model.height * 0.5, 4);
    const target = new THREE.Vector3(0, model.height * 0.45, 0);
    camera.position.set(span * 1.15, model.height * 0.8 + span * 0.55, span * 1.5);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  }, [fitKey, props.model, camera, controls]);
  return null;
}

/**
 * Flies the camera to a node (stage I4 — the 3D twin of the 2D canvas'
 * `FocusController`).
 *
 * The flight keeps the current viewing direction: the user flies *to* the
 * node, the camera does not spin around it. The animation is a smoothstep
 * over 0.7 s, driven by the render clock, and it moves the orbit target with
 * the camera — otherwise the controls would fight the flight and snap back.
 */
function CameraFocus(props: { focus: SceneInteraction["focus"] }): null {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update(): void }
    | null;
  const focusRef = useRef(props.focus);
  focusRef.current = props.focus;
  const seq = props.focus?.seq ?? 0;
  const pending = useRef<{
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null>(null);
  const flight = useRef<{
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    started: number;
  } | null>(null);
  const scratch = useRef(new THREE.Vector3());

  useEffect(() => {
    const focus = focusRef.current;
    if (focus === null) return;
    const target = new THREE.Vector3(focus.position[0], focus.position[1], focus.position[2]);
    const currentTarget = controls?.target.clone() ?? new THREE.Vector3();
    const direction = camera.position.clone().sub(currentTarget);
    if (direction.lengthSq() < 1e-6) direction.set(1, 0.6, 1);
    direction.normalize();
    pending.current = {
      from: camera.position.clone(),
      to: target.clone().add(direction.multiplyScalar(focus.distance)),
      fromTarget: currentTarget,
      toTarget: target,
    };
  }, [seq, camera, controls]);

  useFrame(({ clock }) => {
    if (pending.current !== null) {
      flight.current = { ...pending.current, started: clock.elapsedTime };
      pending.current = null;
    }
    const current = flight.current;
    if (current === null) return;
    const progress = Math.min(1, (clock.elapsedTime - current.started) / 0.7);
    const eased = progress * progress * (3 - 2 * progress);
    camera.position.lerpVectors(current.from, current.to, eased);
    const target = scratch.current.lerpVectors(current.fromTarget, current.toTarget, eased);
    if (controls) {
      controls.target.copy(target);
      controls.update();
    } else {
      camera.lookAt(target);
    }
    if (progress >= 1) flight.current = null;
  });
  return null;
}

/**
 * Turns a click into a node (stage I4).
 *
 * The pointer events are handled on the canvas element, not through r3f's
 * event system: r3f raycasts every interactive object on every pointer
 * *move*, and the 10 000-instance meshes are deliberately not interactive.
 * Here one click costs one ray/sphere test over a flat candidate list —
 * exact, cheap, and it keeps the big meshes out of the raycast path.
 *
 * A drag is an orbit, not a click: the pointer's travel decides, so the
 * user can spin the tree without clearing the selection.
 */
function Picker(props: {
  candidates: readonly PickCandidate[];
  onSelect: (id: string | null) => void;
}): null {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const candidatesRef = useRef(props.candidates);
  candidatesRef.current = props.candidates;
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;

  useEffect(() => {
    const canvas = gl.domElement;
    let downX = 0;
    let downY = 0;
    let dragged = false;
    const onPointerDown = (event: PointerEvent): void => {
      downX = event.clientX;
      downY = event.clientY;
      dragged = false;
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (Math.abs(event.clientX - downX) > 4 || Math.abs(event.clientY - downY) > 4) {
        dragged = true;
      }
    };
    const onClick = (event: MouseEvent): void => {
      if (dragged) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const hit = pickNode(
        {
          origin: [
            raycaster.ray.origin.x,
            raycaster.ray.origin.y,
            raycaster.ray.origin.z,
          ],
          direction: [
            raycaster.ray.direction.x,
            raycaster.ray.direction.y,
            raycaster.ray.direction.z,
          ],
        },
        candidatesRef.current,
      );
      onSelectRef.current(hit === null ? null : hit.id);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("click", onClick);
    };
  }, [gl, camera]);

  return null;
}

/** The tech-stack root, as the sphere at the cone's apex. */
function RootSphere(props: { node: SceneNode3D }): ReactElement {
  return (
    <mesh position={props.node.position as [number, number, number]}>
      <sphereGeometry args={[LAYOUT_3D.rootRadius, 32, 24]} />
      <meshStandardMaterial color={KIND_COLORS[props.node.kind]} />
    </mesh>
  );
}

/**
 * Every tube in **one** instanced draw call.
 *
 * Stage I4's instancing pass: before it, every edge was its own `<mesh>`,
 * which is one draw call and one React element per edge — thousands of them
 * in a real project. A unit cylinder (radius 1, height 1) scaled per
 * instance by `(radius, length, radius)` and rotated by a quaternion carries
 * the whole tree in a single mesh; the thickness still follows the subtree
 * leaf count, because the scale carries it.
 *
 * The tubes that touch the selection are painted in the selection colour —
 * the 3D twin of the 2D canvas' emphasised edge.
 */
function Tubes(props: {
  edges: readonly SceneEdge3D[];
  highlighted: ReadonlySet<string>;
}): ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const edges = props.edges;
  const highlighted = props.highlighted;

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const matrix = new THREE.Matrix4();
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index]!;
      from.set(edge.from[0], edge.from[1], edge.from[2]);
      to.set(edge.to[0], edge.to[1], edge.to[2]);
      direction.subVectors(to, from);
      const length = Math.max(direction.length(), 0.001);
      position.addVectors(from, to).multiplyScalar(0.5);
      quaternion.setFromUnitVectors(up, direction.normalize());
      scale.set(edge.radius, length, edge.radius);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(
        index,
        color.set(highlighted.has(edge.id) ? SELECTION_COLOR : KIND_COLORS[edge.kind]),
      );
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [edges, highlighted]);

  if (edges.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, edges.length]}
      frustumCulled={false}
      raycast={() => null}
    >
      <cylinderGeometry args={[1, 1, 1, 8]} />
      <meshStandardMaterial />
    </instancedMesh>
  );
}

/**
 * Every leaf in **one** instanced draw call, billboarding to the camera.
 *
 * A per-`<sprite>` tree would be thousands of objects and draw calls; the
 * instanced quads share geometry and material, so the count only costs one
 * `setMatrixAt` loop — and since a shared mesh cannot carry per-instance
 * orientation, the camera quaternion is recomposed into every instance each
 * frame (one cheap loop, sub-millisecond at the 10k budget). Status colours
 * come from the same palette the 2D legend shows; the selection and the
 * nodes sharing an incident with it override the status colour (the I4
 * highlight).
 *
 * The billboard loop is skipped while the camera stands still: an idle scene
 * must not rewrite 10 000 matrices per frame for nothing.
 *
 * `raycast` is disabled: 10k instances would be re-tested on every pointer
 * move for a hit nobody can act on. The click test is the pure picker
 * instead (see `Picker`).
 */
function LeafSprites(props: {
  nodes: readonly SceneNode3D[];
  highlight: SelectionHighlight;
}): ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const nodes = props.nodes;
  const highlight = props.highlight;

  // Static part of the frame: translation + colour, once per model and once
  // per selection change.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      matrix.makeTranslation(node.position[0], node.position[1], node.position[2]);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, color.set(leafColor(node, highlight)));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [nodes, highlight]);

  // Billboard part: the same translation with the camera's orientation.
  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(LAYOUT_3D.leafMarker, LAYOUT_3D.leafMarker, 1),
    }),
    [],
  );
  const lastQuaternion = useRef<THREE.Quaternion | null>(null);
  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    // An idle camera means an idle scene: skip the rewrite.
    if (
      lastQuaternion.current !== null &&
      lastQuaternion.current.equals(camera.quaternion)
    ) {
      return;
    }
    lastQuaternion.current = camera.quaternion.clone();
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      scratch.position.set(node.position[0], node.position[1], node.position[2]);
      scratch.matrix.compose(scratch.position, camera.quaternion, scratch.scale);
      mesh.setMatrixAt(index, scratch.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (nodes.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, nodes.length]}
      frustumCulled={false}
      raycast={() => null}
    >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial side={THREE.DoubleSide} toneMapped={false} />
    </instancedMesh>
  );
}

/** The colour of one leaf: the selection wins, then the incident, then the status. */
function leafColor(node: SceneNode3D, highlight: SelectionHighlight): string {
  if (highlight.selectedId === node.id) return SELECTION_COLOR;
  if (highlight.relatedNodeIds.has(node.id)) return BUG_BADGE_COLOR;
  return STATUS_COLORS[node.status];
}

/**
 * Tells the scene that it has drawn a frame (stage I4).
 *
 * The HTML overlays of the scene — the label of the selected node and the
 * hover tooltip — are drei's `<Html>`, which portals its content into a DOM
 * element it appends to the canvas' parent. That setup happens in a layout
 * effect that is guarded by the group's ref: if the `<Html>` is mounted in
 * the *very first* render of the scene, the ref is not attached yet, the
 * effect skips the portal and never runs again — the label stays invisible
 * forever. The case is not hypothetical: it is exactly "the tab opens in 3D
 * with a node already selected" (switching back from 2D keeps the
 * selection), which is the I4 acceptance scenario.
 *
 * So the scene announces its first frame and the overlays mount after it.
 */
function SceneReady(props: { onReady: () => void }): null {
  const announced = useRef(false);
  useFrame(() => {
    if (announced.current) return;
    announced.current = true;
    props.onReady();
  });
  return null;
}

/**
 * The selected node: a ring under it and a label above it.
 *
 * The label is the 3D answer to the 2D node's caption — the name, the kind
 * and the status, in one line. It is mounted only while something is
 * selected (and only after the first frame, see `SceneReady`), so an idle
 * scene pays nothing for it.
 */
function SelectionMarker(props: {
  position: readonly [number, number, number] | null;
  label: string | null;
  ready: boolean;
}): ReactElement | null {
  if (props.position === null) return null;
  const ring: [number, number, number] = [
    props.position[0],
    props.position[1] + 0.03,
    props.position[2],
  ];
  const label: [number, number, number] = [
    props.position[0],
    props.position[1] + LAYOUT_3D.leafMarker * 2.2,
    props.position[2],
  ];
  return (
    <>
      <mesh position={ring} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <torusGeometry args={[LAYOUT_3D.leafMarker * 1.8, 0.05, 8, 32]} />
        <meshBasicMaterial color={SELECTION_COLOR} toneMapped={false} />
      </mesh>
      {props.label === null || !props.ready ? null : (
        <Html position={label} center distanceFactor={16} className="lp-node-label">
          {props.label}
        </Html>
      )}
    </>
  );
}

/**
 * The links of the selected node, drawn as curves (stage I4).
 *
 * A particle alone says "something flies here"; a curve says "this fact
 * depends on that one". The 2D canvas emphasises the edges touching the
 * selection — this is the same information in 3D, drawn along the very arcs
 * the bees fly.
 */
function HighlightedLinks(props: {
  bees: readonly SceneBee3D[];
  ids: ReadonlySet<string>;
}): ReactElement | null {
  const links = useMemo(
    () =>
      props.bees
        .filter((bee) => props.ids.has(bee.id))
        .map((bee) => ({
          id: bee.id,
          color: BEE_STATUS_COLORS[bee.status],
          points: beeArcPoints(bee, 24),
        })),
    [props.bees, props.ids],
  );
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => (
        <Line
          key={link.id}
          points={link.points}
          color={link.color}
          lineWidth={2}
          transparent
          opacity={0.9}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// I3 overlays
// ---------------------------------------------------------------------------

/**
 * Bees: one instanced particle per influence link, flying its arc.
 *
 * The animation is the pure {@link beeProgress} + {@link beeArcPoint} pair —
 * the scene only writes the result into the instance matrices. Hovering a
 * particle **freezes** it (its last arc fraction is pinned): a tooltip that
 * drifts away from the pointer is unreadable, and a frozen particle is also
 * an honest marker of *which* bee the tooltip describes. Only the hovered
 * instance mounts an `<Html>` node, so the label costs nothing while the
 * pointer is elsewhere.
 */
function BeeSwarm(props: {
  bees: readonly SceneBee3D[];
  onHover: (info: HoverInfo | null) => void;
}): ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const bees = props.bees;
  // Arc fraction per bee, refreshed every frame: the hover handler needs the
  // current one but must not recompute the whole swarm on a pointer event.
  const progressRef = useRef<Float64Array>(new Float64Array(0));
  const frozenRef = useRef<{ index: number; u: number } | null>(null);

  useEffect(() => {
    progressRef.current = new Float64Array(bees.length);
  }, [bees]);

  // Status colours: one write per bee per model, like the leaf sprites.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const color = new THREE.Color();
    for (let index = 0; index < bees.length; index += 1) {
      mesh.setColorAt(index, color.set(BEE_STATUS_COLORS[bees[index]!.status]));
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [bees]);

  const scratch = useMemo(
    () => ({ matrix: new THREE.Matrix4(), point: { x: 0, y: 0, z: 0 } }),
    [],
  );

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const t = clock.elapsedTime;
    const frozen = frozenRef.current;
    for (let index = 0; index < bees.length; index += 1) {
      const bee = bees[index]!;
      const u =
        frozen !== null && frozen.index === index ? frozen.u : beeProgress(bee, t);
      progressRef.current[index] = u;
      beeArcPoint(bee, u, scratch.point);
      scratch.matrix.makeTranslation(scratch.point.x, scratch.point.y, scratch.point.z);
      mesh.setMatrixAt(index, scratch.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  const onPointerMove = useCallback(
    (event: { instanceId?: number; stopPropagation: () => void }): void => {
      const index = event.instanceId;
      if (index === undefined || index < 0 || index >= bees.length) return;
      // Already hovering this particle (it is frozen, so nothing moved): a
      // pointer move across a still tooltip must not re-render the scene.
      if (frozenRef.current?.index === index) return;
      event.stopPropagation();
      const bee = bees[index]!;
      const u = progressRef.current[index] ?? beeProgress(bee, 0);
      frozenRef.current = { index, u };
      const at = beeArcPoint(bee, u, { x: 0, y: 0, z: 0 });
      props.onHover({ position: [at.x, at.y, at.z], text: beeTipText(bee) });
    },
    [bees, props],
  );

  const onPointerOut = useCallback((): void => {
    frozenRef.current = null;
    props.onHover(null);
  }, [props]);

  if (bees.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, bees.length]}
      frustumCulled={false}
      onPointerMove={onPointerMove}
      onPointerOut={onPointerOut}
    >
      <sphereGeometry args={[OVERLAY_3D.beeRadius, 8, 6]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

/**
 * Bugs: one instanced octahedron per blocking incident per leaf, pulsing.
 *
 * `bugPulseScale` is pure and per-instance, so the marker count is the only
 * per-frame cost — the octahedron shape (nothing else in the scene is one)
 * and the shared red keep incidents unmistakable next to the leaf sprites.
 */
function BugMarkers(props: {
  bugs: readonly SceneBug3D[];
  onHover: (info: HoverInfo | null) => void;
}): ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  // Which marker the tooltip currently describes — a pointer move over the
  // same one must not re-render the scene (see `BeeSwarm`).
  const hoverKeyRef = useRef<string | null>(null);
  const bugs = props.bugs;

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < bugs.length; index += 1) {
      const bug = bugs[index]!;
      matrix.makeTranslation(bug.position[0], bug.position[1], bug.position[2]);
      mesh.setMatrixAt(index, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [bugs]);

  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1),
      quaternion: new THREE.Quaternion(),
    }),
    [],
  );

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const t = clock.elapsedTime;
    for (let index = 0; index < bugs.length; index += 1) {
      const bug = bugs[index]!;
      const pulse = bugPulseScale(bug, t);
      scratch.position.set(bug.position[0], bug.position[1], bug.position[2]);
      scratch.scale.setScalar(pulse);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      mesh.setMatrixAt(index, scratch.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  const onPointerMove = useCallback(
    (event: { instanceId?: number; stopPropagation: () => void }): void => {
      const index = event.instanceId;
      if (index === undefined || index < 0 || index >= bugs.length) return;
      const bug = bugs[index]!;
      const key = `${bug.id}:${bug.nodeId}`;
      if (hoverKeyRef.current === key) return;
      event.stopPropagation();
      hoverKeyRef.current = key;
      props.onHover({
        position: [...bug.position] as [number, number, number],
        text: bugTipText(bug),
      });
    },
    [bugs, props],
  );

  const onPointerOut = useCallback((): void => {
    hoverKeyRef.current = null;
    props.onHover(null);
  }, [props]);

  if (bugs.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, bugs.length]}
      frustumCulled={false}
      onPointerMove={onPointerMove}
      onPointerOut={onPointerOut}
    >
      <octahedronGeometry args={[OVERLAY_3D.bugRadius, 0]} />
      <meshStandardMaterial
        color={BUG_BADGE_COLOR}
        emissive={BUG_BADGE_COLOR}
        emissiveIntensity={0.5}
      />
    </instancedMesh>
  );
}

/**
 * Goals: a horizontal ring floating above the subtree each goal materialized,
 * tinted by the goal status (the same palette as the 2D goal frame).
 *
 * Goals are few by nature (a project approves a handful at a time), so each
 * ring is its own mesh with its own hover handler — no instancing machinery
 * for something that cannot be numerous, and the tooltip can carry the goal's
 * own progress figures.
 */
function GoalRings(props: {
  goals: readonly SceneGoal3D[];
  onHover: (info: HoverInfo | null) => void;
}): ReactElement | null {
  // Hooks first, the empty case after: a refetch that brings the first goal
  // in must not break the render (a conditional hook changes the count).
  const hoverKeyRef = useRef<string | null>(null);
  if (props.goals.length === 0) return null;
  return (
    <>
      {props.goals.map((goal) => (
        <mesh
          key={goal.id}
          position={goal.center as [number, number, number]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={(event) => {
            // Same ring, same tooltip: no re-render while the pointer sweeps
            // the ring's own surface.
            if (hoverKeyRef.current === goal.id) return;
            event.stopPropagation();
            hoverKeyRef.current = goal.id;
            props.onHover({
              position: [...goal.center] as [number, number, number],
              text: goalTipText(goal),
            });
          }}
          onPointerOut={() => {
            hoverKeyRef.current = null;
            props.onHover(null);
          }}
        >
          <torusGeometry args={[goal.radius, OVERLAY_3D.goalTube, 8, 64]} />
          <meshStandardMaterial
            color={GOAL_STATUS_COLORS[goal.status]}
            transparent
            opacity={0.8}
          />
        </mesh>
      ))}
    </>
  );
}

/**
 * Growth: one additive-blended instanced ring per node with growth data (only
 * in the `growth` layer — the overlay emits an empty list otherwise).
 *
 * The rings are placed **once** (`haloScale` of the ratio, colour from the
 * shared heat ramp) and never touched per frame; the breathing is a single
 * `opacity` write on the shared material. That is the whole I3 frame budget
 * for growth: O(1), whatever the node count — and the reason 1000 nodes with
 * growth data do not cost 1000 matrix updates per frame.
 */
function GrowthHalos(props: { halos: readonly SceneGrowth3D[] }): ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const halos = props.halos;

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI / 2, 0, 0),
    );
    const color = new THREE.Color();
    for (let index = 0; index < halos.length; index += 1) {
      const halo = halos[index]!;
      const size = haloScale(halo.heat);
      position.set(halo.position[0], halo.position[1], halo.position[2]);
      scale.setScalar(size);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, color.set(heatColor(halo.heat)));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [halos]);

  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (material === null) return;
    // One uniform per frame: the whole layer breathes together.
    material.opacity = growthGlow(clock.elapsedTime);
  });

  if (halos.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, halos.length]}
      frustumCulled={false}
      raycast={() => null}
    >
      <torusGeometry args={[0.5, 0.055, 6, 32]} />
      <meshBasicMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Mount / dispose
// ---------------------------------------------------------------------------

/**
 * Renders into `container` (which must be laid out — the `.lp-scene3d` cell
 * is sized by the app grid) and returns the handle that tears it down.
 *
 * **The root is a plain ReactDOM root around `<Canvas>`, not r3f's
 * `createRoot(container)`.** They are different APIs: r3f's `createRoot`
 * expects a *canvas* element and hands it straight to `new WebGLRenderer`,
 * while `<Canvas>` is the component that creates the canvas, measures its
 * parent (`react-use-measure`) and keeps the renderer in step with resizes.
 * Passing the container div to r3f's `createRoot` therefore looked plausible
 * and failed at the first frame with "canvas.getContext is not a function" —
 * a real bug found by the stage-I3 live check in a browser, invisible to the
 * artifact tests. The scene still lives in its own root so its lifecycle is
 * independent of the app's tree, and `dispose()` unmounts that root, stops the
 * animation loop with it and empties the cell.
 *
 * Failures are reported through the optional `onError` (an error boundary
 * around the canvas catches whatever the renderer throws — a lost context, a
 * driver that refuses one), and `mount` itself throws only on a synchronous
 * failure; `ThreeView` turns either into the status line and the 2D fallback.
 */
export function mountScene3D(
  container: HTMLElement,
  options: SceneMountOptions = {},
): Scene3DHandle {
  const store = createSceneStore({
    model: null,
    overlay: EMPTY_OVERLAY,
    interaction: EMPTY_INTERACTION,
    fitKey: "",
  });
  store.callbacks.onSelect = options.onSelect ?? ((): void => {});
  store.callbacks.onError = options.onError ?? ((): void => {});
  const root = createReactRoot(container);
  root.render(
    <SceneErrorBoundary onError={options.onError}>
      <Canvas
        camera={{ position: [4, 3, 6], fov: 50 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <SceneView store={store} />
      </Canvas>
    </SceneErrorBoundary>,
  );
  let disposed = false;
  return {
    setScene(
      model: Scene3DModel | null,
      overlay: Scene3DOverlay | null,
      fitKey: string,
    ): void {
      if (disposed) return;
      const current = store.get();
      store.set({
        model,
        overlay: overlay ?? EMPTY_OVERLAY,
        interaction: current.interaction,
        fitKey,
      });
    },
    setInteraction(interaction: SceneInteraction): void {
      if (disposed) return;
      const current = store.get();
      store.set({ ...current, interaction });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.unmount();
      container.replaceChildren();
    },
  };
}

/**
 * Turns a renderer failure into a status line instead of a broken tab.
 *
 * `<Canvas>` re-throws anything its internal render hits, and a WebGL context
 * can die long after the probe passed (driver eviction, context-limit eviction
 * — the reason the probe releases its own). Without this boundary the error
 * would escape into React's global handler and the tab would sit on a dead 3D
 * cell; with it, the app falls back to the diagram that works (the I1 rule).
 */
class SceneErrorBoundary extends Component<
  { readonly onError?: (detail: string) => void; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error instanceof Error ? error.message : String(error));
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
