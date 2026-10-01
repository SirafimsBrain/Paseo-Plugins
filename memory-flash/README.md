# Memory Flash

Shared persistent memory for coding agents on [Paseo](https://paseo.sh/): a local MCP server backed by SQLite that every agent (Cline, OpenCode, Kilo, Qwen Code, Codex, …) can read and write, plus a full management surface inside Paseo.

Paseo orchestrates agents and passes prompts, but it does not provide durable shared memory between agents. Memory Flash closes that gap: decisions, procedures, handoffs, bugfix notes, working patterns and pitfalls are stored in one tagged, searchable database that all agents share — across agents, projects and sessions.

## What it does

- **Local MCP server (stdio)** — implements the MCP protocol (`initialize`, `tools/list`, `tools/call`) over JSON-RPC on stdin/stdout. Spawned by each agent process; all processes share one SQLite database in WAL mode.
- **Runs with the Paseo server** — the plugin lives inside the Paseo plugin host process, which also serves the management UI and injects the MCP server into agents.
- **MCP tools** — `memory_save`, `memory_search` (FTS5 full-text with snippets), `memory_get`, `memory_update`, `memory_delete`, `memory_list_by_tag`, `memory_handoff`, `memory_stats`.
- **Mandatory tagging** — every memory carries normalized lowercase tags: agent id, project name, topic, and a kind (`decision`, `procedure`, `handoff`, `bugfix`, `pattern`, `pitfall`, `reference`, `note`). Tags are the cross-agent index; search composes text AND tags AND kind AND project.
- **Automatic MCP injection** — via the Paseo `agent.create` before-hook the MCP server is added to every agent created through Paseo (configurable, on by default). Agents from any provider connected to Paseo get the same memory without manual configuration.
- **Direct MCP registration for Cline, Cursor and Codex CLI** — these agents ignore stdio MCP servers delivered through the agent session and read them from their own config files (`~/.cline/data/settings/cline_mcp_settings.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`). The plugin registers the server there directly: per-agent Register/Re-register/Remove buttons, a *Register for all local agent configs* one-click button, preservation of every other server in each file, and atomic writes. The Cline status also runs a live spawn check (real MCP `initialize` handshake against the registered command) and warns when the registered command does not answer.
- **Agent skill** — a standard `SKILL.md` (when to search, when to save, tagging rules, handoff discipline, conservative deletion policy) with mandatory recording rules: every bugfix is saved (symptom, root cause, fix, verification), positive results that worked are saved as `pattern`, and the knowledge base is updated (`memory_update`) whenever functionality changes or a bugfix alters behavior — all in English for cross-agent unification. Installed with one click from the plugin settings into `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.qwen/skills`, `~/.cline/skills` and `~/.kilo/skills` (per-target Install/Update/Remove buttons + *Install into all agents*).
- **Management surface inside Paseo** (sidebar item + ⌘K) — browse and filter memories (kind chips, tag chips), full-text search with highlighted snippets, create/edit/delete with a live editor, per-memory revision history with one-click restore, statistics (totals, by kind/agent/project, top tags, database size).
- **Delegate maintenance to an agent** — the History & tasks tab composes a careful instruction (prefer update over delete, list before deleting, keep changes minimal) and sends it to a running agent picked from the live Paseo agent list; the agent then edits the database through its MCP tools.
- **Remote hosts** — register remote machines running the Paseo server over the standard Paseo SSH transport and check reachability (the remote memory database path is reported). TCP and relay transports are stubs reserved for future work.
- **SQLite everywhere** — single-file database at `$PASEO_HOME/plugins/memory-flash/memory.db` (respects `PASEO_HOME`), WAL mode, FTS5 with porter/unicode61 tokenization, triggers keeping the index in sync, per-memory revision history, atomic settings/hosts files.

## Install

```bash
paseo plugin add /path/to/memory-flash
```

Requires Paseo ≥ 0.10.0 (verified against 0.10.2; uses the plugin SDK 0.10 settings screens, lifecycle hooks and MCP config types). Node ≥ 24 runs on the daemon host (built-in `node:sqlite` with FTS5).

After install: open **Settings → Plugins → Memory Flash** and press **Install into all agents** to place the skill where your agents look for it. The MCP server is injected into new agents automatically. For Cline, Cursor and Codex CLI, additionally press **Register for all local agent configs** (these agents do not pick up stdio MCP servers from the agent session — they need their own config entries, which the button writes for you). The Cline row also shows a live spawn check of the registered command.

The manifest `build` step (`paseo-plugin.json`, an argv array: `[["npm", "run", "bundle"]]`) is executed by the daemon on every plugin load, so `dist/mcp-server.js` is regenerated automatically and MCP-server changes reach agents without a manual rebundle.

## Development

```bash
npm install
npm run bundle   # dist/mcp-server.js — standalone stdio server (esbuild)
npm test         # vitest: store, tools, protocol, skill/hosts, agent MCP registration, live spawn probe, e2e over stdio
npm run typecheck
```

Working with an installed plugin:

```bash
paseo plugin logs memory-flash                 # includes the `[memory-flash] MCP injected: … (entry exists|MISSING)` diagnostic
paseo plugin disable memory-flash && paseo plugin enable memory-flash   # reload (`paseo plugin reload` currently fails manifest validation on the daemon side)
```

Storage layout on the daemon host:

```
$PASEO_HOME/plugins/memory-flash/
├── memory.db      # the shared memory (SQLite, WAL; -wal/-shm sidecars)
├── settings.json  # host-scoped plugin settings (written by the host)
└── hosts.json     # remote host registry
```

Skill folder (`SKILL.md`) is copied into each agent family's skills directory.

Technical details, design decisions, alternatives considered, limitations and the roadmap: see [__doc.md](./__doc.md).
