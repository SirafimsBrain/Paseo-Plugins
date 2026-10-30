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

- Paseo `>=0.13.0` (declared in `paseo-plugin.json`). **Raised from `>=0.8.0`
  in 0.2.3**, because the panel now imports `ScrollView` and `useToast` from
  `@getpaseo/plugin/client/ui`, and that entry has carried them only since
  **0.13.0** — before that they lived in the `client/react-native` entry the
  SDK now deprecates. The floor is an API promise, not a record of the newest
  host tested: the real 0.14.0 host enforces it (the same manifest is rejected
  for a 0.12.0 daemon with `requires Paseo >=0.13.0`).
- Verified against Paseo `0.14.0` (2026-10-30, SDK `@getpaseo/plugin@^0.14.0`,
  installed with `npm install` so the lockfile carries it): `npm run typecheck`
  and `npm test` (70 tests, 8 suites) pass, both entries build with the real
  0.14.0 host compiler with zero deprecated calls, and the plugin is `running`
  in an isolated 0.14.0 daemon — see Compatibility in
  [`__doc.md`](./__doc.md) §18. Earlier: Paseo `0.13.0` / SDK 0.13.0
  (2026-10-24), Paseo `0.12.0` / SDK 0.12.0 (2026-10-21), Paseo `0.10.3` /
  SDK 0.10.1.
- At least one of the agent CLIs on the daemon host for the CLI-backed providers:
  `cline`, `opencode`, `kilo`. Qwen Code and `acpx` are read and written as files
  and need no CLI.
- `npm test` (vitest) and `npm run typecheck` run the server-side test suites;
  the tests build throwaway stores under the OS temp directory and never touch
  the real home stores.

## Paseo 0.14.0 compatibility

Verified against the **stable Paseo 0.14.0** release (2026-10-30).
Full evidence: [`__doc.md`](./__doc.md) §18. **Shipped as `0.2.3`** — the two
deprecated APIs this plugin still used in 0.13.0 are now migrated, and the
SDK pin moved to `@getpaseo/plugin@^0.14.0`.

**Deprecated in 0.13.0 and used here until now — both migrated:**

| Deprecated | Migration in 0.2.3 |
| ---------- | ------------------ |
| the `@getpaseo/plugin/client/react-native` entry point — the panel imported `ScrollView` and `useToast` from it (host exempt list `COMPAT(pluginReactNativeEntrypoint)`, **removal 2027-04-20**, together with `useRevealedText`) | one import line: both now come from `@getpaseo/plugin/client/ui`, which has exported them since 0.13.0. The compiled client bundle contains **zero** `client/react-native` references — and the same compiler run against a copy with the old import restored finds the specifier, so the scan is real. |
| `addWorkspacePanel`'s `context: "workspace"` field (`@deprecated`, "Omit context", optional since 0.13.0) | the field is **omitted**. Runtime-checked in the shipped 0.14.0 renderer: `addWorkspacePanel(e)` throws only when `context` is defined and not `"workspace"`, and normalises `undefined` to `"workspace"` — behaviour is identical. The `context: "workspace"` fields on the four `addCommandCenterItem` registrations **stay**: that contribution is a required discriminant, not a deprecated field. |

**Nothing else deprecated reaches it.** 0.14.0 adds no new `@deprecated`
marks (byte-identical to 0.13.0) and `dist/client/` did not move at all; the
plugin still registers only `addWorkspacePanel` / `addSettingsScreen` /
`addCommandCenterItem`, keeps its `localStorage` reads inside `client/web.ts`,
and registers no lifecycle hooks, so the always-empty `agent.turn_ended`
`timeline` cannot touch it.

