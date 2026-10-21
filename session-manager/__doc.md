# session-manager — Technical Documentation

## Overview

`session-manager` is a Paseo plugin that browses and deletes the **native
session stores** of the coding agents connected to Paseo. It exists because
Paseo can *import* an agent session, but nothing in Paseo or its SDK removes the
transcripts that accumulate on disk.

The plugin runs in the Paseo daemon subprocess (full filesystem and process
access on the daemon host) and renders a React Native panel in the Paseo app.

### Host typography (plugin 0.2.0)

Paseo's `PluginTheme` passes colors only — no font settings — while the app has
Appearance settings for interface font, code font, and interface text size.
The panel therefore reads the app settings JSON from web `localStorage`
(`@paseo:app-settings`) and scales its text sizes by `uiBaseFontSize / 14` with
`shared/host-fonts.ts` (identical module to command-center; see that plugin's
`__doc.md` § 5b for the full reverse-engineering details). A configured
interface font family is applied via the hook in `client/use-host-typography.ts`
usage in the panel styles; when unset, no `fontFamily` is forced so the host's
`--paseo-ui-font` CSS rule stays in effect.

## Compatibility

Current: **verified against Paseo `0.12.0` (2026-10-21, SDK
`@getpaseo/plugin@0.12.0`)** — no API migration was needed; the one change is
the `client/web.ts` DOM-global fix (§16). The manifest range stays `>=0.8.0`
on purpose: this plugin adopts none of the 0.11+ API, so raising the floor
would be dishonest.

Earlier, verified against Paseo `0.10.1` (2026-09-29, SDK `@getpaseo/plugin@0.10.1`):
no code changes required, and the manifest range `>=0.8.0` already covered it.

