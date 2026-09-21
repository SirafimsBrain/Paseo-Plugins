import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asRecord,
  asString,
  directorySize,
  firstLine,
  pathSize,
  safeFileSegment,
  sqliteSize,
  toIso,
} from "../server/util";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-util-"));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string): string {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  return target;
}

describe("toIso", () => {
  it("accepts epoch seconds, epoch milliseconds, and ISO strings", () => {
    expect(toIso(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(toIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(toIso("2023-11-14T22:13:20.000Z")).toBe("2023-11-14T22:13:20.000Z");
  });

  it("returns null for values that are not timestamps", () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso("")).toBeNull();
    expect(toIso("not a date")).toBeNull();
    expect(toIso(Number.NaN)).toBeNull();
  });
});

describe("firstLine", () => {
  it("strips Paseo's user_input wrapper and truncates", () => {
    expect(firstLine('<user_input mode="act">\nFix the bug\nsecond line')).toBe("Fix the bug");
    expect(firstLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(firstLine(undefined)).toBeNull();
    expect(firstLine("   \n  ")).toBeNull();
  });
});

describe("size helpers", () => {
  it("sums a directory tree, including nested directories", () => {
    write("tree/a.txt", "12345");
    write("tree/nested/b.txt", "123");
    expect(directorySize(path.join(root, "tree"))).toBe(8);
  });

  it("measures a file, a directory, or nothing at all", () => {
    const file = write("single.txt", "abc");
    expect(pathSize(file)).toBe(3);
    expect(pathSize(path.join(root, "tree"))).toBe(8);
    expect(pathSize(path.join(root, "missing"))).toBeNull();
  });

  it("adds the SQLite sidecar files to the store size", () => {
    const db = write("store.db", "1234");
    write("store.db-wal", "123");
    write("store.db-shm", "1");
    expect(sqliteSize(db)).toBe(8);
    expect(sqliteSize(path.join(root, "nothing.db"))).toBeNull();
  });
});

describe("safeFileSegment", () => {
  it("turns arbitrary ids into a single safe segment", () => {
    expect(safeFileSegment("../../escape")).toBe("escape");
    expect(safeFileSegment("ses_abc-123.json")).toBe("ses_abc-123.json");
    expect(safeFileSegment("a/b c")).toBe("a_b_c");
    expect(safeFileSegment("...")).toBe("session");
    expect(safeFileSegment("x".repeat(400))).toHaveLength(120);
  });
});

describe("value helpers", () => {
  it("only accepts objects as records and non-empty strings as strings", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBeNull();
    expect(asRecord("nope")).toBeNull();
    expect(asString("value")).toBe("value");
    expect(asString("")).toBeNull();
    expect(asString(7)).toBeNull();
  });
});
