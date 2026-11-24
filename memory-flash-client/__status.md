# Status — memory-flash-client

Current: plugin **0.7.1**, `requirements.paseo >=0.17.0`, `@getpaseo/plugin ^0.17.1`,
verified against **Paseo 0.17.1 (2026-11-21)** — **compatible**.

This file carries the status notes that used to fill the *Status* column of the root
`README.md` (the table there now keeps only this short verdict). Compatibility evidence
stays in [`__compatibility.md`](./__compatibility.md), technical detail in
[`__doc.md`](./__doc.md).

## Verdict

Compatible.

## Release notes

- **0.7.0** — appends one agent instruction per open via `appendSystemPrompt` (never
  saved, never contains a key), hence the raised floor: a 0.16.x daemon rejects the
  field.
- **0.7.1** — renders `{server}`/`{servers}` with the actual configured server names so
  the instruction uses the prefixed tool names Paseo exposes.
- **0.6.4** — replaced the deprecated `server.before` hooks.

## Known gaps

- The screen-draft `useTabState` recommendation is withdrawn because 0.17.1 exposes
  `PluginTab` only to panels.

## Maintenance notes

- Keep this file for release-by-release status notes, known gaps and anything a reader
  needs beyond the one-word verdict; extended SDK evidence belongs in
  [`__compatibility.md`](./__compatibility.md).
