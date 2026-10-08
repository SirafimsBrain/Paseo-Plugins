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
│   └── host-fonts.ts          # host Appearance settings parsing (client-safe)
├── server/
│   ├── providers.ts           # provider adapters (duckduckjs / searxng / duckduckgo /
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
│   ├── settings-screen.tsx    # Settings → Plugins screen: Test connection + Open interface
│   ├── open-search-ui.ts      # opens the interface in Paseo's browser tab (external fallback)
│   └── use-host-typography.ts # host font scale/family hook
├── scripts/
│   └── bundle-mcp-server.mjs  # esbuild → dist/mcp-server.js (standalone stdio server)
└── tests/                     # vitest: 7 suites, 76 tests (incl. real-process stdio e2e)
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
| `searxng` | `{searxngBaseUrl}?q=…&format=json&categories=…&language=…` | none | Ported from the reference MCP: same UA (`bunny-search-mcp/1.0 (+searxng)`), clamped `max_results` 1–30, instant `answers`, `suggestion`/`suggestions`/`corrections`, per-result `engines` |
| `duckduckgo` | `https://html.duckduckgo.com/html/?q=…` | none | Browser UA (HTML endpoint rejects tool UAs), regex-parses `result__a`/`result__snippet`, unwraps `uddg` redirect links, decodes HTML entities |
| `brave` | `https://api.search.brave.com/res/v1/web/search?q=…&count=…` | `X-Subscription-Token` (settings `apiKey`) | 401/403 mapped to an actionable "check the key" error |
| `custom-json` | `customBaseUrl` with `{query}` placeholder (URL-encoded) or `?q=` appended | optional `Authorization: Bearer` | Heuristic field mapping; accepts top-level arrays and nested `results`/`data`/`items`/`web` shapes |

Shared plumbing:

