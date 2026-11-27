# Status — session-manager

Current: plugin **0.8.1**, `requirements.paseo >=0.15.0`, `@getpaseo/plugin ^0.17.1`,
verified against **Paseo 0.17.1 (2026-11-21)** — **compatible**.

This file carries the status notes that used to fill the *Status* column of the root
`README.md` (the table there now keeps only this short verdict). Compatibility evidence
stays in [`__compatibility.md`](./__compatibility.md), technical detail in
[`__doc.md`](./__doc.md).

## Verdict

Compatible; additive-only SDK diff and no deprecated API in use.

## Release notes

- **0.8.1** — adds **Pi** (`@earendil-works/pi-coding-agent`, `~/.pi/agent`) as the
  seventh provider: NDJSON transcripts under `sessions/<--sanitized-cwd-->/`,
  listed and deleted from disk, exported through `pi --export` (HTML).
- **0.7.1** — adds a per-agent sessions panel, `/sessions` filters and `focusHost` on the
  agent link, on top of the 0.6.1 verification.

## Maintenance notes

- Keep this file for release-by-release status notes, known gaps and anything a reader
  needs beyond the one-word verdict; extended SDK evidence belongs in
  [`__compatibility.md`](./__compatibility.md).
