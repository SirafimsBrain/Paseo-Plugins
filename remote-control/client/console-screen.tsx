import { useCallback, useEffect, useState } from "react";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import {
  openExternalUrl,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { consoleUrl, state } from "../shared/rpc";
import { openConsoleUrl } from "./open-console";

const SCREEN_ID = "remote-control";

export { SCREEN_ID };

export function RemoteControlScreen(props: PluginScreenProps) {
  const { theme } = props;
  const stateRpc = useRpc(state);
  const consoleUrlRpc = useRpc(consoleUrl);
  const paseo = usePaseo();

  const [listening, setListening] = useState(false);
  const [transport, setTransport] = useState<"ws" | "sse-post" | null>(null);
  const [transportConnections, setTransportConnections] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await stateRpc({});
      setListening(result.listening);
      setTransport(result.transport);
      setTransportConnections(result.transportConnections);
      setUrl(result.consoleUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [stateRpc]);

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
      if (!result.url) {
        setMessage("Console is not listening yet.");
        return;
      }
      const outcome = await openConsoleUrl(result.url, {
        openBrowser: props.navigation?.openBrowser,
        openExternal: (u) => openExternalUrl(u),
        listWorkspaceIds: async () => {
          try {
            const { entries } = await paseo.workspaces.list();
            return entries.map((entry: { id: string }) => entry.id);
          } catch {
            return [];
          }
        },
      });
      setMessage(
        outcome.via === "browser"
          ? "Opened in a Paseo browser tab."
          : "Opened in your external browser.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [consoleUrlRpc, props.navigation, paseo]);

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={{ color: fg, fontSize: 16, fontWeight: "600" }}>Remote Control</Text>
      <Text style={{ color: muted, fontSize: 13 }}>
        Console: {listening ? "listening" : "stopped"}
        {listening && transport ? ` (transport ${transport}, ${transportConnections} live)` : ""}
      </Text>
      {url ? <Text style={{ color: muted, fontSize: 12 }}>{url}</Text> : null}
      {message ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>{message}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      <Pressable onPress={open} style={[styles.button, { borderColor: accent }]}>
        <Text style={{ color: accent, fontSize: 13 }}>Open console</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  button: { borderWidth: 1, borderRadius: 6, padding: 10, alignSelf: "flex-start", marginTop: 8 },
});