### Installation

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:session-manager
```

Every import in this plugin is supplied by Paseo itself (`@getpaseo/plugin/*`, `zod`, `react`, `react-native`, `@tanstack/react-query`, `@types/node`, Node built-ins), so the manifest declares no `build` step: the daemon clones the repository into `~/.paseo/plugins/session-manager/<revision>/checkout/session-manager`, bundles it there and needs no npm-registry access — the command above is the whole installation. Verified on 2026-10-02 against Paseo `0.10.3` with a static reproduction of the host's bundler boundary check against a staged copy: no boundary errors in either bundle; the live Git install on 0.10.3 reached status `running` with an empty checkout of 4.2 MB (no `node_modules`). The host-side rules this relies on are documented in [command-center's __doc.md](../command-center/__doc.md#5f-version-051--install-time-resolution-and-the-host-bundler-boundary).

### 0.10.x changes affecting this plugin

Paseo 0.10.0 (2026-09-28) and 0.10.1 (2026-09-29) are **additive** for every API this plugin uses:

- **OpenCode v2 support** added — the plugin's OpenCode provider adapter uses the vendor CLI (`opencode session list/delete/export`), which is automatically compatible with OpenCode v2 when the CLI is updated. The adapter does not depend on internal schemas.
- **Password checks for relay connections** added — this is a daemon/network-layer change; the plugin runs in the daemon subprocess and accesses local files/CLI directly, so it is unaffected.
- **Settings reorganization** — the plugin registers its own host-scoped settings screen via `client.addSettingsScreen`; the Paseo Settings UI reorganization does not affect plugin settings screens.
- **Bug fixes** (workspace sidebar persistence, agent import, daemon startup, Pi/OpenCode/Codex edge cases) — none affect the plugin's RPC surface, provider adapters, or client contributions.

The 0.9.0 → 0.10.0 SDK diff touches only additive declarations and bug fixes. The version was bumped to 0.2.1 (patch) to reflect the SDK dependency update.

Verification (with `@getpaseo/plugin@0.10.1` installed):
- `npm run typecheck` passes
- `npm test` passes (8 suites, 70 tests)

<details>
<summary>Historical: 0.9.0 compatibility notes</summary>

Verified against Paseo `0.9.0` (2026-09-22, SDK `@getpaseo/plugin@0.9.0`):
no code changes required, and the manifest range `>=0.8.0` already covers it.

- The 0.9.0 plugin changelog is additive for every API this plugin uses:
  `defineRpc`, `server.handle`, `defineSettings` / `server.registerSettings`
  (the new `read()` / `subscribe()` settings handle is optional and unused
  here), `client.addWorkspacePanel` / `addSettingsScreen` /
  `addCommandCenterItem`, `useRpc` / `useSettings`, and
  `navigation.openAgent({ agentId })` (the new optional `serverId` changes
  nothing at the existing call site). The changed `assistant_message` /
  `tool_call` transformer behaviour does not apply: the plugin registers no
  timeline transformers.
- The SDK diff `0.8.0 → 0.9.0` touches only additive declarations
  (`useHosts`, `getPaseoClient`, `openExternalUrl`, `ExternalLink`,
  `navigation.openBrowser`, the server settings handle, sub-agent
  `parentSessionId` / `toolCallId`) plus a heartbeat-lease fix.
- Verification (throwaway copy with `@getpaseo/plugin@0.9.0` installed):
  `npm run typecheck` passes, `npm test` passes (8 suites, 70 tests).
</details>

## Session store audit (verified 2026-09-21, Paseo 0.8.0)

The original revision of this plugin only managed `~/.acpx/sessions/`. That
store belongs to the **standalone `acpx` CLI** (`npm i -g acpx`, package
`acpx@0.13.2`, repository `openclaw/acpx`), which is a separate product from
Paseo:

- `/opt/Paseo/resources/app.asar` contains **zero** occurrences of the string
  `acpx` (case-insensitive grep).
- Paseo spawns each provider directly, e.g. `npx -y cline@3.0.46 --acp`,
  `kilo acp`, `npx -y @qwen-code/qwen-code@0.20.1 --acp`, and the built-in
  opencode provider. Paseo's own agent records live in
  `$PASEO_HOME/agents/<sanitized-workspace>/<agentId>.json`.

Conclusion: the acpx store is unrelated to Paseo agents, so the plugin had to be
extended to the real stores. The verified layout on a Linux host:

| Agent               | Store location                                                        | Notes |
| ------------------- | --------------------------------------------------------------------- | ----- |
| Cline (`cline@3.x`) | `~/.cline/data/sessions/<sessionId>/<sessionId>.{json,messages.json,compaction.json}` and SQLite `~/.cline/data/db/sessions.db` (`sessions` table), `session-search.db`, `tasks.db`, `teams.db`, `hub-events-hub-production.db` | Deleting only the directory leaves a dangling row in `sessions.db`, which is why deletion goes through `cline history delete` |
| OpenCode (`opencode-ai@1.18.x`) | SQLite `~/.local/share/opencode/opencode.db` (`session`, `message`, `part`, FK `ON DELETE CASCADE`), plus `storage/session_diff/`, `snapshot/`, `tool-output/` | The database reached 543 MB on the audited machine |
| Kilo CLI (`@kilocode/cli@7.7.x`) | SQLite `~/.local/share/kilo/kilo.db` (same schema family as OpenCode), plus `storage/session_diff/`, `snapshot/` | Kilo is an OpenCode fork and keeps the same `session` commands |
| Qwen Code (`@qwen-code/qwen-code@0.20.x`) | `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`, sidecars `~/.qwen/plans/<sessionId>.md`, `~/.qwen/todos/<sessionId>.json`, runtime registry `~/.qwen/sessions/<pid>.json` | `qwen sessions list` exists, `qwen sessions` has no delete command |
| acpx CLI (`acpx@0.13.x`) | `~/.acpx/sessions/index.json` (`schema`, `files`, `entries`), `<id>.json`, `<id>.stream.ndjson` | Unrelated to Paseo, kept for parity |

Paseo agent records reference the native session through
`persistence.sessionId`, `persistence.nativeHandle`, and `runtimeInfo.sessionId`,
which is what the plugin uses to detect that a transcript is still owned by a
Paseo agent.

## Architecture

```
session-manager/
├── paseo-plugin.json            # Plugin manifest (id, description, requirements)
├── index.server.ts              # Server entry: settings + RPC bindings
├── index.client.tsx             # Client entry: panel, settings screen, Command Center items
├── shared/
│   ├── session-manager.ts       # Zod schemas + defineRpc contracts
│   ├── settings.ts              # Host-scoped settings definition
│   └── host-fonts.ts            # Host Appearance settings parsing + font scale math
├── server/
│   ├── session-manager.ts       # Aggregation, safety guards, RPC handlers, listing cache
│   ├── exports.ts               # "Export before delete" file writer
│   ├── paseo-agents.ts          # Paseo agent records -> session id index
│   ├── exec.ts                  # CLI discovery, execution, tolerant JSON parsing
│   ├── util.ts                  # Home paths, sizes, atomic index writes, formatting
│   └── providers/
│       ├── types.ts             # ProviderAdapter contract
│       ├── registry.ts          # Registry of all providers
│       ├── cli.ts               # Factory for CLI-backed providers
│       ├── cline.ts
│       ├── opencode.ts
│       ├── kilo.ts
│       ├── qwen.ts
│       └── acpx.ts
├── client/
│   ├── session-manager-panel.tsx
│   ├── settings-screen.tsx      # Editor for the host-scoped settings
│   ├── intent.ts                # Panel filters handed over by Command Center items
│   └── use-host-typography.ts   # hook: host font settings → scale + families
└── tests/                       # vitest suites (`npm test`)
```

### Provider adapter contract (`server/providers/types.ts`)

```ts
interface ProviderAdapter {
  id: string;      // stable store id, matches the Paseo provider id where one exists
  label: string;   // display label
  list(): Promise<ProviderListResult>;
  delete(ids: string[]): Promise<ProviderDeleteResult>;
  // Optional: dump one session to `outPath` so it survives a delete.
  exportSession?(input: { id: string; outPath: string }): Promise<ProviderExportResult>;
  exportExtension?: string;
}
```

`ProviderListResult` reports the sessions, whether the store/CLI was
`detected`, the `detail` string shown in the UI (path or CLI binary), whether
`deletable` is currently possible, the whole-store size (`storeBytes`), and a
non-fatal `error`.

Storage strategy per adapter:

- **CLI-backed** (`cline`, `opencode`, `kilo`): listing and deletion are driven
  by the vendor's own session commands through `createCliProvider`
  (`server/providers/cli.ts`). This keeps the plugin independent of private
  schemas and lets the agent clean up its own indexes, snapshots and rows.
  Cline falls back to scanning `~/.cline/data/sessions` for listing when its CLI
  is missing, but then reports `deletable: false` instead of editing the SQLite
  history by hand.
- **File-backed** (`qwen-code`, `acpx`): transcripts and records are removed
  directly, because neither agent offers a delete command.
- **Exports**: every adapter implements `exportSession`. The CLI factory uses
  the vendor command when one exists (`opencode export` / `kilo export` print
  JSON on stdout, `cline history export --output` writes an HTML transcript);
  the file adapters copy the raw transcript (`*.jsonl` for Qwen, record + stream
  `.ndjson` for acpx). Verified 2026-09-21 against the installed CLIs
  (`cline@3.x`, `opencode-ai@1.18.x`, `@kilocode/cli@7.7.x`).
- **Qwen sidecars**: deleting a session removes the transcript, `plans/<id>.md`,
  `todos/<id>.json`, and `file-history/<id>/`. The `file-history` directories
  are keyed by session id (verified against `chats/<id>.jsonl` on a live store),
  and Qwen itself cleans that tree with its own `.file-history-cleanup` marker,
  so removing the session's own directory is the documented behaviour, not a
  guess. The runtime registry `~/.qwen/sessions/<pid>.json` is never touched.
- **Sizes**: file-backed stores report an exact `sizeBytes` per row (transcript
  plus sidecars). OpenCode and Kilo keep transcripts in SQLite tables, where
  per-session attribution is only possible by reading the private schema, which
  this plugin refuses to do; rows report `sizeBytes: null` and the panel shows
  the whole database size (`opencode.db` + `-wal` + `-shm`) under "Stores".

### CLI discovery (`server/exec.ts`)

The daemon is usually started from the desktop session, whose `PATH` frequently
misses version managers, so `resolveBinary` searches `PATH` first and then
`~/.local/bin`, `~/bin`, `~/.opencode/bin`, `~/.bun/bin`, `~/.local/share/pnpm`,
`~/.volta/bin`, `~/.nvm/versions/node/*/bin`, `/usr/local/bin`,
`/opt/homebrew/bin`, and the Windows npm/pnpm locations. Binaries run through
`execFile` without a shell, with a timeout and bounded output; `parseJsonLoose`
recovers JSON from output that carries banners or log lines (the `kilo` CLI
prints an ASCII banner).

### Safety guards and the listing cache (`server/session-manager.ts`)

Before deleting, the handler reads the provider's session list and refuses when:

1. the session is still **running** — detected from Cline's `status`/`pid`,
   Qwen's `~/.qwen/sessions/<pid>.json` registry with a `kill(pid, 0)` check, or
   an open (not closed) acpx record; or
2. a Paseo agent record references the session id and is **not archived** —
   deleting it would break resume for that agent in Paseo.

Both refusals carry an actionable message; the panel exposes a force delete that
the user has to confirm explicitly. Archived Paseo agents never block deletion,
because that is exactly the stale-session case this plugin targets.

Provider listings live in a module-level cache with a 30 s TTL, because a
delete request always re-reads the same store a list request already paid for,
and every CLI-backed scan costs a process spawn. The cache is the reason the
guards stay fast, and the reason a `list → delete → list` sequence does not see
stale data:

- every successful or failed delete invalidates the entry of the touched
  provider, so the next guard or list call reads fresh state;
- the panel's "Rescan" sends `refresh: true` and bypasses the cache entirely;
- the 30 s staleness window is bounded: a guard that reads a warm listing points
  at a session deleted elsewhere, and the vendor CLI reports that as a failure,
  it does not delete the wrong session.

### RPC surface (`shared/session-manager.ts`)

| RPC | Input | Output |
| --- | --- | --- |
| `session-manager.list` | `{ refresh? }` | `{ sessions, providers, scannedAt }` |
| `session-manager.delete` | `{ provider, id, force? }` | `{ deleted, error }` |
| `session-manager.delete-batch` | `{ targets: [{ provider, id }], force? }` | `{ deleted, failures }` |
| `session-manager.export` | `{ provider, id }` | `{ exported, path, bytes, error }` |

`list` runs every adapter in parallel with `Promise.all`; a failing adapter
degrades to a provider entry with an `error` instead of failing the whole scan.
The batch handler checks every target through the same guards first, groups the
allowed ids per provider so the vendor CLI is invoked once per store, and
returns per-session failures for everything the guards or the CLI refused.

### Settings (`shared/settings.ts`, `client/settings-screen.tsx`)

The plugin registers host-scoped settings that the panel reads back through
`useSettings` (`@getpaseo/plugin/client`):

| Field | Values | Default | Effect |
| ----- | ------ | ------- | ------ |
| `cleanupDays` | `0` (off) / `30` / `90` | `30` | "Due for cleanup" hint in the panel and pre-filtered Command Center commands |
| `sortOldestFirst` | boolean | `true` | Default order of the session list |
| `exportBeforeDelete` | boolean | `false` | Pre-selected "Export first" toggle in the confirmation block |

Every field has a zod default, because Paseo parses the stored document (`{}`
on a fresh install) before the client ever sees it. Deliberately, nothing here
triggers scheduled deletion: there is no daemon-side timer and no silent
automation — the reminder only highlights and pre-selects, the user confirms.

### Client (`client/session-manager-panel.tsx`)

- `useRpc(listSessions)` in a `@tanstack/react-query` query keyed
  `["session-manager", "sessions"]`.
- Provider chips (only providers with sessions), age chips
  (any / > 1d / > 7d / > 30d), an "Archived Paseo agents" chip, selection
  toggling, "Select all shown", and delete of a single row or the whole
  selection.
- Sort chips switch between oldest-first (the default) and newest-first; unknown
  timestamps sink to the end in both orders.
- The confirmation block previews the batch: per-provider counts with known
  sizes, the size the batch is expected to free (unknown stores are counted as
  unknown, never as zero), risky sessions, and providers where deletion is
  unavailable. Batch deletion runs in chunks of 25 with a live "Deleting x / y"
  indicator.
- One row shows "Export" (a transcript copy under `$PASEO_HOME/session-manager-exports`)
  next to "Delete..."; the confirmation block offers an "Export first" toggle
  with progress and per-file failures.
- Rows linked to a Paseo agent offer "Open agent in Paseo" when the host exposes
  navigation (`navigation.openAgent`).
- The "Stores" section reports the whole-store size of every detected provider,
  so a 543 MB `opencode.db` is visible even where per-session sizes are unknown.
  A "due for cleanup" hint highlights sessions older than the configured
  threshold.
- Command Center items open the panel pre-filtered through
  `client/intent.ts`: sessions older than 30 days and archived-agent sessions
  (both pre-select the matching rows), plus the settings screen.
- All colors come from `theme.colors`; padding follows `layout.compact`;
  scrolling uses the host `ScrollView` from `@getpaseo/plugin/client/react-native`.
- The confirm block lists the risks and switches the action label to
  "Yes, delete anyway" when force is required.
- All colors come from `theme.colors`; padding follows `layout.compact`;
  scrolling uses the host `ScrollView` from `@getpaseo/plugin/client/react-native`.

## Extending to a new coding agent

1. Add `server/providers/<agent>.ts` exporting a `ProviderAdapter`. If the agent
   ships session commands, reuse `createCliProvider` with its list/delete argv
   and a row mapper.
2. Append it to `providers` in `server/providers/registry.ts`.

No other file changes: list, delete, batch delete, guards, status reporting and
the UI adapt automatically. Prefer a provider id equal to the Paseo provider id
so Paseo agent links can be matched.

## Data flow

```
Client panel ──useRpc──▶ shared contracts ──▶ index.server.ts `server.handle`
                                                   │
                                                   ▼
                          server/session-manager.ts (guards + aggregation)
                                                   │
                    ┌──────────────────────────────┼───────────────────────────┐
                    ▼                              ▼                           ▼
        providers/cline|opencode|kilo        providers/qwen            providers/acpx
             (vendor CLI)                 (~/.qwen/projects/…)     (~/.acpx/sessions)
