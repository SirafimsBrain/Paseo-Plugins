import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { changesTouchNode } from "../shared/api";
import type { Bee } from "../shared/links";
import type { Bug } from "../shared/links";
import type { Growth } from "../shared/growth";
import {
  PANEL_CHANGE_POLL_MS,
  dashboardStatus,
  growthGet,
  nodeDetail,
  nodeSetStatus,
  stats,
  treeChanges,
  treeGet,
  treeSearch,
} from "../shared/rpc";
import type { HistoryEntry, LeafStatus, Node } from "../shared/tree";
import { LEAF_STATUSES, NODE_KINDS } from "../shared/tree";
import {
  breadcrumbLabels,
  defaultPanelFilters,
  filterSections,
  nodeStatusLabel,
  versionBadge,
  type LeafStatusFilter,
  type NodeKindFilter,
  type TreeSection,
} from "../shared/panel";
import { type DashboardOpenReport, openDashboard } from "./dashboard-screen";
import { scaledFont } from "./host-font-scale";
import { useHostFontScale } from "./use-host-typography";

/**
 * Native workspace panel for the planning tree (PLAN.md stage E2).
 *
 * Outline (roots with children), status/kind filters, FTS search, counters,
 * and a details view (version, revision, status, bees, bugs, history) with
 * status moves. Everything renders from `theme.colors` and `layout.compact`;
 * the host font scale comes from `useHostFontScale`. No DOM, no canvas, no
 * WebGL — React Native primitives only.
 *
 * The panel addresses the tree of the current workspace: `projectKey` is the
 * workspace's `projectRootPath` (ADR-2 scoping), resolved through
 * `useWorkspace`.
 */

export interface DetailState {
  node: Node;
  path: Node[];
  children: Node[];
  bees: Bee[];
  bugs: Bug[];
  blockingBugs: Bug[];
  history: HistoryEntry[];
  growth: Growth | null;
}

