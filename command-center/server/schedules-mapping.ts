import type { ScheduleView } from "../shared/schedules";
import type { CommandDefinition } from "../shared/commands";

/**
 * Pure mapping from a daemon schedule record to the client-safe view model.
 * Kept free of imports that touch the daemon connection or the filesystem so
 * unit tests can exercise it directly.
 */

export type DaemonSchedule = {
  id: string;
  name: string | null;
  status: "active" | "paused" | "completed";
  cadence:
    | { type: "every"; everyMs: number }
    | { type: "cron"; expression: string; timezone?: string };
  target:
    | { type: "agent"; agentId: string }
    | {
        type: "new-agent";
        config: {
          provider?: string;
          model?: string;
          cwd?: string;
          isolation?: "local" | "worktree";
          archiveOnFinish?: boolean;
        };
      };
  prompt: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  maxRuns: number | null;
};

export interface ScheduleLinkLike {
  scheduleId: string;
  commandId: string;
  commandName: string;
}

/** Pure mapping used by `server/schedules.ts` and unit tests. */
export function toScheduleView(
  schedule: DaemonSchedule,
  commands: CommandDefinition[],
  links: ScheduleLinkLike[],
): ScheduleView {
  const target = schedule.target;
  const config = target.type === "new-agent" ? target.config : null;
  const link = links.find((entry) => entry.scheduleId === schedule.id) ?? null;
  const command = link ? commands.find((candidate) => candidate.id === link.commandId) ?? null : null;
  return {
    id: schedule.id,
    name: schedule.name,
    commandId: link?.commandId ?? null,
    commandName: link?.commandName ?? command?.name ?? null,
    prompt: schedule.prompt,
    status: schedule.status,
    cadence: schedule.cadence,
    targetKind: target.type,
    provider: config?.provider ?? null,
    cwd: config?.cwd ?? null,
    isolation: config?.isolation ?? null,
    archiveOnFinish: config?.archiveOnFinish ?? null,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    maxRuns: schedule.maxRuns,
  };
}
