import type { CommandDefinition } from "./commands";

/** Library ordering: favorites-first alphabetical, or usage-first. */
export type CommandSort = "default" | "used";

/**
 * Sorts a command list for the library tab (0.11.0).
 *
 * `default` keeps the historical ordering (favorites first, then name).
 * `used` puts the most-run commands first, falling back to the default order
 * for ties so the list is stable between renders and reloads.
 *
 * Pure and client-safe; the surface and the tests share it.
 */
export function sortCommands(commands: CommandDefinition[], sort: CommandSort): CommandDefinition[] {
  const byDefault = (a: CommandDefinition, b: CommandDefinition) =>
    Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name);
  return [...commands].sort((a, b) => {
    if (sort === "used") {
      const byUsage = b.useCount - a.useCount;
      if (byUsage !== 0) return byUsage;
    }
    return byDefault(a, b);
  });
}

/**
 * The "most used" summary: commands that have actually run, highest `useCount`
 * first, capped at `limit`. Commands with zero runs are excluded — an empty
 * summary is better than a list of zeros.
 */
export function mostUsedCommands(commands: CommandDefinition[], limit = 3): CommandDefinition[] {
  return [...commands]
    .filter((command) => command.useCount > 0)
    .sort(
      (a, b) => b.useCount - a.useCount || Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name),
    )
    .slice(0, Math.max(0, limit));
}
