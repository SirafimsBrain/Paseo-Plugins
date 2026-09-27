import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Schedules bridge to the standard Paseo scheduler (daemon `schedule/*` RPCs).
 *
 * The daemon owns the schedules: they appear in the native "Schedules" sidebar
 * and keep running regardless of this plugin. The plugin adds command-centric
 * management: create a schedule from a stored command (values frozen at
 * creation time), pause/resume, run once, delete, and per-run tracking via
 * `scheduleInspect`/`scheduleLogs`. A local `schedules.json` store maps daemon
 * schedule ids back to the command that created them.
 *
 * Schedules always execute on the local daemon (the native "Host: desktop"
 * semantics) — multi-host fan-out does not apply to scheduling.
 */

export const scheduleCadenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    expression: z.string(),
    timezone: z.string().optional(),
  }),
  z.object({
    type: z.literal("every"),
    everyMs: z.number(),
  }),
]);

export type ScheduleCadence = z.infer<typeof scheduleCadenceSchema>;

/** Client-safe projection of one daemon schedule. */
export const scheduleViewSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /** Command that created the schedule; null for schedules made elsewhere. */
  commandId: z.string().nullable(),
  /** Stored label from the plugin link store (not the daemon). */
  commandName: z.string().nullable(),
  prompt: z.string(),
  status: z.enum(["active", "paused", "completed"]),
  cadence: scheduleCadenceSchema,
  targetKind: z.enum(["new-agent", "agent"]),
  provider: z.string().nullable(),
  cwd: z.string().nullable(),
  isolation: z.string().nullable(),
  archiveOnFinish: z.boolean().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  maxRuns: z.number().nullable(),
});

export type ScheduleView = z.infer<typeof scheduleViewSchema>;

/** One recorded execution of a schedule. */
export const scheduleRunSchema = z.object({
  id: z.string(),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "failed", "succeeded"]),
  agentId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});

export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

export const listSchedules = defineRpc({
  name: "command-center.schedules",
  input: z.object({}),
  output: z.object({
    schedules: z.array(scheduleViewSchema),
  }),
});

export const createSchedule = defineRpc({
  name: "command-center.schedule-create",
  input: z.object({
    commandId: z.string(),
    /** Optional display name; defaults to the command name. */
    name: z.string().trim().max(120).optional(),
    /** Template values, frozen into the prompt at creation time. */
    values: z.record(z.string(), z.string()),
    /** Workspace used for rendering context and the default cwd. */
    workspaceId: z.string().optional(),
    /** Explicit cwd override; wins over the workspace directory. */
    cwd: z.string().optional(),
    /** Full `provider/model` reference for the created agents. */
    provider: z.string().min(1),
    /** Isolate every run in a branch-off worktree. */
    newWorktree: z.boolean().default(false),
    /** Archive the agent when a run finishes. */
    archiveOnFinish: z.boolean().default(true),
    /** Five-field cron expression in the server's local time. */
    cron: z.string().trim().min(1).max(100),
    /** Cap total runs; null/undefined means unlimited. */
    maxRuns: z.number().int().min(1).max(100000).nullable().optional(),
    /** Fire the first run immediately after creation. */
    runOnCreate: z.boolean().default(false),
  }),
  output: z.object({
    ok: z.boolean(),
    id: z.string().nullable(),
    view: scheduleViewSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const scheduleAction = defineRpc({
  name: "command-center.schedule-action",
  input: z.object({
    id: z.string(),
    action: z.enum(["pause", "resume", "run-once", "delete"]),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const listScheduleRuns = defineRpc({
  name: "command-center.schedule-runs",
  input: z.object({ id: z.string() }),
  output: z.object({
    runs: z.array(scheduleRunSchema),
  }),
});

export const updateSchedule = defineRpc({
  name: "command-center.schedule-update",
  input: z.object({
    id: z.string(),
    /** Empty string leaves the cadence unchanged. */
    cron: z.string().trim().max(100).optional(),
    /** null clears the run cap. Omitted leaves it unchanged. */
    maxRuns: z.number().int().min(1).max(100000).nullable().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

/** Quick cadence presets offered by the schedule dialog. */
export const CADENCE_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily 09:00", cron: "0 9 * * *" },
  { label: "Mondays 09:00", cron: "0 9 * * 1" },
];

function pad2(value: string): string {
  return value.padStart(2, "0");
}

/**
 * Humanizes a cadence for list rows. Recognizes the common cron shapes
 * (presets above plus hourly/daily patterns); anything else falls back to the
 * raw expression, which is still readable for cron users.
 */
export function describeCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "every") {
    const minutes = cadence.everyMs / 60000;
    if (minutes >= 1440 && minutes % 1440 === 0) {
      return `Every ${minutes / 1440} ${minutes / 1440 === 1 ? "day" : "days"}`;
    }
    if (minutes >= 60 && minutes % 60 === 0) {
      return `Every ${minutes / 60} ${minutes / 60 === 1 ? "hour" : "hours"}`;
    }
    return `Every ${Math.max(1, Math.round(minutes))} min`;
  }
  const tz = cadence.timezone ? ` (${cadence.timezone})` : "";
  const match = cadence.expression.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (match) {
    const [, minute, hour, dayOfMonth, month, dayOfWeek] = match;
    const simple =
      dayOfMonth === "*" && month === "*" && dayOfWeek === "*" ? (minute ?? "") : null;
    if (simple !== null) {
      const every = minute?.match(/^\*\/(\d+)$/);
      if (every && hour === "*") return `Every ${every[1]} min${tz}`;
      if (/^\d+$/.test(minute ?? "") && hour === "*") {
        return `Hourly at :${pad2(minute ?? "")}${tz}`;
      }
      if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")) {
        return `Daily at ${pad2(hour ?? "")}:${pad2(minute ?? "")}${tz}`;
      }
    }
    if (dayOfMonth === "*" && month === "*" && /^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")) {
      const weekday = Number(dayOfWeek);
      const names = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
      if (weekday >= 0 && weekday <= 6) {
        return `${names[weekday]} at ${pad2(hour ?? "")}:${pad2(minute ?? "")}${tz}`;
      }
    }
  }
  return `${cadence.expression}${tz}`;
}

/** Minimal structural check before a cron string is sent to the daemon. */
export function looksLikeCron(value: string): boolean {
  return value.trim().split(/\s+/).length === 5;
}

/**
 * The exact prompt a scheduled run executes. Prompt commands are used as-is
 * (already rendered with frozen inputs); a shell line cannot run without an
 * agent, so it is wrapped into an instruction the created agent carries out
 * via its shell tool. Shared by the schedule dialog (preview) and the server
 * (creation) so what the user sees is exactly what the daemon stores.
 */
export function schedulePromptFor(type: "prompt" | "shell", rendered: string): string {
  if (type === "prompt") return rendered;
  return [
    "Run this shell command in the workspace directory, then report its output:",
    "",
    "```sh",
    rendered.trim(),
    "```",
  ].join("\n");
}
