# Bunny Search — technical documentation

This file documents the internal design, verified compatibility, and the roadmap of the `bunny-search` plugin. User-facing description: [README.md](./README.md).

## 1. Purpose and scope

Bunny Search gives every coding agent connected to Paseo a web-search tool: one bundled stdio MCP server (`web_search`, `search_status`) with a user-selectable search backend — SearXNG by default — plus first-class operational UX inside Paseo: a **Test connection** button and a **connected indicator** (provider, base URL, latency, verdict) so the user always knows whether the search service is reachable and the MCP server actually boots.

The SearXNG adapter is ported from the reference implementation at `/home/sirafim/searxng/mcp/searxng_mcp_server.py` (tool signature, query parameters, user agent, timeout handling, friendly error messages, formatted output), extended with the provider registry required by the plugin task.

## 2. Architecture

```
bunny-search/
├── index.server.ts            # plugin server: settings, agent.create MCP injection, RPC handlers
├── index.client.tsx           # surface, sidebar item, ⌘K items, settings screen registration
├── shared/
│   ├── contracts.ts           # zod schemas, RPC contracts (defineRpc), shared types
│   ├── settings.ts            # host-scoped settings definition (defineSettings)
│   └── host-fonts.ts          # host Appearance settings parsing (client-safe)
├── server/
│   ├── providers.ts           # provider adapters (searxng / duckduckgo / brave / custom-json),
│   │                          # HTTP helpers, result formatting
│   ├── mcp-server.ts          # standalone stdio MCP server (JSON-RPC 2.0)
│   ├── mcp-tools.ts           # tool definitions + transport-independent dispatch
│   ├── mcp-launch.ts          # node + dist/mcp-server.js resolution (injection config)
│   ├── probe.ts               # live spawn check: MCP initialize handshake probe
│   ├── settings-file.ts       # settings.json + env reader for the spawned server process
│   ├── settings-mirror.ts     # host → settings.json mirror writer (atomic)
│   ├── ui-url.ts              # search-interface URL derivation (API origin / front pages)
│   └── paths.ts               # $PASEO_HOME resolution
├── client/
│   ├── surface.tsx            # status card (dot indicator) + quick search + Open button
│   ├── settings-screen.tsx    # Settings → Plugins screen: Test connection + Open interface
│   ├── open-search-ui.ts      # opens the interface in Paseo's browser tab (external fallback)
│   └── use-host-typography.ts # host font scale/family hook
├── scripts/
│   └── bundle-mcp-server.mjs  # esbuild → dist/mcp-server.js (standalone stdio server)
└── tests/                     # vitest: 7 suites, 65 tests (incl. real-process stdio e2e)
```

### Data flow

1. **Agent → search.** An agent process spawns `dist/mcp-server.js` as a stdio MCP server (injected by the plugin into Paseo-created agents, or configured manually in any MCP client). `web_search` calls flow through `dispatchMcpTool` → provider adapter → the configured HTTP service → normalized `SearchResponse` → `formatSearchResponse` text.
2. **UI → plugin server.** The surface and settings screen call plugin RPCs (`bunny-search.connection-test`, `bunny-search.status`, `bunny-search.search`) over the host transport. RPC handlers read the effective settings **live from the host settings store** (`settings.read()`), so a settings change applies to the test and quick search immediately.
3. **Host store → settings.json mirror.** The host owns the `defineSettings` store and never writes plugin files itself. Because the spawned MCP server cannot use the plugin API, the plugin mirrors the store into `$PASEO_HOME/plugins/bunny-search/settings.json` on startup and on every change (`settings.subscribe` → `server/settings-mirror.ts`, atomic temp-file + rename). Newly created agents therefore always spawn the MCP server with the user's current configuration.
4. **Plugin process → spawned server.** The connection test additionally spawns the bundled MCP entry exactly the way an agent would and performs an MCP `initialize` handshake (`server/probe.ts`), so the test covers both "the service answers" and "the MCP server boots".

### Why the MCP server is a bundled separate process

Same reasoning as memory-flash: the plugin runs inside the Paseo host process, but agent providers (Cline, OpenCode, Kilo, …) launch their own MCP subprocesses and speak stdio MCP to them. The plugin therefore registers itself with Paseo and injects a stdio config pointing at `dist/mcp-server.js` into every agent it sees created. One bundle, one protocol, many agent consumers.

### MCP protocol coverage

