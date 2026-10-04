import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type StatementSync, type DatabaseSyncOptions } from "node:sqlite";
import {
  memoryInputSchema,
  memoryUpdateSchema,
  type Memory,
  type MemoryInput,
  type MemoryKind,
  type MemoryRevision,
  type MemoryUpdate,
  type SearchResult,
  type SearchOptions,
} from "../shared/memories";

/** Shape of the `memory-flash.stats` RPC output (defined here, re-used there). */
export interface StatsSnapshot {
  total: number;
  byKind: Array<{ kind: MemoryKind; count: number }>;
  byAgent: Array<{ agentId: string; count: number }>;
  byProject: Array<{ project: string; count: number }>;
  topTags: Array<{ tag: string; count: number }>;
  dbSizeBytes: number;
}

/**
 * SQLite-backed shared memory store (requirement 5: SQLite with its
 * extensions — FTS5 full-text search).
 *
 * The database lives at `$PASEO_HOME/plugins/memory-flash/memory.db` so it is
 * co-located with the daemon that hosts the plugin. Every agent connected via
 * the MCP server and the Paseo surface read and write the same file.
 *
 * Schema (inspired by doobidoo/mcp-memory-service and Beledarian/mcp-local-memory):
 * - `memories`         — current rows with kind/title/content/project/agent
 * - `memories_fts`     — FTS5 index over title+content (external content table)
 * - `memory_tags`      — normalized tags, one row per (memory, tag)
 * - `memory_history`   — per-revision audit trail (create/update/delete/restore)
 */

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME;
  return configured && configured.trim().length > 0
    ? configured
    : path.join(os.homedir(), ".paseo");
}

export function memoryDbPath(): string {
  return path.join(paseoHome(), "plugins", "memory-flash", "memory.db");
}

export interface StoreOptions {
  /** Override the database path (tests). */
  dbPath?: string;
  /** Max content revisions kept per memory. */
  historyPerMemory?: number;
}

/** Internal api_keys row (carries the secret hash — never list it). */
export interface ApiKeyRecord {
  id: string;
  label: string;
  keyHash: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  scopes: ("read" | "read_write")[];
}

/** Options for generating an API key. */
export interface ApiKeyOptions {
  label: string;
  /** Time-to-live in days; 0 = never expires. */
  ttlDays?: number;
  scope?: "read" | "read_write";
}

/** Result of a successful generation: the record plus the secret (once). */
export interface GeneratedApiKey {
  record: ApiKeyRecord;
  secret: string;
}

/** Secret prefix marking a memory-flash remote-access key. */
const API_KEY_SECRET_PREFIX = "mf_live_";
/** Bytes of CSPRNG entropy in a secret (base64url-encoded after the prefix). */
const API_KEY_SECRET_BYTES = 32;
/** Characters of the secret kept in `prefix` for UI recognition. */
const API_KEY_PREFIX_LENGTH = 12;

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

const KINDS: readonly MemoryKind[] = [
  "decision",
  "procedure",
  "handoff",
  "bugfix",
  "pattern",
  "pitfall",
  "reference",
  "note",
];

/**
 * How long a statement waits for a competing writer. WAL allows many
 * readers but still only one writer at a time, and every agent process
 * shares this file, so a zero busy timeout turns ordinary write
 * contention into a lost write.
 */
const DB_BUSY_TIMEOUT_MS = 5000;
/** Write attempts before "database is locked" surfaces to the caller. */
const WRITE_ATTEMPTS = 3;
/** Backoff before the first write retry; doubles per attempt. */
const WRITE_RETRY_DELAY_MS = 25;

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 64);
}

function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized.length > 0) seen.add(normalized);
  }
  return [...seen].sort();
}

/**
 * Tags actually stored for a memory: the given tags plus the project
 * name. Both access paths — the `project` column filter and the tag
 * index — must find the same memories, so the project is indexed as a
 * tag too (0.3.2; existing rows are backfilled by the migration).
 */
