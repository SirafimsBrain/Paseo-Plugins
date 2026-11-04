import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { readRestoreSource, replaceDatabase } from "../server/restore";
import { snapshotDatabase, snapshotFileName } from "../server/snapshot";
import { LuckPlannerStore } from "../server/store";

/**
 * Stage L4 acceptance: a snapshot goes back in.
 *
 * The order under test is the safety: the picked file is copied and verified,
 * the swap removes the stale `-wal`, and a database that fails to open leaves
 * the previous file in place instead of leaving the plugin without one.
 *
 * Real SQLite files in a temp directory, no mocks.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const ACTOR = "agent:coder";
const AT = Date.UTC(2026, 10, 4, 14, 5, 30);

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-restore-"));
  dirs.push(dir);
  return dir;
}

function openStore(dbPath?: string): LuckPlannerStore {
  const store = new LuckPlannerStore({
    dbPath: dbPath ?? path.join(tempDir(), "luck-planner.db"),
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** root → trunk → leaf, three rows; enough to tell states apart by name. */
function seed(store: LuckPlannerStore): void {
  const root = store.createNode({
    projectKey: P,
    parentId: null,
    kind: "root",
    name: "Tech stack",
    actor: ACTOR,
  });
  const trunk = store.createNode({
    projectKey: P,
    parentId: root.id,
    kind: "trunk",
    name: "Platform",
    actor: ACTOR,
  });
  store.createNode({
    projectKey: P,
    parentId: trunk.id,
    kind: "branch",
    name: "billing",
    actor: ACTOR,
  });
}

/** Closes `store`, swaps `file` in and opens the result — what the daemon does. */
function restore(store: LuckPlannerStore, file: string): LuckPlannerStore {
  const dbPath = store.dbPath;
  const source = readRestoreSource(file, dbPath);
  try {
    store.close();
    replaceDatabase(dbPath, source, () => {});
  } finally {
    source.cleanup();
  }
  return openStore(dbPath);
}

function names(store: LuckPlannerStore): string[] {
  return store
    .listNodes(P, { includeArchived: true })
    .map((node) => node.name)
    .sort();
}

describe("restore a snapshot", () => {
  it("puts the snapshot back and drops everything written after it", () => {
    const store = openStore();
    seed(store);
    const file = snapshotDatabase(store, { at: AT }).file;

    const schemaVersion = store.schemaVersion;
    store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "after the snapshot",
      actor: ACTOR,
    });
    expect(names(store)).toContain("after the snapshot");

    const restored = restore(store, file);
    expect(names(restored)).toEqual(["Platform", "Tech stack", "billing"]);
    expect(restored.schemaVersion).toBe(schemaVersion);
  });

  it("accepts an extracted .db as well as the archive", () => {
    const store = openStore();
    seed(store);
    const file = snapshotDatabase(store, { at: AT }).file;
    // Unzip by hand the way a user would, then restore from the plain file:
    // the whole point of the zip is that it opens in any file manager.
    const archive = readFileSync(file);
    const extracted = path.join(tempDir(), "extracted.db");
    const entries = unzipSync(archive);
    writeFileSync(extracted, entries[Object.keys(entries)[0]]);

    store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "after the snapshot",
      actor: ACTOR,
    });
    const restored = restore(store, extracted);
    expect(names(restored)).not.toContain("after the snapshot");
  });

  it("removes the previous write-ahead log with the swap", () => {
    const store = openStore();
    seed(store);
    const file = snapshotDatabase(store, { at: AT }).file;
    const dbPath = store.dbPath;

    store.close();
    // A log that belongs to the file being replaced. Left in place it would be
    // replayed onto the restored database and resurrect the old state.
    writeFileSync(`${dbPath}-wal`, "stale frames\n");
    writeFileSync(`${dbPath}-shm`, "stale index\n");
    const source = readRestoreSource(file, dbPath);
    try {
      replaceDatabase(dbPath, source, () => {});
    } finally {
      source.cleanup();
    }
    // Checked before reopening: a reopened store legitimately creates a fresh
    // log again, so the assertion is about the log that came *with* the file.
    const siblings = readdirSync(path.dirname(dbPath));
    expect(siblings).not.toContain("luck-planner.db-wal");
    expect(siblings).not.toContain("luck-planner.db-shm");

    const reopened = openStore(dbPath);
    expect(names(reopened)).toEqual(["Platform", "Tech stack", "billing"]);
  });

  it("keeps the previous database when the restored one does not open", () => {
    const store = openStore();
    seed(store);
    const file = snapshotDatabase(store, { at: AT }).file;
    store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "only in the live database",
      actor: ACTOR,
    });
    const dbPath = store.dbPath;
    const source = readRestoreSource(file, dbPath);
    store.close();

    // The first open of the restored file fails; the rollback puts the old
    // file back and the second open succeeds — the branch a real broken
    // snapshot would take.
    let attempts = 0;
    try {
      expect(() =>
        replaceDatabase(dbPath, source, () => {
          attempts += 1;
          if (attempts === 1) throw new Error("cannot open restored database");
        }),
      ).toThrow(/previous data kept/);
    } finally {
      source.cleanup();
    }

    // The old file is back in place, so the plugin is not left without a
    // database — the restore failed, the tree did not.
    const reopened = openStore(dbPath);
    expect(names(reopened)).toContain("only in the live database");
  });
});

