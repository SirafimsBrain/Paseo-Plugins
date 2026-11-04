Luck Planner gives a project a durable planning tree that coding agents maintain
while they work, and gives the human a place to see it.

## What it does

The tree has a fixed shape: a technical root, module branches, and leaves that
record facts with a status. Three layers sit on top of it — bees (influence
links between facts), incidents (bugs that block specific leaves) and high goals
(a formal plan plus steps, which only a human can approve). Every change is
written to an append-only audit trail that names the agent or person who made
it.

Two surfaces show the same data. The **workspace panel** is the outline: filters,
full-text search, counters, and a details view with status moves and the audit
history of each record. The **dashboard** runs on the daemon host's loopback and
offers two views of the same tree: a plain card board (the default) and an
interactive 2D diagram. A third, 3D view exists in the source but is
**suspended**: its development is stopped for lack of resources while the plain
and 2D views are the focus, and the toolbar's 3D button is disabled. A fourth
surface lists, for one agent, the audit rows that agent wrote.

Agents reach the tree through a bundled MCP server: `luck_tree_get_context`,
`luck_tree_search`, `luck_tree_upsert_node`, `luck_tree_upsert_leaf`,
`luck_tree_move_node`, `luck_tree_archive_node`, `luck_tree_add_bee`,
`luck_tree_report_bug`, `luck_tree_find_bugs`, `luck_tree_find_goals`,
`luck_tree_approve_goal`, `luck_tree_set_goal`, `luck_tree_update_growth` and
`luck_tree_history`. A written skill, installed into the skills directories that
already exist on the host, explains when to write and what to leave out.

## How it works

The plugin contributes a server entry and a client entry. The server entry owns
one SQLite database, publishes the bundled stdio MCP server at a stable path,
injects that server into agents as they are created, and re-derives the
contribution whenever an agent's session opens — which is what reaches agents
that were created before the plugin was installed. Where a provider cannot carry
MCP servers, a single native tool (`luck_tree_upsert_leaf`) is attached to the
session instead, so the loop survives on every provider.

The client entry registers the panel, the dashboard screen, the settings screen,
the Command Center items, the slash commands and a renderer for the plugin's own
timeline rows.

A newly created worktree, workspace or agent seeds the minimal tree (root, trunk,
one `General` branch) so a fresh project is visible before its first fact, and
seeding never duplicates a tree that already exists.

## Setup

Install the plugin on the daemon and enable plugins if the host asks. No
account, token or external service is required. The settings screen exposes the
behaviour:

- inject the MCP server into agents created through Paseo;
- the server name agents see;
- whether the dashboard HTTP server runs, on which port, and with which access
  token;
- how long the audit trail is kept.

The settings screen also offers a one-time registration of the MCP server in the
config files of OpenCode, Kilo, Cline, Cursor, Qwen Code and Codex CLI. The plugin
never writes those files on its own; the decision stays with the user.

Requirements: Paseo 0.15.0 or later, and Node 24 or later on the daemon host (the
plugin uses the built-in `node:sqlite` with FTS5). Linux is the supported
platform; macOS and Windows are planned but not verified. The plugin runs no
downloads and installs no software while running.

On a host where the OpenCode provider reuses a running OpenCode v2 service, the
plugin deliberately contributes no MCP server to `opencode` agents — the host
rejects custom MCP servers in that mode — and relies on the native tool instead.

## Data and limitations

Everything lives on the daemon host: one SQLite database under the Paseo home
directory holds the tree, the links, the incidents, the goals, the growth
records and the audit trail. The plugin sends nothing to any external service;
the facts an agent records reach that agent's own provider in the same way the
rest of its conversation does.

The dashboard is read-only and bound to the host's loopback interface, so it
opens on the machine that runs the daemon; a remote daemon still works through
the native panel. The 3D view is suspended: its code stays in the repository,
its toolbar button is disabled, and the plain board and the 2D diagram are the
supported views. The dashboard is designed for a desktop-sized tab; the native
panel is the mobile-friendly surface.
