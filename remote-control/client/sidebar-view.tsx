import { useCallback, useEffect, useState } from "react";
import type { PluginSidebarViewProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SCREEN_ID } from "./console-screen";
import { connectionTarget, orderedGroups, type ConnectionRow, type GroupRow } from "./connection-tree";
import { terminalRef, workspaceRef } from "./entity-ref";
import { SessionList } from "./session-list";
import { useRemoteActivity } from "./use-activity";
import { consoleUrl, connectionLaunch, connectionsList } from "../shared/rpc";

/**
 * The Remote Control sidebar view (stage 1.1.0, Paseo 0.16.0 `addSidebarView`).
 *
 * 0.16.0 lets a plugin replace the sidebar with its own workspace and agent
 * layout, chosen per device in Settings → Sidebar. This is that layout for
 * remote work: the connection tree, this workspace's live sessions, and the
 * console — instead of one header row next to the host's own tree.
 *
 * Launching still needs a workspace: a terminal tab (ssh) or an external window
 * (rdp/vnc) belongs to the workspace that is active in the sidebar. With none
 * active the view says so instead of guessing.
 *
 * No polling: terminals, windows and the vault arrive through
 * `remote-control.activity`, and the connection list is read when the view
 * mounts — the console is where connections are created, and it is one press
 * away.
 */
export function RemoteControlSidebarView({
  theme,
  active,
  navigation,
  dismiss,
}: PluginSidebarViewProps) {
  const connectionsRpc = useRpc(connectionsList);
  const launchRpc = useRpc(connectionLaunch);
  const consoleRpc = useRpc(consoleUrl);
  const activity = useRemoteActivity();

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = active.workspace?.id ?? null;
  // Stage 1.1.2 (recommendation 1): a live session is a destination, not a
  // line of text. The terminal of an ssh session is a Paseo tab, and an
  // RDP/VNC window belongs to the workspace it was launched from; the refs
  // come from `./entity-ref`. Without an active workspace there is no host id,
  // and the rows stay unpressable.
  const hostId = active.workspace?.hostId ?? null;
  const focusTerminal = hostId
    ? (terminalId: string) => navigation.openTerminal(terminalRef(hostId, terminalId))
    : undefined;
  const focusWorkspace = hostId
    ? (id: string) => navigation.openWorkspace(workspaceRef(hostId, id))
    : undefined;

  const refresh = useCallback(async () => {
    try {
      const list = await connectionsRpc({});
      setGroups(list.groups);
      setConnections(list.connections);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [connectionsRpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const launch = useCallback(
    async (connection: ConnectionRow) => {
      if (!workspaceId) {
        setError("Open a workspace first — a remote session lives in one.");
        return;
      }
      setError(null);
      setBusyId(connection.id);
      try {
        await launchRpc({ connectionId: connection.id, workspaceId });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyId(null);
      }
    },
    [launchRpc, workspaceId],
  );

  const openConsole = useCallback(async () => {
    try {
      const result = await consoleRpc({});
      if (result.url) await openExternalUrl(result.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [consoleRpc]);

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;

  const sshTerminals = (activity?.terminals ?? []).filter(
    (terminal) => terminal.kind === "ssh" && terminal.workspaceId === workspaceId,
  );
  const windows = (activity?.sessions ?? []).filter(
    (session) => session.state === "running" && session.workspaceId === workspaceId,
  );

  const renderConnection = (connection: ConnectionRow) => (
    <Pressable
      key={connection.id}
      onPress={() => void launch(connection)}
      disabled={busyId === connection.id}
      style={[styles.row, { borderColor: theme.colors.border, opacity: busyId === connection.id ? 0.5 : 1 }]}
    >
      <Text style={{ color: fg, fontSize: 12 }} numberOfLines={1}>
        {connection.name}
        {connection.hasPassword ? " 🔒" : ""}
      </Text>
      <Text style={{ color: muted, fontSize: 10 }} numberOfLines={1}>
        {connectionTarget(connection)}
      </Text>
    </Pressable>
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>Remote Control</Text>
        <Pressable onPress={dismiss}>
          <Text style={{ color: muted, fontSize: 11 }}>Show Paseo sidebar</Text>
        </Pressable>
      </View>

      {!workspaceId ? (
        <Text style={{ color: muted, fontSize: 11 }}>
          No active workspace. Open one to launch a session from here.
        </Text>
      ) : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{error}</Text> : null}

      <Text style={[styles.section, { color: muted }]}>
        Sessions in this workspace ({sshTerminals.length + windows.length})
      </Text>
      <SessionList
        theme={theme}
        terminals={sshTerminals}
        windows={windows}
        emptyLabel="Nothing running here."
        {...(focusTerminal ? { onOpenTerminal: (terminal) => focusTerminal(terminal.id) } : {})}
        {...(focusWorkspace ? { onOpenWorkspace: focusWorkspace } : {})}
      />

      <Text style={[styles.section, { color: muted }]}>Connections</Text>
      {connections.length === 0 ? (
        <Text style={{ color: muted, fontSize: 11 }}>No connections yet — create one in the console.</Text>
      ) : (
        <>
          {connections.filter((connection) => connection.groupId === null).map(renderConnection)}
          {orderedGroups(groups).map(({ group, depth }) => (
            <View key={group.id} style={{ marginLeft: depth * 10, marginTop: 4 }}>
              <Text style={{ color: muted, fontSize: 11, fontWeight: "600" }} numberOfLines={1}>
                {group.name}
              </Text>
              {connections
                .filter((connection) => connection.groupId === group.id)
                .map(renderConnection)}
            </View>
          ))}
        </>
      )}

      <Pressable onPress={() => void openConsole()} style={[styles.button, { borderColor: accent }]}>
        <Text style={{ color: accent, fontSize: 12 }}>Open console</Text>
      </Pressable>
      <Pressable
        onPress={() => void refresh()}
        style={[styles.button, { borderColor: theme.colors.border }]}
      >
        <Text style={{ color: muted, fontSize: 11 }}>Reload connections</Text>
      </Pressable>
    </ScrollView>
  );
}

/** Screen id the view can fall back to (kept for the console row). */
export const SIDEBAR_VIEW_SCREEN = SCREEN_ID;

const styles = StyleSheet.create({
  container: { padding: 12, gap: 6 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  section: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 8, opacity: 0.7 },
  row: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, gap: 1 },
  button: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, alignSelf: "flex-start" },
});
