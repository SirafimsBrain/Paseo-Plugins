import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceInNote } from "../server/edit";
import { makeWorkspace, type TestWorkspace } from "./fixtures";

/**
 * `obsidian_edit`: exact-fragment edit of an existing note by vault path.
 *
 * The point of the tool is a note the append-only role writers cannot reach, so
 * the happy path here writes inside a role-less folder and asserts that the rest
 * of the note survives untouched.
 */

const workspaces: TestWorkspace[] = [];

function workspace(notes: Record<string, string>): TestWorkspace {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

function edit(
  created: TestWorkspace,
  relPath: string,
  oldText: string,
  newText: string,
): ReturnType<typeof replaceInNote> {
  return replaceInNote({
    root: created.vault,
    relPath,
    oldText,
    newText,
    maxWriteChars: 200_000,
  });
}

function read(created: TestWorkspace, relPath: string): string {
  return fs.readFileSync(path.join(created.vault, relPath), "utf-8");
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

describe("replaceInNote", () => {
  const note = [
    "---",
    "title: Memory-flash 18",
    "kind: out",
    "---",
    "",
    "# Memory-flash",
    "",
    "## Выжимка",
    "",
    "VNC: nine viewers, TigerVNC first.",
    "Источник: memory-flash 18",
    "",
  ].join("\n");

  it("replaces one fragment in a note outside every writable role", () => {
    const created = workspace({ "Test obsidian-bridge/Memory-flash-18.md": note });
    const outcome = edit(
      created,
      "Test obsidian-bridge/Memory-flash-18.md",
      "VNC: nine viewers, TigerVNC first.",
      "VNC: nine viewers; TigerVNC, TurboVNC, TightVNC.",
    );
    expect("error" in outcome).toBe(false);
    const text = read(created, "Test obsidian-bridge/Memory-flash-18.md");
    expect(text).toContain("VNC: nine viewers; TigerVNC, TurboVNC, TightVNC.");
    expect(text).not.toContain("TigerVNC first.");
    // Everything outside the fragment is untouched, frontmatter included.
    expect(text.startsWith("---\ntitle: Memory-flash 18\nkind: out\n---\n")).toBe(true);
    expect(text.endsWith("Источник: memory-flash 18\n")).toBe(true);
  });

  it("supports deletion and multi-line replacements", () => {
    const created = workspace({ "notes/long.md": "# Doc\n\nkeep\n\ndrop me\n\nend\n" });
    expect("error" in edit(created, "notes/long.md", "\n\ndrop me\n", "\n")).toBe(false);
    expect(read(created, "notes/long.md")).toBe("# Doc\n\nkeep\n\nend\n");

    const mult = workspace({ "notes/multi.md": "a\nb\nc\n" });
    expect("error" in edit(mult, "notes/multi.md", "a\nb", "x\ny\nz")).toBe(false);
    expect(read(mult, "notes/multi.md")).toBe("x\ny\nz\nc\n");
  });

  it("refuses an ambiguous fragment instead of guessing", () => {
    const created = workspace({ "notes/dup.md": "alpha\nbeta\nalpha\n" });
    const outcome = edit(created, "notes/dup.md", "alpha", "omega");
    expect("error" in outcome && outcome.error).toMatch(/occurs 2 times/);
    expect(read(created, "notes/dup.md")).toBe("alpha\nbeta\nalpha\n");
  });

  it("refuses a fragment that is not there", () => {
    const created = workspace({ "notes/one.md": "alpha\n" });
    const outcome = edit(created, "notes/one.md", "alpha ", "omega");
    expect("error" in outcome && outcome.error).toMatch(/not found/);
    expect(read(created, "notes/one.md")).toBe("alpha\n");
  });

  it("refuses to create a missing note", () => {
    const created = workspace({ "notes/one.md": "alpha\n" });
    const outcome = edit(created, "notes/two.md", "alpha", "omega");
    expect("error" in outcome && outcome.error).toMatch(/edits existing notes only/);
    expect(fs.existsSync(path.join(created.vault, "notes/two.md"))).toBe(false);
  });

  it("keeps writes inside the vault", () => {
    const created = workspace({ "notes/one.md": "alpha\n" });
    for (const relPath of ["../outside.md", "/etc/hostname", ".obsidian/app.json"]) {
      const outcome = edit(created, relPath, "alpha", "omega");
      expect("error" in outcome).toBe(true);
    }
    expect(read(created, "notes/one.md")).toBe("alpha\n");
  });

  it("refuses a symlink that leaves the vault", () => {
    const created = workspace({ "notes/one.md": "alpha\n" });
    const outside = path.join(path.dirname(created.vault), "outside.md");
    fs.writeFileSync(outside, "alpha\n", "utf-8");
    fs.symlinkSync(outside, path.join(created.vault, "notes/link.md"));
    const outcome = edit(created, "notes/link.md", "alpha", "omega");
    expect("error" in outcome && outcome.error).toMatch(/symlink/);
    expect(fs.readFileSync(outside, "utf-8")).toBe("alpha\n");
  });

  it("matches a CRLF note with LF input and preserves its line endings", () => {
    const created = workspace({ "notes/win.md": "one\r\ntwo\r\nthree\r\n" });
    const outcome = edit(created, "notes/win.md", "two\nthree", "2\n3");
    expect("error" in outcome).toBe(false);
    if (!("error" in outcome)) expect(outcome.normalizedLineEndings).toBe(true);
    expect(read(created, "notes/win.md")).toBe("one\r\n2\r\n3\r\n");
  });

  it("refuses an identical replacement and an empty fragment", () => {
    const created = workspace({ "notes/one.md": "alpha\n" });
    expect("error" in edit(created, "notes/one.md", "alpha", "alpha")).toBe(true);
    expect("error" in edit(created, "notes/one.md", "", "anything")).toBe(true);
  });

  it("respects the configured fragment limit", () => {
    const created = workspace({ "notes/one.md": "alpha\n" });
    const outcome = replaceInNote({
      root: created.vault,
      relPath: "notes/one.md",
      oldText: "alpha",
      newText: "x".repeat(50),
      maxWriteChars: 10,
    });
    expect("error" in outcome && outcome.error).toMatch(/configured limit is 10/);
  });
});
