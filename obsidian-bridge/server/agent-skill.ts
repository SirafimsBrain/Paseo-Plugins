import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { paseoHome } from "./paths";
import { configuredPluginPath } from "./mcp-launch";

/**
 * Installs the plugin's agent skills.
 *
 * Paseo 0.15.x has no skill API, so the skills are delivered the way the agent
 * runtimes already look for one: a `<skills-root>/<name>/SKILL.md` directory in
 * the user's home. The roots belong to the agents (OpenCode, Codex-style
 * `~/.agents`, Claude Code), so a root that does not exist is left alone — the
 * plugin never creates a skills directory for a runtime the user does not have.
 *
 * The plugin ships five skills rather than one because they answer five
 * different questions an agent asks: how to read and write the vault
 * (`obsidian-bridge`), how to draw a canvas (`obsidian-canvas`), how to grow a plan
 * (`obsidian-planning-create`), how to carry a plan through the work
 * (`obsidian-planning-execute`) and how to review plan against fact afterwards
 * (`obsidian-planning-review`). All of them live in the repository
 * (`skills/<name>/SKILL.md`), are reviewed with the code, are rewritten only
 * when their content differs, and are removed when the switch is turned off —
 * the same contract the single skill had, applied to a list.
 */

export interface SkillDefinition {
  /** Directory name under `skills/` and under every skills root. */
  name: string;
  /** What the skill is for, shown in the settings screen. */
  purpose: string;
}

/**
 * The shipped skills. `obsidian-bridge` stays first: it is the one the settings
 * screen has always reported as the plugin's own, and `SKILL_NAME` keeps
 * pointing at it for callers that predate the list.
 */
export const SKILL_DEFINITIONS: readonly SkillDefinition[] = [
  { name: "obsidian-bridge", purpose: "Read and write the vault" },
  { name: "obsidian-canvas", purpose: "Draw a canvas (diagram, mind map, board)" },
  { name: "obsidian-planning-create", purpose: "Grow a plan tree" },
  { name: "obsidian-planning-execute", purpose: "Carry a plan through the work" },
  { name: "obsidian-planning-review", purpose: "Review plan against fact" },
];

export const SKILL_NAME = SKILL_DEFINITIONS[0].name;
export const SKILL_NAMES: readonly string[] = SKILL_DEFINITIONS.map((skill) => skill.name);

const SKILL_FILE = "SKILL.md";

export interface SkillRoot {
  label: string;
  dir: string;
}

export interface SkillTargetStatus {
  /** Skill directory name, e.g. `obsidian-planning-execute`. */
  skill: string;
  purpose: string;
  label: string;
  root: string;
  path: string;
  detected: boolean;
  installed: boolean;
  upToDate: boolean | null;
}

/** Per-root, per-skill state of the installed copies, for the settings screen. */
export function skillStatuses(): SkillTargetStatus[] {
  const rows: SkillTargetStatus[] = [];
  for (const root of skillRoots()) {
    const detected = isDirectory(root.dir);
    for (const skill of SKILL_DEFINITIONS) {
      const source = resolveSkillSource(skill.name);
      const content = source === null ? null : readIfExists(source);
      const file = path.join(root.dir, skill.name, SKILL_FILE);
      const existing = readIfExists(file);
      rows.push({
        skill: skill.name,
        purpose: skill.purpose,
        label: root.label,
        root: root.dir,
        path: file,
        detected,
        installed: existing !== null,
        upToDate: existing === null || content === null ? null : existing === content,
      });
    }
  }
  return rows;
}

export interface SkillSource {
  name: string;
  /** Absolute path of the skill in the checkout, or `null` when it is missing. */
  path: string | null;
}

