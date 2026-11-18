import * as path from "node:path";
import { SNAPSHOT_REASONS, type SnapshotReason } from "./model";

/**
 * Revision snapshots.
 *
 * A snapshot is the state of a plan file **before** a write, stored next to it
 * in `__history/` as `<slug>.v<version>.r<revision>.md`. It is written first and
 * the live file second, so a crash leaves the old state recoverable; nothing
 * ever edits or deletes a snapshot — restoring writes a new revision of the live
 * file (`plan_restore`, stage 6).
 *
 * The name carries the counters, and the frontmatter repeats them, so a file
 * found outside its folder still says what it is. Relation fields (`parent`,
 * `children`, `influences`, `blocked_by`, `blocks`, `goal`, `materialized`) are
 * dropped on purpose: they point at live documents and would make the snapshot
 * a second, stale copy of the graph.
 */

export const HISTORY_DIR = "__history";

/** Fields a snapshot keeps, in the order it writes them. */
const SNAPSHOT_CONTENT_KEYS = [
  "name",
  "description",
  "brief",
  "payload",
  "plan",
  "growth",
  "severity",
  "formal_text",
  "archived",
  "created",
  "updated",
  "created_by",
  "updated_by",
  "aliases",
  "tags",
] as const;

export interface SnapshotName {
  slug: string;
  version: number;
  revision: number;
}

/** `<slug>.v<version>.r<revision>.md`. */
export function snapshotFileName(slug: string, version: number, revision: number): string {
  const base = slug.replace(/\.md$/i, "");
  return `${base}.v${version}.r${revision}.md`;
}

/** Reads the counters back out of a snapshot file name; `null` when it is not one. */
export function parseSnapshotFileName(fileName: string): SnapshotName | null {
  const match = /^(.+)\.v(\d+)\.r(\d+)\.md$/i.exec(path.posix.basename(fileName));
  if (!match) return null;
  const version = Number.parseInt(match[2], 10);
  const revision = Number.parseInt(match[3], 10);
  if (!Number.isInteger(version) || !Number.isInteger(revision)) return null;
  if (version < 1 || revision < 1) return null;
  return { slug: match[1], version, revision };
}

/** True when a vault-relative path is a snapshot name (regardless of its folder). */
export function isSnapshotFileName(fileName: string): boolean {
  return parseSnapshotFileName(fileName) !== null;
}

/** `a/b/node.md` → `a/b/__history`; the folder the snapshot lives in. */
export function historyDirFor(noteVaultPath: string): string {
  return path.posix.join(path.posix.dirname(noteVaultPath), HISTORY_DIR);
}

/** `a/b/node.md` + `v1 r4` → `a/b/__history/node.v1.r4.md`. */
export function snapshotPathFor(
  noteVaultPath: string,
  version: number,
  revision: number,
): string {
  const slug = path.posix.basename(noteVaultPath).replace(/\.md$/i, "");
  return path.posix.join(historyDirFor(noteVaultPath), snapshotFileName(slug, version, revision));
}

export interface SnapshotInput {
  /** Vault-relative path of the live file the snapshot belongs to. */
  of: string;
  reason: SnapshotReason;
  /** Version/revision of the state being captured, not of the file after the write. */
  version: number;
  revision: number;
  /** Journal operation id of the write that took the snapshot. */
  op?: string;
  /** ISO-8601 timestamp; defaults to the live file's `updated`. */
  at?: string;
}

export type SnapshotResult =
  | { frontmatter: Record<string, unknown>; path: string }
  | { error: string };

/**
 * Builds the snapshot frontmatter and its path from a live document's
 * frontmatter. Refuses anything it cannot describe exactly: an unknown reason,
 * a missing `of`, or counters that are not positive integers.
 */
export function buildSnapshot(
  frontmatter: Record<string, unknown>,
  input: SnapshotInput,
): SnapshotResult {
  const of = input.of.trim();
  if (of.length === 0 || !/\.md$/i.test(of)) {
    return { error: "A snapshot needs the vault path of the live file it copies." };
  }
  if (!SNAPSHOT_REASONS.includes(input.reason)) {
    return {
      error:
        `'${String(input.reason)}' is not a snapshot reason. Use one of ` +
        `${SNAPSHOT_REASONS.join(", ")}.`,
    };
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    return { error: "Snapshot version must be a positive integer." };
  }
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    return { error: "Snapshot revision must be a positive integer." };
  }

  const snapshot: Record<string, unknown> = {};
  if ("id" in frontmatter) snapshot.id = frontmatter.id;
  if ("schema" in frontmatter) snapshot.schema = frontmatter.schema;
  if ("kind" in frontmatter) snapshot.kind = frontmatter.kind;
  snapshot.is_snapshot = true;
  snapshot.snapshot_of = of;
  snapshot.snapshot_reason = input.reason;
  if (input.op && input.op.trim().length > 0) snapshot.snapshot_op = input.op.trim();
  snapshot.version = input.version;
  snapshot.revision = input.revision;
  if ("status" in frontmatter) snapshot.status = frontmatter.status;
  for (const key of SNAPSHOT_CONTENT_KEYS) {
    if (key === "updated" && input.at) continue;
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      snapshot[key] = frontmatter[key];
    }
  }
  if (input.at && input.at.trim().length > 0) snapshot.updated = input.at.trim();

  return {
    frontmatter: snapshot,
    path: snapshotPathFor(of, input.version, input.revision),
  };
}

/** True when the frontmatter marks this document as a stored snapshot. */
export function isSnapshotFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.is_snapshot === true;
}
