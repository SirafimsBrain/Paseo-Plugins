/**
 * The legend (PLAN.md stages G1, G3, G5): what every shape and colour on the
 * canvas means. It renders the shared palette (`dashboard/src/colors.ts`),
 * the very hexes the nodes, bee edges, goal frames and growth bars are painted
 * with, so the legend cannot drift from the diagram. Colour is never the only
 * carrier: every swatch sits next to its text label.
 *
 * G5 adds the heat ramp: the three stops of `HEAT_RAMP` with their textual
 * percentages, so "warm node" is read as "this share of growth steps done".
 */
import type { ReactElement } from "react";
import { LEAF_STATUSES, NODE_KINDS } from "../../../shared/tree";
import { BEE_STATUSES } from "../../../shared/links";
import {
  BEE_STATUS_COLORS,
  BEE_STATUS_LABELS,
  HEAT_RAMP,
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
      <span className="lp-legend-divider" aria-hidden="true" />
      <span
        className="lp-legend-group lp-legend-heat"
        aria-label="Growth heat ramp"
        title="Growth layer: the share of completed growth steps of a node's subtree"
      >
        <span className="lp-legend-ramp" aria-hidden="true">
          {HEAT_RAMP.map((stop) => (
            <span
              key={stop.at}
              className="lp-legend-ramp-stop"
              style={{ backgroundColor: stop.color }}
            />
          ))}
        </span>
        <span>growth 0 % → 100 %</span>
      </span>
      <span className="lp-legend-note">
        🐞 = open incidents on the node · 🎯 = goal subtree · the growth bar
        under a node counts completed steps (its own record plus everything
        below it) · in 3D the same palette: 🐝 fly along arcs, 🐞 pulse on
        their leaves, 🎯 rings float over their subtree, growth glows as rings
      </span>
    </footer>
  );
}
