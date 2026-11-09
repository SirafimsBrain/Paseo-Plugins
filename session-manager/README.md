# session-manager

A Paseo plugin that lists and deletes the on-disk sessions of the coding agents
connected to Paseo, so old transcripts stop filling the disk.

## Features

- **Workspace panel** titled "Agent sessions" (available in the `workspace` and
  `explorer` panel locations).
- **Command Center item** ("Open agent sessions") that opens the panel on demand.
- **Sidebar status row** — a footer entry point ("Agent sessions") that opens a
  summary popover: session counts per provider, whole-store sizes, the number of
  sessions due for cleanup and the number that need a forced delete. The scan
  runs when the popover opens (never at app start) and reuses the server-side
  listing cache, so the panel opens on the same data.
- **One list per agent** — Cline, OpenCode, Kilo, Qwen Code, Kimi Code, and the standalone
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
| `kimi`      | `~/.kimi-code/sessions/<workDirKey>/<id>/` + `session_index.jsonl` | session directory + index entry removed from disk; export via `kimi export` (ZIP) |
| `acpx`      | `~/.acpx/sessions/index.json` + `*.json` + `*.stream.ndjson`     | record, stream and index entry removed |

Agents that expose their own session commands are driven through their CLI, so the
plugin never has to understand private database schemas. When a CLI cannot be
found the provider is reported as unavailable for deletion instead of the plugin
editing the store directly.

The server exposes five RPCs (`session-manager.list`,
`session-manager.delete`, `session-manager.delete-batch`,
`session-manager.export`, `session-manager.refresh`) implemented in `server/`
and consumed by the client panel and the sidebar status row. The row adds no
RPC of its own: it reads `session-manager.list` and derives its counts with
`shared/session-summary.ts`, the same module the panel's cleanup hint uses.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:session-manager
```

The plugin is installed into the Paseo home and runs from there:
`~/.paseo/plugins/session-manager/<revision>/checkout/session-manager`. Every
import in this plugin is supplied by Paseo itself, so it has no install-time
build step and no registry access requirement — the command above is the whole
installation. Updates: `paseo plugin update session-manager`.

## Requirements

- Paseo `>=0.15.0` (declared in `paseo-plugin.json`). The floor is an API
  promise, not a record of the newest host tested: the plugin registers its
  lifecycle hook with `server.addHook`, which only exists from 0.15.0, and the
  panel imports `ScrollView` / `useToast` from `@getpaseo/plugin/client/ui`.
  The real host enforces it (a manifest with a higher floor is rejected by
  `assertPluginCompatibility` before the plugin loads).
- Verified against Paseo `0.15.0` (2026-11-03, SDK `@getpaseo/plugin@^0.15.0`,
  installed with `npm install` so the lockfile carries it): the plugin is
  `running` in an isolated 0.15.0 daemon and the `agent.close.after` hook fires
  on the real daemon. As of 0.5.0 (2026-11-09) `npm run typecheck` and
  `npm test` (11 suites / 94 tests) pass. Earlier: Paseo `0.12.0` /
  SDK 0.12.0 (2026-10-21), Paseo `0.10.3` / SDK 0.10.1. See
  [__compatibility.md](./__compatibility.md).
- At least one of the agent CLIs on the daemon host for the CLI-backed providers:
  `cline`, `opencode`, `kilo`. Qwen Code, Kimi Code and `acpx` are read and
  written as files and need no CLI for listing or deletion (Kimi only needs its
  CLI for `kimi export`).
- `npm test` (vitest) and `npm run typecheck` run the server-side test suites;
  the tests build throwaway stores under the OS temp directory and stub every
  provider adapter, so a run never touches the real home stores and never spawns
  a vendor CLI.

## Compatibility

Paseo **0.15.0 (2026-11-03)** verified, `requirements.paseo >=0.15.0`, SDK `@getpaseo/plugin ^0.15.0` — compatible after migration to `server.addHook("agent.close.after")` (0.3.4). Current plugin version: **0.5.0** (Kimi Code provider since 0.4.0; sidebar status row since 0.5.0).

Full detail: [__compatibility.md](./__compatibility.md); technical evidence: [`__doc.md`](./__doc.md) (Compatibility sections).
