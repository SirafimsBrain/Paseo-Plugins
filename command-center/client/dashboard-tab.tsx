import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import type { CommandDefinition, HistoryEntry } from "../shared/commands";
import { listCommands, listHistory } from "../shared/commands";
import { dashboardSummary } from "../shared/dashboard";
import { interfaceFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

interface Props {
  theme: PluginTheme;
  /** Bumped by the surface after any run/edit so the dashboard reloads. */
  reloadKey: number;
}

function typeLabel(command: CommandDefinition): string {
  if (command.type === "workflow") return `workflow · ${command.steps.length} steps`;
  if (command.type === "shell") return "shell";
  return command.provider ?? "prompt";
}

/**
 * Read-only dashboard tab (0.12.x).
 *
 * Lives in the Command Center screen — a Paseo tab — instead of a web page in
 * the external browser: the same data the library/history tabs use, rendered
 * with the host theme and typography, with no actions and no HTTP surface.
 */
export function DashboardTab({ theme, reloadKey }: Props) {
  const listRpc = useRpc(listCommands);
  const historyRpc = useRpc(listHistory);
  const [commands, setCommands] = useState<CommandDefinition[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([listRpc({}), historyRpc({})])
      .then(([commandResult, historyResult]) => {
        if (cancelled) return;
        setCommands(commandResult.commands);
        setHistory(historyResult.entries);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [listRpc, historyRpc, reloadKey, refreshKey]);

  const summary = useMemo(
    () => dashboardSummary(commands ?? [], history ?? []),
    [commands, history],
  );

  const { foreground, foregroundMuted } = theme.colors;
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const fontFamilyStyle = uiFont ? { fontFamily: uiFont } : null;

  if (commands === null || history === null) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={[styles.muted, { color: foregroundMuted, fontSize: font(13) }]}>
          {error ? `Failed to load the dashboard: ${error}` : "Loading…"}
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={[styles.summary, { borderColor: theme.colors.border }]}>
        <Text style={[styles.summaryLine, { color: foreground }, fontFamilyStyle, { fontSize: font(14) }]}>
          {summary.commandCount} {summary.commandCount === 1 ? "command" : "commands"} ·{" "}
          {summary.totalRuns} {summary.totalRuns === 1 ? "run" : "runs"} ·{" "}
          {summary.failedRuns} failed in recent history
        </Text>
        <Text style={[styles.summaryHint, { color: foregroundMuted, fontSize: font(11) }]}>
          Read-only. Counts come from the per-command run counters; failures cover the stored
          history window.
        </Text>
        <Pressable
          style={[styles.smallButton, { borderColor: theme.colors.border }]}
          onPress={() => setRefreshKey((key) => key + 1)}
        >
          <Text style={[styles.smallButtonText, { color: foreground, fontSize: font(12) }]}>Refresh</Text>
        </Pressable>
      </View>

      <Text style={[styles.section, { color: foregroundMuted, fontSize: font(11) }]}>Most used</Text>
      {summary.mostUsed.length === 0 ? (
        <Text style={[styles.muted, { color: foregroundMuted, fontSize: font(12) }]}>
          Nothing has run yet.
        </Text>
      ) : (
        <Text style={[styles.body, { color: foreground, fontSize: font(12) }]}>
          {summary.mostUsed.map((command) => `${command.name} (${command.useCount})`).join(" · ")}
        </Text>
      )}

      <Text style={[styles.section, { color: foregroundMuted, fontSize: font(11) }]}>Commands</Text>
      {commands.length === 0 ? (
        <Text style={[styles.muted, { color: foregroundMuted, fontSize: font(12) }]}>
          No commands saved yet.
        </Text>
      ) : (
        commands.map((command) => (
          <View key={command.id} style={[styles.row, { borderColor: theme.colors.border }]}>
            <Text
              style={[styles.name, { color: foreground }, fontFamilyStyle, { fontSize: font(13) }]}
              numberOfLines={1}
            >
              {command.favorite ? "★ " : ""}
              {command.name}
            </Text>
            <Text style={[styles.badge, { color: foregroundMuted, fontSize: font(11) }]} numberOfLines={1}>
              {typeLabel(command)}
              {command.category ? ` · ${command.category}` : ""}
            </Text>
            <Text style={[styles.count, { color: foregroundMuted, fontSize: font(11) }]}>
              {command.useCount} runs
            </Text>
          </View>
        ))
      )}

      <Text style={[styles.section, { color: foregroundMuted, fontSize: font(11) }]}>Recent runs</Text>
      {summary.recent.length === 0 ? (
        <Text style={[styles.muted, { color: foregroundMuted, fontSize: font(12) }]}>
          Nothing has run yet.
        </Text>
      ) : (
        summary.recent.map((entry) => (
          <View key={entry.id} style={[styles.row, { borderColor: theme.colors.border }]}>
            <View style={styles.rowHeader}>
              <Text
                style={[styles.name, { color: foreground }, fontFamilyStyle, { fontSize: font(13) }]}
                numberOfLines={1}
              >
                {entry.commandName}
              </Text>
              <Text
                style={[
                  styles.badge,
                  { color: entry.ok ? foregroundMuted : theme.colors.statusDanger, fontSize: font(11) },
                ]}
              >
                {entry.ok ? entry.kind : "failed"}
              </Text>
            </View>
            <Text style={[styles.body, { color: foregroundMuted, fontSize: font(11) }]} numberOfLines={2}>
              {entry.error ?? entry.rendered}
            </Text>
            <Text style={[styles.timestamp, { color: foregroundMuted, fontSize: font(10) }]}>
              {new Date(entry.at).toLocaleString()}
              {entry.provider ? ` · ${entry.provider}` : ""}
            </Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8, paddingBottom: 24 },
  summary: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  summaryLine: { fontSize: 14, fontWeight: "600" },
  summaryHint: { fontSize: 11, opacity: 0.7 },
  smallButton: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 4,
  },
  smallButtonText: { fontSize: 12, fontWeight: "600" },
  section: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    opacity: 0.7,
    marginTop: 8,
  },
  row: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 2 },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  badge: { fontSize: 11, opacity: 0.8, marginLeft: "auto" },
  count: { fontSize: 11, opacity: 0.6 },
  body: { fontSize: 12 },
  timestamp: { fontSize: 10, opacity: 0.5 },
  muted: { fontSize: 12, opacity: 0.6 },
});
