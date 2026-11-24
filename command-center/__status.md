# Status — command-center

Current: plugin **0.14.4**, `requirements.paseo >=0.17.0`, `@getpaseo/plugin ^0.17.1` +
`@getpaseo/client ^0.17.1`, verified against **Paseo 0.17.1 (2026-11-21)** — **compatible**.

This file carries the status notes that used to fill the *Status* column of the root
`README.md` (the table there now keeps only this short verdict). Compatibility evidence
stays in [`__compatibility.md`](./__compatibility.md), technical detail in
[`__doc.md`](./__doc.md).

## Verdict

Compatible; additive-only SDK diff and no deprecated API in use.

## Release notes

- **0.14.4** — adopts 0.17's `appendSystemPrompt` (provenance instructions) and
  `focusHost` (history target links), hence the raised floor, and adds an agent panel and
  a workspace row badge.
- **0.13.4** — the 0.17.1 verification release.
- **0.13.3** — fixed a session-open result that failed every prompt.

## Maintenance notes

- Keep this file for release-by-release status notes, known gaps and anything a reader
  needs beyond the one-word verdict; extended SDK evidence belongs in
  [`__compatibility.md`](./__compatibility.md).
