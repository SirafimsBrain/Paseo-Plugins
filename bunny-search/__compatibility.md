# Compatibility — bunny-search

Current: plugin **0.5.3**, `requirements.paseo >=0.15.0`, `@getpaseo/plugin ^0.15.0`.

This file holds the extended compatibility information that no longer lives in the root `README.md` (which keeps only the main verdict) or in this plugin's `README.md`. Technical evidence stays in [`__doc.md`](./__doc.md).

## Summary (former root README row)

| [bunny-search](./README.md) | **0.15.0 (2026-11-03)** ⁵, **0.14.0 (2026-10-30)** ² | `@getpaseo/plugin@^0.15.0` (pin `^0.15.0`, `requirements.paseo >=0.15.0`) | **0.15.0: compatible after a mandatory migration — shipped as 0.5.3** (patch bump: a deprecated-API replacement, no new capability, tag `bunny-search@0.5.3`). `server.before("agent.create")` and `server.before("agent.session_open")` are `@deprecated` on 0.15.0 (removal after 2027-04-30) and moved to `server.addHook("agent.create.before")` / `server.addHook("agent.open.before")` — payload, return value and hook bodies unchanged, so only the registration and the names moved; the floor followed the API (`addHook` does not exist on 0.14.0) and the SDK diff left `dist/client/` byte-identical, so nothing client-side could move. **One host-side finding, recorded with a proposed fix:** 0.15.0's #7435 makes the OpenCode provider reuse a running v2 service, and an agent carrying custom MCP servers is then rejected (`Custom OpenCode MCP servers … require an isolated server …`) whenever a local OpenCode service is registered — every agent this plugin injects into, `opencode` provider only; reproduced and controlled in the isolated 0.15.0 daemon, mechanism and fix in [§16.3](./__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150). Evidence: typecheck + vitest **10 suites / 133 tests** against SDK 0.15.0, no `server.before(` / `server.on(` left in the plugin, `running` in an isolated 0.15.0 daemon with `[paseo] Plugin ready`, the settings mirror written, zero `Unknown lifecycle hook` errors, and both hooks proven to fire on a real agent creation and a real `paseo send` (`[bunny-search] MCP injected: …`). Recommendations recorded, not implemented: [§16.4](./__doc.md#164-recommendations-for-improvement-recorded-not-implemented). **0.14.0: compatible, no code change and no deprecated API in it** — it stayed **0.4.2** through the pass, with no bump and no tag, because the pass touched only documentation; the same day's implementation release is **0.5.2**. 0.14.0 adds no new `@deprecated` marks (byte-identical to the previous release) and its `dist/client/` did not move, and `server.before("agent.create")` — the plugin's only hook — is still the supported spelling: `server.addHook` is claimed by the deployed hooks page but exists neither in `@getpaseo/plugin@0.14.0` nor in the installed host. Evidence: typecheck + vitest **9 suites / 95 tests** (2 live-search tests skipped by default) against SDK 0.14.0, both entries built by the real 0.14.0 host compiler with zero deprecated calls, the manifest accepted with its `>=0.11.0` floor (rejected for a 0.10.0 daemon), `running` in an isolated 0.14.0 daemon with `[paseo] Plugin ready` and the settings mirror written. **0.5.2 implements all five recommendations of [§15.2](./__doc.md#152-recommendations-for-improvement-recorded-during-the-pass-implemented-in-052)** — recorded by the pass, built when it was asked for; what was built is in [§15.4](./__doc.md#154-implementation-of-152-2026-10-30-shipped-as-052): MCP injection in `before("agent.session_open")` re-derived on every open (so it reaches agents created before `injectIntoAgents` was switched on and survives the idle-runtime release), collision-safe because the agent's saved `mcpServers` are read from the daemon record and every unreadable state fails safe to *skip*; a native `bunny_web_search` tool via `defineAgentTool` for providers without MCP support; a "repair search tools" Command Center action on `agents.ref(id).reload()`; per-agent gating by label (`labelGateKey`) and provider (`skipProviders`); and MCP `instructions` in `initialize`. Because those APIs are 0.14.0's, the pin became `^0.14.0` and the floor `>=0.11.0` → `>=0.14.0`. Evidence for 0.5.2: typecheck + vitest **10 suites / 133 tests** (2 live-search tests skipped), both entries built by the real 0.14.0 host compiler with `deprecatedHits: []`, manifest rejected for an older daemon and accepted for 0.14.0. Details: [Compatibility](./__doc.md#7-compatibility), [§15](./__doc.md#15-paseo-0140--compatibility-pass-2026-10-30). |

