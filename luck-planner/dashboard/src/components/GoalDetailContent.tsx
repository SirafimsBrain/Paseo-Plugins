import type { ReactElement } from "react";
import type { Goal } from "../../../shared/goals";
import { GOAL_STATUSES } from "../../../shared/goals";

export interface GoalDetailContentProps {
  readonly goal: Goal;
  readonly resolveName?: (id: string) => string;
}

export function GoalDetailContent(props: GoalDetailContentProps): ReactElement {
  const { goal } = props;
  return (
    <div className="lp-details-body">
      <h3 className="lp-details-subtitle">Goal</h3>
      <p className="lp-details-path">{goal.formalText}</p>
      <div className="lp-details-section">
        <div className="lp-details-row">
          <span className="lp-details-row-label">Status</span>
          <span className="lp-details-row-value">{goal.status}</span>
        </div>
        <div className="lp-details-row">
          <span className="lp-details-row-label">Revision</span>
          <span className="lp-details-row-value">r{goal.revision}</span>
        </div>
        <div className="lp-details-row">
          <span className="lp-details-row-label">Materialized</span>
          <span className="lp-details-row-value">
            {goal.materializedNodeId ?? "not yet"}
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
    </div>
  );
}
