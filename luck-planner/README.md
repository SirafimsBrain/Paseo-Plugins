# Luck Planner

Project planning tree for coding agents on [Paseo](https://paseo.sh/): a tech-stack root, module branches, fact leaves with statuses, influence links, blocking incidents, approved high goals and growth rates — with a 2D diagram and a 3D scene that read the same data.

Coding agents keep their plan in their own context window, and a chat log is a poor place to look up *what do we already know about this module*. Luck Planner gives a project one durable tree: the agents write it through MCP tools, a human reviews and approves it in the panel and the dashboard, and every write is audited.

## What it does

- **The tree** — five levels: the tech-stack **root**, the **trunks** (platforms), the **branches** (modules), the **side branches** and the **leaves** (the facts: a planned or confirmed piece of work). Every leaf carries a status (`draft → ready → claimed → in_progress → done`, plus `blocked`, `cancelled`, `superseded`), a version, a revision and an append-only history. The store refuses a status transition the state machine does not allow, so an agent cannot skip a step by accident.
- **Influence links (bees)** — a directed link between two leaves saying "this depends on that". In the 3D scene the bees fly along the arcs between the two leaves.
- **Incidents (bugs)** — a problem with a severity, optionally attached to the leaves it blocks. A blocking incident (`open` or `investigating`) is visible everywhere its leaves are.
- **High goals** — a formal task with a plan, created and proposed by an agent and **approved by a human**. There is deliberately no MCP action that approves a goal: the approval gate is the human's call through the panel. An approved goal materializes as a branch of the tree, and the plan's steps become the goal's growth record.
- **Growth** — the steps of a node or a goal and their state, rolled up over the subtree. The same number paints the heat map in 2D and the glow rings in 3D: one computation, two views, never two different answers.
- **MCP tools** — eight read/write tools, available to every agent in the workspace (see below).
- **Registration in the agents' own config files** — the plugin can register its MCP server directly in the config of OpenCode, Kilo, Cline, Cursor and Codex CLI, one button per agent in the settings. That matters because a session-injected server is fragile: OpenCode and Kilo keep session registrations in memory and drop them when an idle directory is evicted, and the terminal agents ignore session-delivered MCP servers altogether. A config-file entry survives the eviction and is the only way in for the latter.
- **The dashboard** — a read-only web app on the loopback interface: a 2D diagram with search, filters and a details panel, and a 3D WebGL scene of the same tree (see "The dashboard").
- **The native panel** — the tree, the filters and the details inside Paseo's workspace panel, with timeline rows for the two facts worth an audit line: a goal that crossed the approval gate, and a leaf that reached `done`.
- **Live updates** — the dashboard and the panel refresh themselves when the tree changes (an SSE stream in the dashboard, a polling RPC in the panel), so a second agent's write shows up without a reload.
- **An agent skill** — `luck-planner` teaches agents *when* to write the tree, not just which tool to call. It is a protocol, not a description: read the context before the work, write the leaf when the fact changes, never manage the tree by hand.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:luck-planner
```

The plugin needs a build step at install and update time (`npm ci` and `npm run bundle`), so the host needs npm-registry access once. The build produces two artifacts: the standalone stdio MCP server (`dist/mcp-server.js`, a single file with no runtime dependencies beyond Node's built-in `node:sqlite`) and the dashboard web app (`dist/dashboard/`, a readable, unminified ESM bundle).

The MCP server is injected into every agent created through Paseo (configurable in the settings), so agents from any provider connected to Paseo get the tools without manual configuration. The tool names are registered under the prefix `luck-planner`, so they appear as `luck-planner_luck_tree_search` and friends.

## The MCP tools

| Tool | What it does |
| ---- | ------------ |
| `luck_tree_get_context` | The "where am I / what is around" call. Without a node id: the project overview (roots and their first-level children). With one: the full path root → … → node, its children, its sibling leaves, the bees touching it, its blocking bugs and its growth progress. |
| `luck_tree_search` | FTS5 full-text search over the tree, with optional kind and status filters and an `includeArchived` switch. |
| `luck_tree_upsert_leaf` | Records a planned or confirmed fact. With a leaf id it updates that leaf (any mutable field plus an optional status transition in the same call); without one it creates a leaf under a parent. The very first leaf of a fresh project bootstraps the skeleton root → trunk → branch. |
| `luck_tree_add_bee` | A directed influence link between two leaves, with an impact description and a status. |
| `luck_tree_report_bug` | An incident with a title, a description and a severity, optionally attached to the leaves it blocks. |
| `luck_tree_set_goal` | Manages a high goal **before** the approval gate: `create` a draft, `update` a draft or proposed plan, or `propose` it for human review. There is no `approve` action — approval is the human's. |
| `luck_tree_update_growth` | Upserts the progress record of one subject (a node or a goal): the steps, their state and the record's own status. |
| `luck_tree_history` | The append-only audit trail of one entity: who changed what, when and from which revision. |

Every call carries a `projectKey`, and the store scopes every read and write by it — a tool call can never reach across a project boundary. `actor` is optional and falls back to the id the MCP server was launched with, so the audit trail is never empty.

## The dashboard

The dashboard is a standalone web app the plugin serves over loopback HTTP (`http://127.0.0.1:8899` by default, the port is configurable) and opens in Paseo's own browser — from the workspace panel's **Open dashboard** button or from the ⌘K item. The access token travels in the query string, because a browser navigation cannot attach an `Authorization` header; with no token configured the plugin generates a random one per plugin session.

**2D — the diagram.** The tree is laid out left to right (root → trunks → branches → leaves), with the goal frames drawn behind the subtree a goal materialized, the bee links as coloured edges, the incident badges on the blocking leaves and the growth bars under the nodes. Clicking a node fills the details panel with its version, revision, status, incidents, influence links, children and history; the edges around the selection and the leaves sharing an incident with it are emphasized. The toolbar search runs a full-text query, clears whatever would hide the best hit and flies the camera to it; the kind, status and version filters narrow the diagram, and the **Growth heat** layer repaints the same tree by the rolled-up growth ratio.

**3D — the scene.** The same payload in a WebGL scene: the tree becomes a radial cone (depth is height, siblings fan around the trunk axis), the leaves are billboarded sprites, the bees fly along curved arcs between the leaves, the blocking incidents pulse above the leaves they block, an approved goal floats as a ring over its subtree and the growth glows as rings in the growth layer. A click picks a node and fills the **same** details panel the 2D diagram fills; the selection shows the nodes sharing an incident with it and draws its influence links as curves; a search flies the camera to the node it found. The 2D/3D choice is remembered in the URL and in the tab, so a copied link opens in the diagram the sender was looking at.

The 3D view needs a real WebGL context. A tab without one (a workspace browser started with `--disable-webgl`, a phone client, a blocked driver) keeps the 2D diagram and says why in the status line — it never shows a black viewport. The 3D scene is a separate lazy bundle, so the 2D dashboard stays small and the WebGL libraries are only downloaded when 3D is actually opened.

## The workspace panel, Command Center and slash commands

- **Workspace panel** — the tree as an outline (roots with their children), counters, a full-text search, filters by kind and status, the details of the selected node, and the button that opens the dashboard.
- **Command Center / ⌘K** — *Open luck-planner tree*, *Open luck-planner dashboard* and *New high goal* (the goal is created as a draft and waits for the approval gate).
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

The settings screen has one more section, **Agent config files**: it shows whether the plugin is registered in the config of OpenCode, Kilo, Cline, Cursor and Codex CLI, and offers a button per agent (plus one for all of them). The plugin never writes those files by itself — they change the behaviour of every session of that agent on the machine, so the decision stays yours. Foreign keys, other servers, tables and comments are preserved, and a file that does not parse is reported instead of overwritten.

## Where the data lives

One SQLite database at `$PASEO_HOME/plugins/luck-planner/luck-planner.db` (falling back to `~/.paseo`). It holds the tree, the links, the incidents, the goals, the growth records and the append-only history, and it survives plugin updates: the plugin's *code* is versioned under `~/.paseo/plugins/luck-planner/<revision>/`, the *data* sits next to those directories.

The dashboard is read-only: it serves the tree, the statistics and the node details, and it never writes. Everything that changes the tree goes through the MCP tools or the panel, so every write carries an actor and lands in the audit trail.

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

The source is split by boundary: `shared/` (types and schemas, client/server neutral), `server/` (the store, the MCP server, the HTTP server, the timeline), `client/` (the panel, the settings screen, the slash commands, the dashboard screen), `dashboard/` (the web app: the pure adapter in `graph.ts`, the 3D layout in `tree-3d.ts`, the 3D overlay in `overlay-3d.ts`, the 3D interaction in `pick-3d.ts` and the scene in `dashboard-3d.tsx`).

## Known limitations

- The 3D view needs WebGL; without it the tab stays on the 2D diagram and says why.
- Collapsing a branch is a 2D-canvas concern: the 3D scene always shows the whole tree (the filters narrow it in both views).
- The 3D scene picks the node nearest along the click ray, using a sphere around each node — a very thin branch tube is picked at its junction, not along its whole length.
- The dashboard is designed for a desktop-sized tab; the native panel is the mobile-friendly surface.

## License

MIT. See [LICENSE](../LICENSE).
