import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { interfaceFontFamily, scaledFont, useHostTypography } from "./use-host-typography";
import { commandCenterSettings } from "../shared/settings";

/**
 * Plugin settings screen (Paseo Settings → Plugins → Command Center). Edits
 * the host-scoped settings registered by the server: history retention,
 * default provider, and the two automation hooks (auto-run on turn end,
 * workspace bootstrap). Values are command *names* — resolved by the server
 * at event time, so renamed/deleted commands simply stop firing.
 */
export function CommandCenterSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(commandCenterSettings);
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const fontStyles = uiFont ? { fontFamily: uiFont } : null;

  if (settings.status === "loading") {
    return (
      <View style={styles.container}>
        <Text style={[styles.text, { color: theme.colors.foreground, fontSize: font(13) }, fontStyles]}>
          Loading settings…
        </Text>
      </View>
    );
  }
  if (settings.status !== "ready") {
    return (
      <View style={styles.container}>
        <Text style={[styles.error, { color: theme.colors.statusDanger, fontSize: font(12) }]}>
          Settings are invalid: {settings.error}
        </Text>
        <Pressable onPress={() => void settings.reset()}>
          <Text style={[styles.reset, { color: theme.colors.accent, fontSize: font(12) }]}>Reset to defaults</Text>
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
        <Text style={[styles.error, { color: theme.colors.statusDanger, fontSize: font(12) }]}>
          {settings.saveError}
        </Text>
      ) : null}
      <SettingsCard>
        <SettingsSection title="History">
          <SettingsInput
            label="History entries kept"
            hint="Between 10 and 500 (default 50). Trimmed on the next run."
            initialValue={String(values.historyLimit)}
            onChangeText={(text: string) => {
              const parsed = Number.parseInt(text, 10);
              if (Number.isFinite(parsed) && String(parsed) === text.trim()) {
                patch({ historyLimit: parsed });
              }
            }}
          />
        </SettingsSection>
        <SettingsSection title="Defaults">
          <SettingsInput
            label="Default provider/model"
            hint="Full reference, e.g. zhipuai/MiMo-V2.6-Flash Free — prefilled for new prompt commands."
            initialValue={values.defaultProvider}
            placeholder="(none)"
            onChangeText={(text: string) => patch({ defaultProvider: text })}
          />
        </SettingsSection>
        <SettingsSection title="Automation">
          <SettingsInput
            label="Auto-run on agent turn end"
            hint="Command name to run (with template defaults) every time an agent finishes a turn successfully. Empty = off."
            initialValue={values.autoRunCommandOnTurnEnd}
            placeholder="(disabled)"
            onChangeText={(text: string) => patch({ autoRunCommandOnTurnEnd: text })}
          />
          <SettingsInput
            label="Workspace bootstrap command"
            hint="Command name to run in every newly created workspace. Empty = off."
            initialValue={values.bootstrapCommand}
            placeholder="(disabled)"
            onChangeText={(text: string) => patch({ bootstrapCommand: text })}
          />
          <SettingsSwitch
            label="Automation enabled"
            hint="Master switch: clear both automation commands to disable them."
            value={values.autoRunCommandOnTurnEnd.trim() !== "" || values.bootstrapCommand.trim() !== ""}
            onValueChange={(enabled: boolean) => {
              if (!enabled) {
                patch({ autoRunCommandOnTurnEnd: "", bootstrapCommand: "" });
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
  text: {},
  error: { marginBottom: 4 },
  reset: { textDecorationLine: "underline" },
});
