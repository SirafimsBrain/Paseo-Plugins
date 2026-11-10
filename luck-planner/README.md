# Luck Planner

Project planning tree for coding agents on [Paseo](https://paseo.sh/): a tech-stack root, module branches, fact leaves with statuses, influence links, blocking incidents, approved high goals and growth rates — with a plain card board and a 2D diagram that read the same data. (The 3D dashboard is **suspended** — see ["3D — suspended"](#3d--suspended).)

Coding agents keep their plan in their own context window, and a chat log is a poor place to look up *what do we already know about this module*. Luck Planner gives a project one durable tree: the agents write it through MCP tools, a human reviews the tree in the panel and approves goals in the dashboard, and every write is audited.

## What it does

- **The tree** — five levels: the tech-stack **root**, the **trunks** (platforms), the **branches** (modules), the **side branches** and the **leaves** (the facts: a planned or confirmed piece of work). Every leaf carries a status (`draft → ready → claimed → in_progress → done`, plus `blocked`, `deferred`, `cancelled`, `superseded`), a version, a revision and an append-only history. `deferred` is the owner's "not now": a decision about the schedule, where `blocked` is a fact about the work. The store refuses a status transition the state machine does not allow, so an agent cannot skip a step by accident.
- **Influence links (bees)** — a directed link between two leaves saying "this depends on that".
- **Incidents (bugs)** — a problem with a severity, optionally attached to the leaves it blocks. A blocking incident (`open` or `investigating`) is visible everywhere its leaves are.
- **High goals** — a formal task with a plan, created and proposed by an agent and **approved by a human**. The gate is the human's: in the dashboard, clicking a goal card opens its modal, where **Approve under …** grows the plan as a side branch with one leaf per step. No agent approves its own proposal — the skill tells it to stop and wait, and `luck_tree_approve_goal` is reserved for a managing agent the user explicitly told to approve. An approved goal materializes as a branch of the tree, and the plan's steps become the goal's growth record.
- **Growth** — the steps of a node or a goal and their state, rolled up over the subtree. The same number paints the 2D heat map: one computation, one answer.
- **MCP tools** — seventeen read/write tools, available to every agent in the workspace (see below).
- **Registration in the agents' own config files** — the plugin can register its MCP server directly in the config of OpenCode, Kilo, Cline, Cursor, Qwen Code, Kimi Code CLI and Codex CLI, one button per agent in the settings. That matters because a session-injected server is fragile: OpenCode and Kilo keep session registrations in memory and drop them when an idle directory is evicted, Cline, Cursor, Qwen Code and Codex CLI ignore session-delivered MCP servers altogether, and Kimi Code CLI keeps its own user-level `mcp.json`. A config-file entry survives the eviction, is the only way in for the first group and also covers Kimi sessions started outside Paseo.
- **The dashboard** — a web app on the loopback interface: a plain card board (the default), a 2D diagram with search, filters and a details panel. It reads, and it makes exactly the two decisions a person makes while reading — a leaf's status and a goal's approval (see "The dashboard"). The 3D scene is suspended.
- **The native panel** — the tree, the filters and the details inside Paseo's workspace panel, with timeline rows for the two facts worth an audit line: a goal that crossed the approval gate, and a leaf that reached `done`.
- **Live updates** — the dashboard and the panel refresh themselves when the tree changes (an SSE stream in the dashboard, a polling RPC in the panel), so a second agent's write shows up without a reload.
- **An agent skill** — `luck-planner` teaches agents *when* to write the tree, not just which tool to call. It is a protocol, not a description: read the context before the work, write the leaf when the fact changes, never manage the tree by hand.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:luck-planner
```

The plugin needs a build step at install and update time (`npm ci` and `npm run bundle`), so the host needs npm-registry access once. The build produces two artifacts: the standalone stdio MCP server (`dist/mcp-server.js`, a single file with no runtime dependencies beyond Node's built-in `node:sqlite`) and the dashboard web app (`dist/dashboard/`, a readable, unminified ESM bundle).

**Browser cache after an update.** After `paseo plugin update luck-planner` (or `paseo plugin reload`), the host ships new `dist/dashboard` assets, but the **in-app browser tab keeps the previous `dashboard.js`/`dashboard.css` in its HTTP cache**. New dashboard code (for example, the red attention hand 🫴 and the “Copy agent instruction” 📋 button on cards) will not appear until you **hard-reload the tab**: `Ctrl + F5` / `Ctrl + Shift + R` (Linux/Windows) or `Cmd + Shift + R` (macOS). The MCP server and the native panel pick up the new code immediately on plugin reload; only the dashboard tab needs the hard reload.

The MCP server is injected into every agent created through Paseo (configurable in the settings), so agents from any provider connected to Paseo get the tools without manual configuration. The tool names are registered under the prefix `luck-planner`, so they appear as `luck-planner_luck_tree_search` and friends.

## The MCP tools

| Tool | What it does |
| ---- | ------------ |
| `luck_tree_get_context` | The "where am I / what is around" call. Without a node id: the project overview (roots and their first-level children; `depth` 1–3 descends further). With one: the full path root → … → node, its children, its sibling leaves, the bees touching it, its blocking bugs and its growth progress. Three optional fields keep the answer cheap: `sections` picks the blocks to return (an empty list = the node alone), `limit` caps every listing, and a cut list reports the dropped count under `truncated`. The `beeCycle` block answers the influence cycle the leaf sits on (with the loop spelled out as names) — a leaf in a loop has no honest place in an execution order. |
| `luck_tree_search` | FTS5 full-text search over the tree, with optional kind and status filters and an `includeArchived` switch. |
| `luck_tree_upsert_leaf` | Records a planned or confirmed fact. With a leaf id it updates that leaf (any mutable field plus an optional status transition in the same call); without one it creates a leaf under a parent. The very first leaf of a fresh project bootstraps the skeleton root → trunk → branch. |
| `luck_tree_upsert_node` | Shapes the structure: creates a node of any kind (root → trunk → branch → side branch) or renames an existing one — this is how the auto-created skeleton gets its real names and how a project with several areas gets a branch per area. |
| `luck_tree_move_node` | Re-parents a node with its whole subtree, for the moment a fact turns out to belong to another branch. |
| `luck_tree_archive_node` | Soft-deletes a node and everything below it: the rows stay in the database and the audit trail keeps them, the tree stops showing them. |
| `luck_tree_add_bee` | A directed influence link between two leaves, with an impact description and a status. Links are directed, so they can close a loop — the plugin finds and marks those. |
| `luck_tree_report_bug` | An incident with a title, a description and a severity, optionally attached to the leaves it blocks. |
| `luck_tree_find_bugs` | List incidents of the project, optionally filtered by status (`open`, `investigating`, `resolved`, `cancelled`). Agents use it to discover what requires attention. |
| `luck_tree_find_goals` | List high goals of the project, optionally filtered by status (`draft`, `proposed`, `approved`, `in_progress`, `done`, `cancelled`, `superseded`). Agents use it to discover planned and approved work. |
| `luck_tree_approve_goal` | Cross the approval gate and materialize a proposed goal’s subtree. Creates a side branch and one leaf per plan step — the human’s approval gate (ADR-7), reserved for a managing agent that was explicitly told to approve on the user’s behalf; an agent never approves its own proposal. In a project with one tree `parentBranchId` may be omitted (its default branch is used); a project with several trees refuses and names them, because guessing would put the plan in the wrong tree. |
| `luck_tree_set_goal` | Manages a high goal **before** the approval gate: `create` a draft, `update` a draft or proposed plan, or `propose` it for human review. There is no `approve` action — approval is the human's. |
| `luck_tree_set_status` | One lifecycle move for a leaf, an incident or a goal (`entityType`, `entityId`, `status`, optional `reason`). Use it when the move has a cause the owner cannot read off the status — "step 2 is deferred because it depends on step 1". When the **owner's last status move** on that row was made in the dashboard, `reason` is required and the store refuses the override without it; a row the agent still owns needs no explanation. `approved` is unreachable here. |
| `luck_tree_update_growth` | Upserts the progress record of one subject (a node or a goal): the steps, their state and the record's own status. |
| `luck_tree_history` | The append-only audit trail of one entity: who changed what, when and from which revision. |
| `luck_tree_export` | Writes one project to a portable `.json.zip`: the tree (archived nodes flagged, not dropped), bees, incidents with attachments, goals, growth and — by default — the audit trail. Omit `path` and the archive lands in the plugin's `backups/` directory under a date-stamped name. |
| `luck_tree_import` | Brings an exported project back: the tree with every parent edge rebuilt on fresh ids, bees, incidents with attachments, goals with their materialized subtree, growth and the audit trail. Every reference is verified before a row is written, and the target project must be empty. A **dry run by default** — the first call reports the counts and writes nothing, so `dryRun: false` does the import. |

**Whose decision it is.** Statuses are the owner's decisions; agents and the owner share the same state machines, and the store tells the two apart in the audit trail. If the owner set a row's current status by hand in the dashboard, an agent that moves it must pass `reason` — the override is recorded as `deferred → in_progress — step 2 depends on step 1` in the audit trail (`luck_tree_history`, `/luck-status`, the node history in the panel and the timeline card), so the plan still explains itself a week later. A subtree the agent wrote and nobody has touched needs no prose: demanding it would only teach everyone to type "done".

Every call carries a `projectKey`, and the store scopes every read and write by it — a tool call can never reach across a project boundary. `actor` is optional and falls back to the id the MCP server was launched with, so the audit trail is never empty.

## The dashboard

The dashboard is a standalone web app the plugin serves over loopback HTTP (`http://127.0.0.1:8899` by default, the port is configurable) and opens in Paseo's own browser — from the workspace panel's **Open dashboard** button or from the ⌘K item. The access token travels in the query string, because a browser navigation cannot attach an `Authorization` header; with no token configured the plugin generates a random one per plugin session.

**2D — the diagram.** The tree is laid out **upwards** — the root at the bottom, the trunk rising, the branches fanning out above it, the way a human reads a tree — with the goal frames drawn behind the subtree a goal materialized, the bee links as coloured edges, the incident badges on the blocking leaves and the growth bars under the nodes. Clicking a node fills the details panel with its version, revision, status, incidents, influence links, children and history; an **incident row** in that panel opens the incident's modal, and a **goal frame** opens the goal's, so the diagram can reach the same lifecycles the board offers. A one-line **planning strip** above the diagram lists what a tree picture cannot draw — the project's goals (a frame exists only after a plan materialized) and incidents attached to no leaf — as status-labelled chips with the same modal behind them. the edges around the selection and the leaves sharing an incident with it are emphasized. The toolbar search runs a full-text query, clears whatever would hide the best hit and flies the camera to it; the kind, status and version filters narrow the diagram, and the **Growth heat** layer repaints the same tree by the rolled-up growth ratio. The details panel is **resizable** — pull its left edge to give it more room, and the width is remembered for the next visit.

**Themes.** The dashboard carries no colours of its own: a theme is a JSON file in the plugin's `themes/` directory (shipped: *Graphite* dark and *Paper* light), served to the tab over `/api/themes`. Put your own palette in `themes/` beside the plugin's database (`$PASEO_HOME/plugins/luck-planner/themes/`) and pick it in the toolbar; a file with a shipped id replaces that palette. *Match Paseo* is the default: the plugin reads the appearance out of Paseo's own surface colour before opening the tab, so the dashboard opens in the scheme you are already looking at, and falls back to the OS preference when the host gives no hint. Only the chrome is themeable — node kinds, statuses, bee statuses, goals and the growth ramp are semantic and stay fixed. The file format and the rules are in [`themes/README.md`](themes/README.md).

**Writes from the dashboard.** The decisions you make while reading are the only writes the browser has, and they are all lifecycle moves: the **status of a leaf**, the **status of an incident**, the **status of a goal** short of the gate, and the **approval of a proposed goal** (which grows its plan as a side branch under a branch you pick — the human gate of ADR-7). Only the transitions the entity's own state machine allows are offered at all. Three things make that acceptable on a loopback socket: the token must arrive in the `Authorization` header (a URL leaks into history and screenshots, so a query token never grants a write), the `Origin` header must be this very server's own host (a foreign page cannot forge it), and the body must be `application/json` (an HTML form cannot send it). Each write carries the revision the panel is showing: if an agent moved the leaf in the meantime, the server refuses with `409` and the tab reloads instead of overwriting work nobody saw. Writes land as audit rows with the actor `user`, and every open tab repaints over the live stream.

**Several trees.** A project normally holds one tree, but nothing forbids a second root — an agent can grow one with `luck_tree_upsert_node`, and the import format accepts exactly one root per file. When a project holds more than one, the dashboard shows a **tree picker** in the toolbar (`All trees` plus one button per root, with node/leaf/branch counts in the tooltip) and every view — board, diagram, goal frames — can be narrowed to one tree; links with one end outside the chosen tree are dropped with it, while bugs and not-yet-materialized goals stay, because neither belongs to a tree. The one decision that *must* name a tree is where an approved goal grows its side branch: in a single-tree project the default branch is used, and in a forest the approval asks, with the branch list grouped by tree. Nothing guesses — a goal that lands in the wrong tree is a plan nobody will find.

**2D — keyboard.** The diagram is usable without a mouse. Tab lands once on the drawing (the selected node, or the first one), the **arrow keys** move between nodes the way they are drawn — up and down along the levels, left and right between neighbours — `Home`/`End` jump to the first and last, `Enter`/`Space` select, `Escape` clears the selection, and the camera follows so an arrow never selects something off screen. The moves follow the geometry of the layout, not the tree, because the eye follows the drawing: a key never gets stuck on a gap and never jumps backwards.

**2D — influence cycles.** Bees are directed, so a set of legal links can loop back on itself: A affects B, B affects C, C affects A. Such a loop has no first leaf, which means the work in it cannot be sequenced at all — so it is surfaced instead of hidden. A leaf whose live bees close a loop wears a `⟳ ×N` chip (N = leaves in the loop), the edges that close it carry a halo and `· ⟳ loop` in their label, and the details panel spells the loop out as one arrow chain of names. The mark is computed on the same payload the diagram already has (Tarjan's components over the `active`/`watching` links) and travels to the MCP tools too: `luck_tree_get_context` answers the same cycle as `beeCycle`, so an agent that is about to sequence a subtree is told when the order does not exist.

### Export — a project as a `.json.zip`

The toolbar's **Export** control downloads the whole project as one archive: the tree (archived nodes included and flagged, not dropped), the influence bees, the incidents with their leaf attachments, the goals, the growth records and — by default — the append-only audit trail. It is a plain link to `/api/export?token=…&project=…`, so the browser saves the file under a date-stamped name (`luck-planner-<project>-YYYYMMDD-HHmmss.json.zip`) instead of streaming it through the page; add `&history=0` for a tree-only copy. The document is versioned, carries the original row ids and is compressed — a project of a few thousand leaves is mostly prose, and prose is what deflate is for.

Agents have the same export as a tool: `luck_tree_export` writes the archive where asked (an absolute `path`) or, by default, into `$PASEO_HOME/plugins/luck-planner/backups/` beside the database, and answers with the path, the size and the counts. Nothing is ever overwritten: an existing path is refused and a second export within the same second gets a `-2` suffix. A project with no nodes is an error, not an empty backup — that is almost always a mistyped `projectKey`. The way back is `luck_tree_import` (or Settings → *Import*): it reads the same archive — or a `.json` extracted from it — validates the whole graph before touching the database, and writes the project into an empty project key with fresh ids, so the copy can live next to the tree it came from.

### 3D — suspended

**The 3D dashboard is stopped.** Development of the 3D scene is suspended (state: *stopped*, from 0.40.9) because the plugin has **no resources for it** and the effort goes to the two main branches: the **plain** board and the **2D** diagram.

The toolbar keeps its third button so the switch still reads Plain / 2D / 3D, but the **3D button is disabled** and its tooltip states the reason; a link or tab that still says `?view=3d` opens the plain board and the status line says why. Nothing was deleted: the scene, the WebGL probe policy and the lazy `dashboard-3d.js` bundle stay in the source and in the build, so resuming is a one-flag change (`THREE_VIEW_SUSPENDED` in `dashboard/src/webgl.ts`) rather than a rewrite. While the flag is set, the dashboard does not even probe for a WebGL context and the scene chunk is never downloaded.

**Browser cache after an update.** After `paseo plugin update luck-planner` (or `paseo plugin reload`), hard-reload any open dashboard tab so the browser picks up the new `dist/dashboard` assets instead of the cached ones: `Ctrl + F5` / `Ctrl + Shift + R` (Linux/Windows) or `Cmd + Shift + R` (macOS). The MCP server and the native panel update immediately on plugin reload; only the dashboard tab needs the hard reload.

## The workspace panel, Command Center and slash commands

- **Workspace panel** — the tree as an outline (roots with their children), counters, a full-text search, filters by kind and status, the details of the selected node, and the button that opens the dashboard.
- **Agent panel** — *Luck Planner activity*: the audit rows **this** agent wrote (which leaf it moved, which incident it reported, what it approved), newest first, each resolved to its node. Read-only; refresh on demand.
- **Command Center / ⌘K** — *Open luck-planner tree*, *Open luck-planner dashboard*, *New high goal* (the goal is created as a draft and waits for the approval gate), *Open this agent's luck-planner activity* and *Refresh luck-planner tools on this agent*.
- **Slash commands** — `/luck-status <leaf> <status>` sets a leaf's status, `/luck-bug <title>` reports an incident. Both resolve a leaf by id or by name.

## The agent skill

The plugin ships a `SKILL.md` for the `luck-planner` skill, installable into `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.qwen/skills`, `~/.cline/skills`, `~/.kilo/skills` and `$KIMI_CODE_HOME/skills` (`~/.kimi-code/skills` by default) from the plugin settings. It is written as a protocol because the tree only pays off when every agent writes to it: read the context before a non-trivial task, record a leaf when a fact changes, report an incident when work is blocked, and never edit the tree by hand.

## Settings

Paseo Settings → Plugins → Luck Planner. Every change takes effect without a daemon restart.

| Setting | Default | What it does |
| ------- | ------- | ------------ |
| `injectIntoAgents` | on | Adds the MCP server to every agent created through Paseo. |
| `mcpServerName` | `luck-planner` | The server name the injected stdio server reports; the tool-name prefix never changes. |
| `httpEnabled` | on | Serves the dashboard HTTP endpoint at all. |
| `httpPort` | `8899` | The dashboard port; `0` picks an ephemeral one. A busy port falls back to an ephemeral port. |
| `accessToken` | empty (auto) | Empty means a random token per plugin session; a value pins it verbatim. |
| `historyRetentionDays` | `0` | Prunes audit rows older than this; `0` keeps the trail forever. |

**Backups.** Settings → *Backups* → **Save snapshot** copies the **whole database** — every project, not just this one — into `backups/` beside it as `luck-planner-<date>-<time>.db.zip`. The copy is a consistent SQLite snapshot taken with `VACUUM INTO` (a plain file copy would miss the write-ahead log), integrity-checked before it is zipped, and the screen reports the path, the size and how many nodes and projects it holds. Nothing is ever overwritten. This is the backup for "the database itself is the problem"; a single project travels as an *export* instead.

**Importing one project.** Settings → *Import* takes the path of any `.json.zip` (or an extracted `.json`) and rebuilds that project — the tree, the links, the incidents, the goals, the growth records and the audit trail — with new ids, so an imported tree does not collide with the copy it came from. The file is only read, never consumed or moved: a `.json.zip` an agent wrote with `luck_tree_export` is exactly what it expects. Two presses again: the first is a **dry run** that reads the file, verifies one root, every parent, the allowed parent→child kinds, bees and incidents on leaves, and answers the counts; the second writes. A refused file leaves the database untouched, and the whole write lands in one transaction. The target project must be **empty** — a project holds one tree — so an import arrives in a fresh workspace path or a database that does not hold it yet; `includeArchived: false` imports only the live part of the tree and says in `warnings` what it skipped.

**Restoring.** Paste one of those paths (or press the last snapshot of the session) and press **Restore** — twice: the first press asks, the second replaces. Before anything is touched the plugin takes one more snapshot named `luck-planner-pre-restore-<date>-<time>.db.zip`, so a restore you regret is one more restore away. The file is verified first (a consistent database, one database entry in the archive, a schema this plugin understands), a stale write-ahead log is removed with the swap, and if the restored database does not open, the previous file is put back and reopened. Running agents hold their own connection to the old file: after a restore, reload the plugin or refresh each agent session so they reconnect.

The settings screen has one more section, **Agent config files**: it shows whether the plugin is registered in the config of OpenCode, Kilo, Cline, Cursor, Qwen Code, Kimi Code CLI and Codex CLI, and offers a button per agent (plus one for all of them). The plugin never writes those files by itself — they change the behaviour of every session of that agent on the machine, so the decision stays yours. Foreign keys, other servers, tables and comments are preserved, and a file that does not parse is reported instead of overwritten.

## Where the data lives

One SQLite database at `$PASEO_HOME/plugins/luck-planner/luck-planner.db` (falling back to `~/.paseo`). It holds the tree, the links, the incidents, the goals, the growth records and the append-only history, and it survives plugin updates: the plugin's *code* is versioned under `~/.paseo/plugins/luck-planner/<revision>/`, the *data* sits next to those directories.

The dashboard serves the tree, the statistics, the node details, the theme catalog and the export download. It writes only the lifecycle moves a person makes — a leaf's, an incident's or a goal's status, and a goal's approval — and those are not a general write path (see *Writes from the dashboard* below). Everything else that changes the tree goes through the MCP tools or the panel, so every write carries an actor and lands in the audit trail. Exports written by `luck_tree_export` land in `$PASEO_HOME/plugins/luck-planner/backups/` unless the caller names an absolute path — next to the database, so they survive plugin updates.

## Development

```bash
npm ci          # dependencies
npm run bundle  # dist/mcp-server.js + dist/dashboard/
npm run typecheck
npm test
```

`npm test` re-bundles first (`pretest`), so the committed `dist/` is always the current build. The dashboard has its own TypeScript config (`dashboard/tsconfig.json`) because the root one excludes `dashboard/**`.

- [`__doc.md`](./__doc.md) — the technical documentation: the domain model, the architectural decisions, every stage of the plan and the reasoning behind them.
- [`PLAN.md`](./PLAN.md) — the stage plan (in Russian, the working language of this repository).

The source is split by boundary: `shared/` (types and schemas, client/server neutral), `server/` (the store, the MCP server, the HTTP server, the timeline), `client/` (the panel, the settings screen, the slash commands, the dashboard screen), `dashboard/` (the web app: the pure adapter in `graph.ts`, the plain board in `plain.ts`, and — suspended, kept unused — the 3D layout in `tree-3d.ts`, the 3D overlay in `overlay-3d.ts`, the 3D interaction in `pick-3d.ts` and the scene in `dashboard-3d.tsx`).

## Compatibility

Paseo **0.15.0 (2026-11-03)** verified, `requirements.paseo >=0.15.0`, SDK `@getpaseo/plugin ^0.15.0` — compatible after migration to `server.addHook` (0.39.8).

Full detail: [__compatibility.md](./__compatibility.md); technical evidence: [`__doc.md`](./__doc.md) (Compatibility sections).

## Known limitations

- The 3D dashboard is **suspended** (see ["3D — suspended"](#3d--suspended)): the code stays in the repository and in the build, the toolbar's 3D button is disabled, and any `?view=3d` link opens the plain board. There is no supported way to open the scene.
- The dashboard is designed for a desktop-sized tab; the native panel is the mobile-friendly surface.
- The dashboard is served on the **daemon host's** loopback interface, so it opens on the machine that runs the daemon. With a remote daemon, the native panel still works (it speaks to the daemon over the host connection), but the dashboard URL points at the desktop's own loopback and the tab stays empty. The MCP tools and the panel are unaffected.

## License

MIT. See [LICENSE](../LICENSE).

## Plain view (default)

The dashboard opens on the **Plain** view: a card board (zones PLAN / ACTIVE / DONE) built from the same `/api/tree` payload as the 2D diagram. Clicking a card opens a modal with the full record (node, goal, or incident). The 2D view remains available in the toolbar and the choice is remembered per tab; the 3D button is disabled (suspended).

**Plain is the primary surface.** The board is where planning is read and decided, so it gets the features first and the 2D diagram gets them second: anything a person has to *do* while reading the plan belongs on a card. The diagram stays a first-class view — the same payload, the same filters, the heat map and the keyboard model — but a change that only exists in 2D is a change in the wrong place. The 3D scene is suspended and out of this rule until it is resumed.

**Moving a status on the board.** Every card whose entity has a legal next step carries the verbs the owner uses — leaf: *Back to plan*, *Claim*, *Start*, *Stop*, *Defer*, *Resume*, *Close*, *Cancel*; incident: *Investigate*, *Resolve*, *Reopen*, *Cancel*; goal: *Propose*, *Back to draft*, *Start*, *Close*, *Cancel*. The list comes from the state machine itself, so a button never offers a move the store would refuse; the write carries the revision the card rendered, and a card that moved meanwhile makes the tab reload instead of overwriting. Two moves are deliberately **not** on a card: approving a goal (it grows a subtree and may need a branch, so it stays the modal's *Approve under …*) and replacing a plan (only plan replacement produces `superseded`, and it cascades a reset).

**The agent's reason on the card.** When an agent moves a status the owner had set by hand, the card carries the note it was forced to give, behind a `↺` marker (the reason text, with the agent and the timestamp in its tooltip). The same note appears in the node, goal and incident modals and in the 2D details panel: the reason is the point of the rule, so it is shown where the decision is read, not only in the audit trail. The data rides `/api/tree` as `statusNotes` (the newest status audit row per entity), so a hundred cards cost one payload, not a hundred history requests.

**Approving a goal.** A proposed goal shows a 🫴 card in the PLAN zone with the next step spelled out. Open the card and the modal's **Approval** section carries the write: **Approve under …** grows the plan as a side branch with one leaf per plan step, and, in a project with several branches (or several trees), a selector names where it lands. The button is absent, with a sentence saying why, when there is no live branch to grow under — create a branch first (`luck_tree_upsert_node`) — and in a tab opened without the access token. The native Paseo panel is read-only for goals: it lists the tree and the audit history, but the approval gate belongs to the dashboard.
