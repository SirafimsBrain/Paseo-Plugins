import { useCallback, useEffect, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  checkConnection,
  checkConnectionDraft,
  clientStatus,
  conflictCheck,
  deleteConnection,
  listConnections,
  saveConnection,
} from "../shared/contracts";
import type { ConnectionView, ConflictCheck, ClientStatus } from "../shared/contracts";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Memory Flash Client surface — the remote memory hosts this machine
 * talks to.
 *
 * The flow mirrors the trust model: on the memory host the user generates
 * an API key (shown once) and copies URL + secret here; the client stores
 * the key in its private `connections.json` and injects the HTTP MCP
 * server into agents created through Paseo.
 *
 * Sections: client identity, coexistence with memory-flash, the
 * connection list with per-connection Check, and the add form (with a
 * "Test" probe that runs before the connection is saved).
 */
export function ConnectionsSurface({ theme }: PluginSurfaceProps) {
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const mono = monoFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const monoStyle = mono ? { fontFamily: mono } : null;
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const border = theme.colors.border;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;
  const success = theme.colors.statusSuccess;

  const listRpc = useRpc(listConnections);
  const saveRpc = useRpc(saveConnection);
  const deleteRpc = useRpc(deleteConnection);
  const checkRpc = useRpc(checkConnection);
  const draftRpc = useRpc(checkConnectionDraft);
  const statusRpc = useRpc(clientStatus);
  const conflictRpc = useRpc(conflictCheck);

  const [reloadKey, setReloadKey] = useState(0);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [conflict, setConflict] = useState<ConflictCheck | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingDraft, setTestingDraft] = useState(false);

  // add-form state
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    void listRpc({})
      .then((result) => setConnections(result.connections))
      .catch(() => undefined);
    void statusRpc({}).then(setStatus).catch(() => undefined);
    void conflictRpc({}).then(setConflict).catch(() => undefined);
  }, [listRpc, statusRpc, conflictRpc, reloadKey]);

  const checkOne = async (connection: ConnectionView) => {
    setBusyId(connection.id);
    setMessage(null);
    const result = await checkRpc({ id: connection.id }).catch(() => null);
    setBusyId(null);
    if (!result) {
      setMessage(`${connection.label}: the check could not be completed.`);
      return;
    }
    setMessage(
      result.ok
        ? `${connection.label}: reachable — ${result.serverName ?? "memory-flash"} with ${result.toolCount ?? 0} tool(s) in ${result.latencyMs} ms.`
        : `${connection.label}: ${result.error ?? "unreachable"}`,
    );
    reload();
  };

  const remove = async (connection: ConnectionView) => {
    setMessage(null);
    await deleteRpc({ id: connection.id }).catch(() => undefined);
    setMessage(`${connection.label} removed — the key must be revoked on the memory host too.`);
    reload();
  };

  const testDraft = async () => {
    setMessage(null);
    const trimmedUrl = url.trim();
    const trimmedSecret = secret.trim();
    if (trimmedUrl.length === 0 || trimmedSecret.length === 0) {
      setMessage("Enter both the MCP URL and the API key to test.");
      return;
    }
    setTestingDraft(true);
    const result = await draftRpc({ url: trimmedUrl, secret: trimmedSecret }).catch(() => null);
    setTestingDraft(false);
    setMessage(
      result === null
        ? "The connection test could not be completed."
        : result.ok
          ? `Reachable — ${result.serverName ?? "memory-flash"} with ${result.toolCount ?? 0} tool(s) in ${result.latencyMs} ms.`
          : result.error ?? "unreachable",
    );
  };

  const add = async () => {
    setMessage(null);
    const trimmedLabel = label.trim();
    const trimmedUrl = url.trim();
    const trimmedSecret = secret.trim();
    if (trimmedLabel.length === 0) {
      setMessage("Give the memory host a name.");
      return;
    }
    if (trimmedUrl.length === 0 || trimmedSecret.length === 0) {
      setMessage("The MCP URL and the API key are required.");
      return;
    }
    const result = await saveRpc({
      connection: {
        id: "",
        label: trimmedLabel,
        url: trimmedUrl,
        secret: trimmedSecret,
        enabled: true,
      },
    }).catch(() => null);
    if (!result?.ok) {
      setMessage(result?.error ?? "Could not save the connection.");
      return;
    }
    setLabel("");
    setUrl("");
    setSecret("");
    setMessage("Connection saved — agents created from now on will use it.");
    reload();
  };

  const statusColor = (entry: ConnectionView): string =>
    entry.status === "ok" ? success : entry.status === "error" ? danger : fgMuted;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.flex}>
        <Text style={{ color: fg, fontSize: font(15), fontWeight: "600" as const, ...uiFontStyle }}>
          Remote memory hosts
        </Text>
        <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 2, ...uiFontStyle }}>
          This machine connects to memory-flash HTTP endpoints over an API key. On the memory host: enable the HTTP endpoint in Memory Flash → Remote access, generate a key, then paste the URL and secret below.
        </Text>

        {status ? (
          <View style={[styles.card, { borderColor: border }]}>
            <Text style={{ color: fg, fontSize: font(13), fontWeight: "600" as const, ...uiFontStyle }}>
              This client
            </Text>
            <Text style={{ color: fgMuted, fontSize: font(11), ...monoStyle }} numberOfLines={1}>
              uuid {status.clientId}
            </Text>
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>
              host {status.identityHost} · {status.enabledConnections} of {status.totalConnections} connection(s) enabled · injection {status.injectIntoAgents ? "on" : "off"}
            </Text>
            {conflict?.memoryFlashInstalled ? (
              <Text style={{ color: fgMuted, fontSize: font(11), marginTop: 4, ...uiFontStyle }}>
                {conflict.note}
              </Text>
            ) : null}
          </View>
        ) : null}

        {connections.length === 0 ? (
          <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 12, ...uiFontStyle }}>
            No memory hosts yet. Generate an API key on a memory-flash host and add it below.
          </Text>
        ) : (
          connections.map((entry) => (
            <View key={entry.id} style={[styles.card, { borderColor: border }]}>
              <Text style={{ color: fg, fontSize: font(13), fontWeight: "600" as const, ...uiFontStyle }}>
                {entry.label}{entry.enabled ? "" : " (disabled)"}
              </Text>
              <Text style={{ color: fgMuted, fontSize: font(11), ...monoStyle }} numberOfLines={1}>
                {entry.url}
              </Text>
              <Text style={{ color: fgMuted, fontSize: font(11), ...monoStyle }} numberOfLines={1}>
                key {entry.keyPrefix}…
              </Text>
              <Text style={{ color: statusColor(entry), fontSize: font(11), ...uiFontStyle }}>
                {entry.status}
                {entry.checkedAt ? ` · ${entry.checkedAt}` : ""}
                {entry.lastError ? ` — ${entry.lastError}` : ""}
              </Text>
              <View style={styles.cardActions}>
                <ActionButton
                  label={busyId === entry.id ? "Checking…" : "Check"}
                  onPress={() => void checkOne(entry)}
                  color={accent}
                  font={font}
                  uiFontStyle={uiFontStyle}
                  disabled={busyId !== null}
                />
                <ActionButton
                  label="Remove"
                  onPress={() => void remove(entry)}
                  color={danger}
                  font={font}
                  uiFontStyle={uiFontStyle}
                />
              </View>
            </View>
          ))
        )}

        <Text style={{ color: fg, fontSize: font(14), fontWeight: "600" as const, marginTop: 16, ...uiFontStyle }}>
          Add a memory host
        </Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder="Name (e.g. office-memory)"
          placeholderTextColor={fgMuted}
          style={[styles.input, { borderColor: border, color: fg, fontSize: font(13) }, uiFontStyle]}
        />
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="http://100.64.0.2:8787/mcp"
          placeholderTextColor={fgMuted}
          autoCapitalize="none"
          style={[styles.input, { borderColor: border, color: fg, fontSize: font(13) }, monoStyle]}
        />
        <TextInput
          value={secret}
          onChangeText={setSecret}
          placeholder="mf_live_…"
          placeholderTextColor={fgMuted}
          autoCapitalize="none"
          secureTextEntry
          style={[styles.input, { borderColor: border, color: fg, fontSize: font(13) }, monoStyle]}
        />
        <View style={styles.formButtons}>
          <Pressable
            onPress={() => void testDraft()}
            disabled={testingDraft}
            style={[styles.smallButton, { borderColor: border }]}
          >
            <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>
              {testingDraft ? "Testing…" : "Test"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void add()}
            style={[styles.smallButton, { borderColor: accent }]}
          >
            <Text style={{ color: accent, fontSize: font(12), ...uiFontStyle }}>Add</Text>
          </Pressable>
        </View>
        {message ? (
          <Text style={{ color: fgMuted, fontSize: font(12), marginTop: 8, ...uiFontStyle }}>
            {message}
          </Text>
        ) : null}
        <Text style={{ color: fgMuted, fontSize: font(10), marginTop: 12, ...uiFontStyle }}>
          The API key is stored in this machine's private connections.json (owner-only). It is never written to git, agent prompts or plugin logs, and the memory host only keeps its hash. Revoke the key on the memory host to cut access.
        </Text>
      </ScrollView>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  color,
  font,
  uiFontStyle,
  disabled,
}: {
  label: string;
  onPress: () => void;
  color: string;
  font: (base: number) => number;
  uiFontStyle: { fontFamily: string } | null;
  disabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={styles.actionButton}>
      <Text style={{ color, fontSize: font(12), ...uiFontStyle }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12 },
  flex: { flex: 1 },
  card: { borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 8 },
  cardActions: { flexDirection: "row", gap: 14, marginTop: 6 },
  actionButton: { paddingVertical: 2 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, marginTop: 8 },
  formButtons: { flexDirection: "row", gap: 8, marginTop: 10 },
  smallButton: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
});
