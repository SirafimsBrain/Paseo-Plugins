import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendToNote,
  describeRoleDirs,
  normalizeRoleDir,
  resolveRoleDirs,
  resolveRolePath,
  roleOfPath,
} from "../server/dirs";
import { dispatchTool } from "../server/mcp-tools";
import { indexPathFor } from "../server/paths";
import { scanVault } from "../server/scan";
import { BridgeStore } from "../server/store";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

const workspaces: TestWorkspace[] = [];

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
});

function workspace(notes: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace({
    "Inbox/source.md": "# Source\n\nPrimary material about queues.\n",
    "Documentation/guide.md": "# Guide\n\nExisting authored document.\n",
    "raw/notes.md": "# Notes\n\nScratch.\n",
    ...notes,
  });
  workspaces.push(created);
  return created;
}

function index(created: TestWorkspace) {
  const settings = runtimeSettings(created.vault);
  const store = new BridgeStore(indexPathFor(created.vault), { stemming: false });
  scanVault({ root: created.vault, store, settings, force: true });
  store.close();
  return settings;
}

describe("role paths", () => {
  it("rejects absolute paths, parent traversal and the config directory", () => {
    expect(normalizeRoleDir("/abs")).toBeNull();
    expect(normalizeRoleDir("../up")).toBeNull();
    expect(normalizeRoleDir(".obsidian/plugins")).toBeNull();
    expect(normalizeRoleDir(" Inbox/Sub ")).toBe("Inbox/Sub");
    expect(normalizeRoleDir("")).toBeNull();
  });

  it("resolves the most specific role and falls back to the workspace", () => {
    const dirs = resolveRoleDirs(runtimeSettings("/tmp/vault"));
    expect(dirs).toEqual({ workspace: "", inbox: "Inbox", out: "Documentation", raw: "raw" });
    expect(roleOfPath("Inbox/a.md", dirs)).toBe("inbox");
    expect(roleOfPath("Documentation/a.md", dirs)).toBe("out");
    expect(roleOfPath("raw/deep/a.md", dirs)).toBe("raw");
    expect(roleOfPath("Projects/a.md", dirs)).toBe("workspace");
  });

  it("refuses a document name that escapes its directory", () => {
    const dirs = resolveRoleDirs(runtimeSettings("/tmp/vault"));
    expect(resolveRolePath(dirs, "out", "../../etc/passwd")).toEqual({
      error: expect.stringContaining("not a file name"),
    });
    expect(resolveRolePath(dirs, "out", "/abs.md")).toEqual({
      error: expect.stringContaining("not a file name"),
    });
    expect(resolveRolePath(dirs, "out", "Guides/queue")).toEqual({
      path: "Documentation/Guides/queue.md",
    });
  });

  it("describes every role for agents", () => {
    const dirs = resolveRoleDirs(runtimeSettings("/tmp/vault"));
    expect(describeRoleDirs(dirs).map((entry) => entry.role)).toEqual([
      "workspace",
      "inbox",
      "out",
      "raw",
    ]);
  });
});

describe("appendToNote", () => {
  it("creates a document with frontmatter and appends sections afterwards", () => {
    const created = workspace();
    const dirs = resolveRoleDirs(runtimeSettings(created.vault));

    const first = appendToNote({
      root: created.vault,
      dirs,
      role: "out",
      name: "Queue guide",
      title: "Queue guide",
      body: "First section.",
      create: true,
    });
    expect(first).toMatchObject({ path: "Documentation/Queue guide.md", created: true });
    const file = path.join(created.vault, "Documentation/Queue guide.md");
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("kind: out");
    expect(content).toContain("# Queue guide");
    expect(content).toContain("First section.");

    const second = appendToNote({
      root: created.vault,
      dirs,
      role: "out",
      name: "Queue guide",
      title: "Second",
      body: "Second section.",
      create: true,
    });
    expect(second).toMatchObject({ created: false, duplicate: false });
    expect(fs.readFileSync(file, "utf-8")).toContain("Second section.");
    // Append-only: the earlier text is still there, in order.
    expect(fs.readFileSync(file, "utf-8").indexOf("First section.")).toBeLessThan(
      fs.readFileSync(file, "utf-8").indexOf("Second section."),
    );
  });

  it("reports an identical body as a duplicate instead of writing twice", () => {
    const created = workspace();
    const dirs = resolveRoleDirs(runtimeSettings(created.vault));
    appendToNote({ root: created.vault, dirs, role: "raw", name: "notes", body: "same", create: false });
    const repeat = appendToNote({
      root: created.vault,
      dirs,
      role: "raw",
      name: "notes",
      body: "same",
      create: false,
    });
    expect(repeat).toMatchObject({ duplicate: true });
  });

  it("refuses a missing document when create is not requested", () => {
    const created = workspace();
    const dirs = resolveRoleDirs(runtimeSettings(created.vault));
    expect(
      appendToNote({
        root: created.vault,
        dirs,
        role: "raw",
        name: "missing",
        body: "x",
        create: false,
      }),
    ).toEqual({ error: expect.stringContaining("does not exist") });
  });
});

