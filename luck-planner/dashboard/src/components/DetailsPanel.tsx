/**
 * The details panel (PLAN.md stage G1). The region and its data contract are
 * real; the content is filled by stage G4, which fetches
 * `GET /api/node/:id` (version, revision, status, bees, bugs, history) when a
 * node is selected on the canvas. Until then the panel states that, so the
 * layout — right column, own scroll, same surface colour as the toolbar — is
 * already final and G4 only swaps the placeholder for real rows.
 */
import type { ReactElement } from "react";

export function DetailsPanel(): ReactElement {
  return (
    <aside className="lp-details" aria-label="Node details">
      <h2 className="lp-details-title">Details</h2>
      <p className="lp-details-empty">
        Select a node on the diagram (stage G4) to see its version, revision,
        status, influence links, incidents and history here.
      </p>
    </aside>
  );
}
