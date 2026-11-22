import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  instructionApplies,
  renderAgentInstructions,
  SERVER_PLACEHOLDER,
  SERVERS_PLACEHOLDER,
  type ClientInstructionTarget,
} from "../shared/agent-instructions";

/**
 * 0.7.1 coverage: the agent instruction that rides on `appendSystemPrompt`
 * (Paseo 0.17.x). The hook wiring lives in `server-contribution.test.ts`.
 */

const BASE: ClientInstructionTarget = {
  injectIntoAgents: true,
  purpose: "interactive",
  injectedNames: 0,
  savedHasServer: false,
};

describe("renderAgentInstructions", () => {
  it("returns null for an empty or whitespace-only template", () => {
    expect(renderAgentInstructions("", ["memory-flash"])).toBeNull();
    expect(renderAgentInstructions(" \n ", ["memory-flash"])).toBeNull();
  });

  it("trims and returns the configured text", () => {
    expect(renderAgentInstructions("  search the team base  ", ["memory-flash"])).toBe(
      "search the team base",
    );
  });

  it("substitutes the single configured server name into every placeholder", () => {
    const text = renderAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, ["memory-flash"]);
    expect(text).not.toBeNull();
    expect(text).not.toContain(SERVER_PLACEHOLDER);
    expect(text).not.toContain(SERVERS_PLACEHOLDER);
    expect(text).toContain("`memory-flash`");
    expect(text).toContain("memory-flash_memory_save");
  });

  it("uses the first actual name for the examples and lists all names", () => {
    const text = renderAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, [
      "memory-flash-conn_a",
      "memory-flash-conn_b",
    ]);
    expect(text).toContain("`memory-flash-conn_a`, `memory-flash-conn_b`");
    expect(text).toContain("memory-flash-conn_a_memory_search");
  });

  it("falls back to the documented default prefix when no name is known", () => {
    const text = renderAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, []);
    expect(text).toContain("memory-flash_memory_search");
  });
});

describe("instructionApplies", () => {
  it("applies when this open contributes a remote server", () => {
    expect(instructionApplies({ ...BASE, injectedNames: 1 })).toBe(true);
  });

  it("applies when the saved configuration already carries a configured name", () => {
    expect(instructionApplies({ ...BASE, savedHasServer: true })).toBe(true);
  });

  it("stays silent when the agent ends up with no remote server", () => {
    expect(instructionApplies(BASE)).toBe(false);
  });

  it("stays silent for gated-off agents and history opens", () => {
    expect(instructionApplies({ ...BASE, injectedNames: 1, injectIntoAgents: false })).toBe(
      false,
    );
    expect(instructionApplies({ ...BASE, injectedNames: 1, purpose: "history" })).toBe(false);
  });
});
