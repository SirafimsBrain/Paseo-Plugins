// SQLite store (stage D1, ADR-3). Single file, WAL, busy_timeout, schema_version
// in `meta`. Groups/connections/settings. No secrets ever stored here.

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Connection, Group } from "../shared/connections";

const SCHEMA_VERSION = 1;

export interface StoreOptions {
  dbPath: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(options: StoreOptions) {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('ssh','rdp','vnc')),
        host TEXT NOT NULL,
        port INTEGER,
        username TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '{}',
        secret_refs TEXT NOT NULL DEFAULT '{}',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS connections_group ON connections(group_id, sort_order);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // ---------- groups ----------

  createGroup(input: { id: string; parentId: string | null; name: string; sortOrder?: number }): Group {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO groups (id, parent_id, name, sort_order, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(input.id, input.parentId, input.name, input.sortOrder ?? 0, now, now);
    return this.getGroup(input.id)!;
  }

  getGroup(id: string): Group | null {
    const row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToGroup(row);
  }

  listGroups(): Group[] {
    const rows = this.db.prepare("SELECT * FROM groups WHERE archived_at IS NULL ORDER BY sort_order, name").all() as Record<string, unknown>[];
    return rows.map(rowToGroup);
  }

  updateGroup(id: string, patch: { name?: string; parentId?: string | null; sortOrder?: number }): Group | null {
    const existing = this.getGroup(id);
    if (!existing) return null;
    const now = Date.now();
    const name = patch.name ?? existing.name;
    const parentId = patch.parentId === undefined ? existing.parentId : patch.parentId;
    const sortOrder = patch.sortOrder ?? existing.sortOrder;
    this.db
      .prepare("UPDATE groups SET name = ?, parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?")
      .run(name, parentId, sortOrder, now, id);
    return this.getGroup(id);
  }

  archiveGroup(id: string): boolean {
    const now = Date.now();
    const result = this.db.prepare("UPDATE groups SET archived_at = ? WHERE id = ? AND archived_at IS NULL").run(now, id);
    return result.changes > 0;
  }

  deleteGroup(id: string): boolean {
    const result = this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---------- connections ----------

  createConnection(input: {
    id: string;
    groupId: string | null;
    name: string;
    protocol: string;
    host: string;
    port: number | null;
    username?: string;
    payload?: Record<string, unknown>;
    secretRefs?: Record<string, string>;
    sortOrder?: number;
  }): Connection {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO connections (id, group_id, name, protocol, host, port, username, payload, secret_refs, sort_order, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        input.id,
        input.groupId,
        input.name,
        input.protocol,
        input.host,
        input.port,
        input.username ?? "",
        JSON.stringify(input.payload ?? {}),
        JSON.stringify(input.secretRefs ?? {}),
        input.sortOrder ?? 0,
        now,
        now,
      );
    return this.getConnection(input.id)!;
  }

  getConnection(id: string): Connection | null {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToConnection(row);
  }

  listConnections(groupId?: string | null): Connection[] {
    let rows: Record<string, unknown>[];
    if (groupId === undefined) {
      rows = this.db.prepare("SELECT * FROM connections WHERE archived_at IS NULL ORDER BY sort_order, name").all() as Record<string, unknown>[];
    } else if (groupId === null) {
      rows = this.db.prepare("SELECT * FROM connections WHERE group_id IS NULL AND archived_at IS NULL ORDER BY sort_order, name").all() as Record<string, unknown>[];
    } else {
      rows = this.db.prepare("SELECT * FROM connections WHERE group_id = ? AND archived_at IS NULL ORDER BY sort_order, name").all(groupId) as Record<string, unknown>[];
    }
    return rows.map(rowToConnection);
  }

  updateConnection(id: string, patch: Partial<{
    groupId: string | null;
    name: string;
    protocol: string;
    host: string;
    port: number | null;
    username: string;
    payload: Record<string, unknown>;
    secretRefs: Record<string, string>;
    sortOrder: number;
    archivedAt: number | null;
  }>): Connection | null {
    const existing = this.getConnection(id);
    if (!existing) return null;
    const now = Date.now();
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown): void => {
      fields.push(`${col} = ?`);
      values.push(val);
    };
    if (patch.groupId !== undefined) set("group_id", patch.groupId);
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.protocol !== undefined) set("protocol", patch.protocol);
    if (patch.host !== undefined) set("host", patch.host);
    if (patch.port !== undefined) set("port", patch.port);
    if (patch.username !== undefined) set("username", patch.username);
    if (patch.payload !== undefined) set("payload", JSON.stringify(patch.payload));
    if (patch.secretRefs !== undefined) set("secret_refs", JSON.stringify(patch.secretRefs));
    if (patch.sortOrder !== undefined) set("sort_order", patch.sortOrder);
    if (patch.archivedAt !== undefined) set("archived_at", patch.archivedAt);
    set("updated_at", now);
    if (fields.length === 0) return existing;
    values.push(id);
    this.db.prepare(`UPDATE connections SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any));
    return this.getConnection(id);
  }

  archiveConnection(id: string): boolean {
    return this.updateConnection(id, { archivedAt: Date.now() }) !== null;
  }

  deleteConnection(id: string): boolean {
    const result = this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Remove every group and connection (settings stay). Used by import --replace. */
  purge(): void {
    this.db.exec("DELETE FROM connections; DELETE FROM groups;");
  }

  // ---------- settings ----------

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

function rowToGroup(row: Record<string, unknown>): Group {
  return {
    id: String(row.id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    name: String(row.name),
    sortOrder: Number(row.sort_order),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
  };
}

function rowToConnection(row: Record<string, unknown>): Connection {
  return {
    id: String(row.id),
    groupId: row.group_id === null ? null : String(row.group_id),
    name: String(row.name),
    protocol: String(row.protocol) as Connection["protocol"],
    host: String(row.host),
    port: row.port === null ? null : Number(row.port),
    username: String(row.username ?? ""),
    payload: safeJson(row.payload, {}),
    secretRefs: safeJson(row.secret_refs, {}),
    sortOrder: Number(row.sort_order),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
  };
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
