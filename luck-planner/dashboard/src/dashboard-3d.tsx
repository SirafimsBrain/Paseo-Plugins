/**
 * Lazy 3D entry of the dashboard (PLAN.md stages I1, I2, I3).
 *
 * This file is a **separate esbuild entry** (`dist/dashboard/assets/dashboard-3d.js`,
 * `scripts/bundle.mjs`) precisely so that `three`, `@react-three/fiber` and
 * `@react-three/drei` never reach the first chunk: `app.tsx` reaches it only
 * through a dynamic `import()`, after the user asks for the 3D view and the
 * WebGL probe passed. Sharing React with the main bundle is why the build
 * uses esbuild code splitting — two copies of React in one page would break
 * every hook (the "Invalid hook call" failure).
 *
 * Stage I1 was the spike (probe + fallback + empty scene). Stage I2 draws the
 * tree itself from the pure radial layout in `dashboard/src/tree-3d.ts`:
 * the tech-stack root is a sphere at the cone's apex, every other node hangs
 * from its parent by a straight tube whose radius follows the subtree leaf
 * count, and leaves are billboarding sprites tinted by their status — one
 * `InstancedMesh` for all of them, which is what keeps 5–10k leaves to a
 * single draw call (the I2 budget).
 *
 * Stage I3 draws the four domain layers on top, from the pure overlay in
 * `dashboard/src/overlay-3d.ts` — the scene still *renders*, it never decides
 * a position or a phase:
 * - bees fly curved arcs between the leaves they connect (honey-coloured
 *   particles, one instanced draw call), each frozen while hovered so its
 *   tooltip — status and revision — stays readable;
 * - blocking incidents pulse above the leaves they block (instanced);
 * - goals float a ring above the subtree they materialized;
 * - growth halos glow around nodes with growth data, one additive-blended
 *   instanced ring whose **opacity** (never a per-node loop) breathes.
 *
 * The per-frame cost is therefore O(bees + bugs) plus a handful of uniform
 * writes — it does not grow with the node count (the I3 frame budget,
 * measured in `tests/dashboard-overlay-3d.test.ts`).
 *
 * The module exposes an imperative `mountScene3D` rather than a global: the
 * caller owns the container, hands the layout and its overlay in through
 * `setScene`, and switching back to 2D is a plain `dispose()` — the page keeps
 * exactly one scene. `setScene(null, …)` (tree not loaded yet) shows the I1
 * spike scene: lights, grid and orbit controls, never a black viewport.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import * as THREE from "three";
import {
  BEE_STATUS_COLORS,
  BUG_BADGE_COLOR,
  GOAL_STATUS_COLORS,
  heatColor,
  KIND_COLORS,
  STATUS_COLORS,
} from "./colors";
import {
  beeArcPoint,
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
import { LAYOUT_3D, type Scene3DModel, type SceneNode3D } from "./tree-3d";

/** Handle returned to the caller; `dispose()` is idempotent. */
export interface Scene3DHandle {
  /**
   * Hands the tree layout and its overlay to the scene; a `null` model shows
   * the spike scene. Both move together because they are one view of one
   * payload — two setters could be called in an order that renders an overlay
   * against the previous tree.
   */
  setScene(model: Scene3DModel | null, overlay: Scene3DOverlay | null): void;
  dispose(): void;
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
}

interface SceneStore {
  get(): SceneState;
  subscribe(listener: () => void): () => void;
  set(state: SceneState): void;
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
  };
}

/** Routes the store's current scene into the right view. */
function SceneView(props: { store: SceneStore }): ReactElement {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get);
  return state.model === null ? <SpikeScene /> : <TreeScene model={state.model} overlay={state.overlay} />;
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
 * The tree (I2) plus its four overlays (I3).
 *
 * The hover tooltip is owned here, not by each overlay: only one can be under
 * the pointer, and one `<Html>` mount per hover keeps the per-frame cost of
 * the label at zero (it follows its position because the overlay hands over a
 * *static* point — bees freeze while hovered, bugs and rings do not move).
 */
