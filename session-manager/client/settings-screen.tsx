import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import {
  CLEANUP_DAY_OPTIONS,
  DEFAULT_SETTINGS,
  cleanupDaysOf,
  sessionManagerSettings,
} from "../shared/settings";

/**
 * Settings screens are host-owned: the values live in Paseo, the panel reads
 * them back through `useSettings`, and this screen is only the editor. Nothing
 * here can delete a session, so an unset or invalid document degrades to the
 * defaults instead of blocking the plugin.
 */
export function SessionManagerSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(sessionManagerSettings);
  const [draft, setDraft] = useState(DEFAULT_SETTINGS);

  const revisionRef = useRef<string | null>(null);
  useEffect(() => {
    if (settings.status !== "ready") return;
    // Only adopt values that came from the host, never a half-finished edit.
    if (revisionRef.current === settings.revision) return;
    revisionRef.current = settings.revision;
    setDraft(settings.values);
  }, [settings]);

  const disabled = settings.status !== "ready" || settings.saving;

  return (
    <SettingsSection
      title="Agent session cleanup"
      info="Session Manager never deletes without confirmation. These values only drive shortcuts, defaults, and the cleanup hint in the panel."
    >
      <SettingsSelect
        label="Cleanup reminder"
        hint="Highlights sessions older than this threshold, and pre-selects them on request."
        value={String(draft.cleanupDays)}
        options={CLEANUP_DAY_OPTIONS.map((option) => ({
          label: option.label,
          value: option.value,
        }))}
        disabled={disabled}
        onValueChange={(value) => setDraft({ ...draft, cleanupDays: cleanupDaysOf(value) })}
      />
      <SettingsSwitch
        label="Oldest sessions first"
        hint="Default order of the session list."
        value={draft.sortOldestFirst}
        disabled={disabled}
        onValueChange={(value) => setDraft({ ...draft, sortOldestFirst: value })}
      />
      <SettingsSwitch
        label="Pre-select export before delete"
        hint="The confirmation block still lets you turn it off for a single batch."
        value={draft.exportBeforeDelete}
        disabled={disabled}
        onValueChange={(value) => setDraft({ ...draft, exportBeforeDelete: value })}
      />
      <SettingsAction
        label="Save"
        actionLabel={settings.saving ? "Saving..." : "Save"}
        disabled={disabled}
        onPress={() => {
          if (settings.status !== "ready") return;
          void settings.save(draft, settings.revision);
        }}
      />
      <SettingsAction
        label="Reset to defaults"
        actionLabel="Reset"
        disabled={disabled}
        onPress={() => {
          void settings.reset();
        }}
      />
      {settings.status === "error" ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          {settings.error}
        </Text>
      ) : null}
      {settings.status === "invalid" ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{settings.error}</Text>
      ) : null}
      {settings.saveError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{settings.saveError}</Text>
      ) : null}
    </SettingsSection>
  );
}
