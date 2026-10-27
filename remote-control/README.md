# remote-control

Local-only remote control console for Paseo: groups and connections for SSH/RDP/VNC whose logins and passwords live in a pass-backed secret vault, with every session launched from the Paseo sidebar.

Terminals are **Paseo workspace terminals**. `remote-control` asks the daemon for one with `paseo.terminals.create()` and the app opens it as a terminal tab of that workspace — the same model Orca uses for its terminal tabs (host-owned PTY, terminal view owned by the tab). The plugin runs no PTY of its own and renders no terminal in a browser page: there is no terminal emulator code in this package.

What it does:

- **Connections carry their credentials.** The *New connection* / *Edit connection* dialogs in the console take the group, name, protocol, host, port, login **and password**. The password is written to the local vault and the connection row only holds the secret name (`connections/<id>/password`) — the database and every API response stay free of values. On edit, the login and settings change like any column, and the password can be replaced or cleared; the master password is asked for only when the vault is locked or not yet set up.
- **Launch from the right sidebar panel.** The *Remote Control* panel lists the connections and opens them: **ssh** with *Open in tab* becomes a terminal tab of the current workspace, **rdp**/**vnc** with *Open window* open their own desktop window on this machine (`xfreerdp3`/`xfreerdp` reads the password from stdin, `vncviewer` gets a `vncpasswd -f` file — credentials never appear in `ps`). A connection with a stored password refuses to launch while the vault is locked, with an explicit message.
- **SSH** — the launch builds the `ssh` argv, materialises the identity file and askpass helper from the vault into a per-session run directory, and opens the session as a terminal tab running a small `/bin/sh` wrapper that exports the askpass variables, runs `ssh`, then deletes the run directory. Secrets never enter argv, the process environment of the wrapper's caller, or the console page.
- **Console** — loopback HTTP server on `127.0.0.1` with a per-instance token (`GET /health`, `/api/state`, `/api/events` SSE, `/api/terminals`, `/api/connections`, `/api/groups`, `/api/secrets`), opened in the Paseo workspace browser or the external browser. The Terminals view lists and kills workspace terminals; a bare "new terminal" action is deliberately gone — opening a terminal means opening an SSH session.
- **Vault** — password-store.org layout under `$PASEO_HOME/pass-store` with an isolated `GNUPGHOME`, unlocked once with the master password and locked on plugin cleanup or by button.
- **Ghostty config import** — discovery → parser → mapper → preview/apply REST for the system Ghostty config (settings are stored; they no longer feed a terminal renderer).

Requires a Paseo daemon with workspace terminals (>= 0.7.3) and Linux for the shipped tooling assumptions (`xfreerdp3`/`xfreerdp` for RDP windows, TigerVNC's `vncviewer` for VNC windows).

See `__doc.md` for the technical design and `PLAN.md` for the roadmap.
