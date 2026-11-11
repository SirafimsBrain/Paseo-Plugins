import { describe, expect, it } from "vitest";
import type { CommandDefinition } from "../shared/commands";
import { declarationsForTemplate, resolveCommandInputs } from "../shared/variables";

function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: "cmd",
    name: "Command",
    type: "prompt",
    template: "Review {{input:pr}} on {{input:repo|main}}",
    variables: [],
    steps: [],
    scope: "global",
    provider: "cline/claude-opus-4-6",
    favorite: false,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    useCount: 0,
    ...overrides,
  };
}

describe("resolveCommandInputs", () => {
  it("keeps declared kinds and prompts, then fills template-only inputs as text", () => {
    const inputs = resolveCommandInputs(
      command({
        variables: [
          { name: "repo", prompt: "Repository", defaultValue: "main", kind: "workspace" },
          { name: "pr", prompt: "Pull request", kind: "file" },
        ],
      }),
    );
    expect(inputs).toEqual([
      { name: "repo", prompt: "Repository", defaultValue: "main", kind: "workspace" },
      { name: "pr", prompt: "Pull request", defaultValue: undefined, kind: "file" },
    ]);
  });

  it("adds a template variable that was never declared as a text input", () => {
    const inputs = resolveCommandInputs(command({ template: "Fix {{input:ticket}}" }));
    expect(inputs).toEqual([
      { name: "ticket", prompt: "ticket", defaultValue: undefined, kind: "text" },
    ]);
  });

  it("returns no inputs for a workflow, which has no template of its own", () => {
    expect(
      resolveCommandInputs(
        command({
          type: "workflow",
          template: "",
          variables: [{ name: "x", prompt: "X", kind: "text" }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("declarationsForTemplate", () => {
  it("uses the picked kind, preserves the stored prompt and prefers the template default", () => {
    const declarations = declarationsForTemplate(
      "Run {{input:target|staging}} in {{input:env}}",
      [
        { name: "target", prompt: "Target service", defaultValue: "prod", kind: "workspace" },
        { name: "env", prompt: "Environment", kind: "text" },
      ],
      { env: "file" },
    );
    expect(declarations).toEqual([
      { name: "target", prompt: "Target service", defaultValue: "staging", kind: "workspace" },
      { name: "env", prompt: "Environment", defaultValue: undefined, kind: "file" },
    ]);
  });

  it("drops declarations whose token was removed from the template", () => {
    expect(
      declarationsForTemplate("Nothing to fill", [{ name: "gone", prompt: "Gone", kind: "text" }], {}),
    ).toEqual([]);
  });

  it("defaults a brand-new input to text", () => {
    expect(declarationsForTemplate("{{input:fresh}}", [], {})).toEqual([
      { name: "fresh", prompt: "fresh", defaultValue: undefined, kind: "text" },
    ]);
  });
});
