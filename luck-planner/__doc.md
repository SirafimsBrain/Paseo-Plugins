# luck-planner — technical documentation

> **Development status: version in development (`0.4.0`).** Development is currently paused
> after **stage B3** (node CRUD + leaf state machine + revisions + append-only audit — done,
> all tests green). The next stage is **B4** (FTS5 search and filters). Nothing in this
> document is a released API: the roadmap in §7 describes work that is still ahead.

This file documents the internal design, decisions, and roadmap of the `luck-planner` plugin.
User-facing description: [README.md](./README.md) (added in stage J1).

`luck-planner` is the project-planning tree for coding agents on [Paseo](https://paseo.sh/):
a SQLite-backed hierarchical model of a project — tech-stack root, trunk, module branches,
fact leaves with statuses, influence links ("bees"), incident bugs, approved high goals, and
growth rates — maintained by coding agents through MCP tools, reviewed by a human in a native
Paseo panel, and visualized in a 2D diagram and a 3D tree served by the plugin's own HTTP
server.

**Source of truth for implementation:** this document. The working Russian-language planning
notes in this directory (`PLAN.md` and the original requirement drafts) are planning artifacts;
where they disagree with `__doc.md`, `__doc.md` wins. The prior research file
`TEMP-ARCHITECTURE-RESEARCH.md` was consumed into this document (§8) and deleted in stage A2.

## 1. Purpose and scope

Coding agents plan and write code, but the plan/fact state of a project lives nowhere durable:
different agents re-derive the same context, lose track of what was decided, and cannot see how
one fact (a leaf) affects another. luck-planner gives every project a single persistent tree:

- **root** — the technology stack (languages, libraries, tools, services, versions, and who
  added each and why; later agents append clarifications, which creates back-references so a
  library can "show" everywhere it is used);
- **trunk** — the link between platform/frameworks/libraries and the actual code;
- **main branches** — modules/packages/libraries of the code itself;
- **side branches** — functions, classes, data structures;
- **leaves** — *facts*: planned code, code in development, done code; each leaf carries a
  version, a revision, and a status;
- **bees** — links between leaves (working on one leaf affects another); each bee has a status
  and revision describing the influence and its severity;
- **bugs** — problems/incidents blocking a leaf or a group of leaves; each bug has a status and
  revision;
- **high goals** — a formal natural-language task plus the agent's broken-down plan; goals
  enter the tree only after the plan is approved, and materialize as side branches with leaves;
- **growth rates** — a progress structure (goal → steps → facts done/not done, reasons,
  pauses, clarification requests) attachable to *any* tree element.

Every mutation records **who, when, what, and with what result** — a mandatory requirement.

## 2. Architectural decisions (ADR)

| # | Decision | Rationale |
| --- | --- | --- |
| **ADR-1** | The dashboard (2D and 3D) is a **separate web app** (React + TypeScript) served by the plugin's HTTP server on `127.0.0.1` and opened in Paseo's **workspace browser** (`navigation.openBrowser`), falling back to `openExternalUrl`. The native React Native panel is the everywhere-working overview layer. | Plugin client code is React Native: DOM, canvas, WebGL, `react-native-svg` and DOM libraries are **compile errors** (plugin reference → Cross-platform rules; the scaffold tsconfig omits DOM). React Flow / Cytoscape / Three.js cannot be embedded in a panel. Precedents in this repo: bunny-search opens its web UI in a Paseo browser tab; memory-flash runs an HTTP server in the daemon subprocess. The workspace browser is Electron Chromium, so WebGL is available for 3D. |
| **ADR-2** | Storage is **one SQLite file** `$PASEO_HOME/plugins/luck-planner/luck-planner.db` (`node:sqlite`, Node ≥ 24.20), WAL, 5 s busy timeout + write-retry, FTS5 (`porter unicode61`), `meta.schema_version` with forward migrations. All rows are scoped by `project_key` (canonical workspace/project path). | Direct requirement ("use SQLite", "FTS5 and strengthened search, the memory-flash example"). One file with `project_key` is simpler than a file per project and repeats memory-flash's proven layout. The memory-flash 0.3.2 lesson (parallel writers: busy timeout + retry) is carried over from day one, not after losing writes. |
| **ADR-3** | Agent access is a **bundled stdio MCP server** (`dist/mcp-server.js`, esbuild), injected into every agent via `server.before("agent.create")` plus `paseo-plugin.json` `mcp.entry` (revision-independent publication, as in memory-flash 0.7.x). Agents read/write the tree with `luck_tree_*` tools. | The point of the plugin is that coding agents maintain the tree. Plugin RPCs are not reachable from agent processes; MCP is the only channel. Proven mechanics from memory-flash and bunny-search. |
| **ADR-4** | **2D — React Flow**; **3D — @react-three/fiber + drei + d3-hierarchy** (last implementation block). Both views share **one data layer** (same JSON API + graph-model adapter + same details panel), with a 2D/3D toggle in the toolbar. | Matches both requirement drafts; a shared data layer prevents logic drift and makes 3D a renderer swap, not a second dashboard. |
| **ADR-5** | The tree is an **adjacency list** (`parent_id`) with kind enum (`root`,`trunk`,`branch`,`subbranch`,`leaf`); no materialized path. The dashboard builds the tree in memory from one query. | Cheap moves without path recomputation; thousands of nodes do not need materialized paths; layout happens in the dashboard. |
| **ADR-6** | Leaves are a **state machine**: `draft → ready → claimed → in_progress → (blocked) → done`, plus terminal `cancelled` / `superseded`. Every transition increments `revision` and appends an audit row (`actor`, `action`, `revision`, `result`, `at`). | The state machine plus revisions are the heart of plan/fact. The audit log is written from the first CRUD stage (B3) — no exceptions. |
| **ADR-7** | High goals have an **approval gate**: `draft → proposed → approved`. Only a human (via the native panel/RPC) or a managing orchestrating agent approves; only `approved` goals materialize a subtree. Replacing a plan supersedes the old goal and **cascades a reset** to derived leaves. | Requirement: the tree receives goals only after the plan is agreed. Plandex review gate; MetaGPT `reset_task` cascade semantics. |
| **ADR-8** | Dashboard v1 is **read-only**. All mutations go through MCP (agents) or the native panel (human). Editing from the dashboard is roadmap. | Shrinks the HTTP attack surface and keeps the first release coherent. |
| **ADR-9** | The HTTP server binds `127.0.0.1` only, uses a per-installation access token in the URL (memory-flash API-key precedent), exposes `GET /health`, and serves the SPA from `dist/dashboard`. No `0.0.0.0` binding without an explicit setting. | Plugins are trusted code with machine access; do not widen the surface with a cheap bind. |

## 3. Target directory layout

```text
luck-planner/
├── paseo-plugin.json        # id, requirements >=0.11.0, build: [[npm,ci],[npm,run,bundle]], mcp.entry
├── package.json             # scripts: bundle (mcp + dashboard), typecheck, test
├── tsconfig.json            # + vitest.config.mts
├── index.client.tsx         # panel, ⌘K items, slash commands, "Open dashboard", settings screen
├── index.server.ts          # RPC handlers, before/on hooks, HTTP server lifecycle, MCP injection
├── shared/                  # zod contracts, no Node/React
│   ├── tree.ts              # nodes, kinds, statuses, revisions
│   ├── links.ts             # bees and bugs
│   ├── goals.ts             # high goals: formal text + plan
│   ├── growth.ts            # growth rates (goal → steps → facts)
│   ├── rpc.ts               # defineRpc contracts
│   └── tools.ts             # MCP tool schemas
├── server/
│   ├── store.ts             # SQLite: schema v1, migrations, CRUD, FTS5, audit
│   ├── semantics/           # state machine, bees, bugs, goals, growth (one file per domain)
│   ├── mcp-server.ts        # stdio JSON-RPC 2.0
│   ├── mcp-tools.ts         # transport-independent dispatch
│   ├── mcp-launch.ts        # node/entry resolution, revision-independent publication
│   ├── http-server.ts       # SPA + JSON API + SSE + health
│   └── skill.ts             # SKILL.md for agents + installer
├── client/
│   ├── tree-panel.tsx       # native workspace panel (tree outline)
│   ├── details.tsx          # node details panel
│   ├── open-dashboard.ts    # openBrowser → openExternalUrl fallback
│   └── use-host-typography.ts
├── dashboard/               # web app (separate bundle, NEVER imported from client/server)
│   ├── index.html
│   └── src/                 # app, data adapter, layout, nodes2d/, scene3d/, details/
├── scripts/bundle.mjs       # esbuild: dist/mcp-server.js + dist/dashboard/*
├── tests/                   # vitest: store, semantics, mcp e2e, http, adapters
├── README.md                # English (project rule)
└── __doc.md                 # this file
```

SDK import boundaries are strict: `dashboard/` is compiled by esbuild as its own entry and is
only ever *served* by the HTTP server — it is never imported from `client/` or `server/`
(precedent: memory-flash `dist/mcp-server.js`). Client code uses React Native primitives only;
DOM globals are forbidden outside `client/web.ts` (which this plugin does not need yet).

## 4. Domain model and state machines

### 4.1 Leaf statuses (exact vocabulary from the requirements)

| Status | Meaning |
| --- | --- |
| `draft` | Not taken into work yet |
| `ready` | Can be taken |
| `claimed` | Locked by an agent |
| `in_progress` | Work under way |
| `blocked` | Waits on a dependency/human (often an open bug) |
| `done` | Step confirmed (by agent or human) |
| `cancelled` / `superseded` | Cancelled / replaced by another plan |

Allowed transitions are defined once in `shared/tree.ts` and enforced by the store; every
transition bumps `revision` and appends a `history` row.

### 4.2 Bees and bugs

- A **bee** connects two leaves of the same `project_key`; self-loops are rejected. It carries
  `status`, `revision`, and a free-text `impact` describing the influence and its degree.
  The API "all bees of a node" works in both directions — the dashboard and panel need it.
- A **bug** is an incident with `title`, `description`, `severity`
  (`low|medium|high|critical`), `status`, `revision`, and an m2m `bug_nodes` table: one bug may
  block a leaf or a group of leaves. An `open` bug attached to a leaf is surfaced as a blocker
  in the leaf's details.

### 4.3 High goals and the approval gate

`draft → proposed → approved` — approval only through the native panel/RPC, recorded with the
approving actor. `approved` materializes a subtree (side branches + leaves derived from
`plan_json`) linked by `materialized_node_id`; materialization is idempotent. Replacing a plan
marks the goal `superseded` and cascades a reset onto derived leaves (MetaGPT `reset_task`
semantics), so plan/fact stays honest after a redo.

### 4.4 Growth rates

A polymorphic progress record attachable to a `node` or a `goal`: ordered steps, each with a
state and the facts of completion/non-completion plus reasons (pauses, clarifications,
approval waits). Carries `status` and `revision` like everything else. The read API computes
an aggregate (share of completed steps) for the dashboard heatmap/progress layer.

## 5. Storage design (schema v1 sketch)

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,             -- uuid
  project_key TEXT NOT NULL,       -- canonical project path
  parent_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL CHECK (kind IN ('root','trunk','branch','subbranch','leaf')),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL,            -- leaf: draft|ready|claimed|in_progress|blocked|done|cancelled|superseded
  version TEXT DEFAULT '',         -- fact/code version
  revision INTEGER NOT NULL DEFAULT 1,
  payload TEXT DEFAULT '{}',       -- JSON: tech-stack for root, file/function for branches, plan/fact for leaves
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT,  -- agent id | 'user'
  archived_at INTEGER
);
CREATE INDEX nodes_project_parent ON nodes(project_key, parent_id);

