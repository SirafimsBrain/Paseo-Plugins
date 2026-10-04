import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Agent skill tests. The install targets are derived from `os.homedir()`,
 * so `HOME` is pointed at a temp directory for the suite — nothing is ever
 * written into the real agent skill directories.
 */

let tempHome: string;
const previousHome = process.env.HOME;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mfc-skill-home-"));
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

async function loadModule() {
  return import("../server/skill");
}

describe("remote memory skill", () => {
  it("is a valid SKILL.md with a name and description frontmatter", async () => {
    const { skillMarkdown } = await loadModule();
    const markdown = skillMarkdown();
    expect(markdown.startsWith("---\n")).toBe(true);
    expect(markdown).toContain("name: memory-flash-remote");
    expect(markdown).toContain("description:");
    // Frontmatter must close before the body starts.
    expect(markdown.indexOf("---", 4)).toBeGreaterThan(0);
  });

  it("names every tool a remote memory host serves", async () => {
    const { REMOTE_TOOL_NAMES, skillMarkdown } = await loadModule();
    const markdown = skillMarkdown();
    // The description is what an agent reads before the body, so every tool
    // has to appear there as well as in the tool list.
    expect(REMOTE_TOOL_NAMES).toEqual([
      "memory_save",
      "memory_search",
      "memory_get",
      "memory_update",
      "memory_delete",
      "memory_list_by_tag",
      "memory_handoff",
      "memory_stats",
    ]);
    for (const name of REMOTE_TOOL_NAMES) {
      expect(markdown).toContain(name);
    }
  });

  it("drives intensive read and write behaviour", async () => {
    const { skillMarkdown } = await loadModule();
    const markdown = skillMarkdown();
    // Read: more than one search, and never trust a fragment.
    expect(markdown).toContain("2-4");
    expect(markdown).toContain("memory_get");
    expect(markdown).toContain("memory_list_by_tag");
    expect(markdown).toContain("memory_stats");
    // Write: every bugfix, positive results, corrections, dedup before save.
    expect(markdown).toContain("Every bugfix is recorded");
    expect(markdown).toContain("Record positive results");
    expect(markdown).toContain("User corrections are decisions");
    expect(markdown).toContain("Search before you save");
    expect(markdown).toContain("memory_update");
    // Always a handoff, and the shared-base tagging rule.
    expect(markdown).toContain("memory_handoff");
    expect(markdown).toContain("untagged memory is lost memory");
  });

  it("explains the remote specifics: shared host, scope, several hosts", async () => {
    const { skillMarkdown } = await loadModule();
    const markdown = skillMarkdown();
    expect(markdown).toContain("memory host");
    expect(markdown).toContain("insufficient-scope");
    expect(markdown).toContain("read");
    expect(markdown).toContain("write");
    expect(markdown).toContain("identically");
  });

  it("installs, reports status and uninstalls into a target directory", async () => {
    const { SKILL_NAME, installSkill, skillFiles, skillMarkdown, skillStatuses, uninstallSkill } =
      await loadModule();

    const before = skillStatuses();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((row) => row.installed === false)).toBe(true);

    const result = installSkill("agents");
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(tempHome, ".agents", "skills", SKILL_NAME, "SKILL.md"));
    expect(fs.readFileSync(result.path!, "utf-8")).toBe(skillMarkdown());

    const after = skillStatuses();
    expect(after.find((row) => row.id === "agents")?.installed).toBe(true);
    expect(after.find((row) => row.id === "agents")?.upToDate).toBe(true);

    expect(skillFiles()).toEqual([{ name: "SKILL.md", content: skillMarkdown() }]);

    expect(uninstallSkill("agents").ok).toBe(true);
    expect(fs.existsSync(result.path!)).toBe(false);
    expect(skillStatuses().find((row) => row.id === "agents")?.installed).toBe(false);
  });

  it("rejects an unknown target instead of writing somewhere unexpected", async () => {
    const { installSkill, uninstallSkill } = await loadModule();
    expect(installSkill("nope").ok).toBe(false);
    expect(uninstallSkill("nope").ok).toBe(false);
  });
});