import { useCallback, useEffect, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { memoryFlashClientSettings } from "../shared/settings";
import {
  clientStatus,
  conflictCheck,
  installSkill,
  regenerateClientId,
  skillPreview,
  skillStatus,
  uninstallSkill,
} from "../shared/contracts";
import type {
  ClientStatus,
  ConflictCheck,
  SkillStatusTarget,
} from "../shared/contracts";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Memory Flash Client settings (Paseo Settings → Plugins → Memory Flash
 * Client).
 *
 * Sections:
 * - Identity: the client UUID and host name announced to memory hosts
 *   (with a one-click UUID reset), and the toggle for the identity
 *   headers.
 * - Integration: how the remote memory servers are named and whether
 *   they are injected into agents created through Paseo.
 * - Coexistence: whether memory-flash itself is installed on this host
 *   (allowed — the two plugins have disjoint roles).
 */
export function ConnectionsSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(memoryFlashClientSettings);
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const mono = monoFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const monoStyle = mono ? { fontFamily: mono } : null;
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const danger = theme.colors.statusDanger;

  const statusRpc = useRpc(clientStatus);
  const conflictRpc = useRpc(conflictCheck);
  const regenerateRpc = useRpc(regenerateClientId);
  const skillStatusRpc = useRpc(skillStatus);
  const installSkillRpc = useRpc(installSkill);
  const uninstallSkillRpc = useRpc(uninstallSkill);
  const skillPreviewRpc = useRpc(skillPreview);

  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [conflict, setConflict] = useState<ConflictCheck | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [skillTargets, setSkillTargets] = useState<SkillStatusTarget[]>([]);
  const [skillMessage, setSkillMessage] = useState<string | null>(null);
  const [skillDoc, setSkillDoc] = useState<string>("");

  const reloadSkills = useCallback(() => {
    void skillStatusRpc({})
      .then((result) => setSkillTargets(result.targets))
      .catch(() => undefined);
  }, [skillStatusRpc]);

  useEffect(() => {
    void statusRpc({}).then(setStatus).catch(() => undefined);
    void conflictRpc({}).then(setConflict).catch(() => undefined);
  }, [statusRpc, conflictRpc]);

  useEffect(() => {
    reloadSkills();
    void skillPreviewRpc({})
      .then((result) => setSkillDoc(result.markdown))
      .catch(() => undefined);
  }, [reloadSkills, skillPreviewRpc]);

  if (settings.status === "loading") {
    return (
      <View style={styles.container}>
        <Text style={{ color: fg, fontSize: font(13), ...uiFontStyle }}>Loading settings…</Text>
      </View>
    );
  }
  if (settings.status !== "ready") {
    return (
      <View style={styles.container}>
        <Text style={{ color: danger, fontSize: font(12) }}>
          Settings are invalid: {settings.error}
        </Text>
      </View>
    );
  }

  const values = settings.values;
  const patch = (partial: Partial<typeof values>) => {
    void settings.save({ ...values, ...partial }, settings.revision);
  };

  const resetUuid = async () => {
    setMessage(null);
    const result = await regenerateRpc({}).catch(() => null);
    if (!result) {
      setMessage("Could not generate a new UUID.");
      return;
    }
    patch({ clientId: result.clientId });
    setMessage(`New client UUID pinned: ${result.clientId}`);
  };

  return (
    <ScrollView style={styles.container}>
      {settings.saveError ? (
        <Text style={{ color: danger, fontSize: font(12), ...uiFontStyle }}>
          {settings.saveError}
        </Text>
      ) : null}
      <SettingsCard>
        <SettingsSection
          title="Identity"
          info="Sent to every memory host as advisory headers (X-Memory-Flash-Client-Id / X-Memory-Flash-Host) so the memory host can tell several clients apart in its audit log. They grant no access — the API key is the credential."
        >
          <SettingsInput
            label="Client UUID"
            hint="Leave empty to use an automatically generated UUID; pin one to keep the identity stable across reinstallation."
            initialValue={values.clientId}
            placeholder="(automatic)"
            onChangeText={(text: string) => patch({ clientId: text.trim() })}
          />
          <SettingsInput
            label="Host name"
            hint="Defaults to this machine's hostname. Set a readable name (e.g. studio-laptop) to identify it on the memory host."
            initialValue={values.hostname}
            placeholder="(this machine)"
            onChangeText={(text: string) => patch({ hostname: text })}
          />
          <SettingsAction
            label="Client UUID"
            actionLabel="Generate a new UUID"
            onPress={() => void resetUuid()}
          />
          {status ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...monoStyle }}>
              current identity: {status.identityHost} · {status.clientId}
            </Text>
          ) : null}
          {message ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{message}</Text>
          ) : null}
          <SettingsSwitch
            label="Send identity headers"
            hint="Disable only to talk to a memory host that does not understand the headers; the API key is always sufficient for authentication."
            value={values.sendIdentityHeaders}
            onValueChange={(enabled: boolean) => patch({ sendIdentityHeaders: enabled })}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Integration"
          info="Every enabled connection is injected into agents created through Paseo as one HTTP MCP server with the API key attached."
        >
          <SettingsSwitch
            label="Inject remote memory servers into new agents"
            value={values.injectIntoAgents}
            onValueChange={(enabled: boolean) => patch({ injectIntoAgents: enabled })}
          />
          <SettingsInput
            label="MCP server name"
            hint="Used for a single connection; with several, each name is suffixed with the connection id to stay unique."
            initialValue={values.mcpServerName}
            onChangeText={(text: string) => patch({ mcpServerName: text })}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Agent skill"
          info="Teaches the agents on this machine that the remote memory_* tools are a shared team base, when to search it and what to write back. Without it agents treat the remote memory as an optional extra and mostly skip it."
        >
          <SettingsAction
            label="Install"
            actionLabel="Install into all agents"
            onPress={() => {
              setSkillMessage(null);
              void installSkillRpc({ targetId: "agents" })
                .then((result) => {
                  setSkillMessage(
                    result.ok
                      ? `Installed ${result.path}.`
                      : (result.error ?? "Install failed."),
                  );
                  reloadSkills();
                })
                .catch(() => setSkillMessage("Install failed."));
            }}
          />
          {skillTargets.map((row) => (
            <View key={row.id} style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={{ color: fg, fontSize: font(12), ...uiFontStyle }}>{row.label}</Text>
                <Text
                  style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }}
                  numberOfLines={1}
                >
                  {row.installed
                    ? row.upToDate
                      ? "installed · up to date"
                      : "installed · outdated"
                    : row.detected
                      ? "detected · not installed"
                      : "not installed"}
                </Text>
              </View>
              <View style={styles.rowActions}>
                <Pressable
                  onPress={() => {
                    setSkillMessage(null);
                    void (row.installed ? uninstallSkillRpc({ targetId: row.id }) : installSkillRpc({ targetId: row.id }))
                      .then((result) => {
                        if ("path" in result && result.ok) setSkillMessage(`Installed ${result.path}.`);
                        else if (result.ok) setSkillMessage(`Removed the skill from ${row.label}.`);
                        else setSkillMessage(result.error ?? "Failed.");
                        reloadSkills();
                      })
                      .catch(() => setSkillMessage("Failed."));
                  }}
                  style={[
                    styles.rowButton,
                    { borderColor: row.installed ? danger : fgMuted },
                  ]}
                >
                  <Text
                    style={{
                      color: row.installed ? danger : fgMuted,
                      fontSize: font(11),
                      ...uiFontStyle,
                    }}
                  >
                    {row.installed ? "Remove" : "Install"}
                  </Text>
                </Pressable>
              </View>
            </View>
          ))}
          {skillMessage ? (
            <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{skillMessage}</Text>
          ) : null}
          {skillDoc ? (
            <Text
              style={{ color: fgMuted, fontSize: font(11), marginTop: 4, ...uiFontStyle }}
              numberOfLines={6}
            >
              {skillDoc.slice(0, 220)}…
            </Text>
          ) : null}
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection
          title="Coexistence with memory-flash"
          info="memory-flash-client and memory-flash may run on the same host. memory-flash is the single memory host; this plugin only adds remote HTTP connections, so the two never conflict."
        >
          {conflict ? (
            <>
              <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>
                memory-flash on this host: {conflict.memoryFlashInstalled ? "yes" : "no"} · conflict:{" "}
                {conflict.conflict ? "yes" : "no"}
              </Text>
              {conflict.note ? (
                <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>
                  {conflict.note}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>Checking…</Text>
          )}
        </SettingsSection>
      </SettingsCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowInfo: { flex: 1 },
  rowActions: { flexDirection: "row", gap: 6 },
  rowButton: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
});
