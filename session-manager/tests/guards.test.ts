import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteAgentSession,
  deleteAgentSessionsBatch,
  invalidateListing,
} from "../server/session-manager";

/**
 * The guards run against the real provider registry and a real store on disk.
 * `acpx` is used because its store is plain JSON, so a test can build a session,
 * point a Paseo agent record at it, and observe exactly what the guard refuses
 * without mocking the registry (which would also hide wiring mistakes).
 */
let root: string;
let acpxHome: string;
let paseoHome: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

interface AcpxIndex {
  schema: string;
  files: string[];
  entries: { acpxRecordId: string; [key: string]: unknown }[];
}

function readAcpxIndex(): AcpxIndex {
  const file = path.join(acpxHome, "sessions", "index.json");
  if (!fs.existsSync(file)) {
    return { schema: "acpx.session-index.v1", files: [], entries: [] };
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as AcpxIndex;
}

function writeAcpxSession(input: { id: string; closed?: boolean; cwd?: string }): void {
  const file = `${input.id}.json`;
  const closed = input.closed ?? true;
  writeJson(path.join(acpxHome, "sessions", file), {
    acpx_record_id: input.id,
    acp_session_id: `acp-${input.id}`,
    cwd: input.cwd ?? "/tmp/workspace",
    closed,
    last_used_at: "2026-01-02T03:04:05.000Z",
  });
  fs.writeFileSync(path.join(acpxHome, "sessions", `${input.id}.stream.ndjson`), "{}\n", "utf-8");

  const index = readAcpxIndex();
  writeJson(path.join(acpxHome, "sessions", "index.json"), {
    schema: index.schema,
    files: [...new Set([...index.files, file])],
    entries: [
      ...index.entries.filter((entry) => entry.acpxRecordId !== input.id),
      {
        file,
        acpxRecordId: input.id,
        cwd: input.cwd ?? "/tmp/workspace",
        closed,
        lastUsedAt: "2026-01-02T03:04:05.000Z",
      },
    ],
  });
}

/** Simulates a session removed outside the plugin, without touching the cache. */
function removeAcpxRecord(id: string): void {
  fs.rmSync(path.join(acpxHome, "sessions", `${id}.json`), { force: true });
  fs.rmSync(path.join(acpxHome, "sessions", `${id}.stream.ndjson`), { force: true });
  const index = readAcpxIndex();
  writeJson(path.join(acpxHome, "sessions", "index.json"), {
    schema: index.schema,
    files: index.files.filter((file) => file !== `${id}.json`),
    entries: index.entries.filter((entry) => entry.acpxRecordId !== id),
  });
}

function writePaseoAgent(input: {
  agentId: string;
  sessionId: string;
  title: string;
  archived?: boolean;
}): void {
  writeJson(path.join(paseoHome, "agents", "workspace-1", `${input.agentId}.json`), {
    id: input.agentId,
    title: input.title,
    provider: "acpx",
    archivedAt: input.archived ? "2026-01-03T00:00:00.000Z" : null,
    persistence: { sessionId: input.sessionId },
    runtimeInfo: { sessionId: input.sessionId },
  });
}

function acpxSessionExists(id: string): boolean {
  return fs.existsSync(path.join(acpxHome, "sessions", `${id}.json`));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-guards-"));
  acpxHome = path.join(root, "acpx");
  paseoHome = path.join(root, "paseo");
  fs.mkdirSync(path.join(acpxHome, "sessions"), { recursive: true });
  fs.mkdirSync(paseoHome, { recursive: true });
  process.env.ACPX_HOME = acpxHome;
  process.env.PASEO_HOME = paseoHome;
  // Every test gets a fresh store under a new temp directory, so the process
  // level listing cache must not carry data across tests.
  invalidateListing();
});

