# Command Center — technical documentation

This file documents the internal design, verified compatibility, and the roadmap of the `command-center` plugin. User-facing description: [README.md](./README.md).

## 1. Purpose and scope

Command Center turns recurring prompts and terminal lines into named, parameterized commands that can be dispatched to any Paseo workspace or agent. It is orchestration glue on top of the Paseo plugin SDK; it does not talk to coding agents directly and stores no credentials.

The concept was inspired by [stablyai/orca](https://github.com/stablyai/orca) (a command dropdown) but is implemented as a full Paseo surface with a library, editor, run dialog, and history.

## 2. Architecture

```
command-center/
├── index.server.ts            # RPC handlers (list/save/delete/favorite/history/run)
├── index.client.tsx           # surface, sidebar item, ⌘K items, /cc slash command
├── shared/
│   ├── commands.ts            # zod schemas, RPC contracts (defineRpc), types
│   └── template.ts            # pure template renderer + input discovery (client-safe)
├── server/
│   ├── store.ts               # atomic JSON storage in $PASEO_HOME/plugins/command-center
│   ├── executor.ts            # run engine: resolve target, render, dispatch, log
│   └── (template.ts removed — shared module is used instead)
├── client/
│   ├── command-center-surface.tsx  # library + history tabs, editor host, run modal
│   ├── command-form.tsx            # create/edit form, provider chips from the daemon
│   ├── run-dialog.tsx              # inputs, target pickers, live preview
│   └── preview.ts                  # preview rendering helper
└── tests/                     # vitest suites (5 files, 37 tests)
```

Data flow for a run:

1. The client resolves the target (workspace id, agent id, worktree flag) and fills variable values, previewing the rendered result locally with the same renderer the server uses.
2. `command-center.run` arrives at the daemon-side handler in `index.server.ts`.
3. The executor re-resolves workspace context server-side, renders the template with the daemon clock, and dispatches:
   - `prompt` + `agentId` → `paseo.agents.ref(id).send(rendered)` after verifying the agent exists and is not archived;
   - `prompt` + no `agentId` → `paseo.agents.create({ config: { provider }, cwd, prompt, title, labels })`, or `paseo.workspaces.ref(id).agents.create(...)` with `worktree: { mode: "branch-off", newBranch }` when the worktree option is set;
   - `shell` → `paseo.terminals.create({ workspaceId, name })` followed by `handle.write(rendered + "\n")`.
4. The run is appended to `history.json` and the command's `useCount` is incremented in `commands.json`.

## 3. Design decisions and SDK findings (0.9.0)

Verified against the running daemon and `@getpaseo/plugin@0.9.0` / `@getpaseo/client` type definitions:

- **No react-query in the plugin host.** `@tanstack/react-query` is not resolvable from plugin client code. The surface therefore uses `useRpc(...)` + `useState`/`useEffect` with an explicit reload key, mirroring the session-manager panel.
- **`useRpc` returns a plain promise function**, not a query hook: `(input) => Promise<Output>`.
- **`paseo.agents.create` requires `cwd`** and `config.provider` is mandatory. The executor falls back to `workspaceDirectory → projectRootPath → process.cwd()`.
- **`worktree: true` does not exist.** The wire schema is a discriminated union: `{ mode: "branch-off", newBranch: string, base? }` | `{ mode: "checkout-branch", branch }` | `{ mode: "checkout-pr", prNumber }`. Branch-off requires an explicit branch name, so the executor generates `command-center/<slug>-<base36 time>`.
- **Creating an agent inside a workspace** goes through `paseo.workspaces.ref(id).agents.create(options)` (`Omit<PaseoAgentCreateOptions, "cwd">`); the daemon then pins the agent to that workspace.
- **Provider list**: `paseo.providers.snapshot()` returns entries `{ provider, status, enabled, ... }`. The editor shows them as one-tap chips; the value stored is just `provider/model` (a bare provider id is accepted by the daemon when no model is required).
- **Terminals**: `terminals.create({ workspaceId, name })` → `PaseoTerminalHandle` with `write(data)`. There is no execution acknowledgement; the write is fire-and-forget by design.
- **Workspace descriptor fields**: `name`, `title`, `projectCustomName`, `projectRootPath`, `workspaceDirectory`, `status`. The UI prefers `projectCustomName ?? title ?? name`.
- **Agent snapshot fields**: `id`, `title`, `status` (`error|initializing|idle|running|closed`), `archivedAt`. "Open" means `status !== "closed"` and no `archivedAt`.
- **Slash command context**: `onSubmit` receives `{ args, paseo, rpc, openSurface, workspace, agent }`; `rpc(contract, input)` is typed by the contract.
- **Manifest**: the daemon rejects unknown manifest keys — a `version` key makes `plugin add` fail with `Unrecognized key: "version"` (same behavior as the `description` key in 0.8.x). Only `id` and `requirements` are currently accepted.
- **Theming**: React Native `Text`/`TextInput` default to black, which is unreadable on the dark Paseo background. The surface therefore reads `theme` from `PluginSurfaceProps` (`theme.colors.foreground`, `foregroundMuted`, `border`) and threads it into `CommandForm` and `RunDialog`; inputs also set `placeholderTextColor`. No color is hardcoded.
- **Safety**: sending to an archived/unknown agent is refused with a readable error instead of dispatching into the void.

## 4. Storage

`$PASEO_HOME/plugins/command-center/` (respects `PASEO_HOME` for tests):

| File | Content |
| --- | --- |
| `commands.json` | `CommandDefinition[]`, sorted by name, favorites first in UI |
| `history.json` | last 50 `HistoryEntry` entries, newest first |

Writes are atomic (temp file + rename). A corrupted file is treated as empty rather than crashing the plugin.

`useCount` is server-owned: the client editor sends its stale value, but `save` preserves the stored counter and `run` increments it.

## 5. RPC surface

| Contract | Input | Output |
| --- | --- | --- |
| `command-center.list` | `{}` | `{ commands }` |
| `command-center.save` | `{ command?, deleteId? }` | `{ saved, id, error }` — delete-then-save in one call |
| `command-center.delete` | `{ id }` | `{ deleted }` |
| `command-center.favorite` | `{ id, favorite }` | `{ ok }` |
| `command-center.history` | `{}` | `{ entries }` |
| `command-center.history-clear` | `{}` | `{ ok }` |
| `command-center.run` | `{ commandId, values, workspaceId?, agentId?, newWorktree? }` | `RunResult` |

All schemas are zod schemas in `shared/commands.ts`; the same module is imported by server and client, so contracts cannot drift.

## 6. Compatibility

Verified on 2026-09-22 against the running daemon `paseo 0.9.0` with `@getpaseo/plugin@0.9.0`:

- `npm run typecheck` — clean.
- `npx vitest run` — 5 suites, 37 tests, all green.
- `paseo plugin add <dir>` → status `running`, daemon logs show `Plugin ready` with no plugin errors.
- The `version` manifest key is rejected by 0.9.0 (`Unrecognized key`) — the key must not be reintroduced until the daemon accepts it.

## 7. Limitations

- **Shell commands are write-only.** The terminal is created and the line is typed, but output is not captured or returned; use the terminal UI to see results.
- **One host.** Commands live on the daemon host's filesystem; multi-host setups would need sync or per-host copies.
- **No secrets.** Templates are plain files; do not put tokens into templates.
- **Worktree runs require a git workspace.** Branch-off mode on a non-git directory will fail with a daemon-side error surfaced in the run dialog.
- **History is linear and bounded** (50 entries); there is no per-command filtering yet.
- **`/cc` runs with defaults** — empty inputs fall back to template defaults and the workspace is picked server-side; a matching command name is required.

## 8. Roadmap (technically feasible on SDK 0.9)

Ordered by value/effort, all verified to exist in the SDK:

1. **Trigger automation** — `server.on("workspace.created" | "agent.turn_ended", ...)` lifecycle hooks: auto-run a command when a workspace opens or when an agent finishes a turn (e.g. auto-run tests after each completed task).
2. **Workflows** — a command type that chains several steps (create workspace → create agent → wait → send follow-up) using `agent.run()/waitForFinish()`; needs per-step state persisted in the store.
3. **Keyboard shortcuts** — global hotkeys per command; requires host support for keybinding registration (not present in 0.9), otherwise emulable via Command Center items only.
4. **Import/export & sharing** — export `commands.json` selections as a shareable JSON or install from a git repo (mirroring how Paseo plugins are distributed).
5. **Multi-agent fan-out** — dispatch one rendered prompt to N agents in parallel via `agents.create` with an idempotency key; merge strategies need a new aggregator step.
6. **Cross-host sync** — replicate the store across daemons using `useHosts()` + per-host `getPaseoClient(serverId)` RPCs.
7. **Command parameters beyond strings** — file pickers, workspace pickers as first-class variable types in the run dialog.
8. **Usage analytics** — aggregate `useCount`/history into a "most used" section; data already exists.
9. **MCP injection** — commands that attach an MCP server config to the created agent via `config.mcpServers`.
