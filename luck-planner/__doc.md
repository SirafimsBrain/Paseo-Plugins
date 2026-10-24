# luck-planner — technical documentation

> **Development status: version in development (`0.34.0`).** Stages **E4** (settings
> screen), **F1** (read-only dashboard HTTP server), **F2** ("Open dashboard"),
> **G1** (dashboard web-app scaffold), **G2** (data adapter + layout), **G3**
> (custom nodes and edges), **G4** (interaction: click → details, selection
> highlights, search with camera focus, filters), **G5** (growth layer: per-node
> growth roll-up, heat map, goal-frame progress), **H1** (live data: the
> `tree-changed` SSE event plus the `tree-changes` RPC the native panel polls),
> **H2** (agent timeline rows for the two key audit facts), **I1** (the WebGL
> spike: probe + fallback, lazy `dashboard-3d.js` entry, empty scene with
> OrbitControls), **I2** (the 3D tree: radial layout + geometry), **I3**
> (bees, bugs, goals and growth in 3D, with the animation frame budget) and
> **I4** (3D interaction: picking into the shared details panel, the selection
> highlight, the camera flight from the search, the filters in 3D and the
> remembered 2D/3D choice), **J1** (the plugin's English README and the link
> from the repository README), **J2** (the live-daemon acceptance — the
> install, the MCP round trip, the goal approval, the dashboard in the host's
> browser, the SSE, the themes and the measurements), **D4** (the MCP
> server registered in the agents' own config files — OpenCode, Kilo, Cline,
> Cursor, Qwen Code, Codex CLI) and **D5** (the structural tools an agent needs to shape
> a project: create/rename, move and archive any node) are done and all
> tests are green.
> Stages A1–I4, J1, J2, D4 and D5 are complete. Nothing in
> this document is a released API: the roadmap in §7 describes work that is still
> ahead.

This file documents the internal design, decisions, and roadmap of the `luck-planner` plugin.
User-facing description: [README.md](./README.md).

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
│   ├── api.ts               # read-only dashboard HTTP API contracts
│   └── tools.ts             # MCP tool schemas
├── server/
│   ├── store.ts             # SQLite: schema v1, migrations, CRUD, FTS5, audit
│   ├── semantics/           # state machine, bees, bugs, goals, growth (one file per domain)
│   ├── mcp-server.ts        # stdio JSON-RPC 2.0
│   ├── mcp-tools.ts         # transport-independent dispatch
│   ├── mcp-launch.ts        # node/entry resolution, revision-independent publication
│   ├── http-server.ts       # SPA + JSON API + SSE + health
│   ├── http-lifecycle.ts    # keeps the HTTP server in step with settings (debounce/restart)
│   ├── change-feed.ts       # polls the shared audit trail → `tree-changed` (stage H1)
│   └── skill.ts             # SKILL.md for agents + installer
├── client/
│   ├── tree-panel.tsx       # native workspace panel (tree outline)
│   ├── details.tsx          # node details panel
│   ├── open-dashboard.ts    # openBrowser → openExternalUrl fallback (pure logic)
│   ├── dashboard-screen.tsx # ⌘K "Open dashboard" screen + SDK glue
│   └── use-host-typography.ts
├── dashboard/               # web app (separate bundle, NEVER imported from client/server)
│   ├── index.html
│   └── src/                 # app, live SSE client, data adapter, layout, nodes2d/, scene3d/, details/
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

### Search (stage B4 — `server/store.ts`, `search(query, options)`)

Search is read-only (no write fence, no transaction, nothing to audit) and hard-scoped to one
`projectKey`: rows of another project are unreachable even with a `project=` pair in the query
text — a mismatch yields no hits rather than a leak. The path is chosen by what the query
actually contains:

1. **FTS5** when the free text has indexable terms. `parseQuery()` first removes the
   recognized `key=value` pairs (`kind=`, `status=`, `project=`; repeated keys accumulate,
   the two enum values are lowercased, one layer of quoting is stripped). `ftsQuery()` keeps
   `"quoted phrases"` verbatim and reduces every other token to letters, digits, `_` and `-`
   before OR-joining them, so bm25 ranks the strongest match first (SQLite returns bm25
   negated: lower is better, and hits are returned in that order). Unknown pairs
   (`version=1.2`) stay in the free text as **two** terms, never glued into one token.
   English **and Russian** stop words are dropped — inside an OR-joined query a stop word
   would otherwise pull every document containing it into the result — and a token counts as
   indexable only when it is ≥2 characters, is not a stop word, and contains at least one
   letter or digit. That last rule is what makes a run of punctuation (`---`, `__`) fall
   through to the LIKE path instead of becoming an empty quoted phrase that silently matches
   nothing. Quoting every term is what neutralizes FTS5 syntax: `key:value` cannot turn into a
   column filter and `NEAR(` cannot turn into an operator, so no user text can produce a
   SQLite syntax error.
