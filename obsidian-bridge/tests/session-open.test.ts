import { describe, expect, it } from "vitest";
import type { AgentRecordLookup } from "../server/agent-record";
import { decideSessionOpen, needsCapabilityProbe, type SessionOpenInput } from "../server/session-open";

const found = (savedServers: string[] = []): AgentRecordLookup => ({
  status: "found",
  savedServers,
});

function input(overrides: Partial<SessionOpenInput> = {}): SessionOpenInput {
  return {
    reason: "resume",
    purpose: "interactive",
    provider: "codex",
    injectIntoAgents: true,
    serverName: "obsidian-bridge",
    lookup: found(),
    supportsMcpServers: true,
    ...overrides,
  };
}

describe("decideSessionOpen", () => {
  it("injects the MCP server when nothing stands in the way", () => {
    expect(decideSessionOpen(input())).toMatchObject({ injectMcp: true, attachTool: false });
  });

  it("does nothing when injection is switched off", () => {
    expect(decideSessionOpen(input({ injectIntoAgents: false }))).toMatchObject({
      injectMcp: false,
      attachTool: false,
    });
  });

  it("never contributes to a history open", () => {
    expect(decideSessionOpen(input({ purpose: "history" }))).toMatchObject({
      injectMcp: false,
      attachTool: false,
    });
  });

  it("does not inject a name the saved configuration already carries", () => {
    expect(
      decideSessionOpen(input({ lookup: found(["obsidian-bridge"]) })),
    ).toMatchObject({ injectMcp: false, attachTool: false });
  });

  it("falls back to attached tools for providers without MCP support", () => {
    expect(decideSessionOpen(input({ supportsMcpServers: false }))).toMatchObject({
      injectMcp: false,
      attachTool: true,
    });
  });

  it("skips when the provider's config file already carries the server", () => {
    expect(decideSessionOpen(input({ configCovered: true }))).toMatchObject({
      injectMcp: false,
      attachTool: false,
    });
    expect(needsCapabilityProbe(input({ configCovered: true }))).toBe(false);
  });

  it("leaves creation to the create hook instead of failing on the absent record", () => {
    expect(
      decideSessionOpen(input({ reason: "create", lookup: { status: "missing" } })),
    ).toMatchObject({ injectMcp: false, attachTool: false });
  });

  it("falls back to attached tools when the agent record cannot be read", () => {
    expect(decideSessionOpen(input({ lookup: { status: "missing" } }))).toMatchObject({
      injectMcp: false,
      attachTool: true,
    });
    expect(
      decideSessionOpen(input({ lookup: { status: "unusable", reason: "unreadable" } })),
    ).toMatchObject({ injectMcp: false, attachTool: true });
  });

  it("falls back to attached tools when capabilities are unknown", () => {
    expect(decideSessionOpen(input({ supportsMcpServers: null }))).toMatchObject({
      injectMcp: false,
      attachTool: true,
    });
  });

  it("explains every decision", () => {
    for (const decision of [
      decideSessionOpen(input()),
      decideSessionOpen(input({ injectIntoAgents: false })),
      decideSessionOpen(input({ purpose: "history" })),
      decideSessionOpen(input({ supportsMcpServers: false })),
    ]) {
      expect(decision.why.length).toBeGreaterThan(0);
    }
  });
});

describe("needsCapabilityProbe", () => {
  it("asks the daemon only when an MCP contribution is possible", () => {
    expect(needsCapabilityProbe(input())).toBe(true);
    expect(needsCapabilityProbe(input({ injectIntoAgents: false }))).toBe(false);
    expect(needsCapabilityProbe(input({ purpose: "history" }))).toBe(false);
    expect(needsCapabilityProbe(input({ lookup: found(["obsidian-bridge"]) }))).toBe(false);
    expect(needsCapabilityProbe(input({ reason: "create" }))).toBe(false);
  });
});
