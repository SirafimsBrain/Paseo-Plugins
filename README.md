# Paseo Plugins

This repository contains my plugin developments for the [Paseo](https://paseo.sh/) project.

All code is written for personal use. The plugins here can be used in the Paseo project without any restrictions.

## Plugins

- [session-manager](./session-manager/README.md) — lists and deletes the on-disk sessions of the coding agents connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) through a workspace panel and Command Center item.
- [command-center](./command-center/README.md) — a personal command center for Paseo: save reusable prompt and shell commands as templates (with per-command MCP server attachment), group them into categories, search them, run them against any workspace or agent with a live preview, browse run history with a configurable retention limit, schedule prompt commands on the standard Paseo scheduler with full tracking inside the plugin, insert commands from the composer attachment picker, and configure defaults and automation (auto-run on agent turn end, workspace bootstrap) in its own settings screen.
- [memory-flash](./memory-flash/README.md) — shared persistent memory for coding agents: a bundled stdio MCP server (SQLite + FTS5) that any agent connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, acpx) can read and write, automatic MCP injection into every Paseo-created agent, tagging by agent/project/kind (decision, procedure, handoff, bugfix, pattern, pitfall, reference, note), full revision history with restore, a Paseo screen for browsing/searching/editing/delegating memory maintenance to agents, one-button skill installation into agent skill directories, direct Cline MCP registration (Cline ignores session stdio servers, so the plugin writes its own settings file), and remote host registration (Paseo SSH implemented, tcp/relay stubbed), plus remote access over HTTP with API keys (Streamable HTTP at `/mcp`, keys generated and shown once with only the SHA-256 hash stored, `read`/`read_write` scopes, expiry, one-click delete, per-IP rate limiting, never logging the `Authorization` header) so other machines can share the same memory database. Search quality is measured rather than assumed: a text query ranks a pool of 50 and fuses several independent FTS5 views with Reciprocal Rank Fusion (no new dependency, no migration), and `memory_diagnose` reports recall@k over control queries while telling each miss apart as *never retrieved* or *ranked too low* — see [ROADMAP.md](./memory-flash/ROADMAP.md).
- [bunny-search](./bunny-search/README.md) — web search for coding agents: a bundled stdio MCP server with a `web_search` tool modeled on the proven SearXNG MCP, user-selectable search services (SearXNG by default, plus DuckDuckGo, Brave Search and any custom JSON endpoint), automatic MCP injection into every Paseo-created agent, a Test connection button (real service probe + live MCP handshake check), a connected indicator (green/red dot with provider, base URL and latency) with a quick-search box, and an Open interface action that opens the search service's web interface in a Paseo browser tab (a separate setting, derived from the API URL's origin when unset).
- [memory-flash-client](./memory-flash-client/README.md) — connects this machine to remote [memory-flash](./memory-flash/README.md) memory hosts over HTTP with an API key: a connections registry (URL + key, owner-only file), a Test/Check probe that mirrors the real agent handshake (health + `initialize` + `tools/list`), a stable client identity (UUID + host name from settings) announced on every request so the memory host can log which client connected, automatic injection of the remote HTTP MCP servers into every Paseo-created agent, its own `memory-flash-remote` agent skill so the remote base is used as intensively as a local one, and an explicit coexistence check for the case where memory-flash and memory-flash-client live on the same host.
- [luck-planner](./luck-planner/README.md) — the project planning tree for coding agents: a SQLite-backed hierarchy of a project (tech-stack root, trunks, module branches and fact leaves with statuses, versions, revisions and an append-only audit trail), influence links between leaves (bees), blocking incidents (bugs), human-approved high goals with plans and growth records — all written through eleven MCP tools that are injected into every agent created through Paseo (and that can be registered directly in the agents' own config files, so they survive OpenCode's directory eviction and reach the terminal agents); a read-only dashboard on the loopback interface with a 2D diagram (full-text search, kind/status/version filters, a details panel, the growth heat layer, live updates over SSE) and a 3D WebGL scene of the same tree (bees flying along arcs, incidents pulsing over the leaves they block, goal rings floating over their subtree, click-to-select into the *same* details panel, a camera flight from the search, the 2D/3D choice remembered in the URL) that falls back to the diagram with a written reason when the browser has no WebGL; a native workspace panel, timeline rows for the two facts worth an audit line (a goal that crossed the approval gate, a leaf that reached `done`), and an agent skill that teaches when to write the tree.

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
| [session-manager](./session-manager/README.md) | **0.12.0 (2026-10-21)** ¹ | `@getpaseo/plugin@0.12.0` | Compatible (typecheck + vitest: 8 suites, 70 tests). **0.2.2**: `requirements.paseo` deliberately left at `>=0.8.0` — this plugin contributes a workspace panel, a settings screen and Command Center items, none of which are deprecated, so it adopted no 0.11+ API and raising the floor would lock out hosts that run it fine. Its one real 0.12.0 finding was a spec violation, now fixed: **two** `localStorage` reads sat outside `client/web.ts` (in `use-host-typography.ts` and inline in the panel's style memo) — both now go through a `client/web.ts` gated on `Platform.OS === "web"`. No install-time build step. Details: [Compatibility](./session-manager/__doc.md#compatibility), [§16](./session-manager/__doc.md#16-paseo-0120--spec-conformance-2026-10-21). |
| [command-center](./command-center/README.md) | **0.12.0 (2026-10-21)** ¹ | `@getpaseo/plugin@0.12.0` + `@getpaseo/client@0.12.0` | Compatible (typecheck + vitest: 9 suites, 98 tests). **0.5.2** migrated the client entry off the deprecated `addSurface`/`addSidebarItem`/`openSurface` onto `addScreen`/`addSidebarHeaderItem`/`openScreen` (including all five `/cc` slash-command branches), raised `requirements.paseo` `>=0.8.0` → `>=0.11.0`, and moved the `localStorage` read into `client/web.ts`. Both `@getpaseo/client` and `@getpaseo/plugin` diffs 0.10.1 → 0.12.0 are additive for the APIs used; all eight `schedule*` methods the scheduler bridge calls are present unchanged. 0.5.1 fixed installation from a clean checkout. Details: [Compatibility](./command-center/__doc.md#6-compatibility), [§10](./command-center/__doc.md#10-paseo-0120--spec-conformance-2026-10-21). |
| [memory-flash](./memory-flash/README.md) | **0.12.0 (2026-10-21)** ¹ | `@getpaseo/plugin@0.12.0` | Compatible (typecheck + vitest: **15 suites, 166 tests**, incl. a real-process stdio MCP e2e, an MCP handshake that survives a simulated plugin update, and a live HTTP endpoint suite driving the server with `fetch`). **0.8.3** migrated to `addScreen`/`addSidebarHeaderItem`/`openScreen`, raised `requirements.paseo` `>=0.10.0` → `>=0.11.0`, and fixed the `localStorage`-outside-`client/web.ts` violation. 0.12.0's `#7023` removes the need for the old 0.5.1 protocol-type-import workaround (kept — it is harmless and still works on 0.11). Earlier: 0.5.0 remote-access HTTP transport with API keys; 0.6.0 outright key deletion and a rewritten agent skill; 0.7.0 Reciprocal Rank Fusion over several FTS5 views plus `memory_diagnose`; 0.7.1 a revision-independent MCP entry path. Details: [Compatibility](./memory-flash/__doc.md#10-compatibility), [§16](./memory-flash/__doc.md#16-paseo-0120--spec-conformance-2026-10-21). |
| [bunny-search](./bunny-search/README.md) | **0.12.0 (2026-10-21)** ¹ | `@getpaseo/plugin@0.12.0` | Compatible (typecheck + vitest: **9 suites, 95 tests**, incl. a real-process stdio MCP e2e). **0.4.2** migrated to `addScreen`/`addSidebarHeaderItem`/`openScreen`, raised `requirements.paseo` `>=0.10.0` → `>=0.11.0`, and fixed the `localStorage`-outside-`client/web.ts` violation. 0.2.1 fixed installation from a clean checkout. Details: [Compatibility](./bunny-search/__doc.md#7-compatibility), [§13](./bunny-search/__doc.md#13-paseo-0120--spec-conformance-2026-10-21). |
| [memory-flash-client](./memory-flash-client/README.md) | **0.12.0 (2026-10-21)** ¹ | `@getpaseo/plugin@0.12.0` | Compatible (typecheck + vitest: 6 suites, 53 tests, incl. an HTTP probe against a stub memory-flash server, MCP-injection tests, a settings-schema round-trip regression and an agent-skill suite). **0.2.1** migrated to `addScreen`/`addSidebarHeaderItem`/`openScreen` (screen titled `Memory Hosts`), raised `requirements.paseo` `>=0.10.0` → `>=0.11.0`, and fixed the `localStorage`-outside-`client/web.ts` violation. Still installs with **no build step** — every import is host-supplied, so no npm-registry access is needed. Requires Memory Flash 0.5.0+ with the HTTP endpoint on the remote host. Details: [Compatibility](./memory-flash-client/__doc.md#12-compatibility), [§15](./memory-flash-client/__doc.md#15-paseo-0120--spec-conformance-2026-10-21). |
| [luck-planner](./luck-planner/README.md) | **0.12.0 (2026-10-22)** ¹ ² | `@getpaseo/plugin@0.12.0` | Compatible (typecheck + vitest: **36 suites, 611 tests**, incl. a real-process stdio MCP e2e, a live HTTP endpoint suite with an SSE stream, the 2D/3D bundle-split contracts, the 3D frame budget at 10k nodes and the client audit of §10.5). **0.32.2** is the plugin's own 0.12.0 conformance pass (the 2026-10-21 pass deliberately skipped it while it was in development): the SDK diff `0.11.0 → 0.12.0` is additive and touches only the ACP and provider declarations this plugin does not use, so `requirements.paseo` stays `>=0.11.0`; the plugin never used the deprecated `addSurface`/`addSidebarItem`/`openSurface`; and its one real spec violation — a `localStorage` read outside `client/web.ts` — is fixed, with the spec's client audit now a test. Improved on the new SDK: `layout.compact` in the settings and dashboard screens, and the dashboard address as a real `ExternalLink`. Verified live on a 0.12.0 daemon (scratch home): the install, `Plugin ready`, a clean `paseo plugin reload`, the published MCP entry answering `initialize`/`tools/list`/`luck_tree_search`, the dashboard `/health`, and both entries built by the **real 0.12.0 host compiler** (`compilePlugin`, taken from the installed app) with zero deprecated calls. Earlier acceptance (0.29.1–0.29.4) fixed three defects only the host's build and the daemon's lifecycle could show. Details: [Compatibility](./luck-planner/__doc.md#10-compatibility), [§10.5](./luck-planner/__doc.md#105-paseo-0120-spec-conformance-0322), [§10.6](./luck-planner/__doc.md#106-the-host-compiler-as-the-oracle). |

¹ Typecheck, vitest and a static reproduction of the host's bundler boundary check (the same `ts.resolveModuleName` walk the desktop app runs, replayed against a staged copy of each plugin with the manifest `build` commands executed first). Plus a live install into an isolated Paseo **0.12.0** daemon (scratch home, production config untouched) on 2026-10-21: all five installed from their working trees as `running`, logged `Plugin ready` with no client-contribution errors, reloaded cleanly via `paseo plugin reload` (the fixed `#6306` flow), and every client entry built with the real 0.12.0 host compiler (`compilePlugin`) — the compiled bundles contain the new screen/sidebar API and zero deprecated calls. Live server-side effects were observed where the plugin has any: bunny-search wrote its settings mirror and memory-flash created `memory.db`.

² luck-planner was deliberately excluded from the 2026-10-21 0.12.0 conformance pass because it was still in development; it had its own pass on 2026-10-22 (luck-planner 0.32.2, §10.5 of its `__doc.md`), with the same evidence: typecheck, vitest, a live install into an isolated 0.12.0 daemon (the git working tree, `running`, `Plugin ready`, a clean reload, the published MCP entry answering, the dashboard's `/health`) and the real 0.12.0 host compiler building both entries. The 2026-10-19 acceptance that preceded it — the git install, the MCP round trip, a goal approval, the dashboard in the host browser, the SSE, both themes, the console and the frame rate — found three defects that only the host's build and the daemon's lifecycle could show; they are fixed in 0.29.1–0.29.4 and pinned by tests.

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
