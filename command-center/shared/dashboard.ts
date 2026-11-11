import type { CommandDefinition, HistoryEntry } from "./commands";
import { mostUsedCommands } from "./analytics";

export interface DashboardSummary {
  commandCount: number;
  /** Sum of the server-owned per-command counters (all successful runs). */
  totalRuns: number;
  /** Failures inside the loaded history window (bounded by history retention). */
  failedRuns: number;
  /** Newest-first slice of the history window. */
  recent: HistoryEntry[];
  mostUsed: CommandDefinition[];
}

export interface DashboardOptions {
  recentLimit?: number;
  mostUsedLimit?: number;
}

/**
 * Read-only dashboard data (0.12.x).
 *
 * The dashboard is a native tab inside the Command Center screen — it is not a
 * web page and not an external browser view — so everything it shows is derived
 * here from the same store the library and history tabs use.
 *
 * `totalRuns` comes from the monotonic `useCount` counters; `failedRuns` and
 * `recent` are limited to the stored history window (the plugin keeps between
 * 10 and 500 entries), which the UI labels as "recent" instead of pretending to
 * be a complete run log.
 *
 * Pure and client-safe, so the tab and the tests share one definition.
 */
export function dashboardSummary(
  commands: CommandDefinition[],
  history: HistoryEntry[],
  options: DashboardOptions = {},
): DashboardSummary {
  const recentLimit = Math.max(0, options.recentLimit ?? 20);
  const mostUsedLimit = Math.max(0, options.mostUsedLimit ?? 3);
  return {
    commandCount: commands.length,
    totalRuns: commands.reduce((sum, command) => sum + command.useCount, 0),
    failedRuns: history.filter((entry) => !entry.ok).length,
    recent: history.slice(0, recentLimit),
    mostUsed: mostUsedCommands(commands, mostUsedLimit),
  };
}
