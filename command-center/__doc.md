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
│   ├── command-center-surface.tsx  # library + history tabs, editor host, run modal, multi-host fan-out
│   ├── command-form.tsx            # create/edit form, provider/model picker
│   ├── run-dialog.tsx              # multi-select workspaces, provider/model picker, live preview, per-target results
│   ├── provider-model-picker.tsx   # dropdown for full `provider/model` references with filter
│   ├── dispatch.ts                 # client-side executor mirror for non-local hosts (multi-host fan-out)
│   └── preview.ts                  # preview rendering helper
└── tests/                     # vitest suites (5 files, 51 tests)
```

Data flow for a run:

1. The run dialog resolves N targets (workspace multi-select grouped by host, optional provider override, optional existing agent for a single target) and fills variable values, previewing the rendered result locally with the same renderer the server uses.
2. Local targets (this daemon) go through `command-center.run-batch` in one call; the executor runs them sequentially and records one history entry per target. A failure on one target does not stop the rest.
3. Targets on other hosts are dispatched from the client via `getPaseoClient(serverId)` using `client/dispatch.ts` — a mirror of the daemon executor, sharing `renderTemplate` and `worktreeBranchFor` from `shared/template.ts` so naming and rendering cannot drift. Results are reported back through `command-center.history-append`.
4. `command-center.run` (single target) is kept unchanged for the `/cc` slash command. Per-target dispatch rules (both executors):
   - `prompt` + `agentId` → `paseo.agents.ref(id).send(rendered)` after verifying the agent exists and is not archived;
   - `prompt` + no `agentId` → `paseo.agents.create({ config: { provider }, cwd, prompt, title, labels })`, or `paseo.workspaces.ref(id).agents.create(...)` with `worktree: { mode: "branch-off", newBranch }` when the worktree option is set;
   - `shell` → `paseo.terminals.create({ workspaceId, name })` followed by `handle.write(rendered + "\n")`.
5. Every successful target appends one entry to `history.json`; `useCount` grows by the number of successful targets.

## 3. Design decisions and SDK findings (0.9.0)

Verified against the running daemon and `@getpaseo/plugin@0.9.0` / `@getpaseo/client` type definitions:

- **No react-query in the plugin host.** `@tanstack/react-query` is not resolvable from plugin client code. The surface therefore uses `useRpc(...)` + `useState`/`useEffect` with an explicit reload key, mirroring the session-manager panel.
- **`useRpc` returns a plain promise function**, not a query hook: `(input) => Promise<Output>`.
- **`paseo.agents.create` requires `cwd`** and `config.provider` is mandatory. The executor falls back to `workspaceDirectory → projectRootPath → process.cwd()`.
- **`worktree: true` does not exist.** The wire schema is a discriminated union: `{ mode: "branch-off", newBranch: string, base? }` | `{ mode: "checkout-branch", branch }` | `{ mode: "checkout-pr", prNumber }`. Branch-off requires an explicit branch name, so the executor generates `command-center/<slug>-<base36 time>`.
- **Creating an agent inside a workspace** goes through `paseo.workspaces.ref(id).agents.create(options)` (`Omit<PaseoAgentCreateOptions, "cwd">`); the daemon then pins the agent to that workspace.
- **Provider list**: `paseo.providers.snapshot()` returns entries `{ provider, status, enabled, ... }`, optionally with inline `models`. The surface resolves models per enabled provider (inline first, `providers.listModels(id)` as fallback, loaded before the run modal can open) and offers only full `provider/model` references via a dropdown; disabled providers and providers without models are hidden entirely, not dimmed.
- **Provider/model format**: the daemon rejects bare provider ids (`Expected config.provider in 'provider/model' format`) — and worse, an unknown model does not error but silently falls back to the provider default. The daemon splits the reference on the FIRST "/" and looks up the remainder in the provider catalog, while catalog model ids may themselves contain slashes (provider `opencode` lists model id `opencode/mimo-v2.6-flash-free`). The reference must therefore always be composed as `<providerId>/<modelIdAsListed>` (`opencode/opencode/mimo-v2.6-flash-free`, as seen on agents created by the Paseo UI). `fullModelRef` implements this; `resolveModelRef` additionally re-qualifies stale stored values against the live catalog and falls back to the default model. Both executors validate with `isFullModelRef`; the run dialog blocks Run until a full reference is picked.
- **Terminals**: `terminals.create({ workspaceId, name })` → `PaseoTerminalHandle` with `write(data)`. There is no execution acknowledgement; the write is fire-and-forget by design.
- **Workspace descriptor fields**: `name`, `title`, `projectCustomName`, `projectRootPath`, `workspaceDirectory`, `status`. The UI prefers `projectCustomName ?? title ?? name`.
- **Agent snapshot fields**: `id`, `title`, `status` (`error|initializing|idle|running|closed`), `archivedAt`. "Open" means `status !== "closed"` and no `archivedAt`.
- **Slash command context**: `onSubmit` receives `{ args, paseo, rpc, openSurface, workspace, agent }`; `rpc(contract, input)` is typed by the contract.
- **Manifest**: the daemon rejects unknown manifest keys — a `version` key makes `plugin add` fail with `Unrecognized key: "version"` (same behavior as the `description` key in 0.8.x). Only `id` and `requirements` are currently accepted.
- **Theming**: React Native `Text`/`TextInput` default to black, which is unreadable on the dark Paseo background. The surface therefore reads `theme` from `PluginSurfaceProps` (`theme.colors.foreground`, `foregroundMuted`, `border`) and threads it into `CommandForm` and `RunDialog`; inputs also set `placeholderTextColor`. No color is hardcoded.
- **Multi-host split**: `PluginServerContext.paseo` is bound to one daemon, so the server cannot reach other daemons. Fan-out across hosts is therefore split — local targets via `command-center.run-batch`, remote targets via per-host `PaseoApi` from `getPaseoClient(serverId)` with host enumeration from `useHosts()`. `useHosts()` is wrapped in try/catch with a single-host fallback for older hosts.
- **Provider override**: the stored `command.provider` is only the default. `run`/`run-batch` accept an optional per-target `provider`; the executor uses `input.provider ?? command.provider`. The dialog offers the union of providers reported by the selected targets' hosts.
- **Workspace picker is always visible**, including global prompts: the old behavior (hidden picker, silent server-side best-guess) left users with no control over `cwd` and `{{workspace.*}}` context. Deselecting everything keeps the legacy best-guess path.
- **Safety**: sending to an archived/unknown agent is refused with a readable error instead of dispatching into the void.

## 4. Storage

`$PASEO_HOME/plugins/command-center/` (respects `PASEO_HOME` for tests):

| File | Content |
| --- | --- |
| `commands.json` | `CommandDefinition[]`, sorted by name, favorites first in UI |
| `history.json` | last 50 `HistoryEntry` entries, newest first — each with the used `provider`, the render `values`, and a `batchId` grouping fan-out runs (all optional: pre-upgrade entries parse without them) |

Writes are atomic (temp file + rename). A corrupted file is treated as empty rather than crashing the plugin.

`useCount` is server-owned: the client editor sends its stale value, but `save` preserves the stored counter and `run` increments it.

Each history card shows the used model and agent (resolved live from the agents list, falling back to the id prefix) and a "Repeat the task" button that reopens the run dialog prefilled with the recorded values, target workspace, model, and — when still open — the same agent. Entries whose command was deleted show a disabled button instead.

## 5. RPC surface

| Contract | Input | Output |
| --- | --- | --- |
| `command-center.list` | `{}` | `{ commands }` |
| `command-center.save` | `{ command?, deleteId? }` | `{ saved, id, error }` — delete-then-save in one call |
| `command-center.delete` | `{ id }` | `{ deleted }` |
| `command-center.favorite` | `{ id, favorite }` | `{ ok }` |
| `command-center.history` | `{}` | `{ entries }` |
| `command-center.history-clear` | `{}` | `{ ok }` |
| `command-center.run` | `{ commandId, values, workspaceId?, agentId?, newWorktree?, provider? }` | `RunResult` (kept for the `/cc` slash command) |
| `command-center.run-batch` | `{ commandId, values, targets }` — 1–20 targets of `{ workspaceId?, agentId?, provider?, newWorktree? }` | `{ results: RunResult[] }`, one entry per target in order |
| `command-center.history-append` | `{ entry }` without `id`/`at` (stamped server-side) | `{ ok, id }` — used by multi-host client dispatch |

All schemas are zod schemas in `shared/commands.ts`; the same module is imported by server and client, so contracts cannot drift.

## 6. Compatibility

Verified on 2026-09-22 against the running daemon `paseo 0.9.0` with `@getpaseo/plugin@0.9.0`:

- `npm run typecheck` — clean.
- `npx vitest run` — 5 suites, 58 tests, all green.
- `paseo plugin add <dir>` → status `running`, daemon logs show `Plugin ready` with no plugin errors.
- The `version` manifest key is rejected by 0.9.0 (`Unrecognized key`) — the key must not be reintroduced until the daemon accepts it.

## 7. Limitations

- **Shell commands are write-only.** The terminal is created and the line is typed, but output is not captured or returned; use the terminal UI to see results.
- **One host.** Commands live on the daemon host's filesystem; multi-host setups would need sync or per-host copies.
- **No secrets.** Templates are plain files; do not put tokens into templates.
- **Worktree runs require a git workspace.** Branch-off mode on a non-git directory will fail with a daemon-side error surfaced in the run dialog.
- **History is linear and bounded** (50 entries); repeat works per entry (batch re-runs are repeated one target at a time); there is no per-command filtering yet.
- **`/cc` runs with defaults** — empty inputs fall back to template defaults and the workspace is picked server-side; a matching command name is required.

## 8. Roadmap (technically feasible on SDK 0.9)

Ordered by value/effort, all verified to exist in the SDK:

1. **Trigger automation** — `server.on("workspace.created" | "agent.turn_ended", ...)` lifecycle hooks: auto-run a command when a workspace opens or when an agent finishes a turn (e.g. auto-run tests after each completed task).
2. **Workflows** — a command type that chains several steps (create workspace → create agent → wait → send follow-up) using `agent.run()/waitForFinish()`; needs per-step state persisted in the store.
3. **Keyboard shortcuts** — global hotkeys per command; requires host support for keybinding registration (not present in 0.9), otherwise emulable via Command Center items only.
4. **Import/export & sharing** — export `commands.json` selections as a shareable JSON or install from a git repo (mirroring how Paseo plugins are distributed).
5. **Multi-agent fan-out** — done for workspaces/hosts via `run-batch` + client dispatch; per-agent (N existing agents as targets) fan-out is still open.
6. **Cross-host sync** — runs across hosts are done (client dispatch); *store* sync (shared `commands.json` across daemons) is still open and would use `useHosts()` + per-host `getPaseoClient(serverId)` RPCs.
7. **Command parameters beyond strings** — file pickers, workspace pickers as first-class variable types in the run dialog.
8. **Usage analytics** — aggregate `useCount`/history into a "most used" section; data already exists.
9. **MCP injection** — commands that attach an MCP server config to the created agent via `config.mcpServers`.
