import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseYamlSubset, type ParsedNote } from "./parse";

/**
 * SQLite index of one vault: notes, heading chunks, FTS5 indexes, tags and the
 * wikilink graph.
 *
 * The database lives outside the vault (`server/paths.ts`) and is opened with
 * WAL so the plugin process (indexer, UI RPCs) and every agent-side MCP process
 * can read it concurrently. Writes go through the same file; SQLite serialises
 * them and the busy timeout absorbs a concurrent scan.
 *
 * Schema version and the FTS tokenizer are recorded in `meta`; a tokenizer
 * change wipes the derived tables so the next scan rebuilds them.
 */

export const SCHEMA_VERSION = 2;

export const TOKENIZE_PLAIN = "unicode61 remove_diacritics 2";
export const TOKENIZE_STEMMED = "porter unicode61 remove_diacritics 2";

export interface NoteFileRow {
  path: string;
  mtime_ms: number;
  size: number;
  hash: string;
}

export interface ChunkRow {
  id: number;
  path: string;
  heading: string;
  text: string;
  score: number;
}

export interface TitleRow {
  path: string;
  title: string;
  score: number;
}

export interface NoteMetaRow {
  path: string;
  title: string;
  folder: string;
  mtime_ms: number;
  size: number;
  word_count: number;
}

export interface IndexCounts {
  notes: number;
  chunks: number;
  links: number;
  unresolvedLinks: number;
}

export interface ChunkToEmbed {
  id: number;
  path: string;
  heading: string;
  text: string;
}

export interface EmbeddedChunk extends ChunkToEmbed {
  vec: Float32Array;
}

export interface EmbeddingStats {
  chunks: number;
  embedded: number;
  stale: number;
}

/**
 * Builds a safe FTS5 MATCH expression from a user query: every word becomes a
 * quoted term, joined with OR for recall. Returns `""` when nothing usable is
 * left, which callers treat as "no full-text signal".
 */
export function toFtsQuery(raw: string): string {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}_-]{1,64}/gu) ?? [];
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return "";
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

