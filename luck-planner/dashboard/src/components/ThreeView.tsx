/**
 * The 3D viewport of the dashboard (PLAN.md stage I1).
 *
 * A deliberately small component: it owns the container cell, pulls the lazy
 * `dashboard-3d.js` chunk on mount (the WebGL probe has already passed —
 * `app.tsx` refuses the view otherwise, see `planViewSwitch`), mounts the
 * scene into the container and disposes it on unmount, so switching back to
 * 2D leaves no renderer, no animation loop and no canvas behind.
 *
 * Every outcome is reported through `onSceneState`, which keeps the app's
 * single status line honest: "Loading the 3D view…" while the chunk arrives,
 * a cleared line once the scene renders, and the failure text (which also
 * sends the tab back to 2D) if the chunk or the renderer refuses. Nothing in
 * here is a value import from `../dashboard-3d` — only the type is, so the
 * main chunk keeps just this loader.
 */
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { Scene3DHandle } from "../dashboard-3d";
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
   * Reports the state change. `loading` carries its status text, `ready`
   * clears the line, `failed` carries the reason — and the app falls back to
   * 2D on that state (the I1 fallback, second half).
   */
  readonly onSceneState: (state: ThreeViewState, status: string) => void;
}

export function ThreeView(props: ThreeViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The callback is called from an effect and a promise; the ref keeps it
  // current without re-running the effect (a remount would restart the scene).
  const stateRef = useRef(props.onSceneState);
  stateRef.current = props.onSceneState;

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
    let handle: Scene3DHandle | null = null;
    stateRef.current("loading", THREE_LOADING_STATUS);

    import("../dashboard-3d")
      .then((module) => {
        if (cancelled) return;
        handle = module.mountScene3D(container);
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
      handle?.dispose();
      handle = null;
    };
  }, [props.webgl.ok]);

  return (
    <div
      className="lp-scene3d"
      ref={containerRef}
      role="img"
      aria-label="3D scene"
    />
  );
}
