import { describe, expect, it } from "vitest";
import type { CommandDefinition } from "../shared/commands";
import { commandMatchesCategory, commandMatchesQuery } from "../shared/search";

function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd_1",
    name: "Review pull request",
    type: "prompt",
    template: "Review {{input:pr}} and summarize {{workspace.name}}",
    variables: [{ name: "pr", prompt: "Pull request number", defaultValue: "123" }],
    scope: "global",
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    useCount: 0,
    ...overrides,
  };
}

describe("commandMatchesQuery", () => {
  it("matches on name regardless of case", () => {
    expect(commandMatchesQuery(command(), "review")).toBe(true);
    expect(commandMatchesQuery(command(), "REVIEW")).toBe(true);
  });

  it("matches on template body and variable prompts", () => {
    expect(commandMatchesQuery(command(), "summarize")).toBe(true);
    expect(commandMatchesQuery(command(), "pull request number")).toBe(true);
  });

  it("requires every term (AND semantics)", () => {
    expect(commandMatchesQuery(command(), "review pull")).toBe(true);
    expect(commandMatchesQuery(command(), "review deploy")).toBe(false);
  });

  it("matches the category label", () => {
    const withCategory = command({ category: "Code review" });
    expect(commandMatchesQuery(withCategory, "code")).toBe(true);
    expect(commandMatchesQuery(command(), "code")).toBe(false);
  });

  it("is empty-query friendly", () => {
    expect(commandMatchesQuery(command(), "   ")).toBe(true);
  });
});

describe("commandMatchesCategory", () => {
  it("null filter shows everything", () => {
    expect(commandMatchesCategory(command(), null)).toBe(true);
    expect(commandMatchesCategory(command({ category: "Ops" }), null)).toBe(true);
  });

  it("filters by exact category", () => {
    expect(commandMatchesCategory(command({ category: "Ops" }), "Ops")).toBe(true);
    expect(commandMatchesCategory(command({ category: "Ops" }), "ops")).toBe(false);
    expect(commandMatchesCategory(command(), "Ops")).toBe(false);
  });
});
