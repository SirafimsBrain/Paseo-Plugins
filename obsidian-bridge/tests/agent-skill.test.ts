import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SKILL_NAME,
  agentSkillStatus,
  installAgentSkill,
  removeAgentSkill,
  resolveSkillSource,
  skillRoots,
} from "../server/agent-skill";

/**
 * The plugin's own skill: shipped in the checkout and copied into the skills
 * directories the installed agents already use. Only existing roots are touched,
 * unchanged copies are not rewritten, and turning the switch off removes it.
 */

const repoSkill = path.join(__dirname, "..", "skills", SKILL_NAME, "SKILL.md");
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
    expect(result.targets).toEqual([installed]);
    expect(fs.existsSync(path.join(first, SKILL_NAME))).toBe(false);
    expect(fs.readFileSync(installed, "utf-8")).toContain("Obsidian Bridge Skill");
  });

  it("does not rewrite a copy that is already current", () => {
    const [root] = roots();
    makeRoot(root);
    expect(installAgentSkill().targets.length).toBe(1);
    expect(installAgentSkill().targets).toEqual([]);
    expect(agentSkillStatus().installed).toEqual([path.join(root, SKILL_NAME, "SKILL.md")]);
  });

  it("replaces a stale copy", () => {
    const [root] = roots();
    makeRoot(root);
    const file = path.join(root, SKILL_NAME, "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "old", "utf-8");
    expect(agentSkillStatus().stale).toEqual([file]);
    expect(installAgentSkill().targets).toEqual([file]);
    expect(agentSkillStatus().stale).toEqual([]);
  });

  it("removes its own skill directory and leaves other skills alone", () => {
    const [root] = roots();
    makeRoot(root);
    fs.mkdirSync(path.join(root, "other-skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "other-skill", "SKILL.md"), "other", "utf-8");
    installAgentSkill();
    const { removed } = removeAgentSkill();
    expect(removed).toEqual([path.join(root, SKILL_NAME)]);
    expect(fs.existsSync(path.join(root, "other-skill", "SKILL.md"))).toBe(true);
  });

  it("reports no root when no agent is installed", () => {
    expect(agentSkillStatus().detected).toEqual([]);
    expect(installAgentSkill()).toEqual({ ok: true, targets: [] });
  });
});
