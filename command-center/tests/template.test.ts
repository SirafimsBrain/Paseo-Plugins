import { describe, expect, it } from "vitest";
import { inputVariablesOf, renderTemplate } from "../shared/template";

describe("renderTemplate", () => {
  it("fills input variables with provided values", () => {
    expect(renderTemplate("Fix {{input:issue}} today", { issue: "#42" })).toBe("Fix #42 today");
  });

  it("falls back to the template default when the value is empty", () => {
    expect(renderTemplate("Deploy {{input:env|staging}}", {})).toBe("Deploy staging");
    expect(renderTemplate("Deploy {{input:env|staging}}", { env: "prod" })).toBe("Deploy prod");
  });

  it("substitutes workspace context tokens", () => {
    const rendered = renderTemplate("Review {{workspace.name}} at {{workspace.path}}", {}, {
      workspaceName: "paseo-plugins",
      workspacePath: "/disk/paseo-plugins",
    });
    expect(rendered).toBe("Review paseo-plugins at /disk/paseo-plugins");
  });

  it("renders date and time from the provided clock", () => {
    const rendered = renderTemplate("Run on {{date}} at {{time}}", {}, {
      date: "2026-09-22",
      time: "17:45",
    });
    expect(rendered).toBe("Run on 2026-09-22 at 17:45");
  });

  it("leaves unknown tokens visible instead of deleting them", () => {
    expect(renderTemplate("hello {{agent.model}}", {})).toBe("hello {{agent.model}}");
  });

  it("tolerates whitespace inside tokens", () => {
    expect(renderTemplate("a {{ input:x }} b", { x: "1" })).toBe("a 1 b");
  });

  it("drops an input without value and without default to an empty string", () => {
    expect(renderTemplate("a{{input:missing}}b", {})).toBe("ab");
  });
});

describe("inputVariablesOf", () => {
  it("extracts names and defaults in order, deduplicated", () => {
    const variables = inputVariablesOf("{{input:a}} {{input:b|2}} {{input:a}}");
    expect(variables).toEqual([
      { name: "a" },
      { name: "b", defaultValue: "2" },
    ]);
  });

  it("ignores non-input tokens", () => {
    expect(inputVariablesOf("{{workspace.name}} {{date}}")).toEqual([]);
  });
});
