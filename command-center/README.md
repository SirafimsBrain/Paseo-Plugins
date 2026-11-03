# Command Center

A personal command center for [Paseo](https://paseo.sh/): save reusable commands as templates, run them against any workspace or agent with a live preview, and browse the run history.

The idea is inspired by [stablyai/orca](https://github.com/stablyai/orca), but instead of a dropdown list it is a full surface with a command library, an editor, and a run dialog.

## What it does

- **Command library** — every command is a `{{...}}`-templated snippet stored on the daemon host in `$PASEO_HOME/plugins/command-center/commands.json`. Favorites float to the top.
- **Two command types**
  - `prompt` → renders the template and either sends it to an existing agent or creates a new agent (optionally branching off into a fresh git worktree of the target workspace).
  - `shell` → renders the template into a command line and writes it into a new terminal of the selected workspace.
- **Template tokens**
  - `{{input:name}}` / `{{input:name|default}}` — prompted at run time; the run dialog builds a form from them automatically.
  - `{{workspace.name}}`, `{{workspace.path}}` — resolved from the target workspace.
  - `{{date}}`, `{{time}}` — current date/time on the daemon clock.
  - Unknown tokens stay visible in the preview instead of silently disappearing.
- **Live preview** — the run dialog shows the fully rendered prompt/line before it is dispatched.
- **Categories** — every command can carry a free-form category label. The library shows a category chip row; picking a chip filters the list, and a new label typed in the editor is registered automatically on save.
- **Search** — a toggleable search field filters commands by name, category, template body, and variable prompts. Matching is case-insensitive and multi-term (AND).
- **Targeting** — multi-select workspaces grouped by host (prompt and shell), run-time provider/model picker with live model lists (disabled providers hidden), optional existing agent for single-target runs, optional branch-off worktree. One click fans out to many workspaces and hosts with per-target results.
- **History** — the last N runs (configurable, default 50) with the rendered payload, target, used model/agent, and error; any entry can be repeated in one click with its values, target, and model prefilled.
- **MCP servers per command** — a prompt command can carry MCP server configs (`stdio`/`http`/`sse`), attached to every agent the command creates.
- **Automation** — optional server-side hooks, configured in the plugin settings: run a command (with template defaults) every time an agent finishes a turn successfully, and/or bootstrap every newly created workspace with a command.
- **Agent tool** — every agent gets a native `command_center_run` tool (delivered by Paseo's own tool transport, no MCP config): it runs a saved command by name or id — shell commands in a terminal of the agent's own workspace, prompt commands as a new agent in that workspace (never the calling agent itself).
- **MCP re-derivation for existing agents** — running a command with MCP servers against an *existing* agent registers them for that agent; the next session reopen (`resume`/`refresh`, including the idle-hour release) contributes the servers the agent's saved config lacks — launch-only, never saved, collision-checked against the daemon's own agent record, and every unknown state fails safe to skip. A "Refresh Command Center tools on this agent" Command Center action forces the reopen via `agents.ref(id).reload()`.
- **Turn-aware dispatch** — when a run targets an existing agent that is mid-turn, the run dialog asks: interrupt the turn (the daemon default) or steer the prompt into it.
- **Deep links** — the screen accepts `view` / `command` / `schedule` params: `/cc list`, `/cc history` and `/cc schedule …` land on the right tab (the new schedule expanded), and the history and schedules tabs can jump to the exact source command, which is border-highlighted in the library.
- **Settings screen** — Paseo Settings → Plugins → Command Center: history retention (10–500), default provider/model for new prompt commands, and the automation hooks.
- **Schedules** — any command (prompt or shell) can be scheduled on the standard Paseo scheduler, managed entirely from the plugin: the `Schedule` button next to `Edit` on a command card opens the form prefilled from the saved command (rendered prompt with default inputs, stored model, workspace), while the run dialog's `Schedule…` button freezes exactly the values you previewed. Pick a cadence preset or a cron expression, cap the number of runs, optionally fire once immediately; shell lines are wrapped into an agent instruction for each run. Schedules run on the daemon host (they also appear in the native Schedules sidebar), the plugin keeps the link to the creating command, and a dedicated tab offers pause/resume, run-now, an inline cadence editor and per-run tracking (status, timing, output/errors).
- **Composer attachment source** — saved commands are searchable from the composer's attachment picker; picking one inserts the template text into the message.
- **Entry points** — sidebar header row, Command Center item (⌘K), and a `/cc` slash command in agent chats (`/cc <name>` runs with defaults; `/cc list`, `/cc history`, `/cc schedule <name> <cron> [name]` open the Command Center screen / create a schedule).
- **Host typography** — text sizes on the screen are scaled by the interface text size from Paseo's Settings → Appearance, and a configured interface/code font family is applied to plugin text (see limitations in `__doc.md`).

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:command-center
```

Requires Paseo ≥ 0.14.0 (verified against the stable 0.14.0 release, 2026-11-01). Version 0.6.0 uses 0.14.0-only surface — the `agent.session_open` tool/MCP maps and `agents.ref(id).reload()` — so the real host gate rejects older daemons; earlier versions raised the floor to the first release whose `client/ui` exported `Modal` / `useToast`.

The plugin is installed into the Paseo home and runs from there: `~/.paseo/plugins/command-center/<revision>/checkout/command-center`, together with its dependencies. It talks to the standard Paseo scheduler through the low-level `@getpaseo/client` daemon client, which Paseo does **not** supply to plugins — so the manifest runs `npm ci` as its install-time build step, and the daemon installs the dependencies before bundling. That means the host needs npm-registry access at install and update time. Updates: `paseo plugin update command-center`.

See [__doc.md](./__doc.md) §5f for the bundler rules this plugin has to respect.

## Development

```bash
npm install
npm run typecheck
npm test
```

Storage layout on the daemon host:

```
$PASEO_HOME/plugins/command-center/
├── commands.json    # the command library
├── categories.json  # known category labels
├── history.json     # the last N runs (settings.historyLimit)
└── schedules.json   # scheduleId ↔ command links for the scheduler bridge
```

## Version 0.6.0 — the §12.3 recommendations (2026-11-01)

Implements all four recommendations recorded by the 0.14.0 pass; full
design notes and evidence: [__doc.md](./__doc.md) §13. New functionality →
second-digit bump; `requirements.paseo` raised one step, to `>=0.14.0`.

- **`command_center_run` agent tool** (`defineAgentTool`) — runs a saved
  command by name from inside any agent; delivered on every interactive
  session open through the hook's `tools` map (the SDK has no global tool
  registration). Shell → a terminal in the agent's own workspace; prompt →
  a **new** agent there with the stored provider and MCP servers, never the
  calling agent (no self-prompt recursion).
- **Session-open MCP re-derivation** — runs against an *existing* agent
  register the command's MCP servers in a per-agent registry; on the next
  `resume`/`refresh` reopen the hook contributes the names the agent's
  saved config lacks, launch-only, with the collision check reading the
  daemon's own agent record and failing safe to skip on any unknown state.
- **"Refresh Command Center tools on this agent"** — a `context: "agent"`
  Command Center action on the new `agents.ref(id).reload()`, which reopens
  the session and re-derives both contributions.
- **Turn-aware dispatch** — the run dialog asks what happens when the
  existing-agent target is busy: `interrupt` (daemon default) or `steer`.
  (The protocol has no `queue` value.)
- **Deep links** — `view`/`command`/`schedule` screen params, used by `/cc`
  and by the "Show command" actions in the history and schedules tabs.

**Verification:** typecheck clean, vitest **13 suites / 149 tests**, both
entries built by the real 0.14.0 host compiler with zero deprecated strings
(plus a negative control), the manifest gate rejecting an older daemon and accepting 0.14.0, and `running` with `[paseo] Plugin ready` and **21 RPC
methods** in an isolated 0.14.0 daemon.

## Paseo 0.14.0 compatibility

Verified against the **stable Paseo 0.14.0** release (2026-10-29), pass run
2026-11-01. Full evidence: [__doc.md](./__doc.md) §12. **The one deprecation left in the plugin is now migrated — shipped as `0.5.3`** (patch bump:
change to existing functionality).

- **Migrated off the deprecated UI entry point.**
  `client/command-center-surface.tsx` now imports `Modal` and `useToast`
  from `@getpaseo/plugin/client/ui` instead of
  `@getpaseo/plugin/client/react-native` (removal 2027-04-20). Both symbols exist in `client/ui` since the release the floor names — verified
  in the npm tarballs, not assumed — and no deprecated API remains anywhere in the plugin.
- **The floor follows the API actually used:** `requirements.paseo`
  `>=0.11.0` → the first release whose `client/ui` carries `Modal` /
  `useToast`. The real 0.14.0 host gate (`assertPluginCompatibility`) rejects
  the manifest for a 0.12.0 daemon and accepts 0.14.0.
- **Real pin bump:** `@getpaseo/plugin` and `@getpaseo/client` now pin
  `^0.14.0` (lockfile updated). The `@getpaseo/client` pin is shipped — the
  manifest's `npm ci` installs it and the scheduler bridge is bundled from
  the plugin's own `node_modules`, so the bridge now runs 0.14.0's daemon
  client.
- **The scheduler bridge is untouched by the SDK diff:** all nine `schedule*`
  methods keep **byte-identical** option/payload types across that step, and the `@getpaseo/client` daemon-client diff is additive only
  (`wholeTurns`, local speech models). The `agent.turn_ended` automation
  still reads only `event.outcome`, so the always-empty `timeline` does not
  bite.
- **Recommendations recorded by the pass** ([__doc.md](./__doc.md)
  §12.3) — a native `command_center_run` agent tool via `defineAgentTool`,
  session-open MCP re-derivation for runs against an existing agent plus a
  "refresh command tools" action on `agents.ref(id).reload()`, turn-aware
  dispatch (`activeTurnBehavior`), and deep links through screen params —
  **all four implemented in 0.6.0** (see above and §13).

**Verification:** typecheck clean against both 0.14.0 SDKs, vitest **9
suites / 98 tests** pass, both entries build with the **real 0.14.0 host
compiler** (from the installed `app.asar`) with zero deprecated strings —
plus a negative control that *does* find the old specifier — and the plugin
installs into an isolated 0.14.0 daemon (scratch home) as `running` with
`[paseo] Plugin ready`, 20 RPC methods registered and a clean reload.

## Paseo 0.12.0 spec conformance

Verified against the **stable Paseo 0.12.0** release (2026-10-21).
Full evidence: [__doc.md](./__doc.md) §10.

**What the new version changed for this plugin:**

- Both SDK diffs (`@getpaseo/plugin@0.10.1 → 0.12.0` and
`@getpaseo/client@0.10.1 → 0.12.0`) are **additive only** for every API this
plugin uses. The `0.11.0 → 0.12.0` client declarations are byte-identical,
so `requirements.paseo` is `>=0.11.0` — the API floor — not `>=0.12.0`.
- All eight `schedule*` methods on the low-level `DaemonClient` that the
scheduler bridge calls (`scheduleList`, `scheduleCreate`, `schedulePause`,
`scheduleResume`, `scheduleRunOnce`, `scheduleDelete`, `scheduleLogs`,
`scheduleUpdate`) are present in `@getpaseo/client@0.12.0` unchanged. The
only signature change in that class is an optional trailing `timeout` on
`readFile`, which this plugin does not call.
- The 0.10-era registrations this plugin used are `@deprecated` in the SDK
(`addSurface`, `addSidebarItem`, `openSurface`). They still work — the
0.12.0 host ships them as shims over `addScreen`/`addSidebarHeaderItem`/
`openScreen` — so this was a migration for correctness, not a breakage fix.
- **Correction to an earlier claim:** the previous release notes in this
repo said the host's compatibility shims were "scheduled for removal after
2027-03-29". That date belongs to *other* `COMPAT(...)` markers in the
0.12.0 sources (`codexFastPreference`, `pluginProviderLaunch`); the
surface/sidebar shims carry **no** removal marker in the shipped 0.12.0
app bundle, and the SDK's `@deprecated` tags state no removal version.
Treat their removal as *when it happens*, not as a dated deadline.

**Migrated in 0.5.2:**

| Before | After |
| ------ | ----- |
| `client.addSurface(id, Component)` | `client.addScreen({ id, title, Component })` |
| `client.addSidebarItem({ id, title, icon, surface })` | `client.addSidebarHeaderItem({ id, title, Component })` rendering `<SidebarRow icon="TerminalSquare" />` |
| `onSelect({ openSurface })` (both Command Center items) | `onSelect({ openScreen })` → `openScreen({ screenId })` |
| `/cc` slash command `onSubmit({ … openSurface })` | `onSubmit({ … openScreen })` — all five branches |
| screen component took `PluginSurfaceProps` | takes `PluginScreenProps` (adds `params`) |
| `requirements.paseo: ">=0.8.0"` | `">=0.11.0"` |
| `@getpaseo/plugin@0.10.1`, `@getpaseo/client@0.10.1` | `0.12.0` / `0.12.0` |

**Spec violation found and fixed:** 0.12.0's client audit says a
cross-platform module touching a DOM global outside `client/web.ts` is a
bug. `client/use-host-typography.ts` read `globalThis.localStorage`
directly. It now calls `readHostTypography()` from the new `client/web.ts`,
gated on `Platform.OS === "web"` with `null` on native so callers fall back
to defaults. The audit is clean after the change.

**Verification:** typecheck clean against both 0.12.0 SDKs, vitest
**9 suites / 98 tests** pass, no deprecated registrations remain in
`client/`, and every contribution ID conforms to the lowercase/hyphen rule.
Live-verified on a real 0.12.0 daemon in an isolated home: installs as
`running`, logs `Plugin ready`, reloads cleanly (`paseo plugin reload`,
the fixed #6306 flow), and the real 0.12.0 host compiler builds the
client entry with zero legacy API calls in the compiled bundle.

Still open, all optional and none conformance blockers:

1. **Audible run feedback** — `client.playAudio({ base64, mimeType })` for
   unattended scheduled/automated runs.
2. **Deep links through screen params** — `PluginScreenProps.params` lets
   history, schedules and `/cc` open the library on an exact command or
   schedule, and `PluginScreenTitle` can derive the header from them. New
   capability → second-digit bump.
3. **Multi-row sidebar** — `SidebarRow` / `SidebarSeparator` groups and an
   `addSidebarFooterItem` slot, host-native instead of in-screen tabs.
4. **Provider launch diagnostics** — `ProviderRegistration.command`/`status`
   so the run dialog can show *why* a provider will not start.
5. **Turn-aware dispatch** — `activeTurnBehavior` (queue vs. interrupt) for
   single-target runs against an existing agent.
6. **Usage reporting** — `server.registerUsageSource(...)`; still optional,
   and 0.12.0 does not change the earlier reasoning about it.

Technical details, design decisions, limitations and the roadmap: see [__doc.md](./__doc.md).