2. **`LIKE` scan** when nothing is indexable (stop-word-only or punctuation-only query), over
   `name`, `description` and `payload`, with `%`, `_` and `\` escaped (the fallback finds the
   literal text the caller typed, not a pattern). Unranked: `score = 0`, `snippet = null`,
   newest first.
3. **Filter-only listing** when there is no free text left at all (`kind=leaf` on its own) —
   the natural backing for "everything with status X" views in the panel and the dashboard.

Option filters and query filters are merged and AND-combined; `kinds` / `statuses` are
validated through the shared enums, so a bad value fails *before any SQL* with the readable
"expected one of …" message. Archived nodes are excluded unless `includeArchived` is set —
search is a view of the live tree. `limit` is clamped to 1..100 (default 50): a search answers
a question, it does not dump the tree. Each hit carries the node, its bm25 `score`, and a
`snippet` — the description with the matched terms highlighted, `null` when there is nothing
to show.

Verified by `tests/search.test.ts` (28 tests): bm25 ordering (two-term short document beats
single-term beats long document), inclusion/exclusion by kind, status, project and archived
state, the FTS index staying in sync with a rename (B2 trigger), Cyrillic search including
capitalized queries (unicode61 case-folds Cyrillic; `porter` stems ASCII only, so a Cyrillic
query must use the stored word form), the LIKE fallback with literal wildcards, limit clamping,
read-only guarantees (revisions, history and the index untouched), and a battery of hostile
queries asserted to produce only MATCH expressions that SQLite accepts.

### Bees (stage C1 — `server/store.ts`)

The influence links of §4.2 are implemented as six methods: `getBee`, `listBees(projectKey)`,
`listBeesForNode(projectKey, nodeId)` (reads) and `createBee`, `updateBee`, `deleteBee`
(mutations). The rules, each verified by `tests/bees.test.ts` (21 tests):

- **Both ends are validated at write time**: the node must exist *in this `project_key`*, be a
  `leaf`, and not be archived. The error names the offending end ("bee source node … is a
  branch; bees connect leaves only"), and a leaf of another project is simply "not found" —
  the project boundary never leaks.
- **Self-loops are rejected** ("a bee cannot connect a leaf to itself"), the runtime
  counterpart of `beeSchema`'s refinement.
- **One bee per ordered pair**: a second `A → B` edge is rejected, because parallel edges
  would render as one ambiguous arrow on the dashboard; the reverse `B → A` is a distinct
  relation and is allowed. The duplicate check sees live rows only, so a pair can be linked
  again after `deleteBee`.
- **Lifecycle**: a bee starts `active` and moves through `BEE_TRANSITIONS` (`shared/links.ts`).
  A no-op and an illegal transition are rejected with the allowed list in the message and
  change nothing — no revision, no history row: the B3 node discipline applied to links.
- **Revision + audit on every mutation**: `createBee` → `link` (revision 1); `updateBee` →
  `status` when the lifecycle moved (result `from → to`, plus `; updated impact` when both
  fields changed) or `update` when only `impact` changed; `deleteBee` → `unlink`. Bees carry
  no `archived_at`, so delete is a real delete — and it still bumps the revision in the audit
  row, so a deleted bee's history stays gapless and strictly increasing, and the returned bee
  carries that same final revision.
- **`listBeesForNode` works in both directions**: the influences a leaf spreads (it is the
  source) and the ones landing on it (it is the target). "Influence over a group" is a set of
  bees sharing one source; the dashboard draws them as edges, the panel lists them in the node
  details.
- **Linking does not touch the leaves**: their revisions and histories stay unchanged, and a
  rejected attempt writes nothing anywhere.

All reads are project-scoped like every other method. `listBees` is what `GET /api/tree` (F1)
will serialize as the graph's edge set.

### Bugs (stage C2 — `server/store.ts`)

Incidents plus the m2m `bug_nodes` table: mutations `createBug`, `updateBug`, `deleteBug`,
`attachBug`, `detachBug`; reads `getBug`, `listBugs`, `listBugsForNode`, `listBlockingBugs`,
`listNodesForBug`. The rules, each verified by `tests/bugs.test.ts` (19 tests):

- **Severity is mandatory at creation** (`low|medium|high|critical`) — triage needs it — and
  status starts `open`. The initial leaf set is attached **in the same transaction** as the
  bug, so a half-created incident with dangling attachments cannot exist.
- **Attachments obey the bee's end contract**: a blocked node must exist in this
  `project_key`, be a `leaf`, and not be archived. A duplicate attach is rejected ("already
  attached"), detaching something that is not attached fails, and re-attaching after a detach
  works. A leaf of another project is simply "not found" — the project boundary never leaks.
- **Lifecycle**: `open → investigating → resolved / cancelled` through `BUG_TRANSITIONS`; a
  no-op and an illegal transition are rejected with the allowed list in the message and change
  nothing — no revision, no history row.
- **Attachment changes are mutations of the bug**: `attachBug` / `detachBug` bump the bug's
  revision and append `link` / `unlink` with the node id in the result. `createBug` writes one
  `create` row (initial attachments included in the result text), `updateBug` writes `status`
  or `update`, `deleteBug` writes `archive`. **The blocked leaves themselves are never
  touched** — a blocker is a computed read, not node state, so a leaf's revision and history
  stay exactly as they were.
- **`deleteBug` removes the incident and all of its attachments** in one transaction, records
  the removed-attachment count in the audit result, and follows the `deleteBee` revision rule:
  the bump is recorded in `history`, the returned bug carries that final revision, and the
  sequence stays gapless.
- **`listBlockingBugs`** is the "blocked by" view of the leaf details: only `open` and
  `investigating` incidents (`isBugBlocking`, `shared/links.ts`). Resolving an incident keeps
  it in `listBugsForNode` for history while instantly removing it from the blocking set.
- **`listNodesForBug`** is the group side: one incident over N leaves reads back as N nodes;
  the dashboard draws the bug as a badge, the panel shows it in both details views.

Every read is project-scoped. `listBugs` plus `listNodesForBug` are what `GET /api/tree` (F1)
will serialize alongside the bee edges.

### High goals (stage C3 — `server/store.ts`)

Six mutations and three reads implement §4.3: `createGoal`, `updateGoal`, `setGoalStatus`,
`approveGoal`, `rejectGoal`, `replaceGoalPlan`; `getGoal`, `listGoals`, `listGoalLeaves`.
The rules, each verified by `tests/goals.test.ts` (15 tests):

- **A goal starts `draft` and lives outside the tree.** `createGoal` writes only a `goals`
  row — no node appears anywhere until approval (acceptance: an unapproved goal is not in the
  tree).
- **The gate is structural.** `setGoalStatus` refuses `approved` (→ `approveGoal`) and
  `superseded` (→ `replaceGoalPlan`) *by name*, so the funnel `draft → proposed → approved`
  cannot be walked around; `rejectGoal` sends a `proposed` plan back to `draft` with the
  `reject` audit action, while `setGoalStatus` remains the generic lifecycle mover for
  `in_progress`, `done`, `cancelled` and the bookkeeping transitions.
  **Actor identity is not the store's business**: it records the approving actor verbatim
  (`updated_by`, audit `actor`), while ADR-7's rule that only a human via the panel/RPC or a
  managing agent may approve is enforced by the **E1 RPC layer**, the only place where the
  caller's identity exists. Stage C3 ships the structural half of the gate.
- **Approval materializes in the same transaction**: a side branch named after the formal
  task grows under `parentBranchId` (a live branch or subbranch — `root`/`trunk`/`leaf`,
  archived and foreign-project nodes are rejected *before* anything is written), holding one
  draft leaf per plan step with payload `{ goalId, stepId, stepOrder }`. Two audit rows mark
  the two mutations (`approve`, then `materialize`), so revisions stay gapless, and a failed
  approval rolls the gate crossing back with it: a half-grown subtree cannot exist.
- **Materialization is idempotent** (acceptance): approving an already-approved,
  already-materialized goal is a pure no-op — no nodes, no revision, no history rows.
- **Replacing a plan extinguishes the derived leaves** (acceptance; MetaGPT `reset_task`):
  the goal becomes `superseded` — terminal, because a redo starts as a fresh goal — and every
  live derived leaf the shared machine can still move goes to `superseded`, each with its own
  revision bump and a `supersede` audit row. Leaves already `cancelled`/`superseded` and
  archived ones are left untouched (`canTransitionLeaf` decides). The subtree stays in the
  tree as the record of the old plan, still reachable through `materialized_node_id`.
- **Plan validation**: writes require a non-empty array of valid `{ id, title, description }`
  steps and name the offending index; reads survive a corrupt `plan_json` by dropping
  malformed steps instead of breaking every list call — the `payload` rule from stage B2.

**Re-entrancy (cross-cutting change in this stage).** `approveGoal` grows its nodes through
the very same `createNode` calls the rest of the store uses, inside one transaction — so
`write()` and the transaction wrapper became re-entrant: a nested call joins the outer fence
and the outer `BEGIN IMMEDIATE` instead of retrying on its own or dying with "cannot start a
transaction within a transaction". The outermost call still owns the retry and the rollback,
so a lock error during materialization rolls back everything before the retry.

### Growth rates (stage C4 — `server/store.ts`, closes block C)

The polymorphic progress record of §4.4: `createGrowth`, `updateGrowth`, `deleteGrowth`; reads
`getGrowth`, `getGrowthForSubject`, `listGrowth` and the aggregate `getGrowthProgress`.
Verified by `tests/growth.test.ts` (13 tests):

- **Binding is polymorphic and strict where it matters**: the subject may be **any live node
  kind** (§4.4 — growth attaches to every tree element) or a goal of this project; archived
  nodes, unknown ids and foreign projects are rejected before any write, with the subject named
  in the message.
- **One record per subject.** A second attach fails with a pointer to `updateGrowth`, so a
  subject's progress stays one gapless revision sequence instead of fragments. The subject
  itself is never mutated — like bees and bugs, growth rides on its own row and its own audit
  entity (`entity_type = growth`).
- **Steps** are the whole ordered array of `{ id, title, state, facts, reason }` — writes
  validate every step and name the first offender by index (and require at least one); reads
  survive a corrupt `steps_json` by dropping malformed steps, the `payload`/`plan_json` rule.
- **Status** moves through `GROWTH_TRANSITIONS` (`active ⇄ stalled`, `→ done`, `→ cancelled`
  and back); no-ops and illegal transitions are rejected and change nothing. The audit action
  is `status` when the lifecycle moved and `update` when only steps changed — one row per
  mutation, revisions gapless.
- **The aggregate is shared code**: `getGrowthProgress` delegates to `growthProgress()` in
  `shared/growth.ts`, so the dashboard (G5), the panel and any RPC compute the same number:
  `ratio = completed / total`, where `skipped` steps stay in the denominator but never count
  as completed, `failed` is reported separately. Returns `null` for an untracked subject — a
  heatmap distinguishes "no record" from "0 % progress".
- **`deleteGrowth`** is a real delete (no archive flag on this table) with the established
  revision rule: the bump is recorded in `history`, the returned record carries that final
  revision, and the subject may be given a fresh record afterwards.

## 6. Paseo integration surface (SDK 0.11.x)

| Contribution | Where | Stage |
| --- | --- | --- |
| Workspace panel (tree outline, details, filters, search) | `client.addWorkspacePanel` | E2 |
| Command Center items + slash commands | `addCommandCenterItem`, `addSlashCommand` | E3 |
| Settings screen (`injectIntoAgents`, `mcpServerName`, `httpEnabled`, HTTP port, token, retention) | `defineSettings` / settings screen | E4 + F1 |
| Plugin RPCs (`tree.get`, `node.detail`, `node.setStatus`, `goal.approve`, …) | `defineRpc` + `server.handle` | E1 |
| MCP injection into agents | `server.before("agent.create")` + `agent.session_open` | D3 ✅ |
| Settings (`injectIntoAgents`, `mcpServerName`) | `defineSettings` / `server.registerSettings` (values); settings screen | D3 ✅ / E4 |
| Skill for coding agents (`SKILL.md` protocol + installer) | `server/skill.ts`, auto-install on plugin load | D3 ✅ |
| Bundled stdio MCP server (`dist/mcp-server.js`) | `paseo-plugin.json` `mcp.entry` + `server/mcp-server.ts`, spawned by agents | D2 ✅ |
| Dashboard HTTP server | daemon subprocess, started by the plugin lifecycle | F1 ✅ |
| "Open dashboard" (panel button + ⌘K screen) | `navigation.openBrowser` → `openExternalUrl` fallback; `dashboard-status` RPC for the URL | F2 ✅ |
| Agent timeline rows (goal approved, leaf done) | `paseo.agents.ref(id).timeline.append` | H2 ✅ |

Client rules enforced at every UI stage: colors only from `theme.colors`, padding from
`layout.compact`, host typography via `use-host-typography`, React Native primitives only, and
the DOM-grep audit (`document.|window.|className=|onClick=` over `client/`) must return zero.

### MCP tools (stage D1 — `shared/tools.ts` + `server/mcp-tools.ts`)

Eight `luck_tree_*` tools, declared in `MCP_TOOLS` (JSON Schema for the future `tools/list`)
and dispatched by `dispatchMcpTool(name, args, { store, defaultActor })`. The dispatch layer is
transport-independent on purpose: the stdio server of stage D2 and
`tests/mcp-tools.test.ts` (32 tests) call the same function — the memory-flash
`server/mcp-tools.ts` precedent.

| Tool | Behaviour |
| --- | --- |
| `luck_tree_get_context` | Orientation call. Without `nodeId`: overview — roots and their first level (`store.listChildren`). With `nodeId`: path root → … → node (`store.getNodePath`), children, sibling leaves, bees touching the node, blocking bugs and growth progress — the agent "descends one level" in one call instead of probing with searches. |
| `luck_tree_search` | FTS5 search within one project (bm25 ranking, `key=value` filters inside free text, optional kinds/statuses arrays, archived excluded by default). |
| `luck_tree_upsert_leaf` | Create a leaf under `parentId` (`name` required, status defaults to `draft`) or update `leafId` in place: any of name/description/version/payload plus an optional status transition in the same call. Stating the current status is a tolerated no-op; a real transition runs the state machine and its audit row; an illegal transition comes back as a readable `invalid status transition …` error that writes nothing. Editing a non-leaf or an unknown/foreign id is rejected with the node kind named. |
| `luck_tree_upsert_node` | The **structure** of a project: create a node of any kind (`root` → `trunk` → `branch` → `subbranch` → `leaf`, the store validates the parent/child kinds) or update an existing one (name, description, version, payload, status). Added in stage D5 — the leaf-level tool alone left an agent unable to shape anything above the leaf, and the live test pass showed exactly that. |
| `luck_tree_move_node` | Re-parent a node with its whole subtree — the way a fact moves into the branch it really belongs to. The store refuses a move that would break the kind rules or create a cycle. |
| `luck_tree_archive_node` | Soft-delete a node **and its subtree**: the rows stay in the database and the audit trail keeps them, the tree and every diagram built from it stop showing them. |
| `luck_tree_add_bee` | Directed influence edge between two live leaves of one project; self-loops, non-leaf ends and foreign ids are rejected by the store with readable messages. |
| `luck_tree_report_bug` | Incident with severity; `nodeIds` attach blocking leaves immediately — every id must resolve inside the project or nothing is written. |
| `luck_tree_set_goal` | Pre-approval goal management only: `create` (draft; `formalText` + `plan` required), `update` (draft/proposed edits), `propose` (draft → proposed). **Deliberately no `approve` action** — ADR-7: the store refuses `approved` from any path but the native panel/RPC. `create`/`propose` responses carry a note telling the agent a human approves; a repeated `propose` is a readable no-op error, not a second transition. |
| `luck_tree_update_growth` | Upsert of one subject's progress record: an explicit `growthId` wins; otherwise the record is resolved by subject — updated when one exists (error when neither `steps` nor `status` is given), or a fresh one is attached (`steps` required). Step shape and status transitions are validated by the store. |
| `luck_tree_history` | Append-only audit trail of any entity (node/bee/bug/goal/growth), oldest first; an unknown id returns an empty list rather than an error. |

Conventions:

- **Validation** lives in the shared zod contracts (`shared/tools.ts`) — the same source of
  truth the RPC layer (E1) reuses; zod issues collapse into one readable
  `Invalid input: <path>: <message>` line. The JSON Schema in `MCP_TOOLS` mirrors the zod
  contracts for `tools/list` (D2).
- **No throws**: validation failures, unknown tools (the error lists the available ones) and
  store errors all come back as `isError` results, so one bad call can never take down the
  MCP server. Host-prefixed names (`luck-planner_luck_tree_search`) are normalized before
  dispatch.
- **Scoping**: every input requires `projectKey`, and every read/write goes through the store,
  which scopes by `project_key` — a tool call structurally cannot cross a project boundary.
  Each dispatch test asserts this per tool: foreign ids error as "not found in project",
  foreign projects come back empty, and rejected calls leave the target row untouched.
- **Actor**: optional `actor` on every mutating input, falling back to the dispatch context's
  `defaultActor` (the agent id the stdio server will be launched with in D2), then
  `agent:unknown` — the audit trail is never empty.

### stdio MCP server (stage D2 — `server/mcp-server.ts`, `server/mcp-launch.ts`)

The transport half of ADR-3. Verified by `tests/mcp-server-e2e.test.ts` (a real spawn of the
built bundle) and `tests/mcp-launch.test.ts` (6 publication tests), plus the manifest
contract in `tests/manifest.test.ts`:

- **Protocol** — newline-delimited JSON-RPC 2.0 over stdin/stdout: `initialize` (protocol
  `2024-11-05`, `serverInfo` name `luck-planner`), `notifications/initialized`, `ping`,
  `tools/list` (the eight `MCP_TOOLS`), `tools/call` (delegates to `dispatchMcpTool`).
  Unknown methods answer `-32601`, unparseable lines `-32700`, notifications get no
  response. **stdout carries the protocol and nothing else** — the ready line and any
  tool-failure diagnostics go to stderr: one stray log line corrupts the client's framing
  and surfaces as `Connection closed` on a perfectly healthy server (memory-flash lesson).
  MCP semantics live next to the framing because there is exactly one transport: the
  dashboard HTTP server (F1) is read-only REST, not an MCP endpoint.
- **Actor** — the server reads `LUCK_PLANNER_AGENT_ID` at startup and uses it as the
  dispatch default, so every audit row written through MCP names the agent that spawned the
  server (stage D3 sets the variable per agent; the e2e asserts `createdBy`).
- **Version guard** — `SERVER_VERSION` in `mcp-server.ts` must equal `package.json`'s
  version; the e2e handshake asserts it, so every release bump updates the constant agents
  see or the suite fails.
- **Bundle** — `scripts/bundle.mjs` (esbuild → single-file `dist/mcp-server.js`, Node
  built-ins external, ESM banner for CJS built-ins, no sourcemap). The suite rebuilds twice
  and asserts byte-identical output; `pretest` runs the script so the spawn always sees a
  fresh build even under a raw `vitest run`.
- **The built bundle is committed.** The root `.gitignore` deliberately does not ignore
  `dist/` for plugins (memory-flash and bunny-search track `dist/mcp-server.js`), so a host
  can work from a clean clone without running the build. `npm test` regenerates the file, so
  a stage commit includes the rebuilt bundle; `dist/dashboard` is still absent until G1.
- **Manifest** — `paseo-plugin.json` gains `build: [["npm","ci"],["npm","run","bundle"]]`
  as **argv arrays**: the daemon runs each step without a shell, and a flat
  `"build": ["npm run bundle"]` fails manifest validation (`expected array, received
  string` at `build[0]`) leaving the plugin `failed` — the memory-flash lesson, now
  asserted by the manifest tests. `mcp.entry: "dist/mcp-server.js"` lets the daemon locate
  the entry for agent injection (D3).
- **Revision-independent publication (`server/mcp-launch.ts`)** — the install directory
  carries a per-revision uuid (`plugins/<id>/<uuid>/checkout/<plugin>`) that the daemon
  deletes on every update, while an agent re-spawns the entry path baked into its config on
  every later turn; the first update after an agent was created used to delete the entry
  out from under it (node exits `MODULE_NOT_FOUND` before the handshake → `Connection
  closed` on every turn — the measured memory-flash 0.7.1 failure). `resolveMcpEntry()`
  finds the bundle (`plugins.luck-planner.path` in `$PASEO_HOME/config.json` first, then
  `__dirname`/`import.meta.url` fallbacks) and publishes it at
  `$PASEO_HOME/plugins/luck-planner/mcp-server.js` — a revision-independent path in the
  plugin's data directory, removed only with the plugin itself — through symlink → temp
  name → `rename` (atomic, so a spawn mid-update reads old or new, never missing), with a
  copy fallback and `realpath`-based idempotence. `index.server.ts` runs it on **every
  plugin load**, keeping already-created agents working after an update. `mcpServerCommand()`
  pairs the entry with `resolveNodeCommand()` (real `node`: `process.execPath`, sibling
  `node`, PATH scan, plain `node` last) — the single source the D3 injection will use.
  Known limitation, inherited: a path already stored in an existing agent's config is not
  rewritten by the host; agents created before publication existed must be recreated once.

### Native workspace panel (stage E2 — `client/tree-panel.tsx`, `shared/panel.ts`)

`index.client.tsx` registers `luck-planner` via `client.addWorkspacePanel`
(workspace + explorer locations). The panel resolves the tree's `projectKey`
from the current workspace's `projectRootPath` (`useWorkspace`, ADR-2
scoping) and reads through the E1 RPCs: outline (`tree-get`) with
collapse/expand, counters (`stats`), FTS search with status/kind filters
(`tree-search`), details (`node-detail` + `growth-get`) with breadcrumb,
version/revision badge, blocking bugs, bees, history and leaf status moves
(`node-set-status`). Status is always text next to the colour dot (never
colour alone). The view-model (`groupByParent`, `filterSections`,
`nodeMatchesFilters`, labels) is pure and pinned by `tests/tree-panel.test.ts`
(8 tests); the DOM-grep audit over `client/` returns zero matches.

### Plugin RPC surface (stage E1 — `shared/rpc.ts`, `index.server.ts`)

Eleven `luck-planner.*` contracts for the Paseo UI: the native panel (E2), Command
Center items (E3) and the settings screen (E4) all go through them. The server
registers the handlers over one shared `LuckPlannerStore` (closed on plugin
cleanup); `tests/rpc.test.ts` (23 tests, fake `PluginServerContext` against a
temp-directory database) covers the surface:

- **Reads** return store rows directly: `tree-get` (roots with their first level of
  children), `tree-search` (FTS5 with kind/status filters), `node-detail` (node +
  path + children + bees + bugs + blocking bugs + history + growth), `growth-get`
  (record plus the shared `growthProgress` aggregate), `stats` (panel counters —
  new `store.stats()`: live nodes by kind/status, in-progress/done leaves, bees,
  open bugs, proposed/approved goals, growth records), `dashboard-status` (F2:
  the live dashboard address) and `tree-changes` (H1: the audit rows written
  after a watermark — see §6 "Live data").
- **Writes** answer `{ ok, …, error }` instead of throwing (the MCP dispatch
  discipline): `node-set-status` (leaf state machine) and `goal-approve` (gate
  crossing + materialization in one transaction). Both stamp `actor ?? "user"` —
  the panel acts for the human, and `goal.approve` records who approved in the
  `approve` audit row.
- **Scoping**: every contract carries `projectKey`; the suite asserts foreign
  projects come back empty and unknown nodes fail with a readable
  `not found in project` message.

### Command Center and slash commands (stage E3 — `client/slash.ts`, `index.client.tsx`)

Two ⌘K items and two composer slash commands, all writing through the plugin
RPCs (two new contracts since E1, nine total):

- **⌘K** — "Open luck-planner tree" (opens the E2 panel) and "New high goal"
  (seeds a draft goal via the new `goal-create` RPC with placeholder text and
  one step, then opens the panel). The SDK 0.11 command context has no dialog
  API, so the draft is refined by an agent (`luck_tree_set_goal`) or a later
  UI stage; per ADR-7 the draft stays out of the tree until approved. The
  dashboard item from the plan lands with F2 (it would be dead until the HTTP
  server exists).
- **Slash** — `/luck-status <leaf name or id> <status>` resolves the leaf
  (uuid passes through; otherwise FTS restricted to leaves — one hit wins,
  several demand a more specific query) and moves it via `node-set-status`;
  `/luck-bug <title>` reports an incident via the new `bug-report` RPC
  (severity `medium`). Errors are thrown as readable messages (the host
  reports a failed `onSubmit`); successes open the panel where the change is
  visible in the audit trail.
- **RPCs** — `goal-create` (draft, actor `user`, plan ≥ 1 step enforced by
  contract and store) and `bug-report` (severity defaults to `medium` both in
  the contract and the handler, `nodeIds` attach blocking leaves). Both follow
  the `{ ok, …, error }` write envelope.
- **Tests** — `tests/slash.test.ts` (13 tests: parsing, uuid detection, leaf
  resolution paths, placeholders) and `tests/rpc.test.ts` (+6: registration
  set, draft creation with the `user` audit stamp, empty-plan refusal, bug
  defaults, leaf attachment, foreign-id rejection).

### Agent injection and skill (stage D3 — `shared/settings.ts`, `server/skill.ts`)

The other half of ADR-3: every Paseo-created agent gets the bundled server, every audit row
gets a real actor, and agents get a written protocol for keeping the tree. Verified by
`tests/d3-injection.test.ts` (6), `tests/skill.test.ts` (7), the `serverName` case in
`tests/mcp-server-e2e.test.ts`, and a live acceptance run on the daemon:

- **`agent.create` before-hook** (`index.server.ts`) — registers
  `config.mcpServers["luck-planner"] = injectedMcpConfig({ serverName })` when the
  `injectIntoAgents` setting (default `true`) allows it. The entry is
  `{ type: "stdio", command, args, env, alwaysLoad: true }`: `command`/`args` come from
  `mcpServerCommand()` (the published revision-independent entry), and `env` carries
  `LUCK_PLANNER_SERVER_NAME` (the `mcpServerName` setting → `serverInfo.name` in
  `initialize`) plus `PASEO_HOME` when the daemon runs on a non-default home. The config
  **key stays `luck-planner`** — it becomes the host tool prefix
  (`luck-planner_luck_tree_*`), which `dispatchMcpTool` normalizes with
  `/^luck[-_]planner_/`. The hook logs `MCP injected: <command> <args>` into
  `paseo plugin logs luck-planner`, which is how the injection is confirmed live.
- **`agent.session_open` before-hook — the audit actor** — `agent.create` cannot carry the
  actor: the agent id does not exist yet when the create request is intercepted. The
  session-open request does (`request.agentId`) and exposes `request.env`, so the hook sets
  `LUCK_PLANNER_AGENT_ID=<agentId>`. Env semantics were verified against the installed
  daemon (`app.asar`): stdio servers spawn with
  `env: { ...process.env, ...runtimeSettings, ...launchEnv, ...config.env }` — the session
  env (`launchEnv`) is the base and the config env only adds to it. Live acceptance: all
  four audit rows of the run carry the real agent id, not `agent:unknown`.
- **Settings** — `shared/settings.ts` (`defineSettings`, host scope): `injectIntoAgents`
  (bool, default `true`) gates both hooks; `mcpServerName` (default `luck-planner`) reaches
  the bundle through `env`. Hooks read them through `settings.read()` with schema defaults
  as the fallback, so a settings race can never disable injection silently. The settings
  screen (stage E4) edits these plus the dashboard endpoint settings (stage F1, see below).
- **First-leaf bootstrap** — the acceptance exposed a hole in the D1 tool set: **no tool
  creates roots or branches**, so an empty project could not receive its first leaf.
  `luck_tree_upsert_leaf` without `parentId` now bootstraps the minimal skeleton
  `root → trunk → branch("General")` and files the leaf under it; the root takes its name
  from the last path segment of `projectKey`. The emptiness check runs inside
  `store.ensureSkeletonBranch()`'s write transaction (`BEGIN IMMEDIATE`), so two racing
  agent processes cannot both bootstrap, every skeleton node gets its `create` audit row,
  and a parentless create on a project that already has a tree comes back as a readable
  `parentId is required when the project already has a tree …` error. Asserted by two
  dispatch tests; the live run bootstrapped from `roots: []` in one call.
- **Skill (`server/skill.ts`)** — `SKILL.md` with YAML frontmatter: a *protocol*, not a
  tool list — orient-then-write (context/search first, one fact one leaf), when a leaf is
  worth creating, the status table with honest transition criteria, "revision and audit are
  automatic — never manage them by hand", bees/bugs/goals (propose only, human approves),
  growth, and the transport-failure rule ("tools briefly unavailable ≠ data gone"). The
  installer mirrors memory-flash: seven targets (`~/.agents/skills`, `.claude`, `.codex`,
  `.config/opencode`, `.qwen`, `.cline`, `.kilo`) with status/install/uninstall functions
  exposed for the E4 screen. On every plugin load `ensureSkillInstalled()` installs into
  targets whose directory **already exists** (an existing directory means that agent
  convention is active) and rewrites only when the content differs — idempotent, and each
  write is logged so `paseo plugin logs luck-planner` shows the install. Live acceptance:
  all seven directories on this machine received the skill.
- **Live acceptance (stage D3)** — a real agent created through `paseo run --provider
  kilo/…` called `luck-planner_luck_tree_get_context` (`roots: []`),
  `luck-planner_luck_tree_upsert_leaf` without `parentId` (skeleton + leaf created,
  `draft`), and `luck-planner_luck_tree_history` (actor = its own agent id), and reported
  the results. **Known provider limitation:** on **OpenCode** the session-delivered entry
  appeared in the initial catalog and then disappeared after the provider rebuilt its tool
  catalog mid-session (the memory-flash lesson, 0.8.0 + 0.8.2: for OpenCode/Kilo
  a registration in the provider's own MCP config file is strictly more reliable
  than the session-level entry);
  Cline/Cursor/Qwen Code/Codex CLI ignore session-delivered MCP servers altogether. Porting
  memory-flash's config-file registrations (`opencode`/`kilo`/`cline`/`cursor`/`codex`) is
  the candidate follow-up stage **D4** — this plugin would reuse the *approach*
  (memory-flash itself is not touched; it already ships that solution), and
  `mcpServerCommand()`/`injectedMcpConfig()` are the single source those
  writers will reuse.

### Dashboard HTTP server (stage F1 — `server/http-server.ts`, `server/http-lifecycle.ts`, `shared/api.ts`)

The 2D/3D dashboards are a separate web app (ADR-1) that this server *serves* from
`dist/dashboard` and feeds from a **read-only** JSON API. It runs inside the daemon
subprocess next to the store, so it shares the one SQLite file the native panel and the
agent MCP servers use (ADR-2).

**Endpoints** (all read-only, ADR-8):

| Endpoint | Auth | Response |
| --- | --- | --- |
| `GET /health` | none | `{ ok: true, server: "luck-planner", version }` — liveness probe |
| `GET /api/tree?project=<key>` | token | nodes + bees + bugs + `bugAttachments` + goals + growth in one graph-ready response |
| `GET /api/node/:id?project=<key>` | token | the `node-detail` RPC shape (path, children, bees, bugs, blocking bugs, history, growth) |
| `GET /api/search?project=<key>&q=&kind=&status=&limit=&includeArchived=` | token | the `tree-search` RPC shape (`matches`, `results[]`) |
| `GET /api/stats?project=<key>` | token | the `stats` RPC shape |
| `GET /api/events` | token | SSE stream: `ready` (version + watermark) on open, heartbeat comment every 15 s, `tree-changed` broadcasts, narrowed by `?project=` (stage H1) |
| everything else | none | the SPA from `dist/dashboard` (SPA fallback for extensionless paths) |

**Why the response shapes are not redefined.** `shared/api.ts` re-exports the RPC output
schemas (`nodeDetail.output`, `treeSearch.output`, `stats.output`) instead of writing new
zod objects, so the panel and the dashboard are guaranteed to read one shape; only the
composite `/api/tree` graph is new there. `tests/http-server.test.ts` parses every response
against those very schemas, which is what "JSON responses agree with the shared schemas"
means concretely. The composite response carries `bugAttachments` (the `bug_nodes` map)
because the badge layer must place each incident on every leaf it blocks without one query
per bug — `store.listBugAttachments()` reads that map in one query, next to a new
`store.listNodes({ includeArchived })` (archived nodes stay out of the graph).

**Security (ADR-9).**

- Binds `127.0.0.1` only. There is deliberately no `httpHost` setting (memory-flash needs
  one because it serves remote MCP clients; the dashboard is local-only).
- Every `/api/*` request needs the per-installation token, accepted as `?token=` (how the
  browser tab is opened) or `Authorization: Bearer` (how scripts call it). The comparison
  uses `crypto.timingSafeEqual` on equal-length buffers; the token is never logged as part
  of a request line. `GET /health` stays public.
- The API has **no write path**: a leaked token cannot mutate the tree (mutations stay on
  MCP/RPC). This is what keeps the surface small.
- Static assets are unauthenticated on purpose: they are the SPA shell (no data), and a
  browser cannot attach a query token to relative asset requests. A path is normalized,
  resolved against the dashboard root and rejected unless it stays inside it, so
  `/%2e%2e%2f…` traversal returns 404 (pinned by a raw-socket test — the global `fetch`
  would normalize the dot segments client-side).
- The constructor refuses an empty token: an unauthenticated API is never started by
  accident.

**Lifecycle (`DashboardEndpoint`).** A class, not three lines in `contribute`, for the same
reasons memory-flash 0.5.2 learned:

- **Debounced + serialized.** Settings arrive per keystroke (`8899` emits `8`, `88`, `889`,
  `8899`). A 150 ms quiet period collapses the burst into one apply, and every apply runs on
  a promise chain, so two overlapping `stop()`/`start()` pairs can never interleave and
  leave a stale listener on the old port.
- **Truthful status.** The bound port/URL come from the running socket, never from the
  settings, so a screen cannot claim a port that failed to bind.
- **Real token.** `accessToken: ""` (default) means *auto*: a random `lp_…` token is minted
  per plugin session, so the API is never exposed with a well-known value; a non-empty
  setting pins it verbatim. Changing the token restarts the listener (the running server
  holds the old one).
- **Auto-fallback.** A busy configured port logs a line and falls back to an ephemeral port
  (`status().portFallback`), instead of leaving the dashboard down.
- **Awaited shutdown.** `contribute`'s cleanup awaits `dispose()`, so the listening socket
  is really closed before the store it serves is; a leaked port would break the next plugin
  load on the same setting.

**Settings.** F1 adds `httpEnabled` (default `true`) so the socket can be closed without
uninstalling — a listening socket deserves a switch. The settings screen gained the matching
"Serve the dashboard HTTP endpoint" switch; `httpPort` (default 8899) and `accessToken`
defaults are unchanged from E4. A checkout where `dist/dashboard` was never built still
answers a truthful placeholder page instead of a blank 404 — the JSON API is already live
(the built SPA from G1 takes its place).

**Live events are wired in H1.** The MCP server runs in a *separate process* that writes the
same SQLite file, so the daemon cannot learn about a mutation from an in-process hook: it
polls the shared audit trail. F1 itself ships only the transport — the stream, the heartbeat
and `broadcast()` exist and are tested, and no mutation called them yet; §6 "Live data"
below documents what H1 added.

### "Open dashboard" (stage F2 — `client/open-dashboard.ts`, `client/dashboard-screen.tsx`)

F2 turns the F1 socket into something a user can actually reach: a **Dashboard** button in
the workspace panel and a ⌘K item, both landing in Paseo's own browser tab on Electron and
in the OS browser everywhere else (ADR-1).

**Where the address comes from.** The client cannot build the URL from the settings: the
port may have fallen back to an ephemeral one and the token is auto-generated when the
setting is empty, so only the daemon knows the live address. The new read-only RPC
`luck-planner.dashboard-status` answers exactly that (`enabled`, `listening`, `url`,
`port`, `portFallback`, `error`), and the URL is built by the pure `dashboardUrl(origin,
token, projectKey?)` in `shared/api.ts` — the same helper the server uses, so the panel and
the HTTP server can never disagree about the query shape. `?project=` carries the
workspace's `projectRootPath`, which is what makes a tab opened from workspace B show B
instead of reusing whatever tab A opened. The URL contains the token, which is the same
trust boundary as the settings screen (it shows the token too) and is never logged.

**Two entry points, one code path.**

| Entry point | How it reaches the browser |
| --- | --- |
| Panel **Dashboard** button | Calls `openDashboard(...)` directly — a workspace panel gets `navigation`, and the project key/workspace id are already at hand. |
| ⌘K **Open luck-planner dashboard** | Opens the registered screen `luck-planner-dashboard` with `projectKey`/`workspaceId` params; the screen calls the same `openDashboard(...)` on mount and keeps the address visible with an "Open again" button. |

The indirection for the ⌘K item is a **SDK constraint, not a design preference**: a Command
Center callback receives `rpc`/`openScreen`/`openPanel`/`workspace`, but **no `navigation`**
— only surfaces, panels and screens are `PluginNavigableHostProps`. bunny-search solves the
same problem by making its ⌘K item open its surface; a screen is the equivalent here, and it
doubles as the "why did nothing open?" card (disabled endpoint / port not bound / server
error / no workspace).

**Pure logic, injected openers.** `client/open-dashboard.ts` holds the whole decision and
imports nothing (no React, no SDK), following `client/slash.ts`; `tests/open-dashboard.test.ts`
pins every branch. The injection is not only a test convenience: the SDK's
`@getpaseo/plugin/client` build re-exports `openExternalUrl` from its TypeScript *source*
only, so a Node test that imported it would read `undefined`. The rules:

- `navigation.openBrowser({ url, workspaceId })` wins when the host advertises it (Electron).
- The workspace id is the caller's, else the first workspace the client knows
  (`paseo.workspaces.list()`), else there is no workspace — and without one the in-app
  browser cannot be used, so the external opener runs.
- A host whose `openBrowser` **throws** (unknown workspace) must not swallow the URL: the
  external opener runs instead. A failing workspace list is treated the same way.
- Only absolute `http`/`https` URLs are ever handed to an opener; anything else throws,
  because `openDashboardUrl` must never become a `javascript:`/`file:` navigation sink.

**Status line.** The panel renders the report text under the counters row (success colour for
`browser`/`external`, danger for `unavailable`/`error`), so a refused open says *why* instead
of failing silently.

### Dashboard web app — scaffold (stage G1 — `dashboard/`)

The 2D/3D dashboards are a standalone React + TypeScript web app (ADR-1), served by the
F1 HTTP server from `dist/dashboard` and fed by its read-only API. Stage G1 lays the
chrome — toolbar, canvas region, details panel, legend — and the build pipeline; the
diagram itself arrives in G2–G5.

**Layout** (`dashboard/src/app.tsx`): a fixed three-row grid — toolbar, body (canvas +
details panel), legend — so mounting the React Flow viewport in G2 changes nothing about
the surrounding chrome. What is already live at G1: the app parses `?token=&project=`
from the URL (stage F2 wrote them there), reads the counters from `/api/stats` through
the typed client, and surfaces every non-fatal failure as a status line in the toolbar
(a dashboard that cannot fetch says *why* instead of throwing to the console). The search
box, the kind/status filters and the 3D half of the view switch render disabled with a
hint naming the stage that wires them (G4, I4) — a scaffold that lies about its state is
worse than one that says what is coming.

**Own theming** (`dashboard/src/theme.ts`, `dashboard/src/dashboard.css`). The tab cannot
see Paseo's theme tokens, so the dashboard ships its own dark/light palette as CSS custom
properties on `:root`, resolved as *stored choice > `prefers-color-scheme` > dark* and
applied once on startup. Colours are data (`ThemeTokens`), not scattered hexes, and the
semantic diagram palette (`dashboard/src/colors.ts`: kind colours, status-bar colours,
labels and glyphs for every `shared/tree.ts` enum member) is one module shared by the
legend today and the G3 custom nodes tomorrow, so a legend swatch cannot drift from the
shape it describes. Every status is labelled in text wherever it appears — colour alone
never carries state.

**Typed API client** (`dashboard/src/api.ts`). `DashboardApi` wraps the F1 endpoints
(`tree`, `node`, `search`, `stats`, plus the public `health` probe) against one origin +
token + project key, and parses every response with the **shared** zod schemas — the same
objects the server validates with and the native panel uses, so a shape drift breaks at
the first line that touches the data instead of deep in a layout function. The origin is
the tab's own (`resolveApiOrigin`): the SPA and the API share the one loopback socket.
A rejected token becomes an actionable message ("re-open the dashboard from Paseo").

**Build** (`scripts/bundle.mjs`). The same script now produces both artifacts: the MCP
bundle and `dist/dashboard` (esbuild, `platform: browser`, ESM, `jsx: automatic`,
`process.env.NODE_ENV` pinned to `production` — without that define a browser tab dies
with `ReferenceError: process is not defined` before the first render, and the dev build
would ship). `dashboard/index.html` is copied next to the emitted
`assets/dashboard.js` + `assets/dashboard.css`; its asset URLs are root-absolute so an
SPA deep link like `/tree/leaf/123` still resolves them against the origin. `dist/` is
committed (project rule, as with the MCP bundle), and the F1 placeholder shell now only
appears when `dist/dashboard` is absent (a checkout whose build never ran).

**TypeScript boundary.** The root `tsconfig.json` excludes `dashboard/**`; the app has
its own `dashboard/tsconfig.json` with the DOM lib (the plugin client stays DOM-free by
construction). `npm run typecheck` runs both. The pure modules the vitest suite imports
(`params.ts`, `theme.ts`, `colors.ts`) touch no DOM APIs, so they typecheck under either
configuration.

### Data adapter and layout (stage G2 — `dashboard/src/graph.ts`, G2 nodes)

The `/api/tree` payload becomes a React Flow `{ nodes, edges }` graph in a
**pure** module: only `d3-hierarchy` at runtime and *type-only* React Flow
imports for the output shapes, so the vitest suite asserts the mapping,
positions and collapse policy without a DOM — the same split `shared/panel.ts`
uses for the native panel.

**Mapping.** `kind → type` one-to-one (`root`/`trunk`/`branch`/`subbranch`/
`leaf`): the `type` is what lets the tech-stack root and the trunk render a
different *shape* from the branches. Every node carries its name, kind,
status, `versionBadge` inputs, direct-child and hidden-descendant counts, and
the open-incident count (open + investigating, the same definition
`stats()` uses) for the G3 badges.

**Layout.** A layered top-down `d3.tree()` over the *visible* subtree only
(amounting to the ADR-4 "layered" choice: it reads as an org chart and
`fitView` normalizes the absolute coordinates anyway), with the node size and
both gaps in one `LAYOUT` constant that the components and the tests share.
Children are sorted by name before the layout, so the same payload yields
identical positions — required for the fixture tests and for SSE-driven
rebuilds (H1) not to make the graph dance. Forests (several roots) are laid
out under an invisible virtual root without emitting a phantom node; a node
whose `parentId` is unknown becomes a root defensively.

**Collapse.** A node in `collapsedIds` stays visible but hides its whole
subtree, and the layout is recomputed over the remainder (no gaps).
`defaultCollapsedIds` keeps the visible set within a 120-node budget,
breadth-first: a small tree opens fully expanded, a 1000-node project as its
top levels (G2 acceptance — this is what keeps the canvas responsive, because
React Flow only renders the visible set; the adapter itself rebuilds in a few
milliseconds). `toggleCollapsed` returns a new set; the app owns it in state
and the Canvas decorates node data with the callback the adapter never writes.

**Edges.** One `smoothstep` tree edge per visible non-root node; one edge per
influence bee whose *both* endpoints are visible, with the impact text and the
bee status in its payload (the G3 edge renderer styles it). No edge ever
references a hidden node — asserted over every fixture and over the synthetic.

**Viewport.** The Canvas mounts React Flow (`fitView`, `nodeTypes`,
positions layout-owned via `draggable: false`). The five kind components are
the structural shapes from G1 (pill/column/box/card with the palette colour
and the status spelled out in text); G3 replaces the visual details, keeping
component names and the data contract. Edges use the built-in renderers —
registering an empty custom edge component would silently hide every path.

**Tests** — `tests/dashboard-graph.test.ts` (15: exact fixture positions and
types, collapse semantics including hidden counts and the relayout, bees and
incidents, the forest case, the default policy, and the acceptance block: a
1045-node synthetic opens within the visible budget with every edge
referencing visible nodes, and ten rebuilds stay under a second).
`typecheck` (both configs) and the full suite are green: 24 files, 341 tests.

### Custom nodes and edges (stage G3 — `graph-nodes.tsx`, `graph-edges.tsx`, `colors.ts`)

Stage G3 fills the visual semantics on top of G2's structural shapes,
keeping component names and the `GraphNodeData` contract so the adapter and
its tests stay valid.

**Palette** (`dashboard/src/colors.ts`) gained the G3 entries, all pure data
pinned by `tests/dashboard-theme.test.ts`: `STATUS_PROGRESS` (the fraction a
leaf's status bar fills to — plan → work → done, capped at 1, monotonically
ordered along the happy path; `blocked` sits at the in-progress height and
lets its red *colour* say blocked), `GOAL_STATUS_COLORS` +
`GOAL_STATUS_LABELS`, `BEE_STATUS_COLORS` + `BEE_STATUS_LABELS`,
`BUG_BADGE_COLOR`, and `withAlpha(hex, alpha)` for softened strokes.
`paletteIsComplete()` now guards bee and goal enums too — a new enum member
without a colour/label fails the suite instead of rendering blank.

**Node rendering** (`graph-nodes.tsx`):
- a **leaf status bar** — a 5px strip filled to `STATUS_PROGRESS[status]` and
  painted `STATUS_COLORS[status]`, always next to the status *text* and the
  `v{version} · r{revision}` caption; it carries `role="img"` +
  `aria-label="Status: …"`, so colour never is the only carrier;
- an **incident badge** `🐞 ×N` on any node with open/investigating
  incidents (count in text, titles behind `title=`);
- the existing kind shapes keep their glyphs (⚙️ 🪵 📦 📂 🍃).

**Goal frames** — one dashed 🎯 rectangle per goal whose materialized
subtree has visible nodes, labelled with the formal task text and the goal
status *in text* beside the frame colour. Frames are **synthetic nodes**
(`type: "goalFrame"`, `GoalFrameData`) kept in their own `goalFrames` array
on `DashboardGraph`, never in `nodes`: the layout never sees them, the G2
node type and its tests are untouched, and `Canvas` concatenates the two
arrays on render. Geometry lives in `GOAL_FRAME` (28px padding + a 26px
label strip); the box is the bounding box of the *visible* subtree in layout
coordinates. A non-materialized goal (draft/proposed, ADR-7) or a subtree
hidden by collapse yields no frame; collapsing the frame's own root shrinks
the box to that node — the frame always describes exactly what is on
screen. Frames are `zIndex: -1`, `selectable: false`, `pointer-events: none`,
so they can never swallow a click or a canvas pan; ids are sorted by goal id
for deterministic output.

**Tree edges** keep React Flow's built-in `smoothstep` path (registering an
empty custom component would hide the path) with `style.stroke =
withAlpha(KIND_COLORS[parent.kind], 0.5)` — the stroke echoes the parent
kind without competing with the nodes.

**Bee edges** (`graph-edges.tsx`) switch from the built-in `default` type to
`type: "bee"`, routed to a custom `BeeEdge` (verified against
`@xyflow/react`'s `EdgeWrapper`: `edgeTypes?.[type] ||
builtinEdgeTypes[type]`, so unregistered types — the tree's `smoothstep` —
keep the built-ins). The renderer draws its own bezier path stroked in
`BEE_STATUS_COLORS[status]`, dashed once `resolved`/`cancelled`, animated
while `active` (the adapter's existing `animated` flag drives React Flow's
path animation), and renders a mid-path label `🐝 <Status>` through
`EdgeLabelRenderer` with `pointer-events: all` so the `title` (the impact
text) stays hoverable.

**Legend** renders the bee-status group from the same palette and explains
the two badges (`🐞` open incidents on the node, `🎯` goal subtree — the
progress layer arrived in G5).

**Bugfix found during the G3 visual acceptance** — `DashboardApi` invoked
its `fetch` as a method of itself (`this.fetchImpl(url)`). Node's fetch
ignores the receiver, so every test passed, while a real browser
(`window.fetch`) throws `TypeError: Failed to execute 'fetch' on 'Window':
Illegal invocation` — the dashboard rendered its chrome and never loaded a
single payload. Fixed by calling the implementation with an explicit global
receiver (`fetchImpl.call(globalThis, …)`), which is also how the injected
test doubles are invoked now. Regression: the "global receiver" test in
`tests/dashboard-build.test.ts` drives the client with a receiver-strict
fetch stand-in that reproduces the browser's rule in Node. Lesson recorded:
Node-side tests cannot see browser host-method receiver semantics — the
tab-level check of PLAN rule 4 must actually watch the network panel, not
only the console.

**Tests** — `tests/dashboard-graph.test.ts` extended (+7: frame geometry
against the layout, no frame without materialization, shrink-on-collapse,
ancestor-collapse dropping the frame, id sorting, `bee` edge type, tree-edge
tint), `tests/dashboard-theme.test.ts` (+4: bee/goal palette coverage,
status-bar ordering bounds, `withAlpha`), `tests/dashboard-build.test.ts`
(+1: the fetch receiver regression). Acceptance was checked **by eye in a
real browser** against a seeded fixture (root/trunk/branches/subbranch, all
leaf statuses, 3 bees of different statuses, 2 incidents, an approved goal
with a materialized side branch plus a proposed one): status colour *and*
text on every leaf, badges, frames, bee labels — console clean.
`typecheck` (both configs) and the full suite green: 24 files, 353 tests.

### Interaction (stage G4 — `graph.ts` filters + selection, `Canvas.tsx`, `DetailsPanel.tsx`, `Toolbar.tsx`)

Stage G4 turns the read-only diagram into the tool the acceptance scenario
names: *find a leaf by search and see its blockers and everything it is
connected to, without a scroll hunt.*

**Filters** (`dashboard/src/graph.ts`). The toolbar's kind/status selects
and the version-prefix input narrow the graph through a new `filter` option
of `buildGraph` — still a pure module, so the policy is unit-tested. A node
survives when it matches *or* has a matching descendant: the path to the
root stays as context, so a filtered leaf still reads as a tree instead of
floating alone. Fields AND together; the version comparison is a
case-insensitive prefix. Collapse wins over the filter — a hidden subtree is
never resurrected, and a filter whose every match is collapsed yields the
empty canvas with an honest "no nodes match the filters" state. Bee edges
follow their endpoints out of the graph, so no edge ever dangles.

**Selection** (`Canvas.tsx`). Clicking a node selects it, clicking the pane
clears it; the adapter stays out of it — the Canvas decorates the nodes with
`selected`/`bugLinked` (the same mechanism as the G2 `onToggle`). `bugLinked`
comes from the pure `relatedByOpenBug(graph, id)`: every other node sharing
an *open* incident with the selection — the blocker trail in both
directions (the same open/investigating definition the badge count uses;
`GraphNodeData.openBugIds` now carries the ids, sorted, next to the count).
Every edge touching the selection — tree and bee alike, via
`edgeTouchesNode` — is emphasized (`lp-edge-emphasis`, heavier stroke plus a
soft glow; the bee keeps its status colour).

**Camera focus** (`FocusController` inside the React Flow provider). On a
`FocusRequest` (search picks a hit, `seq` makes repeats re-trigger) the
controller centres the viewport on the node's layout box
(`graphNodeCenter`) with `setCenter`, zoom floored at 0.85 and a 400 ms
easing — the found node lands in the middle of the canvas instead of
somewhere off-screen. The reveal logic lives in the app: searching a hit
first removes its ancestors from the collapse set and clears whichever
filter excludes it (`ancestorsOf`, nearest ancestor first), so a search can
never "find" something invisible. (Empirically checked in a real browser:
centring is exact; a mid-animation window resize can leave the React Flow
store with a stale container width — the next interaction corrects it.)

**Details panel** (`DetailsPanel.tsx`, real content since G1's placeholder).
Clicking a selection fetches `GET /api/node/:id` (the `nodeDetail` RPC
shape) with a stale-guard so a late response can never overwrite a newer
selection. The panel renders: kind glyph + name, breadcrumb path, kind and
status (dot **plus text**), `v{version} · r{revision}`, last update, the
growth progress bar (`growthProgress` from `shared/growth.ts`), the
incidents with the blocking ones ringed in red and the severity/status in
text, the influence bees with the counterpart's *name* (resolved from the
loaded tree, `→`/`←` showing the direction) and the impact text, the direct
children, and the last 20 history rows (revision, action, timestamp, actor,
result). Loading, error and "nothing selected" are each their own state.

**Toolbar** (`Toolbar.tsx`). The G1 placeholders are now live: the search
box submits an FTS query against `/api/search` on Enter (it owns its own
draft — the query is not diagram state, only the picked result is), the two
selects and the version input drive the adapter filter, and the status line
reports `Found “…”` / `N matches — showing “…”` / `No matches for “…”`.

**Tests** — `tests/dashboard-graph.test.ts` extended (+10: filter
activity/AND/prefix semantics, ancestor context, the empty result, collapse
beating the filter, the cycle-safe ancestor chain, the node centre,
`relatedByOpenBug` honouring the open-only definition, `edgeTouchesNode` on
both edge layers). Acceptance walked in a real browser against the seeded
fixture: search "charges" → the leaf is selected, centred, its blocker
(`webhook signature check`, shared open incident) ringed red, both touching
edges emphasized, and the panel shows the incident, the bee to "prorate
refunds" and the history; the kind/status/version filters narrow the graph
with context and empty out with the honest message; pane click clears the
selection; console clean. `typecheck` (both configs) and the full suite
green: 24 files, 363 tests.

### Growth layer (stage G5 — `graph.ts` roll-ups, `colors.ts` heat ramp, `graph-nodes.tsx`, `Toolbar.tsx`, `app.tsx`)

Stage G5 makes the plan/fact progress visible on the diagram, without touching
the layout: **the layer is a display option and nothing else**. The acceptance
rule of the stage — "switching the layer does not break the layout" — is a
property of the code, not of the eye: the very same `buildGraph` call produces
identical positions, node types, edges and frame boxes in both layers
(pinned by a test that compares the two skeletons field by field).

**Roll-up semantics** (`shared/growth.ts` + `dashboard/src/graph.ts`). The
dashboard never walks the tree itself; it folds the `/api/tree` payload the
server already sends. `summarizeGrowth(records)` in `shared/growth.ts` is the
single arithmetic: it delegates each record to the C4 `growthProgress()` and
only sums, so the dashboard, the native panel and any future RPC compute the
same "share of completed steps" (`skipped` steps leave the denominator, only
`completed` counts). `nodeGrowthRollups()` then does one iterative post-order
pass over the tree (children before parents — the same traversal `subtreeSizes`
uses) and gives every node the merged counters of:

- its own `node`-subject growth record (this is what `hasOwn`/`ownStatus`
  report — the status text next to the bar),
- the `goal`-subject records of every goal **materialized at** that node
  (`goal.materializedNodeId`): a goal's plan steps are part of the tree from
  the moment the gate is crossed (ADR-7), so they join the roll-up exactly
  where they were grown — this is what makes the heat map cover plan progress
  and fact progress with one number, and why the goal frame's bar and the node
  bar can never disagree (the frame simply renders the roll-up of its
  materialized subtree root),
- the roll-ups of its children.

A node with no record anywhere below it is *absent* from the map: the renderer
then draws no bar and no heat, which is how **"no data" stays distinct from
"0 % done"** (`growth: null` vs a `0/N` roll-up). Growth records whose subject
is not in the payload (an archived node, a goal that never materialized) are
ignored; records of the wrong subject type can never tint a node. Roll-ups are
computed over the **full** tree, so a collapsed branch still reports the
progress of what it hides — collapse and filter change what is *shown*, never
what is *counted*.

**Heat ramp** (`dashboard/src/colors.ts`). `HEAT_RAMP` has three stops —
muted grey `#5c6470` at 0 %, the in-progress amber `#e0a84f` at 50 %, the done
green `#4fa860` at 100 % — i.e. the palette's own status vocabulary instead of
an arbitrary gradient, and `heatColor(ratio)` interpolates them in RGB with a
clamped, total domain (out-of-range or non-finite input still yields a valid
hex). The toolbar's second segmented control switches `status` ⇄ `growth`;
in the `growth` layer the adapter fills each node's `heat` with its ratio and
the node body is tinted `withAlpha(heatColor(ratio), 0.22)` while the **kind
border stays untouched** — the shape signal is never lost to the colour, and
the heat value is always accompanied by the `N/M steps` text (the same
accessibility rule the rest of the diagram follows; the tint was verified on
both the dark and the light theme). `GROWTH_STATUS_COLORS/LABELS` join the
palette guard (`paletteIsComplete()`), so a growth status added to
`shared/growth.ts` cannot silently render as a blank caption.

**Rendering** (`graph-nodes.tsx`). Any node with a roll-up gets a bar under
its status row: fill = ratio, colour = the heat ramp, text = `N/M steps` plus
either its own record's status (`· Active`, coloured) or `· subtree` (the
number is rolled up from below). Goal frames render the same bar in their
label strip (the frame box is unchanged — `GOAL_FRAME.labelHeight` still
reserves the strip), with `aria-label`/`title` spelling the percentage out.
The legend gained the heat ramp with its `growth 0 % → 100 %` wording, and the
toolbar carries the layer switch next to the 2D/3D placeholder.

**Honest empty state** (`app.tsx`). Switching to the heat layer in a project
that has no growth records at all writes a status line saying so
("`No growth records in this project yet — the heat layer stays neutral
(agents write them with luck_tree_update_growth)`") instead of letting an
all-grey tree read as "nothing done". Switching back clears only that hint.

**Tests** — `tests/dashboard-graph.test.ts` gained a `G5: growth layer` suite
(12 tests: the leaf → ancestor roll-up and its identity with
`summarizeGrowth`, "no data" vs "0 %", skipped/failed arithmetic, `hasOwn` vs
descendant-only roll-ups, two records of one subject aggregated with the
first-by-id status, foreign subject types and unknown subjects ignored, a
field-by-field layout comparison of the two layers, `heat` only in the growth
layer, the goal record rolling into its materialized node exactly once, the
goal-only and no-record frames, a collapsed branch keeping its hidden
progress, and layer-label coverage). `tests/dashboard-theme.test.ts` gained a
`G5 palettes` suite (5 tests: growth-status coverage through
`paletteIsComplete()`, ramp sortedness/hex validity, `heatColor` at the stops
with clamping and `NaN`, blend + 0 %/100 % distinguishability, and
`summarizeGrowth` arithmetic), and `tests/dashboard-build.test.ts` now asserts
the built bundle carries the layer switch (`Growth heat`, `lp-node-growthbar`).

**Acceptance** — walked in a real pane against a seeded fixture: root → trunk →
three branches, three approved goals materialized under them with exactly
0 %, 50 % and 100 % growth, one node-level record, a bee and an open incident.
Computed styles in the growth layer: the 0 % node tints `rgba(92, 100, 112,
0.22)` (grey), the 50 % one `rgba(224, 168, 79, 0.22)` (amber) and the 100 %
one `rgba(79, 168, 96, 0.22)` (green) — the three goals are distinguishable at
a glance, the goal frames' bars measure 0 %/50 %/100 % wide, nodes without
records stay neutral, and the node transforms are **byte-identical** before
and after the switch (the layout did not move). Clicking a node still fills
the G4 details panel (with its growth bar), the light theme was checked the
same way, and the console stayed clean. `typecheck` (both configs) and the full
suite green: 24 files, 382 tests.

### Live data (stage H1 — `server/change-feed.ts`, `server/store.ts`, `server/http-server.ts`, `server/http-lifecycle.ts`, `shared/api.ts`, `shared/rpc.ts`, `dashboard/src/live.ts`, `client/tree-panel.tsx`)

H1 makes both live surfaces follow the tree without a manual reload: the dashboard tab over
SSE, the native panel over RPC polling. What makes it interesting is *who writes*.

**The cross-process problem, and why the audit trail is the event bus.** The panel, the HTTP
server and any in-process watcher live in the daemon, but every agent mutation goes through
the bundled stdio **MCP server — a separate process** with its own connection to the same
SQLite file (ADR-3). A hook on `LuckPlannerStore.write` would therefore see panel-driven
mutations only and silently miss every agent write, which is precisely the acceptance
scenario of the stage ("a leaf moves by an MCP tool and both views update"). What *is* shared
across processes is the file, and B3 already guarantees that **every mutation appends exactly
one row to `history`**. So the feed polls `history.id > watermark` — an indexed read on the
primary key — and the audit trail becomes the event bus, with no new table and no schema
bump (`SCHEMA_VERSION` stays 1).

**`ChangeFeed`** (`server/change-feed.ts`) owns the cursor and the cadence:
`DEFAULT_POLL_MS = 1000` (fast enough to feel live, slow enough to stay invisible), an
`unref`'d `setInterval` so a daemon with nothing to serve can still exit, no overlap between
ticks, an immediate re-prime in `start()` so an endpoint that sat disabled for hours does not
greet a client with a burst of stale events, and self-stop after three consecutive failures —
a database that went away must end the feed, not fill the log forever. Rows are grouped **per
project**, so a burst (an approved goal materializing a subtree) costs one notification, not
one per row, and a listener that throws costs only itself: the cursor has already moved, so
the row is never resent.

**`readChangesSince`** is the cursor arithmetic, shared by the feed and the RPC: it drains in
pages of `DEFAULT_CHANGE_BATCH = 200`, honours a `maxRows` cap by returning `more: true`, and
never reports a `watermark` ahead of the rows it actually returned — a caller that adopts it
cannot skip rows it was not told about. A cursor at or ahead of the table head (a database
that was replaced) comes back as the head, so a stale client catches up instead of
livelocking on an id that will never arrive.

**The wire.** `GET /api/events` opens with

```text
retry: 3000

event: ready
data: {"version":"0.25.0","watermark":128}

event: tree-changed
data: {"projectKey":"/abs/path","watermark":131,"changes":[ …history rows… ]}
```

`ready` now carries the version and the cursor the stream resumes from, so a reopening tab can
tell a reconnect from a first connect. A stream may narrow itself with `?project=`; the server
remembers it and `broadcast(event, data, projectKey?)` only wakes the tabs that care — one
daemon hosts several workspaces, and a tab open on project A must not refetch because B moved.
`changes` carries the very same `historyEntrySchema` rows `/api/node/:id` returns, so "what
happened" has one shape whether it is read live or read from the trail.

**Dashboard client** (`dashboard/src/live.ts`) is a pure module over an injected
`SseSourceFactory` — the app passes the browser's `EventSource`, tests pass a stand-in, and a
host without `EventSource` gets a visible `offline` indicator instead of a blank page. Three
behaviours are deliberate: a short burst is **coalesced** into one callback (one refetch per
action, not per row); **any** `tree-changed` frame triggers the refetch even when its payload
does not parse (a tab left open across a plugin update must self-heal its *data*, even when it
cannot read the details, and the payload is only used to decide whether the open details panel
needs a refresh); and a **reconnect** refetches, because events sent while the stream was down
are gone for good. `DashboardApi.eventsUrl()` builds the stream URL with the token in the
query — `EventSource` cannot set headers (ADR-8).

**Native panel** (`client/tree-panel.tsx`). The SDK has no server→client push: `server.handle`
is request/response, and the lifecycle hooks are about agents and workspaces. So the panel
polls an RPC twin of the event, `luck-planner.tree-changes`, and the module `shared/rpc.ts`
carries the protocol with it: the first call omits `sinceId` and only reads the cursor
(opening a panel must never replay the trail), every later call passes the previous
`watermark` back and answers the delta, filtered to the caller's project (ADR-2) even though
the cursor is global. `PANEL_CHANGE_POLL_MS = 2000`; a non-empty delta reloads the outline and
refreshes an open details panel. The cursor lives in a ref (it drives no rendering; as state
it would restart the timer every tick) while a small boolean gates the toolbar's
`live`/`connecting` word. TanStack Query named in `PLAN.md` turned out to be unnecessary — the
panel has no query cache to invalidate, and a single watermark poll is less machinery than a
client library the panel does not otherwise use.

**One rule, two consumers.** `changesTouchNode(changes, nodeId)` in `shared/api.ts` decides
whether a batch makes a node view stale: a `node` row counts only when it *is* the open node,
while any other entity (bee, bug, goal, growth) always counts, because those are *linked* to
nodes and can change what a node view shows. The dashboard tab and the panel call the same
function, so the two views cannot drift apart.

**Cost, honestly stated.** One indexed `SELECT` per second per plugin install, and a
worst-case latency of one poll interval between a write and a refresh. Both were chosen over
the alternatives (a DB trigger writing to a side channel, or `PRAGMA data_version` as a
cheaper gate) because they keep the mechanism comprehensible and testable end to end.

**Tests.** `tests/change-feed.test.ts` (13) drives the cursor arithmetic, the grouping, the
re-prime and the failure stop, and proves the acceptance case by writing through a **second
`LuckPlannerStore` on the same file** — the agent-process model, with no MCP spawn needed.
`tests/http-lifecycle.test.ts` adds the same write over a real socket (an open SSE stream
receives `tree-changed`, and a stream opened for another project does not);
`tests/http-server.test.ts` covers the `ready` cursor and the per-project narrowing;
`tests/dashboard-live.test.ts` (10) covers decoding, merging, coalescing, close, the
no-`EventSource` degradation and `changesTouchNode`; `tests/rpc.test.ts` covers the panel's
priming and delta calls; `tests/dashboard-build.test.ts` proves the built bundle carries
`/api/events`, `tree-changed` and the `lp-live` indicator. `typecheck` (both configs) and the
full suite are green: 26 files, 411 tests. The live-daemon walk-through with a real MCP tool
call and a real browser tab belongs to J2.


### Agent timeline rows (stage H2 — `shared/timeline.ts`, `server/timeline.ts`, `client/timeline-row.tsx`, `index.server.ts`, `index.client.tsx`)

Two audit facts get a row in an agent's own timeline, appended with
`paseo.agents.ref(id).timeline.append` and drawn by a plugin renderer: `goal-approved` and
`leaf-done`.

**Trigger: the same journal as H1, with its own feed.** Agents write through the bundled MCP
server — a different process — so the only change log both processes share is the `history`
table, exactly as in H1. `index.server.ts` therefore owns a *second* `ChangeFeed` with its own
watermark, and the difference from the dashboard's feed is deliberate: that one is armed only
while a socket listens and re-primes on start, skipping rows written while it slept, because a
connecting tab refetches everything — a timeline row has no refetch and must appear with
`httpEnabled: false`. Two readers over one table cost one extra indexed `SELECT` per second;
independent cursors are what make both behaviours true.

**Which agent: the acting agent, otherwise the last agent on the same entity.** The audit
actor is free text (`LUCK_PLANNER_AGENT_ID` unless a tool call passes its own `actor`, and
`user` for panel actions), so `agentCandidates` offers the row's actor first and then — newest
first — every distinct non-`user` actor from that entity's earlier rows, capped at eight. That
is how an approval reaches the agent that proposed the goal (the gate itself is crossed by a
human, or by an orchestrating agent), and how a panel-driven `done` still reaches the agent
that last worked on the leaf. Each candidate is verified against the daemon
(`paseo.agents.ref(id).refresh()`, wrapped so both `null` and a rejection mean "not an agent"),
and a fact with no live agent is skipped with one log line: an agent timeline is daemon-local
memory that does not survive a restart, so there is nothing to queue for later.

**SDK handle: captured from the first context that arrives.** `contribute(server)` receives no
`paseo`; hooks and RPC handlers do. Both `before` hooks call `rememberPaseo`, and RPC
registration goes through a local `handle` wrapper instead of `server.handle`, so a panel that
approves a goal with no agent session ever opened still arms the feed — in the same call that
writes the fact. Until a context arrives the feed keeps its cursor and logs the skip.

**Payload.** `shared/timeline.ts` is the single source for `kind` (`luck-planner-event`),
`version` (1) and `timelineDataSchema`; `buildTimelineItem` clamps every field in UTF-8 bytes.
The arithmetic: JSON escaping expands one character to at most six bytes, so
(2048 name + 1024 projectKey + 512 note + 256 actor + 128 entityId) × 6 ≈ 24 KiB — less than
half the SDK's 64 KiB rejection limit — and `timelineDataBytes` measures the finished JSON in
tests against NUL- and surrogate-heavy input. The row id is `lp-<event>-<entityId>-r<revision>`:
re-appending the same transition replaces the row instead of duplicating it, while a later
transition becomes a new row. The row's view-model (`timelineRowText`) lives in `shared/` as
well, because vitest cannot load the Flow-typed `react-native` package — the same reason
`shared/panel.ts` holds the panel's labels.

**Renderer.** `client/timeline-row.tsx` draws `🎯 Goal approved: <name>` /
`✅ Leaf done: <name>` plus `YYYY-MM-DD HH:MM · by <actor> · <note>` from `theme.colors`,
`layout.compact` and `useHostFontScale`, React Native primitives only (the DOM grep over
`client/` stays empty), with the event spelled out so colour is never the only signal.
`index.client.tsx` registers it with the shared constants and schema — that pairing is what
keeps the host from rendering "Plugin timeline item unavailable".

**Tests.** `tests/timeline.test.ts` (36) covers the classifier and `rowFor`, the clamps and the
64 KiB measurement, candidate ordering / deduplication / cap, and `notifyTimelineChange`
against a file-backed store — including "a human approved a goal → the proposing agent gets
the row", "no agent anywhere → quiet skip", a rejected append (logged, the batch continues) and
a missing handle. The wiring tests run the *production* feed inside `contribute`: a write
through a second connection to the same file (the agent-process model) arrives as a row, the
handle is remembered from a plain RPC call, and cleanup stops the polling. Two pre-existing
fake servers now pass a handler context (`{ paseo: undefined }`) — what the SDK always hands a
handler. `typecheck` (both configs) and the full suite are green: 27 files, 447 tests. The
live-daemon check — the row visible in an agent's timeline with no "unavailable" placeholder —
belongs to J2.

### The tree grows upwards (the 2D flip, 0.30.1)

A tree read left-to-right — the root at the far left, the leaves at the far
right — is not how a human reads a tree. The depth axis became the vertical
one and was inverted: the deepest level sits at the top (`y = 0`) and the root
at the bottom, the trunk rising and the branches fanning out above it. One
line in the adapter (`{ x: d.x, y: maxY - d.y }`), and the node components —
which had *always* drawn their handles `Position.Top` / `Position.Bottom` for
exactly this direction — finally point at each other instead of into empty
space.

The layout tests were rewritten for the new convention (the root is the
lowest node of the diagram, the deepest leaves the highest) and the live
dashboard confirmed it: the root at `y = 487`, the trunk at `424`, the branch
at `362`, the leaves at `237…300` — the tree grows up.

### The details panel is resizable (0.32.0)

The panel was a fixed 300 px column, and it showed: the node names and the
history rows were cut mid-word ("Draf t"), and a branch with a long name
("Client panel, settings and host typography") was truncated to nothing
useful. It is **1.5× that (450 px) by default and draggable** — the user
pulls its left edge, the canvas takes the rest, and the width survives a
reload (the same localStorage pattern the theme uses). A double-click on the
edge restores the default; the bounds are 280…720 px.

Two details make the drag behave: the pointer events are **pointer** events
(a touch or a pen drags the same way), and the move/release listeners live
on the **window** — the pointer leaves the seven-pixel edge long before the
user stops moving, and the drag must survive that. The rules (the clamp, the
stored value, the default) live in `dashboard/src/details-width.ts`, pure
over an injected storage, so they are tested without a DOM.

The status of a child row also stopped being squeezed into a broken word
(`flex: none` on the status, `min-width: 0` on the name).

### The growth schema tolerates a rewriting MCP client (0.32.0)

The live test pass found that the Kilo MCP client **rewrites an array that
lives inside a schema-free object**: `steps[].facts` arrived as
`{"item": [...]}` — and an empty array as `""` — so zod rejected the whole
call with "expected array, received object". The data was not damaged, only
the shape it arrived in. The shared schema now normalizes the shape *before*
the validation (`lenientStringArraySchema`): an object with an `item` array
yields that array, a string yields the array of its lines, and anything else
is still rejected. It lives in the shared contract, so the MCP path, the
HTTP API and the store all benefit at once.

### Agent config registrations (stage D4 — `server/agent-mcp-config.ts`, `shared/rpc.ts`, `index.server.ts`, `client/settings-screen.tsx`)

Paseo injects the plugin's MCP server into an agent through the `agent.create`
hook, i.e. it lands in the **session** payload. Two provider behaviours make
that fragile, and stage D4 answers both by registering the server in the
agents' *own* config files:

- **OpenCode and Kilo** keep their session registrations in memory, per
  directory ("location services"), and evict an idle location — which takes
  the server and all its tools with it. Paseo re-registers only while a
  session is being created, so a long-lived agent loses every `luck-planner_*`
  tool for the rest of its life while the MCP server itself is healthy. A
  server that lives in the agent's *config file* is not affected: the config
  is re-read every time a location boots, so the tools come back by
  themselves.
- **Cline, Cursor, Qwen Code and Codex CLI** are terminal agents that do not connect
  stdio MCP servers delivered through an orchestrator's session at all — for
  them a config-file entry is the only way in.

There is a second, subtler effect, measured on OpenCode (the memory-flash
lesson): after an eviction the *dead* session entry still owns the server's
name in the session, so it shadows the healthy config-file server and every
call fails. So **when a config file already carries a current registration,
the session-level injection is skipped** — the config entry wins on every
dimension: it survives eviction, reconnects at every location boot, and
reaches the sessions Paseo never touches. The injection stays the fallback
for machines whose config file was never (or can no longer) be written, and
the skip is logged (`agent.create injection skipped for <provider>`) so the
behaviour is visible in `paseo plugin logs luck-planner`.

**The formats.** One writer per family, because the shapes differ:

| Agent | File | Entry |
| ----- | ---- | ----- |
| OpenCode | `~/.config/opencode/opencode.json` (or `.jsonc`) | `mcp: { luck-planner: { type: "local", command: [node, entry], enabled: true, timeout: 15000 } }` |
| Kilo | `~/.config/kilo/kilo.jsonc` (or `.json`) | the same `mcp:` shape |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | `mcpServers: { luck-planner: { transport: { type: "stdio", command, args } } }` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers: { luck-planner: { command, args } }` |
| Qwen Code | `~/.qwen/settings.json` | `mcpServers: { luck-planner: { command, args, timeout: 15000, trust: true } }` |
| Codex CLI | `~/.codex/config.toml` | the `[mcp_servers.luck-planner]` table with `command` and `args` |

**The rules the writers follow**, in every format:

- **Explicit, per agent.** The plugin never writes these files by itself:
  they change the behaviour of *every* session of that agent on the machine,
  so it is a button in the settings screen — one per target and one pair for
  all of them. A config that does not parse as plain JSON (a `//` comment, a
  syntax error) is **reported, not overwritten**: losing a hand-written
  comment is worse than not registering.
- **Foreign content is preserved.** Only the plugin's own entry is added,
  replaced or removed; every other key, server, table and comment stays — in
  the TOML file byte for byte, because only our table is spliced.
- **Atomic writes.** Temp file plus rename, so a reader never sees a
  half-written config, and the file's mode is kept.
- **The paths are computed per call**, never at import time, so they follow
  the environment (and a test can point them at a temporary home).

**Tests.** `tests/agent-mcp-config.test.ts` (26) points `HOME` and
`XDG_CONFIG_HOME` at a temporary directory — the machine's real agent configs
are never touched — and pins the six formats, the preservation of foreign
keys, servers, tables and comments through a registration *and* a removal,
the refusal to overwrite a file that does not parse, the idempotence of a
second registration (and exactly one table of ours in the TOML file), the
truthful status (registered / registered with an older command / not
registered / agent not installed here), the atomic write (no staging file
left, the mode kept) and the paths themselves (XDG for OpenCode and Kilo, the
home directory for Cline, Cursor, Qwen Code and Codex). `tests/rpc.test.ts` pins the
three new contracts on the RPC surface.

### WebGL spike and the lazy 3D entry (stage I1 — `dashboard/src/webgl.ts`, `dashboard/src/dashboard-3d.tsx`, `dashboard/src/components/ThreeView.tsx`, `scripts/bundle.mjs`)

Block I opens with the spike that de-risks the 3D tree: prove a tab can obtain a
WebGL context, pin the fallback answer, fix the library stack — and do all of it
without touching the first-chunk budget.

**Stack (fixed here, per PLAN.md I1).** `three` + `@react-three/fiber` (the React
reconciler for three) + `@react-three/drei` (OrbitControls and helpers), pinned
to exact versions in `package.json`; the radial tree layout in I2 keeps using
`d3-hierarchy`, the same adapter the 2D diagram already uses, so both views
share one layout model. Rebuilding I2/I3 on a different stack would require
re-opening this decision.

**One React, two entries.** The dashboard build switched to esbuild
`splitting: true` with two entries: `dashboard` (what `index.html` loads
eagerly) and `dashboard-3d` (the scene). esbuild hoists the modules both
graphs share into `chunk-*.js` files, so `react` and the jsx-runtime exist
exactly once per page — two copies of React break every hook (the "Invalid
hook call" failure). The tests pin the outcome: `dashboard.js` contains
exactly one `import("./dashboard-3d.js")` and no
`OrbitControls`/`gridHelper`/`WebGLRenderer` marker, while
`dashboard-3d.js` (≈2.1 MB unminified — the repo does not minify committed
bundles, reviewability over bytes) carries three/r3f/drei and is fetched only
when the toolbar's 3D button is pressed. `index.html` never links it. The
shared react chunk (~26 KB) is the entire first-chunk cost of splitting.

**Probe and fallback.** `detectWebGL()` asks for `webgl2`, then `webgl`, then
`experimental-webgl`, releases the probe context through `WEBGL_lose_context`
(browsers cap live contexts — Chrome caps at 16) and never throws: no canvas,
all-null contexts and a throwing `getContext` (blocked driver, tainted origin)
all answer `{ ok: false, reason }`. The canvas factory is injectable — the
same injected-boundary discipline as `dashboard/src/live.ts` — so vitest
exercises every browser outcome in a DOM-less environment.
`planViewSwitch()` is the one policy point: asking for 3D without WebGL keeps
the 2D diagram and installs `WEBGL_UNAVAILABLE_HINT` in the status line (the
`--disable-webgl` acceptance), and returning to 2D is always silent.

**Mounting.** `dashboard-3d.tsx` exports an imperative
`mountScene3D(container, onError?) → { dispose() }` instead of a global: the
caller owns the container, `dispose()` is idempotent, unmounts the scene's
React root and empties the cell, so switching back to 2D leaves no renderer,
animation loop or canvas behind. The root is a plain **ReactDOM** root around
r3f's `<Canvas>` — *not* r3f's own `createRoot(container)`, which is a
different API: it expects a **canvas** element and hands it straight to
`new WebGLRenderer`, while `<Canvas>` is the component that creates the canvas,
measures its parent (`react-use-measure`) and keeps the renderer in step with
resizes. Passing the container div to r3f's `createRoot` looked plausible and
died on the first frame with "canvas.getContext is not a function" — a real bug
that shipped with I1 and survived I2, because neither stage had ever run in a
browser; stage I3's live check (below) found it. `onError` plus a small error
boundary around the canvas turn a renderer failure that happens *after* the
probe passed (a lost context, a driver that evicts one) into the same status
line and 2D fallback the probe's own `false` answer produces, instead of an
uncaught React error over a dead cell. The spike scene is ambient + directional
light, a 20-unit grid, axes and `OrbitControls` — enough to answer "does WebGL
render in this tab". `ThreeView.tsx` is the only thing the first chunk knows
about the scene: it imports the *type* only (a value import would drag the
whole scene graph into the eager bundle), dynamically imports the chunk on
mount, and reports `loading → ready` / `failed` through the app's status line;
`failed` sends the tab back to 2D.

**Tests.** `tests/dashboard-3d.test.ts` (18): the probe against fakes (WebGL2,
WebGL1 floor, experimental floor, no context, no canvas, throwing factory,
context release), the view policy (the `--disable-webgl` case refuses 3D with
a written reason), the built artifacts (the 3D chunk exists, exactly one
dynamic import reaches it, no three markers leak into the eager chunk,
`index.html` never links it) and the source contracts (type-only import, the
`mountScene3D`/dispose pair, every 3D request routed through
`planViewSwitch`). The determinism test in `tests/dashboard-build.test.ts`
now hashes the 3D chunk as well. `typecheck` (both configs) and the full
suite are green. Rendering in a real tab — the Paseo workspace browser
(Electron) and an external browser — was deferred to the J2 checklist; the
live check performed during I3 (see its section) opened the tab against a real
server and is what found the `createRoot(div)` bug this section now describes.

### The 3D tree — layout and geometry (stage I2 — `dashboard/src/tree-3d.ts`, `dashboard/src/dashboard-3d.tsx`, `dashboard/src/components/ThreeView.tsx`, `dashboard/src/app.tsx`)

The spike becomes a tree. The same payload the 2D diagram renders is
projected into a radial cone, and the scene draws it as spheres, tubes and
instanced sprites — the acceptance ("readable as a tree without a click",
"5–10k nodes stay smooth") is a property of the layout, not of the camera.

**The layout is a pure module.** `dashboard/src/tree-3d.ts` has no three.js
and no DOM: it sits in the eagerly loaded chunk next to `graph.ts` and reuses
that adapter's deterministic `indexTree` (roots + name-sorted children +
dangling-parent defence), then runs d3-hierarchy's `tree().nodeSize([1,
levelHeight])` over a synthetic forest root. Projection: **depth becomes
height** (the deepest facts rest on the ground grid), the sibling axis
becomes the **angle** around the trunk axis, normalised over the widest
spread so a narrow tree fans out and a wide one wraps the full circle, and
rings grow with depth — the silhouette is a measurable cone with the tech
stack at its apex. `subtreeLeafCounts` is an iterative post-pass, and a
branch's tube radius is `clamp(tubeMin, √leaves·0.055, tubeMax)` — square-
root scaling means four times the leaves read as twice the thickness, and a
single-leaf twig sits on the thinnest tube by construction. The synthetic
forest root is dropped again on emit: the apex nodes (no real parent — an
orphaned `parentId` included) carry `isRoot` and render as spheres, so even a
stray trunk in a pruned payload draws instead of vanishing.

**The scene renders, never decides.** `dashboard-3d.tsx` keeps the I1 spike
scene as the base state (`setModel(null)` — the tree still loading — shows
lights, grid and orbit controls, never a black viewport). With a model,
`TreeScene` sizes the grid to the model's radius, `CameraFit` lands the
camera once, when the model *arrives* (a refetch must not fight the hand on
the mouse), apex nodes become `sphereGeometry` meshes tinted by
`KIND_COLORS`, every edge becomes a cylinder oriented by a quaternion along
its segment (exactly as long as the gap — no z-fighting), and **all leaves
are one `InstancedMesh`**: per-instance translation + `STATUS_COLORS` tint
set once per model, then a per-frame `compose` with the camera quaternion so
the quads billboard — one draw call and a sub-millisecond loop at the 10k
budget. The palette is imported from the same `colors.ts` the 2D legend
renders, so the two views can never drift apart. Tube count equals internal-
node count (hundreds in real projects; the leaves are the instanced bulk) —
LOD for tubes is explicitly deferred to the I3–I4 measurement pass.

**The data path.** `app.tsx` builds the model with `buildScene3D(tree.nodes, { filter })`
in a memo keyed on the tree and the toolbar filters (the collapse state stays
a 2D-canvas concern) and hands it to `ThreeView`, which forwards it through
`handle.setModel`
— seeded once when the lazy chunk lands, then on every layout change,
without ever remounting the renderer. `mountScene3D` gained a tiny external
store (`useSyncExternalStore`) behind that setter; `dispose()` is unchanged:
idempotent, unmounts the scene's root, empties the cell.

**Tests.** `tests/dashboard-tree-3d.test.ts` (13) builds fixtures through a
real `LuckPlannerStore` (root→trunk→branch→leaf, seven leaves across three
branches): the apex/level/ring arithmetic, the sibling fan (shared ring,
distinct angles, leaves resting on the ground), one tube per non-root node
with exact endpoints, thickness strictly ordered by subtree leaf count
(4 > 3 > 2 > 1 = floor), the sphere/sprite subsets with their statuses,
purity (two builds are identical), degenerate payloads (empty project, lone
root, an orphaned `parentId` the store itself refuses to create — built as
the hand-crafted payload a pruned response can be), `tubeRadius` clamps and
its √-scaling, `subtreeLeafCounts`, and the budget: 10 000 synthetic nodes
lay out in ~90 ms (asserted under 500 ms) with 9 999 edges and 6 000+
sprites in a single instance. The bundle markers in
`tests/dashboard-3d.test.ts` pin the split: layout symbols live in the app
graph (main + the shared chunk the browser fetches anyway — the scene
value-imports `LAYOUT_3D`, so esbuild hoists the module), while
`instancedMesh`/`setMatrixAt`/`setColorAt`/`sphereGeometry`/
`cylinderGeometry` exist only behind the dynamic import, and the lazy file
contains no layout function at all. `typecheck` (both configs) and the full
suite are green. FPS and the 5–10k render measurements belong to J2.


### Bees, bugs, goals and growth in 3D (stage I3 — `dashboard/src/overlay-3d.ts`, `dashboard/src/dashboard-3d.tsx`, `dashboard/src/app.tsx`, `dashboard/src/components/ThreeView.tsx`, `dashboard/src/graph.ts`)

The tree gets its domain layers. Everything that is *attached* to the nodes —
influence links, blocking incidents, approved goals, growth progress — is drawn
in its own shape, from its own rows, with its own tooltip; the acceptance is
"each link type distinguishable by eye" and "the animation does not degrade FPS
at 1000 nodes".

**One pure module, four projections.** `dashboard/src/overlay-3d.ts` is
three-free and DOM-free, so it lives in the eagerly loaded chunk beside
`graph.ts` (the bundle test pins that split) and is testable in plain Node: the
scene renders its arrays and never computes a position, a phase or a ratio —
the I2 boundary, one layer up. It is a pure function of one `/api/tree` payload
plus the I2 layout (`buildScene3D`), and it drops rather than draws anything
whose anchor is missing from the layout (a link to a leaf that left a pruned
payload, an attachment to an unknown node, a goal that never materialized) —
the overlay describes what is on screen, never a phantom at the origin.

- **Bees — curved arcs.** Every influence link becomes a quadratic Bézier from
  one leaf's position to the other's. The *arc* is the point: the tree itself
  is straight tubes, so a curved flight path reads as a relation rather than a
  branch. The control point sits above the chord's midpoint by a lift
  proportional to the chord (clamped between `beeMinLift` and `beeMaxLift`),
  pushed slightly outward from the trunk axis so arcs bow around the tree, and
  bees that share a pair of leaves take successive **lanes** — the lane key is
  the *canonical* pair (`source|target`, sorted), so A→B and B→A are one pair
  with two lanes and their arcs cannot overlap.
- **Bugs — pulsing markers.** One marker per *blocking* incident (`open` +
  `investigating`) per attached node, floating `bugLift` above it. The
  definition of "blocking" is not re-derived here: `graph.ts` exported its
  `openBugIdsByNode` (which `buildGraph` had as a private helper) so the 3D view
  reads the same rule the 2D badge and `store.stats()` use. One incident pulses
  in one phase (`hashUnit(bug.id)`) on all the leaves it blocks, so one problem
  reads as one problem.
- **Goals — floating rings.** For a goal that materialized (ADR-7), the
  subtree's nodes are walked (cycle-safe) into a bounding box: the ring centres
  on the box in x/z, floats above the *highest node of that subtree*, and its
  radius is half the box diagonal plus a margin (floored, so a one-node goal
  still gets a readable ring). The ring carries the roll-up of the materialized
  root — the same number the 2D goal frame and the node heat use.
- **Growth — glow halos.** One additive-blended ring per node whose subtree has
  growth data, scaled and tinted by the shared heat ramp; a node with no data
  anywhere below it gets **no** halo, keeping "no data" distinct from "0 %
  done". Whether the halos exist is the toolbar's layer switch — the one place
  that decides growth is on screen (the G5 rule), which 3D follows instead of
  inventing a second switch; bees, bugs and goals are links, not a layer, so
  they are always drawn, as in 2D.

**One computation, two views.** The growth roll-up was extracted from
`buildGraph` into `graph.ts#growthRollups(input)` and is now imported by both
the 2D adapter and the 3D overlay, so the two views cannot disagree about "how
much of this subtree is done"; the overlay test asserts the equality instead of
trusting it (same node set, same ratios, same goal progress and node counts as
the 2D frames).

**Animation is a pure function of time, and it is O(links).** The frame math
lives in the same module — `beeProgress` (cycle position) and `beeArcPoint`
(quadratic Bézier into a caller-owned out-vector, allocation-free, the reason a
swarm does not become 60 fps of garbage) per bee, `bugPulseScale` per bug,
`growthGlow` (one breathing opacity for the whole growth layer) and `haloScale`
(baked into the instance matrices at build time). Every phase comes from
`hashUnit(id)` — FNV-1a, never `Math.random()` — so the H1 SSE refetches do not
reshuffle the swarm and a fixture test can pin an animation. Consequently
nothing per frame walks the node list: bees and bug markers are one
`InstancedMesh` each, growth halos one more (positioned once, only the shared
material's opacity moves), goal rings individual meshes because goals are few
by nature. The I3 budget test builds a 10k-node payload with 200 bees, 50
incidents and 1000 growth records and measures both the build and 60 frames of
that pure math; a source contract asserts the scene never reads `model.nodes`.

**Hovering, and the tooltip.** The scene owns one hover state and mounts exactly
one drei `<Html>` while something is hovered — the content of the tooltip is
text from the pure module (`beeTipText`, `bugTipText`, `goalTipText`, all
tested), so "status and revision in the tooltip" is a contract, not markup. A
hovered bee **freezes** at its current arc fraction: a tooltip that drifts away
from the pointer is unreadable, and the frozen particle is an honest marker of
which link is described. The big instanced meshes (leaf sprites, halos) set
`raycast={() => null}` so a pointer move does not re-test 10k instances for a
hit nobody can act on — I4, which makes nodes clickable, has to revisit that
deliberately.

**The data path.** `app.tsx` builds the overlay in a memo keyed on the tree
*and* the layer (the layer is part of the overlay, since it decides the halos)
and hands it to `ThreeView` together with the layout; the handle's
`setModel(...)` became `setScene(model, overlay)` because a model and the links
on it are one view of one payload — two setters could render an overlay against
a previous tree. Remounts are still impossible: the store behind
`useSyncExternalStore` just carries the pair.

**Tests.** `tests/dashboard-overlay-3d.test.ts` (22) builds its fixtures through
a real `LuckPlannerStore` (two bees on one leaf pair in opposite directions, one
on another pair, a blocking incident on two leaves, a resolved one, an approved
goal with its own growth record, a 2/3 growth record on a branch) and pins:
arc endpoints equal to the layout positions with the apex above the chord, lanes
exactly `beeLaneSpacing` apart, a bee to a missing leaf dropped; the animation
(`beeProgress` in `[0, 1)`, starting from the bee's own phase, periodic, and
`beeArcPoint` exact at u = 0/1, above both endpoints in the middle, writing into
the given vector); markers only for blocking incidents, lifted, phase-shared per
incident, pulsing inside the amplitude window with the right period; the goal
ring's centre, radius, `nodeCount` and roll-up agreeing with the 2D frame; the
growth halos matching the 2D heat map node-for-node and ratio-for-ratio
(including the parent roll-up and the dark leaf); determinism of two builds, the
empty project, `hashUnit` and `truncate`; and the frame budget (10k nodes: the
overlay build under 500 ms, 60 frames of animation under 300 ms). The bundle
markers in `tests/dashboard-3d.test.ts` pin the split (`buildSceneOverlay` and
the frame math in the app graph, no overlay *builder* in the lazy chunk, the
four shapes and `Html` only behind the dynamic import) plus two source
contracts: the loader type-imports the overlay and calls `setScene`, and the
scene never touches `model.nodes`.

**The first live check, and the bug it found.** Every stage of block I had been
verified against built artifacts and pure modules — there was no browser in the
harness, and repo rule 4 keeps tab-level checks manual. Stage I3 was the first
to run in one: the Paseo workspace browser (Electron 44 / Chromium 152, driven
through the app's browser-automation host) was pointed at a **real** server —
`DashboardHttpServer` over a seeded `LuckPlannerStore` on an ephemeral port,
token in the query — and driven through the tab's own toolbar, not a stand-in.
Two things came out of it. First, the 2D dashboard renders a real payload (its
stats, filters and live badge come from the seeded store), so the HTTP server,
the token, the SSE channel and the app shell work end to end outside vitest.
Second, and the reason the check was worth the detour: pressing **3D** never
showed a scene. The probe answered `true`, the lazy chunk loaded, and the mount
threw `canvas.getContext is not a function` — r3f's `createRoot` had been
handed the container `div` since I1. The fix is the ReactDOM-root mount
described in the I1 section, now with the `onError` path it needed; after it the
tab mounts a canvas, the status line reads `live`, and a scripted
`document.createElement("canvas").getContext("webgl2")` in the same tab
confirms a real context. What the check could *not* do: the automation host
opens tabs in the background and never paints them, so `screenshot` answered
"not painted" — the shapes' legibility, the FPS figures on a live 5–10k tree,
the tooltip's look and the same walk in an external browser (plus the
`--disable-webgl` fallback line) stay on the J2 manual checklist.

**A flaky suite, fixed at the root.** `tests/dashboard-build.test.ts` and
`tests/mcp-server-e2e.test.ts` used to verify build determinism by *rebuilding*
the shared `dist/` while sibling test files (run in parallel by vitest) read
`dist/dashboard/assets/chunk-*.js`; the chunk sweep would briefly unlink files
under a reader, which reproduced as a random failure in the I2 marker test.
`scripts/bundle.mjs` now accepts `--outdir <dir>` (the install/`pretest` default
is unchanged), both determinism tests build into temp roots, and they compare
the committed artifact with a fresh build — the file set included, so a stale
`chunk-*.js` can no longer hide in the repository. Four consecutive full-suite
runs are green afterwards.

### Interaction in 3D, and the remembered 2D/3D choice (stage I4 — `dashboard/src/pick-3d.ts`, `dashboard/src/view-state.ts`, `dashboard/src/dashboard-3d.tsx`, `dashboard/src/components/ThreeView.tsx`, `dashboard/src/app.tsx`, `dashboard/src/tree-3d.ts`, `dashboard/src/graph.ts`)

The 3D view stops being a picture. A click selects a node and fills the
*same* details panel the 2D diagram fills, the selection shows what the node
is connected to, the search flies the camera to the node it found, the
toolbar filters narrow the 3D tree by the same rule the 2D diagram uses, and
the 2D/3D choice survives a reload.

**The decisions are pure, the scene draws them.** `dashboard/src/pick-3d.ts`
holds everything the interaction *decides*: which node a ray hits
(`pickNode` — a ray/sphere test, nearest hit wins), what the selection
highlights (`selectionHighlight` — the nodes sharing a blocking incident, the
bees of the node, the tubes touching it), and where the camera flies
(`focusTarget`). The scene receives one `SceneInteraction` object and renders
it: the ring, the label, the highlighted links, the ray. The scene never
looks a node up by id — that stays in the app, the only place that knows the
tree. The module sits in the eager chunk next to `graph.ts` and `tree-3d.ts`,
so the decisions are testable in plain Node and the lazy chunk carries only
the drawing.

**Why the picking is ours and not three.js'.** r3f raycasts every
interactive object on every pointer *move*, and the 10 000-instance leaf
mesh is deliberately not interactive (`raycast={() => null}` — the I3 rule).
One click therefore costs one ray/sphere test over a flat candidate list:
exact, cheap, and predictable. The candidates (`pickCandidates`) carry a
radius by *kind* — the sprite's half-edge for a leaf, the sphere's radius
for an apex, a small "joint" around the point where an inner node's children
hang. A drag is an orbit, not a click: the pointer's travel decides, so the
user can spin the tree without clearing the selection, and a click on empty
space clears it (the 2D canvas' pane click).

**The highlight mirrors the 2D canvas, item by item.** The 2D decorates the
selected node, the nodes sharing an open incident with it (`relatedByOpenBug`)
and every edge touching it (`edgeTouchesNode`). The 3D highlight is the same
three sets, computed from the same overlay the scene draws: the selected leaf
and the incident siblings get their own colours, the tubes that touch the node
are painted in the selection colour, and the influence links of the node are
drawn *as curves* along the very arcs the bees fly (a particle alone says
"something flies here"; a curve says "this fact depends on that one"). The
test compares the 3D set with the 2D set instead of trusting both.

**The camera flies to a node, it does not spin around it.** A search request
carries the node's position and a distance (`focusTarget`: a fraction of the
tree's radius, clamped), and the scene keeps the current viewing direction
while it moves the camera *and* the orbit target — 0.7 s of smoothstep. The
camera re-frames only when the *data* changes (a `fitKey` the app computes
from the payload), never when the model is rebuilt: a live refetch or a
filter that narrows the tree must not yank the view out of the user's hands.

**The filters reach the 3D tree.** `buildScene3D(nodes, { filter })` applies
the 2D adapter's own rule (`matchingWithAncestors`, extracted from
`buildGraph`): a node survives when it matches the filter or has a matching
descendant, and the path to the root stays as context. One rule, two views —
the collapse state stays a 2D-canvas concern, and the 3D tree of a filtered
project shows exactly the nodes the diagram shows.

**The 2D/3D choice is remembered.** `dashboard/src/view-state.ts` is the whole
rule: the URL (`?view=3d`) wins, the tab's own `localStorage` is the
fallback, and 2D is the default. The URL always carries the view, so a
copied link opens in the diagram the sender was looking at, while the token
and the project parameter survive the rewrite. WebGL is not consulted here:
whether 3D *can* be shown is the probe's and `planViewSwitch`'s business
(stage I1) — this module only remembers the wish, and a tab that asks for 3D
without WebGL stays on 2D and says why.

**The instancing pass.** Before I4, every edge was its own `<mesh>`: one
draw call *and* one React element per edge, thousands of them in a real
project. The tubes are now one instanced mesh — a unit cylinder scaled per
instance by `(radius, length, radius)` and rotated by a quaternion, so the
thickness still follows the subtree leaf count. A 92-node fixture with 91
tubes and 75 leaves renders in **7 draw calls** (10 with the selection's
highlighted arcs). The billboard loop of the leaf sprites now skips the frame
when the camera stands still: an idle scene rewrites no matrices.

**A bug the live check found.** drei's `<Html>` portals its content into the
DOM in a layout effect guarded by the group's ref; mounted in the *very
first* render of the scene, that ref is not attached yet, the portal is
skipped — and never happens again, so the label stays invisible forever. The
case is not hypothetical: it is exactly "the tab opens in 3D with a node
already selected" (switching back from 2D keeps the selection), which is the
I4 acceptance scenario. The scene now announces its first frame
(`SceneReady`) and mounts the HTML overlays after it.

**The live check.** The Paseo workspace browser (Electron/Chromium) against a
real `DashboardHttpServer` over a seeded `LuckPlannerStore`: a click on a
leaf selects it and the shared details panel answers with its version,
revision, incidents and links; the leaf wears the selection colour, its tube
is painted in it and its two influence links are drawn as curves; a search
flies the camera (the position and the orbit target move to the node) and the
label names the hit; switching 2D → 3D keeps the selection *and* the label;
the status filter cuts the 3D tree from 75 leaves to the 14 that match. The
host cannot paint its background tabs, so the *look* of the scene (legibility
of the four shapes, the FPS on a live 5–10k tree) stays on the J2 checklist.

**Tests.** `tests/dashboard-pick-3d.test.ts` (24) builds its fixtures through
a real store: the ray test (the hit, the miss, the nearest hit in front, a
node behind the origin, a non-unit direction, a ray starting inside a
sphere, a zero-length direction), the candidates (one per node, sized by
kind), the highlight (the incident siblings — compared with the 2D adapter's
own set, the bees in both directions, the node's and its children's tubes, the
empty selection), the focus target, the filters in 3D (the same node set the
2D graph shows, the ancestor path kept, no filter = every node) and the view
state (the URL, the storage, a hostile storage, the precedence, the rewrite
that keeps the token). `tests/dashboard-3d.test.ts` gains the I4 contracts:
the picking decisions stay in the app graph while the drawing stays lazy, the
tubes are one instanced mesh (no per-edge element list), the scene picks with
the pure picker, the loader forwards the interaction and reports a picked
node, both views select through the same setter and fill the same panel, the
view is remembered in the URL and the storage, the filters reach the layout,
and the HTML overlays wait for the first frame. `typecheck` (both configs) and
the full suite: 31 files, 536 tests, green.


## 7. Roadmap (stage map)

One stage = one commit, ending green (`npm run typecheck`, `vitest run`); each functional
stage bumps the MINOR version and is marked with an annotated `luck-planner@<version>` tag
pushed to origin (project rule). Docs-only stages do not bump.

**Status: blocks G, H and I are complete.** Stages A1–F2 are
complete and released as tagged versions up to `luck-planner@0.18.0`; blocks **B (storage)**,
**C (domain semantics)**, **D (agent access)**, **E (UI transport)** and **F (HTTP
transport)** are closed. G1 (0.19.0) scaffolded the dashboard web app, G2 (0.20.0) added the
`/api/tree` → React Flow data adapter with the d3-hierarchy layout and the
collapse/expand policy, G3 (0.21.0) painted the custom nodes and edges
(status bars, incident badges, goal frames, bee-edge renderer) — plus the
`window.fetch` receiver fix that the first real tab exposed — G4
(0.22.0) wired the interaction: node selection with the blocker trail,
`/api/node/:id` details panel, FTS search with camera focus, and the
kind/status/version filters, G5 (0.23.0) added the growth layer: the
per-node roll-up of its own record plus everything below it (goal records
included at the node they materialized), the toolbar heat map, the growth bars
on nodes and goal frames, and the honest "no growth records yet" hint, and
H1 (0.24.0) made both views live: the audit-trail change feed behind the
`tree-changed` SSE event, the per-project streams with their `ready` cursor,
the dashboard's coalescing `EventSource` client, and the `tree-changes` RPC the
native panel polls, and H2 (0.25.0) put the two key audit facts — a goal crossing
the approval gate, a leaf reaching `done` — into the responsible agent's own
timeline, appended through the SDK and drawn by a plugin renderer, and I1
(0.26.0) opened block I with the WebGL spike: an injectable canvas probe with
a released context, the stay-on-2D-with-a-written-reason fallback, and a
second esbuild entry (`dashboard-3d.js`) that keeps three/r3f/drei out of the
eagerly loaded chunk while sharing a single React through code splitting,
and I2 (0.27.0) drew the tree itself: a pure radial layout module (depth →
height, siblings → angles, tube radius ∝ √subtree leaves) feeding a scene of
sphere apexes, quaternion-oriented tubes and a single instanced billboard
mesh for every leaf, wired app → ThreeView → `handle.setModel` without
remounts, and I3 (0.28.0) dressed it: the pure overlay module of bee arcs,
blocking-incident markers, goal rings and growth halos, the per-frame math that
is O(links) instead of O(nodes) (instanced swarms, one breathing opacity,
`hashUnit` phases instead of `Math.random()`), the hover tooltip carrying a
bee's status and revision, and the shared `growthRollups` that now makes 2D and
3D read one number — plus the test-infrastructure fix that moved the
determinism rebuilds out of the shared `dist/`, and I4 (0.29.0) made the
scene interactive: a click picks a node with a pure ray/sphere test (the
10 000-instance meshes stay out of the renderer's raycast path) and fills the
*same* details panel the 2D diagram fills, the selection shows the incident
siblings, the links (drawn as curves) and the tubes that touch it, a search
flies the camera to the node, the toolbar filters narrow the 3D tree by the
2D adapter's own rule, the 2D/3D choice is remembered in the URL and in the
tab's storage, and the tubes became one instanced mesh (7 draw calls for a
92-node fixture). J1 wrote the plugin's **English README** — what the plugin
does, the install, the eight MCP tools, the 2D and 3D dashboards, the panel,
the skill, the settings, where the data lives and the known limitations — and
linked it from the repository README (Plugins, Installation, the build table
and the compatibility table), with a `__doc.md §10 Compatibility` section that
states plainly what is verified and what is not. J2 ran the **live-daemon
acceptance** on Paseo 0.12.0 (§10) — the install from the git source, the
MCP round trip against the published entry, the goal approval, the dashboard
in the host's browser (2D and 3D, the G4/I4 scenario), the SSE, the themes,
the console and the measurements (60 fps, 6 draw calls, 1 773 KiB first load,
2 114 KiB lazy 3D chunk). It also exposed three real defects that no
artifact test could see: the host's CommonJS build has no `import.meta.url`
(§10.1), the plugin's files are not next to its code (§10.2) and the
published MCP entry died with the revision it pointed into (§10.3, §10.4).
A candidate **D4**
remains: registering the plugin in the agents' own MCP config files
(OpenCode, Kilo, Cline, Cursor, Qwen Code, Codex CLI) — the approach memory-flash took in
0.8.0 and hardened in 0.8.2, for the same two reasons: OpenCode evicts an idle
directory and takes the session-injected entry with it, and Cline/Cursor/Qwen Code/Codex
CLI ignore session-delivered MCP servers altogether. It changes **this** plugin
only: the writers reuse `mcpServerCommand()`/`injectedMcpConfig()`, and
memory-flash itself is not touched — it already ships that solution.

| Block | Stages | Versions | Content |
| --- | --- | --- | --- |
| A | A1–A2 | 0.1.0 | scaffold ✅; this document ✅; TEMP removed ✅ |
| B | B1–B4 | 0.2.0–0.5.0 | zod schemas ✅ (0.2.0), SQLite store ✅ (0.3.0), CRUD + state machine + audit ✅ (0.4.0), FTS5 search + filters ✅ (0.5.0) |
| C | C1–C4 | 0.6.0–0.9.0 | bees ✅ (0.6.0), bugs ✅ (0.7.0), goals + approval gate ✅ (0.8.0), growth rates ✅ (0.9.0) |
| D | D1–D5 | 0.10.0–0.12.0, 0.30.0–0.31.0 | MCP tool contracts + dispatch ✅ (0.10.0), stdio server + bundle ✅ (0.11.0), agent injection + skill + bootstrap ✅ (0.12.0), agent config-file registrations ✅ (0.30.0), structural tree tools ✅ (0.31.0) |
| E | E1–E4 | 0.13.0–0.16.0 | RPCs ✅ (0.13.0), native panel ✅ (0.14.0), ⌘K + slash ✅ (0.15.0), settings screen ✅ (0.16.0) |
| F | F1–F2 | 0.17.0–0.18.0 | read-only dashboard HTTP server ✅ (0.17.0), "Open dashboard" action ✅ (0.18.0) |
| G | G1–G5 | 0.19.0–0.23.0 | scaffold ✅ (0.19.0), adapter + layout ✅ (0.20.0), custom nodes + edges ✅ (0.21.0), interaction ✅ (0.22.0), growth layer ✅ (0.23.0) |
| H | H1–H2 | 0.24.0–0.25.0 | live data ✅ (0.24.0), agent timeline rows ✅ (0.25.0) |
| I | I1–I4 | 0.26.0–0.29.0 | 3D tree (react-three-fiber) — **last block**: WebGL spike ✅ (0.26.0), layout + geometry ✅ (0.27.0), link/incident/goal/growth overlays + frame budget ✅ (0.28.0), interaction + toggle ✅ (0.29.0) |

| J | J1–J2 | — | README.md + root README link ✅ (J1, 0.29.0), final e2e acceptance on a live daemon ✅ (J2, 0.29.1–0.29.4 — three defects the live install exposed, all now pinned by tests) |

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
| 3D overlay animation drops frames on big trees | Per-frame work is O(links) with preallocated vectors (I3); the large sets are instanced and positioned once, only one material uniform moves; I4 picking keeps the 10k meshes out of the raycast path (one ray/sphere test per click) and the idle billboard loop rewrites nothing |
| Concurrent SQLite access (agents + UI + HTTP) | WAL + busy timeout + write-retry from stage B2; one owning process |
| Plugin update breaks agents' MCP entry path | Revision-independent publication from stage D2 (memory-flash 0.7.1 lesson) |
| HTTP layer as an attack vector | 127.0.0.1 + token + read-only API (ADR-8, ADR-9) |
| Mobile clients without a workspace browser | Native panel works everywhere; dashboard via `openExternalUrl`; 3D on mobile is best-effort, documented |

Standing constraints: zero runtime npm dependencies in daemon code where possible (Node
built-ins first, as in memory-flash); `dashboard/` dependencies (React Flow, three.js) live in
`devDependencies` and are bundled by esbuild; README.md and `__doc.md` are maintained in
English only (project rule).

## 10. Compatibility

Verified on 2026-10-22 in the plugin's development environment with
`@getpaseo/plugin@0.12.0` (the manifest requires Paseo `>= 0.11.0`; the
0.12.0 conformance pass is §10.5):

- `npm run typecheck` — clean, in both configurations (the root one and
  `dashboard/tsconfig.json`, which the root excludes).
- `npm test` — 36 suites, 611 tests, all green. The suite includes a
  real-process stdio e2e (it spawns the built `dist/mcp-server.js` and speaks
  JSON-RPC over the pipe: handshake → `tools/list` → `tools/call`), the HTTP
  server suites (a real socket on loopback, an SSE stream that a second
  connection to the same file wakes up), the dashboard suites (the built
  artifact, the 2D/3D bundle split, the rebuild determinism against a fresh
  build in a temp root), the 3D budget tests (10 000 nodes, a build and a
  60-frame animation budget) and the client audit of §10.5 (the DOM globals,
  DOM props and HTML elements of `client/`, and the host's interface-size
  parsing).
- Node ≥ 24.20 on the daemon host: the store uses the built-in `node:sqlite`
  with FTS5 (`porter`, `unicode61`).
- The MCP bundle depends on nothing beyond Node built-ins, so an agent's own
  Node runtime can spawn it without an `npm install`.
- The dashboard bundle is a static ESM app served by the plugin's own
  loopback HTTP server; it needs no CDN, no network and no external asset.

**Verified on a running daemon (stage J2, 2026-10-19, Paseo 0.12.0).** The
plugin was installed from the git source on a live daemon
(`paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:luck-planner`),
which builds it in its managed clone (`npm ci`, `npm run bundle`) and loads it
from there. The checklist and its results:

| # | Check | Result |
| - | ----- | ------ |
| 1 | install from the git source → `running` | ✅ `paseo plugin ls` shows `running`, no error column |
| 2 | `paseo plugin logs luck-planner` | ✅ only the host's own `DeprecationWarning`s; the plugin logs its MCP entry, the skill and the dashboard URL |
| 3 | the dashboard answers | ✅ `GET /health` → `{"ok":true,"version":"0.29.4"}`; `GET /` serves the built app (not the placeholder) |
| 4 | an agent through MCP | ✅ the **published** entry (`~/.paseo/plugins/luck-planner/mcp-server.js`) spoke JSON-RPC: `initialize` (name `luck-planner`, version 0.29.4), `tools/list` (all eight tools), `luck_tree_search`, `luck_tree_get_context`, `luck_tree_upsert_leaf` (four leaves with statuses), `luck_tree_add_bee`, `luck_tree_report_bug`, `luck_tree_set_goal` (`create` + `propose`), `luck_tree_update_growth` |
| 5 | the human approves a goal | ✅ the *store* refuses a draft ("only a proposed goal may be approved") and approves the proposed one — the same call the panel's `luck-planner.goal-approve` RPC makes. The goal materialized into the tree and its ring appears in the 3D scene. The panel's **click** itself is a native-surface action with no automation surface; it stays a manual step |
| 6 | the dashboard in the host's browser | ✅ the Paseo workspace browser against the live `127.0.0.1:8899`: the 2D diagram, the details panel, the legend, the live counters |
| 7 | the G4 scenario in 2D | ✅ the search found the leaf ("2 matches — showing …"), the details panel filled with the path, version and revision; clicking another node switched the panel |
| 8 | the I4 scenario in 3D | ✅ the switch mounted the scene (1097×645, a live WebGL context, status `live`); a click on a leaf filled **the same** details panel, and the 3D label named the node |
| 9 | the switch keeps the selection | ✅ 2D → 3D → the details panel still showed the selected node, and the 3D label appeared with it |
| 10 | the SSE updates both views | ✅ with the tab open, a leaf written through MCP moved the 2D counters (8 → 15 → 16 nodes) and the 3D scene (11 → 12 instanced leaves) — no reload |
| 11 | the themes | ✅ dark (`--lp-bg: #0f1115`) and light (`#f6f7f9`, `--lp-surface: #ffffff`) — the stored choice wins over the OS preference |
| 12 | the browser console | ✅ one message, from three.js itself (`THREE.Clock: This module has been deprecated`) — a library deprecation, not an error of this plugin. The host's own automation does not expose the console content, so the check was done with a probe installed in the *installed* checkout (removed afterwards) |
| 13 | the frame rate | ✅ **60 fps** in the live 3D scene (rAF ticks over two seconds) with 16 nodes, 2 bees, 2 incident markers, a goal ring and the selection ring — 6 draw calls |

Measurements (the numbers the roadmap asked for):

| What | Size |
| ---- | ---- |
| the standalone MCP server (`dist/mcp-server.js`) | 869 KiB — no runtime dependency beyond Node's built-ins |
| the dashboard's **first load** (`dashboard.js` + the shared chunks) | 1 773 KiB |
| the **lazy** 3D chunk (`dashboard-3d.js`) | 2 114 KiB — downloaded only when 3D is opened |
| the dashboard CSS | 29 KiB |
| the live tree in the acceptance | 16 nodes, 2 bees, 2 open incidents, 1 materialized goal |

The 10 000-node budget stays a *measured* claim from the suite (an overlay
build under 500 ms, 60 frames of animation under 300 ms, a 10k-node layout in
about 90 ms) — the live tree above is a real project, not a synthetic one, and
the two are different kinds of evidence.

**What the acceptance cost, and what it bought.** Three real defects, all of
them invisible to the artifact tests, because they only exist in the *host's*
build and in the *daemon's* lifecycle: the CommonJS `import.meta` trap
(§10.1), the files-not-next-to-the-code trap (§10.2) and the MCP entry that
died with the revision it pointed into (§10.3, §10.4). Each one is now
pinned by a test that reproduces the host's build rather than describing it.



### 10.1 The CommonJS trap (0.29.1) — the live install found it

The J2 acceptance installed the plugin from the git source on a running
Paseo 0.12.0 daemon. The plugin reported `running`, the MCP entry was
published and the skill was installed — and the **dashboard never started**:

```text
[luck-planner] dashboard port 8899 unavailable (Invalid URL); falling back to an ephemeral port
[luck-planner] dashboard failed to start on an ephemeral port: Invalid URL
```

The cause: the host loads a plugin's *server* code by transpiling its
TypeScript, and that build is **CommonJS**. There `import.meta` is an empty
object, so `new URL("../dist/dashboard/", import.meta.url)` throws
"Invalid URL" — and `resolvePluginVersion()` degraded to `0.0.0` in the same
way, silently. The artifact tests could not see it: they exercise the ESM
bundle (`dist/mcp-server.js`), where `import.meta.url` exists, while the
daemon runs the CommonJS one. Two code paths, two module systems, one
artifact.

The fix is `server/module-dir.ts`: one helper that resolves the module's own
directory through whichever door the build has — `import.meta.url` in ESM,
`__dirname` in CommonJS (`typeof __dirname` on a free identifier is safe in
an ESM bundle, so a single helper serves both). `resolveDashboardDir()` and
`resolvePluginVersion()` now go through it.

The regression test reproduces the host's build instead of describing it:
`tests/module-dir.test.ts` bundles `server/http-server.ts` with esbuild in
**CommonJS** format, lays the output out in the shape of a plugin checkout
(`server/` next to `package.json` and `dist/dashboard/`) and asks the *built*
module where its files are — the dashboard directory, the manifest version,
and no "Invalid URL". The same suite checks the ESM path, and the failure was
verified by hand: the pre-fix resolution, bundled the same way, throws
`Invalid URL` in Node.

### 10.2 The second half of the same trap (0.29.2) — the files are not next to the code

With 0.29.1 the dashboard *started* on the live install and answered on
`http://127.0.0.1:8899` — but with the placeholder page ("the dashboard web
app is not built in this checkout (run the plugin build)"), and `/health`
still reported `0.0.0`.

The reason is the other half of the same trap: the host loads the plugin's
code from **its own** directory, so even a correct `__dirname` points
nowhere near the checkout. The plugin's *files* — the built dashboard and the
manifest — stay in the directory the daemon installed, and the daemon records
it: `$PASEO_HOME/config.json` holds `plugins["luck-planner"].path`, the
checkout with `package.json` and `dist/dashboard/` inside. `mcp-launch.ts`
already used that entry to publish the MCP entry; the dashboard did not.

`server/plugin-paths.ts` is now the single place that answers "where are the
plugin's files": the configured directory first, the module's own root
second (a development checkout has the built app next to the code), and a
candidate counts as usable only when it holds the app's `index.html` — a
directory without it would only reproduce the placeholder. `mcp-launch.ts`
and `http-server.ts` share the lookup now.

The acceptance that pins it is the *shape* of a live install: the test builds
the module in CommonJS format into a directory that holds no built app, points
`PASEO_HOME` at a fake home whose config names a fake checkout, and asserts
that the built module finds the dashboard and the manifest *there* — with the
`index.html` present, so the placeholder can never be served again.

### 10.3 The MCP entry died with the revision it pointed into (0.29.3)

With the dashboard working, the acceptance spoke to the MCP server the way an
agent does — the published entry, over stdio — and got:

```text
Error: Cannot find module '/home/sirafim/.paseo/plugins/luck-planner/mcp-server.js'
```

The published entry was a **symlink into the revision directory**, and the
daemon deletes the previous revision right after the new one is loaded. The
plugin published at load time — when the daemon's config still named the
*previous* revision — so the link pointed at the revision that was about to
be removed, and every agent that spawned the server afterwards got a missing
module. The entry's path was right (revision-independent), its *target* was
not: the plugin's own note called the publication "revision-independent",
while the thing it pointed at was not.

The fix is to publish a **copy**: `publishMcpEntry` writes the bundle to a
temporary name and renames it over the published path, so the entry is a
real file with the bundle's bytes and no dependency on the revision's
lifetime. It is refreshed on every resolution — on plugin load and on every
`agent.create` — so the entry is current by the time an agent needs it,
whatever order the daemon installs in. The regression test in
`tests/mcp-launch.test.ts` now asserts the *content* of the published entry
(and that it still exists after the revision directory is removed) instead of
the realpath of a link.

### 10.4 When the entry is refreshed (0.29.4)

The copy fixed the dangling link, but the first live run showed the copy
carrying the *previous* revision's bundle: the plugin publishes at load, and
at that moment the daemon's config still names the revision the update is
replacing — the daemon rewrites it a few milliseconds later, right after the
plugin is ready. The published entry was therefore the old code (the MCP
handshake reported `0.29.2` while the plugin was `0.29.3`).

The refresh now also happens in `applySettings` — the moment the settings
arrive, which is *after* the daemon finalised the install and rewrote its
config. That is the first instant at which "the revision the daemon just
installed" and "the revision this process is running" are the same thing, and
the log line `MCP entry refreshed: …` makes it visible in
`paseo plugin logs luck-planner`.

The ordering the daemon actually uses, measured on the live install:

| when | what | consequence |
| --- | --- | --- |
| +0 ms | the new revision's directory is created | the bundle exists, but nothing points at it yet |
| +8 s | the plugin loads (the config still names the old revision) | a load-time publication would copy the *old* bundle |
| +8 s, +36 ms | the daemon rewrites `config.json` with the new path | from here on the config is the truth |
| +8 s, +160 ms | the settings arrive → `applySettings` | the first moment the current bundle is knowable — the refresh happens here |
| +8 s, +170 ms | the dashboard endpoint starts and resolves the dashboard directory | it reads the *current* revision's build ✓ |

### 10.5 Paseo 0.12.0 spec conformance (0.32.2)

Verified on 2026-10-22 against the **stable Paseo 0.12.0** release
(`paseo --version` → `0.12.0`) with the plugin SDK `@getpaseo/plugin@0.12.0`.
The 2026-10-21 conformance pass of the other five plugins in this repository
deliberately left this one out — it was still in development — so this section
is its first full pass.

**The SDK diff is additive, and none of it touches this plugin.**

| Diff | What changed | Effect on luck-planner |
| ---- | ------------ | ---------------------- |
| `@getpaseo/plugin@0.11.0 → 0.12.0` | `dist/server/acp.d.ts` (`AcpOptions.workspaceOnlyCatalog`) and `dist/server/provider.d.ts` (`ProviderRegistration.requiresConfiguration`) | none — the plugin registers no provider and no ACP agent |
| `@getpaseo/client@0.11.2 → 0.12.0` | additive: `SendMessageOptions.sourceAgentId`, background workspaces, `readFile` timeout | none — the plugin's client calls are the workspace list and `timeline.append` |
| `@getpaseo/protocol@0.11.2 → 0.12.0` | timeline and agent types | none — the plugin's rows are built against its own zod schema (`shared/timeline.ts`) |

The **client** declarations are byte-identical from 0.11.0 to 0.12.0, so the
manifest floor stays `>= 0.11.0`: the newest API the plugin uses is
`addScreen` / `openScreen`, which arrived in 0.11. Raising the floor to
`>= 0.12.0` would lock out hosts that run the plugin perfectly well — the
manifest documents the *API* floor, not the tested version.

**The deprecated surface API was never used.** The plugin registers
`addWorkspacePanel`, `addSettingsScreen`, `addScreen`,
`addCommandCenterItem`, `addSlashCommand` and `addTimelineRenderer`, and it
opens its screen with `openScreen`. The compiled client bundle (§10.6) carries
the new API and **zero** `addSurface` / `addSidebarItem` / `openSurface`
calls.

**One real spec violation, found and fixed.** Paseo's plugin spec keeps DOM
globals out of cross-platform components: `window`, `document`,
`localStorage`, `navigator` and `location` belong in `client/web.ts`, declared
only for what that module uses and gated on `Platform.OS === "web"`. The
plugin read `localStorage` straight from `client/use-host-typography.ts` — the
host's interface size (Settings → Appearance → Fonts), the same value the
other plugins in this repository read the same way. The read now goes through
`client/web.ts`, the only module allowed to name a DOM global, and the pure
parsing moved to `client/host-font-scale.ts`, which takes the raw settings
document as a parameter and never reaches for a global itself.

`tests/client-dom-globals.test.ts` runs the spec's own client audit over
`client/` — DOM globals, DOM props (`className`, `onClick`) and HTML
elements — and fails on a hit outside `client/web.ts`. The rule is a test, not
a review step, and the same suite pins the interface-size parsing (the three
spellings the host has used, and every malformed shape falling back to the
default scale).

**Improvements made on the new SDK.**

- The settings screen and the dashboard screen now honour `layout.compact`:
  the host's compact layout (phones, narrow windows) gets tighter spacing.
  The workspace panel and the timeline rows already did.
- The dashboard address on the "Open dashboard" screen is a real link
  (`ExternalLink` from `@getpaseo/plugin/client/ui`): one tap reaches the
  dashboard in the system browser when the in-app tab was closed, refused or
  never opened. The address stays selectable, as before.

**Live verification on a real 0.12.0 daemon** (a scratch home on its own
port; the production daemon and its configuration untouched):

| # | Check | Result |
| - | ----- | ------ |
| 1 | `paseo plugin install <the working tree>` | ✅ `running`, no error column |
| 2 | `paseo plugin logs luck-planner` | ✅ `Plugin ready`, the MCP entry published, the skill up to date, the dashboard listening |
| 3 | `paseo plugin reload luck-planner` | ✅ exits 0 in 1.5 s and the plugin restarts cleanly (the 0.12.0 `#6306` fix) |
| 4 | the **published** MCP entry | ✅ `initialize` → `serverInfo { name: "luck-planner", version: "0.32.2" }`, `tools/list` → all eleven tools, `luck_tree_search` answered |
| 5 | the dashboard endpoint | ✅ `GET /health` → `{"ok":true,"server":"luck-planner","version":"0.32.2"}`, `GET /` → the built web app |
| 6 | the real 0.12.0 host compiler | ✅ the client and the server entry build; the client bundle carries the new API and **zero** deprecated calls (§10.6) |

### 10.6 The host compiler as the oracle

The client entry is not typechecked by TypeScript alone: the host compiles it
with its own bundler, and that compiler enforces the runtime boundaries (a
`client/` module in the daemon bundle, a `node:` import in the app bundle, a
module in the plugin root) and the SDK boundaries (`@getpaseo/plugin/client`
in the daemon bundle, `react` in a shared module). A plugin can typecheck
cleanly and still be refused by the host.

For this pass the compiler was taken from the installed 0.12.0 application
itself — `app.asar` → `@getpaseo/server/dist/server/server/plugins/compiler.js`,
the exact `compilePlugin` the daemon runs — and pointed at this plugin's
working tree. It resolved the plugin's own `tsconfig.json`, walked the import
graph with the TypeScript resolver (erased type imports included) and built
both bundles. The result is the evidence in row 6 of §10.5.

The same compiler is what makes the "zero deprecated calls" claim meaningful:
it is the build the user's daemon performs at install time, not a look-alike.
