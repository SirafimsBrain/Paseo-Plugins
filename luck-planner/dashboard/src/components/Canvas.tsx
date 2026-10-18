/**
 * The diagram canvas (PLAN.md stage G2).
 *
 * Mounts the React Flow viewport over the graph the G2 adapter built
 * (`dashboard/src/graph.ts`): the nodes carry an `onToggle` callback the
 * adapter never writes, injected here — the one place where the pure data
 * layer meets the interactive one. `fitView` frames the whole tree on load,
 * pan/zoom come from React Flow; node *positions* stay layout-owned
 * (`draggable: false` in the adapter), so a re-layout never fights the user.
 *
 * Before the first `/api/tree` response (or when the project has no nodes)
 * the canvas shows the honest empty state instead of a blank viewport.
 */
import type { ReactElement } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DashboardGraph } from "../graph";
import { edgeTypes } from "./graph-edges";
import { nodeTypes } from "./graph-nodes";

/** Props of the canvas. */
export interface CanvasProps {
  /** The adapter output for the current tree + collapse state. */
  readonly graph: DashboardGraph;
  /** Whether a tree response has landed at all (empty graph ≠ no data yet). */
  readonly loaded: boolean;
  /** Toggles the collapse state of one node id (wired by the app). */
  readonly onToggleNode: (id: string) => void;
}

export function Canvas(props: CanvasProps): ReactElement {
  const { graph, loaded, onToggleNode } = props;

  if (loaded && graph.nodes.length === 0) {
    return (
      <section className="lp-canvas" aria-label="Tree diagram">
        <div className="lp-canvas-empty">
          <p className="lp-canvas-empty-title">This project has no tree yet</p>
          <p className="lp-canvas-empty-text">
            Ask a coding agent to grow the skeleton
            (<code>luck_tree_upsert_leaf</code>), or open a workspace that has
            one — the diagram appears here after a refresh.
          </p>
        </div>
      </section>
    );
  }

  // The adapter owns the data; the app owns the toggle. Decorating here keeps
  // graph.ts free of React while the nodes stay clickable. Goal frames (G3)
  // ride along behind the tree — they are synthetic, fixed and inert.
  const nodes = graph.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      onToggle: () => onToggleNode(node.id),
    },
  }));

  return (
    <section className="lp-canvas" aria-label="Tree diagram">
      <ReactFlow
        nodes={[...nodes, ...graph.goalFrames]}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}
