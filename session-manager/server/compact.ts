import { createRequire } from "node:module";
import { resolveBinary, runCli } from "./exec";
import { providerById } from "./providers/registry";
import type { SqliteStore } from "./providers/types";
import { sqliteSize } from "./util";

/**
 * Standard SQLite compaction of a provider's session database.
 *
 * `VACUUM` is the database's own space-reclaiming operation: it rebuilds the
 * file from its live pages, which is what removes the free pages a session
 * delete leaves behind (`opencode.db` reached 710 MB on the machine this was
 * written for while most of it was free pages and WAL frames). It changes no
 * row, so it is safe for agent state — unlike deleting rows by hand, which the
 * plugin never does.
 *
 * The `wal_checkpoint(TRUNCATE)` that follows folds the WAL back into the
 * database and truncates `-wal` to zero, so the size reported afterwards is the
 * real size on disk.
 */

/** VACUUM rewrites the whole file; a multi-hundred-megabyte store needs minutes. */
const COMPACT_TIMEOUT_MS = 600_000;

const COMPACT_SQL = "VACUUM; PRAGMA wal_checkpoint(TRUNCATE);";

/** The tiny slice of `node:sqlite` used here, without depending on its typings. */
interface SqliteModule {
  DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
}

/**
 * `node:sqlite` is the fallback when the `sqlite3` binary is missing. Resolved
 * through `createRequire` so a bundler never tries to follow a builtin it may
 * not know (it arrived in Node 22.5).
 */
function loadNodeSqlite(): SqliteModule | null {
  try {
    return createRequire(process.execPath)("node:sqlite") as SqliteModule;
  } catch {
    return null;
  }
}

export type VacuumResult = { ok: true } | { ok: false; error: string };

/** Compacts one SQLite file with the `sqlite3` CLI, or `node:sqlite` when absent. */
export async function vacuumDatabase(file: string): Promise<VacuumResult> {
  const binary = resolveBinary("sqlite3");
  if (binary) {
    const result = await runCli(binary, [file, COMPACT_SQL], { timeoutMs: COMPACT_TIMEOUT_MS });
    if (result.ok) return { ok: true };
    // The binary exists, so its error is the real answer: a locked database
    // (the agent is writing), a corrupt file, or a full disk.
    return { ok: false, error: result.error ?? "sqlite3 failed" };
  }

  const sqlite = loadNodeSqlite();
  if (!sqlite) {
    return {
      ok: false,
      error: 'No SQLite support on this host: install the "sqlite3" CLI or run a Node with node:sqlite',
    };
  }
  try {
    const database = new sqlite.DatabaseSync(file);
    try {
      database.exec(COMPACT_SQL);
    } finally {
      database.close();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface DatabaseCompactOutcome {
  path: string;
  label: string;
  before: number | null;
  after: number | null;
  freed: number | null;
  error: string | null;
}

export interface CompactOutcome {
  ok: boolean;
  before: number | null;
  after: number | null;
  freed: number | null;
  databases: DatabaseCompactOutcome[];
  error: string | null;
}

function emptyOutcome(error: string | null): CompactOutcome {
  return { ok: false, before: null, after: null, freed: null, databases: [], error };
}

function sum(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

/**
 * Compacts every SQLite database of a provider's session store.
 *
 * Providers whose sessions are plain files (Qwen Code, Kimi Code, acpx) have no
 * `sqliteStores`, and the answer says so instead of failing silently: the panel
 * only offers the button for a `compactable` provider.
 */
export async function compactAgentStores(
  input: { provider: string },
  deps: { vacuum?: (file: string) => Promise<VacuumResult> } = {},
): Promise<CompactOutcome> {
  const adapter = providerById(input.provider);
  if (!adapter) return emptyOutcome(`Unknown provider "${input.provider}"`);

  const stores: SqliteStore[] = adapter.sqliteStores ? adapter.sqliteStores() : [];
  if (stores.length === 0) {
    return emptyOutcome(
      `${adapter.label} keeps its sessions outside SQLite; there is no database to compact`,
    );
  }

  const vacuum = deps.vacuum ?? vacuumDatabase;
  const databases: DatabaseCompactOutcome[] = [];
  let firstError: string | null = null;

  for (const store of stores) {
    const before = sqliteSize(store.path);
    // A database that was never created is not an error: the agent simply has
    // not run on this machine yet.
    if (before === null) continue;

    let failure: string | null = null;
    try {
      const result = await vacuum(store.path);
      if (!result.ok) failure = result.error;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    const after = sqliteSize(store.path);
    if (failure !== null && firstError === null) firstError = `${store.label}: ${failure}`;
    databases.push({
      path: store.path,
      label: store.label,
      before,
      after,
      freed: before !== null && after !== null ? Math.max(before - after, 0) : null,
      error: failure,
    });
  }

  if (databases.length === 0) {
    return emptyOutcome(`${adapter.label} has not written a session database on this host`);
  }

  const before = sum(databases.map((entry) => entry.before));
  const after = sum(databases.map((entry) => entry.after));
  return {
    ok: firstError === null,
    before,
    after,
    freed: before !== null && after !== null ? Math.max(before - after, 0) : null,
    databases,
    error: firstError,
  };
}
