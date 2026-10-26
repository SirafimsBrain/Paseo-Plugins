# remote-control — technical notes

See `PLAN.md` for the full atomic plan, decisions (ADR-1..ADR-13) and risks. This file accumulates technical details as stages land.

## Transport (stage A3, 2026-10-25)

**Decision: WebSocket is the terminal transport.** The SSE+POST variant
stays an explicitly unimplemented stub (`SsePostTransport` in
`server/transport.ts`, `SsePostTransportStub` in `console/src/transport.ts`).

Evidence, recorded from the live run described below:

- WebSocket works from the Paseo workspace browser tab (Paseo 0.13.0,
  Electron 44 / Chrome 152 UA) against the plugin's loopback server: connect,
  byte-exact binary echo, JSON control frames — all pass. So the full §5.3
  frame contract is viable, no downgrade to SSE needed.
- SSE (`/api/events`) also streams fine in the same tab, so as a fallback
  path remains available (ADR-12 uses it for live updates of views other
  than the terminal).

Conditions of the decision:

- The browser side is a webview with a real Chromium network stack — the
  workspace browser does not constrain WebSockets. If a future Paseo build
  regresses this, the swap touches only the two `*transport*.ts` files and
  `server/transport.ts` keeps the same frame contract over SSE+POST.
- Security model required by ADR-2 and verified here: upgrade handled for
  `GET /term` only; access token required (query `?token=` for browsers,
  `Authorization: Bearer` also accepted; timing-safe comparison); `Origin`
  header required and its host must equal the request `Host` header,
  so a foreign page or non-browser tool cannot attach (403), and a missing
  or bad token gets 401.
- Node does not track upgraded sockets in `server.closeAllConnections()`:
  `ConsoleHttpServer.stop()` therefore disposes the transport bridge
  **before** closing the HTTP server, otherwise a live terminal connection
  keeps `server.close()` hanging.

### A3 live acceptance run (2026-10-25)

- Server: `node scripts/spike-transport.mjs --port 8891`
  (`scripts/spike-server.ts` bundled on the fly — no daemon needed, both
  `server/http-server.ts` and `server/transport.ts` are plain Node modules).
