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

## Installation

Install from this Git repository — the plugin directory in the repository is appended to the source with `:`, so each plugin has its own source string:

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:command-center
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:session-manager
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:bunny-search
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash-client
```

`github:SirafimsBrain/Paseo-Plugins:command-center` is accepted as a shorthand for the same source. Pin a revision with `--ref <branch|tag|commit>`; upgrades go through `paseo plugin update <id>`.

**Every plugin runs from the Paseo home, never from a development checkout.** A Git install clones the repository into `~/.paseo/plugins/<plugin-id>/<revision>/checkout/<plugin>`, runs the `build` commands from the plugin manifest there, and only then bundles the plugin — the plugin's code, its dependencies and its rebuilt MCP bundles all live under `~/.paseo/plugins/`. Plugin data (stores, settings) sits next to those versioned directories in the same `~/.paseo/plugins/<plugin-id>/` folder and survives updates.

`paseo plugin add <local directory>` is deliberately **not** part of this repository's workflow: it registers the directory as-is, so the plugin would execute straight from the working copy and the host would run no build commands at all. Development changes reach a running plugin through `git push` followed by `paseo plugin update <id>`, which re-clones and re-runs the build steps.

| Plugin | Install-time `build` | Dependencies needed to bundle |
| ------ | -------------------- | ------------------------------ |
| [session-manager](./session-manager/README.md) | — | none |
| [memory-flash-client](./memory-flash-client/README.md) | — | none |
| [command-center](./command-center/README.md) | `npm ci` | `@getpaseo/client` (the low-level daemon client for the scheduler bridge) |
| [memory-flash](./memory-flash/README.md) | `npm ci`, `npm run bundle` | `esbuild` for the standalone MCP server bundle |
| [bunny-search](./bunny-search/README.md) | `npm ci`, `npm run bundle` | `esbuild` for the standalone MCP server bundle |

The three plugins with a build step need npm-registry access on the host during install and update; the other two have no external dependency at all.

The host's bundler resolves a plugin's imports in two different ways: `@getpaseo/plugin*`, `zod`, `react`, `react-native`, `@tanstack/react-query` and `@types/node` are supplied by Paseo itself, while everything else must exist in the plugin's `node_modules` at install time — including *type-only* imports, which fail the build when they cannot be resolved. That is why the plugins above only reach for non-host packages deliberately, and why every non-host import is a declared dependency. Details per plugin: `__doc.md`.

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
| [session-manager](./session-manager/README.md) | 0.10.3 (2026-10-02) ¹ | `@getpaseo/plugin@0.10.1` | Compatible (typecheck + vitest: 8 suites, 70 tests). Host font scaling and font family support added in plugin 0.2.0. Every import is host-supplied, so the plugin installs from a clean checkout with no build step. Details: [Compatibility](./session-manager/__doc.md#compatibility). |
| [command-center](./command-center/README.md) | 0.10.3 (2026-10-02) ¹ | `@getpaseo/plugin@0.10.1` + `@getpaseo/client@0.10.1` | Compatible (typecheck + vitest: 9 suites, 98 tests). Categories, search, and host font scaling added in plugin 0.2.0; scheduler integration (standard Paseo Schedules with plugin-side management and run tracking) added in 0.3.0; scheduling from command cards and for shell commands added in 0.4.0; settings screen, lifecycle-hook automation, MCP server injection, composer attachment source, and extended `/cc` subcommands added in 0.5.0; 0.5.1 fixed installation from a clean checkout (`npm ci` build step + `@getpaseo/client` declared as a real dependency). Details: [Compatibility](./command-center/__doc.md#6-compatibility). |
| [memory-flash](./memory-flash/README.md) | 0.10.3 (2026-10-02) ¹ | `@getpaseo/plugin@0.10.1` | Compatible (typecheck + vitest: 11 suites, 98 tests, incl. a real-process stdio MCP e2e and a live HTTP endpoint suite driving the server with `fetch`). Plugin 0.5.0 added the remote-access HTTP transport with API keys; 0.5.1 fixed installation from a clean checkout (`npm ci` before the MCP bundle step, MCP config types derived from the host SDK). Details: [Compatibility](./memory-flash/__doc.md#10-compatibility). |
| [bunny-search](./bunny-search/README.md) | 0.10.3 (2026-10-02) ¹ | `@getpaseo/plugin@0.10.1` | Compatible (typecheck + vitest: 7 suites, 65 tests, incl. a real-process stdio MCP e2e). 0.2.1 fixed installation from a clean checkout (`npm ci` before the MCP bundle step, MCP config types derived from the host SDK). Details: [Compatibility](./bunny-search/__doc.md#7-compatibility). |
| [memory-flash-client](./memory-flash-client/README.md) | 0.10.3 (2026-10-02) ¹ | `@getpaseo/plugin@0.10.1` | Compatible (typecheck + vitest: 4 suites, 40 tests, incl. an HTTP probe against a stub memory-flash server and MCP-injection tests). 0.1.1 removed the last non-host import (MCP config types derived from the host SDK), so the plugin now installs from a clean checkout with no build step. Requires Memory Flash 0.5.0+ with the HTTP endpoint on the remote host. Details: [Compatibility](./memory-flash-client/__doc.md#11-compatibility). |

¹ Typecheck, vitest and a static reproduction of the host's bundler boundary check (the same `ts.resolveModuleName` walk the desktop app runs, replayed against a staged copy of each plugin with the manifest `build` commands executed first). A live `paseo plugin add` into a running daemon was not part of this change; re-run it once per plugin after pulling.
