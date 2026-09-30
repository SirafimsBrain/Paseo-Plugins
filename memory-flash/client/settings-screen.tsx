import { useCallback, useEffect, useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings, useRpc } from "@getpaseo/plugin/client";
import { memoryFlashSettings } from "../shared/settings";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  installSkill,
  purgeMemories,
  skillPreview,
  skillStatus,
  uninstallSkill,
  memoryStats,
} from "../shared/memories";
import { interfaceFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Plugin settings screen (Paseo Settings → Plugins → Memory Flash).
 *
 * Sections:
 * - Integration: MCP injection into Paseo-created agents.
 * - Skill (requirement 6): install the memory skill into every connected
 *   agent family with one click, per target.
 * - Database: stats and a guarded purge.
 */

type SkillRow = {
  id: string;
  label: string;
  path: string;
  detected: boolean;
  installed: boolean;
  upToDate: boolean | null;
};

export function MemoryFlashSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(memoryFlashSettings);
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const uiFontStyle = uiFont ? { fontFamily: uiFont } : null;
  const fg = theme.colors.foreground;
  const fgMuted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;

  const skillStatusRpc = useRpc(skillStatus);
  const skillInstallRpc = useRpc(installSkill);
  const skillUninstallRpc = useRpc(uninstallSkill);
  const statsRpc = useRpc(memoryStats);
  const purgeRpc = useRpc(purgeMemories);
  const skillPreviewRpc = useRpc(skillPreview);

  const [skillDoc, setSkillDoc] = useState<string>("");
  useEffect(() => {
    void skillPreviewRpc({}).then((result) => setSkillDoc(result.markdown)).catch(() => undefined);
  }, [skillPreviewRpc]);

  const [skillRows, setSkillRows] = useState<SkillRow[]>([]);
  const [skillMessage, setSkillMessage] = useState<string | null>(null);
  const [dbSummary, setDbSummary] = useState<string | null>(null);
  const [purgeTag, setPurgeTag] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const reloadSkills = useCallback(() => {
    void skillStatusRpc({}).then((result) => setSkillRows(result.targets)).catch(() => undefined);
  }, [skillStatusRpc]);

  useEffect(() => {
    reloadSkills();
    void statsRpc({}).then((snapshot) => {
      setDbSummary(`${snapshot.total} memories · ${(snapshot.dbSizeBytes / 1024).toFixed(1)} KiB`);
    }).catch(() => undefined);
  }, [reloadSkills, statsRpc]);

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
        <Text style={{ color: danger, fontSize: font(12) }}>Settings are invalid: {settings.error}</Text>
        <Pressable onPress={() => void settings.reset()}>
          <Text style={{ color: accent, fontSize: font(12), textDecorationLine: "underline" }}>Reset to defaults</Text>
        </Pressable>
      </View>
    );
  }

  const values = settings.values;
  const patch = (partial: Partial<typeof values>) => {
    void settings.save({ ...values, ...partial }, settings.revision);
  };

  const install = async (row: SkillRow) => {
    setSkillMessage(null);
    const result = await skillInstallRpc({ targetId: row.id }).catch(() => null);
    setSkillMessage(result?.ok ? `Skill installed: ${result.path}` : (result?.error ?? "Install failed."));
    reloadSkills();
  };

  const uninstall = async (row: SkillRow) => {
    setSkillMessage(null);
    const result = await skillUninstallRpc({ targetId: row.id }).catch(() => null);
    setSkillMessage(result?.ok ? `Skill removed from ${row.label}.` : (result?.error ?? "Uninstall failed."));
    reloadSkills();
  };

  const installAll = async () => {
    setSkillMessage(null);
    const failures: string[] = [];
    for (const row of skillRows) {
      const result = await skillInstallRpc({ targetId: row.id }).catch(() => null);
      if (!result?.ok) failures.push(row.label);
    }
    setSkillMessage(
      failures.length === 0
        ? "Skill installed into every detected agent location."
        : `Installed with failures: ${failures.join(", ")}`,
    );
    reloadSkills();
  };

  const purgeByTag = async () => {
    setMessage(null);
    const tag = purgeTag.trim();
    if (tag.length === 0) {
      setMessage("Enter a tag to purge.");
      return;
    }
    const result = await purgeRpc({ tags: [tag], project: null, kind: null, confirm: "DELETE" }).catch((cause: unknown) => null);
    setMessage(result ? `Purged ${result.removed} memories with tag "${tag}".` : "Purge failed (see plugin logs).");
    setPurgeTag("");
  };

  return (
    <ScrollView style={styles.container}>
      {settings.saveError ? (
        <Text style={{ color: danger, fontSize: font(12), ...uiFontStyle }}>{settings.saveError}</Text>
      ) : null}
      <SettingsCard>
        <SettingsSection title="Integration">
          <SettingsSwitch
            label="Inject MCP server into new agents"
            hint="Adds the memory-flash MCP server to every agent created through Paseo (all providers)."
            value={values.injectIntoAgents}
            onValueChange={(enabled: boolean) => patch({ injectIntoAgents: enabled })}
          />
          <SettingsInput
            label="MCP server name"
            hint="Name reported to agents in the MCP handshake."
            initialValue={values.mcpServerName}
            onChangeText={(text: string) => patch({ mcpServerName: text })}
          />
          <SettingsInput
            label="Default agent id"
            hint="Recorded on memories saved by agents that do not identify themselves."
            initialValue={values.defaultAgentId}
            placeholder="(none)"
            onChangeText={(text: string) => patch({ defaultAgentId: text })}
          />
          <SettingsInput
            label="History per memory"
            hint="Content revisions kept per memory (10–200)."
            initialValue={String(values.historyPerMemory)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ historyPerMemory: parsed });
              }
            }}
          />
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection title="Agent skill" info="Teaches agents when and how to use the shared memory.">
          <SettingsAction label="Install" actionLabel="Install into all agents" onPress={() => void installAll()} />
          {skillRows.map((row) => (
            <View key={row.id} style={styles.skillRow}>
              <View style={styles.skillInfo}>
                <Text style={{ color: fg, fontSize: font(12), ...uiFontStyle }}>{row.label}</Text>
                <Text style={{ color: fgMuted, fontSize: font(10), ...uiFontStyle }} numberOfLines={1}>
                  {row.installed ? (row.upToDate ? "installed · up to date" : "installed · outdated") : row.detected ? "detected · not installed" : "not installed"}
                </Text>
              </View>
              <View style={styles.skillActions}>
                <Pressable onPress={() => void install(row)} style={[styles.skillButton, { borderColor: accent }]}>
                  <Text style={{ color: accent, fontSize: font(11), ...uiFontStyle }}>{row.installed && !row.upToDate ? "Update" : "Install"}</Text>
                </Pressable>
                {row.installed ? (
                  <Pressable onPress={() => void uninstall(row)} style={[styles.skillButton, { borderColor: danger }]}>
                    <Text style={{ color: danger, fontSize: font(11), ...uiFontStyle }}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
          {skillMessage ? <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{skillMessage}</Text> : null}
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection title="Database" info="The shared SQLite memory file on this host.">
          <Text style={{ color: fgMuted, fontSize: font(12), ...uiFontStyle }}>
            {dbSummary ?? "Counting…"} — $PASEO_HOME/plugins/memory-flash/memory.db
          </Text>
          <Text style={{ color: fgMuted, fontSize: font(11), marginTop: 4, ...uiFontStyle }} numberOfLines={6}>
            {skillDoc ? `${skillDoc.slice(0, 220)}…` : ""}
          </Text>
          <SettingsInput
            label="Purge by tag"
            hint="Deletes every memory carrying this tag. Runs immediately."
            initialValue={purgeTag}
            placeholder="tag"
            onChangeText={setPurgeTag}
          />
          <SettingsAction label="Purge" actionLabel={`Purge tag "${purgeTag.trim() || "…"}"`} onPress={() => void purgeByTag()} />
          {message ? <Text style={{ color: fgMuted, fontSize: font(11), ...uiFontStyle }}>{message}</Text> : null}
        </SettingsSection>
      </SettingsCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  skillRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderTopWidth: 1, borderTopColor: "rgba(128,128,128,0.25)" },
  skillInfo: { flex: 1 },
  skillActions: { flexDirection: "row", gap: 8 },
  skillButton: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
});