```

## Local development

```bash
cd session-manager
npm install         # installs @getpaseo/plugin and the other host modules
npm run typecheck
npm test            # vitest: guards, providers, JSON recovery, settings
paseo plugin reload session-manager
paseo plugin logs session-manager
```

## Limitations

- Deletion happens on the **daemon host**; a remote daemon deletes its own
  sessions, which is the intended scope.
- OpenCode and Kilo expose no "is this session running" signal, so an open
  session can be deleted unless it is linked to a non-archived Paseo agent.
  Their transcripts also cannot be attributed per session without reading the
  private SQLite schema, which the plugin refuses to do; the panel shows the
  whole `*.db` store size instead.
- Sizes are only computed where cheap: Cline session directories, Qwen
  transcripts with their sidecars, and acpx record + stream files. CLI-listed
  agents (OpenCode, Kilo) report `null`, shown as "size unknown".
- The process-level listing cache serves repeated reads for at most 30 seconds;
  any delete invalidates the affected provider, and "Rescan" bypasses it.
- The plugin never archives or deletes Paseo agent records; use the Paseo UI for
  that. It only protects them from accidental transcript deletion.
- Exports land under `$PASEO_HOME/session-manager-exports`; they are plain
  copies the plugin never cleans up by itself.

## Planned improvements with Paseo 0.11.0

Compatibility with the 0.11.0 prerelease (`v0.11.0-beta.5`, verified 2026-10-06)
is established: the SDK diff `@getpaseo/plugin@0.10.1 → 0.11.0-beta.5` is purely
additive for every API this plugin uses; `npm run typecheck` and `npm test`
(8 suites, 70 tests) pass against the 0.11.0 SDK; the real host compiler
(`compilePlugin` from 0.11.0-beta.5) bundles the plugin with SDK 0.11.0, with
the faithful 0.10.1 lockfile, and with host-supplied imports only; the manifest's
`requirements.paseo >=0.8.0` passes `assertPluginCompatibility` for a
0.11.0-beta.5 daemon and app; and a live Git install on an isolated
0.11.0-beta.5 daemon reached status `running` with `Plugin ready` in the logs.
No code changes are required for 0.11.0.

The following new 0.11.0 capabilities are relevant to this plugin. **They are
planned for implementation after the stable Paseo 0.11.0 release, on request:**

1. **Host-managed process execution** — `spawnProcess`, `execCommand` and
   `terminateProcess` from `@getpaseo/plugin/server` (new in 0.11.0) are the
   SDK-native replacement for the plugin's own `node:child_process` usage in
   `server/exec.ts` (the CLI discovery/deletion path used by the Cline, OpenCode
   and Kilo adapters). Beyond moving process lifecycle under the host's
   management, they add correct launching of Windows `.cmd`/`.bat` commands,
   which the current hand-rolled spawn does not handle.
2. **`agent.closed` lifecycle event** — new hook payload
   (`"agent.closed": { agent: PluginHookAgent }`). The plugin could invalidate
   its 30-second listing cache and re-evaluate the "due for cleanup" hint the
   moment an agent closes, instead of waiting for TTL expiry or a manual
   Rescan.
3. **Sidebar contributions** — `addSidebarFooterItem` (new footer slot) and the
   multi-row `SidebarRow` / `SidebarSeparator` components from `client/ui`
   provide additional entry points for the panel. Note for the future migration:
   this plugin does **not** use the deprecated `addSurface` / `addSidebarItem` /
   `openSurface` API (it contributes a workspace panel, a settings screen and a
   Command Center item), so there is nothing to migrate ~~before the
   compatibility shims are removed after 2027-03-29~~ (**the 2027-03-29 date
   was wrong — see §16.1; and §16.2 confirms it: nothing had to be migrated in
   the 0.12.0 audit either**) — only optional new surfaces to adopt.

## 16. Paseo 0.12.0 — spec conformance (2026-10-21)

Audited against the stable `0.12.0` release (2026-10-19).
Release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.12.0>.
The general spec rules (screen/sidebar API, `requirements.paseo` semantics,
ID charset, the `client/web.ts` DOM-global rule, manifest fields) are
spelled out in bunny-search §13; this section records what is specific to
session-manager.

This plugin is the **only one in the repository that needed no registration
migration**, so its 0.12.0 diff is the smallest of the five — and it is also
the plugin with the most DOM-global violations, which is a useful reminder
that "no API migration" is not the same as "conformant".

### 16.1 What 0.12.0 changed for this plugin

| Check | Result |
| --- | --- |
| Registrations used | `client.addWorkspacePanel`, `client.addSettingsScreen`, `client.addCommandCenterItem` (×4) — **none deprecated** in 0.12.0. Command Center callbacks use `openPanel(id)` and `openSettings(id)`, both current. |
| `addSurface` / `addSidebarItem` / `openSurface` | **Not used anywhere** in this plugin (confirmed by grep over `index.client.tsx` and `client/`). Nothing to migrate. This was already noted in §15 item 3 before 0.12.0 existed. |
| SDK diff `@getpaseo/plugin@0.10.1 → 0.12.0` | **Additive only** for every API used here: `registerSettings`, `server.handle`, `server.on`/`server.before`, `useRpc`, `useSettings`, `usePaseo`, `@tanstack/react-query`, `PluginWorkspacePanelProps` (incl. `navigation.openAgent`, which the panel already guards as optional). |
| `0.11.0 → 0.12.0` declarations | `client/contracts.d.ts` and `client/ui.d.ts` byte-identical. |
| **The "2027-03-29" removal date** | §15 item 3 said the compatibility shims "are removed after 2027-03-29". **Wrong for 0.12.0**: that date belongs only to `COMPAT(codexFastPreference)` and `COMPAT(pluginProviderLaunch)`. The surface/sidebar shims have no COMPAT marker and no date; the SDK tags state no removal version. Moot for this plugin (it uses none of those APIs) but the claim is struck through in §15 and corrected in the README. |
| `#7023` (protocol type imports) | No effect: this plugin imports no `@getpaseo/protocol` and — like memory-flash-client — has **no install-time build step**, because every import it references is on the host-supplied list. That property is unchanged. |
| `#6306` | `paseo plugin reload` no longer fails with a 60 s timeout while the reload is still running. |
| Other 0.12.0 plugin fixes (`#6760`, `#6690`, `#7253`, `#7110`, `#7270`, `#7341`) | None apply: no timeline items, no composer pills, no ACP agent, no `waitForReady`, no plugin preview. |
| 0.12.0 features that would matter here | `spawnProcess`/`execCommand`/`terminateProcess` (§15.1) and the `agent.closed` hook (§15.2) — both still optional adoption, neither a conformance requirement. |

