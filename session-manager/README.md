# session-manager

A Paseo plugin that lists and deletes the on-disk sessions of the coding agents
connected to Paseo, so old transcripts stop filling the disk.

## Features

- **Workspace panel** titled "Agent sessions" (available in the `workspace` and
  `explorer` panel locations).
- **Command Center item** ("Open agent sessions") that opens the panel on demand.
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

- Paseo `>=0.15.0` (declared in `paseo-plugin.json`). The floor is an API
  promise, not a record of the newest host tested: the plugin registers its
  lifecycle hook with `server.addHook`, which only exists from 0.15.0, and the
  panel imports `ScrollView` / `useToast` from `@getpaseo/plugin/client/ui`.
  The real host enforces it (a manifest with a higher floor is rejected by
  `assertPluginCompatibility` before the plugin loads).
- Verified against Paseo `0.15.0` (2026-11-03, SDK `@getpaseo/plugin@^0.15.0`,
  installed with `npm install` so the lockfile carries it): `npm run typecheck`
  and `npm test` (10 suites / 85 tests) pass, the `agent.close.after` hook fires
  on the real daemon, and the plugin is `running` in an isolated 0.15.0 daemon —
  see Compatibility in [`__doc.md`](./__doc.md) §19. Earlier: Paseo `0.12.0` /
  SDK 0.12.0 (2026-10-21), Paseo `0.10.3` / SDK 0.10.1.
- At least one of the agent CLIs on the daemon host for the CLI-backed providers:
  `cline`, `opencode`, `kilo`. Qwen Code, Kimi Code and `acpx` are read and
  written as files and need no CLI for listing or deletion (Kimi only needs its
  CLI for `kimi export`).
- `npm test` (vitest) and `npm run typecheck` run the server-side test suites;
  the tests build throwaway stores under the OS temp directory and never touch
  the real home stores.

## Paseo 0.15.0 compatibility

Verified against the **stable Paseo 0.15.0** release (2026-11-03).
Full evidence: [`__doc.md`](./__doc.md) §19. **Compatible after a mandatory
migration — shipped as `0.3.4`**, with `requirements.paseo` `>=0.14.0` →
`>=0.15.0` and the SDK pin `^0.14.0` → `^0.15.0`.

**Deprecated in 0.15.0 and used here — migrated:**

| Deprecated (`@deprecated`, removal after **2027-04-30**) | Migration in 0.3.4 |
| ---------- | ------------------ |
| `server.on(...)` | `server.addHook("agent.close.after", async (event) => …)` — the 0.15.0 rename of `agent.closed`. Same payload (`{ agent }`), same body (`invalidateListing()` + one log line); the handler became `async` only because `HookHandlers` is typed to return a `Promise`. |
| `server.before(...)` | not used by this plugin (it registers no request hooks), listed because it carries the same deprecation mark. |

The legacy spelling still works on 0.15.0 — the SDK maps it through
`legacyEvents` — so this is a deprecation-driven migration, not a breakage.
`addHook` exists on the shipped host: the installed `app.asar` builds the
plugin `server` object with `createLifecycleRegistration(...)` from
`@getpaseo/plugin/internal/lifecycle`. Because `addHook` does not exist on a
0.14.0 host, the manifest floor had to move with it.

**Nothing else changed for this plugin.** The 0.14.0 → 0.15.0 SDK diff is
server-only (`dist/server/lifecycle.*`, `dist/server/index.d.ts`,
`package.json`); **`dist/client/` is byte-identical**, so the panel,
settings screen, four Command Center items, `useTabState` filters and the
`client/ui` imports are untouched by construction. The plugin is unaffected
by the OpenCode shared-service finding in
[bunny-search](../bunny-search/README.md) — it injects no MCP servers.

