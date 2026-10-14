import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCP_TOOLS } from "./mcp-tools";

/**
 * The luck-planner skill and its installer (PLAN.md stage D3).
 *
 * The skill teaches coding agents *when* to write the tree, not just which
 * tools exist: when a fact deserves a leaf, when a status transition is
 * honest, and what `revision`/audit mean (they are automatic — agents must
 * never manage them by hand). It follows the standard SKILL.md layout
 * (YAML frontmatter with name + description, then markdown instructions)
 * used by Claude, Codex, OpenCode, Qwen Code, Kilo and the `~/.agents/skills`
 * convention — the memory-flash skill installer precedent.
 *
 * "Install" copies the skill folder into the agent's skills directory.
 * Stage D3 auto-installs on plugin load only into target directories that
 * already exist (the machine actively uses that agent), writing only when
 * the content differs; the explicit install/uninstall/status functions stay
 * available for the settings screen (stage E4).
 */

export const SKILL_NAME = "luck-planner";

const TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name);

function skillBody(): string {
  return `---
name: luck-planner
description: >
  Shared project fact tree for all coding agents. Use it to keep plan/fact
  state across sessions: orient before a non-trivial task with
  luck_tree_get_context / luck_tree_search, record durable facts as leaves,
  move leaf statuses only when the state really changed, link influence with
  bees, report blockers as bugs, propose goals for human approval, and track
  progress with growth. Scope every call to the project path and write content
  in English. Tools: ${TOOL_NAMES.join(", ")}.
---

# Luck Planner — the shared project tree

You have access to the project's **fact tree**, shared by all coding agents
(Cline, OpenCode, Kilo, Codex, …) across sessions. The tree is the plan/fact
record for one project: a root carrying the tech stack, a trunk, branches,
sub-branches, and **leaves — the durable facts**. Bees link leaves that
influence each other, bugs mark incidents that block them, goals hold
human-approved plans, and growth records step-by-step progress.

Another agent may have worked here yesterday. The tree only pays off when it
is **read before work** and **written the moment something becomes true**.

**Language rule:** write every name and description in **English** — the tree
is shared by agents and humans working in different languages.

**project_key rule:** every call needs \`projectKey\` — the canonical absolute
path of the project root (the workspace's working directory). Use the exact
same string every time; a slightly different path silently creates a second
tree.

---

## 1. Orient before you work

**Never start a non-trivial task blind.** One orientation call replaces a
dozen probes:

\`\`\`
luck_tree_get_context { "projectKey": "/abs/path/to/project" }
\`\`\`

- **No \`nodeId\`** — overview: the roots and their first level.
- **With \`nodeId\`** — the path root → … → that node, its children, sibling
  leaves, bees touching it, blocking bugs, and growth progress: you "descend
  one level" in a single call.

Before creating anything, **search first** — with different wordings, 2–4
calls per task (one query is a guess):

\`\`\`
luck_tree_search { "projectKey": "/abs/path", "query": "auth token refresh" }
luck_tree_search { "projectKey": "/abs/path", "query": "refreshToken expire" }
\`\`\`

Free text supports \`key=value\` filters (\`kind=branch\`, \`status=done\`) and
optional \`kinds\`/\`statuses\` arrays. When a hit looks relevant, read its
context with \`luck_tree_get_context\` before acting on it.

If the tree contradicts the code, **the code is truth** — fix the tree.

---

## 2. When to create a leaf

A leaf is a **durable fact another agent would need**. Create one when:

- a decision was made and constrains future work (record the reason),
- architecture or structure is worth knowing (where things live, why),
- you verified how something actually behaves,
- a constraint or rule comes from the user or the codebase.

Do **not** create a leaf for: transient task state, your personal todo list,
anything obvious from the code currently on screen, or a fact that already
exists in the tree.

**One fact — one leaf.** Search first; update in place with
\`luck_tree_upsert_leaf\` instead of adding a second row. Two leaves that
disagree are worse than none — the next agent cannot tell which is current.

- \`name\` — a short, searchable title: the words a colleague would search for.
- \`description\` — the **why** and how to verify it.
- \`version\` — free-text version of the fact/code the leaf describes
  (\`"2.1"\`, \`"v3 schema"\`); leave empty when meaningless.

Creating a leaf under \`parentId\` starts it in \`draft\`. **The very first
leaf of a project may omit \`parentId\`** — the store then creates the
minimal skeleton (root → trunk → branch named \`General\`) and files the
leaf under it. Every later leaf must pass \`parentId\` from
\`luck_tree_get_context\`; an empty result plus a missing \`parentId\` is the
bootstrap case, not an error.

---

## 3. Status transitions — the machine is not advisory

Leaf statuses run through one state machine:

\`\`\`
draft → ready → claimed → in_progress → done
                         (blocked)↑
cancelled / superseded — terminal
\`\`\`

| Status | Move it when |
| --- | --- |
| \`draft\` | (initial) the fact is recorded but not yet verified. |
| \`ready\` | you verified the content against code, tests or docs. |
| \`claimed\` | you are about to start applying it while other agents coordinate on the same tree. |
| \`in_progress\` | you are actively working it. |
| \`blocked\` | you cannot proceed — **always pair with \`luck_tree_report_bug\`** naming the blocker (severity + the leaf ids it affects). |
| \`done\` | the fact is reflected in reality: the code/docs changed **and** you checked it. "I believe so" is not done. |
| \`cancelled\` | the fact no longer matters. |
| \`superseded\` | a newer leaf replaced it — write the replacement first, then supersede the old one. |

Transitions are carried out by passing \`status\` to
\`luck_tree_upsert_leaf\` together with \`leafId\`. An illegal transition comes
back as a readable \`invalid status transition …\` error **that writes
nothing** — read the message; never fight the machine. Re-stating the
current status is a tolerated no-op.

Single-agent work can go \`draft → ready → done\`; \`claimed\`/\`in_progress\`
exist for coordination, not ceremony.

---

## 4. version, revision, audit — never manage them by hand

- \`version\` is **yours**: the free-text version described above.
- \`revision\` is **internal**: an integer the store increments on every
  mutation. Never try to set or reset it.
- The **audit trail is append-only and automatic**: every mutation writes
  actor (your agent id), action, revision, result and time. Read it with
  \`luck_tree_history { "projectKey": …, "entityId": … }\` (oldest first).
  There is no tool — and no need — to write audit rows manually.

---

## 5. Links: bees and bugs

- \`luck_tree_add_bee\` — directed influence: \`sourceLeafId → targetLeafId\`
  (both live leaves of the same project; self-loops are rejected). Use it
  when changing one fact ripples into another, and give \`impact\` a sentence
  about how strongly.
- \`luck_tree_report_bug\` — an incident: \`title\`, \`severity\`
  (\`low|medium|high|critical\`), and \`nodeIds\` to attach immediately. An
  open bug attached to a leaf shows up as a blocker wherever that leaf is
  read.

---

## 6. Goals and growth

- \`luck_tree_set_goal\` — **pre-approval only**:
  \`create\` (formalText + plan steps → \`draft\`), \`update\` (draft/proposed
  edits), \`propose\` (draft → proposed). **You cannot approve a goal** — a
  human approves it in the Paseo panel, and only an approved goal
  materializes into sub-branches with leaves. After \`propose\`, say so in
  your reply and wait; a repeated \`propose\` is a readable no-op error.
- \`luck_tree_update_growth\` — attach or refresh progress steps for a goal
  or node (\`steps\` when creating, \`steps\`/\`status\` when updating). Update
  it as steps complete or stall (with \`reason\`) — the dashboard renders it
  as progress.

---

## 7. When the tools are briefly unavailable

An agent session can lose its \`luck_tree_*\` tools for a while — typically
after its workspace idled out and restarted:

\`\`\`
No tool named "luck-planner_luck_tree_search" is currently available.
\`\`\`

That is a **transport problem, not a data problem**: the tree is intact and
other agents still read and write it. Do not conclude the tree is gone and do
not restate the task as if no record exists:

1. Keep the content you meant to write ready and retry the call next turn.
2. If it still fails, tell the user which reads/writes were skipped.

Hosts may prefix tool names with the server name (\`luck-planner_luck_tree_search\`);
both spellings work.

---

## Housekeeping

- \`luck_tree_upsert_leaf\` — update a leaf in place (name, description,
  version, payload, status) — prefer it over delete/recreate; the tree has no
  destructive leaf operation by design.
- \`luck_tree_history\` — audit of any entity (node, bee, bug, goal, growth);
  an unknown id returns an empty list rather than an error.
- Be conservative: the tree is the project's memory — prefer updating a leaf
  to be correct over adding a competing one.
`;
}

