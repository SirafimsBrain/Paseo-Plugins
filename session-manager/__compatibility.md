# Compatibility — session-manager

Current: plugin **0.4.0**, `requirements.paseo >=0.15.0`, `@getpaseo/plugin ^0.15.0`.

This file holds the extended compatibility information that no longer lives in the root `README.md` (which keeps only the main verdict) or in this plugin's `README.md`. Technical evidence stays in [`__doc.md`](./__doc.md).

## Summary (former root README row)

| [session-manager](./README.md) | **0.15.0 (2026-11-03)** ⁵, **0.14.0 (2026-10-30)** ² | `@getpaseo/plugin@^0.15.0` (pin `^0.15.0`, `requirements.paseo >=0.15.0`) | **0.15.0: compatible after a mandatory migration — shipped as 0.3.4** (patch bump, tag `session-manager@0.3.4`): the plugin's single lifecycle hook moved from the `@deprecated` `server.on("agent.closed")` to `server.addHook("agent.close.after")` — same payload, same body, the handler only became `async` because `HookHandlers` is typed to return a `Promise`; the floor followed the API (`addHook` does not exist on 0.14.0) and `dist/client/` is byte-identical 0.14.0 → 0.15.0, so the panel, settings screen, four Command Center items and `useTabState` filters are untouched. It is unaffected by the OpenCode shared-service finding (it injects no MCP). Evidence: typecheck + vitest **9 suites / 74 tests** against SDK 0.15.0, no `server.on(` / `server.before(` left in the plugin, `running` in an isolated 0.15.0 daemon with `[paseo] Plugin ready`, zero `Unknown lifecycle hook` errors, and the hook proven to fire on a real agent stop and delete (`[session-manager] agent closed (<id>): listing cache invalidated`). **0.3.5** implements the first [§19.3](./__doc.md#193-recommendations-for-improvement) recommendation — the listing cache is dropped on `agent.archive.after` and `workspace.archive.after` as well, so an archived agent cannot linger with stale "still running" / "due for cleanup" hints until the 30 s TTL ages out (patch bump, tag `session-manager@0.3.5`; vitest 9 suites / 77 tests, both archive hooks observed firing on an isolated 0.15.0 daemon); the remaining recommendations stay recorded. **0.14.0: compatible, and both deprecations Paseo left in it are now migrated — shipped as 0.2.3, with §18.3's recommendations implemented the same day as 0.3.3.** The panel imports `ScrollView` / `useToast` from `@getpaseo/plugin/client/ui` instead of the `client/react-native` entry that goes away on 2027-04-20, and `addWorkspacePanel` no longer passes the `@deprecated` `context: "workspace"` field — the shipped renderer accepts `undefined` and normalises it to `"workspace"`, so behaviour is identical (verified by reading the 0.14.0 bundle, not assumed); the `context` fields on the four `addCommandCenterItem` calls stay, because there it is a required union discriminant. The floor follows the API actually used: `requirements.paseo` moved off `>=0.8.0` to the first host release whose `client/ui` exports those two symbols; the real 0.14.0 host rejects the manifest for a 0.12.0 daemon and accepts 0.14.0. Evidence: typecheck + vitest **8 suites / 70 tests** against SDK 0.14.0, both entries built by the real 0.14.0 host compiler (`compileDirectoryPlugin`) with zero deprecated calls — plus a negative control that *does* find the old specifier — and `running` in an isolated 0.14.0 daemon with `[paseo] Plugin ready` and seven RPC methods registered. **0.3.3** implements three of the four §18.3 recommendations — the listing cache is dropped on the new `agent.closed` event instead of ageing out after 30 s, a `context: "agent"` Command Center action reopens the session through the new `agents.ref(id).reload()` and rescans with a cold cache, and the panel's three filters moved to `useTabState` so they survive a reload. The fourth ("stop runtime, keep the session") was investigated and **cannot be built from a plugin**: `session.can_stop_runtime` is answered inside the provider protocol and consumed by the host's own idle-runtime cleanup, and `PaseoApi` exposes no stop/close/release call — evidence in [§18.5](./__doc.md#185-implementation-of-183-2026-10-30-shipped-as-033). Because `reload()` does not exist in the client of the release before it, the floor moved to `>=0.14.0` (the real host rejects the manifest for an older daemon and accepts 0.14.0); evidence for 0.3.3: typecheck + vitest **9 suites / 74 tests** and both entries built by the real 0.14.0 host compiler with `deprecatedHits: []`. No install-time build step. Details: [Compatibility](./__doc.md#compatibility), [§18](./__doc.md#18-paseo-0140--compatibility-pass-2026-10-30). |

## Details moved from this plugin's README.md

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


## Former root README footnotes

² The 2026-10-30 continuation of the same 0.14.0 pass, scoped to the two plugins footnote ¹ left out — **bunny-search and session-manager** (release notes as in ¹). Same method: `@getpaseo/plugin@0.14.0` unpacked from npm, installed into bunny-search with `npm install --no-save --package-lock=false` so its `package.json` / `package-lock.json` keep the `0.12.0` pin on purpose, and into session-manager with a real pin bump to `^0.14.0` (its migration needs `client/ui`'s `ScrollView` / `useToast`, which 0.12.0's typings do not have). Evidence: typecheck + vitest green against the 0.14.0 SDK — bunny-search **9 suites / 95 tests** (2 live tests skipped by default), session-manager **8 suites / 70 tests**; both entries of both plugins built by the **real 0.14.0 host compiler** (`compileDirectoryPlugin` and `readPluginManifest` extracted from the installed `app.asar`) with no boundary errors, **0 warnings** and zero deprecated calls; the floors enforced by that same host code (bunny-search accepted at 0.11.0 / 0.14.0 and rejected at 0.10.0, session-manager accepted at 0.14.0 and rejected at 0.12.0); and both installed **from the working tree into an isolated 0.14.0 daemon** — a scratch home on its own loopback port with `pluginsEnabled: true`, production home untouched — where each is `running` with `[paseo] Plugin ready`, its RPC methods registered and no plugin or contribution errors in the daemon log (bunny-search also wrote its settings mirror). One negative control: a copy of session-manager with the old `client/react-native` import restored compiles to a bundle that *does* contain the deprecated specifier, so the clean scans are meaningful. bunny-search needed no code change (stays 0.4.2, no tag); session-manager migrated the two deprecations it had carried ⇒ **0.2.3** with its annotated tag. command-center and luck-planner were not part of this pass; command-center was picked up on 2026-11-01 (footnote ³), and luck-planner keeps its earlier verdict.

⁵ The 2026-11-03 pass against the stable **0.15.0** release (2026-11-03) — release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.15.0>. Scope: **bunny-search and session-manager**, the two plugins the first task named, then **remote-control**, and then **luck-planner** (its own pass, the fourth request of the day, which also re-diffed the SDK and re-ran the live daemon checks for itself). Method: the `@getpaseo/plugin@0.14.0` and `@getpaseo/plugin@0.15.0` tarballs unpacked from npm and diffed — four changed paths only (`dist/server/index.d.ts`, `dist/server/lifecycle.d.ts`, `dist/server/lifecycle.js`, `package.json`), **`dist/client/` byte-identical** — then a real pin bump to `^0.15.0`, because the migration needs `addHook`, which 0.14.0's typings do not have. Evidence: typecheck + vitest green against `@getpaseo/plugin@0.15.0` — bunny-search **10 suites / 133 tests** (2 live-search tests skipped by default), session-manager **9 suites / 74 tests**; no `server.before(` / `server.on(` call left in either plugin; both installed **from the working tree into an isolated 0.15.0 daemon** — a scratch home under `.tmp/` on its own loopback port with `pluginsEnabled: true`, production home untouched — where each is `running` with `[paseo] Plugin ready`, **zero** `Unknown lifecycle hook` errors in the daemon log, and the migrated hooks proven to *fire*: `agent.create.before` logged `[bunny-search] MCP injected: …` on a real agent creation, `agent.open.before` logged the session-open decision on a real `paseo send`, and `agent.close.after` logged `[session-manager] agent closed (<id>): listing cache invalidated` on a real agent stop and delete. The same daemon was also used for the OpenCode finding below (plugin on / plugin off / discovery removed). One host-side problem was found and is recorded rather than fixed, because fixing it changes plugin behaviour: **#7435 makes the OpenCode provider reuse a running v2 service, and an agent carrying custom MCP servers is then rejected outright** (`Custom OpenCode MCP servers or process environment require an isolated server …`) whenever a local OpenCode service is registered — which is every agent bunny-search injects into, for the `opencode` provider only; details and the proposed plugin-side fix in [bunny-search §16.3](../bunny-search/__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150). **remote-control** joined the pass later the same day (this repository's third request), checked against the **SDK version the plugin pins for development**, which trails the runtime, so its diff spans two minor versions: `@getpaseo/plugin`'s `dist/client/` is byte-identical across them and `@getpaseo/client`'s `terminals/` declarations did not move, and it uses **no deprecated API at all** — no lifecycle hooks (`server.before` / `server.on` are simply absent; only `server.handle(...)` ×7), no deprecated client registration or option, and the one breaking type change in its range (`TerminalStreamEvent`'s `snapshot`/`restore` → `replay`) does not reach it because it never subscribes to terminal output. Evidence: typecheck (both projects) + vitest **14 suites / 137 tests** against `@getpaseo/plugin@0.15.0` installed with `--no-save --package-lock=false` (pin and floor stay put — no 0.15.0 API is needed), zero deprecated markers in both compiled bundles with a negative control, and `running` in the same isolated 0.15.0 daemon with all seven RPC methods and an end-to-end console check (`/` 200 HTML, `/health` reporting 0.24.11, `/api/*` 200 with the token and 401 without it). It therefore stays **0.24.11**, no bump and no tag — that pass is documentation only. **luck-planner** was the fourth plugin of the day: the same two tarballs diffed again (same four changed paths, `dist/client/` byte-identical), a real pin bump to `^0.15.0` because its two hooks need `addHook`, and the same isolated 0.15.0 daemon **installed from the working tree** — `running`, `[paseo] Plugin ready`, 15 plugin RPCs + 3 settings methods, **zero** `Unknown lifecycle hook` errors, and both migrated hooks proven to fire on a real agent creation (`[luck-planner] MCP injected: …` from `agent.create.before`, `[luck-planner] session_open … agent.create.before …` from `agent.open.before`); the published MCP entry answered `initialize` (0.39.8) / `tools/list` (**14 tools**) and the dashboard answered `/health` and `/api/tree` (`200` with the token, **`401`** without). Evidence: typecheck (both configurations) + vitest **41 suites / 687 tests**, no `server.before(` / `server.on(` left in the plugin ⇒ **0.39.8**, tag `luck-planner@0.39.8`. That daemon also reproduced the OpenCode shared-service finding for this plugin (injection on: creation fails; `XDG_STATE_HOME` pointed at an empty directory: creation succeeds **with** the injection applied) — analysis and the D4 config-file workaround in [luck-planner §10.10.4](../luck-planner/__doc.md#10104-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150). Its five recommendations shipped the same day as **0.40.8**, and implementing them produced two facts the pass could not have known: the host rejects a shared-service agent for a custom **environment** as well as for custom MCP servers (measured three ways on the same daemon: plugin disabled → created; guard on but env stamped → refused; guard on and no env → created), and with the create hook gated the `reason=create` open must attach the native tool or a fresh agent has no way to write. Evidence: vitest **43 suites / 722 tests**; the guard, both seeding hooks (`workspace.create.after`, `worktree.create.after`) and the rebuilt MCP entry (0.40.8, 14 tools) observed live on the same isolated daemon — [luck-planner §10.11](../luck-planner/__doc.md#1011-version-0408--implementing-10105-2026-11-03). **Recommendations recorded, not implemented:** [bunny-search §16.4](../bunny-search/__doc.md#164-recommendations-for-improvement-recorded-not-implemented), [session-manager §19.3](./__doc.md#193-recommendations-for-improvement) and [luck-planner §10.10.5](../luck-planner/__doc.md#10105-recommendations-for-improvement-recorded-not-implemented).

## Appendix — Paseo SDK surface and passes (from root README.md, shared context)

### Paseo 0.15.0 — new and deprecated SDK surface (2026-11-03)

Everything below comes from the `@getpaseo/plugin` npm tarball diffed
`0.14.0 → 0.15.0`, cross-checked against the
[0.15.0 release notes](https://github.com/getpaseo/paseo/releases/tag/v0.15.0)
and the host files inside the installed `app.asar`. Per-plugin impact is in
each plugin's `__doc.md`.

**The whole SDK diff is server-side and it is one file family:** `diff -rq`
over the two unpacked tarballs reports exactly four changed paths —
`dist/server/index.d.ts`, `dist/server/lifecycle.d.ts`,
`dist/server/lifecycle.js`, `package.json` — plus the new export path
`./internal/lifecycle`, which is what the host imports. **`dist/client/` is
byte-identical to 0.14.0**, so every client registration in this repository
(screen, sidebar, settings screen, panels, Command Center items) is untouched
by construction.

**New in 0.15.0:**

| Surface | What it gives you |
| -------- | ----------------- |
| `server.addHook(name, handler)` on `PluginLifecycleRegistration` | The supported way to register lifecycle hooks: type-safe, name-validated against `pluginHookRegistry` (anything else throws `Unknown lifecycle hook: …`), handler `(payload, context) => Promise<result>`. For request hooks the payload is still `{ request }` and the return is still the request or `void` — the same shape the old `before` handlers had, so bodies do not move. |
| `worktree.create.before` | **Awaited.** Mutates `{ repoRoot, sourceCheckout, branch, slug, path, … }` before Git fetches refs or chooses a unique branch name, so a plugin can pick the worktree location and creation options (#8117). |
| `worktree.create.after` | **Awaited**, before workspace setup and agents start (#8081). Payload `{ worktree: { path, branch, sourceCheckout } }`. |
| `PluginHooks` / `PluginHookEvents` / `PluginHookRequests` / `PluginHookPayload` / `PluginHookResult` | Typing helpers for the hook family, re-exported from `@getpaseo/plugin/server`. |
| Host behaviour that reaches plugins | Daemon restarts keep terminal programs running; interrupted agents can resume in their existing conversations behind a new **opt-in** setting (Host → Agents → *Resume agents after restart*); `.worktreeinclude` copies ignored files into new worktrees before setup; plugin screens keep their local state across temporary host disconnections (#8105); discarded messages no longer return after rewinding a plugin conversation (#8368); redundant plugin streaming snapshots are released instead of being retained for the session (#7675). |

**Deprecated in 0.15.0 — both removal dates are 2027-04-30:**

| Deprecated | Replacement |
| ---------- | ----------- |
| `server.on(event, handler)` | `server.addHook(<renamed event>, handler)` |
| `server.before(request, handler)` | `server.addHook(<renamed request>, handler)` |

The renames, straight from the SDK's `legacyEvents` / `legacyRequests` maps:

| Old name | New name |
| -------- | -------- |
| `workspace.created` / `workspace.archived` | `workspace.create.after` / `workspace.archive.after` |
| `agent.created` / `agent.closed` / `agent.archived` | `agent.create.after` / `agent.close.after` / `agent.archive.after` |
| `agent.turn_started` / `agent.turn_ended` | `agent.turn.before` / `agent.turn.after` |
| `agent.permission_requested` / `agent.permission_resolved` | `agent.permission.before` / `agent.permission.after` |
| `agent.create` | `agent.create.before` |
| `agent.session_open` | `agent.open.before` |
| `workspace.create` | `workspace.create.before` |

Both old spellings **keep working on 0.15.0**: the SDK ships
`createLifecycleRegistration`, which maps them through those tables, and the
installed host builds the plugin `server` object with exactly that adapter
(`import { createLifecycleRegistration, pluginHookRegistry } from
"@getpaseo/plugin/internal/lifecycle"`). The migration is therefore driven by
the `@deprecated` mark, not by breakage — same story as `addSurface` /
`addSidebarItem` / `openSurface` in 0.11–0.14. **Two plugins in this
repository used the deprecated spellings and were migrated in this pass:**
bunny-search (two `before` hooks), session-manager (one `on` hook) and, in a
follow-up the same day, **luck-planner** (two `before` hooks, shipped as
0.39.8). command-center, memory-flash and memory-flash-client still call
`server.before(...)` / `server.on(...)` and need the same migration before
2027-04-30 — they were out of scope for this pass.

**One host behaviour that can break MCP-injecting plugins — recorded, it is
not an SDK change:** #7435 makes the OpenCode provider reuse a running v2
service. `requiresDedicatedV2Server()` is true for *any* agent whose config
carries `mcpServers`, and when `selectOpenCodeService()` finds a local service
(`$XDG_STATE_HOME/opencode/service.json`, default
`~/.local/state/opencode/service.json`, compatible `2.x`) instead of owning
the process, the host throws `Custom OpenCode MCP servers or process
environment require an isolated server and cannot be used with a shared
OpenCode service.` — the agent can then be neither created nor opened.
Reproduced and controlled on this machine; details and the proposed
plugin-side fix in
[bunny-search §16.3](../bunny-search/__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150).


### Paseo 0.15.0 compatibility pass (2026-11-03)

**bunny-search**, **session-manager**, **remote-control** and **luck-planner**
were checked against stable 0.15.0 on 2026-11-03 (footnote ⁵; luck-planner in a
follow-up the same day). The other three plugins keep their 0.14.0 verdicts and
**still carry the now-deprecated `server.before` / `server.on` calls** —
command-center, memory-flash and memory-flash-client need the same migration
before 2027-04-30.

| Plugin | Deprecated call on 0.15.0 | Migrated to | Shipped as |
| ------ | ------------------------- | ----------- | ---------- |
| bunny-search | `server.before("agent.create")`, `server.before("agent.session_open")` | `server.addHook("agent.create.before")`, `server.addHook("agent.open.before")` | **0.5.3** |
| session-manager | `server.on("agent.closed")` | `server.addHook("agent.close.after")` | **0.3.4** |
| luck-planner | `server.before("agent.create")`, `server.before("agent.session_open")` | `server.addHook("agent.create.before")`, `server.addHook("agent.open.before")` | **0.39.8**, recommendations implemented in **0.40.8** |
| remote-control | none — no lifecycle hooks, no deprecated registration or option | — (nothing to migrate) | **1.0.0** (release; E1–E3: FreeRDP 3 discovery, window exit codes, RD Gateway; bugfix-only from here) |

Both floors moved with the API they now require — `requirements.paseo`
`>=0.14.0` → `>=0.15.0`, because `addHook` does not exist on a 0.14.0 host —
and both pins moved to `^0.15.0`. No behaviour changed: the hook bodies, the
gates and the returned requests are byte-for-byte what they were, and the
test doubles now register through `addHook` and assert the new names.

Details and evidence:
[bunny-search §16](../bunny-search/__doc.md#16-paseo-0150--compatibility-pass-2026-11-03),
[session-manager §19](./__doc.md#19-paseo-0150--compatibility-pass-2026-11-03).
Recommendations for improvement were recorded, not implemented — see
[bunny-search §16.4](../bunny-search/__doc.md#164-recommendations-for-improvement-recorded-not-implemented)
and [session-manager §19.3](./__doc.md#193-recommendations-for-improvement).
The first session-manager recommendation (also dropping the listing cache on
`agent.archive.after` / `workspace.archive.after`) was implemented the same day
in **0.3.5** — [session-manager §19.5](./__doc.md#195-version-035--the-archive-hook-recommendation-2026-11-03).


### Paseo 0.14.0 — new and deprecated SDK surface (2026-10-29)

Everything below comes from the `@getpaseo/plugin`, `@getpaseo/client` and
`@getpaseo/protocol` npm tarballs diffed against the previous SDK release, cross-checked
against the [0.14.0 release notes](https://github.com/getpaseo/paseo/releases/tag/v0.14.0),
the deployed [plugin hooks reference](https://paseo.sh/docs/plugins/hooks.md)
and the host files inside the installed `app.asar`. It is the full inventory a
plugin of this repository has to care about; per-plugin impact is in each
plugin's `__doc.md`.

**New in 0.14.0** (all optional — none of it is a conformance requirement):

| Surface | What it gives you |
| -------- | ----------------- |
| `before("agent.session_open")` request gains `title`, `labels`, `tools`, `mcpServers` | Per-open, per-plugin **editable** maps: MCP servers and tools re-derived on every `create` / `resume` / `refresh` / `import` (`purpose` `interactive`/`history`), launch-only (never saved), merged in plugin-ID order, ignored for `purpose: "history"`. A name colliding with a *saved* server, the internal `paseo` server or another plugin **fails the session open**, and a provider without MCP support fails with it. Declaring the hook marks open sessions stale and reopens them before the next prompt — the mechanism that finally makes injected servers reach *existing* agents. |
| `defineAgentTool(...)` + `AgentToolDefinition` / `AgentToolContext` / `AgentToolResult` from `@getpaseo/plugin/server` | Give **individual agents** a plugin tool (selected by `agentId`, `provider`, `workspaceId` or `labels`) through Paseo's own tool transport, with no MCP config. Zod-validated input, `signal`, 10-minute call ceiling, a thrown error becomes `{ isError: true, text }`, and only metadata + inputs/results cross the process boundary. Names must match `/^[a-z][a-z0-9_]*$/`, ≤64 chars. |
| `PaseoAgentHandle.reload()` in `@getpaseo/client` | Reopen a provider session with current configuration, **rerunning session-open hooks**, interrupting a running turn, and return the refreshed snapshot — the programmatic form of "reconnect this agent's tools". |
| `FetchAgentTimelineOptions.wholeTurns` | Prefer whole-turn pages when the host supports them; older hosts keep item-based paging. |
| Provider capability `session.can_stop_runtime` (+ request/event) | Opt-in provider protocol addition; matters only to `registerProvider` authors. |
| `@getpaseo/client` `listLocalSpeechModels` / `downloadLocalSpeechModel` / `deleteLocalSpeechModel` | Backing for the new Voice settings and downloadable local models (SenseVoice, Whisper); not a plugin surface. |
| Host-side fixes that matter to plugins | Idle agent runtimes are released after an hour and the saved session resumes on the next prompt (a *session reopen* — exactly where `agent.session_open` re-injects); large Claude/OMP histories and plugin builds stall less; late tool updates no longer create duplicate timeline rows during overlapping turns. |

**Deprecated in 0.14.0: nothing new.** The `@deprecated` set in
`@getpaseo/plugin@0.14.0` is byte-identical to the previous release — the
`client/react-native` entry (removal 2027-04-20, with `useRevealedText`), panel
`context`/`agentId`, `addSurface`/`addSidebarItem`/`openSurface`,
`SettingsGroup`, the always-empty `agent.turn_ended` `timeline`, and
`CreateAgentRequestOptions.git`/`worktreeName`. Nothing had to be migrated in
this repository, and 0.14.0 removes nothing these plugins use.

**One documentation discrepancy worth recording:** the deployed hooks page
says `server.addHook("agent.open.before")` "is available from Paseo 0.14", but
neither `@getpaseo/plugin@0.14.0` nor the installed 0.14.0 host contains
`addHook` anywhere (`grep -r addHook` over the extracted `app.asar`'s
`@getpaseo/**` returns nothing; the daemon dispatches `before` hooks keyed
`agent.session_open` from `runtime.js`). The type-safe 0.14.0 surface is
`server.before("agent.session_open")`; adopt `addHook` only when the SDK
actually ships it. **Resolved in 0.15.0:** `addHook` now exists in the SDK
(`@getpaseo/plugin/internal/lifecycle`) and in the shipped host, which builds
the plugin `server` object with `createLifecycleRegistration(...)` — so the
recommendation in this section is superseded by
[Paseo 0.15.0](#paseo-0150--new-and-deprecated-sdk-surface-2026-11-03).

**The client half of the SDK did not move:** `diff -rq` over
`@getpaseo/plugin` reports changes only under `dist/server/` plus
`package.json`; `dist/client/` is byte-identical to the previous release, so every client
registration in this repository is untouched by construction.


### Paseo 0.14.0 compatibility pass (2026-10-29)

**memory-flash** and **memory-flash-client** were checked against stable
0.14.0 on 2026-10-29; **bunny-search** and **session-manager** followed on
2026-10-30 (footnote ²); **command-center** was the last one, on 2026-11-01
(footnote ³). **luck-planner** remains out of scope. Method and
evidence are in footnotes ¹, ² and ³; per-plugin detail is in each plugin's
`__doc.md`. What the passes found:

- **No code change was required for 0.14.0 anywhere.** Typecheck is clean and
every test suite is green against `@getpaseo/plugin@0.14.0`, so the SDK diff removes nothing these plugins use — and the diff is
additive server-side only; the client SDK is byte-identical.
- **No deprecated API exists in either plugin**, and 0.14.0 deprecates
nothing new. Both keep importing UI from `@getpaseo/plugin/client` and
`@getpaseo/plugin/client/ui` and register only `addScreen` /
`addSidebarHeaderItem` / `addSettingsScreen` / `addCommandCenterItem`.
- **Two code changes rode along.** First, the agent recommendation to use
memory-flash and memory-flash-client was strengthened (skill frontmatter,
a new *non-negotiable baseline* checklist, and the tool descriptions) ⇒
**memory-flash 0.8.3 → 0.8.4** and **memory-flash-client 0.2.1 → 0.2.2**,
each with its annotated tag.
- **The 0.14.0 surface itself is now implemented, not just recommended** —
**memory-flash 0.9.4**, **memory-flash-client 0.3.2** (memory-flash §18.5,
memory-flash-client §17.5): MCP injection in `before("agent.session_open")`
re-derived on every open (so it reaches already created agents and survives
the idle-hour release), collision-safe by reading the agent's saved `mcpServers`
from the daemon's own record and skipping/failing safe on every unknown state;
a "repair memory tools" Command Center action on the new
`agents.ref(id).reload()`; a read-only `memory_flash_recall` attached via
`defineAgentTool` (memory-flash only — the client's tools belong to the remote
host); and MCP `instructions` in `initialize` (memory-flash only). Because
those are 0.14.0 APIs, both plugins raised their floor to `requirements.paseo
>=0.14.0` and pinned `@getpaseo/plugin@^0.14.0` in this release.
- **Verified with the real host compiler, not a re-implementation:**
`compileDirectoryPlugin` and `readPluginManifest` were taken from the
installed 0.14.0 `app.asar`, so the boundary walk, the exempt list and the
manifest schema are the daemon's own. All four entries build with no boundary
errors, and a string scan of the bundles finds no deprecated calls.
- **Manifests and floors:** both `paseo-plugin.json` files pass the real
0.14.0 parser. The pass kept the floors at `>=0.11.0` (a floor is an API
promise, not a record of the newest host tested); the follow-up release
raised both to `>=0.14.0` because the adopted APIs are 0.14.0's.
- **Live:** memory-flash is `running` on this machine's 0.14.0 daemon with
`[memory-flash] MCP entry: … (exists)` + `[paseo] Plugin ready` and no plugin
errors; memory-flash-client is installed but `disabled`, so its result is
compiler- and test-level only.
- **The second batch (2026-10-30, footnote ²) found exactly one place in this
repository where a deprecation was still live.** **bunny-search** needed
nothing: no deprecated API, no code change, no version bump — the improvement
recommendations written into `bunny-search/__doc.md` §15.2
instead, headed by contributing the MCP server in `before("agent.session_open")`
as well so injection reaches agents that already exist and survives the new
idle-runtime release. **session-manager** still carried both hits that release left
in it — both are now migrated: the UI import moved from
`@getpaseo/plugin/client/react-native` (removal 2027-04-20) to
`@getpaseo/plugin/client/ui`, and the `@deprecated` `context: "workspace"`
field was dropped from `addWorkspacePanel` — with the shipped renderer read
first to confirm it accepts `undefined` and normalises it, while the
`context` fields on `addCommandCenterItem` were kept because there the field
is a required union discriminant. Because `client/ui` gained `ScrollView`
and `useToast` only in a later SDK release, `requirements.paseo` moved off
`>=0.8.0` to that release (the floor still follows the API actually used, not
the newest host tested) ⇒
**session-manager 0.2.3**. Recommendations for both plugins are recorded in
their `__doc.md` §15.2 / §18.3, and both sets were implemented the same day
when asked — each is new functionality and therefore its own second-digit
release: **bunny-search 0.5.2** (session-open injection, the
`bunny_web_search` agent tool, the repair action, label/provider gating and
MCP `instructions`; pin `^0.14.0`, floor `>=0.14.0`, 10 suites / 133 tests)
and **session-manager 0.3.3** (`agent.closed` cache invalidation, the refresh
action on `reload()`, `useTabState` filters; floor then raised to `>=0.14.0`,
9 suites / 74 tests). The one recommendation that could not be built is
session-manager's "stop runtime, keep the session": `session.can_stop_runtime`
is answered inside the provider protocol and consumed by the host's own
idle-runtime cleanup, and no plugin-facing call reaches it — evidence in
[§18.5](./__doc.md#185-implementation-of-183-2026-10-30-shipped-as-033).
- **The third batch (2026-11-01, footnote ³) closed the repository's last
live deprecation.** **command-center** still imported `Modal` / `useToast`
from the deprecated `client/react-native` entry; the import now comes from
`client/ui`, `requirements.paseo` moved off `>=0.11.0` to the first release whose
`client/ui` exports those two symbols (the floor still follows the API actually
used), and both pins became `^0.14.0` (a real lockfile bump, since
`@getpaseo/client` is bundled from the plugin's own `node_modules`) ⇒
**command-center 0.5.3**. Its improvement recommendations are recorded in
[§12.3](../command-center/__doc.md#123-recommendations-for-improvement-recorded-not-implemented)
and implemented the same day as **command-center 0.6.0** (§13: the agent
tool, session-open MCP re-derivation, the reload action, turn-aware
dispatch and deep links; floor `>=0.14.0`). **luck-planner** is now the
only plugin not re-checked since its own pass.

