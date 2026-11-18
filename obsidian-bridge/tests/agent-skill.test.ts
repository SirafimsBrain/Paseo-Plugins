import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SKILL_DEFINITIONS,
  SKILL_NAME,
  SKILL_NAMES,
  agentSkillStatus,
  installAgentSkill,
  removeAgentSkill,
  resolveSkillSource,
  resolveSkillSources,
  skillRoots,
  skillStatuses,
  verifyAgentSkill,
} from "../server/agent-skill";

/**
 * The plugin's own skill: shipped in the checkout and copied into the skills
 * directories the installed agents already use. Only existing roots are touched,
 * unchanged copies are not rewritten, and turning the switch off removes it.
 */

const repoSkill = path.join(__dirname, "..", "skills", SKILL_NAME, "SKILL.md");
const PLANNING_SKILLS = ["planning-create", "planning-execute", "planning-review"];

function skillFile(name: string): string {
  return path.join(__dirname, "..", "skills", name, "SKILL.md");
}
let home = "";
const previousHome = process.env.HOME;
const previousXdg = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "obb-skill-"));
  // `os.homedir()` follows $HOME on POSIX, which is what the module uses.
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  fs.rmSync(home, { recursive: true, force: true });
});

function roots(): string[] {
  return skillRoots().map((root) => root.dir);
}

