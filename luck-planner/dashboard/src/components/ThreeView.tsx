/**
 * The 3D viewport of the dashboard (PLAN.md stages I1, I2).
 *
 * A deliberately small component: it owns the container cell, pulls the lazy
 * `dashboard-3d.js` chunk on mount (the WebGL probe has already passed —
 * `app.tsx` refuses the view otherwise, see `planViewSwitch`), mounts the
 * scene into the container and disposes it on unmount, so switching back to
 * 2D leaves no renderer, no animation loop and no canvas behind.
 *
 * Stage I2 adds the data path: the app builds the radial layout
 * (`dashboard/src/tree-3d.ts`, pure) from the loaded tree and hands it to
 * this component, which forwards it into the mounted scene through
 * `handle.setModel` — once when the scene appears, and again on every layout
 * change, without ever remounting the renderer.
 *
 * Every outcome is reported through `onSceneState`, which keeps the app's
 * single status line honest: "Loading the 3D view…" while the chunk arrives,
 * a cleared line once the scene renders, and the failure text (which also
 * sends the tab back to 2D) if the chunk or the renderer refuses. Nothing in
 * here is a value import from `../dashboard-3d` — only types are, so the
 * main chunk keeps just this loader.
 */
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { Scene3DHandle } from "../dashboard-3d";
import type { Scene3DModel } from "../tree-3d";
import {
  THREE_LOADING_STATUS,
  WEBGL_UNAVAILABLE_HINT,
  threeFailedStatus,
  type WebGLSupport,
} from "../webgl";

/** Lifecycle of the viewport, as the app status line sees it. */
export type ThreeViewState = "loading" | "ready" | "failed";

export interface ThreeViewProps {
  /** Result of the one-shot probe; a `false` value never starts a scene. */
  readonly webgl: WebGLSupport;
  /**
   * The tree layout to draw (`null` while the project is still loading —
   * the scene then shows the I1 spike scene instead of a black viewport).
   * A new layout object is forwarded to the live scene; it never remounts.
   */
  readonly model: Scene3DModel | null;
  /**
   * Reports the state change. `loading` carries its status text, `ready`
   * clears the line, `failed` carries the reason — and the app falls back to
   * 2D on that state (the I1 fallback, second half).
   */
  readonly onSceneState: (state: ThreeViewState, status: string) => void;
}

export function ThreeView(props: ThreeViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<Scene3DHandle | null>(null);
  // The callback and the latest model are read from refs: the mount effect
  // deliberately runs once (a remount would restart the scene), and the
  // model effect must not re-run the mount either.
  const stateRef = useRef(props.onSceneState);
  stateRef.current = props.onSceneState;
  const modelRef = useRef(props.model);
  modelRef.current = props.model;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (!props.webgl.ok) {
      // Defensive: the app gates the switch, but a lost context can appear
      // after the probe (driver eviction) — never mount into a dead context.
      stateRef.current("failed", WEBGL_UNAVAILABLE_HINT);
      return;
    }

    let cancelled = false;
    stateRef.current("loading", THREE_LOADING_STATUS);

    import("../dashboard-3d")
      .then((module) => {
        if (cancelled) return;
        const handle = module.mountScene3D(container);
        handleRef.current = handle;
        handle.setModel(modelRef.current);
        stateRef.current("ready", "");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        stateRef.current(
          "failed",
          threeFailedStatus(cause instanceof Error ? cause.message : String(cause)),
        );
      });

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [props.webgl.ok]);

  // Data path (I2): forward every layout change into the mounted scene. Before
  // the chunk arrived the handle is null — the mount effect seeds the model
  // from the ref, so nothing is lost.
  useEffect(() => {
    handleRef.current?.setModel(props.model);
  }, [props.model]);

  return (
    <div
      className="lp-scene3d"
      ref={containerRef}
      role="img"
      aria-label="3D scene"
    />
  );
}
