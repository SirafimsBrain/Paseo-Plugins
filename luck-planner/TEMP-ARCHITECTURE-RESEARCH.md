# TEMP — Architecture research for `luck-planner`

> **This document is temporary.** It exists only to give the coding stage a factual basis:
> verified descriptions of how four established projects solve planning, plan/fact tracking
> and verification, plus a set of proposed architectural decisions for the plugin.
> **Delete this file when coding starts** — durable design decisions will move to
> `__doc.md` / `README.md` (English, per project rules).
>
> Status: research done, **plugin requirements not yet received** (they come after this doc).

Research method: local **SearXNG MCP** (`search` tool, connected to Freebuff Desktop) for
discovery, then direct fetches of `raw.githubusercontent.com` files and the GitHub contents/tree
API so that every claim below points at an exact file that was actually read.

---

## 1. MetaGPT — role pipeline + task DAG

Repo: [`FoundationAgents/MetaGPT`](https://github.com/FoundationAgents/MetaGPT)
(was `geekan/MetaGPT`; the old path redirects).

### What it solves for us

**1.1 Role separation of planning stages.** The four planning roles are separate modules, each
owning one stage of decomposition:

| Role | Stage | Source |
| --- | --- | --- |
| Product Manager | overall scope / PRD | [`metagpt/roles/product_manager.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/product_manager.py) |
| Architect | module breakdown + architecture | [`metagpt/roles/architect.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/architect.py) |
| Project Manager | decomposition into tasks | [`metagpt/roles/project_manager.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/project_manager.py) |
| Engineer / QA | execution and confirmation | [`engineer.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/engineer.py), [`qa_engineer.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/qa_engineer.py) |

Roles share one base class ([`metagpt/roles/role.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/role.py))
and communicate through routed `Message` objects — planning output of one role is the input of the
next, so each stage is independently re-runnable.

**1.2 The plan data model (read verbatim from `schema.py`).**
[`metagpt/schema.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/schema.py) defines:

- `Task`: `task_id`, **`dependent_task_ids`** (prerequisite tasks), `instruction`, `task_type`,
  `code`, `result`, `is_success`, `is_finished`, `assignee`.
- `Plan`: `goal`, `context`, `tasks: list[Task]`, `task_map`, `current_task_id`.
  - `_topological_sort()` orders tasks by dependencies → the plan is a **DAG**, not a flat list.
  - `_update_current_task()` recomputes the cursor: current task = first unfinished task.
  - `reset_task(task_id)` clears a task **and cascades to every downstream dependent task** —
    the mechanism that keeps plan/fact honest when an earlier step is redone.
  - `append_task` / `replace_task` / `finish_current_task` are exposed to the LLM as a registered
    tool (`@register_tool`), i.e. the agent edits the plan through a constrained API, not free text.
  - `TaskReporter().report({tasks, current_task_id})` pushes plan state to the UI on every change.

**1.3 Closure requires proof.** `Task.is_finished` and `Task.is_success` are separate flags;
`TaskResult` carries `code` + `result` + `is_success`, and `update_task_result()` accumulates the
result into the task. A task is not "done" until a result with `is_success` was written into it.

### Takeaway for luck-planner

Adopt the **DAG task model** (`dependent_task_ids` + topological ordering + cascading reset) and the
separation of `is_finished` (work performed) vs `is_success` (verified) as the core of our schema.

---

## 2. Plandex — human plan review, sandbox, diffs and rollback as evidence

Repo: [`plandex-ai/plandex`](https://github.com/plandex-ai/plandex) (Go, client/server).

### What it solves for us

**2.1 A plan is an explicit object with version control and branches.**
[`docs/docs/core-concepts/plans.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/plans.md):

- a plan = loaded context + conversation + **pending changes**;
- plans are named, listed, archived, deleted; **one "current plan" per directory**;
- plans support [version control](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/version-control.md)
  and [branches](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/branches.md);
