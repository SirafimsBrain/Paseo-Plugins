# Status — bunny-search

Current: plugin **0.9.8**, `requirements.paseo >=0.17.0`, `@getpaseo/plugin ^0.17.1`,
verified against **Paseo 0.17.1 (2026-11-21)** — **compatible**.

This file carries the status notes that used to fill the *Status* column of the root
`README.md` (the table there now keeps only this short verdict). Compatibility evidence
stays in [`__compatibility.md`](./__compatibility.md), technical detail in
[`__doc.md`](./__doc.md).

## Verdict

Compatible; additive-only SDK diff and no deprecated API in use.

## Provider verification (2026-11-24, this machine)

Live checks against the real services, through the plugin's own provider code
(`Test connection` and real searches, no mocks):

| Provider | Result |
| -------- | ------ |
| **DuckDuckGo** (HTML endpoint) | **Working** — real results, redirect links unwrapped |
| **Tavily** (keyed API) | **Working** — authenticated search returns real results |
| **DDGS Python** (user-installed `ddgs`) | **Working with a caveat** — real results, but the availability check intermittently reports the library as missing (see below) |
| DuckDuckJS (default multi-engine) | No results — every bundled engine refuses anonymous requests from this IP (see *Known issues*) |
| SearXNG | Not reachable on this machine (`http://omnirouter/search` times out) |

Caveat on DDGS Python: a search sometimes fails with *"Python with the `ddgs`
library was not found"* even though `ddgs` is installed and earlier searches
worked. Discovery runs on the first search after a restart (or after the cached
interpreter failed to import), walks every candidate with a short `import ddgs`
probe and caches only a successful one; when that walk misses — for example a
`python3` earlier on `PATH` that answers slowly or the venv being probed while
the host is busy — the call reports the library as missing instead of falling
back to the interpreter that worked a moment ago. Repeating the search
succeeds, and pinning `Python path` to the interpreter that has the library
(here `~/venv/bin/python`) removes the symptom. The walk itself is unchanged in
0.9.8; this release records the observation.

## Release notes

- **0.9.8** — documentation-only patch (third digit +1): records the 2026-11-24
  provider verification (DuckDuckGo HTML, Tavily and DDGS Python work from this
  machine; DDGS Python intermittently reports the library as missing) in this
  file, the plugin `README.md` and `__doc.md` §24. No code, settings, output
  shape or version floor changed.
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
  "engines answered but returned no results". Workarounds that were verified working
  on the same day: the **DuckDuckGo** (HTML) provider, **Tavily** with a key, and the
  user-installed **DDGS Python** provider (`pip install ddgs`, then select *DDGS
  Python*). A `Proxy URL` with a clean egress IP or a reachable SearXNG instance
  (the configured `http://omnirouter/search` timed out on 2026-11-24) would also
  restore the multi-engine providers. Not a plugin defect — the provider code is
  unchanged and `tests/providers.test.ts` passes; those tests mock the library, so
  they do not detect upstream blocking. Since 0.9.7 the DDGS adapter's per-engine
  walk also survives a single transient miss (live check at 11:53: 5 results,
  `ok: true`). Later on 2026-11-24 the library's `yahoo` engine also began returning
  nothing, so the DDGS provider depends on whichever engine happens to answer; when
  none does, it reports `no engine returned results (…)` with the per-engine errors.
- **2026-11-24 — DDGS Python availability is intermittently reported as missing.**
  See the caveat under *Provider verification*; retry or pin `Python path`.

## Maintenance notes

- Keep this file for release-by-release status notes, known gaps and anything a reader
  needs beyond the one-word verdict; extended SDK evidence belongs in
  [`__compatibility.md`](./__compatibility.md).
