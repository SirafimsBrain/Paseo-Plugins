import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { paseoHome } from "./paths";
import { configuredPluginPath } from "./mcp-launch";

/**
 * Installs the plugin's own agent skill.
 *
 * Paseo 0.15.x has no skill API, so the skill is delivered the way the agent
 * runtimes already look for one: a `<skills-root>/<name>/SKILL.md` directory in
 * the user's home. The roots belong to the agents (OpenCode, Codex-style
 * `~/.agents`, Claude Code), so a root that does not exist is left alone — the
 * plugin never creates a skills directory for a runtime the user does not have.
 *
 * The skill itself lives in the repository (`skills/obsidian-bridge/SKILL.md`),
 * which makes it reviewable and versioned with the code instead of being
 * generated from strings. It is rewritten only when its content differs, and it
 * is removed when the settings switch is turned off.
 */

export const SKILL_NAME = "obsidian-bridge";
const SKILL_FILE = "SKILL.md";

export interface SkillRoot {
  label: string;
  dir: string;
}

export interface SkillStatus {
  /** Absolute path of the skill in the checkout, or `null` when it is missing. */
  source: string | null;
  /** Skills roots that exist on this machine. */
  detected: string[];
  /** `<root>/<name>/SKILL.md` where the installed copy is current. */
  installed: string[];
  /** Installed copies whose content differs from the checkout. */
  stale: string[];
}

export function skillRoots(): SkillRoot[] {
  const home = os.homedir();
  return [
    { label: "OpenCode", dir: path.join(home, ".config", "opencode", "skills") },
    { label: "OpenCode", dir: path.join(home, ".opencode", "skills") },
    { label: "Codex", dir: path.join(home, ".agents", "skills") },
    { label: "Claude Code", dir: path.join(home, ".claude", "skills") },
  ];
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readIfExists(candidate: string): string | null {
  try {
    return fs.readFileSync(candidate, "utf-8");
  } catch {
    return null;
  }
}

/** Locates `skills/obsidian-bridge/SKILL.md` in the installed checkout. */
export function resolveSkillSource(): string | null {
  const candidates: string[] = [];
  const configured = configuredPluginPath();
  if (configured) candidates.push(path.join(configured, "skills", SKILL_NAME, SKILL_FILE));
  if (typeof __dirname === "string") {
    candidates.push(path.join(__dirname, "..", "skills", SKILL_NAME, SKILL_FILE));
    candidates.push(path.join(__dirname, "skills", SKILL_NAME, SKILL_FILE));
  }
  candidates.push(path.join(paseoHome(), "plugins", SKILL_NAME, "skills", SKILL_NAME, SKILL_FILE));
  for (const candidate of candidates) {
    if (readIfExists(candidate) !== null) return candidate;
  }
  return null;
}

export function agentSkillStatus(): SkillStatus {
  const source = resolveSkillSource();
  const content = source === null ? null : readIfExists(source);
  const detected: string[] = [];
  const installed: string[] = [];
  const stale: string[] = [];
  for (const root of skillRoots()) {
    if (!isDirectory(root.dir)) continue;
    detected.push(root.dir);
    const file = path.join(root.dir, SKILL_NAME, SKILL_FILE);
    const existing = readIfExists(file);
    if (existing === null) continue;
    if (content !== null && existing === content) installed.push(file);
    else stale.push(file);
  }
  return { source, detected, installed, stale };
}

/**
 * Writes the skill into every skills root that exists. Unchanged copies are left
 * untouched; a changed skill replaces the old file atomically.
 */
export function installAgentSkill(): { ok: boolean; targets: string[]; error?: string } {
  const source = resolveSkillSource();
  if (source === null) {
    return { ok: false, targets: [], error: "skills/obsidian-bridge/SKILL.md is missing from the checkout" };
  }
  let content: string;
  try {
    content = fs.readFileSync(source, "utf-8");
  } catch (cause) {
    return { ok: false, targets: [], error: cause instanceof Error ? cause.message : String(cause) };
  }
  const targets: string[] = [];
  for (const root of skillRoots()) {
    if (!isDirectory(root.dir)) continue;
    const skillDir = path.join(root.dir, SKILL_NAME);
    const file = path.join(skillDir, SKILL_FILE);
    if (readIfExists(file) === content) continue;
    const temp = path.join(skillDir, `.${SKILL_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(temp, content, "utf-8");
      fs.renameSync(temp, file);
    } catch (cause) {
      fs.rmSync(temp, { force: true });
      return { ok: false, targets, error: `${file}: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    targets.push(file);
  }
  return { ok: true, targets };
}

/** Removes the plugin's skill from every root that has a copy. */
export function removeAgentSkill(): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const root of skillRoots()) {
    if (!isDirectory(root.dir)) continue;
    const skillDir = path.join(root.dir, SKILL_NAME);
    if (path.basename(skillDir) !== SKILL_NAME) continue;
    if (!isDirectory(skillDir)) continue;
    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
      removed.push(skillDir);
    } catch (cause) {
      errors.push(`${skillDir}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { removed, errors };
}