function effectiveTags(tags: readonly string[], project: string | null): string[] {
  if (!project || project.trim().length === 0) return normalizeTags(tags);
  return normalizeTags([...tags, project]);
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private historyPerMemory: number;

  // Cached prepared statements (DatabaseSync.prepare is compiled per call).
  private stmtInsert!: StatementSync;
  private stmtFtsInsert!: StatementSync;
  private stmtAddTag!: StatementSync;
  private stmtHistoryInsert!: StatementSync;
  private stmtTrimHistory!: StatementSync;
  private stmtById!: StatementSync;
  private stmtTagsFor!: StatementSync;
  private stmtDelete!: StatementSync;
  private stmtFtsDelete!: StatementSync;
  private stmtTagsDelete!: StatementSync;
  private stmtHistoryForDelete!: StatementSync;
  private stmtUpdate!: StatementSync;
  private stmtUpdateTags!: StatementSync;
  private stmtApiKeyInsert!: StatementSync;
  private stmtApiKeyByHash!: StatementSync;
  private stmtApiKeyById!: StatementSync;
  private stmtApiKeyAll!: StatementSync;
  private stmtApiKeyDelete!: StatementSync;
  private stmtApiKeyTouch!: StatementSync;
  private stmtApiKeyCount!: StatementSync;

  constructor(options: StoreOptions = {}) {
    this.dbPath = options.dbPath ?? memoryDbPath();
    this.historyPerMemory = options.historyPerMemory ?? 50;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    // `enableForeignKeyConstraints: false` is the default; we enforce
    // referential integrity manually to keep deletes simple and explicit.
    // The busy timeout makes concurrent agent writers wait out short
    // lock contention instead of failing immediately; withWriteRetry()
    // covers the rest of the collision window.
    const openOptions: DatabaseSyncOptions = { timeout: DB_BUSY_TIMEOUT_MS };
    this.db = new DatabaseSync(this.dbPath, openOptions);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
    this.migrate();
    this.prepareStatements();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        project     TEXT,
        agent_id    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        revision    INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id INTEGER NOT NULL,
        tag       TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON memory_tags(tag);

      CREATE TABLE IF NOT EXISTS memory_history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id  INTEGER NOT NULL,
        revision   INTEGER NOT NULL,
        title      TEXT NOT NULL,
        content    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        tags       TEXT NOT NULL,
        changed_by TEXT,
        changed_at TEXT NOT NULL,
        change_kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_memory ON memory_history(memory_id, revision);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id           TEXT PRIMARY KEY,
        label        TEXT NOT NULL,
        key_hash     TEXT NOT NULL,
        prefix       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT,
        revoked_at   TEXT,
        last_used_at TEXT,
        scopes       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    `);
    // FTS5 index — external content so the main row stays authoritative.
    // Triggers keep the index in sync with plain UPDATE/DELETE too.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, content, content='memories', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF title, content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO memories_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
      END;
    `);
    const versionRow = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    const schemaVersion = versionRow ? Number.parseInt(versionRow.value, 10) : 0;
    if (schemaVersion < 1) {
      // Fresh database: start at the current version (nothing to backfill).
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
    } else if (schemaVersion < 2) {
      // 0.3.2: the project name became part of the tag index, so searching
      // by the project tag finds memories that only set the `project`
      // field. Backfill existing rows (PK conflict is ignored).
      this.db.exec(`
        INSERT OR IGNORE INTO memory_tags (memory_id, tag)
        SELECT id, substr(lower(trim(project)), 1, 64) FROM memories
        WHERE project IS NOT NULL AND trim(project) <> '';
      `);
      this.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    }
    if (schemaVersion >= 1 && schemaVersion < 3) {
      // 0.5.0: remote-access API keys. The table itself is created above
      // (IF NOT EXISTS), so only the version marker moves here.
      this.db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    }
  }

  private prepareStatements(): void {
    const now = "datetime('now')";
    void now;
    this.stmtInsert = this.db.prepare(
      `INSERT INTO memories (kind, title, content, project, agent_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    this.stmtFtsInsert = this.db.prepare(
      "INSERT INTO memories_fts(rowid, title, content) VALUES (?, ?, ?)",
    );
    this.stmtAddTag = this.db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)",
    );
    this.stmtHistoryInsert = this.db.prepare(
      `INSERT INTO memory_history (memory_id, revision, title, content, kind, tags, changed_by, changed_at, change_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtTrimHistory = this.db.prepare(
      `DELETE FROM memory_history
       WHERE memory_id = ?
         AND id NOT IN (
           SELECT id FROM memory_history WHERE memory_id = ?
           ORDER BY revision DESC, id DESC LIMIT ?
         )`,
    );
    this.stmtById = this.db.prepare("SELECT * FROM memories WHERE id = ?");
    this.stmtTagsFor = this.db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag");
    this.stmtDelete = this.db.prepare("DELETE FROM memories WHERE id = ?");
    this.stmtFtsDelete = this.db.prepare(
      "INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', ?, ?, ?)",
    );
    this.stmtTagsDelete = this.db.prepare("DELETE FROM memory_tags WHERE memory_id = ?");
    this.stmtHistoryForDelete = this.db.prepare("DELETE FROM memory_history WHERE memory_id = ?");
    this.stmtUpdate = this.db.prepare(
      `UPDATE memories SET kind = ?, title = ?, content = ?, project = ?, agent_id = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    );
    this.stmtUpdateTags = this.db.prepare(
      `INSERT INTO memory_tags (memory_id, tag)
       SELECT ?, value FROM json_each(?)
       WHERE true
       ON CONFLICT(memory_id, tag) DO NOTHING`,
    );
    this.stmtApiKeyInsert = this.db.prepare(
      `INSERT INTO api_keys (id, label, key_hash, prefix, created_at, expires_at, revoked_at, last_used_at, scopes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtApiKeyByHash = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?");
    this.stmtApiKeyById = this.db.prepare("SELECT * FROM api_keys WHERE id = ?");
    this.stmtApiKeyAll = this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC, id");
    this.stmtApiKeyDelete = this.db.prepare("DELETE FROM api_keys WHERE id = ?");
    this.stmtApiKeyTouch = this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?");
    this.stmtApiKeyCount = this.db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL");
  }

  // -------------------------------------------------------------------------
  // Row mapping
  // -------------------------------------------------------------------------

  private rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: Number(row.id),
      kind: row.kind as MemoryKind,
      title: String(row.title),
      content: String(row.content),
      tags: [],
      project: (row.project as string | null) ?? null,
      agentId: (row.agent_id as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      revision: Number(row.revision),
    };
  }

  private tagsFor(id: number): string[] {
    return this.stmtTagsFor.all(id).map((row) => String((row as { tag: unknown }).tag));
  }

  private memoryWithTags(row: Record<string, unknown> | undefined): Memory | null {
    if (!row) return null;
    const memory = this.rowToMemory(row);
    memory.tags = this.tagsFor(memory.id);
    return memory;
  }

  // -------------------------------------------------------------------------
  // Concurrency: several agent processes write the same WAL database
  // -------------------------------------------------------------------------

  /**
   * Runs a write operation, retrying when another process holds the
   * write lock. The driver-level busy timeout (5 s) already waits out
   * ordinary contention; the retry covers the rest of the collision
   * window of a multi-statement operation, so parallel agent workers
   * no longer lose writes to a transient "database is locked".
   */
  private withWriteRetry<T>(operation: () => T): T {
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
  // Write operations
  // -------------------------------------------------------------------------

  /** Creates a memory. Throws a readable Error when validation fails. */
  create(input: MemoryInput, changedBy: string | null = null): Memory {
    return this.withWriteRetry(() => {
      const parsed = memoryInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid memory: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      }
      const value = parsed.data;
      const now = new Date().toISOString();
      const result = this.stmtInsert.run(
        value.kind,
        value.title,
        value.content,
        value.project,
        value.agentId,
        now,
        now,
      );
      const id = Number(result.lastInsertRowid);
      for (const tag of effectiveTags(value.tags, value.project)) this.stmtAddTag.run(id, tag);
      this.recordHistory(id, 1, "create", changedBy, now);
      return this.getById(id) as Memory;
    });
  }

  /** Updates a memory (full replace of mutable fields). */
  update(id: number, input: MemoryUpdate, changedBy: string | null = null): Memory {
    return this.withWriteRetry(() => {
      const parsed = memoryUpdateSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid memory update: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      }
      const existing = this.stmtById.get(id) as Record<string, unknown> | undefined;
      if (!existing) throw new Error(`Memory ${id} not found.`);
      const value = parsed.data;
      // `changedBy` rides inside the update payload for RPC/MCP callers; the
      // positional argument wins when both are provided.
      const author = changedBy ?? value.changedBy ?? null;
      const now = new Date().toISOString();
      this.stmtUpdate.run(
        value.kind,
        value.title,
        value.content,
        value.project,
        value.agentId,
        now,
        id,
      );
      this.stmtTagsDelete.run(id);
      for (const tag of effectiveTags(value.tags, value.project)) this.stmtAddTag.run(id, tag);
      const nextRevision = Number(existing.revision) + 1;
      this.recordHistory(id, nextRevision, "update", author, now);
      return this.getById(id) as Memory;
    });
  }

  /** Deletes a memory and its tags. History rows are kept with change_kind='delete'. */
  delete(id: number, changedBy: string | null = null): boolean {
    return this.withWriteRetry(() => {
      const existing = this.stmtById.get(id) as Record<string, unknown> | undefined;
      if (!existing) return false;
      const now = new Date().toISOString();
      // Keep a tombstone revision before removing the row.
      this.recordHistoryWith(
        id,
        Number(existing.revision),
        "delete",
        changedBy,
        now,
        String(existing.title),
        String(existing.content),
        String(existing.kind),
        this.tagsFor(id),
      );
      this.stmtDelete.run(id);
      this.stmtTagsDelete.run(id);
      return true;
    });
  }

  private recordHistory(
    memoryId: number,
    revision: number,
    changeKind: "create" | "update",
    changedBy: string | null,
    changedAt: string,
  ): void {
    const row = this.stmtById.get(memoryId) as Record<string, unknown> | undefined;
    if (!row) return;
    this.recordHistoryWith(
      memoryId,
      revision,
      changeKind,
      changedBy,
      changedAt,
      String(row.title),
      String(row.content),
      String(row.kind),
      this.tagsFor(memoryId),
    );
  }

  private recordHistoryWith(
    memoryId: number,
    revision: number,
    changeKind: "create" | "update" | "delete",
    changedBy: string | null,
    changedAt: string,
    title: string,
    content: string,
    kind: string,
    tags: string[],
  ): void {
    this.stmtHistoryInsert.run(
      memoryId,
      revision,
      title,
      content,
      kind,
      JSON.stringify(tags),
      changedBy,
      changedAt,
      changeKind,
    );
    this.stmtTrimHistory.run(memoryId, memoryId, this.historyPerMemory);
  }

  get historyLimitPerMemory(): number {
    return this.historyPerMemory;
  }

  set historyLimitPerMemory(value: number) {
    this.historyPerMemory = Math.max(10, Math.min(200, Math.trunc(value)));
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  getById(id: number): Memory | null {
    return this.memoryWithTags(this.stmtById.get(id) as Record<string, unknown> | undefined);
  }

  /** History (audit trail) of one memory, newest first. */
  historyOf(id: number): MemoryRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_history WHERE memory_id = ? ORDER BY revision DESC, id DESC")
      .all(id) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      memoryId: Number(row.memory_id),
      revision: Number(row.revision),
      title: String(row.title),
      content: String(row.content),
      kind: row.kind as MemoryKind,
      tags: safeParseTags(String(row.tags)),
      changedBy: (row.changed_by as string | null) ?? null,
      changedAt: String(row.changed_at),
      changeKind: row.change_kind as "create" | "update" | "delete",
    }));
  }

  revisionById(revisionId: number): MemoryRevision | null {
    const row = this.db
      .prepare("SELECT * FROM memory_history WHERE id = ?")
      .get(revisionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      memoryId: Number(row.memory_id),
      revision: Number(row.revision),
      title: String(row.title),
      content: String(row.content),
      kind: row.kind as MemoryKind,
      tags: safeParseTags(String(row.tags)),
      changedBy: (row.changed_by as string | null) ?? null,
      changedAt: String(row.changed_at),
      changeKind: row.change_kind as "create" | "update" | "delete",
    };
  }

  /** Restores a past revision as a new update (never destroys history). */
  restoreRevision(revisionId: number, changedBy: string | null = null): Memory {
    const revision = this.revisionById(revisionId);
    if (!revision) throw new Error(`Revision ${revisionId} not found.`);
    if (revision.changeKind === "delete") {
      // Recreate the memory with the deleted content.
      return this.create(
        {
          kind: revision.kind,
          title: revision.title,
          content: revision.content,
          tags: revision.tags,
          project: null,
          agentId: revision.changedBy,
        },
        changedBy,
      );
    }
    return this.update(
      revision.memoryId,
      {
        kind: revision.kind,
        title: revision.title,
        content: revision.content,
        tags: revision.tags,
        project: this.getById(revision.memoryId)?.project ?? null,
        agentId: this.getById(revision.memoryId)?.agentId ?? null,
        changedBy,
      },
      changedBy,
    );
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Hybrid search: FTS5 full-text when the query has indexable terms
   * (ranked, with a snippet), structured filtering over kind/tags/
   * project/agent otherwise. Text and filters compose (AND); the terms
   * inside a text query rank (OR), so natural-language queries with
   * extra words still match. `key=value` pairs in the query
   * (project=, kind=, tag=, agent=) act as structured filters.
   */
  search(options: SearchOptions): SearchResult[] {
    const limit = Math.max(1, Math.min(100, options.limit));
    const parsed = parseQuery(options.query);
    const kinds = mergeUnique(options.kinds, parsed.filters.kinds);
    const tags = mergeUnique(options.tags, parsed.filters.tags);
    const project = options.project ?? parsed.filters.project;
    const agentId = options.agentId ?? parsed.filters.agentId;

    const where: string[] = [];
    const params: Array<string | number> = [];

    const ftsMatch = parsed.match;
    const useFts = ftsMatch !== null;
    let sql: string;
    if (useFts) {
      sql = `SELECT m.*, bm25(memories_fts) AS score`;
      where.push("memories_fts MATCH ?");
      params.push(ftsMatch);
      sql += " FROM memories m JOIN memories_fts ON memories_fts.rowid = m.id";
    } else if (parsed.freeText.trim().length > 0) {
      // Query had free text but no indexable terms (punctuation or stop
      // words only) — fall back to LIKE so the user still sees something.
      sql = `SELECT m.*, 0 AS score`;
      where.push("(m.title LIKE ? OR m.content LIKE ?)");
      const like = `%${parsed.freeText.trim()}%`;
      params.push(like, like);
    } else {
      // No free text (empty query or pure key=value filters):
      // plain structured listing, newest first.
      sql = "SELECT m.*, 0 AS score FROM memories m";
    }

    if (kinds.length > 0) {
      where.push(`m.kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }
    if (project) {
      where.push("m.project = ?");
      params.push(project);
    }
    if (agentId) {
      where.push("m.agent_id = ?");
      params.push(agentId);
    }
    if (tags.length > 0) {
      const normalized = normalizeTags(tags);
      const placeholders = normalized.map(() => "?").join(",");
      if (options.tagMode === "all") {
        where.push(
          `(SELECT COUNT(DISTINCT tag) FROM memory_tags t WHERE t.memory_id = m.id AND t.tag IN (${placeholders})) = ?`,
        );
        params.push(...normalized, normalized.length);
      } else {
        where.push(
          `EXISTS (SELECT 1 FROM memory_tags t WHERE t.memory_id = m.id AND t.tag IN (${placeholders}))`,
        );
        params.push(...normalized);
      }
    }

    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const orderSql = useFts ? " ORDER BY score LIMIT ?" : " ORDER BY m.updated_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db
      .prepare(`${sql}${whereSql}${orderSql}`)
      .all(...params) as Record<string, unknown>[];

    const results: SearchResult[] = [];
    for (const row of rows.slice(0, limit)) {
      const memory = this.memoryWithTags(row);
      if (!memory) continue;
      const score = Number(row.score ?? 0);
      results.push({
        memory,
        score,
        snippet: useFts ? this.snippetFor(memory.id, ftsMatch) : null,
      });
    }
    return results;
  }

  /** Highlighted FTS5 snippet for a matched row. */
  private snippetFor(id: number, match: string): string | null {
    try {
      const row = this.db
        .prepare(
          "SELECT snippet(memories_fts, 1, '[…]', '[…]', '…', 12) AS s FROM memories_fts WHERE rowid = ? AND memories_fts MATCH ?",
        )
        .get(id, match) as { s?: string } | undefined;
      return row?.s ?? null;
    } catch {
      return null;
    }
  }

  /** Plain listing with pagination for the surface browser. */
  list(options: SearchOptions & { offset: number }): { memories: Memory[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => "?").join(",")})`);
      params.push(...options.kinds);
    }
    if (options.project) {
      where.push("project = ?");
      params.push(options.project);
    }
    if (options.agentId) {
      where.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options.tags.length > 0) {
      const normalized = normalizeTags(options.tags);
      const placeholders = normalized.map(() => "?").join(",");
      where.push(
        `id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders}))`,
      );
      params.push(...normalized);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM memories${whereSql}`)
      .get(...params) as { c: number };
    const rows = this.db
      .prepare(`${whereSql ? "SELECT * FROM memories" + whereSql : "SELECT * FROM memories"} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, options.limit, options.offset) as Record<string, unknown>[];
    const memories: Memory[] = [];
    for (const row of rows) {
      const memory = this.memoryWithTags(row);
      if (memory) memories.push(memory);
    }
    return { memories, total: Number(totalRow.c) };
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  stats(): StatsSnapshot {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    const byKind = (
      this.db.prepare("SELECT kind, COUNT(*) AS c FROM memories GROUP BY kind ORDER BY c DESC").all() as Array<{ kind: string; c: number }>
    ).map((row) => ({ kind: row.kind as MemoryKind, count: row.c }));
    const byAgent = (
      this.db.prepare("SELECT agent_id, COUNT(*) AS c FROM memories WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY c DESC LIMIT 20").all() as Array<{ agent_id: string; c: number }>
    ).map((row) => ({ agentId: row.agent_id, count: row.c }));
    const byProject = (
      this.db.prepare("SELECT project, COUNT(*) AS c FROM memories WHERE project IS NOT NULL GROUP BY project ORDER BY c DESC LIMIT 20").all() as Array<{ project: string; c: number }>
    ).map((row) => ({ project: row.project, count: row.c }));
    const topTags = (
      this.db.prepare("SELECT tag, COUNT(*) AS c FROM memory_tags GROUP BY tag ORDER BY c DESC LIMIT 30").all() as Array<{ tag: string; c: number }>
    ).map((row) => ({ tag: row.tag, count: row.c }));
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(this.dbPath).size;
    } catch {
      // The database file is always readable in practice; WAL sidecars are
      // not counted.
    }
    return { total, byKind, byAgent, byProject, topTags, dbSizeBytes };
  }

  allTags(): Array<{ tag: string; count: number }> {
    return (
      this.db
        .prepare("SELECT tag, COUNT(*) AS c FROM memory_tags GROUP BY tag ORDER BY c DESC")
        .all() as Array<{ tag: string; c: number }>
    ).map((row) => ({ tag: row.tag, count: row.c }));
  }

  /** Removes history rows, optionally only those older than an ISO timestamp. */
  clearHistory(olderThan: string | null): number {
    let result: { changes: number | bigint };
    if (olderThan) {
      result = this.db
        .prepare("DELETE FROM memory_history WHERE changed_at < ?")
        .run(olderThan) as { changes: number | bigint };
    } else {
      result = this.db.prepare("DELETE FROM memory_history").run() as { changes: number | bigint };
    }
    return Number(result.changes);
  }

  /** Bulk removal used by the surface ("purge") and by delegated agent tasks. */
  purge(filter: { tags?: string[]; project?: string | null; kind?: MemoryKind | null }): number {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.project) {
      where.push("project = ?");
      params.push(filter.project);
    }
    if (filter.tags && filter.tags.length > 0) {
      const normalized = normalizeTags(filter.tags);
      const placeholders = normalized.map(() => "?").join(",");
      where.push(
        `id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${placeholders}))`,
      );
      params.push(...normalized);
    }
    if (where.length === 0) {
      // Refuse to purge everything without any filter — the caller must pass
      // at least one criterion. "Wipe the database" goes through reset().
      throw new Error("Purge requires at least one filter (tags, project or kind).");
    }
    const ids = this.db
      .prepare(`SELECT id FROM memories WHERE ${where.join(" AND ")}`)
      .all(...params) as Array<{ id: number }>;
    for (const { id } of ids) this.delete(id, "purge");
    return ids.length;
  }

  // -------------------------------------------------------------------------
  // Remote access API keys (HTTP transport, 0.5.0). The full secret
  // exists only during generation: the store keeps its SHA-256 hash.
  // -------------------------------------------------------------------------

  /** Creates a new API key and returns it together with the secret (shown once). */
  generateApiKey(options: ApiKeyOptions): GeneratedApiKey {
    const id = `mfk_${randomBase64Url(12)}`;
    const secret = `${API_KEY_SECRET_PREFIX}${randomBase64Url(API_KEY_SECRET_BYTES)}`;
    const now = new Date().toISOString();
    const ttlDays = options.ttlDays ?? 0;
    const record: ApiKeyRecord = {
      id,
      label: options.label,
      keyHash: sha256Hex(secret),
      prefix: secret.slice(0, API_KEY_PREFIX_LENGTH),
      createdAt: now,
      expiresAt:
        ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null,
      revokedAt: null,
      lastUsedAt: null,
      scopes: [options.scope ?? "read_write"],
    };
    this.withWriteRetry(() => {
      this.stmtApiKeyInsert.run(
        record.id,
        record.label,
        record.keyHash,
        record.prefix,
        record.createdAt,
        record.expiresAt,
        record.revokedAt,
        record.lastUsedAt,
        JSON.stringify(record.scopes),
      );
    });
    return { record, secret };
  }

  /**
   * Authenticates a presented secret: hashes it, looks the row up and
   * checks the revoked/expired flags. On success the row's `last_used_at`
   * is refreshed. Returns null on any failure — the caller cannot tell
   * a missing key from a revoked or expired one.
   */
  authenticateApiKey(secret: string): ApiKeyRecord | null {
    const row = this.stmtApiKeyByHash.get(sha256Hex(secret)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const record = this.rowToApiKey(row);
    if (record.revokedAt !== null) return null;
    if (record.expiresAt !== null && record.expiresAt <= new Date().toISOString()) {
      return null;
    }
    const now = new Date().toISOString();
    this.withWriteRetry(() => {
      this.stmtApiKeyTouch.run(now, record.id);
    });
    record.lastUsedAt = now;
    return record;
  }

  /**
   * Deletes a key outright. Returns false when the id is unknown.
   *
   * Deletion, not revocation: the row is gone, so the same label can be
   * re-issued immediately and the list never accumulates dead entries.
   * A revoked row from an older version stays rejected by
   * `authenticateApiKey` until it is deleted here.
   */
  deleteApiKey(id: string): boolean {
    const result = this.withWriteRetry(() =>
      this.stmtApiKeyDelete.run(id),
    ) as { changes: number | bigint };
    return Number(result.changes) > 0;
  }

  /** All keys, newest first, without secret material. */
  listApiKeys(): ApiKeyRecord[] {
    const rows = this.stmtApiKeyAll.all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToApiKey(row));
  }

  /** Number of non-revoked keys, for the HTTP status indicator. */
  activeKeyCount(): number {
    return (this.stmtApiKeyCount.get() as { c: number }).c;
  }

  private rowToApiKey(row: Record<string, unknown>): ApiKeyRecord {
    let scopes: ("read" | "read_write")[] = ["read_write"];
    try {
      const parsed: unknown = JSON.parse(String(row.scopes));
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (scope): scope is "read" | "read_write" =>
            scope === "read" || scope === "read_write",
        );
        if (valid.length > 0) scopes = valid;
      }
    } catch {
      // Unreadable scopes fall back to the default full-access scope.
    }
    return {
      id: String(row.id),
      label: String(row.label),
      keyHash: String(row.key_hash),
      prefix: String(row.prefix),
      createdAt: String(row.created_at),
      expiresAt: row.expires_at === null ? null : String(row.expires_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
      scopes,
    };
  }

  /** Deletes every memory and history row. Used by the surface with confirm. */
  reset(): number {
    return this.withWriteRetry(() => {
      const count = (this.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
      this.db.exec("DELETE FROM memories;");
      this.db.exec("DELETE FROM memory_tags;");
      this.db.exec("DELETE FROM memory_history;");
      this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');");
      return count;
    });
  }

  close(): void {
    this.db.close();
  }
}

function safeParseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Common English stop words. FTS5 ships no stop-word list of its own, so
 * they are dropped here: otherwise every natural-language query carrying
 * a function word ("the bug where login fails") demands that the
 * document contain that word too and matches nothing.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "where", "why", "how", "what", "which", "who", "whom", "whose",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done", "doing",
  "have", "has", "had", "having",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
  "this", "that", "these", "those",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "as", "into", "onto", "over", "under", "between", "through", "during", "before", "after", "above", "below", "up", "down", "out", "off", "again", "once", "here", "there", "all", "any", "both", "each", "few", "more", "most", "other", "some", "such", "no", "not", "only", "own", "same", "so", "than", "too", "very", "just", "because", "until", "while", "about",
]);

/** Tokens shorter than this are dropped from the FTS query. */
const MIN_TOKEN_LENGTH = 2;

/** `key=value` pairs recognized inside a free-text search query. */
const KEY_VALUE_PATTERN = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g;

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function mergeUnique<T>(...lists: readonly T[][]): T[] {
  return [...new Set(lists.flat())];
}

/** node:sqlite throws a plain Error carrying "database is locked". */
function isLockError(cause: unknown): boolean {
  return cause instanceof Error && /database is locked/i.test(cause.message);
}

/** Synchronous sleep — the store is synchronous end to end. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface ParsedQuery {
  /** FTS5 MATCH expression built from the free-text terms; null when nothing indexable remains. */
  match: string | null;
  /** The query text with recognized `key=value` filters removed (LIKE fallback). */
  freeText: string;
  /** Structured filters parsed out of the query. */
  filters: { kinds: string[]; tags: string[]; project: string | null; agentId: string | null };
}

