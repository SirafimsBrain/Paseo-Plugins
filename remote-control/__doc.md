# remote-control — technical notes

See `PLAN.md` for the full atomic plan, decisions (ADR-1..ADR-14) and risks. This file accumulates technical details as stages land.

## The storage is the foundation; first run lives in the panel (stage 0.19.10, 2026-10-27)

Product rule (restated by the customer after 0.18.10): the secret storage —
login + password per connection — is the basis of the plugin. Typing a master
password into a connection form was the wrong place for it, and manual secret
management must not exist at all.

### Live acceptance: baseline confirmed (2026-10-27)

The customer ran the whole route in the app on 0.19.10 and confirmed it as
the baseline for further development: first-run master password created in
the sidebar panel → groups with connections shown → connection created with
its password → clicking it opened the SSH session in a terminal tab with no
login/password prompts. Later stages build on this route and must not change
its contract (panel gates the storage; secrets only via connections; SSH in
a tab; RDP/VNC as external windows).

### First run and unlock — only in the sidebar panel

`client/console-panel.tsx` gates everything behind the storage:

- **Not initialized (first run):** the panel shows *First run — create the
  master password* (one field) and calls the existing `vault.setup` +
  `vault.unlock` RPCs.
- **Locked:** a single unlock field (`vault.unlock` RPC).
- **Unlocked:** the group tree with connections (`connections.list`, which
  now returns `groups` too — tree order with nesting depth, computed
  client-side; connections hang under their group, root connections first,
  empty groups still visible).

While the storage is open nothing asks for anything (auto-lock is off by
default). A launch that fails on a meanwhile-locked storage flips the panel
back to the unlock form immediately (the 3 s poll keeps the status honest).

### Connection passwords: no master-password parameter anymore

- The console's *New connection* / *Edit connection* dialogs keep only the
  `password` field; the *Master password* field is gone.
- `POST /api/connections` and `PATCH /api/connections` accept `{ password }`
  only. Before anything is written, `requireOpenVault()` checks the storage:
  - not initialized → 400 `secret storage is not initialized: open the
    Remote Control panel and create the master password first` (no row is
    created);
  - locked → 400 `vault is locked: unlock it with the master password in the
    Remote Control panel`;
  - open → the value goes to `connections/<id>/password`, the row keeps only
    the secret name. `password: ""` clears, an absent field keeps — as in
    0.18.10.

### Manual secret management removed

- The console's **Secrets view is deleted** (nav entry, renderer, list/create/
  view/delete); nav is Terminals / Connections / Settings.
- The HTTP routes `POST|PATCH|DELETE /api/secrets*` and
  `POST /api/vault/{setup,unlock,lock}` are **gone**: they answer 404 with
  `removed: set up and unlock the storage in the Remote Control panel;
  secrets are managed only through connections`. `GET /api/vault/status`
  stays for the Settings screen.
- Setup/unlock/lock exist only as RPCs (`vault.setup/unlock/lock`), used by
  the panel and the native screen/settings panel.

Covered by the rewritten `tests/connections-password.test.ts` (7 tests):
store/update/keep/clear while open, first-run and locked rejections with
panel guidance (and no half-created row), a connection without a password
saving while locked, and the removed routes answering 404 while status
answers 200.

## Connection passwords and sidebar launches (stage 0.18.10, 2026-10-27)

Product rules this stage implements: the vault exists to store the login
**and password** of every connection; "open a terminal" means opening an SSH
session in a tab; sessions launch from the right sidebar panel — ssh in a
tab, rdp/vnc as external windows; the password is entered when the
connection is created and changed when it is edited.

### Credentials

- The console's *New connection* / *Edit connection* dialogs carry a
  `password` field (plus `masterPassword`) and are the only place a
  connection password is ever typed.
- `POST /api/connections`: a non-empty `password` makes the server run
  `ensureVaultReady(masterPassword)` — setup + unlock of the vault on the
  spot when needed — write the value to `connections/<id>/password` and put
  only that **name** into `secretRefs.passwordSecret`. The SQLite row and
  the API response never contain the value. A missing or wrong master
  password is a 400 *before* the row is created, so a failed save leaves
  nothing behind.
- `PATCH /api/connections`: `password` non-empty → store/replace (the
  master password is needed only while the vault is locked);
  `password: ""` → delete the secret and drop the ref; field absent →
  untouched — that is what the edit dialog sends when the field is left
  empty ("empty = keep"). A legacy `password` key inside `secretRefs` is
  migrated to `passwordSecret` on the next write.
- Logins (`username`) edit like any other column; the stored password is
  never echoed back — the edit dialog shows an empty password field.

### Launch from the right sidebar panel

`client/console-panel.tsx` lists every connection (RPC
`remote-control.connections.list`) and launches it (RPC
`remote-control.connections.launch`, handled in `index.server.ts`):

- **ssh** → `TerminalService.open({ connectionId, workspaceId })` → a Paseo
  terminal tab (see the 0.17.9 section). If the connection has a stored
  password and the vault is locked, the launch refuses with an explicit
  message instead of silently falling back to an interactive prompt.