### 16.2 Why `requirements.paseo` stays `>=0.8.0`

The spec says *"Raise the minimum when adopting a newer API"*. This plugin
adopts none: every registration and callback it calls exists in the 0.8-era
SDK surface, and the one 0.10-era prop it uses (`navigation.openAgent`) is
explicitly optional — the panel already renders its "Open agent in Paseo"
link only when `navigation` is present, so an older app degrades instead of
crashing. Raising the floor would lock out hosts that can run the plugin
perfectly well.

The four plugins that *did* migrate to `addScreen`/`addSidebarHeaderItem`/
`openScreen` therefore carry `>=0.11.0`, while this one keeps `>=0.8.0`. That
difference is deliberate and is the honest per-plugin floor in each case.

What did change: the SDK pin is now `@getpaseo/plugin@0.12.0` for
typecheck/tests, and 0.12.0 is the version verified.

### 16.3 The 0.12.0 cross-platform audit — two violations, fixed

The 0.12.0 client audit flags a DOM global (`window`, `document`,
`localStorage`, `navigator`, `location`) in any `client/` module other than
`client/web.ts` as a bug, and forbids HTML elements, `className` and `onClick`.

This plugin had **two** DOM-global sites — one more than any other plugin
here, because the panel builds its whole style sheet inside a `useMemo` and
inline-did the typography read:

