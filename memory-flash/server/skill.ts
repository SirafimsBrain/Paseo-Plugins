import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCP_TOOLS } from "./mcp-tools";

/**
 * Skill management (requirement 6).
 *
 * The skill teaches coding agents when and how to use the memory MCP tools.
 * It follows the standard SKILL.md layout (YAML frontmatter with name +
 * description, then markdown instructions) used by Claude, Codex, OpenCode,
 * Qwen Code, Kilo and the `~/.agents/skills` convention.
 *
 * "Install" copies the skill folder into the agent's skills directory; the
 * buttons live on the plugin's settings screen.
 */

export const SKILL_NAME = "memory-flash";

const TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name);

function skillBody(): string {
  return `---

name: memory-flash

description: >

  Shared persistent memory for all coding agents. Use it before starting any

  task (search for prior decisions, known bugs, procedures and handoffs from

  other agents), when you discover something durable (a decision, a bugfix

  explanation, a pitfall, a working pattern), and when ending a session

  (write a handoff). Tools: ${TOOL_NAMES.join(", ")}.

---



# Memory Flash — shared agent memory



You have access to the team memory: a tagged, searchable database shared by

**all** coding agents (Cline, OpenCode, Kilo, Qwen Code, Codex, …) across

projects. Another agent may have already solved your problem.



## When to read



- **Before starting a task**: search for prior work on the topic.

- **Before fixing a bug**: check whether someone documented it (or a failed attempt).

- **When entering an unfamiliar area**: look for procedures and decisions.



\`\`\`

memory_search { "query": "auth token refresh", "tags": ["<project>"] }

memory_list_by_tag { "tag": "<project>" }

\`\`\`



## When to write



Save anything the next agent (or future you) will need. One fact — one memory:



| Situation | kind |

| --- | --- |

| A choice was made and justified | \`decision\` |

| A repeatable recipe (build, deploy, test) | \`procedure\` |

| Session end / context transfer | \`handoff\` |

| A bug explained (root cause, fix) | \`bugfix\` |

| Something that worked | \`pattern\` |

| Something that failed / cost time | \`pitfall\` |

| A useful file path or URL | \`reference\` |

| Anything else | \`note\` |



\`\`\`

memory_save { "kind": "decision", "title": "Use WAL mode", "content": "…", "tags": ["<project>", "sqlite"] }

\`\`\`



**Tagging rules (mandatory):** always include the project/repository name and

at least one topic tag, lowercase. Tags are the cross-agent index — an

untagged memory is lost memory.



## Ending a session



Always leave a handoff when the task is not trivially complete:



\`\`\`

memory_handoff { "title": "<task> — state", "content": "Done: …. Failed attempts: …. Next: ….", "project": "<project>" }

\`\`\`



## Housekeeping



You may be asked to maintain the memory (from the Paseo Memory Flash panel or

by the user):



- \`memory_update\` — replace outdated content (history is kept automatically).

- \`memory_delete\` — remove a wrong/obsolete memory by id (a tombstone stays in history).

- \`memory_stats\` — counts by kind/agent/project and top tags.



Be conservative with deletes: prefer updating a memory to be correct over

deleting it. When asked to clean up, list matches first and confirm the scope

(especially tag-based purges) before deleting.
`;
}

export function skillFiles(): Array<{ name: string; content: string }> {
  return [{ name: "SKILL.md", content: skillBody() }];
}

/** Serialized skill content — also used by the client to preview it. */
export function skillMarkdown(): string {
  return skillBody();
}

export interface SkillTarget {
  id: string;
  label: string;
  /** Directory receiving the skill folder (created when missing). */
  dir: () => string;
}

/**
 * Known skill destinations. The four first are the conventions observed on
 * this machine (Paseo itself installs skills into `~/.agents/skills`,
 * `~/.claude/skills` and `~/.codex/skills`; OpenCode and Qwen Code read
 * `~/.config/opencode/skills` and `~/.qwen/skills`).
 */
export function skillTargets(): SkillTarget[] {
  const home = os.homedir();
  return [
    {
      id: "agents",
      label: "All agents (~/.agents/skills)",
      dir: () => path.join(home, ".agents", "skills"),
    },
    {
      id: "claude",
      label: "Claude Code (~/.claude/skills)",
      dir: () => path.join(home, ".claude", "skills"),
    },
    {
      id: "codex",
      label: "Codex CLI (~/.codex/skills)",
      dir: () => path.join(home, ".codex", "skills"),
    },
    {
      id: "opencode",
      label: "OpenCode (~/.config/opencode/skills)",
      dir: () => path.join(home, ".config", "opencode", "skills"),
    },
    {
      id: "qwen",
      label: "Qwen Code (~/.qwen/skills)",
      dir: () => path.join(home, ".qwen", "skills"),
    },
    {
      id: "cline",
      label: "Cline (~/.cline/skills)",
      dir: () => path.join(home, ".cline", "skills"),
    },
    {
      id: "kilo",
      label: "Kilo Code (~/.kilo/skills)",
      dir: () => path.join(home, ".kilo", "skills"),
    },
  ];
}

export interface SkillTargetStatus {
  id: string;
  label: string;
  path: string;
  detected: boolean;
  installed: boolean;
  /** `null` when not installed (nothing to compare). */
  upToDate: boolean | null;
}

function installedPath(target: SkillTarget): string {
  return path.join(target.dir(), SKILL_NAME, "SKILL.md");
}

export function skillStatuses(): SkillTargetStatus[] {
  const expected = skillBody();
  return skillTargets().map((target) => {
    const file = installedPath(target);
    const dirExists = fs.existsSync(target.dir());
    let installed = false;
    let upToDate: boolean | null = null;
    if (fs.existsSync(file)) {
      installed = true;
      try {
        upToDate = fs.readFileSync(file, "utf-8") === expected;
      } catch {
        upToDate = false;
      }
    }
    return {
      id: target.id,
      label: target.label,
      path: file,
      detected: dirExists,
      installed,
      upToDate,
    };
  });
}

export function installSkill(targetId: string): { ok: boolean; path: string | null; error: string | null } {
  const target = skillTargets().find((candidate) => candidate.id === targetId);
  if (!target) return { ok: false, path: null, error: `Unknown skill target: ${targetId}` };
  try {
    const dir = path.join(target.dir(), SKILL_NAME);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of skillFiles()) {
      fs.writeFileSync(path.join(dir, file.name), file.content, "utf-8");
    }
    return { ok: true, path: path.join(dir, "SKILL.md"), error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, path: null, error: message };
  }
}

export function uninstallSkill(targetId: string): { ok: boolean; error: string | null } {
  const target = skillTargets().find((candidate) => candidate.id === targetId);
  if (!target) return { ok: false, error: `Unknown skill target: ${targetId}` };
  try {
    const dir = path.join(target.dir(), SKILL_NAME);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}
