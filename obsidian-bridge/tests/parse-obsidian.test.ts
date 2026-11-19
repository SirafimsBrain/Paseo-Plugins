import { describe, expect, it } from "vitest";
import { extractCallout, extractInlineFields, parseNote } from "../server/parse";

/**
 * 0.10.11: callout types travel with chunks, and Dataview inline fields are
 * readable as fields instead of only as body text.
 */

describe("callouts", () => {
  it("reads the type from the first callout marker in a chunk", () => {
    expect(extractCallout("> [!warning] Do not lose the manifest\n> second line")).toBe("warning");
    expect(extractCallout("> > [!Note]\n> nested")).toBe("note");
  });

  it("ignores a callout-like line inside a code fence", () => {
    expect(extractCallout("```md\n> [!warning] example\n```")).toBeNull();
  });

  it("returns null for prose", () => {
    expect(extractCallout("Just text with a > quote.")).toBeNull();
  });

  it("attaches the type to the chunk", () => {
    const parsed = parseNote(
      ["# A", "", "## Risks", "", "> [!danger] Losing the manifest", "> breaks resume", ""].join("\n"),
      "a.md",
    );
    const risk = parsed.chunks.find((chunk) => chunk.heading.includes("Risks"));
    expect(risk?.callout).toBe("danger");
    expect(parsed.chunks.find((chunk) => chunk.heading.length === 0)?.callout ?? null).toBeNull();
  });
});

describe("nested frontmatter", () => {
  it("keeps mappings and lists of mappings instead of flattening them", () => {
    const parsed = parseNote(
      [
        "---",
        "kind: goal",
        "brief:",
        "  entryPoint: src/index.ts:10",
        "  files: [src/index.ts, tests/index.test.ts]",
        "plan:",
        "  - id: s1",
        "    title: Move the session table",
        "  - id: s2",
        "    title: Rotate refresh tokens",
        "---",
        "",
        "# Goal",
      ].join("\n"),
      "goal.md",
    );
    expect(parsed.frontmatter.brief).toEqual({
      entryPoint: "src/index.ts:10",
      files: ["src/index.ts", "tests/index.test.ts"],
    });
    expect(parsed.frontmatter.plan).toEqual([
      { id: "s1", title: "Move the session table" },
      { id: "s2", title: "Rotate refresh tokens" },
    ]);
  });

  it("falls back to the flat reader when the YAML is rejected", () => {
    const parsed = parseNote("---\ntitle: Two\ntitle: Again\n---\n\n# Body\n", "a.md");
    expect(parsed.frontmatter.title).toBe("Again");
  });
});

describe("Dataview inline fields", () => {
  it("collects `key:: value` pairs by key", () => {
    const fields = extractInlineFields(
      ["status:: active", "owner:: sirafim", "owner:: backup", "not a field"].join("\n"),
    );
    expect(fields.status).toEqual(["active"]);
    expect(fields.owner).toEqual(["sirafim", "backup"]);
    expect(fields["not a field"]).toBeUndefined();
  });

  it("reads the bracketed form with spaces in the key", () => {
    expect(extractInlineFields("[due date]:: 2026-12-01")).toEqual({ "due date": ["2026-12-01"] });
  });

  it("skips fenced code and empty values", () => {
    const fields = extractInlineFields(["```", "key:: value", "```", "empty::"].join("\n"));
    expect(fields).toEqual({});
  });

  it("is part of a parsed note", () => {
    const parsed = parseNote("# A\n\nstatus:: draft\n", "a.md");
    expect(parsed.inlineFields.status).toEqual(["draft"]);
  });
});
