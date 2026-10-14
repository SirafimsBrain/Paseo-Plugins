import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DatabaseSync,
  type DatabaseSyncOptions,
} from "node:sqlite";
import {
  BEE_STATUSES,
  BEE_TRANSITIONS,
  BUG_SEVERITIES,
  BUG_STATUSES,
  BUG_TRANSITIONS,
  beeSchema,
  beeStatusSchema,
  bugSchema,
  bugSeveritySchema,
  bugStatusSchema,
  canTransitionBee,
  canTransitionBug,
  isBugBlocking,
  type Bee,
  type BeeStatus,
  type Bug,
  type BugStatus,
} from "../shared/links";
import {
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  canApproveGoal,
  canTransitionGoal,
  goalSchema,
  goalStatusSchema,
  goalStepSchema,
  type Goal,
  type GoalStatus,
  type GoalStep,
} from "../shared/goals";
import {
  GROWTH_STATUSES,
  GROWTH_TRANSITIONS,
  canTransitionGrowth,
  growthProgress,
  growthSchema,
  growthStatusSchema,
  growthStepSchema,
  growthSubjectTypeSchema,
  type Growth,
  type GrowthStatus,
  type GrowthStep,
  type GrowthSubjectType,
} from "../shared/growth";
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
  type HistoryEntityType,
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
 *
 * Stage C1 adds the influence links ("bees"): a directed edge between two
 * leaves of one project, validated at both ends (leaf kind, same
 * `project_key`, alive), rejecting self-loops and duplicate pairs, moving
 * through its own status machine and carrying the same revision + audit
 * discipline as nodes.
 *
 * Stage C2 adds the incidents ("bugs"): a bug with severity and lifecycle
 * plus the m2m `bug_nodes` table, so one incident can block a leaf or a
 * group of leaves. Every attachment change is a mutation of the bug
 * (revision bump + audit); the blocked leaves themselves are never
 * touched — a blocker is a computed read, not a node state.
 *
 * Stage C3 adds the high goals with their approval gate: a goal enters
 * the tree only when `approveGoal` grows its subtree (side branch + one
 * draft leaf per plan step) inside the *same* transaction — which is why
 * {@link LuckPlannerStore.write} and the transaction wrapper are
 * re-entrant. Replacing a plan supersedes the goal and cascades a reset
 * onto the derived leaves (MetaGPT `reset_task` semantics).
 *
 * Stage C4 closes block C with the growth rates: one polymorphic
 * progress record per node or goal — ordered steps carrying state, facts
 * and reasons — plus the aggregate (`growthProgress`) the dashboard
 * growth layer renders. The subject itself is never mutated.
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
/**
 * The Paseo home directory: `$PASEO_HOME`, falling back to `~/.paseo`
 * (the same convention memory-flash and bunny-search use for plugin
 * data). Exported because every plugin-data path — the database here,
 * the published MCP entry (`mcp-launch.ts`) — must agree on it.
 */
export function paseoHome(): string {
  return process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
}