**One documentation discrepancy, recorded:** the deployed hooks page says
`server.addHook("agent.open.before")` "is available from Paseo 0.14", but
neither the SDK nor the installed 0.14.0 host contains `addHook` — irrelevant
here (the plugin registers no hooks) but it is why nothing in this repository
migrates to `addHook`. See the root
[README](../README.md#paseo-0140--new-and-deprecated-sdk-surface-2026-10-29).

**Recommendations for improvement — implemented in 0.3.3:** the original
recommendations stay in [`__doc.md`](./__doc.md) §18.3, what was built (and
why one item was not) is in §18.5. The listing cache is now invalidated on
0.14.0's new **`agent.closed`** event instead of only ageing out after 30
seconds, a **"refresh session list"** Command Center action reopens the agent
through `agents.ref(id).reload()` and rescans with a cold cache, and the panel's
filters moved to **`useTabState`** so they survive a reload. The lighter
**"stop runtime, keep the session"** action was investigated and **cannot be
built from a plugin**: `session.can_stop_runtime` is answered inside the
provider protocol and consumed by the host's own idle-runtime cleanup, and
`PaseoApi` exposes no stop/close call — §18.5 lists the evidence. Adding
agents' own tools via `defineAgentTool` is still explicitly *not* done here:
it would offer destructive operations to agent processes.

**Verification:** typecheck clean and vitest **9 suites / 74 tests** green
against `@getpaseo/plugin@0.14.0`; both entries build with the **real 0.14.0
host compiler** (`compileDirectoryPlugin` from the installed `app.asar`) with
no boundary errors and **zero deprecated calls**; the manifest passes the real
0.14.0 parser with the new `>=0.14.0` floor (rejected for 0.13.0 and 0.13.2
— `reload()` does not exist in `@getpaseo/client@0.13.2` — accepted for
0.14.0). The live evidence belongs to the 0.2.3 compatibility pass: `running`
in an **isolated 0.14.0 daemon** (scratch home, production config untouched)
installed from the working tree — `[paseo] Plugin ready`, seven RPC methods
registered, no plugin or contribution errors in the daemon log. 0.3.3 was not
re-run live; it is covered by the unit suites and the host compiler above.

## Paseo 0.13.0 compatibility

Verified against the **stable Paseo 0.13.0** release (2026-10-24).
Full evidence: [`__doc.md`](./__doc.md) §17. **No code change was needed**,
so at that point the plugin was still `0.2.2` and `requirements.paseo` still
`>=0.8.0`. Both changed in `0.2.3`, and the floor moved again to `>=0.14.0`
in `0.3.3` — see the 0.14.0 section above.

**Deprecated in 0.13.0 and still used here (works today, deliberately not
migrated):**

| Deprecated | Status |
| ---------- | ------ |
| the `@getpaseo/plugin/client/react-native` entry point — this panel imports `ScrollView` and `useToast` from it | `@deprecated` in favour of `@getpaseo/plugin/client/ui`; the host keeps the entry in its exempt list under `COMPAT(pluginReactNativeEntrypoint)` and **removes it on 2027-04-20**, together with `useRevealedText` (unused here). The migration is one import line. |
| `addWorkspacePanel`'s `context: "workspace"` field | `@deprecated` ("Omit context") and now optional; still typechecks and is still accepted. |

**Deprecated in 0.13.0 that does not reach this plugin:** the panel
`params.agentId` / `addAgentPanel` pair (no agent panel here), the
`agent.turn_ended` `timeline`, which is now **always empty** (this plugin
registers no lifecycle hooks), `SettingsGroup` → `SettingsSection`, and
`@getpaseo/client`'s `CreateAgentRequestOptions.git` / `worktreeName`, which
`createAgent` now **rejects at runtime** (this plugin creates no agents and
declares no `@getpaseo/client` dependency).

**New in 0.13.0, not adopted (all optional):** file panels
(`addFilePanel`), agent panels (`addAgentPanel`), `useTabState`, plugin
translations (`defineTranslations` / `useTranslation` / `client.i18n` — the
plugin's English strings stay valid `PluginText`), `Markdown`,
`StreamedText`, `Loading`, `DocumentFrame`, inline-SVG and component icons,
`createWorkspace`, and `PaseoApi.hosts`. The full inventory is in the root
[README](../README.md#paseo-0130--new-and-deprecated-sdk-surface-2026-10-24).

**Verification:** typecheck clean against SDK 0.13.0, vitest **8 suites /
70 tests** pass, and both entries build with the **real 0.13.0 host
compiler** (`compilePlugin` extracted from the installed `app.asar`) with no
bundler-boundary errors; the manifest passes the real 0.13.0 parser. Live:
`running` on this machine's 0.13.0 daemon with `Plugin ready` and no plugin
errors in the daemon or app logs. The SDK was installed with `--no-save`, so
`package.json` still pins `@getpaseo/plugin@0.12.0` — the host supplies the
runtime SDK and no code needed the 0.13.0 API.

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
