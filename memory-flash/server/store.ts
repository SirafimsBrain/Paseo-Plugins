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

  constructor(options: StoreOptions = {}) {
    this.dbPath = options.dbPath ?? memoryDbPath();
    this.historyPerMemory = options.historyPerMemory ?? 50;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    // `enableForeignKeyConstraints: false` is the default; we enforce
    // referential integrity manually to keep deletes simple and explicit.
    const openOptions: DatabaseSyncOptions = {};
    this.db = new DatabaseSync(this.dbPath, openOptions);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
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
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!version) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')")
        .run();
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
  // Write operations
  // -------------------------------------------------------------------------

  /** Creates a memory. Throws a readable Error when validation fails. */
  create(input: MemoryInput, changedBy: string | null = null): Memory {
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
    for (const tag of normalizeTags(value.tags)) this.stmtAddTag.run(id, tag);
    this.recordHistory(id, 1, "create", changedBy, now);
    return this.getById(id) as Memory;
  }

  /** Updates a memory (full replace of mutable fields). */
  update(id: number, input: MemoryUpdate, changedBy: string | null = null): Memory {
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
    for (const tag of normalizeTags(value.tags)) this.stmtAddTag.run(id, tag);
    const nextRevision = Number(existing.revision) + 1;
    this.recordHistory(id, nextRevision, "update", author, now);
    return this.getById(id) as Memory;
  }

  /** Deletes a memory and its tags. History rows are kept with change_kind='delete'. */
  delete(id: number, changedBy: string | null = null): boolean {
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
   * Hybrid search: FTS5 full-text when a query is present (ranked, with a
   * snippet), structured filtering over kind/tags/project/agent otherwise.
   * Text and filters compose (AND).
   */
  search(options: SearchOptions): SearchResult[] {
    const limit = Math.max(1, Math.min(100, options.limit));
    const where: string[] = [];
    const params: Array<string | number> = [];

    const useFts = options.query.trim().length > 0;
    let sql: string;
    if (useFts) {
      sql = `SELECT m.*, bm25(memories_fts) AS score`;
      const match = ftsQuery(options.query);
      if (match) {
        where.push("memories_fts MATCH ?");
        params.push(match);
      } else {
        // Query had no usable terms — fall back to LIKE so the user still
        // sees something for punctuation-only input.
        sql = `SELECT m.*, 0 AS score`;
        where.push("(m.title LIKE ? OR m.content LIKE ?)");
        const like = `%${options.query.trim()}%`;
        params.push(like, like);
      }
      sql += " FROM memories m JOIN memories_fts ON memories_fts.rowid = m.id";
    } else {
      sql = "SELECT m.*, 0 AS score FROM memories m";
    }

    if (options.kinds.length > 0) {
      where.push(`m.kind IN (${options.kinds.map(() => "?").join(",")})`);
      params.push(...options.kinds);
    }
    if (options.project) {
      where.push("m.project = ?");
      params.push(options.project);
    }
    if (options.agentId) {
      where.push("m.agent_id = ?");
      params.push(options.agentId);
    }
    if (options.tags.length > 0) {
      const normalized = normalizeTags(options.tags);
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
    params.push(limit * 3 > 0 ? limit : limit);

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
        snippet: useFts ? this.snippetFor(memory.id, options.query) : null,
      });
    }
    return results;
  }

  private snippetFor(id: number, query: string): string | null {
    const match = ftsQuery(query);
    if (!match) return null;
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

  /** Deletes every memory and history row. Used by the surface with confirm. */
  reset(): number {
    const count = (this.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    this.db.exec("DELETE FROM memories;");
    this.db.exec("DELETE FROM memory_tags;");
    this.db.exec("DELETE FROM memory_history;");
    this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');");
    return count;
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
 * Builds an FTS5 MATCH expression from a free-form query. Terms are ANDed;
 * quoted phrases are preserved; punctuation-only tokens are dropped.
 */
export function ftsQuery(raw: string): string | null {
  const terms: string[] = [];
  const phraseRegex = /"([^"]+)"/g;
  const phrases: string[] = [];
  let working = raw;
  let match: RegExpExecArray | null;
  while ((match = phraseRegex.exec(raw)) !== null) {
    phrases.push(match[1]);
  }
  working = working.replace(phraseRegex, " ");
  for (const phrase of phrases) {
    const cleaned = phrase.trim();
    if (cleaned.length > 0) terms.push(`"${cleaned.replace(/"/g, '""')}"`);
  }
  for (const token of working.split(/\s+/)) {
    const cleaned = token.replace(/[^\p{L}\p{N}_-]/gu, "");
    if (cleaned.length > 0) terms.push(`"${cleaned}"`);
  }
  return terms.length > 0 ? terms.join(" AND ") : null;
}
