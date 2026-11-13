# Paseo Plugins

This repository contains my plugin developments for the [Paseo](https://paseo.sh/) project.

All code is written for personal use. The plugins here can be used in the Paseo project without any restrictions.

## Plugins

- [session-manager](./session-manager/README.md) — lists and deletes the on-disk sessions of the coding agents connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, Kimi Code, acpx) through a workspace panel, a sidebar status row with a counts/size summary popover, and Command Center items; the listing cache is dropped whenever an agent session closes or is archived, a Command Center action reopens a session to rescan it, and the panel filters persist per tab.
- [command-center](./command-center/README.md) — a personal command center for Paseo: save reusable prompt and shell commands as templates (with per-command MCP server attachment), group them into categories, search them, run them against any workspace or agent with a live preview, browse run history with a configurable retention limit, schedule prompt commands on the standard Paseo scheduler with full tracking inside the plugin, insert commands from the composer attachment picker, configure defaults and automation (auto-run on agent turn end, workspace bootstrap) in its own settings screen, and chain saved commands into a `workflow` with per-step `always` / `on success` / `on failure` conditions that records one history entry with a per-step summary.
- [memory-flash](./memory-flash/README.md) — shared persistent memory for coding agents: a bundled stdio MCP server (SQLite + FTS5) that any agent connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) can read and write, automatic MCP injection into every Paseo-created agent, tagging by agent/project/kind (decision, procedure, handoff, bugfix, pattern, pitfall, reference, note), full revision history with restore, a Paseo screen for browsing/searching/editing/delegating memory maintenance to agents, one-button skill installation into agent skill directories, direct Cline MCP registration (Cline ignores session stdio servers, so the plugin writes its own settings file), and remote host registration (Paseo SSH implemented, tcp/relay stubbed), plus remote access over HTTP with API keys (Streamable HTTP at `/mcp`, keys generated and shown once with only the SHA-256 hash stored, `read`/`read_write` scopes, expiry, one-click delete, per-IP rate limiting, never logging the `Authorization` header) so other machines can share the same memory database. Search quality is measured rather than assumed: a text query ranks a pool of 50 and fuses several independent FTS5 views with Reciprocal Rank Fusion (no new dependency, no migration), and `memory_diagnose` reports recall@k over control queries while telling each miss apart as *never retrieved* or *ranked too low* — see [ROADMAP.md](./memory-flash/ROADMAP.md).
- [bunny-search](./bunny-search/README.md) — web search for coding agents: a bundled stdio MCP server with a `web_search` tool modeled on the proven SearXNG MCP, user-selectable search services (SearXNG by default, plus DuckDuckGo, Brave Search and any custom JSON endpoint), automatic MCP injection into every Paseo-created agent — re-applied on every session open so it reaches agents that already exist and survives the idle-runtime release, and gated per agent by a label or a provider exclusion list —, a native `bunny_web_search` agent tool for providers without MCP support, a "repair search tools" Command Center action, a Test connection button (real service probe + live MCP handshake check), a connected indicator (green/red dot with provider, base URL and latency) with a quick-search box, and an Open interface action that opens the search service's web interface in a Paseo browser tab (a separate setting, derived from the API URL's origin when unset).
- [memory-flash-client](./memory-flash-client/README.md) — connects this machine to remote [memory-flash](./memory-flash/README.md) memory hosts over HTTP with an API key: a connections registry (URL + key, owner-only file), a Test/Check probe that mirrors the real agent handshake (health + `initialize` + `tools/list`), a stable client identity (UUID + host name from settings) announced on every request so the memory host can log which client connected, automatic injection of the remote HTTP MCP servers into every Paseo-created agent, its own `memory-flash-remote` agent skill so the remote base is used as intensively as a local one, and an explicit coexistence check for the case where memory-flash and memory-flash-client live on the same host.
- [luck-planner](./luck-planner/README.md) — the project planning tree for coding agents: a SQLite-backed hierarchy of a project (tech-stack root, trunks, module branches and fact leaves with statuses, versions, revisions and an append-only audit trail), influence links between leaves (bees), blocking incidents (bugs), human-approved high goals with plans and growth records — all written through eleven MCP tools that are injected into every agent created through Paseo (and that can be registered directly in the agents' own config files, so they survive OpenCode's directory eviction and reach the terminal agents); a read-only dashboard on the loopback interface with a 2D diagram (full-text search, kind/status/version filters, a details panel, the growth heat layer, live updates over SSE) and a 3D WebGL scene of the same tree (bees flying along arcs, incidents pulsing over the leaves they block, goal rings floating over their subtree, click-to-select into the *same* details panel, a camera flight from the search, the 2D/3D choice remembered in the URL) that falls back to the diagram with a written reason when the browser has no WebGL; a native workspace panel, timeline rows for the two facts worth an audit line (a goal that crossed the approval gate, a leaf that reached `done`), and an agent skill that teaches when to write the tree.
- [remote-control](./remote-control/README.md) — a local-only remote control console for Paseo: a loopback web console (workspace browser tab) for groups/connections whose login **and password** are kept in a pass-backed secret vault (the database stores only secret names; the storage is created and unlocked once with a master password in the sidebar panel, and secrets exist only inside connections — no manual secret management), and a right-sidebar launch panel: SSH sessions open as native Paseo workspace tabs (`paseo.terminals.create`) with credentials materialised from the vault without leaking into argv/env, RDP/VNC open as external desktop windows (FreeRDP 3 reads the password from stdin, and an RD Gateway password as the second stdin line when the gateway has its own login; VNC viewers are discovered per machine from nine supported clients and get a `vncpasswd -f` file, a Remmina profile or the TigerVNC/TurboVNC env fallback), a **Sessions** console view lists Paseo tabs together with those RDP/VNC windows and can kill either, and the whole connection set — groups, parameters, stored passwords — moves between machines as one JSON export/import file, optionally sealed with a passphrase; it also manages the user's `~/.ssh/config` read-modify-write (one marked `Host` block per connection, `Include`s followed, hand-written entries, wildcard/`Match` rules and unknown directives preserved, atomic revision-checked writes with a backup and a refusal to take over a hand-typed alias), deploys a public key into the remote `authorized_keys` with ssh-copy-id semantics, and its console **Settings** screen edits the console port, vault auto-lock, pass-store directory and RDP/VNC client overrides (all visible in `GET /api/state`), while the **Sessions** view filters, groups, bulk-kills and updates live over SSE. Built with `npm ci`, `npm run bundle`; depends on `esbuild`.
- [obsidian-bridge](./obsidian-bridge/README.md) — a bridge to a local Obsidian vault: indexes notes from disk (frontmatter, tags, wikilinks, heading chunks) into SQLite/FTS5, answers `obsidian_search`/`read`/`outline`/`list`/`links` with note paths and headings as citations — full-text BM25 over heading chunks fused with title/alias matches and one-hop wikilink proximity — and does it strictly on explicit request: the tools are injected inertly on session open (native fallback tools for providers without MCP), nothing is read or written unless the prompt asks, no skill is installed, and every setting lives in a Paseo settings screen including the directory available to Paseo, which is validated before the first scan and is a hard boundary (nothing above it is reachable); inside it three roles tell an agent where to work — `inbox` for incoming sources, `out` for authored documents, `raw` for scratch — and the only write tools append a dated section to an explicitly named document in one of those roles, never editing, moving or deleting anything.

