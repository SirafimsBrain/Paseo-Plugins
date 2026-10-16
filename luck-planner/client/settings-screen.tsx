import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { scaledFont, useHostFontScale } from "./use-host-typography";
import {
  DEFAULT_HTTP_PORT,
  generateAccessToken,
  luckPlannerSettings,
} from "../shared/settings";

/**
 * Plugin settings screen (Paseo Settings → Plugins → Luck Planner,
 * PLAN.md stage E4). Edits the five host-scoped settings registered by the
 * server: MCP injection, reported server name, dashboard HTTP port
 * (0 = auto), access token (regenerate), and audit-history retention
 * (0 = keep forever). Every save goes through `settings.save` — the host
 * persists the doc, so values survive daemon restarts, and the server
 * re-reads them live (`agent.create` per creation, retention on
 * `subscribe`), so no daemon restart is needed — a plugin reload suffices.
 */
export function LuckPlannerSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(luckPlannerSettings);
  const fontScale = useHostFontScale();
  const font = (base: number) => scaledFont(base, fontScale);
  const fg = theme.colors.foreground;
  const danger = theme.colors.statusDanger;
  const accent = theme.colors.accent;

  if (settings.status === "loading") {
    return (
      <View style={styles.container}>
        <Text style={{ color: fg, fontSize: font(13) }}>Loading settings…</Text>
      </View>
    );
  }
  if (settings.status !== "ready") {
    return (
      <View style={styles.container}>
        <Text style={{ color: danger, fontSize: font(12) }}>
          Settings are invalid: {settings.error}
        </Text>
        <Pressable onPress={() => void settings.reset()} style={styles.resetButton}>
          <Text style={{ color: accent, fontSize: font(12), textDecorationLine: "underline" }}>
            Reset to defaults
          </Text>
        </Pressable>
      </View>
    );
  }

  const values = settings.values;
  const patch = (partial: Partial<typeof values>) => {
    void settings.save({ ...values, ...partial }, settings.revision);
  };

  return (
    <View style={styles.container}>
      {settings.saveError ? (
        <Text style={{ color: danger, fontSize: font(12), marginBottom: 4 }}>
          {settings.saveError}
        </Text>
      ) : null}
      <SettingsCard>
        <SettingsSection title="Agents">
          <SettingsSwitch
            label="Inject MCP server into agents"
            hint="Adds luck-planner to every agent created through Paseo. Applies to the next agent; no daemon restart needed."
            value={values.injectIntoAgents}
            onValueChange={(enabled: boolean) => patch({ injectIntoAgents: enabled })}
          />
          <SettingsInput
            label="Reported server name"
            hint="Name the injected server reports in MCP initialize. The config key (and tool prefixes) stay luck-planner."
            initialValue={values.mcpServerName}
            onChangeText={(text: string) => patch({ mcpServerName: text })}
          />
        </SettingsSection>
        <SettingsSection title="Dashboard HTTP (stage F1)">
          <SettingsInput
            label="Port"
            hint={`1–65535, or 0 for auto (ephemeral). Default ${DEFAULT_HTTP_PORT}.`}
            initialValue={String(values.httpPort)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text.trim(), 10);
              if (
                Number.isInteger(parsed) &&
                parsed >= 0 &&
                parsed <= 65535 &&
                String(parsed) === text.trim()
              ) {
                patch({ httpPort: parsed });
              }
            }}
          />
          <SettingsRow
            label="Access token"
            hint="Sent by every dashboard request (query ?token=). Empty = a random per-session token."
          >
            <Text
              selectable
              style={{ color: fg, fontSize: font(12) }}
              numberOfLines={2}
            >
              {values.accessToken || "(auto — random each plugin load)"}
            </Text>
          </SettingsRow>
          <SettingsAction
            label="Token"
            actionLabel={values.accessToken ? "Regenerate" : "Generate"}
            hint="Replaces the token — previously opened dashboard tabs stop working."
            onPress={() => patch({ accessToken: generateAccessToken() })}
          />
        </SettingsSection>
        <SettingsSection title="History">
          <SettingsInput
            label="History retention (days)"
            hint="Audit rows older than this are pruned at plugin load and on every settings change. 0 = keep forever."
            initialValue={String(values.historyRetentionDays)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text.trim(), 10);
              if (
                Number.isInteger(parsed) &&
                parsed >= 0 &&
                parsed <= 3650 &&
                String(parsed) === text.trim()
              ) {
                patch({ historyRetentionDays: parsed });
              }
            }}
          />
        </SettingsSection>
      </SettingsCard>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 8 },
  resetButton: { marginTop: 6, alignSelf: "flex-start" },
});
