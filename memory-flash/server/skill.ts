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
 *
 * The body is deliberately a *protocol*, not a description: memory only pays
 * off when every agent reads before it works and writes while it works, so
 * the rules below are phrased as mandatory, checkable steps rather than
 * advice an agent may quietly skip.
 */

export const SKILL_NAME = "memory-flash";

const TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name);

function skillBody(): string {
  return `---

name: memory-flash

description: >

  Shared persistent memory for all coding agents. Use it before starting any

  task (search for prior decisions, known bugs, procedures and handoffs from

  other agents), while working (record decisions, every positive result that

  worked, and — always — every bugfix), and whenever functionality changes

  (update the existing memories so the base stays current). Search several

  ways before concluding that nothing is known, and read the full memory, not

  the snippet. Write all memory content in English. Tools: ${TOOL_NAMES.join(", ")}.

---

# Memory Flash — shared agent memory

You have access to the team memory: a tagged, searchable database shared by
**all** coding agents (Cline, OpenCode, Kilo, Qwen Code, Codex, …) across
projects and machines. Another agent may have already solved your problem.

A memory that is never written is lost, and a memory that is written twice
creates two conflicting answers. The rules below exist to avoid both.

**Language rule:** write every memory in **English** — title, content and
tags. The base is shared by agents and humans working in different languages;
one language keeps search reliable and the knowledge unified.

---

## 1. Read before you work — not just once

**Never start a non-trivial task with a single search.** One query is a guess;
the person who solved this yesterday may have used different words. Search
until you are reasonably sure the base has nothing, which usually means 2–4
calls per task.

Search with **different vocabulary each time**: the user's words, the symbol
names from the code, the error text, the concept in plain English. Also vary
the filter — a free-text query and a tag/kind query reach different rows.

\`\`\`
memory_search { "query": "auth token refresh" }
memory_search { "query": "refreshToken expire" }
memory_search { "query": "", "tags": ["<project>"], "kinds": ["decision", "bugfix"] }
\`\`\`

### When to search

- **Before starting any task** that is not a one-line change.
- **Before fixing a bug** — check whether someone already hit it, and whether
  their fix or a failed attempt is documented.
- **Before entering an unfamiliar area** — look for procedures and decisions.
- **Before writing code in a file you have not touched this session** — a
  memory may record a constraint about that exact file.
- **Before choosing an approach** — a prior \`decision\` may rule the obvious
  option out.

### Do not trust a snippet

Search returns fragments. When a hit looks relevant, read the whole thing with
\`memory_get\` before you act on it — the caveat is usually in the part that was
truncated. Acting on half a memory is how agents re-introduce known bugs.

### When a search finds nothing, say so and widen

An empty result is a statement about *your query*, not about the base:

1. Re-search with synonyms, the error string, the file name, the symbol.
2. Drop the filters — a \`kind\` or \`tag\` filter silently hides rows.
3. List by tag: \`memory_list_by_tag { "tag": "<project>" }\` to see everything
   filed under the project.
4. Still nothing after that? Then proceed — and say in your final handoff that
   the area was undocumented, so the next agent knows the memory was checked.

When you do not know how the base is organised, run \`memory_stats\` once: it
lists the real project names, kinds and top tags. Those are the words that
make the other searches work.

---

## 2. Write while you work — not only at the end

Memory written at the end of a session is written from memory-of-the-task and
is usually vague. Save the moment something becomes true.

**Mandatory rules**

1. **Every bugfix is recorded — no exceptions.** Symptom, root cause, the fix
   and how to verify it. If a memory about the same bug exists, update it
   with \`memory_update\` instead of creating a duplicate.
2. **Record positive results.** Not only failures are worth keeping. When a
   solution succeeds, a configuration pays off, or an approach proves fast,
   reliable or elegant — save it as a \`pattern\` so nobody rediscovers it.
3. **User corrections are decisions.** When the user rejects an approach,
   explains a convention or states a preference, save it. It is the single
   most expensive thing to re-derive.
4. **Keep the base current.** When functionality changes, first search for the
   memories describing the old behavior and update them. The base must never
   contradict the code — prefer updating over saving a conflicting second row.

### Before you save: search first

One fact — one memory. Search for the topic; if a related row exists,
\`memory_update\` it. Two rows that disagree are worse than no row: the next
agent cannot tell which one is current.

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
at least one topic tag, lowercase. Tags are the cross-agent index — an
untagged memory is lost memory.

### Write so the next agent can find it

This is not style advice. Measured on a 5000-row base, search failed because
the query shared **no words** with the stored memory: someone hit a bug and
wrote “retry loop had no backoff”, then three weeks later a different agent
searched “repeated failures hammer the service”. No ranking system can bridge
a gap of zero shared words — the record was never retrieved, not retrieved too
low. Reranking was measured at exactly zero improvement for this reason.

So the \`Symptom\` line is a search index, not a description:

1. **Write the symptom the way a human reports it**, not the way the code
   reads. Both, in one memory: \`Symptom: users see old data until they
   refresh (stale response served after a write).\`
2. **Paste the literal error string** somewhere in the content. It is the
   single highest-value string in the memory — users paste errors verbatim.
3. **Name the file, the symbol, the command.** \`Fix: raised busy_timeout in
   store.ts\` finds it; \`Fix: increased the timeout\` does not.
4. **Put the plain-language words in tags.** Tags are matched before content:
   \`["paseo-plugins", "sqlite", "stale-data", "cache-invalidation"]\`.
5. **When a fact is genuinely worth finding twice**, save it under the wording
   a colleague would use, not only your own.

If you cannot say how someone else would search for it, the memory is not
finished yet.

### Measure the base when something looks wrong

If search repeatedly returns the wrong records, do not guess at the cause —
measure it. \`memory_diagnose\` takes control queries plus the ids that answer
them and reports recall@k and, per miss, whether the answer was **never
retrieved** or only **ranked too low**. That single distinction decides the
fix: a never-retrieved miss means the wording on disk does not match the
question being asked, which is a writing problem, not a ranking one.

\`\`\`
memory_search { "query": "stale data after write" }
memory_diagnose { "queries": [{ "query": "stale data after write", "expectedIds": [<id>] }] }
\`\`\`

---

## 3. Always leave a handoff

End every session that is not trivially complete — including successful ones,
where the handoff records what was changed and what is now safe to rely on.

\`\`\`
memory_handoff { "title": "<task> — state", "content": "Done: …. Failed attempts: …. Next: …. Open questions: ….", "project": "<project>" }
\`\`\`

---

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
