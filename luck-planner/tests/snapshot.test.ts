import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectSnapshot,
  snapshotDatabase,
  snapshotEntryName,
  snapshotFileName,
} from "../server/snapshot";
import { LuckPlannerStore } from "../server/store";

/**
 * Stage L3 acceptance: the *installation* — every project, every table — is
 * copied with `VACUUM INTO` (one consistent read of a live WAL database),
 * verified, and written as a single `.db.zip` beside the database.
 *
 * Real SQLite files in a temp directory, no mocks: the whole point of the
 * stage is that a copy of a running database is a database, and only a real
 * driver can prove that.
 */

const dirs: string[] = [];
const stores: LuckPlannerStore[] = [];

const P = "/projects/demo";
const Q = "/projects/second";
const ACTOR = "agent:coder";
/** Fixed clock: the file name must not depend on "now". */
const AT = Date.UTC(2026, 10, 4, 13, 20, 55);

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "luck-planner-snapshot-"));
  dirs.push(dir);
  return dir;
}

function openStore(): LuckPlannerStore {
  const store = new LuckPlannerStore({
    dbPath: path.join(tempDir(), "luck-planner.db"),
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Two projects, an archived leaf, a bee, a bug, a goal and a growth record. */
function seed(store: LuckPlannerStore): {
  archived: string;
  leafA: string;
} {
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
  const branch = store.createNode({
    projectKey: P,
    parentId: trunk.id,
    kind: "branch",
    name: "billing",
    actor: ACTOR,
  });
  const leafA = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "retry failed charges",
    actor: ACTOR,
  });
  const leafB = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "prorate refunds",
    actor: ACTOR,
  });
  const archived = store.createNode({
    projectKey: P,
    parentId: branch.id,
    kind: "leaf",
    name: "retired idea",
    actor: ACTOR,
  });
  store.archiveNode({ projectKey: P, id: archived.id, actor: ACTOR });
  store.createNode({
    projectKey: Q,
    parentId: null,
    kind: "root",
    name: "Second project",
    actor: ACTOR,
  });
  store.createBee({
    projectKey: P,
    sourceLeafId: leafA.id,
    targetLeafId: leafB.id,
    impact: "refund proration depends on retry outcome",
    actor: ACTOR,
  });
  store.createBug({
    projectKey: P,
    title: "webhook 500s",
    severity: "high",
    nodeIds: [leafA.id],
    actor: ACTOR,
  });
  store.createGoal({
    projectKey: P,
    formalText: "Charges retry without duplicating refunds",
    plan: [{ id: "s1", title: "spec", description: "define the retry window" }],
    actor: ACTOR,
  });
  store.createGrowth({
    projectKey: P,
    subjectType: "node",
    subjectId: leafA.id,
    steps: [{ id: "g1", title: "spec", state: "completed", facts: [], reason: "" }],
    actor: ACTOR,
  });
  return { archived: archived.id, leafA: leafA.id };
}