All plugins follow the host Appearance settings (interface font, code font, and interface text size) in their UI: sizes are scaled relative to the app-wide value, and a configured font family is applied to plugin text.

## Installation

Install from this Git repository — the plugin directory in the repository is appended to the source with `:`, so each plugin has its own source string:

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:command-center
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:session-manager
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:bunny-search
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash-client
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:luck-planner
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:remote-control
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:obsidian-bridge
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
| [luck-planner](./luck-planner/README.md) | `npm ci`, `npm run bundle` | `esbuild` for the standalone MCP server bundle |
| [remote-control](./remote-control/README.md) | `npm ci`, `npm run bundle` | `esbuild` for the console web app |
| [obsidian-bridge](./obsidian-bridge/README.md) | `npm ci`, `npm run bundle` | `esbuild` for the standalone MCP server bundle |

The four plugins with a build step need npm-registry access on the host during install and update; the other two have no external dependency at all.

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

| Plugin | Ver. | Verified Paseo | Requirement | SDK | Status | Details |
| ------ | ---- | -------------- | ----------- | --- | ------ | ------- |
| [session-manager](./session-manager/README.md) | 0.5.0 | 0.15.0 (2026-11-03) | `>=0.15.0` | `@getpaseo/plugin ^0.15.0` | Compatible after `addHook` migration | [__compatibility.md](./session-manager/__compatibility.md) |
| [command-center](./command-center/README.md) | 0.7.0 | 0.15.0 (2026-11-09) | `>=0.15.0` | `@getpaseo/plugin ^0.15.3` + `@getpaseo/client ^0.15.3` | Compatible after `addHook` migration | [__compatibility.md](./command-center/__compatibility.md) |
| [memory-flash](./memory-flash/README.md) | 0.10.4 | 0.14.0 (2026-10-29) | `>=0.14.0` | `@getpaseo/plugin ^0.14.0` | Compatible; 0.14.0 surface in use | [__compatibility.md](./memory-flash/__compatibility.md) |
| [bunny-search](./bunny-search/README.md) | 0.5.3 | 0.15.0 (2026-11-03) | `>=0.15.0` | `@getpaseo/plugin ^0.15.0` | Compatible after `addHook` migration | [__compatibility.md](./bunny-search/__compatibility.md) |
| [memory-flash-client](./memory-flash-client/README.md) | 0.4.2 | 0.14.0 (2026-10-29) | `>=0.14.0` | `@getpaseo/plugin ^0.14.0` | Compatible; 0.14.0 surface in use | [__compatibility.md](./memory-flash-client/__compatibility.md) |
| [luck-planner](./luck-planner/README.md) | 0.52.2 | 0.15.0 (2026-11-03) | `>=0.15.0` | `@getpaseo/plugin ^0.15.0` | Compatible after `addHook` migration | [__compatibility.md](./luck-planner/__compatibility.md) |
| [remote-control](./remote-control/README.md) | 1.0.0 | 0.15.0 (2026-11-03) | `>=0.11.0` | `@getpaseo/plugin 0.13.0` (dev pin) | Compatible as-is; no deprecated API used | [__compatibility.md](./remote-control/__compatibility.md) |

Extended compatibility information — SDK surface diffs, pass evidence and footnotes — lives in each plugin's `__compatibility.md` (linked above) and in its `__doc.md`.