/**
 * Splits a free-form query into an FTS5 MATCH expression and structured
 * filters. Recognized `key=value` pairs (project=, kind=, tag=, agent=)
 * become filters; unknown pairs contribute both sides as search terms
 * (never glued into a single token). The remaining free text goes to
 * {@link ftsQuery}, so `project=auth-api login` means "login" ANDed
 * with the project filter instead of searching for "projectauth-api".
 */
export function parseQuery(raw: string): ParsedQuery {
  const filters: ParsedQuery["filters"] = { kinds: [], tags: [], project: null, agentId: null };
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
      filters.kinds.push(value);
    } else if (key === "tag" || key === "tags") {
      filters.tags.push(value);
    } else if (key === "agent" || key === "agentid" || key === "agent_id") {
      filters.agentId = value;
    } else {
      // Unknown filter: keep both sides as separate search terms.
      replacements.push({ start: match.index, end: regex.lastIndex, text: `${match[1]} ${value}` });
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
 * Builds an FTS5 MATCH expression from a free-form query. Quoted phrases
 * are preserved verbatim; single terms are OR-ed (bm25 ranks the best
 * matches first) after dropping stop words and very short tokens.
 * Returns null when nothing indexable remains.
 */
export function ftsQuery(raw: string): string | null {
  const terms: string[] = [];
  const phraseRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRegex.exec(raw)) !== null) {
    const cleaned = match[1].trim();
    if (cleaned.length > 0) terms.push(`"${cleaned.replace(/"/g, '""')}"`);
  }
  const withoutPhrases = raw.replace(phraseRegex, " ");
  for (const token of withoutPhrases.split(/\s+/)) {
    const cleaned = token.replace(/[^\p{L}\p{N}_-]/gu, "");
    if (cleaned.length < MIN_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(cleaned.toLowerCase())) continue;
    terms.push(`"${cleaned}"`);
  }
  return terms.length > 0 ? terms.join(" OR ") : null;
}