- **HTTP** — global `fetch` (Node ≥ 18) with an `AbortSignal.timeout(...)` deadline; friendly, actionable messages for timeouts, `ECONNREFUSED`, `ENOTFOUND`/`EAI_AGAIN`, HTTP statuses and invalid JSON (mirroring the reference MCP's error style). DuckDuckJS engine calls have no abort support in the library, so the adapter races them against `timeoutMs` instead.
- **Normalization** — every adapter returns the same `SearchResponse` (`query`, `results[]` with `title`/`url`/`content`/`engines?`, `answers?`, `suggestion?`), so `formatSearchResponse` is provider-agnostic.
- **Formatting** — `Query:` line, `Answer:` (first instant answer), numbered results (`N. title`, URL, snippet truncated to 300 chars with `…`, `Engines:`), `Did you mean:`. Empty results render `No results found.`

## 4. Settings and configuration

**Host settings** (`shared/settings.ts`, `defineSettings`, scope `host`): `injectIntoAgents` (bool, default true), `mcpServerName` (default `bunny-search`), `searchService` (enum, default `duckduckjs` since 0.3.0; `searxng`, `duckduckgo`, `brave`, `custom-json` remain), `duckduckjsEngine` (enum `auto`/`duckduckgo`/`brave`/`google`/`mojeek`/`yahoo`, default `auto`), `proxyUrl` (optional http(s) proxy for DuckDuckJS, empty = direct), `searxngBaseUrl` (default `http://127.0.0.1:8888/search` — the reference MCP default), `customBaseUrl`, `searchUiUrl` (web interface URL; empty = derive from the API base URL's origin), `apiKey`, `timeoutMs` (1000–60000, default 20000), `maxResults` (1–30, default 10), `categories` (default `general,web`), `language` (default auto). The settings screen shows the engine selector and proxy field only when DuckDuckJS is the selected service. Existing installs keep their stored `searchService`; the new default applies to fresh configurations.

**Interface URL derivation** (`server/ui-url.ts`): explicit `searchUiUrl` wins; otherwise the origin of `searxngBaseUrl` / `customBaseUrl` (API `http://omnirouter/search` → interface `http://omnirouter`, port preserved); DuckDuckGo and Brave fall back to their public front pages (`https://duckduckgo.com`, `https://search.brave.com`). `bunny-search.status` reports the derived `uiUrl` (never a secret) to the UI.

**Runtime settings** — the MCP server is spawned by agent processes outside the plugin host, so it cannot receive settings through the SDK. `server/settings-file.ts` layers: schema defaults ← `$PASEO_HOME/plugins/bunny-search/settings.json` (accepts both the host `{revision, values}` layout and a flat object; out-of-range values fall back) ← environment variables (`BUNNY_SEARCH_BASE_URL`, `BUNNY_SEARCH_PROVIDER`, `BUNNY_SEARCH_DUCKDUCKJS_ENGINE`, `BUNNY_SEARCH_PROXY_URL`, `BUNNY_SEARCH_CUSTOM_URL`, `BUNNY_SEARCH_API_KEY`, `BUNNY_SEARCH_TIMEOUT_MS`, `BUNNY_SEARCH_MAX_RESULTS`, `BUNNY_SEARCH_CATEGORIES`, `BUNNY_SEARCH_LANGUAGE`; `SEARXNG_BASE_URL` is honored for drop-in compatibility with the reference MCP). This keeps the server usable standalone with any MCP client.

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
| Paseo | verified against 0.10.3 and stable 0.11.0 (requirement `>=0.10.0`; bumped to `>=0.11.0` when the 0.11-only improvements in §10 are implemented) |
| SDK | `@getpaseo/plugin@0.10.1` (0.11.0 verified for the SDK as a build/test target, see §10) |
| Node | ≥ 18 (global `fetch`; daemon verified on Node 24) |
| Install | `paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:bunny-search` — the daemon clones into `~/.paseo/plugins/bunny-search/<revision>/checkout/bunny-search` and runs the manifest build step `[["npm", "ci"], ["npm", "run", "bundle"]]` there, so the dependencies are installed and `dist/mcp-server.js` is rebuilt in the Paseo home (both commands need registry access). A local-directory source is not used: it would execute the plugin straight from the working copy and run no build commands at all. |
| Verification | typecheck clean (three-project `tsc -b`); vitest 7 suites / 76 tests (providers with stubbed fetch + mocked DuckDuckJS engines, settings-file layering, settings-mirror round-trip, interface-URL derivation, spawn probe, tool dispatch, stdio e2e against a local fake SearXNG); static reproduction of the host's bundler boundary check against a staged copy — no boundary errors; stable-0.11.0 checks in §10.1 |

## 8. Alternatives considered

- **SearXNG only** — simplest, but the task explicitly requires user-selectable providers; the adapter interface makes adding more (e.g. Tavily, SerpAPI) a single new object in the registry.
- **Search libraries evaluated for the extra engines (stage 1, 0.3.0)** — `@overclockedsenku/duckduckjs` chosen (TypeScript, five engines without API keys, single-file bundling verified with esbuild, proxy reachable through its own `undici` dependency); Python `ddgs` deferred to stage 2 (richest engine set and first-class `proxy` argument, but requires python3 ≥ 3.10 plus a user-run `pip install ddgs` — the plugin will only *check* availability, never install it); the npm package `ddgs` rejected (puppeteer + stealth plugin — a Chromium download that contradicts the self-contained bundle); `google-search-scraper-nodejs` rejected (Windows-only browser automation); `@wzrdteam/search` not adopted (Bing-only scraper whose axios proxy support is reachable only through process environment variables, so no settings-UI field is possible — and DuckDuckJS already aggregates Bing-class sources).
- **In-process MCP** — impossible: agents speak stdio MCP to their own subprocesses.
- **Settings via MCP config** — the host injects the command only; values must come from the settings file / env, hence the layered reader.
- **Reading the host store from the MCP process** — impossible by design: the store is only exposed to the plugin host via the plugin API, and the MCP process is spawned by agent providers outside that host; hence the mirror file (the earlier file-only reader was the source of the "settings changed but the test still hits the default URL" bug — fixed by reading the store live and mirroring it).

## 9. Roadmap

- **Stage 2 (on request): Python `ddgs` backend** — a `python3` subprocess provider using the user-installed `ddgs` library (runtime availability check with an actionable error; the plugin never installs it), bringing bing/google/startpage/yandex and a per-request `proxy` argument (http/https/socks5).
- Register the MCP server directly in Cline/Cursor/Codex config files (as memory-flash does) for agents that ignore session stdio servers.
- Optional response caching and per-project category presets.
- More providers behind the same adapter interface.

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
  `bunny-search@0.3.0`.

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
