/**
 * The dashboard application shell (PLAN.md stages G1–G2).
 *
 * Layout: toolbar (identity + counters + future controls), the diagram canvas,
 * the details panel and the legend. What is real: the app reads the token and
 * project from the URL, talks to the plugin's read-only HTTP API through the
 * typed client, and renders the live counters from `/api/stats` plus the node
 * diagram from `/api/tree` — the G2 adapter (`dashboard/src/graph.ts`) maps
 * the payload to React Flow nodes/edges with a d3-hierarchy layout, honoring
 * the collapse set this shell owns. The theme is the dashboard's own
 * dark/light palette, applied to `:root` as CSS custom properties.
 *
 * State rules kept deliberately small so later stages can extend them without
 * a rewrite: one `load()` effect keyed on the resolved client, one status line
 * for every non-fatal error (a dashboard that fails to fetch says why in the
 * toolbar instead of throwing to the console), and the collapse set that
 * survives refetches (the default policy applies to the first payload only).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { StatsResponse, TreeResponse } from "../../shared/api";
import { DashboardApi, resolveApiOrigin } from "./api";
import {
  buildGraph,
  defaultCollapsedIds,
  EMPTY_GRAPH,
  toggleCollapsed,
} from "./graph";
import { parseDashboardParams } from "./params";
import { resolveTheme, THEME_STORAGE_KEY, tokensFor, type ThemeName } from "./theme";
import { Canvas } from "./components/Canvas";
import { DetailsPanel } from "./components/DetailsPanel";
import { Legend } from "./components/Legend";
import { Toolbar } from "./components/Toolbar";

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

  const onToggleNode = useCallback((id: string): void => {
    setCollapsedIds((previous) => toggleCollapsed(previous, id));
  }, []);

  const graph = useMemo(
    () => (tree === null ? EMPTY_GRAPH : buildGraph(tree, { collapsedIds })),
    [tree, collapsedIds],
  );

  return (
    <div className="lp-app">
      <Toolbar projectKey={params.projectKey} stats={stats} statusLine={statusLine} />
      <div className="lp-body">
        <Canvas
          graph={graph}
          loaded={tree !== null}
          onToggleNode={onToggleNode}
        />
        <DetailsPanel />
      </div>
      <Legend />
    </div>
  );
}
