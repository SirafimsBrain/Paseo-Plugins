# Compatibility — memory-flash

Current: plugin **0.10.4**, `requirements.paseo >=0.14.0`, `@getpaseo/plugin ^0.14.0`.

This file holds the extended compatibility information that no longer lives in the root `README.md` (which keeps only the main verdict) or in this plugin's `README.md`. Technical evidence stays in [`__doc.md`](./__doc.md).

## Summary (former root README row)

| [memory-flash](./README.md) | **0.14.0 (2026-10-29)** ¹ | `@getpaseo/plugin@0.14.0` (pin `^0.14.0`, `requirements.paseo >=0.14.0`) | **0.14.0: compatible, and its new surface is used — no deprecated API exists in the plugin.** Shipped as **0.9.4**: the compatibility pass (0.8.4) also strengthened the agent recommendation (frontmatter `description` that opens with *mandatory, not optional*, a new `## The non-negotiable baseline` checklist with anti-shortcut rules, and `memory_save`/`memory_search`/`memory_handoff` tool descriptions), and **0.9.4 implements all four recommendations from the pass**: MCP injection in `before("agent.session_open")` (re-derived on every open, so it reaches already created agents and survives eviction — contributing the server only when the agent's saved config does not carry that name, since a collision fails the open; the saved set is read from the daemon's agent record and every unreadable state skips), a read-only `memory_flash_recall` tool attached via `defineAgentTool`, a "repair memory tools" Command Center action on the new `agents.ref(id).reload()`, and MCP `instructions` in `initialize`. Evidence: typecheck + vitest **16 suites, 192 tests**, both entries built by the real 0.14.0 host compiler with zero deprecated calls, `running` on the live 0.14.0 daemon. Earlier: 0.5.0 remote-access HTTP transport with API keys; 0.6.0 outright key deletion and a rewritten agent skill; 0.7.0 Reciprocal Rank Fusion over several FTS5 views plus `memory_diagnose`; 0.7.1 a revision-independent MCP entry path. Details: [Compatibility](./__doc.md#10-compatibility), [§18](./__doc.md#18-paseo-0140--compatibility-pass-2026-10-29). |

## Kimi Code CLI support — 0.10.4

Kimi Code CLI (`@moonshot-ai/kimi-code`, provider id `kimi` in Paseo, launched
as `kimi acp`) is now a first-class agent target:

- **Direct MCP registration** in `$KIMI_CODE_HOME/mcp.json` (`~/.kimi-code/mcp.json`
  by default), flat `mcpServers: { memory-flash: { command, args } }` — the same
  shared JSON writer as Cursor, so foreign servers are preserved, a broken file is
  never rewritten, and the write stays atomic. `KIMI_CODE_HOME` is honoured, since
  it moves the CLI's whole data root; the project-local `.kimi-code/mcp.json` is
  never touched (workspace trust belongs to the repository).
- **Skill target** `$KIMI_CODE_HOME/skills` (`~/.kimi-code/skills`), the directory
  Kimi Code CLI scans for user-level Agent Skills, alongside the existing
  `~/.agents/skills` target it also reads.
- RPCs `memory-flash.kimi-mcp-status` / `-register` / `-unregister`, a row in the
  settings screen, and Kimi included in *Register for all local agent configs*.

Evidence: `npm run typecheck` clean, `vitest run` **17 suites / 200 tests** pass
(the new `tests/kimi-mcp.test.ts` covers the default and moved data root, entry
shape, foreign-server preservation, corrupted-file refusal and unregistration;
the skill suite now expects eight targets).

## Details moved from this plugin's README.md

## Paseo 0.14.0 compatibility

Verified against the **stable Paseo 0.14.0** release (2026-10-29).
Full evidence: [__doc.md](./__doc.md) §18. **No deprecated API exists in this
plugin**, and the release's new surface is not just compatible with it — it is
*used*: **`0.9.4` implements all four recommendations from §18.2**.
`requirements.paseo` is therefore `>=0.14.0` and the SDK pin is `^0.14.0`
(`agent.session_open`, `defineAgentTool` and `reload()` are 0.14.0 API).

**Nothing deprecated reaches it.** The `@deprecated` list in
`@getpaseo/plugin@0.14.0` is byte-identical to the release before it, and the
plugin's whole client surface — `dist/client/` — did not change at all across
that step, so `addScreen`, `addSidebarHeaderItem`, `addSettingsScreen` and
`addCommandCenterItem` are exactly what they were.

**New in 0.9.4 — the 0.14.0 features, implemented** (design and decision
matrix in [__doc.md](./__doc.md) §18.5):

1. **MCP injection in `before("agent.session_open")`** alongside the existing
   `agent.create` write — the hook re-runs on create *and* resume/
   refresh/import, re-derives its `mcpServers` map on every open, survives
   OpenCode's per-directory eviction and reaches **already created** agents:
   the direct fix for the documented
   `No tool named "memory-flash_memory_save"` case (§13). It contributes the
   server **only when the agent's saved configuration does not already carry
   that name** (a collision fails the session open), only when the provider
   supports MCP, and never on `purpose: "history"`; the saved set is read from
   the daemon's agent record, and every unreadable/unknown state resolves to
   *skip*, so the hook can never break an open.
2. **A read-only `memory_flash_recall` tool** attached on every open via the
   new `defineAgentTool` — MCP-free, re-derived per open, never persisted, so
   an agent that receives no MCP server still gets search. Read-only on
   purpose: writes stay on the MCP transport with its attribution model.
3. **A "repair memory tools" Command Center action** built on the new
   `agents.ref(id).reload()`: it reopens the session, reruns the hook above
   and re-registers the server — one click instead of recreating the agent.
4. **MCP `instructions` in `initialize`** — the mandatory-tone protocol
   (search before the first edit, save the bugfix immediately, hand off
   before stopping) returned to clients that surface server instructions.

Worth knowing from the 0.14.0 notes: idle agent runtimes are released after
an hour and resumed on the next prompt — a session reopen, i.e. exactly the
position where the new hook re-injects the server.

**Verification:** typecheck clean against SDK 0.14.0, vitest **16 suites /
192 tests** pass (including the new session-open decision matrix, record
reader, attached tool, reload RPC and `initialize` instructions suites), both
entries build with the **real 0.14.0 host compiler** (`compileDirectoryPlugin`
from the installed `app.asar`) with no boundary errors and zero deprecated
calls, the manifest passes the real 0.14.0 parser, and the plugin is `running`
on this machine's 0.14.0 daemon with `[paseo] Plugin ready`.

**The agent recommendation was strengthened in 0.8.4** on three surfaces an
agent reads: the skill frontmatter `description` ("mandatory, not optional";
a non-trivial task starts with a search and ends with a handoff; a skipped
step must be named in the final answer), a new `## The non-negotiable
baseline` checklist section, and the `memory_save`/`memory_search`/
`memory_handoff` tool descriptions. Details: [__doc.md](./__doc.md) §18.4.

## Paseo 0.12.0 spec conformance

Verified against the **stable Paseo 0.12.0** release (2026-10-21).
Full evidence: [__doc.md](./__doc.md) §16.

**What the new version changed for this plugin:**

- The SDK diff `@getpaseo/plugin@0.10.1 → 0.12.0` is **additive only** for
every API this plugin uses; the `0.11.0 → 0.12.0` client declarations are
byte-identical, so `requirements.paseo` is `>=0.11.0` (the API floor), not
`>=0.12.0`.
- The 0.10-era registrations were `@deprecated` in the SDK (`addSurface`,
`addSidebarItem`, `openSurface`) but still shipped as working shims in the
0.12.0 host — this was a migration for correctness, not a breakage fix.
- **A previously documented date was wrong:** earlier notes said the host's
compatibility shims were "scheduled for removal after **2027-03-29**". That
date belongs to unrelated `COMPAT(...)` markers in 0.12.0
(`codexFastPreference`, `pluginProviderLaunch`); the surface/sidebar shims
carry no removal marker and the SDK's `@deprecated` tags state no version.
See [__doc.md](./__doc.md) §16.1.
- 0.12.0's `#7023` lets a plugin import Paseo *protocol types* with no
plugin-local install (type-only imports are erased at compile time). This
plugin does not import `@getpaseo/protocol`, so it is unaffected. `#6306`
fixes the 60-second `paseo plugin reload` timeout.

**Migrated in 0.8.3:**

| Before | After |
| ------ | ----- |
| `client.addSurface(id, Component)` | `client.addScreen({ id, title, Component })` |
| `client.addSidebarItem({ id, title, icon, surface })` | `client.addSidebarHeaderItem({ id, title, Component })` rendering `<SidebarRow icon="Database" />` |
| `onSelect({ openSurface })` (both Command Center items) | `onSelect({ openScreen })` → `openScreen({ screenId })` |
| screen component took `PluginSurfaceProps` | takes `PluginScreenProps` (adds `params`) |
| `requirements.paseo: ">=0.10.0"` | `">=0.11.0"` |
| `@getpaseo/plugin@0.10.1` | `@getpaseo/plugin@0.12.0` |

**Spec violation found and fixed:** 0.12.0's client audit treats a
cross-platform module touching a DOM global outside `client/web.ts` as a
bug. `client/use-host-typography.ts` read `globalThis.localStorage`
directly; it now calls `readHostTypography()` from the new `client/web.ts`,
gated on `Platform.OS === "web"` with `null` on native so callers fall back
to defaults.

**Verification:** typecheck clean against SDK 0.12.0, vitest **15 suites /
166 tests** pass (including the live HTTP endpoint suite and the stdio MCP
e2e), the MCP bundle rebuilds, and no deprecated registrations remain.
Live-verified on a real 0.12.0 daemon in an isolated home: installs as
`running`, logs `Plugin ready`, creates `memory.db` on startup, reloads
cleanly (`paseo plugin reload`, the fixed #6306 flow), and the real
0.12.0 host compiler builds the client entry with zero legacy API calls
in the compiled bundle.

Still open, all optional and none conformance blockers:

1. **Host-managed processes** — `spawnProcess` / `terminateProcess` in
   `server/mcp-probe.ts` and `server/remote-hosts.ts`, for Windows
   `.cmd`/`.bat` launching and host-owned process lifecycle.
2. **Deep links through screen params** — open the management screen on an
   exact memory via `PluginScreenProps.params`, with `PluginScreenTitle`
   deriving the header, plus `SidebarRow`/`SidebarSeparator` chip grouping
   and an `addSidebarFooterItem` quick entry. New capability → second-digit bump.
3. **`agent.closed` lifecycle event** — the foundation for the "always a
   handoff at the end of a session" rule and for timeline surfacing.

Technical details, design decisions, alternatives considered, limitations and the roadmap: see [__doc.md](./__doc.md).


## Former root README footnotes

¹ The 2026-10-29 pass against the stable **0.14.0** release (2026-10-29) — release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.14.0>. Scope: **memory-flash and memory-flash-client only**, the two plugins this task named; the other four were not re-checked *in that pass* — bunny-search and session-manager were picked up the next day (footnote ²), while command-center and luck-planner still kept their earlier verdicts (command-center was migrated on 2026-11-01, footnote ³). Method: the three SDK tarballs (`@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`) unpacked from npm and diffed against the previous release, then installed into each plugin with `npm install --no-save --package-lock=false` — at pass time **`package.json` / `package-lock.json` still pinned `0.12.0`**, since no code needed a 0.14.0 API yet. Evidence: typecheck + vitest green against `@getpaseo/plugin@0.14.0` — **21 suites / 219 tests** in total; both entries of both plugins built by the **real 0.14.0 host compiler** (`compileDirectoryPlugin`, `readPluginManifest` extracted from the installed `app.asar`) with no bundler-boundary errors and **zero deprecated calls** in the bundles; memory-flash `running` on this machine's live 0.14.0 daemon with `[paseo] Plugin ready`. The pass's own code change was the strengthened agent skill (0.8.4 / 0.2.2); the follow-up release **0.9.4 / 0.3.2** then implemented the recommendations below for real — at which point the pin became `^0.14.0`, `requirements.paseo` `>=0.14.0`, and the totals became **22 suites / 253 tests**.

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
[session-manager §19](../session-manager/__doc.md#19-paseo-0150--compatibility-pass-2026-11-03).
Recommendations for improvement were recorded, not implemented — see
[bunny-search §16.4](../bunny-search/__doc.md#164-recommendations-for-improvement-recorded-not-implemented)
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