CREATE TABLE bees (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  source_leaf_id TEXT NOT NULL REFERENCES nodes(id),
  target_leaf_id TEXT NOT NULL REFERENCES nodes(id),
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  impact TEXT DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT
);

CREATE TABLE bugs (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT DEFAULT '',
  severity TEXT NOT NULL,          -- low|medium|high|critical
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT
);
CREATE TABLE bug_nodes (bug_id TEXT REFERENCES bugs(id), node_id TEXT REFERENCES nodes(id),
  PRIMARY KEY (bug_id, node_id));

CREATE TABLE goals (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  formal_text TEXT NOT NULL,       -- natural-language task
  plan_json TEXT NOT NULL,         -- agent's atomic plan steps
  status TEXT NOT NULL,            -- draft|proposed|approved|in_progress|done|cancelled
  materialized_node_id TEXT REFERENCES nodes(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT
);

CREATE TABLE growth (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('node','goal')),
  subject_id TEXT NOT NULL,
  steps_json TEXT NOT NULL,        -- [{step, state, facts[], reason}]
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_by TEXT, updated_by TEXT
);

-- append-only audit: who/when/what/result (mandatory)
CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- create|update|status|link|approve|...
  revision INTEGER NOT NULL, actor TEXT,
  result TEXT DEFAULT '', at INTEGER NOT NULL
);

