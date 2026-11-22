import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  instructionApplies,
  renderAgentInstructions,
  SERVER_PLACEHOLDER,
  type InstructionTarget,
} from "../shared/agent-instructions";

/**
 * 0.14.1 coverage: the agent instruction that rides on `appendSystemPrompt`
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
    expect(renderAgentInstructions("", "memory-flash")).toBeNull();
    expect(renderAgentInstructions("   \n\t ", "memory-flash")).toBeNull();
  });

  it("trims and returns the configured text", () => {
    expect(renderAgentInstructions("  search first  ", "memory-flash")).toBe("search first");
  });

  it("substitutes every {server} with the configured server name", () => {
    const text = renderAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, "team-memory");
    expect(text).not.toBeNull();
    expect(text).not.toContain(SERVER_PLACEHOLDER);
    for (const tool of ["memory_search", "memory_save", "memory_handoff"]) {
      expect(text).toContain(`team-memory_${tool}`);
    }
  });

  it("uses the default memory-flash prefix when the server is not renamed", () => {
    const text = renderAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, "memory-flash");
    expect(text).toContain("memory-flash_memory_save");
    expect(text).toContain("`memory-flash_memory_search`");
    // Bare names would name tools Paseo does not expose under that form.
    expect(text).not.toMatch(/(^|[^-_])memory_save/);
  });

  it("substitutes a placeholder the user added by hand", () => {
    expect(renderAgentInstructions("Use `{server}_memory_get`.", "base")).toBe(
      "Use `base_memory_get`.",
    );
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
