/**
 * Database restore (PLAN.md stage L4, `__doc.md` §6).
 *
 * The counterpart of the L3 snapshot: take a `.db.zip` (or a `.db` the user
 * extracted by hand), prove it is a database this plugin can open, and swap it
 * into place under the running daemon.
 *
 * Three rules shape this module:
 *
 * 1. **The file the user picked is never moved or modified.** It is copied to a
 *    temporary file next to the target, and *that* copy is what gets renamed
 *    into place. A restore that consumes its own source is a restore nobody
 *    dares to try twice.
 * 2. **Verify before the swap, roll back after it.** The copy goes through the
 *    same `inspectSnapshot` gate as a fresh snapshot (integrity, tables,
 *    schema version) and is then opened by a real `LuckPlannerStore`; if that
 *    open fails, the previous file is put back and reopened, so the plugin ends
 *    up where it started instead of with no database at all.
 * 3. **The old database is never deleted without a copy.** The caller takes an
 *    automatic snapshot first (`pre-restore` label) and this module keeps the
 *    previous file beside the database until the new one has opened, then
 *    removes it.
 *
 * The `-wal`/`-shm` siblings are deleted with the swap: a write-ahead log
 * belongs to the database file it was written for, and letting an old log
 * attach itself to a restored file is how a "restore" silently resurrects the
 * state it was meant to remove.
 *
 * **Other processes.** Agent MCP servers hold their own connections to the
 * same file (ADR-2). Replacing the file under them leaves those handles on the
 * previous inode, so the daemon asks the user to reload the plugin / refresh
 * agent sessions after a restore; this module can only close its own handle.
 */

import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { exportStamp } from "../shared/export";
import {
  SNAPSHOT_ENTRY_EXTENSION,
  inspectSnapshot,
  type SnapshotCounts,
} from "./snapshot";
import { SCHEMA_VERSION } from "./store";

/** A restore source that passed every check and is ready to be swapped in. */
export interface RestoreSource {
  /** Temporary database file beside the target; consumed by the swap. */
  readonly database: string;
  /** Schema version the copy reports. */
  readonly schemaVersion: number;
  readonly counts: SnapshotCounts;
  /** Where the user's file came from (for the log line). */
  readonly origin: string;
  /** Removes the temporary file; safe to call after a swap (no-op then). */
  readonly cleanup: () => void;
}

/**
 * Reads and verifies a snapshot, leaving a ready-to-swap copy next to
 * `dbPath`'s directory.
 *
 * Accepts the `.db.zip` the plugin writes and a bare `.db` — the second one
 * matters because the whole point of a zip is that a user can open it, and
 * "I extracted it, now restore it" is the obvious next step.
 */
export function readRestoreSource(file: string, dbPath: string): RestoreSource {
  if (!path.isAbsolute(file)) {
    throw new Error(`restore path must be absolute: ${file}`);
  }
  if (!existsSync(file)) {
    throw new Error(`no such file: ${file}`);
  }

  const directory = path.dirname(dbPath);
  const temporary = path.join(
    directory,
    `.restore-${process.pid}-${randomUUID().slice(0, 8)}${SNAPSHOT_ENTRY_EXTENSION}`,
  );
  const cleanup = (): void => {
    for (const leftover of [temporary, `${temporary}-wal`, `${temporary}-shm`]) {
      if (existsSync(leftover)) rmSync(leftover, { force: true });
    }
  };

  try {
    if (file.endsWith(".zip")) {
      const entries = unzipSync(readFileSync(file));
      const names = Object.keys(entries);
      const databases = names.filter((name) => name.endsWith(SNAPSHOT_ENTRY_EXTENSION));
      if (databases.length !== 1) {
        throw new Error(
          `archive ${path.basename(file)} must hold exactly one database entry, ` +
            `found ${databases.length} of ${names.length}`,
        );
      }
      writeFileSync(temporary, entries[databases[0]]);
    } else {
      copyFileSync(file, temporary);
    }

    const { schemaVersion, counts } = inspectSnapshot(temporary);
    if (schemaVersion > SCHEMA_VERSION) {
      // The store would refuse this at open too, but by then the swap has
      // happened; say which side is behind while the old database is intact.
      throw new Error(
        `snapshot schema version ${schemaVersion} is newer than the supported ` +
          `${SCHEMA_VERSION} — update the plugin before restoring this file`,
      );
    }
    return { database: temporary, schemaVersion, counts, origin: file, cleanup };
  } catch (cause) {
    cleanup();
    throw cause;
  }
}

/**
 * Swaps `source.database` into `dbPath` and opens it through `reopen`.
 *
 * `reopen` must construct the store for `dbPath` (the caller owns the store
 * lifecycle); it is called once for the restored file and, on failure, once
 * more after the previous file has been put back. A failed reopen therefore
 * leaves a working plugin on the old data and a readable error.
 */
export function replaceDatabase(
  dbPath: string,
  source: Pick<RestoreSource, "database">,
  reopen: () => void,
  at: number = Date.now(),
): void {
  const previous = `${dbPath}.before-restore-${exportStamp(at)}-${randomUUID().slice(0, 6)}`;
  renameSync(dbPath, previous);
  // A log of the *previous* database must never follow the restored file.
  for (const suffix of ["-wal", "-shm"]) {
    const leftover = `${dbPath}${suffix}`;
    if (existsSync(leftover)) rmSync(leftover, { force: true });
  }
  renameSync(source.database, dbPath);

  try {
    reopen();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    rmSync(dbPath, { force: true });
    renameSync(previous, dbPath);
    try {
      reopen();
    } catch (reopenCause) {
      // Both files are broken: keep both, say so loudly, and leave the daemon
      // to the operator instead of deleting evidence.
      throw new Error(
        `restored database failed to open (${message}) and the previous one ` +
          `could not be reopened either (${reopenCause instanceof Error ? reopenCause.message : String(reopenCause)}); ` +
          `the old file is at ${previous}`,
      );
    }
    throw new Error(`restored database failed to open, previous data kept: ${message}`);
  }

  // The previous file existed only until the restored one proved it opens;
  // the automatic `pre-restore` snapshot is what the user keeps.
  rmSync(previous, { force: true });
}