## Details moved from this plugin's README.md

## Paseo 0.15.0 compatibility

Verified against the **stable Paseo 0.15.0** release (2026-11-03).
Full evidence: [__doc.md](./__doc.md) §16. **Compatible after a mandatory
migration — shipped as `0.5.3`**, with `requirements.paseo` `>=0.14.0` →
`>=0.15.0` and the SDK pin `^0.14.0` → `^0.15.0`.

**Deprecated in 0.15.0 and used here — both migrated:**

| Deprecated (`@deprecated`, removal after **2027-04-30**) | Migration in 0.5.3 |
| ---------- | ------------------ |
| `server.before(...)` | `server.addHook(...)`, with the renamed hook: `agent.create` → **`agent.create.before`**, `agent.session_open` → **`agent.open.before`**. Payload (`{ request }`) and return (the request or `void`) are unchanged, so the hook bodies did not move — only the registration and the names did. |
| `server.on(...)` | not used by this plugin (it registers no event hooks), listed because it carries the same deprecation mark. |

The legacy spellings still work on 0.15.0 — the SDK maps them through
`legacyRequests` / `legacyEvents` — so this is a deprecation-driven
migration, not a breakage. `addHook` exists on the shipped host: the
installed `app.asar` builds the plugin `server` object with
`createLifecycleRegistration(...)` from `@getpaseo/plugin/internal/lifecycle`.
Because `addHook` does not exist on a 0.14.0 host, the manifest floor had to
move with it.

**Nothing else changed for this plugin.** The 0.14.0 → 0.15.0 SDK diff is
server-only (`dist/server/lifecycle.*`, `dist/server/index.d.ts`,
`package.json`); **`dist/client/` is byte-identical**, so the screen, sidebar,
settings-screen and Command Center registrations and the `client/ui` imports
are untouched by construction. New 0.15.0 hooks (`worktree.create.before` /
`worktree.create.after`) have no search-shaped purpose here.

