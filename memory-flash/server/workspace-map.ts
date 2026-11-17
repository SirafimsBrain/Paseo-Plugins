import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { paseoHome } from "./store";

/**
 * Workspace identity for the default `project` (0.13.5).
 *
 * Paseo 0.16.0 puts `PASEO_WORKSPACE_ID` in every agent's environment. The id
 * is stable across worktrees, renames and folder moves, which is exactly what
 * the cwd-derived project name is not — but a UUID is unreadable in the memory
 * list. The plugin therefore writes a small id → name map next to the database
 * (it has the Paseo API; the standalone MCP server does not) and the MCP
 * server reads it.
 *
 * Everything here is best effort: a missing or stale map only means the
 * default falls back to the folder name, never that a write fails.
 */

/** Id → workspace name, written by the plugin and read by the MCP server. */
export function workspaceMapPath(): string {
  return path.join(paseoHome(), "plugins", "memory-flash", "workspaces.json");
}

/** Replaces the map atomically; a failed write leaves the previous one intact. */
export function saveWorkspaceNameMap(
  entries: ReadonlyArray<{ id: string; name: string | null; directory: string | null }>,
): void {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    const name = (entry.name ?? "").trim() || basename(entry.directory);
    if (entry.id && name) map[entry.id] = name;
  }
  const target = workspaceMapPath();
  const staging = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(staging, `${JSON.stringify(map, null, 2)}\n`, "utf8");
    renameSync(staging, target);
  } catch {
    try {
      unlinkSync(staging);
    } catch {
      // Nothing to clean up.
    }
  }
}

/** Reads the id → name map; empty when it is missing or unreadable. */
export function readWorkspaceNameMap(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(workspaceMapPath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const map: Record<string, string> = {};
    for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof name === "string" && name.trim().length > 0) map[id] = name.trim();
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * The project an agent's memories should be filed under when it names none.
 *
 * 1. `MEMORY_FLASH_PROJECT` — an explicit override (tests, unusual setups).
 * 2. The workspace name behind `PASEO_WORKSPACE_ID` — stable across worktrees
 *    and renames, which is the duplicate-project fix.
 * 3. The current directory's name — the old behaviour, kept as a fallback for
 *    agents launched outside a Paseo workspace (Cline, a terminal, CI).
 */
export function defaultProject(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const explicit = env.MEMORY_FLASH_PROJECT?.trim();
  if (explicit) return explicit;

  const workspaceId = env.PASEO_WORKSPACE_ID?.trim();
  if (workspaceId) {
    const name = readWorkspaceNameMap()[workspaceId];
    if (name) return name;
    // The map is refreshed by the plugin at start; if it is not there yet, a
    // short id keeps agents in the same workspace grouped instead of guessing.
    return `workspace-${workspaceId.slice(0, 8)}`;
  }

  return basename(cwd);
}

function basename(directory: string | null): string | null {
  if (!directory) return null;
  const name = path.basename(directory);
  return name && name !== path.sep ? name : null;
}
