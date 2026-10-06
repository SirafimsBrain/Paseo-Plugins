# Bunny Search

Web search for coding agents on [Paseo](https://paseo.sh/): a bundled stdio MCP server that gives every agent (Cline, OpenCode, Kilo, Qwen Code, Codex, …) a `web_search` tool, with a pluggable choice of search backends and a live connection indicator inside Paseo.

Paseo orchestrates agents but has no built-in web search. Bunny Search closes that gap: agents ask one tool, the plugin routes the request to the configured search service (SearXNG by default), and the answer comes back as plain formatted text — title, URL, content snippet and source engines — modeled on the proven [SearXNG MCP server](https://github.com/searxng/searxng) reference implementation.

## What it does

- **Local MCP server (stdio)** — implements the MCP protocol (`initialize`, `tools/list`, `tools/call`) over newline-delimited JSON on stdin/stdout. Spawned by each agent process; zero runtime npm dependencies (Node built-ins only).
- **MCP tools** — `web_search` (query, `max_results` 1–30, SearXNG `categories`, `language`) and `search_status` (configured provider, base URL, defaults). Output follows the reference MCP layout: query line, instant answer, numbered results with URL, snippet (≤ 300 chars) and engines, plus a "did you mean" suggestion when the service offers one.
- **User-selectable search services** — pick the backend in settings:
  - **SearXNG** (default) — self-hosted JSON API (`format=json`), categories, language, instant answers and engine attribution;
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

Requires Paseo ≥ 0.10.0 (verified against 0.10.3; uses the plugin SDK 0.10 settings screens and lifecycle hooks). Node ≥ 18 on the daemon host (global `fetch`).

After install: open **Settings → Plugins → Bunny Search**, pick the search service, configure its URL/key, and press **Test connection**. For SearXNG, point `SearXNG base URL` at your instance's JSON endpoint (e.g. `http://127.0.0.1:8888/search` — the same default as the reference MCP). Optionally set `Search interface URL` to the human-facing page of your instance (defaults to the API URL's origin) and use **Open in browser** to browse it. New agents get the `web_search` tool automatically.

Settings changed in the UI take effect immediately for the connection test and quick search (the plugin reads the host settings store live) and are mirrored to `$PASEO_HOME/plugins/bunny-search/settings.json` for the spawned MCP server — every newly created agent picks them up on spawn.

The plugin is installed into the Paseo home and runs from there: `~/.paseo/plugins/bunny-search/<revision>/checkout/bunny-search`. The manifest `build` step (`paseo-plugin.json`, an argv array: `[["npm", "ci"], ["npm", "run", "bundle"]]`) is executed by the daemon in that directory on every install and every update: `npm ci` installs the dependencies, then `dist/mcp-server.js` is regenerated, so MCP-server changes reach agents without a manual rebundle. Both commands need registry access on the host. Updates: `paseo plugin update bunny-search`.

## Development

```bash
npm install
npm run bundle   # dist/mcp-server.js — standalone stdio server (esbuild)
npm test         # vitest: providers, settings layering, probe, tools, stdio e2e
npm run typecheck
```

Working with an installed plugin:

```bash
paseo plugin logs bunny-search                 # includes the `[bunny-search] MCP injected: …` diagnostic
paseo plugin disable bunny-search && paseo plugin enable bunny-search   # reload (`paseo plugin reload` currently fails manifest validation on the daemon side)
```

Storage layout on the daemon host:

```
$PASEO_HOME/plugins/bunny-search/
└── settings.json  # settings mirror written by the plugin host on every settings change; read by the spawned MCP server
```

The host keeps the authoritative settings in its own store (exposed to the plugin via the `settings.bunny-search.read` RPC and change subscription); the JSON file above is a mirror for the MCP server process, which is spawned by agent providers outside the plugin host and therefore cannot use the plugin API.

## Planned improvements with Paseo 0.11.0

Paseo `0.11.0-beta.5` (prerelease of 0.11.0, verified 2026-10-06) is compatible
with this plugin as-is: typecheck, the test suite, the real host bundler and a
live Git install on an isolated 0.11.0-beta.5 daemon all pass unchanged. New
0.11.0 APIs relevant to this plugin:

- **`spawnProcess` / `execCommand` / `terminateProcess`**
  (`@getpaseo/plugin/server`) — replace the `node:child_process` probe in
  `server/probe.ts` (service test + MCP spawn/initialize check) with
  host-managed processes, including Windows `.cmd`/`.bat` launching.
- **Screen/sidebar modernization** — migrate the deprecated `addSurface` /
  `addSidebarItem` / `openSurface` to `addScreen` / `addSidebarHeaderItem` /
  `openScreen` (the host's compatibility shims are removed after **2027-03-29**),
  deep-link the surface with a prefilled quick-search query via screen URL
  params (`PluginScreenProps.params`), and use `SidebarRow` /
  `addSidebarFooterItem` for a host-native layout.
- **`server.registerUsageSource()`** — publish the configured search backend's
  quota/utilization (e.g. Brave API limits) as a usage source, readable through
  `listUsageReports()` in the Paseo usage reports (candidate: depends on the
  backend exposing usage data).

Implementation is planned **after the stable Paseo 0.11.0 release, on request**.

Technical details, design decisions, alternatives considered, limitations and the roadmap: see [__doc.md](./__doc.md).
