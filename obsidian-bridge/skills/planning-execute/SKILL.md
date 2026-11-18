---
name: planning-execute
description: Carry an existing plan through the work with the `plan_*` tools — `plan_read` before a change, `plan_set_status` to move a leaf's lifecycle, `plan_update_node` for a brief or payload, `plan_link` for influences, `plan_incident` for blockers, `plan_growth` to record progress, `plan_move_node`/`plan_archive_node` to restructure. Use when the user asks you to work on a planned task, mark progress, record a blocker or decision, or reorganise the plan while the work is happening.
---

# Planning: executing a plan

The plan is the record of the work, not a to-do list beside it. While you work, the plan changes through the tools —
one snapshot per change, one journal line per change, and never a hand-edited file.

## Before every change

1. `plan_scope {}` if you have not called it in this session: it reports the root, the Paseo workspace you are scoped
   to, the projects and whether writes are enabled. Stay inside that workspace — `plan_*` cannot address a sibling
   workspace, and trying `..` or its name is a refusal, not a path to resolve.
2. `plan_search { query: "<words from the title>" }` then `plan_read { path: "…" }`. Read the node you are about to
   touch: `revision`, `status`, `children`, `influences`, `blockedBy`, `beeCycle` and the brief all come back.
3. Keep the `revision` you saw. Every write accepts `expected_revision`; if another agent (or a person in Obsidian)
   changed the file first, the write is refused instead of losing their work. Re-read, reconcile, then repeat.

## Moving the work

- **One lifecycle step at a time** — `plan_set_status { path, status }`. A leaf goes `draft → ready → claimed →
  in_progress → blocked|deferred|done|cancelled|superseded`. Claim a leaf you are about to work on and set
  `in_progress`; that is how a second agent knows it is taken. A no-op status is refused, and so is an invented one.
- **Record what changed, not what you hope** — `plan_update_node { path, brief: { … } }` for the durable "why", and
  `plan_growth { path, steps: [{ title, state, note }] }` for the running record. Growth is for what actually happened
  (a measurement, a dead end); a step's `state` is a fact, not a percentage.
- **A decision is a leaf, not a comment** — if the work produced a decision the plan did not anticipate, add the leaf
  and link it. A chat message is not readable next month; the tree is.
- **Influences** — `plan_link { source, target, impact }` when one leaf changes how another should be done. Only the
  source stores the edge, and `plan_read` reports a cycle if one closes. A cycle is information, not an error: name it
  in the answer and ask which edge is wrong instead of silently cutting one.
- **Blockers** — `plan_incident { path: "<project>/_incidents/<slug>", name, description }` and attach it to the leaves
  it blocks. Only `open` and `investigating` incidents block. When it is resolved, move it with `plan_set_status`; the
  leaves stop being blocked without a second edit.
- **Restructuring** — `plan_move_node` when a branch belongs somewhere else (links follow it), `plan_archive_node` when
  a subtree is dead (nothing is deleted, history moves with it). Both are resumable: if a call fails halfway, repeat it
  with the same `op_id` instead of inventing a second operation.

## The write path, stated once

Every write tool: checks `readOnly` → resolves the path inside the planning root → reads the node and verifies
`expected_revision` → refuses a manual edit unless `accept_external: true` → writes a snapshot of the current state →
writes the file atomically → appends one journal line. You do not have to remember the order; you do have to respect
its answers. A refusal is a report about the state of the plan, not a bug to route around.

**Never** touch a plan file under `planRoot` with `obsidian_edit`, `obsidian_write_document`, `obsidian_write_scratch`, `shell`, `write`,
`patch`, `sed` or a rename in the terminal. Those paths skip the snapshot, the revision check and the journal, and the
next `plan_validate` will report the damage. The same rule covers `__history` and `_archive`: a snapshot is immutable and
an archived node is out of the tree; neither is a note to edit.

## Working with a second agent

- Set `actor` to your agent id on every write. Two agents on one node are handled by `expected_revision`: the second
  gets a refusal, re-reads and decides.
- Claim before you start, and say in the answer which leaf you moved and to what.
- Do not "tidy" nodes another agent is working in: moving or archiving a leaf someone claimed is a decision for the user.

## Finishing a piece of work

1. `plan_set_status` to `done` (or `blocked` with an incident attached — a blocker recorded is better than a status that
   lies).
2. `plan_growth` with the steps that actually happened.
3. If the plan's shape no longer matches reality, fix the shape now (move, archive, add the missing leaf), not "later".
4. Answer with what changed in the plan: node paths, the status you set, the revision you produced. A reader should be
   able to open the node and see exactly what you reported.

A `[TRUNCATED]` result is not a failure: pass its `continuation` object unchanged to `obsidian_continue`. Do not use
file tools to fetch the rest of a plan answer — the continuation is the supported and cheaper path.