describe("restore source validation", () => {
  function snapshotFile(): string {
    const store = openStore();
    seed(store);
    return snapshotDatabase(store, { at: AT }).file;
  }

  it("refuses a relative path and a file that is not there", () => {
    const dbPath = path.join(tempDir(), "luck-planner.db");
    expect(() => readRestoreSource("relative.zip", dbPath)).toThrow(/must be absolute/);
    expect(() => readRestoreSource(path.join(tempDir(), "missing.zip"), dbPath)).toThrow(
      /no such file/,
    );
  });

  it("refuses an archive that does not hold exactly one database", () => {
    const dbPath = path.join(tempDir(), "luck-planner.db");
    const two = path.join(tempDir(), "two.db.zip");
    writeFileSync(two, zipSync({ "a.db": strToU8("x"), "b.db": strToU8("y") }));
    expect(() => readRestoreSource(two, dbPath)).toThrow(/exactly one database entry/);

    const none = path.join(tempDir(), "none.db.zip");
    writeFileSync(none, zipSync({ "readme.txt": strToU8("hello") }));
    expect(() => readRestoreSource(none, dbPath)).toThrow(/found 0 of 1/);
  });

  it("refuses a file that is not a database", () => {
    const dbPath = path.join(tempDir(), "luck-planner.db");
    const file = path.join(tempDir(), "not-a-db.db");
    writeFileSync(file, "just text\n");
    expect(() => readRestoreSource(file, dbPath)).toThrow();
    // Nothing is left behind by the failed attempt: the temp copy is removed.
    expect(readdirSync(path.dirname(dbPath))).toEqual([]);
  });

  it("refuses a snapshot written by a newer plugin version", () => {
    const dbPath = path.join(tempDir(), "luck-planner.db");
    const file = snapshotFile();
    // A database this plugin cannot migrate downwards: the store refuses it at
    // open, so the swap must never happen in the first place.
    const bump = path.join(tempDir(), "newer.db");
    const entries = unzipSync(readFileSync(file));
    writeFileSync(bump, entries[Object.keys(entries)[0]]);
    const raw = new DatabaseSync(bump);
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    raw.close();

    expect(() => readRestoreSource(bump, dbPath)).toThrow(/newer than the supported/);
    expect(readdirSync(path.dirname(dbPath))).toEqual([]);
  });

  it("never touches the file it was given", () => {
    const dbPath = path.join(tempDir(), "luck-planner.db");
    const file = snapshotFile();
    const before = readFileSync(file);
    const source = readRestoreSource(file, dbPath);
    source.cleanup();
    expect(readFileSync(file)).toEqual(before);
  });
});

describe("snapshot labels", () => {
  it("marks the automatic pre-restore copy in its name", () => {
    // The stamp is local wall-clock, so the format is what a test can pin.
    expect(snapshotFileName(AT)).toMatch(/^luck-planner-\d{8}-\d{6}\.db\.zip$/);
    expect(snapshotFileName(AT, "pre-restore")).toMatch(
      /^luck-planner-pre-restore-\d{8}-\d{6}\.db\.zip$/,
    );
    const store = openStore();
    seed(store);
    const result = snapshotDatabase(store, { at: AT, label: "pre-restore" });
    expect(path.basename(result.file)).toBe(snapshotFileName(AT, "pre-restore"));
  });
});
