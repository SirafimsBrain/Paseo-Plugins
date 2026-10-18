/**
 * The dashboard toolbar (PLAN.md stage G1): identity, counters and the
 * controls the later stages light up (search in G4, filters in G4, the 3D
 * switch in I4). Controls that have no backing yet render disabled with a
 * hint instead of pretending to work — a scaffold that lies about its state
 * is worse than one that says what is coming.
 */
import type { ReactElement } from "react";
import type { StatsResponse } from "../../../shared/api";

/** Props of the toolbar. */
export interface ToolbarProps {
  /** Canonical project key the tab is showing (ADR-2). */
  readonly projectKey: string;
  /** Loaded counters, or `null` while the first request is in flight. */
  readonly stats: StatsResponse | null;
  /** Non-fatal status/error line rendered at the right edge. */
  readonly statusLine: string;
}

/** One `label · value` counter cell. */
function Counter(props: { label: string; value: number }): ReactElement {
  return (
    <span className="lp-counter" title={props.label}>
      <span className="lp-counter-value">{props.value}</span>
      <span className="lp-counter-label">{props.label}</span>
    </span>
  );
}

export function Toolbar(props: ToolbarProps): ReactElement {
  const stats = props.stats;
  return (
    <header className="lp-toolbar">
      <div className="lp-toolbar-identity">
        <span className="lp-toolbar-title">luck-planner</span>
        <span className="lp-toolbar-project" title={props.projectKey}>
          {props.projectKey || "no project"}
        </span>
      </div>

      <div className="lp-toolbar-counters" aria-label="Project counters">
        {stats === null ? (
          <span className="lp-counter-hint">Loading counters…</span>
        ) : (
          <>
            <Counter label="nodes" value={stats.nodes.total} />
            <Counter label="in progress" value={stats.leaves.inProgress} />
            <Counter label="done" value={stats.leaves.done} />
            <Counter label="bees" value={stats.bees} />
            <Counter label="open bugs" value={stats.bugs.open} />
            <Counter label="goals" value={stats.goals.approved} />
          </>
        )}
      </div>

      <div className="lp-toolbar-controls">
        <input
          className="lp-toolbar-search"
          type="search"
          placeholder="Search (stage G4)"
          aria-label="Search the tree (arrives in stage G4)"
          disabled
        />
        <select className="lp-toolbar-filter" aria-label="Filter by kind" disabled>
          <option>Kind (G4)</option>
        </select>
        <select className="lp-toolbar-filter" aria-label="Filter by status" disabled>
          <option>Status (G4)</option>
        </select>
        <div className="lp-view-switch" role="group" aria-label="View">
          <button type="button" className="lp-view-button lp-view-button-active" aria-pressed="true">
            2D
          </button>
          <button
            type="button"
            className="lp-view-button"
            aria-pressed="false"
            disabled
            title="The 3D view arrives in stage I4"
          >
            3D
          </button>
        </div>
      </div>

      <div className="lp-toolbar-status" role="status">
        {props.statusLine}
      </div>
    </header>
  );
}
