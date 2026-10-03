# Memory Flash Client

Connects this machine to a **remote [Memory Flash](../memory-flash/README.md) memory host** over HTTP with an API key, so agents created through [Paseo](https://paseo.sh/) here can read and write the same shared memory database that lives on another machine.

It is the client half of Memory Flash's remote access: the memory host serves MCP over HTTP and issues an API key; this plugin stores that key, announces who is connecting, and injects the HTTP MCP server into every Paseo-created agent. No plugin on the memory host is required for access — an MCP URL plus a key is enough — but this plugin makes that setup a few clicks instead of hand-written config.

## What it does

- **Connects to any number of memory hosts** — each connection is one remote endpoint (`http://<host>:<port>/mcp`) plus the API key generated there. A machine may use several memory hosts side by side.
- **Manual key transfer, no network enrollment** — the key is generated on the memory host and pasted here by the user. It is never requested or issued automatically over the network, so it never ends up in an agent's context or logs.
- **Client identity** — every request carries a stable client UUID and a host name from the plugin settings (`X-Memory-Flash-Client-Id`, `X-Memory-Flash-Host`). The memory host records them, so several clients are distinguishable in its audit log. The UUID is generated once and can be pinned or regenerated in the settings screen.
- **Automatic MCP injection** — via the Paseo `agent.create` before-hook, each enabled connection is added to every agent created through Paseo as an HTTP MCP server with `Authorization: Bearer <key>` attached (configurable, on by default). With one connection the server is named `memory-flash`; with several, each name is suffixed with its connection id so they stay unique.
- **Connection check** — "Test" (for an unsaved URL + key) and "Check" (for a saved connection) run the same sequence a real agent performs: `GET /healthz`, then the MCP `initialize` handshake, then `tools/list` with the Bearer key, and report the memory host's server name, tool count, latency and a readable error. Failed checks are stored and shown per connection.
- **Key safety** — the API key is stored in `$PASEO_HOME/plugins/memory-flash-client/connections.json` with owner-only permissions (0600), never in git, never in an agent prompt, and never in a plugin log. The UI only ever shows the key's prefix. Revoke the key on the memory host to cut access.
- **Coexistence check with memory-flash** — the plugin detects whether memory-flash itself is installed on this host (from the Paseo config and the plugin data directory) and states explicitly that running both is allowed: memory-flash is the single memory host of this machine, this plugin only adds remote connections, so the two never conflict. The check is computed, not hard-coded, so a genuine overlap later has a place to surface.
- **Management surface inside Paseo** (sidebar item "Memory Hosts" + ⌘K entry) — the list of memory hosts with status, last check and key prefix, plus the add form (name, URL, secret) with Test and Add; and a settings screen for the identity and injection options.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash-client
```

Requires Paseo ≥ 0.10.0 (verified against 0.10.3) and Memory Flash 0.5.0+ with the HTTP endpoint enabled on the remote host.

The plugin is installed into the Paseo home and runs from there: `~/.paseo/plugins/memory-flash-client/<revision>/checkout/memory-flash-client`. Every import in this plugin is supplied by Paseo itself, so it has no install-time build step and no registry access requirement — the command above is the whole installation. Updates: `paseo plugin update memory-flash-client`.

**Rule for this plugin: install it from the Git source only.** `paseo plugin add <local directory>` is not supported here — it would execute the plugin straight from a working copy instead of from the Paseo home. This machine is only the client side, so the memory host needs no plugin at all: an HTTP MCP URL plus an API key are enough.

## How to use

1. On the **memory host**, open **Settings → Plugins → Memory Flash → Remote access (HTTP + API key)**, enable the HTTP endpoint, and press **Generate API key**. Copy the URL and secret — the secret is shown once.
2. On **this machine**, open the **Memory Hosts** surface in Paseo.
3. Fill in the name, paste the URL (`http://100.64.0.2:8787/mcp`) and the secret, press **Test** (optional but recommended: it proves the host answers and accepts the key), then **Add**.
4. Create or use an agent through Paseo — it now gets the remote memory tools automatically. Check the status line on the connection card.
5. If a machine is lost, press **Revoke** on that key in Memory Flash on the memory host, then **Remove** the connection here.

## Identity settings

- **Client UUID** — leave empty to let the plugin generate one (kept stable for the process and across restarts), or pin a specific UUID. "Generate a new UUID" in the settings screen rotates it (useful if the identity ever leaked).
- **Host name** — defaults to this machine's `os.hostname()`; set a readable name such as `studio-laptop` so the memory host's log says who connected.
- **Send identity headers** — on by default. Turning it off only omits the two advisory headers; the API key remains the sole credential.

The identity headers grant no access — the memory host authenticates on the API key alone. They exist purely so the memory host can log which client connected.

Both fields accept an empty value on purpose: empty `clientId` means "use the plugin's generated UUID" and empty `Host name` means "use this machine's `os.hostname()`". A pinned `Client UUID` must be a real UUID. (Version 0.1.2: the schema previously required a minimum length on both fields, so a fresh install — where both are empty — reported its settings as invalid and the settings screen showed a raw Zod error instead of the form.)

## Development

```bash
npm install
npm test         # vitest: connections store, probe, identity/conflict, settings schema, server contribution (MCP injection)
npm run typecheck
```

Storage layout on this machine:

```
$PASEO_HOME/plugins/memory-flash-client/
└── connections.json   # remote memory hosts and their API keys (mode 0600)
```

Requires Paseo ≥ 0.10.0 (uses the plugin SDK 0.10 settings, lifecycle hooks and `McpHttpServerConfig`).

See [__doc.md](./__doc.md) for the technical details: contracts, the probe sequence, the injection shape and the coexistence check.
