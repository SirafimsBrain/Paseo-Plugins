/**
 * The details panel (PLAN.md stage G4). G1 laid out the region; G4 fills it
 * with the real `/api/node/:id` payload the app fetches when a node is
 * selected on the canvas — the same shape the native panel renders
 * (`nodeDetail` RPC output, validated once by the shared zod schema).
 *
 * Content, top to bottom: the node itself (kind glyph, name, breadcrumb
 * path, status dot **plus text**, `v{version} · r{revision}`, last update),
 * growth progress when the node has a growth record, the incidents that
 * block it (open/investigating first — the "blockers" half of the G4
 * acceptance scenario), every incident attached to it, its influence bees
 * with the counterpart's *name* (resolved by the app from the loaded tree)
 * and the impact text, its direct children, and the latest history rows.
 *
 * Every status/severity is spelled out in text next to its colour — the
 * same accessibility rule the diagram follows.
 */
import { useCallback, useRef } from "react";
import { NodeDetailContent } from "./NodeDetailContent";
import type { ReactElement, ReactNode } from "react";
import type { NodeResponse } from "../../../shared/api";
import { growthProgress } from "../../../shared/growth";
import {
  BEE_STATUS_COLORS,
  BEE_STATUS_LABELS,
  BUG_BADGE_COLOR,
  KIND_COLORS,
  KIND_GLYPHS,
  KIND_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "../colors";

/** Props of the details panel. */
export interface DetailsPanelProps {
  /** The fetched node detail, or `null` when nothing is selected. */
  readonly detail: NodeResponse | null;
  /** Whether the detail request is in flight. */
  readonly loading: boolean;
  /** Non-fatal fetch error, rendered in place of the content. */
  readonly error: string;
  /** Resolves a node id to its display name (falls back to a short id). */
  readonly resolveName: (id: string) => string;
  /**
   * The panel's current width in pixels. The panel is **resizable**: the
   * user drags its left edge, and the width survives a reload.
   */
  readonly width: number;
  /** Reports a new width while the user drags the edge. */
  readonly onWidthChange: (width: number) => void;
  /** Reports the width once the drag ends — the moment to persist it. */
  readonly onWidthCommit: (width: number) => void;
  /** Restores the default width (double-click on the edge). */
  readonly onWidthReset: () => void;
}

/** "18.10.2026, 14:03" — short local timestamp for the history rows. */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One labelled field row. */
function Row(props: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="lp-details-row">
      <span className="lp-details-row-label">{props.label}</span>
      <span className="lp-details-row-value">{props.children}</span>
    </div>
  );
}

/**
 * The drag edge that resizes the panel.
 *
 * Pointer events, not mouse events: a touch or a pen drags the same way. The
 * move and release listeners live on the **window**, not on the handle: the
 * pointer leaves the seven-pixel edge long before the user stops moving, and
 * the drag must survive that.
 *
 * The panel sits on the right, so dragging its left edge *left* makes it
 * wider — the delta is therefore inverted. The width is clamped by the app
 * (it knows the bounds); a double-click restores the default.
 */
function ResizeHandle(props: {
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  onWidthReset: () => void;
}): ReactElement {
  const start = useRef<{ x: number; width: number } | null>(null);
  const last = useRef(props.width);

  const onPointerMove = useCallback(
    (event: PointerEvent): void => {
      const origin = start.current;
      if (origin === null) return;
      // The panel is on the right: the pointer moving left widens it.
      const next = origin.width + (origin.x - event.clientX);
      last.current = next;
      props.onWidthChange(next);
    },
    [props],
  );

  const stop = useCallback((): void => {
    if (start.current === null) return;
    start.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    props.onWidthCommit(last.current);
  }, [onPointerMove, props]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      start.current = { x: event.clientX, width: props.width };
      last.current = props.width;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [onPointerMove, props.width, stop],
  );

  return (
    <div
      className="lp-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the details panel"
      aria-valuenow={Math.round(props.width)}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={props.onWidthReset}
    />
  );
}

export function DetailsPanel(props: DetailsPanelProps): ReactElement {
  const { detail, loading, error, resolveName } = props;
  return (
    <aside className="lp-details" aria-label="Node details">
      <ResizeHandle
        width={props.width}
        onWidthChange={props.onWidthChange}
        onWidthCommit={props.onWidthCommit}
        onWidthReset={props.onWidthReset}
      />
      <h2 className="lp-details-title">Details</h2>

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
        <NodeDetailContent detail={detail} resolveName={resolveName} />
      )}
    </aside>
  );
}
