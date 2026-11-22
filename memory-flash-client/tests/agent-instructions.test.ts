import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  instructionApplies,
  renderAgentInstructions,
  type ClientInstructionTarget,
} from "../shared/agent-instructions";

/**
 * 0.7.0 coverage: the agent instruction that rides on `appendSystemPrompt`
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
    expect(renderAgentInstructions("")).toBeNull();
    expect(renderAgentInstructions(" \n ")).toBeNull();
  });

  it("trims and returns the configured text", () => {
    expect(renderAgentInstructions("  search the team base  ")).toBe("search the team base");
  });

  it("ships a default that names the three memory tools", () => {
    for (const tool of ["memory_search", "memory_save", "memory_handoff"]) {
      expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(tool);
    }
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
