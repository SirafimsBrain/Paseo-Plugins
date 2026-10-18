/**
 * The diagram canvas (PLAN.md stages G2, G4).
 *
 * Mounts the React Flow viewport over the graph the adapter built
 * (`dashboard/src/graph.ts`). Two kinds of wiring live here, both purely
 * presentational — the adapter stays free of React and of interactivity:
 *
 * - **decoration** (since G2): node data gets the `onToggle` callback the
 *   adapter never writes;
 * - **selection** (G4): clicking a node selects it (`onNodeClick`), clicking
 *   the pane clears the selection. The selection is decorated into the node
 *   data (`selected`), the nodes sharing an open incident with it get
 *   `bugLinked`, and every edge touching the selected node — tree edges and
 *   bee edges alike — is emphasized via a class + a heavier stroke. Emphasis
 *   is computed with the pure helpers `relatedByOpenBug`/`edgeTouchesNode`.
 *
 * The `FocusController` child is the only piece that talks to the React Flow
 * camera: on a `FocusRequest` (G4 search) it centres the viewport on the
 * node's layout box, so "find a leaf by search" never turns into a
 * scroll hunt (the G4 acceptance scenario).
 *
 * Before the first `/api/tree` response (or when the graph is empty after
 * filters/collapse) the canvas shows the honest empty state instead of a
 * blank viewport; the app overrides the wording when the emptiness is the
 * result of the active filters (G4).
 */
import { useEffect } from "react";
import type { ReactElement } from "react";
import { Background, Controls, ReactFlow, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  edgeTouchesNode,
  graphNodeCenter,
  relatedByOpenBug,
  type DashboardGraph,
  type FocusRequest,
} from "../graph";
import { edgeTypes } from "./graph-edges";
import { nodeTypes } from "./graph-nodes";

/** Props of the canvas. */
export interface CanvasProps {
  /** The adapter output for the current tree + collapse + filter state. */
  readonly graph: DashboardGraph;
  /** Whether a tree response has landed at all (empty graph ≠ no data yet). */
  readonly loaded: boolean;
  /** Toggles the collapse state of one node id (wired by the app). */
  readonly onToggleNode: (id: string) => void;
  /** Currently selected node id, or `null` (stage G4). */
  readonly selectedId: string | null;
  /** Sets/clears the selection when a node or the pane is clicked (G4). */
  readonly onSelectNode: (id: string | null) => void;
  /** Latest camera-focus request, or `null` (G4 search). */
  readonly focus: FocusRequest | null;
  /** Empty-state overrides — the app names filters as the reason (G4). */
  readonly emptyTitle?: string;
  readonly emptyText?: string;
}

/**
 * Flies the camera to the requested node. Lives *inside* the React Flow
 * provider (a child of `<ReactFlow>`), so it can use `useReactFlow` without
 * threading the instance up through the app.
 */
function FocusController({ focus }: { focus: FocusRequest | null }): null {
  const flow = useReactFlow();
  useEffect(() => {
    if (focus === null) return;
    const node = flow.getNodes().find((candidate) => candidate.id === focus.nodeId);
    if (node === undefined) return; // hidden by a filter we could not clear
    const center = graphNodeCenter(node);
    void flow.setCenter(center.x, center.y, {
      zoom: Math.max(flow.getZoom(), 0.85),
      duration: 400,
    });
  }, [focus, flow]);
  return null;
}

export function Canvas(props: CanvasProps): ReactElement {
  const { graph, loaded, onToggleNode, selectedId, onSelectNode, focus } = props;

  if (loaded && graph.nodes.length === 0) {
    return (
      <section className="lp-canvas" aria-label="Tree diagram">
        <div className="lp-canvas-empty">
          <p className="lp-canvas-empty-title">
            {props.emptyTitle ?? "This project has no tree yet"}
          </p>
          <p className="lp-canvas-empty-text">
            {props.emptyText ??
              "Ask a coding agent to grow the skeleton" +
                " (<code>luck_tree_upsert_leaf</code>), or open a workspace that" +
                " has one — the diagram appears here after a refresh."}
          </p>
        </div>
      </section>
    );
  }

  // The adapter owns the data; the app owns the toggle and the selection.
  // Decorating here keeps graph.ts free of React while the nodes stay
  // clickable. Selection-related sets are computed by the pure helpers, so
  // this file stays a thin wiring layer.
  const bugLinked = relatedByOpenBug(graph, selectedId);
  const nodes = graph.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      onToggle: () => onToggleNode(node.id),
      selected: node.id === selectedId,
      bugLinked: bugLinked.has(node.id),
    },
  }));
  const edges = graph.edges.map((edge) => {
    if (!edgeTouchesNode(edge, selectedId)) return edge;
    const emphasized =
      edge.data?.kind === "bee"
        ? 3 // the bee stroke starts at 2 and carries its own status colour
        : 2.5; // tree strokes start at the default 1
    return {
      ...edge,
      className: "lp-edge-emphasis",
      style: { ...edge.style, strokeWidth: emphasized, opacity: 1 },
    };
  });

  return (
    <section className="lp-canvas" aria-label="Tree diagram">
      <ReactFlow
        nodes={[...nodes, ...graph.goalFrames]}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        onPaneClick={() => onSelectNode(null)}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <FocusController focus={focus} />
        <Background gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}
