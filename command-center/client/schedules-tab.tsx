import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import type { ScheduleRun, ScheduleView } from "../shared/schedules";
import { describeCadence } from "../shared/schedules";
import {
  listScheduleRuns,
  listSchedules,
  scheduleAction,
  updateSchedule,
} from "../shared/schedules";
import { interfaceFontFamily, monoFontFamily, scaledFont, useHostTypography } from "./use-host-typography";

/**
 * Schedules tab. Lists every schedule the local daemon knows (the same store
 * the native Schedules sidebar shows), grouped by the command that created it,
 * with pause/resume/run-once/delete, an inline cadence editor and per-run
 * tracking from `scheduleLogs`.
 */

interface Props {
  theme: PluginTheme;
  reloadKey: number;
  onChanged: () => void;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const RUN_BADGE: Record<ScheduleRun["status"], string> = {
  running: "running",
  succeeded: "ok",
  failed: "failed",
};

export function SchedulesTab({ theme, reloadKey, onChanged }: Props) {
  const listRpc = useRpc(listSchedules);
  const runsRpc = useRpc(listScheduleRuns);
  const actionRpc = useRpc(scheduleAction);
  const updateRpc = useRpc(updateSchedule);

  const { foreground, foregroundMuted, statusDanger, statusSuccess } = theme.colors;
  const typography = useHostTypography();
  const font = (base: number) => scaledFont(base, typography);
  const uiFont = interfaceFontFamily(typography);
  const monoFont = monoFontFamily(typography);

  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ScheduleRun[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingCron, setEditingCron] = useState<{ id: string; value: string } | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    listRpc({})
      .then((result) => {
        if (!cancelled) {
          setSchedules(result.schedules);
          setError(null);
        }
      })
      .catch((loadError: Error) => {
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [listRpc]);

  useEffect(() => load(), [load, reloadKey]);

  const loadRuns = useCallback(
    (id: string) => {
      runsRpc({ id })
        .then((result) => setRuns((previous) => ({ ...previous, [id]: result.runs })))
        .catch(() => setRuns((previous) => ({ ...previous, [id]: [] })));
    },
    [runsRpc],
  );

  const toggle = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!runs[id]) loadRuns(id);
  };

  const act = (schedule: ScheduleView, action: "pause" | "resume" | "run-once" | "delete") => {
    setBusyId(schedule.id);
    actionRpc({ id: schedule.id, action })
      .then((result) => {
        if (!result.ok && result.error) setError(result.error);
        if (action === "delete" && result.ok) onChanged();
        load();
      })
      .catch((actionError: Error) => setError(actionError.message))
      .finally(() => setBusyId(null));
  };