export function defaultDbPath(): string {
  return path.join(paseoHome(), "plugins", "luck-planner", "luck-planner.db");
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

/** `createBee` input: a directed influence edge between two live leaves. */
export interface CreateBeeInput {
  projectKey: string;
  sourceLeafId: string;
  targetLeafId: string;
  /** Initial status (defaults to `active`). */
  status?: BeeStatus;
  /** Degree/description of the influence; defaults to an empty string. */
  impact?: string;
  actor: string;
}

/** `updateBee` input: at least one of `impact`, `status` must be present. */
export interface UpdateBeeInput {
  projectKey: string;
  id: string;
  impact?: string;
  status?: BeeStatus;
  actor: string;
}

/** `deleteBee` input: hard-deletes the edge (bees carry no archive flag). */
export interface DeleteBeeInput {
  projectKey: string;
  id: string;
  actor: string;
}

/**
 * `createBug` input: one transaction creates the incident and attaches its
 * initial leaf set (the group the incident blocks).
 */
export interface CreateBugInput {
  projectKey: string;
  title: string;
  description?: string;
  severity: string;
  /** Initial status (defaults to `open`). */
  status?: string;
  /** Leaves this incident blocks right away; defaults to none. */
  nodeIds?: string[];
  actor: string;
}

/** `updateBug` input: at least one of title/description/severity/status. */
export interface UpdateBugInput {
  projectKey: string;
  id: string;
  title?: string;
  description?: string;
  severity?: string;
  status?: string;
  actor: string;
}

/** `deleteBug` input: hard-deletes the incident and its attachments. */
export interface DeleteBugInput {
  projectKey: string;
  id: string;
  actor: string;
}

/** `attachBug` input: adds one live leaf to the incident's group. */
export interface AttachBugInput {
  projectKey: string;
  bugId: string;
  nodeId: string;
  actor: string;
}

/** `detachBug` input: unlinks one leaf; the incident itself stays. */
export interface DetachBugInput {
  projectKey: string;
  bugId: string;
  nodeId: string;
  actor: string;
}

/**
 * `createGoal` input. A goal always starts as a `draft` — the funnel
 * draft → proposed → approved is what the gate enforces, so there is no
 * status parameter to shortcut it.
 */
export interface CreateGoalInput {
  projectKey: string;
  /** The formal natural-language task; becomes the subtree root's name. */
  formalText: string;
  /** Atomic plan steps; on approval each becomes a draft leaf. */
  plan: GoalStep[];
  actor: string;
}

/** `updateGoal` input: pre-approval edits of the task or the plan. */
export interface UpdateGoalInput {
  projectKey: string;
  id: string;
  formalText?: string;
  plan?: GoalStep[];
  actor: string;
}

/** `setGoalStatus` input: the generic lifecycle mover (no gate, no cascade). */
export interface SetGoalStatusInput {
  projectKey: string;
  id: string;
  status: GoalStatus;
  actor: string;
}

/** `approveGoal` input: crosses the gate and materializes in one transaction. */
export interface ApproveGoalInput {
  projectKey: string;
  id: string;
  /** Live branch (or subbranch) the goal's side branch grows under. */
  parentBranchId: string;
  actor: string;
}

/** `rejectGoal` input: a `proposed` plan is sent back to `draft`. */
export interface RejectGoalInput {
  projectKey: string;
  id: string;
  actor: string;
}

/** `replaceGoalPlan` input: supersedes the goal and resets derived leaves. */
export interface ReplaceGoalPlanInput {
  projectKey: string;
  id: string;
  plan: GoalStep[];
  actor: string;
}

/**
 * `createGrowth` input: a polymorphic progress record for **one** node or
 * goal. A subject may hold at most one growth record — a second attach is
 * rejected with a pointer to `updateGrowth`.
 */
export interface CreateGrowthInput {
  projectKey: string;
  subjectType: GrowthSubjectType;
  subjectId: string;
  /** Ordered steps; each carries state, facts and a reason. At least one. */
  steps: GrowthStep[];
  /** Initial status (defaults to `active`). */
  status?: GrowthStatus;
  actor: string;
}

/** `updateGrowth` input: at least one of `steps`, `status`. */
export interface UpdateGrowthInput {
  projectKey: string;
  id: string;
  steps?: GrowthStep[];
  status?: GrowthStatus;
  actor: string;
}

/** `deleteGrowth` input: hard-deletes the progress record (no archive flag). */
export interface DeleteGrowthInput {
  projectKey: string;
  id: string;
  actor: string;
}

/**
 * Aggregate progress of one subject, as `getGrowthProgress` reports it:
 * the numbers the dashboard growth layer (G5) renders. `ratio` is
 * `completed / total` per `growthProgress` in `shared/growth.ts` —
 * skipped steps stay in the denominator but never count as completed.
 */
export interface GrowthProgress {
  subjectType: GrowthSubjectType;
  subjectId: string;
  status: GrowthStatus;
  revision: number;
  total: number;
  completed: number;
  failed: number;
  ratio: number;
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
  /** Nesting depth of {@link write}; >0 means an outer call owns retries. */
  private writeDepth = 0;
  /** True while inside BEGIN…COMMIT — nested transactions join the outer one. */
  private inTransaction = false;

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
   *
   * Re-entrant: a nested call (a materialization creating nodes inside
   * the goal's own transaction) joins the outer one instead of retrying
   * on its own — the outermost call owns the retry, and its rollback
   * undoes the nested work too, so a retry starts from a clean slate.
   */
  write<T>(operation: () => T): T {
    if (this.writeDepth > 0) return operation();
    let attempt = 0;
    for (;;) {
      try {
        this.writeDepth += 1;
        try {
          return operation();
        } finally {
          this.writeDepth -= 1;
        }
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

  /**
   * Live direct children of a node, oldest first. `parentId: null` lists
   * the project's roots — how the MCP context tool lets an agent start at
   * the tech-stack level and descend (stage D1). Archived children stay
   * out: context describes the tree an agent may actually work on.
   * Read-only: no fence, no transaction, nothing to audit.
   */
  listChildren(projectKey: string, parentId: string | null): Node[] {
    const rows =
      parentId === null
        ? (this.db
            .prepare(
              `SELECT * FROM nodes
                WHERE project_key = ? AND parent_id IS NULL AND archived_at IS NULL
                ORDER BY created_at, id`,
            )
            .all(projectKey) as unknown as NodeRow[])
        : (this.db
            .prepare(
              `SELECT * FROM nodes
                WHERE project_key = ? AND parent_id = ? AND archived_at IS NULL
                ORDER BY created_at, id`,
            )
            .all(projectKey, parentId) as unknown as NodeRow[]);
    return rows.map(rowToNode);
  }

  /**
   * The ancestor chain of a node, root first, ending with the node itself
   * — the "where am I" breadcrumb the MCP context tool returns so an agent
   * can see how a fact hangs off the tech stack. An unknown id yields an
   * empty path; a corrupt parent chain terminates instead of looping.
   * Read-only.
   */
  getNodePath(projectKey: string, id: string): Node[] {
    const path: Node[] = [];
    const seen = new Set<string>();
    let currentId: string | null = id;
    while (currentId !== null && !seen.has(currentId)) {
      seen.add(currentId);
      const node = this.getNode(projectKey, currentId);
      if (!node) break;
      path.unshift(node);
      currentId = node.parentId;
    }
    return path;
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
   *
   * Re-entrant: while a transaction is open, a nested call (e.g.
   * `createNode` invoked by `approveGoal`) simply runs its statements in
   * the outer transaction — SQLite cannot nest `BEGIN IMMEDIATE`, and one
   * atomic unit is exactly what materialization needs.
   */
  private transaction<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
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
    } finally {
      this.inTransaction = false;
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
    entityType: HistoryEntityType,
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectKey, entityType, entityId, action, revision, actor, result, at);
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
          "node",
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

  /**
   * The branch a first leaf hangs under, creating the minimal skeleton
   * `root → trunk → branch` when the project has no live tree yet (stage D3).
   *
   * No MCP tool creates roots or branches, so without this an empty project
   * could never receive its first leaf. The emptiness check runs inside the
   * write transaction (`BEGIN IMMEDIATE` serializes writers), so two agent
   * processes racing on a fresh project cannot both bootstrap the tree.
   * Every created node gets a full audit row — the skeleton is not a
   * backdoor around the history rule.
   */
  ensureSkeletonBranch(input: { projectKey: string; actor: string }): Node {
    const projectKey = requireText(input.projectKey, "project key");
    const actor = requireText(input.actor, "actor");

    return this.write(() =>
      this.transaction(() => {
        const existing = this.db
          .prepare(
            `SELECT id FROM nodes
              WHERE project_key = ? AND parent_id IS NULL AND archived_at IS NULL
              LIMIT 1`,
          )
          .all(projectKey);
        if (existing.length > 0) {
          throw new Error(
            "the project already has a tree — omit parentId only for the very first " +
              "leaf; call luck_tree_get_context and pass the parentId of a branch " +
              "or subbranch",
          );
        }
        const root = this.createNode({
          projectKey,
          parentId: null,
          kind: "root",
          name: projectNameFromKey(projectKey),
          description:
            "Project root (tech stack). Created automatically with the first leaf.",
          actor,
        });
        const trunk = this.createNode({
          projectKey,
          parentId: root.id,
          kind: "trunk",
          name: "Trunk",
          description:
            "Links platforms/libraries with the code. Created automatically with the first leaf.",
          actor,
        });
        return this.createNode({
          projectKey,
          parentId: trunk.id,
          kind: "branch",
          name: "General",
          description:
            "Default module branch. Created automatically with the first leaf.",
          actor,
        });
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
          "node",
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
          "node",
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
            "node",
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
          "node",
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

  // -------------------------------------------------------------------------
  // Bees — influence links between leaves (stage C1)
  // -------------------------------------------------------------------------

  /** One bee by id, or `null` when it is not in this `projectKey`. */
  getBee(projectKey: string, id: string): Bee | null {
    const row = this.db
      .prepare("SELECT * FROM bees WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as BeeRow | undefined;
    return row ? rowToBee(row) : null;
  }

  /** Every bee of the project (the graph the dashboard lays out). */
  listBees(projectKey: string): Bee[] {
    const rows = this.db
      .prepare("SELECT * FROM bees WHERE project_key = ? ORDER BY created_at, id")
      .all(projectKey) as unknown as BeeRow[];
    return rows.map(rowToBee);
  }

  /**
   * Every bee touching `nodeId` — **both directions**: the influences the
   * node spreads (it is the source) and the ones landing on it (it is the
   * target). What the node details panel and the graph renderer both need;
   * an unknown node simply has no bees.
   */
  listBeesForNode(projectKey: string, nodeId: string): Bee[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bees
          WHERE project_key = ? AND (source_leaf_id = ? OR target_leaf_id = ?)
          ORDER BY created_at, id`,
      )
      .all(projectKey, nodeId, nodeId) as unknown as BeeRow[];
    return rows.map(rowToBee);
  }

  /**
   * Creates a directed influence edge between two live leaves of the same
   * project. Both ends are validated (existence in this project, `leaf`
   * kind, not archived), self-loops are rejected, and a second bee for the
   * same ordered pair is rejected too — parallel edges would render as one
   * ambiguous arrow on the dashboard. The reverse pair (`B → A`) is a
   * different, legitimate relation. The edge starts as `active` with
   * revision 1 and a `link` audit row.
   */
  createBee(input: CreateBeeInput): Bee {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const sourceLeafId = requireText(input.sourceLeafId, "bee source leaf id");
    const targetLeafId = requireText(input.targetLeafId, "bee target leaf id");
    const status = parseBeeStatus(input.status ?? "active");
    const impact = requireString(input.impact ?? "", "impact");

    return this.write(() =>
      this.transaction(() => {
        if (sourceLeafId === targetLeafId) {
          throw new Error(
            `a bee cannot connect a leaf to itself (node ${sourceLeafId})`,
          );
        }
        this.requireBeeEnd(projectKey, sourceLeafId, "source");
        this.requireBeeEnd(projectKey, targetLeafId, "target");
        const duplicate = this.db
          .prepare(
            `SELECT id FROM bees
              WHERE project_key = ? AND source_leaf_id = ? AND target_leaf_id = ?`,
          )
          .get(projectKey, sourceLeafId, targetLeafId) as
          | { id: string }
          | undefined;
        if (duplicate) {
          throw new Error(
            `a bee from ${sourceLeafId} to ${targetLeafId} already exists (${duplicate.id})`,
          );
        }

        const id = randomUUID();
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO bees
               (id, project_key, source_leaf_id, target_leaf_id, status,
                revision, impact, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            projectKey,
            sourceLeafId,
            targetLeafId,
            status,
            impact,
            now,
            now,
            actor,
            actor,
          );
        this.appendHistory(
          projectKey,
          "bee",
          id,
          "link",
          1,
          actor,
          `linked ${sourceLeafId} → ${targetLeafId}`,
          now,
        );
        return rowToBee(this.requireBeeRow(projectKey, id));
      }),
    );
  }

  /**
   * Updates a bee: `impact`, `status`, or both — at least one is required.
   * A status change runs through `BEE_TRANSITIONS` (`shared/links.ts`):
   * a no-op and an illegal transition are rejected with a readable message
   * and change nothing — no revision, no history row. The audit action is
   * `status` when the lifecycle moved, `update` otherwise.
   */
  updateBee(input: UpdateBeeInput): Bee {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    const sets: string[] = [];
    const params: Array<string | number> = [];
    const changed: string[] = [];
    if (input.impact !== undefined) {
      sets.push("impact = ?");
      params.push(requireString(input.impact, "impact"));
      changed.push("impact");
    }
    const wantsStatus = input.status !== undefined;
    const to = wantsStatus ? parseBeeStatus(input.status) : null;
    if (sets.length === 0 && !wantsStatus) {
      throw new Error("updateBee requires at least one of: impact, status");
    }

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireBeeRow(projectKey, input.id);
        let from: BeeStatus | null = null;
        if (wantsStatus && to !== null) {
          // Parses the stored value too, so a corrupt row fails readably.
          from = parseBeeStatus(row.status);
          if (from === to) {
            throw new Error(`bee ${row.id} already has status \"${from}\"`);
          }
          if (!canTransitionBee(from, to)) {
            const allowed = BEE_TRANSITIONS[from];
            throw new Error(
              `invalid status transition ${from} → ${to} for bee ${row.id}; ` +
                `allowed from \"${from}\": ${allowed.length > 0 ? allowed.join(", ") : "none (terminal status)"}`,
            );
          }
          sets.push("status = ?");
          params.push(to);
          changed.push("status");
        }

        const now = Date.now();
        sets.push("revision = revision + 1", "updated_at = ?", "updated_by = ?");
        params.push(now, actor, projectKey, row.id);
        this.db
          .prepare(`UPDATE bees SET ${sets.join(", ")} WHERE project_key = ? AND id = ?`)
          .run(...params);
        const impactChanged = changed.includes("impact");
        this.appendHistory(
          projectKey,
          "bee",
          row.id,
          from !== null ? "status" : "update",
          row.revision + 1,
          actor,
          from !== null
            ? `${from} → ${to}${impactChanged ? "; updated impact" : ""}`
            : "updated impact",
          now,
        );
        return rowToBee(this.requireBeeRow(projectKey, row.id));
      }),
    );
  }

  /**
   * Removes a bee (bees carry no `archived_at`, so this is a real delete).
   * The audit row is written in the same transaction with `revision + 1`,
   * so the history of a deleted bee stays gapless and strictly increasing:
   * the bump lives on in `history` after the row is gone. The returned bee
   * is that final recorded state (its revision already includes the bump),
   * which keeps the last history row and the returned value in agreement.
   * Deleting an unknown bee fails, and the pair may be linked again
   * afterwards.
   */
  deleteBee(input: DeleteBeeInput): Bee {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireBeeRow(projectKey, input.id);
        this.db
          .prepare("DELETE FROM bees WHERE project_key = ? AND id = ?")
          .run(projectKey, row.id);
        const now = Date.now();
        const finalRevision = row.revision + 1;
        this.appendHistory(
          projectKey,
          "bee",
          row.id,
          "unlink",
          finalRevision,
          actor,
          `unlinked ${row.source_leaf_id} → ${row.target_leaf_id}`,
          now,
        );
        return rowToBee({
          ...row,
          revision: finalRevision,
          updated_at: now,
          updated_by: actor,
        });
      }),
    );
  }

  /** Loads a bee row scoped by `project_key` or throws a readable error. */
  private requireBeeRow(projectKey: string, id: string): BeeRow {
    const row = this.db
      .prepare("SELECT * FROM bees WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as BeeRow | undefined;
    if (!row) throw new Error(`bee ${id} not found in project ${projectKey}`);
    return row;
  }

  /**
   * Validates one end of a would-be bee: it must exist **in this project**,
   * be a `leaf`, and not be archived. Reads the row for `createBee`'s own
   * checks; the role name makes the error say which end is wrong.
   */
  private requireBeeEnd(
    projectKey: string,
    nodeId: string,
    role: "source" | "target",
  ): NodeRow {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE project_key = ? AND id = ?")
      .get(projectKey, nodeId) as NodeRow | undefined;
    if (!row) {
      throw new Error(
        `bee ${role} node ${nodeId} not found in project ${projectKey}`,
      );
    }
    if (row.archived_at !== null) {
      throw new Error(`bee ${role} node ${nodeId} is archived`);
    }
    if (row.kind !== "leaf") {
      throw new Error(
        `bee ${role} node ${nodeId} is a ${row.kind}; bees connect leaves only`,
      );
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // Bugs — incidents blocking a leaf or a group of leaves (stage C2)
  // -------------------------------------------------------------------------

  /** One bug by id, or `null` when it is not in this `projectKey`. */
  getBug(projectKey: string, id: string): Bug | null {
    const row = this.db
      .prepare("SELECT * FROM bugs WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as BugRow | undefined;
    return row ? rowToBug(row) : null;
  }

  /** Every bug of the project (the incident list for the panel/dashboard). */
  listBugs(projectKey: string): Bug[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM bugs WHERE project_key = ? ORDER BY created_at, id",
      )
      .all(projectKey) as unknown as BugRow[];
    return rows.map(rowToBug);
  }

  /** Every incident attached to `nodeId` — any status, ordered oldest first. */
  listBugsForNode(projectKey: string, nodeId: string): Bug[] {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM bugs b
           JOIN bug_nodes bn ON bn.bug_id = b.id
          WHERE b.project_key = ? AND bn.node_id = ?
          ORDER BY b.created_at, b.id`,
      )
      .all(projectKey, nodeId) as unknown as BugRow[];
    return rows.map(rowToBug);
  }

  /**
   * The incidents that **block** `nodeId` right now: `open` and
   * `investigating` ones (`isBugBlocking`, `shared/links.ts`). This is what
   * the leaf details panel renders as "blocked by" — a leaf with a blocking
   * bug is visibly stuck even though its own status may still say
   * `in_progress`.
   */
  listBlockingBugs(projectKey: string, nodeId: string): Bug[] {
    return this.listBugsForNode(projectKey, nodeId).filter((bug) =>
      isBugBlocking(bug.status),
    );
  }

  /**
   * The leaves one incident blocks — the "group" side of `bug_nodes`:
   * reverse of {@link listBugsForNode}, what the bug details must show.
   */
  listNodesForBug(projectKey: string, bugId: string): Node[] {
    this.requireBugRow(projectKey, bugId);
    const rows = this.db
      .prepare(
        `SELECT n.* FROM nodes n
           JOIN bug_nodes bn ON bn.node_id = n.id
          WHERE bn.bug_id = ? AND n.project_key = ?
          ORDER BY n.created_at, n.id`,
      )
      .all(bugId, projectKey) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Creates an incident and attaches its initial leaf set in one
   * transaction: either the bug and all its attachments land together, or
   * nothing does. Severity is mandatory (triage needs it); status starts
   * `open`. Every attached node must be a live leaf of this project.
   * History: one `create` row, revision 1.
   */
  createBug(input: CreateBugInput): Bug {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const title = requireText(input.title, "bug title");
    const description = requireString(input.description ?? "", "description");
    const severity = parseBugSeverity(input.severity);
    const status = parseBugStatus(input.status ?? "open");
    const nodeIds = [...new Set(input.nodeIds ?? [])];

    return this.write(() =>
      this.transaction(() => {
        for (const nodeId of nodeIds) {
          this.requireBugNode(projectKey, nodeId);
        }
        const id = randomUUID();
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO bugs
               (id, project_key, title, description, severity, status,
                revision, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(
            id,
            projectKey,
            title,
            description,
            severity,
            status,
            now,
            now,
            actor,
            actor,
          );
        const attach = this.db.prepare(
          "INSERT INTO bug_nodes (bug_id, node_id) VALUES (?, ?)",
        );
        for (const nodeId of nodeIds) attach.run(id, nodeId);
        this.appendHistory(
          projectKey,
          "bug",
          id,
          "create",
          1,
          actor,
          `created bug \"${title}\" (${severity})${
            nodeIds.length > 0 ? `; attached ${nodeIds.length} node(s)` : ""
          }`,
          now,
        );
        return rowToBug(this.requireBugRow(projectKey, id));
      }),
    );
  }

  /**
   * Updates a bug: `title`, `description`, `severity`, `status` — at least
   * one is required. A status change runs through `BUG_TRANSITIONS`; a
   * no-op and an illegal transition are rejected with a readable message
   * and change nothing (no revision, no history). The audit action is
   * `status` when the lifecycle moved, `update` otherwise.
   */
  updateBug(input: UpdateBugInput): Bug {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    const sets: string[] = [];
    const params: Array<string | number> = [];
    const changed: string[] = [];
    if (input.title !== undefined) {
      sets.push("title = ?");
      params.push(requireText(input.title, "bug title"));
      changed.push("title");
    }
    if (input.description !== undefined) {
      sets.push("description = ?");
      params.push(requireString(input.description, "description"));
      changed.push("description");
    }
    if (input.severity !== undefined) {
      sets.push("severity = ?");
      params.push(parseBugSeverity(input.severity));
      changed.push("severity");
    }
    const wantsStatus = input.status !== undefined;
    const to = wantsStatus ? parseBugStatus(input.status) : null;
    if (sets.length === 0 && !wantsStatus) {
      throw new Error(
        "updateBug requires at least one of: title, description, severity, status",
      );
    }

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireBugRow(projectKey, input.id);
        let from: BugStatus | null = null;
        if (wantsStatus && to !== null) {
          from = parseBugStatus(row.status);
          if (from === to) {
            throw new Error(`bug ${row.id} already has status \"${from}\"`);
          }
          if (!canTransitionBug(from, to)) {
            const allowed = BUG_TRANSITIONS[from];
            throw new Error(
              `invalid status transition ${from} → ${to} for bug ${row.id}; ` +
                `allowed from \"${from}\": ${allowed.length > 0 ? allowed.join(", ") : "none (terminal status)"}`,
            );
          }
          sets.push("status = ?");
          params.push(to);
          changed.push("status");
        }

        const now = Date.now();
        sets.push("revision = revision + 1", "updated_at = ?", "updated_by = ?");
        params.push(now, actor, projectKey, row.id);
        this.db
          .prepare(`UPDATE bugs SET ${sets.join(", ")} WHERE project_key = ? AND id = ?`)
          .run(...params);
        const otherChanged = changed.filter((field) => field !== "status");
        this.appendHistory(
          projectKey,
          "bug",
          row.id,
          from !== null ? "status" : "update",
          row.revision + 1,
          actor,
          from !== null
            ? `${from} → ${to}${
                otherChanged.length > 0
                  ? `; updated ${otherChanged.join(", ")}`
                  : ""
              }`
            : `updated ${otherChanged.join(", ")}`,
          now,
        );
        return rowToBug(this.requireBugRow(projectKey, row.id));
      }),
    );
  }

  /**
   * Links one live leaf to the incident: the group membership grows by one.
   * The bug's revision bumps and a `link` row is appended — attachment is a
   * mutation **of the bug**; the leaf's own revision and history stay
   * untouched (a blocker is a computed read, not node state).
   */
  attachBug(input: AttachBugInput): Bug {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const nodeId = requireText(input.nodeId, "node id");

    return this.write(() =>
      this.transaction(() => {
        const bug = this.requireBugRow(projectKey, input.bugId);
        this.requireBugNode(projectKey, nodeId);
        const attached = this.db
          .prepare("SELECT 1 FROM bug_nodes WHERE bug_id = ? AND node_id = ?")
          .get(bug.id, nodeId);
        if (attached) {
          throw new Error(`bug ${bug.id} is already attached to node ${nodeId}`);
        }
        this.db
          .prepare("INSERT INTO bug_nodes (bug_id, node_id) VALUES (?, ?)")
          .run(bug.id, nodeId);
        const now = Date.now();
        this.db
          .prepare(
            `UPDATE bugs SET revision = revision + 1, updated_at = ?, updated_by = ?
              WHERE project_key = ? AND id = ?`,
          )
          .run(now, actor, projectKey, bug.id);
        this.appendHistory(
          projectKey,
          "bug",
          bug.id,
          "link",
          bug.revision + 1,
          actor,
          `attached node ${nodeId}`,
          now,
        );
        return rowToBug(this.requireBugRow(projectKey, bug.id));
      }),
    );
  }

  /**
   * Unlinks one leaf from the incident (the incident itself stays). The
   * bug's revision bumps and an `unlink` row is appended; unlinking a
   * node that is not attached fails, and the leaf may be attached again.
   */
  detachBug(input: DetachBugInput): Bug {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const nodeId = requireText(input.nodeId, "node id");

    return this.write(() =>
      this.transaction(() => {
        const bug = this.requireBugRow(projectKey, input.bugId);
        const result = this.db
          .prepare("DELETE FROM bug_nodes WHERE bug_id = ? AND node_id = ?")
          .run(bug.id, nodeId);
        if (Number(result.changes) === 0) {
          throw new Error(`bug ${bug.id} is not attached to node ${nodeId}`);
        }
        const now = Date.now();
        this.db
          .prepare(
            `UPDATE bugs SET revision = revision + 1, updated_at = ?, updated_by = ?
              WHERE project_key = ? AND id = ?`,
          )
          .run(now, actor, projectKey, bug.id);
        this.appendHistory(
          projectKey,
          "bug",
          bug.id,
          "unlink",
          bug.revision + 1,
          actor,
          `detached node ${nodeId}`,
          now,
        );
        return rowToBug(this.requireBugRow(projectKey, bug.id));
      }),
    );
  }

  /**
   * Removes an incident and **all of its attachments** in one transaction.
   * Bugs carry no `archived_at`, so this is a real delete; the audit row is
   * `archive` (the removal verb of the shared action vocabulary — `link` /
   * `unlink` are reserved for single attachments) with the exact outcome in
   * the result, and it keeps the same revision bump rule as `deleteBee`, so
   * a deleted bug's history stays gapless and matches the returned final
   * revision. Deleting an unknown bug fails.
   */
  deleteBug(input: DeleteBugInput): Bug {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireBugRow(projectKey, input.id);
        const detached = Number(
          this.db
            .prepare("DELETE FROM bug_nodes WHERE bug_id = ?")
            .run(row.id).changes,
        );
        this.db
          .prepare("DELETE FROM bugs WHERE project_key = ? AND id = ?")
          .run(projectKey, row.id);
        const now = Date.now();
        const finalRevision = row.revision + 1;
        this.appendHistory(
          projectKey,
          "bug",
          row.id,
          "archive",
          finalRevision,
          actor,
          `deleted bug \"${row.title}\" (${detached} attachment(s) removed)`,
          now,
        );
        return rowToBug({
          ...row,
          revision: finalRevision,
          updated_at: now,
          updated_by: actor,
        });
      }),
    );
  }

  /** Loads a bug row scoped by `project_key` or throws a readable error. */
  private requireBugRow(projectKey: string, id: string): BugRow {
    const row = this.db
      .prepare("SELECT * FROM bugs WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as BugRow | undefined;
    if (!row) throw new Error(`bug ${id} not found in project ${projectKey}`);
    return row;
  }

  /**
   * Validates one node a bug wants to block: it must exist **in this
   * project**, be a `leaf`, and not be archived — the same contract as a
   * bee's end, because a blocker that points nowhere is worse than no
   * blocker at all.
   */
  private requireBugNode(projectKey: string, nodeId: string): NodeRow {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE project_key = ? AND id = ?")
      .get(projectKey, nodeId) as NodeRow | undefined;
    if (!row) {
      throw new Error(
        `bug node ${nodeId} not found in project ${projectKey}`,
      );
    }
    if (row.archived_at !== null) {
      throw new Error(`bug node ${nodeId} is archived`);
    }
    if (row.kind !== "leaf") {
      throw new Error(
        `bug node ${nodeId} is a ${row.kind}; bugs block leaves only`,
      );
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // High goals — approval gate, materialization, plan replacement (C3)
  // -------------------------------------------------------------------------

  /** One goal by id, or `null` when it is not in this `projectKey`. */
  getGoal(projectKey: string, id: string): Goal | null {
    const row = this.db
      .prepare("SELECT * FROM goals WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  /** Every goal of the project, oldest first (approval queue + history). */
  listGoals(projectKey: string): Goal[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM goals WHERE project_key = ? ORDER BY created_at, id",
      )
      .all(projectKey) as unknown as GoalRow[];
    return rows.map(rowToGoal);
  }

  /**
   * The live leaf descendants of the subtree this goal materialized — the
   * derived plan facts. Empty until the goal is approved; after a plan
   * replacement it still lists them (now superseded), because the subtree
   * remains the historical record of the old plan.
   */
  listGoalLeaves(projectKey: string, goalId: string): Node[] {
    const goal = this.requireGoalRow(projectKey, goalId);
    if (goal.materialized_node_id === null) return [];
    const rows = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM nodes WHERE project_key = ? AND id = ?
           UNION
           SELECT n.id FROM nodes n
             JOIN subtree s ON n.parent_id = s.id
            WHERE n.project_key = ?
         )
         SELECT n.* FROM nodes n JOIN subtree s ON s.id = n.id
          WHERE n.kind = 'leaf' AND n.archived_at IS NULL
          ORDER BY n.created_at, n.id`,
      )
      .all(
        projectKey,
        goal.materialized_node_id,
        projectKey,
      ) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Creates a high goal as a `draft`: the formal task plus the agent's
   * plan. **Nothing enters the tree here** — a goal lives only in the
   * `goals` table until it is approved, which is the acceptance rule
   * "an unapproved goal is not in the tree" (ADR-7).
   */
  createGoal(input: CreateGoalInput): Goal {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const formalText = requireText(input.formalText, "goal formal text");
    const plan = parsePlan(input.plan);

    return this.write(() =>
      this.transaction(() => {
        const id = randomUUID();
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO goals
               (id, project_key, formal_text, plan_json, status, revision,
                materialized_node_id, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, 'draft', 1, NULL, ?, ?, ?, ?)`,
          )
          .run(
            id,
            projectKey,
            formalText,
            JSON.stringify(plan),
            now,
            now,
            actor,
            actor,
          );
        this.appendHistory(
          projectKey,
          "goal",
          id,
          "create",
          1,
          actor,
          `created goal with ${plan.length} plan step(s)`,
          now,
        );
        return rowToGoal(this.requireGoalRow(projectKey, id));
      }),
    );
  }

  /**
   * Edits the task or the plan **before** approval (statuses `draft` and
   * `proposed` only). Once a subtree exists the plan belongs to
   * `replaceGoalPlan`, and terminal goals are immutable; both cases fail
   * with a message that says which call to use instead.
   */
  updateGoal(input: UpdateGoalInput): Goal {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    const sets: string[] = [];
    const params: Array<string | number> = [];
    const changed: string[] = [];
    if (input.formalText !== undefined) {
      sets.push("formal_text = ?");
      params.push(requireText(input.formalText, "goal formal text"));
      changed.push("formal text");
    }
    if (input.plan !== undefined) {
      const plan = parsePlan(input.plan);
      sets.push("plan_json = ?");
      params.push(JSON.stringify(plan));
      changed.push(`plan (${plan.length} step(s))`);
    }
    if (sets.length === 0) {
      throw new Error("updateGoal requires at least one of: formalText, plan");
    }

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireGoalRow(projectKey, input.id);
        const status = parseGoalStatus(row.status);
        if (status !== "draft" && status !== "proposed") {
          throw new Error(
            ["approved", "in_progress", "done"].includes(status)
              ? `goal ${row.id} already grew a subtree; replace its plan through replaceGoalPlan (it supersedes the derived leaves)`
              : `goal ${row.id} is ${status} and can no longer be updated`,
          );
        }
        const now = Date.now();
        sets.push("revision = revision + 1", "updated_at = ?", "updated_by = ?");
        params.push(now, actor, projectKey, row.id);
        this.db
          .prepare(`UPDATE goals SET ${sets.join(", ")} WHERE project_key = ? AND id = ?`)
          .run(...params);
        this.appendHistory(
          projectKey,
          "goal",
          row.id,
          "update",
          row.revision + 1,
          actor,
          `updated ${changed.join(", ")}`,
          now,
        );
        return rowToGoal(this.requireGoalRow(projectKey, row.id));
      }),
    );
  }

  /**
   * The generic lifecycle mover: `draft → proposed`, `approved →
   * in_progress → done`, `→ cancelled` — whatever `GOAL_TRANSITIONS`
   * allows. Two transitions are deliberately unreachable here: `approved`
   * (only {@link approveGoal} crosses the gate, and it materializes in the
   * same breath) and `superseded` (only {@link replaceGoalPlan} marks it,
   * because it owns the cascade). A no-op and an illegal transition are
   * rejected and change nothing.
   */
  setGoalStatus(input: SetGoalStatusInput): Goal {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const to = parseGoalStatus(input.status);
    if (to === "approved") {
      throw new Error(
        `goal status "approved" is behind the approval gate; call approveGoal for goal ${input.id}`,
      );
    }
    if (to === "superseded") {
      throw new Error(
        `goal status "superseded" only comes from replaceGoalPlan for goal ${input.id}`,
      );
    }

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireGoalRow(projectKey, input.id);
        const from = parseGoalStatus(row.status);
        if (from === to) {
          throw new Error(`goal ${row.id} already has status \"${from}\"`);
        }
        if (!canTransitionGoal(from, to)) {
          const allowed = GOAL_TRANSITIONS[from];
          throw new Error(
            `invalid status transition ${from} → ${to} for goal ${row.id}; ` +
              `allowed from \"${from}\": ${allowed.length > 0 ? allowed.join(", ") : "none (terminal status)"}`,
          );
        }
        const now = Date.now();
        this.db
          .prepare(
            `UPDATE goals SET status = ?, revision = revision + 1,
                             updated_at = ?, updated_by = ?
              WHERE project_key = ? AND id = ?`,
          )
          .run(to, now, actor, projectKey, row.id);
        this.appendHistory(
          projectKey,
          "goal",
          row.id,
          "status",
          row.revision + 1,
          actor,
          `${from} → ${to}`,
          now,
        );
        return rowToGoal(this.requireGoalRow(projectKey, row.id));
      }),
    );
  }

  /**
   * **The approval gate.** Only a `proposed` goal may cross it
   * (`canApproveGoal`), and crossing it *materializes the subtree in the
   * same transaction*: a side branch named after the formal task,
   * hanging under `parentBranchId`, with one draft leaf per plan step
   * (payload `goalId`/`stepId`/`stepOrder`). Two audit rows mark the two
   * mutations — `approve` (status) and `materialize` (subtree) — so the
   * revision sequence stays gapless. The parent must be a live node that
   * can take `subbranch` children (a branch or subbranch).
   *
   * **Idempotent**: approving an already-approved, already-materialized
   * goal is a pure no-op — no nodes, no revision, no history — which is
   * the acceptance rule "materialization is idempotent".
   */
  approveGoal(input: ApproveGoalInput): Goal {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const parentBranchId = requireText(input.parentBranchId, "parent branch id");

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireGoalRow(projectKey, input.id);
        const status = parseGoalStatus(row.status);
        if (status === "approved" && row.materialized_node_id !== null) {
          return rowToGoal(row); // already crossed and grown: nothing to do
        }
        if (!canApproveGoal(status)) {
          throw new Error(
            `only a proposed goal may be approved; goal ${row.id} is ${status}`,
          );
        }
        const plan = parsePlan(safeParsePlan(row.plan_json));
        const parent = this.requireGoalParent(projectKey, parentBranchId);

        // 1) The gate crossing.
        const approvedAt = Date.now();
        this.db
          .prepare(
            `UPDATE goals SET status = 'approved', revision = revision + 1,
                             updated_at = ?, updated_by = ?
              WHERE project_key = ? AND id = ?`,
          )
          .run(approvedAt, actor, projectKey, row.id);
        this.appendHistory(
          projectKey,
          "goal",
          row.id,
          "approve",
          row.revision + 1,
          actor,
          `approved under parent ${parent.id}`,
          approvedAt,
        );

        // 2) Materialization: the nested createNode calls join this very
        // transaction (re-entrant write/transaction), so a failure anywhere
        // rolls back the gate crossing too.
        const root = this.createNode({
          projectKey,
          parentId: parent.id,
          kind: "subbranch",
          name: row.formal_text,
          payload: { goalId: row.id },
          actor,
        });
        for (const [index, step] of plan.entries()) {
          this.createNode({
            projectKey,
            parentId: root.id,
            kind: "leaf",
            name: step.title,
            description: step.description,
            status: "draft",
            payload: { goalId: row.id, stepId: step.id, stepOrder: index },
            actor,
          });
        }

        const materializedAt = Date.now();
        this.db
          .prepare(
            `UPDATE goals SET materialized_node_id = ?, revision = revision + 1,
                             updated_at = ?, updated_by = ?
              WHERE project_key = ? AND id = ?`,
          )
          .run(root.id, materializedAt, actor, projectKey, row.id);
        this.appendHistory(
          projectKey,
          "goal",
          row.id,
          "materialize",
          row.revision + 2,
          actor,
          `grew side branch ${root.id} with ${plan.length} step leaf(s) under ${parent.id}`,
          materializedAt,
        );
        return rowToGoal(this.requireGoalRow(projectKey, row.id));
      }),
    );
  }

  /**
   * Structured rejection at the gate: a `proposed` goal goes back to
   * `draft` for rework, recorded with the `reject` action (the panel's
   * "Reject" button). Every other status is refused with a readable
   * message and changes nothing.
   */
  rejectGoal(input: RejectGoalInput): Goal {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireGoalRow(projectKey, input.id);
        const from = parseGoalStatus(row.status);
        if (from !== "proposed") {
          throw new Error(
            `only a proposed goal can be rejected; goal ${row.id} is ${from}`,
          );
        }
        const now = Date.now();
        this.db
          .prepare(
            `UPDATE goals SET status = 'draft', revision = revision + 1,
                             updated_at = ?, updated_by = ?
              WHERE project_key = ? AND id = ?`,
          )
          .run(now, actor, projectKey, row.id);
        this.appendHistory(
          projectKey,
          "goal",
          row.id,
          "reject",
          row.revision + 1,
          actor,
          `${from} → draft (plan rejected)`,
          now,
        );
        return rowToGoal(this.requireGoalRow(projectKey, row.id));
      }),
    );
  }

  /**
   * Replaces the plan of a **materialized** goal (MetaGPT `reset_task`
   * semantics): the goal becomes `superseded` — terminal, because a redo
   * starts as a fresh goal with the new plan — and every derived leaf the
   * shared machine can still move is reset to `superseded`, each with its
   * own revision bump and a `supersede` audit row. Leaves already
   * `cancelled`/`superseded` and archived ones are left untouched
   * (`canTransitionLeaf` decides). The subtree stays in the tree as the
   * historical record of the old plan, still reachable through
   * `materialized_node_id`. The goal's plan is stored alongside, so the
   * rejected plan is not lost.
   */
  replaceGoalPlan(input: ReplaceGoalPlanInput): Goal {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const plan = parsePlan(input.plan);

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireGoalRow(projectKey, input.id);
        const from = parseGoalStatus(row.status);
        if (from === "draft" || from === "proposed") {
          throw new Error(
            `goal ${row.id} has not grown a subtree yet (status ${from}); edit its plan with updateGoal`,
          );
        }
        if (!canTransitionGoal(from, "superseded")) {
          const allowed = GOAL_TRANSITIONS[from];
          throw new Error(
            `invalid status transition ${from} → superseded for goal ${row.id}; ` +
              `allowed from \"${from}\": ${allowed.length > 0 ? allowed.join(", ") : "none (terminal status)"}`,
          );
        }

        // Cascade: reset every live leaf of the materialized subtree whose
        // status may still move to `superseded`.
        let total = 0;
        let reset = 0;
        if (row.materialized_node_id !== null) {
          const leaves = this.db
            .prepare(
              `WITH RECURSIVE subtree(id) AS (
                 SELECT id FROM nodes WHERE project_key = ? AND id = ?
                 UNION
                 SELECT n.id FROM nodes n
                   JOIN subtree s ON n.parent_id = s.id
                  WHERE n.project_key = ?
               )
               SELECT n.* FROM nodes n JOIN subtree s ON s.id = n.id
                WHERE n.kind = 'leaf' AND n.archived_at IS NULL
                ORDER BY n.created_at, n.id`,
            )
            .all(
              projectKey,
              row.materialized_node_id,
              projectKey,
            ) as unknown as NodeRow[];
          const now = Date.now();
          total = leaves.length;
          for (const leafRow of leaves) {
            const leafStatus = parseStatus(leafRow.status);
            if (!canTransitionLeaf(leafStatus, "superseded")) continue;
            this.db
              .prepare(
                `UPDATE nodes SET status = 'superseded', revision = revision + 1,
                                 updated_at = ?, updated_by = ?
                  WHERE project_key = ? AND id = ?`,
              )
              .run(now, actor, projectKey, leafRow.id);
            this.appendHistory(
              projectKey,
              "node",
              leafRow.id,
              "supersede",
              leafRow.revision + 1,
              actor,
              `superseded: goal ${row.id} plan replaced`,
              now,
            );
            reset += 1;
          }
        }

        const now = Date.now();
        this.db
          .prepare(
            `UPDATE goals SET plan_json = ?, status = 'superseded',
                             revision = revision + 1, updated_at = ?, updated_by = ?
              WHERE project_key = ? AND id = ?`,
          )
          .run(JSON.stringify(plan), now, actor, projectKey, row.id);
        this.appendHistory(
          projectKey,
          "goal",
          row.id,
          "supersede",
          row.revision + 1,
          actor,
          `plan replaced (${plan.length} step(s)); ${reset}/${total} derived leaf(s) reset`,
          now,
        );
        return rowToGoal(this.requireGoalRow(projectKey, row.id));
      }),
    );
  }

  /** Loads a goal row scoped by `project_key` or throws a readable error. */
  private requireGoalRow(projectKey: string, id: string): GoalRow {
    const row = this.db
      .prepare("SELECT * FROM goals WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as GoalRow | undefined;
    if (!row) throw new Error(`goal ${id} not found in project ${projectKey}`);
    return row;
  }

  /**
   * Validates where a goal's subtree may grow: a live node of this
   * project that can take `subbranch` children — a branch or a subbranch.
   */
  private requireGoalParent(projectKey: string, nodeId: string): NodeRow {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE project_key = ? AND id = ?")
      .get(projectKey, nodeId) as NodeRow | undefined;
    if (!row) {
      throw new Error(
        `goal parent node ${nodeId} not found in project ${projectKey}`,
      );
    }
    if (row.archived_at !== null) {
      throw new Error(`goal parent node ${nodeId} is archived`);
    }
    const kind = parseKind(row.kind);
    if (!canHaveChild(kind, "subbranch")) {
      throw new Error(
        `a goal subtree cannot grow under a ${kind}; it needs a branch or subbranch`,
      );
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // Growth rates — progress of any node or goal (stage C4)
  // -------------------------------------------------------------------------

  /** One growth record by id, or `null` when it is not in this `projectKey`. */
  getGrowth(projectKey: string, id: string): Growth | null {
    const row = this.db
      .prepare("SELECT * FROM growth WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as GrowthRow | undefined;
    return row ? rowToGrowth(row) : null;
  }

  /** The (single) progress record of a subject, or `null` if it has none. */
  getGrowthForSubject(
    projectKey: string,
    subjectType: GrowthSubjectType,
    subjectId: string,
  ): Growth | null {
    const type = parseGrowthSubjectType(subjectType);
    const row = this.db
      .prepare(
        "SELECT * FROM growth WHERE project_key = ? AND subject_type = ? AND subject_id = ?",
      )
      .get(projectKey, type, subjectId) as GrowthRow | undefined;
    return row ? rowToGrowth(row) : null;
  }

  /** Every growth record of the project (the dashboard heatmap's input). */
  listGrowth(projectKey: string): Growth[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM growth WHERE project_key = ? ORDER BY created_at, id",
      )
      .all(projectKey) as unknown as GrowthRow[];
    return rows.map(rowToGrowth);
  }

  /**
   * The aggregate the dashboard renders for one subject: `null` when the
   * subject has no progress record, otherwise the shared
   * `growthProgress()` numbers plus the record's status and revision —
   * one call instead of "fetch, then compute" for every row of a heatmap.
   */
  getGrowthProgress(
    projectKey: string,
    subjectType: GrowthSubjectType,
    subjectId: string,
  ): GrowthProgress | null {
    const growth = this.getGrowthForSubject(projectKey, subjectType, subjectId);
    if (!growth) return null;
    const aggregate = growthProgress(growth.steps);
    return {
      subjectType: growth.subjectType,
      subjectId: growth.subjectId,
      status: growth.status,
      revision: growth.revision,
      ...aggregate,
    };
  }

  /**
   * Attaches a progress record to **any** live tree element or to a goal
   * (the polymorphic binding of `__doc.md` §4.4). One record per subject:
   * a second attach fails with a pointer to `updateGrowth`, so progress
   * history stays one gapless revision sequence instead of fragments.
   * The subject itself is never modified — like bees and bugs, growth is
   * carried by its own row and audited on its own entity.
   */
  createGrowth(input: CreateGrowthInput): Growth {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");
    const subjectType = parseGrowthSubjectType(input.subjectType);
    const subjectId = requireText(input.subjectId, "growth subject id");
    const steps = parseGrowthSteps(input.steps);
    const status = parseGrowthStatus(input.status ?? "active");

    return this.write(() =>
      this.transaction(() => {
        this.requireGrowthSubject(projectKey, subjectType, subjectId);
        const existing = this.db
          .prepare(
            `SELECT id FROM growth
              WHERE project_key = ? AND subject_type = ? AND subject_id = ?`,
          )
          .get(projectKey, subjectType, subjectId) as { id: string } | undefined;
        if (existing) {
          throw new Error(
            `growth for ${subjectType} ${subjectId} already exists (${existing.id}); update it instead`,
          );
        }

        const id = randomUUID();
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO growth
               (id, project_key, subject_type, subject_id, steps_json, status,
                revision, created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(
            id,
            projectKey,
            subjectType,
            subjectId,
            JSON.stringify(steps),
            status,
            now,
            now,
            actor,
            actor,
          );
        this.appendHistory(
          projectKey,
          "growth",
          id,
          "create",
          1,
          actor,
          `created growth for ${subjectType} ${subjectId} with ${steps.length} step(s)`,
          now,
        );
        return rowToGrowth(this.requireGrowthRow(projectKey, id));
      }),
    );
  }

  /**
   * Updates a growth record: `steps` (the whole ordered array), `status`,
   * or both — at least one is required. A status change runs through
   * `GROWTH_TRANSITIONS`; a no-op and an illegal transition are rejected
   * and change nothing. The audit action is `status` when the lifecycle
   * moved, `update` otherwise — the exact discipline of `updateBee` /
   * `updateBug`.
   */
  updateGrowth(input: UpdateGrowthInput): Growth {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    const sets: string[] = [];
    const params: Array<string | number> = [];
    let steps: GrowthStep[] | null = null;
    if (input.steps !== undefined) {
      steps = parseGrowthSteps(input.steps);
      sets.push("steps_json = ?");
      params.push(JSON.stringify(steps));
    }
    const wantsStatus = input.status !== undefined;
    const to = wantsStatus ? parseGrowthStatus(input.status) : null;
    if (sets.length === 0 && !wantsStatus) {
      throw new Error("updateGrowth requires at least one of: steps, status");
    }

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireGrowthRow(projectKey, input.id);
        let from: GrowthStatus | null = null;
        if (wantsStatus && to !== null) {
          from = parseGrowthStatus(row.status);
          if (from === to) {
            throw new Error(`growth ${row.id} already has status \"${from}\"`);
          }
          if (!canTransitionGrowth(from, to)) {
            const allowed = GROWTH_TRANSITIONS[from];
            throw new Error(
              `invalid status transition ${from} → ${to} for growth ${row.id}; ` +
                `allowed from \"${from}\": ${allowed.length > 0 ? allowed.join(", ") : "none (terminal status)"}`,
            );
          }
          sets.push("status = ?");
          params.push(to);
        }

        const now = Date.now();
        sets.push("revision = revision + 1", "updated_at = ?", "updated_by = ?");
        params.push(now, actor, projectKey, row.id);
        this.db
          .prepare(`UPDATE growth SET ${sets.join(", ")} WHERE project_key = ? AND id = ?`)
          .run(...params);
        this.appendHistory(
          projectKey,
          "growth",
          row.id,
          from !== null ? "status" : "update",
          row.revision + 1,
          actor,
          from !== null
            ? `${from} → ${to}${
                steps !== null ? `; updated ${steps.length} step(s)` : ""
              }`
            : `updated ${steps!.length} step(s)`,
          now,
        );
        return rowToGrowth(this.requireGrowthRow(projectKey, row.id));
      }),
    );
  }

  /**
   * Removes a growth record (no `archived_at` on this table, so a real
   * delete). The audit row keeps the same revision-bump rule as the other
   * deletes: the bump lives on in `history`, the returned record carries
   * that final revision, and the subject may be given a fresh progress
   * record afterwards.
   */
  deleteGrowth(input: DeleteGrowthInput): Growth {
    const actor = requireText(input.actor, "actor");
    const projectKey = requireText(input.projectKey, "project key");

    return this.write(() =>
      this.transaction(() => {
        const row = this.requireGrowthRow(projectKey, input.id);
        this.db
          .prepare("DELETE FROM growth WHERE project_key = ? AND id = ?")
          .run(projectKey, row.id);
        const now = Date.now();
        const finalRevision = row.revision + 1;
        this.appendHistory(
          projectKey,
          "growth",
          row.id,
          "archive",
          finalRevision,
          actor,
          `deleted growth for ${row.subject_type} ${row.subject_id} (${safeParseGrowthSteps(row.steps_json).length} step(s))`,
          now,
        );
        return rowToGrowth({
          ...row,
          revision: finalRevision,
          updated_at: now,
          updated_by: actor,
        });
      }),
    );
  }

  /** Loads a growth row scoped by `project_key` or throws a readable error. */
  private requireGrowthRow(projectKey: string, id: string): GrowthRow {
    const row = this.db
      .prepare("SELECT * FROM growth WHERE project_key = ? AND id = ?")
      .get(projectKey, id) as GrowthRow | undefined;
    if (!row) throw new Error(`growth ${id} not found in project ${projectKey}`);
    return row;
  }

  /**
   * Validates the polymorphic subject: the node/goal must exist **in this
   * project**, and a node must not be archived (progress of a deleted
   * element is nonsense). Growth attaches to a node of **any** kind —
   * §4.4 assigns it to every tree element.
   */
  private requireGrowthSubject(
    projectKey: string,
    subjectType: GrowthSubjectType,
    subjectId: string,
  ): void {
    if (subjectType === "node") {
      const row = this.db
        .prepare("SELECT * FROM nodes WHERE project_key = ? AND id = ?")
        .get(projectKey, subjectId) as NodeRow | undefined;
      if (!row) {
        throw new Error(
          `growth subject node ${subjectId} not found in project ${projectKey}`,
        );
      }
      if (row.archived_at !== null) {
        throw new Error(`growth subject node ${subjectId} is archived`);
      }
      return;
    }
    this.requireGoalRow(projectKey, subjectId);
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

interface BeeRow {
  id: string;
  project_key: string;
  source_leaf_id: string;
  target_leaf_id: string;
  status: string;
  revision: number;
  impact: string;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
}

interface BugRow {
  id: string;
  project_key: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  revision: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
}

interface GoalRow {
  id: string;
  project_key: string;
  formal_text: string;
  plan_json: string;
  status: string;
  revision: number;
  materialized_node_id: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
}

interface GrowthRow {
  id: string;
  project_key: string;
  subject_type: string;
  subject_id: string;
  steps_json: string;
  status: string;
  revision: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
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

/** Maps a `bees` row to the shared `Bee` (schema-validated). */
function rowToBee(row: BeeRow): Bee {
  return beeSchema.parse({
    id: row.id,
    projectKey: row.project_key,
    sourceLeafId: row.source_leaf_id,
    targetLeafId: row.target_leaf_id,
    status: row.status,
    revision: row.revision,
    impact: row.impact,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  });
}

/** Maps a `bugs` row to the shared `Bug` (schema-validated). */
function rowToBug(row: BugRow): Bug {
  return bugSchema.parse({
    id: row.id,
    projectKey: row.project_key,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  });
}

/** Maps a `goals` row to the shared `Goal` (schema-validated). */
function rowToGoal(row: GoalRow): Goal {
  return goalSchema.parse({
    id: row.id,
    projectKey: row.project_key,
    formalText: row.formal_text,
    plan: safeParsePlan(row.plan_json),
    status: row.status,
    revision: row.revision,
    materializedNodeId: row.materialized_node_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  });
}

/** Maps a `growth` row to the shared `Growth` (schema-validated). */
function rowToGrowth(row: GrowthRow): Growth {
  return growthSchema.parse({
    id: row.id,
    projectKey: row.project_key,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    steps: safeParseGrowthSteps(row.steps_json),
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
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

/**
 * Last segment of a project key — the name for an auto-created skeleton
 * root (`/repos/my-app` → `my-app`).
 */
function projectNameFromKey(projectKey: string): string {
  const parts = projectKey.split(/[\\/]+/).filter((part) => part.length > 0);
  const last = parts[parts.length - 1] ?? "";
  return last.length > 0 ? last : "project";
}

/**
 * Validates a string that may legitimately be empty (`impact` starts out
 * blank) but must still *be* a string — RPC and MCP callers arrive from
 * JavaScript, where `undefined`/`null`/`42` are easy to send.
 */
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Validates a bee status, failing with a readable message. */
function parseBeeStatus(value: unknown): BeeStatus {
  const parsed = beeStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid bee status ${JSON.stringify(value)}; expected one of: ${BEE_STATUSES.join(", ")}`,
    );
  }
  return parsed.data;
}

/** Validates a bug severity, failing with a readable message. */
function parseBugSeverity(value: unknown): string {
  const parsed = bugSeveritySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid bug severity ${JSON.stringify(value)}; expected one of: ${BUG_SEVERITIES.join(", ")}`,
    );
  }
  return parsed.data;
}

/** Validates a bug status, failing with a readable message. */
function parseBugStatus(value: unknown): BugStatus {
  const parsed = bugStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid bug status ${JSON.stringify(value)}; expected one of: ${BUG_STATUSES.join(", ")}`,
    );
  }
  return parsed.data;
}

/** Validates a goal status, failing with a readable message. */
function parseGoalStatus(value: unknown): GoalStatus {
  const parsed = goalStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid goal status ${JSON.stringify(value)}; expected one of: ${GOAL_STATUSES.join(", ")}`,
    );
  }
  return parsed.data;
}

/**
 * Validates a plan for a **write**: an ordered array of at least one
 * `{ id, title, description }` step. The first offending step fails with
 * its index, so a caller with a big plan knows where to look.
 */
function parsePlan(value: unknown): GoalStep[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `goal plan must be an array of steps, got ${JSON.stringify(value)}`,
    );
  }
  if (value.length === 0) {
    throw new Error("goal plan must contain at least one step");
  }
  const steps: GoalStep[] = [];
  for (const [index, step] of value.entries()) {
    const parsed = goalStepSchema.safeParse(step);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `invalid goal plan step ${index}: ${
          issue ? `${issue.path.join(".") || "step"}: ${issue.message}` : "invalid step"
        }; each step needs { id, title, description }`,
      );
    }
    steps.push(parsed.data);
  }
  return steps;
}

