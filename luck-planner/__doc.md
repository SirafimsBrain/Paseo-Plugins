# luck-planner — technical documentation

> **Development status: version in development (`0.9.0`).** Development is currently paused
> after **stage C4** (growth rates — done, all tests green; **block C is complete**). The next
> stage is **D1** (MCP tool contracts). Nothing in this
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

**Status: development paused after stage C4.** Stages A1–C4 are complete and released as
tagged versions up to `luck-planner@0.9.0`; block **C (domain semantics) is closed** and
stage **D1** (MCP tool contracts) is next. Blocks D–J are untouched.

| Block | Stages | Versions | Content |
| --- | --- | --- | --- |
| A | A1–A2 | 0.1.0 | scaffold ✅; this document ✅; TEMP removed ✅ |
| B | B1–B4 | 0.2.0–0.5.0 | zod schemas ✅ (0.2.0), SQLite store ✅ (0.3.0), CRUD + state machine + audit ✅ (0.4.0), FTS5 search + filters ✅ (0.5.0) |
| C | C1–C4 | 0.6.0–0.9.0 | bees ✅ (0.6.0), bugs ✅ (0.7.0), goals + approval gate ✅ (0.8.0), growth rates ✅ (0.9.0) |
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
