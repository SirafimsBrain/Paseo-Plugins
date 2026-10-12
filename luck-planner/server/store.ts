import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DatabaseSync,
  type DatabaseSyncOptions,
} from "node:sqlite";

/**
 * SQLite store for the planning tree (PLAN.md stage B2, `__doc.md` §5).
 *
 * Concurrency model (ADR-2): one database file per machine, shared by the
 * plugin process, agent MCP servers and the dashboard HTTP server. WAL
 * allows many readers but one writer at a time, so every write runs
 * behind {@link LuckPlannerStore.write} — a busy timeout waits out
 * ordinary contention and a retry covers the remaining collision window
 * (the measured memory-flash 0.3.2 lesson: with neither, parallel agent
 * workers lose writes to "database is locked").
 *
 * CRUD and the state machine arrive in stage B3 on top of this layer;
 * this file owns the schema, the migrations and the write fence only.
 */

/**
 * How long a statement waits for a competing writer. WAL allows many
 * readers but still only one writer at a time, and every agent process
 * shares this file, so a zero busy timeout turns ordinary write
 * contention into a lost write.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** Write attempts before "database is locked" surfaces to the caller. */
const WRITE_ATTEMPTS = 3;
/** Backoff before the first write retry; doubles per attempt. */
const WRITE_RETRY_DELAY_MS = 25;

/** Current schema version; bumped by appending a migration. */
export const SCHEMA_VERSION = 1;

/**
 * Resolves the default database location: `$PASEO_HOME/plugins/
 * luck-planner/luck-planner.db`, falling back to `~/.paseo` (the same
 * convention memory-flash and bunny-search use for plugin data).
 */
export function defaultDbPath(): string {
  const home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
  return path.join(home, "plugins", "luck-planner", "luck-planner.db");
}

export interface StoreOptions {
  /** Explicit database file; defaults to {@link defaultDbPath}. */
  dbPath?: string;
  /**
   * Busy timeout override. Production callers leave this unset (5 s);
   * tests shorten it to exercise the lock path quickly.
   */
  busyTimeoutMs?: number;
}

/**
 * Schema v1 (`__doc.md` §5). Referential integrity is documented in the
 * DDL but enforced in code (SQLite foreign keys default to off, the same
 * choice memory-flash makes) so deletes stay explicit and simple.
 */