export function skillFiles(): Array<{ name: string; content: string }> {
  return [{ name: "SKILL.md", content: skillBody() }];
}

/** Serialized skill content — also used for previews and diffing. */
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
 * Known skill destinations — the conventions observed on the machine that
 * also run memory-flash (Paseo itself installs skills into
 * `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills`; OpenCode and
 * Qwen Code read `~/.config/opencode/skills` and `~/.qwen/skills`).
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
  /** The agent's skills directory exists on this machine. */
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

export function installSkill(
  targetId: string,
): { ok: boolean; path: string | null; error: string | null } {
  const target = skillTargets().find((candidate) => candidate.id === targetId);
  if (!target) {
    return { ok: false, path: null, error: `Unknown skill target: ${targetId}` };
  }
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

export function uninstallSkill(
  targetId: string,
): { ok: boolean; error: string | null } {
  const target = skillTargets().find((candidate) => candidate.id === targetId);
  if (!target) {
    return { ok: false, error: `Unknown skill target: ${targetId}` };
  }
  try {
    const dir = path.join(target.dir(), SKILL_NAME);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/**
 * Install the skill into every skills directory that **already exists** —
 * an existing directory means that agent convention is active on this
 * machine, so the skill belongs there; anything else would create folders
 * the agent never reads. Writes only when the content differs, so calling
 * this on every plugin load is idempotent.
 *
 * Returns the paths that were actually (re)written — the plugin logs one
 * line per path, which is what makes the install verifiable in
 * `paseo plugin logs luck-planner`.
 */
export function ensureSkillInstalled(): string[] {
  const written: string[] = [];
  for (const target of skillTargets()) {
    if (!fs.existsSync(target.dir())) continue;
    const status = skillStatuses().find((entry) => entry.id === target.id);
    if (status?.installed && status.upToDate === true) continue;
    const result = installSkill(target.id);
    if (result.ok && result.path) written.push(result.path);
  }
  return written;
}
