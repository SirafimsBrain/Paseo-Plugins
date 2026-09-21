# session-manager

A Paseo plugin for managing ACP (Agent Communication Protocol) sessions stored on disk.

## Features

- **Workspace panel** titled "Provider Sessions" (available in the `workspace` and `explorer` panel locations) that lists all recorded ACP sessions.
- **Command Center item** ("Open provider sessions") that opens the panel on demand.
- **Filtering** — toggle to show only closed sessions, or all sessions.
- **Browsing** — sessions are sorted by last-used time (oldest first) and show the agent command, status (open/closed), age, and working directory.
- **Deletion** — delete a single session or (see the server module) batches of sessions, with a two-step confirm flow and toast feedback.

## How it works

The plugin reads the ACP session index located at `~/.acpx/sessions/index.json` and the per-session `*.json` metadata / `*.stream.ndjson` stream files stored alongside it. It exposes three RPCs (`session-manager.list`, `session-manager.delete`, `session-manager.delete-batch`) implemented on the server side and consumed by the client side panel.

For detailed technical documentation see [`__doc.md`](./__doc.md).

## Requirements

- Paseo `>=0.8.0` (declared in `paseo-plugin.json`).
