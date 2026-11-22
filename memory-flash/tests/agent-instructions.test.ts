import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  instructionApplies,
  renderAgentInstructions,
  type InstructionTarget,
} from "../shared/agent-instructions";

/**
 * 0.14.0 coverage: the agent instruction that rides on `appendSystemPrompt`
 * (Paseo 0.17.x). The hook wiring lives in `agent-hooks.test.ts`.
 */

const BASE: InstructionTarget = {
  injectIntoAgents: true,
  purpose: "interactive",
  injectMcp: false,
  configCovered: false,
  savedHasServer: false,
};

describe("renderAgentInstructions", () => {
  it("returns null for an empty or whitespace-only template", () => {
    expect(renderAgentInstructions("")).toBeNull();
    expect(renderAgentInstructions("   \n\t ")).toBeNull();
  });

  it("trims and returns the configured text", () => {
    expect(renderAgentInstructions("  search first  ")).toBe("search first");
  });

  it("ships a default that names the three memory tools", () => {
    for (const tool of ["memory_search", "memory_save", "memory_handoff"]) {
      expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(tool);
    }
  });
});

describe("instructionApplies", () => {
  it("applies when this open contributes the server", () => {
    expect(instructionApplies({ ...BASE, injectMcp: true })).toBe(true);
  });

  it("applies when the agent's own config file covers the provider", () => {
    expect(instructionApplies({ ...BASE, configCovered: true })).toBe(true);
  });

  it("applies when the saved configuration already carries the server", () => {
    expect(instructionApplies({ ...BASE, savedHasServer: true })).toBe(true);
  });

  it("stays silent for a recall-only open", () => {
    expect(instructionApplies(BASE)).toBe(false);
  });

  it("stays silent for gated-off agents and history opens", () => {
    expect(instructionApplies({ ...BASE, injectMcp: true, injectIntoAgents: false })).toBe(
      false,
    );
    expect(instructionApplies({ ...BASE, injectMcp: true, purpose: "history" })).toBe(false);
  });
});
