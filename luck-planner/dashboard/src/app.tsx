/**
 * The dashboard application shell (PLAN.md stage G1).
 *
 * Layout: toolbar (identity + counters + future controls), the diagram canvas,
 * the details panel and the legend — the regions stages G2–G5 fill in. What is
 * already real at G1: the app reads the token/project from the URL, talks to
 * the plugin's read-only HTTP API through the typed client, and renders the
 * live counters from `/api/stats`; the theme is the dashboard's own
 * dark/light palette, applied to `:root` as CSS custom properties.
 *
 * State rules kept deliberately small so later stages can extend them without
 * a rewrite: one `load()` effect keyed on the resolved client, one status line
 * for every non-fatal error (a dashboard that fails to fetch says why in the
 * toolbar instead of throwing to the console).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { StatsResponse } from "../../shared/api";
import { DashboardApi, resolveApiOrigin } from "./api";
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
      setStats(await client.stats());
      setStatusLine("");
    } catch (cause) {
      setStatusLine(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, params.projectKey]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="lp-app">
      <Toolbar projectKey={params.projectKey} stats={stats} statusLine={statusLine} />
      <div className="lp-body">
        <Canvas />
        <DetailsPanel />
      </div>
      <Legend />
    </div>
  );
}