function createSchemaV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id           TEXT PRIMARY KEY,
      project_key  TEXT NOT NULL,
      parent_id    TEXT REFERENCES nodes(id),
      kind         TEXT NOT NULL CHECK (kind IN ('root','trunk','branch','subbranch','leaf')),
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'draft',
      version      TEXT NOT NULL DEFAULT '',
      revision     INTEGER NOT NULL DEFAULT 1,
      payload      TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      created_by   TEXT,
      updated_by   TEXT,
      archived_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS nodes_project_parent ON nodes(project_key, parent_id);

    CREATE TABLE IF NOT EXISTS bees (
      id             TEXT PRIMARY KEY,
      project_key    TEXT NOT NULL,
      source_leaf_id TEXT NOT NULL REFERENCES nodes(id),
      target_leaf_id TEXT NOT NULL REFERENCES nodes(id),
      status         TEXT NOT NULL,
      revision       INTEGER NOT NULL DEFAULT 1,
      impact         TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      created_by     TEXT,
      updated_by     TEXT
    );
    CREATE INDEX IF NOT EXISTS bees_source ON bees(source_leaf_id);
    CREATE INDEX IF NOT EXISTS bees_target ON bees(target_leaf_id);

    CREATE TABLE IF NOT EXISTS bugs (
      id          TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      severity    TEXT NOT NULL,
      status      TEXT NOT NULL,
      revision    INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      created_by  TEXT,
      updated_by  TEXT
    );
    CREATE TABLE IF NOT EXISTS bug_nodes (
      bug_id  TEXT NOT NULL REFERENCES bugs(id),
      node_id TEXT NOT NULL REFERENCES nodes(id),
      PRIMARY KEY (bug_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS bug_nodes_node ON bug_nodes(node_id);

    CREATE TABLE IF NOT EXISTS goals (
      id                   TEXT PRIMARY KEY,
      project_key          TEXT NOT NULL,
      formal_text          TEXT NOT NULL,
      plan_json            TEXT NOT NULL,
      status               TEXT NOT NULL,
      revision             INTEGER NOT NULL DEFAULT 1,
      materialized_node_id TEXT REFERENCES nodes(id),
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      created_by           TEXT,
      updated_by           TEXT
    );

    CREATE TABLE IF NOT EXISTS growth (
      id           TEXT PRIMARY KEY,
      project_key  TEXT NOT NULL,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('node','goal')),
      subject_id   TEXT NOT NULL,
      steps_json   TEXT NOT NULL,
      status       TEXT NOT NULL,
      revision     INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      created_by   TEXT,
      updated_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS growth_subject ON growth(subject_type, subject_id);

    CREATE TABLE IF NOT EXISTS history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key  TEXT NOT NULL,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      action       TEXT NOT NULL,
      revision     INTEGER NOT NULL,
      actor        TEXT,
      result       TEXT NOT NULL DEFAULT '',
      at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_entity ON history(entity_type, entity_id);

    -- FTS5 external-content index over the searchable node text. Nodes keep
    -- a TEXT id, so the implicit rowid is the index anchor; triggers keep
    -- the index in sync with plain UPDATE/DELETE too.
    CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
      name, description, payload, content='nodes', content_rowid='rowid',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS node_fts_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO node_fts(rowid, name, description, payload)
      VALUES (new.rowid, new.name, new.description, new.payload);
    END;
    CREATE TRIGGER IF NOT EXISTS node_fts_delete AFTER DELETE ON nodes BEGIN
      INSERT INTO node_fts(node_fts, rowid, name, description, payload)
      VALUES ('delete', old.rowid, old.name, old.description, old.payload);
    END;
    CREATE TRIGGER IF NOT EXISTS node_fts_update
    AFTER UPDATE OF name, description, payload ON nodes BEGIN
      INSERT INTO node_fts(node_fts, rowid, name, description, payload)
      VALUES ('delete', old.rowid, old.name, old.description, old.payload);
      INSERT INTO node_fts(rowid, name, description, payload)
      VALUES (new.rowid, new.name, new.description, new.payload);
    END;
  `);
}

/**
 * Sequential migrations, indexed by the version they migrate *from*:
 * `MIGRATIONS[0]` upgrades a v0 database to v1. A fresh database runs
 * every migration in order, so one code path covers both cases and an
 * old file can never silently skip a step.
 */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [createSchemaV1];

/** node:sqlite throws a plain Error carrying "database is locked". */
function isLockError(cause: unknown): boolean {
  return cause instanceof Error && /database is locked/i.test(cause.message);
}

/** Synchronous sleep — the store is synchronous end to end. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class LuckPlannerStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly busyTimeoutMs: number;
  private closed = false;

  constructor(options: StoreOptions = {}) {
    this.dbPath = options.dbPath ?? defaultDbPath();
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    // The driver-level timeout and the PRAGMA both matter: the option is
    // applied at open, the PRAGMA covers every later statement.
    const openOptions: DatabaseSyncOptions = { timeout: this.busyTimeoutMs };
    this.db = new DatabaseSync(this.dbPath, openOptions);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
    this.migrate();
  }

  // -------------------------------------------------------------------------
  // Schema and migrations
  // -------------------------------------------------------------------------

  private migrate(): void {
    // `meta` exists before version bookkeeping; the migrations below create
    // the remaining tables with IF NOT EXISTS, so this is safe to repeat.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    let version = row ? Number.parseInt(row.value, 10) : 0;
    if (!Number.isInteger(version) || version < 0) version = 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `luck-planner database schema version ${version} is newer than the supported ${SCHEMA_VERSION}; upgrade the plugin.`,
      );
    }
    while (version < SCHEMA_VERSION) {
      MIGRATIONS[version](this.db);
      version += 1;
      if (row) {
        this.db
          .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
          .run(String(version));
      } else {
        this.db
          .prepare(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
          )
          .run(String(version));
      }
    }
  }

  /** The schema version the open database reports. */
  get schemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row ? Number.parseInt(row.value, 10) : 0;
  }

  // -------------------------------------------------------------------------
  // Concurrency: several agent processes write the same WAL database
  // -------------------------------------------------------------------------

  /**
   * Runs a write operation behind the lock-contention fence: the busy
   * timeout (5 s by default) waits out ordinary contention, and a
   * transient "database is locked" is retried with exponential backoff
   * before it surfaces as a readable error. **Every mutation of the
   * store must go through this method** — a write that bypasses it is
   * how parallel agent workers lose data.
   */
  write<T>(operation: () => T): T {
    let attempt = 0;
    for (;;) {
      try {
        return operation();
      } catch (cause) {
        attempt += 1;
        if (attempt >= WRITE_ATTEMPTS || !isLockError(cause)) throw cause;
        sleepSync(WRITE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Idempotent: plugin cleanup can run more than once (disable, reload,
   * removal), and a second close must not throw.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
