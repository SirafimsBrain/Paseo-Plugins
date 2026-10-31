# remote-control — technical notes

See `PLAN.md` for the full atomic plan, decisions (ADR-1..ADR-14) and risks. This file accumulates technical details as stages land.

## Architecture invariants (checked and confirmed 2026-10-27)

Three properties the customer asked to verify and keep as a standing
contract; later stages must not change them.

1. **One plugin instance for every workspace.** The server entry
   (`index.server.ts`) runs once per plugin load and owns the only
   `VaultService`, `Store` (single DB path
   `$PASEO_HOME/plugins/remote-control/remote-control.db`, no workspace
   component in it), `TerminalService` and console endpoint. Workspace panels
   mount per workspace but all instances talk to that one server over the
   same RPCs; groups, connections and the storage state are shared. Only
   cosmetic fields (`projectRootPath`) are workspace-specific.
2. **An SSH session tab opens in the workspace active at click time, never
   in another one, and lives until the user closes it or the console kills
   it.** Every launch path derives `workspaceId` from the UI element that was
   clicked, and that element belongs to the active workspace: an Explorer
   panel is interactive only when its own workspace is focused
   (`pane-context.tsx`: interactivity = workspace-focused ∧ pane-focused),
   and a console tab lives in the browser tab of the workspace that opened
   it (`?workspaceId=` opener). The plugin never re-targets or closes an
   existing terminal; tabs are inserted by Paseo's `addMissingEntityTabs`
   with `focus: false` and stay there. Destruction paths: the user closes
   the tab (Paseo confirms and stops the process — discussion #6389), or the
   console's Terminals view kills it; plugin reload (`dispose()`) removes run
   directories but never kills terminals. An externally opened console has
   no `workspaceId`: with several workspaces a launch refuses explicitly
   instead of picking a workspace, so a session can never "jump".
3. **No limit on concurrent sessions.** Every "Open in tab" press is its own
   `remote-control.connections.launch` RPC → a fresh `paseo.terminals.create`
   with a new per-terminal run directory; there is no pool, reuse or cap in
   the plugin (the only guard is the per-row `busyId` disabling the button
   while its own request is in flight). N presses → N independent terminal
   tabs, each killed independently.

Evidence gaps to keep in mind: the exact Paseo close-X → `killTerminal`
call site and the full `addMissingEntityTabs()` body were not read directly
in v0.13.0 sources (verified via the terminal-close discussion and the
`reconcileWorkspaceTabs` input path); the multi-session claim was verified
code-wise, not by spawning live sessions.

## VNC, external sessions and the Sessions view (stage 0.23.10, 2026-10-31)

Three customer requests landed together, because they share one lifecycle: the
VNC launcher ported from vnc-pilot, the tracking of the desktop windows the
plugin spawns, and the console view that shows those windows next to Paseo
terminals.

### VNC fields (`shared/vnc-fields.ts`, `shared/protocols.ts`)

- `shared/vnc-fields.ts` is dependency-free (no zod) so the console bundle and
  the schema import the same tables: client ids/labels in vnc-pilot's discovery
  order, the quality/compress/encoding/color-depth choices, and
  `VNC_PAYLOAD_DEFAULTS` (`shared: true`, `colorDepth: "24"`,
  `acceptClipboard: true`, `sendClipboard: true`, `turbovncLocal: true`).
- `vncPayloadSchema` is a loose zod object: `vncClient` (enum, **no "auto"
  value** — an absent value means "first installed client", which is what old
  rows get), `customBinary`, `display`, the shared/view flags, the four
  quality selects, the TigerVNC/TurboVNC groups, and `extraArgs`
  (`string[] | string`: the array is the RDP/legacy form, the string is
  vnc-pilot's shell-like form). Unknown keys (`payload.auth`, import extras)
  pass through.
- The console modal builds both payload sections (`rdpForm` and `vncForm`) and
  shows only the selected protocol's section; submit sends `payload` for RDP
  and VNC, nothing for SSH. VNC keys at their Auto/empty value are dropped, as
  in the RDP form.
- The client select is filled from `GET /api/vnc/clients`: a stored client that
  is no longer installed stays visible as `"<id> (not installed)"` so editing
  never silently switches the viewer.

### Discovery (`server/protocols/discovery.ts`, `server/protocols/vnc.ts`)

- `findExecutable(names, pathEnv)` walks PATH in order and returns the first
  executable match; `isExecutable` is shared with the custom-binary path.
- `discoverVncClients` tries the nine viewers in preference order (TigerVNC,
  TurboVNC, TightVNC, RealVNC, Remmina, KRDC, Vinagre, gvncviewer, Custom).
- `vncviewer` is shared by four products, so a **bare shared binary must be
  fingerprinted** by its `--version`/`-version`/`-help`/`-v` output; an
  un-fingerprinted `vncviewer` is refused rather than launched with another
  product's flags. Dedicated names (`remmina`, `krdc`, …) are accepted even
  when the probe prints nothing.
- Results are cached process-wide for 30 s keyed by PATH
  (`resetVncDiscoveryCache()` for tests and a fresh-install refresh).
- `resolveVncClient` precedence: `customBinary` > explicit `vncClient` > first
  discovered. A missing viewer produces an actionable error listing the
  supported clients and the custom-binary escape hatch.

### Target formatting

`splitHostPort` is IPv6-aware; `formatVncHost` brackets IPv6 literals.

| Source | Target |
|---|---|
| `display: 1` (any port source ignored) | `host:1` (port 5901) |
| `host: "h:5905"` | `h::5905` (embedded port wins over the row's port) |
| `port: 5901` | `host::5901` |
| nothing | `host::5900` |
| GUI clients | `vnc://host:port` |

The embedded port is stripped from the bare host before formatting: vnc-pilot
emits `host:5901::5901` for a host that already carries the port, which is a
reference bug we do not copy.

### Per-viewer argv (`buildVncClientArgs`)

- **TigerVNC/TurboVNC:** `-ViewOnly`, `-FullScreen`, `-Shared`/`-Shared=0`,
  `-PreferredEncoding` (Tiger) / `-Encoding` (Turbo), `-QualityLevel`
  (Tiger) / `-Quality q*10+5` (Turbo's 1–100), `-CompressLevel`, colour
  mapping (`-LowColorLevel 2` / `-FullColor` for Tiger, `-Colors` for Turbo),
  `-geometry`/`-DesktopSize`, `-via`, clipboard flags, Turbo `-JPEG=1` and
  `-LocalCursor`, extra args, then `-passwd <file>`.
- **TightVNC:** `-viewonly`, `-fullscreen`, `-shared`/`-noshared`,
  `-encodings`, `-quality`, `-compresslevel`, `-bgr233`/`-truecolour`,
  extra args, `-passwd`.
- **RealVNC:** `-ViewOnly`, `-FullScreen`, `-Shared`, `-PreferredEncoding`
  (Tight is not a RealVNC encoding and is skipped), `-via`, extra args,
  `-passwd`.
- **Remmina:** `--connect <temporary .remmina profile>`; without a password a
  profile is still not needed and `-c vnc://host:port` is used.
- **KRDC / Vinagre:** `vnc://` URI, `-f` / `--fullscreen`, extra args.
- **gvncviewer / Custom:** `host::port`, extra args, `-passwd` for Custom.
- Options a viewer does not support are omitted, never guessed.

### Password material

- VNC challenge/response only uses the first 8 characters:
  `truncateVncPassword` mirrors `vncpasswd`'s own truncation.
- TigerVNC/TurboVNC/TightVNC/RealVNC/Custom: `vncpasswd -f` receives the
  password on stdin and its output is written as `vnc.passwd` mode 0600 in a
  per-launch `$PASEO_HOME/run/ext_<uuid>/` directory; the run directory is
  removed when the window exits and on plugin dispose.
- Remmina: the password goes into the temporary `.remmina` profile (0600,
  same run directory), because Remmina reads it from there.
- Only TigerVNC/TurboVNC fall back to `VNC_PASSWORD` (plus `VNC_USERNAME`)
  when `vncpasswd` is missing; the other viewers prompt for themselves. A
  failed `vncpasswd` logs a warning and falls back the same way. The secret
  never enters argv.

### External session registry (`server/sessions.ts`)

- RDP and VNC windows are detached desktop processes, so the plugin keeps an
  in-memory registry: `register` after a successful spawn, `list` (prunes dead
  pids and removes their run directories), `get`, `kill` (SIGTERM to the
  detached process group, then removes the run directory) and `dispose`
  (removes run directories on plugin reload but leaves windows running, just
  as it leaves Paseo terminals alone).
- Liveness probe, signal delivery and cleanup are injectable for tests.
- `launchExternalWindow` returns `sessionId` in addition to pid/binary and the
  RPC launch result carries it (`shared/rpc.ts`).

### Console API and view

- `GET /api/sessions[?workspaceId=]` merges the external windows (kind `rdp` /
  `vnc`, target `host:port`) with Paseo terminals (kind `ssh`/`local`, target
  their cwd) into one list.
- `POST /api/sessions/:id/kill` dispatches by registry first, then to the
  terminal service. The legacy `/api/terminals` and
  `/api/terminals/:id/kill` routes stay for compatibility.
- The console's left menu is **Sessions / Connections / Settings**; the
  Sessions table shows ID, Name, Kind, Target, Started and a `kill` action for
  every row, and polls every 3 s.
- The Connections Auth column now reflects the protocol's actual method:
  a proven `payload.auth` wins, otherwise RDP and VNC show `password` (the only
  method they support) and SSH shows `unknown` until a test proves key or
  password.

### Tests

`tests/vnc.test.ts` (targets, validation, extra-arg splitting, discovery and
fingerprinting, per-viewer argv, passwd file permissions/truncation),
`tests/sessions.test.ts` (registry lifecycle) and
`tests/sessions-http.test.ts` (merged list, kill dispatch, legacy routes).
`tests/external-launch.test.ts` now uses a fake `vncviewer` that answers the
version fingerprint before recording the real launch argv.

### Not done in this stage

- No live VNC launch: no viewer is installed on the development machine, so
  coverage comes from fake binaries. The "focus window" hint, filters and bulk
  actions of the original G1 idea remain out of scope.
- Reconnect for external windows is not implemented; a killed window is
  relaunched from the panel.

## RDP connection creation (stage 0.22.10, 2026-10-30)

Creating an RDP connection is now a first-class form: the protocol select in
the connection modal shows the full FreeRDP 3 option set (ported from
rdp-pilot), the server validates every payload against its protocol schema
before anything is written, and a launch turns that payload into argv.

### Payload schema (`shared/protocols.ts` + `shared/rdp-fields.ts`)

- `rdpPayloadSchema` is a **loose** zod object: it type-checks the fields
  the plugin owns and preserves unknown keys — `payload.auth` (written by
  the connection test) and keys from imported backups must survive a save.
  The `ssh`/`vnc` schemas are loose for the same reason.
- Choice tables (`RDP_BPP`, `RDP_SEC`, … plus the human labels in
  `RDP_CHOICES`) live in the dependency-free `shared/rdp-fields.ts`: the
  console bundle imports it directly (zod stays out of the browser bundle)
  and the schema derives its enums from the same arrays, so form and
  validation cannot drift apart.
- An empty choice ("Automatic"/"Default") is **not** a value — the key is
  dropped and FreeRDP decides.
- `validatePayload(protocol, payload)` is the single entry point used by
  `POST /api/connections` and `PATCH /api/connections/:id`: a rejected
  payload is a 400 naming the offending field, and on POST it throws
  **before** any vault write, so a rejected create stores nothing.

### Form (`console/src/main.ts`)

Domain stays visible; everything else collapses behind "Advanced (RDP)"
with rdp-pilot's group titles (Display, Performance, Redirection, Security,
Keyboard, Network, Codecs) so the modal stays laconic. New connections
pre-fill `RDP_PAYLOAD_DEFAULTS` (rdp-pilot's FieldSpec defaults, resolution
1280×720); edit/duplicate pre-fill the stored payload. Controls register
their payload key at build time: `read()` starts from the stored payload
(so keys the form does not manage pass through) and overwrites or deletes
by control state. Switching the protocol away hides the section and the
submit handler then sends no `payload` at all.

### argv (`server/protocols/external.ts`)

`buildRdpArgs()` is the FreeRDP 3 port of rdp-pilot's `build_spawn()`:
target → title → domain → display → performance → redirection → security →
keyboard → network → codecs → `extraArgs` last.

- `/t:` carries the connection name (identifiable windows), `/v:` brackets
  IPv6 literals.
- **Absent key → absent option.** A legacy row with an empty payload builds
  exactly the argv it built before this stage; defaults materialize only
  once the form has saved them.
- Secrets still never enter argv: the user password travels via
  `/from-stdin:force`.
- `/cert:ignore` remains the detached default (nobody can answer FreeRDP's
  prompt); `payload.cert` overrides it, `certIgnore: false` opts out
  explicitly, `certName` adds `/cert:name:` after it.
- `/kbd:layout:…,type:…` is one compound option; its values pass through
  `rdpCsvValue()` — quoting only for FreeRDP's comma-separated sub-option
  parser, never for plain scalar options.

### Deliberately not in this stage

- **RD Gateway** (`/gateway:g:,u:,d:,p:`): rdp-pilot puts the gateway
  password into argv, which our contract forbids, and FreeRDP 3 has no
  stdin path for it. The whole group is deferred until a safe mechanism is
  chosen — half support would hang a detached window on a prompt.
- Binary discovery (`wlfreerdp3`, `REMOTE_CONTROL_RDP_BIN` override) stays
  stage E1; the launcher keeps its plain PATH search.
- The console still shows no Launch button for RDP rows (unchanged): RDP
  launches come from the sidebar panel (stage 0.18.10).

### Tests

`tests/rdp-create.test.ts`: schema acceptance and rejection (field named),
unknown-key preservation, the full argv etalon in rdp-pilot's group order,
legacy-row argv stability, IPv6 bracketing, CSV quoting, `/audio-mode:2`, a
grep test proving no FreeRDP 2 conversion branch exists, and REST POST/PATCH
rejection that stores nothing.

## Service layer: grouped duplicates and the connection test (stage 0.21.10, 2026-10-28)

Three service functions the customer ordered before the key-copy stage: the
Connections view split by groups, a duplicate action, and a connection test
that learns **how** a host actually accepts logins.

### Grouped view

Sections per group in tree order (nested groups indent), root-level
connections under "(no group)", empty groups remain on screen. Every row
carries an **Auth** column with the flag described below.

### Duplicate

- **UI:** the `duplicate` button opens the create dialog prefilled with the
  source's fields and the next free copy name; **Cancel creates nothing** —
  the copy only comes into existence on Save, which POSTs with
  `duplicateOf`. The modal shows the name the server would compute anyway.
- **Names** (`shared/naming.ts`, `nextCopyName`, used by console and
  server): strip a trailing `_copy(\d*)`, then
  `name` → `name_copy` → `name_copy1` → `name_copy2` … — uniqueness comes
  from incrementing, so the user never meets a "name already exists" error.
- **Server:** `POST /api/connections { duplicateOf }` — fields omitted from
  the body fall back to the source (group, protocol, host, port, login,
  payload including the auth flag); **every stored secret of the source is
  re-encrypted under `connections/<newId>/…`**, which requires an open
  storage (otherwise 400 with panel guidance, as with password writes); a
  password present in the body replaces the copied one. Unknown source → 404.

### Connection test and the auth flag

- `POST /api/connections/:id/test` (ssh only, else 400). Attempt 1: **public
  key only** — `BatchMode=yes`, no askpass variables in the env, so exit 0
  can only mean key auth. Attempt 2 (only when a password is stored): the
  stored password through the askpass helper, `NumberOfPasswordPrompts=1`.
  Both attempts use `ConnectTimeout=6` with a hard kill after ~12s.
- `StrictHostKeyChecking=accept-new` is added unless the payload pins its own
  value: a first contact must not fail the probe outright (same
  trust-on-first-use a human would accept interactively).
- **Flag:** `payload.auth` = `key` | `password`; the default is *unknown*
  (absent). Priority is encoded in the value — `key` is the preferred method,
  `password` the fallback. A **failed** probe never clears a known flag: a
  network blip must not erase a proven method. The future key-copy stage
  flips the flag to `key` on success.
- Editing host/port/protocol/login resets the flag to `unknown` (different
  target, old fact no longer applies); renames keep it; a duplicate copies it.
- The probe is injectable (`sshProbe` option on `ConsoleHttpServer`), so the
  route contract is tested without a live host; the real probe gets a
  closed-port run in the test suite.

Acceptance: `npm run typecheck` + 94/94 vitest (13 new in
`tests/connections-service.test.ts`).

## Export / import of connections with secrets (stage 0.20.10, 2026-10-28)

One JSON file carries the complete set — group tree, every connection
parameter (protocol, host, port, login, payload) **and the stored
passwords/keys** — so it can be moved to another machine and imported there
with working connections, without re-entering credentials (the customer's
reference is sshpilot's backup archive). Implementation:
`server/transfer.ts`, routes `POST /api/export` and `POST /api/import`,
console *Export* / *Import* buttons in the Connections view.

### Bundle format

```jsonc
{
  "format": "remote-control-export",
  "version": 1,
  "exportedAt": "2026-10-28T…",
  "pluginVersion": "0.20.10",
  "groups": [{ "id", "parentId", "name", "sortOrder" }],
  "connections": [{
    "id", "groupId", "name", "protocol", "host", "port", "username",
    "payload": { /* protocol fields, secret-ref keys stripped */ },
    "sortOrder",
    "secrets": { "password": "…", "identity": "…" }  // plaintext values
  }]
}
```

- **Secrets in the file are values, not vault paths.** Export resolves
  `secretRefs.passwordSecret` / `identitySecret` (and legacy `password` /
  `identity`) through the vault and writes semantic keys; vault-internal
  names like `connections/<id>/password` are never written to the file, and
  secret-ref keys are stripped from the exported payload — they are local
  paths, meaningless elsewhere. A dangling reference (entry deleted by hand)
  is skipped rather than failing the export.
- **Encryption is optional but symmetric.** With a passphrase the plaintext
  bundle is sealed: AES-256-GCM, key = `scrypt(passphrase, salt, N=16384,
  r=8, p=1)`, fresh 16-byte salt + 12-byte IV per export, auth tag kept.
  The envelope (`{ encrypted: true, encryption, data, tag }`) opens only
  with the same passphrase (`wrong passphrase for this export file`), and
  `openBundle` auto-detects envelope vs plain JSON. Without a passphrase the
  file is plain JSON — the download itself never round-trips a page field.
- **A closed storage gates export only when there is something to resolve.**
  Connections with secrets → the same panel-pointing errors as saving a
  connection ("not initialized…" / "vault is locked… to export passwords");
  a store without secrets exports fine while locked.
- **Format version is checked before anything else** — a future `version: 2`
  file fails with "this export file uses format version 2; this plugin
  understands 1", not a schema dump.

### Import semantics- **`mode: "merge"` (default):** groups are resolved parents-first and a
  group with the same name under the same resolved parent is reused; a
  connection matches on protocol+host+port+username+name — a match is updated
  in place (id kept), anything else is created with a fresh `conn_*` id.
  Re-importing the same file is therefore idempotent, not duplicating.
- **`mode: "replace"`:** every stored secret under `connections/` is
  deleted, then `store.purge()` wipes all groups and connections, then the
  bundle is applied as a pure create (result equals the file).
- **Secrets are re-written under the target ids:** each value goes to
  `connections/<new id>/<semantic>` in the *target* machine's vault and the
  row gets the matching `secretRefs` — the import needs the target storage
  open (`requireOpenVault`), never its master password. A previous secret at
  the same ref field is deleted to avoid orphans.
- **Safety rails:** a cyclic group hierarchy in a hand-edited file throws
  ("cyclic group hierarchy") instead of recursing; non-JSON, foreign format
  and malformed envelopes are rejected with readable errors; import runs
  group-by-group, and connection payloads are plain data (secret-ref keys
  stripped again on import).

### Contract

```text
POST /api/export          { passphrase? } → 200, Content-Disposition:
                           attachment; filename="remote-control-export-<date>.json",
                           body = bundle file (plain or sealed JSON)
POST /api/import          { file, mode?: "merge"|"replace", passphrase? }
                           → 200 { ok, mode,
                             groups: {created, reused},
                             connections: {created, updated}, passwords }
```

Both routes require the console token; both are refused (400) with the
panel-pointing message when secrets are involved and the storage is closed.

### Next stage preview: `~/.ssh/config` management and public-key copy

The customer announced the following stage: manage `~/.ssh/config` and copy
an SSH public key to a remote host, both modeled on sshpilot. Research facts
(pinned to sshpilot `c947f207`):

- **ssh config is the source of truth** in sshpilot: the daemon parses the
  root config following `Include`s and watches for external changes;
  `src/sshpilot/core/connections/ssh_config_loader.py` maps `host`,
  `hostname`, `port`, `user`, `identityfile`, `proxycommand`, `proxyjump`,
  forwarding rules; wildcard/negated `Host` tokens and `Match` blocks are
  rules, not connectable entries. Writes go through
  `ssh_config_store.py::SshConfigStore.replace_text()` — atomic replacement
  (same-dir temp file, backup, mode preservation, symlink refusal, revision
  check). Unknown directives are preserved in `extra_ssh_config`, so
  hand-written entries survive edits.
- **"Copy Key to Server"** deploys an existing or freshly generated key
  into the remote `authorized_keys` (wiki: Key Management); it may prompt
  for the server password during deployment. The exact transport (binary
  `ssh-copy-id` vs piping over `ssh`) was **not verified** in the sources —
  decide at stage time, `ssh-copy-id` semantics over the plugin's own ssh
  launch path is the natural fit here.

Design consequence for the stage: parse-and-preserve (never regenerate) the
user's config, atomic writes with backup, and key deployment reusing the
existing vault credentials — details go into the PLAN stage when it starts.

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