afterEach(() => {
  delete process.env.ACPX_HOME;
  delete process.env.PASEO_HOME;
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("deleteAgentSession guards", () => {
  it("deletes a closed session that no Paseo agent references", async () => {
    writeAcpxSession({ id: "session-free" });
    const result = await deleteAgentSession({ provider: "acpx", id: "session-free" });

    expect(result).toEqual({ deleted: true, error: null });
    expect(acpxSessionExists("session-free")).toBe(false);
  });

  it("refuses an unknown provider", async () => {
    const result = await deleteAgentSession({ provider: "nope", id: "session-free" });
    expect(result.deleted).toBe(false);
    expect(result.error).toBe('Unknown provider "nope"');
  });

  it("refuses a session the store does not have", async () => {
    writeAcpxSession({ id: "session-free" });
    const result = await deleteAgentSession({ provider: "acpx", id: "ghost" });
    expect(result).toEqual({ deleted: false, error: "Session not found" });
  });

  it("refuses a running session until force is passed", async () => {
    writeAcpxSession({ id: "session-live", closed: false });

    const refused = await deleteAgentSession({ provider: "acpx", id: "session-live" });
    expect(refused.deleted).toBe(false);
    expect(refused.error).toContain("still running");
    expect(acpxSessionExists("session-live")).toBe(true);

    const forced = await deleteAgentSession({
      provider: "acpx",
      id: "session-live",
      force: true,
    });
    expect(forced).toEqual({ deleted: true, error: null });
    expect(acpxSessionExists("session-live")).toBe(false);
  });

  it("refuses a session an open Paseo agent still references", async () => {
    writeAcpxSession({ id: "session-linked" });
    writePaseoAgent({
      agentId: "agent-1",
      sessionId: "session-linked",
      title: "Refactor the parser",
    });

    const refused = await deleteAgentSession({ provider: "acpx", id: "session-linked" });
    expect(refused.deleted).toBe(false);
    expect(refused.error).toContain('open Paseo agent "Refactor the parser"');
    expect(acpxSessionExists("session-linked")).toBe(true);
  });

  it("deletes a session of an archived Paseo agent without force", async () => {
    writeAcpxSession({ id: "session-archived" });
    writePaseoAgent({
      agentId: "agent-2",
      sessionId: "session-archived",
      title: "Old work",
      archived: true,
    });

    const result = await deleteAgentSession({ provider: "acpx", id: "session-archived" });
    expect(result).toEqual({ deleted: true, error: null });
  });
});

describe("deleteAgentSessionsBatch", () => {
  it("deletes the allowed targets and reports the refused ones", async () => {
    writeAcpxSession({ id: "free" });
    writeAcpxSession({ id: "linked" });
    writePaseoAgent({ agentId: "agent-1", sessionId: "linked", title: "Open agent" });
    writeAcpxSession({ id: "live", closed: false });

    const result = await deleteAgentSessionsBatch({
      targets: [
        { provider: "acpx", id: "free" },
        { provider: "acpx", id: "linked" },
        { provider: "acpx", id: "live" },
        { provider: "ghost-provider", id: "free" },
      ],
    });

    expect(result.deleted).toBe(1);
    expect(result.failures).toEqual([
      {
        provider: "acpx",
        id: "linked",
        error: 'Session belongs to open Paseo agent "Open agent". Archive it in Paseo first, or delete with force.',
      },
      {
        provider: "acpx",
        id: "live",
        error: "Session is still running. Stop the agent first, or delete with force.",
      },
      { provider: "ghost-provider", id: "free", error: 'Unknown provider "ghost-provider"' },
    ]);
    expect(acpxSessionExists("free")).toBe(false);
    expect(acpxSessionExists("linked")).toBe(true);
    expect(acpxSessionExists("live")).toBe(true);
  });

  it("force-deletes risky targets and keeps the other sessions", async () => {
    writeAcpxSession({ id: "live", closed: false });
    writeAcpxSession({ id: "linked" });
    writeAcpxSession({ id: "bystander" });
    writePaseoAgent({ agentId: "agent-1", sessionId: "linked", title: "Open agent" });

    const result = await deleteAgentSessionsBatch({
      targets: [
        { provider: "acpx", id: "live" },
        { provider: "acpx", id: "linked" },
      ],
      force: true,
    });

    expect(result.deleted).toBe(2);
    expect(result.failures).toEqual([]);
    expect(acpxSessionExists("live")).toBe(false);
    expect(acpxSessionExists("linked")).toBe(false);
    expect(acpxSessionExists("bystander")).toBe(true);
  });

  it("removes the index entries of the deleted sessions", async () => {
    writeAcpxSession({ id: "a" });
    writeAcpxSession({ id: "b" });

    await deleteAgentSessionsBatch({ targets: [{ provider: "acpx", id: "a" }] });

    const index = readAcpxIndex();
    expect(index.entries.map((entry) => entry.acpxRecordId)).toEqual(["b"]);
    expect(index.files).toEqual(["b.json"]);
  });
});

describe("listing cache", () => {
  it("invalidates the listing of a provider it just changed", async () => {
    writeAcpxSession({ id: "a" });

    const first = await deleteAgentSession({ provider: "acpx", id: "a" });
    expect(first.deleted).toBe(true);

    // The second attempt must not reuse the listing that still contained `a`.
    const second = await deleteAgentSession({ provider: "acpx", id: "a" });
    expect(second).toEqual({ deleted: false, error: "Session not found" });
  });

  it("serves the warm listing to the next guard check", async () => {
    writeAcpxSession({ id: "warm" });

    // A refused target only reads the store; it warms the cache and nothing else.
    await deleteAgentSessionsBatch({ targets: [{ provider: "acpx", id: "ghost" }] });
    removeAcpxRecord("warm");

    const result = await deleteAgentSessionsBatch({
      targets: [{ provider: "acpx", id: "warm" }],
    });

    // The guard still saw the cached session, so the failure came from the store.
    expect(result.failures).toEqual([
      { provider: "acpx", id: "warm", error: "session record not found" },
    ]);
  });

  it("drops a warm listing after the TTL expires", async () => {
    vi.useFakeTimers();
    writeAcpxSession({ id: "warm" });

    await deleteAgentSessionsBatch({ targets: [{ provider: "acpx", id: "ghost" }] });
    removeAcpxRecord("warm");
    vi.advanceTimersByTime(31_000);

    const result = await deleteAgentSessionsBatch({
      targets: [{ provider: "acpx", id: "warm" }],
    });

    expect(result.failures).toEqual([
      { provider: "acpx", id: "warm", error: "Session not found" },
    ]);
  });
});
