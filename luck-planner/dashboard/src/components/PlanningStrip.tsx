/**
 * The planning strip of the 2D view (0.51.2).
 *
 * The diagram is a picture of the **tree**, so two planning entities have no
 * place on it: a goal that has not materialized yet (a draft or a proposal
 * waiting for the gate) and an incident attached to no leaf. Before this strip
 * they were reachable only from the plain board, which made "plain first" read
 * as "plain only" — the goal and incident lifecycles existed in the diagram
 * for everything the tree happened to draw.
 *
 * The strip is deliberately not a second board: it lists the project's goals
 * (the frame only exists once a plan materialized) and the incidents no leaf
 * can lead to, as chips carrying the status in text (the project's
 * colour-plus-text rule) and a ↺ mark when an agent's override reason is
 * available. A click opens the same modal the board opens, so both views write
 * through one path.
 */
import type { ReactElement } from "react";
import { GOAL_STATUS_COLORS, GOAL_STATUS_LABELS, BUG_STATUS_COLORS, BUG_STATUS_LABELS } from "../colors";
import type { Goal } from "../../../shared/goals";
import type { Bug, BugNode } from "../../../shared/links";
import type { PlainStatusOverride } from "../plain";

export interface PlanningStripProps {
  /** Every goal of the project; the unmaterialized ones are the point. */
  readonly goals: readonly Goal[];
  /** Every incident of the project; only unattached ones are shown. */
  readonly bugs: readonly Bug[];
  /** Incident → leaf links, used to tell an unattached incident apart. */
  readonly bugAttachments: readonly BugNode[];
  /** Agent override reasons, keyed `<entityType>:<entityId>` (`overrideIndex`). */
  readonly overrides: ReadonlyMap<string, PlainStatusOverride>;
  readonly onSelectGoal: (goalId: string) => void;
  readonly onSelectBug: (bugId: string) => void;
}

/** A label that fits a chip: the first line, cut at ~64 characters. */
function chipText(text: string): string {
  const first = text.split("\n")[0]!.trim();
  return first.length > 64 ? `${first.slice(0, 63)}…` : first;
}

export function PlanningStrip(props: PlanningStripProps): ReactElement | null {
  const attached = new Set(props.bugAttachments.map((link) => link.bugId));
  const looseBugs = props.bugs.filter((bug) => !attached.has(bug.id));
  const sortedGoals = [...props.goals].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  if (sortedGoals.length === 0 && looseBugs.length === 0) return null;

  return (
    <div
      className="lp-planning-strip"
      role="group"
      aria-label="Goals and incidents the diagram cannot draw"
    >
      <span className="lp-planning-strip-label">Planning</span>
      {sortedGoals.map((goal) => {
        const override = props.overrides.get(`goal:${goal.id}`);
        return (
          <button
            key={goal.id}
            type="button"
            className="lp-planning-chip"
            data-kind="goal"
            data-status={goal.status}
            title={
              (override !== undefined
                ? `↺ ${override.reason}\n`
                : "") +
              `${goal.formalText}\n${GOAL_STATUS_LABELS[goal.status]} · ${goal.plan.length} step(s)` +
              (goal.materializedNodeId === null ? " · not in the tree yet" : "")
            }
            onClick={() => props.onSelectGoal(goal.id)}
          >
            <span aria-hidden="true">🎯</span>
            <span className="lp-planning-chip-text">{chipText(goal.formalText)}</span>
            <span
              className="lp-planning-chip-status"
              style={{ color: GOAL_STATUS_COLORS[goal.status] }}
            >
              {GOAL_STATUS_LABELS[goal.status]}
            </span>
            {override !== undefined ? (
              <span className="lp-planning-chip-override" aria-label="An agent moved this status and said why">
                ↺
              </span>
            ) : null}
          </button>
        );
      })}
      {looseBugs.map((bug) => {
        const override = props.overrides.get(`bug:${bug.id}`);
        return (
          <button
            key={bug.id}
            type="button"
            className="lp-planning-chip"
            data-kind="bug"
            data-status={bug.status}
            title={
              (override !== undefined ? `↺ ${override.reason}\n` : "") +
              `${bug.title}\n${BUG_STATUS_LABELS[bug.status]} · ${bug.severity} · no leaf attached`
            }
            onClick={() => props.onSelectBug(bug.id)}
          >
            <span aria-hidden="true">🐞</span>
            <span className="lp-planning-chip-text">{chipText(bug.title)}</span>
            <span
              className="lp-planning-chip-status"
              style={{ color: BUG_STATUS_COLORS[bug.status] }}
            >
              {BUG_STATUS_LABELS[bug.status]}
            </span>
            {override !== undefined ? (
              <span className="lp-planning-chip-override" aria-label="An agent moved this status and said why">
                ↺
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
