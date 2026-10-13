import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DatabaseSync,
  type DatabaseSyncOptions,
} from "node:sqlite";
import {
  LEAF_STATUSES,
  LEAF_TRANSITIONS,
  NODE_KINDS,
  canHaveChild,
  canTransitionLeaf,
  historyEntrySchema,
  leafStatusSchema,
  nodeKindSchema,
  nodeSchema,
  type HistoryAction,
  type HistoryEntry,
  type LeafStatus,
  type Node,
  type NodeKind,
} from "../shared/tree";

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
 * Stage B3 adds the mutation API on top of this layer: node CRUD with the
 * leaf state machine (shared/tree.ts), a revision bump on every change and
 * the append-only audit row per mutation (ADR-6). Every mutation runs
 * inside {@link LuckPlannerStore.write} and its own transaction.
 *
 * Stage B4 adds read-side search over the `node_fts` index of stage B2:
 * `key=value` filters parsed out of the free text, OR-joined terms ranked
 * by bm25, and a `LIKE` fallback when nothing indexable remains — the
 * memory-flash `parseQuery`/`ftsQuery` approach, adapted to node kinds and
 * leaf statuses.
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

/** `createNode` input. `parentId: null` is valid for a `root` node only. */
export interface CreateNodeInput {
  projectKey: string;
  parentId: string | null;
  kind: NodeKind;
  name: string;
  description?: string;
  /** Initial status (defaults to `draft`); may be any valid leaf status. */
  status?: LeafStatus;
  version?: string;
  payload?: Record<string, unknown>;
  actor: string;
}

/** `updateNode` input: at least one mutable field must be present. */
export interface UpdateNodeInput {
  projectKey: string;
  id: string;
  name?: string;
  description?: string;
  version?: string;
  payload?: Record<string, unknown>;
  actor: string;
}

/** `moveNode` input: the node is re-parented under `newParentId`. */
export interface MoveNodeInput {
  projectKey: string;
  id: string;
  newParentId: string;
  actor: string;
}

/** `archiveNode` input: soft-deletes the node and its whole subtree. */
export interface ArchiveNodeInput {
  projectKey: string;
  id: string;
  actor: string;
}

/** `setStatus` input: leaf nodes only, transitions per shared/tree.ts. */
export interface SetStatusInput {
  projectKey: string;
  id: string;
  status: LeafStatus;
  actor: string;
}

/**
 * `search` options (stage B4). The free text may carry its own
 * `key=value` pairs (`kind=`, `status=`, `project=`); option filters and
 * query filters are merged, and both AND with the text.
 */
export interface SearchOptions {
  /** Hard scope: only nodes of this project are ever returned. */
  projectKey: string;
  /** Restrict to these node kinds (merged with `kind=` in the query). */
  kinds?: NodeKind[];
  /** Restrict to these leaf statuses (merged with `status=` in the query). */
  statuses?: LeafStatus[];
  /** Include soft-deleted (archived) nodes; they are excluded by default. */
  includeArchived?: boolean;
  /** Result cap, clamped to 1..100; defaults to {@link DEFAULT_SEARCH_LIMIT}. */
  limit?: number;
}

/** One search result: the node, its rank and a description preview. */
export interface SearchHit {
  node: Node;
  /**
   * bm25 (lower is better — SQLite returns it negated so `ORDER BY score`
   * sorts best-first). `0` for the LIKE fallback and the filter-only
   * listing, which are unranked.
   */
  score: number;
  /** Description with the matched terms highlighted; `null` when there is none. */
  snippet: string | null;
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

  // -------------------------------------------------------------------------
  // Reads (stage B3)
  // -------------------------------------------------------------------------

