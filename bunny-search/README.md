# Bunny Search

Web search for coding agents on [Paseo](https://paseo.sh/): a bundled stdio MCP server that gives every agent (Cline, OpenCode, Kilo, Qwen Code, Codex, …) a `web_search` tool, with a pluggable choice of search backends and a live connection indicator inside Paseo.

Paseo orchestrates agents but has no built-in web search. Bunny Search closes that gap: agents ask one tool, the plugin routes the request to the configured search service (DuckDuckJS multi-engine by default), and the answer comes back as plain formatted text — title, URL, content snippet and source engines — modeled on the proven [SearXNG MCP server](https://github.com/searxng/searxng) reference implementation.

## What it does

- **Local MCP server (stdio)** — implements the MCP protocol (`initialize`, `tools/list`, `tools/call`) over newline-delimited JSON on stdin/stdout. Spawned by each agent process; shipped as one self-contained esbuild bundle (dependencies compiled in — agents only need Node ≥ 18, no `npm install`).
- **MCP tools** — `web_search` (query, `max_results` 1–30, SearXNG `categories`, `language`) and `search_status` (configured provider, base URL, defaults). Output follows the reference MCP layout: query line, instant answer, numbered results with URL, snippet (≤ 300 chars) and engines, plus a "did you mean" suggestion when the service offers one.
- **User-selectable search services** — pick the backend in settings:
  - **DuckDuckJS** (default) — the [DuckDuckJS](https://www.npmjs.com/package/@overclockedsenku/duckduckjs) meta-search library, no API key: queries DuckDuckGo, Brave, Google, Mojeek and Yahoo — the engine selector defaults to **Auto**, which walks that order until one engine returns results (each engine can also be pinned). Optional `Proxy URL` routes the library's requests through an http(s) proxy (undici dispatcher; empty = direct). The language setting maps to the engine region (`ru` → `ru-ru`);
  - **DDGS Python** — the [PyPI `ddgs`](https://pypi.org/project/ddgs/) metasearch library (bing, brave, duckduckgo, google, mojeek, startpage, yandex, yahoo, …) run in a `python3` subprocess, with http(s)/socks5 proxy support. The library is a **user-installed requirement** — the plugin only *checks* availability and never installs Python packages (see "Python requirement" below);
  - **SearXNG** — self-hosted JSON API (`format=json`), categories, language, instant answers and engine attribution;
  - **DuckDuckGo** — HTML endpoint, no API key, redirect links unwrapped;
  - **Brave Search** — official REST API with `X-Subscription-Token`;
  - **Custom JSON** — any JSON search endpoint: `{query}` placeholder in the URL (or `?q=`), heuristic field mapping (`title`/`name`/`heading`, `url`/`link`/`href`, `content`/`snippet`/`description`/`body`/`text`), array or nested `results`/`data`/`items`/`web` payloads;
  - **Tavily**, **Exa**, **Kagi Search**, **Perplexity** (0.7.5) — the four most requested coding-agent APIs, each one adapter behind the same normalised result. One `API key` field is used for whichever service is selected (the settings screen says how it is sent): Tavily `Authorization: Bearer` against `api.tavily.com/search`, Exa `x-api-key` against `api.exa.ai/search` with page text as the snippet, Kagi `Authorization: Bot <token>` against `kagi.com/api/v0/search` (search results only), Perplexity `sonar` against `api.perplexity.ai/chat/completions`, whose answer becomes the `Answer:` block and whose citations become the result list. A missing key fails before the request with an actionable message, and 401/403 is reported as a rejected key.
- **Test connection button** — Settings → Plugins → Bunny Search runs a real probe against the configured service (with the configured timeout) **and** a live MCP handshake check (spawn + `initialize`) of the bundled server, showing latency or a friendly, actionable error (connection refused, DNS, timeout, HTTP status, invalid JSON, rejected API key).
- **Open search interface** — the API endpoint and the human-facing web interface are separate settings (`Search interface URL`). When the interface URL is empty it is derived from the API URL's origin (e.g. API `http://omnirouter/search` → interface `http://omnirouter`); DuckDuckGo and Brave fall back to their public front pages. The **Open in browser** action opens it inside Paseo's own browser tab on the desktop app, or the system browser elsewhere. The sidebar screen has a matching **Open** button.
- **Connected indicator** — the sidebar screen shows a green/red/gray dot with the current provider, base URL, last-check latency and time, so "is my web search MCP working?" is always one glance away. A quick-search box runs a real query through the configured service without touching an agent.
- **Live status stream (0.7.5)** — the screen subscribes to `bunny-search.status-stream` (Paseo 0.16.0 `addSubscription`), so the dot, latency and provider update on their own after a connection test or a settings change, and a new *Recent agents* list shows which agents were provisioned since the screen opened, including the ones that received only the attached tool. Each pushed event is a complete snapshot (status, the event itself, the last 20 decisions), so a missed event cannot leave the screen stale.
- **Search-the-draft composer control (0.7.5)** — a `Search` action sits with the composer controls in every agent: it takes the prompt you already typed (up to 512 characters), runs the configured search and inserts the formatted results at the cursor, so the agent starts from real sources and you can edit what was added before sending.
- **Deep-linked quick search (0.7.5)** — `Command Center → Search the web for this agent's task` opens the screen with the agent's title already in the search box (`params.q`); opening the item never runs a query by itself.
- **Per-agent provisioning marker (0.7.5, fixed in 0.7.6)** — the plugin records `bunny-search: { mode: "mcp" | "tool" | "skipped", reason, at }` in the agent's `metadata` (Paseo 0.16.0), so the daemon itself records how each agent was provisioned. `agent.create.before` returns it; `agent.open.before` writes it through the SDK (`setMetadata`, fire-and-forget) rather than returning it, because the host lets that hook change only `env`, `tools` and `mcpServers` and fails the open otherwise. An agent whose marker says `mcp` also skips the capability probe on later opens: the provider's answer cannot have changed for it.
- **Response cache (0.7.5)** — identical searches are answered from a small in-process LRU (`Cache TTL`, default 300 s, 0 disables, max 64 entries) instead of hitting the upstream service again. The formatted answer says `Query: … (cached)`, empty results are never cached, and every settings change clears it.
- **Background agents (0.7.5)** — by default background agents (hidden from tabs and notifications) get search like any other agent, because that is what they exist for. `Skip background agents` in settings excludes them at session open for users who do not want it.
- **Automatic MCP injection** — via the Paseo `agent.create.before` hook the MCP server is added to every agent created through Paseo (configurable, on by default; configurable tool name), and re-contributed on every `agent.open.before`. Since 0.7.6 the injected command points at a stable copy under `$PASEO_HOME/plugins/bunny-search/`, so a plugin update does not break already-created agents, and saved entries left behind by an older install are restored on start.
- **Graceful degradation on a shared OpenCode service (0.6.3)** — Paseo 0.15.0 reuses a running OpenCode v2 service, and such a host refuses *any* agent whose config carries custom MCP servers (`Custom OpenCode MCP servers … require an isolated server …`, #7435), so the injection would make creation and every reopen fail instead of enabling search. The plugin reproduces the host's selection rule locally from the same environment the host uses — `process.env` with `agents.providers.opencode.env` from `$PASEO_HOME/config.json` overlaid on it, so `PASEO_OPENCODE_SERVER_URL` or `XDG_STATE_HOME` set in Paseo's provider settings counts — and, for the `opencode` provider only, withholds the MCP server; the agent opens normally and the native `bunny_web_search` tool keeps search working.
- **Standalone use outside Paseo** — the MCP server reads `$PASEO_HOME/plugins/bunny-search/settings.json` and honors `BUNNY_SEARCH_*` environment variables (`SEARXNG_BASE_URL` is honored too, for drop-in compatibility with the reference MCP), so it also works with any MCP client.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:bunny-search
```

Requires Paseo ≥ 0.15.0 (verified against the stable release of 2026-11-16;
uses the plugin SDK screen/sidebar API, settings screens and `server.addHook`). Node ≥ 18 on the daemon host (global `fetch`).

### Python requirement (for the DDGS Python service)

The DDGS Python provider needs **Python ≥ 3.10 with the `ddgs` library
installed — you install it yourself**:

```bash
pip install ddgs          # or: pipx install ddgs, uv tool install ddgs
```

The plugin never installs Python packages: it only *checks* availability
(`import ddgs`) and reports an actionable error when the library is missing.
It finds the interpreter in this order and uses the first one that can
import `ddgs`:

1. the `Python path` field in the plugin settings (explicit override);
2. environment variables: `BUNNY_SEARCH_PYTHON`, `VIRTUAL_ENV`, `CONDA_PREFIX`;
3. every `python3` / `python` on `PATH` (in `PATH` order);
4. well-known virtualenv directories: `~/.venv`, `~/venv`,
   `~/.virtualenvs/*`, `~/.local/share/virtualenvs/*`.

Candidates without the library are skipped (a system Python without `ddgs`
first on `PATH` is no problem), and the resolved interpreter is cached for
the process lifetime.

After install: open **Settings → Plugins → Bunny Search** — the default **DuckDuckJS** provider works out of the box (no API key, no self-hosted service). To use another backend, pick the search service and configure its URL/key, then press **Test connection**. For SearXNG, point `SearXNG base URL` at your instance's JSON endpoint (e.g. `http://127.0.0.1:8888/search` — the same default as the reference MCP). Optionally set `Search interface URL` to the human-facing page of your instance (defaults to the API URL's origin) and use **Open in browser** to browse it. New agents get the `web_search` tool automatically.

Settings changed in the UI take effect immediately for the connection test and quick search (the plugin reads the host settings store live) and are mirrored to `$PASEO_HOME/plugins/bunny-search/settings.json` for the spawned MCP server — every newly created agent picks them up on spawn.

The plugin is installed into the Paseo home and runs from there: `~/.paseo/plugins/bunny-search/<revision>/checkout/bunny-search`. The manifest `build` step (`paseo-plugin.json`, an argv array: `[["npm", "ci"], ["npm", "run", "bundle"]]`) is executed by the daemon in that directory on every install and every update: `npm ci` installs the dependencies, then `dist/mcp-server.js` is regenerated, so MCP-server changes reach agents without a manual rebundle. Both commands need registry access on the host. Updates: `paseo plugin update bunny-search`.

## Development

```bash
npm install
npm run bundle   # dist/mcp-server.js — standalone stdio server (esbuild)
npm test         # vitest: 12 hermetic suites / 179 tests (providers, cache, provisioning, discovery, settings, probe, tools, hooks, stdio e2e)
BUNNY_LIVE=1 npx vitest run tests/live-ddgs.test.ts   # live smoke: real Python + PyPI ddgs + network
npm run typecheck   # tsc -b: three projects — server, client (react-native), tests
```

The typecheck is split on purpose: react-native's and `@types/node`'s ambient
`fetch`/`AbortSignal` declarations conflict when server and client code share
one `tsc` program (the merge is order-dependent), so each runtime typechecks in
its own project and the root `tsconfig.json` is a solution file referencing
them.

Working with an installed plugin:

```bash
paseo plugin logs bunny-search                 # includes the `[bunny-search] MCP injected: …` diagnostic
paseo plugin reload bunny-search   # works on Paseo 0.11.0 (verified: exit 0, plugin restarts)
paseo plugin disable bunny-search && paseo plugin enable bunny-search   # equivalent reload on older daemons
```

Storage layout on the daemon host:

```
$PASEO_HOME/plugins/bunny-search/
└── settings.json  # settings mirror written by the plugin host on every settings change; read by the spawned MCP server
```

The host keeps the authoritative settings in its own store (exposed to the plugin via the `settings.bunny-search.read` RPC and change subscription); the JSON file above is a mirror for the MCP server process, which is spawned by agent providers outside the plugin host and therefore cannot use the plugin API.

## Compatibility

Paseo **0.16.0 (2026-11-16)** verified, `requirements.paseo >=0.15.0`, SDK `@getpaseo/plugin ^0.16.0` — compatible with no API migration; 0.16.0's one breaking change (`agent.turn.after.timeline` removed) is not used, and the shared OpenCode-service guard is still required by the 0.16.0 host. 0.7.5 adds no API dependency: the status subscription, composer control, metadata marker, background policy and deep links all use capabilities the same 0.16.0 SDK already exposes. Current version: **0.7.6** — a patch over 0.7.5 that keeps `metadata` out of the `agent.open.before` result (the 0.16.0 host rejects it and fails every prompt) and writes the marker through the SDK instead.

Full detail: [__compatibility.md](./__compatibility.md); technical evidence: [`__doc.md`](./__doc.md) (Compatibility sections).
