---
name: planning-review
description: Review a plan against what actually happened with the `plan_*` tools — `plan_read` for the current state, `plan_history` for the snapshots, `plan_restore` to bring one back as a new revision, `plan_growth` for the running record, `plan_validate` for integrity, and `plan_incident`/`plan_link` for what the review found. Use when the user asks for a plan review, a plan-vs-fact check, what changed and why, or to restore or roll back a node.
---

# Planning: reviewing plan against fact

A review answers three questions with evidence from the tree: **what was planned**, **what happened**, and **what the
plan says now that it did not say before**. Snapshots and the journal are the evidence; memory is not.

## Reading the history

1. `plan_scope {}` to confirm which Paseo workspace folder you are reviewing; `plan_*` never crosses into another
   workspace (only `obsidian_*` may read those notes, and only when the user asked).
2. `plan_read { path }` — the live state: `version`, `revision`, `status`, relations, `growth`, snapshot count.
3. `plan_history { path }` — the snapshots, newest first: version, revision, reason, time, actor. Every write produced
   one, so the list is the change log of the node.
4. `plan_history { path, version, revision }` — one snapshot's full content. Compare it with the live node in your
   answer: what text changed, what status moved, which relations appeared or disappeared.

`version` moves only on a structural decision (a new branch, a re-plan); `revision` moves on every edit. A jump in
`version` with five revisions after it is a re-plan, and a review that does not mention it is incomplete.

## The questions a review has to answer

| Question | Evidence |
| --- | --- |
| Did the work happen? | leaf `status`, `growth.steps[].state`, incidents resolved vs still `open` |
| Did it happen the way the plan said? | snapshot diff: the brief before and after, the steps added mid-flight |
| What did the plan get wrong? | leaves still `draft` after the work is done, `blocked` without an incident, `done` without growth |
| What is dead weight? | branches with no live leaf, leaves superseded by another leaf, subtrees fit for `plan_archive_node` |
| What disagrees with itself? | `plan_validate`: dangling links, orphans, body/frontmatter divergence, cycles, unfinished operations |

`plan_validate { project }` is the integrity half of the review and belongs in it every time: a tree that reads well but
holds an unresolved link or a half-finished `op:start` is not a plan you can act on.

## Growth is the fact, the status is the summary

`plan_growth` records what happened in steps — a measurement, a rejected approach, a decision with its reason. In a
review, read the steps, not just the status: a `done` leaf whose growth says "abandoned, moved to the new queue" is not
done, it is superseded. Say so and propose the status the evidence supports; do not silently rewrite history.

## Incidents and cycles

- An `open`/`investigating` incident blocks every leaf it is attached to. A review that lists blocked work without
  naming the incident is missing the actionable part.
- `plan_read` reports `beeCycle` when the influence graph closes a loop. Report the loop and the edges that close it;
  cutting one is a decision for the user, because the direction of influence is a claim about the design.
- A resolved incident stays as history: it explains why a leaf was late. Do not archive it to make the tree look clean.

## Restoring is not rolling back

`plan_restore { path, version, revision }` writes a snapshot's **content** into the live file as `revision + 1`, with
`restored_from` recording where it came from. It keeps the live relations, the line's `version`, and snapshots the
current state first — so a restore is itself reviewable and reversible.

Use it when the current text is wrong and an earlier text was right. Do **not** use it to "undo" a status change or a
move: those are lifecycle and structure, and reversing them has its own tools (`plan_set_status`, `plan_move_node`).
A snapshot from before a kind change is refused; a kind change is a version event, not an edit.

## Reporting a review

Answer in the user's language, and keep every claim traceable:

1. **State** — project, node paths, `version`/`revision` you read, when.
2. **Planned vs happened** — per branch: leaves done, in progress, blocked (with the incident), still `draft`.
3. **What changed** — the snapshot diff you actually read (revision → revision), not a guess.
4. **What the plan got wrong** — stale leaves, superseded work, branches to archive, decisions that never landed.
5. **Integrity** — the `plan_validate` result, verbatim counts and the issues worth fixing.
6. **Proposed next shape** — concrete `plan_*` calls (move this branch, archive that subtree, restore this leaf), each
   with the reason from the evidence. Do not perform structural changes as part of a review unless the user asked for
   them.

Write plan files under `planRoot` only through the tools, on every step of a review. `plan_history` reads snapshots; `plan_restore`
writes one back. Nothing in `__history` or `_archive` is an editable note.

A `[TRUNCATED]` integrity report carries a `continuation`: call `obsidian_continue` with that object to read the next
page of issues instead of opening plan files directly. Review every page before concluding the tree is clean.
