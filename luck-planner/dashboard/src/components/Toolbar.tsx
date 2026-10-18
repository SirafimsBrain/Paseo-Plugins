/**
 * The dashboard toolbar (PLAN.md stages G1, G4, G5): identity, counters and
 * the controls. G1 shipped the search box and the kind/status filters as
 * disabled placeholders with a hint naming this stage; G4 wires them for
 * real: the search box submits an FTS query against `/api/search` (the app
 * focuses the camera on the best hit), the two selects and the version input
 * narrow the diagram through the adapter's `filter` option. G5 adds the layer
 * switch — `Status` (the G3/G4 view) vs `Growth heat` (the whole tree tinted
 * by its growth ratio).
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
import { GRAPH_LAYER_LABELS, GRAPH_LAYERS, type GraphLayer } from "../graph";
import { KIND_LABELS, STATUS_LABELS } from "../colors";

/** The three toolbar filters, owned by the app and applied by the adapter. */
export interface ToolbarFilters {
  kind: NodeKind | "";
  status: LeafStatus | "";
  version: string;
}

/** Connection state of the live-update stream (stage H1). */
export type ToolbarLiveState = "connecting" | "live" | "offline";

/** Text of the live indicator — the state is never colour-only. */
const LIVE_LABELS: Record<ToolbarLiveState, string> = {
  connecting: "connecting",
  live: "live",
  offline: "offline",
};

const LIVE_HINTS: Record<ToolbarLiveState, string> = {
  connecting: "Connecting to the change stream…",
  live: "Live: the server pushes tree-changed events over /api/events (SSE).",
  offline:
    "The change stream is down and reconnecting; the data on screen may be stale. Reload the tab if the plugin was restarted.",
};

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
  /** Active diagram layer (G5). */
  readonly layer: GraphLayer;
  /** Switches the diagram layer (G5). */
  readonly onLayerChange: (layer: GraphLayer) => void;
  /** Live-update stream state (H1). */
  readonly live: ToolbarLiveState;
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
        <div className="lp-view-switch" role="group" aria-label="Layer" title="Status: kind shapes, status bars and badges. Growth heat: the same diagram tinted by growth progress.">
          {GRAPH_LAYERS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={
                candidate === props.layer
                  ? "lp-view-button lp-view-button-active"
                  : "lp-view-button"
              }
              aria-pressed={candidate === props.layer}
              onClick={() => props.onLayerChange(candidate)}
            >
              {GRAPH_LAYER_LABELS[candidate]}
            </button>
          ))}
        </div>
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
        <span
          className={`lp-live lp-live-${props.live}`}
          title={LIVE_HINTS[props.live]}
        >
          <span className="lp-live-dot" aria-hidden="true" />
          {LIVE_LABELS[props.live]}
        </span>
        <span className="lp-toolbar-status-text">{props.statusLine}</span>
      </div>
    </header>
  );
}