export class BridgeStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, options: { stemming: boolean }) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.ensureSchema(options.stemming);
  }

  close(): void {
    this.db.close();
  }

  private ensureSchema(stemming: boolean): void {
    const tokenize = stemming ? TOKENIZE_STEMMED : TOKENIZE_PLAIN;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        folder TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        frontmatter TEXT NOT NULL DEFAULT '',
        word_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        heading TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE TABLE IF NOT EXISTS tags (
        path TEXT NOT NULL,
        tag TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (path, tag, source)
      );
      CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
      CREATE TABLE IF NOT EXISTS aliases (
        path TEXT NOT NULL,
        alias TEXT NOT NULL,
        PRIMARY KEY (path, alias)
      );
      CREATE TABLE IF NOT EXISTS links (
        source_path TEXT NOT NULL,
        raw_target TEXT NOT NULL,
        target_path TEXT,
        alias TEXT,
        anchor TEXT,
        kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS links_source ON links(source_path);
      CREATE INDEX IF NOT EXISTS links_target ON links(target_path);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, heading, path UNINDEXED, tokenize='${tokenize}'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, aliases, path UNINDEXED, tokenize='${tokenize}'
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dim INTEGER NOT NULL,
        text_hash TEXT NOT NULL,
        vec BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS embeddings_model ON embeddings(model_id);
      CREATE INDEX IF NOT EXISTS embeddings_path ON embeddings(path);
    `);

    const recorded = this.getMeta("tokenize");
    if (recorded === null) {
      this.setMeta("tokenize", tokenize);
    } else if (recorded !== tokenize) {
      // The tokenizer is baked into the FTS tables: rebuild everything.
      this.db.exec(`
        DELETE FROM chunks_fts; DELETE FROM chunks;
        DELETE FROM notes_fts; DELETE FROM notes;
        DELETE FROM tags; DELETE FROM aliases; DELETE FROM links;
      `);
      this.setMeta("tokenize", tokenize);
    }
    this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  // -------------------------------------------------------------------------
  // meta
  // -------------------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  // -------------------------------------------------------------------------
  // notes
  // -------------------------------------------------------------------------

  listNoteFiles(): NoteFileRow[] {
    return this.db
      .prepare("SELECT path, mtime_ms, size, hash FROM notes ORDER BY path")
      .all() as unknown as NoteFileRow[];
  }

  noteFile(relPath: string): NoteFileRow | null {
    const row = this.db
      .prepare("SELECT path, mtime_ms, size, hash FROM notes WHERE path = ?")
      .get(relPath) as NoteFileRow | undefined;
    return row ?? null;
  }

  noteMeta(relPath: string): NoteMetaRow | null {
    const row = this.db
      .prepare(
        "SELECT path, title, folder, mtime_ms, size, word_count FROM notes WHERE path = ?",
      )
      .get(relPath) as NoteMetaRow | undefined;
    return row ?? null;
  }

  /** Inserts or replaces one note and every derived row. */
  upsertNote(input: {
    relPath: string;
    parsed: ParsedNote;
    mtimeMs: number;
    size: number;
    hash: string;
  }): void {
    const { relPath, parsed } = input;
    const folder = path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath);
    this.db.exec("BEGIN");
    try {
      this.deleteDerivedRows(relPath);

      this.db
        .prepare(
          `INSERT INTO notes (path, title, folder, mtime_ms, size, hash, frontmatter, word_count, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             title = excluded.title, folder = excluded.folder, mtime_ms = excluded.mtime_ms,
             size = excluded.size, hash = excluded.hash, frontmatter = excluded.frontmatter,
             word_count = excluded.word_count, indexed_at = excluded.indexed_at`,
        )
        .run(
          relPath,
          parsed.title,
          folder,
          input.mtimeMs,
          input.size,
          input.hash,
          JSON.stringify(parsed.frontmatter),
          parsed.wordCount,
          new Date().toISOString(),
        );

      const noteRow = this.db.prepare("SELECT rowid AS id FROM notes WHERE path = ?").get(relPath) as
        | { id: number }
        | undefined;
      if (noteRow) {
        this.db
          .prepare("INSERT INTO notes_fts (rowid, title, aliases, path) VALUES (?, ?, ?, ?)")
          .run(noteRow.id, parsed.title, parsed.aliases.join(" "), relPath);
      }

      const insertChunk = this.db.prepare(
        "INSERT INTO chunks (path, ordinal, heading, text) VALUES (?, ?, ?, ?)",
      );
      const insertChunkFts = this.db.prepare(
        "INSERT INTO chunks_fts (rowid, text, heading, path) VALUES (?, ?, ?, ?)",
      );
      parsed.chunks.forEach((chunk, ordinal) => {
        const result = insertChunk.run(relPath, ordinal, chunk.heading, chunk.text);
        insertChunkFts.run(Number(result.lastInsertRowid), chunk.text, chunk.heading, relPath);
      });

      const insertTag = this.db.prepare(
        "INSERT OR IGNORE INTO tags (path, tag, source) VALUES (?, ?, ?)",
      );
      for (const tag of parsed.tags) insertTag.run(relPath, tag, "body");

      const insertAlias = this.db.prepare(
        "INSERT OR IGNORE INTO aliases (path, alias) VALUES (?, ?)",
      );
      for (const alias of parsed.aliases) insertAlias.run(relPath, alias);

      const insertLink = this.db.prepare(
        "INSERT INTO links (source_path, raw_target, target_path, alias, anchor, kind) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const link of parsed.links) {
        insertLink.run(relPath, link.rawTarget, null, link.alias, link.anchor, link.kind);
      }

      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  private deleteDerivedRows(relPath: string): void {
    this.db
      .prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)")
      .run(relPath);
    // Chunk ids are recreated on every note write, so vectors go with them.
    this.db.prepare("DELETE FROM embeddings WHERE path = ?").run(relPath);
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);
    this.db
      .prepare("DELETE FROM notes_fts WHERE rowid IN (SELECT rowid FROM notes WHERE path = ?)")
      .run(relPath);
    this.db.prepare("DELETE FROM tags WHERE path = ?").run(relPath);
    this.db.prepare("DELETE FROM aliases WHERE path = ?").run(relPath);
    this.db.prepare("DELETE FROM links WHERE source_path = ?").run(relPath);
  }

  deleteNote(relPath: string): void {
    this.db.exec("BEGIN");
    try {
      this.deleteDerivedRows(relPath);
      this.db.prepare("DELETE FROM notes WHERE path = ?").run(relPath);
      // Links into the removed note become unresolved immediately, so a
      // backlink never points at a note the vault no longer has.
      this.db.prepare("UPDATE links SET target_path = NULL WHERE target_path = ?").run(relPath);
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  // -------------------------------------------------------------------------
  // link resolution
  // -------------------------------------------------------------------------

  /**
   * Resolves every `[[target]]` against the current note set (exact path,
   * basename, alias), in one pass. Ambiguous basenames stay unresolved rather
   * than guessing, so `obsidian_links` can report them.
   */
  resolveLinks(): void {
    const notes = this.db.prepare("SELECT path FROM notes").all() as unknown as Array<{ path: string }>;
    const byPath = new Map<string, string>();
    const byBase = new Map<string, string | null>();
    for (const note of notes) {
      const lower = note.path.toLowerCase();
      byPath.set(lower, note.path);
      byPath.set(lower.replace(/\.md$/, ""), note.path);
      const base = path.posix.basename(note.path).replace(/\.md$/i, "").toLowerCase();
      byBase.set(base, byBase.has(base) ? null : note.path);
    }
    const aliases = this.db
      .prepare("SELECT path, alias FROM aliases")
      .all() as unknown as Array<{ path: string; alias: string }>;
    const byAlias = new Map<string, string>();
    for (const row of aliases) {
      const key = row.alias.toLowerCase();
      if (!byAlias.has(key)) byAlias.set(key, row.path);
    }

    const links = this.db
      .prepare("SELECT rowid AS id, source_path, raw_target, target_path FROM links")
      .all() as unknown as Array<{
      id: number;
      source_path: string;
      raw_target: string;
      target_path: string | null;
    }>;

    const update = this.db.prepare("UPDATE links SET target_path = ? WHERE rowid = ?");
    for (const link of links) {
      const resolved = resolveTarget(link.raw_target, link.source_path, {
        byPath,
        byBase,
        byAlias,
      });
      if (resolved !== link.target_path) update.run(resolved, link.id);
    }
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  searchChunks(query: string, limit: number): ChunkRow[] {
    const match = toFtsQuery(query);
    if (match.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.path AS path, c.heading AS heading,
                snippet(chunks_fts, 0, '', '', ' … ', 24) AS snippet,
                bm25(chunks_fts) AS rank
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as unknown as Array<{
      id: number;
      path: string;
      heading: string;
      snippet: string;
      rank: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      heading: row.heading,
      text: row.snippet,
      score: -row.rank,
    }));
  }

  searchTitles(query: string, limit: number): TitleRow[] {
    const match = toFtsQuery(query);
    if (match.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT n.path AS path, n.title AS title, bm25(notes_fts) AS rank
         FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as unknown as Array<{ path: string; title: string; rank: number }>;
    return rows.map((row) => ({ path: row.path, title: row.title, score: -row.rank }));
  }

  recentNotes(limit: number): NoteMetaRow[] {
    return this.db
      .prepare(
        `SELECT path, title, folder, mtime_ms, size, word_count FROM notes
         ORDER BY mtime_ms DESC LIMIT ?`,
      )
      .all(limit) as unknown as NoteMetaRow[];
  }

  notesUnder(folder: string, limit: number): NoteMetaRow[] {
    const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
    if (trimmed.length === 0) {
      return this.db
        .prepare(
          `SELECT path, title, folder, mtime_ms, size, word_count FROM notes
           ORDER BY path LIMIT ?`,
        )
        .all(limit) as unknown as NoteMetaRow[];
    }
    return this.db
      .prepare(
        `SELECT path, title, folder, mtime_ms, size, word_count FROM notes
         WHERE path = ? OR path LIKE ?
         ORDER BY path LIMIT ?`,
      )
      .all(trimmed, `${trimmed}/%`, limit) as unknown as NoteMetaRow[];
  }

  chunksOf(relPath: string): Array<{ heading: string; text: string }> {
    return this.db
      .prepare("SELECT heading, text FROM chunks WHERE path = ? ORDER BY ordinal")
      .all(relPath) as unknown as Array<{ heading: string; text: string }>;
  }

  firstChunk(relPath: string): { heading: string; text: string } | null {
    const row = this.db
      .prepare("SELECT heading, text FROM chunks WHERE path = ? ORDER BY ordinal LIMIT 1")
      .get(relPath) as { heading: string; text: string } | undefined;
    return row ?? null;
  }

  tagsOf(relPath: string): string[] {
    const rows = this.db
      .prepare("SELECT tag FROM tags WHERE path = ? ORDER BY tag")
      .all(relPath) as unknown as Array<{ tag: string }>;
    return rows.map((row) => row.tag);
  }

  backlinksOf(relPath: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT source_path FROM links WHERE target_path = ? ORDER BY source_path",
      )
      .all(relPath) as unknown as Array<{ source_path: string }>;
    return rows.map((row) => row.source_path);
  }

  outgoingLinks(
    relPath: string,
  ): Array<{ raw_target: string; target_path: string | null; alias: string | null; anchor: string | null; kind: string }> {
    return this.db
      .prepare(
        `SELECT raw_target, target_path, alias, anchor, kind FROM links
         WHERE source_path = ? ORDER BY rowid`,
      )
      .all(relPath) as unknown as Array<{
      raw_target: string;
      target_path: string | null;
      alias: string | null;
      anchor: string | null;
      kind: string;
    }>;
  }

  unresolvedLinks(limit: number): Array<{ source_path: string; raw_target: string }> {
    return this.db
      .prepare(
        `SELECT source_path, raw_target FROM links
         WHERE target_path IS NULL AND raw_target <> ''
         GROUP BY raw_target, source_path ORDER BY source_path LIMIT ?`,
      )
      .all(limit) as unknown as Array<{ source_path: string; raw_target: string }>;
  }

  /** One-hop neighbours of a set of notes, by how many of them link there. */
  graphNeighbours(paths: string[], limit: number): Array<{ path: string; weight: number }> {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(", ");
    // Both ends of every link touching a seed: what the seeds link to, and
    // what links to them.
    const outgoing = this.db
      .prepare(
        `SELECT target_path AS path, COUNT(*) AS weight FROM links
         WHERE source_path IN (${placeholders}) AND target_path IS NOT NULL
         GROUP BY target_path ORDER BY weight DESC LIMIT ?`,
      )
      .all(...paths, limit) as unknown as Array<{ path: string; weight: number }>;
    const incoming = this.db
      .prepare(
        `SELECT source_path AS path, COUNT(*) AS weight FROM links
         WHERE target_path IN (${placeholders})
         GROUP BY source_path ORDER BY weight DESC LIMIT ?`,
      )
      .all(...paths, limit) as unknown as Array<{ path: string; weight: number }>;
    const seeds = new Set(paths);
    const merged = new Map<string, number>();
    for (const row of [...outgoing, ...incoming]) {
      if (seeds.has(row.path)) continue;
      merged.set(row.path, (merged.get(row.path) ?? 0) + row.weight);
    }
    return [...merged.entries()]
      .map(([notePath, weight]) => ({ path: notePath, weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  backlinkCounts(paths: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (paths.length === 0) return counts;
    const placeholders = paths.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT target_path AS path, COUNT(DISTINCT source_path) AS weight FROM links
         WHERE target_path IN (${placeholders}) GROUP BY target_path`,
      )
      .all(...paths) as unknown as Array<{ path: string; weight: number }>;
    for (const row of rows) counts.set(row.path, row.weight);
    return counts;
  }

  // -------------------------------------------------------------------------
  // embeddings
  // -------------------------------------------------------------------------

  /** Chunks that have no vector for `modelId` yet (missing or another model). */
  chunksToEmbed(modelId: string, limit = 200_000): ChunkToEmbed[] {
    return this.db
      .prepare(
        `SELECT c.id AS id, c.path AS path, c.heading AS heading, c.text AS text
         FROM chunks c
         LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model_id = ?
         WHERE e.chunk_id IS NULL
         ORDER BY c.path, c.ordinal LIMIT ?`,
      )
      .all(modelId, limit) as unknown as ChunkToEmbed[];
  }

  putEmbedding(input: {
    chunkId: number;
    path: string;
    modelId: string;
    dim: number;
    textHash: string;
    vec: Float32Array;
  }): void {
    const bytes = new Uint8Array(input.vec.buffer, input.vec.byteOffset, input.vec.byteLength);
    this.db
      .prepare(
        `INSERT INTO embeddings (chunk_id, path, model_id, dim, text_hash, vec)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET
           path = excluded.path, model_id = excluded.model_id, dim = excluded.dim,
           text_hash = excluded.text_hash, vec = excluded.vec`,
      )
      .run(input.chunkId, input.path, input.modelId, input.dim, input.textHash, bytes);
  }

  embeddingStats(modelId: string): EmbeddingStats {
    const one = (sql: string, ...params: Array<string | number>): number => {
      const row = this.db.prepare(sql).get(...params) as { c: number } | undefined;
      return row?.c ?? 0;
    };
    return {
      chunks: one("SELECT COUNT(*) AS c FROM chunks"),
      embedded: one("SELECT COUNT(*) AS c FROM embeddings WHERE model_id = ?", modelId),
      stale: one("SELECT COUNT(*) AS c FROM embeddings WHERE model_id <> ?", modelId),
    };
  }

  /** Vectors of one model, joined with the chunk text for snippets. */
  embeddingsFor(modelId: string): EmbeddedChunk[] {
    const rows = this.db
      .prepare(
        `SELECT e.chunk_id AS id, e.path AS path, c.heading AS heading, c.text AS text, e.vec AS vec
         FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
         WHERE e.model_id = ?`,
      )
      .all(modelId) as unknown as Array<{
      id: number;
      path: string;
      heading: string;
      text: string;
      vec: Uint8Array;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      heading: row.heading,
      text: row.text,
      vec: toFloat32(row.vec),
    }));
  }

  /** Drops vectors produced by a different model (a model change invalidates them). */
  clearEmbeddingsExcept(modelId: string): void {
    this.db.prepare("DELETE FROM embeddings WHERE model_id <> ?").run(modelId);
  }

  clearEmbeddings(): void {
    this.db.prepare("DELETE FROM embeddings").run();
  }

  counts(): IndexCounts {
    const one = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { c: number } | undefined;
      return row?.c ?? 0;
    };
    return {
      notes: one("SELECT COUNT(*) AS c FROM notes"),
      chunks: one("SELECT COUNT(*) AS c FROM chunks"),
      links: one("SELECT COUNT(*) AS c FROM links"),
      unresolvedLinks: one(
        "SELECT COUNT(*) AS c FROM links WHERE target_path IS NULL AND raw_target <> ''",
      ),
    };
  }

  sizeBytes(): number {
    const pageCount = this.db.prepare("PRAGMA page_count").get() as { page_count: number } | undefined;
    const pageSize = this.db.prepare("PRAGMA page_size").get() as { page_size: number } | undefined;
    return Number(pageCount?.page_count ?? 0) * Number(pageSize?.page_size ?? 0);
  }
}

/** Decodes a BLOB column into a Float32Array copy (never aliases SQLite memory). */
function toFloat32(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/** Resolves one wikilink target against the vault's note/alias maps. */
export function resolveTarget(
  rawTarget: string,
  sourcePath: string,
  maps: {
    byPath: Map<string, string>;
    byBase: Map<string, string | null>;
    byAlias: Map<string, string>;
  },
): string | null {
  const normalized = rawTarget
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\.md$/i, "")
    .toLowerCase();
  if (normalized.length === 0) return sourcePath;
  return (
    maps.byPath.get(normalized) ??
    maps.byBase.get(path.posix.basename(normalized)) ??
    maps.byAlias.get(normalized) ??
    null
  );
}

/** Re-exports for tests that build frontmatter without the parser. */
export { parseYamlSubset };
