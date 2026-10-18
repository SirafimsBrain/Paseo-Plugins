/**
 * The diagram canvas (PLAN.md stage G1). At this stage the canvas is the
 * honest scaffold: it hosts the future React Flow viewport (G2 mounts it
 * here) and, until then, tells the user exactly that instead of drawing an
 * empty box. Keeping the region real (a measured, scrollable, themed area)
 * means G2 only has to mount `<ReactFlow>` into it.
 */
import type { ReactElement } from "react";

export function Canvas(): ReactElement {
  return (
    <section className="lp-canvas" aria-label="Tree diagram">
      <div className="lp-canvas-empty">
        <p className="lp-canvas-empty-title">The 2D diagram arrives in stage G2</p>
        <p className="lp-canvas-empty-text">
          The data layer is already live: the toolbar counters come from
          <code> /api/stats</code>, and the layout (d3-hierarchy positions for
          every node) is mounted here once stages G2–G3 land.
        </p>
      </div>
    </section>
  );
}