**One host-side finding, recorded with a recommended fix:** on 0.15.0 the
host reuses a running OpenCode v2 service (#7435), and an agent that carries
custom MCP servers is then **rejected** with `Custom OpenCode MCP servers or
process environment require an isolated server …` — which hits every agent
this plugin injects into, for the `opencode` provider only, whenever a local
OpenCode service is registered (`~/.local/state/opencode/service.json`).
Reproduced and controlled (plugin on / plugin off / discovery removed) in the
isolated 0.15.0 daemon; the mechanism, the exact scope and the proposed fix
are in [__doc.md](./__doc.md) §16.3, the fix itself as recommendation
§16.4 item 1. Until it is built, adding `opencode` to `skipProviders`
avoids the failure — at the cost of losing search on opencode agents.

**Recommendations for improvement — recorded, not implemented:**
[__doc.md](./__doc.md) §16.4 — skip MCP for `opencode` while a shared
OpenCode service is discoverable (falling back to the native
`bunny_web_search` tool), deep-link quick search through
`PluginScreenProps.params` with an `addSidebarFooterItem` status row, registry
metadata (`name` / `icon` / `media` + `OVERVIEW.md`), response caching and
per-project presets, and more providers behind the same adapter.

**Verification:** typecheck clean (three-project `tsc -b`) and vitest
**10 suites / 133 tests** green against `@getpaseo/plugin@^0.15.0` (2
live-search tests skipped without `BUNNY_LIVE=1`), no `server.before(` /
`server.on(` call left in the plugin, and **live on the real 0.15.0 daemon**:
installed from the working tree into an isolated scratch home, `running` with
`[paseo] Plugin ready`, the settings mirror written, zero `Unknown lifecycle
hook` errors — and both hooks proven to fire on a real agent creation and a
real `paseo send` (`[bunny-search] MCP injected: …`).

## Paseo 0.14.0 compatibility

Verified against the **stable Paseo 0.14.0** release (2026-10-30).
Full evidence: [__doc.md](./__doc.md) §15. **No code change was needed and no
deprecated API exists in this plugin** — it stays `0.4.2` (no bump, no tag:
this pass changed no code) and `requirements.paseo` stays `>=0.11.0`.

**Nothing deprecated reaches it.** The `@deprecated` set in
`@getpaseo/plugin@0.14.0` is byte-identical to the release before it, and `dist/client/` did not
change at all across that step, so `addScreen` /
`addSidebarHeaderItem` / `addSettingsScreen` / `addCommandCenterItem` and the
`client/ui` imports are exactly what they were. `server.before("agent.create")`
— the plugin's only hook — is still the supported spelling in 0.14.0.

**One documentation discrepancy, recorded:** the deployed hooks page says
`server.addHook("agent.open.before")` "is available from Paseo 0.14", but
neither `@getpaseo/plugin@0.14.0` nor the installed 0.14.0 host contains
`addHook` anywhere. Keep `server.before(...)` / `server.on(...)` until the SDK
ships it — see the root
[README](../README.md#paseo-0140--new-and-deprecated-sdk-surface-2026-10-29).

**Recommendations for improvement — implemented in 0.5.2:** the original
recommendations stay in [__doc.md](./__doc.md) §15.2, what was built is in
§15.4. The search server is now also contributed in
`before("agent.session_open")`, so injection reaches agents created before
`injectIntoAgents` was switched on and survives 0.14.0's new idle-runtime
release — collision-safe, because the agent's saved `mcpServers` are read from
the daemon's own record and every unreadable state fails safe to *skip*; a
native `bunny_web_search` tool rides along through `defineAgentTool` (the
fallback for providers without MCP support); a **"repair search tools"**
Command Center action runs the new `agents.ref(id).reload()`; injection can be
gated per agent by a **label** (`labelGateKey`) or excluded per **provider**
(`skipProviders`); and the MCP `initialize` response now carries
`instructions` telling agents when to search and to open the returned URLs.

**Verification:** typecheck clean and vitest **10 suites / 133 tests** green
(2 live-search tests skipped without `BUNNY_LIVE=1`) against
`@getpaseo/plugin@0.14.0`, now pinned `^0.14.0` in `package.json` and
`package-lock.json` because the code needs those APIs. Both entries build with
the **real 0.14.0 host compiler** (`compileDirectoryPlugin` extracted from the
installed `app.asar`) with no boundary errors and **zero deprecated calls**,
and the manifest passes the real 0.14.0 parser with its `>=0.14.0` floor
(an older daemon is rejected, 0.14.0 is accepted). The live evidence
belongs to the 0.4.2 compatibility pass: `running` in an **isolated 0.14.0
daemon** (scratch home, production config untouched) installed from the
working tree — `[paseo] Plugin ready`, six RPC methods registered and
`[bunny-search] settings mirrored: …` in the plugin log, with no plugin or
contribution errors in the daemon log. 0.5.2 was not re-run live; it is
covered by the unit/e2e suites and the host compiler above.

## Paseo 0.12.0 spec conformance

Verified against the **stable Paseo 0.12.0** release (2026-10-21).
Full evidence: [__doc.md](./__doc.md) §13.

**What the new version changed for this plugin:**

- The SDK diff `@getpaseo/plugin@0.10.1 → 0.12.0` is **additive only** for
every API this plugin uses — nothing removed, nothing changed in meaning.
The `0.11.0 → 0.12.0` client declarations are byte-identical: the
screen/sidebar API landed in 0.11.0, so `requirements.paseo` is
`>=0.11.0`, not `>=0.12.0`.
- The 0.10-era client registrations this plugin used are now marked
`@deprecated` in the SDK (`addSurface`, `addSidebarItem`, `openSurface`).
They still work — the 0.12.0 host ships them as shims over
`addScreen`/`addSidebarHeaderItem`/`openScreen` — so this was a migration
for correctness, not a breakage fix.
- 0.12.0's `#7023` lets a plugin import Paseo *protocol types* without a
plugin-local install. This plugin deliberately does not import
`@getpaseo/protocol`, so it is unaffected either way. 0.12.0's `#6306`
fixes the 60-second `paseo plugin reload` timeout.

**Migrated in 0.4.2:**

| Before | After |
| ------ | ----- |
| `client.addSurface(id, Component)` | `client.addScreen({ id, title, Component })` |
| `client.addSidebarItem({ id, title, icon, surface })` | `client.addSidebarHeaderItem({ id, title, Component })` rendering `<SidebarRow icon="Globe" />` |
| `onSelect({ openSurface })` | `onSelect({ openScreen })` → `openScreen({ screenId })` |
| screen component took `PluginSurfaceProps` | takes `PluginScreenProps` (adds `params`, enabling future deep links) |
| `requirements.paseo: ">=0.10.0"` | `">=0.11.0"` — the API floor actually used |
| `@getpaseo/plugin@0.10.1` | `@getpaseo/plugin@0.12.0` (typecheck/tests target) |

**One real spec violation found and fixed:** 0.12.0's client audit says a
cross-platform module touching a DOM global outside `client/web.ts` is a
bug. `client/use-host-typography.ts` read `globalThis.localStorage`
directly. It now calls `readHostTypography()` from the new `client/web.ts`,
which is gated on `Platform.OS === "web"` and returns `null` on native so
callers fall back to defaults. The audit is clean after the change.

**Verification:** typecheck clean against SDK 0.12.0, vitest **9 suites /
95 tests** pass, the MCP bundle rebuilds, no deprecated registrations
remain in `client/`, and every contribution ID conforms to the
lowercase/hyphen rule. Live-verified on a real 0.12.0 daemon in an
isolated home: installs as `running`, logs `Plugin ready`, reloads
cleanly (`paseo plugin reload`, the fixed #6306 flow), and the real
0.12.0 host compiler builds the client entry with zero legacy API
calls in the compiled bundle.

Still open, all optional and none of them conformance blockers:

1. **Host-managed processes** — `spawnProcess` / `terminateProcess` in
   `server/probe.ts`, for correct Windows `.cmd` launching and descendant
   cleanup (§10.2 item 1).
2. **Deep-link quick search** — pass `?q=` through
   `PluginScreenProps.params`, and move the connection status into an
   `addSidebarFooterItem` row with `SidebarRow` / `SidebarSeparator`. New
   capability, so it would be a second-digit bump.
3. **Registry readiness** — `name` / `icon` / `media` in
   `paseo-plugin.json` plus an `OVERVIEW.md`, required only for a plugin
   registry listing, not for installation (§10.2 item 3).
4. **Usage source** — deferred: no in-scope backend exposes quota data and
   the account-based `registerUsageSource()` model fits poorly (see
   [__doc.md](./__doc.md) §10.2 item 4). 0.12.0 does not change this.

Technical details, design decisions, alternatives considered, limitations and the roadmap: see [__doc.md](./__doc.md).


## Former root README footnotes

² The 2026-10-30 continuation of the same 0.14.0 pass, scoped to the two plugins footnote ¹ left out — **bunny-search and session-manager** (release notes as in ¹). Same method: `@getpaseo/plugin@0.14.0` unpacked from npm, installed into bunny-search with `npm install --no-save --package-lock=false` so its `package.json` / `package-lock.json` keep the `0.12.0` pin on purpose, and into session-manager with a real pin bump to `^0.14.0` (its migration needs `client/ui`'s `ScrollView` / `useToast`, which 0.12.0's typings do not have). Evidence: typecheck + vitest green against the 0.14.0 SDK — bunny-search **9 suites / 95 tests** (2 live tests skipped by default), session-manager **8 suites / 70 tests**; both entries of both plugins built by the **real 0.14.0 host compiler** (`compileDirectoryPlugin` and `readPluginManifest` extracted from the installed `app.asar`) with no boundary errors, **0 warnings** and zero deprecated calls; the floors enforced by that same host code (bunny-search accepted at 0.11.0 / 0.14.0 and rejected at 0.10.0, session-manager accepted at 0.14.0 and rejected at 0.12.0); and both installed **from the working tree into an isolated 0.14.0 daemon** — a scratch home on its own loopback port with `pluginsEnabled: true`, production home untouched — where each is `running` with `[paseo] Plugin ready`, its RPC methods registered and no plugin or contribution errors in the daemon log (bunny-search also wrote its settings mirror). One negative control: a copy of session-manager with the old `client/react-native` import restored compiles to a bundle that *does* contain the deprecated specifier, so the clean scans are meaningful. bunny-search needed no code change (stays 0.4.2, no tag); session-manager migrated the two deprecations it had carried ⇒ **0.2.3** with its annotated tag. command-center and luck-planner were not part of this pass; command-center was picked up on 2026-11-01 (footnote ³), and luck-planner keeps its earlier verdict.

⁵ The 2026-11-03 pass against the stable **0.15.0** release (2026-11-03) — release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.15.0>. Scope: **bunny-search and session-manager**, the two plugins the first task named, then **remote-control**, and then **luck-planner** (its own pass, the fourth request of the day, which also re-diffed the SDK and re-ran the live daemon checks for itself). Method: the `@getpaseo/plugin@0.14.0` and `@getpaseo/plugin@0.15.0` tarballs unpacked from npm and diffed — four changed paths only (`dist/server/index.d.ts`, `dist/server/lifecycle.d.ts`, `dist/server/lifecycle.js`, `package.json`), **`dist/client/` byte-identical** — then a real pin bump to `^0.15.0`, because the migration needs `addHook`, which 0.14.0's typings do not have. Evidence: typecheck + vitest green against `@getpaseo/plugin@0.15.0` — bunny-search **10 suites / 133 tests** (2 live-search tests skipped by default), session-manager **9 suites / 74 tests**; no `server.before(` / `server.on(` call left in either plugin; both installed **from the working tree into an isolated 0.15.0 daemon** — a scratch home under `.tmp/` on its own loopback port with `pluginsEnabled: true`, production home untouched — where each is `running` with `[paseo] Plugin ready`, **zero** `Unknown lifecycle hook` errors in the daemon log, and the migrated hooks proven to *fire*: `agent.create.before` logged `[bunny-search] MCP injected: …` on a real agent creation, `agent.open.before` logged the session-open decision on a real `paseo send`, and `agent.close.after` logged `[session-manager] agent closed (<id>): listing cache invalidated` on a real agent stop and delete. The same daemon was also used for the OpenCode finding below (plugin on / plugin off / discovery removed). One host-side problem was found and is recorded rather than fixed, because fixing it changes plugin behaviour: **#7435 makes the OpenCode provider reuse a running v2 service, and an agent carrying custom MCP servers is then rejected outright** (`Custom OpenCode MCP servers or process environment require an isolated server …`) whenever a local OpenCode service is registered — which is every agent bunny-search injects into, for the `opencode` provider only; details and the proposed plugin-side fix in [bunny-search §16.3](./__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150). **remote-control** joined the pass later the same day (this repository's third request), checked against the **SDK version the plugin pins for development**, which trails the runtime, so its diff spans two minor versions: `@getpaseo/plugin`'s `dist/client/` is byte-identical across them and `@getpaseo/client`'s `terminals/` declarations did not move, and it uses **no deprecated API at all** — no lifecycle hooks (`server.before` / `server.on` are simply absent; only `server.handle(...)` ×7), no deprecated client registration or option, and the one breaking type change in its range (`TerminalStreamEvent`'s `snapshot`/`restore` → `replay`) does not reach it because it never subscribes to terminal output. Evidence: typecheck (both projects) + vitest **14 suites / 137 tests** against `@getpaseo/plugin@0.15.0` installed with `--no-save --package-lock=false` (pin and floor stay put — no 0.15.0 API is needed), zero deprecated markers in both compiled bundles with a negative control, and `running` in the same isolated 0.15.0 daemon with all seven RPC methods and an end-to-end console check (`/` 200 HTML, `/health` reporting 0.24.11, `/api/*` 200 with the token and 401 without it). It therefore stays **0.24.11**, no bump and no tag — that pass is documentation only. **luck-planner** was the fourth plugin of the day: the same two tarballs diffed again (same four changed paths, `dist/client/` byte-identical), a real pin bump to `^0.15.0` because its two hooks need `addHook`, and the same isolated 0.15.0 daemon **installed from the working tree** — `running`, `[paseo] Plugin ready`, 15 plugin RPCs + 3 settings methods, **zero** `Unknown lifecycle hook` errors, and both migrated hooks proven to fire on a real agent creation (`[luck-planner] MCP injected: …` from `agent.create.before`, `[luck-planner] session_open … agent.create.before …` from `agent.open.before`); the published MCP entry answered `initialize` (0.39.8) / `tools/list` (**14 tools**) and the dashboard answered `/health` and `/api/tree` (`200` with the token, **`401`** without). Evidence: typecheck (both configurations) + vitest **41 suites / 687 tests**, no `server.before(` / `server.on(` left in the plugin ⇒ **0.39.8**, tag `luck-planner@0.39.8`. That daemon also reproduced the OpenCode shared-service finding for this plugin (injection on: creation fails; `XDG_STATE_HOME` pointed at an empty directory: creation succeeds **with** the injection applied) — analysis and the D4 config-file workaround in [luck-planner §10.10.4](../luck-planner/__doc.md#10104-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150). Its five recommendations shipped the same day as **0.40.8**, and implementing them produced two facts the pass could not have known: the host rejects a shared-service agent for a custom **environment** as well as for custom MCP servers (measured three ways on the same daemon: plugin disabled → created; guard on but env stamped → refused; guard on and no env → created), and with the create hook gated the `reason=create` open must attach the native tool or a fresh agent has no way to write. Evidence: vitest **43 suites / 722 tests**; the guard, both seeding hooks (`workspace.create.after`, `worktree.create.after`) and the rebuilt MCP entry (0.40.8, 14 tools) observed live on the same isolated daemon — [luck-planner §10.11](../luck-planner/__doc.md#1011-version-0408--implementing-10105-2026-11-03). **Recommendations recorded, not implemented:** [bunny-search §16.4](./__doc.md#164-recommendations-for-improvement-recorded-not-implemented), [session-manager §19.3](../session-manager/__doc.md#193-recommendations-for-improvement) and [luck-planner §10.10.5](../luck-planner/__doc.md#10105-recommendations-for-improvement-recorded-not-implemented).

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
[bunny-search §16.3](./__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150).


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
[bunny-search §16](./__doc.md#16-paseo-0150--compatibility-pass-2026-11-03),
[session-manager §19](../session-manager/__doc.md#19-paseo-0150--compatibility-pass-2026-11-03).
Recommendations for improvement were recorded, not implemented — see
[bunny-search §16.4](./__doc.md#164-recommendations-for-improvement-recorded-not-implemented)
and [session-manager §19.3](../session-manager/__doc.md#193-recommendations-for-improvement).
The first session-manager recommendation (also dropping the listing cache on
`agent.archive.after` / `workspace.archive.after`) was implemented the same day
in **0.3.5** — [session-manager §19.5](../session-manager/__doc.md#195-version-035--the-archive-hook-recommendation-2026-11-03).


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
[§18.5](../session-manager/__doc.md#185-implementation-of-183-2026-10-30-shipped-as-033).
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

