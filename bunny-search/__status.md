# Status — bunny-search

Current: plugin **0.9.7**, `requirements.paseo >=0.17.0`, `@getpaseo/plugin ^0.17.1`,
verified against **Paseo 0.17.1 (2026-11-21)** — **compatible**.

This file carries the status notes that used to fill the *Status* column of the root
`README.md` (the table there now keeps only this short verdict). Compatibility evidence
stays in [`__compatibility.md`](./__compatibility.md), technical detail in
[`__doc.md`](./__doc.md).

## Verdict

Compatible; additive-only SDK diff and no deprecated API in use.

## Release notes

- **0.9.7** — the DDGS adapter no longer relies on the library's `auto` mode, which
  aborts on the first blocked engine; it falls back to walking the library's text engines
  one by one (up to two passes, since a single engine can also miss transiently) and
  takes the first non-empty answer.
- **0.8.7** — adopts 0.17.x `appendSystemPrompt` and `focusHost`, hence the raised floor
  a 0.16.x daemon would reject.
- **0.7.7** — the 0.17.1 verification release (0.17.1 keeps the shared
  OpenCode-service restriction).

## Known issues

- **2026-11-24 — DuckDuckJS returns no results from this machine.** All five engines
  refuse anonymous scraping: DuckDuckGo answers HTTP 202 with its anti-bot challenge
  page, Google serves an `enablejs` interstitial whose markup matches none of the
  library's selectors, Brave returns 429, Mojeek 403 and Yahoo 500. The
  `@overclockedsenku/duckduckjs` dependency is already at its latest published version
  (26.1.0, 2026-04-01), so no upgrade fixes this. *Test connection* reports it as
  "engines answered but returned no results". Workarounds: a `Proxy URL` with a clean
  egress IP, the user-installed DDGS Python provider (`pip install ddgs`, then select
  *DDGS Python*), or a reachable SearXNG instance (the configured
  `http://omnirouter/search` timed out on 2026-11-24). Not a plugin defect — the
  provider code is unchanged and `tests/providers.test.ts` (49 tests) passes; those
  tests mock the library, so they do not detect upstream blocking. Since 0.9.7 the
  DDGS adapter is the working fallback on this machine: `ddgs` 9.16.1 lives in `~/venv`,
  `yahoo` answers while the other library engines return nothing, and the adapter's
  per-engine walk survives a single transient miss (live check at 11:53: 5 results,
  `ok: true`). Later on 2026-11-24 `yahoo` began returning nothing for every query as
  well, so no free engine answers from this IP any more; restoring search needs a proxy,
  a reachable SearXNG, or a keyed provider (Tavily, Exa, Kagi, Perplexity, Brave).

## Maintenance notes

- Keep this file for release-by-release status notes, known gaps and anything a reader
  needs beyond the one-word verdict; extended SDK evidence belongs in
  [`__compatibility.md`](./__compatibility.md).
