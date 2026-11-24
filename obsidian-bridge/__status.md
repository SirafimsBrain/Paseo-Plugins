# Status — obsidian-bridge

Current: plugin **0.26.23**, `requirements.paseo >=0.17.0`, `@getpaseo/plugin ^0.17.1`,
verified against **Paseo 0.17.1 (SDK 0.17.3, 2026-11-23)** — **compatible**.

This file carries the status notes that used to fill the *Status* column of the root
`README.md` (the table there now keeps only this short verdict). Compatibility evidence
stays in [`__compatibility.md`](./__compatibility.md), technical detail in
[`__doc.md`](./__doc.md).

## Verdict

Compatible.

## Release notes

- **0.26.23** — fixes what the live planning test of 0.26.22 found: `null` reaches
  `brief`/`payload`/`plan` schemas, a filtered overview counts only its project,
  plan notes open with their name and description, incidents show the leaves they
  block, `notes` is empty instead of `—`, `plan_history` marks snapshots that a
  kind change made unrestorable, a leaf in the way is named, and semantic search
  reports `unavailable` instead of `done` when the installation cannot load the
  model (with correct vector counters and checkout-aware resolution).
- **0.26.22** — adds a *Remove agent integration* action that deletes the
  OpenCode/Kilo/Cline MCP entries, the installed skill directories and the saved MCP
  server of existing agents (finding entries an older name left behind by launch path and
  skill marker) and turns the four integration switches off.
- **0.25.22** — hardens the standalone MCP installation (safe uninstall, atomic 0600
  settings, explicit source precedence, namespaced opt-in skills, lexical-only standalone
  mode, standalone-only index refresh) and keeps the Paseo plugin's tools and inputs
  unchanged.
- **0.24.22** — keeps machine-specific home paths out of the shipped sources with a guard
  test, and shows the vault-path placeholder as `~/…`.
- **0.24.21** — installs the release its installer belongs to, so a `curl` from a tag URL
  builds and records that tag instead of `main`, and completes the release pipeline the
  first tag exposed: a lockfile regenerated for CI's npm (a stale `esbuild` entry), and
  `npm ci --ignore-scripts` in the workflow because `onnxruntime-node`'s postinstall
  downloads a CUDA asset that 404s on a runner. An OpenCode config test no longer depends
  on the developer's `~/.paseo`.
- **0.23.18** — installs the same MCP server standalone (no Paseo) with
  `obsidian-bridge-install.sh` into `~/.agents/obsidian-bridge-mcp`, with its own
  `settings.json`, index and `AGENT-SETUP.md`, and refreshes the index before a search.
- **0.22.18** — adds a per-open agent instruction via `appendSystemPrompt` (setting +
  `{server}` prefix, hence the 0.17 floor), `useTabState` for the workspace panel, a
  read-only Markdown file panel, an index badge on workspace rows and
  `/obsidian <query>`.
- **0.21.18** — found no deprecated API in use.

## Behaviour notes

- The plugin enforces its own boundary (symlinks resolved, configurable document
  extensions, `.md` by default).
- Planning is scoped by Paseo project, with the planning directory defaulting to
  `Projects`; the settings screen can check and create that folder.
- Planning operations were corrected from a live test (approval layout, archive scope,
  kind-change migration, nested frontmatter, search noise, index rebuild).
- The settings mirror is accepted only as plugin-written data.
- OpenCode/Kilo still get the server from their own config files.

## Maintenance notes

- Keep this file for release-by-release status notes, known gaps and anything a reader
  needs beyond the one-word verdict; extended SDK evidence belongs in
  [`__compatibility.md`](./__compatibility.md).
