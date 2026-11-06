import type { ReactElement } from "react";
import type { Bug } from "../../../shared/links";
import { cardStatusActions, type PlainStatusOverride } from "../plain";

export interface BugDetailContentProps {
  readonly bug: Bug;
  readonly nodeNames?: ReadonlyMap<string, string>;
  /**
   * Moves the incident through `BUG_TRANSITIONS` (0.51.1). Absent in a tab
   * opened without the write token (and in the read-only uses of this view).
   */
  readonly onSetStatus?: (status: string) => void;
  /** Status of a write in flight, or `null` (0.51.1). */
  readonly pendingStatus?: string | null;
  /** The last refusal, in the server's words (0.51.1). */
  readonly error?: string;
  /** The agent's reason for the last status move on this incident (0.51.2). */
  readonly override?: PlainStatusOverride | null;
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
      {props.override !== undefined && props.override !== null ? (
        <div className="lp-details-section lp-details-override">
          <p className="lp-details-override-line">
            <span className="lp-details-override-label">↺ Agent override:</span>{" "}
            {props.override.reason}
          </p>
          <span className="lp-details-hint">
            {props.override.actor} — the previous status was set by hand, so the
            move came with a reason.
          </span>
        </div>
      ) : null}
      {props.onSetStatus !== undefined && cardStatusActions("bug", bug.status).length > 0 ? (
        <div className="lp-details-section lp-details-write">
          <h3 className="lp-details-subtitle">Lifecycle</h3>
          <div className="lp-details-status-actions">
            {cardStatusActions("bug", bug.status).map((action) => (
              <button
                key={action.status}
                type="button"
                className="lp-write-button"
                disabled={props.pendingStatus !== undefined && props.pendingStatus !== null}
                title={`Move the incident to ${action.status}`}
                onClick={() => props.onSetStatus?.(action.status)}
              >
                {action.label}
              </button>
            ))}
          </div>
          {props.error !== undefined && props.error.length > 0 ? (
            <p className="lp-details-error" role="alert">
              {props.error}
            </p>
          ) : null}
        </div>
      ) : null}
      {bug.description ? (
        <div className="lp-details-section">
          <p className="lp-details-hint">{bug.description}</p>
        </div>
      ) : null}
    </div>
  );
}
