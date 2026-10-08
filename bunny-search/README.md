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
  - **Custom JSON** — any JSON search endpoint: `{query}` placeholder in the URL (or `?q=`), heuristic field mapping (`title`/`name`/`heading`, `url`/`link`/`href`, `content`/`snippet`/`description`/`body`/`text`), array or nested `results`/`data`/`items`/`web` payloads.
- **Test connection button** — Settings → Plugins → Bunny Search runs a real probe against the configured service (with the configured timeout) **and** a live MCP handshake check (spawn + `initialize`) of the bundled server, showing latency or a friendly, actionable error (connection refused, DNS, timeout, HTTP status, invalid JSON, rejected API key).
- **Open search interface** — the API endpoint and the human-facing web interface are separate settings (`Search interface URL`). When the interface URL is empty it is derived from the API URL's origin (e.g. API `http://omnirouter/search` → interface `http://omnirouter`); DuckDuckGo and Brave fall back to their public front pages. The **Open in browser** action opens it inside Paseo's own browser tab on the desktop app, or the system browser elsewhere. The sidebar surface has a matching **Open** button.
- **Connected indicator** — the sidebar surface shows a green/red/gray dot with the current provider, base URL, last-check latency and time, so "is my web search MCP working?" is always one glance away. A quick-search box runs a real query through the configured service without touching an agent.
- **Automatic MCP injection** — via the Paseo `agent.create` before-hook the MCP server is added to every agent created through Paseo (configurable, on by default; configurable tool name).
- **Standalone use outside Paseo** — the MCP server reads `$PASEO_HOME/plugins/bunny-search/settings.json` and honors `BUNNY_SEARCH_*` environment variables (`SEARXNG_BASE_URL` is honored too, for drop-in compatibility with the reference MCP), so it also works with any MCP client.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:bunny-search
```

Requires Paseo ≥ 0.10.0 (verified against 0.10.3 and the stable 0.11.0 release; uses the plugin SDK settings screens and lifecycle hooks). Node ≥ 18 on the daemon host (global `fetch`).

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
npm test         # vitest: 9 hermetic suites / 95 tests (providers, discovery, settings, probe, tools, stdio e2e)
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

## Paseo 0.11.0 compatibility and improvement plan

Verified against the **stable Paseo 0.11.0** release (2026-10-07), no code
changes needed to run:

- Typecheck and the test suite (7 suites, 65 tests) pass against
  `@getpaseo/plugin@0.11.0`; the 0.11.0 SDK diff over 0.10.1 is additive for
  every API this plugin uses (nothing removed).
- A fresh Git install on an isolated 0.11.0 daemon completed the manifest
  build (`npm ci` + `npm run bundle`), reached status `running` and logged
  `Plugin ready`; `paseo plugin reload` works on 0.11.0.
- The install command above keeps working: 0.11.0 added a plugin registry
  (`paseo plugin add owner/slug`), while explicit Git URLs still install
  directly.

Improvement plan against the new 0.11.0 APIs (implementation on request):

1. **Host-managed processes** — replace `node:child_process` in the connection
   probe (`server/probe.ts`) with `spawnProcess()` / `terminateProcess()`,
   gaining correct Windows `.cmd`/`.bat` launching and descendant cleanup.
2. **Screens and sidebar** — migrate the deprecated `addSurface` /
   `addSidebarItem` / `openSurface` to `addScreen` / `addSidebarHeaderItem` /
   `addSidebarFooterItem` / `openScreen`, deep-link the quick search with a
   prefilled query through screen URL params, and render the connection status
   with host-native `SidebarRow` / `SidebarSeparator`.
3. **Registry readiness** — add `name` / `icon` / `media` to
   `paseo-plugin.json` and an `OVERVIEW.md` (per the `paseo plugin init`
   template) so the plugin can be listed in the Paseo plugin registry.
4. **Usage source** — deferred: no in-scope backend exposes quota data and the
   account-based `registerUsageSource()` model fits poorly (see [__doc.md](./__doc.md)).

Adopting items 1–2 raises `requirements.paseo` from `>=0.10.0` to `>=0.11.0`,
because the plugin SDK is supplied by the host at runtime. Full evidence and
the file-level implementation plan: [__doc.md](./__doc.md) §10.

Technical details, design decisions, alternatives considered, limitations and the roadmap: see [__doc.md](./__doc.md).
