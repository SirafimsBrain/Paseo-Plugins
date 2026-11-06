import { useState, type ReactElement } from "react";
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
  /** Live branches the side branch may grow under (L8/L10); empty = read-only. */
  readonly branches?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    /** The tree the branch belongs to — in a forest the choice needs it. */
    readonly rootName?: string;
  }>;
  /** The branch the server's policy would use (L10); preselected here. */
  readonly defaultBranchId?: string | null;
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
  const options = branches ?? [];
  /**
   * Where the approval grows. The policy preselects a branch (the only tree's
   * default one) but the human decides — in a forest the tree *is* the
   * decision, and defaulting it silently would put the plan somewhere nobody
   * looks for it (L10).
   */
  const [choice, setChoice] = useState<string | null>(null);
  const chosen =
    choice !== null && options.some((branch) => branch.id === choice)
      ? choice
      : (props.defaultBranchId ?? options[0]?.id ?? null);
  const target =
    chosen === null
      ? null
      : (options.find((branch) => branch.id === chosen) ?? null);
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
      {/*
       * The gate is open but there is nowhere to grow: the plan becomes a side
       * branch, and a project without a live branch or sub-branch has none to
       * host it. Saying so beats a modal that silently offers no button.
       */}
      {canApprove && onApprove !== undefined && target === null ? (
        <div className="lp-details-section lp-details-write">
          <h3 className="lp-details-subtitle">Approval</h3>
          <p className="lp-details-hint">
            Nothing to grow under: this project has no live branch or
            sub-branch, and the plan becomes a side branch. Create one with{" "}
            <code>luck_tree_upsert_node</code>, then approve again.
          </p>
        </div>
      ) : null}
      {/* A tab opened without the write token reads; it cannot cross the gate. */}
      {canApprove && onApprove === undefined ? (
        <div className="lp-details-section lp-details-write">
          <h3 className="lp-details-subtitle">Approval</h3>
          <p className="lp-details-hint">
            This tab cannot write — open the dashboard from Paseo so it carries
            the access token, then approve the goal here.
          </p>
        </div>
      ) : null}
      {canApprove && onApprove !== undefined && target !== null ? (
        <div className="lp-details-section lp-details-write">
          <h3 className="lp-details-subtitle">Approval</h3>
          {options.length > 1 ? (
            <label className="lp-details-row">
              <span className="lp-details-row-label">Grows under</span>
              <select
                className="lp-write-select"
                aria-label="Branch the goal's side branch grows under"
                value={target.id}
                onChange={(event) => setChoice(event.target.value)}
              >
                {options.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.rootName !== undefined && branch.rootName.length > 0
                      ? `${branch.rootName} · ${branch.name}`
                      : branch.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
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
