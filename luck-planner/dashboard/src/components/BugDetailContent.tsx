import type { ReactElement } from "react";
import type { Bug } from "../../../shared/links";

export interface BugDetailContentProps {
  readonly bug: Bug;
  readonly nodeNames?: ReadonlyMap<string, string>;
}

export function BugDetailContent(props: BugDetailContentProps): ReactElement {
  const { bug } = props;
  return (
    <div className="lp-details-body">
      <h3 className="lp-details-subtitle">Incident</h3>
      <p className="lp-details-path">{bug.title}</p>
      <div className="lp-details-section">
        <div className="lp-details-row">
          <span className="lp-details-row-label">Severity</span>
          <span className="lp-details-row-value">{bug.severity}</span>
        </div>
        <div className="lp-details-row">
          <span className="lp-details-row-label">Status</span>
          <span className="lp-details-row-value">{bug.status}</span>
        </div>
      </div>
      {bug.description ? (
        <div className="lp-details-section">
          <p className="lp-details-hint">{bug.description}</p>
        </div>
      ) : null}
    </div>
  );
}
