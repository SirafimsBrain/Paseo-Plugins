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
│   ├── share.ts               # portable library bundle: export/import/merge/copy (client-safe)
│   ├── targets.ts             # pure per-agent/per-workspace target planner (client-safe)
│   ├── variables.ts           # typed input resolution + directory-browse RPC (client-safe)
│   ├── analytics.ts           # library ordering + "most used" summary (client-safe)
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
│   ├── share-dialog.tsx            # export/import modal (clipboard + raw JSON URL)
│   ├── use-host-typography.ts     # hook: host font settings → scale + families
│   └── preview.ts                  # preview rendering helper
└── tests/                     # vitest suites (9 files, 98 tests)
```

Data flow for a run:

1. The run dialog resolves N targets (workspace multi-select grouped by host, optional provider override, and any number of existing agents — `shared/targets.ts` plans the union, with a selected agent replacing the new-agent run for its own workspace) and fills variable values, previewing the rendered result locally with the same renderer the server uses.
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
| `command-center.export` | `{ ids? }` | `{ json, count }` — versioned library bundle; omitted/empty `ids` exports everything |
| `command-center.import` | `{ json, mode: merge\|copy }` | `{ ok, added, updated, skipped, error }` — accepts a bundle or a bare `commands.json` array |
| `command-center.import-url` | `{ url, mode }` | same as `import` — fetches a raw http(s) JSON file (10 s timeout) |
| `command-center.browse` | `{ cwd, path }` | `{ path, entries, error }` — read-only directory listing for `file` inputs, via the local daemon's `listDirectory` |
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

The schema extension (a `workflow` command type with conditional steps `always | on-success | on-failure`) is straightforward and does not require new SDK APIs — the executor already runs batches sequentially and knows per-target success/failure. Deferred as a scope decision: 0.5.0 was already large, and a workflow editor UI (step ordering, conditions, failure handling) plus per-step state in the store is a feature-sized change on its own. Natural candidate for 0.6.0 — it actually shipped in **0.7.0** (§14.2), after 0.6.0 spent its scope on the §12.3 recommendations.

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
   the daemon clones the repository into `~/.paseo/plugins/command-center/<revision>/checkout/command-center`, installs the dependencies itself and only then bundles — the plugin's code, dependencies and rebuilt artifacts all live in the Paseo home. This is the only supported source for this repository: a local-directory source would run the plugin straight from the working copy and execute no build commands, so updates go through `git push` + `paseo plugin update command-center`.
2. `package.json` — `@getpaseo/client` is now a declared, version-pinned dev dependency (`0.10.1`, matching `@getpaseo/plugin`) instead of an accidental peer. `package-lock.json` was regenerated: the root `version` field was stale at `0.4.1`, and the package lost its `"peer": true` marker.

Nothing about the plugin's behaviour changed — no runtime code was touched. The scheduler bridge still uses `DaemonClient` over the local websocket; it simply now has its dependency guaranteed to exist at install time.

### Verification

Reproduced the host's own walk statically (TypeScript resolver + the same exempt list + the same throw-on-unresolved-type rule) against a staged copy of the plugin with the manifest `build` commands executed first:

| State | server bundle | client bundle |
| --- | --- | --- |
| before the fix, no `node_modules` | 3 errors (`executor.ts`, `schedules.ts`, `daemon-connection.ts`) | 1 error (`client/dispatch.ts`) |
| before the fix, `npm ci` run | clean | clean |
| after the fix, staged + `build` commands | clean | clean |

Plus `npm run typecheck` (clean) and `npx vitest run` (9 suites, 98 tests).

**Verified live on 2026-10-02** against Paseo `0.10.3` on the daemon host: before the change the plugin was installed from this working directory and sat in status `failed` with exactly the reported error; after the change `paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:command-center` reported `running` at revision `8f36572`, the daemon logs show `Plugin ready`, the managed checkout contains `node_modules/@getpaseo/{client,plugin,protocol,relay}` installed by the build step, and `paseo plugin update command-center` reports `current`.

The same defect existed in three sibling plugins and was fixed the same way — see the repository [README](../README.md#installation).

## 6. Compatibility

Current: **verified on 2026-11-09 against Paseo `0.15.0`**, shipped as
`0.7.0` with `@getpaseo/plugin@^0.15.3` + `@getpaseo/client@^0.15.3` — the
four lifecycle hooks moved from the deprecated `server.on` / `server.before`
to `server.addHook` (§14.1), which makes `requirements.paseo >=0.15.0` a hard
requirement (`addHook` does not exist on a 0.14.0 host). The 0.14.0 surface
adopted in 0.6.0 (`defineAgentTool` delivery via `request.tools`, the
`agent.open.before` request maps, `agents.ref(id).reload()`) is unchanged, and
the deprecated `client/react-native` UI entry stays migrated from 0.5.3 (§12).

Earlier, on 2026-11-01 against Paseo `0.14.0` with
`@getpaseo/plugin@^0.14.0` + `@getpaseo/client@^0.14.0` (a real pin bump) —
the one deprecation left in the plugin is migrated: the UI import now comes
from `@getpaseo/plugin/client/ui`, and `requirements.paseo` moved to the first
release whose `client/ui` carries `Modal` / `useToast`, shipped as `0.5.3` —
see §12.

Earlier, on 2026-10-21 against Paseo `0.12.0` with
`@getpaseo/plugin@0.12.0` + `@getpaseo/client@0.12.0`, manifest requirement
raised to `>=0.11.0`, client registrations migrated to the screen/sidebar API
and the `client/web.ts` DOM-global audit fixed — see §10.

Earlier, on 2026-10-02 against Paseo `0.10.3` with `@getpaseo/plugin@0.10.1` + `@getpaseo/client@0.10.1`:

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

The plugin's manifest range was `>=0.8.0` through 0.5.1, which covered 0.10.x. The version was bumped to 0.5.0 (new functionality: settings screen, automation hooks, MCP injection, attachment source, `/cc` subcommands, history retention setting) and to 0.5.1 (bugfix: installation from a clean checkout, §5f). From 0.5.2 the range is `>=0.11.0`, because the client entry now uses the 0.11+ screen/sidebar API (§10).

## 7. Limitations

- **Shell commands are write-only.** The terminal is created and the line is typed, but output is not captured or returned; use the terminal UI to see results.
- **One host.** Commands live on the daemon host's filesystem; multi-host setups would need sync or per-host copies.
- **Schedules run on the local daemon only.** The native scheduler executes on the daemon that owns the schedule; there is no cross-host scheduling.
- **Scheduled prompts are frozen.** Variable values and workspace context are rendered at creation time; editing a command later does not change existing schedules (delete and recreate, or edit the cadence inline).
- **The bridge needs the daemon config.** `daemon-connection.ts` reads `daemon.listen` from `$PASEO_HOME/config.json`; if the daemon listens behind authentication, the bridge would need the password — not required in the default local setup (no password set).
- **No secrets.** Templates are plain files; do not put tokens into templates.
- **Worktree runs require a git workspace.** Branch-off mode on a non-git directory will fail with a daemon-side error surfaced in the run dialog.
- **File browsing is local-only.** `command-center.browse` goes through the plugin's single daemon connection, so the picker lists the local host's filesystem; a remote-host target keeps a typed path.
- **Agent fan-out is uniform.** Selecting several existing agents sends the same rendered prompt with the same values to each; there are no per-agent value overrides.
- **History is linear and bounded** (default 50, user-configurable 10–500 via settings, §5d); repeat works per entry (batch re-runs are repeated one target at a time); there is no per-command filtering yet.
- **`/cc` runs with defaults** — empty inputs fall back to template defaults and the workspace is picked server-side; a matching command name is required. `list`/`history` only open the surface: the slash context has no message channel to print into.
- **Automation is best-effort.** Auto-run/bootstrap commands execute with template defaults and swallow errors (§5d); a failing automation never blocks the triggering event, and failures are only visible via the run history.
- **Installation needs the npm registry.** The manifest build step is `npm ci`, because the scheduler bridge depends on `@getpaseo/client`, which Paseo does not supply to plugins (§5f). A host without registry access cannot install or update this plugin; the other four plugins in this repository have no such requirement. (Paseo 0.12.0's `#7023` relaxed this for *type-only* `@getpaseo/protocol/*` imports — erased at compile time, no local install needed — but `@getpaseo/client` is imported for its **runtime** `DaemonClient`, so it must still be installed.)
- **Workflows are a chain, not a pipeline.** Steps do not receive each other's output; each step dispatches through the normal command path against the same target workspace. Workflow-level `values` are applied by variable name to every step template.
- **Workflows are local and unscheduled.** They are rejected for remote-host targets (the step library lives on this daemon), are not offered in the schedule dialog or the composer attachment source (no template to insert), and cannot be nested.
- **Workflow steps ignore worktree mode.** Branch-off would create one worktree per prompt step, so the run dialog hides the toggle and the executor forces `newWorktree: false` for steps.
- **A workflow records one history entry.** Per-step outcomes live in its `steps` summary; the entry cannot be repeated step-by-step, only as a whole workflow.

