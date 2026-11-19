---
name: planning-create
description: Grow a project plan as a tree of Markdown documents with the `plan_*` tools — `plan_scope` finds the planning root, `plan_read`/`plan_search` read it, `plan_create_node` adds a root, trunk, branch, sub-branch or leaf, `plan_goal` records a goal with its steps, `plan_growth` tracks how a node or goal grew, and `plan_import` imports a legacy project archive. Use when the user asks you to start or extend a plan, break work into branches and leaves, or turn a goal or an existing plan into a tree.
---

# Planning: creating a plan

A plan is a **directory of Markdown documents** inside the configured planning root (`planRoot`, by default
`Projects`). Every document carries frontmatter with an `id`, a `kind`, counters (`version`, `revision`),
`parent`/`children` links and its relations. The tools write that shape; you never write it by hand.

## Where you are

1. `plan_scope {}` first. It answers `planning_available`, the resolved root, the Paseo `project` whose tree you share
   with the other workspaces of that project, the `workspace_id` written into plan YAML, the projects it already holds,
   `writesEnabled` and the limits. The plugin creates the planning directory and the project folder on demand, so an
   empty tree is a normal starting point; if planning is still unavailable, stop and tell the user.
2. Paths are **relative to the project folder** (`<planRoot>/<project>`): `centurion/backend/auth` — never
   `Projects/centurion/...`, never another project's name, never an absolute path. `..`, a leading `/` and
   `.obsidian` are refused by code, not by this skill. Other workspaces of the same project use this same tree freely;
   another project's plans are out of reach for `plan_*`, while `obsidian_*` may read them only on an explicit task.
3. Look before you grow: `plan_search` finds a node by name or text, `plan_read` returns a node with its children,
   relations and the snapshot list.

## The shape of a tree

| Kind | Holds | File |
| --- | --- | --- |
| `root` | one trunk | `<project>/<project>.md` |
| `trunk` | branches | `<project>/<trunk>/<trunk>.md` |
| `branch` | sub-branches and leaves | `<parent>/<branch>/<branch>.md` |
| `subbranch` | sub-branches and leaves, any depth | `<parent>/<subbranch>/<subbranch>.md` |
| `leaf` | nothing: it is the work | `<parent>/<leaf>.md` |

A root holds exactly one level of trunk; a trunk holds branches; a branch holds sub-branches and leaves. That is the
only hierarchy the schema accepts — `plan_create_node` refuses anything else and names the kinds that would fit.

## Create in order

1. **The project** — `plan_create_node { path: "centurion", kind: "root", name: "Centurion", description: "…" }`.
   One or two sentences of description and a `stack` entry per technology belong here; this is what a later reader (and
   you, three sessions later) sees first.
2. **A trunk per area of work** — `path: "centurion/backend"`, `kind: "trunk"`. Three to six trunks is a plan; twelve
   is a filing cabinet.
3. **A branch per question, not per file** — `path: "centurion/backend/auth"`, `kind: "branch"`. The branch is the unit
   a reviewer reads, so its description says what decision lives there.
4. **Leaves for the work** — `path: "centurion/backend/auth/session-store"`, `kind: "leaf"`, `status: "draft"`.
   A leaf has one outcome, a `brief` (why it exists, what "done" means), and no children. Split a leaf that needs a
   second "and then".

Then connect what you created: `plan_link` for an influence between two leaves, `plan_incident` for a problem that
blocks work, `plan_goal` for an outcome that is not a node yet.

## Goals before work

A goal is a formal statement plus steps, not a node: `plan_goal { path: "<project>/_goals/<slug>", formal_text: …,
plan: [{ title: "…" }], status: "proposed" }`. An agent may **propose** a goal but never approve the one it created —
`plan_approve_goal` refuses that, and the user approves (or passes `actor: "user"`). Approval is what turns the goal into
a trunk → a `steps` branch → one leaf per step, so do not create that subtree by hand as well.

## Importing instead of retyping

To bring a project in from a legacy archive: `plan_import { path: "<archive>.json.zip" }` — a dry run by default. Read
its `counts`, `warnings` and `files`, then repeat with `dry_run: false`. Import into an empty project; the original row
id is kept as `legacy_id`, so importing the same file twice answers `unchanged` rather than duplicating the tree.

## Rules that are enforced, not advised

- **Only the tools write plan files.** No `obsidian_edit`, `obsidian_write_*`, `shell`, `write` or `patch` against a
  file under the planning root — not to fix frontmatter, not to rename a folder, not "just this once". Every write goes
  through a tool that takes a snapshot, bumps `revision`, checks `expected_revision` and appends the journal.
- **Read the counters before you write.** Pass `expected_revision` from what `plan_read` returned; a different revision
  on disk refuses the change instead of overwriting another agent's work.
- **A manual edit is a fact, not an obstacle.** If the file changed outside the tools, the write refuses until you pass
  `accept_external: true` — do that only after reading the change and deciding it is safe to overwrite.
- `readOnly: true` switches every write off; report that instead of looking for a way around it.
- `__history` and `_archive` are not addressable: snapshots are read by `plan_history`, archived work by
  `plan_scope`/`plan_validate`. Never reconstruct a node by writing a file that looks like one.

## Finish

Call `plan_validate { project: "<project>" }` after a batch of creation: it reports dangling links, orphans, a doubled
root and a half-finished operation, each with the file to fix. A clean tree is one root, every link resolving, every
body matching its frontmatter.

If `plan_validate` returns `[TRUNCATED]`, copy its `continuation` object into `obsidian_continue` unchanged to see the
remaining issues. Never replace a truncated plan result with a file read or a direct edit of `planRoot`.
