/**
 * The legend (PLAN.md stages G1, G3): what every shape and colour on the
 * canvas means. It renders the shared palette (`dashboard/src/colors.ts`),
 * the very hexes the nodes, bee edges and goal frames are painted with, so
 * the legend cannot drift from the diagram. Colour is never the only
 * carrier: every swatch sits next to its text label.
 */
import type { ReactElement } from "react";
import { LEAF_STATUSES, NODE_KINDS } from "../../../shared/tree";
import { BEE_STATUSES } from "../../../shared/links";
import {
  BEE_STATUS_COLORS,
  BEE_STATUS_LABELS,
  KIND_COLORS,
  KIND_GLYPHS,
  KIND_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "../colors";

export function Legend(): ReactElement {
  return (
    <footer className="lp-legend" aria-label="Legend">
      <span className="lp-legend-title">Legend</span>
      <span className="lp-legend-group">
        {NODE_KINDS.map((kind) => (
          <span className="lp-legend-item" key={kind}>
            <span
              className="lp-legend-swatch"
              style={{ backgroundColor: KIND_COLORS[kind] }}
              aria-hidden="true"
            />
            <span className="lp-legend-glyph" aria-hidden="true">
              {KIND_GLYPHS[kind]}
            </span>
            {KIND_LABELS[kind]}
          </span>
        ))}
      </span>
      <span className="lp-legend-divider" aria-hidden="true" />
      <span className="lp-legend-group">
        {LEAF_STATUSES.map((status) => (
          <span className="lp-legend-item" key={status}>
            <span
              className="lp-legend-swatch"
              style={{ backgroundColor: STATUS_COLORS[status] }}
              aria-hidden="true"
            />
            {STATUS_LABELS[status]}
          </span>
        ))}
      </span>
      <span className="lp-legend-divider" aria-hidden="true" />
      <span className="lp-legend-group">
        {BEE_STATUSES.map((status) => (
          <span className="lp-legend-item" key={status}>
            <span
              className="lp-legend-swatch"
              style={{ backgroundColor: BEE_STATUS_COLORS[status] }}
              aria-hidden="true"
            />
            <span aria-hidden="true">🐝 </span>
            {BEE_STATUS_LABELS[status]}
          </span>
        ))}
      </span>
      <span className="lp-legend-note">
        🐞 = open incidents on the node · 🎯 = goal subtree (progress layer —
        stage G5)
      </span>
    </footer>
  );
}
