import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { CommandDefinition } from "../shared/commands";
import { CADENCE_PRESETS, looksLikeCron, schedulePromptFor } from "../shared/schedules";
import { renderPreview } from "./preview";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Schedule-creation dialog. Renders from the run dialog state (values and
 * provider already resolved) or directly from a stored command (the card's
 * Schedule button), so the user schedules exactly what they see: the prompt is
 * rendered once here and frozen into the schedule. Shell lines are wrapped
 * into an agent instruction via `schedulePromptFor`.
 */

export interface ScheduleDialogProps {
  command: CommandDefinition;
  theme: PluginTheme;
  /** Frozen prompt built from the current values (rendered preview). */
  renderedPrompt: string;
  provider: string;
  workspaceName: string | null;
  newWorktree: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (input: { name: string; cron: string; maxRuns: number | null; runOnCreate: boolean }) => void;
  onCancel: () => void;
}

export function ScheduleDialog({
  command,
  theme,
  renderedPrompt,
  provider,
  workspaceName,
  newWorktree,
  busy,
  error,
  onCreate,
  onCancel,
}: ScheduleDialogProps) {
  const { foreground, foregroundMuted } = theme.colors;
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const monoFont = monoFontFamily(typography);

  const [name, setName] = useState(command.name);
  const [cron, setCron] = useState("0 9 * * *");
  const [preset, setPreset] = useState<string | null>("0 9 * * *");
  const [maxRunsText, setMaxRunsText] = useState("");
  const [runOnCreate, setRunOnCreate] = useState(false);

  const maxRuns = useMemo(() => {
    const trimmed = maxRunsText.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
  }, [maxRunsText]);

  const cronValid = looksLikeCron(cron);
  const maxRunsValid = maxRunsText.trim().length === 0 || maxRuns !== null;

  const applyPreset = (next: string) => {
    setPreset(next);
    setCron(next);
  };

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: foreground }, uiFont ? { fontFamily: uiFont } : null, { fontSize: font(16) }]}>
        Schedule “{command.name}”
      </Text>
      <Text style={[styles.subtitle, { color: foregroundMuted, fontSize: font(12) }]}>
        Runs on this host via the standard Paseo scheduler{workspaceName ? ` — ${workspaceName}` : ""}.{" "}
        {command.type === "shell"
          ? "The shell line is frozen into an agent instruction"
          : "The prompt is frozen with the current inputs"}
        ; edit the schedule here, on the Schedules tab, or in the native Schedules sidebar.
      </Text>

      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>Name</Text>
        <TextInput
          style={[styles.input, { color: foreground, borderColor: theme.colors.border }]}
          value={name}
          onChangeText={setName}
          placeholder="Schedule name"
          placeholderTextColor={foregroundMuted}
        />
      </View>

      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>Cadence</Text>
        <View style={styles.row}>
          {CADENCE_PRESETS.map((option) => (
            <Pressable
              key={option.cron}
              style={[styles.chip, { borderColor: theme.colors.border }, preset === option.cron && styles.chipActive]}
              onPress={() => applyPreset(option.cron)}
            >
              <Text style={[styles.chipText, { color: foreground }]}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          style={[styles.input, { color: foreground, borderColor: theme.colors.border }, monoFont ? { fontFamily: monoFont } : null]}
          value={cron}
          onChangeText={(next) => {
            setCron(next);
            setPreset(CADENCE_PRESETS.some((option) => option.cron === next) ? next : null);
          }}
          placeholder="cron expression, e.g. */30 * * * *"
          placeholderTextColor={foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!cronValid ? (
          <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>
            A cron expression needs five fields (minute hour day month weekday).
          </Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>Max runs (empty = unlimited)</Text>
        <TextInput
          style={[styles.input, { color: foreground, borderColor: theme.colors.border }]}
          value={maxRunsText}
          onChangeText={setMaxRunsText}
          placeholder="Unlimited"
          placeholderTextColor={foregroundMuted}
          keyboardType="number-pad"
        />
      </View>

      <View style={styles.field}>
        <Pressable style={styles.checkRow} onPress={() => setRunOnCreate((value) => !value)}>
          <Text style={[styles.check, { color: foreground }]}>{runOnCreate ? "☑" : "☐"}</Text>
          <Text style={[styles.checkLabel, { color: foreground }]}>Run once right after creating</Text>
        </Pressable>
      </View>

      <View style={styles.previewBox}>
        <Text style={[styles.previewLabel, { color: foregroundMuted }]}>Prompt each run</Text>
        <Text style={[styles.previewText, { color: foreground, fontSize: font(12) }, monoFont ? { fontFamily: monoFont } : null]}>
          {schedulePromptFor(command.type, renderedPrompt) || "—"}
        </Text>
        <Text style={[styles.previewMeta, { color: foregroundMuted, fontSize: font(11) }]}>
          {[provider, workspaceName, newWorktree ? "worktree isolation" : "local"]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join(" · ")}
        </Text>
      </View>

      {error ? <Text style={[styles.hint, { color: theme.colors.statusDanger }]}>{error}</Text> : null}

      <View style={styles.row}>
        <Pressable style={[styles.button, styles.secondaryButton]} onPress={onCancel} disabled={busy}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
        <Pressable
          style={[styles.button, (!cronValid || !maxRunsValid || busy) && styles.buttonDisabled]}
          disabled={!cronValid || !maxRunsValid || busy}
          onPress={() => onCreate({ name, cron, maxRuns, runOnCreate })}
        >
          <Text style={styles.buttonText}>{busy ? "Creating…" : "Create schedule"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 4 },
  title: { fontSize: 16, fontWeight: "700" },
  subtitle: { fontSize: 12, opacity: 0.6, marginBottom: 6 },
  field: { marginTop: 8 },
  fieldLabel: { fontSize: 12, opacity: 0.7, marginBottom: 3 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
  },
  chipActive: { backgroundColor: "rgba(90,140,255,0.25)", borderColor: "rgba(90,140,255,0.8)" },
  chipText: { fontSize: 12 },
  input: {
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  check: { fontSize: 14 },
  checkLabel: { fontSize: 13 },
  previewBox: {
    marginTop: 10,
    borderRadius: 8,
    backgroundColor: "rgba(128,128,128,0.12)",
    padding: 10,
  },
  previewLabel: { fontSize: 11, opacity: 0.6, marginBottom: 2 },
  previewText: { fontSize: 12, fontFamily: "monospace" },
  previewMeta: { fontSize: 11, opacity: 0.6, marginTop: 4 },
  hint: { fontSize: 11, marginTop: 4 },
  button: {
    flex: 1,
    marginTop: 12,
    backgroundColor: "rgba(90,140,255,0.9)",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  secondaryButton: { backgroundColor: "rgba(128,128,128,0.3)" },
  buttonText: { color: "white", fontWeight: "600" },
});
