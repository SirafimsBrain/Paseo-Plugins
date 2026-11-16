import { useEffect, useState } from "react";
import type { PluginNewWorkspaceItemProps } from "@getpaseo/plugin/client";
import { useNewWorkspace, useRpc } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ConnectionRow } from "./connection-tree";
import { connectionsList } from "../shared/rpc";

/**
 * "Remote Control" item in the New workspace setup (stage 1.1.0, Paseo 0.16.0
 * `addNewWorkspaceItem`).
 *
 * Picking a connection stamps the workspace that is about to be created with
 * `remote-control: { connectionId, connectionName, protocol, host }`, through
 * `newWorkspace.setMetadata`. The stamp is what makes the workspace say where
 * it belongs — the sidebar badge, the panel and any other plugin read the same
 * key, and the launch path writes it too when a session is opened later.
 *
 * Nothing is created here: the item only records the choice, and the host's own
 * Create button makes the workspace.
 */
export function RemoteControlNewWorkspaceItem({ theme }: PluginNewWorkspaceItemProps) {
  const newWorkspace = useNewWorkspace();
  const connectionsRpc = useRpc(connectionsList);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    connectionsRpc({})
      .then((list) => {
        if (cancelled) return;
        setConnections(list.connections);
      })
      .catch(() => {
        // No library yet; the item stays hidden rather than empty.
      });
    return () => {
      cancelled = true;
    };
  }, [connectionsRpc]);

  if (connections.length === 0) return null;

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;

  const choose = async (connection: ConnectionRow) => {
    setBusy(true);
    setError(null);
    try {
      await newWorkspace.setMetadata({
        "remote-control": {
          connectionId: connection.id,
          connectionName: connection.name,
          protocol: connection.protocol,
          host: connection.host,
        },
      });
      setSelectedId(connection.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: "600" }}>Remote host</Text>
      <Text style={{ color: muted, fontSize: 11 }}>
        Remember which machine this workspace belongs to. Remote sessions opened from it are
        counted in the sidebar.
      </Text>
      <View style={styles.rows}>
        {connections.map((connection) => {
          const selected = selectedId === connection.id;
          return (
            <Pressable
              key={connection.id}
              onPress={() => void choose(connection)}
              disabled={busy}
              style={[
                styles.chip,
                { borderColor: selected ? accent : theme.colors.border },
                selected ? { backgroundColor: accent } : null,
              ]}
            >
              <Text style={{ color: selected ? "#ffffff" : fg, fontSize: 11 }} numberOfLines={1}>
                {connection.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  rows: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
});