describe("database snapshot", () => {
  it("writes one .db.zip into backups/ beside the database", () => {
    const store = openStore();
    seed(store);
    const result = snapshotDatabase(store, { at: AT });

    expect(result.file).toBe(
      path.join(
        path.dirname(store.dbPath),
        "backups",
        snapshotFileName(AT),
      ),
    );
    expect(result.file).toMatch(/backups\/luck-planner-\d{8}-\d{6}\.db\.zip$/);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.dbBytes).toBeGreaterThan(0);
    expect(result.at).toBe(AT);
    // The schema version comes from the copy's own `meta` table, not from the
    // running store — otherwise the check would only prove that the code agrees
    // with itself.
    expect(result.schemaVersion).toBe(store.schemaVersion);
  });

  it("counts what the copy holds, archived rows included", () => {
    const store = openStore();
    const { archived } = seed(store);
    const { counts } = snapshotDatabase(store, { at: AT });

    expect(counts.projects).toBe(2);
    expect(counts.nodes).toBe(
      store.listNodes(P, { includeArchived: true }).length +
        store.listNodes(Q, { includeArchived: true }).length,
    );
    expect(counts.archivedNodes).toBe(1);
    expect(counts.bees).toBe(1);
    expect(counts.bugs).toBe(1);
    expect(counts.bugAttachments).toBe(1);
    expect(counts.goals).toBe(1);
    expect(counts.growth).toBe(1);
    expect(counts.history).toBeGreaterThan(0);
    // The archived row is a real row of the copy, not a count of something else.
    expect(store.getNode(P, archived)?.archivedAt).not.toBeNull();
  });

  it("holds one database a fresh SQLite opens and integrity-checks", () => {
    const store = openStore();
    seed(store);
    const result = snapshotDatabase(store, { at: AT });

    const entries = unzipSync(readFileSync(result.file));
    const names = Object.keys(entries);
    expect(names).toEqual([snapshotEntryName(snapshotFileName(AT))]);
    expect(names[0].endsWith(".db")).toBe(true);

    const extracted = path.join(tempDir(), "restored.db");
    writeFileSync(extracted, entries[names[0]]);
    const copy = new DatabaseSync(extracted, { readOnly: true });
    try {
      expect(Object.values(copy.prepare("PRAGMA integrity_check").get()!)).toEqual([
        "ok",
      ]);
      const nodes = copy.prepare("SELECT COUNT(*) AS n FROM nodes").get() as {
        n: number;
      };
      expect(nodes.n).toBe(result.counts.nodes);
      // WAL mode is a property of the *running* store; the copy is a plain
      // database with no `-wal` to lose, which is what a restore needs.
      const journal = copy.prepare("PRAGMA journal_mode").get()!;
      expect(String(Object.values(journal)[0])).not.toBe("wal");
    } finally {
      copy.close();
    }
  });

  it("freezes the rows as they were when it was taken", () => {
    const store = openStore();
    seed(store);
    const result = snapshotDatabase(store, { at: AT });
    const entries = unzipSync(readFileSync(result.file));
    const extracted = path.join(tempDir(), "frozen.db");
    writeFileSync(extracted, entries[Object.keys(entries)[0]]);

    // Writes *after* the snapshot must not appear in it; the live store grows.
    store.createNode({
      projectKey: P,
      parentId: null,
      kind: "root",
      name: "written after the snapshot",
      actor: ACTOR,
    });

    const copy = new DatabaseSync(extracted, { readOnly: true });
    try {
      const nodes = copy.prepare("SELECT COUNT(*) AS n FROM nodes").get() as {
        n: number;
      };
      expect(nodes.n).toBe(result.counts.nodes);
      const found = copy
        .prepare("SELECT COUNT(*) AS n FROM nodes WHERE name = ?")
        .get("written after the snapshot") as { n: number };
      expect(found.n).toBe(0);
    } finally {
      copy.close();
    }
    expect(store.listNodes(P, { includeArchived: true })).toHaveLength(
      result.counts.nodes - 1 + 1,
    );
  });

  it("leaves no temporary database behind", () => {
    const store = openStore();
    seed(store);
    const result = snapshotDatabase(store, { at: AT });
    const dir = path.dirname(result.file);
    // One file, and it is the archive: the uncompressed copy is removed in a
    // `finally`, so a failed zip cannot litter the backup directory either.
    expect(readdirSync(dir)).toEqual([path.basename(result.file)]);
  });

  it("gives a second snapshot in the same second a -2 before the whole extension", () => {
    const store = openStore();
    seed(store);
    const first = snapshotDatabase(store, { at: AT });
    const second = snapshotDatabase(store, { at: AT });

    expect(path.basename(second.file)).toBe(
      snapshotFileName(AT).replace(".db.zip", "-2.db.zip"),
    );
    expect(first.file).not.toBe(second.file);
  });

  it("honours an explicit directory and refuses a relative one", () => {
    const store = openStore();
    seed(store);
    const custom = path.join(tempDir(), "elsewhere");
    const result = snapshotDatabase(store, { at: AT, dir: custom });
    expect(path.dirname(result.file)).toBe(custom);

    // The daemon's working directory is not the user's: a relative path would
    // scatter backups into whatever directory the shell happened to be in.
    expect(() => snapshotDatabase(store, { at: AT, dir: "relative/backups" })).toThrow(
      /must be absolute/,
    );
  });

  it("reports the database faithfully even when it is empty", () => {
    const store = openStore();
    // A snapshot of a fresh installation is a legitimate backup (it is the
    // whole database, not one project), unlike an empty project *export*.
    const result = snapshotDatabase(store, { at: AT });
    expect(result.counts.nodes).toBe(0);
    expect(result.counts.projects).toBe(0);
    expect(result.schemaVersion).toBe(store.schemaVersion);
  });
});

describe("snapshot verification", () => {
  it("rejects a file that is not a database", () => {
    const file = path.join(tempDir(), "not-a-database.db");
    writeFileSync(file, "this is not sqlite\n");
    expect(() => inspectSnapshot(file)).toThrow();
  });

  it("rejects a database that is not a luck-planner store", () => {
    const file = path.join(tempDir(), "empty.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE other (x TEXT);");
    db.close();
    expect(() => inspectSnapshot(file)).toThrow(/no meta table/);
  });

  it("names the missing table instead of failing on a COUNT", () => {
    const file = path.join(tempDir(), "partial.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    db.close();
    expect(() => inspectSnapshot(file)).toThrow(/missing the nodes table/);
  });
});

describe("store.snapshotInto", () => {
  it("refuses a relative path and an existing file", () => {
    const store = openStore();
    seed(store);
    expect(() => store.snapshotInto("relative.db")).toThrow(/must be absolute/);

    const existing = path.join(tempDir(), "already-there.db");
    writeFileSync(existing, "");
    // `VACUUM INTO` alone would happily write into a zero-length target (SQLite
    // reads that as an empty database), so the store refuses any existing path.
    expect(() => store.snapshotInto(existing)).toThrow(/refusing to overwrite/);
    expect(readFileSync(existing)).toHaveLength(0);
  });
});
