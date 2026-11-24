# Bunny Search — technical documentation

This file documents the internal design, verified compatibility, and the roadmap of the `bunny-search` plugin. User-facing description: [README.md](./README.md).

## 1. Purpose and scope

Bunny Search gives every coding agent connected to Paseo a web-search tool: one bundled stdio MCP server (`web_search`, `search_status`) with a user-selectable search backend — the DuckDuckJS meta-search library by default since 0.3.0 (SearXNG remains selectable) — plus first-class operational UX inside Paseo: a **Test connection** button and a **connected indicator** (provider, base URL, latency, verdict) so the user always knows whether the search service is reachable and the MCP server actually boots.

The SearXNG adapter is ported from the reference implementation at `/home/sirafim/searxng/mcp/searxng_mcp_server.py` (tool signature, query parameters, user agent, timeout handling, friendly error messages, formatted output), extended with the provider registry required by the plugin task.

## 2. Architecture

```
bunny-search/
├── index.server.ts            # plugin server: settings, agent.create MCP injection, RPC handlers
├── index.client.tsx           # surface, sidebar item, ⌘K items, settings screen registration
├── shared/
│   ├── contracts.ts           # zod schemas, RPC contracts (defineRpc), shared types
│   ├── settings.ts            # host-scoped settings definition (defineSettings)
│   ├── agent-instructions.ts  # `appendSystemPrompt` template + tool names (0.8.7)
│   └── host-fonts.ts          # host Appearance settings parsing (client-safe)
├── server/
│   ├── cjs-globals.ts         # __dirname/__filename globals for the host bundle evaluator
│   ├── ddgs-python.ts         # stage 2: PyPI ddgs subprocess (interpreter discovery + JSON calls)
│   ├── providers.ts           # provider adapters (duckduckjs / ddgs / searxng / duckduckgo /
│   │                          # brave / custom-json), HTTP helpers, result formatting
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
│   ├── sidebar-item.tsx       # sidebar row + live status dot (0.8.7)
│   ├── agent-panel.tsx        # per-agent search panel, inserts into that agent's composer (0.8.7)
│   ├── screen-id.ts           # the one screen id shared by the registrations
│   ├── settings-screen.tsx    # Settings → Plugins screen: Test connection + Open interface
│   ├── open-search-ui.ts      # opens the interface in Paseo's browser tab (external fallback)
│   └── use-host-typography.ts # host font scale/family hook
├── scripts/
│   └── bundle-mcp-server.mjs  # esbuild → dist/mcp-server.js (standalone stdio server)
└── tests/                     # vitest: 9 hermetic suites, 95 tests (incl. real-process stdio e2e)
                               # + live-ddgs.test.ts — live smoke (real Python/PyPI ddgs/network),
                               #   skipped by default; run with BUNNY_LIVE=1
```

Typechecking is split into three project references because server and client
code cannot share one `tsc` program (see §11.3): `tsconfig.server.json`
(server + shared + `index.server.ts`), `tsconfig.client.json` (client + shared
+ `index.client.tsx`) and `tsconfig.tests.json` (tests + the server code they
import); the root `tsconfig.json` is a solution file (`files: []` +
`references`) that keeps both worlds out of each other's ambient global scope,
and `npm run typecheck` runs `tsc -b` over it.

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
| `duckduckjs` (default, 0.3.0) | `@overclockedsenku/duckduckjs` library (DuckDuckGo HTML, Brave/Google/Mojeek/Yahoo internal endpoints) | none | `duckduckjsEngine` = `auto` walks DuckDuckGo → Brave → Google → Mojeek → Yahoo and returns the first non-empty answer, collecting per-engine failures (an aggregate error only when every engine fails); a concrete engine id pins one engine. `language` maps to `region` (`ru` → `ru-ru`); `proxyUrl` sets an undici `ProxyAgent` as the global dispatcher (http(s) only) because the library fetches through undici. `check()` additionally treats "all engines answered but zero results" as a failure (rate-limit signature). |
| `ddgs` (0.4.0) | `python3 -c <script>` subprocess running the user-installed PyPI `ddgs` library (`DDGS().text()`) | none (library is a user requirement) | Interpreter discovery in `server/ddgs-python.ts` (settings → `BUNNY_SEARCH_PYTHON` → `VIRTUAL_ENV` → `CONDA_PREFIX` → `PATH` → `~/.venv`/`~/venv`/`~/.virtualenvs`), first candidate that passes `import ddgs` wins, cached per process; `language` → `region` (same `ll-ll` mapping); `proxyUrl` passed as the library's `proxy` argument (http(s)/socks5); subprocess killed at `timeoutMs`; JSON array on stdout is normalized to `title`/`href`/`body`. `check()` runs the availability probe first so a missing library yields the "install it yourself" error, then a real search probe. Since 0.9.7 the script tries the library's `auto` mode first and, when it yields nothing, walks `ddgs.engines.ENGINES["text"]` one engine at a time in priority order and takes the first non-empty answer, because `auto` waits with `FIRST_EXCEPTION` and a single blocked engine aborts the search (§23). |
| `searxng` | `{searxngBaseUrl}?q=…&format=json&categories=…&language=…` | none | Ported from the reference MCP: same UA (`bunny-search-mcp/1.0 (+searxng)`), clamped `max_results` 1–30, instant `answers`, `suggestion`/`suggestions`/`corrections`, per-result `engines` |
| `duckduckgo` | `https://html.duckduckgo.com/html/?q=…` | none | Browser UA (HTML endpoint rejects tool UAs), regex-parses `result__a`/`result__snippet`, unwraps `uddg` redirect links, decodes HTML entities |
| `brave` | `https://api.search.brave.com/res/v1/web/search?q=…&count=…` | `X-Subscription-Token` (settings `apiKey`) | 401/403 mapped to an actionable "check the key" error |
| `custom-json` | `customBaseUrl` with `{query}` placeholder (URL-encoded) or `?q=` appended | optional `Authorization: Bearer` | Heuristic field mapping; accepts top-level arrays and nested `results`/`data`/`items`/`web` shapes |

Shared plumbing:

