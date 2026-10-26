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
 * - **I1 3D spike**: the toolbar's 2D/3D switch is real. WebGL is probed once
 *   (`dashboard/src/webgl.ts`), the 3D scene arrives through the lazy
 *   `dashboard-3d.js` chunk only after the probe passed, and a tab without
 *   WebGL keeps the 2D diagram with an explanation in the status line.
 * - **I2 3D tree**: the same tree feeds a pure radial layout
 *   (`dashboard/src/tree-3d.ts` — depth becomes height, siblings fan around
 *   the trunk axis) which the scene draws as sphere/tubes/sprites; the model
 *   is rebuilt on every tree refetch and handed to the live scene.
 * - **I3 3D overlays**: the same payload also feeds a pure overlay
 *   (`dashboard/src/overlay-3d.ts`) — bee arcs with their particles, blocking
 *   incidents, goal rings and (in the growth layer) growth halos. The overlay
 *   is rebuilt with the model and the layer, and travels with the model into
 *   the scene as one view.
 * - **I4 3D interaction**: a click in the scene selects a node and fills the
 *   *same* details panel the 2D canvas fills; the selection is drawn in the
 *   scene (a ring, a label, the nodes sharing an incident, the links of the
 *   node) and a search flies the camera to the node. The toolbar filters
 *   narrow the 3D tree by the same rule the 2D diagram uses, and the 2D/3D
 *   choice is remembered in the URL and in the tab's own storage.
 * - **K1 plain board** (ADR-10): the default view is a card board — zones
 *   of planned / in-motion / done work built by the pure adapter
 *   (`dashboard/src/plain.ts`) from the same `/api/tree` payload, with
 *   collapsible tree sections and the same toolbar filters (one
 *   `matchingWithAncestors` rule for three views). The details panel hides
 *   itself here — the K2 modal takes its job — and a search opens the
 *   sections down to the hit and scrolls its card into view.
 *
 * State rules kept deliberately small so later stages can extend them
 * without a rewrite: one `load()` effect keyed on the resolved client, one
 * status line for every non-fatal error, the collapse set that survives
 * refetches (the default policy applies to the first payload only), and the
 * selection which is just an id — the detail record is a separate state so
 * a stale response can never overwrite a newer selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import {
  changesTouchNode,
  type NodeResponse,
  type StatsResponse,
  type TreeResponse,
} from "../../shared/api";
import { DashboardApi, resolveApiOrigin } from "./api";
import { KIND_LABELS, STATUS_LABELS } from "./colors";
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
import {
  clampDetailsWidth,
  DEFAULT_DETAILS_WIDTH,
  forgetDetailsWidth,
  readStoredDetailsWidth,
  storeDetailsWidth,
  type DetailsWidthStorage,
} from "./details-width";
import { createChangeStream } from "./live";
import { buildSceneOverlay, EMPTY_OVERLAY } from "./overlay-3d";
import {
  buildPlainBoard,
  defaultPlainCollapse,
  EMPTY_PLAIN_BOARD,
  plainReveal,
  togglePlainSection,
  type PlainCardKind,
} from "./plain";
import {
  EMPTY_INTERACTION,
  focusTarget,
  pickCandidates,
  selectionHighlight,
  type SceneInteraction,
} from "./pick-3d";
import { buildScene3D } from "./tree-3d";
import {
  initialView,
  viewSearch,
  writeStoredView,
  type ViewStorage,
} from "./view-state";
import {
  detectWebGL,
  planViewSwitch,
  type DashboardView,
} from "./webgl";
import { resolveTheme, THEME_STORAGE_KEY, tokensFor, type ThemeName } from "./theme";
import { Canvas } from "./components/Canvas";
import { DetailsPanel } from "./components/DetailsPanel";
import { DetailModal } from "./components/DetailModal";
import { NodeDetailContent } from "./components/NodeDetailContent";
import { GoalDetailContent } from "./components/GoalDetailContent";
import { BugDetailContent } from "./components/BugDetailContent";
import { Legend } from "./components/Legend";
import { PlainView } from "./components/PlainView";
import { ThreeView, type ThreeViewState } from "./components/ThreeView";
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