- project-level config lives in a committed-or-ignored `.plandex/` directory.

**2.2 Changes never touch the working tree directly — review gate first.**
[`docs/docs/core-concepts/reviewing-changes.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/reviewing-changes.md):

- results accumulate in a version-controlled **sandbox**;
- the user reviews with `plandex diff` (git-diff format, `--ui` side-by-side / line-by-line),
  then `plandex reject [files]` or `plandex apply`;
- **after apply, pending commands (tests, builds) execute automatically; if they fail the changes
  are rolled back**, then auto-debug or a prompt follows;
- an [autonomy matrix](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/autonomy.md)
  (`auto-apply` / `auto-exec` / `auto-debug` / `auto-commit` per level) controls how much runs
  without a human.

**2.3 Context is loaded deliberately**, not wholesale —
[`context-management.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/context-management.md)
(automatic project map vs manual loads), and
[`execution-and-debugging.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/execution-and-debugging.md)
covers the run/debug loop.

### Takeaway for luck-planner

Copy the **review gate** (plan approved by a human before coding), **diff/test as the fact side of
plan/fact**, **rollback on failed verification**, and the **explicit autonomy level** as a plan-level
setting.

---

## 3. Cline / Roo-Code "Memory Bank" — file-based plan/fact storage

Sources:
- canonical rules: [`cline/prompts/.clinerules/memory-bank.md`](https://github.com/cline/prompts/blob/main/.clinerules/memory-bank.md)
  (read in full for this research);
- agent repo: [`cline/cline`](https://github.com/cline/cline); the pattern is also used by Roo Code
  and many ports (e.g. [`hudrazine/claude-code-memory-bank`](https://github.com/hudrazine/claude-code-memory-bank)).

### What it solves for us

**3.1 Six Markdown files, fixed hierarchy** (the rules file states each file's content):

```
projectBrief.md   -> productContext.md
       |----------> systemPatterns.md   (architecture, key decisions, component relationships)
       |----------> techContext.md      (technologies, dependencies, constraints, tooling)
                   -> activeContext.md  (current focus, recent changes, next steps, decisions)
                   -> progress.md       (what works / what's left / status / known issues / evolution)
```

- `projectBrief.md` is the foundation and source of truth for scope (≈ our "общий план");
- `systemPatterns.md` ≈ module breakdown and architecture (≈ "разбивка по модулям");
- `techContext.md` ≈ dependencies and planned migrations (≈ "технологические миграции");
- `progress.md` + `activeContext.md` ≈ **план/факт**: current status, evidence, next steps.

**3.2 Two explicit workflows.** *Plan mode*: read all files → check completeness → build and present
a strategy. *Act mode*: check bank → update documentation → execute → document changes.
Updates are triggered by new patterns, significant changes, or an explicit `update memory bank`
command (which forces reviewing **all** files).

**3.3 Why it matters here:** state is plain files in the project repo — no DB, diffable, survives
agent resets ("my memory resets completely between sessions").

### Takeaway for luck-planner

Use **repository files as the storage layer** (a `luck-planner/` directory with plan/progress files),
so the coding agent reads them with its normal file tools; keep a Memory-Bank-like update ritual
after every significant step.

---

## 4. OpenHands — event-driven state, versioned events, verification runs

Repos (multi-repository system, verified from the README):
- [`OpenHands/OpenHands`](https://github.com/OpenHands/OpenHands) — "Agent Canvas": frontend /
  control center, backend selection, local-stack orchestration;
- [`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk) — Python SDK,
  Agent Server, agents, tools, **conversations, workspaces, events**;
- [`OpenHands/automation`](https://github.com/OpenHands/automation) — schedules, webhooks,
  **run history**, dispatching.

### What it solves for us

**4.1 Everything is an event.** The SDK keeps an `event` package:
[`openhands-sdk/openhands/sdk/event/`](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-sdk/openhands/sdk/event)
with `base.py`, `conversation_state.py`, `conversation_error.py`, `condenser.py`, etc.
Conversation state is *derived from* the event stream, and the UI is updated by consuming events —
exactly the "event-driven status updates in UI" pattern.

**4.2 Persisted events must never break old data** — the SDK's
[`AGENTS.md`](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/AGENTS.md)
mandates: `schema_version` bump on incompatible shape change, `_migrate_vN_to_vN+1` functions,
golden fixtures for historical payloads, permanent deprecation handlers ("old events should ALWAYS
load without error"), and CI checks that enforce it.

**4.3 Verification is a runtime, not a claim.** Agents execute in Docker sandboxes / VMs (see the
[README quickstart options](https://github.com/OpenHands/OpenHands#quickstart)), and automation
keeps run history — a task's outcome is attached as a run result rather than a self-reported status.

### Takeaway for luck-planner

Store plan changes as an **append-only event log with a schema version + migration path**, derive
the current plan/fact view from it, and attach **verification runs** (command, exit code, output
reference) to task events.

---

## 5. Proposed architecture for `luck-planner` (to be confirmed against requirements)

Not a decision yet — a starting position assembled from the four research targets, mapped onto the
capabilities of a Paseo plugin (contributions: workspace panel, command-center items, slash
commands, timeline rows, server RPCs, lifecycle/before hooks — see the `paseo-plugin` skill).

| # | Requirement (as stated by the user) | Chosen source pattern | Where it goes in the plugin |
| --- | --- | --- | --- |
| 1 | Общий план (overall plan) | MetaGPT `Plan{goal, context, tasks}` + Memory Bank `projectBrief.md` | `plan.json` top-level section + rendered overview |
| 2 | Разбивка по модулям (module breakdown) | MetaGPT role pipeline (PM → Architect → PM) as three plan stages; Memory Bank `systemPatterns.md` | `plan.json` `modules[]`, each with its own task list |
| 3 | Технологические миграции (tech migrations) | Memory Bank `techContext.md` + Plandex versioned plan revisions | `plan.json` `migrations[]` with `plannedFor` / `status` |
| 4 | Связка с агентом кодинга (coding-agent link) | MetaGPT `Task.assignee`; OpenHands conversation dispatch; Paseo SDK `create_agent` / `send_agent_prompt` / `archive_agent` | server RPC that spawns/binds a Paseo agent per task, labels it with the task id |
| 5 | План / факт | Plandex sandbox + `progress.md` semantics | per task: `plan` (expected) vs `fact` (actual: commits, test runs, agent report) |
| 6 | Верификация (verification) | Plandex: run commands after apply, **rollback on failure**; MetaGPT `is_success` gate; OpenHands run history | task can only reach `done` with a `verification{command, exitCode, at}` record; failed verification reopens the task and cascades reset to dependants |

### 5.1 Proposed data layout (file-based, no DB)

```text
<project>/.luck-planner/
  plan.json          # canonical state: goal, modules[], tasks[] (DAG), migrations[], revisions[]
  events.ndjson      # append-only event log (schemaVersion at line 1), OpenHands-style
  progress.md        # human-readable план/факт view, regenerated from plan.json (Memory Bank style)
  verifications/     # one file per verification run: command, exitCode, output excerpt
```

Precedent for storing plugin state as plain files: the installed `bunny-search` Paseo plugin keeps
its settings in `$PASEO_HOME/plugin-settings/<id>/<id>.json` and mirrors human-readable output
next to it.

### 5.2 Proposed state machine (task)

```text
proposed -> planned -> in_progress -> verifying -> done
                ^           |            |
                +-----------+            v
             (reopened + cascade reset of dependants) <- failed
```

- `planned` → human approval gate (Plandex review);
- `verifying` → tests/build run, result recorded (Plandex auto-exec + MetaGPT `is_success`);
- `failed` → `reset_task` semantics from MetaGPT: reopen this task **and all dependants**.

### 5.3 Proposed Paseo integration surface

- **Workspace panel** (`addWorkspacePanel`): plan tree, DAG, план/факт per task, verification log;
- **Command Center item** + **slash command** (e.g. `/plan …`): create/approve/advance plan steps;
- **Timeline row** (`paseo.agents.ref(id).timeline.append`): emit plan events (task started,
  verification passed/failed) into the coding agent's timeline;
- **Server RPC** (`defineRpc` + `server.handle`): plan mutations, agent spawn/bind, verification run;
- **Lifecycle hooks** (`server.on` ended turns) → derive `fact` from the coding agent's turn result;
- **Before hooks** (`server.before`) → inject the current task's plan slice into the spawned agent's
  prompt/config (MetaGPT "planner output = executor input").

### 5.4 Open questions (waiting for the requirements)

1. Scope of storage: per-project files (proposal above) vs plugin settings in Paseo home?
2. Who is allowed to mark a task `done` — agent, human, or only verification evidence?
3. Is a human approval gate mandatory before coding starts (Plandex-style), or advisory?
4. Do plan revisions need branching, or is linear revision history enough?
5. Which providers/agent profiles carry the `assignee` binding (see `list_profiles` in Paseo skill)?

---

## 6. Sources (all links verified while writing this document)

**MetaGPT** — https://github.com/FoundationAgents/MetaGPT
- [`metagpt/schema.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/schema.py) — `Task`, `TaskResult`, `Plan` (DAG, topological sort, cascading reset, `TaskReporter`)
- [`metagpt/roles/`](https://github.com/FoundationAgents/MetaGPT/tree/main/metagpt/roles) — `product_manager.py`, `architect.py`, `project_manager.py`, `engineer.py`, `qa_engineer.py`, `role.py`

**Plandex** — https://github.com/plandex-ai/plandex
- [`docs/docs/core-concepts/plans.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/plans.md)
- [`docs/docs/core-concepts/reviewing-changes.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/reviewing-changes.md)
- [`docs/docs/core-concepts/version-control.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/version-control.md)
- [`docs/docs/core-concepts/branches.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/branches.md)
- [`docs/docs/core-concepts/autonomy.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/autonomy.md)
- [`docs/docs/core-concepts/context-management.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/context-management.md)
- [`docs/docs/core-concepts/execution-and-debugging.md`](https://github.com/plandex-ai/plandex/blob/main/docs/docs/core-concepts/execution-and-debugging.md)

**Cline / Memory Bank**
- [`cline/prompts/.clinerules/memory-bank.md`](https://github.com/cline/prompts/blob/main/.clinerules/memory-bank.md) — the full pattern (file hierarchy, plan/act workflows, update rules)
- [`cline/cline`](https://github.com/cline/cline) — agent that follows the pattern
- [`hudrazine/claude-code-memory-bank`](https://github.com/hudrazine/claude-code-memory-bank) — port of the same pattern (evidence the format is reusable outside Cline)

**OpenHands**
- [`OpenHands/OpenHands`](https://github.com/OpenHands/OpenHands) — README (multi-repo boundaries, Agent Canvas, sandbox options, architecture diagram)
- [`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk) — SDK/Agent Server
- [`openhands-sdk/openhands/sdk/event/`](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-sdk/openhands/sdk/event) — event package (`base.py`, `conversation_state.py`, …)
- [`openhands-sdk/openhands/sdk/AGENTS.md`](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/AGENTS.md) — event schema versioning / migration / backward-compat policy
- [`OpenHands/automation`](https://github.com/OpenHands/automation) — schedules, webhooks, run history, dispatch

**Local context used for mapping**
- `paseo-plugin` account skill (plugin contribution surface used in §5.3)
- installed plugin `bunny-search` (`$PASEO_HOME/plugins/bunny-search/...`) for the file-state precedent (§5.1)
