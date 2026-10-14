import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SKILL_NAME,
  ensureSkillInstalled,
  installSkill,
  skillMarkdown,
  skillStatuses,
  skillTargets,
  uninstallSkill,
} from "../server/skill";

/**
 * Stage D3 acceptance (`PLAN.md`): the skill installs. Everything resolves
 * through `os.homedir()`, which on POSIX reads `$HOME` — without isolation
 * these tests would touch the real `~/.agents/skills`.
 */

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "luck-skill-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  };
});

describe("skill installer", () => {
  it("reports the seven known targets with install state", () => {
    const statuses = skillStatuses();
    expect(statuses).toHaveLength(7);
    const ids = statuses.map((status) => status.id).sort();
    expect(ids).toEqual([
      "agents",
      "claude",
      "cline",
      "codex",
      "kilo",
      "opencode",
      "qwen",
    ]);
    for (const status of statuses) {
      expect(status.path).toContain(path.join(SKILL_NAME, "SKILL.md"));
      expect(status.detected).toBe(false); // isolated HOME starts empty
      expect(status.installed).toBe(false);
      expect(status.upToDate).toBeNull();
    }
    // Targets resolve inside the isolated home — no write escaped it.
    for (const target of skillTargets()) {
      expect(target.dir().startsWith(home)).toBe(true);
    }
  });

  it("installs and uninstalls into a target directory", () => {
    const agents = skillStatuses().find((status) => status.id === "agents");
    const install = installSkill("agents");
    expect(install.ok).toBe(true);
    expect(install.path).toBe(agents?.path);
    expect(fs.existsSync(install.path!)).toBe(true);

    const content = fs.readFileSync(install.path!, "utf-8");
    expect(content).toContain("name: luck-planner");
    expect(content).toContain("luck_tree_search");
    expect(content).toContain("luck_tree_upsert_leaf");
    expect(content).toContain("luck_tree_set_goal");

    const after = skillStatuses().find((status) => status.id === "agents");
    expect(after?.installed).toBe(true);
    expect(after?.upToDate).toBe(true);

    const uninstall = uninstallSkill("agents");
    expect(uninstall.ok).toBe(true);
    expect(fs.existsSync(install.path!)).toBe(false);
  });

  it("rejects unknown targets", () => {
    expect(installSkill("nope").ok).toBe(false);
    expect(uninstallSkill("nope").ok).toBe(false);
  });

  it("ships a protocol document, not a tool list", () => {
    const markdown = skillMarkdown();
    expect(markdown).toMatch(/^---\n/);
    expect(markdown).toContain("name: luck-planner");
    // All eight tools are named.
    for (const tool of [
      "luck_tree_get_context",
      "luck_tree_search",
      "luck_tree_upsert_leaf",
      "luck_tree_add_bee",
      "luck_tree_report_bug",
      "luck_tree_set_goal",
      "luck_tree_update_growth",
      "luck_tree_history",
    ]) {
      expect(markdown).toContain(tool);
    }
    // The three lessons the plan names explicitly: when to create a leaf,
    // when to move a status, and that revision/audit are automatic.
    expect(markdown).toContain("When to create a leaf");
    expect(markdown).toContain("Status transitions");
    expect(markdown).toContain("never manage them by hand");
    // Approval gate (ADR-7) and scoping rules travel with the skill.
    expect(markdown).toContain("You cannot approve a goal");
    expect(markdown).toContain("project_key");
    expect(markdown).toContain("English");
  });
});

describe("ensureSkillInstalled (plugin-load auto-install)", () => {
  it("installs only into directories that already exist", () => {
    const agentsDir = path.join(home, ".agents", "skills");
    fs.mkdirSync(agentsDir, { recursive: true });
    // `.claude` deliberately does not exist — an unused agent convention.

    const written = ensureSkillInstalled();
    expect(written).toEqual([path.join(agentsDir, SKILL_NAME, "SKILL.md")]);
    expect(fs.existsSync(path.join(agentsDir, SKILL_NAME, "SKILL.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
  });

  it("is idempotent and rewrites only stale content", () => {
    const agentsDir = path.join(home, ".agents", "skills");
    fs.mkdirSync(agentsDir, { recursive: true });

    expect(ensureSkillInstalled()).toHaveLength(1);
    // Second load: content is current — nothing is rewritten (a load must
    // not churn files every time).
    expect(ensureSkillInstalled()).toEqual([]);

    const file = path.join(agentsDir, SKILL_NAME, "SKILL.md");
    fs.writeFileSync(file, "stale content from an older release\n");
    const rewritten = ensureSkillInstalled();
    expect(rewritten).toEqual([file]);
    expect(fs.readFileSync(file, "utf-8")).toBe(skillMarkdown());
  });

  it("returns nothing on a machine without skill directories", () => {
    expect(ensureSkillInstalled()).toEqual([]);
  });
});