## 8. Roadmap

Ordered by value/effort, all verified to exist in SDK 0.10.1. Items 1 (trigger automation) and 9 (MCP injection) of the previous roadmap were delivered in 0.5.0 (§5d) and removed from this list.

1. **Workflows — delivered in 0.7.0 (§14.2)** and removed from this list: a `workflow` command type chaining saved commands with `always | on-success | on-failure` conditions, an executor pass, per-step history summaries and a step editor.
2. **Keyboard shortcuts** — global hotkeys per command; requires host support for keybinding registration (not present in 0.10.x), otherwise emulable via Command Center items only.
3. **Import/export & sharing** — delivered in 0.8.0 (§15): a versioned JSON bundle, merge/copy import semantics, and raw-URL import (a file in a git host, a gist, any static URL).
4. **Multi-agent fan-out** — delivered in 0.9.0 (§16): any number of existing agents can be selected as targets; the pure `planTargets` helper unions them with the selected workspaces, de-duplicates a workspace that already has a selected agent, and carries the owning host so an agent without a loaded workspace still goes to the right daemon.
5. **Cross-host sync** — runs across hosts are done (client dispatch); *store* sync (shared `commands.json` across daemons) is still open and would use `useHosts()` + per-host `getPaseoClient(serverId)` RPCs.
6. **Command parameters beyond strings** — delivered in 0.10.0 (§17): declared inputs carry a `kind` (`text` / `file` / `workspace`), the editor lets each template input pick one, the run dialog renders a workspace chip picker and a file path field with a directory browser.
7. **Usage analytics** — delivered in 0.11.0 (§18): a `Most used` summary (top three by successful runs) and a usage-first library ordering; the data is the existing `useCount`.
8. **Composer pills / timeline run cards** — blocked today (§5e); revisit when the SDK gains global pill registration or plugin-attributed timeline items.
9. **Web dashboard** — deferred (§5e); revisit if the host adds a remote-access surface plugins can attach to.

## 9. Planned improvements with Paseo 0.11.0

Compatibility with the 0.11.0 prerelease (`v0.11.0-beta.5`, verified 2026-10-06)
is established: the SDK diffs `@getpaseo/plugin@0.10.1 → 0.11.0-beta.5` and
`@getpaseo/client@0.10.1 → 0.11.0-beta.5` are purely additive for every API this
plugin uses; `npm run typecheck` and `npx vitest run` (9 suites, 98 tests) pass
against the 0.11.0 SDKs; the real host compiler (`compilePlugin` from
0.11.0-beta.5) bundles the plugin both with SDK 0.11.0 and with the faithful
0.10.1 lockfile; the manifest's `requirements.paseo >=0.8.0` passes
`assertPluginCompatibility` for a 0.11.0-beta.5 daemon and app; a live Git install
on an isolated 0.11.0-beta.5 daemon reached status `running` with `Plugin ready`;
and a wire test drove the full schedule lifecycle (create, inspect, pause,
resume, update, logs, delete, list) plus `command-center.save` through the old
0.10.1 `@getpaseo/client` against the 0.11.0-beta.5 daemon — 11/11 passed. No
code changes are required for 0.11.0.

The following new 0.11.0 capabilities are relevant to this plugin. **They are
planned for implementation after the stable Paseo 0.11.0 release, on request:**

1. **Audible run feedback** — `client.playAudio({ base64, mimeType })` on
   `PluginClientContext` (new in 0.11.0, resolves when playback ends). Scheduled
   runs and automation hooks (§5d) execute unattended; a completion/failure chime
   would make their outcome perceptible without watching the history tab.
2. **Screen and sidebar modernization** — migrate the deprecated `addSurface` /
   `addSidebarItem` / `openSurface` (used in `index.client.tsx`) to `addScreen` /
   `addSidebarHeaderItem` / `openScreen`. ~~The host ships compatibility shims
   (COMPAT markers in `evaluate.ts`) that are scheduled for removal after
   **2027-03-29**, so the migration must land before then.~~ **Superseded by
   §10.2: done in 0.5.2, and the 2027-03-29 date was wrong — no removal marker
   exists on these shims in 0.12.0 (§10.1).** The new API is more
   than a rename: `PluginScreenProps.params` carries URL parameters into the
   surface (a deep link could open the library on an exact command, or the
   schedules tab on an exact schedule, from history, `/cc` or Command Center
   items), `PluginScreenTitle` can derive the header from those params, the
   multi-row `SidebarRow` / `SidebarSeparator` components organize header and
   footer rows host-natively, and `addSidebarFooterItem` adds a footer slot.
3. **Provider launch diagnostics** — `ProviderRegistration` gained
   `command?: readonly [string, ...string[]]` (override the launch command of a
   plugin-provided provider) and `status?(request: ProviderStatusRequest): Promise<ProviderStatus>`,
   backed by the new `ProviderLaunchSchema` / `ProviderStatusSchema`. The run
   dialog's provider/model picker could surface a live "why this provider cannot
   start" status instead of failing at dispatch time.
