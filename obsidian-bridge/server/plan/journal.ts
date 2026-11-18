import * as fs from "node:fs";
import * as path from "node:path";
import type { PlanRoot } from "./paths";

/**
 * The project journal: one append-only line per mutation.
 *
 * It is the human-readable answer to "what happened here", and the file
 * `plan_history` complements with snapshots. Append-only matters: nothing in
 * the plugin edits or deletes a line, so two agents cannot overwrite each
 * other's record, and a failed multi-file operation (stage 6) can be traced
 * from its `op:start` marker to the missing `op:done`.
 *
 * Line format:
 * `2026-11-18T10:40:00Z · plan_update_node · [[…|session-store]] · v1 r4 → r5 · actor: codex · status: ready → in_progress`
 */

export interface JournalEntry {
  /** ISO-8601 UTC timestamp. */
  at: string;
  /** Tool name, or `op:start <uuid>` / `op:done <uuid>`. */
  op: string;
  /** Wikilink of the affected node, when there is one. */
  target?: string;
  /** What changed, e.g. `v1 r4 → r5`. */
  result?: string;
  actor?: string;
  /** Status transition, when the operation changed one. */
  status?: string;
  /** Why an override happened. */
  reason?: string;
}

export function formatJournalLine(entry: JournalEntry): string {
  const parts = [entry.at.trim(), entry.op.trim()];
  if (entry.target && entry.target.trim().length > 0) parts.push(entry.target.trim());
  if (entry.result && entry.result.trim().length > 0) parts.push(entry.result.trim());
  if (entry.actor && entry.actor.trim().length > 0) parts.push(`actor: ${entry.actor.trim()}`);
  if (entry.status && entry.status.trim().length > 0) parts.push(`status: ${entry.status.trim()}`);
  if (entry.reason && entry.reason.trim().length > 0) parts.push(`reason: ${entry.reason.trim()}`);
  return parts.join(" · ");
}

/**
 * `<planRoot>/<project>/_journal.md`; a project-less change (a file directly
 * under the root) goes to `<planRoot>/_journal.md`.
 */
export function journalPathFor(root: PlanRoot, project: string | null): string {
  return project
    ? `${root.relPath}/${project}/_journal.md`
    : `${root.relPath}/_journal.md`;
}

export function appendJournal(
  root: PlanRoot,
  project: string | null,
  entry: JournalEntry,
): { path: string } | { error: string } {
  const relPath = journalPathFor(root, project);
  const absolute = path.join(root.vaultRoot, relPath);
  const line = `${formatJournalLine(entry)}\n`;
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (!fs.existsSync(absolute)) {
      fs.writeFileSync(absolute, `# Journal\n\n${line}`, { encoding: "utf-8", flag: "wx" });
      return { path: relPath };
    }
    fs.appendFileSync(absolute, line, "utf-8");
    return { path: relPath };
  } catch (cause) {
    return {
      error: `The change was applied but the journal could not be appended: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
}