/**
 * Lenient plan reader for **reads**: a goal row whose `plan_json` went
 * corrupt must still open (the `rowToNode` payload rule applied to goals) —
 * malformed steps are dropped instead of breaking every list call.
 */
function safeParsePlan(raw: string): GoalStep[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (step): step is GoalStep => goalStepSchema.safeParse(step).success,
    );
  } catch {
    return [];
  }
}

/** Validates a growth subject type, failing with a readable message. */
function parseGrowthSubjectType(value: unknown): GrowthSubjectType {
  const parsed = growthSubjectTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid growth subject type ${JSON.stringify(value)}; expected one of: ${["node", "goal"].join(", ")}`,
    );
  }
  return parsed.data;
}

/** Validates a growth status, failing with a readable message. */
function parseGrowthStatus(value: unknown): GrowthStatus {
  const parsed = growthStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid growth status ${JSON.stringify(value)}; expected one of: ${GROWTH_STATUSES.join(", ")}`,
    );
  }
  return parsed.data;
}

/**
 * Validates growth steps for a **write**: a non-empty array of
 * `{ id, title, state, facts, reason }`, the first offender named by index.
 */
function parseGrowthSteps(value: unknown): GrowthStep[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `growth steps must be an array, got ${JSON.stringify(value)}`,
    );
  }
  if (value.length === 0) {
    throw new Error("growth steps must contain at least one step");
  }
  const steps: GrowthStep[] = [];
  for (const [index, step] of value.entries()) {
    const parsed = growthStepSchema.safeParse(step);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `invalid growth step ${index}: ${
          issue ? `${issue.path.join(".") || "step"}: ${issue.message}` : "invalid step"
        }; each step needs { id, title, state, facts, reason }`,
      );
    }
    steps.push(parsed.data);
  }
  return steps;
}

/**
 * Lenient step reader for **reads**: a corrupt `steps_json` must not break
 * `listGrowth` / the dashboard — malformed steps are dropped, the same
 * rule as `payload` and `plan_json`.
 */
function safeParseGrowthSteps(raw: string): GrowthStep[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (step): step is GrowthStep => growthStepSchema.safeParse(step).success,
    );
  } catch {
    return [];
  }
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
