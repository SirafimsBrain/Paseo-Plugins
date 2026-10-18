/**
 * The dashboard toolbar (PLAN.md stages G1, G4): identity, counters and the
 * controls. G1 shipped the search box and the kind/status filters as
 * disabled placeholders with a hint naming this stage; G4 wires them for
 * real: the search box submits an FTS query against `/api/search` (the app
 * focuses the camera on the best hit), the two selects and the version input
 * narrow the diagram through the adapter's `filter` option.
 *
 * The search input keeps its own draft state (the query is *not* diagram
 * state — only the picked result is) and submits on Enter, which is the
 * keyboard flow the acceptance scenario assumes.
 */
import { useState } from "react";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import type { StatsResponse } from "../../../shared/api";
import { LEAF_STATUSES, NODE_KINDS } from "../../../shared/tree";
import type { LeafStatus, NodeKind } from "../../../shared/tree";
import { KIND_LABELS, STATUS_LABELS } from "../colors";

/** The three toolbar filters, owned by the app and applied by the adapter. */
export interface ToolbarFilters {
  kind: NodeKind | "";
  status: LeafStatus | "";
  version: string;
}

/** Props of the toolbar. */
export interface ToolbarProps {
  /** Canonical project key the tab is showing (ADR-2). */
  readonly projectKey: string;
  /** Loaded counters, or `null` while the first request is in flight. */
  readonly stats: StatsResponse | null;
  /** Non-fatal status/error line rendered at the right edge. */
  readonly statusLine: string;
  /** Current filter values (G4). */
  readonly filters: ToolbarFilters;
  /** Replaces the whole filter set when one control changes (G4). */
  readonly onFiltersChange: (filters: ToolbarFilters) => void;
  /** Runs an FTS query — the app focuses the best hit (G4). */
  readonly onSearch: (query: string) => void;
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
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const query = draft.trim();
    if (query.length > 0) props.onSearch(query);
  };

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
        <form className="lp-toolbar-search-form" onSubmit={submit} role="search">
          <input
            className="lp-toolbar-search"
            type="search"
            placeholder="Search (FTS)"
            aria-label="Search the tree"
            value={draft}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setDraft(event.target.value)
            }
          />
        </form>
        <select
          className="lp-toolbar-filter"
          aria-label="Filter by kind"
          value={props.filters.kind}
          onChange={(event) =>
            props.onFiltersChange({
              ...props.filters,
              kind: event.target.value as NodeKind | "",
            })
          }
        >
          <option value="">All kinds</option>
          {NODE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
        <select
          className="lp-toolbar-filter"
          aria-label="Filter by status"
          value={props.filters.status}
          onChange={(event) =>
            props.onFiltersChange({
              ...props.filters,
              status: event.target.value as LeafStatus | "",
            })
          }
        >
          <option value="">All statuses</option>
          {LEAF_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <input
          className="lp-toolbar-filter"
          type="text"
          size={8}
          placeholder="Version"
          aria-label="Filter by version prefix"
          title="Filter by version prefix, e.g. 2.1"
          value={props.filters.version}
          onChange={(event) =>
            props.onFiltersChange({
              ...props.filters,
              version: event.target.value,
            })
          }
        />
        <div className="lp-view-switch" role="group" aria-label="View">
          <button
            type="button"
            className="lp-view-button lp-view-button-active"
            aria-pressed="true"
          >
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