- **HTTP** — global `fetch` (Node ≥ 18) with an `AbortSignal.timeout(...)` deadline; friendly, actionable messages for timeouts, `ECONNREFUSED`, `ENOTFOUND`/`EAI_AGAIN`, HTTP statuses and invalid JSON (mirroring the reference MCP's error style). DuckDuckJS engine calls have no abort support in the library, so the adapter races them against `timeoutMs` instead.
- **Normalization** — every adapter returns the same `SearchResponse` (`query`, `results[]` with `title`/`url`/`content`/`engines?`, `answers?`, `suggestion?`), so `formatSearchResponse` is provider-agnostic.
- **Formatting** — `Query:` line, `Answer:` (first instant answer), numbered results (`N. title`, URL, snippet truncated to 300 chars with `…`, `Engines:`), `Did you mean:`. Empty results render `No results found.`

## 4. Settings and configuration

**Host settings** (`shared/settings.ts`, `defineSettings`, scope `host`): `agentInstructions` (string, 2000 max, default `DEFAULT_AGENT_INSTRUCTIONS` with a `{tool}` placeholder; empty switches the instruction off — 0.8.7), `injectIntoAgents` (bool, default true), `mcpServerName` (default `bunny-search`), `searchService` (enum, default `duckduckjs` since 0.3.0; `ddgs`, `searxng`, `duckduckgo`, `brave`, `custom-json` remain), `duckduckjsEngine` (enum `auto`/`duckduckgo`/`brave`/`google`/`mojeek`/`yahoo`, default `auto`), `proxyUrl` (optional proxy for DuckDuckJS — http(s), and for DDGS Python — http(s)/socks5; empty = direct), `ddgsPythonPath` (explicit interpreter for the `ddgs` service; empty = auto-discovery), `searxngBaseUrl` (default `http://127.0.0.1:8888/search` — the reference MCP default), `customBaseUrl`, `searchUiUrl` (web interface URL; empty = derive from the API base URL's origin), `apiKey`, `timeoutMs` (1000–60000, default 20000), `maxResults` (1–30, default 10), `categories` (default `general,web`), `language` (default auto). The settings screen shows the engine selector and proxy field only when DuckDuckJS is the selected service, and the Python-path and proxy fields when DDGS Python is. Existing installs keep their stored `searchService`; the new default applies to fresh configurations.

**Interface URL derivation** (`server/ui-url.ts`): explicit `searchUiUrl` wins; otherwise the origin of `searxngBaseUrl` / `customBaseUrl` (API `http://omnirouter/search` → interface `http://omnirouter`, port preserved); DuckDuckGo and Brave fall back to their public front pages (`https://duckduckgo.com`, `https://search.brave.com`). `bunny-search.status` reports the derived `uiUrl` (never a secret) to the UI.

**Runtime settings** — the MCP server is spawned by agent processes outside the plugin host, so it cannot receive settings through the SDK. `server/settings-file.ts` layers: schema defaults ← `$PASEO_HOME/plugins/bunny-search/settings.json` (accepts both the host `{revision, values}` layout and a flat object; out-of-range values fall back) ← environment variables (`BUNNY_SEARCH_BASE_URL`, `BUNNY_SEARCH_PROVIDER`, `BUNNY_SEARCH_DUCKDUCKJS_ENGINE`, `BUNNY_SEARCH_PROXY_URL`, `BUNNY_SEARCH_PYTHON`, `BUNNY_SEARCH_CUSTOM_URL`, `BUNNY_SEARCH_API_KEY`, `BUNNY_SEARCH_TIMEOUT_MS`, `BUNNY_SEARCH_MAX_RESULTS`, `BUNNY_SEARCH_CATEGORIES`, `BUNNY_SEARCH_LANGUAGE`; `SEARXNG_BASE_URL` is honored for drop-in compatibility with the reference MCP). This keeps the server usable standalone with any MCP client.

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
| Paseo | verified against 0.17.1 (2026-11-21, §21 and §22), 0.16.0 (2026-11-16, §18) and 0.15.0 (2026-11-03, §16); requirement `>=0.17.0` since 0.8.7 — `appendSystemPrompt` and `focusHost` exist only from 0.17.0 and a 0.16.x daemon rejects the field (§22.3). Earlier: `>=0.15.0` (`server.addHook` exists only from 0.15.0, §16), 0.14.0 (2026-10-30, §15), 0.12.0 (2026-10-21), stable 0.11.0 and 0.10.3. |
| SDK | `@getpaseo/plugin@^0.17.1` (pin raised from `^0.16.0` for the 2026-11-22 pass; the host supplies the runtime instance, the pin only types the build) |
| Node | ≥ 18 (global `fetch`; daemon verified on Node 24) |
| Install | `paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:bunny-search` — the daemon clones into `~/.paseo/plugins/bunny-search/<revision>/checkout/bunny-search` and runs the manifest build step `[["npm", "ci"], ["npm", "run", "bundle"]]` there, so the dependencies are installed and `dist/mcp-server.js` is rebuilt in the Paseo home (both commands need registry access). A local-directory source is not used: it would execute the plugin straight from the working copy and run no build commands at all. |
| Verification | typecheck clean (three-project `tsc -b`) and vitest **13 suites / 183 tests** green against SDK 0.17.1 (§21.4); earlier evidence against SDK 0.15.0 — **10 suites / 133 tests** green, with 2 live-search tests skipped by default (`BUNNY_LIVE=1`) (§16.5); both hooks registered and firing on the **real 0.15.0 daemon** — `agent.create.before` logged `MCP injected`, `agent.open.before` logged the session-open decision (§16.5); older evidence: 0.14.0 (§15.3), 0.12.0 client audit still clean (§13.3), stable-0.11.0 checks in §10.1, live ddgs smoke (`BUNNY_LIVE=1`) — real search results + connection check `ok` on this machine (`~/venv/bin/python3`, ddgs 9.16.0). Older passes: SDK 0.12.0 (§13.4) |

## 8. Alternatives considered

- **SearXNG only** — simplest, but the task explicitly requires user-selectable providers; the adapter interface makes adding more (e.g. Tavily, SerpAPI) a single new object in the registry.
- **Search libraries evaluated for the extra engines (stage 1, 0.3.0)** — `@overclockedsenku/duckduckjs` chosen (TypeScript, five engines without API keys, single-file bundling verified with esbuild, proxy reachable through its own `undici` dependency); Python `ddgs` deferred to stage 2 (richest engine set and first-class `proxy` argument, but requires python3 ≥ 3.10 plus a user-run `pip install ddgs` — the plugin will only *check* availability, never install it); the npm package `ddgs` rejected (puppeteer + stealth plugin — a Chromium download that contradicts the self-contained bundle); `google-search-scraper-nodejs` rejected (Windows-only browser automation); `@wzrdteam/search` not adopted (Bing-only scraper whose axios proxy support is reachable only through process environment variables, so no settings-UI field is possible — and DuckDuckJS already aggregates Bing-class sources).
- **In-process MCP** — impossible: agents speak stdio MCP to their own subprocesses.
- **Settings via MCP config** — the host injects the command only; values must come from the settings file / env, hence the layered reader.
- **Reading the host store from the MCP process** — impossible by design: the store is only exposed to the plugin host via the plugin API, and the MCP process is spawned by agent providers outside that host; hence the mirror file (the earlier file-only reader was the source of the "settings changed but the test still hits the default URL" bug — fixed by reading the store live and mirroring it).

## 9. Roadmap

- Register the MCP server directly in Cline/Cursor/Codex config files (as memory-flash does) for agents that ignore session stdio servers.
- Optional response caching and per-project category presets.
- More providers behind the same adapter interface.
- ~~**Stage 2: Python `ddgs` backend**~~ — implemented in 0.4.0, see §12.

## 10. Paseo 0.11.0 — verified compatibility and improvement plan

### 10.1 Verification against the stable 0.11.0 release (2026-10-07)

Stable `0.11.0` replaced the beta verification target. Everything below was
re-run against the stable release; conclusions:

| Check | Result |
| --- | --- |
| SDK diff `@getpaseo/plugin@0.10.1 → 0.11.0` | **additive only** for this plugin: new `dist/server/process.*` and `dist/server/usage.*` files; changed declaration files (`client/contracts`, `client/index`, `client/ui`, `server/contracts`, `server/index`, `server/lifecycle`, `server/provider`) only add types/members (`PluginScreen*`, `SidebarRow`, `registerUsageSource`, `agent.closed`, `playAudio`, provider launch/status). Nothing the plugin uses was removed. |
| Deprecated aliases in 0.11.0 | `addSurface`, `addSidebarItem` and `openSurface` are still present in `client/contracts.d.ts`, marked `@deprecated`; the shipped client bundle implements `addSurface` as a thin wrapper over `G.addScreen(...)`, i.e. they are host shims, still functional on 0.11.0. |
| SDK diff `0.11.0-beta.5 → 0.11.0` | only `package.json` differs — the beta-era verification (host bundler, manifest compatibility, live install) carries over to stable. |
| `npm run typecheck` with SDK 0.11.0 | exit 0 (scratch copy of the plugin with `@getpaseo/plugin@0.11.0` installed). |
| `npm test` with SDK 0.11.0 | 7 suites / 65 tests pass. |
| Fresh Git install on an isolated stable-0.11.0 daemon (`--home` scratch, own port) | manifest build ran `npm ci` (358 packages) + `npm run bundle` (`dist/mcp-server.js written`), plugin reached status `running`, log shows `Plugin ready` + `settings mirrored`. The README install command (`git+subdir` URL form) works unchanged despite the new registry-first `paseo plugin add owner/slug` semantics. |
| `paseo plugin reload bunny-search` on 0.11.0 | exit 0, plugin restarts (`Plugin ready` in logs) — the old "reload fails manifest validation" note is stale on 0.11.0 and was removed from the README. |
| Production home (`~/.paseo`, daemon 0.11.0) | plugin `running`, `agent.create` hook logs `MCP injected: …`. |
| Fresh-home pitfall (not a plugin issue) | a brand-new daemon home ships `pluginsEnabled` unset (plugins globally disabled); the plugin installs and builds but stays `disabled` until the flag is set. Reproduced and worked around in the scratch home. |
| Build-log observation | npm ≥ 11 blocks the esbuild postinstall script (`allowScripts`) during `npm ci`; `npm run bundle` still succeeds because esbuild's platform package is a regular dependency. Harmless, but worth knowing when reading install logs. |

**Conclusion: no code changes are required for 0.11.0; the plugin runs as-is.**

### 10.2 Improvement plan (implementation on request)

Ordered by value/risk; items 1–3 are the actual work items, 4 is recorded as
rejected for now.

**1. Host-managed process execution — `server/probe.ts` (small, low risk).**
- Replace `import { spawn } from "node:child_process"` with
  `spawnProcess` from `@getpaseo/plugin/server` (same `spawn` signature plus
  Windows `.cmd`/`.bat` handling, `windowsHide`, shell quoting).
- Replace `child.kill("SIGTERM")` in `finish()` with `await terminateProcess(child, "SIGTERM")`
  (on POSIX it is `child.kill(signal)`; on Windows it taskkills the tree), so a
  timed-out probe cannot leave an orphaned MCP server on Windows.
- `execCommand` is not needed here — the probe streams stdout line by line.
- Effects: `tests/probe.test.ts` keeps its contract (the probe still returns
  `Promise<boolean>`); no behavioral change on POSIX, so the 65 tests remain
  the safety net. Bump `requirements.paseo` to `>=0.11.0` (SDK is supplied by
  the host at runtime; `spawnProcess` does not exist on 0.10 hosts).

**2. Screen/sidebar modernization — `index.client.tsx`, `client/surface.tsx` (medium).**
- `client.addSurface(id, C)` → `client.addScreen({ id, title, Component })` and
  `client.addSidebarItem({ id, title, icon, surface })` →
  `client.addSidebarHeaderItem({ id, title, Component })` where the component
  renders `SidebarRow`s and calls `props.openScreen({ screenId, params })`.
- Command Center `onSelect({ openSurface })` → `onSelect(ctx)` with
  `ctx.openScreen({ screenId, params })`.
- New capability: `PluginScreenProps.params` (string→string, travels in the
  screen URL) — the Command Center item and a future slash command can deep
  link `?q=<query>` so the quick-search box opens prefilled;
  `PluginScreenTitle` derives the header (`Bunny Search` or `Search: <q>`).
- Status block: `addSidebarFooterItem` with `SidebarRow` + `trailing` slot for
  the green/red dot and a Test button, `SidebarSeparator` between groups —
  host-native instead of custom surface layout.
- Shims stay functional on 0.11.0 (verified above); the migration is
  proactive, driven by the `@deprecated` marks rather than an imminent removal.
  Bump `requirements.paseo` to `>=0.11.0`.

**3. Registry readiness — `paseo-plugin.json` + new `OVERVIEW.md` (small).**
- 0.11.0 added manifest metadata: `name` (display name), `icon` (PNG inside
  the package), `media` (screenshots/videos — local paths relative to the
  manifest or HTTPS URLs; local assets must be listed in package.json
  `files`). Add `name: "Bunny Search"`, `icon`, and 2–3 settings screenshots.
- Create `OVERVIEW.md` beside the manifest: required to list the plugin in the
  registry; plain-language description of what it does, setup, capabilities and
  limits — no install commands, badges or changelog (per the `paseo plugin init`
  template). This is what the plugin page shows under the install command.
- No runtime effect; unlocks `paseo plugin add SirafimsBrain/Paseo-Plugins`
  registry installs once the repo is submitted.

**4. Usage reporting — deferred (decision recorded).**
- `registerUsageSource({ id, label, icon?, input: ZodType, discover(scope),
  fetch(input) })` models **accounts in a login store**: `discover` must return
  `UsageAccount[]` for a global/session scope, `fetch` reads the store without
  writing it. It is designed for subscription logins (Codex, Claude, …), not
  for a backend with a stateless API key.
- Of the four providers, only Brave has quota-shaped limits, and its Search API
  does not expose a quota endpoint that could back `discover`/`fetch`; SearXNG
  and DuckDuckGo have no quota; Custom JSON is unknown by construction.
- Registering a synthetic "account" whose window is guessed from response
  headers would put an unreliable card into the user-facing Usage dialog.
  Revisit only if Brave ships a quota endpoint or a provider adapter grows a
  reliable rate-limit signal.

## 11. Version 0.3.0 — DuckDuckJS as the default provider

### 11.1 Motivation

Search engines have tightened the rules for anonymous queries, which degraded
the SearXNG-first setup (a proxy inside SearXNG did not hold up under load).
Stage 1 of the response makes the self-contained **DuckDuckJS** library the
default backend: no API key, no self-hosted service, five engines with an
automatic fallback order. SearXNG stays in the provider dropdown as a first-class
option (requirement), together with DuckDuckGo, Brave and Custom JSON.
Real search output is verified by the user from a real browser only — the
codebase follows "optimistic coding": unit tests mock the engines, and no test
performs live queries against search services.

### 11.2 What changed

- `shared/settings.ts` / `shared/contracts.ts`: `searchService` default
  `searxng` → `duckduckjs`; new `duckduckjsEngine` (default `auto`) and
  `proxyUrl` (default empty) fields; `SEARCH_SERVICE_LABELS` lists DuckDuckJS
  first; new `DUCKDUCKJS_ENGINE_LABELS` for the settings-screen select.
- `server/providers.ts`: new `duckduckjs` adapter — engine registry
  (DuckDuckGo/Brave/Google/Mojeek/Yahoo), `auto` fallthrough collecting
  per-engine failures, language→region mapping, `AbortSignal.timeout`-free
  engine race against `timeoutMs`, `check()` that also fails on the
  "answered but zero results" rate-limit signature, and `applyProxyUrl()`
  which validates an http(s) proxy URL and installs an undici `ProxyAgent`
  as the global dispatcher (shared with the library's own `fetch`; an empty
  URL restores a direct `Agent`).
- `server/settings-file.ts`: new defaults plus file/env parsing
  (`BUNNY_SEARCH_DUCKDUCKJS_ENGINE`, `BUNNY_SEARCH_PROXY_URL`).
- `client/settings-screen.tsx`: engine select and proxy input rendered only
  for the DuckDuckJS service; provider hints no longer claim SearXNG is the
  default. `server/ui-url.ts` derives the DuckDuckGo front page for
  DuckDuckJS (overridable via `Search interface URL`).
- `scripts/bundle-mcp-server.mjs`: the ESM banner gained `__filename` /
  `__dirname` shims — `@deno/shim-deno` (pulled in by the library) uses them
  and otherwise crashes a `format: esm` bundle at load time.
- `server/cjs-globals.ts` + the first import of `index.server.ts`: defines
  `__dirname`/`__filename` on `globalThis` **before any bundled dependency
  evaluates** — the host compiles the server entry to `format: "cjs"` and
  runs it via `globalThis.eval` in a wrapper that supplies only
  `require`/`module`/`exports`, so `@deno/shim-deno`'s module-scope
  `__dirname` crashed plugin load with `__dirname is not defined` (release
  blocker of the first 0.3.0 rollout; see §11.4).
- `package.json`: `dependencies` on `@overclockedsenku/duckduckjs` +
  `undici` (both compiled into `dist/mcp-server.js`; agents still need no
  `node_modules`); bundle size 24 KB → ~3.3 MB.
- Tests: DuckDuckJS engines are mocked with a hoisted `vi.mock` (scripted
  results/failures per engine), covering fallthrough, empty answers,
  aggregate failure, pinned-engine errors, region mapping, clamping, proxy
  validation and the check()'s rate-limit branch; settings-file defaults and
  the stdio e2e (which pins `BUNNY_SEARCH_PROVIDER=searxng` against its fake
  SearXNG) were updated for the new default. 7 suites / 76 tests, typecheck
  clean.
- Version `0.2.1` → `0.3.0` (new functionality → second digit), annotated tag
  `bunny-search@0.3.0`; hotfix `0.3.0` → `0.3.1` (third digit) for the
  host-evaluator load crash, tag `bunny-search@0.3.1`.

### 11.3 The typecheck split: `@types/node` vs `react-native` ambient globals

Adding the library's `undici` dependency exposed a latent conflict in the
single whole-plugin `tsc` program: `@types/node` and `react-native` both
declare global `fetch`, `RequestInit` and `AbortSignal`, and their
`AbortSignal` interfaces are not identical (`onabort` shapes differ). The
merge is hidden by `skipLibCheck`, but whether the `timedGet` fetch call
type-checks then depends on **which declaration wins the global merge — i.e.
on file processing order**, which changed once `undici` entered the import
graph (`server/providers.ts(98): error TS2769`, "Type 'AbortSignal' is not
assignable to type 'global.AbortSignal'"). The failure reproduced with
`providers.ts + any client file` in one program and never with either side
alone; dynamic import, `AbortSignal.timeout()` and other signal constructions
all stayed order-dependent, so the conflict cannot be fixed inside one call
site.

Resolution: **each runtime typechecks in its own project** (every subset was
empirically verified clean first):

| Project | Contents | Ambient globals |
| --- | --- | --- |
| `tsconfig.server.json` | `server/`, `shared/`, `index.server.ts` | `@types/node` only |
| `tsconfig.client.json` | `client/`, `shared/`, `index.client.tsx` | react-native + `@types/node` |
| `tsconfig.tests.json` | `tests/` + the server code they import | `@types/node` only |

Root `tsconfig.json` became a solution file (`files: []` + `references`,
children `extends` it for compiler options and set `composite` + `noEmit`),
and `npm run typecheck` runs `tsc -b`. Client code never touches `fetch` or
`AbortSignal`, so no functionality is unchecked; the alternative paths —
type-assertion casts around the fetch call, or dropping request abortion —
were rejected as suppressions/behavior regressions. Note: no single command
type-checks the *entire* plugin anymore; that combination is exactly the
uncheckable one.

### 11.4 The 0.3.0 load crash and the host evaluator contract

The first rollout of 0.3.0 failed at `paseo plugin update` with
`Plugin failed to load: __dirname is not defined` and rolled back to the
previous revision. Root cause (read out of the app bundle's
`@getpaseo/server` plugin compiler):

- The host compiles the plugin **server** entry with esbuild
  `bundle: true, format: "cjs", platform: "node", target: "node20"`,
  externalizing only the plugin SDK specifiers and `zod`
  (`SERVER_HOST_MODULES`); **all other npm dependencies are bundled into
  the plugin process** (git installs satisfy the boundary checks because
  the manifest build ran `npm ci` inside the checkout).
- The output is wrapped as `(function(require) { const module = …; const
  exports = …; <code> })` and evaluated with indirect `globalThis.eval`,
  so the only injected CommonJS binding is `require` — `__dirname` and
  `__filename` are undefined free variables in that scope.
- Until DuckDuckJS the plugin had zero bundled CommonJS dependencies, so
  the gap was invisible. `@deno/shim-deno` reads `__dirname` at module
  scope (`…/stable/variables/mainModule.js`) and threw during bundle
  evaluation — i.e. at plugin load, before any plugin code ran.

Fix: `server/cjs-globals.ts` assigns `globalThis.__dirname/__filename`
(`??=` so real values win) and `index.server.ts` imports it **first** —
ESM import evaluation order is declaration order, so the globals exist
before the bundled `@deno/shim-deno` factory executes. The values are
only ever read to build informational shim paths.

Verification: a local replica of the exact host pipeline (same esbuild
options, wrapper, indirect eval, `factory(runtimeRequire)`, mock
`PluginServerContext`) loads the bundle, registers all three RPC
handlers and serves `bunny-search.status` with `provider: "duckduckjs"`;
the same replica **without** the shim reproduces the crash at the
identical `mainModule.js` line (control run), and the real
`paseo plugin update` then reached status `running`.

## 12. Version 0.4.0 — DDGS Python backend (stage 2)

### 12.1 Requirement boundary: the user installs the library

The PyPI `ddgs` library is documented as a **user-installed requirement**
(README "Python requirement": `pip install ddgs` / pipx / uv). The plugin
contains **no installer**: `server/ddgs-python.ts` only *verifies*
availability with `import ddgs` and reports an actionable error
("user requirement — install it yourself … pip install ddgs") that also
lists every interpreter it searched. This satisfies the stage-2 contract:
check and use, never install.

### 12.2 Interpreter discovery (environment variables first)

Ordered candidate walk, first one that both executes and imports `ddgs`
wins (candidates without the library are skipped — this machine's
`/usr/bin/python3` has no ddgs while `~/venv` does):

1. `ddgsPythonPath` plugin setting (explicit override);
2. environment variables — `BUNNY_SEARCH_PYTHON`, `VIRTUAL_ENV`,
   `CONDA_PREFIX` (then every `python3`/`python` on `PATH` in `PATH`
   order, itself an environment-based tier);
3. well-known directories: `~/.venv`, `~/venv`, `~/.virtualenvs/*`,
   `~/.local/share/virtualenvs/*`.

The requested order ("start with environment variables, then the venv
directories") is therefore literal: settings override → env vars → PATH →
directories. The resolved interpreter is cached for the process lifetime;
if a verified interpreter later fails to import the library, the cache is
dropped and discovery runs once more before the error is surfaced.
`BUNNY_SEARCH_PYTHON` also works as a settings-file environment override.

### 12.3 Subprocess protocol

`spawn(python, ["-c", <script>, query, max_results, region, proxy,
timeout_s], …)` — no shell, arguments passed as argv. The script runs
`DDGS(timeout=…, proxy=…)` (constructor takes http(s)/socks5 proxy) and
`client.text(query, max_results=…, region=…)`, printing a JSON array on
stdout; errors go to stderr with a non-zero exit and are surfaced as the
last meaningful line. The child is killed at `timeoutMs` (same
"did not respond within the configured timeout" wording as the other
providers). `language` maps to the `ll-ll` region convention shared with
DuckDuckJS (`ru` → `ru-ru`) via the common `languageToRegion()` helper.
Because the module uses only Node built-ins (`node:child_process`,
`node:fs`, `node:os`, `node:path`), it adds no npm dependencies and is
safe inside both bundles (host CJS evaluator and the MCP ESM bundle).

### 12.4 UI, checks and verification

- Settings screen: for the `ddgs` service — a `Python path` override
  field (with the discovery order in its hint) and the shared `Proxy URL`
  field; `search_status`/`providerBaseUrl` report no base URL and
  `searchInterfaceUrl` returns `null` (a subprocess has no web UI).
- `check()` runs the availability probe **first** (missing library → the
  install-yourself error, never a confusing search failure), then a real
  search probe; "answered but zero results" maps to the shared
  rate-limit message.
- Tests: `python-discovery.test.ts` (real fs, fake `python` shell
  scripts — ordering, skipping interpreters without the library,
  actionable search trail, cache behavior) and `ddgs-provider.test.ts`
  (scripted `spawn` mock — normalization, region/proxy/timeout argv,
  clamping, error mapping, timeout kill, rediscovery after the library
  disappears, all three `check()` branches). 9 suites / 95 tests green;
  three-project typecheck green.
- Real-machine smoke (availability only, **no search performed** — live
  queries are tested by the user): discovery skipped `/usr/bin/python3`
  (no ddgs) and resolved `/home/sirafim/venv/bin/python3`
  (`ddgs 9.16.0`, Python 3.13.5) from `PATH`.
- Version `0.3.1` → `0.4.0` (new functionality → second digit), annotated
  tag `bunny-search@0.4.0`.

## 13. Paseo 0.12.0 — spec conformance (2026-10-21)

Audited and migrated against the stable `0.12.0` release
(2026-10-19). Evidence below; the release notes:
<https://github.com/getpaseo/paseo/releases/tag/v0.12.0>.

### 13.1 What 0.12.0 changed for this plugin

| Check | Result |
| --- | --- |
| SDK diff `@getpaseo/plugin@0.10.1 → 0.12.0` | **Additive only** for the API surface this plugin uses. New since 0.10.1: the screen/sidebar API (`addScreen`, `addSidebarHeaderItem`, `addSidebarFooterItem`, `openScreen`, `PluginScreenProps.params`, `SidebarRow`/`SidebarSeparator`), `playAudio`, `spawnProcess`/`execCommand`/`terminateProcess`, `registerUsageSource`. Nothing the plugin used was removed or changed in meaning. |
| `0.11.0 → 0.12.0` declaration diff | `client/contracts.d.ts` and `client/ui.d.ts` are **byte-identical** between the two releases: the screen/sidebar API landed in 0.11.0 and 0.12.0 adds no client contract change. The migration below is therefore 0.11.0-compatible, which is why `requirements.paseo` is `>=0.11.0` rather than `>=0.12.0`. |
| Server SDK diff | Additive only: `registerUsageSource` (+ `dist/server/usage.*`) and `spawnProcess`/`execCommand`/`terminateProcess` (+ `dist/server/process.*`). |
| Deprecated client members in 0.12.0 | `addSurface`, `addSidebarItem` (and its `PluginSidebarContribution` type) and `openSurface` remain in `client/contracts.d.ts` with `@deprecated Use addScreen` / `... addSidebarHeaderItem` / `... openScreen` JSDoc. No removal version is published. |
| Deprecated members on the shipped 0.12.0 host | Still implemented as shims: the app bundle maps `addSurface(id, Component)` → `addScreen({ id, title: id, Component })`, `addSidebarItem(contribution)` → the header-item registry, and `openSurface(id)` → `openScreen({ screenId: id })`. Old plugins keep loading; the migration is driven by the `@deprecated` marks, not by breakage. |
| `PluginSurfaceProps` | **Not deprecated.** It is still the prop type of settings-screen components, so `client/settings-screen.tsx` and the shared `openSearchInterfaceUrl(url, props, paseo)` helper keep it. Only the *screen* component moved to `PluginScreenProps` (it adds `params`). |
| 0.12.0 fixes that touch this plugin's area | `#7023` — plugins importing Paseo *protocol types* no longer fail to install with `Could not resolve type dependency`; type-only `@getpaseo/protocol/...` imports are erased without a plugin-local install (runtime imports still resolve normally). This plugin still does **not** import `@getpaseo/protocol` (see the comment in `index.server.ts`), so it is unaffected either way. `#6306` — `paseo plugin reload` no longer fails with a 60 s timeout while the reload is still running, which makes the documented reload workflow below reliable. `#6760` — `providers.waitForReady` no longer throws in plugins on mobile (not used here). |
| Manifest rules | `requirements.paseo` is an npm semver range checked on install, start, enable and reload; unknown keys inside `requirements` are rejected. `name`/`icon`/`media` metadata requires ≥ 0.11.0 and is still unused here (§10.2 item 3, unchanged — no runtime effect). |
| ID charset | Plugin, screen, sidebar-item, Command Center, settings-screen and slash-command IDs must start with a lowercase letter and contain lowercase letters, numbers or hyphens. `bunny-search`, `bunny-search-settings`, `open-bunny-search` all conform. |

### 13.2 Migration performed (version 0.4.1 → 0.4.2)

`index.client.tsx` and `client/surface.tsx`:

| Before (0.10-era) | After (0.11+/0.12 spec) |
| --- | --- |
| `client.addSurface(SURFACE_ID, BunnySearchSurface)` | `client.addScreen({ id: SCREEN_ID, title: "Bunny Search", Component: BunnySearchSurface })` |
| `client.addSidebarItem({ id, title, icon, surface })` | `client.addSidebarHeaderItem({ id, title, Component })` with `BunnySearchSidebarItem` rendering `<SidebarRow icon="Globe" active={...} onPress={...} />` |
| `onSelect({ openSurface }) { openSurface(SURFACE_ID) }` | `onSelect({ openScreen }) { openScreen({ screenId: SCREEN_ID }) }` |
| `BunnySearchSurface(props: PluginSurfaceProps)` | `BunnySearchSurface(props: PluginScreenProps)` — gains `params`, so a Command Center item or slash command can deep-link `?q=<query>` later |

Why a **header** item: the previous `addSidebarItem` registered into the
sidebar's header list, so `addSidebarHeaderItem` preserves placement exactly.
`addSidebarFooterItem` is reserved for the §10.2 item 2 status dot/Test button
(unchanged: that extra row is a new capability, still optional work).
Settings-row label and accessibility label both come from the contribution
`title`; the row's own label defaults to it, so `SidebarRow` needs no `label`.
The screen `title` is a plain string (`"Bunny Search"`) — no params are
passed today, so a `PluginScreenTitle` function would be dead code.

DOM-global rule (see §13.3) forced one more new file: `client/use-host-typography.ts`
no longer touches the page store itself; it calls `readHostTypography()` from
the new `client/web.ts`.

`paseo-plugin.json`: `requirements.paseo` `>=0.10.0` → `>=0.11.0`
(`addScreen`/`addSidebarHeaderItem`/`openScreen` do not exist on 0.10 hosts).
`package.json`: `@getpaseo/plugin` `0.10.1` → `0.12.0`, version `0.4.1` → `0.4.2`
(functionality change to existing registration → patch digit, per the project
versioning rules).

### 13.3 The 0.12.0 cross-platform audit — one real violation, fixed

The 0.12.0 client audit is `document.|window.|localStorage|navigator.|<html element>|className=|onClick=`
over `client/`, and *"A hit outside `client/web.ts` is a bug."* DOM globals
must live in `client/web.ts`, declared only for what that module uses, with
every export gated on `Platform.OS === "web"` plus a native fallback.

| Audit target | Before | After |
| --- | --- | --- |
| `client/use-host-typography.ts` | read `globalThis.localStorage` directly (spec violation: a DOM global in a cross-platform module) | **fixed** — calls `readHostTypography()` from the new `client/web.ts`, which is gated on `Platform.OS === "web"` and returns `null` on native so callers fall back to defaults |
| `client/surface.tsx`, `client/settings-screen.tsx`, `client/open-search-ui.ts` | clean | clean |
| HTML elements / `className` / `onClick` in `client/` | none (React Native only) | none |
| `"DOM"` in `lib`, or `/// <reference lib="dom" />` | none — `tsconfig.json` has `"lib": ["ES2023"]` | unchanged |
| `shared/host-fonts.ts` | takes the storage object as a **parameter** (`Pick<Storage, "getItem">`), never reaches for a global itself | unchanged — shared code stays runtime-neutral, which is what lets `client/web.ts` be the only global accessor |

The same `use-host-typography.ts` copy exists in command-center,
memory-flash, memory-flash-client and session-manager; each needs the same
one-file fix when it is audited (that is a per-plugin patch bump for each).

### 13.4 Verification (2026-10-21, this machine)

| Check | Result |
| --- | --- |
| `npm install` with `@getpaseo/plugin@0.12.0` | exit 0; lockfile updated |
| `npm run typecheck` (three-project `tsc -b`) against 0.12.0 types | **exit 0** |
| `npm test` | **9 suites / 95 tests pass** (2 gated live tests skipped, as designed) |
| `npm run bundle` → `dist/mcp-server.js` | written, exit 0 |
| 0.12.0 client audit (DOM globals outside `client/web.ts`, HTML elements, `className`, `onClick`) | **clean** |
| `"DOM"`/`reference lib="dom"` in tsconfigs | clean (`lib: ["ES2023"]`) |
| Remaining deprecated registrations in `client/` | **none** (`grep addSurface\|addSidebarItem\|openSurface` → no hits) |
| All IDs conform to the lowercase/hyphen rule | yes |
| `requirements.paseo` | `>=0.11.0` — matches the APIs actually used |
| Live install on a running 0.12.0 daemon | **PASS** — installed from the working tree into an isolated 0.12.0 daemon (scratch `HOME`, production config untouched): status `running`, `Plugin ready` in the log, no client-contribution errors. The real 0.12.0 host compiler (`compilePlugin`) built the client entry; the compiled bundle contains the new API and **zero** legacy `addScreen`/`addSidebarItem`/`registerCommand`/`createComposerPill`/`registerAttachmentSource`/`registerTimelineDecorator`/`registerSurface`/`registerCommandCenterItem`/`appendArtifact`/`renderArtifact` calls. Server-side effects observed live: the settings mirror was written. `paseo plugin reload bunny-search` exits 0 (the 0.12.0 #6306 fix). |

### 13.5 Not adopted (recorded, unchanged from §10.2)

- **Item 1 — `spawnProcess`/`terminateProcess` in `server/probe.ts`.** Still
  the better API (Windows `.cmd` handling, tree kill on timeout), but adopting
  it is a server-behavior change needing its own test pass. Not required for
  0.12.0 conformance: `node:child_process` remains legal in `server/`.
- **Item 3 — registry metadata** (`name`/`icon`/`media` + `OVERVIEW.md`).
  Still optional at runtime; `OVERVIEW.md` is what a *registry listing*
  requires, not what installation requires.
- **Item 4 — `registerUsageSource`.** Rejected earlier; 0.12.0 does not change
  the reasoning.
- **Deep-link quick search via `PluginScreenProps.params`** and a
  `addSidebarFooterItem` status row: both now *possible* on this SDK, both
  still optional. They would be new functionality → second-digit bump.

Version `0.4.1` → `0.4.2` (existing-registration migration + a real audit
fix, no new capability → last digit), annotated tag `bunny-search@0.4.2`.

## 15. Paseo 0.14.0 — compatibility pass (2026-10-30)

Audited against the stable `0.14.0` release (2026-10-29).
Release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.14.0>.
The repository-wide inventory of what 0.14.0 adds and deprecates is in the
root [README](../README.md#paseo-0140--new-and-deprecated-sdk-surface-2026-10-29);
this section records what is specific to bunny-search.

**Result: compatible, no code change and no deprecated API in it.** Version
stays `0.4.2` — no bump and no tag, because this pass changed no code (only
documentation). Superseded the same day: §15.2's recommendations were then
implemented on request, which is a real code change and shipped as **0.5.2**
(§15.4), with the annotated tag `bunny-search@0.5.2` and the floor raised to
`requirements.paseo >=0.14.0` because the adopted APIs are 0.14.0's.

### 15.1 What 0.14.0 changed for this plugin

| Check | Result |
| --- | --- |
| Registrations used | `addScreen`, `addSidebarHeaderItem`, `addSettingsScreen`, `addCommandCenterItem` — none deprecated. `dist/client/` of `@getpaseo/plugin` is **byte-identical** across that step, so every client registration this plugin makes is untouched by construction. |
| UI imports | Everything comes from `@getpaseo/plugin/client` and `@getpaseo/plugin/client/ui`; the deprecated `client/react-native` entry (removal 2027-04-20) is still unused. The compiled client bundle contains **zero** deprecated items. |
| The plugin's only hook | `server.before("agent.create")` — **not deprecated in 0.14.0**. `PluginLifecycleRegistration` still exposes exactly `on` and `before`, with no `@deprecated` marks. |
| SDK diff `@getpaseo/plugin` (previous release → 0.14.0) | **Additive, server-side only**: `defineAgentTool` + `AgentToolDefinition` / `AgentToolContext` / `AgentToolResult`, and `before("agent.session_open")`'s request gained `title`, `labels`, `tools`, `mcpServers`. Nothing was removed and the client half did not move. |
| `agent.turn_ended` `timeline` (always empty) | Not applicable — no lifecycle hooks of any kind are registered. |
| `SettingsGroup`, panel `context` / `agentId`, `addSurface` / `addSidebarItem` / `openSurface`, `CreateAgentRequestOptions.git` / `worktreeName` | None used; the plugin creates no agents and contributes no panel. |
| Client audit (DOM globals outside `client/web.ts`) | Still clean — §13.3's fix holds; 0.14.0 changes neither the rule nor the files involved. |
| Manifest | Passes the real 0.14.0 `readPluginManifest` (strict `requirements` schema); `requirements.paseo` stays `>=0.11.0`, still the honest floor **at the time of this pass** — §15.4 raises it to `>=0.14.0` once the recommendations are implemented. Enforced by the real host: the same manifest is **rejected for `version: 0.10.0`** (`requires Paseo >=0.11.0`) and accepted for `0.11.0` and `0.14.0`. |
| Install-time build | Unchanged: `[["npm", "ci"], ["npm", "run", "bundle"]]`. The `0.14.0 → 0.12.0` pin in `package.json` was deliberate — no code needed a 0.14.0 API at this point, and the host supplies the runtime SDK; §15.4 changes it to `^0.14.0` when the code starts using `defineAgentTool`. |
| MCP server side | The bundled stdio `dist/mcp-server.js` is a standalone Node bundle that speaks no Paseo SDK API; nothing in 0.14.0 reaches it. |
| New host behaviour that touches injection | **Idle agent runtimes are released after one hour** (`agents.idleRuntimeCleanup`, default on) and the saved session resumes on the next prompt — a *session reopen*. `agent.create` injection is written into the saved config, so it survives; but see §15.2 item 1 for the gap it exposes. |
| `server.addHook` / `agent.open.before` | **Documented but absent.** The deployed hooks page claims `addHook` "is available from Paseo 0.14", yet `grep -r addHook` over `@getpaseo/plugin@0.14.0` **and** over the extracted 0.14.0 host's `@getpaseo/**` returns nothing. The type-safe 0.14.0 spelling stays `server.before("agent.session_open")`. |

### 15.2 Recommendations for improvement (recorded during the pass, implemented in 0.5.2)

Each item below is **new functionality**, so adopting any of them means a
second-digit bump (`0.4.2 → 0.5.2`) and its own test pass. They were written
down here rather than built during the compatibility pass, because that task
asked for a check; all five were then implemented when asked to. The original
wording is kept unchanged so the reasoning stays auditable — what was actually
built, item by item, is in §15.4.

1. **Also contribute the MCP server in `before("agent.session_open")`**
   (`mcpServers` on that request is new in 0.14.0). The hook re-runs on
   `create` / `resume` / `refresh` / `import` and re-derives the map on every
   open, which is the only way to reach agents that **already exist** when the
   user turns `injectIntoAgents` on — today they keep searching without a
   server until they are recreated. It also survives OpenCode's per-directory
   eviction and the new idle-hour runtime release. Constraints to respect,
   all learned by memory-flash 0.9.4 in this same repository: a name that
   collides with a *saved* server, the internal `paseo` server or another
   plugin **fails the session open**, so read the agent's saved `mcpServers`
   from the daemon record and skip on any unreadable state; never contribute
   on `purpose: "history"`; and check the provider supports MCP (0.14.0 fails
   such an open with `does not support MCP servers`).
2. **Expose `web_search` as a native agent tool with `defineAgentTool`** and
   attach it from the same session-open hook. It needs no MCP config at all,
   which makes it the fallback for providers without MCP support and for
   agents the user does not want a spawned process for. Zod-validated input,
   a 10-minute call ceiling, and `{ text, structuredContent, isError }` out —
   the handler would wrap the same `searchWeb()` the RPC already uses. Keep
   the MCP server as well: it is what agents without the tool see.
3. **A "repair search tools" Command Center action on the new
   `agents.ref(id).reload()`** — it reopens the session, reruns the hooks and
   re-registers the server for an already-running agent, instead of asking the
   user to recreate it. Memory-flash ships exactly this in 0.9.4.
4. **Gate injection with `request.labels`** (also new on the session-open
   request): inject only into agents labelled e.g. `web-search: "on"`, or skip
   agents of a provider the user never wants to pay search latency for. Today
   the choice is host-wide, one switch for every agent.
5. **Return `instructions` from the MCP `initialize` response** — one
   paragraph telling agents when to search (before answering questions about
   the outside world, after a failing build with an unfamiliar error, before
   proposing an API that may not exist) and that results must be opened with
   the returned URLs. Clients that surface server instructions show it; those
   that do not are unaffected. This is the same trick memory-flash used in
   0.9.4 for its mandatory-tone protocol.

Explicitly **not** recommended: moving the injection off `agent.create`.
That hook is what persists the server into the agent's saved configuration,
and persistence across restarts is the property the plugin depends on; the
session-open contribution above is additive, not a replacement.

### 15.3 Verification (2026-10-30, this machine)

| Check | Result |
| --- | --- |
| SDK installation | `npm install --no-save --package-lock=false @getpaseo/plugin@0.14.0` — **`package.json` / `package-lock.json` untouched**, the pin stays `0.12.0` on purpose (the host supplies the runtime SDK and no code needed a 0.14.0 API). |
| `npm run typecheck` (`tsc -b tsconfig.json`, three projects) against 0.14.0 | **exit 0** |
| `npm test` (with `pretest` rebuilding `dist/mcp-server.js`) | **9 suites / 95 tests pass**, 1 suite with the 2 `BUNNY_LIVE=1` tests skipped by default |
| Real 0.14.0 host compiler (`compileDirectoryPlugin` + `readPluginManifest` extracted from the installed `app.asar`) | **Both entries compile, no boundary errors, 0 warnings**; a scan of the compiled bundles finds **zero** `addSurface` / `addSidebarItem` / `openSurface` / `SettingsGroup` / `useRevealedText` / `client/react-native` occurrences. Client bundle 37 044 chars, server bundle 3 388 603 chars. |
| 0.14.0 manifest schema + floor | Accepted with `requirements.paseo >=0.11.0`; the same real host code rejects it for a 0.10.0 daemon and accepts 0.11.0 / 0.14.0. |
| Live on an isolated 0.14.0 daemon | **PASS** — a scratch home (`/tmp/paseo-scratch`, `daemonVersion "0.14.0"`, loopback on its own port, production home untouched) with `pluginsEnabled: true` and the plugin installed **from the working tree**: status `running`, `[paseo] Plugin ready`, the six RPC methods registered (`bunny-search.connection-test`, `.search`, `.status`, `settings.bunny-search.*`) and the server-side effect visible — `[bunny-search] settings mirrored: …/plugins/bunny-search/settings.json`. No plugin or client-contribution errors in the daemon log; the only stderr lines are Node's own `DEP0176` / `DEP0129` runtime warnings, not Paseo plugin-API deprecations. |
| Negative control | The same compiler run against a copy of session-manager with the old `client/react-native` import restored finds `client/react-native` in the bundle (1 hit), proving the scan would catch a regression. |
| Post-check cleanup | SDKs restored to the pinned `0.12.0`, `git status` clean apart from the documentation this pass added, typecheck exit 0 on the restored state. |

### 15.4 Implementation of §15.2 (2026-10-30, shipped as 0.5.2)

All five recommendations are implemented. They are new functionality, so this
is a second-digit release: `0.4.2 → 0.5.2`, annotated tag
`bunny-search@0.5.2`. Two consequences follow the code:

* **The SDK pin is now `@getpaseo/plugin@^0.14.0`** (it was `0.12.0`, held back
  while no 0.14.0 API was used): `defineAgentTool` and the `labels` / `tools` /
  `mcpServers` fields of the session-open request exist only there.
* **`requirements.paseo` moved `>=0.11.0` → `>=0.14.0`** for the same reason —
  a floor follows the APIs actually used, not the newest host tested. Verified
  with the real host parser: an older daemon is rejected, 0.14.0 is accepted.

| # | Recommendation (§15.2) | What was built |
| --- | --- | --- |
| 1 | Contribute the MCP server in `before("agent.session_open")` | New `server/session-open.ts` (pure decision) + `server/agent-record.ts` (collision-safe read of the agent's saved `mcpServers` from `$PASEO_HOME/agents/*/<agentId>.json`; every unreadable state fails safe to *skip*), wired in `index.server.ts`. Skips `purpose: "history"`, skips `reason: "create"` while the `agent.create` hook owns creation, and probes `capabilities.supportsMcpServers` only when a contribution is still possible — a gated-off or already-provisioned agent costs no daemon round trip on open. |
| 2 | Native `web_search` agent tool | New `server/agent-tools.ts` → `bunny_web_search` via `defineAgentTool`: zod input (`query`, `max_results`, `categories`, `language` — the MCP tool's own argument names, so the two paths are interchangeable), a 10-minute call ceiling, `{ text, structuredContent, isError }` out, `signal.aborted` honoured, wrapping the same `searchWeb()` the RPC uses. Attached exactly where no MCP server is contributed in the same open, so an agent never sees two names for one search. **Named with a prefix on purpose:** Paseo rejects a plugin tool that collides with one of its own built-ins (`plugin-tools.js`) or with another plugin (`plugins/runtime.js`), and both rejections are load/open-time failures. |
| 3 | "Repair search tools" Command Center action | `bunny-search.agent-reload` RPC → `paseo.agents.ref(id).reload()` in `index.server.ts`, surfaced as a `context: "agent"` command in `index.client.tsx`. A refused reload throws, which the host shows as an error toast, so it is never silent. |
| 4 | Gate injection with `request.labels` | Two new settings, both on Settings → Integration: `labelGateKey` (empty = today's host-wide switch; otherwise the agent must carry that label key with an opt-in value — anything but `off` / `false` / `no` / `0` / empty) and `skipProviders` (comma-separated provider ids, matched case-insensitively). **`agent.create` has no labels** — `PluginBeforeRequests["agent.create"]` carries only `config` and `env` — so with a gate configured the create hook deliberately injects nothing and `agent.session_open` owns creation, where `request.labels` exists. The gate blocks *both* contributions: the attached tool must not become a back door around it. |
| 5 | `instructions` in the MCP `initialize` response | `MCP_INSTRUCTIONS` lives in `server/mcp-tools.ts` rather than `server/mcp-server.ts` (that module runs `main()` on import and cannot be loaded in-process by a test) and is returned from `initialize`. One paragraph: when to search — outside-world questions, an API or flag that may not exist, an unfamiliar error, a failing build — and that results are pointers to be opened and cited, not quoted from the snippet. |

Explicitly **unchanged**: the `agent.create` hook still persists the server
into the agent's saved configuration whenever no gate is configured. That
persistence across restarts is the property the plugin depends on; the
session-open contribution is additive, not a replacement.

**Verification of 0.5.2 (2026-10-30, this machine)**

| Check | Result |
| --- | --- |
| SDK installation | `npm install -D @getpaseo/plugin@0.14.0` → `package.json` / `package-lock.json` now record `^0.14.0`, intentionally (the code needs those APIs). |
| `npm run typecheck` (`tsc -b`, three projects) against 0.14.0 | **exit 0** |
| `npm test` (`pretest` rebuilds `dist/mcp-server.js`, now stamped `0.5.2`) | **10 suites / 133 tests pass**, 1 suite with the 2 `BUNNY_LIVE=1` tests skipped — up from 9 / 95: the new `tests/agent-hooks.test.ts` adds 38 tests over the record reader, the gate, the decision matrix, both hooks, the repair RPC, the tool and the instructions, and `tests/mcp-server-e2e.test.ts` now asserts `instructions` on a real spawned server. |
| Real 0.14.0 host compiler (`compileDirectoryPlugin` + `readPluginManifest` from the installed `app.asar`) | **both entries compile, no boundary errors, 0 warnings, `deprecatedHits: []`**; client bundle 39 555 chars, server 3 360 671 chars. |
| Manifest floor | an older daemon is rejected with the host's own message (`requires Paseo >=0.14.0`), 0.14.0 is accepted. |
| Live daemon | **Not re-run for 0.5.2** — the isolated scratch home of §15.3 was removed after that pass; the new code is covered by the unit/e2e suites and the real host compiler above. |

## 16. Paseo 0.15.0 — compatibility pass (2026-11-03)

Audited against the stable `0.15.0` release (2026-11-03).
Release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.15.0>.
The repository-wide inventory of what 0.15.0 adds and deprecates is in the
root [README](../README.md#paseo-0150--new-and-deprecated-sdk-surface-2026-11-03);
this section records what is specific to bunny-search.

**Result: compatible, but only after a mandatory migration — `server.before`
and `server.on` are `@deprecated` in 0.15.0, so both of this plugin's hooks
moved to `server.addHook`. Shipped as `0.5.3`, `requirements.paseo`
`>=0.14.0` → `>=0.15.0`, SDK pin `^0.14.0` → `^0.15.0`.** One host-side
interaction with the new OpenCode shared-service reuse is recorded in §16.3
with a recommended fix; it is not caused by the migration.

### 16.1 What 0.15.0 changed for this plugin

| Check | Result |
| --- | --- |
| SDK diff `@getpaseo/plugin@0.14.0 → 0.15.0` | **Server-only.** `diff -rq` over the two unpacked npm tarballs reports exactly four changed files: `dist/server/index.d.ts`, `dist/server/lifecycle.d.ts`, `dist/server/lifecycle.js`, `package.json`. **`dist/client/` is byte-identical**, so every client registration in this plugin (screen, sidebar header, settings screen, Command Center item) is untouched by construction, and the `client/ui` imports still resolve. `package.json` also gains the export path `./internal/lifecycle`, which is what the host imports. |
| **Deprecated: `server.before(...)` and `server.on(...)`** | Both carry `/** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */` on `PluginLifecycleRegistration`. They keep working on 0.15.0 — the SDK adapter maps them through `legacyRequests` / `legacyEvents` — so this is a deprecation-driven migration, not a breakage. |
| Replacement: `server.addHook(name, handler)` | Type-safe and name-validated against `pluginHookRegistry` (throws `Unknown lifecycle hook: …` for anything else). Handlers are `(payload, context) => Promise<result>`; for request hooks the payload is still `{ request }` and the return is still the request or `void`, so the bodies did not change. |
| Hook renames used here | `agent.create` → **`agent.create.before`**, `agent.session_open` → **`agent.open.before`**. Payload and result types are the same objects as before (`PluginHookRequests["agent.create.before"]` is the old `PluginBeforeRequests["agent.create"]`). |
| Host support | The installed 0.15.0 `app.asar` contains `import { createLifecycleRegistration, pluginHookRegistry } from "@getpaseo/plugin/internal/lifecycle"` and `const registration = createLifecycleRegistration((name, handler) => this.register(name, handler));`, plus the literal `agent.create.before`. So `addHook` is live on the shipped host, not just in the typings — and the legacy `on` / `before` spellings still resolve through the same adapter. |
| New hooks, not adopted | `worktree.create.before` / `worktree.create.after` (plugin-chosen worktree locations, the awaited `worktree.create.after` before workspace setup) and the `agent.*` / `workspace.*` renames the plugin does not use. None of them has a search-shaped purpose here — see §16.4. |
| 0.15.0 host behaviour that touches injection | Daemon restarts keep terminal programs running, and agent recovery after a host restart is a new **opt-in** setting. Both reopen sessions, which is exactly the `agent.open.before` path the plugin already re-derives on every open — no change needed. Plugin screens keep their local state across host disconnections (#8105) — a benefit, not a requirement. |
| `agent.turn_ended` `timeline` (always empty) | Not applicable — the plugin registers no turn hooks. |

### 16.2 Migration performed (0.5.2 → 0.5.3)

| Before (deprecated on 0.15.0) | After |
| --- | --- |
| `server.before("agent.create", async ({ request }) => …)` | `server.addHook("agent.create.before", async ({ request }) => …)` |
| `server.before("agent.session_open", async ({ request }, { paseo }) => …)` | `server.addHook("agent.open.before", async ({ request }, { paseo }) => …)` |
| comments and diagnostics naming the old hooks (`PluginBeforeRequests["agent.create"]`, "handled by the agent.create hook", …) | renamed to the 0.15.0 spellings (`PluginHookRequests["agent.create.before"]`, "…the agent.create.before hook"), so logs and docs match the host |

The test doubles in `tests/agent-hooks.test.ts` now expose one `addHook`
instead of `before` / `on`, and the registered-name assertions check
`agent.create.before` / `agent.open.before`. No behaviour changed: the same
settings read, the same gates, the same returned request.

`paseo-plugin.json`: `requirements.paseo` `>=0.14.0` → `>=0.15.0`, because
`addHook` does not exist on a 0.14.0 host. `package.json`: `@getpaseo/plugin`
`^0.14.0` → `^0.15.0`, version `0.5.2` → `0.5.3` (deprecated-API replacement,
no new capability → last digit), annotated tag `bunny-search@0.5.3`.

### 16.3 Compatibility finding: injected MCP vs. OpenCode's shared service (0.15.0)

**This is a host-level interaction introduced by 0.15.0 (#7435, "Reuse
running OpenCode v2 services"), not a defect of the migration — but it breaks
this plugin's core feature on the `opencode` provider whenever a local
OpenCode v2 service is registered.** Reproduced on this machine, 2026-11-03,
in the isolated 0.15.0 daemon of §16.5.

Mechanism, read out of the installed `app.asar`:

1. `requiresDedicatedV2Server(config, launch)` returns `true` as soon as
   `Object.keys(config.mcpServers ?? {}).length > 0` — i.e. for **any**
   agent this plugin injects into. Its own comment: *"Custom MCP is
   location-scoped … so [it needs] isolation."*
2. `V2Runtime.acquire()` only starts an isolated server when
   `selectOpenCodeService()` returns `kind: "owned"`. Otherwise it calls
   `assertSharedConfiguration(input, selection)`, which throws exactly the
   observed error:
   `Custom OpenCode MCP servers or process environment require an isolated server and cannot be used with a shared OpenCode service.`
3. `selectOpenCodeService()` returns `owned` only when neither
   `PASEO_OPENCODE_SERVER_URL` nor a discovery file is present. It otherwise
   reads `$XDG_STATE_HOME/opencode/service.json` (default
   `~/.local/state/opencode/service.json`) and, for a local host on a
   compatible `2.x` service, returns `kind: "discovered"` → shared → throw.

Observed on this machine (the file is present, `version 2.2.5`,
`http://127.0.0.1:37999`, written by the user's own `opencode serve --service`;
Paseo's own child is the separate `opencode serve --hostname 127.0.0.1 --port 0`):

| Step | bunny-search | Result |
| --- | --- | --- |
| `paseo run --provider opencode` | enabled (`agent.create.before` logged `MCP injected`) | **fails**: `Failed to create agent: Custom OpenCode MCP servers … require an isolated server …` |
| the same command | disabled | **succeeds** — agent created and running (control) |
| `paseo send` to that agent after re-enabling | enabled (`agent.open.before` logged `injecting 'bunny-search' … MCP injected`) | **fails** with the same error, so *existing* agents are hit too, not just new ones |
| the same `paseo send` after restarting the daemon with `XDG_STATE_HOME` pointed at an empty directory | enabled | **no error** — with discovery gone the host picks `owned` and starts its own server; the plugin logged `attaching bunny_web_search tool only: provider does not support MCP servers` |

Scope and caveats:

- **Only the `opencode` provider.** cline / kilo / qwen / claude / codex do
  not go through `V2Runtime`. **session-manager is unaffected** (it injects
  no MCP and registers no create hook).
- The failure needs a *discovered* local OpenCode service; on a machine
  without `service.json` (and without `PASEO_OPENCODE_SERVER_URL`) the path
  is `owned` and injection works as before.
- The plugin's own capability probe is **not** a reliable guard for this
  condition: `capabilities.supportsMcpServers` came back `true` on the open
  that injected and `false` on the later control run, with no plugin-side
  change between them. The decision matrix (`server/session-open.ts`) is
  correct; the input it is given varies.

**Recommended fix (recorded in the pass; implemented in 0.6.3 — §17):** treat
"shared OpenCode service discovered" as "no MCP for this open", the way the
`supportsMcpServers === false` branch already does, so the decision becomes
`injectMcp: false, attachTool: true` and the agent keeps search through the
native `bunny_web_search` tool instead of failing to open. The host's
discovery file is readable from the plugin (same path, same version rule).

**Immediate user workaround with the settings that already ship:** add
`opencode` to `skipProviders`. Note the gate is deliberately absolute — it
blocks *both* contributions (`injectMcp: false, attachTool: false`), so
opencode agents then get **no search at all** rather than the native tool.
**Unnecessary since 0.6.3:** the plugin detects the shared service itself and
degrades to the native tool (§17).

### 16.4 Recommendations for improvement (recorded, not implemented)

Ordered by value. Items 1–3 are the actionable ones; 4–6 carry over from
§15.2 / §9 unchanged. The list describes the 0.15.0 pass: item 1 has since
shipped in **0.6.3** (§17), items 2–6 are still open.

1. **Skip MCP contribution for `opencode` while a shared OpenCode v2 service
   is discoverable** — **implemented in 0.6.3, see §17.** (read `$XDG_STATE_HOME/opencode/service.json`, default
   `~/.local/state/opencode/service.json`, with the host's `2.x` version
   rule) and fall back to `bunny_web_search` instead. This turns the §16.3
   hard failure into a graceful degradation and keeps search working on
   affected hosts. Small, self-contained in `server/session-open.ts`
   (a new input + a new `mcpBlockReason` branch) plus a settings-free
   existence check — worth a second-digit bump only if it grows a setting.
2. **Deep-link quick search** — pass `?q=` through `PluginScreenProps.params`
   (available since 0.11, still unused) so a Command Center item or slash
   command opens the screen with the query prefilled, and move the connection
   status into an `addSidebarFooterItem` row with a Test button.
3. **Registry readiness** — `name` / `icon` / `media` in `paseo-plugin.json`
   plus an `OVERVIEW.md`, required only for a registry listing (§10.2 item 3).
4. Optional response caching and per-project category presets (§9).
5. More providers behind the same `SearchProvider` adapter — Tavily, SerpAPI
   (§8) — each is one new object in the registry.
6. `registerUsageSource` stays rejected: no in-scope backend exposes a quota
   endpoint that could back `discover` / `fetch` (§10.2 item 4).

**Not applicable in 0.15.0:** `worktree.create.before` / `worktree.create.after`
let a plugin choose worktree locations, but neither has a search-shaped
purpose — the MCP server and the native tool are contributed per agent, not
per worktree.

### 16.5 Verification (2026-11-03, this machine)

| Check | Result |
| --- | --- |
| SDK installation | `npm install` with `@getpaseo/plugin@^0.15.0` → `package.json` / `package-lock.json` record `^0.15.0`. |
| `npm run typecheck` (`tsc -b`, three projects) against 0.15.0 | **exit 0** |
| `npm test` (`pretest` rebuilds `dist/mcp-server.js`) | **10 suites / 133 tests pass**, 1 suite with the 2 `BUNNY_LIVE=1` tests skipped — unchanged from 0.5.2, now covering the `addHook` registration names. |
| Deprecated-call scan | the plugin contains **no** `server.before(` / `server.on(` call any more (`grep` over `index.server.ts`, `server/`, `client/`, `shared/`, `tests/` → only historical prose in earlier §13–§15 records). |
| Live daemon | **PASS** — installed from the working tree into an **isolated 0.15.0 daemon** (scratch home under `.tmp/`, own loopback port 6799, `pluginsEnabled: true`, production home untouched): status `running`, `[paseo] Plugin ready`, settings mirror written, **zero** `Unknown lifecycle hook` errors in the daemon log. |
| Hooks actually fire | **PASS** — `agent.create.before` logged `[bunny-search] MCP injected: … dist/mcp-server.js` on a real agent creation, and `agent.open.before` logged the session-open decision (`injecting 'bunny-search' …`) on a real `paseo send`. |
| Manifest floor | `>=0.15.0` accepted by the real 0.15.0 parser (the plugin loaded and reached `running`). |
| Host-side finding | the OpenCode shared-service failure of §16.3 was reproduced and controlled in the same daemon (plugin on / plugin off / discovery removed). |

## 17. Shared OpenCode service — graceful degradation (0.6.3)

§16.3 recorded a host interaction that breaks this plugin's core feature on the
`opencode` provider and recommended a plugin-side fix. **0.6.3 implements it.**

The host rule (read from the installed `0.15.0` `app.asar`,
`@getpaseo/server` → `agent/providers/opencode/v2/`):

- `requiresDedicatedV2Server(config, launch)` is true as soon as the agent's
  config carries any `mcpServers` — i.e. for every agent this plugin injects
  into;
- `V2Runtime.acquire()` calls `assertSharedConfiguration()` for any selection
  other than `owned`, and that is where the open fails with
  `Custom OpenCode MCP servers or process environment require an isolated server
  and cannot be used with a shared OpenCode service.`;
- `selectOpenCodeService()` returns `explicit` when `PASEO_OPENCODE_SERVER_URL`
  is set, otherwise `discovered` for a compatible `2.x` (at least `2.0.10`)
  `$XDG_STATE_HOME/opencode/service.json` (default
  `~/.local/state/opencode/service.json`, shape `{version,url,pid,password?}`)
  whose URL points at this host.

### 17.1 Implementation

`server/opencode-service.ts` reproduces that rule from local files and returns
`{shared, detail, path}`; `sharedOpenCodeMcpBlock(provider, service)` turns it
into a block reason **only for `opencode`**. The environment is read the way the
host reads it: `agents.providers.opencode.env` from `$PASEO_HOME/config.json` is
overlaid on the daemon's `process.env`, so a `PASEO_OPENCODE_SERVER_URL` or
`XDG_STATE_HOME` set in Paseo's provider settings wins over the shell — the same
values `V2Runtime` would use. `readProviderConfigEnv()` tolerates a missing or
malformed config and ignores non-string values; `XDG_STATE_HOME` keeps the host's
`??` semantics. The hooks call `sharedOpenCodeMcpBlockFor(provider)`, which reads
that map and skips the filesystem entirely for non-`opencode` providers. That
reason is a new `SessionOpenInput.openCodeMcpBlock` field:

- `mcpBlockReason()` returns it first, so `decideSessionOpen` yields
  `injectMcp: false, attachTool: true` — the existing "tool only" branch. This
  is the exact degradation §16.3 asked for: `bunny_web_search` keeps search
  working without any MCP configuration on the agent.
- `needsCapabilityProbe()` returns `false` for the block, so the open costs no
  daemon round trip when no contribution is possible anyway.
- `agent.create.before` returns the request untouched instead of writing the
  saved entry, so creation itself no longer fails; the first open then attaches
  the tool.

### 17.2 Trade-offs and limitations

- **The pid check replaces the host's HTTP probe.** The host probes the
  discovered URL before choosing `discovered`; the plugin checks the recorded
  `pid` with `kill(pid, 0)` from a lifecycle hook instead. A `service.json` left
  behind by a crashed service is correctly ignored; a live pid whose service no
  longer answers still counts as shared. The cost is a degraded open (native
  tool only), never a failed one.
- **Detection is per open, not cached** — one `readFile` per hook call.
- **Agents created earlier keep their saved entries.** A lifecycle hook cannot
  rewrite a saved config, so on a machine that later acquires a shared service
  such an agent cannot open until its entry is gone (recreate it).
- **Scope.** Only `opencode` is affected, and only this plugin's own
  contribution is withheld; another plugin's MCP server still triggers the host
  rule.
- The existing `skipProviders` workaround stays useful for other reasons, but it
  is no longer needed for this failure — and unlike the guard, it also removes
  the native tool (§16.3).

### 17.3 Verification (2026-11-15, this machine)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | **11 suites pass, 1 skipped (live DDGS), 156 tests pass, 2 skipped** — `tests/opencode-service.test.ts` (host version rule, explicit URL, discovery file with live/dead pid, remote host, corrupt file, `XDG_STATE_HOME` resolution, decision branch, probe skipping; plus `agents.providers.opencode.env` parsing and both provider overrides) and five wiring tests in `tests/agent-hooks.test.ts` (create skipped for opencode, other providers unaffected, session open degrades to `bunny_web_search`, both settings overrides honoured) |
| Host rule source | extracted from the installed `0.15.0` `app.asar` (`v2/service-selection.js`, `v2/runtime.js`) |

Version `0.5.3 → 0.6.3` (new capability: the OpenCode guard → second digit),
annotated tag `bunny-search@0.6.3`.
`0.6.4` extends the guard to Paseo's own provider settings: it reads
`agents.providers.opencode.env` from `$PASEO_HOME/config.json` and overlays it on
`process.env` exactly as `V2Runtime` does (patch bump, tag
`bunny-search@0.6.4`).
The same guard ships in memory-flash 0.11.4 (§19 there) and
memory-flash-client 0.5.2 (§18 there), which have the same failure mode.

## 18. Paseo 0.16.0 — compatibility pass (2026-11-16)

Verified against the **stable 0.16.0** release. **No code change was needed and
no deprecated API exists in this plugin.** What moved is the SDK pin
(`^0.15.0` → `^0.16.0`, lockfile refreshed) and the documentation, so the
plugin takes a patch release **0.6.5** (tag `bunny-search@0.6.5`);
`requirements.paseo` stays `>=0.15.0` because no 0.16.0 API is adopted.

### 18.1 The SDK diff, as it reaches this plugin

`@getpaseo/plugin@0.15.4` and `@0.16.0` were unpacked and diffed. The plugin's
surface is untouched:

* **The one breaking change — `agent.turn.after.timeline` removed (#9573)** —
  cannot reach a plugin with no turn hook. This plugin registers
  `agent.create.before` and `agent.open.before` only.
* **Hook payloads gained `metadata` and `background`** (`PluginHookAgent`,
  `PluginHookWorkspace`, `PluginSessionOpenRequest`, and the
  `agent.create.before` payload). Neither hook body reads them; `readSavedMcpServers`,
  the label gate and the provider gate work from `agentId`, `labels` and
  `provider` exactly as before.
* **`agent.open.before` may now return a partial result** — `PluginHookRequestResults`
  is `Omit<PluginSessionOpenRequest, "metadata" | "background"> & { background?; metadata? }`.
  The hook returns `{ ...request, tools, mcpServers }`, which still type-checks
  against that type (verified by `tsc -b`, not assumed).
* **`SettingsDefinition.scope` widened to `"host" | "device"`.** Additive; the
  plugin keeps `scope: "host"`, because its values configure the daemon host that
  spawns the MCP server, not the device showing the screen.
* **Client: additions only** — `useSubscription`, composer controls
  (`Toggle`/`Select`/`Action`/`Combobox`), New-workspace items, reference API,
  sidebar views, workspace row badges, `useProject`/`useTerminals`. **No new
  `@deprecated` mark**, and every symbol this plugin uses (`addScreen`,
  `addSidebarHeaderItem`, `addSettingsScreen`, `addCommandCenterItem`,
  `PluginScreenProps`, `useRpc`, `useSettings`, `useTabState`, `SidebarRow`,
  `SettingsSection`/`SettingsSelect`/`SettingsSwitch`/`SettingsAction`) is
  unchanged.

### 18.2 The OpenCode shared-service guard is still needed

0.6.3/0.6.4 withhold the MCP server on the `opencode` provider when a shared
OpenCode v2 service is discoverable, because Paseo's #7435 refuses any agent
whose config carries custom MCP servers on such a service. That rule is
**unchanged in 0.16.0** — read out of the installed `app.asar`, not assumed:

```js
export function requiresDedicatedV2Server(config, launch) {
    if (Object.keys(config.mcpServers ?? {}).length > 0) return true;
    return Object.keys(launch?.env ?? {}).some((key) => !V2_SESSION_ENV_KEYS.has(key));
}
// service lease, shared/discovered selection:
if (input.env || input.dedicated || processOverrides.length) {
    throw new Error(`Custom OpenCode MCP servers or process environment require an isolated server
        and cannot be used with a shared OpenCode service…`);
}
```

So the detection in `server/opencode-service.ts` (explicit
`PASEO_OPENCODE_SERVER_URL`, then `<XDG_STATE_HOME>/opencode/service.json` with a
compatible 2.x version, a local host and a live pid) still reproduces the host's
own selection rule and must stay.

**One 0.16.0 fix improves the degraded path:** #9426 — *“Fixed OpenCode v2
failing to discover plugin tools available only to its session”*. The fallback
the guard leaves in place is the session-scoped `bunny_web_search` agent tool, so
on 0.16.0 the tool-only mode is more reliable than it was on 0.15.0.

### 18.3 Verification (2026-11-16, this machine)

| Check | Result |
| --- | --- |
| `npm run typecheck` (`tsc -b`: server / client / tests projects) against `@getpaseo/plugin@0.16.0` | **exit 0** |
| `npm test` (`pretest` rebuilds `dist/mcp-server.js` with esbuild) | **11 suites / 156 tests pass**, 1.09 s; `tests/live-ddgs.test.ts` skipped without `BUNNY_LIVE=1` (1 suite / 2 tests) |
| Deprecated API scan | `grep` for `server.on(`, `server.before(`, `addSurface`, `addSidebarItem`, `openSurface`, `client/react-native` over the plugin: **no matches** |
| Live 0.16.0 daemon | isolated scratch home on its own loopback port, `pluginsEnabled: true`, installed from the published Git tag `bunny-search@0.6.5` (so the manifest `npm ci` + `npm run bundle` ran as on a real install): status `running`, `[paseo] Plugin ready`, settings mirror written, four RPC methods plus the three settings methods registered (seven in total), no plugin/contribution errors |
| Host rule | `requiresDedicatedV2Server` + the refusal message read from `/opt/Paseo/resources/app.asar` (0.16.0) |

Not verified: the hooks were not fired on a live agent inside the isolated
daemon (no agent was created there). Their matrix is covered by
`tests/agent-hooks.test.ts` (43 tests) and the registration was proven by the
plugin reaching `running` with no hook errors.

### 18.4 Recommendations for improvement (recorded 2026-11-16)

> Items 1–7 below were implemented in **0.7.5** — see §19 for the design and
> the verification. Item 8 (host-managed processes for the probe) stays a
> long-term prospect: Linux is the priority platform and the current spawn path
> already works there.

1. **Live status through `addSubscription` (new in 0.16.0).** The connected
   indicator and the quick-search box poll on demand (`connectionStatus`). A
   daemon subscription would let the sidebar screen update the dot, latency and
   last-check time without a manual Test, and — more usefully — surface
   “agent X was created without search tools” the moment it happens instead of
   waiting for the user to press *Repair search tools*.
2. **A composer control for search (new in 0.16.0).** `Toggle`/`Action` in the
   composer would give a one-click “search this draft” pill: take the composer
   text (or the selected text) as the query, run `runSearch`, and insert the
   formatted result as a Markdown block. Today the same flow needs a separate
   screen and copy-paste.
3. **Per-agent marker in `metadata` (new in 0.16.0).** `agent.create.before`
   may return `metadata`, and `PluginHookAgent` now exposes it. Writing
   `bunny-search: { mode: "mcp" | "tool", at: <iso> }` would let the repair
   action list the agents that never received tools, and let the session-open
   hook skip the daemon capability probe for agents it already provisioned.
4. **Decide and document the `background` agents policy (new in 0.16.0).**
   Background agents (hidden from tabs and default lists) currently get search
   like any other agent. Either keep that and say so, or gate them with the
   existing `skipProviders`-style logic — a one-line decision, but it should be
   written down rather than emergent.
5. **Deep-link quick search** (still open from §16.4). A Command Center item
   (“Search the web…”) that opens the screen with `PluginScreenProps.params`
   pre-filled, plus `?q=` deep links, would make the search box reachable from
   the Command Center like the other plugins' actions.
6. **Response cache with a TTL.** Repeated identical queries (agents often
   re-search the same error string) hit the upstream engines every time. A
   small in-process LRU with a 5–10 minute TTL, shown as “cached” in the result
   header, would cut rate-limit failures at no correctness cost.
7. **More providers behind the existing adapter.** The adapter already
   normalises title/url/snippet, so Tavily, Exa, Kagi and Perplexity are one
   provider module each — the four most requested APIs a coding agent actually
   benefits from (fresh indexes and answer fields).
8. **Host-managed processes for the probe** (`spawnProcess` / `terminateProcess`
   from `@getpaseo/plugin/server`, still open from §16.4). Its benefit is
   Windows `.cmd` launching and a host-owned process tree; Linux stays the
   priority, so this remains a long-term prospect.

## 19. Plugin 0.7.5 — the 0.16.0 recommendations, implemented (2026-11-16)

Seven of the eight items in §18.4 are implemented in 0.7.5. The eighth —
host-managed probe processes — is deliberately left out and remains a prospect
(§19.8). Nothing in this release changes the Paseo API surface the plugin uses:
every feature below is built on capabilities the 0.15.0/0.16.0 host already
offers (`addSubscription`, `addComposerItem`, hook `metadata`,
`request.background`, `PluginScreenProps.params`).

### 19.1 Live status stream (`bunny-search.status-stream`)

- **Contract** (`shared/contracts.ts`): `statusStream = defineSubscription({ name,
  input: {}, event })`. The event carries the whole snapshot — `kind`
  (`status` | `provisioning`), `at`, `status` (the same shape
  `connectionStatus` returns: provider, base URL, interface URL, `lastCheck`),
  the event that just happened (`provisioning`, null for a status-only push) and
  `recent`, a newest-first ring of the last 20 decisions. A subscriber that
  missed an event is still correct after the next one, because the snapshot is
  self-contained.
- **Server** (`index.server.ts`): `server.handle(statusStream, …)` pushes the
  snapshot on subscribe, then one snapshot per event, and unsubscribes on
  `context.signal` abort. The wake-ups come from `server/provisioning.ts`
  (`recordProvisioning`, `notifyStatusChange`, `clearProvisioningLog`), which is
  called by the session-open hook, the connection test and the settings
  subscription (a settings edit also calls `resetSearchCache()`).
- **Client**: the sidebar screen uses `useSubscription(statusStream, {}, …)`, so
  the dot, latency and the provider label update without pressing *Test*.
  Hosts older than 0.16.0 have no `useSubscription`; the screen still loads its
  status once through `connectionStatus`, which is why the initial RPC stayed.

### 19.2 Composer control: “search the draft”

`client/composer-item.tsx` registers a host `Action` through
`client.addComposerItem`. It reads `useComposer().prompt`, caps the query at 512
characters, runs the existing `runSearch` RPC and inserts the formatted answer at
the cursor with `composer.insertText`. The promise returned from `onPress` is what
the host renders as pending; a rejection (provider error, empty answer) becomes a
host error toast. Nothing is sent until the user presses the control, and the
inserted text is editable text, not an attachment.

### 19.3 Per-agent provisioning marker in `metadata`

- `server/provisioning.ts` owns one metadata key, `bunny-search`:
  `{ mode: "mcp" | "tool" | "skipped", reason, at }`.
- `agent.create.before` writes it on every branch it decides (injected, provider
  excluded, shared-OpenCode block, background excluded) and leaves it untouched
  while it defers to the label gate.
- `agent.open.before` appends the same decision to the event log the status
  stream reads (`reason` is the decision text the log already prints, so the
  marker explains itself) and, since 0.7.6, writes the marker with
  `paseo.agents.ref(id).setMetadata(…)` instead of returning it in the hook
  result — the 0.16.0 host rejects a change to anything but `env`, `tools` and
  `mcpServers` there and fails the open (§20). The write is fire-and-forget and
  only happens when the mode changes, never for `purpose: "history"`.
- The read-back is used for one thing only: when the marker says `mcp`, the
  session-open hook skips the daemon capability probe and treats the provider as
  MCP-capable for this agent — the answer cannot have changed for an agent the
  plugin already provisioned. A `tool` or `skipped` marker never suppresses the
  probe, so an agent cannot be degraded forever by a stale decision.
- Unknown or malformed values resolve to “no claim” (`null`), never to a guess.

### 19.4 Background agents: policy

The decision, recorded here and in the settings screen: **background agents get
search like any other agent by default**. They are agents the user started for a
task (a review helper, a summariser); withholding search makes them worse at the
job they exist for.

The policy is nonetheless switchable: `skipBackgroundAgents` (off by default)
excludes them at `agent.open.before`, where `request.background` exists, and the
log line gains a `/background` tag. The creation hook has no `background` field
in `PluginHookRequests["agent.create.before"]`, so it honours
`config.background` when a caller passes one and otherwise leaves the decision
to the session open — documented in `shared/settings.ts` rather than implied by
code.

### 19.5 Deep-linked quick search

- `PluginScreenProps.params.q` pre-fills the quick-search box (a `useEffect` on
  the param, so re-opening the screen with a different `q` refills it).
- A new Command Center item, *Search the web for this agent's task* (agent
  context), opens the screen with `params: { q: agent.title }`.
- The deep link never runs the search by itself: the user still presses the
  button, so no network request is spent by opening a menu item.

### 19.6 Response cache

`server/search-cache.ts` is a process-local LRU (64 entries) with a TTL taken
from `cacheTtlSeconds` (default 300 s, 0 disables, 0–3600 accepted).

- **Where**: inside `searchWeb`, so the MCP `web_search` tool, the attached
  `bunny_web_search` tool and the UI quick search share it. Connection tests call
  the adapters directly and are never answered from the cache.
- **Key**: service, engine pin, SearXNG/custom URLs, normalised query (trimmed,
  lower-cased, whitespace collapsed), result count, categories, language. The API
  key is deliberately absent — a rotated key does not change the answer.
- **Empty answers are never stored**: an empty result is what a rate limit looks
  like, and caching it would starve an agent for the whole TTL.
- **Visible**: the formatted text says `Query: … (cached)`, so an agent can tell
  a reused answer from a fresh one and rephrase if it needs newer data.
- **Invalidation**: every settings change clears the cache; the MCP server
  process keeps its own cache, which dies with the agent session.

### 19.7 Four more providers

One adapter each in `server/providers.ts`, behind the same interface:

| Service | Endpoint | Auth | Mapping |
| --- | --- | --- | --- |
| Tavily | `POST https://api.tavily.com/search` | `Authorization: Bearer` | `results[].title/url/content` |
| Exa | `POST https://api.exa.ai/search` | `x-api-key` | `results[].title/url/text` (page text, truncated by the formatter) |
| Kagi | `GET https://kagi.com/api/v0/search` | `Authorization: Bot <token>` | `data[]` with `t: 0` only (skips related searches) |
| Perplexity | `POST https://api.perplexity.ai/chat/completions` | `Authorization: Bearer` | `choices[0].message.content` → `answers`, `search_results`/`citations` → results |

All four share one API-key field, because only one service is active at a time;
the settings screen explains how the key is sent for the selected service. A
missing key fails before any request with the same actionable message the Brave
adapter uses, and 401/403 is reported as “rejected the API key”. The SDK-free
`providerBaseUrl` and `searchInterfaceUrl` cover the new ids, so the *Open*
button and the status screen keep working.

### 19.8 Deliberately not implemented: host-managed probe processes

`spawnProcess` / `terminateProcess` from `@getpaseo/plugin/server` would give the
MCP handshake probe a host-owned process tree and Windows `.cmd` launching. Linux
is the priority platform, the current `spawn` path is verified there, and the
probe is a diagnostic rather than a runtime dependency — so this stays a prospect
(also noted in §16.4 and §18.4).

### 19.9 Settings, contracts and files touched

- `shared/settings.ts`: `searchService` gains `tavily | exa | kagi | perplexity`;
  new `skipBackgroundAgents` (bool, default false) and `cacheTtlSeconds`
  (default 300, 0–3600). No migration is needed: both fields have defaults, so a
  stored document without them parses.
- `shared/contracts.ts`: `RuntimeSettings.cacheTtlSeconds`, `SearchResponse.cached`,
  `API_KEY_SERVICES`, labels for the new services, `provisioningEventSchema` and
  `statusStream`.
- `server/settings-file.ts`: the same four ids, `cacheTtlSeconds` from the file
  and from `BUNNY_SEARCH_CACHE_TTL_SECONDS` — the MCP process must see what the
  host shows.
- `server/session-open.ts`: `background`, `skipBackgroundAgents` and `knownMode`
  in the decision input; the background gate; the probe skipped on a `mcp`
  marker.
- New files: `server/search-cache.ts`, `server/provisioning.ts`,
  `client/composer-item.tsx`, `tests/provisioning.test.ts`.

### 19.10 Verification (2026-11-16, this machine)

| Check | Result |
| --- | --- |
| `npm run typecheck` (`tsc -b`, three projects) | exit 0 |
| `npm test` (hermetic vitest) | 12 passed / 1 skipped suites, 179 passed / 2 skipped tests |
| New provider tests | mapping, headers, missing key, rejected key (401), base URLs |
| New cache tests | reuse + `(cached)` marker, key separation, TTL 0, empty answer not stored |
| New provisioning tests | marker round-trip, foreign shapes, LRU ring, listeners |
| New hook tests | background gate on/off, marker written on open, probe skipped when the marker says `mcp` |
| Live daemon | not repeated for this patch: the hooks, RPCs and subscription use the same registration path verified for 0.6.5 against a real 0.16.0 daemon; the subscription handler and composer item are exercised by the host at runtime, so a live `addSubscription`/`addComposerItem` round trip is the one thing this build does not prove on its own |

## 20. Plugin 0.7.6 — the session-open hook may not return `metadata` (2026-11-16)

**Symptom.** Every prompt to an agent failed with `Plugin bunny-search
agent.open.before failed: agent.open.before hooks can only change env, tools, and
mcpServers`; the prompt never reached the provider. It hit existing agents too
(any session reopen — resume, reload, prompt after a plugin reload), for every
provider.

**Cause.** 0.7.5 made the session-open hook return `{ ...request, tools,
  mcpServers, metadata }`, carrying the `bunny-search` provisioning marker in
`metadata`. The SDK types accept an optional `metadata` there
(`PluginHookRequestResults["agent.open.before"]` is
`Omit<PluginSessionOpenRequest, "metadata" | "background"> & { background?;
  metadata? }`), but the 0.16.0 daemon enforces the documented contract —
`agent.open.before` may change only `env`, `tools` and `mcpServers`, every other
field is read-only — and rejects a result whose `metadata` differs from the
request's. A rejected hook fails the open, and an open is what a prompt needs, so
the rejection surfaced as a failed prompt. The `agent.create.before` marker was
never affected: that hook may change `metadata`.

**Fix.** The session-open hook returns `request` (unchanged) or `{ ...request,
  tools, mcpServers }`; the marker is written through the SDK instead —
`paseo.agents.ref(request.agentId).setMetadata({ "bunny-search": marker })`, not
awaited, with a logged rejection (the hooks reference is explicit that awaiting a
write to the agent being opened deadlocks the open). The write is skipped when the
stored mode already matches the new one and for `purpose: "history"`, so an
idle-runtime resume does not republish the same marker. Read-back is unchanged: a
stored `mcp` marker still suppresses the capability probe.

**Verification.** `npm run typecheck` (three-project `tsc -b`) exit 0; `npm test`
— 13 passed / 1 skipped suites, 183 passed / 2 skipped tests, including the
updated hook tests (the marker reaches `setMetadata`, never the returned request)
and the new `tests/mcp-stable.test.ts`. The failing path itself is host-side: no
live daemon run is claimed for this patch.

### 20.1 Stable MCP entry and repair of older saved configs

The same release closes a second failure that showed up right after the first:

```text
OpenCode MCP server bunny-search failed to connect: … MCP server process exited
with code 1 … Cannot find module
'…/plugins/bunny-search/4b1a20f3-…/checkout/bunny-search/dist/mcp-server.js'
```

`agent.create.before` writes an absolute path into the agent's *saved* config, and
Paseo installs a plugin under
`$PASEO_HOME/plugins/<id>/<install-uuid>/checkout/<id>/`, so a reinstall or an
update moves the bundle while every already-created agent keeps launching the old
checkout path. The session-open hook cannot replace that entry — the name collides
with the saved configuration and the host fails the open — so `server/mcp-stable.ts`
makes the entry survive instead:

1. **One stable copy.** On every plugin start the bundle is copied to
   `$PASEO_HOME/plugins/bunny-search/mcp-server.js` (the directory that already
   holds the settings mirror and survives reinstalls), and `resolveMcpEntry()`
   injects and probes *that* path. `resolveBundledEntry()` remains the source of
   the copy and the fallback when the copy fails; a copy is only preferred when
   this run actually made it, so a stale copy from an older version is never used.
2. **Healing agents created by an older version.** Their saved entry still names
   a file inside the old checkout, so the same start restores the missing file at
   exactly that path. Only paths under `$PASEO_HOME/plugins/bunny-search/` are
   written, only the `bunny-search` entry is inspected, and an existing file is
   left untouched; anything else is logged and skipped.

Both steps are best-effort: a failure leaves the previous behaviour in place and is
visible in `paseo plugin logs bunny-search`.

The composer pill, the subscription push and the metadata marker are all
host-visible behaviour: `paseo plugin logs bunny-search` shows the
`session_open … [mode]` lines and the status stream's push failures, which is the
first place to look if a host build renders the control but never answers.

## 21. Paseo 0.17.1 — compatibility pass (2026-11-22)

Verified against the **stable 0.17.1** release
(<https://github.com/getpaseo/paseo/releases/tag/v0.17.1>, published 2026-11-21).
**No code change was needed and no deprecated API exists in this plugin.** What
moved is the SDK pin (`^0.16.0` → `^0.17.1`, lockfile refreshed), the test
counts in the docs and this section, so the plugin takes a patch release
**0.7.7** (tag `bunny-search@0.7.7`). `requirements.paseo` stays `>=0.15.0`:
no API adopted here is newer than 0.15.0, and a floor records the API promise,
not the newest host tested.

### 21.1 What 0.17.0 / 0.17.1 changed, as far as a plugin can see

0.17.0 has no published release body; 0.17.1's notes list the plugin-facing
changes. Both were read from the release pages and confirmed against the SDK
declarations (`§21.2`), not inferred from the changelog wording:

| Release item | Shape in the SDK | Relevance here |
| --- | --- | --- |
| *Plugin control of worktree creation, removal, and restoration* (#10278) | new `registerWorktreeManager` on `PluginServerContext` + `dist/server/worktree.*` types | **not used** — this plugin never creates worktrees |
| *Plugin agent instructions* (#9781) | `appendSystemPrompt?: string[]` on the `agent.open.before` **request** (“Instructions appended for this open; not saved on the agent”) | **not used today**; the only genuinely useful new capability for this plugin — see §21.5 item 1 |
| *A `focusHost` navigation option* (#5574) | `navigation.supportsFocusHost` + `focusHost?` on `openAgent`/`openWorkspace` | **not used today**; §21.5 item 2 |
| *Update providers in Paseo* (#9568, #9661), *quota forecasts* (#10289, #10385) | `ProviderRegistration.installation` (`installUrl`, `updateUrl`, `inspect`, `checkForUpdates`, `update`), `UsageWindow.durationSeconds`, `UsageReport.observedAt`, `UsageScope.launch` | **not applicable** — the plugin registers no provider (its search providers are internal adapters) and no usage source (decision recorded in §10.2 item 4) |
| Skills in `/` suggestions (#10383) | `ProviderSlashCommand.kind?: "command" \| "skill"` | not used — no provider registration |
| *Fixed plugin screens and settings failing to use plugin state hooks* (#10049), *Fixed plugin agents failing to reopen after their provider closes the session* (#10153) | host fixes, no declaration change | improves this plugin without changes: its screen and settings screen register through `addScreen`/`addSettingsScreen` and use the host hooks `useSettings`/`useRpc`/`useSubscription`/`useComposer` |

0.17.1 itself is otherwise provider work (Antigravity approvals/history, goose
models, PR watching, heartbeats) with no plugin-API change.

### 21.2 The SDK diff `0.16.0 → 0.17.1`

Both packages were unpacked (`npm pack @getpaseo/plugin@0.17.1`) and the
`dist/**/*.d.ts` trees diffed. **Nothing was removed and no declaration the
plugin uses changed shape** — the diff is additive only:

| Declaration file | Change | Used here |
| --- | --- | --- |
| `server/index.d.ts` | re-exports the new worktree types | no (additive) |
| `server/contracts.d.ts` | `registerWorktreeManager(manager): () => void` on `PluginServerContext` | no (additive) |
| `server/lifecycle.d.ts` | `PluginSessionOpenRequest.appendSystemPrompt?: string[]`; `baseRef` branch gained `startPoint?` | no (additive; `appendSystemPrompt` is a candidate, §21.5) |
| `server/provider.d.ts` | `installation?: ProviderInstallation` and its context/inspection/update types; `ProviderSlashCommand.kind` | no (no provider registration) |
| `server/usage.d.ts` | `durationSeconds`, `observedAt`, `UsageScope.launch`, `UsageSourceRegistration.provider` | no (no usage source) |
| `server/acp.d.ts` | new optional ACP harness options (`loadReplayQuietPeriodMs`, `deferTurnOnRunningTools`, `autoAcceptMode`) plus widened provider type imports | no — ACP harness internals; this plugin registers no provider |
| `server/worktree.d.ts` | new file | no |
| `client/contracts.d.ts` | `navigation.supportsFocusHost`, `focusHost?` on `openAgent`/`openWorkspace` | no (additive; candidate, §21.5) |
| everything else (`index`, `contracts`, `settings`, `server/agent-tools`, `client/ui`, `client/host`, `client/composer`, refs, rpc, icons, text, attachments) | **identical** | — |

So `addHook`, `registerSettings`, `handle`, `addScreen`, `addSidebarHeaderItem`,
`addSettingsScreen`, `addCommandCenterItem`, `addComposerItem`,
`defineSubscription`/`useSubscription`, `usePaseo`/`useRpc`/`useSettings`/
`useComposer`, `paseo.agents.ref().refresh()/reload()/setMetadata()`,
`SidebarRow`, `SettingsCard`/`SettingsSection`/`SettingsSelect`/`SettingsSwitch`/
`SettingsInput`/`SettingsAction` and `Action` all keep the signatures this plugin
compiles against.

### 21.3 Deprecated APIs on 0.17.1 — none are used

`grep -rn "@deprecated"` over the 0.17.1 `dist/**/*.d.ts` yields exactly the
same set as 0.16.0 (no new marks, no removal versions added). Each one, and the
verdict for this plugin:

| Deprecated member | Where | Used here? |
| --- | --- | --- |
| `addSurface`, `addSidebarItem`, `openSurface` | `client/contracts.d.ts` | **no** — the plugin uses `addScreen`, `addSidebarHeaderItem`, `openScreen` (§13.2) |
| `PluginSidebarContribution` | `client/contracts.d.ts` | **no** — uses `PluginSidebarItemContribution` via `addSidebarHeaderItem` |
| `SettingsGroup` (**use `SettingsSection`**) | `client/ui.d.ts` | **no** — every heading is `SettingsSection` |
| `context: "workspace"` / `context: "agent"` + `agentId` on panel props, `addWorkspacePanel` with `context: "agent"` | `client/contracts.d.ts` | **no** — the plugin registers no panel |
| the `@getpaseo/plugin/client/react-native` entry and its `useRevealedText` (removal after 2027-04-20) | `client/react-native.d.ts` | **no** — every UI symbol comes from `@getpaseo/plugin/client/ui` (`SidebarRow`, `Settings*`, `Action`) |
| `server.on(...)`, `server.before(...)` (renamed to `addHook`) | `server/lifecycle.d.ts` (removal after 2027-04-30) | **no** — migrated in 0.5.3; only comments mention the old names |
| `providerOptions`/`settings`/`controls`/`toolCallMode` provider-report fields | `server/provider.d.ts` | **no** — no provider registration |

The audit command used:

```bash
grep -rnE "addSurface|addSidebarItem|openSurface|SettingsGroup|addWorkspacePanel|server\.before|server\.on\(|client/react-native" \
  index.server.ts index.client.tsx server client shared tests
```

Two matches are prose only (`index.server.ts:71` and `tests/agent-hooks.test.ts:32`
explain the 0.15.0 rename) — nothing executable. `PluginSurfaceProps` is *not*
deprecated: it stays the prop type of settings-screen components, so
`client/settings-screen.tsx` and `client/open-search-ui.ts` keep it (§13.1).

### 21.4 Verification (2026-11-22, this machine)

| Check | Result |
| --- | --- |
| Installed Paseo CLI | `paseo --version` → **0.17.1** |
| SDK diff `@getpaseo/plugin@0.16.0 → 0.17.1` | additive only, table in §21.2; no removed or reshaped declaration |
| Deprecated scan | table in §21.3, **no live deprecation** |
| `npm install --save-dev @getpaseo/plugin@^0.17.1` | exit 0, `node_modules` at 0.17.1, `package.json` pin `^0.17.1` |
| `npm run typecheck` (`tsc -b`, three projects) against SDK 0.17.1 | **exit 0** |
| `npm test` (`pretest` rebuilds `dist/mcp-server.js`) | **13 suites / 183 tests pass**, 1 suite / 2 tests skipped (`tests/live-ddgs.test.ts`, needs `BUNNY_LIVE=1`) |
| Live daemon | **not run**: no daemon is up on this machine (`paseo plugin logs bunny-search` → “Daemon is not running for /home/sirafim/.paseo”), and the pass had no reason to start one. Nothing in the 0.17.1 diff touches the hooks or the RPC transport, so the 0.16.0 live evidence (§18.3) and the hook/tool suites carry the runtime behaviour |

### 21.5 Recommendations for improvement (recorded 2026-11-22, not implemented)

Ordered by value/effort. Items 1–2 use 0.17.x capabilities; 3–6 are older
prospects that this pass re-scoped. None of them changes the plugin's floor
above `>=0.15.0` unless noted.

1. **Agent instructions via `appendSystemPrompt` (0.17.x, #9781) — small, high value.**
   `agent.open.before` may now append instructions for that open without saving
   them on the agent. One setting (`Agent instructions`, on by default) could add
   something like *“When a question depends on current library versions, APIs or
   error messages, call `web_search` (or `bunny_web_search`) instead of relying on
   memory.”* Today every agent has to discover the tool by itself, which is the
   main reason a working MCP server still goes unused. Same hook, same return
   object, one new field; the degraded (`tool`-only) mode keeps working because
   the instruction can name whichever surface it actually contributed.
2. **`focusHost` deep links from *Recent agents* (0.17.x, #5574) — small.**
   The provisioning list currently shows `agentId · provider · mode`. Making a row
   pressable (`navigation.openAgent({ agentId, serverId, focusHost: true })`, gated
   on `navigation.supportsFocusHost`) turns “agent X got no tools” into a jump to
   that agent, which is what the row is for.
3. **`/bunny-search` slash command (0.13 surface, still open) — small.**
   `addSlashCommand` with the query as the argument would complement the composer
   control for users who never open the screen: run the search, insert the
   formatted text into the composer.
4. **Sidebar footer status row (0.11 surface, open since §10.2 item 2) — medium.**
   `addSidebarFooterItem` with a `SidebarRow` and a `trailing` dot would put the
   green/red indicator beside the sidebar instead of behind one click, reusing the
   existing `statusStream` snapshot.
5. **Per-agent results panel (0.16 `addAgentPanel`) — medium.**
   A small panel holding the last N searches of the current agent would keep the
   global screen for configuration and make the result history per agent. Useful
   only if the user wants results visible after the composer insertion.
6. **Host-managed probe processes (`spawnProcess`/`terminateProcess`) — unchanged prospect.**
   Still only about Windows `.cmd` launching; Linux is the priority platform and
   the current `node:child_process` path works there (§10.2 item 1, §18.4 item 8).

## 22. Plugin 0.8.7 — the 0.17.x improvements, implemented (2026-11-22)

Items 1–5 of §21.5 are shipped. This is new functionality, so the version moves on
the second digit with the third preserved (0.7.7 → 0.8.7) and the requirement floor
moves with the API actually used (`>=0.15.0` → `>=0.17.0`, §22.3).

### 22.1 What was built

| # | Capability | Where | Behaviour |
| --- | --- | --- | --- |
| 1 | Agent instructions (`appendSystemPrompt`) | `shared/agent-instructions.ts`, `server/session-open.ts` (`instructionToolName`), `index.server.ts`, settings `agentInstructions` | Every session open that leaves the agent with search also appends one instruction for that open. `{tool}` is substituted with `web_search` (MCP) or `bunny_web_search` (attached tool), so the text never names a tool the agent does not have. Gated-off agents, `history` opens and an empty setting add nothing |
| 2 | `focusHost` links | `client/surface.tsx` (*Recent agents* rows) | A row opens the agent it names with `navigation.openAgent({ agentId, focusHost: true })`, gated on `navigation.openAgent` and `navigation.supportsFocusHost`; the row is inert when the client cannot navigate |
| 3 | `/bunny-search <query>` | `index.client.tsx` (`addSlashCommand`, agent context) | Runs `bunny-search.search`, then inserts the formatted block into the agent's own composer (`composers({ agentId })`). An empty argument or a provider error throws, so the host shows it instead of inserting nothing |
| 4 | Sidebar status dot | `client/sidebar-item.tsx` | The existing sidebar row now carries the green/red/muted dot in `SidebarRow.trailing`, fed by `statusStream` plus one `connectionStatus` read on mount. Deliberately *not* a second footer row: two identical rows would compete for the same press |
| 5 | Agent panel | `client/agent-panel.tsx` (`addAgentPanel`) | Search scoped to `params.agentId`; explicit *Insert into the prompt* writes into that agent's composer. Nothing is sent automatically and results stay in the panel until inserted |

Item 6 (`spawnProcess`/`terminateProcess` for the probe) stays a prospect: its only
benefit is Windows `.cmd` launching, and Linux is the priority platform.

### 22.2 The `appendSystemPrompt` contract, read out of the 0.17.1 host

The SDK types say the field exists; the daemon decides whether a hook may change it.
Both were checked against the installed 0.17.1 app bundle (`/opt/Paseo/resources/app.asar`),
not guessed:

```js
// validateBeforeResult, "agent.open.before"
if (changesSessionOpenTarget(previous, next)) {
    throw new Error("agent.open.before hooks can only change env, tools, mcpServers, and appendSystemPrompt");
}
return {
    ...result,
    background: previous.background,
    metadata: previous.metadata,
    ...(next.appendSystemPrompt === undefined && previous.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: previous.appendSystemPrompt }
        : {}),
};
```

Two consequences drove the implementation:

1. **It is allowed** — `appendSystemPrompt` is explicitly in the allowed set, unlike
   `metadata` (§20). This is the one hook result field this plugin adds in 0.8.7.
2. **An omitted field means "unchanged"** — so the hook appends to
   `request.appendSystemPrompt` instead of replacing it, and an instruction written by
   another plugin or by the agent's own configuration survives. `changesSessionOpenTarget`
   does not compare the field at all, so changing it never fails the open.

AGENTS.md-style caveat from §20 still applies to `metadata`: the marker keeps going
through `paseo.agents.ref(id).setMetadata(...)`, never through the hook result.

### 22.3 Why the floor is now `>=0.17.0`

`appendSystemPrompt` and `navigation.supportsFocusHost` do not exist in the 0.16.x
SDK (checked on the packed `0.16.0` and `0.16.2` declarations), and a 0.16.x daemon
rejects an `agent.open.before` result whose extra field it does not know — the exact
failure mode that made 0.7.6 a patch release. Since the instruction is on by default,
such a host would fail **every** session open, so the plugin must not load on 0.16.x:
`requirements.paseo` is `>=0.17.0`. The client registrations added here are older
(`addSlashCommand` and `addAgentPanel` exist in 0.15.0), so the floor is set by the
server-side field, not by the UI.

### 22.4 Verification (2026-11-22, this machine)

| Check | Result |
| --- | --- |
| `npm run typecheck` (`tsc -b`, server / client / tests) against SDK 0.17.1 | **exit 0** |
| `npm test` | **14 suites / 199 tests pass**, 1 suite / 2 tests skipped (`BUNNY_LIVE=1` needed) |
| New `tests/agent-instructions.test.ts` | renderer (placeholder substitution, empty template, trimming) and the `instructionToolName` matrix (contributed MCP, attached tool, recorded marker, saved server, gated-off, history, nothing at all) |
| Extended `tests/agent-hooks.test.ts` | the hook appends exactly one instruction naming the contributed tool; appends to instructions the host already carries; names `bunny_web_search` in tool-only mode; still instructs a create-owned open whose server is already saved; adds nothing for an empty setting, a gated-off agent or a `history` open |
| Host contract | allowed-field set, merge semantics and the 0.17.0 availability read from the 0.17.1 `app.asar` / packed declarations (§22.2, §22.3) |
| Live daemon | **not run** — no daemon is up on this machine, so nothing here proves the instruction reaches a real agent turn or that the panel, slash command and dot render in a real 0.17.1 client. The hook path is covered by tests with the host's own result shape; the UI paths are unverified visually |

## 23. Plugin 0.9.7 — DDGS engine fallback (2026-11-24)

New functionality, so the version moves on the second digit with the third
preserved (0.8.7 → 0.9.7). No settings, argument list, version floor or output
shape changed.

**Cause.** `ddgs` 9.16.1 runs engines in batches of
`ceil(max_results / 10) + 1` workers and waits with
`wait(..., FIRST_EXCEPTION)`, so one engine that answers with no results (the
signature of anonymous rate-limiting) aborts the whole search even when another
engine would have returned results. The adapter called `DDGS().text(query)`
without a backend, i.e. exactly that flaky `auto` path.

**Change.** The inline script (`SEARCH_SCRIPT` in `server/ddgs-python.ts`) now
tries `auto` first and, when it yields nothing, walks
`ddgs.engines.ENGINES["text"]` one engine at a time in priority order (highest
priority first, then name) and takes the first non-empty answer inside a 90 %
budget of the configured timeout. The walk runs up to twice, because a single
engine can also answer `No results found.` transiently (observed with `yahoo`:
1 failure in 3 runs for the same query). If nothing works, stderr lists the per-engine
errors and the plugin reports them as
`DDGS Python search failed: no engine returned results (…)`.

**Why it was needed.** On 2026-11-24 the DuckDuckJS engines were all refusing
anonymous scraping from this machine; `ddgs` showed the same pattern — `brave`,
`duckduckgo`, `grokipedia`, `mojeek`, `startpage` and `wikipedia` answered in
under 0.5 s with no results while `yahoo` returned real results, and `auto`
succeeded in only two of three runs because of the batched shuffle. The library
is installed in `~/venv` and is discovered through the `~/venv` fallback tier,
because the `PATH` `python3` has no `ddgs`. Even the working engine is
intermittent, which is why the walk repeats once before failing.

**Verified.** `npm run typecheck` exit 0; `tests/ddgs-provider.test.ts` and
`tests/providers.test.ts` — 59 tests pass; live
`BUNNY_LIVE=1 npx vitest run tests/live-ddgs.test.ts` against `ddgs` 9.16.1:
5 real results for `typescript` and `check { ok: true, latencyMs: 1045 }` at
11:53, i.e. the fallback does reach a working engine when one is available.

**Limit of the fix.** The fallback only helps while *some* free engine answers.
Later on the same day `yahoo` started returning `No results found.` for every
query as well (five consecutive runs from a fresh `DDGS` instance), so all engines
used by both providers are refusing anonymous requests from this machine. In that
state the plugin correctly reports `no engine returned results (…)` with the
per-engine errors; restoring search needs a different egress IP (`Proxy URL`),
a reachable SearXNG instance, or one of the keyed providers (Tavily, Exa, Kagi,
Perplexity, Brave). **Not verified:** behaviour on a host where the engines are
not blocked, and the two-pass walk against a permanently blocked engine set
beyond the unit-level error mapping.

## 24. Plugin 0.9.8 — provider verification snapshot (2026-11-24)

Documentation-only patch (0.9.7 → 0.9.8, third digit +1): no code, settings,
argument list, output shape or version floor changed, so §23 remains the
description of the adapter's behaviour. This section records what was actually
exercised against real services so a later reader knows which provider paths
have live evidence and which do not.

**Method.** Provider checks were run through the plugin's own provider code
(`Test connection` in Settings → Plugins → Bunny Search and real searches from
the quick-search box), not through mocks, on the same host that ran the
`tests/providers.test.ts` suite. The suites mock the libraries and therefore
prove normalisation and error mapping only; they cannot detect an upstream that
refuses anonymous requests.

**Results.**

| Provider | Live result | Note |
| -------- | ----------- | ---- |
| DuckDuckGo (HTML endpoint) | works | real results, redirect links unwrapped |
| Tavily | works | keyed API, authenticated search returns results |
| DDGS Python | works, intermittent availability check | real results via the §23 fallback; a search can still report the library as missing |
| DuckDuckJS | no results | every bundled engine blocked from this IP (§23, *Known issues* in `__status.md`) |
| SearXNG | not reachable | configured `http://omnirouter/search` times out |

**The intermittent "library not found" report.** `checkDdgsAvailability()` runs
discovery, which walks the candidate interpreters (§4) and probes each one with
`import ddgs` under a 15 s timeout; only a successful candidate is cached for
the process lifetime, and a cached interpreter that later fails to import is
dropped and rediscovered once. When the walk itself misses — a `PATH` `python3`
ahead of the venv answering slowly or the venv probe losing its budget on a busy
host — the call surfaces the discovery failure ("Python with the 'ddgs' library
was not found … Searched: …") even though an earlier search succeeded. Repeating
the search normally recovers, and pinning the `Python path` setting to the
interpreter that has the library (here `~/venv/bin/python`) avoids the symptom
entirely. 0.9.8 documents this; it does not change the discovery logic.

**Not verified.** The three keyed providers that were not exercised this round
(Exa, Kagi, Perplexity), the multi-engine providers on an unblocked egress IP,
and SearXNG against a reachable instance. Those paths are covered by unit tests
only.
