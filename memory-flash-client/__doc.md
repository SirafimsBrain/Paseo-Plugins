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

## 5. Connection check

`probeConnection(url, secret, identity)` in `server/probe.ts` runs the same three steps a real agent performs, each with its own 8 s timeout and `AbortController`, and returns a `ConnectionCheck`:

1. `GET /healthz` (same origin, derived from the MCP URL) — liveness. Fails fast with a hint to enable the memory host's HTTP endpoint when the answer is not 200.
2. `POST /mcp` `initialize` with `Authorization: Bearer <key>` — the MCP handshake. `401`/`403` is translated into "the memory host rejected the API key. Generate a new key…", never echoing the key back. A result without `serverInfo` is treated as "this is not a memory-flash endpoint".
3. `POST /mcp` `tools/list` — proves the key is not merely valid but granted tool access; the count is reported, which doubles as a scope check (a read-only key shows fewer tools).

`checkedAt` and latency are recorded on the connection so the surface can show a status line. The check never logs the secret and never throws — failures come back as `status: "error"` with a readable message (refused, DNS, timeout, non-200, JSON-RPC error). `checkConnectionDraft` runs the same probe for an unsaved URL + key, so the UI can validate before saving.

## 6. MCP injection

The `agent.create` before-hook adds one `McpHttpServerConfig` per enabled connection:

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

## 7. Coexistence with memory-flash (conflict check)

`server/conflict.ts` answers one question: is memory-flash also installed on this host? It reads `$PASEO_HOME/config.json` (the `plugins` map, honouring `enabled: false`) and checks for `$PASEO_HOME/plugins/memory-flash`, and reports:

- `memoryFlashInstalled` — whether a local memory host exists;
- `conflict` — always `false` today. The two plugins have disjoint roles and no shared state: memory-flash owns this machine's `memory.db` and injects a stdio server; memory-flash-client only holds remote connections and injects HTTP servers under its own names. The field is computed (not hard-coded) so a genuine overlap — a colliding server name, a shared store — has a place to surface as a blocking conflict;
- `singleMemoryHost` — `true`: exactly one memory-flash per host is assumed, so no ambiguity is designed in;
- `note` — an advisory sentence rendered in the UI explaining that running both is allowed, or that this installation only connects to remote hosts.

Detection is filesystem/config-based on purpose: it needs no daemon RPC and works even when the memory-flash plugin is disabled but its data directory still exists.

## 8. RPC surface

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

## 9. Security posture

| Measure | Where |
| ------- | ----- |
| Key stored owner-only, never in git | `connections.ts` — `0600` file in a `0700` directory |
| Key never returned to the UI | `toView()` strips it; the save RPC echoes back only `{ok, id, error}` |
| Key never logged | the injection and probe logs print URL and name only |
| Key never in an agent prompt | the key lives in the MCP config header, not in any prompt text |
| No automatic issuance | the user pastes a key generated on the memory host; nothing is requested over the network |
| Per-connection revoke | removing a connection here plus revoking the key there cuts access |

The residual risk is inherent to the design and accepted: a client that stores a bearer key locally is a bearer credential, so the file is the trust boundary, and the memory host must be reachable only over a trusted network (VPN/LAN/loopback) or behind HTTPS.

## 10. Tests

- `tests/connections.test.ts` — CRUD, URL normalization, prefix derivation, secret redaction, 0600 permissions, state preservation on edit, corruption recovery.
- `tests/probe.test.ts` — a stub memory-flash server: success path, Bearer + identity headers present, 401, missing `/healthz`, broken handshake, unreachable host, health-URL derivation, `host:port` paste.
- `tests/identity-conflict.test.ts` — conflict detection (config entry, data dir, disabled entry, corrupted config, both plugins present), UUID generation/validation, hostname resolution.
- `tests/server-contribution.test.ts` — the `agent.create` hook with a fake `PluginServerContext`: injection shape, pinned vs generated UUID, stability across agents, multi-connection naming, disabled/skip/preserve behaviour, identity-header toggle, and the RPC surface (list/save/delete, status counts, missing-connection check, conflict check, UUID regeneration).

## 11. Compatibility

Built against Paseo `0.10.x` with `@getpaseo/plugin@0.10.1`:

- `npm run typecheck` — clean.
- `npm test` — 4 suites, 40 tests, green.
- Uses: `registerSettings`, `before("agent.create")`, `handle`, and the SDK's `McpHttpServerConfig` (`type: "http"`, `url`, `headers`) from `@getpaseo/protocol`.

## 12. Limitations and roadmap

- **One key per connection, no rotation helper.** Rotating means generating a new key on the memory host, editing the connection, then revoking the old key. A "rotate" action that walks both sides would be nicer.
- **No TLS.** The endpoint is plain HTTP by design; a VPN or an SSH tunnel is the intended front. A future `https` URL is already accepted by the URL normalizer.
- **No fan-out.** Each agent gets the tools of every enabled connection, which means the same tool names (`memory_search`, …) can appear more than once when several hosts are enabled. A future release could namespace tools per connection.
- **The generated UUID is per-process until pinned.** Restarting the daemon yields a new generated identity unless the user pins one; the memory host therefore sees a new client id after each restart. Pinning is one click in the settings screen.
