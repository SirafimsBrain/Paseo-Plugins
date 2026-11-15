import * as fs from "node:fs";
import * as path from "node:path";
import { readAgentRecordLocation } from "./agent-record";
import { normalizeProjectKey } from "./project-seed";
import { paseoHome } from "./store";

/**
 * The project key a *session* writes to (0.52.3).
 *
 * The store scopes every row by `projectKey` (ADR-2) and the panel/dashboard
 * address a project by the workspace's `projectRootPath`. Until 0.52.3 that
 * value existed only in the plugin host: the agent-facing tools asked for
 * `projectKey` and an agent had to reproduce the absolute path itself. An
 * agent that wrote `"centurion"` instead of `/DISK1/projects/centurion`
 * created a second, invisible tree — the writes succeeded, the dashboard
 * showed an empty board, and the agent reported "the plan is created"
 * (observed on a real workspace: an entire plan and an approved goal landed
 * under the relative key).
 *
 * The fix is to derive the key where the plugin already knows it and hand it
 * to the writers:
 *
 * - the `agent.open.before` hook reads the agent record and the daemon's
 *   `workspaces.json` (both plain files, no daemon round trip) and stamps
 *   `LUCK_PLANNER_PROJECT_KEY` onto the session environment;
 * - the MCP server takes it as its default (falling back to its own `cwd`,
 *   which is the agent's workspace, since Paseo spawns it there);
 * - a `projectKey` that is *relative* or otherwise points at the same
 *   directory is **resolved onto** that key instead of starting a new tree,
 *   and the answer says so — a silent rewrite would be as confusing as the
 *   silent second tree was.
 *
 * A genuinely different absolute path is left alone: cross-project work is
 * legitimate when the user asks for it, and the key is the only scope there
 * is.
 */

/** One workspace entry of `$PASEO_HOME/projects/workspaces.json`. */
interface WorkspaceEntry {
  workspaceId?: unknown;
  cwd?: unknown;
  worktreeRoot?: unknown;
  projectRootPath?: unknown;
}

/** `$PASEO_HOME/projects/workspaces.json` — the daemon's workspace registry. */
function workspacesFile(home: string): string {
  return path.join(home, "projects", "workspaces.json");
}

/**
 * The project key of a workspace id, as the daemon records it.
 *
 * `worktreeRoot` wins over `cwd`: for a Paseo-owned worktree the panel keys
 * the project by the worktree root, and a workspace whose `cwd` moved inside
 * the tree must not create a second project. `null` when the registry cannot
 * be read or holds no such workspace — the caller then falls back, never
 * guesses.
 */
export function workspaceProjectKey(
  workspaceId: string | null | undefined,
  home: string = paseoHome(),
): string | null {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    return null;
  }
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(workspacesFile(home), "utf-8"));
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as WorkspaceEntry;
    if (candidate.workspaceId !== workspaceId) continue;
    for (const raw of [candidate.worktreeRoot, candidate.projectRootPath, candidate.cwd]) {
      if (typeof raw !== "string") continue;
      const key = normalizeProjectKey(raw);
      if (key !== null) return key;
    }
    return null;
  }
  return null;
}

/**
 * The canonical project key of one agent's workspace.
 *
 * Best effort by design, like `agent-record.ts`: a missing or unreadable
 * record answers `null` and the caller keeps the old behaviour (the agent
 * passes `projectKey` itself), so this can never break a session open.
 */
export function agentWorkspaceKey(
  agentId: string,
  home: string = paseoHome(),
): string | null {
  const location = readAgentRecordLocation(agentId, path.join(home, "agents"));
  const fromWorkspace =
    location.workspaceId === null
      ? null
      : workspaceProjectKey(location.workspaceId, home);
  if (fromWorkspace !== null) return fromWorkspace;
  // The record's own `cwd` is the last honest source: for a local checkout it
  // *is* the project root.
  return normalizeProjectKey(location.cwd);
}

/** A resolved key, plus the sentence the caller should show when it moved. */
export interface ResolvedProjectKey {
  projectKey: string;
  note: string | null;
}

/** Same directory, ignoring a trailing separator and `.`/`..` segments. */
function samePath(left: string, right: string): boolean {
  try {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
  } catch {
    return left === right;
  }
}

/** `key` is the tail of `full` (`centurion` vs `/DISK1/projects/centurion`). */
function isTailOf(key: string, full: string): boolean {
  const keyParts = key.split(/[\\/]+/).filter((part) => part.length > 0);
  const fullParts = full.split(/[\\/]+/).filter((part) => part.length > 0);
  if (keyParts.length === 0 || keyParts.length > fullParts.length) return false;
  const offset = fullParts.length - keyParts.length;
  return keyParts.every((part, index) => part === fullParts[offset + index]);
}

/**
 * Resolve the `projectKey` of one tool call against the session's workspace
 * key.
 *
 * - no key given → the session key;
 * - the same directory spelled differently (trailing slash, `..`, relative
 *   path, or a bare tail such as `centurion`) → the session key, **with a
 *   note** so the caller can see the correction;
 * - a different absolute path → left alone (an explicit cross-project call);
 * - no key given and **no** session key → returned as-is, which the tool's own
 *   validation then refuses with its usual `projectKey` message: with nothing
 *   to resolve onto, the old contract is the honest one.
 */
export function resolveProjectKey(
  requested: unknown,
  defaultKey?: string | null,
): ResolvedProjectKey {
  const fallback = normalizeProjectKey(defaultKey ?? null);
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (raw.length === 0) {
    return {
      projectKey: fallback ?? "",
      note: null,
    };
  }
  const given = normalizeProjectKey(raw) ?? raw;
  if (fallback === null || given === fallback) {
    return { projectKey: given, note: null };
  }
  const note = (why: string): ResolvedProjectKey => ({
    projectKey: fallback,
    note:
      `projectKey '${raw}' ${why} this session's workspace key ` +
      `'${fallback}'; the call was scoped there.`,
  });
  if (samePath(given, fallback)) return note("names the same directory as");
  if (!path.isAbsolute(given) && isTailOf(given, fallback)) {
    return note("is a relative tail of");
  }
  return { projectKey: given, note: null };
}
