/**
 * Whole-database snapshot (PLAN.md stage L3, `__doc.md` §6).
 *
 * Stage L2 exports *one project* as a document; this exports the
 * *installation* — every project, every table, in the format the store itself
 * reads. Two different promises, two different files:
 *
 * - the export is portable and semantic (ids remapped on import, versioned
 *   envelope, readable with `unzip` + `jq`), written by a plugin that knows
 *   the tree;
 * - the snapshot is a byte-level copy of SQLite's own state, the thing you
 *   put back when the tree or the schema is the problem.
 *
 * **Why `VACUUM INTO` and not a file copy.** The database runs in WAL mode
 * (ADR-2) and several processes write it: `cp luck-planner.db` misses the
 * `-wal` frame that was just committed and can capture a torn page. `VACUUM
 * INTO` reads one consistent snapshot and writes a fresh, defragmented file —
 * a valid database without a `-wal`, which is exactly what a restore wants.
 *
 * **Why a zip.** The customer is a folder the user opens by hand; one file per
 * backup, compressible, and it is the same container the project export
 * already uses (`fflate`), so the plugin gains no new dependency. The
 * uncompressed `.db` stays a temporary file inside the same directory and is
 * removed in a `finally`: a failed zip must not leave half a backup around.
 *
 * **What is verified before the file is written.** The copy is reopened
 * read-only, `PRAGMA integrity_check` must answer `ok`, and the row counts are
 * read from the *copy* — a snapshot that says `nodes: 412` is evidence, while
 * a snapshot that says "saved" is a hope. Stage L4 (restore) relies on that
 * check: it refuses to swap a database whose `integrity_check` fails.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zipSync } from "fflate";
import { exportStamp } from "../shared/export";
import { defaultBackupDir, freeName } from "./export";
import type { LuckPlannerStore } from "./store";

/** Suffix of a written snapshot: the database is the payload, the zip the box. */
export const SNAPSHOT_FILE_EXTENSION = ".db.zip";
/** Suffix of the database *inside* the archive. */
export const SNAPSHOT_ENTRY_EXTENSION = ".db";
/** Prefix every snapshot file shares (the same as the project exports). */
export const SNAPSHOT_PREFIX = "luck-planner";

/** Main tables of the schema, in the order a person reads them. */
const COUNTED_TABLES = [
  "nodes",
  "bees",
  "bugs",
  "bug_nodes",
  "goals",
  "growth",
  "history",
] as const;

/** Rows the snapshot holds — proof of content, not just of size. */
export interface SnapshotCounts {
  /** Distinct `project_key`s in `nodes`. */
  readonly projects: number;
  readonly nodes: number;
  /** Soft-deleted nodes travel in a snapshot like everything else. */
  readonly archivedNodes: number;
  readonly bees: number;
  readonly bugs: number;
  readonly bugAttachments: number;
  readonly goals: number;
  readonly growth: number;
  readonly history: number;
}

/** Where a snapshot should go; both fields are optional. */
export interface SnapshotRequest {
  /** Directory for the generated name; defaults to `backups/` beside the DB. */
  readonly dir?: string;
  /**
   * Epoch milliseconds that names the file and pins the zip entry's mtime.
   * Defaults to now; tests pass a fixed value so names and bytes are stable.
   */
  readonly at?: number;
}

/** What the settings screen (and the log) gets back. */
export interface SnapshotResult {
  /** Absolute path of the written archive. */
  readonly file: string;
  /** Size of the archive on disk. */
  readonly bytes: number;
  /** Size of the database inside it — the honest measure of the backup. */
  readonly dbBytes: number;
  /** Schema version recorded in the copy's `meta` table. */
  readonly schemaVersion: number;
  readonly counts: SnapshotCounts;
  /** Epoch milliseconds of the snapshot (the `at` it was taken with). */
  readonly at: number;
}

/**
 * `luck-planner-YYYYMMDD-HHmmss.db.zip`.
 *
 * No project slug: a snapshot covers the whole installation, and a name that
 * named a project would suggest it could be restored into one.
 */
export function snapshotFileName(at: number): string {
  return `${SNAPSHOT_PREFIX}-${exportStamp(at)}${SNAPSHOT_FILE_EXTENSION}`;
}

/** Name of the database entry inside the archive (`…-20261104-132055.db`). */
export function snapshotEntryName(fileName: string): string {
  const stem = fileName.endsWith(".zip")
    ? fileName.slice(0, -".zip".length)
    : fileName;
  return `${stem}${SNAPSHOT_ENTRY_EXTENSION}`;
}

