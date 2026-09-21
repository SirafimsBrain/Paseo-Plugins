# session-manager — Technical Documentation

## Overview

`session-manager` is a Paseo plugin that allows browsing and cleaning up ACP
(Agent Communication Protocol) sessions persisted on the local filesystem. It
reads the session store maintained by `acpx` (located under
`~/.acpx/sessions/`) and exposes that information to the Paseo UI, where users
can inspect and delete sessions.

## Architecture

The plugin follows the Paseo plugin layout: a **server** side that runs in the
extension host and performs filesystem I/O, a **client** side that renders a
React Native panel, and **shared** code that defines the RPC contracts and
schemas used by both sides.

```
session-manager/
├── paseo-plugin.json          # Plugin manifest (id + paseo requirement)
├── index.server.ts            # Server entry: registers RPC handlers
├── index.client.tsx           # Client entry: registers panel + Command Center item
├── shared/
│   └── session-manager.ts     # defineRpc definitions + Zod schemas
├── server/
│   └── session-manager.ts     # ACP session store reads/deletes
└── client/
    └── session-manager-panel.tsx  # Workspace panel UI
```

### Server (`index.server.ts`)

`index.server.ts` calls `server.handle(...)` to bind the shared RPC
definitions to their server-side implementations from
`server/session-manager.ts`. It wires three RPCs:

| RPC                     | Server handler              | Shared definition     |
| ----------------------- | --------------------------- | --------------------- |
| `session-manager.list`  | `listAcpSessions`           | `listSessions`        |
| `session-manager.delete`| `deleteAcpSession`          | `deleteSession`       |
| `session-manager.delete-batch` | `deleteAcpSessionsBatch` | `deleteSessions`   |

### Shared (`shared/session-manager.ts`)

Defines the data model and RPC contracts using `@getpaseo/plugin`'s
`defineRpc` and `zod` for input/output validation. The `AcpSession` schema
describes each session record surfaced to the UI:

| Field          | Type      | Description                                          |
| -------------- | --------- | ---------------------------------------------------- |
| `id`           | string    | The ACP record id (maps to `acpxRecordId` in the index). |
| `name`         | string \| null | Human-readable name, if any.                    |
| `cwd`          | string    | Working directory the session was created in.        |
| `agentCommand` | string    | The agent command that produced the session.         |
| `closed`       | boolean   | Whether the session is closed.                       |
| `createdAt`    | string    | ISO timestamp of creation (read from the session meta file). |
| `lastUsedAt`   | string    | ISO timestamp the session was last used (from the index). |
| `streamExists` | boolean   | Whether a corresponding `*.stream.ndjson` file exists on disk. |

### Server implementation (`server/session-manager.ts`)

Reads and mutates the ACP session store directly on the filesystem. Key
constants and functions:

- `ACPX_SESSIONS_DIR` — `~/.acpx/sessions/`, the ACP session directory.
- `INDEX_FILE` — `index.json` inside that directory; an `{ "entries": [...] }`
  index of ACP session records.

**Functions:**

- `readIndex()` — synchronous read + JSON parse of `index.json`, returning
  `{ entries: [] }` on any error.
- `writeIndex(index)` — writes the index back atomically (best-effort).
- `readSessionMeta(filename)` — reads a per-session `*.json` file to extract
  `created_at` and `name`. Returns safe defaults on failure.
- `listAcpSessions()` — maps each index entry to an `AcpSession`, enriching
  with metadata from the session file and checking for the `.stream.ndjson`
  sidecar. Returns `{ sessions }`.
- `deleteAcpSession({ id })` — finds the entry by `acpxRecordId`, removes the
  `*.json` metadata file and the `*.stream.ndjson` stream file (if present),
  then updates the index. Returns `{ deleted: boolean }`.
- `deleteAcpSessionsBatch({ ids })` — same as `deleteAcpSession` but for a
  list of ids; removes matching entries and their files, returns the count of
  deleted sessions as `{ deleted: number }`.

File deletions are best-effort: a failed `unlinkSync` is swallowed and the
entry is skipped rather than failing the whole operation.

### Client (`client/session-manager-panel.tsx`)

Renders the "Provider Sessions" workspace panel. It uses `@tanstack/react-query`
for fetching/mutating and Paseo's `useRpc` to invoke the server RPCs, plus
Paseo's `useToast` for user feedback.

**State:**

- `onlyClosed` (default `true`) — filter to only closed sessions.
- `confirmId` — id of the session pending a second-confirm delete gesture.
- `busyId` — id currently being deleted (disables buttons).

**Query:** `useQuery` with key
`["session-manager", "sessions"]` calls `listSessions`; results are filtered by
`onlyClosed` and sorted by `lastUsedAt` (ascending).

**Mutation:** `useMutation` calling `deleteSession({ id })`. On success it toasts
and invalidates the list query; on error it toasts the message. `onSettled`
clears `busyId` and `confirmId`.

**UI:** A header with the "Closed only" switch and a count; a scrollable list of
session rows. Each row shows the name (or id), a meta line with the agent
command binary, status, and age (computed via `ageLabel`), and the `cwd`. A
"Delete..." button enters confirm mode, after which the row shows "Yes, delete"
/ "Cancel" affordances.

**Styling:** Plain React Native inline style objects derived from the plugin
theme `theme.colors` (e.g. `surface0`, `foreground`, `foregroundMuted`,
`border`, `statusDanger`).

## Data flow

```
Client panel  ──useRpc──▶  shared RPC definitions
       │
       └── server.handle (index.server.ts)
               │
               ▼
       server/session-manager.ts  (filesystem I/O on ~/.acpx/sessions/)
```

## Dependencies

- `@getpaseo/plugin` 0.8.0 (peer / dev)
- `@tanstack/react-query` ^5
- `zod` ^4 (for RPC schema validation)
- `react` 19.1, `react-native` 0.81.5

## Limitations / notes

- Filesystem access is direct and synchronous (`fs.*Sync`); the plugin requires
  that Paseo's server runtime has access to the user's home directory and the
  `~/.acpx/sessions/` layout.
- The index is the source of truth; deleting a session file without updating the
  index is not handled by the list path (stale entries with missing files are
  simply read with default metadata).
- The client currently only exposes single-session deletion through the
  mutation; batch deletion is implemented on the server (`deleteSessions` RPC)
  but is not yet wired into the panel UI.
