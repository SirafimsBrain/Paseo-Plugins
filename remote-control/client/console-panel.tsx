import { useCallback, useEffect, useState } from "react";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useTabState, useWorkspace } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { z } from "zod";
import { openConsoleUrl } from "./open-console";
import { SessionList } from "./session-list";
import {
  connectionTarget,
  orderedGroups,
  type ConnectionRow,
  type GroupRow,
} from "./connection-tree";
import { useRemoteActivity } from "./use-activity";
import type { ExternalSessionView, TerminalView } from "../shared/activity";
import {
  consoleUrl,
  connectionLaunch,
  connectionsList,
  exportBundle,
  exportStatus,
  vaultSetup,
  vaultUnlock,
} from "../shared/rpc";

/**
 * Which location is rendering the panel. The agent location (stage 1.1.2)
 * shows the same remote surface, because sessions belong to the workspace.
 */
export type RemoteControlPanelScope = "workspace" | "agent";

export interface RemoteControlPanelProps
  extends Pick<PluginWorkspacePanelProps, "theme" | "workspaceId" | "navigation" | "tab"> {
  scope?: RemoteControlPanelScope;
}

/**
 * The panel's view survives a remount, a plugin reload and a workspace reopen
 * (stage 1.1.2, Paseo 0.17.1 recommendation 3): `useTabState` keeps it in the
 * panel tab, with the schema falling back to Connections for a missing or
 * foreign value.
 */
const panelViewSchema = z.object({
  view: z.enum(["connections", "sessions"]),
});

type PanelView = z.infer<typeof panelViewSchema>;

const DEFAULT_PANEL_VIEW: PanelView = { view: "connections" };