- Page: the probe page copied to `dist/console` (`console/index.html` +
  `console/src/main.ts` → `main.js`), opened in the real Paseo workspace
  browser. All checks run in-page and report through the DOM
  (`#run-state[data-state]`, `li[data-test][data-state][data-detail]`,
  `window.__rcProbeDone`) — no screenshots (Paseo memory #7).
- Results: `t1-connect` pass, `t2-binary-echo` pass (256-byte pattern
  byte-exact), `t3-ping-pong` pass, `t4-events` (SSE) pass; negative probes
  done in-page: WS without a token and with a wrong token are refused,
  correct-token echo roundtrip OK. Unit coverage in `tests/transport.test.ts`
  (status codes 401/403/404, byte-exact echo, control echo mode, parallel
  sessions, live-connection tracking, SSE subscriber tracking, stop semantics).
- `tests/http-server.test.ts`: adapted to `@types/node` 22.20.5 typing
  (`res.json()` now yields `unknown`) — no behavior change.

## Install (note)

`@lydell/node-pty` declared its platform binary as an *optional* dependency,
which Paseo's `npm ci` step omitted, causing the plugin to fail to load on
linux-x64. Switched back to the original `node-pty`, which compiles via
`node-gyp rebuild` during `npm ci` (node-gyp is now a devDependency; build
tools gcc/make/python are required on the host). This is the path validated
by risk R2.

- `shared/connections.ts`: zod schemas for groups/connections (hierarchy, validation).
- `shared/protocols.ts`: protocol registry (ssh/rdp/vnc) with default ports, payload schemas, secret fields, launchable flags.
- `server/store.ts`: SQLite (WAL, busy_timeout, foreign_keys, schema_version 1) with groups/connections/settings/meta; CRUD + archive/delete; migrations.
- `server/protocols/registry.ts`: launcher registry with buildLaunchFor.
- `server/protocols/ssh.ts`: buildSshArgv, materializeIdentity (0600), createAskpassHelper (SSH_ASKPASS, secret never in argv/env), cleanupRunDir, prepareSshLaunch (vault-backed).
- `server/sessions.ts`: createSsh (spawns ssh via PTY with run dir, cleanup on exit), reconnect.
- REST: /api/groups, /api/connections[/:id], /api/sessions (connectionId → ssh).
- Console: Connections section (new group/connection, launch for ssh).
- Tests: tests/store.test.ts (15 tests).

- `server/vault.ts`: `VaultService` over an isolated `GNUPGHOME` + `PASSWORD_STORE_DIR`
  (defaults `$PASEO_HOME/pass-gnupg` and `$PASEO_HOME/pass-store`), supporting
  `setup` (generates a RSA key with the master password as its passphrase,
  writes `.gpg-id`, creates an encrypted probe), `unlock` (trial decryption,
  caches the passphrase in a Buffer), `lock` (zeroes the buffer, kills
  gpg-agent), `status`, `listEntries`, `get`, `set`, `delete`. Auto-lock by
  inactivity supported (default off). `gpg-agent.conf` sets cache ttl 0 so
  unlock actually verifies the password.
- `shared/vault.ts` + RPCs `vault.setup/unlock/lock`; `state` now reports
  `vault: { initialized, unlocked, entries }`.
- REST: `/api/vault/{status,setup,unlock,lock}`, `/api/secrets[/:name]`
  (GET/POST/PATCH/DELETE), token-gated; only names are listed, values fetched
  on demand.
- `client/console-screen.tsx`: vault status, Setup/Unlock (prompt) and Lock
  buttons. Console: secrets section (status, lock, new secret, list with
  view/delete).
- Cleanup: `vault.lock()` on plugin dispose. C3: wrong password not cached,
  buffer zeroed on lock, auto-lock timer, foreign store dir via `storeDir`
  option, scenario tests skip gracefully when gpg is absent.
- Tests: `tests/vault.test.ts` (12 tests, gpg-gated).

- `server/pty.ts`: `Pty` wraps `@lydell/node-pty` (linux-x64 prebuild, no
  native compile needed), ring buffer (`RingBuffer`, default 64 KiB) with
  `snapshot()` for attach replay, `write`/`resize`/`kill`, `onData`/`onExit`.
- `server/sessions.ts`: `SessionRegistry` with unified `Session` shape
  (local/ssh/rdp/vnc kinds, starting/running/exited/failed states), createLocal,
  kill, reconnect (new PID, seeds the new pty's buffer from the old snapshot),
  attach (replay + live data + exit notification), resize. Emits
  `session-updated` events.
- `server/transport.ts`: default connection handler is now `sessionBridge`
  (attach by `sessionId`, binary↔PTY, resize, ping→pong, detach on close);
  `echoConnection` remains exported for tests/spikes. `PtyHandle` interface
  keeps transport decoupled from sessions.
- `server/http-server.ts`: `/api/sessions` (GET list, POST create local),
  `/api/sessions/:id/kill`, `/api/sessions/:id/reconnect`; SSE broadcasts
  `session-updated`. `broadcastSse` added.
- `console/src/main.ts`: Sessions section — New local session, list with
  kill, selection attaches the terminal over WS (attach frame, input routing,
  exit notification), SSE-driven refresh.
- `index.server.ts`: wires `SessionRegistry` into the endpoint (resolveSession
  + sessions + onServerStarted broadcast). Cleanup disposes the registry.
- Tests: 42 total green (transport tests switched to `echoConnection` for
  echo-mode assertions).

- `console/src/terminal.ts`: wraps `ghostty-web` (`init`, `Terminal`, `FitAddon`):
  `mountTerminal(container, options)` inits the WASM runtime once, opens the
  terminal into the container, fits + observes resize via `FitAddon`. Renders
  an optional banner. Disposes both addon and terminal.
- `shared/terminal-options.ts`: pure `ghosttySettingsToTerminalOptions` mapping
  imported Ghostty settings (font, size, scrollback, cursor style/blink/colour,
  theme + 16-colour palette entries `N=color`) onto terminal runtime options.
  Unit-tested in `tests/terminal-options.test.ts`.
- `console/index.html` gained a `#terminal` container; `console/src/main.ts`
  mounts the terminal with a banner on load.
- `ghostty-web`'s WASM ships as an embedded base64 data URL, so esbuild
  carries it inside `dist/console/main.js` — no separate asset required
  (verified: bundle contains `ghostty-web`).
- The PTY bridge (stage B3) will feed bytes via `terminal.write` and read
  input via `terminal.onData`; this stage only proves the renderer.

- `server/ghostty-config.ts`: `discoverGhosttyConfigPaths` / `findGhosttyConfigPath`
  (XDG_CONFIG_HOME → `~/.config/ghostty/config` → macOS Application Support →
  `~/.ghostty/config`), `parseGhosttyConfig` (comments, `key = value` and
  `key=value`, `config-file` includes with cycle + depth guards), and
  `mapGhosttySettings` (supported keys → typed `GhosttySettings`, everything
  else — including the keys orca dropped in review: `window-padding-color`,
  `window-padding-balance`, `selection-word-chars` — collected, de-duplicated,
  into `ignored`).
- Comment stripping treats `#` as a comment marker only when it is not
  immediately followed by a hex colour (3/6/8 hex digits), so values such as
  `background = #1e1e2e` survive.
- `shared/ghostty-settings.ts`: zod schemas for the imported settings and the
  import preview.
- Persistence (interim, until the SQLite store lands in D1): JSON file at
  `$PASEO_HOME/plugins/remote-control/ghostty-settings.json`, via
  `loadGhosttySettings` / `applyGhosttySettings`.
- REST: `GET /api/ghostty/import` (preview) and `POST /api/ghostty/import/apply`
  (body `{ settings }` or a bare settings object), both token-gated.
- Console: minimal Settings card with Preview / Apply buttons (in
  `console/src/main.ts`), rendering the preview JSON.
- Tests: `tests/ghostty-config.test.ts` (38 total tests green).

- Token: empty plugin setting → random hex per session; a pinned value is
  used as is. `GET /health` needs no token, everything else (including
  `/api/events`) does; the SPA itself is served without a token, like in
  `luck-planner`.
- `server/paths.ts` resolves the install directory ESM → `__dirname` →
  `$PASEO_HOME/config.json plugins["remote-control"].path` (follows the
  install-trap memory: plugin files are not next to the running module).
- The native panel is a thin wrapper (status + "Open console"), polling the
  RPC; `state` now also reports `transport` and live `transportConnections`.
