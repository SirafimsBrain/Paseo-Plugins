import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ExternalSessionView, TerminalView } from "../shared/activity";

/**
 * The live sessions of one workspace, as rows that go somewhere (stage 1.1.2,
 * Paseo 0.17.1 recommendation 1).
 *
 * Before this the sidebar view printed its sessions as plain text: an ssh
 * terminal there was a dead line, even though the same terminal is a Paseo
 * tab one press away. A row is therefore a button. Which destination exists
 * depends on the surface: the sidebar view can focus a terminal *and* move to
 * another workspace, while a panel's navigation only carries `openWorkspace`
 * (0.17.1 `PluginNavigableHostProps`), so the panel passes a workspace handler
 * alone and rows without a destination stay unpressable instead of pretending.
 */
export interface SessionListProps {
  theme: PluginWorkspacePanelProps["theme"];
  terminals: TerminalView[];
  windows: ExternalSessionView[];
  /** Shown instead of rows when both lists are empty. */
  emptyLabel: string;
  onOpenTerminal?: (terminal: TerminalView) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
}

export function SessionList({
  theme,
  terminals,
  windows,
  emptyLabel,
  onOpenTerminal,
  onOpenWorkspace,
}: SessionListProps) {
  if (terminals.length + windows.length === 0) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{emptyLabel}</Text>;
  }

  const rows: { key: string; label: string; detail: string | null; onPress?: () => void }[] = [
    ...terminals.map((terminal) => ({
      key: `terminal-${terminal.id}`,
      label: `SSH · ${terminal.name}`,
      detail: null,
      ...(onOpenTerminal ? { onPress: () => onOpenTerminal(terminal) } : {}),
    })),
    ...windows.map((session) => ({
      key: `window-${session.id}`,
      label: `${session.kind.toUpperCase()} · ${session.name}`,
      detail: session.target,
      ...(onOpenWorkspace && session.workspaceId
        ? { onPress: () => onOpenWorkspace(session.workspaceId as string) }
        : {}),
    })),
  ];

  return (
    <View style={styles.list}>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          onPress={row.onPress}
          disabled={!row.onPress}
          style={[styles.row, { borderColor: theme.colors.border }]}
          accessibilityHint={row.onPress ? "Opens the session" : undefined}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 11 }} numberOfLines={1}>
            {row.label}
          </Text>
          {row.detail ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
              {row.detail}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 4 },
  row: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, gap: 1 },
});