export interface SkillStatus {
  /** Absolute path of `obsidian-bridge/SKILL.md`, or `null` when it is missing. */
  source: string | null;
  /** Every shipped skill and where it was found. */
  sources: SkillSource[];
  /** Skills roots that exist on this machine. */
  detected: string[];
  /** `<root>/<name>/SKILL.md` where the installed copy is current. */
  installed: string[];
  /** Installed copies whose content differs from the checkout. */
  stale: string[];
}

/** Kimi Code CLI's data root: `$KIMI_CODE_HOME`, else `~/.kimi-code`. */
function kimiCodeHome(): string {
  const configured = (process.env.KIMI_CODE_HOME ?? "").trim();
  return configured.length > 0 ? configured : path.join(os.homedir(), ".kimi-code");
}

/**
 * Every skills directory the agent runtimes on this machine read, with the
 * canonical one first: `~/.agents/skills` is the shared convention Paseo itself
 * uses, the rest belong to individual CLIs.
 */
export function skillRoots(): SkillRoot[] {
  const home = os.homedir();
  return [
    { label: "Shared (~/.agents)", dir: path.join(home, ".agents", "skills") },
    { label: "OpenCode", dir: path.join(home, ".config", "opencode", "skills") },
    { label: "OpenCode", dir: path.join(home, ".opencode", "skills") },
    { label: "Cline", dir: path.join(home, ".cline", "skills") },
    { label: "Kilo", dir: path.join(home, ".kilo", "skills") },
    { label: "Kimi Code CLI", dir: path.join(kimiCodeHome(), "skills") },
    { label: "Qwen Code", dir: path.join(home, ".qwen", "skills") },
    { label: "Codex CLI", dir: path.join(home, ".codex", "skills") },
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

/** Locates `skills/<name>/SKILL.md` in the installed checkout. */
export function resolveSkillSource(name: string = SKILL_NAME): string | null {
  const candidates: string[] = [];
  const configured = configuredPluginPath();
  if (configured) candidates.push(path.join(configured, "skills", name, SKILL_FILE));
  if (typeof __dirname === "string") {
    candidates.push(path.join(__dirname, "..", "skills", name, SKILL_FILE));
    candidates.push(path.join(__dirname, "skills", name, SKILL_FILE));
  }
  candidates.push(path.join(paseoHome(), "plugins", SKILL_NAME, "skills", name, SKILL_FILE));
  for (const candidate of candidates) {
    if (readIfExists(candidate) !== null) return candidate;
  }
  return null;
}

/** Every shipped skill with the checkout path it was found at. */
export function resolveSkillSources(): SkillSource[] {
  return SKILL_DEFINITIONS.map((skill) => ({
    name: skill.name,
    path: resolveSkillSource(skill.name),
  }));
}

export function agentSkillStatus(): SkillStatus {
  const sources = resolveSkillSources();
  const detected: string[] = [];
  const installed: string[] = [];
  const stale: string[] = [];
  for (const root of skillRoots()) {
    if (!isDirectory(root.dir)) continue;
    detected.push(root.dir);
    for (const skill of SKILL_DEFINITIONS) {
      const source = sources.find((entry) => entry.name === skill.name)?.path ?? null;
      const content = source === null ? null : readIfExists(source);
      const file = path.join(root.dir, skill.name, SKILL_FILE);
      const existing = readIfExists(file);
      if (existing === null) continue;
      if (content !== null && existing === content) installed.push(file);
      else stale.push(file);
    }
  }
  return {
    source: sources.find((entry) => entry.name === SKILL_NAME)?.path ?? null,
    sources,
    detected,
    installed,
    stale,
  };
}

export interface SkillVerifyResult {
  /** Skills roots that exist and were inspected. */
  checked: string[];
  /** Copies that were missing or stale and have been rewritten. */
  repaired: string[];
  /** Roots whose copy could not be written. */
  errors: string[];
}

/**
 * Verifies every installed copy of every shipped skill against the checkout and
 * repairs what drifted.
 *
 * This is the currency check the plugin runs on load, after a settings change
 * and on a timer: a skill directory can be edited, replaced or removed by hand,
 * by another plugin, or left behind by an update, and an agent then works from
 * stale instructions without anyone noticing. `~/.agents/skills` always exists
 * on a configured machine and is checked first; a root that does not exist is
 * skipped, never created.
 */
export function verifyAgentSkill(): SkillVerifyResult {
  const checked: string[] = [];
  const repaired: string[] = [];
  const errors: string[] = [];

  const contents = new Map<string, string>();
  for (const skill of SKILL_DEFINITIONS) {
    const source = resolveSkillSource(skill.name);
    if (source === null) {
      errors.push(`skills/${skill.name}/SKILL.md is missing from the checkout`);
      continue;
    }
    try {
      contents.set(skill.name, fs.readFileSync(source, "utf-8"));
    } catch (cause) {
      errors.push(
        `${source}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  for (const root of skillRoots()) {
    if (!isDirectory(root.dir)) continue;
    checked.push(root.dir);
    for (const skill of SKILL_DEFINITIONS) {
      const content = contents.get(skill.name);
      if (content === undefined) continue;
      const skillDir = path.join(root.dir, skill.name);
      const file = path.join(skillDir, SKILL_FILE);
      if (readIfExists(file) === content) continue;
      const temp = path.join(
        skillDir,
        `.${SKILL_FILE}.${process.pid}.${Date.now()}.${skill.name}.tmp`,
      );
      try {
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(temp, content, "utf-8");
        fs.renameSync(temp, file);
        repaired.push(file);
      } catch (cause) {
        fs.rmSync(temp, { force: true });
        errors.push(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  return { checked, repaired, errors };
}

/** Writes every skill wherever it is missing or stale (see `verifyAgentSkill`). */
export function installAgentSkill(): { ok: boolean; targets: string[]; error?: string } {
  const missing = SKILL_DEFINITIONS.filter((skill) => resolveSkillSource(skill.name) === null);
  if (missing.length > 0) {
    return {
      ok: false,
      targets: [],
      error: `${missing.map((skill) => `skills/${skill.name}/SKILL.md`).join(", ")} missing from the checkout`,
    };
  }
  const result = verifyAgentSkill();
  if (result.errors.length > 0) {
    return { ok: false, targets: result.repaired, error: result.errors.join("; ") };
  }
  return { ok: true, targets: result.repaired };
}

/** Marker every shipped `SKILL.md` carries, so a renamed copy is still recognised. */
const SKILL_MARKER = "<!-- installed-by: obsidian-bridge -->";

/** True when `dir` holds a `SKILL.md` this plugin installed. */
function installedByPlugin(dir: string): boolean {
  const text = readIfExists(path.join(dir, SKILL_FILE));
  return text !== null && text.includes(SKILL_MARKER);
}

/**
 * Removes the plugin's skills from every root that has a copy.
 *
 * A directory is removed when its name is one of `SKILL_NAMES` or when its
 * `SKILL.md` carries the plugin's marker. The marker is what keeps removal
 * useful after a skill is renamed: the next version no longer knows the old
 * directory name, but it still recognises the file it wrote. A skill without
 * the marker and with another name is never touched.
 */
export function removeAgentSkill(): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  const ownNames = new Set(SKILL_NAMES);
  for (const root of skillRoots()) {
    if (!isDirectory(root.dir)) continue;
    let entries: string[];
    try {
      entries = fs
        .readdirSync(root.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (cause) {
      errors.push(`${root.dir}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    for (const name of entries) {
      const skillDir = path.join(root.dir, name);
      if (path.basename(skillDir) !== name) continue;
      if (!ownNames.has(name) && !installedByPlugin(skillDir)) continue;
      try {
        fs.rmSync(skillDir, { recursive: true, force: true });
        removed.push(skillDir);
      } catch (cause) {
        errors.push(`${skillDir}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  return { removed, errors };
}
