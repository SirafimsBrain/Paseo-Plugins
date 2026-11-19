import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planDirectoryState } from "../server/plan/folder";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/**
 * "Planning directory" check/create actions (0.21.13).
 *
 * The settings screen can report whether the configured planning folder exists
 * and create it on request. These tests use the real filesystem: the point is
 * what `stat`, `mkdir` and `realpath` do, and the boundary must hold for the
 * button exactly as it holds for `plan_*`.
 */

const workspaces: TestWorkspace[] = [];

function workspace(notes: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

describe("planDirectoryState", () => {
  it("reports a missing folder without creating it", () => {
    const space = workspace();
    const state = planDirectoryState(runtimeSettings(space.vault), { relPath: "Projects" });
    expect(state.error).toBeNull();
    expect(state.exists).toBe(false);
    expect(state.created).toBe(false);
    expect(state.folder).toBe("Projects");
    expect(fs.existsSync(path.join(space.vault, "Projects"))).toBe(false);
  });

  it("reports an existing folder", () => {
    const space = workspace({ "Projects/orion/plan.md": "# plan" });
    const state = planDirectoryState(runtimeSettings(space.vault), { relPath: "Projects" });
    expect(state.exists).toBe(true);
    expect(state.isDirectory).toBe(true);
    expect(state.path).toBe(path.join(space.vault, "Projects"));
  });

  it("creates the folder and its missing parents on request", () => {
    const space = workspace();
    const first = planDirectoryState(runtimeSettings(space.vault), {
      relPath: "Planning/Projects",
      create: true,
    });
    expect(first.error).toBeNull();
    expect(first.created).toBe(true);
    expect(first.exists).toBe(true);
    expect(fs.statSync(path.join(space.vault, "Planning/Projects")).isDirectory()).toBe(true);

    const second = planDirectoryState(runtimeSettings(space.vault), {
      relPath: "Planning/Projects",
      create: true,
    });
    expect(second.exists).toBe(true);
    expect(second.created).toBe(false);
  });

  it("uses the saved setting, falling back to Projects when it is empty", () => {
    const space = workspace();
    expect(
      planDirectoryState(runtimeSettings(space.vault, { planRoot: "Projects" })).folder,
    ).toBe("Projects");
    expect(planDirectoryState(runtimeSettings(space.vault, { planRoot: "" })).folder).toBe(
      "Projects",
    );
    expect(
      planDirectoryState(runtimeSettings(space.vault, { planRoot: "Notes/Plans" })).folder,
    ).toBe("Notes/Plans");
  });

  it("asks for the configured directory first", () => {
    const state = planDirectoryState(runtimeSettings(""), { relPath: "Projects", create: true });
    expect(state.exists).toBe(false);
    expect(state.error).toContain("Set the directory available to Paseo first");
  });

  it("refuses values that could address something above the directory", () => {
    const space = workspace();
    for (const value of ["../outside", "/tmp/elsewhere", ".obsidian/plugins", "a/../../b"]) {
      const state = planDirectoryState(runtimeSettings(space.vault), {
        relPath: value,
        create: true,
      });
      expect(state.error, value).not.toBeNull();
      expect(state.created).toBe(false);
    }
    expect(fs.readdirSync(space.vault).sort()).toEqual([".obsidian"]);
  });

  it("refuses a folder reached through a symlink out of the directory, creating nothing", () => {
    const space = workspace();
    const outside = fs.mkdtempSync(path.join(space.home, "outside-"));
    fs.symlinkSync(outside, path.join(space.vault, "linked"), "dir");

    const state = planDirectoryState(runtimeSettings(space.vault), {
      relPath: "linked/Projects",
      create: true,
    });
    expect(state.error).toContain("outside the configured vault");
    expect(state.created).toBe(false);
    expect(fs.existsSync(path.join(outside, "Projects"))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("reports a file sitting where the folder should be", () => {
    const space = workspace({ Projects: "not a folder" });
    const state = planDirectoryState(runtimeSettings(space.vault), {
      relPath: "Projects",
      create: true,
    });
    expect(state.exists).toBe(false);
    expect(state.error).toContain("not a directory");
  });
});
