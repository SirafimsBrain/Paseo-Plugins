/**
 * Lazy 3D entry of the dashboard (PLAN.md stage I1).
 *
 * This file is a **separate esbuild entry** (`dist/dashboard/assets/dashboard-3d.js`,
 * `scripts/bundle.mjs`) precisely so that `three`, `@react-three/fiber` and
 * `@react-three/drei` never reach the first chunk: `app.tsx` reaches it only
 * through a dynamic `import()`, after the user asks for the 3D view and the
 * WebGL probe passed. Sharing React with the main bundle is why the build
 * switched to esbuild code splitting — two copies of React in one page would
 * break every hook (the "Invalid hook call" failure).
 *
 * Stage I1 is the spike: an **empty scene with orbit controls**, enough to
 * answer "does WebGL render in this tab" and "does the fallback work". The
 * tree geometry (I2), links and goals (I3) and picking/focus (I4) build on
 * this entry; nothing here reads the project data yet.
 *
 * The module exposes an imperative `mountScene3D` rather than a global: the
 * caller owns the container, so switching back to 2D is a plain `dispose()`
 * and the page keeps exactly one scene.
 */
import { Canvas, createRoot } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { ReactElement } from "react";

/** Handle returned to the caller; `dispose()` is idempotent. */
export interface Scene3DHandle {
  dispose(): void;
}

/**
 * The spike scene: lights, a reference grid and orbit controls — a viewport
 * the eye can read as three-dimensional (the acceptance is "an empty scene
 * with OrbitControls renders"), with no project data yet.
 */
function EmptyScene(): ReactElement {
  return (
    <>
      <color attach="background" args={["#10131a"]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 8, 4]} intensity={1.2} />
      {/* 20-unit grid, default colours: scale and horizon at a glance. */}
      <gridHelper args={[20, 20]} />
      <axesHelper args={[2]} />
      <OrbitControls makeDefault target={[0, 0, 0]} />
    </>
  );
}

/**
 * Renders the spike scene into `container` (which must be laid out — the
 * `.lp-scene3d` cell is sized by the app grid) and returns the handle that
 * tears it down: the r3f root unmounts, its animation loop and renderer stop
 * with it, and the container is emptied so a later mount starts clean.
 *
 * Throws only if r3f cannot create a renderer at all (no WebGL despite the
 * probe, or a lost context); the caller turns that into a status line and
 * falls back to 2D.
 */
export function mountScene3D(container: HTMLElement): Scene3DHandle {
  // Inferred rather than annotated: `ReconcilerRoot` is generic over the
  // canvas element type, and the inference from `container` is exact.
  const root = createRoot(container);
  root.render(
    <CanvasShell>
      <EmptyScene />
    </CanvasShell>,
  );
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.unmount();
      container.replaceChildren();
    },
  };
}

/** Canvas defaults for the spike: device-pixel-ratio aware, antialiased. */
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
