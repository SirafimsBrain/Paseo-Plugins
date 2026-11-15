/**
 * The details drawer (PLAN.md stage G4, drawer since 0.54.0).
 *
 * G1 laid out the region; G4 fills it with the real `/api/node/:id` payload
 * the app fetches when a node is selected on the canvas — the same shape the
 * native panel renders (`nodeDetail` RPC output, validated once by the shared
 * zod schema).
 *
 * **Why a drawer.** The panel used to be a right-hand column. When the 2D
 * planning strip arrived it became a third grid item of a two-column body, so
 * the diagram was squeezed into the narrow column and the details took the
 * main area — the reported breakage. It is now a full-width drawer **under**
 * the diagram: closed by default (the diagram is the reason the tab is open),
 * opened by its own header button, and its height dragged from the top edge.
 * The open state lives for the browsing session, the height for good — see
 * `dashboard/src/details-panel.ts`.
 *
 * Content, top to bottom: the node itself (kind glyph, name, breadcrumb
 * path, status dot **plus text**, `v{version} · r{revision}`, last update),
 * the execution brief, growth progress, the incidents that block it, every
 * incident attached to it, its influence bees with the counterpart's *name*,
 * its direct children, and the latest history rows.
 *
 * Every status/severity is spelled out in text next to its colour — the same
 * accessibility rule the diagram follows.
 */
import { useCallback, useRef } from "react";
import { NodeDetailContent } from "./NodeDetailContent";
import type { ReactElement } from "react";
import type { NodeResponse } from "../../../shared/api";
import type { LeafStatus } from "../../../shared/tree";
import type { PlainStatusOverride } from "../plain";

/** Props of the details drawer. */
export interface DetailsPanelProps {
  /** The fetched node detail, or `null` when nothing is selected. */
  readonly detail: NodeResponse | null;
  /** Whether the detail request is in flight. */
  readonly loading: boolean;
  /** Non-fatal fetch error, rendered in place of the content. */
  readonly error: string;
  /** Resolves a node id to its display name (falls back to a short id). */
  readonly resolveName: (id: string) => string;
  /** Whether the drawer is open; `false` renders the header only. */
  readonly open: boolean;
  /** Toggles the drawer (the app persists it for the session). */
  readonly onToggle: () => void;
  /** The drawer's height in pixels while open. */
  readonly height: number;
  /** Reports a new height while the user drags the top edge. */
  readonly onHeightChange: (height: number) => void;
  /** Reports the height once the drag ends — the moment to persist it. */
  readonly onHeightCommit: (height: number) => void;
  /** Restores the default height (double-click on the edge). */
  readonly onHeightReset: () => void;
  /** Moves the selected leaf (stage L8); absent without a writable client. */
  readonly onSetStatus?: (status: LeafStatus) => void;
  /** The status whose write is in flight (L8). */
  readonly pendingStatus?: LeafStatus | null;
  /** The last write refusal for the selected node (L8). */
  readonly writeError?: string;
  /** The agent's reason for the last status move on this node (0.51.2). */
  readonly override?: PlainStatusOverride | null;
  /** Opens the incident modal from the incident list (0.51.2). */
  readonly onSelectBug?: (bugId: string) => void;
}

/**
 * The drag edge that resizes the drawer.
 *
 * Pointer events, not mouse events: a touch or a pen drags the same way. The
 * move and release listeners live on the **window**, not on the handle: the
 * pointer leaves the seven-pixel edge long before the user stops moving, and
 * the drag must survive that.
 *
 * The drawer sits at the bottom, so dragging its top edge *up* makes it
 * taller. The height is clamped by the app (it knows the bounds); a
 * double-click restores the default.
 */
function ResizeHandle(props: {
  height: number;
  onHeightChange: (height: number) => void;
  onHeightCommit: (height: number) => void;
  onHeightReset: () => void;
}): ReactElement {
  const start = useRef<{ y: number; height: number } | null>(null);
  const last = useRef(props.height);

  const onPointerMove = useCallback(
    (event: PointerEvent): void => {
      const origin = start.current;
      if (origin === null) return;
      // The drawer is at the bottom: the pointer moving up grows it.
      const next = origin.height + (origin.y - event.clientY);
      last.current = next;
      props.onHeightChange(next);
    },
    [props],
  );

  const stop = useCallback((): void => {
    if (start.current === null) return;
    start.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    props.onHeightCommit(last.current);
  }, [onPointerMove, props]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      start.current = { y: event.clientY, height: props.height };
      last.current = props.height;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [onPointerMove, props.height, stop],
  );

  return (
    <div
      className="lp-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the details drawer"
      aria-valuenow={Math.round(props.height)}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={props.onHeightReset}
    />
  );
}

export function DetailsPanel(props: DetailsPanelProps): ReactElement {
  const { detail, loading, error, resolveName } = props;
  const selected = detail === null ? "" : detail.node.name;

  return (
    <aside
      className={props.open ? "lp-details lp-details-open" : "lp-details lp-details-closed"}
      aria-label="Node details"
      style={props.open ? { height: `${props.height}px` } : undefined}
    >
      {props.open ? (
        <ResizeHandle
          height={props.height}
          onHeightChange={props.onHeightChange}
          onHeightCommit={props.onHeightCommit}
          onHeightReset={props.onHeightReset}
        />
      ) : null}

      {/*
       * The header is the drawer's whole state: a button that says what is
       * inside (the selected node, once there is one) and whether it is open.
       * It stays visible when the drawer is closed — a collapsed panel the
       * user cannot find again is worse than no panel.
       */}
      <div className="lp-details-head">
        <button
          type="button"
          className="lp-details-toggle"
          aria-expanded={props.open}
          aria-controls="lp-details-body"
          onClick={props.onToggle}
          title={
            props.open
              ? "Hide the details and give the diagram the room"
              : "Show the details of the selected node"
          }
        >
          <span className="lp-details-chevron" aria-hidden="true">
            {props.open ? "▾" : "▴"}
          </span>
          <span className="lp-details-title">Details</span>
        </button>
        {props.open ? null : (
          <span className="lp-details-summary">
            {loading
              ? "loading…"
              : selected.length > 0
                ? selected
                : "click a node on the diagram, then open the details"}
          </span>
        )}
      </div>

      {props.open ? (
        <div className="lp-details-content" id="lp-details-body">
          {error.length > 0 ? (
            <p className="lp-details-error" role="alert">
              {error}
            </p>
          ) : loading ? (
            <p className="lp-details-empty">Loading…</p>
          ) : detail === null ? (
            <p className="lp-details-empty">
              Click a node on the diagram to see its version, revision, status,
              influence links, incidents and history here.
            </p>
          ) : (
            <NodeDetailContent
              detail={detail}
              resolveName={resolveName}
              onSetStatus={props.onSetStatus}
              pendingStatus={props.pendingStatus}
              writeError={props.writeError}
              override={props.override}
              onSelectBug={props.onSelectBug}
            />
          )}
        </div>
      ) : null}
    </aside>
  );
}
