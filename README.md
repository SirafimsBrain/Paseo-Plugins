# Paseo Plugins

This repository contains my plugin developments for the [Paseo](https://paseo.sh/) project.

All code is written for personal use. The plugins here can be used in the Paseo project without any restrictions.

## Plugins

- [session-manager](./session-manager/README.md) — lists and deletes the on-disk sessions of the coding agents connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) through a workspace panel and Command Center item; the listing cache is dropped whenever an agent session closes, a Command Center action reopens a session to rescan it, and the panel filters persist per tab.
- [command-center](./command-center/README.md) — a personal command center for Paseo: save reusable prompt and shell commands as templates (with per-command MCP server attachment), group them into categories, search them, run them against any workspace or agent with a live preview, browse run history with a configurable retention limit, schedule prompt commands on the standard Paseo scheduler with full tracking inside the plugin, insert commands from the composer attachment picker, and configure defaults and automation (auto-run on agent turn end, workspace bootstrap) in its own settings screen.
- [memory-flash](./memory-flash/README.md) — shared persistent memory for coding agents: a bundled stdio MCP server (SQLite + FTS5) that any agent connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) can read and write, automatic MCP injection into every Paseo-created agent, tagging by agent/project/kind (decision, procedure, handoff, bugfix, pattern, pitfall, reference, note), full revision history with restore, a Paseo screen for browsing/searching/editing/delegating memory maintenance to agents, one-button skill installation into agent skill directories, direct Cline MCP registration (Cline ignores session stdio servers, so the plugin writes its own settings file), and remote host registration (Paseo SSH implemented, tcp/relay stubbed), plus remote access over HTTP with API keys (Streamable HTTP at `/mcp`, keys generated and shown once with only the SHA-256 hash stored, `read`/`read_write` scopes, expiry, one-click delete, per-IP rate limiting, never logging the `Authorization` header) so other machines can share the same memory database. Search quality is measured rather than assumed: a text query ranks a pool of 50 and fuses several independent FTS5 views with Reciprocal Rank Fusion (no new dependency, no migration), and `memory_diagnose` reports recall@k over control queries while telling each miss apart as *never retrieved* or *ranked too low* — see [ROADMAP.md](./memory-flash/ROADMAP.md).
- [bunny-search](./bunny-search/README.md) — web search for coding agents: a bundled stdio MCP server with a `web_search` tool modeled on the proven SearXNG MCP, user-selectable search services (SearXNG by default, plus DuckDuckGo, Brave Search and any custom JSON endpoint), automatic MCP injection into every Paseo-created agent — re-applied on every session open so it reaches agents that already exist and survives the idle-runtime release, and gated per agent by a label or a provider exclusion list —, a native `bunny_web_search` agent tool for providers without MCP support, a "repair search tools" Command Center action, a Test connection button (real service probe + live MCP handshake check), a connected indicator (green/red dot with provider, base URL and latency) with a quick-search box, and an Open interface action that opens the search service's web interface in a Paseo browser tab (a separate setting, derived from the API URL's origin when unset).
- [memory-flash-client](./memory-flash-client/README.md) — connects this machine to remote [memory-flash](./memory-flash/README.md) memory hosts over HTTP with an API key: a connections registry (URL + key, owner-only file), a Test/Check probe that mirrors the real agent handshake (health + `initialize` + `tools/list`), a stable client identity (UUID + host name from settings) announced on every request so the memory host can log which client connected, automatic injection of the remote HTTP MCP servers into every Paseo-created agent, its own `memory-flash-remote` agent skill so the remote base is used as intensively as a local one, and an explicit coexistence check for the case where memory-flash and memory-flash-client live on the same host.
- [luck-planner](./luck-planner/README.md) — the project planning tree for coding agents: a SQLite-backed hierarchy of a project (tech-stack root, trunks, module branches and fact leaves with statuses, versions, revisions and an append-only audit trail), influence links between leaves (bees), blocking incidents (bugs), human-approved high goals with plans and growth records — all written through eleven MCP tools that are injected into every agent created through Paseo (and that can be registered directly in the agents' own config files, so they survive OpenCode's directory eviction and reach the terminal agents); a read-only dashboard on the loopback interface with a 2D diagram (full-text search, kind/status/version filters, a details panel, the growth heat layer, live updates over SSE) and a 3D WebGL scene of the same tree (bees flying along arcs, incidents pulsing over the leaves they block, goal rings floating over their subtree, click-to-select into the *same* details panel, a camera flight from the search, the 2D/3D choice remembered in the URL) that falls back to the diagram with a written reason when the browser has no WebGL; a native workspace panel, timeline rows for the two facts worth an audit line (a goal that crossed the approval gate, a leaf that reached `done`), and an agent skill that teaches when to write the tree.
- [remote-control](./remote-control/README.md) — a local-only remote control console for Paseo: a loopback web console (workspace browser tab) for groups/connections whose login **and password** are kept in a pass-backed secret vault (the database stores only secret names; the storage is created and unlocked once with a master password in the sidebar panel, and secrets exist only inside connections — no manual secret management), and a right-sidebar launch panel: SSH sessions open as native Paseo workspace tabs (`paseo.terminals.create`) with credentials materialised from the vault without leaking into argv/env, RDP/VNC open as external desktop windows (FreeRDP reads the password from stdin, TigerVNC gets a `vncpasswd -f` file), and the whole connection set — groups, parameters, stored passwords — moves between machines as one JSON export/import file, optionally sealed with a passphrase. Built with `npm ci`, `npm run bundle`; depends on `esbuild`.

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

