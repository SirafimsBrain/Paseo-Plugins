import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { agentsRoot, readSavedMcpServers } from "../server/agent-record";

const homes: string[] = [];
let currentHome = "";
let root = "";

beforeEach(() => {
  currentHome = mkdtempSync(path.join(tmpdir(), "cc-agent-record-"));
  homes.push(currentHome);
  root = agentsRoot(currentHome);
});

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function writeRecord(workspace: string, agentId: string, record: unknown): void {
  mkdirSync(path.join(root, workspace), { recursive: true });
  writeFileSync(
    path.join(root, workspace, `${agentId}.json`),
    typeof record === "string" ? record : JSON.stringify(record),
    "utf-8",
  );
}

describe("readSavedMcpServers", () => {
  it("returns the saved MCP keys of the agent record", () => {
    writeRecord("ws-slug", "agent-1", {
      config: { mcpServers: { github: { type: "http", url: "https://api.github.com/mcp" }, paseo: {} } },
    });
    expect(readSavedMcpServers("agent-1", root)).toEqual({
      status: "found",
      savedServers: ["github", "paseo"],
    });
  });

  it("treats a record without mcpServers as an empty saved set", () => {
    writeRecord("ws-slug", "agent-1", { config: {} });
    expect(readSavedMcpServers("agent-1", root)).toEqual({ status: "found", savedServers: [] });
  });

  it("finds the record across several workspace directories", () => {
    writeRecord("other-slug", "elsewhere", { config: { mcpServers: { a: {} } } });
    writeRecord("ws-slug", "agent-1", { config: { mcpServers: { b: {} } } });
    expect(readSavedMcpServers("agent-1", root)).toEqual({
      status: "found",
      savedServers: ["b"],
    });
  });

  it("reports missing when no record exists anywhere", () => {
    mkdirSync(root, { recursive: true });
    expect(readSavedMcpServers("ghost", root)).toEqual({ status: "missing" });
  });

  it("reports unusable when the agents root is unreadable", () => {
    const result = readSavedMcpServers("agent-1", path.join(currentHome, "nope"));
    expect(result.status).toBe("unusable");
  });

  it("reports unusable for invalid JSON", () => {
    writeRecord("ws-slug", "agent-1", "{not json");
    const result = readSavedMcpServers("agent-1", root);
    expect(result).toMatchObject({ status: "unusable" });
  });

  it("reports unusable when config is missing or not an object", () => {
    writeRecord("ws-slug", "agent-1", { noConfig: true });
    const result = readSavedMcpServers("agent-1", root);
    expect(result).toMatchObject({ status: "unusable" });
  });

  it("reports unusable when mcpServers is not an object", () => {
    writeRecord("ws-slug", "agent-1", { config: { mcpServers: ["github"] } });
    const result = readSavedMcpServers("agent-1", root);
    expect(result).toMatchObject({ status: "unusable" });
  });

  it("rejects an empty agent id without touching the disk", () => {
    expect(readSavedMcpServers("  ", root)).toMatchObject({ status: "unusable" });
  });
});
