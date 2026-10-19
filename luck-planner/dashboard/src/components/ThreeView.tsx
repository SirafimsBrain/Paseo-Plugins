/**
 * The 3D viewport of the dashboard (PLAN.md stages I1, I2, I3, I4).
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
 * `handle.setScene` — once when the scene appears, and again on every layout
 * change, without ever remounting the renderer. Stage I3 rides in the same
 * pair: the overlay (`dashboard/src/overlay-3d.ts`) is passed alongside the
 * layout, because a model and the links on it are one view of one payload.
 *
 * Stage I4 adds the interaction: the selection, the pickable nodes and a
 * camera request travel in one `SceneInteraction` object
 * (`dashboard/src/pick-3d.ts`), and a click in the scene comes back as
 * `onSelectNode` — the *same* setter the 2D canvas uses, so both views fill
 * the same details panel.
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
import type { Scene3DOverlay } from "../overlay-3d";
import type { SceneInteraction } from "../pick-3d";
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
   * The link/incident/goal/growth overlays of the same payload (stage I3),
   * computed by `dashboard/src/overlay-3d.ts`. Forwarded together with the
   * model — they describe one view of one payload.
   */
  readonly overlay: Scene3DOverlay | null;
  /**
   * Identifies the data the model was built from. The scene re-frames the
   * camera when it changes and keeps the camera where the user left it when
   * it does not (a live refetch must not yank the view).
   */
  readonly fitKey: string;
  /**
   * The interaction state (stage I4): the selection, the pickable nodes and
   * a possible camera flight. One object, one update.
   */
  readonly interaction: SceneInteraction;
  /**
   * Reports a node the user clicked in the scene (`null` for empty space).
   * The app selects it — the same selection the 2D canvas sets, so the same
   * details panel answers in both views.
   */
  readonly onSelectNode: (id: string | null) => void;
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
  const selectRef = useRef(props.onSelectNode);
  selectRef.current = props.onSelectNode;
  // The scene arrives as a pair (layout + overlay); both are read from refs so
  // the mount effect keeps running exactly once.
  const sceneRef = useRef({ model: props.model, overlay: props.overlay, fitKey: props.fitKey });
  sceneRef.current = { model: props.model, overlay: props.overlay, fitKey: props.fitKey };
  const interactionRef = useRef(props.interaction);
  interactionRef.current = props.interaction;

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
        const handle = module.mountScene3D(container, {
          onError: (detail) => {
            // A renderer that dies after the probe passed (lost context, driver
            // eviction): the scene reports it, the app leaves 3D.
            if (!cancelled) stateRef.current("failed", threeFailedStatus(detail));
          },
          onSelect: (id) => {
            if (!cancelled) selectRef.current(id);
          },
        });
        handleRef.current = handle;
        handle.setScene(
          sceneRef.current.model,
          sceneRef.current.overlay,
          sceneRef.current.fitKey,
        );
        handle.setInteraction(interactionRef.current);
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

  // Data path (I2/I3): forward every layout/overlay change into the mounted
  // scene. Before the chunk arrived the handle is null — the mount effect
  // seeds the scene from the ref, so nothing is lost.
  useEffect(() => {
    handleRef.current?.setScene(props.model, props.overlay, props.fitKey);
  }, [props.model, props.overlay, props.fitKey]);

  // Interaction path (I4): the selection and the camera request.
  useEffect(() => {
    handleRef.current?.setInteraction(props.interaction);
  }, [props.interaction]);

  return (
    <div
      className="lp-scene3d"
      ref={containerRef}
      role="img"
      aria-label="3D scene"
    />
  );
}
