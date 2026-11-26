# Paseo Plugins

This repository contains my plugin developments for the [Paseo](https://paseo.sh/) project.

All code is written for personal use. The plugins here can be used in the Paseo project without any restrictions.

## Plugins

- [session-manager](./session-manager/README.md) — lists and deletes the on-disk sessions of the coding agents connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, Kimi Code, acpx) through a workspace panel, a sidebar status row with a counts/size summary popover, and Command Center items; the listing cache is dropped whenever an agent session closes or is archived, a Command Center action reopens a session to rescan it, the panel filters persist per tab, and every store that keeps its sessions in SQLite (Cline, OpenCode, Kilo) has its own compaction button that runs the database's `VACUUM` and reports the before/after size and the freed bytes.
- [command-center](./command-center/README.md) — a personal command center for Paseo: save reusable prompt and shell commands as templates (with per-command MCP server attachment), group them into categories, search them, run them against any workspace or agent with a live preview, browse run history with a configurable retention limit, schedule prompt commands on the standard Paseo scheduler with full tracking inside the plugin, insert commands from the composer attachment picker, configure defaults and automation (auto-run on agent turn end, workspace bootstrap) in its own settings screen, and chain saved commands into a `workflow` with per-step `always` / `on success` / `on failure` conditions that records one history entry with a per-step summary.
- [memory-flash](./memory-flash/README.md) — shared persistent memory for coding agents: a bundled stdio MCP server (SQLite + FTS5) that any agent connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, Kimi Code CLI, Pi, acpx) can read and write, automatic MCP injection into every Paseo-created agent, tagging by agent/project/kind (decision, procedure, handoff, bugfix, pattern, pitfall, reference, note), full revision history with restore, a Paseo screen for browsing/searching/editing/delegating memory maintenance to agents, one-button skill installation into agent skill directories, direct MCP registration in the agents' own config files (Cline ignores session stdio servers, so the plugin writes its own settings file; Cursor, Codex CLI, OpenCode, Kilo, Kimi Code CLI and Pi are covered the same way) — served to those external agents only while Paseo runs, answering `Демон Paseo недоступен, MCP недоступен` otherwise — and remote host registration (Paseo SSH implemented, tcp/relay stubbed), plus remote access over HTTP with API keys (Streamable HTTP at `/mcp`, keys generated and shown once with only the SHA-256 hash stored, `read`/`read_write` scopes, expiry, one-click delete, per-IP rate limiting, never logging the `Authorization` header) so other machines can share the same memory database. Search quality is measured rather than assumed: a text query ranks a pool of 50 and fuses several independent FTS5 views with Reciprocal Rank Fusion (no new dependency, no migration), and `memory_diagnose` reports recall@k over control queries while telling each miss apart as *never retrieved* or *ranked too low* — see [ROADMAP.md](./memory-flash/ROADMAP.md).
- [bunny-search](./bunny-search/README.md) — web search for coding agents: a bundled stdio MCP server with a `web_search` tool modeled on the proven SearXNG MCP, user-selectable search services (SearXNG by default, plus DuckDuckGo, Brave Search and any custom JSON endpoint), automatic MCP injection into every Paseo-created agent — re-applied on every session open so it reaches agents that already exist and survives the idle-runtime release, and gated per agent by a label or a provider exclusion list —, a native `bunny_web_search` agent tool for providers without MCP support, a "repair search tools" Command Center action, a Test connection button (real service probe + live MCP handshake check), a connected indicator (green/red dot with provider, base URL and latency) with a quick-search box, and an Open interface action that opens the search service's web interface in a Paseo browser tab (a separate setting, derived from the API URL's origin when unset). Since 0.7.5 it also streams live provisioning status, offers a composer "search the draft" control, records a per-agent `metadata` marker, caches identical answers with a TTL, and supports Tavily, Exa, Kagi and Perplexity.
- [memory-flash-client](./memory-flash-client/README.md) — connects this machine to remote [memory-flash](./memory-flash/README.md) memory hosts over HTTP with an API key: a connections registry (URL + key, owner-only file), a Test/Check probe that mirrors the real agent handshake (health + `initialize` + `tools/list`), a stable client identity (UUID + host name from settings) announced on every request so the memory host can log which client connected, automatic injection of the remote HTTP MCP servers into every Paseo-created agent, its own `memory-flash-remote` agent skill (including Pi's `~/.pi/agent/skills`) so the remote base is used as intensively as a local one, and an explicit coexistence check for the case where memory-flash and memory-flash-client live on the same host.
- [luck-planner](./luck-planner/README.md) — **FROZEN (code freeze):** development is stopped because of the high complexity of maintaining the code and developing further functionality; its functionality is being migrated to [obsidian-bridge](./obsidian-bridge/README.md).
- [remote-control](./remote-control/README.md) — a local-only remote control console for Paseo: a loopback web console (workspace browser tab) for groups/connections whose login **and password** are kept in a pass-backed secret vault (the database stores only secret names; the storage is created and unlocked once with a master password in the sidebar panel, and secrets exist only inside connections — no manual secret management), and a right-sidebar launch panel: SSH sessions open as native Paseo workspace tabs (`paseo.terminals.create`) with credentials materialised from the vault without leaking into argv/env, RDP/VNC open as external desktop windows (FreeRDP 3 reads the password from stdin, and an RD Gateway password as the second stdin line when the gateway has its own login; VNC viewers are discovered per machine from nine supported clients and get a `vncpasswd -f` file, a Remmina profile or the TigerVNC/TurboVNC env fallback), a **Sessions** console view lists Paseo tabs together with those RDP/VNC windows and can kill either, and the whole connection set — groups, parameters, stored passwords — moves between machines as one JSON export/import file, optionally sealed with a passphrase; it also manages the user's `~/.ssh/config` read-modify-write (one marked `Host` block per connection, `Include`s followed, hand-written entries, wildcard/`Match` rules and unknown directives preserved, atomic revision-checked writes with a backup and a refusal to take over a hand-typed alias), deploys a public key into the remote `authorized_keys` with ssh-copy-id semantics, and its console **Settings** screen edits the console port, vault auto-lock, pass-store directory and RDP/VNC client overrides (all visible in `GET /api/state`), while the **Sessions** view filters, groups, bulk-kills and updates live over SSE. Built with `npm ci`, `npm run bundle`; depends on `esbuild`.
- [obsidian-bridge](./obsidian-bridge/README.md) — a bridge to a local Obsidian vault: indexes notes from disk (frontmatter, tags, wikilinks, heading chunks) into SQLite/FTS5, answers `obsidian_search`/`read`/`outline`/`list`/`links` with note paths and headings as citations — full-text BM25 over heading chunks fused with title/alias matches and one-hop wikilink proximity — and does it strictly on explicit request: the tools are injected inertly on session open (native fallback tools for providers without MCP), nothing is read or written unless the prompt asks, a reviewable `SKILL.md` shipped with the plugin is installed into the agents' existing skills directories and teaches the read → cite → write workflow plus Obsidian Flavored Markdown (the official [obsidianmd/obsidian-skills](https://github.com/obsidianmd/obsidian-skills) stays the upstream reference), an exact-fragment `obsidian_edit` can change an existing note anywhere under the root, and every setting lives in a Paseo settings screen including the directory available to Paseo, which is validated before the first scan and is a hard boundary (nothing above it is reachable); inside it three roles tell an agent where to work — `inbox` for incoming sources, `out` for authored documents, `raw` for scratch — and the only write tools append a dated section to an explicitly named document in one of those roles, never editing, moving or deleting anything. Local semantic search (multilingual e5-small via Transformers.js, no external service) joins the fusion, a workspace tab and a composer attachment source expose the same index, and an optional Local REST API plugin adds Obsidian's own fuzzy search, authoritative link metadata, live vault events and "Open in Obsidian".

All plugins follow the host Appearance settings (interface font, code font, and interface text size) in their UI: sizes are scaled relative to the app-wide value, and a configured font family is applied to plugin text.

## Installation

Install from this Git repository — the plugin directory in the repository is appended to the source with `:`, so each plugin has its own source string:

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:command-center
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:session-manager
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:bunny-search
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash-client
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
| [remote-control](./remote-control/README.md) | 1.2.0 | 0.17.1 (2026-11-21) | `>=0.16.0` | `@getpaseo/plugin ^0.17.1` | Compatible as-is — [__status.md](./remote-control/__status.md) | [__compatibility.md](./remote-control/__compatibility.md) |
| [obsidian-bridge](./obsidian-bridge/README.md) | `npm ci`, `npm run bundle` | `esbuild` for the standalone MCP server bundle |

The three plugins with a bundle build step need npm-registry access on the host during install and update; the other two have no external dependency at all.

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
| [session-manager](./session-manager/README.md) | 0.7.1 | 0.17.1 (2026-11-21) | `>=0.15.0` | `@getpaseo/plugin ^0.17.1` | Compatible — [__status.md](./session-manager/__status.md) | [__compatibility.md](./session-manager/__compatibility.md) |
| [command-center](./command-center/README.md) | 0.14.4 | 0.17.1 (2026-11-21) | `>=0.17.0` | `@getpaseo/plugin ^0.17.1` + `@getpaseo/client ^0.17.1` | Compatible — [__status.md](./command-center/__status.md) | [__compatibility.md](./command-center/__compatibility.md) |
| [memory-flash](./memory-flash/README.md) | 0.15.1 | 0.17.1 (2026-11-21) | `>=0.17.0` | `@getpaseo/plugin ^0.17.1` | Compatible — [__status.md](./memory-flash/__status.md) | [__compatibility.md](./memory-flash/__compatibility.md) |
| [bunny-search](./bunny-search/README.md) | 0.9.8 | 0.17.1 (2026-11-21) | `>=0.17.0` | `@getpaseo/plugin ^0.17.1` | Compatible — [__status.md](./bunny-search/__status.md) | [__compatibility.md](./bunny-search/__compatibility.md) |
| [memory-flash-client](./memory-flash-client/README.md) | 0.8.1 | 0.17.1 (2026-11-21) | `>=0.17.0` | `@getpaseo/plugin ^0.17.1` | Compatible — [__status.md](./memory-flash-client/__status.md) | [__compatibility.md](./memory-flash-client/__compatibility.md) |
| [remote-control](./remote-control/README.md) | 1.0.1 | 0.16.0 (2026-11-16) | `>=0.11.0` | `@getpaseo/plugin 0.16.0` (dev pin) | Compatible as-is — [__status.md](./remote-control/__status.md) | [__compatibility.md](./remote-control/__compatibility.md) |
| [obsidian-bridge](./obsidian-bridge/README.md) | 0.26.23 | 0.17.1 (SDK 0.17.3, 2026-11-23) | `>=0.17.0` | `@getpaseo/plugin ^0.17.1` | Compatible — [__status.md](./obsidian-bridge/__status.md) | [__compatibility.md](./obsidian-bridge/__compatibility.md) |

The table keeps only a short verdict. The per-release status notes, known gaps and maintenance details behind it live in each plugin's `__status.md` (linked from the *Status* column); extended compatibility information — SDK surface diffs, pass evidence and footnotes — lives in its `__compatibility.md` (linked from *Details*) and in its `__doc.md`.
