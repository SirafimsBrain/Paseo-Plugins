# Compatibility — luck-planner

Current: plugin **0.51.2**, `requirements.paseo >=0.15.0`, `@getpaseo/plugin ^0.15.0`.

This file holds the extended compatibility information that no longer lives in the root `README.md` (which keeps only the main verdict) or in this plugin's `README.md`. Technical evidence stays in [`__doc.md`](./__doc.md).

## Summary (former root README row)

| [luck-planner](./README.md) | **0.15.0 (2026-11-03)** ⁵, **0.14.0 (2026-11-01)** ⁴ | `@getpaseo/plugin@^0.15.0` (pin `^0.15.0`, `requirements.paseo >=0.15.0`) | **0.15.0: compatible after a mandatory migration — shipped as 0.39.8** (patch bump: a deprecated-API replacement, no new capability, tag `luck-planner@0.39.8`). Both of its hooks moved from the `@deprecated` spellings to `server.addHook`: `server.before("agent.create")` → `server.addHook("agent.create.before")` and `server.before("agent.session_open")` → `server.addHook("agent.open.before")` — payload, return value and hook bodies unchanged, so only the registrations, the hook names in the log lines and the test doubles moved; the floor followed the API (`addHook` does not exist on 0.14.0) and `dist/client/` is byte-identical 0.14.0 → 0.15.0, so the panel, the settings screen, the dashboard screen, the Command Center items, the slash commands and the timeline renderer are untouched. **One host-side finding, reproduced and controlled in the isolated 0.15.0 daemon:** 0.15.0's OpenCode shared-service reuse (#7435) refuses an agent whose config carries `mcpServers` while a local OpenCode v2 service is discoverable — since this plugin injects its MCP server into every agent, `opencode` agents cannot be created or opened on such a host; mechanism in [bunny-search §16.3](../bunny-search/__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150), plugin-side analysis, the D4 config-file workaround and the proposed guard in [luck-planner §10.10.4](./__doc.md#10104-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150). Evidence: typecheck (both configurations) + vitest **41 suites / 687 tests** against SDK 0.15.0, no `server.before(` / `server.on(` left in the plugin, `running` in an isolated 0.15.0 daemon with `[paseo] Plugin ready`, 15 plugin RPCs + 3 settings methods, **zero** `Unknown lifecycle hook` errors — which is itself the proof that the host accepts both new hook names — and both hooks observed firing on a real agent creation (`MCP injected: …`, `session_open … agent.create.before …`), plus the published MCP entry answering `initialize` (0.39.8) / `tools/list` (14 tools) and the dashboard's `/health` and `/api/*` (200 with the token, 401 without). **All five recommendations of [§10.10.5](./__doc.md#10105-recommendations-for-improvement-recorded-not-implemented) are implemented the same day — shipped as 0.40.8** (second-digit bump: new capability, tag `luck-planner@0.40.8`, evidence in [§10.11](./__doc.md#1011-version-0408--implementing-10105-2026-11-03)): the **OpenCode shared-service guard** (discovery read for `opencode`; a discovered `2.x` service makes both hooks contribute neither MCP **nor the audit-actor environment**, falling back to the native `luck_tree_upsert_leaf` tool — the same host that refused creation in 0.39.8 now creates the agent), **project seeding** on `worktree.create.after` (awaited) and on `workspace.create.after` / `agent.create.after` (idempotent root → trunk → `General`, actor `paseo`), an **agent-scoped activity panel** (`addAgentPanel` + `params.agentId`, backed by the new `luck-planner.agent-activity` RPC over `store.listActorActivity`) with its Command Center item, and **registry metadata** (`name`, `media`, `OVERVIEW.md`). The pass also corrected the finding itself: 0.15.0 rejects a shared-service agent for a custom **environment** as well as for custom MCP servers, so the open hook skips its `LUCK_PLANNER_AGENT_ID` stamp there and the native tool takes the actor from `context.agent.id`; and `reason=create` — which used to be left to the create hook — now attaches the native tool when that hook was gated, or a fresh agent would ship with no way to write. Evidence for 0.40.8: typecheck clean, vitest **43 suites / 722 tests**, and live on an isolated 0.15.0 daemon — the guard logging `injection skipped for opencode: OpenCode 2.2.5 service discovered …` while the agent is **created** and the open hook logs `attaching native luck_tree_upsert_leaf tool only: shared OpenCode service (…)`, `workspace.create.after` and `worktree.create.after` seeding their projects (3 projects × root/trunk/`General`, 9 audit rows, actor `paseo`), and the rebuilt MCP entry answering `initialize` (0.40.8) / `tools/list` (14 tools). **0.14.0: compatible, no deprecated API in it** — the pass stayed **0.34.1** (documentation only), and the same day's implementation release is **0.35.1**: all six [§10.8](./__doc.md#108-recommendations-for-improvement-implemented-in-0351--109) recommendations implemented — session-open MCP re-derivation (collision-checked against the daemon's own agent record, capability-probed, D4's config-file cover keeps ownership of the surface), a native `luck_tree_upsert_leaf` fallback tool via `defineAgentTool` for providers without MCP, a "Refresh luck-planner tools on this agent" action on `agents.ref(id).reload()`, panel state through `useTabState`, deep links through the focus mailbox (0.14.0's `openPanel` carries no params channel), and MCP `instructions` in `initialize`. Because the 0.14.0 surface is now a hard requirement, the floor moved to `>=0.14.0` (the real host gate rejects an older daemon and accepts 0.14.0); evidence for 0.35.1: typecheck + vitest **41 suites / 678 tests**, both entries built by the real 0.14.0 host compiler with `deprecatedHits: []`, and `running` in an isolated 0.14.0 daemon after a clean reload — details in [§10.9](./__doc.md#109-version-0351--implementing-108-2026-11-01). **0.35.2** (patch, same day) repairs the shipped lockfile: the `^0.14.0` pin had left the transitive closure of `@getpaseo/plugin` (`@getpaseo/client` / `protocol` / `relay`, `ws`, `@noble/*`, `tweetnacl`) out of `package-lock.json`, so the manifest's `npm ci` build step failed on git installs — `npm ci` now verifies clean, tag `luck-planner@0.35.2`. luck-planner uses none of the 0.14.0 `@deprecated` surface (its UI helpers already come from `client/ui`, its registrations are the modern screen/panel family, and it never subscribes to `agent.turn_ended`'s always-empty `timeline`); its bare `react-native` imports are not a deprecation — the host compiler lists `react-native` as external and the SDK skill's examples use it. The floor follows the API actually used: it was `>=0.11.0` at pass time (`addScreen` / `openScreen`, from 0.11) with the older pin it carried then; 0.35.1 adopts 0.14.0's surface (`defineAgentTool`, `agents.ref(id).reload()`, `useTabState`, the session-open `tools` map), so `requirements.paseo` is now `>=0.14.0` and the pin `^0.14.0` — the real host gate rejects an older daemon and accepts 0.14.0. Evidence: typecheck + vitest **37 suites / 635 tests** against SDK 0.14.0, both entries built by the real 0.14.0 host compiler (`compileDirectoryPlugin`) with `deprecatedHits: []` — plus a negative control that restores the old `client/react-native` import and does produce the hit; and `running` in an isolated 0.14.0 daemon (scratch home, own loopback port, production untouched) with `[paseo] Plugin ready`, **17 RPC methods**, the published MCP entry answering `initialize` / `tools/list` (**11 tools**), the dashboard's `/health` and a clean `paseo plugin reload`. **Six recommendations** ([§10.8](./__doc.md#108-recommendations-for-improvement-implemented-in-0351--109)), **implemented in 0.35.1** ([§10.9](./__doc.md#109-version-0351--implementing-108-2026-11-01)): session-open MCP re-derivation with a capability probe, a native fallback tool via `defineAgentTool`, a refresh action on `agents.ref(id).reload()`, panel state through `useTabState`, deep links through the focus mailbox (the `openPanel` params-channel deviation is documented in §10.9), and MCP `instructions` in `initialize`. Earlier: its own 0.12.0 conformance pass (0.32.2, 2026-10-22) in [§10.5](./__doc.md#105-paseo-0120-spec-conformance-0322), and the 0.29.1–0.29.4 acceptance that fixed three defects only the host's build and the daemon's lifecycle could show. Details: [Compatibility](./__doc.md#10-compatibility), [§10.7](./__doc.md#107-paseo-0140-compatibility-pass-2026-11-01). |

## Details moved from this plugin's README.md

## Paseo 0.15.0 compatibility

Verified against the **stable Paseo 0.15.0** release (2026-11-03) — the plugin's own pass for the new version. Full evidence: [`__doc.md` §10.10](./__doc.md#1010-paseo-0150-compatibility-pass-2026-11-03).

**Verdict: compatible, but only after a mandatory migration — shipped as 0.39.8** (patch bump: a deprecated-API replacement, no new capability; tag `luck-planner@0.39.8`). 0.15.0 marks `server.before(...)` and `server.on(...)` `@deprecated` (removal after 2027-04-30) in favour of `server.addHook(...)` with renamed hooks, and this plugin used the first spelling twice: `server.before("agent.create")` → `server.addHook("agent.create.before")` and `server.before("agent.session_open")` → `server.addHook("agent.open.before")`. Payload, return value and hook bodies are unchanged, so only the registrations, the hook names in the log lines and the test doubles moved. The floor followed the API — `server.addHook` does not exist on a 0.14.0 host — so `requirements.paseo` is `>=0.15.0` and the pin `@getpaseo/plugin@^0.15.0`.

- **The SDK diff is server-side only:** four changed paths (`dist/server/index.d.ts`, `dist/server/lifecycle.d.ts`, `dist/server/lifecycle.js`, `package.json`); **`dist/client/` is byte-identical to 0.14.0**, so the panel, the settings screen, the dashboard screen, the Command Center items, the slash commands and the timeline renderer are untouched by construction.
- None of the other `@deprecated` surface is used: no `server.on` (no event hooks at all), no `client/react-native` entry (`SettingsSection` / `ExternalLink` come from `client/ui`), no `addSurface` / `addSidebarItem` / `openSurface`, no `SettingsGroup`, no deprecated `context` on the panel registration, and no `agent.turn_ended` subscription (whose `timeline` is deprecated and always empty).
- 0.15.0's host behaviour helps rather than hinders: resumed sessions after a restart (agent recovery is opt-in) reopen through `agent.open.before`, which is the path that already re-derives the audit actor and the MCP contribution, and plugin screens now keep their local state across host disconnections — the panel's `useTabState` state included.
- **One host-side finding, recorded with a proposed fix:** 0.15.0's OpenCode shared-service reuse (#7435) refuses an agent whose config carries `mcpServers` while a local OpenCode v2 service is discoverable (`Custom OpenCode MCP servers … require an isolated server …`). Since this plugin injects its MCP server into every agent, `opencode` agents cannot be created or opened on such a host; reproduced and controlled in the isolated 0.15.0 daemon, mechanism in [bunny-search §16.3](../bunny-search/__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150), plugin-side analysis, the D4 config-file workaround and the proposed guard in [`__doc.md` §10.10.4](./__doc.md#10104-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150).
- Evidence: typecheck (both configurations) + vitest **41 suites / 687 tests** against SDK 0.15.0; no `server.before(` / `server.on(` call left in the plugin; installed **from the working tree into an isolated 0.15.0 daemon** — `running`, `[paseo] Plugin ready`, 15 plugin RPCs + 3 settings methods, **zero** `Unknown lifecycle hook` errors (which is itself the proof that the host accepts both new hook names), and both hooks observed firing on a real agent creation (`MCP injected: …` and `session_open … agent.create.before …`); the published MCP entry answering `initialize` (version 0.39.8) / `tools/list` (**14 tools**); the dashboard's `/health` and an `/api/tree` that is `200` with the token and `401` without it.

**All five recommendations are implemented — shipped as 0.40.8** (second-digit bump: new capability, tag `luck-planner@0.40.8`, [`__doc.md` §10.11](./__doc.md#1011-version-0408--implementing-10105-2026-11-03)):

- **Shared OpenCode service guard.** The plugin reads the host's discovery (`PASEO_OPENCODE_SERVER_URL`, or `$XDG_STATE_HOME/opencode/service.json`) for the `opencode` provider. A discovered `2.x` service means the host would reject a custom MCP server **or a custom environment**, so both hooks contribute neither: creation is no longer refused, and the agent keeps the tree through the native `luck_tree_upsert_leaf` tool. The live check on the same host moved from "creation refused" to "agent created". Unreadable discovery data is treated as *not shared*, so a corrupt file cannot silently strip MCP from every agent.
- **Project seeding.** `worktree.create.after` (awaited, before workspace setup and agents start) plus `workspace.create.after` / `agent.create.after` create the root → `Trunk` → `General` skeleton for a project that has none, so a fresh worktree or workspace is visible in the dashboard before its first fact. Seeding is idempotent, audited under the actor `paseo`, and never throws into a creation.
- **Agent-scoped activity panel.** "Luck Planner activity" is registered with `addAgentPanel` and reads `params.agentId`; a new Command Center item (*Open this agent's luck-planner activity*, in agent context) opens it. The data is the existing audit trail sliced by actor through the new `luck-planner.agent-activity` RPC, with each row resolved to its node.
- **Registry metadata.** `name` and `media` in `paseo-plugin.json` plus a shipped `OVERVIEW.md`.

The guard also turned out to need one correction the pass could not have predicted: 0.15.0 rejects a shared-service agent for a custom **environment** as well as for custom MCP servers, and this plugin stamps `LUCK_PLANNER_AGENT_ID` for its audit actor — so the open hook skips the stamp when the service is shared and the native tool reads the actor from `context.agent.id` instead. Evidence: vitest **43 suites / 722 tests**, and on an isolated 0.15.0 daemon the guard, both seeding hooks (worktree and workspace) and the refreshed MCP entry (0.40.8, 14 tools) were observed live.

## Paseo 0.14.0 compatibility

Verified against the **stable Paseo 0.14.0** release (2026-10-29) on 2026-11-01 — the plugin's own pass for the new version. Full evidence: [`__doc.md` §10.7](./__doc.md#107-paseo-0140-compatibility-pass-2026-11-01).

**Verdict: compatible, no deprecated API.** The pass itself touched only documentation (it stayed **0.34.1**); the follow-up release **0.35.1** (2026-11-01) implements all six §10.8 recommendations and makes the 0.14.0 surface a hard requirement — the pin is `@getpaseo/plugin@^0.14.0` and `requirements.paseo` is `>=0.14.0` (the real host gate rejects an older daemon and accepts 0.14.0). **0.35.2** (patch, same day) repairs the shipped lockfile — the transitive closure of `@getpaseo/plugin@^0.14.0` had been left out of `package-lock.json`, so the manifest's `npm ci` build step failed on git installs; `npm ci` now verifies clean. Full evidence: [`__doc.md` §10.9](./__doc.md#109-version-0351--implementing-108-2026-11-01).

- None of the `@deprecated` surface `@getpaseo/plugin@0.14.0` declares is used: the UI helpers already come from `@getpaseo/plugin/client/ui` (`SettingsSection`, not the deprecated `SettingsGroup`; `ExternalLink`), the registrations are the modern screen/panel family, and the plugin never subscribes to `agent.turn_ended` (whose `timeline` is deprecated and always empty). The bare `react-native` imports are not a deprecation — the host compiler lists `react-native` as external and the SDK skill's own examples import from it.
- The floor follows the API actually used. It was `>=0.11.0` at pass time (the newest API is `addScreen` / `openScreen`, from 0.11) with an older pin; 0.35.1 adopts 0.14.0's surface (`defineAgentTool`, `agents.ref(id).reload()`, `useTabState`, the session-open `tools` map), so the pin is now `@getpaseo/plugin@^0.14.0` (lockfile updated) and `requirements.paseo` is `>=0.14.0` — the real host gate rejects an older daemon and accepts 0.14.0.
- Evidence for the pass: typecheck + vitest **37 suites / 635 tests** against SDK 0.14.0; both entries built by the **real 0.14.0 host compiler** with zero deprecated strings (a negative control restores the old `client/react-native` import and does produce the hit); `running` in an isolated 0.14.0 daemon with `[paseo] Plugin ready`, 17 RPC methods, the published MCP entry answering `initialize` / `tools/list` (11 tools), the dashboard's `/health` and a clean `paseo plugin reload`. Evidence for 0.35.1: typecheck + vitest **41 suites / 678 tests** (the new agent-record, session-open decision-matrix, agent-tool, focus and `agent-reload` suites, plus the `instructions` handshake in the real-process MCP e2e), both entries built by the real 0.14.0 host compiler with `deprecatedHits: []`, the floor gate rejecting an older daemon with the host's own message, and `running` on an isolated 0.14.0 daemon installed from the working tree with `[paseo] Plugin ready`, `MCP entry refreshed`, the dashboard on its ephemeral-port fallback and a clean reload.
- 0.14.0's idle-runtime release does not affect the plugin: the audit-actor environment is re-injected by the existing `agent.session_open` hook on every open and resume.

**Six recommendations, all implemented in 0.35.1** ([`__doc.md` §10.8](./__doc.md#108-recommendations-for-improvement-implemented-in-0351--109) for what each one was, [§10.9](./__doc.md#109-version-0351--implementing-108-2026-11-01) for what shipped): session-open MCP re-derivation in `before("agent.session_open")` — collision-checked against the daemon's own agent record, capability-probed, with D4's config-file cover keeping ownership of the surface — so it reaches existing agents and survives eviction; a native `luck_tree_upsert_leaf` fallback tool via `defineAgentTool` for providers without MCP; a "Refresh luck-planner tools on this agent" Command Center action on `agents.ref(id).reload()`; panel state through `useTabState`; deep links for the record a command just changed (through the focus mailbox — one documented deviation: 0.14.0's `openPanel` carries no params channel); and MCP `instructions` in `initialize`.

## Paseo 0.12.0 spec conformance

Verified against the **stable Paseo 0.12.0** release (2026-10-22) with the plugin SDK `@getpaseo/plugin@0.12.0`. Full evidence: [`__doc.md` §10.5](./__doc.md#105-paseo-0120-spec-conformance-0322).

**What the new version changed for this plugin:**

- The SDK diff is **additive only** for every API this plugin uses: the client declarations are byte-identical from 0.11.0 to 0.12.0, and the two changed files (the ACP and the provider declarations) cover registrations this plugin does not have. `requirements.paseo` therefore stays `>=0.11.0` — the newest API it uses is `addScreen` / `openScreen`, which arrived in 0.11.
- The plugin never used the deprecated `addSurface` / `addSidebarItem` / `openSurface`; it registers `addScreen`, `addWorkspacePanel`, `addSettingsScreen`, `addCommandCenterItem`, `addSlashCommand` and `addTimelineRenderer`. The client entry, built by the **real 0.12.0 host compiler**, contains zero deprecated calls.
- **One real spec violation was found and fixed.** The plugin read the host's `localStorage` outside `client/web.ts`, which Paseo's cross-platform rules forbid: DOM globals belong in that one module, gated on `Platform.OS === "web"`. The read moved to `client/web.ts`, the parsing to a pure module, and the spec's own client audit now runs as a test.

**Improved in 0.32.2:**

- The settings screen and the dashboard screen honour the host's compact layout (phones, narrow windows).
- The dashboard address is a real link: one tap reaches the dashboard in the system browser when the in-app tab was closed or refused.

**Verified live on a 0.12.0 daemon** (a scratch home; the production daemon untouched): the install from the working tree (`running`), `Plugin ready` in the log, a clean `paseo plugin reload`, the published MCP entry answering `initialize` / `tools/list` / `luck_tree_search`, the dashboard's `/health` and the built web app, and both entries built by the real 0.12.0 host compiler.


## Former root README footnotes

⁴ The 2026-11-01 continuation of the 0.14.0 pass, scoped to **luck-planner**, the last plugin left on a historical verdict (release notes as in ¹). Same method: `@getpaseo/plugin@0.14.0` installed with `npm install --no-save --package-lock=false --legacy-peer-deps`, so `package.json` / `package-lock.json` keep their older pin on purpose — no 0.14.0 API is adopted. Evidence: typecheck + vitest **37 suites / 635 tests**; both entries built by the **real 0.14.0 host compiler** (`compileDirectoryPlugin(directory, "0.14.0")` extracted from the installed `app.asar`) with no boundary errors and **zero deprecated strings** — plus a negative control (a temp entry importing `client/react-native` does produce the hit); the floor enforced by the host's own `assertPluginCompatibility` (rejected at 0.10.0, accepted at 0.11.0 / 0.14.0); and an install **from the working tree into an isolated 0.14.0 daemon** — a scratch home on its own loopback port (6768) with `pluginsEnabled: true`, production home untouched — where it is `running` with `[paseo] Plugin ready`, **17 RPC methods**, the published MCP entry answering `initialize` / `tools/list` (**11 tools**), the dashboard's `/health` and a clean `paseo plugin reload`. The pass touched only documentation: luck-planner stays **0.34.1**, no bump, no tag. Its six improvement recommendations are recorded in [§10.8](./__doc.md#108-recommendations-for-improvement-implemented-in-0351--109).

⁵ The 2026-11-03 pass against the stable **0.15.0** release (2026-11-03) — release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.15.0>. Scope: **bunny-search and session-manager**, the two plugins the first task named, then **remote-control**, and then **luck-planner** (its own pass, the fourth request of the day, which also re-diffed the SDK and re-ran the live daemon checks for itself). Method: the `@getpaseo/plugin@0.14.0` and `@getpaseo/plugin@0.15.0` tarballs unpacked from npm and diffed — four changed paths only (`dist/server/index.d.ts`, `dist/server/lifecycle.d.ts`, `dist/server/lifecycle.js`, `package.json`), **`dist/client/` byte-identical** — then a real pin bump to `^0.15.0`, because the migration needs `addHook`, which 0.14.0's typings do not have. Evidence: typecheck + vitest green against `@getpaseo/plugin@0.15.0` — bunny-search **10 suites / 133 tests** (2 live-search tests skipped by default), session-manager **9 suites / 74 tests**; no `server.before(` / `server.on(` call left in either plugin; both installed **from the working tree into an isolated 0.15.0 daemon** — a scratch home under `.tmp/` on its own loopback port with `pluginsEnabled: true`, production home untouched — where each is `running` with `[paseo] Plugin ready`, **zero** `Unknown lifecycle hook` errors in the daemon log, and the migrated hooks proven to *fire*: `agent.create.before` logged `[bunny-search] MCP injected: …` on a real agent creation, `agent.open.before` logged the session-open decision on a real `paseo send`, and `agent.close.after` logged `[session-manager] agent closed (<id>): listing cache invalidated` on a real agent stop and delete. The same daemon was also used for the OpenCode finding below (plugin on / plugin off / discovery removed). One host-side problem was found and is recorded rather than fixed, because fixing it changes plugin behaviour: **#7435 makes the OpenCode provider reuse a running v2 service, and an agent carrying custom MCP servers is then rejected outright** (`Custom OpenCode MCP servers or process environment require an isolated server …`) whenever a local OpenCode service is registered — which is every agent bunny-search injects into, for the `opencode` provider only; details and the proposed plugin-side fix in [bunny-search §16.3](../bunny-search/__doc.md#163-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150). **remote-control** joined the pass later the same day (this repository's third request), checked against the **SDK version the plugin pins for development**, which trails the runtime, so its diff spans two minor versions: `@getpaseo/plugin`'s `dist/client/` is byte-identical across them and `@getpaseo/client`'s `terminals/` declarations did not move, and it uses **no deprecated API at all** — no lifecycle hooks (`server.before` / `server.on` are simply absent; only `server.handle(...)` ×7), no deprecated client registration or option, and the one breaking type change in its range (`TerminalStreamEvent`'s `snapshot`/`restore` → `replay`) does not reach it because it never subscribes to terminal output. Evidence: typecheck (both projects) + vitest **14 suites / 137 tests** against `@getpaseo/plugin@0.15.0` installed with `--no-save --package-lock=false` (pin and floor stay put — no 0.15.0 API is needed), zero deprecated markers in both compiled bundles with a negative control, and `running` in the same isolated 0.15.0 daemon with all seven RPC methods and an end-to-end console check (`/` 200 HTML, `/health` reporting 0.24.11, `/api/*` 200 with the token and 401 without it). It therefore stays **0.24.11**, no bump and no tag — that pass is documentation only. **luck-planner** was the fourth plugin of the day: the same two tarballs diffed again (same four changed paths, `dist/client/` byte-identical), a real pin bump to `^0.15.0` because its two hooks need `addHook`, and the same isolated 0.15.0 daemon **installed from the working tree** — `running`, `[paseo] Plugin ready`, 15 plugin RPCs + 3 settings methods, **zero** `Unknown lifecycle hook` errors, and both migrated hooks proven to fire on a real agent creation (`[luck-planner] MCP injected: …` from `agent.create.before`, `[luck-planner] session_open … agent.create.before …` from `agent.open.before`); the published MCP entry answered `initialize` (0.39.8) / `tools/list` (**14 tools**) and the dashboard answered `/health` and `/api/tree` (`200` with the token, **`401`** without). Evidence: typecheck (both configurations) + vitest **41 suites / 687 tests**, no `server.before(` / `server.on(` left in the plugin ⇒ **0.39.8**, tag `luck-planner@0.39.8`. That daemon also reproduced the OpenCode shared-service finding for this plugin (injection on: creation fails; `XDG_STATE_HOME` pointed at an empty directory: creation succeeds **with** the injection applied) — analysis and the D4 config-file workaround in [luck-planner §10.10.4](./__doc.md#10104-compatibility-finding-injected-mcp-vs-opencodes-shared-service-0150). Its five recommendations shipped the same day as **0.40.8**, and implementing them produced two facts the pass could not have known: the host rejects a shared-service agent for a custom **environment** as well as for custom MCP servers (measured three ways on the same daemon: plugin disabled → created; guard on but env stamped → refused; guard on and no env → created), and with the create hook gated the `reason=create` open must attach the native tool or a fresh agent has no way to write. Evidence: vitest **43 suites / 722 tests**; the guard, both seeding hooks (`workspace.create.after`, `worktree.create.after`) and the rebuilt MCP entry (0.40.8, 14 tools) observed live on the same isolated daemon — [luck-planner §10.11](./__doc.md#1011-version-0408--implementing-10105-2026-11-03). **Recommendations recorded, not implemented:** [bunny-search §16.4](../bunny-search/__doc.md#164-recommendations-for-improvement-recorded-not-implemented), [session-manager §19.3](../session-manager/__doc.md#193-recommendations-for-improvement) and [luck-planner §10.10.5](./__doc.md#10105-recommendations-for-improvement-recorded-not-implemented).

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