function TreeScene(props: {
  model: Scene3DModel;
  overlay: Scene3DOverlay;
}): ReactElement {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const onHover = useCallback((info: HoverInfo | null): void => {
    setHover(info);
  }, []);

  const grid = useMemo(() => {
    const size = Math.max(20, Math.ceil((props.model.radius * 2.2) / 10) * 10);
    return { size, divisions: size / 2 };
  }, [props.model]);
  return (
    <>
      <color attach="background" args={["#10131a"]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 8, 4]} intensity={1.2} />
      <gridHelper args={[grid.size, grid.divisions]} />
      <CameraFit model={props.model} />
      {props.model.roots.map((root) => (
        <RootSphere key={root.id} node={root} />
      ))}
      {props.model.edges.map((edge) => (
        <Tube key={edge.id} edge={edge} />
      ))}
      <LeafSprites nodes={props.model.leaves} />
      <GoalRings goals={props.overlay.goals} onHover={onHover} />
      <GrowthHalos halos={props.overlay.growth} />
      <BugMarkers bugs={props.overlay.bugs} onHover={onHover} />
      <BeeSwarm bees={props.overlay.bees} onHover={onHover} />
      {hover === null ? null : (
        <Html position={hover.position} center distanceFactor={18} className="lp-tip">
          {hover.text}
        </Html>
      )}
      <OrbitControls makeDefault target={[0, props.model.height * 0.45, 0]} />
    </>
  );
}

/**
 * Frames the model once, when it arrives — not per frame: after the user has
 * orbited, a re-frame would fight the hand on the mouse, so the fit runs
 * only on a model change (a refetch of the same tree keeps the camera).
 */
function CameraFit(props: { model: Scene3DModel }): null {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: THREE.Vector3; update(): void }
    | null;
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
  }, [props.model, camera, controls]);
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
 * One parent→child tube, oriented along the segment. The cylinder's local +Y
 * is aligned to the direction by a quaternion, so the tube is exactly as long
 * as the gap and meets both nodes without z-fighting.
 */
function Tube(props: {
  edge: { from: readonly [number, number, number]; to: readonly [number, number, number]; radius: number; kind: SceneNode3D["kind"] };
}): ReactElement {
  const placement = useMemo(() => {
    const from = new THREE.Vector3(...props.edge.from);
    const to = new THREE.Vector3(...props.edge.to);
    const direction = to.clone().sub(from);
    const length = direction.length();
    const midpoint = from.clone().add(direction.multiplyScalar(0.5));
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.clone().normalize(),
    );
    return {
      position: midpoint.toArray() as [number, number, number],
      quaternion: quaternion.toArray() as [number, number, number, number],
      length: Math.max(length, 0.001),
    };
  }, [props.edge]);
  return (
    <mesh position={placement.position} quaternion={placement.quaternion}>
      <cylinderGeometry
        args={[props.edge.radius, props.edge.radius, placement.length, 8]}
      />
      <meshStandardMaterial color={KIND_COLORS[props.edge.kind]} />
    </mesh>
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
 * come from the same palette the 2D legend shows.
 *
 * `raycast` is disabled: 10k instances would be re-tested on every pointer
 * move for a hit nobody can act on (I3 only needs the small overlays to be
 * hoverable). I4, which makes nodes clickable, must revisit that deliberately.
 */
function LeafSprites(props: { nodes: readonly SceneNode3D[] }): ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const nodes = props.nodes;

  // Static part of the frame: translation + status colour, once per model.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      matrix.makeTranslation(node.position[0], node.position[1], node.position[2]);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, color.set(STATUS_COLORS[node.status]));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [nodes]);

  // Billboard part: the same translation with the camera's orientation.
  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(LAYOUT_3D.leafMarker, LAYOUT_3D.leafMarker, 1),
    }),
    [],
  );
  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (mesh === null) return;
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
      props.onHover({ position: [...bug.position] as [number, number, number], text: bugTipText(bug) });
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
      <meshStandardMaterial color={BUG_BADGE_COLOR} emissive={BUG_BADGE_COLOR} emissiveIntensity={0.5} />
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
 * Renders into `container` (which must be laid out — the `.lp-scene3d` cell is
 * sized by the app grid) and returns the handle that tears it down.
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
  onError?: (detail: string) => void,
): Scene3DHandle {
  const store = createSceneStore({ model: null, overlay: EMPTY_OVERLAY });
  const root = createReactRoot(container);
  root.render(
    <SceneErrorBoundary onError={onError}>
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
    setScene(model: Scene3DModel | null, overlay: Scene3DOverlay | null): void {
      if (disposed) return;
      store.set({ model, overlay: overlay ?? EMPTY_OVERLAY });
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
