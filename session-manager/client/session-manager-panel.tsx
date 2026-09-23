import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { AgentSession, SessionTarget } from "../shared/session-manager";
import { deleteSessions, exportSession, listSessions } from "../shared/session-manager";
import { DEFAULT_SETTINGS, sessionManagerSettings } from "../shared/settings";
import {
  clearSessionManagerIntent,
  getSessionManagerIntent,
  subscribeSessionManagerIntent,
} from "./intent";
import {
  defaultHostTypography,
  readHostTypographyFromLocalStorage,
  scaledFont,
} from "../shared/host-fonts";

const AGE_FILTERS: { label: string; days: number }[] = [
  { label: "Any age", days: 0 },
  { label: "> 1 day", days: 1 },
  { label: "> 7 days", days: 7 },
  { label: "> 30 days", days: 30 },
];

const SORT_OPTIONS: { label: string; oldestFirst: boolean }[] = [
  { label: "Oldest first", oldestFirst: true },
  { label: "Newest first", oldestFirst: false },
];

/**
 * A batch runs through the RPC in chunks: one request per provider keeps the
 * server side cheap, while chunking gives the panel a real "x of y" progress
 * and keeps a long delete from looking like a hang.
 */
const DELETE_CHUNK_SIZE = 25;

interface Filters {
  providerFilter: string;
  ageDays: number;
  archivedOnly: boolean;
}

interface Progress {
  phase: "export" | "delete";
  done: number;
  total: number;
}

