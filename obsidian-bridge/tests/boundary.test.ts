import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "../server/mcp-tools";
import { mirrorPathIn, parseSettingsFile, readSettingsMirror } from "../server/settings-file";
import { writeSettingsMirror } from "../server/settings-mirror";
import { makeWorkspace, runtimeSettings, type TestWorkspace } from "./fixtures";

/**
 * The boundary the plugin enforces itself (0.20.13).
 *
 * These are the cases reproduced during the permission audit: a symlinked note
 * or role directory that led outside the configured directory, a project
 * checkout's `.env` and `.git/config` being readable, and `obsidian_edit`
 * reaching above the configured directory.
 */

const workspaces: TestWorkspace[] = [];
const tempDirs: string[] = [];

function vaultWith(notes: Record<string, string> = {}): TestWorkspace {
  const created = makeWorkspace(notes);
  workspaces.push(created);
  return created;
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function siblingOfVault(created: TestWorkspace, name: string): string {
  const dir = path.join(path.dirname(created.vault), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (workspaces.length > 0) workspaces.pop()?.cleanup();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("symlinked paths (R1, R2)", () => {
  it("refuses to read a note whose symlink leads outside the configured directory", async () => {
    const created = vaultWith({ "notes/real.md": "# Safe\n" });
    const outside = siblingOfVault(created, "outside");
    fs.writeFileSync(path.join(outside, "secret.md"), "TOPSECRET-CONTENT\n", "utf-8");
    fs.mkdirSync(path.join(created.vault, "notes"), { recursive: true });
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(created.vault, "notes/link.md"));

    const read = await dispatchTool("obsidian_read", { path: "notes/link.md" }, runtimeSettings(created.vault));

    expect(read.isError).toBe(true);
    expect(read.text).not.toContain("TOPSECRET-CONTENT");
  });

  it("refuses to write through a role directory that is a symlink out of the directory", async () => {
    const created = vaultWith();
    const outside = siblingOfVault(created, "outside-writes");
    fs.symlinkSync(outside, path.join(created.vault, "raw"));

    const write = await dispatchTool(
      "obsidian_write_scratch",
      { name: "leak", body: "must not land outside" },
      runtimeSettings(created.vault),
    );

    expect(write.isError).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses to edit a symlinked note that leads outside the directory", async () => {
    const created = vaultWith();
    const outside = siblingOfVault(created, "outside-edit");
    const target = path.join(outside, "secret.md");
    fs.writeFileSync(target, "before\n", "utf-8");
    fs.symlinkSync(target, path.join(created.vault, "link.md"));

    const edit = await dispatchTool(
      "obsidian_edit",
      { path: "link.md", old_text: "before", new_text: "after" },
      runtimeSettings(created.vault),
    );

    expect(edit.isError).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("before\n");
  });
});

describe("document extension allowlist (R3)", () => {
  it("accepts Markdown and refuses other files, dot files and extensionless names", async () => {
    const created = vaultWith({
      "notes/guide.md": "# Guide\n\nReadable.\n",
      "notes/plain.txt": "plain text\n",
      ".env": "OPENAI_API_KEY=sk-live\n",
      ".git/config": "[remote]\n\turl = https://user:token@example.com/repo.git\n",
      LICENSE: "MIT\n",
    });
    const settings = runtimeSettings(created.vault);

    const markdown = await dispatchTool("obsidian_read", { path: "notes/guide.md" }, settings);
    expect(markdown.isError).toBeUndefined();

    for (const candidate of ["notes/plain.txt", ".env", ".git/config", "LICENSE"]) {
      const refused = await dispatchTool("obsidian_read", { path: candidate }, settings);
      expect(refused.isError, candidate).toBe(true);
      expect(refused.text, candidate).toContain("only .md files");
    }
    expect((await dispatchTool("obsidian_read", { path: ".env" }, settings)).text).not.toContain(
      "sk-live",
    );
  });

  it("lets the user add an extension, while dot files stay refused", async () => {
    const created = vaultWith({
      "notes/plain.txt": "plain text\n",
      ".env": "OPENAI_API_KEY=sk-live\n",
    });
    const settings = runtimeSettings(created.vault, { allowedExtensions: ".md, txt" });

    const txt = await dispatchTool("obsidian_read", { path: "notes/plain.txt" }, settings);
    expect(txt.isError).toBeUndefined();
    expect((txt.structuredContent as { content: string }).content).toContain("plain text");

    const env = await dispatchTool("obsidian_read", { path: ".env" }, settings);
    expect(env.isError).toBe(true);
    expect(env.text).not.toContain("sk-live");
  });

  it("refuses to edit a non-document file even when it exists", async () => {
    const created = vaultWith({ ".env": "OPENAI_API_KEY=sk-live\n" });

    const edit = await dispatchTool(
      "obsidian_edit",
      { path: ".env", old_text: "sk-live", new_text: "rotated" },
      runtimeSettings(created.vault),
    );

    expect(edit.isError).toBe(true);
    expect(fs.readFileSync(path.join(created.vault, ".env"), "utf-8")).toContain("sk-live");
  });
});

describe("obsidian_edit boundary (R4)", () => {
  it("refuses a path above the configured directory and says why", async () => {
    const created = vaultWith({ "note.md": "# Note\n" });
    const outside = siblingOfVault(created, "outside-project");
    fs.writeFileSync(path.join(outside, "other.md"), "foreign\n", "utf-8");

    const edit = await dispatchTool(
      "obsidian_edit",
      { path: "../outside-project/other.md", old_text: "foreign", new_text: "changed" },
      runtimeSettings(created.vault),
    );

    expect(edit.isError).toBe(true);
    expect(edit.text).toContain("inside the configured Obsidian directory");
    expect(edit.text).toContain("do not retry");
    expect(fs.readFileSync(path.join(outside, "other.md"), "utf-8")).toBe("foreign\n");
  });

  it("still edits a note anywhere below the configured directory", async () => {
    const created = vaultWith({ "deep/folder/note.md": "# Note\n\nBefore.\n" });

    const edit = await dispatchTool(
      "obsidian_edit",
      { path: "deep/folder/note.md", old_text: "Before.", new_text: "After." },
      runtimeSettings(created.vault),
    );

    expect(edit.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(created.vault, "deep/folder/note.md"), "utf-8")).toContain(
      "After.",
    );
  });
});

describe("settings mirror as data (R5)", () => {
  function mirror(target: string, document: unknown, mode = 0o600): string {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(document), { encoding: "utf-8", mode });
    fs.chmodSync(target, mode);
    return target;
  }

  it("ignores a mirror that a foreign writer put there", () => {
    const home = tempDir("obb-mirror-");
    const target = mirror(mirrorPathIn(home), {
      values: { vaultPath: "/tmp/elsewhere", readOnly: false },
    });

    const read = readSettingsMirror(target);
    expect(read.accepted).toBe(false);
    expect(read.reason).toBe("not written by this plugin");
    // Closed state: no vault path, so every tool refuses with instructions.
    expect(parseSettingsFile(target).vaultPath).toBe("");
  });

  it("ignores a group-writable mirror", () => {
    const home = tempDir("obb-mirror-");
    const target = mirror(
      mirrorPathIn(home),
      { writtenBy: "obsidian-bridge", values: { vaultPath: "/tmp/elsewhere" } },
      0o664,
    );

    expect(readSettingsMirror(target).reason).toBe("writable by group or others");
    expect(parseSettingsFile(target).vaultPath).toBe("");
  });

  it("accepts the mirror the plugin writes", () => {
    const home = tempDir("obb-mirror-");
    const target = mirrorPathIn(home);
    writeSettingsMirror(
      { ...parseSettingsFile(mirrorPathIn(home)), vaultPath: "/vault/here", readOnly: true },
      target,
    );

    const read = readSettingsMirror(target);
    expect(read.accepted).toBe(true);
    const settings = parseSettingsFile(target);
    expect(settings.vaultPath).toBe("/vault/here");
    expect(settings.readOnly).toBe(true);
    expect(settings.planRoot).toBe("Projects");
    expect(settings.allowedExtensions).toBe(".md");
  });
});