- **rdp / vnc** → `launchExternalWindow()` (`server/protocols/external.ts`)
  spawns the desktop client detached; its window appears on the user's
  display like any other application window. Credentials stay out of argv:
  - FreeRDP (`xfreerdp3`, then `xfreerdp`): `/from-stdin:force` with the
    password written to stdin; `/v:host:port`, `/u:`, `/cert:ignore` — a
    detached launch has nobody to answer the interactive certificate
    prompt; payload `cert`/`extraArgs` override. FreeRDP ≥ 3 expected:
    stdin credential reading regressed in some versions
    (FreeRDP#11922, #12048).
  - TigerVNC (`vncviewer`, `xtigervncviewer`): `-passwd <file>` with a 0600
    file written by `vncpasswd -f`; when `vncpasswd` is missing the password
    goes to the child as `VNC_PASSWORD`/`VNC_USERNAME` (current TigerVNC),
    and with nothing available the viewer shows its own auth dialog. The
    run directory is removed when the window exits.
  - The client's stderr is captured (8 KiB cap) and a non-zero exit logs
    the tail through `paseo plugin logs`; a missing binary is an explicit
    error naming the candidates.
- The bare-terminal entry points are gone: no *New terminal* in the
  console's Terminals view (list + kill stay), no *Open terminal* buttons
  in the sidebar/settings panels, no ⌘K *Open terminal* item.

Covered by `tests/connections-password.test.ts` (6, gpg-gated),
`tests/external-launch.test.ts` (13: arg building, PATH resolution, a fake
`xfreerdp3` asserting the password arrives on stdin and not in argv, a fake
`vncpasswd`/`vncviewer` pair for the passwd file and its cleanup) and the
locked-vault case in `tests/terminals.test.ts`.

## Terminals are Paseo workspace tabs (stage 0.17.9, 2026-10-27)

**Decision: remote-control runs no PTY and renders no terminal.** The browser
terminal (ghostty-web + node-pty + the `/term` WebSocket bridge) was removed
from the plugin; every terminal is now a **Paseo workspace terminal**, which
the app opens as a terminal tab — the same model Orca uses for its terminal
tabs (host-owned PTY, terminal view owned by the tab).

Mechanism, verified against the Paseo 0.13.x sources:

- `paseo.terminals.create({ workspaceId, cwd?, name?, command?, args? })`
  (`@getpaseo/client` → daemon `create_terminal_request`, which carries
  `command`/`args` and **no** `env`) creates a daemon-side PTY.
- The app reconciles workspace tabs from the terminal list:
  `addMissingEntityTabs()` in `packages/app/src/stores/workspace-layout-actions.ts`
  opens a tab for every *standalone* terminal that has none. A terminal a
  plugin creates therefore appears as a terminal tab of that workspace with
  no app-side wiring, which makes `workspaceId` the only thing the plugin has
  to get right. Tabs are inserted with `focus: false`, and Paseo exposes no
  plugin API to focus a terminal tab, so the tab appears and the user switches
  to it.
- Plugin code reaches the SDK only through the RPC handler context
  (`context.paseo`), so every handler in `index.server.ts` captures it. The
  console is always opened right after a `console-url` RPC, and until the API
  is captured `/api/terminals` answers 503 with an explicit message instead
  of a broken launch. Because that capture alone leaves a console opened right
  after a plugin reload without an API (verified live in 0.17.9), the client
  entry pings the `remote-control.state` RPC immediately and every 10 s, so
  the server holds a fresh API whatever the UI is doing (0.17.10).
- The console carries the opener's workspace as `?workspaceId=` (added by
  `client/open-console.ts`); without it the service resolves the workspace
  only when exactly one exists, otherwise it refuses.

SSH (`server/terminals.ts` + `server/protocols/ssh.ts`): the launch runs as
`sh -c '<wrapper>'` because the create-terminal request has no `env` field.
The wrapper exports `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE`/`DISPLAY` (only the
values the launch changed), runs the shell-quoted argv, removes the run
directory (identity file + askpass helper) and exits with ssh's status.
`buildSshCommand()` and the service are covered by `tests/terminals.test.ts`.
Terminal list/kill in the console polls every 3 s: the daemon owns terminals
now, so the plugin has no state of its own to broadcast over SSE.

Removed with the browser terminal: `server/pty.ts`, `server/sessions.ts`,
`server/transport.ts`, `server/prebuilds/`, `console/src/terminal.ts`,
`console/src/transport.ts`, `shared/terminal-options.ts`, the A3 spike scripts,
`tests/transport.test.ts`, `tests/terminal-options.test.ts`, and the
`ghostty-web`, `ws`, `node-pty`, `@types/ws` and `node-gyp` dependencies.
Ghostty settings import (B1) stays: it reads and stores the system config but
no longer feeds a renderer.

## Transport (stage A3, 2026-10-25) — historical, the WebSocket bridge is gone

> Superseded by 0.17.9: the terminal transport was removed together with the
> browser terminal. Kept as the record of the A3 spike; nothing in the plugin
> uses it anymore.

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

## Web admin panel

The loopback console is now a single-page admin panel (left nav: Sessions,
Connections, Secrets, Terminal, Settings) with modal dialogs for create/edit.
Vanilla TS (no React in the console bundle) — esbuild carries everything into
`dist/console/main.js`. SSE keeps Sessions and Connections fresh.

Paseo runs `npm ci` with optional dependencies omitted, so `@lydell/node-pty`
could not load its platform binary. The plugin ships a prebuilt
`server/prebuilds/linux-x64/pty.node` and `server/pty.ts` copies it into
`node_modules/node-pty/prebuilds/linux-x64/` on first load, so no native
build step is needed. Linux-x64 only.

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
