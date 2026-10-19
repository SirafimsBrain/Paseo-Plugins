/**
 * Lazy 3D entry of the dashboard (PLAN.md stages I1, I2).
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
 * single draw call (the I2 budget). Colours are not duplicated here: the
 * scene imports the same `colors.ts` palette the 2D legend renders.
 *
 * The module exposes an imperative `mountScene3D` rather than a global: the
 * caller owns the container, hands the model in through `setModel`, and
 * switching back to 2D is a plain `dispose()` — the page keeps exactly one
 * scene. `setModel(null)` (tree not loaded yet) shows the I1 spike scene:
 * lights, grid and orbit controls, never a black viewport.
 */
import { Canvas, createRoot, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import * as THREE from "three";
import { KIND_COLORS, STATUS_COLORS } from "./colors";
import { LAYOUT_3D, type Scene3DModel, type SceneNode3D } from "./tree-3d";

/** Handle returned to the caller; `dispose()` is idempotent. */
export interface Scene3DHandle {
  /** Hands the tree layout to the scene; `null` shows the spike scene. */
  setModel(model: Scene3DModel | null): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Model store: `setModel` from the outside, React state on the inside.
// ---------------------------------------------------------------------------

interface ModelStore {
  get(): Scene3DModel | null;
  subscribe(listener: () => void): () => void;
  set(model: Scene3DModel | null): void;
}

function createModelStore(initial: Scene3DModel | null): ModelStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(model) {
      if (current === model) return;
      current = model;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Routes the store's current model into the right scene. */
function SceneView(props: { store: ModelStore }): ReactElement {
  const model = useSyncExternalStore(props.store.subscribe, props.store.get);
  return model === null ? <SpikeScene /> : <TreeScene model={model} />;
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

/** The I2 tree: grid sized to the model, root spheres, tubes, leaf sprites. */
function TreeScene(props: { model: Scene3DModel }): ReactElement {
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
    >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial side={THREE.DoubleSide} toneMapped={false} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Mount / dispose
// ---------------------------------------------------------------------------

/**
 * Renders into `container` (which must be laid out — the `.lp-scene3d` cell
 * is sized by the app grid) and returns the handle that tears it down: the
 * r3f root unmounts, its animation loop and renderer stop with it, and the
 * container is emptied so a later mount starts clean.
 *
 * Throws only if r3f cannot create a renderer at all (no WebGL despite the
 * probe, or a lost context); the caller turns that into a status line and
 * falls back to 2D.
 */
export function mountScene3D(container: HTMLElement): Scene3DHandle {
  const store = createModelStore(null);
  const root = createRoot(container);
  root.render(
    <CanvasShell>
      <SceneView store={store} />
    </CanvasShell>,
  );
  let disposed = false;
  return {
    setModel(model: Scene3DModel | null): void {
      if (disposed) return;
      store.set(model);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.unmount();
      container.replaceChildren();
    },
  };
}

/** Canvas defaults: device-pixel-ratio aware, antialiased. */
function CanvasShell(props: { children: ReactElement }): ReactElement {
  return (
    <Canvas
      camera={{ position: [4, 3, 6], fov: 50 }}
      dpr={[1, 2]}
      gl={{ antialias: true }}
    >
      {props.children}
    </Canvas>
  );
}