The stdio server implements the MCP 2024-11-05 baseline: `initialize` (protocol version, `tools` capability, `serverInfo`), `notifications/initialized`, `ping`, `tools/list`, `tools/call` (text content, `isError` flag), and `-32700/-32601` error responses. Newline-delimited JSON; stdout carries protocol messages only (logs go to stderr). Async tool dispatch is wrapped with `Promise.resolve(...)` so every request still yields exactly one JSON-RPC response. Verified by the e2e suite (real spawned process over stdio) and by a manual smoke test against a fake SearXNG HTTP server.

## 3. Provider adapters

All adapters implement one interface (`server/providers.ts`):

```ts
interface SearchProvider {
  search(request: SearchRequest, settings: RuntimeSettings): Promise<SearchResponse>;
  check(settings: RuntimeSettings): Promise<CheckResult>;  // the connection test backend
}
```

| Adapter | Endpoint | Auth | Notes |
| --- | --- | --- | --- |
| `searxng` (default) | `{searxngBaseUrl}?q=…&format=json&categories=…&language=…` | none | Ported from the reference MCP: same UA (`bunny-search-mcp/1.0 (+searxng)`), clamped `max_results` 1–30, instant `answers`, `suggestion`/`suggestions`/`corrections`, per-result `engines` |
| `duckduckgo` | `https://html.duckduckgo.com/html/?q=…` | none | Browser UA (HTML endpoint rejects tool UAs), regex-parses `result__a`/`result__snippet`, unwraps `uddg` redirect links, decodes HTML entities |
| `brave` | `https://api.search.brave.com/res/v1/web/search?q=…&count=…` | `X-Subscription-Token` (settings `apiKey`) | 401/403 mapped to an actionable "check the key" error |
| `custom-json` | `customBaseUrl` with `{query}` placeholder (URL-encoded) or `?q=` appended | optional `Authorization: Bearer` | Heuristic field mapping; accepts top-level arrays and nested `results`/`data`/`items`/`web` shapes |

Shared plumbing:

