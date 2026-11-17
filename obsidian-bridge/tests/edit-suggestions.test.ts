import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceInNote } from "../server/edit";
import { makeWorkspace, type TestWorkspace } from "./fixtures";

/**
 * 0.10.11: a refused `obsidian_edit` is actionable. The caller gets the closest
 * text from the note (or the places an ambiguous fragment occurs), and a
 * re-wrapped fragment can be matched with `ignoreWhitespace`.
 */

const workspaces: TestWorkspace[] = [];

function workspace(notes: Record<string, string>): TestWorkspace {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

function read(created: TestWorkspace, relPath: string): string {
  return fs.readFileSync(path.join(created.vault, relPath), "utf-8");
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

const NOTE = [
  "# Report",
  "",
  "## Findings",
  "",
  "The queue drains in two passes, and the second pass is slower.",
  "",
  "## Risks",
  "",
  "Losing the manifest breaks the resume path.",
  "",
].join("\n");

describe("obsidian_edit refusals", () => {
  it("returns the closest text when the fragment is missing", () => {
    const created = workspace({ "Projects/report.md": NOTE });
    const result = replaceInNote({
      root: created.vault,
      relPath: "Projects/report.md",
      oldText: "The queue drains in three passes, and the second pass is slower.",
      newText: "rewritten",
      maxWriteChars: 200_000,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("not found");
    expect(result.error).toContain("ignore_whitespace");
    expect(result.suggestions?.length).toBeGreaterThan(0);
    expect(result.suggestions?.[0].line).toBe(5);
    expect(result.suggestions?.[0].text).toContain("two passes");
    // Nothing was written.
    expect(read(created, "Projects/report.md")).toBe(NOTE);
  });

  it("reports where an ambiguous fragment occurs", () => {
    const created = workspace({ "note.md": "first\nrepeated line\nmiddle\nrepeated line\n" });
    const result = replaceInNote({
      root: created.vault,
      relPath: "note.md",
      oldText: "repeated line",
      newText: "changed",
      maxWriteChars: 200_000,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.occurrences).toBe(2);
    expect(result.suggestions?.map((entry) => entry.line)).toEqual([2, 4]);
  });

  it("matches a re-wrapped fragment only when asked", () => {
    const created = workspace({ "note.md": NOTE });
    const reWrapped = "The queue drains in two passes,\nand the second pass is slower.";

    const refused = replaceInNote({
      root: created.vault,
      relPath: "note.md",
      oldText: reWrapped,
      newText: "replaced",
      maxWriteChars: 200_000,
    });
    expect("error" in refused).toBe(true);

    const accepted = replaceInNote({
      root: created.vault,
      relPath: "note.md",
      oldText: reWrapped,
      newText: "The queue drains in one pass.",
      maxWriteChars: 200_000,
      ignoreWhitespace: true,
    });
    expect(accepted).toMatchObject({ ignoreWhitespace: true, normalizedLineEndings: false });
    expect(read(created, "note.md")).toContain("The queue drains in one pass.");
    expect(read(created, "note.md")).not.toContain("two passes");
  });

  it("does not use the whitespace mode when the fragment is genuinely ambiguous", () => {
    const created = workspace({ "note.md": "alpha   beta\nlater\nalpha\tbeta\n" });
    const result = replaceInNote({
      root: created.vault,
      relPath: "note.md",
      oldText: "alpha beta",
      newText: "changed",
      maxWriteChars: 200_000,
      ignoreWhitespace: true,
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.occurrences).toBe(2);
    expect(read(created, "note.md")).toContain("alpha   beta");
  });
});
