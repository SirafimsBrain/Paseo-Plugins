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

- Paseo `>=0.8.0` (declared in `paseo-plugin.json`). **Deliberately not
  raised:** this plugin contributes a workspace panel, a settings screen and
  Command Center items — none of the 0.11+ screen/sidebar API — so the floor
  stays where the APIs actually reach. Only the SDK pin moved to 0.12.0.
- Verified against Paseo `0.12.0` (2026-10-21, SDK `@getpaseo/plugin@0.12.0`):
  `npm run typecheck` and `npm test` (70 tests, 8 suites) pass; see
  Compatibility in [`__doc.md`](./__doc.md). Earlier: Paseo 0.10.3 against
  SDK 0.10.1.
- At least one of the agent CLIs on the daemon host for the CLI-backed providers:
  `cline`, `opencode`, `kilo`. Qwen Code and `acpx` are read and written as files
  and need no CLI.
- `npm test` (vitest) and `npm run typecheck` run the server-side test suites;
  the tests build throwaway stores under the OS temp directory and never touch
  the real home stores.

## Paseo 0.12.0 spec conformance

Verified against the **stable Paseo 0.12.0** release (2026-10-21).
Full evidence: [`__doc.md`](./__doc.md) §16.

**This plugin needed no API migration.** It contributes a workspace panel
(`addWorkspacePanel`), a settings screen (`addSettingsScreen`) and Command
Center items (`addCommandCenterItem` with `openPanel`/`openSettings`) — none
of which are deprecated in 0.12.0 — so it never used `addSurface`,
`addSidebarItem` or `openSurface`. The SDK diff `@getpaseo/plugin@0.10.1 →
0.12.0` is **additive only** for everything it calls, and the `0.11.0 → 0.12.0`
declarations are byte-identical.

**`requirements.paseo` stays `>=0.8.0` on purpose.** Raising the floor is only
honest when a plugin adopts a newer API; this one adopts none, so a 0.10.x
host can still run it. The SDK pin moved to `@getpaseo/plugin@0.12.0` for
typecheck/tests, and 0.12.0 was the release verified.

**One real spec violation found and fixed.** 0.12.0's client audit treats a
cross-platform module touching a DOM global outside `client/web.ts` as a bug.
This plugin had **two** such sites — more than any other plugin here:

| Site | Fix |
| ---- | --- |
| `client/use-host-typography.ts` read `globalThis.localStorage` | now calls `readHostTypography()` from the new `client/web.ts` |
| `client/session-manager-panel.tsx` read `globalThis.localStorage` inline in its `styles` memo | same call, same module |

`client/web.ts` is gated on `Platform.OS === "web"` and returns `null` on
native so callers fall back to defaults. The audit is clean after the change.

**A previously documented date was wrong:** earlier notes said the host's
compatibility shims were "scheduled for removal after **2027-03-29**". That
date belongs to unrelated `COMPAT(...)` markers in 0.12.0
(`codexFastPreference`, `pluginProviderLaunch`); the surface/sidebar shims
carry no removal marker and the SDK tags state no version. It made no
difference to this plugin (it uses none of those APIs) but the claim is
corrected everywhere it appeared.

**Verification:** typecheck clean against SDK 0.12.0, vitest **8 suites /
70 tests** pass, the DOM-global audit is clean, and no deprecated
registrations exist. Live-verified on a real 0.12.0 daemon in an
isolated home: installs as `running`, logs `Plugin ready`, reloads
cleanly (`paseo plugin reload`, the fixed #6306 flow), and the real
0.12.0 host compiler builds the client entry (neither the deprecated
nor the new contribution API is used, as designed).

Still open, all optional and none conformance blockers:

1. **Host-managed processes** — `spawnProcess` / `terminateProcess` /
   `execCommand` in `server/exec.ts`, for Windows `.cmd`/`.bat` launching
   and host-owned process lifecycle.
2. **`agent.closed` lifecycle event** — invalidate the 30-second listing
   cache and refresh the "due for cleanup" hint the moment an agent closes.
3. **Extra sidebar entry points** — `addSidebarFooterItem` and multi-row
   `SidebarRow`/`SidebarSeparator`. New capability → second-digit bump.

For the full technical description see [`__doc.md`](./__doc.md).
