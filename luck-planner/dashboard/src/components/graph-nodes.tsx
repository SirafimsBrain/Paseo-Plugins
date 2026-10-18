/**
 * Graph node components (PLAN.md stages G2–G3).
 *
 * G2 delivers the *structural* rendering: one box per node with the kind
 * distinction by **shape** (the tech-stack root is a wide pill, the trunk a
 * bordered column, branches boxes, leaves slim cards) and the collapse/expand
 * affordance with the hidden-descendant count. Stage G3 fills in the visual
 * semantics on top of that, keeping the component names and the
 * `GraphNodeData` contract so the G2 adapter and its tests stay valid:
 *
 * - **leaf status bar** — a progress strip filled to `STATUS_PROGRESS[status]`
 *   and painted in `STATUS_COLORS[status]`, always next to the status *text*
 *   and the `v{version} · r{revision}` caption: the bar shows the position in
 *   plan → work → done, the text names the actual status (colour alone never
 *   carries state);
 * - **incident badges** — `🐞 ×N` on any node with open/investigating
 *   incidents, in text, with the titles behind the `title` attribute;
 * - **goal frames** — a synthetic dashed rectangle (`goalFrame` type) behind
 *   the materialized subtree of a high goal, labelled 🎯 with the goal text
 *   and its status in text.
 *
 * Edges live in `graph-edges.tsx` (bee renderer); tree edges keep React Flow's
 * built-in `smoothstep` path with a kind-tinted stroke from the adapter.
 *
 * Colour comes from `dashboard/src/colors.ts` (the shared palette the legend
 * already renders).
 */
import type { CSSProperties, ReactElement } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import {
  BUG_BADGE_COLOR,
  GOAL_STATUS_COLORS,
  GOAL_STATUS_LABELS,
  KIND_COLORS,
  KIND_GLYPHS,
  STATUS_COLORS,
  STATUS_LABELS,
  STATUS_PROGRESS,
} from "../colors";
import {
  LAYOUT,
  type GraphFlowNode,
  type GraphNodeData,
  type GoalFrameNode,
} from "../graph";

/**
 * Per-kind box shape: the root is a wide pill (the tech-stack entry), the
 * trunk a taller bordered column (the platform↔code link), branches and
 * subbranches rounded boxes, leaves slim cards.
 */
const KIND_SHAPE: Record<GraphNodeData["kind"], CSSProperties> = {
  root: { borderRadius: 999, borderWidth: 2, padding: "12px 26px" },
  trunk: { borderRadius: 8, borderWidth: 2, padding: "10px 14px" },
  branch: { borderRadius: 8, borderWidth: 1, padding: "8px 12px" },
  subbranch: { borderRadius: 6, borderWidth: 1, padding: "6px 10px" },
  leaf: { borderRadius: 10, borderWidth: 1, padding: "6px 10px" },
};

/** The 🐞 ×N chip; text (not colour alone) carries the count. */
function BugBadge({ count }: { count: number }): ReactElement {
  return (
    <span
      className="lp-node-bugbadge"
      title={`${count} open incident${count === 1 ? "" : "s"} on this node`}
      style={{
        backgroundColor: `${BUG_BADGE_COLOR}26`,
        borderColor: BUG_BADGE_COLOR,
        color: BUG_BADGE_COLOR,
      }}
    >
      🐞 ×{count}
    </span>
  );
}

/** One node of the diagram. */
export function GraphNode({ data }: NodeProps<GraphFlowNode>): ReactElement {
  const shape = KIND_SHAPE[data.kind];
  const hasChildren = data.childCount > 0;
  return (
    <div
      className={`lp-node lp-node-${data.kind}`}
      style={{
        ...shape,
        width: LAYOUT.nodeWidth,
        minHeight: LAYOUT.nodeHeight,
        background: "var(--lp-surface, #171a21)",
        borderColor: KIND_COLORS[data.kind],
        color: "var(--lp-text, #e6e9ef)",
      }}
      data-status={data.status}
      data-kind={data.kind}
      data-selected={data.selected ? "true" : undefined}
      data-bug-linked={data.bugLinked ? "true" : undefined}
    >
      <Handle type="target" position={Position.Top} />
      <div className="lp-node-title">
        <span className="lp-node-glyph" aria-hidden="true">
          {KIND_GLYPHS[data.kind]}
        </span>
        <span className="lp-node-name" title={data.name}>
          {data.name}
        </span>
        {data.openBugCount > 0 ? <BugBadge count={data.openBugCount} /> : null}
      </div>
      {data.kind === "leaf" ? (
        <div className="lp-node-status">
          <span
            className="lp-node-status-dot"
            style={{ backgroundColor: STATUS_COLORS[data.status] }}
            aria-hidden="true"
          />
          {/* Text next to the colour: status never relies on colour alone. */}
          <span className="lp-node-status-text">{STATUS_LABELS[data.status]}</span>
          <span className="lp-node-version">
            v{data.version} · r{data.revision}
          </span>
        </div>
      ) : null}
      {data.kind === "leaf" ? (
        /* The G3 status bar: fill = position in plan → work → done, colour =
           status. Decorative — the text row above is the accessible carrier. */
        <div
          className="lp-node-statusbar"
          role="img"
          aria-label={`Status: ${STATUS_LABELS[data.status]}`}
          title={`Status: ${STATUS_LABELS[data.status]}`}
        >
          <div
            className="lp-node-statusbar-fill"
            style={{
              width: `${Math.round(STATUS_PROGRESS[data.status] * 100)}%`,
              backgroundColor: STATUS_COLORS[data.status],
            }}
          />
        </div>
      ) : null}
      {hasChildren ? (
        <button
          type="button"
          className="lp-node-toggle"
          aria-expanded={!data.collapsed}
          aria-label={
            data.collapsed
              ? `Expand ${data.name} (${data.hiddenDescendantCount} hidden)`
              : `Collapse ${data.name}`
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggle?.();
          }}
        >
          {data.collapsed ? `+${data.hiddenDescendantCount}` : "−"}
        </button>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/**
 * The 🎯 goal frame (G3): a dashed rectangle behind the subtree a high goal
 * materialized, labelled with the goal's formal text and its status in text
 * next to the colour. Pointer-transparent and non-selectable (the adapter set
 * `zIndex: -1`), so it can never swallow a click meant for a node.
 */
export function GoalFrame({
  data,
}: NodeProps<GoalFrameNode>): ReactElement {
  return (
    <div
      className="lp-goal-frame"
      data-status={data.status}
      style={{
        width: data.width,
        height: data.height,
        borderColor: GOAL_STATUS_COLORS[data.status],
      }}
      title={`${data.name} — ${GOAL_STATUS_LABELS[data.status]} (${data.nodeCount} nodes)`}
    >
      <span
        className="lp-goal-frame-label"
        style={{ color: GOAL_STATUS_COLORS[data.status] }}
      >
        <span aria-hidden="true">🎯 </span>
        <span className="lp-goal-frame-name">{data.name}</span>
        <span className="lp-goal-frame-status">
          {" · "}
          {GOAL_STATUS_LABELS[data.status]}
        </span>
      </span>
    </div>
  );
}

/** Registers the components under their adapter type names. */
export const nodeTypes = {
  root: GraphNode,
  trunk: GraphNode,
  branch: GraphNode,
  subbranch: GraphNode,
  leaf: GraphNode,
  goalFrame: GoalFrame,
};
