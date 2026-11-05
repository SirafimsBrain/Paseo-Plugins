# Luck Planner

Project planning tree for coding agents on [Paseo](https://paseo.sh/): a tech-stack root, module branches, fact leaves with statuses, influence links, blocking incidents, approved high goals and growth rates — with a plain card board and a 2D diagram that read the same data. (The 3D dashboard is **suspended** — see ["3D — suspended"](#3d--suspended).)

Coding agents keep their plan in their own context window, and a chat log is a poor place to look up *what do we already know about this module*. Luck Planner gives a project one durable tree: the agents write it through MCP tools, a human reviews and approves it in the panel and the dashboard, and every write is audited.

## What it does

- **The tree** — five levels: the tech-stack **root**, the **trunks** (platforms), the **branches** (modules), the **side branches** and the **leaves** (the facts: a planned or confirmed piece of work). Every leaf carries a status (`draft → ready → claimed → in_progress → done`, plus `blocked`, `cancelled`, `superseded`), a version, a revision and an append-only history. The store refuses a status transition the state machine does not allow, so an agent cannot skip a step by accident.
- **Influence links (bees)** — a directed link between two leaves saying "this depends on that".
- **Incidents (bugs)** — a problem with a severity, optionally attached to the leaves it blocks. A blocking incident (`open` or `investigating`) is visible everywhere its leaves are.
- **High goals** — a formal task with a plan, created and proposed by an agent and **approved by a human**. There is deliberately no MCP action that approves a goal: the approval gate is the human's call through the panel. An approved goal materializes as a branch of the tree, and the plan's steps become the goal's growth record.
- **Growth** — the steps of a node or a goal and their state, rolled up over the subtree. The same number paints the 2D heat map: one computation, one answer.
- **MCP tools** — eleven read/write tools, available to every agent in the workspace (see below).
- **Registration in the agents' own config files** — the plugin can register its MCP server directly in the config of OpenCode, Kilo, Cline, Cursor, Qwen Code and Codex CLI, one button per agent in the settings. That matters because a session-injected server is fragile: OpenCode and Kilo keep session registrations in memory and drop them when an idle directory is evicted, and the terminal agents ignore session-delivered MCP servers altogether. A config-file entry survives the eviction and is the only way in for the latter.
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
| `luck_tree_approve_goal` | Cross the approval gate and materialize a proposed goal’s subtree. Creates a side branch and one leaf per plan step — the human’s approval gate (ADR-7). |
| `luck_tree_set_goal` | Manages a high goal **before** the approval gate: `create` a draft, `update` a draft or proposed plan, or `propose` it for human review. There is no `approve` action — approval is the human's. |
| `luck_tree_update_growth` | Upserts the progress record of one subject (a node or a goal): the steps, their state and the record's own status. |
| `luck_tree_history` | The append-only audit trail of one entity: who changed what, when and from which revision. |
| `luck_tree_export` | Writes one project to a portable `.json.zip`: the tree (archived nodes flagged, not dropped), bees, incidents with attachments, goals, growth and — by default — the audit trail. Omit `path` and the archive lands in the plugin's `backups/` directory under a date-stamped name. |
| `luck_tree_import` | Brings an exported project back: the tree with every parent edge rebuilt on fresh ids, bees, incidents with attachments, goals with their materialized subtree, growth and the audit trail. Every reference is verified before a row is written, and the target project must be empty. A **dry run by default** — the first call reports the counts and writes nothing, so `dryRun: false` does the import. |

Every call carries a `projectKey`, and the store scopes every read and write by it — a tool call can never reach across a project boundary. `actor` is optional and falls back to the id the MCP server was launched with, so the audit trail is never empty.

## The dashboard

The dashboard is a standalone web app the plugin serves over loopback HTTP (`http://127.0.0.1:8899` by default, the port is configurable) and opens in Paseo's own browser — from the workspace panel's **Open dashboard** button or from the ⌘K item. The access token travels in the query string, because a browser navigation cannot attach an `Authorization` header; with no token configured the plugin generates a random one per plugin session.

**2D — the diagram.** The tree is laid out **upwards** — the root at the bottom, the trunk rising, the branches fanning out above it, the way a human reads a tree — with the goal frames drawn behind the subtree a goal materialized, the bee links as coloured edges, the incident badges on the blocking leaves and the growth bars under the nodes. Clicking a node fills the details panel with its version, revision, status, incidents, influence links, children and history; the edges around the selection and the leaves sharing an incident with it are emphasized. The toolbar search runs a full-text query, clears whatever would hide the best hit and flies the camera to it; the kind, status and version filters narrow the diagram, and the **Growth heat** layer repaints the same tree by the rolled-up growth ratio. The details panel is **resizable** — pull its left edge to give it more room, and the width is remembered for the next visit.

**Themes.** The dashboard carries no colours of its own: a theme is a JSON file in the plugin's `themes/` directory (shipped: *Graphite* dark and *Paper* light), served to the tab over `/api/themes`. Put your own palette in `themes/` beside the plugin's database (`$PASEO_HOME/plugins/luck-planner/themes/`) and pick it in the toolbar; a file with a shipped id replaces that palette. *Match Paseo* is the default: the plugin reads the appearance out of Paseo's own surface colour before opening the tab, so the dashboard opens in the scheme you are already looking at, and falls back to the OS preference when the host gives no hint. Only the chrome is themeable — node kinds, statuses, bee statuses, goals and the growth ramp are semantic and stay fixed. The file format and the rules are in [`themes/README.md`](themes/README.md).

**Writes from the dashboard.** Two decisions are yours to make while reading the diagram, and they are the only writes the browser has: the **status of a leaf** (only the transitions the state machine allows are offered) and the **approval of a proposed goal** (which grows its plan as a side branch under a branch you pick — the human gate of ADR-7). Three things make that acceptable on a loopback socket: the token must arrive in the `Authorization` header (a URL leaks into history and screenshots, so a query token never grants a write), the `Origin` header must be this very server's own host (a foreign page cannot forge it), and the body must be `application/json` (an HTML form cannot send it). Each write carries the revision the panel is showing: if an agent moved the leaf in the meantime, the server refuses with `409` and the tab reloads instead of overwriting work nobody saw. Writes land as audit rows with the actor `user`, and every open tab repaints over the live stream.

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

The plugin ships a `SKILL.md` for the `luck-planner` skill, installable into `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.qwen/skills`, `~/.cline/skills` and `~/.kilo/skills` from the plugin settings. It is written as a protocol because the tree only pays off when every agent writes to it: read the context before a non-trivial task, record a leaf when a fact changes, report an incident when work is blocked, and never edit the tree by hand.

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

The settings screen has one more section, **Agent config files**: it shows whether the plugin is registered in the config of OpenCode, Kilo, Cline, Cursor, Qwen Code and Codex CLI, and offers a button per agent (plus one for all of them). The plugin never writes those files by itself — they change the behaviour of every session of that agent on the machine, so the decision stays yours. Foreign keys, other servers, tables and comments are preserved, and a file that does not parse is reported instead of overwritten.

## Where the data lives

One SQLite database at `$PASEO_HOME/plugins/luck-planner/luck-planner.db` (falling back to `~/.paseo`). It holds the tree, the links, the incidents, the goals, the growth records and the append-only history, and it survives plugin updates: the plugin's *code* is versioned under `~/.paseo/plugins/luck-planner/<revision>/`, the *data* sits next to those directories.

The dashboard serves the tree, the statistics, the node details, the theme catalog and the export download. It writes only two things — a leaf's status and a goal's approval — and those are not a general write path (see *Writes from the dashboard* below). Everything else that changes the tree goes through the MCP tools or the panel, so every write carries an actor and lands in the audit trail. Exports written by `luck_tree_export` land in `$PASEO_HOME/plugins/luck-planner/backups/` unless the caller names an absolute path — next to the database, so they survive plugin updates.

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

## Paseo 0.15.0 compatibility

Verified against the **stable Paseo 0.15.0** release (2026-11-03) — the plugin's own pass for the new version. Full evidence: [`__doc.md` §10.10](./__doc.md#1010-paseo-0150-compatibility-pass-2026-11-03).

**Verdict: compatible, but only after a mandatory migration — shipped as 0.39.8** (patch bump: a deprecated-API replacement, no new capability; tag `luck-planner@0.39.8`). 0.15.0 marks `server.before(...)` and `server.on(...)` `@deprecated` (removal after 2027-04-30) in favour of `server.addHook(...)` with renamed hooks, and this plugin used the first spelling twice: `server.before("agent.create")` → `server.addHook("agent.create.before")` and `server.before("agent.session_open")` → `server.addHook("agent.open.before")`. Payload, return value and hook bodies are unchanged, so only the registrations, the hook names in the log lines and the test doubles moved. The floor followed the API — `server.addHook` does not exist on a 0.14.0 host — so `requirements.paseo` is `>=0.15.0` and the pin `@getpaseo/plugin@^0.15.0`.

- **The SDK diff is server-side only:** four changed paths (`dist/server/index.d.ts`, `dist/server/lifecycle.d.ts`, `dist/server/lifecycle.js`, `package.json`); **`dist/client/` is byte-identical to 0.14.0**, so the panel, the settings screen, the dashboard screen, the Command Center items, the slash commands and the timeline renderer are untouched by construction.
- None of the other `@deprecated` surface is used: no `server.on` (no event hooks at all), no `client/react-native` entry (`SettingsSection` / `ExternalLink` come from `client/ui`), no `addSurface` / `addSidebarItem` / `openSurface`, no `SettingsGroup`, no deprecated `context` on the panel registration, and no `agent.turn_ended` subscription (whose `timeline` is deprecated and always empty).
- 0.15.0's host behaviour helps rather than hinders: resumed sessions after a restart (agent recovery is opt-in) reopen through `agent.open.before`, which is the path that already re-derives the audit actor and the MCP contribution, and plugin screens now keep their local state across host disconnections — the panel's `useTabState` state included.
- **One host-side finding, recorded with a proposed fix:** 0.15.0's OpenCode shared-service reuse (#7435) refuses an agent whose config carries `mcpServers` while a local OpenCode v2 service is discoverable (`Custom OpenCode MCP servers … require an isolated server …`). Since this plugin injects its MCP server into every agent, `opencode` agents cannot be created or opened on such a host; reproduced and controlled in the isolated 0.15.0 daemon, mechanism in [bunny-search §16.3](../bunny-search/__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150), plugin-side analysis, the D4 config-file workaround and the proposed guard in [`__doc.md` §10.10.4](./__doc.md#10104-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150).
- Evidence: typecheck (both configurations) + vitest **41 suites / 687 tests** against SDK 0.15.0; no `server.before(` / `server.on(` call left in the plugin; installed **from the working tree into an isolated 0.15.0 daemon** — `running`, `[paseo] Plugin ready`, 15 plugin RPCs + 3 settings methods, **zero** `Unknown lifecycle hook` errors (which is itself the proof that the host accepts both new hook names), and both hooks observed firing on a real agent creation (`MCP injected: …` and `session_open … agent.create.before …`); the published MCP entry answering `initialize` (version 0.39.8) / `tools/list` (**14 tools**); the dashboard's `/health` and an `/api/tree` that is `200` with the token and `401` without it.

**All five recommendations are implemented — shipped as 0.40.8** (second-digit bump: new capability, tag `luck-planner@0.40.8`, [`__doc.md` §10.11](./__doc.md#1011-version-0408--implementing-10105-2026-11-03)):

- **Shared OpenCode service guard.** The plugin reads the host's discovery (`PASEO_OPENCODE_SERVER_URL`, or `$XDG_STATE_HOME/opencode/service.json`) for the `opencode` provider. A discovered `2.x` service means the host would reject a custom MCP server **or a custom environment**, so both hooks contribute neither: creation is no longer refused, and the agent keeps the tree through the native `luck_tree_upsert_leaf` tool. The live check on the same host moved from "creation refused" to "agent created". Unreadable discovery data is treated as *not shared*, so a corrupt file cannot silently strip MCP from every agent.
- **Project seeding.** `worktree.create.after` (awaited, before workspace setup and agents start) plus `workspace.create.after` / `agent.create.after` create the root → `Trunk` → `General` skeleton for a project that has none, so a fresh worktree or workspace is visible in the dashboard before its first fact. Seeding is idempotent, audited under the actor `paseo`, and never throws into a creation.
- **Agent-scoped activity panel.** "Luck Planner activity" is registered with `addAgentPanel` and reads `params.agentId`; a new Command Center item (*Open this agent's luck-planner activity*, in agent context) opens it. The data is the existing audit trail sliced by actor through the new `luck-planner.agent-activity` RPC, with each row resolved to its node.
- **Registry metadata.** `name` and `media` in `paseo-plugin.json` plus a shipped `OVERVIEW.md`.

The guard also turned out to need one correction the pass could not have predicted: 0.15.0 rejects a shared-service agent for a custom **environment** as well as for custom MCP servers, and this plugin stamps `LUCK_PLANNER_AGENT_ID` for its audit actor — so the open hook skips the stamp when the service is shared and the native tool reads the actor from `context.agent.id` instead. Evidence: vitest **43 suites / 722 tests**, and on an isolated 0.15.0 daemon the guard, both seeding hooks (worktree and workspace) and the refreshed MCP entry (0.40.8, 14 tools) were observed live.

## Paseo 0.14.0 compatibility

Verified against the **stable Paseo 0.14.0** release (2026-10-29) on 2026-11-01 — the plugin's own pass for the new version. Full evidence: [`__doc.md` §10.7](./__doc.md#107-paseo-0140-compatibility-pass-2026-11-01).

**Verdict: compatible, no deprecated API.** The pass itself touched only documentation (it stayed **0.34.1**); the follow-up release **0.35.1** (2026-11-01) implements all six §10.8 recommendations and makes the 0.14.0 surface a hard requirement — the pin is `@getpaseo/plugin@^0.14.0` and `requirements.paseo` is `>=0.14.0` (the real host gate rejects an older daemon and accepts 0.14.0). **0.35.2** (patch, same day) repairs the shipped lockfile — the transitive closure of `@getpaseo/plugin@^0.14.0` had been left out of `package-lock.json`, so the manifest's `npm ci` build step failed on git installs; `npm ci` now verifies clean. Full evidence: [`__doc.md` §10.9](./__doc.md#109-version-0351--implementing-108-2026-11-01).

- None of the `@deprecated` surface `@getpaseo/plugin@0.14.0` declares is used: the UI helpers already come from `@getpaseo/plugin/client/ui` (`SettingsSection`, not the deprecated `SettingsGroup`; `ExternalLink`), the registrations are the modern screen/panel family, and the plugin never subscribes to `agent.turn_ended` (whose `timeline` is deprecated and always empty). The bare `react-native` imports are not a deprecation — the host compiler lists `react-native` as external and the SDK skill's own examples import from it.
- The floor follows the API actually used. It was `>=0.11.0` at pass time (the newest API is `addScreen` / `openScreen`, from 0.11) with an older pin; 0.35.1 adopts 0.14.0's surface (`defineAgentTool`, `agents.ref(id).reload()`, `useTabState`, the session-open `tools` map), so the pin is now `@getpaseo/plugin@^0.14.0` (lockfile updated) and `requirements.paseo` is `>=0.14.0` — the real host gate rejects an older daemon and accepts 0.14.0.
- Evidence for the pass: typecheck + vitest **37 suites / 635 tests** against SDK 0.14.0; both entries built by the **real 0.14.0 host compiler** with zero deprecated strings (a negative control restores the old `client/react-native` import and does produce the hit); `running` in an isolated 0.14.0 daemon with `[paseo] Plugin ready`, 17 RPC methods, the published MCP entry answering `initialize` / `tools/list` (11 tools), the dashboard's `/health` and a clean `paseo plugin reload`. Evidence for 0.35.1: typecheck + vitest **41 suites / 678 tests** (the new agent-record, session-open decision-matrix, agent-tool, focus and `agent-reload` suites, plus the `instructions` handshake in the real-process MCP e2e), both entries built by the real 0.14.0 host compiler with `deprecatedHits: []`, the floor gate rejecting an older daemon with the host's own message, and `running` on an isolated 0.14.0 daemon installed from the working tree with `[paseo] Plugin ready`, `MCP entry refreshed`, the dashboard on its ephemeral-port fallback and a clean reload.
- 0.14.0's idle-runtime release does not affect the plugin: the audit-actor environment is re-injected by the existing `agent.session_open` hook on every open and resume.

**Six recommendations, all implemented in 0.35.1** ([`__doc.md` §10.8](./__doc.md#108-recommendations-for-improvement-implemented-in-0351--109) for what each one was, [§10.9](./__doc.md#109-version-0351--implementing-108-2026-11-01) for what shipped): session-open MCP re-derivation in `before("agent.session_open")` — collision-checked against the daemon's own agent record, capability-probed, with D4's config-file cover keeping ownership of the surface — so it reaches existing agents and survives eviction; a native `luck_tree_upsert_leaf` fallback tool via `defineAgentTool` for providers without MCP; a "Refresh luck-planner tools on this agent" Command Center action on `agents.ref(id).reload()`; panel state through `useTabState`; deep links for the record a command just changed (through the focus mailbox — one documented deviation: 0.14.0's `openPanel` carries no params channel); and MCP `instructions` in `initialize`.

## Paseo 0.12.0 spec conformance

Verified against the **stable Paseo 0.12.0** release (2026-10-22) with the plugin SDK `@getpaseo/plugin@0.12.0`. Full evidence: [`__doc.md` §10.5](./__doc.md#105-paseo-0120-spec-conformance-0322).

**What the new version changed for this plugin:**

- The SDK diff is **additive only** for every API this plugin uses: the client declarations are byte-identical from 0.11.0 to 0.12.0, and the two changed files (the ACP and the provider declarations) cover registrations this plugin does not have. `requirements.paseo` therefore stays `>=0.11.0` — the newest API it uses is `addScreen` / `openScreen`, which arrived in 0.11.
- The plugin never used the deprecated `addSurface` / `addSidebarItem` / `openSurface`; it registers `addScreen`, `addWorkspacePanel`, `addSettingsScreen`, `addCommandCenterItem`, `addSlashCommand` and `addTimelineRenderer`. The client entry, built by the **real 0.12.0 host compiler**, contains zero deprecated calls.
- **One real spec violation was found and fixed.** The plugin read the host's `localStorage` outside `client/web.ts`, which Paseo's cross-platform rules forbid: DOM globals belong in that one module, gated on `Platform.OS === "web"`. The read moved to `client/web.ts`, the parsing to a pure module, and the spec's own client audit now runs as a test.

**Improved in 0.32.2:**

- The settings screen and the dashboard screen honour the host's compact layout (phones, narrow windows).
- The dashboard address is a real link: one tap reaches the dashboard in the system browser when the in-app tab was closed or refused.

**Verified live on a 0.12.0 daemon** (a scratch home; the production daemon untouched): the install from the working tree (`running`), `Plugin ready` in the log, a clean `paseo plugin reload`, the published MCP entry answering `initialize` / `tools/list` / `luck_tree_search`, the dashboard's `/health` and the built web app, and both entries built by the real 0.12.0 host compiler.

## Known limitations

- The 3D dashboard is **suspended** (see ["3D — suspended"](#3d--suspended)): the code stays in the repository and in the build, the toolbar's 3D button is disabled, and any `?view=3d` link opens the plain board. There is no supported way to open the scene.
- The dashboard is designed for a desktop-sized tab; the native panel is the mobile-friendly surface.
- The dashboard is served on the **daemon host's** loopback interface, so it opens on the machine that runs the daemon. With a remote daemon, the native panel still works (it speaks to the daemon over the host connection), but the dashboard URL points at the desktop's own loopback and the tab stays empty. The MCP tools and the panel are unaffected.

## License

MIT. See [LICENSE](../LICENSE).

## Plain view (default)

The dashboard opens on the **Plain** view: a card board (zones PLAN / ACTIVE / DONE) built from the same `/api/tree` payload as the 2D diagram. Clicking a card opens a modal with the full record (node, goal, or incident). The 2D view remains available in the toolbar and the choice is remembered per tab; the 3D button is disabled (suspended).
