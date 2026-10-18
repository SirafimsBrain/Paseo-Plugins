/**
 * The dashboard application shell (PLAN.md stages G1, G2, G4, G5).
 *
 * Layout: toolbar (identity + counters + controls), the diagram canvas, the
 * details panel and the legend. What is live so far:
 * - the app reads the token and project from the URL, talks to the plugin's
 *   read-only HTTP API through the typed client, and renders the live
 *   counters from `/api/stats` plus the node diagram from `/api/tree`
 *   through the pure adapter (`dashboard/src/graph.ts`);
 * - **G4 interaction**: clicking a node selects it and loads
 *   `/api/node/:id` into the details panel (version, revision, status,
 *   incidents incl. blockers, influence links, children, history); the
 *   canvas emphasizes every edge touching the selection and highlights the
 *   other leaves sharing an open incident with it; the toolbar search runs
 *   an FTS query, clears whatever hides the best hit (collapse ancestors,
 *   conflicting filters) and flies the camera to it; the kind/status/version
 *   selects narrow the diagram through the adapter's filter option.
 * - **G5 growth layer**: the toolbar layer switch hands `layer` to the
 *   adapter, which fills each node's `heat` with its rolled-up growth ratio;
 *   switching it is a pure re-render (same positions), and an empty heat
 *   layer says so in words instead of looking like "nothing done".
 *
 * State rules kept deliberately small so later stages can extend them
 * without a rewrite: one `load()` effect keyed on the resolved client, one
 * status line for every non-fatal error, the collapse set that survives
 * refetches (the default policy applies to the first payload only), and the
 * selection which is just an id — the detail record is a separate state so
 * a stale response can never overwrite a newer selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { NodeResponse, StatsResponse, TreeResponse } from "../../shared/api";
import { DashboardApi, resolveApiOrigin } from "./api";
import {
  ancestorsOf,
  buildGraph,
  defaultCollapsedIds,
  EMPTY_GRAPH,
  isFilterActive,
  toggleCollapsed,
  type FocusRequest,
  type GraphLayer,
} from "./graph";
import { parseDashboardParams } from "./params";
import { resolveTheme, THEME_STORAGE_KEY, tokensFor, type ThemeName } from "./theme";
import { Canvas } from "./components/Canvas";
import { DetailsPanel } from "./components/DetailsPanel";
import { Legend } from "./components/Legend";
import { Toolbar, type ToolbarFilters } from "./components/Toolbar";

/** Applies a theme's tokens to `:root` as the CSS custom properties. */
function applyTheme(theme: ThemeName): void {
  const tokens = tokensFor(theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty("--lp-bg", tokens.bg);
  root.style.setProperty("--lp-surface", tokens.surface);
  root.style.setProperty("--lp-border", tokens.border);
  root.style.setProperty("--lp-text", tokens.text);
  root.style.setProperty("--lp-text-muted", tokens.textMuted);
  root.style.setProperty("--lp-accent", tokens.accent);
  root.style.setProperty("--lp-selection", tokens.selection);
}

/** Startup theme: stored choice, else the OS preference, else dark. */
function initialTheme(): ThemeName {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Private mode / disabled storage: fall back to the OS preference.
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  return resolveTheme(stored, prefersDark);
}

/**
 * The same filters with the kind/status fields cleared when they are the
 * reason a found node would stay hidden (the version prefix is kept — it is
 * an explicit narrowing the user typed).
 */
function filterExcludesNode(
  filters: ToolbarFilters,
  node: TreeResponse["nodes"][number],
): ToolbarFilters {
  return {
    kind: filters.kind !== "" && filters.kind !== node.kind ? filters.kind : "",
    status: filters.status !== "" && filters.status !== node.status ? filters.status : "",
    version: filters.version,
  };
}

/** Shown when the growth layer is switched on in a project without records. */
const GROWTH_EMPTY_HINT =
  "No growth records in this project yet — the heat layer stays neutral (agents write them with luck_tree_update_growth).";

export function App(): ReactElement {
  const params = useMemo(() => parseDashboardParams(window.location.search), []);
  const client = useMemo(
    () =>
      params.token.length > 0
        ? new DashboardApi(resolveApiOrigin(window.location.href), params.token, params.projectKey)
        : null,
    [params.projectKey, params.token],
  );

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [statusLine, setStatusLine] = useState("");
  const [theme] = useState<ThemeName>(initialTheme);

  // G4 interaction state.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [filters, setFilters] = useState<ToolbarFilters>({
    kind: "",
    status: "",
    version: "",
  });
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const focusSeq = useRef(0);

  // G5 growth layer: `status` is the G3/G4 view, `growth` tints the tree.
  const [layer, setLayer] = useState<GraphLayer>("status");

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const load = useCallback(async (): Promise<void> => {
    if (client === null) {
      setStatusLine("Open this page from Paseo (⌘K → “Open luck-planner dashboard”) so the URL carries the access token.");
      return;
    }
    if (params.projectKey.length === 0) {
      setStatusLine("The URL names no project; open the dashboard from a workspace.");
      return;
    }
    try {
      const [nextStats, nextTree] = await Promise.all([
        client.stats(),
        client.tree(),
      ]);
      setStats(nextStats);
      setTree(nextTree);
      // First payload only: apply the default collapse policy (G2 acceptance —
      // a 1000-node project must open as a readable skeleton). Later refreshes
      // keep whatever the user expanded or collapsed by hand.
      setCollapsedIds((previous) =>
        previous.size > 0 ? previous : defaultCollapsedIds(nextTree.nodes),
      );
      setStatusLine("");
    } catch (cause) {
      setStatusLine(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, params.projectKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load the selected node's detail (`/api/node/:id`); ignore a response
  // that arrives after the selection moved on.
  useEffect(() => {
    if (client === null || selectedId === null) {
      setDetail(null);
      setDetailError("");
      return;
    }
    let stale = false;
    setDetailLoading(true);
    setDetailError("");
    void client
      .node(selectedId)
      .then((response) => {
        if (!stale) setDetail(response);
      })
      .catch((cause: unknown) => {
        if (!stale) {
          setDetail(null);
          setDetailError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!stale) setDetailLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [client, selectedId]);

  const onToggleNode = useCallback((id: string): void => {
    setCollapsedIds((previous) => toggleCollapsed(previous, id));
  }, []);

  const requestFocus = useCallback((nodeId: string): void => {
    focusSeq.current += 1;
    setFocus({ nodeId, seq: focusSeq.current });
  }, []);

  /**
   * Switches the diagram layer (G5). Purely a display option — the layout is
   * rebuilt with the same positions — but with one honest hint: an empty heat
   * layer means "no growth records yet", not "nothing done".
   */
  const onLayerChange = useCallback(
    (next: GraphLayer): void => {
      setLayer(next);
      setStatusLine((previous) => {
        if (next === "growth") {
          if (previous === "" && (tree?.growth.length ?? 0) === 0) {
            return GROWTH_EMPTY_HINT;
          }
          return previous;
        }
        return previous === GROWTH_EMPTY_HINT ? "" : previous;
      });
    },
    [tree],
  );

  /**
   * Makes sure a node is actually on screen: expands its collapsed
   * ancestors and clears whichever filter excludes it (search should never
   * "find" something the user cannot see — the G4 acceptance scenario).
   */
  const revealNode = useCallback((nodeId: string): void => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      for (const ancestor of ancestorsOf(tree?.nodes ?? [], nodeId)) {
        next.delete(ancestor);
      }
      return next;
    });
    setFilters((previous) => {
      const node = tree?.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) return previous;
      return filterExcludesNode(previous, node);
    });
  }, [tree]);

  const onSearch = useCallback(
    async (query: string): Promise<void> => {
      if (client === null) return;
      try {
        const result = await client.search({ q: query });
        if (result.results.length === 0) {
          setStatusLine(`No matches for “${query}”.`);
          return;
        }
        const hit = result.results[0].node;
        revealNode(hit.id);
        setSelectedId(hit.id);
        requestFocus(hit.id);
        setStatusLine(
          result.matches === 1
            ? `Found “${hit.name}”.`
            : `${result.matches} matches — showing “${hit.name}”.`,
        );
      } catch (cause) {
        setStatusLine(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client, revealNode, requestFocus],
  );

  const graph = useMemo(
    () =>
      tree === null
        ? EMPTY_GRAPH
        : buildGraph(tree, { collapsedIds, filter: filters, layer }),
    [tree, collapsedIds, filters, layer],
  );

  const resolveName = useCallback(
    (id: string): string => {
      const node = tree?.nodes.find((candidate) => candidate.id === id);
      return node !== undefined ? node.name : `…${id.slice(0, 8)}`;
    },
    [tree],
  );

  const filtersActive = isFilterActive(filters);

  return (
    <div className="lp-app">
      <Toolbar
        projectKey={params.projectKey}
        stats={stats}
        statusLine={statusLine}
        filters={filters}
        onFiltersChange={setFilters}
        onSearch={(query) => void onSearch(query)}
        layer={layer}
        onLayerChange={onLayerChange}
      />
      <div className="lp-body">
        <Canvas
          graph={graph}
          loaded={tree !== null}
          onToggleNode={onToggleNode}
          selectedId={selectedId}
          onSelectNode={setSelectedId}
          focus={focus}
          emptyTitle={filtersActive ? "No nodes match the filters" : undefined}
          emptyText={
            filtersActive
              ? "Loosen or clear the kind/status/version filters to see the tree again."
              : undefined
          }
        />
        <DetailsPanel
          detail={detail}
          loading={detailLoading}
          error={detailError}
          resolveName={resolveName}
        />
      </div>
      <Legend />
    </div>
  );
}
