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
- **Targeting** — multi-select workspaces grouped by host (prompt and shell), run-time provider/model picker with live model lists (disabled providers hidden), optional existing agent for single-target runs, optional branch-off worktree. One click fans out to many workspaces and hosts with per-target results.
- **History** — the last 50 runs with the rendered payload, target, used model/agent, and error; any entry can be repeated in one click with its values, target, and model prefilled.
- **Entry points** — sidebar item, Command Center item (⌘K), and a `/cc <command name>` slash command in agent chats.

## Install

```bash
paseo plugin add /path/to/command-center
```

Requires Paseo ≥ 0.8.0 (verified against 0.9.0).

## Development

```bash
npm install
npm run typecheck
npm test
```

Storage layout on the daemon host:

```
$PASEO_HOME/plugins/command-center/
├── commands.json   # the command library
└── history.json    # the last 50 runs
```

Technical details, design decisions, limitations and the roadmap: see [__doc.md](./__doc.md).
