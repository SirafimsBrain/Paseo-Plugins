import { describe, expect, it } from "vitest";
import {
  ATTACHED_TOOL_NAME,
  DEFAULT_AGENT_INSTRUCTIONS,
  MCP_TOOL_NAME,
  renderAgentInstructions,
} from "../shared/agent-instructions";
import {
  decideSessionOpen,
  instructionToolName,
  type InstructionTargetInput,
  type SessionOpenInput,
} from "../server/session-open";

/**
 * 0.8.7 coverage: the agent instruction that rides on `appendSystemPrompt` (Paseo 0.17.x).
 *
 * Two pure decisions are tested here — rendering the template, and which tool name the
 * instruction may mention. The hook wiring lives in `agent-hooks.test.ts`.
 */

const BASE: SessionOpenInput = {
  reason: "resume",
  purpose: "interactive",
  provider: "opencode",
  labels: {},
  injectIntoAgents: true,
  serverName: "bunny-search",
  labelGateKey: "",
  skipProviders: "",
  background: false,
  skipBackgroundAgents: false,
  knownMode: null,
  lookup: { status: "found", savedServers: [] },
  supportsMcpServers: true,
  openCodeMcpBlock: null,
};

function target(overrides: Partial<InstructionTargetInput> = {}): InstructionTargetInput {
  const decided = decideSessionOpen(BASE);
  return {
    purpose: BASE.purpose,
    gatedOff: false,
    serverName: BASE.serverName,
    decide: decided,
    knownMode: null,
    lookup: BASE.lookup,
    ...overrides,
  };
}

describe("renderAgentInstructions", () => {
  it("substitutes every {tool} placeholder", () => {
    expect(renderAgentInstructions("Use `{tool}`. Prefer {tool} over memory.", MCP_TOOL_NAME)).toBe(
      "Use `web_search`. Prefer web_search over memory.",
    );
  });

  it("returns null for an empty or whitespace-only template", () => {
    expect(renderAgentInstructions("", MCP_TOOL_NAME)).toBeNull();
    expect(renderAgentInstructions("   \n\t ", MCP_TOOL_NAME)).toBeNull();
  });

  it("trims and keeps a template without a placeholder", () => {
    expect(renderAgentInstructions("  search when unsure  ", ATTACHED_TOOL_NAME)).toBe(
      "search when unsure",
    );
  });

  it("ships a default that names the placeholder exactly once", () => {
    expect(DEFAULT_AGENT_INSTRUCTIONS.split("{tool}")).toHaveLength(2);
  });
});

describe("instructionToolName", () => {
  it("names the MCP tool when this open contributes the server", () => {
    expect(instructionToolName(target())).toBe(MCP_TOOL_NAME);
  });

  it("names the attached tool when only bunny_web_search is contributed", () => {
    const decided = decideSessionOpen({ ...BASE, lookup: { status: "missing" } });
    const name = instructionToolName(
      target({ decide: decided, lookup: { status: "missing" } }),
    );
    expect(decided.attachTool).toBe(true);
    expect(name).toBe(ATTACHED_TOOL_NAME);
  });

  it("falls back to the recorded provisioning marker", () => {
    const skipped = decideSessionOpen({ ...BASE, purpose: "history" });
    // A history open is refused first, so use a create-owned reason for the fallback.
    expect(instructionToolName(target({ decide: skipped, purpose: "history" }))).toBeNull();
    expect(
      instructionToolName(target({ decide: skipped, purpose: "interactive", knownMode: "mcp" })),
    ).toBe(MCP_TOOL_NAME);
    expect(
      instructionToolName(target({ decide: skipped, purpose: "interactive", knownMode: "tool" })),
    ).toBe(ATTACHED_TOOL_NAME);
  });

  it("recognises a server already saved in the agent configuration", () => {
    const lookup = { status: "found" as const, savedServers: ["bunny-search"] };
    const decided = decideSessionOpen({ ...BASE, lookup });
    expect(instructionToolName(target({ decide: decided, lookup }))).toBe(MCP_TOOL_NAME);
  });

  it("stays silent for gated-off agents and history opens", () => {
    expect(instructionToolName(target({ gatedOff: true }))).toBeNull();
    expect(instructionToolName(target({ purpose: "history" }))).toBeNull();
  });

  it("stays silent when the agent ends up with no search at all", () => {
    const decided = decideSessionOpen({ ...BASE, injectIntoAgents: false });
    expect(
      instructionToolName(target({ decide: decided, gatedOff: true, knownMode: null })),
    ).toBeNull();
  });
});
