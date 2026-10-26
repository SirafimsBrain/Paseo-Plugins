import { useCallback, useEffect, useState } from "react";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import {
  openExternalUrl,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { consoleUrl, state, vaultLock, vaultSetup, vaultUnlock } from "../shared/rpc";
import { openConsoleUrl } from "./open-console";

const SCREEN_ID = "remote-control";

export { SCREEN_ID };

export function RemoteControlScreen(props: PluginScreenProps) {
  const { theme } = props;
  const stateRpc = useRpc(state);
  const consoleUrlRpc = useRpc(consoleUrl);
  const vaultSetupRpc = useRpc(vaultSetup);
  const vaultUnlockRpc = useRpc(vaultUnlock);
  const vaultLockRpc = useRpc(vaultLock);
  const paseo = usePaseo();

  const [listening, setListening] = useState(false);
  const [transport, setTransport] = useState<"ws" | "sse-post" | null>(null);
  const [transportConnections, setTransportConnections] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [vault, setVault] = useState<{ initialized: boolean; unlocked: boolean; entries: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await stateRpc({});
      setListening(result.listening);
      setTransport(result.transport);
      setTransportConnections(result.transportConnections);
      setUrl(result.consoleUrl);
      setVault(result.vault);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [stateRpc]);

  const doUnlock = useCallback(async () => {
    const password = (globalThis as unknown as { prompt?: (m: string) => string | null }).prompt?.("Master password");
    if (!password) return;
    try {
      if (!vault?.initialized) {
        await vaultSetupRpc({ password });
      }
      const result = await vaultUnlockRpc({ password });
      if (!result.ok) setError("unlock failed");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [vault, refresh, vaultSetupRpc, vaultUnlockRpc]);

  const doLock = useCallback(async () => {
    try {
      await vaultLockRpc({});
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refresh, vaultLockRpc]);

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
      <Text style={{ color: muted, fontSize: 13 }}>
        Vault: {vault ? (vault.initialized ? (vault.unlocked ? "unlocked" : "locked") : "not initialized") : "…"}
        {vault?.initialized ? ` (${vault.entries} secrets)` : ""}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable onPress={doUnlock} style={[styles.button, { borderColor: accent }]}>
          <Text style={{ color: accent, fontSize: 13 }}>{vault?.initialized ? "Unlock" : "Setup"}</Text>
        </Pressable>
        <Pressable onPress={doLock} style={[styles.button, { borderColor: accent }]}>
          <Text style={{ color: accent, fontSize: 13 }}>Lock</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  button: { borderWidth: 1, borderRadius: 6, padding: 10, alignSelf: "flex-start", marginTop: 8 },
});
