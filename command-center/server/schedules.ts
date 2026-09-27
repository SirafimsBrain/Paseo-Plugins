import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ScheduleView,
  ScheduleRun,
} from "../shared/schedules";
import { schedulePromptFor } from "../shared/schedules";
import type { CommandDefinition } from "../shared/commands";
import { loadCommands } from "./store";
import { getDaemonClient } from "./daemon-connection";
import { commandNameFor, linkSchedule, loadScheduleLinks, unlinkSchedule } from "./schedule-links";
import { toScheduleView, type DaemonSchedule } from "./schedules-mapping";

/**
 * Bridges the plugin RPC contracts to the daemon's `schedule/*` RPCs.
 * Every call goes through the lazy singleton `DaemonClient`; the daemon owns
 * schedule persistence, cadence evaluation and run execution.
 */

type DaemonScheduleRecord = DaemonSchedule;

type DaemonRun = {
  id: string;
  scheduledFor: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "failed" | "succeeded";
  agentId: string | null;
  output: string | null;
  error: string | null;
};

function toView(
  schedule: DaemonScheduleRecord,
  commands: CommandDefinition[],
  links: { scheduleId: string; commandId: string; commandName: string }[],
): ScheduleView {
  return toScheduleView(schedule, commands, links);
}

function toRun(run: DaemonRun): ScheduleRun {
  return {
    id: run.id,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status,
    agentId: run.agentId,
    output: run.output,
    error: run.error,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchScheduleViews(): Promise<ScheduleView[]> {
  const client = await getDaemonClient();
  const payload = await client.scheduleList();
  const commands = loadCommands();
  const links = loadScheduleLinks();
  const live = new Set(payload.schedules.map((schedule) => schedule.id));
  // Prune links for schedules deleted outside the plugin (native UI, CLI).
  const stale = links.filter((link) => !live.has(link.scheduleId));
  if (stale.length > 0) {
    for (const link of stale) unlinkSchedule(link.scheduleId);
  }
  return payload.schedules.map((schedule) => toView(schedule, commands, links));
}

export async function createScheduleFromCommand(input: {
  commandId: string;
  name?: string | null;
  values: Record<string, string>;
  workspaceId?: string | null;
  cwd?: string | null;
  provider: string;
  newWorktree: boolean;
  archiveOnFinish: boolean;
  cron: string;
  maxRuns?: number | null;
  runOnCreate: boolean;
  /** Workspace name for template rendering; null when unknown. */
  workspaceName?: string | null;
  /** Workspace directory fallback for the run cwd. */
  workspaceDirectory?: string | null;
  render: (template: string, values: Record<string, string>, context: {
    workspaceName?: string | null;
    workspacePath?: string | null;
  }) => string;
}): Promise<{ ok: boolean; id: string | null; view: ScheduleView | null; error: string | null }> {
  const command = loadCommands().find((candidate) => candidate.id === input.commandId);
  if (!command) {
    return { ok: false, id: null, view: null, error: `Unknown command ${input.commandId}.` };
  }
  const rendered = schedulePromptFor(
    command.type,
    input.render(command.template, input.values, {
      workspaceName: input.workspaceName ?? null,
      workspacePath: input.workspaceDirectory ?? null,
    }),
  );
  const cwd = input.cwd?.trim() || input.workspaceDirectory?.trim() || "";
  if (cwd.length === 0) {
    return {
      ok: false,
      id: null,
      view: null,
      error: "No working directory — select a workspace in the run dialog, then schedule from there.",
    };
  }
  try {
    const client = await getDaemonClient();
    const payload = await client.scheduleCreate({
      name: input.name?.trim() ? input.name.trim() : command.name,
      prompt: rendered,
      cadence: { type: "cron", expression: input.cron.trim() },
      target: {
        type: "new-agent",
        config: {
          provider: input.provider,
          cwd,
          isolation: input.newWorktree ? "worktree" : "local",
          archiveOnFinish: input.archiveOnFinish,
        },
      },
      ...(input.maxRuns != null ? { maxRuns: input.maxRuns } : {}),
      runOnCreate: input.runOnCreate,
    });
    const created = payload.schedule;
    if (!created) {
      return { ok: false, id: null, view: null, error: payload.error ?? "The daemon rejected the schedule." };
    }
    linkSchedule({
      scheduleId: created.id,
      commandId: command.id,
      commandName: command.name,
      createdAt: new Date().toISOString(),
    });
    const view = toView(created as DaemonScheduleRecord, loadCommands(), loadScheduleLinks());
    return { ok: true, id: created.id, view, error: null };
  } catch (error) {
    return { ok: false, id: null, view: null, error: errorText(error) };
  }
}

export async function runScheduleAction(
  id: string,
  action: "pause" | "resume" | "run-once" | "delete",
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const client = await getDaemonClient();
    switch (action) {
      case "pause":
        await client.schedulePause({ id });
        break;
      case "resume":
        await client.scheduleResume({ id });
        break;
      case "run-once":
        await client.scheduleRunOnce({ id });
        break;
      case "delete":
        await client.scheduleDelete({ id });
        unlinkSchedule(id);
        break;
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export async function fetchScheduleRuns(id: string): Promise<ScheduleRun[]> {
  const client = await getDaemonClient();
  const payload = await client.scheduleLogs({ id });
  return payload.runs.map(toRun);
}

export async function updateScheduleOnDaemon(input: {
  id: string;
  cron?: string | null;
  maxRuns?: number | null;
}): Promise<{ ok: boolean; error: string | null }> {
  try {
    const client = await getDaemonClient();
    await client.scheduleUpdate({
      id: input.id,
      ...(input.cron && input.cron.trim().length > 0
        ? { cadence: { type: "cron" as const, expression: input.cron.trim() } }
        : {}),
      ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
    });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}