**Recommendation 1 of §19.3 is implemented — shipped as `0.3.5`:** the listing
cache is now dropped on archiving too. `agent.archive.after` and
`workspace.archive.after` are registered next to the close hook and call the
same `invalidateListing()`, so an archived agent or workspace stops being
served from the 30-second cache with its stale "still running" / "due for
cleanup" hints. Existing functionality hardened → patch bump; the floor and
the SDK pin do not move. Also verified live on an isolated 0.15.0 daemon
(`paseo workspace archive` → `workspace archived (…): listing cache
invalidated`, `paseo archive <agent>` → `agent archived (…): listing cache
invalidated`); details and evidence table in [`__doc.md`](./__doc.md) §19.5.

**Recorded, not scheduled:** [`__doc.md`](./__doc.md) §19.3 — moving the
provider adapters that shell out onto `spawnProcess` / `terminateProcess` stays
a **long-term prospect**: its benefits (`.cmd` / `.bat` resolution, a
host-owned process tree) are Windows-shaped, and Windows support is not a
priority for this plugin right now — `node:child_process` is legal in `server/`
and works on the macOS / Linux hosts in use. An `addSidebarFooterItem` status
row remains an open idea as well.

**Verification:** typecheck clean (`tsc --noEmit`) and vitest **9 suites / 77
tests** green against `@getpaseo/plugin@^0.15.0` (74 at the 0.3.4 pass; 0.3.5
added the three archive-hook tests), no `server.on(` /
`server.before(` call left in the plugin, and **live on the real 0.15.0
daemon**: installed from the working tree into an isolated scratch home,
`running` with `[paseo] Plugin ready`, zero `Unknown lifecycle hook` errors —
and the hook proven to fire on a real agent stop and a real delete
(`[session-manager] agent closed (<id>): listing cache invalidated`).

## Paseo 0.14.0 compatibility

Verified against the **stable Paseo 0.14.0** release (2026-10-30).
Full evidence: [`__doc.md`](./__doc.md) §18. **Shipped as `0.2.3`** — the two
deprecated APIs this plugin still used are now migrated, and the
SDK pin moved to `@getpaseo/plugin@^0.14.0`.

**Deprecated by Paseo and used here until then — both migrated:**

| Deprecated | Migration in 0.2.3 |
| ---------- | ------------------ |
| the `@getpaseo/plugin/client/react-native` entry point — the panel imported `ScrollView` and `useToast` from it (host exempt list `COMPAT(pluginReactNativeEntrypoint)`, **removal 2027-04-20**, together with `useRevealedText`) | one import line: both now come from `@getpaseo/plugin/client/ui`, which exports them. The compiled client bundle contains **zero** `client/react-native` references — and the same compiler run against a copy with the old import restored finds the specifier, so the scan is real. |
| `addWorkspacePanel`'s `context: "workspace"` field (`@deprecated`, "Omit context", optional) | the field is **omitted**. Runtime-checked in the shipped 0.14.0 renderer: `addWorkspacePanel(e)` throws only when `context` is defined and not `"workspace"`, and normalises `undefined` to `"workspace"` — behaviour is identical. The `context: "workspace"` fields on the four `addCommandCenterItem` registrations **stay**: that contribution is a required discriminant, not a deprecated field. |

**Nothing else deprecated reaches it.** 0.14.0 adds no new `@deprecated`
marks and `dist/client/` did not move at all; the
plugin registers `addWorkspacePanel` / `addSettingsScreen` /
`addCommandCenterItem`, keeps its `localStorage` reads inside `client/web.ts`,
and — since 0.3.3 — exactly one lifecycle hook, which is a close event and not
a turn event, so the always-empty `agent.turn_ended` `timeline` cannot touch
it. (That hook is itself migrated in the 0.15.0 section below.)

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
0.14.0 parser with the new `>=0.14.0` floor (an older daemon is rejected,
because `reload()` did not exist in `@getpaseo/client` before 0.14.0). The live evidence belongs to the 0.2.3 compatibility pass: `running`
in an **isolated 0.14.0 daemon** (scratch home, production config untouched)
installed from the working tree — `[paseo] Plugin ready`, seven RPC methods
registered, no plugin or contribution errors in the daemon log. 0.3.3 was not
re-run live; it is covered by the unit suites and the host compiler above.

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
