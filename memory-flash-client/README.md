# Memory Flash Client

Connects this machine to a **remote [Memory Flash](../memory-flash/README.md) memory host** over HTTP with an API key, so agents created through [Paseo](https://paseo.sh/) here can read and write the same shared memory database that lives on another machine.

It is the client half of Memory Flash's remote access: the memory host serves MCP over HTTP and issues an API key; this plugin stores that key, announces who is connecting, and injects the HTTP MCP server into every Paseo-created agent. No plugin on the memory host is required for access — an MCP URL plus a key is enough — but this plugin makes that setup a few clicks instead of hand-written config.

## What it does

- **Connects to any number of memory hosts** — each connection is one remote endpoint (`http://<host>:<port>/mcp`) plus the API key generated there. A machine may use several memory hosts side by side.
- **Manual key transfer, no network enrollment** — the key is generated on the memory host and pasted here by the user. It is never requested or issued automatically over the network, so it never ends up in an agent's context or logs.
- **Client identity** — every request carries a stable client UUID and a host name from the plugin settings (`X-Memory-Flash-Client-Id`, `X-Memory-Flash-Host`). The memory host records them, so several clients are distinguishable in its audit log. The UUID is generated once and can be pinned or regenerated in the settings screen.
- **Automatic MCP injection** — via the Paseo `agent.create` before-hook, each enabled connection is added to every agent created through Paseo as an HTTP MCP server with `Authorization: Bearer <key>` attached (configurable, on by default). With one connection the server is named `memory-flash`; with several, each name is suffixed with its connection id so they stay unique.
- **Agent instructions on every open (0.7.0, corrected in 0.7.1)** — a working remote `memory_*` tool does not make an agent use it, and the skill is a separate install. Every session open that leaves the agent with at least one remote server also appends one instruction (Paseo 0.17 `appendSystemPrompt`, that session only, never saved on the agent): *search (`{server}_memory_search`) before the first edit, save every bugfix (`{server}_memory_save`), leave a handoff (`{server}_memory_handoff`) before stopping*. Paseo prefixes MCP tool names with the server name, so the text is rendered with the actual configured names — `{servers}` expands to the full list (`memory-flash`, or `memory-flash-<connectionId>` per connection) and `{server}` to the first one used in the examples. The text is a setting (empty switches it off) and never contains a key; `history` opens and agents with injection off get nothing.
- **Connection check** — "Test" (for an unsaved URL + key) and "Check" (for a saved connection) run the same sequence a real agent performs: `GET /healthz`, then the MCP `initialize` handshake, then `tools/list` with the Bearer key, and report the memory host's server name, tool count, latency and a readable error. Failed checks are stored and shown per connection.
- **Key safety** — the API key is stored in `$PASEO_HOME/plugins/memory-flash-client/connections.json` with owner-only permissions (0600), never in git, never in an agent prompt, and never in a plugin log. The UI only ever shows the key's prefix. Deleting the key on the memory host cuts access.
- **Agent skill** — the plugin ships its own `memory-flash-remote` `SKILL.md`, installed from the settings screen into `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.qwen/skills`, `~/.cline/skills`, `~/.kilo/skills`, `$KIMI_CODE_HOME/skills` (`~/.kimi-code/skills` by default) and `$PI_CODING_AGENT_DIR/skills` (`~/.pi/agent/skills` by default). The body also states that `memory_*` is a symbiont of every harness — use it in the work, not only when the user mentions memory. Availability is not usage: an agent that finds the `memory_*` tools on a machine without the memory plugin treats them as an optional extra. The skill tells it that this is a *shared team base* owned by another machine, and sets the same protocol the local plugin uses — 2–4 differently worded searches before a non-trivial task, `memory_get` instead of trusting a snippet, widen the query before concluding nothing is known, and write back every bugfix, positive result and user correction, searching first so one fact yields one memory, always ending with a handoff. It also states the two remote-specific facts: writes need a key issued with `read_write` scope (a `read` key exposes only `memory_search`, `memory_get`, `memory_list_by_tag` and `memory_stats`), and several configured hosts expose identically named tools.
- **Coexistence check with memory-flash** — the plugin detects whether memory-flash itself is installed on this host (from the Paseo config and the plugin data directory) and states explicitly that running both is allowed: memory-flash is the single memory host of this machine, this plugin only adds remote connections, so the two never conflict. The check is computed, not hard-coded, so a genuine overlap later has a place to surface.
- **Graceful degradation on a shared OpenCode service (0.5.2)** — Paseo 0.15.0 reuses a running OpenCode v2 service, and such a host refuses any agent whose config carries custom MCP servers (#7435). The plugin reproduces the host's selection rule locally from the same environment the host uses — `process.env` with `agents.providers.opencode.env` from `$PASEO_HOME/config.json` overlaid on it, so `PASEO_OPENCODE_SERVER_URL` or `XDG_STATE_HOME` set in Paseo's provider settings counts — and withholds the remote servers for the `opencode` provider instead of making creation and every reopen fail; the log line names the reason. Other providers, and hosts where Paseo owns its OpenCode server, are unaffected.
- **Management screen inside Paseo** (sidebar header row "Memory Hosts" + ⌘K entry) — the list of memory hosts with status, last check and key prefix, plus the add form (name, URL, secret) with Test and Add; and a settings screen for the identity and injection options.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash-client
```

Requires Paseo ≥ 0.17.0 (the agent instruction uses 0.17.0's `appendSystemPrompt`; a 0.16.x daemon rejects the field and fails the open) and Memory Flash 0.5.0+ with the HTTP endpoint enabled on the remote host.

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

Requires Paseo ≥ 0.17.0 (the `agent.create.before` / `agent.open.before` hooks registered through `server.addHook` are 0.15.0 API, and `agents.ref().reload()` used since 0.3.2 is 0.14.0; the agent instruction needs 0.17.0's `appendSystemPrompt`; uses the plugin SDK screen/sidebar API, settings and `McpHttpServerConfig`).

## Compatibility

Paseo **0.17.1 (2026-11-21)** verified, `requirements.paseo >=0.17.0`, SDK `@getpaseo/plugin ^0.17.1`. **0.8.1 adds Pi support for the agent skill** (`$PI_CODING_AGENT_DIR/skills`, `~/.pi/agent/skills` by default) and the symbiont sentence in the skill body; a machine-level Pi MCP registration is planned, not shipped. **0.7.1 corrects the instruction's tool names** (`{server}`/`{servers}` resolved from the configured server names, because Paseo prefixes MCP tools with them). **0.7.0 implements the 0.17.x recommendation**: one agent instruction per open via `appendSystemPrompt`, telling the agent what the injected remote `memory_*` tools are for (per-open, never saved, never contains a key). `useTabState` is not available to a plugin screen in 0.17.1 (`PluginScreenProps` has no `tab`; only panels get a `PluginTab`), so the connection-draft recommendation is withdrawn; `focusHost` still has nothing to attach to and `registerWorktreeManager` stays rejected. The floor rose with the instruction because a 0.16.x daemon rejects the field. The 0.17.1 SDK diff is additive and deprecates nothing new, but the plugin still registered both hooks with `server.before`, deprecated since 0.15.0 and scheduled for removal after 2027-04-30 — **0.6.4 replaces them** with `server.addHook("agent.create.before")` and `server.addHook("agent.open.before")` (same registry, same payload, same awaited policy, so the remote HTTP server injection is unchanged). The floor rose to `>=0.15.0` because `addHook` does not exist on a 0.14.x host. 0.16.0 features are evaluated in [__doc.md](./__doc.md) §19.3, 0.17.1 recommendations in §20.3.

Full detail: [__compatibility.md](./__compatibility.md); technical evidence: [`__doc.md`](./__doc.md) (Compatibility sections).
