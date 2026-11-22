import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { sessionsForAgent } from "../shared/agent-sessions";
import { defaultHostTypography, scaledFont } from "../shared/host-fonts";
import type { AgentSession } from "../shared/session-manager";
import { deleteSessions, exportSession, listSessions } from "../shared/session-manager";
import { formatBytes, needsForce } from "../shared/session-summary";
import { DEFAULT_SETTINGS, sessionManagerSettings } from "../shared/settings";
import { ageLabel, errorMessage, sessionKey, sortSessions } from "./present";
import { readHostTypography } from "./web";

/**
 * Per-agent sessions panel (0.7.0, `addAgentPanel`).
 *
 * The workspace panel answers "what is on this machine"; before deleting, the
 * question is "what does *this* agent own". Paseo records the provider session a
 * Paseo agent points at, and the listing already carries that link, so this panel
 * is the same listing filtered to `params.agentId` — no second RPC, no schema
 * guess. It keeps the destructive flow of the workspace panel (two-step confirm,
 * a force step for running or referenced-elsewhere sessions) but can only ever act
 * on the sessions of the agent it was opened for.
 */
export function AgentSessionsPanel({ theme, layout, params }: PluginAgentPanelProps) {
  const listRpc = useRpc(listSessions);
  const deleteRpc = useRpc(deleteSessions);
  const exportRpc = useRpc(exportSession);
  const toast = useToast();
  const queryClient = useQueryClient();

  const settings = useSettings(sessionManagerSettings);
  const settingsValues = settings.status === "ready" ? settings.values : DEFAULT_SETTINGS;

  const [pending, setPending] = useState<AgentSession | null>(null);

  // The same query key as the workspace panel: opening this panel after the other
  // one reuses its result instead of rescanning every store.
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["session-manager", "sessions"],
    queryFn: () => listRpc({}),
  });

  const sessions = data?.sessions ?? [];
  const providerStatuses = data?.providers ?? [];

  const labelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const status of providerStatuses) map.set(status.id, status.label);
    return map;
  }, [providerStatuses]);

  const detectedOf = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const status of providerStatuses) map.set(status.id, status.detected);
    return map;
  }, [providerStatuses]);

  const rows = useMemo(
    () =>
      sortSessions(
        sessionsForAgent(sessions, params.agentId),
        settingsValues.sortOldestFirst,
      ),
    [sessions, params.agentId, settingsValues.sortOldestFirst],
  );

  const deleteMutation = useMutation({
    mutationFn: (session: AgentSession) =>
      deleteRpc({
        targets: [{ provider: session.provider, id: session.id }],
        // A running session, or one this panel's own agent holds open, is only
        // deleted after the explicit "delete anyway" step.
        force: needsForce(session),
      }),
    onSuccess: (result, session) => {
      if (result.deleted > 0) {
        toast.show(`Deleted ${session.title ?? session.id}`, { variant: "success" });
      }
      for (const failure of result.failures) toast.error(`${failure.id}: ${failure.error}`);
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ["session-manager", "sessions"] });
    },
    onError: (mutationError) => {
      toast.error(errorMessage(mutationError, "Failed to delete the session"));
      setPending(null);
    },
  });

  const exportMutation = useMutation({
    mutationFn: (session: AgentSession) =>
      exportRpc({ provider: session.provider, id: session.id }),
    onSuccess: (result, session) => {
      if (result.exported && result.path) {
        toast.show(`Exported ${session.id} to ${result.path}`, { variant: "success" });
        return;
      }
      toast.error(`${session.id}: ${result.error ?? "export failed"}`);
    },
    onError: (mutationError, session) => {
      toast.error(`${session.id}: ${errorMessage(mutationError, "export failed")}`);
    },
  });

  const styles = useMemo(() => {
    const typography = readHostTypography() ?? defaultHostTypography();
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
      title: {
        color: theme.colors.foreground,
        fontSize: font(16),
        fontWeight: "600" as const,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: font(12) },
      row: {
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginBottom: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
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
      rowTitle: {
        color: theme.colors.foreground,
        fontWeight: "600" as const,
        flexShrink: 1,
        fontSize: font(14),
      },
      actions: {
        flexDirection: "row" as const,
        gap: 12,
        marginTop: 8,
        alignItems: "center" as const,
      },
      danger: { color: theme.colors.statusDanger, fontWeight: "600" as const },
      warning: { color: theme.colors.statusWarning, fontSize: font(12), marginTop: 4 },
      mutedAction: { color: theme.colors.foregroundMuted, fontSize: font(12) },
      confirmBox: {
        marginTop: 10,
        marginBottom: 12,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        backgroundColor: theme.colors.surface2,
      },
    };
  }, [theme, layout.compact]);

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
        <Text style={styles.title}>This agent&apos;s sessions</Text>
        <Pressable accessibilityRole="button" onPress={() => void refetch()}>
          <Text style={styles.muted}>{isFetching ? "Scanning..." : "Rescan"}</Text>
        </Pressable>
      </View>

      <Text style={styles.muted}>
        {rows.length === 0
          ? "No session store references this agent"
          : `${rows.length} session(s) referenced by this agent`}
        {data?.scannedAt ? ` · scanned ${ageLabel(data.scannedAt)}` : ""}
      </Text>

      {pending ? (
        <View style={styles.confirmBox}>
          <Text style={styles.muted}>
            Delete {pending.title ?? pending.id} (
            {labelOf.get(pending.provider) ?? pending.provider})?
          </Text>
          {needsForce(pending) ? (
            <Text style={styles.warning}>
              {pending.running
                ? "This session is still running; deleting it can lose the live transcript."
                : "A Paseo agent still references this session; deleting it breaks its resume."}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={deleteMutation.isPending}
              onPress={() => deleteMutation.mutate(pending)}
            >
              <Text style={styles.danger}>
                {deleteMutation.isPending
                  ? "Working..."
                  : needsForce(pending)
                    ? "Yes, delete anyway"
                    : "Yes, delete"}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPending(null)}>
              <Text style={styles.mutedAction}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <ScrollView style={{ marginTop: 12 }}>
        {rows.map((session) => {
          const size = formatBytes(session.sizeBytes);
          const providerLabel = labelOf.get(session.provider) ?? session.provider;
          const exportable = detectedOf.get(session.provider) === true;
          return (
            <View key={sessionKey(session)} style={styles.row}>
              <View style={styles.rowHeader}>
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
                {session.paseoAgent?.archived ? " · archived agent" : ""}
              </Text>

              {session.cwd ? (
                <Text style={styles.muted} numberOfLines={1}>
                  {session.cwd}
                </Text>
              ) : null}

              <View style={styles.actions}>
                {exportable ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={exportMutation.isPending}
                    onPress={() => exportMutation.mutate(session)}
                  >
                    <Text style={styles.mutedAction}>Export</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setPending(session)}
                >
                  <Text style={styles.danger}>Delete...</Text>
                </Pressable>
              </View>
            </View>
          );
        })}

        {rows.length === 0 && !error ? (
          <Text style={styles.muted}>
            Paseo only links a provider session once the agent has written one, and the link is
            read from the agent records at scan time. Use Rescan after the agent starts a
            session; the workspace panel lists the whole store.
          </Text>
        ) : null}

        {error ? (
          <Text style={[styles.danger, { marginTop: 12 }]}>
            {errorMessage(error, "Failed to load sessions")}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
