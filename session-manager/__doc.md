# session-manager — Technical Documentation

## Overview

`session-manager` is a Paseo plugin that browses and deletes the **native
session stores** of the coding agents connected to Paseo. It exists because
Paseo can *import* an agent session, but nothing in Paseo or its SDK removes the
transcripts that accumulate on disk.

The plugin runs in the Paseo daemon subprocess (full filesystem and process
access on the daemon host) and renders a React Native panel in the Paseo app.

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
├── index.server.ts              # Server entry: binds RPCs to handlers
├── index.client.tsx             # Client entry: panel + Command Center item
├── shared/
│   └── session-manager.ts       # Zod schemas + defineRpc contracts
├── server/
│   ├── session-manager.ts       # Aggregation, safety guards, RPC handlers
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
└── client/
    └── session-manager-panel.tsx
```

### Provider adapter contract (`server/providers/types.ts`)

```ts
interface ProviderAdapter {
  id: string;      // stable store id, matches the Paseo provider id where one exists
  label: string;   // display label
  list(): Promise<ProviderListResult>;
  delete(ids: string[]): Promise<ProviderDeleteResult>;
}
```

`ProviderListResult` reports the sessions, whether the store/CLI was
`detected`, the `detail` string shown in the UI (path or CLI binary), whether
`deletable` is currently possible, and a non-fatal `error`.

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

### CLI discovery (`server/exec.ts`)

The daemon is usually started from the desktop session, whose `PATH` frequently
misses version managers, so `resolveBinary` searches `PATH` first and then
`~/.local/bin`, `~/bin`, `~/.opencode/bin`, `~/.bun/bin`, `~/.local/share/pnpm`,
`~/.volta/bin`, `~/.nvm/versions/node/*/bin`, `/usr/local/bin`,
`/opt/homebrew/bin`, and the Windows npm/pnpm locations. Binaries run through
`execFile` without a shell, with a timeout and bounded output; `parseJsonLoose`
recovers JSON from output that carries banners or log lines (the `kilo` CLI
prints an ASCII banner).

### Safety guards (`server/session-manager.ts`)

Before deleting, the handler re-reads the provider's live session list and
refuses when:

1. the session is still **running** — detected from Cline's `status`/`pid`,
   Qwen's `~/.qwen/sessions/<pid>.json` registry with a `kill(pid, 0)` check, or
   an open (not closed) acpx record; or
2. a Paseo agent record references the session id and is **not archived** —
   deleting it would break resume for that agent in Paseo.

Both refusals carry an actionable message; the panel exposes a force delete that
the user has to confirm explicitly. Archived Paseo agents never block deletion,
because that is exactly the stale-session case this plugin targets.

### RPC surface (`shared/session-manager.ts`)

| RPC | Input | Output |
| --- | --- | --- |
| `session-manager.list` | `{}` | `{ sessions, providers, scannedAt }` |
| `session-manager.delete` | `{ provider, id, force? }` | `{ deleted, error }` |
| `session-manager.delete-batch` | `{ targets: [{ provider, id }], force? }` | `{ deleted, failures }` |

`list` runs every adapter in parallel with `Promise.all`; a failing adapter
degrades to a provider entry with an `error` instead of failing the whole scan.

### Client (`client/session-manager-panel.tsx`)

- `useRpc(listSessions)` in a `@tanstack/react-query` query keyed
  `["session-manager", "sessions"]`.
- Provider chips (only providers with sessions), age chips
  (any / > 1d / > 7d / > 30d), selection toggling, "Select all shown", and
  delete of a single row or the whole selection.
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
paseo plugin reload session-manager
paseo plugin logs session-manager
```

## Limitations

- Deletion happens on the **daemon host**; a remote daemon deletes its own
  sessions, which is the intended scope.
- OpenCode and Kilo expose no "is this session running" signal, so an open
  session can be deleted unless it is linked to a non-archived Paseo agent.
- Sizes are only computed where cheap: Cline session directories, Qwen
  transcripts, and acpx record + stream files. CLI-listed agents report `null`.
- Qwen sidecars are limited to `plans/<id>.md` and `todos/<id>.json`;
  `~/.qwen/file-history/<uuid>` is left alone because its keys are not
  documented as session ids.
- The plugin never archives or deletes Paseo agent records; use the Paseo UI for
  that. It only protects them from accidental transcript deletion.
