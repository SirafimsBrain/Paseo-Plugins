import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  instructionApplies,
  renderAgentInstructions,
  SERVER_PLACEHOLDER,
  type InstructionTarget,
} from "../shared/agent-instructions";
import { obsidianBridgeSettings } from "../shared/settings";

/**
 * 0.22.18 coverage: the per-open agent instruction (Paseo 0.17
 * `appendSystemPrompt`) and its placeholder rendering.
 */

const BASE: InstructionTarget = {
  injectIntoAgents: true,
  purpose: "interactive",
  reason: "resume",
  injectMcp: false,
  attachTool: false,
  configCovered: false,
  savedHasServer: false,
};

describe("renderAgentInstructions", () => {
  it("returns null for an empty or whitespace-only template", () => {
    expect(renderAgentInstructions("", "obsidian-bridge")).toBeNull();
    expect(renderAgentInstructions("  \n ", "obsidian-bridge")).toBeNull();
  });

  it("trims the configured text", () => {
    expect(renderAgentInstructions("  cite the path  ", "obsidian-bridge")).toBe(
      "cite the path",
    );
  });

  it("substitutes every {server} with the MCP prefix", () => {
    const text = renderAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, "obsidian-bridge");
    expect(text).not.toBeNull();
    expect(text).not.toContain(SERVER_PLACEHOLDER);
    expect(text).toContain("`obsidian-bridge`");
    expect(text).toContain("obsidian-bridge_obsidian_search");
    expect(text).toContain("obsidian-bridge_obsidian_read");
  });

  it("substitutes the attached-tool prefix too", () => {
    const text = renderAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, "obsidian_bridge");
    expect(text).toContain("obsidian_bridge_obsidian_search");
    expect(text).not.toContain("obsidian-bridge_obsidian_search");
  });

  it("leaves a template without the placeholder as written", () => {
    expect(renderAgentInstructions("Use the vault.", "obsidian-bridge")).toBe("Use the vault.");
  });
});

describe("instructionApplies", () => {
  it("applies whenever the open leaves a working surface", () => {
    expect(instructionApplies({ ...BASE, injectMcp: true })).toBe(true);
    expect(instructionApplies({ ...BASE, attachTool: true })).toBe(true);
    expect(instructionApplies({ ...BASE, configCovered: true })).toBe(true);
    expect(instructionApplies({ ...BASE, savedHasServer: true })).toBe(true);
    expect(instructionApplies({ ...BASE, reason: "create" })).toBe(true);
  });

  it("stays silent without a surface, for history opens and when injection is off", () => {
    expect(instructionApplies(BASE)).toBe(false);
    expect(instructionApplies({ ...BASE, injectMcp: true, purpose: "history" })).toBe(false);
    expect(
      instructionApplies({ ...BASE, injectMcp: true, injectIntoAgents: false }),
    ).toBe(false);
  });
});

describe("settings", () => {
  it("defaults agentInstructions to the shipped text", () => {
    const parsed = obsidianBridgeSettings.schema.parse({});
    expect(parsed.agentInstructions).toBe(DEFAULT_AGENT_INSTRUCTIONS);
  });

  it("keeps an empty value, which switches the instruction off", () => {
    const parsed = obsidianBridgeSettings.schema.parse({ agentInstructions: "" });
    expect(parsed.agentInstructions).toBe("");
  });
});