CREATE TABLE node_fts USING fts5(name, description, payload, content='nodes', content_rowid='rowid',
  tokenize='porter unicode61');   -- + INSERT/UPDATE/DELETE triggers (memory-flash template)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version
```

Storage rules carried over from memory-flash (verified there, apply here):

- WAL + `synchronous=NORMAL`; open with a 5 s busy timeout (both the `DatabaseSync` `timeout`
  option and `PRAGMA busy_timeout`) and run every write through a retry wrapper
  (transient `database is locked` retried with exponential backoff before surfacing a readable
  error);
- schema version in `meta.schema_version` with forward migrations (`_migrate_vN_to_vN+1`);
- FTS5 external-content index kept in sync by triggers (correct for direct `UPDATE`s too);
- search parses `key=value` filters out of the free text and OR-joins the remaining tokens
  (bm25 ordering), with a `LIKE` fallback when nothing indexable remains;
- every failure path returns a readable `{ok:false, error}` rather than a raw SQLite message.

## 6. Paseo integration surface (SDK 0.11.x)

| Contribution | Where | Stage |
| --- | --- | --- |
| Workspace panel (tree outline, details, filters, search) | `client.addWorkspacePanel` | E2 |
| Command Center items + slash commands | `addCommandCenterItem`, `addSlashCommand` | E3 |
| Settings screen (`injectIntoAgents`, `mcpServerName`, HTTP port, token, retention) | `defineSettings` / settings screen | E4 |
| Plugin RPCs (`tree.get`, `node.detail`, `node.setStatus`, `goal.approve`, …) | `defineRpc` + `server.handle` | E1 |
| MCP injection into agents | `server.before("agent.create")` | D3 |
| Dashboard HTTP server | daemon subprocess, started by the plugin lifecycle | F1 |
| "Open dashboard" | `navigation.openBrowser` → `openExternalUrl` fallback | F2 |
| Agent timeline rows (goal approved, leaf done) | `paseo.agents.ref(id).timeline.append` (optional) | H2 |

Client rules enforced at every UI stage: colors only from `theme.colors`, padding from
`layout.compact`, host typography via `use-host-typography`, React Native primitives only, and
the DOM-grep audit (`document.|window.|className=|onClick=` over `client/`) must return zero.

### MCP tools (planned contract, stage D1)

`luck_tree_get_context` (root→…→leaf path plus neighbouring facts), `luck_tree_search`,
`luck_tree_upsert_leaf` (plan/fact + version), `luck_tree_add_bee`, `luck_tree_report_bug`,
`luck_tree_set_goal` (draft/proposed only — humans approve), `luck_tree_update_growth`,
`luck_tree_history`. All validated by the same zod schemas as the RPCs; all writes carry a
`project_key` and an actor.

### Dashboard HTTP API (planned, stage F1, read-only)

`GET /health`, `GET /api/tree?project=` (nodes + bees + bugs + goals + growth in one graph-
ready response), `GET /api/node/:id` (details + history + links), `GET /api/search`,
`GET /api/stats`, `SSE /api/events` (tree-changed notifications, stage H1).

## 7. Roadmap (stage map)

One stage = one commit, ending green (`npm run typecheck`, `vitest run`); each functional
stage bumps the MINOR version and is marked with an annotated `luck-planner@<version>` tag
pushed to origin (project rule). Docs-only stages do not bump.

**Status: development paused after stage B3.** Stages A1–B3 are complete and released as
tagged versions up to `luck-planner@0.4.0`; stage **B4** (FTS5 search and filters) is next.
Blocks C–J are untouched.

| Block | Stages | Versions | Content |
| --- | --- | --- | --- |
| A | A1–A2 | 0.1.0 | scaffold ✅; this document ✅; TEMP removed ✅ |
| B | B1–B4 | 0.2.0–0.5.0 | zod schemas ✅ (0.2.0), SQLite store ✅ (0.3.0), CRUD + state machine + audit ✅ (0.4.0), FTS5 search ⏸ *next: B4* |
| C | C1–C4 | 0.6.0–0.9.0 | bees, bugs, goals + approval gate, growth rates |
| D | D1–D3 | 0.10.0–0.12.0 | MCP tool contracts, stdio server + bundle, agent injection + skill |
| E | E1–E4 | 0.13.0–0.16.0 | RPCs, native panel, ⌘K + slash, settings screen |
| F | F1–F2 | 0.17.0–0.18.0 | dashboard HTTP server, "Open dashboard" action |
| G | G1–G5 | 0.19.0–0.23.0 | 2D dashboard (React Flow): scaffold, adapter + layout, nodes, interaction, growth layer |
| H | H1–H2 | 0.24.0–0.25.0 | SSE live updates; optional timeline rows |
| I | I1–I4 | 0.26.0–0.29.0 | 3D tree (react-three-fiber) — **last block**: WebGL spike, geometry, effects, interaction + toggle |
| J | J1–J2 | — | README.md + root README link; final e2e acceptance on a live daemon |

Blocks B–D have file-disjoint boundaries and may be delegated to different agents.

## 8. Research provenance (why these decisions)

The design was validated against four established systems (full source links are preserved in
the conversation history of the research stage; each claim below names the system it came
from):

- **MetaGPT** (`metagpt/schema.py`, `metagpt/roles/`) — tasks form a **DAG** with
  `dependent_task_ids`, topological ordering, and `reset_task` that **cascades to downstream
  dependents**; `is_finished` (work performed) and `is_success` (verified) are separate.
  Adopted: cascading reset on plan replacement (§4.3), separation of "leaf done" from
  "confirmed by verification".
- **Plandex** (docs: plans, reviewing-changes, autonomy) — a plan is an explicit object behind
  a **review gate**; changes land through review, and failed verification rolls back.
  Adopted: the goal approval gate (§4.3) and read-only dashboard v1 (ADR-8).
- **Cline / Roo Code Memory Bank** (`.clinerules/memory-bank.md`) — plan/fact state survives
  agent resets because it is written down in a fixed ritual after every significant step.
  Adopted: the mandatory audit trail (§1, §5) and the growth-rate structure (§4.4).
- **OpenHands** (`software-agent-sdk` events, `AGENTS.md` policy) — everything is an
  **append-only event log** with a `schema_version` and migration functions; old events must
  always load. Adopted: `history` table + `meta.schema_version` migrations (§5).

## 9. Risks and standing constraints

| Risk | Mitigation |
| --- | --- |
| WebGL unavailable in the workspace browser on some client | Spike I1 before writing the scene; fall back to 2D with an explanation |
| React Flow degrades above ~1000 nodes | Collapse/expand by default (G2), filters, synthetic-canvas measurement in the G2 acceptance |
| 3D bundle bloats the first chunk | Separate lazy entry `dashboard-3d.js` (I1), loaded only on toggle |
| Concurrent SQLite access (agents + UI + HTTP) | WAL + busy timeout + write-retry from stage B2; one owning process |
| Plugin update breaks agents' MCP entry path | Revision-independent publication from stage D2 (memory-flash 0.7.1 lesson) |
| HTTP layer as an attack vector | 127.0.0.1 + token + read-only API (ADR-8, ADR-9) |
| Mobile clients without a workspace browser | Native panel works everywhere; dashboard via `openExternalUrl`; 3D on mobile is best-effort, documented |

Standing constraints: zero runtime npm dependencies in daemon code where possible (Node
built-ins first, as in memory-flash); `dashboard/` dependencies (React Flow, three.js) live in
`devDependencies` and are bundled by esbuild; README.md and `__doc.md` are maintained in
English only (project rule).
