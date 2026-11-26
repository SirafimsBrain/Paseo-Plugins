# Status — memory-flash

Current: plugin **0.15.1**, `requirements.paseo >=0.17.0`, `@getpaseo/plugin ^0.17.1`,
verified against **Paseo 0.17.1 (2026-11-21)** — **compatible**.

This file carries the status notes that used to fill the *Status* column of the root
`README.md` (the table there now keeps only this short verdict). Compatibility evidence
stays in [`__compatibility.md`](./__compatibility.md), technical detail in
[`__doc.md`](./__doc.md).

## Verdict

Compatible.

## Release notes

- **0.15.1** — Pi support (stdio MCP registration in `$PI_CODING_AGENT_DIR/mcp.json`
  and a skill target in `<agent-dir>/skills`) and the daemon gate: the bundled stdio
  server serves only while Paseo runs and otherwise answers every tool call with
  `Демон Paseo недоступен, MCP недоступен`. Skill body gained the *whole memory
  unavailable* protocol and the symbiont rule. Plan for the remaining plugins:
  [`MCP-STDIO-PLAN.md`](./MCP-STDIO-PLAN.md).
- **0.14.0** — implements the 0.17.x recommendations: per-open agent instructions via
  `appendSystemPrompt` (only when the agent gets the full memory server) and an
  **Open agent** action on memory rows with `focusHost`. The floor rose to `>=0.17.0`
  because a 0.16.x daemon rejects the field.
- **0.14.1** — resolves the `{server}` placeholder from `mcpServerName` so the
  instruction names `memory-flash_memory_save`-style tools, not bare ones.
- **0.13.8** — replaced the deprecated `server.before` hooks.

## Known gaps

- `useTabState` is panel-only in 0.17.1, so the screen-tab recommendation is withdrawn
  rather than faked.

## Maintenance notes

- Keep this file for release-by-release status notes, known gaps and anything a reader
  needs beyond the one-word verdict; extended SDK evidence belongs in
  [`__compatibility.md`](./__compatibility.md).
