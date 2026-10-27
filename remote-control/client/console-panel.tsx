import { useCallback, useEffect, useState } from "react";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { openConsoleUrl } from "./open-console";
import {
  consoleUrl,
  connectionLaunch,
  connectionsList,
  state,
} from "../shared/rpc";

interface ConnectionRow {
  id: string;
  name: string;
  protocol: "ssh" | "rdp" | "vnc";
  host: string;
  port: number | null;
  username: string;
  hasPassword: boolean;
}

export function RemoteControlPanel(props: PluginWorkspacePanelProps) {
  const { theme, workspaceId } = props;
  const projectRootPath = useWorkspace(workspaceId, (workspace) => workspace.projectRootPath);
  const stateRpc = useRpc(state);
  const consoleUrlRpc = useRpc(consoleUrl);
  const connectionsRpc = useRpc(connectionsList);
  const launchRpc = useRpc(connectionLaunch);
  const paseo = usePaseo();

  const [listening, setListening] = useState(false);
  const [vault, setVault] = useState<{ initialized: boolean; unlocked: boolean; entries: number } | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await stateRpc({});
      setListening(result.listening);
      setVault(result.vault);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    try {
      const list = await connectionsRpc({});
      setConnections(list.connections);
    } catch {
      // The daemon may be reconnecting; the next tick retries.
    }
  }, [stateRpc, connectionsRpc]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const open = useCallback(async () => {
    setMessage(null);
    setError(null);
    try {
      const result = await consoleUrlRpc({});
      if (!result.url) return;
      await openConsoleUrl(result.url, {
        openBrowser: (input) => props.navigation?.openBrowser?.(input),
        openExternal: (u) => openExternalUrl(u),
        listWorkspaceIds: async () => [workspaceId],
      }, workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [consoleUrlRpc, props.navigation, workspaceId]);

  // ssh → a Paseo terminal tab running the session; rdp/vnc → their own
  // desktop window on this machine.
  const launch = useCallback(async (connection: ConnectionRow) => {
    setError(null);
    setMessage(null);
    setBusyId(connection.id);
    try {
      const result = await launchRpc({ connectionId: connection.id, workspaceId });
      setMessage(
        result.kind === "terminal"
          ? `${connection.name}: SSH session opened as a terminal tab.`
          : `${connection.name}: ${connection.protocol.toUpperCase()} window opened (${result.binary}, pid ${result.pid}).`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }, [launchRpc, workspaceId]);

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>Remote Control</Text>
      <Text style={{ color: muted, fontSize: 12 }}>
        Console: {listening ? "listening" : "stopped"}
        {vault ? ` · vault ${vault.initialized ? (vault.unlocked ? "unlocked" : "locked") : "setup"}` : ""}
      </Text>
      <Text style={{ color: muted, fontSize: 12 }}>Project: {projectRootPath ?? "(none)"}</Text>
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      {message ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>{message}</Text> : null}
      <Pressable onPress={open} style={[styles.button, { borderColor: accent }]}>
        <Text style={{ color: accent, fontSize: 12 }}>Open console</Text>
      </Pressable>

      <Text style={{ color: fg, fontSize: 12, fontWeight: "600", marginTop: 8 }}>Connections</Text>
      {connections.length === 0 ? (
        <Text style={{ color: muted, fontSize: 11 }}>
          No connections yet — create one in the console.
        </Text>
      ) : (
        connections.map((connection) => (
          <View key={connection.id} style={styles.row}>
            <View style={styles.rowInfo}>
              <Text style={{ color: fg, fontSize: 12 }} numberOfLines={1}>
                {connection.name}
                {connection.hasPassword ? " 🔒" : ""}
              </Text>
              <Text style={{ color: muted, fontSize: 11 }} numberOfLines={1}>
                {connection.protocol.toUpperCase()} ·{" "}
                {connection.username ? `${connection.username}@` : ""}
                {connection.host}
                {connection.port ? `:${connection.port}` : ""}
              </Text>
            </View>
            <Pressable
              onPress={() => void launch(connection)}
              disabled={busyId === connection.id}
              style={[
                styles.button,
                styles.launchButton,
                { borderColor: accent, opacity: busyId === connection.id ? 0.5 : 1 },
              ]}
            >
              <Text style={{ color: accent, fontSize: 11 }}>
                {connection.protocol === "ssh" ? "Open in tab" : "Open window"}
              </Text>
            </Pressable>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 6 },
  button: { borderWidth: 1, borderRadius: 6, padding: 8, alignSelf: "flex-start" },
  launchButton: { paddingVertical: 5, paddingHorizontal: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  rowInfo: { flex: 1, gap: 1 },
});
