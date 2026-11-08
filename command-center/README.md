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

## Compatibility

Paseo **0.14.0 (2026-11-01)** verified, `requirements.paseo >=0.14.0`, SDK `@getpaseo/plugin ^0.14.0` + `@getpaseo/client ^0.14.0` — compatible; 0.14.0 surface in use (0.6.0).

Full detail: [__compatibility.md](./__compatibility.md); technical evidence: [`__doc.md`](./__doc.md) (Compatibility sections).