/**
 * Takes a snapshot of the whole database and writes it as one `.db.zip`.
 *
 * Order matters: vacuum into a temporary file, verify the copy, zip the
 * verified bytes, and only then write the archive — so the file that appears
 * in `backups/` is never a half-written or unverified database. The temporary
 * file (and any `-wal`/`-shm` the driver may have created next to it) is
 * removed even when the zip or the write fails.
 */
export function snapshotDatabase(
  store: LuckPlannerStore,
  request: SnapshotRequest = {},
): SnapshotResult {
  const at = request.at ?? Date.now();
  const dir = request.dir ?? defaultBackupDir(store.dbPath);
  if (!path.isAbsolute(dir)) {
    // The daemon's working directory is not the user's; a relative `backups`
    // would scatter snapshots into whatever directory the shell happened to be in.
    throw new Error(`snapshot directory must be absolute: ${dir}`);
  }
  mkdirSync(dir, { recursive: true });

  // `freeName` already answers an absolute path inside `dir`.
  const file = freeName(dir, snapshotFileName(at), SNAPSHOT_FILE_EXTENSION);
  const temporary = path.join(
    dir,
    `.snapshot-${process.pid}-${randomUUID().slice(0, 8)}${SNAPSHOT_ENTRY_EXTENSION}`,
  );

  try {
    store.snapshotInto(temporary);
    const dbBytes = statSync(temporary).size;
    const { schemaVersion, counts } = inspectSnapshot(temporary);
    const entry = snapshotEntryName(path.basename(file));
    // `mtime` pinned to the DOS epoch for the same reason the project export
    // pins it: the container must not carry a second, arbitrary clock.
    const bytes = zipSync(
      { [entry]: [readFileSync(temporary), { mtime: new Date(1980, 0, 1) }] },
      { level: 9 },
    );
    writeFileSync(file, bytes);
    return { file, bytes: bytes.byteLength, dbBytes, schemaVersion, counts, at };
  } finally {
    for (const leftover of [temporary, `${temporary}-wal`, `${temporary}-shm`]) {
      if (existsSync(leftover)) rmSync(leftover, { force: true });
    }
  }
}

/**
 * Opens a snapshot read-only and reads back what it proves.
 *
 * Called on the temporary copy before it is zipped (and available to stage L4
 * for a file the user picked): a database that fails `integrity_check` or has
 * no `meta` table is not a luck-planner snapshot, whatever its name says.
 */
export function inspectSnapshot(file: string): {
  schemaVersion: number;
  counts: SnapshotCounts;
} {
  let copy: DatabaseSync | undefined;
  try {
    copy = new DatabaseSync(file, { readOnly: true });
    const integrity = copy.prepare("PRAGMA integrity_check").get();
    const verdict = integrity ? String(Object.values(integrity)[0]) : "no answer";
    if (verdict !== "ok") {
      throw new Error(`snapshot failed integrity_check: ${verdict}`);
    }
    // A schema the plugin does not know would otherwise surface as a
    // confusing "no such table" from a COUNT; name the real problem instead.
    const hasTable = (table: string): boolean =>
      copy?.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table) !== undefined;
    if (!hasTable("meta")) {
      throw new Error("snapshot has no meta table — not a luck-planner database");
    }
    const versionRow = copy
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!versionRow) {
      throw new Error("snapshot has no meta.schema_version row");
    }
    for (const table of COUNTED_TABLES) {
      if (!hasTable(table)) throw new Error(`snapshot is missing the ${table} table`);
    }
    const schemaVersion = Number.parseInt(versionRow.value, 10);
    const count = (sql: string): number => {
      const row = copy?.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    const counts: SnapshotCounts = {
      projects: count("SELECT COUNT(DISTINCT project_key) AS n FROM nodes"),
      nodes: count("SELECT COUNT(*) AS n FROM nodes"),
      archivedNodes: count(
        "SELECT COUNT(*) AS n FROM nodes WHERE archived_at IS NOT NULL",
      ),
      bees: count("SELECT COUNT(*) AS n FROM bees"),
      bugs: count("SELECT COUNT(*) AS n FROM bugs"),
      bugAttachments: count("SELECT COUNT(*) AS n FROM bug_nodes"),
      goals: count("SELECT COUNT(*) AS n FROM goals"),
      growth: count("SELECT COUNT(*) AS n FROM growth"),
      history: count("SELECT COUNT(*) AS n FROM history"),
    };
    return { schemaVersion, counts };
  } finally {
    copy?.close();
  }
}
