import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kimiProvider } from "../server/providers/kimi";

vi.mock("../server/exec", () => ({
  resolveBinary: () => null,
  runCli: async () => ({ ok: false, error: "mocked" }),
}));

/**
 * Kimi Code CLI exposes no `session list` / `session delete` command, so this
 * adapter reads $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/ directly and
 * deletes from disk. The tests build a store on disk and check that only the
 * requested session's directory disappears, because a mistake here destroys
 * transcripts.
 */

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const WORKDIR = "abcd1234-workspace-key";

let kimiHome: string;

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function sessionDir(id: string): string {
  return path.join(kimiHome, "sessions", WORKDIR, id);
}

function writeSession(id: string, state: Record<string, unknown>): void {
  writeFile(path.join(sessionDir(id), "state.json"), JSON.stringify(state));
}

function writeIndex(records: Record<string, unknown>[]): void {
  writeFile(
    path.join(kimiHome, "session_index.jsonl"),
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
}

function writeLock(id: string): void {
  writeFile(path.join(kimiHome, "locks", "sessions", id, ".lock"), "");
}

function exists(target: string): boolean {
  return fs.existsSync(target);
}

beforeEach(() => {
  kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-kimi-"));
  process.env.KIMI_CODE_HOME = kimiHome;
});

afterEach(() => {
  delete process.env.KIMI_CODE_HOME;
  fs.rmSync(kimiHome, { recursive: true, force: true });
});

describe("kimi list", () => {
  it("reads sessions from disk and maps state.json fields", async () => {
    writeSession(SESSION, {
      title: "Fix the parser",
      createdAt: 1_700_000_000_000,
      lastActivity: 1_700_000_100_000,
    });
    writeSession(OTHER, { title: "Other session" });
    writeIndex([
      { id: SESSION, title: "Index title", cwd: "/tmp/workspace" },
      { id: OTHER },
    ]);

    const result = await kimiProvider.list();
    const session = result.sessions.find((entry) => entry.id === SESSION);

    expect(session).toBeDefined();
    expect(session?.title).toBe("Fix the parser");
    expect(session?.cwd).toBe("/tmp/workspace");
    expect(session?.createdAt).toBe("2023-11-14T22:13:20.000Z");
    expect(session?.running).toBe(false);
    expect(session?.sizeBytes).toBeGreaterThan(0);
    expect(result.detected).toBe(true);
    expect(result.deletable).toBe(true);
    expect(result.detail).toBe(path.join(kimiHome, "sessions"));
    expect(result.storeBytes).toBeGreaterThan(0);
  });

  it("falls back to the directory mtime when no timestamp is recorded", async () => {
    writeSession(SESSION, {});
    const result = await kimiProvider.list();
    expect(result.sessions[0]?.updatedAt).not.toBeNull();
  });

  it("marks a session as running while its occupancy lock exists", async () => {
    writeSession(SESSION, {});
    writeLock(SESSION);

    const result = await kimiProvider.list();
    expect(result.sessions[0]?.running).toBe(true);
  });

  it("ignores a lock directory whose name is not a real session", async () => {
    writeSession(SESSION, {});
    writeLock("does-not-exist");

    const result = await kimiProvider.list();
    expect(result.sessions[0]?.running).toBe(false);
  });

  it("reports an empty result when the store does not exist", async () => {
    const result = await kimiProvider.list();
    expect(result.sessions).toEqual([]);
    expect(result.detected).toBe(false);
  });
});

describe("kimi delete", () => {
  it("removes only the requested session directory and its index entry", async () => {
    writeSession(SESSION, {});
    writeSession(OTHER, {});
    writeIndex([{ id: SESSION }, { id: OTHER }]);

    const result = await kimiProvider.delete([SESSION]);

    expect(result.deleted).toEqual([SESSION]);
    expect(result.failures).toEqual([]);
    expect(exists(sessionDir(SESSION))).toBe(false);
    expect(exists(sessionDir(OTHER))).toBe(true);

    // The index entry for the deleted session is pruned.
    const index = fs
      .readFileSync(path.join(kimiHome, "session_index.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(index.map((record) => record.id)).toEqual([OTHER]);
  });

  it("reports a session whose directory is already gone", async () => {
    const result = await kimiProvider.delete(["missing"]);
    expect(result.deleted).toEqual([]);
    expect(result.failures).toEqual([
      { id: "missing", error: "session directory not found" },
    ]);
  });
});

describe("kimi export", () => {
  it("reports cannot export when the kimi CLI is not installed", async () => {
    writeSession(SESSION, {});
    const outPath = path.join(kimiHome, "out", "copy.zip");

    const result = await kimiProvider.exportSession?.({
      id: SESSION,
      outPath,
    });

    expect(result).toEqual({
      ok: false,
      error: "CLI \"kimi\" not found; cannot export",
    });
    expect(kimiProvider.exportExtension).toBe("zip");
  });
});
