import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecordLookup } from "../server/agent-record";
import {
  contributesForReason,
  decideSessionOpen,
  mayContribute,
  needsCapabilityProbe,
  type SessionOpenInput,
} from "../server/session-open";
import {
  forgetAgentMcp,
  loadAgentMcpRegistry,
  MAX_AGENTS,
  rememberAgentMcp,
} from "../server/agent-mcp";

const homes: string[] = [];

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "cc-session-open-"));
  homes.push(home);
  process.env.PASEO_HOME = home;
});

afterAll(() => {
  delete process.env.PASEO_HOME;
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const found: AgentRecordLookup = { status: "found", savedServers: [] };
const servers = { github: { type: "http", url: "https://api.github.com/mcp" } };
const registry = { servers, commandName: "Review PR" };

function input(overrides: Partial<SessionOpenInput> = {}): SessionOpenInput {
  return {
    reason: "resume",
    purpose: "interactive",
    lookup: found,
    supportsMcpServers: true,
    registry,
    ...overrides,
  };
}

describe("session-open decision", () => {
  it("contributes the registry servers when the saved config lacks them", () => {
    const decision = decideSessionOpen(input());
    expect(decision.contribute).toEqual(["github"]);
    expect(decision.why).toContain("Review PR");
  });

  it("drops only the names the saved configuration already carries", () => {
    const decision = decideSessionOpen(
      input({ lookup: { status: "found", savedServers: ["github"] } }),
    );
    expect(decision.contribute).toEqual([]);
    expect(decision.why).toContain("already carries every registry server");
  });

  it("keeps the missing subset of a partially colliding entry", () => {
    const decision = decideSessionOpen(
      input({
        lookup: { status: "found", savedServers: ["github"] },
        registry: {
          servers: { github: servers.github!, jira: { type: "http", url: "https://jira/mcp" } },
          commandName: "Review PR",
        },
      }),
    );
    expect(decision.contribute).toEqual(["jira"]);
    expect(decision.why).toContain("1 already saved, dropped");
  });

  it("fails safe to skip on an unusable record", () => {
    const decision = decideSessionOpen(
      input({ lookup: { status: "unusable", reason: "no config object" } }),
    );
    expect(decision.contribute).toEqual([]);
    expect(decision.why).toContain("unusable");
  });

  it("fails safe to skip on a missing record", () => {
    const decision = decideSessionOpen(input({ lookup: { status: "missing" } }));
    expect(decision.contribute).toEqual([]);
    expect(decision.why).toContain("not found on disk");
  });

  it("skips providers without MCP support and unknown capabilities", () => {
    expect(decideSessionOpen(input({ supportsMcpServers: false })).contribute).toEqual([]);
    expect(decideSessionOpen(input({ supportsMcpServers: null })).contribute).toEqual([]);
  });

  it("never contributes for purpose history", () => {
    expect(contributesForReason("resume")).toBe(true);
    const decision = decideSessionOpen(input({ purpose: "history" }));
    expect(decision.contribute).toEqual([]);
    expect(decision.why).toContain("history");
  });

  it("only contributes on resume/refresh reopens", () => {
    expect(contributesForReason("create")).toBe(false);
    expect(contributesForReason("import")).toBe(false);
    expect(decideSessionOpen(input({ reason: "create" })).contribute).toEqual([]);
    expect(decideSessionOpen(input({ reason: "import" })).contribute).toEqual([]);
  });

  it("skips when the agent has no registry entry or an empty one", () => {
    expect(decideSessionOpen(input({ registry: null })).contribute).toEqual([]);
    expect(decideSessionOpen(input({ registry: { servers: {}, commandName: "x" } })).contribute).toEqual([]);
    expect(mayContribute(input({ registry: null }))).toBe(false);
    expect(mayContribute(input({ registry: { servers: {}, commandName: "x" } }))).toBe(false);
    expect(mayContribute(input())).toBe(true);
  });

  it("asks the daemon for capabilities only when a contribution is possible", () => {
    expect(needsCapabilityProbe(input())).toBe(true);
    expect(needsCapabilityProbe(input({ registry: null }))).toBe(false);
    expect(needsCapabilityProbe(input({ purpose: "history" }))).toBe(false);
    expect(needsCapabilityProbe(input({ lookup: { status: "found", savedServers: ["github"] } }))).toBe(true);
  });
});

describe("agent MCP registry store", () => {
  it("remembers servers under the agent id and clears on empty", () => {
    rememberAgentMcp("agent-1", servers, "Review PR", new Date("2026-11-01T10:00:00Z"));
    expect(loadAgentMcpRegistry()["agent-1"]).toEqual({
      servers,
      commandName: "Review PR",
      updatedAt: "2026-11-01T10:00:00.000Z",
    });

    // A later command without servers replaces the entry (last run wins).
    rememberAgentMcp("agent-1", {}, "Plain prompt", new Date("2026-11-01T11:00:00Z"));
    expect(loadAgentMcpRegistry()["agent-1"]).toBeUndefined();
  });

  it("forgets one agent without touching the others", () => {
    rememberAgentMcp("agent-1", servers, "A");
    rememberAgentMcp("agent-2", servers, "B");
    forgetAgentMcp("agent-1");
    const registry = loadAgentMcpRegistry();
    expect(registry["agent-1"]).toBeUndefined();
    expect(registry["agent-2"]).toBeDefined();
  });

  it("ignores blank agent ids", () => {
    rememberAgentMcp("  ", servers, "A");
    expect(loadAgentMcpRegistry()).toEqual({});
  });

  it("survives a corrupt registry file with an empty registry", () => {
    rememberAgentMcp("agent-1", servers, "A");
    const file = path.join(process.env.PASEO_HOME!, "plugins", "command-center", "agent-mcp.json");
    rmSync(file);
    writeFileSync(file, "{corrupt", "utf-8");
    expect(loadAgentMcpRegistry()).toEqual({});
  });

  it("caps the registry at MAX_AGENTS, dropping the oldest entries", () => {
    for (let index = 0; index < MAX_AGENTS + 5; index += 1) {
      rememberAgentMcp(
        `agent-${index}`,
        servers,
        `Command ${index}`,
        new Date(1700000000000 + index * 1000),
      );
    }
    const registry = loadAgentMcpRegistry();
    expect(Object.keys(registry)).toHaveLength(MAX_AGENTS);
    expect(registry["agent-0"]).toBeUndefined();
    expect(registry[`agent-${MAX_AGENTS + 4}`]).toBeDefined();
  });
});
