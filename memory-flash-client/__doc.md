# Memory Flash Client — technical documentation

## 1. Purpose and scope

Memory Flash Client is the client half of [Memory Flash](../memory-flash/__doc.md)'s remote access (0.5.0). A machine running Memory Flash serves its MCP tools over HTTP and issues per-machine API keys; this plugin stores those keys, announces the local client identity, and injects the remote MCP servers into every agent created through Paseo.

Scope:

- a connection registry for remote memory hosts (URL + API key), stored locally with owner-only permissions;
- a connection check that mirrors the handshake a real agent performs;
- identity (client UUID + host name) sent as advisory headers on every request;
- injection of the configured connections into Paseo-created agents as `McpHttpServerConfig`;
- a coexistence check against a locally installed memory-flash.

Out of scope: issuing keys (that is the memory host's job), replication or fan-out across several hosts from one agent, and TLS termination (expect a VPN or an SSH tunnel in front of the endpoint).

## 2. Architecture

```
memory host (memory-flash)                 this machine (memory-flash-client)
┌──────────────────────────┐               ┌───────────────────────────────┐
│ McpHttpServer            │  POST /mcp    │ index.server.ts               │
│  POST /mcp  (JSON-RPC)   │◄─────────────│  agent.create hook            │
│  auth: Bearer <key>      │  Authorization│   → McpHttpServerConfig per  │
│  logs client identity    │  + identity   │     enabled connection       │
│  MemoryStore (SQLite)    │  headers      │ server/probe.ts (checks)      │
└──────────────────────────┘               │ server/connections.ts (store) │
                                           │ server/identity.ts            │
                                           │ server/conflict.ts            │
                                           └───────────────────────────────┘
```

Modules:

| File | Responsibility |
| ---- | -------------- |
| `shared/contracts.ts` | Zod schemas, value types and every RPC contract. |
| `shared/settings.ts` | Host-scoped settings: identity and injection options. |
| `server/connections.ts` | `connections.json` CRUD, URL normalization, secret redaction. |
| `server/identity.ts` | UUID generation/validation, hostname resolution. |
| `server/probe.ts` | Connection check: `/healthz` + `initialize` + `tools/list`. |
| `server/conflict.ts` | Coexistence detection with a local memory-flash. |
| `server/opencode-service.ts` | Shared OpenCode v2 service detection (0.15.0 #7435) so MCP injection can degrade instead of failing the open. |
| `index.server.ts` | Settings, identity fallback, the `agent.create` hook, the RPCs. |
| `client/connections-surface.tsx` | Sidebar surface: connection list, add form, Test/Check. |
| `client/settings-screen.tsx` | Settings → Plugins → Memory Flash Client. |

## 3. Connections

`connections.json` (version 1) lives at `$PASEO_HOME/plugins/memory-flash-client/connections.json` and is written atomically (temp file in the same directory + rename) with mode `0600` inside a `0700` directory, because it holds API keys. A missing or corrupted file is treated as an empty registry rather than an error, so a bad edit cannot brick the plugin.

Each record:

| Field | Meaning |
| ----- | ------- |
| `id` | `conn_<base36>`; supplied id wins (used by the UI to update) |
| `label` | human name, e.g. `office-memory` |
| `url` | MCP endpoint, normalized: scheme defaulted to `http://`, empty path set to `/mcp` |
| `secret` | the API key (`mf_live_…`) — written here, never returned to the UI |
| `keyPrefix` | first 12 characters, the only key material the UI ever sees |
| `enabled` | whether the connection is injected into agents |
| `status`, `lastError`, `checkedAt` | set only by the probe, preserved across edits |

`listViews()` / `toView()` strip `secret`, so the RPC surface cannot leak it even by accident. This is asserted by tests.

## 4. Identity

The identity is a pair: a stable client UUID and a host name. Both come from plugin settings; both are sent as headers on every MCP request.

- `clientId` — a pinned UUID from settings wins. When it is empty or malformed the plugin generates one (`crypto.randomUUID`) on first use and keeps it for the lifetime of the daemon process, so every agent created in that window presents the same identity. The `regenerateClientId` RPC rotates it and the settings screen pins the new value, which makes the rotation survive a restart.
- `hostname` — a settings override, else `os.hostname()`.

Headers:

```
X-Memory-Flash-Client-Id: 3f9c…-…
X-Memory-Flash-Host: studio-laptop
```

They are advisory. The memory host authenticates on the API key alone and uses the headers only for its audit log. `sendIdentityHeaders: false` omits them for a memory host that does not understand them; the key remains the credential.

### 4.1 Settings schema constraints (since 0.1.2)

`shared/settings.ts` declares `clientId: z.string().trim().max(64).default("").refine(v => v === "" || UUID_RE.test(v))` and `hostname: z.string().trim().max(80).default("")`. Neither field has a minimum length, because the empty string is the documented "use the generated value" state that `resolveIdentity` (see §4) resolves to a fresh UUID and `os.hostname()`.

Before 0.1.2 both fields carried `min(8)` / `min(1)` while defaulting to `""`, which made a fresh install report `status: "invalid"`. The mechanism matters, because it is a general hazard for plugin schemas:

1. The daemon (`plugins/settings/index.js` → `read()`) finds no settings file, parses `{}` and gets the defaults back with `status: "ready"`. In Zod 4 a `.default()` value does not pass through the field's own checks.
2. The client (`useSettings`) calls `safeParse(state.values)` on those already-expanded values. The keys now exist, `.default()` no longer applies, and `min()` is enforced — so the store flips to `invalid` with `too_small` issues for `clientId` and `hostname`.
3. `client/settings-screen.tsx` renders `settings.error` verbatim in that state, so the user saw the pretty-printed Zod issue array and had no way to recover: the form, `patch()` and `reset()` are all behind the `status === "ready"` branch, and a `save` would have been rejected by the same schema anyway.

The rule for every plugin schema here: **a default must satisfy its own schema, and a constraint that would reject the default belongs on the value only when it is set** (the `.refine()` above) rather than on the type. `tests/settings-schema.test.ts` pins this down with `schema.parse(schema.parse({}))` plus the daemon→client round trip.

## 5. Agent skill (since 0.2.0)

The plugin ships its own `SKILL.md` — `memory-flash-remote` — installed into the same agent skill directories as the memory-flash skill (`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.qwen/skills`, `~/.cline/skills`, `~/.kilo/skills`, `$KIMI_CODE_HOME/skills` — `~/.kimi-code/skills` by default). The settings screen has an **Agent skill** card: *Install into all agents*, one Install/Remove/Update row per target with an `installed · up to date | outdated` state, a message line and a preview of the first lines.

**Why the client needs its own skill.** The injected MCP servers make the `memory_*` tools *available* on the client machine, but availability is not usage. Without instruction, an agent treats them as an optional extra on a machine that "does not have the memory plugin", searches once at most, and writes nothing — which is exactly when the shared base is worth the most: before a task, and right after a fix. Because the two plugins are installed independently (a client machine has no memory-flash at all), memory-flash's own `SKILL.md` is not present there.

**What it says.** The protocol mirrors [memory-flash/__doc.md §5](../memory-flash/__doc.md) — 2–4 differently worded searches before a non-trivial task, `memory_get` instead of trusting a snippet, widen before concluding nothing is known, every bugfix / positive result / user correction written back, search-before-save to avoid duplicates, mandatory project+topic tagging, always a handoff — with three adaptations that only make sense across the network:

**Strengthened in 0.2.2 (§17.4):** the frontmatter `description` now opens with "treat it as **mandatory, not optional**" and requires the agent to name any skipped step in its final answer, and the body gained a `## The non-negotiable baseline` checklist (search before the first edit / save the bugfix the moment it is fixed / save decisions and corrections when they happen / leave a handoff before stopping) with explicit anti-shortcut rules.

| Remote fact | Consequence in the skill |
| ----------- | ------------------------ |
| The database belongs to the memory host and is shared with other machines | Write for an agent that has no access to this machine's files; the handoff must be self-contained. |
| Access is decided by the key's scope | A `read` key exposes only `memory_search`, `memory_get`, `memory_list_by_tag`, `memory_stats`; write tools are refused with an insufficient-scope error, which the agent must report rather than silently skip. |
| Requests cross the network | Batch related work, but never skip a search because of latency. |

It also warns that several configured hosts expose identically named tools (§13).

Implementation: `server/skill.ts` — `skillMarkdown()` / `skillFiles()` / `skillTargets()` / `skillStatuses()` / `installSkill()` / `uninstallSkill()`, the same shape as memory-flash's module. `REMOTE_TOOL_NAMES` is a literal list rather than an import: this plugin must stay free of non-host dependencies so it installs from a clean checkout with no build step (see §12), and the two plugins are separate checkouts.

---

## 6. Connection check

`probeConnection(url, secret, identity)` in `server/probe.ts` runs the same three steps a real agent performs, each with its own 8 s timeout and `AbortController`, and returns a `ConnectionCheck`:

1. `GET /healthz` (same origin, derived from the MCP URL) — liveness. Fails fast with a hint to enable the memory host's HTTP endpoint when the answer is not 200.
2. `POST /mcp` `initialize` with `Authorization: Bearer <key>` — the MCP handshake. `401`/`403` is translated into "the memory host rejected the API key. Generate a new key…", never echoing the key back. A result without `serverInfo` is treated as "this is not a memory-flash endpoint".
3. `POST /mcp` `tools/list` — proves the key is not merely valid but granted tool access; the count is reported, which doubles as a scope check (a read-only key shows fewer tools).

`checkedAt` and latency are recorded on the connection so the surface can show a status line. The check never logs the secret and never throws — failures come back as `status: "error"` with a readable message (refused, DNS, timeout, non-200, JSON-RPC error). `checkConnectionDraft` runs the same probe for an unsaved URL + key, so the UI can validate before saving.

## 7. MCP injection

Each enabled connection becomes one HTTP MCP server in the agent config, built as an `as const` literal and type-checked where it is stored into `mcpServers` — the plugin deliberately does not import the MCP config types from `@getpaseo/protocol`, which Paseo does not supply to plugins.

The `agent.create` before-hook adds one HTTP MCP server per enabled connection:

```ts
{
  type: "http",
  url: "http://100.64.0.2:8787/mcp",
  headers: {
    Authorization: "Bearer mf_live_…",
    "X-Memory-Flash-Client-Id": "<uuid>",
    "X-Memory-Flash-Host": "<host>",
  },
  alwaysLoad: true,
}
```

Naming: a single enabled connection is named exactly `mcpServerName` (default `memory-flash`); with several, each becomes `<mcpServerName>-<connectionId>` so names stay unique inside one agent. Disabled connections are skipped. Existing MCP servers on the request are preserved (the map is spread, not replaced). When injection is off, or no connection is enabled, the hook returns the request untouched.

The injection log line (`[memory-flash-client] MCP injected: <name> → <url> (client <host>)`) deliberately omits the key, so plugin logs are safe to paste into an issue.

## 8. Coexistence with memory-flash (conflict check)

`server/conflict.ts` answers one question: is memory-flash also installed on this host? It reads `$PASEO_HOME/config.json` (the `plugins` map, honouring `enabled: false`) and checks for `$PASEO_HOME/plugins/memory-flash`, and reports:

- `memoryFlashInstalled` — whether a local memory host exists;
- `conflict` — always `false` today. The two plugins have disjoint roles and no shared state: memory-flash owns this machine's `memory.db` and injects a stdio server; memory-flash-client only holds remote connections and injects HTTP servers under its own names. The field is computed (not hard-coded) so a genuine overlap — a colliding server name, a shared store — has a place to surface as a blocking conflict;
- `singleMemoryHost` — `true`: exactly one memory-flash per host is assumed, so no ambiguity is designed in;
- `note` — an advisory sentence rendered in the UI explaining that running both is allowed, or that this installation only connects to remote hosts.

Detection is filesystem/config-based on purpose: it needs no daemon RPC and works even when the memory-flash plugin is disabled but its data directory still exists.

## 9. RPC surface

| Contract | Input | Output |
| --- | --- | --- |
| `memory-flash-client.connections` | `{}` | `{ connections: [ConnectionView] }` (no secrets) |
| `memory-flash-client.connections-save` | `{ connection: {id?, label, url, secret, enabled} }` | `{ ok, id, error }` |
| `memory-flash-client.connections-delete` | `{ id }` | `{ ok }` |
| `memory-flash-client.connections-check` | `{ id }` | `ConnectionCheck` (persists status) |
| `memory-flash-client.connections-check-draft` | `{ url, secret }` | `ConnectionCheck` (does not persist) |
| `memory-flash-client.status` | `{}` | `{ clientId, hostname, identityHost, totalConnections, enabledConnections, okConnections, injectIntoAgents, mcpServerName, connectionsPath }` |
| `memory-flash-client.conflict-check` | `{}` | `ConflictCheck` |
| `memory-flash-client.regenerate-id` | `{}` | `{ clientId }` |
| `memory-flash-client.skill-preview` | `{}` | `{ markdown }` |
| `memory-flash-client.skill-status` | `{}` | `{ targets: [SkillStatusTarget] }` |
| `memory-flash-client.skill-install` | `{ targetId }` | `{ ok, path, error }` |
| `memory-flash-client.skill-uninstall` | `{ targetId }` | `{ ok, error }` |

## 10. Security posture

| Measure | Where |
| ------- | ----- |
| Key stored owner-only, never in git | `connections.ts` — `0600` file in a `0700` directory |
| Key never returned to the UI | `toView()` strips it; the save RPC echoes back only `{ok, id, error}` |
| Key never logged | the injection and probe logs print URL and name only |
| Key never in an agent prompt | the key lives in the MCP config header, not in any prompt text |
| No automatic issuance | the user pastes a key generated on the memory host; nothing is requested over the network |
| Per-connection revoke | removing a connection here plus revoking the key there cuts access |

The residual risk is inherent to the design and accepted: a client that stores a bearer key locally is a bearer credential, so the file is the trust boundary, and the memory host must be reachable only over a trusted network (VPN/LAN/loopback) or behind HTTPS.

## 11. Tests

- `tests/connections.test.ts` — CRUD, URL normalization, prefix derivation, secret redaction, 0600 permissions, state preservation on edit, corruption recovery.
- `tests/probe.test.ts` — a stub memory-flash server: success path, Bearer + identity headers present, 401, missing `/healthz`, broken handshake, unreachable host, health-URL derivation, `host:port` paste.
- `tests/identity-conflict.test.ts` — conflict detection (config entry, data dir, disabled entry, corrupted config, both plugins present), UUID generation/validation, hostname resolution.
- `tests/skill.test.ts` — the agent skill: frontmatter shape, every remote tool named, the intensive read/write rules present, the remote-specific notes (shared host, key scope, several hosts), and install → status → uninstall against a temporary `HOME` (nothing touches the real agent skill directories).
- `tests/settings-schema.test.ts` — the settings schema contract: defaults expand, `schema.parse(schema.parse({}))` round-trips (the fresh-install regression for §4.1), pinned UUID validation and trimming, upper bounds.
- `tests/server-contribution.test.ts` — the `agent.create` hook with a fake `PluginServerContext`: injection shape, pinned vs generated UUID, stability across agents, multi-connection naming, disabled/skip/preserve behaviour, identity-header toggle, and the RPC surface (list/save/delete, status counts, missing-connection check, conflict check, UUID regeneration).

## 12. Compatibility

Current: **verified on 2026-10-29 against Paseo `0.14.0`** with
`@getpaseo/plugin@0.14.0` (installed with `--no-save`, so the manifest pin
stays `0.12.0`) — no code change needed and no deprecated API in the plugin;
static evidence only, because the plugin is not installed on the machine the
pass ran on (it is present but `disabled`) — see §17. Shipped as `0.2.2` for
the strengthened agent skill (§17.4), not for a 0.14.0 finding.

Earlier, built against Paseo `0.10.3` with `@getpaseo/plugin@0.10.1`:

- `npm run typecheck` — clean.
- `npm test` — 6 suites, 53 tests, green (47 before the 0.2.0 agent-skill suite).
- Uses: `registerSettings`, `before("agent.create")`, `handle`, and the host's own MCP config type (`type: "http"`, `url`, `headers`) reached through `request.config.mcpServers`.
- Fix verification for 0.1.2 was done against the same Zod version the host ships (`zod@4.6.5`): the daemon step (`schema.parse({})`) and the client step (`safeParse(expanded)`) were executed directly against `shared/settings.ts` and both succeed, and `tests/settings-schema.test.ts` locks the behaviour in. Host-side re-check: `paseo plugin update memory-flash-client` on the machine where the plugin is installed, then open the settings screen — it must render the form with both identity fields empty instead of a Zod issue list.
- Since 0.1.1 the plugin references **no package outside Paseo's host-supplied list**, so it has no install-time build step: `paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash-client` clones into `~/.paseo/plugins/memory-flash-client/<revision>/checkout/memory-flash-client` and bundles it there with no npm-registry access. Before that it carried a type-only import of `McpHttpServerConfig` from `@getpaseo/protocol/agent-types`, which is not host-supplied and made the host's bundler fail with `Could not resolve type dependency` whenever `node_modules` was absent. See [__doc.md](../command-center/__doc.md#5f-version-051--install-time-resolution-and-the-host-bundler-boundary) in command-center for the host-side rules.

## 13. Limitations and roadmap

- **One key per connection, no rotation helper.** Rotating means generating a new key on the memory host, editing the connection, then revoking the old key. A "rotate" action that walks both sides would be nicer.
- **No TLS.** The endpoint is plain HTTP by design; a VPN or an SSH tunnel is the intended front. A future `https` URL is already accepted by the URL normalizer.
- **No fan-out.** Each agent gets the tools of every enabled connection, which means the same tool names (`memory_search`, …) can appear more than once when several hosts are enabled. A future release could namespace tools per connection.
- **The generated UUID is per-process until pinned.** Restarting the daemon yields a new generated identity unless the user pins one; the memory host therefore sees a new client id after each restart. Pinning is one click in the settings screen.
- **Git source only.** The plugin must be installed with `paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash-client` so it runs from `~/.paseo/plugins/memory-flash-client/<revision>/checkout/memory-flash-client`. A local-directory source is not supported: it executes the plugin from the working copy instead of the Paseo home. Updates go through `paseo plugin update memory-flash-client`. The machine that *serves* the memory needs no plugin at all — an HTTP MCP URL plus an API key are sufficient.

## 14. Planned improvements with Paseo 0.11.0

Compatibility with the 0.11.0 prerelease (`v0.11.0-beta.5`, verified 2026-10-06)
is established: the SDK diff `@getpaseo/plugin@0.10.1 → 0.11.0-beta.5` is purely
additive for every API this plugin uses; `npm run typecheck` and `npm test`
(6 suites, 53 tests) pass against the 0.11.0 SDK; the real host compiler
(`compilePlugin` from 0.11.0-beta.5) bundles the plugin with SDK 0.11.0 and with
host-supplied imports only (this plugin has no install-time build); the
manifest's `requirements.paseo >=0.10.0` passes `assertPluginCompatibility` for
a 0.11.0-beta.5 daemon and app; and a live Git install on an isolated
0.11.0-beta.5 daemon reached status `running`, with `memory-flash-client.status`
answering over the wire. No code changes are required for 0.11.0.

The following new 0.11.0 capabilities are relevant to this plugin. **They are
planned for implementation after the stable Paseo 0.11.0 release, on request:**

1. **Screen/sidebar modernization** — migrate the deprecated `addSurface` /
   `addSidebarItem` / `openSurface` (used in `index.client.tsx`) to `addScreen` /
   `addSidebarHeaderItem` / `openScreen`; ~~the host's compatibility shims are
   scheduled for removal after **2027-03-29**.~~ **Superseded by §15.2: done in
   0.2.1, and the 2027-03-29 date was wrong — no removal marker exists on these
   shims in 0.12.0 (§15.1).** What remains of this item is the layout work:
   `PluginScreenProps.params` would
   let a deep link open the Memory Hosts screen on an exact connection (e.g.
   from a Command Center item), `PluginScreenTitle` can derive the header from
   it, and `SidebarRow` / `SidebarSeparator` / `addSidebarFooterItem` give the
   connection list and add form a host-native multi-row layout.
2. **`agent.closed` lifecycle event** — new hook payload
   (`"agent.closed": { agent: PluginHookAgent }`), a counterpart to the
   `agent.create` before-hook the injection already uses (§7). The plugin could
   release per-agent state for the injected HTTP MCP connections and record
   last-used statistics per connection when an agent closes — data the memory
   host's audit log cannot attribute, since it only sees the shared API key.

## 15. Paseo 0.12.0 — spec conformance (2026-10-21)

Audited and migrated against the stable `0.12.0` release (2026-10-19).
Release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.12.0>.
The general spec rules (screen/sidebar API, `requirements.paseo` semantics,
ID charset, the `client/web.ts` DOM-global rule, manifest fields) are
spelled out in bunny-search §13; this section records what is specific to
Memory Flash Client.

### 15.1 What 0.12.0 changed for this plugin

| Check | Result |
| --- | --- |
| SDK diff `@getpaseo/plugin@0.10.1 → 0.12.0` | **Additive only** for the API surface used here. `0.11.0 → 0.12.0` client declarations (`client/contracts.d.ts`, `client/ui.d.ts`) are byte-identical, so the migrated API is 0.11.0-compatible and `requirements.paseo` is `>=0.11.0`, not `>=0.12.0`. |
| Deprecated client members | `addSurface`, `addSidebarItem` (+ `PluginSidebarContribution`), `openSurface` remain in 0.12.0 with `@deprecated` JSDoc and **no removal version**; the shipped app bundle still implements them as shims over `addScreen` / the header-item registry / `openScreen`. |
| **Correction: the "2027-03-29" removal date** | §14.1 and the old README stated the shims were "scheduled for removal after **2027-03-29**". **Wrong for 0.12.0**: grepping the 0.12.0 server package and the shipped app bundle, `2027-03-29` appears only on `COMPAT(codexFastPreference)` and `COMPAT(pluginProviderLaunch)` — unrelated. The surface/sidebar shims carry no COMPAT marker and no date. §14.1 is marked superseded. |
| `#7023` — `Could not resolve type dependency` | The one 0.12.0 fix with real history for this plugin. §12 records that 0.1.1 removed a type-only import of `McpHttpServerConfig` from `@getpaseo/protocol/agent-types` because the host's bundler demanded a plugin-local install of a package it does not supply. **0.12.0 relaxes exactly this**: type-only `@getpaseo/protocol/*` imports are now erased at compile time with no local install; runtime imports of a non-host-supplied package are still rejected. The `as const` + host-type-check workaround is **kept** — it costs nothing, keeps the plugin installable with no build step, and remains compatible with 0.11.x hosts. |
| Install-time build step | Still **none**. This plugin references no package outside Paseo's host-supplied list, so `paseo plugin add` clones and bundles with no npm-registry access. Unchanged and still the plugin's sharpest install property. |
| `#6306` | `paseo plugin reload` no longer fails with a 60-second timeout while the reload is still running — relevant to the documented `paseo plugin update memory-flash-client` workflow. |
| Other 0.12.0 plugin fixes | `#6760` (`providers.waitForReady` on mobile), `#6690`/`#7253` (timeline-plugin prompt rendering), `#7110` (Escape closes a plugin preview first), `#7270` (follow-ups to a plugin ACP agent), `#7341` (late-loading composer pills). None apply: no timeline items, no composer pills, no ACP agent, no `waitForReady`. |
| `PluginSurfaceProps` | Not deprecated — still the settings-screen prop type, so `client/settings-screen.tsx` keeps it. Only the Memory Hosts screen moved to `PluginScreenProps`. |
| Server/API surface used | `registerSettings`, `before("agent.create")`, `handle` — all unchanged in 0.12.0. The injected MCP config shape (`type: "http"`, `url`, `headers`) is a runtime value built by the plugin, not a type import, so `#7023` does not affect it. |
| Manifest | `requirements.paseo` `>=0.10.0` → `>=0.11.0`. No `build` key, and none needed. |

### 15.2 Migration performed (version 0.2.0 → 0.2.1)

`index.client.tsx`:

| Before | After |
| --- | --- |
| `client.addSurface(SURFACE_ID, ConnectionsSurface)` | `client.addScreen({ id, title: "Memory Hosts", Component })` |
| `client.addSidebarItem({ id, title, icon, surface })` | `client.addSidebarHeaderItem({ id, title, Component })` rendering `<SidebarRow icon="Database" active onPress>` |
| `onSelect({ openSurface })` | `onSelect({ openScreen })` → `openScreen({ screenId })` |

The screen `title` is `"Memory Hosts"` — the name the sidebar row and the
Command Center item already used for this entry point — rather than the raw
contribution id, which is what the deprecated `addSurface` shim would have
shown as the header (its shim passes `title: id`).

`client/connections-surface.tsx`: `PluginSurfaceProps` → `PluginScreenProps`.

`client/use-host-typography.ts` now calls `readHostTypography()` from the new
`client/web.ts` (gated on `Platform.OS === "web"`, `null` on native) instead
of reading `globalThis.localStorage` itself — §15.3.

`package.json`: `@getpaseo/plugin` `0.10.1` → `0.12.0`, version `0.2.0` → `0.2.1`.
`paseo-plugin.json`: `requirements.paseo` `>=0.10.0` → `>=0.11.0`.

### 15.3 The 0.12.0 cross-platform audit

The 0.12.0 client audit flags a DOM global (`window`, `document`,
`localStorage`, `navigator`, `location`) in any `client/` module other than
`client/web.ts` as a bug, and forbids HTML elements, `className` and `onClick`.

| Target | Result |
| --- | --- |
| `client/use-host-typography.ts` | **was a violation** (read `globalThis.localStorage` directly) → **fixed** by the new `client/web.ts` |
| Rest of `client/` | clean — a word-boundary check for DOM identifiers used as code finds none |
| HTML elements / `className` / `onClick` in `client/` | none — React Native only |
| `"DOM"` in `lib`, `/// <reference lib="dom" />` | none — `tsconfig.json` uses `"lib": ["ES2023"]` |
| `shared/host-fonts.ts` | takes the storage object as a **parameter**; never reaches for a global |

### 15.4 Verification (2026-10-21, this machine)

| Check | Result |
| --- | --- |
| `npm install` with `@getpaseo/plugin@0.12.0` | exit 0; lockfile updated |
| `npm run typecheck` | **exit 0** |
| `npm test` | **6 suites / 53 tests pass** — includes the HTTP probe against a stub memory-flash server, the MCP-injection tests, the settings-schema round-trip regression and the agent-skill suite |
| 0.12.0 client audit (DOM globals outside `client/web.ts`, HTML, `className`, `onClick`) | **clean** |
| `"DOM"` / `reference lib="dom"` | clean |
| Remaining deprecated registrations in `client/` | **none** |
| Contribution ID charset | conforms (`memory-flash-client`, `memory-flash-client-settings`, `open-memory-flash-client`) |
| `requirements.paseo` | `>=0.11.0` — matches the APIs actually used |
| Live install on a running 0.12.0 daemon | **PASS** — installed from the working tree into an isolated 0.12.0 daemon (scratch home, production config untouched): status `running`, `Plugin ready` in the log, no errors. The real 0.12.0 host compiler (`compilePlugin`) built the client entry; the compiled bundle contains the new API and **zero** legacy registrations. `paseo plugin reload memory-flash-client` exits 0 and the plugin restarts cleanly (the 0.12.0 #6306 fix). |

### 15.5 Not adopted (from §14; 0.12.0 changes none of them)

1. **Layout work on the Memory Hosts screen** — `SidebarRow`/
   `SidebarSeparator` grouping, an `addSidebarFooterItem` entry, and deep
   links to an exact connection through `PluginScreenProps.params` with
   `PluginScreenTitle` deriving the header. The *registration* half of §14.1
   is done (§15.2); this half is new functionality → second-digit bump.
2. **`agent.closed` lifecycle event** — release per-agent state of the
   injected HTTP MCP connections and record last-used statistics per
   connection. Still new functionality.

Version `0.2.0` → `0.2.1` (existing-registration migration + a real audit
fix, no new capability → last digit), annotated tag
`memory-flash-client@0.2.1`.

## 17. Paseo 0.14.0 — compatibility pass (2026-10-29)

Audited against the stable `0.14.0` release (2026-10-29).
Release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.14.0>.
The repository-wide inventory of what 0.14.0 adds and deprecates is in the
root [README](../README.md#paseo-0140--new-and-deprecated-sdk-surface-2026-10-29);
this section records what is specific to memory-flash-client.

**Result: compatible, no code change was required for 0.14.0 and no
deprecated API exists in the plugin.** The version still moved — `0.2.1 →
0.2.2` — because that same commit strengthened the agent skill (§17.4).

A follow-up release, **`0.3.2`**, then implemented the recommendations from
§17.2 on the new surface: the `agent.session_open` contribution and the
"repair remote memory tools" action built on `agents.ref(id).reload()`.
New functionality ⇒ the minor digit moved (`0.2.2 → 0.3.2`); the design and
its collision rules are recorded in §17.5.

**Evidence caveat, stated plainly:** the plugin is **not installed on the
machine the pass ran on** (it is present but `disabled`), so there is no live
0.14.0 daemon evidence. The result rests on the SDK diff, typecheck, the full
test suite, the real 0.14.0 host compiler and the real 0.14.0 manifest parser.

### 17.1 What 0.14.0 changed for this plugin

| Check | Result |
| --- | --- |
| Registrations used | `addScreen`, `addSidebarHeaderItem`, `addSettingsScreen`, `addCommandCenterItem` — none deprecated; the entire `dist/client/` tree of `@getpaseo/plugin` is **byte-identical** across that step, so none of them can have moved. |
| `@deprecated` list | **Byte-identical across that step**; 0.14.0 adds no new deprecation, and the plugin avoids every existing one (it never used `client/react-native`). |
| Hooks used | `server.before("agent.create")` (saved-config MCP injection) plus, since 0.3.2, `server.before("agent.session_open")` (launch-only contribution) — `PluginLifecycleRegistration.before` is unchanged and not deprecated. |
| New hook `agent.session_open` | **Additive**, with editable `tools` and `mcpServers` maps per plugin per open (`create`/`resume`/`refresh`/`import`). **Used since 0.3.2** (`mcpServers` only — see §17.2, §17.5; no attached tool, on purpose). |
| `server.addHook("agent.open.before")` | **Documented but absent in 0.14.0** — neither the published SDK nor the installed host contains `addHook`; the working surface today is `before("agent.session_open")`. Details: [memory-flash/__doc.md §18.1](../memory-flash/__doc.md). |
| `agent.turn_ended` `timeline`, `SettingsGroup`, panel `context`/`agentId`, `CreateAgentRequestOptions.git`/`worktreeName` | None used. |
| Client audit (DOM globals outside `client/web.ts`) | Still clean. |
| Manifest | Passes the real 0.14.0 `readPluginManifest`; `requirements.paseo` stays `>=0.11.0`. |
| Install-time build | Still **none** — every import is on the host-supplied list, so the plugin installs with no npm-registry access. |
| Remote-host side | The plugin's HTTP probe talks to a **memory-flash** host, not to Paseo's SDK; 0.14.0's speech models, chat-display settings and idle-runtime release do not overlap with the connections registry (§3). The idle release *does* matter indirectly: a resumed session is a `session_open`, the position recommendation 1 targets. |

### 17.2 New 0.14.0 surface — recommendations, implemented in 0.3.2

Recorded during the compatibility pass; kept because it explains the shape of
the code that now implements it (§17.5).

1. **Inject the remote HTTP servers in `before("agent.session_open")`** in
   addition to `before("agent.create")`. The hook re-runs on create *and*
   resume/refresh/import and re-derives its `mcpServers` map on every open, so
   a remote server that left the agent's saved config (OpenCode's
   per-directory eviction) is restored on the next prompt, and **already
   created** agents get it without being recreated. Trap: a name colliding
   with a saved server **fails the session open**, so the contribution must
   skip any name the agent's saved configuration already carries, and
   `purpose: "history"` opens ignore these servers.
   **As implemented (0.3.2):** the same two-layer scheme as memory-flash
   §18.5 — `agent.create` keeps writing the saved config, session-open
   contributes only names absent from it. The saved set is read from the
   daemon's own agent record (`server/agent-record.ts`, `$PASEO_HOME/agents/
   <workspace>/<agentId>.json`); every unreadable or unknown state — record
   missing, no `config` object, snapshot unavailable, `reason: "create"` —
   resolves to *skip*, so the hook can never break an open. This is the same
   recommendation as memory-flash §18.2.1, implemented in both plugins.
2. **A "repair memory tools" action** built on the new
   `agents.ref(id).reload()`, which reopens the session with current config and
   reruns the session-open hooks. It answers the most common support case
   (tools missing after an idle restart) with one button instead of
   "recreate the agent".
   **As implemented (0.3.2):** the `memory-flash-client.agent-reload` RPC plus
   the Command Center item *"Repair remote memory tools (reopen this agent's
   session)"* (`context: "agent"`); a refused reload throws into a host error
   toast instead of failing silently.
3. **Not recommended here: `defineAgentTool`.** The tools belong to the remote
   host; attaching local ones would create a second, differently capable memory
   surface on the client machine and confuse which base an agent is writing to.
   **Still true in 0.3.2** — the session-open hook contributes `mcpServers`
   and no `tools`, and the client's README repeats the reason.

### 17.3 Verification (2026-10-29, this machine)

| Check | Result |
| --- | --- |
| SDK installation | During the pass: `npm install --no-save --package-lock=false @getpaseo/plugin@0.14.0 @getpaseo/client@0.14.0 @getpaseo/protocol@0.14.0`, pin untouched. **`0.3.2` then moved the pin to `^0.14.0` for real** — `agent.session_open` and `reload()` are 0.14.0 API, so `requirements.paseo` became `>=0.14.0` at the same time. |
| `npm run typecheck` against 0.14.0 | **exit 0** (before and after the §17.4 skill change, and after §17.5). |
| `npm test` | At the pass: **6 suites / 53 tests pass** — the HTTP probe against a stub memory-flash server, MCP-injection, settings-schema round-trip and the agent-skill suite. After §17.5: **6 suites / 61 tests**. |
| Real 0.14.0 host compiler (`compileDirectoryPlugin` + `readPluginManifest` from the installed `app.asar`) | **Manifest accepted; both entries compile, no boundary errors**; **zero** deprecated calls in the bundles. Re-run after the §17.4 edits: same result. |
| Live on a 0.14.0 daemon | **Not available** — the plugin is not installed (status `disabled`) on this 0.14.0 machine. The §15 evidence stands; a live check happens the first time it is installed or updated on a 0.14.0 host. |
| Post-check cleanup | SDKs restored to `0.12.0`, `git status` shows only this pass's intended files. |

### 17.4 `0.2.2` — the agent recommendation strengthened

Availability is not usage (§5), so the wording is the plugin's main lever.
Two surfaces an agent reads were strengthened:

1. **Skill frontmatter `description`** — now opens with "treat it as
   **mandatory, not optional**: a non-trivial task starts with a search and
   ends with a handoff", keeps the 2-4-query requirement, states that a bugfix
   is written back *the moment it is fixed, never at the end of the session*,
   and requires the agent to name a skipped step in its final answer instead
   of staying silent.
2. **New `## The non-negotiable baseline` section** before §1 — the four steps
   as a numbered checklist declared part of the definition of a *finished*
   task, plus anti-shortcut rules (one empty query is not a search; a
   transport error does not cancel the handoff — retry, then report what was
   skipped).

The existing skill tests assert frontmatter shape, the presence of every tool
name and the key phrases (`2-4`, `Every bugfix is recorded`, …); all of them
stay green, so no test change was needed.

### 17.5 `0.3.2` — the 0.14.0 features implemented

Two additions, both re-derived on every session open rather than persisted:

**1. `agent.session_open` contribution (`index.server.ts`,
`server/session-open.ts`, `server/agent-record.ts`).** Every *enabled*
connection becomes the same HTTP MCP entry the `agent.create` hook writes
(`type: "http"`, `url`, `Authorization: Bearer …`, optional identity headers,
`alwaysLoad: true`), with the same naming rule (one connection → plain
`mcpServerName`, several → `<name>-<connectionId>`), so the saved and the
launch-time registration cannot drift apart. The contribution is skipped
unless *all* of the following hold:

- `injectIntoAgents` is on and at least one connection is enabled;
- `purpose !== "history"` and `reason !== "create"` (creation belongs to the
  `agent.create` hook, whose write the record has not caught up with yet);
- the provider reports `capabilities.supportsMcpServers === true`;
- the agent's saved configuration **does not already carry the name** — a
  collision fails the host's session open, so a name already present is left
  to the host's own launch of the saved entry.

The saved set comes from the daemon's own record
(`$PASEO_HOME/agents/<workspace>/<agentId>.json`), because neither the hook
nor the SDK can see it. **Every failure mode resolves to *skip*** — record
missing, no `config` object, unparseable JSON, snapshot unavailable,
capabilities unknown — so the hook can only ever do nothing, never break an
open. `decideClientSessionOpen` is a pure function so the whole matrix is
unit-tested without a daemon.

Unlike memory-flash, **no tool is attached**: the tools belong to the remote
host (§17.2 item 3), and a local copy would give an agent two different
answers to "what is in the memory?" depending on which transport answered.

**2. "Repair remote memory tools" (`memory-flash-client.agent-reload` +
Command Center item).** `agents.ref(id).reload()` reopens the provider session
with its current configuration, which reruns `agent.session_open` and
re-contributes the remote servers. The item runs in `context: "agent"`, so the
agent id is the host's; `reload()` returning `null` or throwing surfaces as a
host error toast (`ok: false` + `error` over the RPC) instead of silence.

Verification after the change (2026-10-29): `npm run typecheck` exit 0,
`npm test` **6 suites / 61 tests** — the session-open suite covers injection,
the collision skip, `reason=create`, the three fail-safe paths, the off switch
and the no-connection case; the reload suite covers success and a refused
reload.

## 18. Paseo 0.15.0 — shared OpenCode service: graceful degradation (0.5.2)

The 0.15.0 host (#7435, "Reuse running OpenCode v2 services") lets the
`opencode` provider connect to an already running OpenCode v2 service instead
of owning one, and refuses any agent that carries custom MCP servers on such a
service:
`Custom OpenCode MCP servers or process environment require an isolated server
and cannot be used with a shared OpenCode service.`
The rule was read out of the installed host (`@getpaseo/server`,
`agent/providers/opencode/v2/`): `requiresDedicatedV2Server()` is true as soon
as the agent's config carries any `mcpServers` — which is every agent this
plugin injects into — `V2Runtime.acquire()` calls `assertSharedConfiguration()`
for any selection other than `owned`, and `selectOpenCodeService()` returns
`explicit` when `PASEO_OPENCODE_SERVER_URL` is set or `discovered` for a
compatible `2.x` `$XDG_STATE_HOME/opencode/service.json` pointing at this host.

For this plugin the consequence is direct: the remote HTTP MCP servers it
contributes to every agent *are* the "custom MCP servers" the host refuses, so
the contribution made creation fail and every reopen fail the same way.

### 18.1 Implementation

`server/opencode-service.ts` reproduces the selection rule from local files and
returns `{shared, detail, path}`; `sharedOpenCodeMcpBlock(provider, service)`
turns it into a block reason **only for `opencode`**. The environment is read the
way the host reads it: `agents.providers.opencode.env` from
`$PASEO_HOME/config.json` is overlaid on the daemon's `process.env`, so a
`PASEO_OPENCODE_SERVER_URL` or `XDG_STATE_HOME` set in Paseo's provider settings
wins over the shell — the same values `V2Runtime` would use.
`readProviderConfigEnv()` tolerates a missing or malformed config and ignores
non-string values; `XDG_STATE_HOME` keeps the host's `??` semantics. The hooks
call `sharedOpenCodeMcpBlockFor(provider)`, which reads that map and skips the
filesystem entirely for non-`opencode` providers. Both hooks consult it:

- **`agent.create`** — returns the request untouched instead of adding the HTTP
  entries, so the saved configuration never makes creation impossible. Log:
  `agent.create injection skipped for opencode: shared OpenCode service …`.
- **`agent.session_open`** — the block reason is an input of
  `decideClientSessionOpen` (`openCodeMcpBlock`) and short-circuits to
  `injectNames: []`, with the reason in `why`. The capability probe is skipped
  when the block applies.

There is **no attached tool to fall back to**, by this plugin's own rule
(§17.2 item 3): the tools belong to the remote host, and a local read-only copy
would answer from a different base. Degradation therefore means "no remote
memory on the `opencode` provider while the shared service is in use", stated
in the log, instead of a failed creation or open.

### 18.2 Trade-offs and limitations

- **The pid check replaces the host's HTTP probe.** The host probes the
  discovered URL; the plugin checks the recorded `pid` with `kill(pid, 0)`. A
  stale `service.json` from a crashed service is ignored; a live pid whose
  service no longer answers still counts as shared. The cost is a degraded open,
  never a failed one.
- **Detection is per open, not cached** — one `readFile` per hook call.
- **Agents created earlier keep their saved entries.** A lifecycle hook cannot
  rewrite a saved config, so on a machine that later acquires a shared service
  such an agent cannot open until its entry is gone (recreate it).
- **This plugin has no config-file registration path** comparable to
  memory-flash §6, so unlike that plugin there is no full-function alternative
  on such a host — only the degraded one.
- bunny-search records the same fix as a recommendation (§16.4 there) and does
  not implement it yet.

### 18.3 Verification (2026-11-15, this machine)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | **7 suites / 84 tests pass** — `tests/opencode-service.test.ts` (host version rule, explicit URL, discovery file with live/dead pid, remote host, corrupt file, `XDG_STATE_HOME` resolution, decision branch; plus `agents.providers.opencode.env` parsing and both provider overrides) and five wiring tests in `tests/server-contribution.test.ts` (create skipped for opencode, other providers unaffected, session open skipped, both settings overrides honoured) |
| Host rule source | extracted from the installed `0.15.0` `app.asar` (`v2/service-selection.js`, `v2/runtime.js`) |

Version `0.4.2 → 0.5.2` (new capability: the OpenCode guard → second digit),
annotated tag `memory-flash-client@0.5.2`.
`0.5.3` extends the guard to Paseo's own provider settings: it reads
`agents.providers.opencode.env` from `$PASEO_HOME/config.json` and overlays it on
`process.env` exactly as `V2Runtime` does (patch bump, tag
`memory-flash-client@0.5.3`).

## 19. Paseo 0.16.0 / 0.16.1 — compatibility pass (2026-11-17, 0.6.3)

Verified against stable **0.16.0** (2026-11-16) and **0.16.1** (2026-11-17).
**No code change was needed** — neither in the server entry, the client entry nor
the tests. Only the SDK pin moved (`^0.14.0` → `^0.16.1`).

### 19.1 What was checked

- The single 0.16.0 breaking removal, `agent.turn.after.timeline`: not used.
- The stricter `agent.open.before` hook (env/tools/mcpServers only): not used.
  This plugin writes saved MCP config in `agent.create` and contributes
  launch-only servers in `agent.session_open`.
- `PluginHookAgent` gained `background` and `metadata`: this plugin never builds
  an agent literal, so nothing broke.
- Deprecated client API (`addSurface`, `addSidebarItem`, `openSurface`, panel
  `context`, `SettingsGroup`, `react-native` entry): none used.
- `typecheck` exit 0; `vitest` **7 suites / 84 tests** pass.
- Live coverage is limited by the machine: the plugin is installed but
  `disabled`, so `paseo plugin update` and a live session-open were not
  exercised for this release. Its server imports are all host-supplied, so the
  risk of a stale bundle is lower than for memory-flash, but this is not the same
  as a live run.

### 19.2 What 0.16.1 changes

Fixes only: Claude bypass approvals, touch-target sizing, a Claude token-refresh
race, an OpenCode question that could not be dismissed, plugin installs through
an npm registry mirror, and related UI/Git repairs. Nothing touches MCP
injection, agent hooks or plugin settings, which is the whole surface this plugin
uses.

### 19.3 Recommended next steps (not implemented)

1. **Composer items for remote memory (highest value).**
   0.16.0's `addComposerItem` gives a control the prompt and `insertText`. The
   natural pair for a remote base is "search this host" (insert `#id title` as a
   citation) and "save this draft to the remote host". Today the remote base is
   only reachable by the agent through MCP; the human has no path from the
   composer. Cost: medium — the probe/RPC plumbing already exists.
2. **Agent metadata recording the connected host.**
   Write `memory-flash-client.host` (connection id, not the key) at session open.
   The coexistence check and the repair action could then say *which* base an
   agent was wired to, and a sidebar badge could show it. Requires the 0.16.0
   metadata return field, never a full request echo.
3. **Per-workspace server names from `PASEO_WORKSPACE_ID`.**
   With several workspaces the current names (`memory-flash`, `memory-flash-<id>`)
   are identical across workspaces, which makes logs and agent records ambiguous.
   Including a short workspace key keeps them unique and stable. Cost: small, but
   it changes injected names and needs a migration note.

## 20. Paseo 0.17.1 — compatibility pass and the deprecated hook migration (2026-11-22, 0.6.4)

Verified against the stable **0.17.1** release (2026-11-21,
<https://github.com/getpaseo/paseo/releases/tag/v0.17.1>). Verdict: **compatible**;
one live deprecation was found and replaced. Shipped as **0.6.4** (bugfix-level:
no behaviour changes, no new functionality). The SDK pin moves `^0.16.1` →
`^0.17.1`, and `requirements.paseo` moves `>=0.14.0` → **`>=0.15.0`**, because the
replacement API (`addHook`) does not exist on a 0.14.x host.

### 20.1 What 0.17.1 changed in the plugin SDK

The SDK diff `0.16.0 → 0.17.1` is additive only: `navigation.focusHost` /
`supportsFocusHost`, `registerWorktreeManager` with the `PluginWorktree*` types,
`appendSystemPrompt` on the `agent.open.before` request, and provider-author /
usage-author fields. The `@deprecated` set is identical to 0.16.0's — **no new
deprecation**. The full inventory and the file-level diff are in
[memory-flash §22.1](../memory-flash/__doc.md#221-what-0171-changed-in-the-plugin-sdk);
both plugins run against the same SDK and neither registers a provider, a usage
source or a worktree manager, so those additions do not reach this plugin.

### 20.2 The deprecated `server.before` calls — replaced

Both hooks used the **`@deprecated`** `server.before` (deprecated in 0.15.0,
removed after 2027-04-30) — the debt recorded in §19 and in
[__compatibility.md](./__compatibility.md). They now use `server.addHook`:

| Before | After | Where |
| ------ | ----- | ----- |
| `server.before("agent.create", …)` | `server.addHook("agent.create.before", …)` | `index.server.ts`, the saved remote HTTP server injection |
| `server.before("agent.session_open", …)` | `server.addHook("agent.open.before", …)` | `index.server.ts`, the per-open re-contribution |

The equivalence is the SDK's own: one registry behind both spellings, the handler
receives `{ request }` and returns the request or `void`, both names are
`waits: true` in `pluginHookRegistry`, so the host still blocks on them. Hook
bodies, paths and the `decideClientSessionOpen` matrix are unchanged. The fake
server in `tests/server-contribution.test.ts` now implements `addHook` and the
suites address `agent.create.before` / `agent.open.before`.

The failure being avoided is silent, not loud: without the hooks the agent is
created and opened with no remote HTTP server, i.e. it simply has no shared
memory tools. That is why the migration was made now rather than at the deadline.

### 20.3 New 0.17.x surface — recommendations (recorded, not implemented)

1. **`appendSystemPrompt` in `agent.open.before` — highest value.**
   The remote servers are contributed launch-only and can be withheld entirely
   (a shared OpenCode v2 service, §18) or replaced by the agent's own config.
   A one-line instruction per open ("the servers `memory-flash*` are a shared
   remote base; search it before the first edit, save a bugfix when it is fixed,
   hand off before stopping") tells the agent what the injected tools are for
   without another skill install. Per-open, never saved, no file writes. Cost:
   small; needs `requirements.paseo >=0.17.0` because a 0.16.x daemon rejects the
   field. A second-digit release.
2. **`useTabState` for the connections screen's draft.** `client/connections-surface.tsx`
   keeps the add-connection draft (`label`, `url`, `secret`, …) in plain
   `useState`, so switching screens loses a half-typed connection.
   `useTabState(tab, schema, default)` (0.16.0; state hooks fixed for plugin
   screens in the 0.17.0 #10049 fix) persists a schema-validated draft per tab.
   Cost: small; no floor change. The secret must stay out of it — persist the URL
   and label, never the key.
3. **`focusHost` — nothing to attach to yet.** The screen opens no agent or
   workspace, so the option is recorded for a future "open the agent wired to
   this connection" link, gated on `navigation.supportsFocusHost` (#5574).
4. **`registerWorktreeManager` — evaluated and rejected.** This plugin is about
   remote memory, has no worktree policy, and should not acquire one.

The three recommendations of §19.3 (composer citation, host provenance in agent
metadata, `PASEO_WORKSPACE_ID`-aware server names) stay open and are unaffected by
0.17.1; the first is now cheaper to build than the new item 1 and can be shipped
together with it.

Relevant 0.17.1 host fixes: **#10153** (a plugin agent reopens after its provider
closes the session — that reopen is where the re-contribution runs), **#10390**
(resumed Codex sessions use their current directory for configuration and MCP
servers), **#10187** (shared OpenCode service turns no longer stay running; the
shared-service refusal of custom MCP servers is still in force in 0.17.1, so §18
stays valid).

### 20.4 Verification

- `npm run typecheck` exit 0 against `@getpaseo/plugin@0.17.1`.
- `npm test` **7 suites / 84 tests** pass, including the session-open matrix and
  the reload action, which run through the `addHook` double.
- No deprecated plugin API remains in `*.ts`/`*.tsx`: no `server.before`, no
  `server.on`, no `addSurface` / `addSidebarItem` / `openSurface` /
  `SettingsGroup` / `client/react-native`.
- **Not verified live:** the plugin is installed but `disabled` on this machine
  and no daemon is running, so `paseo plugin update` and a live session open under
  0.17.1 were not exercised. All its imports are host-supplied, so the install
  path needs no build step — but this is not the same as a live run.