/**
 * The details panel's width (stage I4 follow-up) — the rules live in
 * `dashboard/src/details-width.ts` (pure, testable without a DOM).
 */
function detailsStorage(): DetailsWidthStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Shown when the growth layer is switched on in a project without records. */
const GROWTH_EMPTY_HINT =
  "No growth records in this project yet — the heat layer stays neutral (agents write them with luck_tree_update_growth).";

/** Shown when the 3D view is on but the filters left the tree empty. */
const SCENE_EMPTY_HINT =
  "No nodes match the filters — the 3D tree is empty. Loosen or clear the kind/status/version filters.";

/**
 * The tab's storage, or `null` when the browser forbids it (private mode,
 * disabled cookies). A storage that throws is a storage that does not exist.
 */
function safeStorage(): ViewStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Writes the current view into the address bar (stage I4), keeping the token
 * and the project parameter. A copied link then opens in the same diagram
 * the sender was looking at.
 */
function syncViewToUrl(view: DashboardView): void {
  const search = viewSearch(window.location.search, view);
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${search}${window.location.hash}`,
  );
}

/** Connection state of the SSE stream (stage H1), incl. "not open yet". */
type LiveState = "connecting" | "live" | "offline";

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
  // K1 plain board: collapsed *sections* (keys from `plain.ts`), separate
  // from the 2D canvas collapse — the two views remember their own shape.
  const [plainCollapsed, setPlainCollapsed] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // K1: the entity the toolbar search should scroll into view on the board.
  const [plainScrollTarget, setPlainScrollTarget] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("");
  const [theme] = useState<ThemeName>(initialTheme);
  // The details panel is resizable; the width survives a reload.
  const [detailsWidth, setDetailsWidth] = useState(() =>
    readStoredDetailsWidth(detailsStorage()),
  );

  // G4 interaction state.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<
    { kind: "node" | "goal" | "bug"; id: string } | null
  >(null);
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

  // I1 3D spike: which diagram is on screen, and whether this tab can draw
  // WebGL at all. The probe runs once per tab (it allocates and releases a
  // context); every 3D request goes through `planViewSwitch`.
  //
  // I4: the view is a *preference* — the URL names it (`?view=3d`), the tab
  // remembers it (localStorage), and the 2D diagram is the default. A tab
  // that asks for 3D without WebGL stays on 2D and says why.
  const webgl = useMemo(() => detectWebGL(), []);
  const storage = useMemo(() => safeStorage(), []);
  const [view, setView] = useState<DashboardView>(() => {
    const wanted = initialView(window.location.search, storage);
    return planViewSwitch(webgl, wanted).view;
  });

  // H1 live updates: the SSE connection state and a counter that forces the
  // details panel to refetch when a change touches the node it shows.
  const [live, setLive] = useState<LiveState>("connecting");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

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
      // keep whatever the user expanded or collapsed by hand. The plain board
      // gets the same treatment with its own budget (K1).
      setCollapsedIds((previous) =>
        previous.size > 0 ? previous : defaultCollapsedIds(nextTree.nodes),
      );
      setPlainCollapsed((previous) =>
        previous.size > 0
          ? previous
          : defaultPlainCollapse(buildPlainBoard(nextTree)),
      );
      setStatusLine("");
    } catch (cause) {
      setStatusLine(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, params.projectKey]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Stage H1: live updates. One SSE stream per tab; each `tree-changed` batch
   * refetches the project (the stream coalesces the burst) and refreshes the
   * details panel when the open node — or anything linked to it — moved.
   *
   * A **reconnect** refetches as well: events sent while the stream was down
   * are gone for good, and the first `open` of a fresh mount must not double
   * the initial `load()` above.
   */
  useEffect(() => {
    if (client === null) return;
    let opens = 0;
    const stream = createChangeStream({
      url: client.eventsUrl(),
      onStatus: (status) => {
        setLive(status.state);
        if (status.state !== "live") return;
        opens += 1;
        if (opens > 1) void load();
      },
      onTreeChanged: (event) => {
        void load();
        const current = selectedIdRef.current;
        if (current !== null && changesTouchNode(event.changes, current)) {
          setDetailRefresh((count) => count + 1);
        }
      },
    });
    return () => stream.close();
  }, [client, load]);

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
  }, [client, selectedId, detailRefresh]);

  const onToggleNode = useCallback((id: string): void => {
    setCollapsedIds((previous) => toggleCollapsed(previous, id));
  }, []);

  /** K1: toggles one plain-board section (pure helper of `plain.ts`). */
  const onTogglePlainSection = useCallback((key: string): void => {
    setPlainCollapsed((previous) => togglePlainSection(previous, key));
  }, []);

  /**
   * A card click (K1 + K2): every card opens the modal — a leaf card first
   * selects its node (the detail fetch this triggers is what the modal
   * renders), goal and bug cards render their content straight from the
   * already-loaded `/api/tree` payload.
   */
  const onPlainCardSelect = useCallback(
    (kind: PlainCardKind, entityId: string): void => {
      if (kind === "leaf") {
        setSelectedId(entityId);
        setModal({ kind: "node", id: entityId });
      } else if (kind === "goal") {
        setModal({ kind: "goal", id: entityId });
      } else if (kind === "bug") {
        setModal({ kind: "bug", id: entityId });
      }
    },
    [],
  );

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
   * Resolves a toolbar view request (I1). The plan decides both halves of the
   * acceptance: with WebGL the tab switches to the lazy scene, without it the
   * tab *stays* on 2D and the status line carries the explanation.
   *
   * I4 adds the memory: the choice is written into the address bar (so a
   * copied link opens in the same diagram) and into the tab's own storage
   * (so a reload comes back to it).
   */
  const onViewChange = useCallback(
    (target: DashboardView): void => {
      const plan = planViewSwitch(webgl, target);
      setView(plan.view);
      if (plan.status !== null) setStatusLine(plan.status);
      writeStoredView(storage, plan.view);
      syncViewToUrl(plan.view);
    },
    [storage, webgl],
  );

  // The opening view: a refused 3D request explains itself, and the address
  // bar always names the diagram this tab shows.
  useEffect(() => {
    const wanted = initialView(window.location.search, storage);
    const plan = planViewSwitch(webgl, wanted);
    if (plan.status !== null) setStatusLine(plan.status);
    syncViewToUrl(plan.view);
  }, [storage, webgl]);

  /**
   * Scene lifecycle (I1): progress and errors share the status line, and a
   * failed scene drops straight back to 2D — a blank viewport would be a
   * worse answer than the diagram that works.
   */
  const onSceneState = useCallback(
    (state: ThreeViewState, status: string): void => {
      setStatusLine(status);
      if (state === "failed") setView("2d");
    },
    [],
  );

  // K1 plain board: the card view over the same payload and the same
  // toolbar filters (one `matchingWithAncestors` rule for three views).
  const plainBoard = useMemo(
    () =>
      tree === null
        ? EMPTY_PLAIN_BOARD
        : buildPlainBoard(tree, { filter: filters }),
    [tree, filters],
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
        // K1: the board must show the hit too — open the sections down to
        // its card and scroll it into view (the G4 "found = visible" rule).
        const reveal = plainReveal(plainBoard, hit.id);
        if (reveal.sectionKeys.length > 0) {
          setPlainCollapsed((previous) => {
            const next = new Set(previous);
            for (const key of reveal.sectionKeys) next.delete(key);
            return next;
          });
        }
        if (reveal.cardId !== null) setPlainScrollTarget(hit.id);
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
    [client, plainBoard, revealNode, requestFocus],
  );

  const graph = useMemo(
    () =>
      tree === null
        ? EMPTY_GRAPH
        : buildGraph(tree, { collapsedIds, filter: filters, layer }),
    [tree, collapsedIds, filters, layer],
  );

  // K1 plain board: the card view over the same payload and the same
  // toolbar filters (one `matchingWithAncestors` rule for three views).
  // I2 3D layout: the same payload, a radial projection. Rebuilt when the
  // tree changes and when the toolbar filters narrow it (I4: both views show
  // the same nodes) — the collapse state stays a 2D-canvas concern.
  const scene3dModel = useMemo(
    () => (tree === null ? null : buildScene3D(tree.nodes, { filter: filters })),
    [tree, filters],
  );

  // I3 3D overlays: bees, blocking incidents, goal rings and — in the growth
  // layer only, exactly like the 2D heat layer — the growth halos. Rebuilt
  // when the layer changes because the layer *is* part of the overlay.
  const scene3dOverlay = useMemo(
    () =>
      tree === null || scene3dModel === null
        ? null
        : buildSceneOverlay(tree, scene3dModel, { layer }),
    [tree, scene3dModel, layer],
  );

  // I4: the identity of the *data* the scene shows. The camera re-frames when
  // it changes (a different tree) and stays put when it does not — a live
  // refetch or a filter that narrows the tree must not yank the view.
  const scene3dFitKey = useMemo(
    () => (tree === null ? "" : `${tree.nodes.length}:${tree.nodes[0]?.id ?? ""}`),
    [tree],
  );

  // I4: the pickable nodes — positions and radii for the click test. Rebuilt
  // with the model, not with the selection.
  const scene3dCandidates = useMemo(
    () => (scene3dModel === null ? [] : pickCandidates(scene3dModel)),
    [scene3dModel],
  );

  // I4: the interaction state the scene renders: the selection (with its
  // label and its position), the highlight of the links around it and a
  // possible camera flight. Computed here because the app is the only place
  // that knows the tree, the selection and the search.
  const scene3dInteraction = useMemo<SceneInteraction>(() => {
    if (tree === null || scene3dModel === null) return EMPTY_INTERACTION;
    const selected =
      selectedId === null
        ? null
        : (tree.nodes.find((node) => node.id === selectedId) ?? null);
    const position =
      selectedId === null
        ? null
        : (scene3dModel.nodes.find((node) => node.id === selectedId)?.position ?? null);
    const label =
      selected === null
        ? null
        : `${selected.name} — ${KIND_LABELS[selected.kind]} · ${STATUS_LABELS[selected.status]}`;
    const target = focus === null ? null : focusTarget(scene3dModel, focus.nodeId);
    return {
      selectedId,
      selectedLabel: label,
      selectedPosition: position,
      candidates: scene3dCandidates,
      highlight: selectionHighlight(
        scene3dModel,
        scene3dOverlay ?? EMPTY_OVERLAY,
        selectedId,
      ),
      focus:
        focus === null || target === null
          ? null
          : {
              nodeId: focus.nodeId,
              seq: focus.seq,
              position: target.position,
              distance: target.distance,
            },
    };
  }, [
    focus,
    scene3dCandidates,
    scene3dModel,
    scene3dOverlay,
    selectedId,
    tree,
  ]);

  // I4: an empty 3D tree (the filters hid everything) says so instead of
  // showing a blank viewport.
  const scene3dEmpty = scene3dModel !== null && scene3dModel.nodes.length === 0;
  useEffect(() => {
    if (view !== "3d") return;
    setStatusLine((previous) => {
      if (scene3dEmpty) return SCENE_EMPTY_HINT;
      return previous === SCENE_EMPTY_HINT ? "" : previous;
    });
  }, [scene3dEmpty, view]);

  const resolveName = useCallback(
    (id: string): string => {
      const node = tree?.nodes.find((candidate) => candidate.id === id);
      return node !== undefined ? node.name : `…${id.slice(0, 8)}`;
    },
    [tree],
  );

  const filtersActive = isFilterActive(filters);

  /** A new width while the user drags the panel's edge. */
  const onDetailsWidthChange = useCallback((width: number): void => {
    setDetailsWidth(clampDetailsWidth(width));
  }, []);

  /** The width once the drag ends — the moment to remember it. */
  const onDetailsWidthCommit = useCallback((width: number): void => {
    const clamped = clampDetailsWidth(width);
    setDetailsWidth(clamped);
    storeDetailsWidth(detailsStorage(), clamped);
  }, []);

  /** Back to the default width (double-click on the edge). */
  const onDetailsWidthReset = useCallback((): void => {
    setDetailsWidth(DEFAULT_DETAILS_WIDTH);
    forgetDetailsWidth(detailsStorage());
  }, []);

  return (
    <div className="lp-app">
      <Toolbar
        projectKey={params.projectKey}
        stats={stats}
        statusLine={statusLine}
        live={live}
        filters={filters}
        onFiltersChange={setFilters}
        onSearch={(query) => void onSearch(query)}
        layer={layer}
        onLayerChange={onLayerChange}
        view={view}
        onViewChange={onViewChange}
        webglOk={webgl.ok}
      />
      <div
        className={view === "plain" ? "lp-body lp-body-plain" : "lp-body"}
        style={
          {
            "--lp-details-width": `${detailsWidth}px`,
          } as React.CSSProperties
        }
      >
        {view === "plain" ? (
          <PlainView
            board={plainBoard}
            loaded={tree !== null}
            collapsed={plainCollapsed}
            onToggleSection={onTogglePlainSection}
            selectedEntityId={selectedId}
            onSelectCard={onPlainCardSelect}
            scrollTargetEntityId={plainScrollTarget}
            emptyTitle={filtersActive ? "No nodes match the filters" : undefined}
            emptyText={
              filtersActive
                ? "Loosen or clear the kind/status/version filters to see the board again."
                : undefined
            }
          />
        ) : view === "3d" ? (
          <ThreeView
            webgl={webgl}
            model={scene3dModel}
            overlay={scene3dOverlay}
            fitKey={scene3dFitKey}
            interaction={scene3dInteraction}
            onSelectNode={setSelectedId}
            onSceneState={onSceneState}
          />
        ) : (
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
        )}
        {/* K1: the modal of stage K2 takes the panel's job on the board —
            the "click a node on the diagram" placeholder would only confuse. */}
        {view === "plain" ? null : (
          <DetailsPanel
            detail={detail}
            loading={detailLoading}
            error={detailError}
            resolveName={resolveName}
            width={detailsWidth}
            onWidthChange={onDetailsWidthChange}
            onWidthCommit={onDetailsWidthCommit}
            onWidthReset={onDetailsWidthReset}
          />
        )}
      </div>
      <DetailModal
        open={modal !== null}
        title={
          modal === null
            ? ""
            : modal.kind === "node"
              ? (tree?.nodes.find((n) => n.id === modal.id)?.name ?? "Node")
              : modal.kind === "goal"
                ? "Goal"
                : "Incident"
        }
        onClose={() => {
          if (modal?.kind === "node") setSelectedId(null);
          setModal(null);
        }}
      >
        {modal?.kind === "node" && detail !== null ? (
          <NodeDetailContent detail={detail} resolveName={resolveName} />
        ) : null}
        {modal?.kind === "node" && detail === null ? (
          <p className="lp-details-empty">Loading…</p>
        ) : null}
        {modal?.kind === "goal" && tree !== null
          ? (() => {
              const goal = tree.goals.find((g) => g.id === modal.id);
              return goal ? <GoalDetailContent goal={goal} /> : null;
            })()
          : null}
        {modal?.kind === "bug" && tree !== null
          ? (() => {
              const bug = tree.bugs.find((b) => b.id === modal.id);
              return bug ? <BugDetailContent bug={bug} /> : null;
            })()
          : null}
      </DetailModal>
      <Legend />
    </div>
  );
}
