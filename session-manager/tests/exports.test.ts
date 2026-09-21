import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportAgentSession, exportDirectory } from "../server/exports";

/** Exports land in the Paseo home directory, one file per session. */
let root: string;
let acpxHome: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf-8");
}

function writeAcpxStore(recordId: string, file: string): void {
  writeJson(path.join(acpxHome, "sessions", `${file}.json`), { acpx_record_id: recordId });
  fs.writeFileSync(path.join(acpxHome, "sessions", `${file}.stream.ndjson`), '{"chunk":1}\n');
  writeJson(path.join(acpxHome, "sessions", "index.json"), {
    schema: "acpx.session-index.v1",
    files: [`${file}.json`],
    entries: [
      {
        file: `${file}.json`,
        acpxRecordId: recordId,
        closed: true,
        lastUsedAt: "2026-01-02T03:04:05.000Z",
      },
    ],
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-exports-"));
  acpxHome = path.join(root, "acpx");
  fs.mkdirSync(path.join(acpxHome, "sessions"), { recursive: true });
  process.env.ACPX_HOME = acpxHome;
  process.env.PASEO_HOME = path.join(root, "paseo");
});

afterEach(() => {
  delete process.env.ACPX_HOME;
  delete process.env.PASEO_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("exportAgentSession", () => {
  it("refuses an unknown provider", async () => {
    const result = await exportAgentSession({ provider: "nope", id: "a" });
    expect(result).toEqual({
      exported: false,
      path: null,
      bytes: null,
      error: 'Unknown provider "nope"',
    });
  });

  it("writes the record and the stream of an acpx session", async () => {
    writeAcpxStore("record-1", "record-1");

    const result = await exportAgentSession({ provider: "acpx", id: "record-1" });

    expect(result.exported).toBe(true);
    expect(result.error).toBeNull();
    expect(result.bytes).toBeGreaterThan(0);
    expect(path.basename(result.path ?? "")).toBe("acpx-record-1.ndjson");
    const content = fs.readFileSync(result.path as string, "utf-8");
    expect(content).toContain("acpx_record_id");
    expect(content).toContain('"chunk":1');
  });

  it("keeps a hostile session id inside the export directory", async () => {
    writeAcpxStore("../../escape", "escape");

    const result = await exportAgentSession({ provider: "acpx", id: "../../escape" });

    expect(result.exported).toBe(true);
    expect(path.dirname(result.path as string)).toBe(exportDirectory());
    expect(path.basename(result.path ?? "")).toBe("acpx-escape.ndjson");
  });

  it("reports a session with no data on disk", async () => {
    const result = await exportAgentSession({ provider: "acpx", id: "ghost" });
    expect(result.exported).toBe(false);
    expect(result.error).toBe("session record not found");
  });

  it("fails when the export directory cannot be created", async () => {
    writeAcpxStore("record-1", "record-1");
    // A file where the exports directory should be makes mkdir fail.
    fs.writeFileSync(path.join(root, "paseo"), "not a directory");

    const result = await exportAgentSession({ provider: "acpx", id: "record-1" });

    expect(result.exported).toBe(false);
    expect(result.path).toBeNull();
    expect(result.error).toBeTruthy();
  });
});