| Target | Before | After |
| --- | --- | --- |
| `client/use-host-typography.ts` | read `globalThis.localStorage` directly | calls `readHostTypography()` from the new `client/web.ts` |
| `client/session-manager-panel.tsx` (inside the `styles` `useMemo`) | inline `readHostTypographyFromLocalStorage((globalThis as …).localStorage)` | calls the same `readHostTypography()`; the import of `readHostTypographyFromLocalStorage` is gone from the panel |
| `client/settings-screen.tsx` | clean — the one raw regex hit is the word "document" inside a JSDoc comment ("an unset or invalid document degrades to the…") | unchanged |
| HTML elements / `className` / `onClick` in `client/` | none | none |
| `"DOM"` in `lib`, `/// <reference lib="dom" />` | none | none |
| `shared/host-fonts.ts` | takes the storage object as a **parameter**, never reaches for a global | unchanged |

`client/web.ts` gates every export on `Platform.OS === "web"` and returns
`null` on native, so callers keep the `?? defaultHostTypography()` fallback —
behaviour is identical on every platform.

### 16.4 Verification (2026-10-21, this machine)

| Check | Result |
| --- | --- |
| `npm install` with `@getpaseo/plugin@0.12.0` | exit 0; lockfile updated |
| `npm run typecheck` (`tsc --noEmit`) | **exit 0** |
| `npm test` | **8 suites / 70 tests pass** |
| 0.12.0 client audit (DOM globals outside `client/web.ts`, HTML, `className`, `onClick`) | **clean** (one prose hit in a comment, no code) |
| Remaining deprecated registrations | **none** — none existed |
| Contribution ID charset | conforms (`session-manager`, `session-manager-settings`, `open-session-manager`, `open-session-manager-old`, `open-session-manager-archived`, `open-session-manager-settings`) |
| `requirements.paseo` | **unchanged `>=0.8.0`** — deliberately, §16.2 |
| Install-time build step | **none** — every import is host-supplied, so installation still needs no npm-registry access |
| Live install on a running 0.12.0 daemon | **PASS** — installed from the working tree into an isolated 0.12.0 daemon (scratch home, production config untouched): status `running`, `Plugin ready` in the log, no errors. The real 0.12.0 host compiler (`compilePlugin`) built the client entry (neither the deprecated nor the new contribution API is used, as designed). `paseo plugin reload session-manager` exits 0 and the plugin restarts cleanly (the 0.12.0 #6306 fix). |

### 16.5 Not adopted (from §15; 0.12.0 changes none of them)

1. **Host-managed processes** — `spawnProcess`/`terminateProcess`/
   `execCommand` in `server/exec.ts` (the CLI discovery/deletion path behind
   the Cline, OpenCode and Kilo adapters). Still a server-behavior change
   needing its own test pass; `node:child_process` remains legal under
   `server/`.
2. **`agent.closed` lifecycle event** — invalidate the 30-second listing
   cache and re-evaluate the "due for cleanup" hint the moment an agent
   closes. New functionality.
3. **Extra sidebar entry points** — `addSidebarFooterItem`, multi-row
   `SidebarRow`/`SidebarSeparator`. New capability.

Version `0.2.1` → `0.2.2` (the DOM-global audit fix, no API and no new
capability → last digit), annotated tag `session-manager@0.2.2`.