function makeRoot(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

describe("agent skill", () => {
  it("ships a skill with the Agent Skills frontmatter", () => {
    const text = fs.readFileSync(repoSkill, "utf-8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain(`name: ${SKILL_NAME}`);
    expect(text).toMatch(/\ndescription: .+\n/);
    expect(text).toContain("obsidian_edit");
  });

  it("finds the shipped skill next to the code", () => {
    expect(resolveSkillSource()).toContain(path.join("skills", SKILL_NAME, "SKILL.md"));
  });

  it("installs only into skills roots that already exist", () => {
    const [first, second] = roots();
    makeRoot(second);
    const result = installAgentSkill();
    expect(result.ok).toBe(true);
    const installed = path.join(second, SKILL_NAME, "SKILL.md");
    expect(result.targets.length).toBe(SKILL_NAMES.length);
    expect(result.targets).toContain(installed);
    expect(fs.existsSync(path.join(first, SKILL_NAME))).toBe(false);
    expect(fs.readFileSync(installed, "utf-8")).toContain("Obsidian Bridge Skill");
    for (const name of PLANNING_SKILLS) {
      expect(fs.existsSync(path.join(second, name, "SKILL.md"))).toBe(true);
    }
  });

  it("does not rewrite a copy that is already current", () => {
    const [root] = roots();
    makeRoot(root);
    expect(installAgentSkill().targets.length).toBe(SKILL_NAMES.length);
    expect(installAgentSkill().targets).toEqual([]);
    expect(agentSkillStatus().installed.length).toBe(SKILL_NAMES.length);
    expect(agentSkillStatus().installed).toContain(path.join(root, SKILL_NAME, "SKILL.md"));
  });

  it("replaces a stale copy", () => {
    const [root] = roots();
    makeRoot(root);
    const file = path.join(root, SKILL_NAME, "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old", "utf-8");
    expect(agentSkillStatus().stale).toContain(file);
    expect(installAgentSkill().targets).toContain(file);
    expect(agentSkillStatus().stale).toEqual([]);
  });

  it("removes its own skill directory and leaves other skills alone", () => {
    const [root] = roots();
    makeRoot(root);
    fs.mkdirSync(path.join(root, "other-skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "other-skill", "SKILL.md"), "other", "utf-8");
    installAgentSkill();
    const { removed } = removeAgentSkill();
    expect(removed.length).toBe(SKILL_NAMES.length);
    expect(removed).toContain(path.join(root, SKILL_NAME));
    for (const name of SKILL_NAMES) {
      expect(fs.existsSync(path.join(root, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(root, "other-skill", "SKILL.md"))).toBe(true);
  });

  it("verifies and repairs what drifted, including a hand-edited skill", () => {
    const [shared] = roots();
    makeRoot(shared);
    const file = path.join(shared, SKILL_NAME, "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "stale", "utf-8");
    const result = verifyAgentSkill();
    expect(result.checked).toContain(shared);
    expect(result.repaired).toContain(file);
    expect(result.repaired.length).toBe(SKILL_NAMES.length);
    expect(fs.readFileSync(file, "utf-8")).toBe(fs.readFileSync(repoSkill, "utf-8"));
    // A second pass has nothing to repair.
    expect(verifyAgentSkill().repaired).toEqual([]);
  });

  it("covers the shared, Cline and Kilo skills directories", () => {
    const labels = skillRoots().map((root) => `${root.label}:${root.dir}`);
    expect(labels.some((entry) => entry.includes(".agents/skills"))).toBe(true);
    expect(labels.some((entry) => entry.includes(".cline/skills"))).toBe(true);
    expect(labels.some((entry) => entry.includes(".kilo/skills"))).toBe(true);
    expect(labels[0]).toContain(".agents/skills");
  });

  it("reports a per-root status list for the settings screen", () => {
    const [shared, opencode] = roots();
    makeRoot(shared);
    makeRoot(opencode);
    installAgentSkill();
    const statuses = skillStatuses().filter((row) => row.detected);
    expect(statuses.length).toBe(2 * SKILL_NAMES.length);
    expect(statuses.every((row) => row.installed && row.upToDate === true)).toBe(true);
    expect([...new Set(statuses.map((row) => row.root))].sort()).toEqual([opencode, shared].sort());
    expect(new Set(statuses.map((row) => row.skill)).size).toBe(SKILL_NAMES.length);
  });

  it("reports no root when no agent is installed", () => {
    expect(agentSkillStatus().detected).toEqual([]);
    expect(installAgentSkill()).toEqual({ ok: true, targets: [] });
  });

  it("ships the three planning skills, each naming its tools and the planning root", () => {
    for (const name of PLANNING_SKILLS) {
      const text = fs.readFileSync(skillFile(name), "utf-8");
      expect(text.startsWith("---\n")).toBe(true);
      expect(text).toContain(`name: ${name}`);
      expect(text).toMatch(/\ndescription: .+\n/);
      expect(text).toContain("planRoot");
      expect(text).toMatch(/plan_[a-z_]+/);
      // The skills never carry a machine-specific path: the root is configured, not assumed.
      expect(text).not.toMatch(/(^|\s)\/(home|Users|tmp|var|DISK1|mnt)\//);
    }
  });

  it("installs and removes every shipped skill, not just the first", () => {
    const [root] = roots();
    makeRoot(root);
    const installed = installAgentSkill();
    expect(installed.ok).toBe(true);
    expect(installed.targets.length).toBe(SKILL_DEFINITIONS.length);
    for (const name of SKILL_NAMES) {
      expect(fs.existsSync(path.join(root, name, "SKILL.md"))).toBe(true);
    }
    expect(removeAgentSkill().removed.sort()).toEqual(
      SKILL_NAMES.map((name) => path.join(root, name)).sort(),
    );
  });

  it("repairs exactly the planning skill that drifted", () => {
    const [root] = roots();
    makeRoot(root);
    installAgentSkill();
    const target = path.join(root, "planning-execute", "SKILL.md");
    fs.writeFileSync(target, "old instructions", "utf-8");
    expect(agentSkillStatus().stale).toEqual([target]);
    expect(verifyAgentSkill().repaired).toEqual([target]);
    expect(fs.readFileSync(target, "utf-8")).toBe(
      fs.readFileSync(skillFile("planning-execute"), "utf-8"),
    );
  });

  it("reports one row per skill and root in the settings list", () => {
    makeRoot(roots()[0]);
    const rows = skillStatuses().filter((row) => row.detected);
    expect(rows.map((row) => row.skill).sort()).toEqual([...SKILL_NAMES].sort());
    expect(rows.every((row) => row.purpose.length > 0)).toBe(true);
    expect(resolveSkillSources().every((entry) => entry.path !== null)).toBe(true);
  });
});
