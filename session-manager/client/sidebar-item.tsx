import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { AgentSession, ProviderStatus } from "../shared/session-manager";
import { listSessions } from "../shared/session-manager";
import { DEFAULT_SETTINGS, sessionManagerSettings } from "../shared/settings";
import type { SessionSummary } from "../shared/session-summary";
import { formatBytes, summarizeSessions } from "../shared/session-summary";
import { scaledFont } from "../shared/host-fonts";
import { useHostTypography } from "./use-host-typography";

/**
 * Sidebar footer item (0.5.0): a status/count entry point for the plugin.
 *
 * A sidebar item receives `openScreen` and `openPopover`, but no `openPanel`
 * (the host reserves `openPanel` for Command Center callbacks), so the row
 * cannot open the Agent sessions workspace panel itself. It therefore opens a
 * summary popover — per-provider counts, the whole-store sizes and the cleanup
 * due count — and points at the panel for the destructive flow.
 *
 * The listing is fetched only when the popover opens, never on mount: every
 * scan spawns the vendor CLIs (`cline`, `opencode`, `kilo`), and an
 * always-visible row must not pay that cost on app start. The server-side
 * 30-second listing cache means a scan started here is reused by the panel.
 */

function SessionSummaryPopover({
  theme,
  layout,
  close,
  onSummary,
}: PluginPopoverProps & { onSummary(summary: SessionSummary): void }) {
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const listRpc = useRpc(listSessions);
  const settings = useSettings(sessionManagerSettings);
  const cleanupDays =
    settings.status === "ready" ? settings.values.cleanupDays : DEFAULT_SETTINGS.cleanupDays;

  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setRefreshing(refresh);
      setError(null);
      try {
        const result = refresh ? await listRpc({ refresh: true }) : await listRpc({});
        setSessions(result.sessions);
        setProviders(result.providers);
        setPhase("ready");
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Scan failed");
        setPhase("error");
      } finally {
        setRefreshing(false);
      }
    },
    [listRpc],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const summary = useMemo(
    () => summarizeSessions(sessions, providers, cleanupDays),
    [sessions, providers, cleanupDays],
  );

  // The row keeps the last counts it saw, so the footer stays informative after
  // the popover closes instead of falling back to "no badge".
  useEffect(() => {
    if (phase === "ready") onSummary(summary);
  }, [phase, summary, onSummary]);

  const detected = summary.providers.filter((provider) => provider.detected || provider.count > 0);
  const knownSize = formatBytes(summary.knownBytes);

  const styles = useMemo(
    () => ({
      root: {
        padding: layout.compact ? 12 : 16,
        gap: 8,
        minWidth: layout.compact ? 240 : 300,
        backgroundColor: theme.colors.surface1,
      },
      headerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: font(15),
        fontWeight: "600" as const,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: font(12) },
      warning: { color: theme.colors.statusWarning, fontSize: font(12) },
      danger: { color: theme.colors.statusDanger, fontSize: font(12) },
      providerRow: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        alignItems: "baseline" as const,
        gap: 12,
      },
      providerName: { color: theme.colors.foreground, fontSize: font(13) },
      providerDetail: { color: theme.colors.foregroundMuted, fontSize: font(12) },
      divider: {
        height: 1,
        backgroundColor: theme.colors.border,
        marginVertical: 4,
      },
      actions: {
        flexDirection: "row" as const,
        justifyContent: "flex-end" as const,
        gap: 12,
        marginTop: 4,
      },
      action: { color: theme.colors.accent, fontSize: font(12), fontWeight: "600" as const },
      loadingRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
    }),
    [theme, layout, typography],
  );

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Agent sessions</Text>
        <Pressable onPress={close} accessibilityRole="button">
          <Text style={styles.action}>Close</Text>
        </Pressable>
      </View>

      {phase === "loading" ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.muted}>Scanning session stores...</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.danger}>{error}</Text> : null}

      {phase === "ready" ? (
        <>
          <Text style={styles.muted}>
            {summary.total} {summary.total === 1 ? "session" : "sessions"} in {detected.length}{" "}
            {detected.length === 1 ? "store" : "stores"}
            {knownSize ? ` · ${knownSize} known` : ""}
          </Text>
          {cleanupDays > 0 ? (
            <Text style={summary.due > 0 ? styles.warning : styles.muted}>
              {summary.due} {summary.due === 1 ? "session" : "sessions"} due for cleanup (older
              than {cleanupDays} days)
            </Text>
          ) : (
            <Text style={styles.muted}>Cleanup hint is off</Text>
          )}
          {summary.risky > 0 ? (
            <Text style={styles.warning}>
              {summary.risky} need force delete (running or open in Paseo)
            </Text>
          ) : null}

          {detected.length > 0 ? <View style={styles.divider} /> : null}
          {detected.map((provider) => {
            const storeSize = formatBytes(provider.storeBytes);
            return (
              <View key={provider.id} style={styles.providerRow}>
                <Text style={styles.providerName}>{provider.label}</Text>
                <Text style={styles.providerDetail}>
                  {provider.count}
                  {provider.due > 0 ? ` · ${provider.due} due` : ""}
                  {storeSize ? ` · ${storeSize}` : " · size unknown"}
                </Text>
              </View>
            );
          })}
          {detected
            .filter((provider) => provider.error)
            .map((provider) => (
              <Text key={`${provider.id}-error`} style={styles.muted}>
                {provider.label}: {provider.error}
              </Text>
            ))}
        </>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={() => void load(true)}
          disabled={refreshing}
          accessibilityRole="button"
        >
          <Text style={styles.action}>{refreshing ? "Rescanning..." : "Rescan"}</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>
        Open the Agent sessions panel in a workspace to delete or export a session.
      </Text>
    </View>
  );
}

export function SessionManagerSidebarItem({ theme, layout, openPopover }: PluginSidebarItemProps) {
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const [summary, setSummary] = useState<SessionSummary | null>(null);

  const openSummary = useCallback(() => {
    openPopover((props) => <SessionSummaryPopover {...props} onSummary={setSummary} />);
  }, [openPopover]);

  return (
    <SidebarRow
      icon="Database"
      onPress={openSummary}
      trailing={
        summary && summary.total > 0 ? (
          <Text
            style={{
              color: summary.due > 0 ? theme.colors.statusWarning : theme.colors.foregroundMuted,
              fontSize: font(layout.compact ? 11 : 12),
            }}
          >
            {summary.total}
            {summary.due > 0 ? ` · ${summary.due} due` : ""}
          </Text>
        ) : undefined
      }
    />
  );
}
