import type { ReactElement } from "react";
import { canApproveGoal } from "../../../shared/goals";
import type { Goal } from "../../../shared/goals";
import { GOAL_STATUS_COLORS, GOAL_STATUS_LABELS } from "../colors";

/**
 * A high goal in the details modal (stage K2), with the approval gate (L8).
 *
 * Approval is the human's decision (ADR-7), and the dashboard is where a human
 * reads a proposed plan — so this is the one place in the browser that may
 * cross the gate. It needs a **target branch** because the goal's side branch
 * has to grow somewhere, and that is a choice, not a default: the caller passes
 * the live branches of the project and the control offers them.
 */
export interface GoalDetailContentProps {
  readonly goal: Goal;
  readonly resolveName?: (id: string) => string;
  /** Live branches the side branch may grow under (L8); empty = read-only. */
  readonly branches?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Crosses the gate under `parentBranchId` (L8). */
  readonly onApprove?: (parentBranchId: string) => void;
  /** Whether an approval write is in flight (L8). */
  readonly pending?: boolean;
  /** The last refusal, in the server's words (L8). */
  readonly error?: string;
}

export function GoalDetailContent(props: GoalDetailContentProps): ReactElement {
  const { goal, branches, onApprove, pending, error } = props;
  const canApprove = canApproveGoal(goal.status);
  const target = branches !== undefined && branches.length > 0 ? branches[0]! : null;
  return (
    <div className="lp-details-body">
      <h3 className="lp-details-subtitle">Goal</h3>
      <p className="lp-details-path">{goal.formalText}</p>
      <div className="lp-details-section">
        <div className="lp-details-row">
          <span className="lp-details-row-label">Status</span>
          <span className="lp-details-row-value">
            <span
              className="lp-details-dot"
              style={{ backgroundColor: GOAL_STATUS_COLORS[goal.status] }}
              aria-hidden="true"
            />
            {GOAL_STATUS_LABELS[goal.status]}
          </span>
        </div>
        <div className="lp-details-row">
          <span className="lp-details-row-label">Revision</span>
          <span className="lp-details-row-value lp-details-mono">
            r{goal.revision}
          </span>
        </div>
        <div className="lp-details-row">
          <span className="lp-details-row-label">Materialized</span>
          <span className="lp-details-row-value">
            {goal.materializedNodeId === null
              ? "not yet"
              : props.resolveName?.(goal.materializedNodeId) ??
                goal.materializedNodeId}
          </span>
        </div>
      </div>
      {goal.plan.length > 0 ? (
        <div className="lp-details-section">
          <h3 className="lp-details-subtitle">Plan ({goal.plan.length})</h3>
          <ol className="lp-details-list">
            {goal.plan.map((step) => (
              <li key={step.id} className="lp-details-child">
                <span className="lp-details-child-name">{step.title}</span>
                {step.description ? (
                  <span className="lp-details-hint">{step.description}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {canApprove && onApprove !== undefined && target !== null ? (
        <div className="lp-details-section lp-details-write">
          <h3 className="lp-details-subtitle">Approval</h3>
          <button
            type="button"
            className="lp-write-button lp-write-button-approve"
            disabled={pending === true}
            aria-busy={pending === true}
            title={`Grow this goal's ${goal.plan.length} step leaf(s) under “${target.name}”`}
            onClick={() => onApprove(target.id)}
          >
            Approve under {target.name}
          </button>
          <span className="lp-details-hint">
            Approval is the human's decision (ADR-7): it becomes an{" "}
            <code>approve</code> audit row and materializes the plan under the
            chosen branch. The request carries r{goal.revision} — a goal that
            moved meanwhile is refused instead of overwritten.
          </span>
          {error !== undefined && error.length > 0 ? (
            <p className="lp-details-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
