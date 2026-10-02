# Command Center — technical documentation

This file documents the internal design, verified compatibility, and the roadmap of the `command-center` plugin. User-facing description: [README.md](./README.md).

## 1. Purpose and scope

Command Center turns recurring prompts and terminal lines into named, parameterized commands that can be dispatched to any Paseo workspace or agent. It is orchestration glue on top of the Paseo plugin SDK; it does not talk to coding agents directly and stores no credentials.

The concept was inspired by [stablyai/orca](https://github.com/stablyai/orca) (a command dropdown) but is implemented as a full Paseo surface with a library, editor, run dialog, and history.

## 2. Architecture

```
command-center/
├── index.server.ts            # RPC handlers, settings registration, lifecycle hooks,
│   │                          # attachment-search handler (list/save/delete/favorite/history/
│   │                          # run/schedules/attachment-search)
├── index.client.tsx           # surface, sidebar item, ⌘K items, /cc slash command
│   │                          # (list|history|schedule|<name>), attachment source,
│   │                          # settings screen registration
├── shared/
│   ├── commands.ts            # zod schemas (incl. commandSchema.mcpServers), RPC contracts
│   │                          # (defineRpc), types
│   ├── settings.ts            # host-scoped plugin settings definition (defineSettings)
│   ├── schedules.ts           # schedule view models, RPC contracts, cadence helpers (client-safe)
│   ├── template.ts            # pure template renderer + input discovery (client-safe)
│   ├── search.ts              # pure command search/filter over name, category, template, variables
│   └── host-fonts.ts          # host Appearance settings parsing + font scale math (client-safe)
├── server/
│   ├── store.ts               # atomic JSON storage in $PASEO_HOME/plugins/command-center
│   ├── executor.ts            # run engine: resolve target, render, dispatch, log
│   ├── daemon-connection.ts   # lazy DaemonClient singleton to the local daemon websocket
│   ├── schedules.ts           # schedule bridge: daemon schedule/* RPCs ↔ plugin contracts
│   ├── schedules-mapping.ts   # pure daemon→view mapping (unit-tested)
│   ├── schedule-links.ts      # schedules.json link store (scheduleId ↔ commandId)
│   └── (template.ts removed — shared module is used instead)
├── client/
│   ├── command-center-surface.tsx  # library + history + schedules tabs, editor host, run modal, fan-out
│   ├── command-form.tsx            # create/edit form, provider/model picker, defaultProvider from settings
│   ├── settings-screen.tsx         # Paseo Settings → Plugins screen (host settings via useSettings)
│   ├── run-dialog.tsx              # multi-select workspaces, provider/model picker, preview, Schedule… button
│   ├── schedule-dialog.tsx         # cadence presets, cron input, max runs, run-on-create
│   ├── schedules-tab.tsx           # schedule list: status, next/last run, actions, run history
│   ├── provider-model-picker.tsx   # dropdown for full `provider/model` references with filter
│   ├── dispatch.ts                 # client-side executor mirror for non-local hosts (multi-host fan-out)
│   ├── use-host-typography.ts     # hook: host font settings → scale + families
│   └── preview.ts                  # preview rendering helper
└── tests/                     # vitest suites (9 files, 98 tests)
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
- **Manifest**: the daemon rejects unknown manifest keys — a `version` key makes `plugin add` fail with `Unrecognized key: "version"`. The accepted keys are `id`, `description`, `requirements` and `build` (see §5f for what `build` does).
- **Theming**: React Native `Text`/`TextInput` default to black, which is unreadable on the dark Paseo background. The surface therefore reads `theme` from `PluginSurfaceProps` (`theme.colors.foreground`, `foregroundMuted`, `border`) and threads it into `CommandForm` and `RunDialog`; inputs also set `placeholderTextColor`. No color is hardcoded. Font sizes are scaled through `shared/host-fonts.ts` (see 5b).
- **No dropdown Menu component**: the host exposes only `Modal`, `Icon`, `ScrollView`, `FlatList`, `TextInput`, `copyText`, toasts from `client/react-native` — there is no `Menu`/`Picker`. The category picker is therefore chips + a plain text input.
- **Multi-host split**: `PluginServerContext.paseo` is bound to one daemon, so the server cannot reach other daemons. Fan-out across hosts is therefore split — local targets via `command-center.run-batch`, remote targets via per-host `PaseoApi` from `getPaseoClient(serverId)` with host enumeration from `useHosts()`. `useHosts()` is wrapped in try/catch with a single-host fallback for older hosts.
- **Provider override**: the stored `command.provider` is only the default. `run`/`run-batch` accept an optional per-target `provider`; the executor uses `input.provider ?? command.provider`. The dialog offers the union of providers reported by the selected targets' hosts.
- **Workspace picker is always visible**, including global prompts: the old behavior (hidden picker, silent server-side best-guess) left users with no control over `cwd` and `{{workspace.*}}` context. Deselecting everything keeps the legacy best-guess path.
- **Safety**: sending to an archived/unknown agent is refused with a readable error instead of dispatching into the void.

## 4. Storage

`$PASEO_HOME/plugins/command-center/` (respects `PASEO_HOME` for tests):

| File | Content |
| --- | --- |
| `commands.json` | `CommandDefinition[]`, sorted by name, favorites first in UI |
| `categories.json` | known category labels `CommandCategory[]` (`{ name, sortKey }`), deduped case-insensitively on load |
| `history.json` | last N `HistoryEntry` entries, newest first (N = `historyLimit` setting, default 50, range 10–500) — each with the used `provider`, the render `values`, and a `batchId` grouping fan-out runs (all optional: pre-upgrade entries parse without them) |

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
| `command-center.categories` | `{}` | `{ categories: CommandCategory[] }` — stored labels plus implicit ones found on commands |
| `command-center.categories-save` | `{ category?, renameFrom?, deleteName? }` | `{ ok, error }` — create/rename/delete in one call; deleting unsets the label on referencing commands |
| `command-center.schedules` | `{}` | `{ schedules: ScheduleView[] }` — every daemon schedule plus the plugin link (commandId/commandName); prunes stale links |
| `command-center.schedule-create` | `{ commandId, values, provider, cron, name?, workspaceId?, cwd?, newWorktree?, archiveOnFinish?, maxRuns?, runOnCreate? }` | `{ ok, id, view, error }` — renders the template once, creates the daemon schedule, stores the link |
| `command-center.schedule-action` | `{ id, action: pause\|resume\|run-once\|delete }` | `{ ok, error }` |
| `command-center.schedule-runs` | `{ id }` | `{ runs: ScheduleRun[] }` — daemon run log (status/timing/agent/output/error) |
| `command-center.schedule-update` | `{ id, cron?, maxRuns? }` | `{ ok, error }` — cadence/run-cap edits |
| `command-center.attachment-search` | `{ query }` | `{ items }` ≤ 20 — multi-term search over name/template/category for the composer attachment picker (`identifier`, `url`, `text` = raw template, `resourceType`) |

All schemas are zod schemas in `shared/commands.ts`; the same module is imported by server and client, so contracts cannot drift.

## 5a. Categories and search

### Categories

- `CommandDefinition.category` — an optional free-form label (≤ 40 chars, trimmed). There is no fixed taxonomy: the picker in the editor lists stored labels, and a typed new label is registered through `categories-save` right after the command is saved.
- `categories.json` is the source of truth for the label list. Commands may reference labels missing from it (manual edits, sync races); `listCategories` merges such "implicit" labels into the response so the filter never silently hides commands.
- Deleting a category unsets it on all referencing commands (server-side, single write). Renaming moves commands over in the same call.
- UI: a chip row above the library (rendered only when at least one command has a category); `All` resets the filter. The active category is highlighted with the accent color.

### Search

- Pure module `shared/search.ts`: `commandMatchesQuery` (multi-term AND, case-insensitive over name + category + template + variable prompts/names) and `commandMatchesCategory` (exact label, `null` = show all).
- The search field is toggled with the `Search` button in the library toolbar; clearing the query or toggling it off resets filtering. Filtering composes with the category chips and favorites-first ordering.
- Search is client-side over the already-loaded list — command libraries are small (dozens), so an index or an RPC-side search is unnecessary complexity at this scale.

## 5b. Host typography (fonts from Paseo Appearance settings)

### The problem

Paseo's `PluginTheme` passes **colors only** — there is no typography API in SDK 0.9 (verified in `@getpaseo/plugin/dist/contracts.d.ts` and in the host bundle). Meanwhile the desktop app has full Appearance settings (since 0.1.88): interface font, code font, interface text size, code text size. Plugin UIs hardcode px sizes, so with a larger-than-default interface size configured, plugin text renders smaller than the rest of the app. This is a host-side gap, not a plugin bug.

### How the host applies its settings (reverse-engineered from the 0.9 app bundle)

- Font **sizes** scale only inside the host's Unistyles theme: `FONT_SIZE = { sm: 12, base: 14, lg: 16, xl: 18, 2xl: 20, 3xl: 22, 4xl: 26 }`, factor `k = uiBaseFontSize / 14`. Plugin React components cannot read Unistyles.
- Font **family** is applied document-wide via injected CSS: `applyRootUiFont` sets `--paseo-ui-font` on `documentElement` plus the rule `:is(#root, #overlay-root) *:not([data-pmono]):not([data-pmono] *) { font-family: var(--paseo-ui-font) }`. So a configured interface font DOES reach plugin text in the web/desktop runtime already; but the CSS variable is only set when the user configured a custom font (empty = no variable, system stack applies).
- Settings are persisted to web `localStorage` under `@paseo:app-settings` (keys: `uiFontFamily`, `monoFontFamily`, `uiBaseFontSize`, `contentFontSize`, `codeFontSize`). Observed live values: `uiFontFamily: "Roboto…"`, `monoFontFamily: "Fira Code"`, `uiBaseFontSize: 16` (host default 14).

### The plugin-side solution

`shared/host-fonts.ts` + `client/use-host-typography.ts` (copied 1:1 into session-manager):

1. Read `@paseo:app-settings` from `localStorage` (synchronous, in-page; falls back to defaults when unavailable, e.g. native runtime).
2. Compute `scale = uiBaseFontSize / 14` (legacy `uiFontSize` percent-style field migrated the same way the host does), sanitized font families (same character strip as the host's `sanitizeFontFamily`).
3. Every previously hardcoded `fontSize: N` in the surface/form/dialog becomes `fontSize: scaledFont(N, typography)` — an integer px that tracks the user's setting.
4. When the user configured an interface font, it is applied explicitly as `fontFamily` (helps runtimes where the host CSS rule does not reach); when empty, no `fontFamily` is set so the host rule/system stack stays in effect. Same for the code font on template/preview texts.

Limitations: changes apply on next mount (settings change rarely; re-reading per render would add jank); the scale tracks `uiBaseFontSize` only — `contentFontSize`/`codeFontSize` are parsed but intentionally not applied (the host uses them for chat/code panes, not UI chrome). If the host later adds typography to `PluginTheme`, this module should be replaced by it.

## 5c. Scheduler integration (standard Paseo Schedules)

### Daemon API findings (verified live against 0.9.2)

- The schedule RPCs (`schedule/create|list|inspect|logs|pause|resume|delete|run-once|update`) live on the **low-level `DaemonClient`** (`@getpaseo/client/internal/daemon-client`), **not** on `PaseoApi` — `context.paseo` (server) and `usePaseo()`/`getPaseoClient()` (client) do not expose them.
- The plugin server process therefore opens its own websocket connection to the local daemon: URL from `$PASEO_HOME/config.json` → `daemon.listen` (default `ws://127.0.0.1:6767/ws`; the websocket endpoint is `/ws`). `server/daemon-connection.ts` keeps a lazy singleton with built-in reconnect; the client type is `cli` and reconnect resumes the same `clientId` session.
- This bridge is the **only** reason the plugin depends on a package Paseo does not supply, and it is what forces the install-time build step described in §5f.
- `automation.manage` permission strings in the daemon bundle apply to hub/relay connections only — a direct loopback client is not gated (verified by an end-to-end probe: create → inspect → pause → resume → update → delete all succeeded).
- Create payload: `{ name?, prompt, cadence: {type:"cron", expression, timezone?}, target: {type:"new-agent", config:{provider, cwd, isolation:"local"|"worktree", archiveOnFinish, ...}} | {type:"agent", agentId}, maxRuns?, runOnCreate? }`. The full `provider/model` reference (e.g. `zhipuai/MiMo-V2.6-Flash Free`) is accepted as-is.
- Responses carry `status: active|paused|completed`, `nextRunAt/lastRunAt/maxRuns`; `scheduleLogs` returns runs `{status: running|failed|succeeded, startedAt, endedAt, agentId, output, error}` — this is the run-tracking source of truth.
- Schedules always execute on the daemon that owns them (the native form's "Host" field) — multi-host fan-out does not apply to scheduling.

### Plugin design

- The daemon owns schedules; the plugin adds command-centric management. `schedules.json` maps `scheduleId → {commandId, commandName}` so the Schedules tab can show the creating command; links to schedules deleted elsewhere are pruned on the next list.
- **Create** has two entry points, both opening the same dialog (presets `*/15 * * * *`, `0 * * * *`, `0 */6 * * *`, `0 9 * * *`, `0 9 * * 1`, free cron, max runs, run-on-create):
  - the run dialog (`Schedule…`) — freezes exactly the values/provider/workspace/worktree previewed there;
  - the library card's `Schedule` button right after `Edit` — prefills the dialog from the stored command alone: `defaultValuesForCommand()` merges declared variables with `{{input:…}}` names discovered in the template, the prompt is rendered with those defaults, the stored `provider` is resolved against the live model catalog, and the first loaded workspace supplies the target cwd (shown in the dialog subtitle).
  - The prompt is rendered **once** and frozen — `{{input:…}}` and `{{date}}/{{time}}` do not re-resolve per run.
- **Track/manage** happens in the Schedules tab: status, humanized cadence (`describeCadence`), next/last run, pause/resume, run-now, inline cadence editing (`scheduleUpdate`), delete, and the last 10 runs per schedule from `scheduleLogs`.
- Shell commands are schedulable too: the scheduler runs prompts only, so `schedulePromptFor(type, rendered)` (shared module) wraps the rendered line into an agent instruction with a fenced `sh` block. The schedule dialog preview and the server's create path call the same helper, so what the user sees is exactly what the daemon stores.
- Cwd is required by the daemon `new-agent` target: the dialog passes the selected workspace directory, else the creation fails with a readable error.

## 5d. Version 0.5.0 — settings, automation hooks, MCP injection, attachment source

All features below are verified against `@getpaseo/plugin@0.10.1` type definitions; the SDK reference for this release is Paseo `0.10.1`.

### Settings screen (host-scoped settings)

- `shared/settings.ts` defines `commandCenterSettings = defineSettings({ id: "command-center", scope: "host", version: 1, schema })` with four fields: `historyLimit` (10–500, default 50), `defaultProvider` (prefilled for new prompt commands), `autoRunCommandOnTurnEnd` and `bootstrapCommand` (automation: command **names**, resolved by the server at event time — renamed/deleted commands simply stop firing, no stale ids).
- The server registers the definition via `server.registerSettings(...)` (see §2), reads it once at startup and on every change (`settings.subscribe`) to apply `setHistoryLimit` + `enforceHistoryLimit` live, without a restart.
- The client contributes a screen via `client.addSettingsScreen` → Paseo Settings → Plugins → Command Center ([settings-screen.tsx](./client/settings-screen.tsx)). The UI is built from `@getpaseo/plugin/client/ui` components (`SettingsCard`/`SettingsSection`/`SettingsInput`/`SettingsSwitch`) — note this is a **separate subpath import**, not part of `@getpaseo/plugin/client`.
- `CommandForm` pre-fills `defaultProvider` from settings (via `useSettings`) so new prompt commands start with the configured model.

### Lifecycle-hook automation

- `agent.turn_ended` — when `event.outcome.kind === "completed"`, runs the command named in `autoRunCommandOnTurnEnd` with template defaults (`values: {}`). Prompt commands only (a shell line cannot sensibly "auto-run" after every turn). Errors are swallowed: a failing auto-run must not break the agent that just finished.
- `workspace.created` — runs the `bootstrapCommand` command in the new workspace (`workspaceId: event.workspace.id`): install deps, lint, build. Same defaults-and-swallow-errors policy.
- Both handlers resolve the command by **name, case-insensitively**, at event time — automation config survives command renames that keep the name and never dangles pointers to deleted commands.

### MCP server injection

- `commandSchema.mcpServers` (shared/commands.ts) — a strict zod union matching the SDK `McpServerConfig`: `{ type: "stdio", command, args?, env?, alwaysLoad? } | { type: "http", url, headers?, alwaysLoad? } | { type: "sse", url, headers?, alwaysLoad? }`.
- `executor.ts` passes `{ provider, mcpServers: command.mcpServers }` into `agents.create` config on both the local and multi-host dispatch paths. Per-command MCP attachment — a command can, e.g., always create its agents with a GitHub MCP server attached.
- Injection happens **per command** at creation time, not via `server.before("agent.create")`: the plugin only intercepts its own agent creations, and config-level attachment is the explicit, user-visible way to do it. A global `before("agent.create")` hook would silently modify agents created by other surfaces and was intentionally not used.

### Attachment source (composer picker)

- `client.addAttachmentSource(defineAttachmentSource({ ... search: searchCommandsForAttachment }))` — the Command Center appears in the composer attachment picker; searching runs the `command-center.attachment-search` RPC against the server store.
- The handler does a multi-term AND search over name/template/category, returns ≤ 20 items with `identifier: "command-center:<id>"`, `url: "command-center://command/<id>"`, `resourceType: prompt-command | shell-command`, and `text` = the **raw template** (inputs stay as `{{input:…}}` tokens for the user to fill in the message).
- SDK constraint honored: the attachment item contract requires `url` to be a `ZodURL`, hence the custom `command-center://command/<id>` scheme instead of a bare id.

### `/cc` slash command extensions

The slash context has **no message channel** — output can only be shown by opening the surface, so the subcommands navigate rather than print:

- `/cc` or `/cc list` — opens the surface (library listing).
- `/cc history` — opens the surface on the history view.
- `/cc schedule <name> <cron> [scheduleName]` — creates a daemon schedule from a prompt command that has a stored provider; falls back to the first workspace server-side (`createSchedule` without `workspaceId`). Defaults to `0 9 * * *` when the cron argument is omitted.
- `/cc <command name>` — runs the command with template defaults (unchanged behavior).

## 5e. Ideas evaluated and not implemented (why)

The 10-idea analysis for 0.5.0; every item verified against the 0.10.1 SDK and host bundle before deciding.

### Composer pills — not implemented (SDK constraint)

`client.addComposerPill` requires both `workspaceId` and **`agentId`** — pills are per-agent, not global. The host bundle throws `Plugin composer pill needs an agent` when `agentId` is empty. There is no plugin-side hook that fires "for every open chat", so a pill cannot be attached to arbitrary conversations at plugin startup. Command Center remains reachable from chats via `/cc` and the ⌘K items. Revisit if the SDK grows a per-surface or global pill registration.

### Timeline transformer/renderer for command runs — not implemented (architecture)

`addTimelineTransformer` can only transform items whose `itemType` is a valid `AgentTimelineItem` type. Command Center runs are **not** tool calls: the plugin server creates agents/terminals directly via daemon RPCs, so no `tool_call` timeline item is ever produced that could be transformed. There is nothing in the agent timeline to hook into. Rendering run cards in the agent chat would require the host to emit plugin-attributed timeline items — a host-side change.

### Theme contribution — intentionally skipped

The host already supplies a full `PluginTheme` (colors, appearance) to plugin surfaces, and the plugin follows host Appearance settings for typography (§5b). A custom `addTheme` theme would fight the host theme (mismatched borders/foreground) for negligible value. Revisit only if the host lets users opt into plugin themes.

### Workflows (multi-step chained commands) — deferred

The schema extension (a `workflow` command type with conditional steps `always | on-success | on-failure`) is straightforward and does not require new SDK APIs — the executor already runs batches sequentially and knows per-target success/failure. Deferred as a scope decision: 0.5.0 was already large, and a workflow editor UI (step ordering, conditions, failure handling) plus per-step state in the store is a feature-sized change on its own. Natural candidate for 0.6.0.

### Web dashboard / remote access — deferred

The surface is a React Native component rendered inside the host webview; "read-only view on a phone" would mean either a separate HTTP server exposing the store (new attack surface, token handling, host port management) or the host's own remote-access feature. High effort, medium value for a personal plugin.

## 5f. Version 0.5.1 — install-time resolution and the host bundler boundary

### The failure

`paseo plugin add /path/to/command-center` on a fresh checkout failed with:

```
[plugin: paseo-plugin-server-runtime-boundary] Could not resolve type dependency
"@getpaseo/client" imported by …/command-center/server/executor.ts
```

The reported file is the first one the check trips over; behind it were two more failures — the same type-only import in `server/schedules.ts` and the *runtime* import of `DaemonClient` in `server/daemon-connection.ts`.

### How the host resolves plugin imports

Paseo does not hand the plugin directory to esbuild as-is. It installs a boundary plugin (`paseo-plugin-server-runtime-boundary` / `…-client-…`, found in the desktop `app.asar`) that walks every source file reachable from `index.server.ts` / `index.client.tsx` and checks each import:

1. Files must live under `server/`, `client/`, `shared/` or be `index.server.*` / `index.client.*`; a `client/`-only module may not enter the server bundle and vice versa.
2. Imports are resolved with the **TypeScript resolver** (`ts.resolveModuleName`, `moduleResolution: Bundler`, options from the plugin's own `tsconfig.json`) — not with esbuild's resolver, because esbuild erases type-only imports and the check needs the original syntax.
3. A fixed list of specifiers is treated as **supplied by the host** and skipped entirely: `@getpaseo/plugin`, `@getpaseo/plugin/{client,client/ui,client/react-native,server,server/provider,server/acp}`, plus `zod`, `react`, `react-native`, `@tanstack/react-query`, `@types/node` and Node built-ins.
4. For any other **type-only** specifier that does not resolve, the check throws `Could not resolve type dependency "…"`. Value imports are left to esbuild (erased imports and guarded `require`s are legal), but a missing one still fails the build there.
5. Resolved packages under `node_modules` are accepted; the plugin's own `client/`/`server/`/`shared/` split is enforced recursively.

`@getpaseo/client` is **not** on the host-supplied list, so this plugin's scheduler bridge (§5c) made every install depend on a populated `node_modules`.

### Why a fresh checkout had none

- `node_modules` is git-ignored, so a clone has no dependencies.
- `paseo plugin add <directory>` goes through `installDirectory()`, which reads the manifest, registers the path and starts the plugin — it runs **no** build commands. Only the npm- and git-source path (`prepareInstall()` → `runPluginBuild(directory, manifest.build)`) executes anything, and it does so *before* the bundle is validated.
- `@getpaseo/client` was not a declared dependency at all: it arrived only as an auto-installed peer of `@getpaseo/plugin` (marked `"peer": true` in the lockfile), so it disappeared under `--legacy-peer-deps` / `--omit=peer` as well.

### The fix

1. `paseo-plugin.json` — `"build": [["npm", "ci"]]`. With the Git source
   (`paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:command-center`)
   the daemon clones the repository, installs the dependencies itself and only then bundles. This makes the documented one-command install self-sufficient; a local directory install still needs `npm ci` once, which the README states.
2. `package.json` — `@getpaseo/client` is now a declared, version-pinned dev dependency (`0.10.1`, matching `@getpaseo/plugin`) instead of an accidental peer. `package-lock.json` was regenerated: the root `version` field was stale at `0.4.1`, and the package lost its `"peer": true` marker.

Nothing about the plugin's behaviour changed — no runtime code was touched. The scheduler bridge still uses `DaemonClient` over the local websocket; it simply now has its dependency guaranteed to exist at install time.

### Verification

Reproduced the host's own walk statically (TypeScript resolver + the same exempt list + the same throw-on-unresolved-type rule) against a staged copy of the plugin with the manifest `build` commands executed first:

| State | server bundle | client bundle |
| --- | --- | --- |
| before the fix, no `node_modules` | 3 errors (`executor.ts`, `schedules.ts`, `daemon-connection.ts`) | 1 error (`client/dispatch.ts`) |
| before the fix, `npm ci` run | clean | clean |
| after the fix, staged + `build` commands | clean | clean |

Plus `npm run typecheck` (clean) and `npx vitest run` (9 suites, 98 tests). A live `paseo plugin add` into a running daemon was not performed as part of this change.

The same defect existed in three sibling plugins and was fixed the same way — see the repository [README](../README.md#installation).

## 6. Compatibility

Verified on 2026-10-02 against Paseo `0.10.3` with `@getpaseo/plugin@0.10.1` + `@getpaseo/client@0.10.1`:

- `npm run typecheck` — clean.
- `npx vitest run` — 9 suites, 98 tests, all green.
- Static reproduction of the host's bundler boundary check against a staged copy — no boundary errors in the server or client bundle (§5f).
- Earlier verification, on 2026-09-29 against Paseo `0.10.1`: live probe of the whole schedule lifecycle (create with full model ref, inspect, pause, resume, update, delete) succeeded, and `paseo plugin add <dir>` reached status `running` with `Plugin ready` in the daemon logs. That install used a working copy with `node_modules` already present — the path §5f fixes.
- The `version` manifest key is rejected by 0.10.x (`Unrecognized key`) — the key must not be reintroduced until the daemon accepts it.

### 6.1 Paseo 0.10.x changes affecting this plugin

Paseo 0.10.0 (2026-09-28) and 0.10.1 (2026-09-29) are **additive** for every API this plugin uses:

- **OpenCode v2 support** added — the plugin's provider resolution via `paseo.providers.snapshot()` and `providers.listModels()` automatically includes the new OpenCode v2 models when the daemon detects them. No plugin change required.
- **Password checks for relay connections** added — this is a daemon/network-layer change; the plugin's local loopback `DaemonClient` (server/daemon-connection.ts) is unaffected as it connects directly to the local daemon websocket without relay.
- **Settings reorganization** — superseded in 0.5.0: the plugin now contributes its own settings screen via `client.addSettingsScreen` + `server.registerSettings` (§5d), which is the SDK-native mechanism on 0.10.x.
- **Bug fixes** (workspace sidebar persistence, agent import, daemon startup, Pi/OpenCode/Codex edge cases) — none affect the plugin's RPC surface or client contributions.

The plugin's manifest range `>=0.8.0` already covers 0.10.x. The version was bumped to 0.5.0 (new functionality: settings screen, automation hooks, MCP injection, attachment source, `/cc` subcommands, history retention setting) and to 0.5.1 (bugfix: installation from a clean checkout, §5f).

## 7. Limitations

- **Shell commands are write-only.** The terminal is created and the line is typed, but output is not captured or returned; use the terminal UI to see results.
- **One host.** Commands live on the daemon host's filesystem; multi-host setups would need sync or per-host copies.
- **Schedules run on the local daemon only.** The native scheduler executes on the daemon that owns the schedule; there is no cross-host scheduling.
- **Scheduled prompts are frozen.** Variable values and workspace context are rendered at creation time; editing a command later does not change existing schedules (delete and recreate, or edit the cadence inline).
- **The bridge needs the daemon config.** `daemon-connection.ts` reads `daemon.listen` from `$PASEO_HOME/config.json`; if the daemon listens behind authentication, the bridge would need the password — not required in the default local setup (no password set).
- **No secrets.** Templates are plain files; do not put tokens into templates.
- **Worktree runs require a git workspace.** Branch-off mode on a non-git directory will fail with a daemon-side error surfaced in the run dialog.
- **History is linear and bounded** (default 50, user-configurable 10–500 via settings, §5d); repeat works per entry (batch re-runs are repeated one target at a time); there is no per-command filtering yet.
- **`/cc` runs with defaults** — empty inputs fall back to template defaults and the workspace is picked server-side; a matching command name is required. `list`/`history` only open the surface: the slash context has no message channel to print into.
- **Automation is best-effort.** Auto-run/bootstrap commands execute with template defaults and swallow errors (§5d); a failing automation never blocks the triggering event, and failures are only visible via the run history.
- **Installation needs the npm registry.** The manifest build step is `npm ci`, because the scheduler bridge depends on `@getpaseo/client`, which Paseo does not supply to plugins (§5f). A host without registry access cannot install or update this plugin; the other four plugins in this repository have no such requirement.

## 8. Roadmap

Ordered by value/effort, all verified to exist in SDK 0.10.1. Items 1 (trigger automation) and 9 (MCP injection) of the previous roadmap were delivered in 0.5.0 (§5d) and removed from this list.

1. **Workflows** — a `workflow` command type chaining several steps with `always | on-success | on-failure` conditions (§5e): the executor already runs batches sequentially, so the runtime is close; the work is the schema, per-step state, and a workflow editor UI.
2. **Keyboard shortcuts** — global hotkeys per command; requires host support for keybinding registration (not present in 0.10.x), otherwise emulable via Command Center items only.
3. **Import/export & sharing** — export `commands.json` selections as a shareable JSON or install from a git repo (mirroring how Paseo plugins are distributed).
4. **Multi-agent fan-out** — done for workspaces/hosts via `run-batch` + client dispatch; per-agent (N existing agents as targets) fan-out is still open.
5. **Cross-host sync** — runs across hosts are done (client dispatch); *store* sync (shared `commands.json` across daemons) is still open and would use `useHosts()` + per-host `getPaseoClient(serverId)` RPCs.
6. **Command parameters beyond strings** — file pickers, workspace pickers as first-class variable types in the run dialog.
7. **Usage analytics** — aggregate `useCount`/history into a "most used" section; data already exists.
8. **Composer pills / timeline run cards** — blocked today (§5e); revisit when the SDK gains global pill registration or plugin-attributed timeline items.
9. **Web dashboard** — deferred (§5e); revisit if the host adds a remote-access surface plugins can attach to.
