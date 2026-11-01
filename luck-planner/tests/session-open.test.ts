import { describe, expect, it } from "vitest";
import type { AgentRecordLookup } from "../server/agent-record";
import {
  decideSessionOpen,
  needsCapabilityProbe,
  type SessionOpenInput,
} from "../server/session-open";

/**
 * The decision matrix of the session-open hook (`__doc.md` §10.8). Every row
 * exists because a real failure mode was found in the field:
 *
 * - the `agent.create` parity row — the hook must produce the same injected
 *   config the creation hook would, or agents created before
 *   `injectIntoAgents` was enabled keep their stale config (and their
 *   session-open record dies at eviction);
 * - the collision rows — the memory-flash / bunny-search lesson: a saved
 *   agent must never be overwritten;
 * - the config-cover row — D4's config file owns the surface, the hook must
 *   not double-declare;
 * - the native-fallback rows — providers without MCP (Codex, headless Claude
 *   Code) get the `command_center_run`-predecessor native tool instead.
 */

const FOUND_NONE: AgentRecordLookup = { status: "found", savedServers: [] };
const FOUND_OURS: AgentRecordLookup = {
  status: "found",
  savedServers: ["luck-planner"],
};
const FOUND_OTHER: AgentRecordLookup = {
  status: "found",
  savedServers: ["git"],
};
const UNUSABLE: AgentRecordLookup = {
  status: "unusable",
  reason: "invalid JSON",
};

function input(overrides: Partial<SessionOpenInput> = {}): SessionOpenInput {
  return {
    reason: "resume",
    purpose: "interactive",
    injectIntoAgents: true,
    serverName: "luck-planner",
    configCovered: false,
    lookup: FOUND_NONE,
    supportsMcpServers: true,
    ...overrides,
  };
}

describe("decideSessionOpen — inject (agent.create parity)", () => {
  it("injects when the agent's saved config does not carry the server", () => {
    expect(decideSessionOpen(input())).toEqual({
      injectMcp: true,
      attachTool: false,
      why: "injecting 'luck-planner': saved configuration has no such server (0 saved server(s))",
    });
  });

  it("injects alongside other saved servers (merge, never replace)", () => {
    const decision = decideSessionOpen(input({ lookup: FOUND_OTHER }));
    expect(decision.injectMcp).toBe(true);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("1 saved server(s)");
  });
});

describe("decideSessionOpen — gates and config ownership", () => {
  it("injects nothing when injectIntoAgents is off", () => {
    expect(decideSessionOpen(input({ injectIntoAgents: false }))).toEqual({
      injectMcp: false,
      attachTool: false,
      why: "skipped: injectIntoAgents is off",
    });
  });

  it("leaves history opens alone (no surprise writes to the tree)", () => {
    const decision = decideSessionOpen(input({ purpose: "history" }));
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toBe("skipped: purpose is history");
  });

  it("leaves reason=create to the agent.create hook (no double injection)", () => {
    const decision = decideSessionOpen(input({ reason: "create" }));
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toBe(
      "skipped: reason=create is handled by the agent.create hook",
    );
  });

  it("does nothing when the config file covers the server (D4 owns the surface)", () => {
    expect(decideSessionOpen(input({ configCovered: true }))).toEqual({
      injectMcp: false,
      attachTool: false,
      why: "skipped: the agent's config file already registers the server (D4)",
    });
  });
});

describe("decideSessionOpen — collision (saved agents are never overwritten)", () => {
  it("does not overwrite an agent that already saved the server", () => {
    const decision = decideSessionOpen(input({ lookup: FOUND_OURS }));
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("already carries");
  });

  it("does not attach the tool next to a saved server either (one surface)", () => {
    const decision = decideSessionOpen(
      input({ lookup: FOUND_OURS, supportsMcpServers: false }),
    );
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(false);
    expect(decision.why).toContain("already carries");
  });
});

describe("decideSessionOpen — native fallback (providers without MCP)", () => {
  it("attaches the native tool when the provider has no MCP", () => {
    expect(decideSessionOpen(input({ supportsMcpServers: false }))).toEqual({
      injectMcp: false,
      attachTool: true,
      why: "attaching native luck_tree_upsert_leaf tool only: provider does not support MCP servers",
    });
  });

  it("attaches the native tool when capabilities are unknown (conservative parity)", () => {
    const decision = decideSessionOpen(input({ supportsMcpServers: null }));
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(true);
    expect(decision.why).toContain("provider capabilities unknown");
  });

  it("attaches the native tool when the agent record is missing", () => {
    // Capability is known to be fine — the record itself is the blocker.
    const decision = decideSessionOpen(
      input({ lookup: { status: "missing" }, supportsMcpServers: true }),
    );
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(true);
    expect(decision.why).toContain("agent record not found on disk");
  });

  it("attaches the native tool when the agent record is unusable", () => {
    const decision = decideSessionOpen(
      input({ lookup: UNUSABLE, supportsMcpServers: true }),
    );
    expect(decision.injectMcp).toBe(false);
    expect(decision.attachTool).toBe(true);
    expect(decision.why).toContain("agent record unusable (invalid JSON)");
  });
});

describe("needsCapabilityProbe", () => {
  it("skips the probe when the agent already saved the server", () => {
    expect(needsCapabilityProbe(input({ lookup: FOUND_OURS }))).toBe(false);
  });
  it("returns false for every gate (history, create, config, disabled)", () => {
    expect(needsCapabilityProbe(input({ purpose: "history" }))).toBe(false);
    expect(needsCapabilityProbe(input({ reason: "create" }))).toBe(false);
    expect(needsCapabilityProbe(input({ configCovered: true }))).toBe(false);
    expect(needsCapabilityProbe(input({ injectIntoAgents: false }))).toBe(false);
  });
  it("probes when the agent has no record (its surface is unknown)", () => {
    expect(
      needsCapabilityProbe(input({ lookup: { status: "missing" } })),
    ).toBe(true);
  });
  it("probes when the record is unusable", () => {
    expect(needsCapabilityProbe(input({ lookup: UNUSABLE }))).toBe(true);
  });
  it("probes when the saved servers do not include ours", () => {
    expect(needsCapabilityProbe(input({ lookup: FOUND_NONE }))).toBe(true);
    expect(needsCapabilityProbe(input({ lookup: FOUND_OTHER }))).toBe(true);
  });
});