function ageLabel(iso: string | null): string {
  if (!iso) return "unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "unknown";
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours}h ago`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

function formatBytes(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function sessionKey(session: AgentSession): string {
  return `${session.provider}:${session.id}`;
}

function isOldEnough(session: AgentSession, days: number): boolean {
  if (days <= 0) return true;
  if (!session.updatedAt) return true;
  const ms = Date.now() - new Date(session.updatedAt).getTime();
  return Number.isNaN(ms) || ms >= days * 86_400_000;
}

function needsForce(session: AgentSession): boolean {
  return session.running || (session.paseoAgent !== null && !session.paseoAgent.archived);
}

function filterSessions(sessions: AgentSession[], filters: Filters): AgentSession[] {
  return sessions.filter(
    (session) =>
      (filters.providerFilter === "all" || session.provider === filters.providerFilter) &&
      isOldEnough(session, filters.ageDays) &&
      (!filters.archivedOnly || session.paseoAgent?.archived === true),
  );
}

/** Oldest sessions first by default: that is the order deletion work needs. */
function sortSessions(sessions: AgentSession[], oldestFirst: boolean): AgentSession[] {
  const timestamp = (value: string | null): number => {
    if (!value) return oldestFirst ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? (oldestFirst ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY) : parsed;
  };
  return [...sessions].sort((a, b) =>
    oldestFirst
      ? timestamp(a.updatedAt) - timestamp(b.updatedAt)
      : timestamp(b.updatedAt) - timestamp(a.updatedAt),
  );
}

/** Sum of the sizes the store reported; null when no row knew its size. */
function knownBytes(sessions: AgentSession[]): number | null {
  const known = sessions.filter((session) => session.sizeBytes !== null);
  if (known.length === 0) return null;
  return known.reduce((total, session) => total + (session.sizeBytes ?? 0), 0);
}

/** Directory part of an export path, without importing `node:path` on mobile. */
function directoryOf(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const index = filePath.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SessionManagerPanel({ theme, layout, navigation }: PluginWorkspacePanelProps) {
  const listRpc = useRpc(listSessions);
  const deleteBatchRpc = useRpc(deleteSessions);
  const exportRpc = useRpc(exportSession);
  const toast = useToast();
  const queryClient = useQueryClient();

  const settings = useSettings(sessionManagerSettings);
  const settingsValues = settings.status === "ready" ? settings.values : DEFAULT_SETTINGS;

  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [ageDays, setAgeDays] = useState<number>(0);
  const [archivedOnly, setArchivedOnly] = useState<boolean>(false);
  const [oldestFirst, setOldestFirst] = useState<boolean>(DEFAULT_SETTINGS.sortOldestFirst);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<SessionTarget[] | null>(null);
  const [exportBeforeDelete, setExportBeforeDelete] = useState<boolean>(
    DEFAULT_SETTINGS.exportBeforeDelete,
  );
  const [progress, setProgress] = useState<Progress | null>(null);
  const forceRefresh = useRef(false);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["session-manager", "sessions"],
    queryFn: () => {
      // "Rescan" has to bypass the server-side listing cache; recomputing the
      // list after a delete does not, because deleting invalidates it already.
      const refresh = forceRefresh.current;
      forceRefresh.current = false;
      return refresh ? listRpc({ refresh: true }) : listRpc({});
    },
  });

  const sessions = data?.sessions ?? [];
  const providerStatuses = data?.providers ?? [];

  const filters: Filters = useMemo(
    () => ({ providerFilter, ageDays, archivedOnly }),
    [providerFilter, ageDays, archivedOnly],
  );

  const rows = useMemo(
    () => sortSessions(filterSessions(sessions, filters), oldestFirst),
    [sessions, filters, oldestFirst],
  );

  // Settings reach the client asynchronously: adopt them once, then let the
  // chips own the state for the rest of the session.
  const adoptedSettings = useRef(false);
  useEffect(() => {
    if (adoptedSettings.current || settings.status !== "ready") return;
    adoptedSettings.current = true;
    setOldestFirst(settings.values.sortOldestFirst);
    setExportBeforeDelete(settings.values.exportBeforeDelete);
  }, [settings]);

  // Filters requested by a Command Center item.
  const intent = useSyncExternalStore(
    subscribeSessionManagerIntent,
    getSessionManagerIntent,
    () => null,
  );
  const selectWhenLoaded = useRef(false);
  useEffect(() => {
    if (!intent) return;
    const next: Filters = {
      providerFilter: intent.providerFilter ?? providerFilter,
      ageDays: intent.ageDays ?? ageDays,
      archivedOnly: intent.archivedOnly ?? archivedOnly,
    };
    setProviderFilter(next.providerFilter);
    setAgeDays(next.ageDays);
    setArchivedOnly(next.archivedOnly);
    setPending(null);
    if (intent.selectShown) {
      const matching = filterSessions(sessions, next);
      if (matching.length > 0) {
        setSelected(matching.map(sessionKey));
      } else {
        selectWhenLoaded.current = true;
      }
    }
    clearSessionManagerIntent();
    // The intent object is a fresh reference per command, which is what triggers
    // this effect; the filter setters above must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  useEffect(() => {
    if (!selectWhenLoaded.current || rows.length === 0) return;
    selectWhenLoaded.current = false;
    setSelected(rows.map(sessionKey));
  }, [rows]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of sessions) {
      map.set(session.provider, (map.get(session.provider) ?? 0) + 1);
    }
    return map;
  }, [sessions]);

  const labelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const status of providerStatuses) map.set(status.id, status.label);
    return map;
  }, [providerStatuses]);

  const statusOf = useMemo(() => {
    const map = new Map<string, (typeof providerStatuses)[number]>();
    for (const status of providerStatuses) map.set(status.id, status);
    return map;
  }, [providerStatuses]);

  const selectedSessions = useMemo(
    () => sessions.filter((session) => selected.includes(sessionKey(session))),
    [sessions, selected],
  );

  const pendingSessions = useMemo(() => {
    if (!pending) return [];
    return pending
      .map((target) =>
        sessions.find(
          (session) => session.provider === target.provider && session.id === target.id,
        ),
      )
      .filter((session): session is AgentSession => session !== undefined);
  }, [pending, sessions]);

  const pendingRisky = pendingSessions.filter(needsForce);
  const pendingBytes = knownBytes(pendingSessions);
  const pendingBlocked = useMemo(() => {
    const blocked = new Set<string>();
    for (const session of pendingSessions) {
      const status = statusOf.get(session.provider);
      if (status && !status.deletable) blocked.add(status.label);
    }
    return [...blocked];
  }, [pendingSessions, statusOf]);

  const pendingByProvider = useMemo(() => {
    const groups = new Map<string, { label: string; count: number; bytes: number | null }>();
    for (const session of pendingSessions) {
      const label = labelOf.get(session.provider) ?? session.provider;
      const current = groups.get(session.provider) ?? { label, count: 0, bytes: null };
      current.count += 1;
      if (session.sizeBytes !== null) current.bytes = (current.bytes ?? 0) + session.sizeBytes;
      groups.set(session.provider, current);
    }
    return [...groups.values()];
  }, [pendingSessions, labelOf]);

  const dueSessions = useMemo(() => {
    if (settingsValues.cleanupDays <= 0) return [];
    return sessions.filter(
      (session) => isOldEnough(session, settingsValues.cleanupDays) && !needsForce(session),
    );
  }, [sessions, settingsValues.cleanupDays]);

  const deleteMutation = useMutation({
    mutationFn: (input: { targets: SessionTarget[]; force: boolean; exportFirst: boolean }) =>
      runBatch(input.targets, input.force, input.exportFirst),
    onSuccess: (summary) => {
      if (summary.exported > 0) {
        const directory = directoryOf(summary.exportedPaths[0]);
        toast.show(
          `Exported ${summary.exported} session(s)${directory ? ` to ${directory}` : ""}`,
          { variant: "success" },
        );
      }
      for (const failure of summary.exportFailures.slice(0, 3)) {
        toast.error(`Export failed: ${failure}`);
      }
      if (summary.deleted > 0) {
        toast.show(`Deleted ${summary.deleted} session(s)`, { variant: "success" });
      }
      for (const failure of summary.failures.slice(0, 3)) {
        toast.error(`${failure.id}: ${failure.error}`);
      }
      if (summary.deleted === 0 && summary.failures.length === 0) {
        toast.show("Nothing was deleted", { variant: "warning" });
      }
      setSelected([]);
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ["session-manager", "sessions"] });
    },
    onError: (mutationError) => {
      toast.error(errorMessage(mutationError, "Failed to delete sessions"));
      setPending(null);
    },
    onSettled: () => setProgress(null),
  });

  const exportMutation = useMutation({
    mutationFn: (target: SessionTarget) =>
      exportRpc({ provider: target.provider, id: target.id }),
    onSuccess: (result, target) => {
      if (result.exported && result.path) {
        toast.show(`Exported ${target.id} to ${result.path}`, { variant: "success" });
        return;
      }
      toast.error(`${target.id}: ${result.error ?? "export failed"}`);
    },
    onError: (mutationError, target) => {
      toast.error(`${target.id}: ${errorMessage(mutationError, "export failed")}`);
    },
  });

  const styles = useMemo(
    () => {
      const typography = readHostTypographyFromLocalStorage(
        (globalThis as unknown as { localStorage?: { getItem(key: string): string | null } | undefined })
          .localStorage,
      ) ?? defaultHostTypography();
      const font = (base: number) => scaledFont(base, typography);
      return {
      root: {
        flex: 1,
        padding: layout.compact ? 12 : 20,
        backgroundColor: theme.colors.surface0,
      },
      headerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        marginBottom: 8,
      },
      title: { color: theme.colors.foreground, fontSize: font(16), fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: font(12) },
      chipRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
        marginBottom: 6,
      },
      chip: {
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      chipActive: {
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      chipText: { color: theme.colors.foreground, fontSize: font(12) },
      chipTextActive: { color: theme.colors.accentForeground, fontSize: font(12) },
      row: {
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginBottom: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      rowSelected: {
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginBottom: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      },
      rowHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      badge: {
        paddingVertical: 2,
        paddingHorizontal: 6,
        borderRadius: 4,
        backgroundColor: theme.colors.surface2,
      },
      badgeText: { color: theme.colors.foregroundMuted, fontSize: font(10) },
      rowTitle: { color: theme.colors.foreground, fontWeight: "600" as const, flexShrink: 1, fontSize: font(14) },
      actions: { flexDirection: "row" as const, gap: 12, marginTop: 8, alignItems: "center" as const },
      danger: { color: theme.colors.statusDanger, fontWeight: "600" as const },
      warning: { color: theme.colors.statusWarning, fontSize: font(12), marginTop: 4 },
      success: { color: theme.colors.statusSuccess, fontSize: font(12) },
      confirmBox: {
        marginTop: 10,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        backgroundColor: theme.colors.surface2,
      },
      noticeBox: {
        marginTop: 10,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      };
    },
    [theme, layout.compact],
  );

  function toggleSelection(session: AgentSession) {
    const key = sessionKey(session);
    setSelected((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
    setPending(null);
  }

  function selectAllShown() {
    setSelected(rows.map(sessionKey));
    setPending(null);
  }

  function selectDue() {
    setSelected(dueSessions.map(sessionKey));
    setPending(null);
  }

  function requestDelete(targets: AgentSession[]) {
    setPending(targets.map((session) => ({ provider: session.provider, id: session.id })));
  }

  function confirmDelete() {
    if (!pending) return;
    deleteMutation.mutate({
      targets: pending,
      force: pendingRisky.length > 0,
      exportFirst: exportBeforeDelete,
    });
  }

  /** Export then delete, in chunks, reporting progress between the awaits. */
  async function runBatch(targets: SessionTarget[], force: boolean, exportFirst: boolean) {
    const exportedPaths: string[] = [];
    const exportFailures: string[] = [];

    if (exportFirst) {
      for (let index = 0; index < targets.length; index += 1) {
        setProgress({ phase: "export", done: index, total: targets.length });
        const target = targets[index];
        try {
          const result = await exportRpc({ provider: target.provider, id: target.id });
          if (result.exported && result.path) {
            exportedPaths.push(result.path);
          } else {
            exportFailures.push(`${target.id}: ${result.error ?? "export failed"}`);
          }
        } catch (error) {
          exportFailures.push(`${target.id}: ${errorMessage(error, "export failed")}`);
        }
        setProgress({ phase: "export", done: index + 1, total: targets.length });
      }
    }

    let deleted = 0;
    const failures: { provider: string; id: string; error: string }[] = [];
    let processed = 0;
    setProgress({ phase: "delete", done: 0, total: targets.length });
    for (const batch of chunk(targets, DELETE_CHUNK_SIZE)) {
      const result = await deleteBatchRpc({ targets: batch, force });
      deleted += result.deleted;
      failures.push(...result.failures);
      processed += batch.length;
      setProgress({ phase: "delete", done: processed, total: targets.length });
    }

    return { exported: exportedPaths.length, exportedPaths, exportFailures, deleted, failures };
  }

  const failingProviders = providerStatuses.filter(
    (status) => status.error !== null || (status.detected && !status.deletable),
  );

  const storeSummaries = providerStatuses
    .filter((status) => status.detected)
    .map((status) => {
      const size = formatBytes(status.storeBytes);
      return {
        id: status.id,
        label: status.label,
        count: status.count,
        size: size ? `${size} store` : "store size unknown",
      };
    });

  if (isLoading) {
    return (
      <View style={styles.root}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={[styles.muted, { marginTop: 12 }]}>Scanning agent session stores...</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Agent sessions</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setPending(null);
            forceRefresh.current = true;
            refetch();
          }}
        >
          <Text style={styles.muted}>{isFetching ? "Scanning..." : "Rescan"}</Text>
        </Pressable>
      </View>

      <Text style={styles.muted}>
        {rows.length} of {sessions.length} sessions
        {data?.scannedAt ? ` · scanned ${ageLabel(data.scannedAt)}` : ""}
      </Text>

      {dueSessions.length > 0 ? (
        <View style={styles.noticeBox}>
          <Text style={styles.muted}>
            {dueSessions.length} session(s) older than {settingsValues.cleanupDays} days are due for
            cleanup. Nothing is deleted automatically: review the selection, then confirm.
          </Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={selectDue}>
              <Text style={styles.success}>Select due sessions</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={[styles.chipRow, { marginTop: 10 }]}>
        <Pressable
          accessibilityRole="button"
          style={providerFilter === "all" ? styles.chipActive : styles.chip}
          onPress={() => {
            setProviderFilter("all");
            setPending(null);
          }}
        >
          <Text style={providerFilter === "all" ? styles.chipTextActive : styles.chipText}>
            All ({sessions.length})
          </Text>
        </Pressable>
        {providerStatuses
          .filter((status) => status.count > 0)
          .map((status) => (
            <Pressable
              key={status.id}
              accessibilityRole="button"
              style={providerFilter === status.id ? styles.chipActive : styles.chip}
              onPress={() => {
                setProviderFilter(status.id);
                setPending(null);
              }}
            >
              <Text
                style={providerFilter === status.id ? styles.chipTextActive : styles.chipText}
              >
                {status.label} ({counts.get(status.id) ?? 0})
              </Text>
            </Pressable>
          ))}
      </View>

      <View style={styles.chipRow}>
        {AGE_FILTERS.map((filter) => (
          <Pressable
            key={filter.days}
            accessibilityRole="button"
            style={ageDays === filter.days ? styles.chipActive : styles.chip}
            onPress={() => {
              setAgeDays(filter.days);
              setPending(null);
            }}
          >
            <Text style={ageDays === filter.days ? styles.chipTextActive : styles.chipText}>
              {filter.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          style={archivedOnly ? styles.chipActive : styles.chip}
          onPress={() => {
            setArchivedOnly((current) => !current);
            setPending(null);
          }}
        >
          <Text style={archivedOnly ? styles.chipTextActive : styles.chipText}>
            Archived Paseo agents
          </Text>
        </Pressable>
      </View>

      <View style={styles.chipRow}>
        {SORT_OPTIONS.map((option) => (
          <Pressable
            key={option.label}
            accessibilityRole="button"
            style={oldestFirst === option.oldestFirst ? styles.chipActive : styles.chip}
            onPress={() => {
              setOldestFirst(option.oldestFirst);
              setPending(null);
            }}
          >
            <Text
              style={oldestFirst === option.oldestFirst ? styles.chipTextActive : styles.chipText}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={selectAllShown}>
          <Text style={styles.muted}>Select all shown</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setSelected([])}>
          <Text style={styles.muted}>Clear</Text>
        </Pressable>
        {selectedSessions.length > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => requestDelete(selectedSessions)}>
            <Text style={styles.danger}>Delete {selectedSessions.length} selected...</Text>
          </Pressable>
        ) : null}
      </View>

      {pending ? (
        <View style={styles.confirmBox}>
          <Text style={styles.danger}>
            Delete {pending.length} session{pending.length === 1 ? "" : "s"}?
          </Text>

          {pendingByProvider.map((group) => (
            <Text key={group.label} style={styles.muted}>
              {group.label}: {group.count}
              {group.bytes !== null ? ` · ${formatBytes(group.bytes)}` : " · size unknown"}
            </Text>
          ))}

          <Text style={[styles.muted, { marginTop: 4 }]}>
            {pendingBytes !== null
              ? `Known size to free: ${formatBytes(pendingBytes)}; stores without per-session sizes are not counted.`
              : "Per-session sizes are unknown for the selected stores; the freed space is reported per provider after the next scan."}
          </Text>

          {pendingRisky.length > 0 ? (
            <Text style={styles.warning}>
              {pendingRisky.length} session(s) are running or still referenced by an open Paseo
              agent and will be force-deleted.
            </Text>
          ) : null}

          {pendingBlocked.length > 0 ? (
            <Text style={styles.warning}>
              Deletion is unavailable for {pendingBlocked.join(", ")}; those sessions will fail.
            </Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={deleteMutation.isPending}
            onPress={() => setExportBeforeDelete((current) => !current)}
          >
            <Text style={styles.muted}>
              {exportBeforeDelete
                ? `☑ Export ${pending.length} session(s) first (Paseo home)`
                : "☐ Export before delete"}
            </Text>
          </Pressable>

          {progress ? (
            <Text style={styles.muted}>
              {progress.phase === "export" ? "Exporting" : "Deleting"} {progress.done} / {
                progress.total
              }
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={deleteMutation.isPending}
              onPress={confirmDelete}
            >
              <Text style={styles.danger}>
                {deleteMutation.isPending
                  ? "Working..."
                  : pendingRisky.length > 0
                    ? "Yes, delete anyway"
                    : "Yes, delete"}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPending(null)}>
              <Text style={styles.muted}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <ScrollView style={{ marginTop: 12 }}>
        {rows.map((session) => {
          const key = sessionKey(session);
          const isSelected = selected.includes(key);
          const size = formatBytes(session.sizeBytes);
          const providerLabel = labelOf.get(session.provider) ?? session.provider;
          const status = statusOf.get(session.provider);
          const exportable = status ? status.detected : false;
          const linkedAgent = session.paseoAgent;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              style={isSelected ? styles.rowSelected : styles.row}
              onPress={() => toggleSelection(session)}
            >
              <View style={styles.rowHeader}>
                <Text style={styles.badgeText}>{isSelected ? "◉" : "◯"}</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{providerLabel}</Text>
                </View>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {session.title ?? session.id}
                </Text>
              </View>

              <Text style={[styles.muted, { marginTop: 4 }]}>
                {ageLabel(session.updatedAt)}
                {size ? ` · ${size}` : " · size unknown"}
                {session.running ? " · running" : ""}
                {linkedAgent ? " · Paseo agent" : ""}
              </Text>

              {session.cwd ? (
                <Text style={styles.muted} numberOfLines={1}>
                  {session.cwd}
                </Text>
              ) : null}

              {linkedAgent ? (
                <Text style={linkedAgent.archived ? styles.muted : styles.warning}>
                  {linkedAgent.archived ? "Archived Paseo agent: " : "Open Paseo agent: "}
                  {linkedAgent.title ?? linkedAgent.id}
                </Text>
              ) : null}

              {linkedAgent && navigation ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => navigation.openAgent({ agentId: linkedAgent.id })}
                >
                  <Text style={styles.success}>Open agent in Paseo</Text>
                </Pressable>
              ) : null}

              <View style={styles.actions}>
                {exportable ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={exportMutation.isPending}
                    onPress={() =>
                      exportMutation.mutate({ provider: session.provider, id: session.id })
                    }
                  >
                    <Text style={styles.muted}>Export</Text>
                  </Pressable>
                ) : null}
                <Pressable accessibilityRole="button" onPress={() => requestDelete([session])}>
                  <Text style={styles.danger}>Delete...</Text>
                </Pressable>
              </View>
            </Pressable>
          );
        })}

        {rows.length === 0 ? (
          <Text style={styles.muted}>
            No sessions match the current filters. Rescan if the agent just wrote one.
          </Text>
        ) : null}

        {storeSummaries.length > 0 ? (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.title}>Stores</Text>
            {storeSummaries.map((store) => (
              <Text key={store.id} style={styles.muted} numberOfLines={2}>
                {store.label}: {store.count} session(s) · {store.size}
              </Text>
            ))}
          </View>
        ) : null}

        {error ? (
          <Text style={[styles.danger, { marginTop: 12 }]}>
            {errorMessage(error, "Failed to load sessions")}
          </Text>
        ) : null}

        {failingProviders.length > 0 ? (
          <View style={{ marginTop: 16 }}>
            {failingProviders.map((status) => (
              <Text key={status.id} style={styles.muted} numberOfLines={3}>
                {status.label}: {status.error ?? status.detail}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