export function LuckPlannerPanel(props: PluginWorkspacePanelProps) {
  const { theme, layout, workspaceId } = props;
  const fontScale = useHostFontScale();
  const font = (base: number) => scaledFont(base, fontScale);
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const border = theme.colors.border;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;
  const warning = theme.colors.statusWarning;
  const success = theme.colors.statusSuccess;
  const compact = layout.compact;

  const projectRootPath = useWorkspace(workspaceId, (workspace) => workspace.projectRootPath);

  const treeGetRpc = useRpc(treeGet);
  const treeSearchRpc = useRpc(treeSearch);
  const nodeDetailRpc = useRpc(nodeDetail);
  const nodeSetStatusRpc = useRpc(nodeSetStatus);
  const growthGetRpc = useRpc(growthGet);
  const statsRpc = useRpc(stats);
  const dashboardStatusRpc = useRpc(dashboardStatus);
  const changesRpc = useRpc(treeChanges);
  const paseo = usePaseo();

  const [sections, setSections] = useState<TreeSection[]>([]);
  const [counters, setCounters] = useState<{
    total: number;
    inProgress: number;
    done: number;
    openBugs: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<LeafStatusFilter>(null);
  const [kindFilter, setKindFilter] = useState<NodeKindFilter>(null);
  useEffect(() => {
    if (!projectRootPath) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const load = async () => {
      try {
        const [tree, projectStats] = await Promise.all([
          treeGetRpc({ projectKey: projectRootPath }),
          statsRpc({ projectKey: projectRootPath }),
        ]);
        if (cancelled) return;
        setSections(tree.roots);
        setCounters({
          total: projectStats.leaves.total,
          inProgress: projectStats.leaves.inProgress,
          done: projectStats.leaves.done,
          openBugs: projectStats.bugs.open,
        });
      } catch (cause) {
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : "Failed to load the tree");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectRootPath, reloadKey, treeGetRpc, statsRpc]);

  useEffect(() => {
    if (!projectRootPath || query.trim().length === 0) {
      setSearchHits(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void treeSearchRpc({
        projectKey: projectRootPath,
        query: query.trim(),
        statuses: statusFilter ? [statusFilter] : undefined,
        kinds: kindFilter ? [kindFilter] : undefined,
        limit: 50,
      })
        .then((result) => {
          if (cancelled) return;
          setSearchHits(result.results.map((hit: any) => hit.node));
        })
        .catch(() => {
          if (!cancelled) setSearchHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectRootPath, query, statusFilter, kindFilter, treeSearchRpc]);

  const openDetail = useCallback(
    async (nodeId: string) => {
      if (!projectRootPath) return;
      setSelectedId(nodeId);
      setDetailError(null);
      setActionError(null);
      try {
        const result = await nodeDetailRpc({ projectKey: projectRootPath, nodeId });
        setDetail(result);
      } catch (cause) {
        setDetail(null);
        setDetailError(cause instanceof Error ? cause.message : "Failed to load details");
      }
    },
    [nodeDetailRpc, projectRootPath],
  );

  const changeStatus = useCallback(
    async (nodeId: string, status: LeafStatus) => {
      if (!projectRootPath) return;
      setActing(true);
      setActionError(null);
      try {
        const result = await nodeSetStatusRpc({ projectKey: projectRootPath, nodeId, status });
        if (!result.ok || !result.node) {
          setActionError(result.error ?? "Status change failed");
          return;
        }
        await openDetail(nodeId);
        reload();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "Status change failed");
      } finally {
        setActing(false);
      }
    },
    [nodeSetStatusRpc, openDetail, projectRootPath, reload],
  );

  const [searchHits, setSearchHits] = useState<Node[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Stage F2: "Open dashboard" — resolve the live URL through the RPC and hand
  // it to the in-app browser (Electron) or the external opener. The report is
  // rendered under the counters row so a refusal explains itself.
  const [dashboardReport, setDashboardReport] = useState<DashboardOpenReport | null>(null);
  const [openingDashboard, setOpeningDashboard] = useState(false);
  const openDashboardAction = useCallback(async () => {
    if (!projectRootPath) return;
    setOpeningDashboard(true);
    try {
      setDashboardReport(
        await openDashboard({
          projectKey: projectRootPath,
          workspaceId,
          readStatus: (input) => dashboardStatusRpc(input),
          props,
          paseo,
        }),
      );
    } finally {
      setOpeningDashboard(false);
    }
  }, [dashboardStatusRpc, paseo, projectRootPath, props, workspaceId]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  // -------------------------------------------------------------------------
  // Stage H1: live updates. The plugin SDK has no server→client push, so the
  // panel **polls** the `tree-changes` RPC: one priming call publishes the
  // audit watermark (opening a panel must never replay the whole trail), then
  // every tick asks for the delta. A non-empty delta reloads the outline and
  // refreshes an open details panel.
  //
  // The cursor is a ref, not state: it drives no rendering, and as state it
  // would restart the poll timer on every tick. `live` (state) only says
  // whether the cursor is armed — the indicator must not claim liveness while
  // the first call has not answered.
  // -------------------------------------------------------------------------
  const watermarkRef = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const [livePrimed, setLivePrimed] = useState(false);

  useEffect(() => {
    if (!projectRootPath) return;
    watermarkRef.current = null;
    setLivePrimed(false);
    let cancelled = false;
    void changesRpc({ projectKey: projectRootPath })
      .then((result) => {
        if (cancelled) return;
        watermarkRef.current = result.watermark;
        setLivePrimed(true);
      })
      .catch(() => {
        // A failed prime leaves the cursor unset; the next panel open retries.
        if (!cancelled) setLivePrimed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [changesRpc, projectRootPath]);

  useEffect(() => {
    if (!projectRootPath) return;
    const timer = setInterval(() => {
      const since = watermarkRef.current;
      if (since === null || pollingRef.current) return;
      pollingRef.current = true;
      void changesRpc({ projectKey: projectRootPath, sinceId: since })
        .then((result) => {
          watermarkRef.current = result.watermark;
          if (result.changes.length === 0) return;
          reload();
          const current = selectedIdRef.current;
          if (current !== null && changesTouchNode(result.changes, current)) {
            void openDetail(current);
          }
        })
        .catch(() => {
          // Transient (a reloading plugin, a busy daemon): the next tick
          // retries from the same watermark, so nothing is skipped.
        })
        .finally(() => {
          pollingRef.current = false;
        });
    }, PANEL_CHANGE_POLL_MS);
    return () => clearInterval(timer);
  }, [changesRpc, openDetail, projectRootPath, reload]);

  if (!projectRootPath) {
    return (
      <View style={styles.container}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: font(13) }}>
          Open a workspace to see its planning tree.
        </Text>
      </View>
    );
  }

  const filters = {
    ...defaultPanelFilters(),
    query: searchHits ? "" : query,
    status: statusFilter,
    kind: kindFilter,
  };
  const visibleSections = filterSections(sections, filters);
  const listCount = searchHits
    ? searchHits.length
    : visibleSections.reduce((total, section) => total + 1 + section.children.length, 0);

  return (
    <View style={styles.container}>
      <View style={[styles.counters, { borderColor: border }]}>
        {loading ? (
          <Text style={{ color: fgMuted, fontSize: font(12) }}>Loading…</Text>
        ) : counters ? (
          <Text style={{ color: fg, fontSize: font(12) }}>
            {counters.total} leaves · {counters.inProgress} in progress · {counters.done} done ·{" "}
            {counters.openBugs} open bugs ·{" "}
            {/* H1: the panel polls `tree-changes`, so the outline follows
                agent writes with no manual reload. Worded, not colour-only. */}
            <Text style={{ color: livePrimed ? success : fgMuted }}>
              {livePrimed ? "live" : "connecting"}
            </Text>
          </Text>
        ) : (
          <Text style={{ color: fgMuted, fontSize: font(12) }}>No counters yet</Text>
        )}
        <View style={styles.counterActions}>
          <Pressable
            accessibilityRole="button"
            disabled={openingDashboard}
            onPress={() => void openDashboardAction()}
            style={styles.reloadButton}
          >
            <Text style={{ color: accent, fontSize: font(12), opacity: openingDashboard ? 0.5 : 1 }}>
              {openingDashboard ? "Opening…" : "Dashboard"}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={reload} style={styles.reloadButton}>
            <Text style={{ color: accent, fontSize: font(12) }}>Reload</Text>
          </Pressable>
        </View>
      </View>
      {loadError ? (
        <Text style={{ color: danger, fontSize: font(12), marginTop: 6 }}>{loadError}</Text>
      ) : null}
      {dashboardReport ? (
        <Text
          style={{
            color: dashboardReport.outcome === "unavailable" || dashboardReport.outcome === "error"
              ? danger
              : success,
            fontSize: font(11),
            marginTop: 6,
          }}
        >
          {dashboardReport.message}
        </Text>
      ) : null}

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search leaves…"
        placeholderTextColor={fgMuted}
        style={[
          styles.input,
          { borderColor: border, color: fg, fontSize: font(13), paddingVertical: compact ? 4 : 6 },
        ]}
      />
      {searching ? (
        <Text style={{ color: fgMuted, fontSize: font(11), marginTop: 4 }}>Searching…</Text>
      ) : null}

      <View style={styles.chipRow}>
        <FilterChip
          label="All statuses"
          active={statusFilter === null}
          onPress={() => setStatusFilter(null)}
          fg={statusFilter === null ? accent : fgMuted}
          fontSize={font(11)}
        />
        {LEAF_STATUSES.map((status) => (
          <FilterChip
            key={status}
            label={status}
            active={statusFilter === status}
            onPress={() => setStatusFilter(statusFilter === status ? null : status)}
            fg={statusFilter === status ? accent : fgMuted}
            fontSize={font(11)}
          />
        ))}
      </View>
      <View style={styles.chipRow}>
        <FilterChip
          label="All kinds"
          active={kindFilter === null}
          onPress={() => setKindFilter(null)}
          fg={kindFilter === null ? accent : fgMuted}
          fontSize={font(11)}
        />
        {NODE_KINDS.map((kind) => (
          <FilterChip
            key={kind}
            label={kind}
            active={kindFilter === kind}
            onPress={() => setKindFilter(kindFilter === kind ? null : kind)}
            fg={kindFilter === kind ? accent : fgMuted}
            fontSize={font(11)}
          />
        ))}
      </View>

      <ScrollView style={styles.flex}>
        {searchHits ? (
          <SearchList
            nodes={searchHits}
            selectedId={selectedId}
            onSelect={openDetail}
            fg={fg}
            fgMuted={fgMuted}
            border={border}
            fontSize={font(13)}
            smallFontSize={font(11)}
          />
        ) : (
          visibleSections.map((section) => (
            <SectionView
              key={section.node.id}
              section={section}
              expanded={expanded[section.node.id] ?? true}
              onToggle={() =>
                setExpanded((prev) => ({
                  ...prev,
                  [section.node.id]: !(prev[section.node.id] ?? true),
                }))
              }
              selectedId={selectedId}
              onSelect={openDetail}
              fg={fg}
              fgMuted={fgMuted}
              accent={accent}
              danger={danger}
              warning={warning}
              success={success}
              border={border}
              fontSize={font(13)}
              smallFontSize={font(11)}
              compact={compact}
            />
          ))
        )}
        {!loading && listCount === 0 ? (
          <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 8 }}>
            Nothing here yet — agents grow this tree as they work.
          </Text>
        ) : null}
      </ScrollView>

      {selectedId ? (
        <NodeDetails
          detail={detail}
          detailError={detailError}
          actionError={actionError}
          acting={acting}
          onStatus={changeStatus}
          fg={fg}
          fgMuted={fgMuted}
          border={border}
          accent={accent}
          danger={danger}
          fontSize={font(13)}
          smallFontSize={font(11)}
          projectKey={projectRootPath}
          growthGet={growthGetRpc}
          onChanged={reload}
        />
      ) : null}
    </View>
  );
}

function FilterChip({ label, active, onPress, fg, fontSize }: {
  label: string;
  active: boolean;
  onPress: () => void;
  fg: string;
  fontSize: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={{ color: fg, fontSize }}>{label}</Text>
    </Pressable>
  );
}

function statusColor(
  status: LeafStatus,
  danger: string,
  warning: string,
  success: string,
  muted: string,
): string {
  switch (status) {
    case "done":
      return success;
    case "in_progress":
    case "claimed":
      return warning;
    case "blocked":
      return danger;
    default:
      return muted;
  }
}

function SearchList({ nodes, selectedId, onSelect, fg, fgMuted, border, fontSize, smallFontSize }: {
  nodes: Node[];
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  fg: string;
  fgMuted: string;
  border: string;
  fontSize: number;
  smallFontSize: number;
}) {
  return (
    <View>
      {nodes.map((node) => (
        <Pressable
          key={node.id}
          accessibilityRole="button"
          onPress={() => onSelect(node.id)}
          style={[styles.row, { borderColor: border }, selectedId === node.id && styles.rowSelected]}
        >
          <Text style={{ color: fg, fontSize }} numberOfLines={2}>
            {node.name}
          </Text>
          <Text style={{ color: fgMuted, fontSize: smallFontSize }}>{nodeStatusLabel(node)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function SectionView({ section, expanded, onToggle, selectedId, onSelect, fg, fgMuted, accent, danger, warning, success, border, fontSize, smallFontSize, compact }: {
  section: TreeSection;
  expanded: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  fg: string;
  fgMuted: string;
  accent: string;
  danger: string;
  warning: string;
  success: string;
  border: string;
  fontSize: number;
  smallFontSize: number;
  compact: boolean;
}) {
  return (
    <View style={[styles.section, { borderColor: border }]}>
      <Pressable accessibilityRole="button" onPress={onToggle} style={styles.sectionHeader}>
        <Text style={{ color: fg, fontSize, fontWeight: "600" }} numberOfLines={1}>
          {expanded ? "▾" : "▸"} {section.node.name}
        </Text>
        <Text style={{ color: fgMuted, fontSize: smallFontSize }}>{section.children.length}</Text>
      </Pressable>
      {expanded
        ? section.children.map((child) => (
            <Pressable
              key={child.id}
              accessibilityRole="button"
              onPress={() => onSelect(child.id)}
              style={[styles.row, selectedId === child.id && { borderColor: accent, borderWidth: 1 }]}
            >
              <View style={styles.rowTitle}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: statusColor(child.status, danger, warning, success, fgMuted) },
                  ]}
                />
                <Text style={{ color: fg, fontSize, flex: 1 }} numberOfLines={compact ? 1 : 2}>
                  {child.name}
                </Text>
              </View>
              <Text style={{ color: fgMuted, fontSize: smallFontSize }}>
                {nodeStatusLabel(child)}
              </Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

function NodeDetails({ detail, detailError, actionError, acting, onStatus, fg, fgMuted, border, accent, danger, fontSize, smallFontSize, projectKey, growthGet }: {
  detail: DetailState | null;
  detailError: string | null;
  actionError: string | null;
  acting: boolean;
  onStatus: (nodeId: string, status: LeafStatus) => void;
  fg: string;
  fgMuted: string;
  border: string;
  accent: string;
  danger: string;
  fontSize: number;
  smallFontSize: number;
  projectKey: string;
  growthGet: (input: { projectKey: string; subjectType: "node" | "goal"; subjectId: string }) => Promise<{
    growth: null | { id: string };
    total: number;
    completed: number;
    failed: number;
    ratio: number;
  }>;
  onChanged: () => void;
}) {
  const [growth, setGrowth] = useState<{ total: number; completed: number; ratio: number } | null>(null);
  useEffect(() => {
    if (!detail) {
      setGrowth(null);
      return;
    }
    let cancelled = false;
    void growthGet({ projectKey, subjectType: "node", subjectId: detail.node.id })
      .then((result) => {
        if (!cancelled) setGrowth({ total: result.total, completed: result.completed, ratio: result.ratio });
      })
      .catch(() => {
        if (!cancelled) setGrowth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detail, growthGet, projectKey]);

  if (detailError) {
    return (
      <View style={[styles.details, { borderColor: border }]}>
        <Text style={{ color: danger, fontSize: smallFontSize }}>{detailError}</Text>
      </View>
    );
  }
  if (!detail) {
    return (
      <View style={[styles.details, { borderColor: border }]}>
        <Text style={{ color: fgMuted, fontSize: smallFontSize }}>Loading details…</Text>
      </View>
    );
  }
  const last = detail.history.length > 0 ? detail.history[detail.history.length - 1] : null;
  return (
    <View style={[styles.details, { borderColor: border }]}>
      <Text style={{ color: fgMuted, fontSize: smallFontSize }} numberOfLines={2}>
        {breadcrumbLabels(detail.path).join(" / ")}
      </Text>
      <Text style={{ color: fg, fontSize, fontWeight: "600", marginTop: 2 }} numberOfLines={2}>
        {detail.node.name}
      </Text>
      <Text style={{ color: fgMuted, fontSize: smallFontSize, marginTop: 2 }}>
        {versionBadge(detail.node)} · {nodeStatusLabel(detail.node)}
      </Text>
      {detail.node.description ? (
        <Text style={{ color: fg, fontSize: smallFontSize, marginTop: 4 }} numberOfLines={4}>
          {detail.node.description}
        </Text>
      ) : null}
      {growth && growth.total > 0 ? (
        <Text style={{ color: fgMuted, fontSize: smallFontSize, marginTop: 4 }}>
          Growth: {growth.completed}/{growth.total} ({Math.round(growth.ratio * 100)}%)
        </Text>
      ) : null}
      {detail.blockingBugs.length > 0 ? (
        <Text style={{ color: danger, fontSize: smallFontSize, marginTop: 4 }}>
          Blocked by: {detail.blockingBugs.map((bug) => bug.title).join(", ")}
        </Text>
      ) : null}
      {detail.node.kind === "leaf" ? (
        <View style={styles.chipRow}>
          {(["ready", "in_progress", "blocked", "done"] as const).map((status) => (
            <Pressable
              key={status}
              accessibilityRole="button"
              disabled={acting}
              onPress={() => onStatus(detail.node.id, status)}
              style={styles.smallButton}
            >
              <Text style={{ color: accent, fontSize: smallFontSize }}>{status}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {detail.bugs.length > 0 ? (
        <Text style={{ color: fgMuted, fontSize: smallFontSize, marginTop: 4 }}>
          Bugs: {detail.bugs.map((bug) => `${bug.title} (${bug.status})`).join("; ")}
        </Text>
      ) : null}
      {detail.bees.length > 0 ? (
        <Text style={{ color: fgMuted, fontSize: smallFontSize, marginTop: 4 }}>
          Bees: {detail.bees.length} influence link(s)
        </Text>
      ) : null}
      {last ? (
        <Text style={{ color: fgMuted, fontSize: smallFontSize, marginTop: 4 }}>
          Last: {last.action} by {last.actor ?? "unknown"} — {last.result}
        </Text>
      ) : null}
      {actionError ? (
        <Text style={{ color: danger, fontSize: smallFontSize, marginTop: 4 }}>{actionError}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12 },
  flex: { flex: 1 },
  counters: { flexDirection: "row", alignItems: "center", borderBottomWidth: 1, paddingBottom: 6, gap: 12 },
  counterActions: { flexDirection: "row", alignItems: "center", gap: 12, marginLeft: "auto" },
  reloadButton: { paddingVertical: 4 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, marginTop: 8 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderColor: "transparent" },
  chipActive: { borderWidth: 1, borderRadius: 10 },
  section: { borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 8 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  row: { borderTopWidth: 1, paddingVertical: 6, gap: 2, marginTop: 4 },
  rowSelected: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 6 },
  rowTitle: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  details: { borderTopWidth: 1, marginTop: 8, paddingTop: 8, gap: 2 },
  smallButton: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
});

