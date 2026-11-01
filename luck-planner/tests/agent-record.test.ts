import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSavedMcpServers } from "../server/agent-record";

/**
 * The session-open collision check (`__doc.md` §10.8) reads the agent's saved
 * record the same way the daemon persists it: one JSON file per agent under
 * `<PASEO_HOME>/agents/<workspace>/`, with a `config.mcpServers` name map.
 * These tests pin the lookup's three-way contract — `found` / `missing` /
 * `unusable` — that the decision matrix in `server/session-open.ts` builds
 * on: "unknown" states must never be mistaken for "the agent does not have
 * the server" (that would double-inject on top of a saved config).
 */

let root: string;
let workspaceDir: string;
const AGENT = "agent-1";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "luck-agent-record-"));
  workspaceDir = path.join(root, "ws-1");
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRecord(record: unknown, id = AGENT): void {
  writeFileSync(path.join(workspaceDir, `${id}.json`), JSON.stringify(record));
}

describe("readSavedMcpServers", () => {
  it("returns the saved MCP server names of the agent record", () => {
    writeRecord({ config: { mcpServers: { "luck-planner": {}, git: {} } } });
    expect(readSavedMcpServers(AGENT, root)).toEqual({
      status: "found",
      savedServers: ["luck-planner", "git"],
    });
  });

  it("treats a record without an mcpServers map as found-but-empty (needs injection)", () => {
    writeRecord({ config: {} });
    expect(readSavedMcpServers(AGENT, root)).toEqual({
      status: "found",
      savedServers: [],
    });
  });

  it("reports missing when the agent has no record file", () => {
    expect(readSavedMcpServers(AGENT, root)).toEqual({ status: "missing" });
  });

  it("reports unusable when the file is not JSON (unknown state, never inject)", () => {
    writeFileSync(path.join(workspaceDir, `${AGENT}.json`), "{oops");
    const lookup = readSavedMcpServers(AGENT, root);
    expect(lookup.status).toBe("unusable");
  });

  it("reports unusable when the record has no config object", () => {
    writeRecord({ something: "else" });
    const lookup = readSavedMcpServers(AGENT, root);
    expect(lookup.status).toBe("unusable");
  });

  it("reports unusable when mcpServers is not a name map", () => {
    writeRecord({ config: { mcpServers: ["luck-planner"] } });
    const lookup = readSavedMcpServers(AGENT, root);
    expect(lookup.status).toBe("unusable");
  });

  it("finds the record in a second workspace directory (the scan continues)", () => {
    const other = path.join(root, "ws-2");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      path.join(other, `${AGENT}.json`),
      JSON.stringify({ config: { mcpServers: { "luck-planner": {} } } }),
    );
    expect(readSavedMcpServers(AGENT, root)).toEqual({
      status: "found",
      savedServers: ["luck-planner"],
    });
  });

  it("rejects an empty id (the record name would be the directory itself)", () => {
    const lookup = readSavedMcpServers("", root);
    expect(lookup.status).toBe("unusable");
  });

  it("never matches an id that escapes the agents root (path traversal guard)", () => {
    writeRecord({ config: { mcpServers: { "luck-planner": {} } } });
    // `<root>/ws-1/../../.json` normalizes outside the root: the lookup must
    // not read it and must not report the server as saved.
    expect(readSavedMcpServers("../..", root)).toEqual({ status: "missing" });
  });

  it("reports unusable when the agents root itself is unreadable", () => {
    const lookup = readSavedMcpServers(AGENT, path.join(root, "no-such-dir"));
    expect(lookup.status).toBe("unusable");
  });
});
