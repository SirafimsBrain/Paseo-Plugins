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
