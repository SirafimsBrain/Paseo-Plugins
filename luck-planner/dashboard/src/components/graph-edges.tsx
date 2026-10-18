/**
 * Custom edge renderers (PLAN.md stage G3).
 *
 * Registering an edge type **replaces** React Flow's path drawing for that
 * type, so the bee edge draws its own path here while tree edges deliberately
 * stay on the built-in `smoothstep` renderer (`edgeTypes` falls back to the
 * built-ins for any type it does not know — verified against
 * `@xyflow/react`'s EdgeWrapper).
 *
 * The bee edge (🐝, the influence link between two leaves):
 * - stroke colour from `BEE_STATUS_COLORS[status]`, dashed once the link is
 *   resolved/cancelled (no longer a live influence), animated while active
 *   (the adapter sets `animated`, React Flow's built-in path animation runs
 *   on our path too);
 * - a mid-path label `🐝 <Status>` — the status is always spelled out in
 *   text, colour alone never carries it;
 * - the `impact` description rides behind the label's `title` attribute, so
 *   hovering the edge answers "in what way does this influence?".
 */
import type { ReactElement } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { BEE_STATUS_COLORS, BEE_STATUS_LABELS } from "../colors";
import type { GraphFlowEdge } from "../graph";

/** The 🐝 influence edge between two visible leaves. */
export function BeeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  interactionWidth,
}: EdgeProps<GraphFlowEdge>): ReactElement | null {
  if (data?.kind !== "bee") return null;
  const { status, impact } = data;
  const color = BEE_STATUS_COLORS[status];
  const label = BEE_STATUS_LABELS[status];

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.35,
  });

  const settled = status === "resolved" || status === "cancelled";

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={interactionWidth}
        style={{
          stroke: color,
          strokeWidth: 2,
          strokeDasharray: settled ? "6 4" : undefined,
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="lp-bee-label"
          data-status={status}
          title={impact.length > 0 ? `${label} — ${impact}` : label}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            borderColor: color,
            color,
            // The label renderer is pointer-events: none by default — keep
            // the hover tooltip (the impact text) reachable.
            pointerEvents: "all",
          }}
        >
          <span aria-hidden="true">🐝 </span>
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** Custom types; unregistered types (tree `smoothstep`) keep built-ins. */
export const edgeTypes = {
  bee: BeeEdge,
};
