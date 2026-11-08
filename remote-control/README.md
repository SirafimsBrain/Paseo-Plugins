# remote-control

Local-only remote control console for Paseo: groups and connections for SSH/RDP/VNC whose logins and passwords live in a pass-backed secret storage, with every session launched from the Paseo sidebar.

**Status: 1.0.0 — released, bugfix-only.** The functional scope is frozen after stages E1–E3 (FreeRDP 3 discovery, exit codes for closed windows, RD Gateway), and the plugin is in live use: new functionality is paused and only fixes ship, as `1.0.x` patches. The freeze rules are in `PLAN.md` §8 and the maintenance policy in `__doc.md`; known limitations are listed below and in `__doc.md`.

Terminals are **Paseo workspace terminals**. `remote-control` asks the daemon for one with `paseo.terminals.create()` and the app opens it as a terminal tab of that workspace — the same model Orca uses for its terminal tabs (host-owned PTY, terminal view owned by the tab). The plugin runs no PTY of its own and renders no terminal in a browser page: there is no terminal emulator code in this package.

What it does:

- **The secret storage is the foundation, opened once.** On first run the *Remote Control* sidebar panel asks you to **create the master password**; afterwards it only shows an unlock field when the storage is locked. Groups with their connections appear in the panel **only after** the storage is open, and while it stays open nothing asks for anything (auto-lock is off by default). The panel and the connection form never collect the master password — first run and unlock are the only places it is typed.
- **Connections carry their credentials.** The *New connection* / *Edit connection* dialogs in the console take group, name, protocol, host, port, login **and password** — no master-password field: the storage must already be open, otherwise the save is refused with a message pointing at the panel (before any row is written). The password goes to the storage under `connections/<id>/password`; the database and every API response stay free of values. On edit the login and settings change like any column, and the password can be replaced (empty field = keep) or cleared (`password: ""`).
- **RDP connections carry the full FreeRDP 3 option set.** Choosing *RDP* in the connection dialog shows the domain plus collapsed *Advanced (RDP)* groups — display, performance, redirection, security, RD Gateway (host, port, gateway login/domain, usage method, and a gateway password that lives in the secret storage and reaches FreeRDP on stdin as the second line after the connection password — never in argv), keyboard, network and codecs — ported from `rdp-pilot` with its defaults (new connections pre-fill them). A gateway with its own login refuses to launch until its password is stored, and a gateway without one reuses the connection credentials. The options are validated against the protocol schema before anything is stored, and a launch maps them onto argv group by group; connections created before this keep exactly their previous command line, and no option ever carries a secret.
- **VNC connections are the vnc-pilot port.** Choosing *VNC* shows the VNC field groups: viewer, display number, custom binary, view-only/fullscreen/shared, quality, compression, encoding and colour depth, the TigerVNC/TurboVNC groups and an extra-arguments line. Nine viewers are supported — TigerVNC, TurboVNC, TightVNC, RealVNC, Remmina, KRDC, Vinagre, gvncviewer and a custom binary. The viewer list is discovered on this machine: a shared `vncviewer` is identified by its version output, so TigerVNC/TurboVNC/TightVNC/RealVNC are never launched with another product's flags. Targets follow vnc-pilot (`host:display` when a display number is set, otherwise `host::port`, `vnc://host:port` for GUI clients, IPv6 in brackets), and each viewer gets only the options it really supports. A display number wins over the port; a port embedded in the host wins over the connection row.
- **Secrets cannot be managed manually.** There is no Secrets screen and no `/api/secrets` API: creating, replacing or removing a secret happens only through a connection's create/edit form; setup and unlock happen only in the panel and native surfaces (RPC). Locking is the one exception: *Lock now* in the console's Settings and the *Lock remote-control vault* Command Center item drop the cached passphrase without touching any secret (`POST /api/vault/lock`).
- **`~/.ssh/config` is managed read-modify-write, never regenerated.** The console's *ssh-config* action on an SSH row writes one `Host` block for that connection — `HostName`, `User`, `Port`, optional `IdentityFile` and `ProxyJump`, with the alias from *Advanced (SSH)* or a slug of the connection name — marked by a `# remote-control: <connection id>` comment above the `Host` line. Everything else in the file survives byte for byte: hand-written blocks, wildcard rules, `Match` blocks, unknown directives, comments. `Include`s are followed, and a block that already lives in an included file is updated there. Writes are atomic (same-directory temp file, rename, mode preserved), refuse a symlink, keep the previous file as `<config>.remote-control.bak`, and are revision-checked — a hand edit made while the console was open is reported instead of overwritten. A hand-written block that already uses the alias is **refused**, never taken over; pick another alias. *Sync all SSH connections* in Settings does the same for every SSH row.
- **Copy key to server.** The *copy key* action on an SSH row deploys a public key into the remote `authorized_keys` with ssh-copy-id semantics over the plugin's own ssh path: the connection's explicit *public key* path, else its *Identity file* + `.pub`, else the public half of the identity stored in the vault (derived with `ssh-keygen -y`), else `~/.ssh/id_{ed25519,ecdsa,rsa}.pub`. The remote command creates `~/.ssh` with `700` and `authorized_keys` with `600`, greps for the exact key line and appends only when it is absent, so repeating the action is harmless. The stored password is used through the askpass helper; without one ssh runs in `BatchMode=yes` and fails fast. The response carries the key type and its `SHA256:` fingerprint, never the private key.
- **Launch from the right sidebar panel.** The panel shows the group tree with connections: **ssh** with *Open in tab* becomes a terminal tab of the current workspace, **rdp**/**vnc** with *Open window* open their own desktop window on this machine (the RDP client is discovered per display server — `wlfreerdp3` first on Wayland, `xfreerdp3` otherwise, with `REMOTE_CONTROL_RDP_BIN` or the Settings override taking precedence — and reads the password from stdin; VNC viewers get a `vncpasswd -f` file, a temporary Remmina profile, or — without `vncpasswd` — TigerVNC/TurboVNC's `VNC_PASSWORD`; credentials never appear in `ps`). A connection with a stored password refuses to launch while the storage is locked, and the panel flips to the unlock form.
- **SSH** — the launch builds the `ssh` argv, materialises the identity file and askpass helper from the storage into a per-session run directory, and opens the session as a terminal tab running a small `/bin/sh` wrapper that exports the askpass variables, runs `ssh`, then deletes the run directory. Secrets never enter argv, the process environment of the wrapper's caller, or the console page.
- **Console** — loopback HTTP server on `127.0.0.1` with a per-instance token (`GET /health`, `/api/state`, `/api/events` SSE, `/api/settings`, `/api/sessions`, `/api/vnc/clients`, `/api/terminals`, `/api/connections`, `/api/connections/:id/{test,copy-key}`, `/api/ssh-config`, `/api/ssh-config/sync`, `/api/groups`, `/api/export`, `/api/import`, `GET /api/vault/status`, `POST /api/vault/lock`); *Open console* opens it as the central tab with all plugin settings, in the Paseo workspace browser or the external browser.
- **The Sessions view covers every kind and stays live.** One table for Paseo terminal tabs (`local`, `ssh`) and the RDP/VNC desktop windows the plugin spawned, with filters for kind, connection and free text, optional grouping by connection, per-row and bulk `kill` (select rows → *Kill selected*), and a *Surface* column. SSH/local rows say they are Paseo tabs and RDP/VNC rows say they are desktop windows; a closed window keeps its row as `exited (code)` — the launcher records the exit code — with a *remove* action instead of *kill* (a window whose death the plugin never observed shows `exited` without a code); the per-row *open* / *focus window* action states where the session lives (Paseo has no API to focus an existing tab, and a window belongs to the window manager — the plugin does not pretend otherwise). External-window changes are pushed over SSE (`event: sessions`), so kills and new windows appear immediately; daemon-owned tabs are polled every 5 s because the daemon exposes no change event for them. SSH and local rows also offer **peek**: a read-only modal with the last 200 lines of the terminal's scrollback, fetched with a single `paseo.terminals.ref(id).capture({ stripAnsi: true })` and a *Refresh* button. Nothing is typed into the terminal and no stream is subscribed — the tab and its PTY stay the daemon's. A console opened without a live Paseo API still shows the external windows with an explicit warning instead of an empty error.
- **Settings in the console** — the *Settings* view edits the console port (`0` = ephemeral; changing it restarts the listener with the debounced endpoint, so the current tab's origin stops and the console is reopened from the panel), vault auto-lock in minutes, the pass store directory (`PASSWORD_STORE_DIR`; changing it relocks the vault and points it at the new directory without a daemon restart), and explicit RDP/VNC client paths (empty = discovery; a connection's own viewer still wins). *Lock now* is there too. Everything is persisted in the plugin store and visible in `GET /api/state` together with the vault status and the resolved console endpoint.
- **Commands** — `/remote console | new | lock` in the composer, a sidebar row (terminal icon, highlights while the console screen is open) and three Command Center items: *Open remote-control console*, *New remote connection* (opens the console directly on the connection form) and *Lock remote-control vault.*
- **Vault** — password-store.org layout under `$PASEO_HOME/pass-store` with an isolated `GNUPGHOME`, unlocked once with the master password and locked on plugin cleanup or by button.
- **Export / import of connections** — the *Export* and *Import* buttons in the console's Connections view move the whole set (group tree, every connection parameter, **including stored logins and passwords**) as one JSON file: export it, carry it to another machine, import it, and the connections work immediately without hunting for credentials. An optional passphrase seals the file with AES-256-GCM (scrypt key derivation); without one the file is plain JSON. Import merges by default (matching connections are updated, nothing is duplicated) or replaces the whole set. The storage must be open to export or import secrets.
- **Service actions in the Connections view** — rows are grouped into sections per group (tree order, nested groups indent, root-level rows under "(no group)", empty groups stay visible), so it is always clear where a connection was created; every row carries its **auth column**: a proven `payload.auth` wins, otherwise RDP and VNC show `password` (the only method they support) and SSH shows `unknown` until a test proves key or password. Two actions: **duplicate** opens a prefilled copy dialog — the name continues the chain `name` → `name_copy` → `name_copy1`… (uniqueness is guaranteed by incrementing, never a name clash), the stored secrets are copied with the connection, and cancelling creates nothing; **test** probes an SSH host, first with the public key only (`BatchMode=yes`, so success means real key auth) and then with the stored password through the askpass helper, recording the outcome in the flag. A failed test never clears a proven flag; changing host/port/protocol/login resets it to `unknown`.
- **Ghostty config import** — discovery → parser → mapper → preview/apply REST for the system Ghostty config (settings are stored; they no longer feed a terminal renderer).

Requires a Paseo daemon with workspace terminals (>= 0.7.3) and Linux for the shipped tooling assumptions (FreeRDP **3** for RDP windows — `xfreerdp3`/`wlfreerdp3`, or an explicit `REMOTE_CONTROL_RDP_BIN`/Settings override; a client that reports FreeRDP 2 is refused with an explicit error rather than half-translated; one of the supported VNC viewers plus `vncpasswd` for password-file launches on VNC).

See `__doc.md` for the technical design and `PLAN.md` for the roadmap.

## Paseo 0.15.0 compatibility

Verified against the **stable Paseo 0.15.0** release (2026-11-03).
Full evidence: [`__doc.md`](./__doc.md#paseo-0150--compatibility-pass-2026-11-03).
**Compatible as-is — no deprecated API is used anywhere in this plugin, so
nothing was migrated, no code changed and the version stays `0.24.11`** (no
bump, no tag). `requirements.paseo` stays `>=0.11.0` and the dev pin stays where it is: the host
supplies the SDK at bundle and run time and no 0.15.0 API is needed.

**Deprecated in 0.15.0 and *not* used here:** `server.before(...)` /
`server.on(...)` (removal after 2027-04-30 — the plugin registers no lifecycle
hooks at all, only seven RPC handlers), `addSurface` / `addSidebarItem` /
`openSurface` (the plugin already registers `addWorkspacePanel` / `addScreen` /
`addCommandCenterItem`), `SettingsGroup`, the `client/react-native` UI entry,
the `addWorkspacePanel` `context` field (panels only *receive*
`PluginWorkspacePanelProps`; the registrations never pass `context`) and
`CreateAgentRequestOptions.git` / `worktreeName`. The SDK diff from the pinned version to 0.15.0 leaves **`dist/client/` byte-identical**, so the panel, screen, sidebar row and
Command Center item cannot have moved.

**0.15.0 works in this plugin's favour:** SSH sessions are
`paseo.terminals.create` terminals, and terminal programs now survive daemon
restarts, crashes and supported updates (the first upgrade from 0.14.0 still
closes them once), while reconnecting restores up to 10 000 lines of retained
scrollback — so an SSH tab no longer comes back empty after an app reload.
Plugin screens also keep their local state across temporary host
disconnections.

**Recommendations from that pass — outcome**
([`__doc.md`](./__doc.md#recommendations-for-improvement--outcome-stage-02611-2026-11-07)):

1. **Read-only terminal mirror** — shipped in **0.26.11** as *peek* on
   SSH/local rows (last 200 scrollback lines through a single
   `paseo.terminals.ref(id).capture({ stripAnsi: true })`; the PTY and the tab
   stay Paseo's, ADR-5).
2. **"Restart host and keep terminals"** — closed as impossible from a plugin:
   `PluginHandlerContext` only exposes `PaseoApi`, which has no
   `shutdownServer`; `paseo plugin reload` covers the need (restart the plugin,
   not the daemon). The finding is recorded instead of a button that cannot
   work.
3. **The two `as any` casts** are gone and the sidebar row is registered
   (`addSidebarHeaderItem`, `remote-control-console-row`) — both in **0.26.11**.

**Verification (0.15.0 pass):** `npm run typecheck` (both projects) exit 0 and
**14 suites / 137 tests** passed against `@getpaseo/plugin@0.15.0`; the compiled
client and server bundles contain **zero** deprecated markers (with a negative
control proving the scan works); and the plugin was installed **from the
working tree into an isolated 0.15.0 daemon** (scratch home, own loopback
port) where it reported `running`, `[remote-control] plugin ready`, all seven
RPC methods, and a working console — `GET /` 200 HTML, `/health`
`{"ok":true,…}`, `/api/state` and `/api/connections` 200 with the token (query
or `Authorization: Bearer`) and **401 without it**. The plugin has since
shipped **1.0.0** (H3, the G1–G3 console tails, the ghostty Apply fix, the
read-only *peek* and sidebar row, then stages E1–E3: FreeRDP 3 discovery, exit
codes for closed windows, RD Gateway) and is now in bugfix-only mode; the
current check is **20 suites / 223 tests**.
