# Memory Flash Client

Connects this machine to a **remote [Memory Flash](../memory-flash/README.md) memory host** over HTTP with an API key, so agents created through [Paseo](https://paseo.sh/) here can read and write the same shared memory database that lives on another machine.

It is the client half of Memory Flash's remote access: the memory host serves MCP over HTTP and issues an API key; this plugin stores that key, announces who is connecting, and injects the HTTP MCP server into every Paseo-created agent. No plugin on the memory host is required for access — an MCP URL plus a key is enough — but this plugin makes that setup a few clicks instead of hand-written config.

## What it does

- **Connects to any number of memory hosts** — each connection is one remote endpoint (`http://<host>:<port>/mcp`) plus the API key generated there. A machine may use several memory hosts side by side.
- **Manual key transfer, no network enrollment** — the key is generated on the memory host and pasted here by the user. It is never requested or issued automatically over the network, so it never ends up in an agent's context or logs.
- **Client identity** — every request carries a stable client UUID and a host name from the plugin settings (`X-Memory-Flash-Client-Id`, `X-Memory-Flash-Host`). The memory host records them, so several clients are distinguishable in its audit log. The UUID is generated once and can be pinned or regenerated in the settings screen.
- **Automatic MCP injection** — via the Paseo `agent.create` before-hook, each enabled connection is added to every agent created through Paseo as an HTTP MCP server with `Authorization: Bearer <key>` attached (configurable, on by default). With one connection the server is named `memory-flash`; with several, each name is suffixed with its connection id so they stay unique.
- **Connection check** — "Test" (for an unsaved URL + key) and "Check" (for a saved connection) run the same sequence a real agent performs: `GET /healthz`, then the MCP `initialize` handshake, then `tools/list` with the Bearer key, and report the memory host's server name, tool count, latency and a readable error. Failed checks are stored and shown per connection.
- **Key safety** — the API key is stored in `$PASEO_HOME/plugins/memory-flash-client/connections.json` with owner-only permissions (0600), never in git, never in an agent prompt, and never in a plugin log. The UI only ever shows the key's prefix. Deleting the key on the memory host cuts access.
- **Agent skill** — the plugin ships its own `memory-flash-remote` `SKILL.md`, installed from the settings screen into `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.qwen/skills`, `~/.cline/skills` and `~/.kilo/skills`. Availability is not usage: an agent that finds the `memory_*` tools on a machine without the memory plugin treats them as an optional extra. The skill tells it that this is a *shared team base* owned by another machine, and sets the same protocol the local plugin uses — 2–4 differently worded searches before a non-trivial task, `memory_get` instead of trusting a snippet, widen the query before concluding nothing is known, and write back every bugfix, positive result and user correction, searching first so one fact yields one memory, always ending with a handoff. It also states the two remote-specific facts: writes need a key issued with `read_write` scope (a `read` key exposes only `memory_search`, `memory_get`, `memory_list_by_tag` and `memory_stats`), and several configured hosts expose identically named tools.
- **Coexistence check with memory-flash** — the plugin detects whether memory-flash itself is installed on this host (from the Paseo config and the plugin data directory) and states explicitly that running both is allowed: memory-flash is the single memory host of this machine, this plugin only adds remote connections, so the two never conflict. The check is computed, not hard-coded, so a genuine overlap later has a place to surface.
- **Management screen inside Paseo** (sidebar header row "Memory Hosts" + ⌘K entry) — the list of memory hosts with status, last check and key prefix, plus the add form (name, URL, secret) with Test and Add; and a settings screen for the identity and injection options.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash-client
```

Requires Paseo ≥ 0.11.0 (verified against the stable 0.13.0 release, 2026-10-24) and Memory Flash 0.5.0+ with the HTTP endpoint enabled on the remote host.

The plugin is installed into the Paseo home and runs from there: `~/.paseo/plugins/memory-flash-client/<revision>/checkout/memory-flash-client`. Every import in this plugin is supplied by Paseo itself, so it has no install-time build step and no registry access requirement — the command above is the whole installation. Updates: `paseo plugin update memory-flash-client`.

**Rule for this plugin: install it from the Git source only.** `paseo plugin add <local directory>` is not supported here — it would execute the plugin straight from a working copy instead of from the Paseo home. This machine is only the client side, so the memory host needs no plugin at all: an HTTP MCP URL plus an API key are enough.

## How to use

### 1. Prepare the memory host

The memory host is the machine running the Memory Flash plugin — it owns the database.

1. Open **Settings → Plugins → Memory Flash → Remote access (HTTP + API key)**.
2. Turn on **Enable the HTTP endpoint** (version 0.5.2+; before that the switch was called the remote-access toggle).
3. Set **Bind address**. `127.0.0.1` keeps the endpoint private to that machine — reach it over a VPN with a Tailscale address (`100.x.y.z`) or a LAN address, never a bare `0.0.0.0` on a public network.
4. Set **Port** (default `8787`) and wait for the green line `listening on http://…`. The status line reports the interface actually bound; when the address is a wildcard it prints the dialable LAN address to copy — `0.0.0.0` is not an address you can paste into a client.
5. Fill in **New key — name** (e.g. `studio-laptop`) and press **Generate API key**.
6. Copy the secret from the *Copy now* block — it is shown once and cannot be recovered. Close the block; if you lose it, press **Delete** on that key and generate another.

You end up with two values: a URL like `http://100.64.0.2:8787/mcp` and a secret like `mf_live_…`.

### 2. Point this machine at the host

7. Open the **Memory Hosts** screen in Paseo (or **Settings → Plugins → Memory Flash Client**).
8. Fill in the name, paste the URL and the secret, press **Test**, then **Add**.
   **Test** runs the same handshake a real agent performs: `GET /healthz`, then `initialize` and `tools/list` with the key. A green result reports the host name, the number of tools and the latency.
9. The card turns green. Set **Client UUID** / **Host name** in the settings screen so the host's audit log can tell your machine apart.

### 3. Make the agents actually use it

10. Open **Settings → Plugins → Memory Flash Client → Agent skill** and press **Install into all agents**.
11. Create an agent through Paseo. It receives the remote memory tools automatically, and the skill teaches it to search 2–4 times before a non-trivial task and to write every bugfix, positive result and user correction back to the shared base.

### 4. Rotating or cutting access

12. To cut a machine off, press **Delete** on its key in Memory Flash on the host — the row is removed, so the client is refused on its next request and the name is free immediately. Then **Remove** the connection here.

## Identity settings

- **Client UUID** — leave empty to let the plugin generate one (kept stable for the process and across restarts), or pin a specific UUID. "Generate a new UUID" in the settings screen rotates it (useful if the identity ever leaked).
- **Host name** — defaults to this machine's `os.hostname()`; set a readable name such as `studio-laptop` so the memory host's log says who connected.
- **Send identity headers** — on by default. Turning it off only omits the two advisory headers; the API key remains the sole credential.

The identity headers grant no access — the memory host authenticates on the API key alone. They exist purely so the memory host can log which client connected.

Both fields accept an empty value on purpose: empty `clientId` means "use the plugin's generated UUID" and empty `Host name` means "use this machine's `os.hostname()`". A pinned `Client UUID` must be a real UUID. (Version 0.1.2: the schema previously required a minimum length on both fields, so a fresh install — where both are empty — reported its settings as invalid and the settings screen showed a raw Zod error instead of the form.)

## Development

```bash
npm install
npm test         # vitest: connections store, probe, identity/conflict, settings schema, server contribution (MCP injection), agent skill
npm run typecheck
```

Storage layout on this machine:

```
$PASEO_HOME/plugins/memory-flash-client/
└── connections.json   # remote memory hosts and their API keys (mode 0600)
```

Requires Paseo ≥ 0.11.0 (uses the plugin SDK screen/sidebar API, settings, lifecycle hooks and `McpHttpServerConfig`).

## Paseo 0.13.0 compatibility

Verified against the **stable Paseo 0.13.0** release (2026-10-24).
Full evidence: [__doc.md](./__doc.md) §16. **No code change was needed, and
no deprecated 0.13.0 API remains in this plugin** — it is still `0.2.1` and
`requirements.paseo` still `>=0.11.0`.

**Evidence caveat:** the plugin is **not installed on the machine the pass
ran on**, so unlike the other four it has no live 0.13.0 daemon evidence —
its result rests on the SDK diff, typecheck, the full test suite, the real
0.13.0 host compiler and the real 0.13.0 manifest parser. The 0.12.0 live
evidence (§15 of [__doc.md](./__doc.md)) stands until the next install or
update on a 0.13.0 host.

**Nothing deprecated reaches it.** The plugin imports its UI from
`@getpaseo/plugin/client` and `@getpaseo/plugin/client/ui`, never from the
`client/react-native` entry that 0.13.0 deprecates (removal 2027-04-20, with
`useRevealedText`); its hooks are `before("agent.create")` and
`registerSettings`, so the always-empty `agent.turn_ended` `timeline` does not
apply; and it neither creates agents (the `git`/`worktreeName` options
`createAgent` now rejects) nor contributes a panel or uses `SettingsGroup`.
0.13.0's connected hosts (`PaseoApi.hosts`) are Paseo-to-Paseo delegation and
do not overlap with this plugin's remote memory hosts over HTTP API keys.

**New in 0.13.0, not adopted (all optional):** plugin translations
(`defineTranslations` / `useTranslation` / `client.i18n` — connection labels
stay valid English `PluginText`), `Markdown` / `StreamedText` / `Loading` /
`DocumentFrame`, inline-SVG icons, file panels, agent panels, `useTabState`,
`createWorkspace`, and `PaseoApi.hosts`. The full inventory is in the root
[README](../README.md#paseo-0130--new-and-deprecated-sdk-surface-2026-10-24).

**Verification:** typecheck clean against SDK 0.13.0, vitest **6 suites /
53 tests** pass, and both entries build with the **real 0.13.0 host compiler**
(from the installed `app.asar`) with no boundary errors and zero deprecated
calls. The manifest passes the real 0.13.0 parser, and the plugin still has
**no install-time build step**. The SDK was installed with `--no-save`, so
`package.json` still pins `@getpaseo/plugin@0.12.0`.

## Paseo 0.12.0 spec conformance

Verified against the **stable Paseo 0.12.0** release (2026-10-21).
Full evidence: [__doc.md](./__doc.md) §15.

**What the new version changed for this plugin:**

- The SDK diff `@getpaseo/plugin@0.10.1 → 0.12.0` is **additive only** for
every API this plugin uses; `0.11.0 → 0.12.0` client declarations are
byte-identical, so `requirements.paseo` is `>=0.11.0` (the API floor), not
`>=0.12.0`.
- The 0.10-era registrations were `@deprecated` (`addSurface`,
`addSidebarItem`, `openSurface`) but still shipped as working shims in the
0.12.0 host — a migration for correctness, not a breakage fix.
- **A previously documented date was wrong:** earlier notes said the shims
were "scheduled for removal after **2027-03-29**". That date belongs to
unrelated `COMPAT(...)` markers in 0.12.0; the surface/sidebar shims carry no
removal marker and the SDK tags state no version. See
[__doc.md](./__doc.md) §15.1.
- 0.12.0's `#7023` is worth noting for this plugin specifically: it lets a
plugin import Paseo *protocol types* (type-only) with no local install, which
is exactly the failure this plugin hit in 0.1.1 and worked around by dropping
the `McpHttpServerConfig` import. The workaround is kept — it costs nothing
and still works — but on 0.12.0 it is no longer load-bearing. `#6306` also
fixes the 60-second `paseo plugin reload` timeout.
- Still **no install-time build step**: this plugin references no package
outside Paseo's host-supplied list, so it installs without npm-registry
access. `#7023` relaxes *type* imports only; this plugin was already clean.

**Migrated in 0.2.1:**

| Before | After |
| ------ | ----- |
| `client.addSurface(id, Component)` | `client.addScreen({ id, title, Component })` |
| `client.addSidebarItem({ id, title, icon, surface })` | `client.addSidebarHeaderItem({ id, title, Component })` rendering `<SidebarRow icon="Database" />` |
| `onSelect({ openSurface })` | `onSelect({ openScreen })` → `openScreen({ screenId })` |
| screen component took `PluginSurfaceProps` | takes `PluginScreenProps` (adds `params`) |
| `requirements.paseo: ">=0.10.0"` | `">=0.11.0"` |
| `@getpaseo/plugin@0.10.1` | `@getpaseo/plugin@0.12.0` |

The screen title moved to `"Memory Hosts"` (the name the sidebar row and
Command Center item already used) instead of the raw contribution id.

**Spec violation found and fixed:** 0.12.0's client audit treats a
cross-platform module touching a DOM global outside `client/web.ts` as a
bug. `client/use-host-typography.ts` read `globalThis.localStorage`
directly; it now calls `readHostTypography()` from the new `client/web.ts`,
gated on `Platform.OS === "web"` with `null` on native so callers fall back
to defaults.

**Verification:** typecheck clean against SDK 0.12.0, vitest **6 suites /
53 tests** pass, no deprecated registrations remain, and every contribution
ID conforms to the lowercase/hyphen rule. Live-verified on a real
0.12.0 daemon in an isolated home: installs as `running`, logs
`Plugin ready`, reloads cleanly (`paseo plugin reload`, the fixed #6306
flow), and the real 0.12.0 host compiler builds the client entry with
zero legacy API calls in the compiled bundle.

Still open, both optional and neither a conformance blocker:

1. **Multi-row sidebar** — lay the host list out with
   `SidebarRow`/`SidebarSeparator`, add an `addSidebarFooterItem` entry, and
   deep-link to a specific connection via `PluginScreenProps.params` with
   `PluginScreenTitle` deriving the header. New capability → second-digit bump.
2. **`agent.closed` lifecycle event** — release per-agent state of the
   injected HTTP MCP connections and record last-used stats when an agent
   closes.

See [__doc.md](./__doc.md) for the technical details: contracts, the probe sequence, the injection shape and the coexistence check.
