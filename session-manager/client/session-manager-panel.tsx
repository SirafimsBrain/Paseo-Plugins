import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { AgentSession, SessionTarget } from "../shared/session-manager";
import { deleteSessions, listSessions } from "../shared/session-manager";

const AGE_FILTERS: { label: string; days: number }[] = [
  { label: "Any age", days: 0 },
  { label: "> 1 day", days: 1 },
  { label: "> 7 days", days: 7 },
  { label: "> 30 days", days: 30 },
];

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

export function SessionManagerPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const listRpc = useRpc(listSessions);
  const deleteBatchRpc = useRpc(deleteSessions);
  const toast = useToast();
  const queryClient = useQueryClient();

  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [ageDays, setAgeDays] = useState<number>(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<SessionTarget[] | null>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["session-manager", "sessions"],
    queryFn: () => listRpc({}),
  });

  const sessions = data?.sessions ?? [];
  const providerStatuses = data?.providers ?? [];

  const rows = useMemo(() => {
    return sessions.filter(
      (session) =>
        (providerFilter === "all" || session.provider === providerFilter) &&
        isOldEnough(session, ageDays),
    );
  }, [sessions, providerFilter, ageDays]);

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

  const deleteMutation = useMutation({
    mutationFn: (input: { targets: SessionTarget[]; force: boolean }) =>
      deleteBatchRpc({ targets: input.targets, force: input.force }),
    onSuccess: (result) => {
      if (result.deleted > 0) {
        toast.show(`Deleted ${result.deleted} session(s)`, { variant: "success" });
      }
      for (const failure of result.failures.slice(0, 3)) {
        toast.error(`${failure.id}: ${failure.error}`);
      }
      if (result.deleted === 0 && result.failures.length === 0) {
        toast.show("Nothing was deleted", { variant: "warning" });
      }
      setSelected([]);
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ["session-manager", "sessions"] });
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error ? mutationError.message : "Failed to delete sessions",
      );
      setPending(null);
    },
  });

  const styles = useMemo(
    () => ({
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
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
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
      chipText: { color: theme.colors.foreground, fontSize: 12 },
      chipTextActive: { color: theme.colors.accentForeground, fontSize: 12 },
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
      badgeText: { color: theme.colors.foregroundMuted, fontSize: 10 },
      rowTitle: { color: theme.colors.foreground, fontWeight: "600" as const, flexShrink: 1 },
      actions: { flexDirection: "row" as const, gap: 12, marginTop: 8, alignItems: "center" as const },
      danger: { color: theme.colors.statusDanger, fontWeight: "600" as const },
      warning: { color: theme.colors.statusWarning, fontSize: 12, marginTop: 4 },
      success: { color: theme.colors.statusSuccess, fontSize: 12 },
      confirmBox: {
        marginTop: 10,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        backgroundColor: theme.colors.surface2,
      },
    }),
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

  function requestDelete(targets: AgentSession[]) {
    setPending(targets.map((session) => ({ provider: session.provider, id: session.id })));
  }

  function confirmDelete() {
    if (!pending) return;
    deleteMutation.mutate({ targets: pending, force: pendingRisky.length > 0 });
  }

  const failingProviders = providerStatuses.filter(
    (status) => status.error !== null || (status.detected && !status.deletable),
  );

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

      <View style={[styles.chipRow, { marginTop: 10 }]}>
        <Pressable
          accessibilityRole="button"
          style={providerFilter === "all" ? styles.chipActive : styles.chip}
          onPress={() => setProviderFilter("all")}
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
              onPress={() => setProviderFilter(status.id)}
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
            onPress={() => setAgeDays(filter.days)}
          >
            <Text style={ageDays === filter.days ? styles.chipTextActive : styles.chipText}>
              {filter.label}
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
          {pendingRisky.length > 0 ? (
            <Text style={styles.warning}>
              {pendingRisky.length} session(s) are running or still referenced by an open Paseo
              agent and will be force-deleted.
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
                  ? "Deleting..."
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
                {size ? ` · ${size}` : ""}
                {session.running ? " · running" : ""}
                {session.paseoAgent ? " · Paseo agent" : ""}
              </Text>

              {session.cwd ? (
                <Text style={styles.muted} numberOfLines={1}>
                  {session.cwd}
                </Text>
              ) : null}

              {session.paseoAgent ? (
                <Text style={session.paseoAgent.archived ? styles.muted : styles.warning}>
                  {session.paseoAgent.archived ? "Archived Paseo agent: " : "Open Paseo agent: "}
                  {session.paseoAgent.title ?? session.paseoAgent.id}
                </Text>
              ) : null}

              <View style={styles.actions}>
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

        {error ? (
          <Text style={[styles.danger, { marginTop: 12 }]}>
            {error instanceof Error ? error.message : "Failed to load sessions"}
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