4. **Turn-aware prompt dispatch** — `activeTurnBehavior` in `SendMessageOptions`
   (`@getpaseo/client` 0.11, exposed via `PaseoAgentSendOptions`) lets a prompt
   command decide explicitly what happens when its target agent is mid-turn
   (queue vs. interrupt) instead of inheriting the daemon default — relevant to
   single-target runs against an existing agent.
5. **Usage reporting** — `server.registerUsageSource({ id, label, icon?, input,
   discover(scope), fetch(input) })` plus the client-side `listUsageReports()` /
   `supportsUsageReports()` (new protocol messages `usage.list_reports.*`).
   Command Center could aggregate its own run counts into Paseo's usage reports,
   complementing the existing "most used" analytics idea (roadmap item 7).

## 10. Paseo 0.12.0 — spec conformance (2026-10-21)

Audited and migrated against the stable `0.12.0` release (2026-10-19).
Release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.12.0>.
bunny-search §13 covers the general spec rules this plugin also had to meet
(screen/sidebar API, `requirements.paseo` semantics, ID charset, the
`client/web.ts` DOM-global rule); this section records what is specific to
Command Center.

### 10.1 What 0.12.0 changed for this plugin

| Check | Result |
| --- | --- |
| SDK diff `@getpaseo/plugin@0.10.1 → 0.12.0` | **Additive only** for the API surface used here. `0.11.0 → 0.12.0` client declarations are byte-identical. |
| SDK diff `@getpaseo/client@0.10.1 → 0.12.0` | **Additive only** for what the scheduler bridge uses. `exports` map identical. The `DaemonClient` class gained members (`listUsageReports`, `supportsBackgroundWorkspaces`, `sourceAgentId`/`background`/`callerAgentId` request fields, a `usage.list_reports` subscription) and one signature change: `readFile(..., timeout?)` gained an **optional trailing** parameter — a source-compatible widening. Nothing was removed. |
| All 8 `schedule*` methods the bridge calls | Present in `@getpaseo/client@0.12.0`, same shapes: `scheduleList`, `scheduleCreate`, `schedulePause`, `scheduleResume`, `scheduleRunOnce`, `scheduleDelete`, `scheduleLogs`, `scheduleUpdate`. (Verified by matching each method's declaration in `dist/daemon-client.d.ts` against 0.10.1.) |
| `PaseoApi` (type-only import in `server/executor.ts`, `client/dispatch.ts`) | Still exported from `@getpaseo/client`; used only as a type, so the bundle boundary rules are unchanged. |
| Deprecated client members | `addSurface`, `addSidebarItem` (+ `PluginSidebarContribution`) and `openSurface` remain, `@deprecated`, no removal version. The 0.12.0 **app bundle** still implements them as shims over `addScreen` / the header-item registry / `openScreen`. |
| **Correction: the "2027-03-29" removal date** | §9 of this document and the old README claimed the surface/sidebar shims were "scheduled for removal after 2027-03-29" (attributed to COMPAT markers in `evaluate.ts`). **That claim does not hold for 0.12.0.** Grepping the 0.12.0 server package and the shipped app bundle: `2027-03-29` appears only on `COMPAT(codexFastPreference)` and `COMPAT(pluginProviderLaunch)` — unrelated. The surface/sidebar shims carry **no** COMPAT marker and **no** date, and the SDK's `@deprecated` tags state no removal version. Treat removal as happening without notice, not as a dated deadline. |
| `PluginSurfaceProps` | Not deprecated; still the settings-screen prop type, so `client/settings-screen.tsx` keeps it. Only the Command Center screen moved to `PluginScreenProps`. |
| `#7023` (protocol type imports) | Relaxation, not a change this plugin can use: it exempts *type-only* `@getpaseo/protocol/*` imports from the plugin-local install. This plugin imports `@getpaseo/client` for its **runtime** `DaemonClient`, so the `npm ci` build step stays required (§5f, §7). |
| `#6306` (reload timeout) | `paseo plugin reload` no longer fails with a 60 s timeout while a reload is still running — makes the documented reload workflow reliable. |
| Manifest | `requirements.paseo` `>=0.8.0` → `>=0.11.0`. `name`/`icon`/`media` metadata needs ≥ 0.11.0 and remains unused (no runtime effect). The `version` manifest key is still **rejected** by 0.10.x — not reintroduced (§6). |

### 10.2 Migration performed (version 0.5.1 → 0.5.2)

`index.client.tsx`:

| Before | After |
| --- | --- |
| `client.addSurface(SURFACE_ID, CommandCenterSurface)` | `client.addScreen({ id, title: "Command Center", Component })` |
| `client.addSidebarItem({ id, title, icon, surface })` | `client.addSidebarHeaderItem({ id, title, Component })` rendering `<SidebarRow icon="TerminalSquare" active onPress>` |
| `onSelect({ openSurface })` ×2 (global + workspace Command Center items) | `onSelect({ openScreen })` → `openScreen({ screenId })` |
| `/cc` `onSubmit({ args, rpc, openSurface })` — 5 call sites | `onSubmit({ args, rpc, openScreen })` → `openScreen({ screenId })` |

`client/command-center-surface.tsx`: `PluginSurfaceProps` → `PluginScreenProps`
(this is the file that owns the tabs, so it is the one that would consume
`params` for a deep link later).

`client/use-host-typography.ts` no longer touches the page store; it calls
`readHostTypography()` from the new `client/web.ts` (§13 of bunny-search
explains the rule; the fix is byte-identical across plugins).

`package.json`: `@getpaseo/plugin` and `@getpaseo/client` `0.10.1` → `0.12.0`,
version `0.5.1` → `0.5.2`. `paseo-plugin.json`: `requirements.paseo`
`>=0.8.0` → `>=0.11.0`.

### 10.3 Verification (2026-10-21, this machine)

| Check | Result |
| --- | --- |
| `npm install` with both 0.12.0 SDKs | exit 0; lockfile updated |
| `npm run typecheck` (`tsc --noEmit`) | **exit 0** |
| `npm test` | **9 suites / 98 tests pass** |
| 0.12.0 client audit (DOM globals outside `client/web.ts`, HTML elements, `className`, `onClick`) | **clean** |
| Remaining deprecated registrations in `client/` | **none** |
| Contribution ID charset | conforms (`command-center`, `command-center-settings`, `open-command-center`, `open-command-center-workspace`, `cc`) |
| `requirements.paseo` | `>=0.11.0` — matches the APIs actually used |
| Live install on a running 0.12.0 daemon | **PASS** — installed from the working tree into an isolated 0.12.0 daemon (scratch home, production config untouched): status `running`, `Plugin ready` in the log, no errors. The real 0.12.0 host compiler (`compilePlugin`) built the client entry; the compiled bundle contains the new API and **zero** legacy registrations. `paseo plugin reload command-center` exits 0 and the plugin restarts cleanly (the 0.12.0 #6306 fix). |

### 10.4 Not adopted (from §9; 0.12.0 changes none of them)

1. `client.playAudio` — audible feedback for unattended runs. Available, optional.
2. **Deep links through `PluginScreenProps.params`** — `PluginScreenTitle`
   deriving the header, history/`/cc`/Command Center opening an exact command
   or schedule. This is the substantive remaining §9 item and would be new
   functionality → second-digit bump.
3. Multi-row sidebar (`SidebarRow`/`SidebarSeparator`, `addSidebarFooterItem`)
   — optional presentation work.
4. Provider launch diagnostics (`ProviderRegistration.command`/`status`).
5. `activeTurnBehavior` — queue vs. interrupt for single-target runs.
6. `registerUsageSource` — still optional; 0.12.0 adds the client-side
   `listUsageReports()`/`supportsUsageReports()` half, which does not by
   itself make Command Center a sensible usage source.

Version `0.5.1` → `0.5.2` (existing-registration migration + the DOM-global
audit fix, no new capability → last digit), annotated tag
`command-center@0.5.2`.

## 12. Paseo 0.14.0 — compatibility pass (2026-11-01)

Audited against the stable `0.14.0` release (2026-10-29).
Release notes: <https://github.com/getpaseo/paseo/releases/tag/v0.14.0>.
The repository-wide inventory of what 0.14.0 adds and deprecates is in the
root [README](../README.md#paseo-0140--new-and-deprecated-sdk-surface-2026-10-29);
this section records what is specific to command-center.

**Result: compatible, and the one deprecation left in the plugin is now migrated — shipped as `0.5.3`** (a patch bump under this repository's
versioning: a change to existing functionality, no new functionality).

### 12.1 What 0.14.0 changed for this plugin

| Check | Result |
| --- | --- |
| `@getpaseo/plugin` `dist/client/` (previous release → 0.14.0) | **Byte-identical** (`diff -rq` over the two npm tarballs) — every client registration this plugin makes is untouched by construction. |
| `@getpaseo/plugin` `dist/server/` (previous release → 0.14.0) | Additive only: the new `agent-tools.*` (`defineAgentTool`), the `agent.session_open` request maps, and `session.can_stop_runtime` in the provider declarations. The plugin registers no agent tools and no session-open hook; its two lifecycle hooks (`agent.turn_ended`, `workspace.created`) are unchanged and still typecheck. |
| `@getpaseo/client` `schedule*` methods (the scheduler bridge) | **All nine the bridge calls are present and unchanged** — `scheduleCreate`, `scheduleList`, `scheduleInspect`, `scheduleLogs`, `schedulePause`, `scheduleResume`, `scheduleDelete`, `scheduleRunOnce`, `scheduleUpdate`. Their option and payload types (`CreateScheduleOptions`, `InspectScheduleOptions`, `UpdateScheduleOptions`, `ScheduleCreatePayload`, `ScheduleListPayload`) diff **byte-identical** across that step. |
| `@getpaseo/client` `daemon-client.d.ts` overall | Additive only: `FetchAgentTimelineOptions.wholeTurns` and the three local-speech-model methods (Voice settings backing — not a plugin surface). The only `@deprecated` marks are the pre-existing `CreateAgentRequestOptions.git` / `.worktreeName`, which this plugin never passed. |
| `agent.turn_ended`'s always-empty `timeline` (deprecated earlier) | Still not affected — the automation reads only `event.outcome.kind === "completed"`. |
| Deprecated `@getpaseo/plugin/client/react-native` entry (removal 2027-04-20) | **The last live deprecated call in this repository — migrated** (§12.2). The entry still exists in `0.14.0` with the same `@deprecated` marker, but this plugin no longer references it anywhere. |
| `@getpaseo/plugin/client/ui` exports used after the migration | `Modal` and `useToast` are both exported by `client/ui` in 0.14.0 (`ui.d.ts` lines 42–43); both are absent from 0.12.0's `client/ui` and present from the next release on — the basis for the raised floor (§12.2). |
| Client audit (DOM globals outside `client/web.ts`) | Still clean (the §10.3 fix holds; the rule is unchanged in 0.14.0). |
| Manifest | Passes the real 0.14.0 `readPluginManifest`; the floor is enforced by the daemon's own `assertPluginCompatibility` — rejected for a 0.12.0 daemon, accepted for 0.14.0 (§12.4). |
| Node-level noise | The plugin subprocess logs Node 24's `DEP0176` warning (`fs.F_OK is deprecated`) once at startup. It comes from the bundled dependency chain of `@getpaseo/client@0.14.0`, not from Paseo SDK code, and is benign. |

### 12.2 Migration performed (0.5.2 → 0.5.3)

| Before | After |
| ------ | ----- |
| `client/command-center-surface.tsx` imported `Modal` / `useToast` from `@getpaseo/plugin/client/react-native` | same line imports from `@getpaseo/plugin/client/ui` — the only source change; both symbols exist there |
| devDependency `@getpaseo/plugin@0.12.0` | `^0.14.0` — a **real pin bump** (unlike the earlier `--no-save` pass): the 0.12.0 typings have no `Modal`/`useToast` in `client/ui`, so the pin had to move for typecheck to pass |
| devDependency `@getpaseo/client@0.12.0` | `^0.14.0` — the lockfile is what the manifest's `npm ci` installs at plugin install/update, and `@getpaseo/client` is **not** host-supplied: the scheduler bridge is bundled from the plugin's own `node_modules`, so this bump ships 0.14.0's daemon client in the server bundle |
| `requirements.paseo: ">=0.11.0"` | raised — the floor follows the API actually used, not the newest host tested: `client/ui` gained `Modal` and `useToast` one release later (both absent from 0.12.0's `client/ui`), and nothing else the plugin uses needs more than 0.11/0.12 |

### 12.3 Recommendations for improvement (recorded, not implemented)

**Status update (2026-11-01): all four items below are implemented in
version 0.6.0 — see §13.** The section is kept as the pass's record.

Each item was written down by this pass and left for a future release;
items 1–2 are new functionality (second-digit bump), items 3–4 change
existing behaviour or add capability (each carries its own bump under the
repository's versioning rules).

1. **A native `command_center_run` agent tool (`defineAgentTool`, new in
   0.14.0).** Give every agent a plugin tool that runs a saved command by
   name through Paseo's own tool transport — no MCP config, Zod-validated
   input (`{ commandId | name, values? }`), `signal` and a 10-minute ceiling
   handled by the host. That turns the command library into something an
   agent can invoke mid-turn ("run the saved `deploy-staging` command"),
   which today is impossible: commands are reachable only from the screen,
   the ⌘K items, `/cc` and the composer picker. Names must match
   `/^[a-z][a-z0-9_]*$/` and stay ≤64 chars.
2. **Session-open MCP re-derivation for runs against an *existing* agent,
   plus a "refresh command tools" action — both 0.14.0 APIs.** Per-command
   MCP servers are currently attached only at `agents.create` time
   (`server/executor.ts` passes `{ provider, mcpServers }` into the saved
   agent config), so they are correct for every agent a command creates and
   survive the new idle-hour runtime release. The gap is the run dialog's
   existing-agent target: if that agent was created without the command's
   servers (or the command's servers changed since), there is no way to get
   them into the session. `before("agent.session_open")` can contribute
   them launch-only on the next open (collision-safe: read the agent's
   saved `mcpServers` from the daemon record and skip on any unreadable
   state, since a name collision fails the session open), and a
   `context: "agent"` Command Center action on the new
   `agents.ref(id).reload()` can reopen the session with the current
   configuration. Follow the collision-safe pattern already shipped in
   bunny-search 0.5.2 / memory-flash 0.9.4.
3. **Turn-aware dispatch (`activeTurnBehavior`) — still open from §9.**
   Single-target runs against an existing agent currently have no declared
   queue-vs-interrupt policy; 0.14.0 changes neither the argument nor the
   reasoning.
4. **Deep links through screen params (`PluginScreenProps.params`) — still
   open from §9.** `history`, `schedules` and `/cc <name>` could
   open the library focused on an exact command or schedule instead of the
   default tab.

Not recommended for this plugin from the 0.14.0 surface:
`FetchAgentTimelineOptions.wholeTurns` (the plugin never fetches
timelines), `session.can_stop_runtime` (provider-protocol only, no
plugin-facing call), the local-speech-model methods (Voice settings
backing), and `before("agent.session_open")` for *created* agents — the
create-time attachment is already saved into the agent config and is the
stronger guarantee.

### 12.4 Verification (2026-11-01, this machine)

| Check | Result |
| --- | --- |
| SDK installation | Real pin bump to `@getpaseo/plugin@^0.14.0` + `@getpaseo/client@^0.14.0`; `npm install` resolved plugin/client/protocol all `0.14.0` and updated `package-lock.json` (this lockfile is shipped — `npm ci` runs at plugin install/update). |
| `npm run typecheck` (`tsc --noEmit`) against both 0.14.0 SDKs | **exit 0** |
| `npm test` | **9 suites / 98 tests pass** (including the schedules and server-rpc suites that cover the scheduler bridge against `@getpaseo/client@0.14.0`) |
| Real 0.14.0 host compiler (`compileDirectoryPlugin` + `readPluginManifest` extracted from the installed `/opt/Paseo` `app.asar`) | **Both entries compile, no boundary errors.** `clientBundle` 140,765 bytes and `serverBundle` 8,918,954 bytes with **zero** deprecated strings (`@getpaseo/plugin/client/react-native`, `useRevealedText`, `addSurface(`, `addSidebarItem(`, `openSurface(`, `SettingsGroup`). Negative control: a copy with the old `client/react-native` import restored compiles to a client bundle that **does** contain the deprecated specifier, so the clean scan is meaningful. |
| 0.14.0 manifest schema | `readPluginManifest` accepts `{ id, requirements: { paseo: ">=0.14.0" }, build: [["npm","ci"]] }`. |
| Floor enforced by the daemon's own gate (`assertPluginCompatibility`, the call `plugins/index.js` makes with the daemon version) | `0.12.0`: **REJECTED** (the host message names the required floor); `0.14.0`: accepted. |
| Live, isolated 0.14.0 daemon (scratch home, `127.0.0.1:16767`, `pluginsEnabled: true`, production `~/.paseo` untouched) | **PASS** — installed from the working tree: status `running`, `[paseo] Plugin ready`, **20 RPC methods** registered (17 `command-center.*` + 3 `settings.command-center.*`), a clean `paseo plugin reload` (still `running`, ready twice), and no plugin or contribution errors in the daemon log. One benign `DEP0176 fs.F_OK` Node warning from the bundled dependency chain (§12.1). |
| Post-check cleanup | Isolated daemon stopped, scratch state removed, `git status` shows only this release's files. |

## 13. Version 0.6.0 — implementing the §12.3 recommendations (2026-11-01)

Implements **all four** recommendations recorded by the 0.14.0 pass (§12.3).
New functionality → second-digit bump `0.5.3 → 0.6.0`; the floor follows the adopted APIs: `requirements.paseo` raised to **`>=0.14.0`**, because the
plugin now uses 0.14.0-only surface (`defineAgentTool` delivered through the
`agent.session_open` request's `tools`, the request's editable `mcpServers`
map, and `agents.ref(id).reload()`); the SDK pins stay `^0.14.0`.

### 13.1 What was built

| # | Recommendation | Implementation | Key decisions |
| - | -------------- | -------------- | ------------- |
| 1 | Native `command_center_run` agent tool | `server/agent-tool.ts` (`defineAgentTool`), delivered by appending it to `request.tools` in `before("agent.session_open")` — the SDK's `PluginServerContext` exposes **no** global tool registration, and bunny-search delivers its tool the same way. Pure helpers (`findCommand`, the input schema) are exported for tests. | Name `command_center_run` (host regex `/^[a-z][a-z0-9_]*$/`, ≤64 chars). Resolved by exact id or case-insensitive name. **Shell** commands run in a terminal of the *calling agent's own workspace*; **prompt** commands create a **new** agent there with the command's stored provider and MCP servers — deliberately never the calling agent, because an agent prompting itself mid-turn recurses. Stored defaults fill the template, `values` override them. Unknown command → `isError` with the library listing. Every run lands in the shared history. Attached on every `purpose: "interactive"` open; the only collision rule is against Paseo's own and other plugins' tools. |
| 2 | Session-open MCP re-derivation + refresh action | Registry `server/agent-mcp.ts` (`$PASEO_HOME/plugins/command-center/agent-mcp.json`, last-run-wins per agent, capped at 200 entries oldest-dropped, cleared on `agent.archived`); pure decision `server/session-open.ts`; collision-safe reader `server/agent-record.ts` (a copy of bunny-search's proven reader). | Written by the executor on every run against an **existing** agent (a run with no servers clears the entry). The hook contributes only on `resume`/`refresh` reopens with `purpose: interactive`, only the names the agent's **saved** config lacks, and only when the record on disk proves it — a missing/unusable record, an unknown capability or a provider without MCP all **fail safe to skip**, because a name collision aborts the session open. The capability probe (`agents.ref(id).refresh()`) runs only when a contribution is still possible. Runs against *created* agents are unchanged: their create-time attachment is saved into the agent config and is the stronger guarantee. |
| 3 | "Refresh Command Center tools" action | RPC `command-center.agent-reload` → `paseo.agents.ref(id).reload()` in `index.server.ts`; surfaced as a `context: "agent"` Command Center item (`index.client.tsx`). | A refused reload throws, which the host shows as an error toast — never silent. The reload reruns `agent.session_open`, re-deriving both contributions above. |
| 4 | Turn-aware dispatch | `activeTurnBehavior: "interrupt" \| "steer"` (the real `SendMessageOptions` enum) threaded run dialog → `runCommand` / `runTargetSchema` → executor `handle.send(...)` and the remote-host dispatch (`client/dispatch.ts`). | **The protocol has no `queue` value** — §9's "queue vs. interrupt" wording is corrected here: the choices are `interrupt` (the daemon default when omitted) and `steer` (deliver into the running turn). The run dialog shows the two chips only when an existing agent is the target; fan-out targets never carry it (the agent picker is single-target only). Omitted value ⇒ send options omitted ⇒ daemon default, so behaviour is unchanged unless the user picks. |
| 5 | Deep links through screen params | `shared/screen-params.ts` (`view=library\|history\|schedules`, `command=<id>`, `schedule=<id>`), applied in the screen via one `applyParams` path; `/cc` subcommands pass params (`list` → library, `history` → history, `schedule …` → schedules with the new schedule expanded, unknown name → library). | The same params object is built by the in-screen actions — history entries gained "Show command", schedule rows gained "Show command", and a focused command/schedule is border-highlighted (its filters are cleared so it cannot be hidden; a focused schedule is auto-expanded). Unknown views and empty ids degrade to defaults, so a hand-edited link never breaks the screen. Manual tab switches drop the focus. |

### 13.2 Deliberately not built

1. **No settings toggle for the agent tool.** It attaches on every interactive
   open; Paseo's own permission system covers tool calls. A host-wide switch
   (like bunny-search's `injectIntoAgents`) can ride along with a future
   settings release if the tool ever proves too loud.
2. **No registry for remote-host targets.** The registry lives on the local
   daemon; a fan-out target on another host is dispatched through that host's
   API, and its session-open hooks run on *that* daemon.
3. **Schedules pass no `activeTurnBehavior`** — a scheduled prompt always
   creates its own agent, so there is never an active turn to steer into.

### 13.3 Verification (2026-11-01, this machine)

| Check | Result |
| --- | --- |
| `npm run typecheck` against the 0.14.0 SDKs | **exit 0** |
| `npm test` | **13 suites / 149 tests pass** — new suites: `agent-tool` (definition legality, resolution, shell/prompt dispatch, error paths), `agent-record` (the full fail-safe matrix), `session-open` (decision matrix + registry store incl. the cap), `screen-params` (parse/round-trip); extended: `executor` (activeTurnBehavior threading, registry write/clear), `server-rpc` (hook wiring, contribution matrix, reload RPC). |
| Real 0.14.0 host compiler (`compileDirectoryPlugin` + `readPluginManifest` from the installed `app.asar`) | Manifest accepted with `>=0.14.0`; `clientBundle` 149,071 bytes and `serverBundle` 8,932,342 bytes with **zero** deprecated strings; negative control (old `client/react-native` import restored) **does** produce the hit. |
| Floor enforced by the daemon's own `assertPluginCompatibility` | `0.12.0`: REJECTED (the floor is now a real API requirement, not just the `client/ui` exports); `0.14.0`: ACCEPTED. |
| Live, isolated 0.14.0 daemon (scratch home, `127.0.0.1:16767`, production untouched) | **PASS** — installed from the working tree: `running`, `[paseo] Plugin ready`, **21 RPC methods** (18 `command-center.*` incl. the new `command-center.agent-reload`, + 3 `settings.command-center.*`), no plugin errors, and a clean `paseo plugin reload`. |

## 14. Version 0.7.0 — Paseo 0.15.0 and workflows (2026-11-09)

One release closes the two open stage items: the mandatory 0.15.0 hook
migration (§14.1) and roadmap item 1, workflows (§14.2). New functionality →
second-digit bump `0.6.0 → 0.7.0`, annotated tag `command-center@0.7.0`.

### 14.1 Paseo 0.15.0 — the four lifecycle hooks migrated

0.15.0 marks `server.on(...)` and `server.before(...)` as `@deprecated`
("Use addHook with the renamed hook. Removed after 2027-04-30") on
`PluginLifecycleRegistration`. All four registrations in `index.server.ts` used
the deprecated spelling, so the migration is mandatory rather than optional.

| Before (0.6.0) | After (0.7.0) | Payload used |
| --- | --- | --- |
| `server.on("agent.turn_ended", async (event, { paseo }) => …)` | `server.addHook("agent.turn.after", async (event, { paseo }) => …)` | `event.outcome.kind` (unchanged shape) |
| `server.on("workspace.created", …)` | `server.addHook("workspace.create.after", …)` | `event.workspace.id` |
| `server.on("agent.archived", (event) => …)` | `server.addHook("agent.archive.after", async (event) => …)` | `event.agent.id`; the handler is `async` because `HookHandlers` returns a `Promise` |
| `server.before("agent.session_open", async ({ request }, { paseo }) => …)` | `server.addHook("agent.open.before", async ({ request }, { paseo }) => …)` | the request is still wrapped in `{ request }`; the return is still the request |

The bodies are untouched: `HookHandlers` is typed `(payload, context) =>
Promise<PluginHookResult>`, and `PluginHookPayload` wraps request hooks in
`{ request }`, so the session-open contribution keeps its `tools` /
`mcpServers` edits verbatim. `pluginHookRegistry` proves the host does not
await the three event hooks (`waits: false`) but does await
`agent.open.before` (`waits: true`), which the request-return contract needs.

`requirements.paseo`: `>=0.14.0 → >=0.15.0` (`addHook` does not exist on a
0.14.0 host). Pins: `@getpaseo/plugin` and `@getpaseo/client`
`^0.14.0 → ^0.15.3` (the installed 0.15.x patch; the client pin is shipped
because the scheduler bridge bundles its own `DaemonClient`, §5f). The nine
`schedule*` methods the bridge calls are still present in
`@getpaseo/client@0.15.3` with the same signatures (checked by string and by
the green schedule suites).

**Not adopted from 0.15.0:** `worktree.create.before` / `worktree.create.after`.
The plugin does create branch-off worktrees (prompt runs), but controlling
their location or running setup inside them is a behaviour change without a
current need, and workflows deliberately do not branch off at all (§14.3).

### 14.2 Workflows

`commandTypeSchema` gained `workflow`, and a stored workflow carries
`steps: [{ commandId, condition }]` (`condition: always | on-success |
on-failure`, max 20). A workflow has no template of its own; `template`
defaults to `""` and the per-type requirement moved into
`validateCommandForSave(command, library)` (shared, pure, used by the save
handler and `tests/commands.test.ts`): prompt/shell need a template, a
workflow needs at least one step, no self-reference, no missing command, no
nested workflow.

Execution (`executeWorkflow` in `server/executor.ts`) validates the whole
chain before dispatching anything, then runs the steps in order against the
same target:

| Condition | Runs when |
| --- | --- |
| `always` | every time |
| `on-success` | the immediately previous executed step succeeded **and** no earlier step failed (so a successful cleanup does not re-arm it; a first step never runs) |
| `on-failure` | the immediately previous executed step failed |

A failure does not abort the chain — `always` / `on-failure` steps after it are
exactly how cleanup or notification is expressed — and the workflow's overall
`ok` is true only when every executed step succeeded. Each step runs through
the normal `executeCommand` path with per-step history disabled, so steps keep
their own type, provider, MCP servers and template defaults; workflow-level
`values` override a step's defaults by variable name.

The chain appends **one** history entry (`kind: "workflow"`) whose `steps`
array carries `{ commandId, commandName, condition, kind, ok, error, skipped }`
per step; `rendered` is the one-line-per-step summary shown in the history tab.
`RunResult` gained the same `workflow` kind, and the agent tool reports
`workflow run in workspace …` as its dispatch target.

Client surface:

- **Editor** (`client/command-form.tsx`): third type chip, step cards with
  command name, condition chips, ↑/↓/remove, and an "Add step" chip row built
  from the saved prompt/shell commands (the workflow itself and other
  workflows are excluded). Validation mirrors `validateCommandForSave`.
- **Library card**: badge `workflow · N steps`, body `A → B → C` with names
  resolved from the loaded library.
- **Run dialog**: shows the step list (with `[on success]` / `[on failure]`
  markers) instead of a template preview, hides inputs, the provider picker and
  the worktree toggle, keeps workspace targeting, the existing-agent picker and
  the busy-turn choice. The run label is `Run workflow`.
- **Not offered:** the Schedule button (server also refuses: "Workflows cannot
  be scheduled — schedule their steps instead.") and the composer attachment
  source (nothing to insert).

### 14.3 Deliberately limited

1. **No output chaining** — steps are independent dispatches, not a pipeline;
   a step cannot consume the previous step's terminal output.
2. **Local only** — a remote-host target is rejected in the run dialog path,
   because the step library lives on this daemon.
3. **No worktree mode** — `newWorktree` is forced off for steps (one worktree
   per step would be wrong), and the dialog hides the toggle.
4. **No scheduling and no attachment insertion** — see §7.
5. **No nesting** — rejected by both the editor and the executor.

### 14.4 Verification (2026-11-09, this machine)

| Check | Result |
| --- | --- |
| SDK installation | `npm install --save-dev @getpaseo/plugin@^0.15.0 @getpaseo/client@^0.15.0` resolved **0.15.3** and updated `package.json` + the shipped `package-lock.json`. |
| `npm run typecheck` (`tsc --noEmit`) | **exit 0** |
| `npm test` | **14 suites / 159 tests pass** — 149 from 0.6.0 + `tests/workflows.test.ts` (6: order and one history entry, condition matrix incl. `always` after a failure, missing step pre-flight, nested rejection, all-skipped, value pass-through) + 4 new `validateCommandForSave` cases (the two obsolete schema tests were replaced: the schema now parses an empty template by design). |
| Deprecated-call scan | no `server.on(` / `server.before(` left in the plugin; the fake server in `tests/server-rpc.test.ts` exposes `addHook` only. |
| Live daemon | **PASS** — installed from the working tree into an isolated **0.15.3** daemon (scratch home under `.tmp/`, `127.0.0.1:16768`, `pluginsEnabled: true`, production `~/.paseo` untouched): status `running`, `[paseo] Plugin ready`, **21 RPC methods** registered, **zero** `Unknown lifecycle hook` errors — the host validates `addHook` names at registration, so the four migrated names are proven accepted. Only the benign `DEP0176 fs.F_OK` warning from the bundled dependency chain appears (§12.1). The scratch home was stopped and removed; the production home was never touched. |
| Workflow execution | Covered by `tests/workflows.test.ts` against throwaway stores; the workflow path was not exercised through the app UI (the client surface was not rendered). |
## 15. Version 0.8.0 — library sharing (2026-11-11)

Roadmap §8 item 3 ("import/export & sharing"), delivered. New functionality →
second-digit bump `0.7.0 → 0.8.0`, annotated tag `command-center@0.8.0`.

### 15.1 Format

`shared/share.ts` owns the format and the merge rules (client-safe, pure):

```json
{
  "format": "command-center/commands",
  "version": 1,
  "exportedAt": "2026-11-11T00:00:00.000Z",
  "commands": [ /* CommandDefinition[] */ ]
}
```

- The envelope is versioned so a future schema change is rejected instead of
  silently mis-parsed. Bare `CommandDefinition[]` (what a hand-copied
  `commands.json` looks like) is also accepted on import.
- `useCount` is reset to 0 on export and never restored on import: the counter
  describes *this* library's usage, and importing someone else's history would
  corrupt the "most used" ordering. `favorite` travels with the command in copy
  mode and is preserved locally in merge mode.
- Export takes an optional id selection; the UI lists every command with a
  toggle, all selected by default.

### 15.2 `merge` vs `copy`

| Mode | Identity | Result |
| ---- | -------- | ------ |
| `merge` (default) | Existing id, else case-insensitive name | Matching commands are updated in place (id, `createdAt`, `favorite`, `useCount` stay local); unknown ones are added |
| `copy` | Always a fresh id | Every imported command is added; a name collision becomes `Name (2)`, `Name (3)`… so importing your own export never overwrites the originals |

Both modes remap workflow step ids through a bundle→final-id map. That is what
makes a copied workflow chain point at the *copied* step commands instead of at
dangling ids. Commands are imported before workflows, so a bundle where the
workflow is listed first still validates. Every candidate passes the same
`validateCommandForSave` as the save handler; a broken record is skipped and
reported (`skipped`/`error`), never written.

Import also registers any category labels the bundle brought along (through the
same categories store the editor uses), so the filter chips stay consistent.

### 15.3 Import from a URL

`command-center.import-url` fetches a raw http(s) JSON file and runs the same
import path. This is the practical "install from a repository" form: a file
committed to a git host, a gist, or any static URL works; the plugin does not
invoke `git` and does not read plugin manifests. The request is user-initiated,
time-boxed at 10 s, and only `http:`/`https:` URLs are accepted.

### 15.4 UI

The library toolbar gained a `Share` button; the modal has two tabs:

- **Export** — per-command selection chips, the formatted bundle in a read-only
  text area, `Copy JSON` (`copyText` from `client/ui`).
- **Import** — mode chips (`Update it (merge)` / `Add a copy`), a paste area,
  and a raw-URL field with `Fetch`. The result line reports
  `added / updated / skipped` plus the first error; a successful import
  refreshes the library immediately.

### 15.5 Deliberately not built

1. **No plugin-manifest install.** The roadmap's "install from a git repo" is
   satisfied by fetching the JSON file; cloning a repository and running its
   code is Paseo's own plugin mechanism, not a command-library feature.
2. **No automatic cross-host push.** Sharing is an explicit bundle operation;
   see §16 for the SDK limit that keeps automatic store sync open.
3. **No merge conflict UI.** `merge` is last-write-wins by bundle content; the
   dialog offers `copy` for users who want to keep both sides.

### 15.6 Verification (2026-11-11)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **15 suites / 170 tests pass** — 159 from 0.7.0 + `tests/share.test.ts` (11: envelope/bare-array parsing, malformed and foreign-format rejection, export selection and counter reset, merge identity/favorite/useCount semantics, invalid-record skipping, copy name de-duplication, workflow step remapping incl. out-of-order bundles, missing-step rejection, unique naming) |
| UI | The share dialog was not rendered in the app in this pass; its behaviour is covered by the pure module and RPC wiring only |
## 16. Version 0.9.0 — per-agent fan-out (2026-11-11)

Roadmap §8 item 4, the remaining half: multi-agent fan-out. New functionality →
second-digit bump `0.8.0 → 0.9.0`, annotated tag `command-center@0.9.0`.

### 16.1 What changed

The run dialog's single "Send to an existing agent" picker became a multi-select
list. The target planner moved into `shared/targets.ts` (`planTargets`), a pure
module the dialog and `tests/targets.test.ts` share:

| Selection | Targets |
| --- | --- |
| Nothing | One legacy best-guess target (server picks the workspace) |
| Workspaces only | One new-agent target per workspace (unchanged) |
| Agents only | One existing-agent target per agent |
| Workspace + an agent of that workspace | The agent target only — the workspace is not started again with a new agent |
| Workspace A + agent of workspace B | A new-agent target for A and an existing-agent target for B |

Additional rules:

- **Host routing.** A target now carries `serverId`. The workspace key used to
  be the only host carrier, but an agent can be selected without its workspace
  being in the loaded list; without `serverId` that target would be dispatched
  to the local daemon with a foreign agent id. `client/dispatch.ts` and the
  local `run-batch` split in the surface use it, so remote agents always reach
  their own host.
- **Offer set.** With workspaces selected, the agent list shows only agents
  living in them (across hosts); with nothing selected it shows every open
  agent. Closed/archived agents are never offered.
- **Turn-aware dispatch** (`activeTurnBehavior`) is applied to every selected
  agent target; new-agent targets never carry it. The busy-turn chips appear
  as soon as at least one agent is selected.
- **Worktrees** stay a new-agent concept: agent targets always use
  `newWorktree: false`, and workflows keep forcing it off for the remaining
  new-agent targets.
- The per-target result list labels an agent target by the agent's title when no
  workspace name is available.

### 16.2 Deliberately not built

1. **No per-agent values.** One rendered prompt goes to every selected agent;
   per-agent variable overrides would need a different dialog model.
2. **No "send to every agent of a workspace".** Agents are picked explicitly;
   a select-all shortcut for the filtered list is a future UI nicety.
3. **Schedules are unchanged** — a scheduled run still creates its own agent.

### 16.3 Verification (2026-11-11)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **16 suites / 176 tests pass** — 170 from 0.8.0 + `tests/targets.test.ts` (6: best-guess fallback, workspace fan-out, agent without a loaded workspace keeps its host, agent replaces its own workspace, mixed workspace/agent planning, busy-turn policy only on agent targets + workflow worktree off) |
| UI | The multi-select picker was not rendered in the app this pass; the planning logic it calls is unit-tested |
## 17. Version 0.10.0 — typed command parameters (2026-11-11)

Roadmap §8 item 6 ("command parameters beyond strings"), delivered. New
functionality → second-digit bump `0.9.0 → 0.10.0`, annotated tag
`command-center@0.10.0`.

### 17.1 Model

`commandVariableSchema` gained `kind: "text" | "file" | "workspace"` with a zod
default of `text`, so every pre-0.10.0 command (and every `commands.json`
written by an older release) parses unchanged. The template token stays
`{{input:name}}` / `{{input:name|default}}` — the kind controls the widget, not
the interpolation — so rendering, schedules, the agent tool and the attachment
source need no changes.

`shared/variables.ts` is the single definition of how inputs are resolved:

- `resolveCommandInputs(command)` — declared variables first (they carry kind,
  prompt and default), then `{{input:…}}` names discovered in the template as
  `text`. Workflows return an empty list (no template of their own).
- `declarationsForTemplate(template, stored, kinds)` — the editor's inverse:
  emits one declaration per token, keeping the stored prompt, preferring the
  template's inline default over the stored one, and dropping declarations whose
  token was removed. This is why saving no longer writes `variables: []`.

### 17.2 Run dialog

| Kind | Control |
| --- | --- |
| `text` | The original single-line input |
| `workspace` | Chip per loaded workspace (grouped by host like the target picker); the value is the workspace **name**. A hint points at `{{workspace.path}}` for the directory |
| `file` | Path field plus `Browse…`, which expands an inline directory browser |

The browser calls `command-center.browse`, a new RPC backed by
`DaemonClient.listDirectory(cwd, path)` — the same low-level daemon client the
schedule bridge already uses, because `PaseoApi` exposes no file listing.
Entries are sorted directories-first and capped at 100; tapping a directory
navigates, tapping a file writes its path into the input. The listing is
read-only and answers for the **local** daemon only (the plugin server holds one
daemon connection), so a remote-host workspace surfaces the RPC error and the
user types the path.

### 17.3 Verification (2026-11-11)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **17 suites / 182 tests pass** — 176 from 0.9.0 + `tests/variables.test.ts` (6: declared kind/prompt preservation, discovered-as-text, workflow returns no inputs, editor kind override with template-default precedence, removed-token cleanup, new input defaults to text) |
| Schema back-compat | `kind` has a zod default, so the existing `tests/store`, `tests/commands`, `tests/executor` and `tests/workflows` fixtures still parse (the only fixture that needed `kind` was the typed search fixture, updated) |
| UI | The new controls and the directory browser were not rendered in the app this pass; their inputs/outputs are covered by the pure module and the RPC contract |
## 18. Version 0.11.0 — usage analytics (2026-11-11)

Roadmap §8 item 7 ("usage analytics"), delivered. New functionality →
second-digit bump `0.10.0 → 0.11.0`, annotated tag `command-center@0.11.0`.

### 18.1 What changed

`shared/analytics.ts` holds both pure helpers:

- `sortCommands(commands, "default" | "used")` — the library ordering. `default`
  keeps the historical favorites-first alphabetical order; `used` sorts by
  `useCount` descending and falls back to the default ordering for ties, so the
  list is deterministic.
- `mostUsedCommands(commands, limit = 3)` — the summary: only commands with
  `useCount > 0`, highest first, favorite/name as tie-breakers, capped.

The library tab gained two ordering chips (`A–Z`, `Most used`) in the toolbar
and a bordered `Most used` block above the list (`Name (runs) · …`). The block
is hidden while a search query or category filter is active, because it would
otherwise describe a different set than the list below it.

`useCount` is still server-owned: `command-center.save` preserves the stored
counter and `run`/`run-batch` increment it by the number of successful targets
(workflows count once, per §14). The summary therefore reflects real dispatches,
not dialog opens.

### 18.2 Deliberately not built

1. **No separate analytics tab.** The roadmap asked for a "most used" section;
   a tab would duplicate the library for three numbers.
2. **No time-windowed stats.** `useCount` is a monotonic counter; "runs this
   week" would need history queries with retention-dependent results (history is
   bounded at 10–500 entries).
3. **No cross-command charts.** Out of scope for a personal command library.

### 18.3 Verification (2026-11-11)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **18 suites / 188 tests pass** — 182 from 0.10.0 + `tests/analytics.test.ts` (6: default ordering, usage ordering with default tie-break, input immutability, zero-run exclusion and cap, all-zero case, zero limit) |
| UI | The summary block and ordering chips were not rendered in the app this pass; their data comes from the unit-tested helpers |
