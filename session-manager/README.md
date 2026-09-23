# session-manager

A Paseo plugin that lists and deletes the on-disk sessions of the coding agents
connected to Paseo, so old transcripts stop filling the disk.

## Features

- **Workspace panel** titled "Agent sessions" (available in the `workspace` and
  `explorer` panel locations).
- **Command Center item** ("Open agent sessions") that opens the panel on demand.
- **One list per agent** — Cline, OpenCode, Kilo, Qwen Code, and the standalone
  `acpx` ACP store are scanned in one pass and labelled per provider.
- **Filtering** — by provider and by age (`> 1 day`, `> 7 days`, `> 30 days`),
  with an "Archived Paseo agents" view and an oldest-first default order.
- **Deletion** — single session or a multi-select batch, with a two-step confirm,
  a batch preview (counts, expected freed space, risky items), live progress,
  and toast feedback. Sizes are shown when the store exposes them; otherwise
  the row says "size unknown" and the provider's whole store size is shown.
- **Export before delete** — one transcript copy per session
  (`$PASEO_HOME/session-manager-exports`), from a row button or from the
  confirmation block.
- **Safety guards** — running sessions and sessions referenced by an open Paseo
  agent are refused unless you explicitly confirm the force delete.
- **Cleanup hints and shortcuts** — host-scoped settings drive a "due for
  cleanup" hint, default order, and export defaults; Command Center items open
  the panel pre-filtered ("older than 30 days", archived sessions, settings).
- **Extensible** — a new coding agent means one adapter file plus one line in the
  provider registry.
- **Host typography** — panel text sizes follow the interface text size from
  Paseo's Settings → Appearance, and a configured interface font is applied to
  panel text.

## How it works

Each agent keeps its own session store, so the plugin talks to each store its own
way (see [`__doc.md`](./__doc.md) for the verified paths):

| Provider    | Store                                                            | Delete strategy                     |
| ----------- | ---------------------------------------------------------------- | ----------------------------------- |
| `cline`     | `~/.cline/data/sessions/<id>/` + `~/.cline/data/db/sessions.db`   | `cline history delete --session-id` |
| `opencode`  | `~/.local/share/opencode/opencode.db`                            | `opencode session delete <id>`      |
| `kilo`      | `~/.local/share/kilo/kilo.db`                                    | `kilo session delete <id>`          |
| `qwen-code` | `~/.qwen/projects/<project>/chats/<id>.jsonl`                    | transcript (+ `plans`, `todos`, `file-history`) removed from disk |
| `acpx`      | `~/.acpx/sessions/index.json` + `*.json` + `*.stream.ndjson`     | record, stream and index entry removed |

Agents that expose their own session commands are driven through their CLI, so the
plugin never has to understand private database schemas. When a CLI cannot be
found the provider is reported as unavailable for deletion instead of the plugin
editing the store directly.

The server exposes four RPCs (`session-manager.list`,
`session-manager.delete`, `session-manager.delete-batch`,
`session-manager.export`) implemented in `server/` and consumed by the
client panel.

## Requirements

- Paseo `>=0.8.0` (declared in `paseo-plugin.json`).
- Verified against Paseo `0.9.0` (2026-09-22, SDK `@getpaseo/plugin@0.9.0`):
  `npm run typecheck` and `npm test` (70 tests, 8 suites) pass with no code
  changes; the 0.9.0 plugin changes are additive for every API this plugin
  uses (see Compatibility in [`__doc.md`](./__doc.md)).
- At least one of the agent CLIs on the daemon host for the CLI-backed providers:
  `cline`, `opencode`, `kilo`. Qwen Code and `acpx` are read and written as files
  and need no CLI.
- `npm test` (vitest) and `npm run typecheck` run the server-side test suites;
  the tests build throwaway stores under the OS temp directory and never touch
  the real home stores.

For the full technical description see [`__doc.md`](./__doc.md).
