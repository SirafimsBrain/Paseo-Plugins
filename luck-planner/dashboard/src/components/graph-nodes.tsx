/**
 * Graph node components (PLAN.md stage G2).
 *
 * G2 delivers the *structural* rendering the plan requires for this stage:
 * one box per node with the kind distinction by **shape** (the tech-stack
 * root is a wide pill, the trunk a bordered column, branches boxes, leaves
 * slim cards with a status bar spelled out in text next to its colour) and
 * the collapse/expand affordance with the hidden-descendant count. Stage G3
 * replaces the visual details — richer status semantics, bug badges, goal
 * frames, bee-edge styling — keeping these component names and the
 * `GraphNodeData` contract, so the G2 adapter and its tests stay valid.
 *
 * Edges are left to React Flow's built-in renderers at G2 (`smoothstep` for
 * the tree, `default` for bees): a custom edge component *replaces* the path
 * drawing, so registering empty ones would silently hide every edge.
 *
 * Colour comes from `dashboard/src/colors.ts` (the shared palette the legend
 * already renders).
 */
import type { CSSProperties, ReactElement } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import {
  KIND_COLORS,
  KIND_GLYPHS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "../colors";
import { LAYOUT, type GraphFlowNode, type GraphNodeData } from "../graph";

/**
 * Per-kind box shape: the root is a wide pill (the tech-stack entry), the
 * trunk a taller bordered column (the platform↔code link), branches and
 * subbranches rounded boxes, leaves slim cards. G3 keeps the shapes and
 * refines the insides.
 */
const KIND_SHAPE: Record<GraphNodeData["kind"], CSSProperties> = {
  root: { borderRadius: 999, borderWidth: 2, padding: "12px 26px" },
  trunk: { borderRadius: 8, borderWidth: 2, padding: "10px 14px" },
  branch: { borderRadius: 8, borderWidth: 1, padding: "8px 12px" },
  subbranch: { borderRadius: 6, borderWidth: 1, padding: "6px 10px" },
  leaf: { borderRadius: 10, borderWidth: 1, padding: "6px 10px" },
};

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
    >
      <Handle type="target" position={Position.Top} />
      <div className="lp-node-title">
        <span className="lp-node-glyph" aria-hidden="true">
          {KIND_GLYPHS[data.kind]}
        </span>
        <span className="lp-node-name" title={data.name}>
          {data.name}
        </span>
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

/** Registers the five kind components under their adapter type names. */
export const nodeTypes = {
  root: GraphNode,
  trunk: GraphNode,
  branch: GraphNode,
  subbranch: GraphNode,
  leaf: GraphNode,
};
