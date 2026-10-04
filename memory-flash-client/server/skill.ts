import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Agent skill for the *remote* memory, installed on the client machine.
 *
 * The memory database lives on another machine (the memory host) and is
 * shared with that machine's own agents and with any other client. Without
 * a skill on this side, agents see a set of `memory_*` MCP tools with no
 * idea that they reach a shared team base — so they treat them as an
 * optional extra and skip them, which is exactly when the memory is worth
 * most (before a task, and right after a fix).
 *
 * The body mirrors the memory-flash skill in intent but adapts the wording
 * to remote access: the base belongs to the memory host, writes depend on
 * the key's scope, and requests cross the network.
 *
 * Deliberately dependency-free: the plugin installs from a clean checkout
 * with no build step, so the tool names are listed literally instead of
 * being imported from the memory-flash plugin.
 */

/** Skill name — a distinct folder from `memory-flash` so both can coexist. */
export const SKILL_NAME = "memory-flash-remote";

/** Tools served by memory-flash 0.5.0+ over HTTP. */
export const REMOTE_TOOL_NAMES = [
  "memory_save",
  "memory_search",
  "memory_get",
  "memory_update",
  "memory_delete",
  "memory_list_by_tag",
  "memory_handoff",
  "memory_stats",
] as const;

function skillBody(): string {
  return `---

name: memory-flash-remote

description: >

  Shared team memory served from a remote Memory Flash host over HTTP. This

  machine's agents are part of the same knowledge base as the agents on the

  memory host and on every other client. Search it before starting any

  non-trivial task (2-4 differently worded searches, not one), read the full

  memory with memory_get instead of trusting a snippet, and write back while

  you work: every bugfix, every positive result, every user correction and

  every decision with its alternatives. Update an existing memory instead of

  creating a conflicting duplicate, tag everything with the project name, and

  always leave a handoff. Write all memory content in English. Tools: ${REMOTE_TOOL_NAMES.join(", ")}.

---

# Remote team memory (Memory Flash)

The \`memory_*\` tools reach a **shared memory host** — one SQLite database
used by the agents on that machine and by every other machine connected to
it. You are not writing to a private scratchpad: what you save here is read
by agents that have never seen your conversation, on projects that are not
yours.

That cuts both ways. Memory you save can save another agent an hour of
work, and memory you skip writing can force the next agent to rediscover what
you already know. Treat search-before-work and write-while-working as part
of the task, not as an optional extra.

**Language rule:** write every memory in **English** — title, content and
tags. The base is shared across machines and languages; one language keeps
search reliable and the knowledge unified.

---

## 1. Read before you work — not just once

**Never start a non-trivial task with a single search.** One query is a guess.
The agent who solved this yesterday — on the memory host or on another
client — may have used completely different words.

Search with **different vocabulary each time**: the user's phrasing, the
symbol and file names from the code, the literal error text, the concept in
plain English. Vary the filters too — a free-text query and a tag/kind query
reach different rows.

\`\`\`
memory_search { "query": "auth token refresh" }
memory_search { "query": "refreshToken expire" }
memory_search { "query": "", "tags": ["<project>"], "kinds": ["decision", "bugfix"] }
\`\`\`

### When to search

- **Before starting any task** that is not a one-line change.
- **Before fixing a bug** — someone may have hit it already, and their fix or
  a failed attempt may be recorded.
- **Before entering an unfamiliar area** — look for procedures and decisions.
- **Before writing code in a file you have not touched this session**.
- **Before choosing an approach** — a prior \`decision\` may rule the obvious
  option out.

### Do not trust a snippet

Search returns fragments. When a hit looks relevant, read the whole memory
with \`memory_get\` before acting — the caveat is usually in the part that was
truncated, and acting on half a memory is how agents re-introduce known bugs.

### When a search finds nothing, widen before concluding

An empty result is a statement about *your query*, not about the base:

1. Re-search with synonyms, the error string, the file name, the symbol.
2. Drop the filters — a \`kind\` or \`tag\` filter silently hides rows.
3. List by tag: \`memory_list_by_tag { "tag": "<project>" }\`.
4. \`memory_stats\` shows the real project names, kinds and top tags — the
   words that make the other searches work.
5. Still nothing? Proceed, and say so in your handoff so the next agent
   knows the base was actually checked.

---

## 2. Write while you work — on the shared base

Save the moment something becomes true, not at the end of the session from
memory of the task. This is someone else's database: write what the next
agent would need, and nothing that is only true for your current session.

**Mandatory rules**

1. **Every bugfix is recorded — no exceptions.** Symptom, root cause, the fix
   and how to verify it.
2. **Record positive results.** A solution that worked, a configuration that
   pays off, an approach that proved fast or elegant — save it as a \`pattern\`
   so nobody rediscovers it.
3. **User corrections are decisions.** When the user rejects an approach or
   states a convention, save it. It is the most expensive thing to re-derive.
4. **Search before you save.** One fact — one memory. If a related row exists,
   \`memory_update\` it. Two rows that disagree are worse than none: the next
   agent cannot tell which is current.
5. **Keep the base current.** When functionality changes, find and update the
   memories describing the old behavior.

\`\`\`
memory_search { "query": "WAL checkpoint" }
memory_save { "kind": "bugfix", "title": "Fix WAL checkpoint stall", "content": "Symptom: … Root cause: … Fix: … Verify: …", "tags": ["<project>", "sqlite"] }
\`\`\`

### Kinds

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

**Tagging rules (mandatory):** always include the project/repository name and
at least one topic tag, lowercase. The base spans many machines, so tags are
the only index a foreign agent has. An untagged memory is lost memory.

---

## 3. Always leave a handoff

The next agent is often on **another machine**. Every session that is not
trivially complete — including successful ones — ends with a handoff, and it
must be self-contained: the other side cannot see your files or your terminal.

\`\`\`
memory_handoff { "title": "<task> — state", "content": "Done: …. Failed attempts: …. Next: …. Open questions: ….", "project": "<project>" }
\`\`\`

---

## Housekeeping

You may be asked to maintain the memory (from the Paseo Memory Flash panel or
by the user):

- \`memory_update\` — replace outdated content (history is kept automatically).
- \`memory_delete\` — remove a wrong/obsolete memory by id (a tombstone stays).
- \`memory_stats\` — counts by kind/agent/project and top tags.

Be conservative with deletes on a shared base: prefer updating a memory to
being correct over deleting it. List matches first and confirm the scope
(especially tag-based purges) before deleting.

---

## Notes on the remote transport

- The calls cross the network to another machine. Batch related work into one
  call where the tools allow it, but never skip a search because of latency.
- **Your access depends on the key's scope.** A key issued with \`read\` scope
  only exposes \`memory_search\`, \`memory_get\`, \`memory_list_by_tag\` and
  \`memory_stats\`; write tools are refused. If a save or handoff is rejected
  with an insufficient-scope error, that is a host-side key decision — report
  it instead of silently continuing.
- If several memory hosts are configured, their servers expose identically
  named tools. Use the host your task is about, and do not assume two calls
  with the same tool name reach the same database.
`;
}

export function skillFiles(): Array<{ name: string; content: string }> {
  return [{ name: "SKILL.md", content: skillBody() }];
}

/** Serialized skill content — also used by the settings screen to preview it. */
export function skillMarkdown(): string {
  return skillBody();
}

export interface SkillTarget {
  id: string;
  label: string;
  dir: () => string;
}

/** The same destinations memory-flash installs into on this machine. */
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