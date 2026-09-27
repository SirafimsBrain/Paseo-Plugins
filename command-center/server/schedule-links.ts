import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandDefinition, HistoryEntry } from "../shared/commands";
import { paseoHome, storeRoot } from "./store";

/**
 * Plugin-side link store for schedules (`schedules.json`).
 *
 * The daemon is the source of truth for a schedule's existence and runtime
 * state; this file only records which command created which schedule, so the
 * Schedules tab can group rows by command and keep working when the daemon
 * briefly forgets nothing (it persists schedules itself). Entries whose
 * schedule disappeared on the daemon are pruned on the next list call.
 */

export interface ScheduleLink {
  scheduleId: string;
  commandId: string;
  commandName: string;
  createdAt: string;
}

function schedulesFile(): string {
  return path.join(storeRoot(), "schedules.json");
}

function writeJsonAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(temp, target);
}

export function loadScheduleLinks(): ScheduleLink[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(schedulesFile(), "utf-8"));
    return Array.isArray(parsed) ? (parsed as ScheduleLink[]) : [];
  } catch {
    return [];
  }
}

export function saveScheduleLinks(links: ScheduleLink[]): void {
  writeJsonAtomic(schedulesFile(), links);
}

export function linkSchedule(link: ScheduleLink): void {
  const links = loadScheduleLinks().filter((entry) => entry.scheduleId !== link.scheduleId);
  links.push(link);
  saveScheduleLinks(links);
}

export function unlinkSchedule(scheduleId: string): void {
  saveScheduleLinks(loadScheduleLinks().filter((entry) => entry.scheduleId !== scheduleId));
}

export function commandNameFor(commands: CommandDefinition[], commandId: string | null): string | null {
  if (!commandId) return null;
  return commands.find((command) => command.id === commandId)?.name ?? null;
}

/** Keeps the plugin history limit consistent with the run history list. */
export function historyLimitFor(entries: HistoryEntry[]): number {
  return Math.max(entries.length, 50);
}
