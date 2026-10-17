# luck-planner — technical documentation

> **Development status: version in development (`0.17.0`).** Stages **E4** (settings
> screen) and **F1** (read-only dashboard HTTP server) are done and all tests are green;
> the next stage is **F2** ("Open dashboard"). Stages A1–F1 are complete; F2 and blocks
> G–J are otherwise untouched. Nothing in this document is a released API: the roadmap in
> §7 describes work that is still ahead.

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
| Settings screen (`injectIntoAgents`, `mcpServerName`, `httpEnabled`, HTTP port, token, retention) | `defineSettings` / settings screen | E4 + F1 |
| Plugin RPCs (`tree.get`, `node.detail`, `node.setStatus`, `goal.approve`, …) | `defineRpc` + `server.handle` | E1 |
| MCP injection into agents | `server.before("agent.create")` + `agent.session_open` | D3 ✅ |
| Settings (`injectIntoAgents`, `mcpServerName`) | `defineSettings` / `server.registerSettings` (values); settings screen | D3 ✅ / E4 |
| Skill for coding agents (`SKILL.md` protocol + installer) | `server/skill.ts`, auto-install on plugin load | D3 ✅ |
| Bundled stdio MCP server (`dist/mcp-server.js`) | `paseo-plugin.json` `mcp.entry` + `server/mcp-server.ts`, spawned by agents | D2 ✅ |
| Dashboard HTTP server | daemon subprocess, started by the plugin lifecycle | F1 ✅ |
| "Open dashboard" | `navigation.openBrowser` → `openExternalUrl` fallback | F2 |
| Agent timeline rows (goal approved, leaf done) | `paseo.agents.ref(id).timeline.append` (optional) | H2 |

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

Seven `luck-planner.*` contracts for the Paseo UI: the native panel (E2), Command
Center items (E3) and the settings screen (E4) all go through them. The server
registers the handlers over one shared `LuckPlannerStore` (closed on plugin
cleanup); `tests/rpc.test.ts` (15 tests, fake `PluginServerContext` against a
temp-directory database) covers the surface:

- **Reads** return store rows directly: `tree-get` (roots with their first level of
  children), `tree-search` (FTS5 with kind/status filters), `node-detail` (node +
  path + children + bees + bugs + blocking bugs + history + growth), `growth-get`
  (record plus the shared `growthProgress` aggregate), `stats` (panel counters —
  new `store.stats()`: live nodes by kind/status, in-progress/done leaves, bees,
  open bugs, proposed/approved goals, growth records).
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
  catalog mid-session (memory-flash 0.8.1 lesson: for OpenCode/Kilo a registration in the
  provider's own MCP config file is strictly more reliable than the session-level entry);
  Cline/Cursor/Codex CLI ignore session-delivered MCP servers altogether. Porting
  memory-flash's config-file registrations (`opencode`/`kilo`/`cline`/`cursor`/`codex`) is
  the candidate follow-up stage **D4**; `mcpServerCommand()`/`injectedMcpConfig()` are the
  single source those writers will reuse.

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
| `GET /api/events` | token | SSE stream: `ready` on open, heartbeat comment every 15 s, `tree-changed` broadcasts (stage H1) |
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
defaults are unchanged from E4. While `dist/dashboard` is not built (stage G1), `GET /`
answers a truthful placeholder page instead of a blank 404 — the JSON API is already live.

**Not yet wired (stage H1).** The MCP server runs in a *separate process* that writes the
same SQLite file, so the daemon cannot learn about a mutation without polling or a DB hook.
For that reason `/api/events` is a placeholder in F1: the stream, heartbeat and
`broadcast()` exist and are tested, but no mutation calls them yet.

## 7. Roadmap (stage map)

One stage = one commit, ending green (`npm run typecheck`, `vitest run`); each functional
stage bumps the MINOR version and is marked with an annotated `luck-planner@<version>` tag
pushed to origin (project rule). Docs-only stages do not bump.

**Status: block F (HTTP transport) is open — F1 is done.** Stages A1–E4 are complete
and released as tagged versions up to `luck-planner@0.16.0`; blocks **B (storage)**, **C
(domain semantics)**, **D (agent access)** and **E (UI transport)** are closed. F1 (0.17.0)
delivers the read-only dashboard HTTP server on loopback (ADR-9). **Block F continues with
F2** ("Open dashboard": `navigation.openBrowser` with the tokenised URL, `openExternalUrl`
fallback). A candidate **D4** (config-file MCP registrations for OpenCode/Kilo/Cline/Cursor/
Codex, the memory-flash 0.8.1 fix) may still precede the remaining UI work.

| Block | Stages | Versions | Content |
| --- | --- | --- | --- |
| A | A1–A2 | 0.1.0 | scaffold ✅; this document ✅; TEMP removed ✅ |
| B | B1–B4 | 0.2.0–0.5.0 | zod schemas ✅ (0.2.0), SQLite store ✅ (0.3.0), CRUD + state machine + audit ✅ (0.4.0), FTS5 search + filters ✅ (0.5.0) |
| C | C1–C4 | 0.6.0–0.9.0 | bees ✅ (0.6.0), bugs ✅ (0.7.0), goals + approval gate ✅ (0.8.0), growth rates ✅ (0.9.0) |
| D | D1–D3 | 0.10.0–0.12.0 | MCP tool contracts + dispatch ✅ (0.10.0), stdio server + bundle ✅ (0.11.0), agent injection + skill + bootstrap ✅ (0.12.0) |
| E | E1–E4 | 0.13.0–0.16.0 | RPCs ✅ (0.13.0), native panel ✅ (0.14.0), ⌘K + slash ✅ (0.15.0), settings screen ✅ (0.16.0) |
| F | F1–F2 | 0.17.0–0.18.0 | read-only dashboard HTTP server ✅ (0.17.0), "Open dashboard" action |
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
