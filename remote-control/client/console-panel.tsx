import { useCallback, useEffect, useState } from "react";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { openConsoleUrl } from "./open-console";
import { consoleUrl, state } from "../shared/rpc";

export function RemoteControlPanel(props: PluginWorkspacePanelProps) {
  const { theme, layout, workspaceId } = props;
  const projectRootPath = useWorkspace(workspaceId, (workspace) => workspace.projectRootPath);
  const stateRpc = useRpc(state);
  const consoleUrlRpc = useRpc(consoleUrl);

  const [listening, setListening] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await stateRpc({});
      setListening(result.listening);
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
    try {
      const result = await consoleUrlRpc({});
      if (!result.url) return;
      await openExternalUrl(result.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [consoleUrlRpc]);

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;

  return (
    <View style={styles.container}>
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>Remote Control</Text>
      <Text style={{ color: muted, fontSize: 12 }}>Console: {listening ? "listening" : "stopped"}</Text>
      <Text style={{ color: muted, fontSize: 12 }}>Project: {projectRootPath ?? "(none)"}</Text>
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      <Pressable onPress={open} style={[styles.button, { borderColor: accent }]}>
        <Text style={{ color: accent, fontSize: 12 }}>Open console</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 6 },
  button: { borderWidth: 1, borderRadius: 6, padding: 8, alignSelf: "flex-start" },
});
