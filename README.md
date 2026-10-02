# Paseo Plugins

This repository contains my plugin developments for the [Paseo](https://paseo.sh/) project.

All code is written for personal use. The plugins here can be used in the Paseo project without any restrictions.

## Plugins

- [session-manager](./session-manager/README.md) — lists and deletes the on-disk sessions of the coding agents connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) through a workspace panel and Command Center item.
- [command-center](./command-center/README.md) — a personal command center for Paseo: save reusable prompt and shell commands as templates (with per-command MCP server attachment), group them into categories, search them, run them against any workspace or agent with a live preview, browse run history with a configurable retention limit, schedule prompt commands on the standard Paseo scheduler with full tracking inside the plugin, insert commands from the composer attachment picker, and configure defaults and automation (auto-run on agent turn end, workspace bootstrap) in its own settings screen.
- [memory-flash](./memory-flash/README.md) — shared persistent memory for coding agents: a bundled stdio MCP server (SQLite + FTS5) that any agent connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) can read and write, automatic MCP injection into every Paseo-created agent, tagging by agent/project/kind (decision, procedure, handoff, bugfix, pattern, pitfall, reference, note), full revision history with restore, a Paseo surface for browsing/searching/editing/delegating memory maintenance to agents, one-button skill installation into agent skill directories, direct Cline MCP registration (Cline ignores session stdio servers, so the plugin writes its own settings file), and remote host registration (Paseo SSH implemented, tcp/relay stubbed), plus remote access over HTTP with API keys (Streamable HTTP at `/mcp`, keys generated and shown once with only the SHA-256 hash stored, `read`/`read_write` scopes, expiry, one-click revoke, per-IP rate limiting, never logging the `Authorization` header) so other machines can share the same memory database.
- [bunny-search](./bunny-search/README.md) — web search for coding agents: a bundled stdio MCP server with a `web_search` tool modeled on the proven SearXNG MCP, user-selectable search services (SearXNG by default, plus DuckDuckGo, Brave Search and any custom JSON endpoint), automatic MCP injection into every Paseo-created agent, a Test connection button (real service probe + live MCP handshake check), a connected indicator (green/red dot with provider, base URL and latency) with a quick-search box, and an Open interface action that opens the search service's web interface in a Paseo browser tab (a separate setting, derived from the API URL's origin when unset).
- [memory-flash-client](./memory-flash-client/README.md) — connects this machine to remote [memory-flash](./memory-flash/README.md) memory hosts over HTTP with an API key: a connections registry (URL + key, owner-only file), a Test/Check probe that mirrors the real agent handshake (health + `initialize` + `tools/list`), a stable client identity (UUID + host name from settings) announced on every request so the memory host can log which client connected, automatic injection of the remote HTTP MCP servers into every Paseo-created agent, and an explicit coexistence check for the case where memory-flash and memory-flash-client live on the same host.

All plugins follow the host Appearance settings (interface font, code font, and interface text size) in their UI: sizes are scaled relative to the app-wide value, and a configured font family is applied to plugin text.

## Versioning and releases

Each plugin is versioned independently with a `MAJOR.MINOR.PATCH` number in its own `package.json`:

- `PATCH` (last digit) — a bugfix or a change to existing functionality,
- `MINOR` (second digit) — new functionality,
- `MAJOR` (first digit) — a release requested with the word "release" (the other two digits reset to zero).

Every version bump is marked with an annotated Git tag `<plugin-name>@<version>` on the commit that carries that version, and the tag is pushed to `origin` — for example, `memory-flash@0.4.2`.

## License

MIT. See [LICENSE](./LICENSE).

## Compatibility

| Plugin | Verified Paseo | SDK | Result |
| ------ | -------------- | --- | ------ |
| [session-manager](./session-manager/README.md) | 0.10.0 (2026-09-29) | `@getpaseo/plugin@0.10.0` | Compatible, no code changes required (typecheck + vitest: 8 suites, 70 tests). Host font scaling and font family support added in plugin 0.2.0. Details: [Compatibility](./session-manager/__doc.md#compatibility). |
| [command-center](./command-center/README.md) | 0.10.1 (2026-09-29) | `@getpaseo/plugin@0.10.1` | Compatible, verified by installing the plugin into the running daemon (typecheck + vitest: 9 suites, 98 tests). Categories, search, and host font scaling added in plugin 0.2.0; scheduler integration (standard Paseo Schedules with plugin-side management and run tracking) added in 0.3.0; scheduling from command cards and for shell commands added in 0.4.0; settings screen, lifecycle-hook automation, MCP server injection, composer attachment source, and extended `/cc` subcommands added in 0.5.0. Details: [Compatibility](./command-center/__doc.md#compatibility). |
| [memory-flash](./memory-flash/README.md) | 0.10.2 (2026-09-30) | `@getpaseo/plugin@0.10.1` | Compatible, verified by installing the plugin into the running daemon (typecheck + vitest: 11 suites, 98 tests, incl. a real-process stdio MCP e2e and a live HTTP endpoint suite driving the server with `fetch`). Plugin 0.5.0 added the remote-access HTTP transport with API keys. Details: [Compatibility](./memory-flash/__doc.md#compatibility). |
| [bunny-search](./bunny-search/README.md) | 0.10.2 (2026-10-01) | `@getpaseo/plugin@0.10.1` | Compatible (typecheck + vitest: 7 suites, 65 tests, incl. a real-process stdio MCP e2e). Details: [Compatibility](./bunny-search/__doc.md#7-compatibility). |
| [memory-flash-client](./memory-flash-client/README.md) | 0.10.2 | `@getpaseo/plugin@0.10.1` | Compatible (typecheck + vitest: 4 suites, 40 tests, incl. an HTTP probe against a stub memory-flash server and MCP-injection tests). Requires Memory Flash 0.5.0+ with the HTTP endpoint on the remote host. Details: [Compatibility](./memory-flash-client/__doc.md#11-compatibility). |