describe("write tools", () => {
  it("writes into the configured out, raw and inbox directories", () => {
    const created = workspace();
    const settings = index(created);

    const document = dispatchTool(
      "obsidian_write_document",
      { name: "Queue guide", title: "Queue guide", body: "Authored content." },
      settings,
    );
    expect(document.isError).toBeUndefined();
    expect(document.structuredContent).toMatchObject({ path: "Documentation/Queue guide.md", created: true });
    expect(fs.existsSync(path.join(created.vault, "Documentation/Queue guide.md"))).toBe(true);

    const scratch = dispatchTool(
      "obsidian_write_scratch",
      { name: "bugfix-alt", body: "Option A: retry." },
      settings,
    );
    expect(scratch.structuredContent).toMatchObject({ path: "raw/bugfix-alt.md" });

    const inbox = dispatchTool("obsidian_append_inbox", { body: "New source arrived." }, settings);
    expect(inbox.structuredContent).toMatchObject({ path: "Inbox/Inbox.md", created: true });
  });

  it("refuses every write when readOnly is on", () => {
    const created = workspace();
    const settings = index(created);
    const readOnly = { ...settings, readOnly: true };
    for (const [tool, args] of [
      ["obsidian_write_document", { name: "x", body: "y" }],
      ["obsidian_write_scratch", { name: "x", body: "y" }],
      ["obsidian_append_inbox", { body: "y" }],
    ] as const) {
      const outcome = dispatchTool(tool, args, readOnly);
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("Writes are disabled");
    }
  });

  it("refuses a body over the configured limit", () => {
    const created = workspace();
    const settings = { ...index(created), maxWriteChars: 1000 };
    const outcome = dispatchTool(
      "obsidian_write_scratch",
      { name: "big", body: "x".repeat(1200) },
      settings,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("limit is 1000");
  });

  it("cannot write outside the configured roles or above the root", () => {
    const created = workspace();
    const settings = index(created);
    const escaped = dispatchTool(
      "obsidian_write_document",
      { name: "../../outside", body: "x" },
      settings,
    );
    expect(escaped.isError).toBe(true);

    const read = dispatchTool("obsidian_read", { path: "../outside.md" }, settings);
    expect(read.isError).toBe(true);
    expect(read.text).toContain("outside the vault");
  });

  it("tells the agent which directory is for what", () => {
    const created = workspace();
    const settings = index(created);
    const outcome = dispatchTool("obsidian_directories", {}, settings);
    expect(outcome.structuredContent).toMatchObject({
      directories: {
        workspace: "",
        inbox: "Inbox",
        out: "Documentation",
        raw: "raw",
      },
      writesEnabled: true,
    });
    const roles = (outcome.structuredContent as { roles: Array<{ role: string; use: string }> }).roles;
    expect(roles.map((role) => role.role)).toEqual(["workspace", "inbox", "out", "raw"]);
    expect(roles.find((role) => role.role === "raw")?.use).toContain("Scratch");
  });

  it("tags search hits and listings with their role and filters by scope", () => {
    const created = workspace();
    const settings = index(created);

    const all = dispatchTool("obsidian_search", { query: "material" }, settings);
    const hits = (all.structuredContent as { hits: Array<{ path: string; role: string }> }).hits;
    const inboxHit = hits.find((hit) => hit.path.startsWith("Inbox/"));
    expect(inboxHit?.role).toBe("inbox");

    const outOnly = dispatchTool(
      "obsidian_search",
      { query: "queues", scope: "out" },
      settings,
    );
    const outHits = (outOnly.structuredContent as { hits: Array<{ role: string }> }).hits;
    expect(outHits.every((hit) => hit.role === "out")).toBe(true);

    const listed = dispatchTool("obsidian_list", { scope: "raw" }, settings);
    const notes = (listed.structuredContent as { notes: Array<{ role: string }> }).notes;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((note) => note.role === "raw")).toBe(true);
  });
});
