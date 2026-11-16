import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactAgentStores } from "../server/compact";

/**
 * SQLite compaction (0.6.0): `VACUUM` + `wal_checkpoint(TRUNCATE)` against the
 * databases of a provider's session store.
 *
 * The tests never run SQLite: the vacuum step is injected, so the suite checks
 * the decisions — which providers are compactable, which files are touched, how
 * the before/after numbers and failures are reported — without needing a
 * `sqlite3` binary on the build host. A real database is exercised once by hand
 * against the live stores (§22 of `__doc.md`).
 */

let root: string;
let dataHome: string;

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

/** A stand-in vacuum: truncates the file, which is what VACUUM does in size terms. */
function truncatingVacuum(sizeAfter: number) {
  const touched: string[] = [];
  return {
    touched,
    vacuum: async (file: string) => {
      touched.push(file);
      fs.writeFileSync(file, "x".repeat(sizeAfter));
      return { ok: true } as const;
    },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-compact-"));
  dataHome = path.join(root, "share");
  process.env.XDG_DATA_HOME = dataHome;
  process.env.CLINE_DATA_DIR = path.join(root, "cline", "data");
});

afterEach(() => {
  delete process.env.XDG_DATA_HOME;
  delete process.env.CLINE_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("compactAgentStores", () => {
  it("refuses an unknown provider", async () => {
    const result = await compactAgentStores({ provider: "nope" });
    expect(result).toEqual({
      ok: false,
      before: null,
      after: null,
      freed: null,
      databases: [],
      error: 'Unknown provider "nope"',
    });
  });

  it("says so when a provider keeps its sessions outside SQLite", async () => {
    const { vacuum, touched } = truncatingVacuum(10);
    const result = await compactAgentStores({ provider: "qwen-code" }, { vacuum });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside SQLite");
    expect(result.databases).toEqual([]);
    expect(touched).toEqual([]);
  });

  it("compacts opencode.db and reports the freed bytes", async () => {
    const database = path.join(dataHome, "opencode", "opencode.db");
    writeFile(database, "x".repeat(1000));
    const { vacuum, touched } = truncatingVacuum(400);

    const result = await compactAgentStores({ provider: "opencode" }, { vacuum });

    expect(touched).toEqual([database]);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.before).toBe(1000);
    expect(result.after).toBe(400);
    expect(result.freed).toBe(600);
    expect(result.databases).toEqual([
      {
        path: database,
        label: "opencode.db",
        before: 1000,
        after: 400,
        freed: 600,
        error: null,
      },
    ]);
  });

  it("counts the WAL in the before size, because truncating it is part of the win", async () => {
    const database = path.join(dataHome, "kilo", "kilo.db");
    writeFile(database, "x".repeat(1000));
    writeFile(`${database}-wal`, "w".repeat(500));
    // The real sequence is VACUUM + `wal_checkpoint(TRUNCATE)`: the main file
    // shrinks and the WAL goes to zero.
    const vacuum = async (file: string) => {
      fs.writeFileSync(file, "x".repeat(700));
      fs.writeFileSync(`${file}-wal`, "");
      return { ok: true } as const;
    };

    const result = await compactAgentStores({ provider: "kilo" }, { vacuum });

    expect(result.before).toBe(1500);
    expect(result.after).toBe(700);
    expect(result.freed).toBe(800);
  });

  it("compacts both session databases of Cline", async () => {
    const dbDir = path.join(root, "cline", "data", "db");
    const sessions = path.join(dbDir, "sessions.db");
    const search = path.join(dbDir, "session-search.db");
    writeFile(sessions, "x".repeat(300));
    writeFile(search, "x".repeat(700));
    // A hub telemetry database is not part of the session store and stays untouched.
    const hub = path.join(dbDir, "hub-events-hub-production.db");
    writeFile(hub, "x".repeat(9000));
    const { vacuum, touched } = truncatingVacuum(100);

    const result = await compactAgentStores({ provider: "cline" }, { vacuum });

    expect(touched).toEqual([sessions, search]);
    expect(result.ok).toBe(true);
    expect(result.before).toBe(1000);
    expect(result.after).toBe(200);
    expect(result.freed).toBe(800);
    expect(result.databases.map((entry) => entry.label)).toEqual([
      "sessions.db",
      "session-search.db",
    ]);
  });

  it("skips a database that was never created instead of failing", async () => {
    writeFile(path.join(root, "cline", "data", "db", "sessions.db"), "x".repeat(200));
    const { vacuum, touched } = truncatingVacuum(50);

    const result = await compactAgentStores({ provider: "cline" }, { vacuum });

    expect(touched).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.before).toBe(200);
  });

  it("reports 'never written' when no database of the store exists", async () => {
    const { vacuum } = truncatingVacuum(10);
    const result = await compactAgentStores({ provider: "opencode" }, { vacuum });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("has not written a session database");
    expect(result.databases).toEqual([]);
  });

  it("surfaces a locked database as a failure with the label in the message", async () => {
    const database = path.join(dataHome, "opencode", "opencode.db");
    writeFile(database, "x".repeat(1000));
    const vacuum = async () => ({ ok: false, error: "database is locked" }) as const;

    const result = await compactAgentStores({ provider: "opencode" }, { vacuum });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("opencode.db: database is locked");
    expect(result.databases[0]?.error).toBe("database is locked");
    expect(result.databases[0]?.before).toBe(1000);
    expect(result.databases[0]?.after).toBe(1000);
    expect(result.freed).toBe(0);
  });

  it("keeps the successful databases when one of two fails", async () => {
    const dbDir = path.join(root, "cline", "data", "db");
    const sessions = path.join(dbDir, "sessions.db");
    const search = path.join(dbDir, "session-search.db");
    writeFile(sessions, "x".repeat(300));
    writeFile(search, "x".repeat(700));
    const vacuum = async (file: string) =>
      file === sessions
        ? ({ ok: true } as const)
        : ({ ok: false, error: "file is not a database" } as const);

    const result = await compactAgentStores({ provider: "cline" }, { vacuum });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("session-search.db: file is not a database");
    expect(result.databases.map((entry) => entry.error)).toEqual([null, "file is not a database"]);
  });
});
