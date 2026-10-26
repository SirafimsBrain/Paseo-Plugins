import { useCallback, useEffect, useState } from "react";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import {
  openExternalUrl,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { consoleUrl, state, vaultLock, vaultSetup, vaultUnlock } from "../shared/rpc";
import { openConsoleUrl } from "./open-console";

export function RemoteControlSettingsPanel(props: PluginWorkspacePanelProps) {
  const { theme, workspaceId } = props;
  const projectRootPath = useWorkspace(workspaceId, (w) => w.projectRootPath);
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
  const [vault, setVault] = useState<{ initialized: boolean; unlocked: boolean; entries: number } | null>(null);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      if (!result.url) { setMessage("Console is not listening yet."); return; }
      const outcome = await openConsoleUrl(result.url, {
        openBrowser: props.navigation?.openBrowser,
        openExternal: (u) => openExternalUrl(u),
        listWorkspaceIds: async () => [workspaceId],
      }, workspaceId);
      setMessage(outcome.via === "browser" ? "Opened in a Paseo browser tab." : "Opened in your external browser.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [consoleUrlRpc, props.navigation, workspaceId]);

  const doUnlock = useCallback(async () => {
    if (password.length === 0) { setError("enter a master password first"); return; }
    setError(null);
    setMessage(null);
    try {
      if (!vault?.initialized) await vaultSetupRpc({ password });
      const result = await vaultUnlockRpc({ password });
      if (!result.ok) setError("unlock failed");
      else setMessage(vault?.initialized ? "unlocked" : "vault set up and unlocked");
      setPassword("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [password, vault, refresh, vaultSetupRpc, vaultUnlockRpc]);

  const doLock = useCallback(async () => {
    setError(null);
    setMessage(null);
    try {
      await vaultLockRpc({});
      setMessage("locked");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refresh, vaultLockRpc]);

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={{ color: fg, fontSize: 16, fontWeight: "600" }}>Remote Control — Settings</Text>
      <Text style={{ color: muted, fontSize: 12 }}>Project: {projectRootPath ?? "(none)"}</Text>
      <Text style={{ color: muted, fontSize: 13 }}>
        Console: {listening ? "listening" : "stopped"}
        {listening && transport ? ` (transport ${transport}, ${transportConnections} live)` : ""}
      </Text>
      {url ? <Text style={{ color: muted, fontSize: 12 }}>{url}</Text> : null}
      <Pressable onPress={open} style={[styles.button, { borderColor: accent }]}>
        <Text style={{ color: accent, fontSize: 13 }}>Open console</Text>
      </Pressable>

      <Text style={{ color: fg, fontSize: 14, fontWeight: "600", marginTop: 12 }}>Vault</Text>
      <Text style={{ color: muted, fontSize: 13 }}>
        {vault ? (vault.initialized ? (vault.unlocked ? "unlocked" : "locked") : "not initialized") : "…"}
        {vault?.initialized ? ` (${vault.entries} secrets)` : ""}
      </Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="master password"
        secureTextEntry
        style={[styles.input, { color: fg, borderColor: muted }]}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable onPress={doUnlock} style={[styles.button, { borderColor: accent }]}>
          <Text style={{ color: accent, fontSize: 13 }}>{vault?.initialized ? "Unlock" : "Setup"}</Text>
        </Pressable>
        <Pressable onPress={doLock} style={[styles.button, { borderColor: accent }]}>
          <Text style={{ color: accent, fontSize: 13 }}>Lock</Text>
        </Pressable>
      </View>
      {message ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>{message}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  button: { borderWidth: 1, borderRadius: 6, padding: 10, alignSelf: "flex-start" },
  input: { borderWidth: 1, borderRadius: 6, padding: 8, width: 240 },
});