  const saveCron = () => {
    if (!editingCron) return;
    setBusyId(editingCron.id);
    updateRpc({ id: editingCron.id, cron: editingCron.value })
      .then((result) => {
        if (!result.ok && result.error) setError(result.error);
        setEditingCron(null);
        load();
      })
      .catch((updateError: Error) => setError(updateError.message))
      .finally(() => setBusyId(null));
  };

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {schedules === null && error === null ? (
        <Text style={[styles.muted, { color: foregroundMuted, fontSize: font(13) }]}>Loading…</Text>
      ) : null}
      {error ? (
        <Text style={[styles.errorText, { fontSize: font(12) }]}>
          Scheduler unavailable: {error}
        </Text>
      ) : null}
      {schedules !== null && schedules.length === 0 ? (
        <Text style={[styles.muted, { color: foregroundMuted, fontSize: font(13) }]}>
          No schedules yet. Open a command’s run dialog and tap “Schedule…” to run it on a cadence.
        </Text>
      ) : null}
      {(schedules ?? []).map((schedule) => {
        const isOpen = expanded === schedule.id;
        const runList = runs[schedule.id];
        const statusColor =
          schedule.status === "active" ? statusSuccess : schedule.status === "paused" ? foregroundMuted : statusDanger;
        return (
          <View key={schedule.id} style={[styles.card, { borderColor: theme.colors.border }]}>
            <Pressable onPress={() => toggle(schedule.id)}>
              <View style={styles.cardHeader}>
                <Text style={[styles.cardTitle, { color: foreground }, uiFont ? { fontFamily: uiFont } : null, { fontSize: font(14) }]} numberOfLines={1}>
                  {schedule.name ?? schedule.id}
                </Text>
                <Text style={[styles.badge, { color: foreground, fontSize: font(10), backgroundColor: `${statusColor}33` }]}>
                  {schedule.status}
                </Text>
              </View>
              <Text style={[styles.metaLine, { color: foregroundMuted, fontSize: font(12) }]}>
                {describeCadence(schedule.cadence)}
              </Text>
              <Text style={[styles.metaLine, { color: foregroundMuted, fontSize: font(11) }]}>
                {schedule.commandName ? `Command: ${schedule.commandName} · ` : ""}
                {schedule.provider ?? "—"}
                {schedule.isolation === "worktree" ? " · worktree" : ""}
                {schedule.maxRuns != null ? ` · max ${schedule.maxRuns} runs` : ""}
              </Text>
              <Text style={[styles.metaLine, { color: foregroundMuted, fontSize: font(11) }]}>
                Next: {formatWhen(schedule.nextRunAt)} · Last: {formatWhen(schedule.lastRunAt)}
              </Text>
            </Pressable>

            <View style={styles.cardActions}>
              {schedule.status === "active" ? (
                <Pressable
                  style={[styles.actionButton, busyId === schedule.id && styles.disabled]}
                  disabled={busyId === schedule.id}
                  onPress={() => act(schedule, "pause")}
                >
                  <Text style={[styles.actionText, { color: foreground, fontSize: font(12) }]}>Pause</Text>
                </Pressable>
              ) : schedule.status === "paused" ? (
                <Pressable
                  style={[styles.actionButton, busyId === schedule.id && styles.disabled]}
                  disabled={busyId === schedule.id}
                  onPress={() => act(schedule, "resume")}
                >
                  <Text style={[styles.actionText, { color: foreground, fontSize: font(12) }]}>Resume</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={[styles.actionButton, busyId === schedule.id && styles.disabled]}
                disabled={busyId === schedule.id}
                onPress={() => act(schedule, "run-once")}
              >
                <Text style={[styles.actionText, { color: foreground, fontSize: font(12) }]}>Run now</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, busyId === schedule.id && styles.disabled]}
                disabled={busyId === schedule.id}
                onPress={() => setEditingCron({ id: schedule.id, value: schedule.cadence.type === "cron" ? schedule.cadence.expression : "0 9 * * *" })}
              >
                <Text style={[styles.actionText, { color: foreground, fontSize: font(12) }]}>Edit cadence</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, busyId === schedule.id && styles.disabled]}
                disabled={busyId === schedule.id}
                onPress={() => act(schedule, "delete")}
              >
                <Text style={[styles.actionText, styles.deleteText, { fontSize: font(12) }]}>Delete</Text>
              </Pressable>
            </View>

            {editingCron?.id === schedule.id ? (
              <View style={styles.field}>
                <Text style={[styles.fieldLabel, { color: foregroundMuted }]}>Cron expression</Text>
                <Pressable onPress={saveCron}>
                  <Text style={[styles.saveHint, { color: foreground, fontSize: font(12) }]}>{editingCron.value} — tap to save</Text>
                </Pressable>
                <View style={styles.row}>
                  {["*/15 * * * *", "0 * * * *", "0 */6 * * *", "0 9 * * *", "0 9 * * 1"].map((option) => (
                    <Pressable
                      key={option}
                      style={[styles.chip, { borderColor: theme.colors.border }]}
                      onPress={() => setEditingCron({ ...editingCron, value: option })}
                    >
                      <Text style={[styles.chipText, { color: foreground }]}>{option}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            {isOpen ? (
              <View style={styles.runsBox}>
                {runList === undefined ? (
                  <Text style={[styles.metaLine, { color: foregroundMuted, fontSize: font(11) }]}>Loading runs…</Text>
                ) : runList.length === 0 ? (
                  <Text style={[styles.metaLine, { color: foregroundMuted, fontSize: font(11) }]}>No runs recorded yet.</Text>
                ) : (
                  runList.slice(0, 10).map((run) => (
                    <View key={run.id} style={styles.runRow}>
                      <Text
                        style={[
                          styles.runBadge,
                          {
                            color: run.status === "succeeded" ? statusSuccess : run.status === "failed" ? statusDanger : foregroundMuted,
                            fontSize: font(10),
                          },
                        ]}
                      >
                        {RUN_BADGE[run.status]}
                      </Text>
                      <View style={styles.runTexts}>
                        <Text style={[styles.metaLine, { color: foregroundMuted, fontSize: font(11) }]}>
                          {formatWhen(run.startedAt)}
                          {run.endedAt ? ` → ${formatWhen(run.endedAt)}` : ""}
                        </Text>
                        {run.error ? (
                          <Text style={[styles.metaLine, { color: statusDanger, fontSize: font(11) }]} numberOfLines={2}>
                            {run.error}
                          </Text>
                        ) : run.output ? (
                          <Text style={[styles.metaLine, { color: foregroundMuted, fontSize: font(11) }]} numberOfLines={2}>
                            {run.output}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  ))
                )}
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10, paddingBottom: 24 },
  card: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.3)",
    padding: 12,
    gap: 4,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 14, fontWeight: "600", flexShrink: 1 },
  badge: {
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
  },
  metaLine: { opacity: 0.75, marginTop: 2 },
  cardActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 },
  actionButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: "rgba(128,128,128,0.18)",
  },
  disabled: { opacity: 0.5 },
  actionText: { fontSize: 12 },
  deleteText: { color: "rgb(220,80,80)" },
  field: { marginTop: 8 },
  fieldLabel: { fontSize: 12, opacity: 0.7, marginBottom: 3 },
  saveHint: { marginBottom: 6, textDecorationLine: "underline" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(128,128,128,0.4)",
  },
  chipText: { fontSize: 12 },
  runsBox: {
    marginTop: 8,
    borderRadius: 8,
    backgroundColor: "rgba(128,128,128,0.12)",
    padding: 10,
    gap: 6,
  },
  runRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  runBadge: { fontWeight: "700", marginTop: 2, textTransform: "uppercase" },
  runTexts: { flex: 1 },
  muted: { opacity: 0.6, fontSize: 13 },
  errorText: { color: "rgb(220,80,80)" },
});