| Plugin | Verified Paseo | SDK | Result |
| ------ | -------------- | --- | ------ |
| [session-manager](./session-manager/README.md) | **0.14.0 (2026-10-30)** ¹ ⁵, **0.13.0 (2026-10-24)** ¹ ³ | `@getpaseo/plugin@^0.14.0` (pin `^0.14.0`, `requirements.paseo >=0.14.0`) | **0.14.0: compatible, and both deprecations 0.13.0 left in it are now migrated — shipped as 0.2.3, with §18.3's recommendations implemented the same day as 0.3.3.** The panel imports `ScrollView` / `useToast` from `@getpaseo/plugin/client/ui` instead of the `client/react-native` entry that goes away on 2027-04-20, and `addWorkspacePanel` no longer passes the `@deprecated` `context: "workspace"` field — the shipped renderer accepts `undefined` and normalises it to `"workspace"`, so behaviour is identical (verified by reading the 0.14.0 bundle, not assumed); the `context` fields on the four `addCommandCenterItem` calls stay, because there it is a required union discriminant. The floor follows the API actually used: `requirements.paseo` `>=0.8.0` → `>=0.13.0`, since `client/ui` has carried those two exports only since 0.13.0; the real 0.14.0 host rejects the manifest for a 0.12.0 daemon and accepts 0.13.0 / 0.14.0. Evidence: typecheck + vitest **8 suites / 70 tests** against SDK 0.14.0, both entries built by the real 0.14.0 host compiler (`compileDirectoryPlugin`) with zero deprecated calls — plus a negative control that *does* find the old specifier — and `running` in an isolated 0.14.0 daemon with `[paseo] Plugin ready` and seven RPC methods registered. **0.3.3** implements three of the four §18.3 recommendations — the listing cache is dropped on the new `agent.closed` event instead of ageing out after 30 s, a `context: "agent"` Command Center action reopens the session through the new `agents.ref(id).reload()` and rescans with a cold cache, and the panel's three filters moved to `useTabState` so they survive a reload. The fourth ("stop runtime, keep the session") was investigated and **cannot be built from a plugin**: `session.can_stop_runtime` is answered inside the provider protocol and consumed by the host's own idle-runtime cleanup, and `PaseoApi` exposes no stop/close/release call — evidence in [§18.5](./session-manager/__doc.md#185-implementation-of-183-2026-10-30-shipped-as-033). Because `reload()` does not exist in `@getpaseo/client@0.13.2`, the floor moved `>=0.13.0` → `>=0.14.0` (the real host rejects the manifest for 0.13.0 / 0.13.2 and accepts 0.14.0); evidence for 0.3.3: typecheck + vitest **9 suites / 74 tests** and both entries built by the real 0.14.0 host compiler with `deprecatedHits: []`. **0.13.0 (2026-10-24)** ¹ ³: compatible, no code change, the two deprecations recorded but deliberately not migrated (the migration is this release). **0.12.0 (2026-10-21)** ¹: compatible, shipped as 0.2.2, whose one real finding was two `localStorage` reads outside `client/web.ts` (fixed). No install-time build step. Details: [Compatibility](./session-manager/__doc.md#compatibility), [§18](./session-manager/__doc.md#18-paseo-0140--compatibility-pass-2026-10-30), [§17](./session-manager/__doc.md#17-paseo-0130--compatibility-pass-2026-10-24), [§16](./session-manager/__doc.md#16-paseo-0120--spec-conformance-2026-10-21). |
| [command-center](./command-center/README.md) | **0.13.0 (2026-10-24)** ¹ ³ | `@getpaseo/plugin@0.13.0` + `@getpaseo/client@0.13.0` | **Compatible with 0.13.0, no code change** (typecheck + vitest: 9 suites, 98 tests; the real 0.13.0 host compiler builds both entries; `running` on a live 0.13.0 daemon with `Plugin ready`). The two 0.13.0 changes that could have bitten it did not: all nine `schedule*` methods the scheduler bridge calls are present in `@getpaseo/client@0.13.0` with **byte-identical** option/payload types, and the `agent.turn_ended` handler reads only `event.outcome` — the hook's `timeline` is now always empty in 0.13.0. One deprecation remains: the UI import still comes from the deprecated `@getpaseo/plugin/client/react-native` entry. **0.12.0 (2026-10-21)** ¹: compatible, shipped as 0.5.2 (screen/sidebar migration, `requirements.paseo` `>=0.8.0` → `>=0.11.0`, `localStorage` moved into `client/web.ts`); 0.5.1 fixed installation from a clean checkout. Details: [Compatibility](./command-center/__doc.md#6-compatibility), [§11](./command-center/__doc.md#11-paseo-0130--compatibility-pass-2026-10-24), [§10](./command-center/__doc.md#10-paseo-0120--spec-conformance-2026-10-21). |
| [memory-flash](./memory-flash/README.md) | **0.14.0 (2026-10-29)** ¹ ⁴, **0.13.0 (2026-10-24)** ¹ ³ | `@getpaseo/plugin@0.14.0` (pin `^0.14.0`, `requirements.paseo >=0.14.0`) | **0.14.0: compatible, and its new surface is used — no deprecated API exists in the plugin.** Shipped as **0.9.4**: the compatibility pass (0.8.4) also strengthened the agent recommendation (frontmatter `description` that opens with *mandatory, not optional*, a new `## The non-negotiable baseline` checklist with anti-shortcut rules, and `memory_save`/`memory_search`/`memory_handoff` tool descriptions), and **0.9.4 implements all four recommendations from the pass**: MCP injection in `before("agent.session_open")` (re-derived on every open, so it reaches already created agents and survives eviction — contributing the server only when the agent's saved config does not carry that name, since a collision fails the open; the saved set is read from the daemon's agent record and every unreadable state skips), a read-only `memory_flash_recall` tool attached via `defineAgentTool`, a "repair memory tools" Command Center action on the new `agents.ref(id).reload()`, and MCP `instructions` in `initialize`. Evidence: typecheck + vitest **16 suites, 192 tests**, both entries built by the real 0.14.0 host compiler with zero deprecated calls, `running` on the live 0.14.0 daemon. **0.13.0: compatible, no code change and no deprecated API left in it** (typecheck + vitest: **15 suites, 166 tests**, incl. a real-process stdio MCP e2e, an MCP handshake that survives a simulated plugin update, and a live HTTP endpoint suite driving the server with `fetch`; the real 0.13.0 host compiler builds both entries with zero deprecated calls; `running` on a live 0.13.0 daemon with `Plugin ready`). **0.12.0 (2026-10-21)** ¹: compatible, shipped as 0.8.3 (screen/sidebar migration, `requirements.paseo` `>=0.10.0` → `>=0.11.0`, `client/web.ts` fix); `#7023` made the old 0.5.1 protocol-type-import workaround non-load-bearing (kept, harmless). Earlier: 0.5.0 remote-access HTTP transport with API keys; 0.6.0 outright key deletion and a rewritten agent skill; 0.7.0 Reciprocal Rank Fusion over several FTS5 views plus `memory_diagnose`; 0.7.1 a revision-independent MCP entry path. Details: [Compatibility](./memory-flash/__doc.md#10-compatibility), [§18](./memory-flash/__doc.md#18-paseo-0140--compatibility-pass-2026-10-29), [§17](./memory-flash/__doc.md#17-paseo-0130--compatibility-pass-2026-10-24), [§16](./memory-flash/__doc.md#16-paseo-0120--spec-conformance-2026-10-21). |
| [bunny-search](./bunny-search/README.md) | **0.14.0 (2026-10-30)** ¹ ⁵, **0.13.0 (2026-10-24)** ¹ ³ | `@getpaseo/plugin@^0.14.0` (pin `^0.14.0`, `requirements.paseo >=0.14.0`) | **0.14.0: compatible, no code change and no deprecated API in it** — it stayed **0.4.2** through the pass, with no bump and no tag, because the pass touched only documentation; the same day's implementation release is **0.5.2**. 0.14.0 adds no new `@deprecated` marks (byte-identical to 0.13.0) and its `dist/client/` did not move, and `server.before("agent.create")` — the plugin's only hook — is still the supported spelling: `server.addHook` is claimed by the deployed hooks page but exists neither in `@getpaseo/plugin@0.14.0` nor in the installed host. Evidence: typecheck + vitest **9 suites / 95 tests** (2 live-search tests skipped by default) against SDK 0.14.0, both entries built by the real 0.14.0 host compiler with zero deprecated calls, the manifest accepted with its `>=0.11.0` floor (rejected for a 0.10.0 daemon), `running` in an isolated 0.14.0 daemon with `[paseo] Plugin ready` and the settings mirror written. **0.5.2 implements all five recommendations of [§15.2](./bunny-search/__doc.md#152-recommendations-for-improvement-recorded-during-the-pass-implemented-in-052)** — recorded by the pass, built when it was asked for; what was built is in [§15.4](./bunny-search/__doc.md#154-implementation-of-152-2026-10-30-shipped-as-052): MCP injection in `before("agent.session_open")` re-derived on every open (so it reaches agents created before `injectIntoAgents` was switched on and survives the idle-runtime release), collision-safe because the agent's saved `mcpServers` are read from the daemon record and every unreadable state fails safe to *skip*; a native `bunny_web_search` tool via `defineAgentTool` for providers without MCP support; a "repair search tools" Command Center action on `agents.ref(id).reload()`; per-agent gating by label (`labelGateKey`) and provider (`skipProviders`); and MCP `instructions` in `initialize`. Because those APIs are 0.14.0's, the pin became `^0.14.0` and the floor `>=0.11.0` → `>=0.14.0`. Evidence for 0.5.2: typecheck + vitest **10 suites / 133 tests** (2 live-search tests skipped), both entries built by the real 0.14.0 host compiler with `deprecatedHits: []`, manifest rejected for 0.13.0 / 0.13.2 and accepted for 0.14.0. **0.13.0 (2026-10-24)** ¹ ³: compatible, no code change. **0.12.0 (2026-10-21)** ¹: compatible, shipped as 0.4.2 (screen/sidebar migration, `requirements.paseo` `>=0.10.0` → `>=0.11.0`, `client/web.ts` fix); 0.2.1 fixed installation from a clean checkout. Details: [Compatibility](./bunny-search/__doc.md#7-compatibility), [§15](./bunny-search/__doc.md#15-paseo-0140--compatibility-pass-2026-10-30), [§14](./bunny-search/__doc.md#14-paseo-0130--compatibility-pass-2026-10-24), [§13](./bunny-search/__doc.md#13-paseo-0120--spec-conformance-2026-10-21). |
| [memory-flash-client](./memory-flash-client/README.md) | **0.14.0 (2026-10-29)** ¹ ⁴, **0.13.0 (2026-10-24)** ¹ ³ | `@getpaseo/plugin@0.14.0` (pin `^0.14.0`, `requirements.paseo >=0.14.0`) | **0.14.0: compatible, and its new surface is used — no deprecated API exists in the plugin.** Shipped as **0.3.2**: the compatibility pass (0.2.2) strengthened the agent recommendation (frontmatter `description` + a new `## The non-negotiable baseline` checklist), and **0.3.2 implements the pass's recommendations** — the remote HTTP servers are now also contributed in `before("agent.session_open")` (re-derived on every open, skipping any name the agent's saved config already carries, with the saved set read from the daemon's agent record and every unreadable state failing safe to *skip*), plus a "repair remote memory tools" Command Center action on the new `agents.ref(id).reload()`; `defineAgentTool` stays deliberately unused — the tools belong to the remote host. Evidence: typecheck + vitest **6 suites, 61 tests**, both entries built by the real 0.14.0 host compiler with zero deprecated calls, manifest accepted; **limited live evidence** (installed but `disabled` on this machine). Still installs with **no build step**. Requires Memory Flash 0.5.0+ with the HTTP endpoint on the remote host. **0.13.0: compatible, no code change and no deprecated API left in it** (typecheck + vitest: 6 suites, 53 tests, incl. an HTTP probe against a stub memory-flash server, MCP-injection tests, a settings-schema round-trip regression and an agent-skill suite; the real 0.13.0 host compiler builds both entries with zero deprecated calls; the 0.13.0 manifest schema accepts it). **No live 0.13.0 evidence**: the plugin is not installed on the machine the pass ran on. Still installs with **no build step** — every import is host-supplied, so no npm-registry access is needed. Requires Memory Flash 0.5.0+ with the HTTP endpoint on the remote host. **0.12.0 (2026-10-21)** ¹: compatible, shipped as 0.2.1. Details: [Compatibility](./memory-flash-client/__doc.md#12-compatibility), [§17](./memory-flash-client/__doc.md#17-paseo-0140--compatibility-pass-2026-10-29), [§16](./memory-flash-client/__doc.md#16-paseo-0130--compatibility-pass-2026-10-24), [§15](./memory-flash-client/__doc.md#15-paseo-0120--spec-conformance-2026-10-21). |
| [luck-planner](./luck-planner/README.md) | **0.12.0 (2026-10-22)** ¹ ² | `@getpaseo/plugin@0.12.0` | Compatible (typecheck + vitest: **36 suites, 611 tests**, incl. a real-process stdio MCP e2e, a live HTTP endpoint suite with an SSE stream, the 2D/3D bundle-split contracts, the 3D frame budget at 10k nodes and the client audit of §10.5). **0.32.2** is the plugin's own 0.12.0 conformance pass (the 2026-10-21 pass deliberately skipped it while it was in development): the SDK diff `0.11.0 → 0.12.0` is additive and touches only the ACP and provider declarations this plugin does not use, so `requirements.paseo` stays `>=0.11.0`; the plugin never used the deprecated `addSurface`/`addSidebarItem`/`openSurface`; and its one real spec violation — a `localStorage` read outside `client/web.ts` — is fixed, with the spec's client audit now a test. Improved on the new SDK: `layout.compact` in the settings and dashboard screens, and the dashboard address as a real `ExternalLink`. Verified live on a 0.12.0 daemon (scratch home): the install, `Plugin ready`, a clean `paseo plugin reload`, the published MCP entry answering `initialize`/`tools/list`/`luck_tree_search`, the dashboard `/health`, and both entries built by the **real 0.12.0 host compiler** (`compilePlugin`, taken from the installed app) with zero deprecated calls. Earlier acceptance (0.29.1–0.29.4) fixed three defects only the host's build and the daemon's lifecycle could show. Details: [Compatibility](./luck-planner/__doc.md#10-compatibility), [§10.5](./luck-planner/__doc.md#105-paseo-0120-spec-conformance-0322), [§10.6](./luck-planner/__doc.md#106-the-host-compiler-as-the-oracle). |

¹ Typecheck, vitest and a static reproduction of the host's bundler boundary check (the same `ts.resolveModuleName` walk the desktop app runs, replayed against a staged copy of each plugin with the manifest `build` commands executed first). Plus a live install into an isolated Paseo **0.12.0** daemon (scratch home, production config untouched) on 2026-10-21: all five installed from their working trees as `running`, logged `Plugin ready` with no client-contribution errors, reloaded cleanly via `paseo plugin reload` (the fixed `#6306` flow), and every client entry built with the real 0.12.0 host compiler (`compilePlugin`) — the compiled bundles contain the new screen/sidebar API and zero deprecated calls. Live server-side effects were observed where the plugin has any: bunny-search wrote its settings mirror and memory-flash created `memory.db`.

² luck-planner was deliberately excluded from the 2026-10-21 0.12.0 conformance pass because it was still in development; it had its own pass on 2026-10-22 (luck-planner 0.32.2, §10.5 of its `__doc.md`), with the same evidence: typecheck, vitest, a live install into an isolated 0.12.0 daemon (the git working tree, `running`, `Plugin ready`, a clean reload, the published MCP entry answering, the dashboard's `/health`) and the real 0.12.0 host compiler building both entries. The 2026-10-19 acceptance that preceded it — the git install, the MCP round trip, a goal approval, the dashboard in the host browser, the SSE, both themes, the console and the frame rate — found three defects that only the host's build and the daemon's lifecycle could show; they are fixed in 0.29.1–0.29.4 and pinned by tests.

³ The 2026-10-24 pass against the stable **0.13.0** release (2026-10-24) — release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.13.0>. Both SDK packages were unpacked from npm and diffed `0.12.0 → 0.13.0`, then installed into each plugin with `npm install --no-save --package-lock=false`, so **`package.json` / `package-lock.json` still pin `0.12.0`** on purpose: the host supplies the SDK at bundle and run time, no plugin code needed a 0.13.0 API, and raising the pin would be a code change carrying its own version bump. Evidence: typecheck + vitest green against `@getpaseo/plugin@0.13.0` (and `@getpaseo/client@0.13.0` for command-center) — 47 suites / 482 tests in total; both entries of every plugin built by the **real 0.13.0 host compiler** (`compilePlugin` and `plugin-sdk-specifiers.js` extracted from the installed `app.asar`) with no bundler-boundary errors; every `paseo-plugin.json` accepted by the real 0.13.0 `readPluginManifest`; and four of the five already installed and `running` on this machine's live 0.13.0 daemon, logging `Plugin ready` with no plugin errors in the daemon or app logs (memory-flash-client is not installed on that machine). The workspace was left with `package.json` and `package-lock.json` untouched — the SDKs in `node_modules` were restored to 0.12.0 afterwards.

⁴ The 2026-10-29 pass against the stable **0.14.0** release (2026-10-29) — release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.14.0>. Scope: **memory-flash and memory-flash-client only**, the two plugins this task named; the other four were not re-checked *in that pass* — bunny-search and session-manager were picked up the next day (footnote ⁵), while command-center and luck-planner still keep their 0.13.0 / 0.12.0 verdicts. Method: the three SDK tarballs (`@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`) unpacked from npm and diffed `0.13.0 → 0.14.0`, then installed into each plugin with `npm install --no-save --package-lock=false` — at pass time **`package.json` / `package-lock.json` still pinned `0.12.0`**, since no code needed a 0.14.0 API yet. Evidence: typecheck + vitest green against `@getpaseo/plugin@0.14.0` — **21 suites / 219 tests** in total; both entries of both plugins built by the **real 0.14.0 host compiler** (`compileDirectoryPlugin`, `readPluginManifest` extracted from the installed `app.asar`) with no bundler-boundary errors and **zero deprecated calls** in the bundles; memory-flash `running` on this machine's live 0.14.0 daemon with `[paseo] Plugin ready`. The pass's own code change was the strengthened agent skill (0.8.4 / 0.2.2); the follow-up release **0.9.4 / 0.3.2** then implemented the recommendations below for real — at which point the pin became `^0.14.0`, `requirements.paseo` `>=0.14.0`, and the totals became **22 suites / 253 tests**.

⁵ The 2026-10-30 continuation of the same 0.14.0 pass, scoped to the two plugins footnote ⁴ left out — **bunny-search and session-manager** (release notes as in ⁴). Same method: `@getpaseo/plugin@0.14.0` unpacked from npm, installed into bunny-search with `npm install --no-save --package-lock=false` so its `package.json` / `package-lock.json` keep the `0.12.0` pin on purpose, and into session-manager with a real pin bump to `^0.14.0` (its migration needs `client/ui`'s `ScrollView` / `useToast`, which 0.12.0's typings do not have). Evidence: typecheck + vitest green against the 0.14.0 SDK — bunny-search **9 suites / 95 tests** (2 live tests skipped by default), session-manager **8 suites / 70 tests**; both entries of both plugins built by the **real 0.14.0 host compiler** (`compileDirectoryPlugin` and `readPluginManifest` extracted from the installed `app.asar`) with no boundary errors, **0 warnings** and zero deprecated calls; the floors enforced by that same host code (bunny-search accepted at 0.11.0 / 0.14.0 and rejected at 0.10.0, session-manager accepted at 0.13.0 / 0.14.0 and rejected at 0.12.0); and both installed **from the working tree into an isolated 0.14.0 daemon** — a scratch home on its own loopback port with `pluginsEnabled: true`, production home untouched — where each is `running` with `[paseo] Plugin ready`, its RPC methods registered and no plugin or contribution errors in the daemon log (bunny-search also wrote its settings mirror). One negative control: a copy of session-manager with the old `client/react-native` import restored compiles to a bundle that *does* contain the deprecated specifier, so the clean scans are meaningful. bunny-search needed no code change (stays 0.4.2, no tag); session-manager migrated the two deprecations 0.13.0 had left in it ⇒ **0.2.3** with its annotated tag. command-center and luck-planner were not part of this pass and keep their earlier verdicts.

### Paseo 0.14.0 — new and deprecated SDK surface (2026-10-29)

Everything below comes from the `@getpaseo/plugin`, `@getpaseo/client` and
`@getpaseo/protocol` npm tarballs diffed `0.13.0 → 0.14.0`, cross-checked
against the [0.14.0 release notes](https://github.com/getpaseo/paseo/releases/tag/v0.14.0),
the deployed [plugin hooks reference](https://paseo.sh/docs/plugins/hooks.md)
and the host files inside the installed `app.asar`. It is the full inventory a
plugin of this repository has to care about; per-plugin impact is in each
plugin's `__doc.md`.

**New in 0.14.0** (all optional — none of it is a conformance requirement):

| Surface | What it gives you |
| -------- | ----------------- |
| `before("agent.session_open")` request gains `title`, `labels`, `tools`, `mcpServers` | Per-open, per-plugin **editable** maps: MCP servers and tools re-derived on every `create` / `resume` / `refresh` / `import` (`purpose` `interactive`/`history`), launch-only (never saved), merged in plugin-ID order, ignored for `purpose: "history"`. A name colliding with a *saved* server, the internal `paseo` server or another plugin **fails the session open**, and a provider without MCP support fails with it. Declaring the hook marks open sessions stale and reopens them before the next prompt — the mechanism that finally makes injected servers reach *existing* agents. |
| `defineAgentTool(...)` + `AgentToolDefinition` / `AgentToolContext` / `AgentToolResult` from `@getpaseo/plugin/server` | Give **individual agents** a plugin tool (selected by `agentId`, `provider`, `workspaceId` or `labels`) through Paseo's own tool transport, with no MCP config. Zod-validated input, `signal`, 10-minute call ceiling, a thrown error becomes `{ isError: true, text }`, and only metadata + inputs/results cross the process boundary. Names must match `/^[a-z][a-z0-9_]*$/`, ≤64 chars. |
| `PaseoAgentHandle.reload()` in `@getpaseo/client` | Reopen a provider session with current configuration, **rerunning session-open hooks**, interrupting a running turn, and return the refreshed snapshot — the programmatic form of "reconnect this agent's tools". |
| `FetchAgentTimelineOptions.wholeTurns` | Prefer whole-turn pages when the host supports them; older hosts keep item-based paging. |
| Provider capability `session.can_stop_runtime` (+ request/event) | Opt-in provider protocol addition; matters only to `registerProvider` authors. |
| `@getpaseo/client` `listLocalSpeechModels` / `downloadLocalSpeechModel` / `deleteLocalSpeechModel` | Backing for the new Voice settings and downloadable local models (SenseVoice, Whisper); not a plugin surface. |
| Host-side fixes that matter to plugins | Idle agent runtimes are released after an hour and the saved session resumes on the next prompt (a *session reopen* — exactly where `agent.session_open` re-injects); large Claude/OMP histories and plugin builds stall less; late tool updates no longer create duplicate timeline rows during overlapping turns. |

**Deprecated in 0.14.0: nothing new.** The `@deprecated` set in
`@getpaseo/plugin@0.14.0` is byte-identical to 0.13.0 — the
`client/react-native` entry (removal 2027-04-20, with `useRevealedText`), panel
`context`/`agentId`, `addSurface`/`addSidebarItem`/`openSurface`,
`SettingsGroup`, the always-empty `agent.turn_ended` `timeline`, and
`CreateAgentRequestOptions.git`/`worktreeName`. Nothing had to be migrated in
this repository, and 0.14.0 removes nothing these plugins use.

**One documentation discrepancy worth recording:** the deployed hooks page
says `server.addHook("agent.open.before")` "is available from Paseo 0.14", but
neither `@getpaseo/plugin@0.14.0` nor the installed 0.14.0 host contains
`addHook` anywhere (`grep -r addHook` over the extracted `app.asar`'s
`@getpaseo/**` returns nothing; the daemon dispatches `before` hooks keyed
`agent.session_open` from `runtime.js`). The type-safe 0.14.0 surface is
`server.before("agent.session_open")`; adopt `addHook` only when the SDK
actually ships it.

**The client half of the SDK did not move:** `diff -rq` over
`@getpaseo/plugin` reports changes only under `dist/server/` plus
`package.json`; `dist/client/` is byte-identical to 0.13.0, so every client
registration in this repository is untouched by construction.

### Paseo 0.14.0 compatibility pass (2026-10-29)

**memory-flash** and **memory-flash-client** were checked against stable
0.14.0 on 2026-10-29; **bunny-search** and **session-manager** followed on
2026-10-30 (footnote ⁵). **command-center** and **luck-planner** are still
out of scope, so their rows keep their 0.13.0 / 0.12.0 verdicts. Method and
evidence are in footnotes ⁴ and ⁵; per-plugin detail is in each plugin's
`__doc.md`. What the passes found:

- **No code change was required for 0.14.0 anywhere.** Typecheck is clean and
every test suite is green against `@getpaseo/plugin@0.14.0`, so the
`0.13.0 → 0.14.0` SDK diff removes nothing these plugins use — and the diff is
additive server-side only; the client SDK is byte-identical.
- **No deprecated API exists in either plugin**, and 0.14.0 deprecates
nothing new. Both keep importing UI from `@getpaseo/plugin/client` and
`@getpaseo/plugin/client/ui` and register only `addScreen` /
`addSidebarHeaderItem` / `addSettingsScreen` / `addCommandCenterItem`.
- **Two code changes rode along.** First, the agent recommendation to use
memory-flash and memory-flash-client was strengthened (skill frontmatter,
a new *non-negotiable baseline* checklist, and the tool descriptions) ⇒
**memory-flash 0.8.3 → 0.8.4** and **memory-flash-client 0.2.1 → 0.2.2**,
each with its annotated tag.
- **The 0.14.0 surface itself is now implemented, not just recommended** —
**memory-flash 0.9.4**, **memory-flash-client 0.3.2** (memory-flash §18.5,
memory-flash-client §17.5): MCP injection in `before("agent.session_open")`
re-derived on every open (so it reaches already created agents and survives
the idle-hour release), collision-safe by reading the agent's saved `mcpServers`
from the daemon's own record and skipping/failing safe on every unknown state;
a "repair memory tools" Command Center action on the new
`agents.ref(id).reload()`; a read-only `memory_flash_recall` attached via
`defineAgentTool` (memory-flash only — the client's tools belong to the remote
host); and MCP `instructions` in `initialize` (memory-flash only). Because
those are 0.14.0 APIs, both plugins raised their floor to `requirements.paseo
>=0.14.0` and pinned `@getpaseo/plugin@^0.14.0` in this release.
- **Verified with the real host compiler, not a re-implementation:**
`compileDirectoryPlugin` and `readPluginManifest` were taken from the
installed 0.14.0 `app.asar`, so the boundary walk, the exempt list and the
manifest schema are the daemon's own. All four entries build with no boundary
errors, and a string scan of the bundles finds no deprecated calls.
- **Manifests and floors:** both `paseo-plugin.json` files pass the real
0.14.0 parser. The pass kept the floors at `>=0.11.0` (a floor is an API
promise, not a record of the newest host tested); the follow-up release
raised both to `>=0.14.0` because the adopted APIs are 0.14.0's.
- **Live:** memory-flash is `running` on this machine's 0.14.0 daemon with
`[memory-flash] MCP entry: … (exists)` + `[paseo] Plugin ready` and no plugin
errors; memory-flash-client is installed but `disabled`, so its result is
compiler- and test-level only.
- **The second batch (2026-10-30, footnote ⁵) found exactly one place in this
repository where a deprecation was still live.** **bunny-search** needed
nothing: no deprecated API, no code change, no version bump — the improvement
recommendations written into `bunny-search/__doc.md` §15.2
instead, headed by contributing the MCP server in `before("agent.session_open")`
as well so injection reaches agents that already exist and survives the new
idle-runtime release. **session-manager** still carried both hits 0.13.0 left
in it, and both are now migrated: the UI import moved from
`@getpaseo/plugin/client/react-native` (removal 2027-04-20) to
`@getpaseo/plugin/client/ui`, and the `@deprecated` `context: "workspace"`
field was dropped from `addWorkspacePanel` — with the shipped renderer read
first to confirm it accepts `undefined` and normalises it, while the
`context` fields on `addCommandCenterItem` were kept because there the field
is a required union discriminant. Because `client/ui` only gained `ScrollView`
and `useToast` in 0.13.0, `requirements.paseo` moved `>=0.8.0` → `>=0.13.0`
(the floor still follows the API actually used, not the newest host tested) ⇒
**session-manager 0.2.3**. Recommendations for both plugins are recorded in
their `__doc.md` §15.2 / §18.3, and both sets were implemented the same day
when asked — each is new functionality and therefore its own second-digit
release: **bunny-search 0.5.2** (session-open injection, the
`bunny_web_search` agent tool, the repair action, label/provider gating and
MCP `instructions`; pin `^0.14.0`, floor `>=0.14.0`, 10 suites / 133 tests)
and **session-manager 0.3.3** (`agent.closed` cache invalidation, the refresh
action on `reload()`, `useTabState` filters; floor `>=0.13.0` → `>=0.14.0`, 9
suites / 74 tests). The one recommendation that could not be built is
session-manager's "stop runtime, keep the session": `session.can_stop_runtime`
is answered inside the provider protocol and consumed by the host's own
idle-runtime cleanup, and no plugin-facing call reaches it — evidence in
[§18.5](./session-manager/__doc.md#185-implementation-of-183-2026-10-30-shipped-as-033).

### Paseo 0.13.0 — new and deprecated SDK surface (2026-10-24)

Everything below comes from the `@getpaseo/plugin` and `@getpaseo/client`
npm tarballs diffed `0.12.0 → 0.13.0`, cross-checked against the [0.13.0
release notes](https://github.com/getpaseo/paseo/releases/tag/v0.13.0) and
against the host files shipped in the installed `app.asar`. It is the full
inventory a plugin of this repository has to care about; per-plugin impact is
in each plugin's `__doc.md`.

**New in 0.13.0** (all optional — none of it is a conformance requirement):

| Surface | What it gives you |
| -------- | ----------------- |
| `client.addFilePanel(...)` + `PluginFilePanelContribution` | Open matching files in the file tab (a PDF viewer, a rich Markdown editor): match by `files.extensions` / `files.filenames`, render `PluginFilePanelProps` — `file`, `params: { path, lineStart?, lineEnd? }`, `workspaceId`, `revision`, `tab`. |
| `@getpaseo/plugin/client` file API | `PluginFile`, `useFileBytes` / `useFileText` / `useFileUrl`, and `PluginFileConflictError` / `PluginFileDeletedError` for the file-tab panels above. |
| `client.addAgentPanel(...)` + `PluginAgentPanelContribution` | The supported way to contribute a *per-agent* panel — the replacement for `addWorkspacePanel({ context: "agent" })`. |
| `PluginPanelProps<Params>` | Every panel (workspace, agent, file) now receives `params`, `revision` and `tab` beside `workspaceId`; `PluginTab` exposes `setModified`, `state` and `setState`. |
| `useTabState(tab, schema, defaultState)` | Per-tab panel state that survives reloads, validated against a zod schema with the default used for missing/invalid values. |
| Translations (`defineTranslations`, `useTranslation`, `client.i18n`, `requirePluginText`, `isPluginMessage`) | Plugin labels follow the app language; `PluginText` = `string \| PluginMessage`, and **every human-readable contribution string — `title`, `label`, `description`, `argumentHint`, `pickerTitle`, `searchPlaceholder`, the theme `name` — is now generic over it** (identifiers such as a slash command's `name` stay `string`), so a plain `string` remains valid everywhere and nothing had to change in this repository. Manifest `translations` + `OVERVIEW.<locale>.md` cover the plugin listing. |
| `@getpaseo/plugin/client/ui` | Now the single home for plugin UI: it also exports `Markdown` (host renderer, theme and link behaviour), `StreamedText` (replaces `useRevealedText`), `Loading`, `DocumentFrame`, and `Icon` accepts `{ icon }` (component or inline SVG) as well as `{ name }` (Lucide). |
| Icons (`@getpaseo/plugin` root + `client/ui`) | `PluginIcon`, `PluginSerializableIcon` (Lucide name or `{ svg }`), `PluginSvgIcon`, `findSvgIconProblem`, `PLUGIN_SVG_ICON_MAX_BYTES`; `PluginIconProps` moved from `client/contracts` to the new `icons` module and is still re-exported from `client` and `client/ui`; `SidebarIcon` accepts a component or SVG too. |
| `@getpaseo/client` | `PaseoApi.hosts` (`listHosts` / `observeHosts` / `addHost` / `updateHost` / `requireConnectedHosts`) for delegating to other machines, `PaseoAgentHandle.address`, `createWorkspace({ source, agent, idempotencyKey })`, `parent?: AgentAddress`, `DaemonClientConfig.sessionPermissions`, relay security (`minimumMode`, `onSecurityMode`) and a richer `DaemonConnectionError`. |
| Host-side fixes that matter to plugins | Plugin header buttons now show in the workspace ··· menu on phones and narrow windows (`#7630`); notification timeline transformers no longer fail with `invalid item type: notification` (`#7582`); reopened ACP plugin agents no longer open an empty chat (`#7717`). |
| Packaging | Peers are now `@getpaseo/client@0.13.0` + `@getpaseo/protocol@0.13.0`, `react >=19.1.0 <20` (was `~19.1.0`), `react-native >=0.81.5`; the SDK itself gained an `i18next` dependency (host-supplied, not a plugin concern). The export map is unchanged. |

**Deprecated in 0.13.0** (working today; migrate when convenient):

| Deprecated | Use instead | Status in 0.13.0 |
| ---------- | ----------- | ---------------- |
| The `@getpaseo/plugin/client/react-native` entry point, including `useRevealedText` | `@getpaseo/plugin/client/ui`; `StreamedText` for streamed assistant text | Works. The host's exempt list keeps it under `COMPAT(pluginReactNativeEntrypoint): added in v0.13.0, remove after 2027-04-20` — **the entry and `useRevealedText` go away on 2027-04-20**. Imported by session-manager and command-center. |
| Panel `context` and `agentId` props (`PluginWorkspacePanelProps.context`, `PluginAgentPanelProps.context`, `PluginAgentPanelProps.agentId`) and `addWorkspacePanel`'s `context` field | `params.agentId` and `client.addAgentPanel(...)` | Works; `context?: "workspace"` is now optional, the `"agent"` variant is deprecated. Passed by session-manager. |
| `agent.turn_ended`'s `timeline` | It is **always empty**: `context.paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 })` | A silent behaviour change, not a type error. Only command-center listens, and it reads `event.outcome` only. |
| `SettingsGroup` | `SettingsSection` | Works; no plugin here uses it. |
| `@getpaseo/client` `CreateAgentRequestOptions.git` and `.worktreeName` | `createWorkspace({ source, agent, idempotencyKey })` | **Rejected by `createAgent` at runtime** — the one 0.13.0 change that can actually fail a plugin instead of merely nagging. `PaseoAgentCreateOptions.worktree` (used by command-center) is *not* deprecated. |

Carried over unchanged from 0.11/0.12: `addSurface`, `addSidebarItem` and
`openSurface` remain `@deprecated` in favour of `addScreen`,
`addSidebarHeaderItem`/`addSidebarFooterItem` and `openScreen`; no plugin in
this repository still calls them.

### Paseo 0.13.0 compatibility pass (2026-10-24)

All five finished plugins were checked against 0.13.0 (luck-planner was out
of scope for this pass, so its row above still reads 0.12.0). Method and
evidence are in footnote ³; per-plugin detail is in each plugin's `__doc.md`.
What the pass found:

- **No code change was required anywhere.** Typecheck is clean and every test
suite is green against `@getpaseo/plugin@0.13.0`, so the 0.12.0 → 0.13.0 SDK
diff removes nothing these plugins use.
- **Two plugins still import the deprecated `client/react-native` entry**
(session-manager: `ScrollView`, `useToast`; command-center: `Modal`,
`useToast`). They compile and run today and the host keeps the entry exempt
until 2027-04-20, so this is a migration, not a breakage — the compiled
bundles are otherwise free of deprecated calls.
- **session-manager still passes `context: "workspace"` to
`addWorkspacePanel`**, now a deprecated (and optional) field.
- **command-center's two risky 0.13.0 changes both miss it:** all nine
`schedule*` methods keep byte-identical option/payload types, and its
`agent.turn_ended` automation never reads the now-empty `timeline`.
- **Verified with the real host compiler, not a re-implementation:**
`compilePlugin` and `plugin-sdk-specifiers.js` were taken from the installed
0.13.0 `app.asar`, so the exempt list, the boundary walk and the bundle
settings are the daemon's own. All ten entries build with no boundary errors,
and a string scan of the bundles finds no `addSurface` / `addSidebarItem` /
`openSurface` / `useRevealedText` / `SettingsGroup` anywhere.
- **Manifests and floors:** all five `paseo-plugin.json` files pass the real
0.13.0 `readPluginManifest` (strict `requirements` schema). Floors are
unchanged — session-manager `>=0.8.0`, the other four `>=0.11.0` — because
0.13.0 adds nothing any of them uses, and a floor is an API promise, not a
record of the newest host tested.
- **Live:** four of the five are installed on this machine's 0.13.0 daemon and
`running`, logging `Plugin ready` with no plugin errors. memory-flash-client
is not installed there, so its 0.13.0 evidence is compiler- and test-level
only.
- **Not adopted, on purpose** (new in 0.13.0, optional, none a blocker): file
panels, `addAgentPanel`, `useTabState`, plugin translations/i18n, `Markdown`,
`StreamedText`, inline-SVG icons, `createWorkspace`, and `PaseoApi.hosts`.

Per-plugin evidence: session-manager §17, command-center §11, memory-flash
§17, bunny-search §14, memory-flash-client §16.

### Paseo 0.12.0 conformance pass (2026-10-21)

All five finished plugins were audited against the stable 0.12.0 release
(2026-10-19) and verified with typecheck + vitest against
`@getpaseo/plugin@0.12.0`. What that pass found:

- **The SDK diffs are additive.** `@getpaseo/plugin@0.10.1 → 0.12.0` removes
nothing these plugins use, and the `0.11.0 → 0.12.0` client declarations are
byte-identical — the screen/sidebar API landed in 0.11.0, which is why the
four migrated plugins declare `requirements.paseo: >=0.11.0` rather than
`>=0.12.0`.
- **Four plugins migrated off deprecated client API.** `addSurface`,
`addSidebarItem` and `openSurface` are `@deprecated` in the SDK in favour of
`addScreen`, `addSidebarHeaderItem`/`addSidebarFooterItem` and `openScreen`.
They still work — the 0.12.0 host ships them as shims — so this was a
migration for correctness, not a breakage fix. session-manager never used
them, so it needed no migration and keeps its honest `>=0.8.0` floor.
- **One real spec violation, in all five plugins.** 0.12.0's client audit
treats a cross-platform module touching a DOM global outside `client/web.ts`
as a bug; every plugin read `globalThis.localStorage` in
`use-host-typography.ts` (session-manager did it twice). Each now has a
`client/web.ts` gated on `Platform.OS === "web"` with a native fallback.
- **A documented removal date was wrong.** These plugins' notes previously
said the compatibility shims were "scheduled for removal after 2027-03-29".
That date belongs to unrelated `COMPAT(...)` markers in 0.12.0; the
surface/sidebar shims carry no removal marker and the SDK tags state no
version. Corrected in every plugin's docs.
- **Not adopted, on purpose** (none is a conformance blocker): host-managed
`spawnProcess`/`terminateProcess`, deep links through `PluginScreenProps.params`,
`agent.closed` lifecycle hooks, `registerUsageSource`, and registry metadata
(`name`/`icon`/`media` + `OVERVIEW.md`).
- **All five verified live on a real 0.12.0 daemon.** Each was installed from
its working tree into an isolated home (production config untouched): status
`running`, `Plugin ready` in the log, a clean `paseo plugin reload` (the fixed
`#6306` flow — every plugin restarts and re-registers), and every client entry
built by the real 0.12.0 host compiler with zero deprecated calls in the
compiled bundle. See footnote ¹ for the full evidence.

Per-plugin evidence: bunny-search §13, command-center §10, memory-flash §16,
memory-flash-client §15, session-manager §16, luck-planner §10.5.

### luck-planner's own 0.12.0 pass (2026-10-22)

luck-planner was in development when the pass above ran, so it had its own
audit in 0.32.2 — the same method, on the plugin the others had skipped:

- **The SDK diff touches nothing it uses.** `@getpaseo/plugin@0.11.0 →
  0.12.0` changes only `AcpOptions.workspaceOnlyCatalog` and
  `ProviderRegistration.requiresConfiguration`; the client declarations are
  byte-identical, so the manifest floor stays `>=0.11.0` (the API floor, not
  the tested version).
- **No deprecated client API.** The plugin registers `addScreen`,
  `addWorkspacePanel`, `addSettingsScreen`, `addCommandCenterItem`,
  `addSlashCommand` and `addTimelineRenderer`, and opens its screen with
  `openScreen` — the compiled client bundle has zero deprecated calls.
- **One real spec violation, fixed.** The host's interface size was read from
  `globalThis.localStorage` in `client/use-host-typography.ts`, outside the
  one module allowed to name a DOM global. The read moved to
  `client/web.ts` (gated on `Platform.OS === "web"`), the parsing to a pure
  module, and the spec's client audit now runs as a test.
- **Two improvements on the new SDK:** `layout.compact` in the settings and
  dashboard screens, and the dashboard address as a real `ExternalLink`.
- **The real host compiler as the oracle:** `compilePlugin` was taken from the
  installed 0.12.0 application and pointed at the plugin's working tree — the
  same build the daemon performs at install time.