  /** Returns the node, or `null` when it is not in this `projectKey`. */
  getNode(projectKey: string, id: string): Node | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  /** Append-only audit trail of one entity, oldest first. */
  listHistory(projectKey: string, entityId: string): HistoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM history WHERE project_key = ? AND entity_id = ? ORDER BY id",
      )
      .all(projectKey, entityId) as unknown as HistoryRow[];
    return rows.map(rowToHistory);
  }

  // -------------------------------------------------------------------------
  // Mutations (stage B3): every one bumps `revision`, appends a history row
  // and runs inside a transaction behind the write fence.
  // -------------------------------------------------------------------------

  /**
   * Runs `operation` in a single immediate transaction: either the node
   * change *and* its audit row land together, or neither does. Called only
   * from inside {@link write}, so a lock error rolls the whole transaction
   * back before the retry.
   */
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // BEGIN itself may have failed; nothing to roll back.
      }
      throw error;
    }
  }

  /** Loads a node row scoped by `project_key` or throws a readable error. */
  private requireRow(projectKey: string, id: string): NodeRow {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as NodeRow | undefined;
    if (!row) throw new Error(`node ${id} not found in project ${projectKey}`);
    return row;
  }

  /** Appends one append-only audit row (mandatory for every mutation). */
  private appendHistory(
    projectKey: string,
    entityId: string,
    action: HistoryAction,
    revision: number,
    actor: string,
    result: string,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO history
           (project_key, entity_type, entity_id, action, revision, actor, result, at)
         VALUES (?, 'node', ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectKey, entityId, action, revision, actor, result, at);
  }

  /** Creates a node; `parentId: null` is accepted for `root` nodes only. */
  createNode(input: CreateNodeInput): Node {
    const kind = parseKind(input.kind);
    const name = requireText(input.name, "node name");
    const status = parseStatus(input.status ?? "draft");
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    return this.write(() =>
      this.transaction(() => {
        let parentId: string | null;
        if (kind === "root") {
          if (input.parentId !== null) {
            throw new Error("a root node must not have a parent");
          }
          parentId = null;
        } else {
          if (input.parentId === null) {
            throw new Error(`a ${kind} node requires a parent`);
          }
          const parent = this.requireRow(projectKey, input.parentId);
          if (parent.archived_at !== null) {
            throw new Error(`parent node ${parent.id} is archived`);
          }
          const parentKind = parseKind(parent.kind);
          if (!canHaveChild(parentKind, kind)) {
            throw new Error(`a ${kind} cannot be a child of a ${parentKind}`);
          }
          parentId = parent.id;
        }

        const id = randomUUID();
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO nodes
               (id, project_key, parent_id, kind, name, description, status,
                version, revision, payload, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            projectKey,
            parentId,
            kind,
            name,
            input.description ?? "",
            status,
            input.version ?? "",
            JSON.stringify(input.payload ?? {}),
            now,
            now,
            actor,
            actor,
          );
        this.appendHistory(
          projectKey,
          id,
          "create",
          1,
          actor,
          `created ${kind} \"${name}\"`,
          now,
        );
        return rowToNode(this.requireRow(projectKey, id));
      }),
    );
  }

  /** Updates name/description/version/payload in place (one revision bump). */
  updateNode(input: UpdateNodeInput): Node {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    const sets: string[] = [];
    const params: Array<string | number> = [];
    const changed: string[] = [];
    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(requireText(input.name, "node name"));
      changed.push("name");
    }
    if (input.description !== undefined) {
      sets.push("description = ?");
      params.push(input.description);
      changed.push("description");
    }
    if (input.version !== undefined) {
      sets.push("version = ?");
      params.push(input.version);
      changed.push("version");
    }
    if (input.payload !== undefined) {
      sets.push("payload = ?");
      params.push(JSON.stringify(input.payload));
      changed.push("payload");
    }
    if (sets.length === 0) {
      throw new Error(
        "updateNode requires at least one of: name, description, version, payload",
      );
    }

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireRow(projectKey, input.id);
        if (row.archived_at !== null) {
          throw new Error(`node ${row.id} is archived and cannot be modified`);
        }
        const now = Date.now();
        sets.push("revision = revision + 1", "updated_at = ?", "updated_by = ?");
        params.push(now, actor, projectKey, row.id);
        this.db
          .prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE project_key = ? AND id = ?`)
          .run(...params);
        this.appendHistory(
          projectKey,
          row.id,
          "update",
          row.revision + 1,
          actor,
          `updated ${changed.join(", ")}`,
          now,
        );
        return rowToNode(this.requireRow(projectKey, row.id));
      }),
    );
  }

  /** Re-parents a node; cycles, kind violations and archived targets are rejected. */
  moveNode(input: MoveNodeInput): Node {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireRow(projectKey, input.id);
        if (row.archived_at !== null) {
          throw new Error(`node ${row.id} is archived and cannot be moved`);
        }
        if (row.kind === "root") {
          throw new Error("a root node has no parent to move under");
        }
        if (input.newParentId === row.id) {
          throw new Error(`cannot move node ${row.id} under itself`);
        }
        const parent = this.requireRow(projectKey, input.newParentId);
        if (parent.archived_at !== null) {
          throw new Error(`parent node ${parent.id} is archived`);
        }
        if (parent.id === row.parent_id) {
          throw new Error(`node ${row.id} is already a child of ${parent.id}`);
        }
        const nodeKind = parseKind(row.kind);
        const parentKind = parseKind(parent.kind);
        if (!canHaveChild(parentKind, nodeKind)) {
          throw new Error(`a ${nodeKind} cannot be a child of a ${parentKind}`);
        }

        // Cycle check: the new parent must not sit inside the moved node's
        // own subtree — walk its ancestor chain up to the root.
        let ancestorId: string | null = parent.id;
        const seen = new Set<string>();
        while (ancestorId !== null) {
          if (ancestorId === row.id) {
            throw new Error(
              `cannot move node ${row.id} under ${parent.id}: it would create a cycle`,
            );
          }
          if (seen.has(ancestorId)) break; // corrupt chain guard
          seen.add(ancestorId);
          const up = this.db
            .prepare("SELECT parent_id FROM nodes WHERE project_key = ? AND id = ?")
            .get(projectKey, ancestorId) as { parent_id: string | null } | undefined;
          ancestorId = up ? up.parent_id : null;
        }

        const now = Date.now();
        this.db
          .prepare(
            `UPDATE nodes SET parent_id = ?, revision = revision + 1,
                             updated_at = ?, updated_by = ?
             WHERE project_key = ? AND id = ?`,
          )
          .run(parent.id, now, actor, projectKey, row.id);
        this.appendHistory(
          projectKey,
          row.id,
          "update",
          row.revision + 1,
          actor,
          `moved from ${row.parent_id ?? "none"} to ${parent.id}`,
          now,
        );
        return rowToNode(this.requireRow(projectKey, row.id));
      }),
    );
  }

  /**
   * Soft-deletes a node and its whole subtree (cascade). Each archived node
   * gets its own revision bump and its own `archive` audit row; descendants
   * that are already archived are left untouched. Returns the archived ids.
   */
  archiveNode(input: ArchiveNodeInput): string[] {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireRow(projectKey, input.id);
        if (row.archived_at !== null) {
          throw new Error(`node ${row.id} is already archived`);
        }
        // UNION (distinct) terminates even on a corrupt parent chain.
        const ids = (
          this.db
            .prepare(
              `WITH RECURSIVE subtree(id) AS (
                 SELECT id FROM nodes WHERE project_key = ? AND id = ?
                 UNION
                 SELECT n.id FROM nodes n
                   JOIN subtree s ON n.parent_id = s.id
                  WHERE n.project_key = ?
               )
               SELECT id FROM subtree`,
            )
            .all(projectKey, row.id, projectKey) as Array<{ id: string }>
        ).map((entry) => entry.id);

        const now = Date.now();
        const archived: string[] = [];
        const archiveStmt = this.db.prepare(
          `UPDATE nodes SET archived_at = ?, revision = revision + 1,
                           updated_at = ?, updated_by = ?
           WHERE project_key = ? AND id = ? AND archived_at IS NULL`,
        );
        const revisionStmt = this.db.prepare(
          "SELECT revision FROM nodes WHERE project_key = ? AND id = ?",
        );
        for (const nodeId of ids) {
          const result = archiveStmt.run(now, now, actor, projectKey, nodeId);
          if (Number(result.changes) === 0) continue; // already archived
          const revision = Number(
            (revisionStmt.get(projectKey, nodeId) as { revision: number }).revision,
          );
          this.appendHistory(
            projectKey,
            nodeId,
            "archive",
            revision,
            actor,
            nodeId === row.id
              ? `archived ${row.kind} \"${row.name}\"`
              : `archived with ancestor ${row.id}`,
            now,
          );
          archived.push(nodeId);
        }
        return archived;
      }),
    );
  }

  /**
   * Moves a **leaf** through the state machine of `shared/tree.ts`: invalid
   * transitions, no-ops, non-leaf nodes and archived nodes are rejected
   * with a readable message and bump nothing.
   */
  setStatus(input: SetStatusInput): Node {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const to = parseStatus(input.status);

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireRow(projectKey, input.id);
        if (row.archived_at !== null) {
          throw new Error(`node ${row.id} is archived and cannot change status`);
        }
        if (row.kind !== "leaf") {
          throw new Error(
            `the status state machine applies to leaf nodes only; node ${row.id} is a ${row.kind}`,
          );
        }
        const from = parseStatus(row.status);
        if (from === to) {
          throw new Error(`node ${row.id} already has status \"${from}\"`);
        }
        if (!canTransitionLeaf(from, to)) {
          const allowed = LEAF_TRANSITIONS[from];
          throw new Error(
            `invalid status transition ${from} → ${to} for node ${row.id}; ` +
              `allowed from \"${from}\": ${allowed.length > 0 ? allowed.join(", ") : "none (terminal status)"}`,
          );
        }
        const now = Date.now();
        this.db
          .prepare(
            `UPDATE nodes SET status = ?, revision = revision + 1,
                             updated_at = ?, updated_by = ?
             WHERE project_key = ? AND id = ?`,
          )
          .run(to, now, actor, projectKey, row.id);
        this.appendHistory(
          projectKey,
          row.id,
          "status",
          row.revision + 1,
          actor,
          `${from} → ${to}`,
          now,
        );
        return rowToNode(this.requireRow(projectKey, row.id));
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Search (stage B4): FTS5 + key=value filters, bm25 ordering, LIKE fallback
  // -------------------------------------------------------------------------

  /**
   * Searches one project's nodes.
   *
   * Three paths, chosen by what the query actually contains:
   *
   * 1. **FTS5** when the free text has indexable terms — `parseQuery` pulls
   *    `key=value` pairs out first, `ftsQuery` keeps quoted phrases and
   *    OR-joins the rest, so a natural-language query still matches, and
   *    bm25 ranks the strongest match first.
   * 2. **`LIKE` scan** when the text has no indexable terms (stop words or
   *    punctuation only) — a fallback that still answers instead of an
   *    empty result.
   * 3. **Filter-only listing** when there is no free text at all — the
   *    natural backing for "everything with status X" views.
   *
   * Text and filters compose (AND): an option filter, a `key=value` pair in
   * the query and the project scope must all hold, while the terms *inside*
   * the text rank with OR. A `project=` pair that does not equal
   * `options.projectKey` simply yields no hits — search never crosses the
   * project boundary (ADR-2). Archived nodes stay out unless asked for.
   *
   * Read-only: no fence, no transaction, nothing to audit.
   */
  search(query: string, options: SearchOptions): SearchHit[] {
    const projectKey = requireText(options.projectKey, "project key");
    if (typeof query !== "string") {
      throw new Error("search query must be a string");
    }
    const limit = clampLimit(options.limit);
    const parsed = parseQuery(query);
    const kinds = mergeUnique(
      (options.kinds ?? []).map((value) => parseKind(value)),
      parsed.filters.kinds.map((value) => parseKind(value)),
    );
    const statuses = mergeUnique(
      (options.statuses ?? []).map((value) => parseStatus(value)),
      parsed.filters.statuses.map((value) => parseStatus(value)),
    );

    // Structured filters, shared by all three paths. `where` always holds at
    // least the project scope, so no path can ever see another project.
    const where: string[] = ["n.project_key = ?"];
    const params: Array<string | number> = [projectKey];
    if (!options.includeArchived) where.push("n.archived_at IS NULL");
    if (kinds.length > 0) {
      where.push(`n.kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }
    if (statuses.length > 0) {
      where.push(`n.status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (parsed.filters.project !== null) {
      where.push("n.project_key = ?");
      params.push(parsed.filters.project);
    }
    const filtersSql = where.map((clause) => ` AND ${clause}`).join("");

    const match = parsed.match;
    let rows: Array<{ rowid: number; id: string; score: number }>;
    if (match !== null) {
      rows = this.db
        .prepare(
          `SELECT n.rowid AS rowid, n.id AS id, bm25(node_fts) AS score
           FROM node_fts JOIN nodes n ON n.rowid = node_fts.rowid
           WHERE node_fts MATCH ?${filtersSql}
           ORDER BY score ASC, n.id ASC
           LIMIT ?`,
        )
        .all(match, ...params, limit) as Array<{
        rowid: number;
        id: string;
        score: number;
      }>;
    } else {
      const freeText = parsed.freeText.trim();
      const whereSql = ` WHERE ${where.join(" AND ")}`;
      if (freeText.length > 0) {
        // No indexable terms, but there is text: substring scan over the
        // indexed columns. Unranked, so recency decides. Metacharacters are
        // escaped, so the fallback finds the text the caller typed instead
        // of treating `"_"` as "any single character".
        const like = `%${escapeLikePattern(freeText)}%`;
        rows = this.db
          .prepare(
            `SELECT n.rowid AS rowid, n.id AS id, 0 AS score
             FROM nodes n
             WHERE (n.name LIKE ? ESCAPE '\\'
                    OR n.description LIKE ? ESCAPE '\\'
                    OR n.payload LIKE ? ESCAPE '\\')
               AND ${where.join(" AND ")}
             ORDER BY n.updated_at DESC, n.id ASC
             LIMIT ?`,
          )
          .all(like, like, like, ...params, limit) as Array<{
          rowid: number;
          id: string;
          score: number;
        }>;
      } else {
        rows = this.db
          .prepare(
            `SELECT n.rowid AS rowid, n.id AS id, 0 AS score
             FROM nodes n${whereSql}
             ORDER BY n.updated_at DESC, n.id ASC
             LIMIT ?`,
          )
          .all(...params, limit) as Array<{
          rowid: number;
          id: string;
          score: number;
        }>;
      }
    }

    // Hydrate in rank order; the same row can be re-read cheaply, and a node
    // deleted between the two statements is simply skipped.
    const nodeStmt = this.db.prepare(
      "SELECT * FROM nodes WHERE project_key = ? AND id = ?",
    );
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const nodeRow = nodeStmt.get(projectKey, row.id) as NodeRow | undefined;
      if (!nodeRow) continue;
      hits.push({
        node: rowToNode(nodeRow),
        score: Number(row.score),
        snippet: match !== null ? this.snippetFor(row.rowid, match) : null,
      });
    }
    return hits;
  }

  /**
   * Highlighted description preview for a matched row (`null` when the
   * description is empty or the row no longer matches). A failure here must
   * never fail the search itself — the snippet is a nicety, the hits are not.
   */
  private snippetFor(rowid: number, match: string): string | null {
    try {
      const row = this.db
        .prepare(
          "SELECT snippet(node_fts, 1, '[…]', '[…]', '…', 12) AS s FROM node_fts WHERE rowid = ? AND node_fts MATCH ?",
        )
        .get(rowid, match) as { s?: string } | undefined;
      return row?.s ? row.s : null;
    } catch {
      return null;
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

// ---------------------------------------------------------------------------
// Row shapes and mapping (snake_case DB ↔ camelCase shared schemas)
// ---------------------------------------------------------------------------

interface NodeRow {
  id: string;
  project_key: string;
  parent_id: string | null;
  kind: string;
  name: string;
  description: string;
  status: string;
  version: string;
  revision: number;
  payload: string;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
  archived_at: number | null;
}

interface HistoryRow {
  id: number;
  project_key: string;
  entity_type: string;
  entity_id: string;
  action: string;
  revision: number;
  actor: string | null;
  result: string;
  at: number;
}

/** Maps a `nodes` row to the shared `Node`, parsing the JSON payload. */
function rowToNode(row: NodeRow): Node {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // A corrupt payload must not break reads; the row itself is still valid.
  }
  return nodeSchema.parse({
    id: row.id,
    projectKey: row.project_key,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    revision: row.revision,
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    archivedAt: row.archived_at,
  });
}

/** Maps a `history` row to the shared `HistoryEntry` (schema-validated). */
function rowToHistory(row: HistoryRow): HistoryEntry {
  return historyEntrySchema.parse({
    id: row.id,
    projectKey: row.project_key,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    revision: row.revision,
    actor: row.actor,
    result: row.result,
    at: row.at,
  });
}

/** Validates a node kind, failing with a readable message. */
function parseKind(value: unknown): NodeKind {
  const parsed = nodeKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid node kind ${JSON.stringify(value)}; expected one of: ${NODE_KINDS.join(", ")}`,
    );
  }
  return parsed.data;
}

/** Validates a leaf status, failing with a readable message. */
function parseStatus(value: unknown): LeafStatus {
  const parsed = leafStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid status ${JSON.stringify(value)}; expected one of: ${LEAF_STATUSES.join(", ")}`,
    );
  }
  return parsed.data;
}

/** Rejects empty strings for required text fields (name, actor, project key). */
function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Query parsing and FTS5 expression building (stage B4)
// ---------------------------------------------------------------------------

/** Default and maximum result sizes: a search answers a question, it does not dump the tree. */
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;

/** Clamps the requested limit to 1..100, rejecting nonsense loudly. */
function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `search limit must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(value)));
}

/** De-duplicates filter lists while preserving order (options ∪ query). */
function mergeUnique<T>(...lists: readonly T[][]): T[] {
  return [...new Set(lists.flat())];
}

/**
 * Escapes the LIKE metacharacters (`%`, `_` and the escape character
 * itself) so the fallback scans for the literal text the caller typed:
 * without this a query of `_` would match every node with a name longer
 * than zero characters.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Stop words dropped from free-text queries. FTS5 ships no stop-word list,
 * and a term inside an OR-joined query *does* match documents that only
 * contain that word — so without this list a natural-language query
 * ("the bug where login fails" / "где ошибка в экспорте") drags every
 * document containing a function word into the results. English list from
 * memory-flash; Russian list added here because this tree's content is
 * written in Russian. Single-character tokens are dropped anyway by
 * {@link MIN_TOKEN_LENGTH}.
 */
const STOP_WORDS = new Set([
  // English (memory-flash list)
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "where", "why", "how", "what", "which", "who", "whom", "whose",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done", "doing",
  "have", "has", "had", "having",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
  "this", "that", "these", "those",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "as", "into", "onto", "over", "under", "between", "through", "during", "before", "after", "above", "below", "up", "down", "out", "off", "again", "once", "here", "there", "all", "any", "both", "each", "few", "more", "most", "other", "some", "such", "no", "not", "only", "own", "same", "so", "than", "too", "very", "just", "because", "until", "while", "about",
  // Russian function words
  "без", "более", "больше", "будет", "будто", "был", "была", "были", "было", "быть",
  "вам", "вас", "вдруг", "ведь", "весь", "вот", "впрочем", "все", "всего", "всех", "всю", "вся", "вы",
  "где", "даже", "для", "до", "другой",
  "его", "ее", "если", "есть", "еще", "же", "за", "зачем", "здесь",
  "из", "или", "им", "их",
  "как", "какая", "какой", "конечно", "кто", "куда",
  "лучше", "между", "меня", "мне", "много", "мог", "можно", "мой", "моя", "мы",
  "над", "надо", "наш", "него", "нее", "нет", "ни", "нибудь", "никогда", "ним", "них", "ничего", "но", "ну", "нужно",
  "об", "один", "он", "она", "они", "оно", "опять", "от",
  "перед", "под", "после", "потом", "потому", "почти", "при", "про",
  "раз", "разве", "сам", "свою", "себе", "себя", "сейчас", "сказал", "сначала", "со", "совсем",
  "так", "такая", "также", "такой", "там", "тебя", "тем", "теперь", "то", "тогда", "того", "тоже", "только", "том", "тот", "тут", "ты",
  "уже", "хоть",
  "чего", "чем", "через", "что", "чтоб", "чтобы", "чуть",
  "эта", "эти", "это", "я",
]);

/** Tokens shorter than this are dropped from the FTS query. */
const MIN_TOKEN_LENGTH = 2;

/** `key=value` pairs recognized inside a free-text search query. */
const KEY_VALUE_PATTERN = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g;

/** Strips one layer of quoting from a filter value (`"a b"` → `a b`). */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Result of {@link parseQuery}. */
export interface ParsedQuery {
  /**
   * FTS5 MATCH expression built from the free-text terms; `null` when
   * nothing indexable remains (the caller falls back to LIKE).
   */
  match: string | null;
  /** The query with the recognized `key=value` filters removed. */
  freeText: string;
  /** Structured filters parsed out of the query text. */
  filters: { kinds: string[]; statuses: string[]; project: string | null };
}

/**
 * Splits a free-form query into an FTS5 MATCH expression and structured
 * filters. Recognized pairs (`kind=`, `status=`, `project=`) become
 * filters — a bare word on either side of an *unknown* pair is kept as
 * search terms instead, never glued into one token: `version=1.2` searches
 * for "version" and "1.2", not for "version1.2". The remaining free text
 * goes to {@link ftsQuery}, so `kind=leaf export` means "export" ANDed with
 * the kind filter rather than a search for the literal "kindleaf export".
 *
 * Kind and status values are lowercased (the enums are lowercase), so
 * `Kind=Leaf` works; anything else stays readable as a validation error
 * listing the accepted values.
 */
export function parseQuery(raw: string): ParsedQuery {
  const filters: ParsedQuery["filters"] = {
    kinds: [],
    statuses: [],
    project: null,
  };
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const regex = new RegExp(KEY_VALUE_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1].toLowerCase();
    const value = unquote(match[2]).trim();
    if (value.length === 0) continue;
    if (key === "project") {
      filters.project = value;
    } else if (key === "kind" || key === "kinds") {
      filters.kinds.push(value.toLowerCase());
    } else if (key === "status" || key === "statuses") {
      filters.statuses.push(value.toLowerCase());
    } else {
      // Unknown filter: keep both sides as separate search terms.
      replacements.push({
        start: match.index,
        end: regex.lastIndex,
        text: `${match[1]} ${value}`,
      });
      continue;
    }
    replacements.push({ start: match.index, end: regex.lastIndex, text: " " });
  }
  let freeText = raw;
  for (const { start, end, text } of replacements.reverse()) {
    freeText = freeText.slice(0, start) + text + freeText.slice(end);
  }
  return { match: ftsQuery(freeText), freeText, filters };
}

/**
 * A token is indexable when it is long enough, is not a stop word and
 * contains at least one letter or digit. The last rule matters: a run of
 * punctuation (`---`) would otherwise become a quoted phrase with zero
 * tokens, which matches nothing *and* blocks the LIKE fallback — the query
 * would silently return an empty result instead of scanning for the text.
 */
function isIndexable(token: string): boolean {
  if (token.length < MIN_TOKEN_LENGTH) return false;
  if (STOP_WORDS.has(token.toLowerCase())) return false;
  return /[\p{L}\p{N}]/u.test(token);
}

/**
 * Builds an FTS5 MATCH expression from a free-form query. Quoted phrases
 * are preserved verbatim; single terms are stripped of anything that is not
 * a letter, digit, underscore or hyphen (so `key:value` cannot turn into a
 * column filter and `NEAR(` cannot turn into an operator), then OR-joined
 * so bm25 ranks the best matches first. Everything is quoted, which is what
 * neutralizes FTS5 syntax. Returns `null` when nothing indexable remains.
 */
export function ftsQuery(raw: string): string | null {
  const terms: string[] = [];
  const phraseRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRegex.exec(raw)) !== null) {
    const cleaned = match[1].trim();
    if (!isIndexable(cleaned)) continue;
    terms.push(`"${cleaned.replace(/"/g, '""')}"`);
  }
  const withoutPhrases = raw.replace(phraseRegex, " ");
  for (const token of withoutPhrases.split(/\s+/)) {
    const cleaned = token.replace(/[^\p{L}\p{N}_-]/gu, "");
    if (!isIndexable(cleaned)) continue;
    terms.push(`"${cleaned}"`);
  }
  return terms.length > 0 ? terms.join(" OR ") : null;
}