- **HTTP** — global `fetch` (Node ≥ 18) with an `AbortController` timeout; friendly, actionable messages for timeouts, `ECONNREFUSED`, `ENOTFOUND`/`EAI_AGAIN`, HTTP statuses and invalid JSON (mirroring the reference MCP's error style).
- **Normalization** — every adapter returns the same `SearchResponse` (`query`, `results[]` with `title`/`url`/`content`/`engines?`, `answers?`, `suggestion?`), so `formatSearchResponse` is provider-agnostic.
- **Formatting** — `Query:` line, `Answer:` (first instant answer), numbered results (`N. title`, URL, snippet truncated to 300 chars with `…`, `Engines:`), `Did you mean:`. Empty results render `No results found.`

## 4. Settings and configuration

**Host settings** (`shared/settings.ts`, `defineSettings`, scope `host`): `injectIntoAgents` (bool, default true), `mcpServerName` (default `bunny-search`), `searchService` (enum, default `searxng`), `searxngBaseUrl` (default `http://127.0.0.1:8888/search` — the reference MCP default), `customBaseUrl`, `searchUiUrl` (web interface URL; empty = derive from the API base URL's origin), `apiKey`, `timeoutMs` (1000–60000, default 20000), `maxResults` (1–30, default 10), `categories` (default `general,web`), `language` (default auto).

**Interface URL derivation** (`server/ui-url.ts`): explicit `searchUiUrl` wins; otherwise the origin of `searxngBaseUrl` / `customBaseUrl` (API `http://omnirouter/search` → interface `http://omnirouter`, port preserved); DuckDuckGo and Brave fall back to their public front pages (`https://duckduckgo.com`, `https://search.brave.com`). `bunny-search.status` reports the derived `uiUrl` (never a secret) to the UI.

**Runtime settings** — the MCP server is spawned by agent processes outside the plugin host, so it cannot receive settings through the SDK. `server/settings-file.ts` layers: schema defaults ← `$PASEO_HOME/plugins/bunny-search/settings.json` (accepts both the host `{revision, values}` layout and a flat object; out-of-range values fall back) ← environment variables (`BUNNY_SEARCH_BASE_URL`, `BUNNY_SEARCH_PROVIDER`, `BUNNY_SEARCH_CUSTOM_URL`, `BUNNY_SEARCH_API_KEY`, `BUNNY_SEARCH_TIMEOUT_MS`, `BUNNY_SEARCH_MAX_RESULTS`, `BUNNY_SEARCH_CATEGORIES`, `BUNNY_SEARCH_LANGUAGE`; `SEARXNG_BASE_URL` is honored for drop-in compatibility with the reference MCP). This keeps the server usable standalone with any MCP client.

## 5. Connection test and connected indicator

`bunny-search.connection-test` (the Test connection button) composes two independent checks:

1. **Service probe** — `checkSearchService()` performs a real search request against the configured backend with the configured timeout and measures latency (`server/providers.ts`).
2. **MCP handshake** — `probeMcpServer()` (4 s budget) spawns the bundled entry exactly as an agent would (`server/mcp-launch.ts` resolution), sends `{jsonrpc:"2.0",id:1,method:"initialize"}` and waits for a JSON-RPC response on stdout.

The RPC returns `{ok, provider, status, latencyMs, error, checkedAt, mcp:{ok, error}}`; overall `ok` requires both halves. The last result is kept in plugin memory and served by `bunny-search.status`, which backs:

- the **settings screen** status card (green/red dot, per-check error/success lines, including a distinct MCP-handshake failure line), and
- the **surface** status card (provider label, base URL, `Working · N ms` / `Failed: …` / `Not checked yet`, Test button, quick-search box backed by `bunny-search.search`).

This answers the task requirement directly: the user sees, at a glance, whether the search MCP is connected and working — and when it is not, the exact reason (service unreachable vs. server not booting).

**Open search interface** — the settings screen and the surface expose an **Open in browser / Open** action for `uiUrl`. On Electron hosts it opens inside Paseo's own browser tab via `props.navigation.openBrowser({url, workspaceId})` (workspace resolved through `paseo.workspaces.list()`); everywhere else — or when no workspace can be resolved — it falls back to `openExternalUrl()` from the plugin client SDK (`client/open-search-ui.ts`).

## 6. Agent injection

The injected MCP entry is built as an `as const` literal rather than annotated with `McpStdioServerConfig` from `@getpaseo/protocol`: that package is not supplied by Paseo, so a type-only import of it makes the plugin's server bundle depend on `node_modules` existing at install time. Assigning the literal into `request.config.mcpServers` type-checks it against the host's own type, which is the stronger guarantee. See [__doc.md](../command-center/__doc.md#5f-version-051--install-time-resolution-and-the-host-bundler-boundary) in command-center for the host-side rules this satisfies.

`index.server.ts` registers a `server.before('agent.create', …)` hook (awaited by the host): when `injectIntoAgents` is on, it adds

```json
"mcpServers": { "<mcpServerName>": { "type": "stdio", "command": "<node>", "args": ["<dist/mcp-server.js>"], "alwaysLoad": true } }
```

to the agent config and logs `[bunny-search] MCP injected: …` (visible in `paseo plugin logs bunny-search`). Command/entry resolution follows memory-flash's `mcp-launch.ts`: node via `process.execPath`/sibling/PATH, entry via `$PASEO_HOME/config.json` `plugins.<id>.path`, `dist/mcp-server.js` next to the bundle, import-meta dir, then `$PASEO_HOME/plugins/bunny-search/mcp-server.js`.

## 7. Compatibility

| Item | Value |
| --- | --- |
| Paseo | verified against 0.10.3 (requirement `>=0.10.0`) |
| SDK | `@getpaseo/plugin@0.10.1` |
| Node | ≥ 18 (global `fetch`; daemon verified on Node 24) |
| Install | `paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:bunny-search` — the manifest build step is `[["npm", "ci"], ["npm", "run", "bundle"]]`, so the daemon installs the dependencies and rebuilds `dist/mcp-server.js` in its managed clone (both commands need registry access). A local-directory install runs no build commands: run `npm ci && npm run bundle` there once. |
| Verification | typecheck clean; vitest 7 suites / 65 tests (providers with stubbed fetch, settings-file layering, settings-mirror round-trip, interface-URL derivation, spawn probe, tool dispatch, stdio e2e against a local fake SearXNG); static reproduction of the host's bundler boundary check against a staged copy — no boundary errors |

## 8. Alternatives considered

- **SearXNG only** — simplest, but the task explicitly requires user-selectable providers; the adapter interface makes adding more (e.g. Tavily, SerpAPI) a single new object in the registry.
- **In-process MCP** — impossible: agents speak stdio MCP to their own subprocesses.
- **Settings via MCP config** — the host injects the command only; values must come from the settings file / env, hence the layered reader.
- **Reading the host store from the MCP process** — impossible by design: the store is only exposed to the plugin host via the plugin API, and the MCP process is spawned by agent providers outside that host; hence the mirror file (the earlier file-only reader was the source of the "settings changed but the test still hits the default URL" bug — fixed by reading the store live and mirroring it).

## 9. Roadmap

- Register the MCP server directly in Cline/Cursor/Codex config files (as memory-flash does) for agents that ignore session stdio servers.
- Optional response caching and per-project category presets.
- More providers behind the same adapter interface.
