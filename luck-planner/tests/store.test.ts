import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LuckPlannerStore, SCHEMA_VERSION } from "../server/store";

/**
 * Stage B2 acceptance (`PLAN.md`): schema on a real file, idempotent
 * reopen, concurrent writers without loss, migration path v0→v1. These
 * tests use real SQLite files in a temp directory — no mocks, the same
 * discipline as memory-flash's store tests.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-store-"));
  dirs.push(dir);
  return dir;
}

function openStore(dbPath: string, busyTimeoutMs?: number): LuckPlannerStore {
  const store = new LuckPlannerStore({ dbPath, busyTimeoutMs });
  stores.push(store);
  return store;
}

/** Raw connection of a store, same access its own methods use. */
function dbOf(store: LuckPlannerStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("schema v1", () => {
  it("creates every planned table on a fresh file", () => {
    const dbPath = path.join(tempDir(), "nested", "luck-planner.db");
    const store = openStore(dbPath);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    // FTS5 additionally creates shadow tables (node_fts_data, ...) and
    // AUTOINCREMENT adds sqlite_sequence; the acceptance criterion is that
    // every planned table exists.
    const names = tableNames(dbOf(store));
    for (const planned of [
      "nodes",
      "bees",
      "bugs",
      "bug_nodes",
      "goals",
      "growth",
      "history",
      "meta",
      "node_fts",
    ]) {
      expect(names, `table ${planned}`).toContain(planned);
    }
  });

  it("enables WAL and NORMAL synchronous", () => {
    const store = openStore(path.join(tempDir(), "a.db"));
    const db = dbOf(store);
    expect(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode,
    ).toBe("wal");
    expect(
      Number((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous),
    ).toBe(1); // NORMAL
  });

  it("scopes the nodes index on (project_key, parent_id)", () => {
    const store = openStore(path.join(tempDir(), "b.db"));
    const indexes = (
      dbOf(store)
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toContain("nodes_project_parent");
  });

  it("keeps the FTS5 index in sync through triggers", () => {
    const store = openStore(path.join(tempDir(), "c.db"));
    const db = dbOf(store);
    store.write(() => {
      db.prepare(
        `INSERT INTO nodes (id, project_key, kind, name, status, revision, payload, created_at, updated_at)
         VALUES (?, '/p', 'leaf', ?, 'draft', 1, '{}', 1, 1)`,
      ).run(randomUUID(), "PDF export library");
    });
    const hits = db
      .prepare(
        "SELECT rowid FROM node_fts WHERE node_fts MATCH 'export'",
      )
      .all();
    expect(hits).toHaveLength(1);
  });

  it("reopens idempotently and keeps the data", () => {
    const dbPath = path.join(tempDir(), "d.db");
    const first = openStore(dbPath);
    const id = randomUUID();
    first.write(() => {
      dbOf(first)
        .prepare(
          `INSERT INTO nodes (id, project_key, kind, name, status, revision, payload, created_at, updated_at)
           VALUES (?, '/p', 'root', 'Tech stack', 'draft', 1, '{}', 1, 1)`,
        )
        .run(id);
    });
    first.close();

    const second = openStore(dbPath);
    expect(second.schemaVersion).toBe(SCHEMA_VERSION);
    const row = dbOf(second)
      .prepare("SELECT name FROM nodes WHERE id = ?")
      .get(id) as { name: string } | undefined;
    expect(row?.name).toBe("Tech stack");
  });
});

describe("migrations", () => {
  it("migrates a v0 database to v1", () => {
    const dbPath = path.join(tempDir(), "e.db");
    // A v0 file: only the meta table, no schema.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    legacy
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '0')")
      .run();
    legacy.close();

    const store = openStore(dbPath);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(tableNames(dbOf(store))).toContain("nodes");
  });

  it("refuses a database newer than the supported schema", () => {
    const dbPath = path.join(tempDir(), "f.db");
    const future = new DatabaseSync(dbPath);
    future.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    future
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '99')")
      .run();
    future.close();

    expect(() => openStore(dbPath)).toThrow(/newer than the supported/);
  });
});

describe("write fence", () => {
  it("retries a transient lock error with backoff and succeeds", () => {
    const store = openStore(path.join(tempDir(), "g.db"));
    let calls = 0;
    const started = Date.now();
    const result = store.write(() => {
      calls += 1;
      if (calls < 3) throw new Error("database is locked");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    // 25 ms + 50 ms of mandated backoff actually elapsed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it("surfaces the lock error after the attempt budget", () => {
    const store = openStore(path.join(tempDir(), "h.db"));
    let calls = 0;
    expect(() =>
      store.write(() => {
        calls += 1;
        throw new Error("database is locked");
      }),
    ).toThrow(/database is locked/);
    expect(calls).toBe(3);
  });

  it("does not retry errors that are not lock contention", () => {
    const store = openStore(path.join(tempDir(), "i.db"));
    let calls = 0;
    expect(() =>
      store.write(() => {
        calls += 1;
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    expect(calls).toBe(1);
  });
});

describe("concurrent writers", () => {
  it("loses no writes when a child process and the store write in parallel", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "concurrent.db");
    const store = openStore(dbPath);
    const CHILD_WRITES = 200;
    const PARENT_WRITES = 200;

    // The child mirrors the production writer: node:sqlite, 5 s busy
    // timeout, the same retry budget, writing the same table from a
    // separate OS process — the exact shape of an agent MCP server.
    const scriptPath = path.join(dir, "writer.cjs");
    writeFileSync(
      scriptPath,
      `
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const [dbPath, countArg] = process.argv.slice(2);
const count = Number(countArg);
const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec("PRAGMA busy_timeout = 5000;");
const stmt = db.prepare(
  "INSERT INTO nodes (id, project_key, kind, name, status, revision, payload, created_at, updated_at) VALUES (?, '/conc', 'leaf', ?, 'draft', 1, '{}', ?, ?)"
);
console.log("ready");
for (let i = 0; i < count; i++) {
  const now = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      stmt.run(randomUUID(), "child-" + i, now, now);
      break;
    } catch (error) {
      attempt += 1;
      if (attempt >= 3 || !/database is locked/i.test(String(error && error.message))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
    }
  }
}
console.log("done");
db.close();
`,
    );

    const child = spawn(process.execPath, [scriptPath, dbPath, String(CHILD_WRITES)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const stdout = child.stdout!;
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes("ready")) resolve();
      });
      // A child that dies before "ready" must fail the test immediately
      // instead of hanging the await until the timeout.
      child.once("exit", (code) =>
        reject(new Error(`writer child exited early with code ${code}`)),
      );
    });

    // The child is already hammering the file; write from this process
    // through the real fence at the same time.
    const stmt = dbOf(store).prepare(
      `INSERT INTO nodes (id, project_key, kind, name, status, revision, payload, created_at, updated_at)
       VALUES (?, '/conc', 'leaf', ?, 'draft', 1, '{}', ?, ?)`,
    );
    for (let i = 0; i < PARENT_WRITES; i++) {
      const now = Date.now();
      store.write(() => stmt.run(randomUUID(), "parent-" + i, now, now));
    }

    const [code] = (await once(child, "exit")) as [number];
    expect(code).toBe(0);

    const total = (
      dbOf(store)
        .prepare("SELECT COUNT(*) AS c FROM nodes WHERE project_key = '/conc'")
        .get() as { c: number }
    ).c;
    expect(total).toBe(CHILD_WRITES + PARENT_WRITES);
  }, 20_000);
});