export function RemoteControlPanel({
  theme,
  workspaceId,
  navigation,
  tab,
  scope = "workspace",
}: RemoteControlPanelProps) {
  const projectRootPath = useWorkspace(workspaceId, (workspace) => workspace.projectRootPath);
  const activity = useRemoteActivity();
  const consoleUrlRpc = useRpc(consoleUrl);
  const exportRpc = useRpc(exportBundle);
  const exportStatusRpc = useRpc(exportStatus);
  const connectionsRpc = useRpc(connectionsList);
  const launchRpc = useRpc(connectionLaunch);
  const vaultSetupRpc = useRpc(vaultSetup);
  const vaultUnlockRpc = useRpc(vaultUnlock);
  const paseo = usePaseo();

  // Stage 1.1.0: `listening` and the vault state come from the activity
  // subscription instead of a 3-second `state` poll; only the connection list
  // (edited in the console) is still read here.
  const [bundle, setBundle] = useState<{ path: string; bytes: number } | null>(null);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [masterPassword, setMasterPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [panelView, setPanelView] = useTabState<PanelView>(
    tab,
    panelViewSchema,
    DEFAULT_PANEL_VIEW,
  );

  const refresh = useCallback(async () => {
    try {
      const list = await connectionsRpc({});
      setGroups(list.groups);
      setConnections(list.connections);
    } catch {
      // The daemon may be reconnecting; the next tick retries.
    }
  }, [connectionsRpc]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const listening = activity?.listening ?? false;
  const vault = activity?.vault ?? null;
  const sshTerminals: TerminalView[] = (activity?.terminals ?? []).filter(
    (terminal) => terminal.kind === "ssh" && terminal.workspaceId === workspaceId,
  );
  const windows: ExternalSessionView[] = (activity?.sessions ?? []).filter(
    (session) => session.state === "running" && session.workspaceId === workspaceId,
  );
  const sessions = sshTerminals.length + windows.length;

  // Binary export (stage 1.1.0): the daemon writes the bundle and hands back
  // its bytes as `Uint8Array`, so the panel only shows where it landed.
  const exportToFile = useCallback(async () => {
    setError(null);
    setMessage(null);
    try {
      // The bytes are the RPC's whole value (a byte payload cannot ride inside
      // an object); the file they were written to is reported separately.
      const bytes = await exportRpc({});
      const status = await exportStatusRpc({});
      setBundle({
        path: status?.path ?? "(unknown)",
        bytes: status?.bytes ?? bytes.byteLength,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [exportRpc, exportStatusRpc]);

  const open = useCallback(async () => {
    setMessage(null);
    setError(null);
    try {
      const result = await consoleUrlRpc({});
      if (!result.url) return;
      await openConsoleUrl(result.url, {
        openBrowser: (input) => navigation?.openBrowser?.(input),
        openExternal: (u) => openExternalUrl(u),
        listWorkspaceIds: async () => [workspaceId],
      }, workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [consoleUrlRpc, navigation, workspaceId]);

  // First run creates the master password; later visits only unlock. Once the
  // storage is open nothing asks for anything again (auto-lock is off).
  const submitVault = useCallback(async () => {
    if (masterPassword.length === 0) {
      setError(vault?.initialized ? "enter the master password" : "choose a master password");
      return;
    }
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      if (vault && !vault.initialized) {
        await vaultSetupRpc({ password: masterPassword });
      }
      const result = await vaultUnlockRpc({ password: masterPassword });
      if (!result.ok) {
        setError("wrong master password");
      } else {
        setMessage(vault?.initialized ? "storage unlocked" : "secret storage created");
        setMasterPassword("");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [masterPassword, vault, vaultSetupRpc, vaultUnlockRpc, refresh]);

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
      const text = cause instanceof Error ? cause.message : String(cause);
      setError(text);
      if (/vault is locked|not initialized/i.test(text)) {
        // The storage got locked meanwhile — show the unlock form right away.
        void refresh();
      }
    } finally {
      setBusyId(null);
    }
  }, [launchRpc, workspaceId, refresh]);

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;

  const storageLabel = !vault
    ? "…"
    : !vault.initialized
      ? "not set up — first run"
      : vault.unlocked
        ? `unlocked · ${vault.entries} saved`
        : "locked";

  const renderConnectionRow = (connection: ConnectionRow) => (
    <View key={connection.id} style={styles.row}>
      <View style={styles.rowInfo}>
        <Text style={{ color: fg, fontSize: 12 }} numberOfLines={1}>
          {connection.name}
          {connection.hasPassword ? " 🔒" : ""}
        </Text>
        <Text style={{ color: muted, fontSize: 11 }} numberOfLines={1}>
          {connectionTarget(connection)}
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
  );

  const needsSetup = vault !== null && !vault.initialized;
  const needsUnlock = vault !== null && vault.initialized && !vault.unlocked;
  const open_ = vault !== null && vault.unlocked;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>Remote Control</Text>
      <Text style={{ color: muted, fontSize: 12 }}>
        Console: {listening ? "listening" : "stopped"} · storage: {storageLabel} · remote
        sessions here: {sessions}
      </Text>
      <Text style={{ color: muted, fontSize: 12 }}>Project: {projectRootPath ?? "(none)"}</Text>
      {scope === "agent" ? (
        <Text style={{ color: muted, fontSize: 11 }}>
          Remote sessions here belong to this workspace, not to this agent.
        </Text>
      ) : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      {message ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>{message}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable onPress={open} style={[styles.button, { borderColor: accent }]}>
          <Text style={{ color: accent, fontSize: 12 }}>Open console</Text>
        </Pressable>
        <Pressable
          onPress={() => void exportToFile()}
          style={[styles.button, { borderColor: theme.colors.border }]}
        >
          <Text style={{ color: muted, fontSize: 12 }}>Export bundle to host</Text>
        </Pressable>
      </View>
      {bundle ? (
        <Text style={{ color: muted, fontSize: 11 }} numberOfLines={2}>
          Bundle written: {bundle.path} ({bundle.bytes} bytes)
        </Text>
      ) : null}

      {needsSetup ? (
        <View style={styles.vaultForm}>
          <Text style={{ color: fg, fontSize: 12, fontWeight: "600" }}>
            First run — create the master password
          </Text>
          <Text style={{ color: muted, fontSize: 11 }}>
            It opens the storage where connection logins and passwords are kept. You will not be
            asked for it again while the storage stays unlocked.
          </Text>
          <TextInput
            value={masterPassword}
            onChangeText={setMasterPassword}
            placeholder="master password"
            secureTextEntry
            style={[styles.input, { color: fg, borderColor: muted }]}
          />
          <Pressable
            onPress={() => void submitVault()}
            disabled={busy}
            style={[styles.button, { borderColor: accent, opacity: busy ? 0.5 : 1 }]}
          >
            <Text style={{ color: accent, fontSize: 12 }}>Create master password</Text>
          </Pressable>
        </View>
      ) : null}

      {needsUnlock ? (
        <View style={styles.vaultForm}>
          <Text style={{ color: fg, fontSize: 12, fontWeight: "600" }}>
            The secret storage is locked
          </Text>
          <Text style={{ color: muted, fontSize: 11 }}>
            Enter the master password to open connection logins and passwords.
          </Text>
          <TextInput
            value={masterPassword}
            onChangeText={setMasterPassword}
            placeholder="master password"
            secureTextEntry
            style={[styles.input, { color: fg, borderColor: muted }]}
          />
          <Pressable
            onPress={() => void submitVault()}
            disabled={busy}
            style={[styles.button, { borderColor: accent, opacity: busy ? 0.5 : 1 }]}
          >
            <Text style={{ color: accent, fontSize: 12 }}>Unlock</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", gap: 6 }}>
        {([
          { view: "connections" as const, label: "Connections" },
          { view: "sessions" as const, label: `Sessions (${sessions})` },
        ]).map(({ view, label }) => (
          <Pressable
            key={view}
            onPress={() => setPanelView({ view })}
            style={[
              styles.button,
              styles.viewButton,
              { borderColor: panelView.view === view ? accent : theme.colors.border },
            ]}
          >
            <Text
              style={{
                color: panelView.view === view ? accent : muted,
                fontSize: 11,
                fontWeight: panelView.view === view ? "600" : "400",
              }}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {panelView.view === "sessions" ? (
        <SessionList
          theme={theme}
          terminals={sshTerminals}
          windows={windows}
          emptyLabel="Nothing running in this workspace."
          onOpenWorkspace={(id) => navigation?.openWorkspace({ workspaceId: id })}
        />
      ) : open_ ? (
        groups.length === 0 && connections.length === 0 ? (
          <Text style={{ color: muted, fontSize: 11 }}>
            No connections yet — create one in the console.
          </Text>
        ) : (
          <View style={styles.tree}>
            {connections
              .filter((connection) => connection.groupId === null)
              .map(renderConnectionRow)}
            {orderedGroups(groups).map(({ group, depth }) => (
              <View key={group.id} style={{ marginTop: 6 }}>
                <Text
                  style={{ color: fg, fontSize: 12, fontWeight: "600", marginLeft: depth * 14 }}
                  numberOfLines={1}
                >
                  {group.name}
                </Text>
                <View style={{ marginLeft: (depth + 1) * 14 }}>
                  {connections.filter((connection) => connection.groupId === group.id).length === 0 ? (
                    <Text style={{ color: muted, fontSize: 11 }}>—</Text>
                  ) : (
                    connections
                      .filter((connection) => connection.groupId === group.id)
                      .map(renderConnectionRow)
                  )}
                </View>
              </View>
            ))}
          </View>
        )
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 6 },
  button: { borderWidth: 1, borderRadius: 6, padding: 8, alignSelf: "flex-start" },
  launchButton: { paddingVertical: 5, paddingHorizontal: 10 },
  viewButton: { paddingVertical: 4, paddingHorizontal: 9 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  rowInfo: { flex: 1, gap: 1 },
  tree: { gap: 2 },
  vaultForm: { gap: 6, marginTop: 4 },
  input: { borderWidth: 1, borderRadius: 6, padding: 8, width: 220 },
});
