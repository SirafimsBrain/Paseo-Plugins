# session-manager

A Paseo plugin that lists and deletes the on-disk sessions of the coding agents
connected to Paseo, so old transcripts stop filling the disk.

## Features

- **Workspace panel** titled "Agent sessions" (available in the `workspace` and
  `explorer` panel locations).
- **Command Center item** ("Open agent sessions") that opens the panel on demand.
- **One list per agent** — Cline, OpenCode, Kilo, Qwen Code, and the standalone
  `acpx` ACP store are scanned in one pass and labelled per provider.
- **Filtering** — by provider and by age (`> 1 day`, `> 7 days`, `> 30 days`).
- **Deletion** — single session or a multi-select batch, with a two-step confirm
  and toast feedback. Sizes are shown when the store exposes them.
- **Safety guards** — running sessions and sessions referenced by an open Paseo
  agent are refused unless you explicitly confirm the force delete.
- **Extensible** — a new coding agent means one adapter file plus one line in the
  provider registry.

## How it works

Each agent keeps its own session store, so the plugin talks to each store its own
way (see [`__doc.md`](./__doc.md) for the verified paths):

| Provider    | Store                                                            | Delete strategy                     |
| ----------- | ---------------------------------------------------------------- | ----------------------------------- |
| `cline`     | `~/.cline/data/sessions/<id>/` + `~/.cline/data/db/sessions.db`   | `cline history delete --session-id` |
| `opencode`  | `~/.local/share/opencode/opencode.db`                            | `opencode session delete <id>`      |
| `kilo`      | `~/.local/share/kilo/kilo.db`                                    | `kilo session delete <id>`          |
| `qwen-code` | `~/.qwen/projects/<project>/chats/<id>.jsonl`                    | transcript (+ `plans`, `todos`) removed from disk |
| `acpx`      | `~/.acpx/sessions/index.json` + `*.json` + `*.stream.ndjson`     | record, stream and index entry removed |

Agents that expose their own session commands are driven through their CLI, so the
plugin never has to understand private database schemas. When a CLI cannot be
found the provider is reported as unavailable for deletion instead of the plugin
editing the store directly.

The server exposes three RPCs (`session-manager.list`, `session-manager.delete`,
`session-manager.delete-batch`) implemented in `server/` and consumed by the
client panel.

## Requirements

- Paseo `>=0.8.0` (declared in `paseo-plugin.json`).
- At least one of the agent CLIs on the daemon host for the CLI-backed providers:
  `cline`, `opencode`, `kilo`. Qwen Code and `acpx` are read and written as files
  and need no CLI.

For the full technical description see [`__doc.md`](./__doc.md).
