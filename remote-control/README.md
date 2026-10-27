# remote-control

Local-only remote control console for Paseo: groups and connections for SSH/RDP/VNC, a pass-backed secret vault, and workspace terminals.

Terminals are **Paseo workspace terminals**. `remote-control` asks the daemon for one with `paseo.terminals.create()` and the app opens it as a terminal tab of that workspace — the same model Orca uses for its terminal tabs (host-owned PTY, terminal view owned by the tab). The plugin runs no PTY of its own and renders no terminal in a browser page: there is no terminal emulator code in this package.

What it does:

- **Terminals** — a *New terminal* action in the console, an *Open terminal* button in the side panel and settings panel, and a workspace command in the command palette (⌘K / Ctrl+K) all create a workspace terminal, which Paseo shows as a tab. A terminal opened from the console belongs to the workspace the console was opened from (`workspaceId` query parameter).
- **SSH** — *Launch* on an ssh connection builds the `ssh` argv, materialises the identity file and askpass helper from the vault into a per-session run directory, and opens the session as a terminal tab running a small `/bin/sh` wrapper that exports the askpass variables, runs `ssh`, then deletes the run directory. Secrets never enter argv, the process environment of the wrapper's caller, or the console page.
- **Console** — loopback HTTP server on `127.0.0.1` with a per-instance token (`GET /health`, `/api/state`, `/api/events` SSE, `/api/terminals`, `/api/connections`, `/api/groups`, `/api/secrets`), opened in the Paseo workspace browser or the external browser.
- **Vault** — password-store.org layout under `$PASEO_HOME/pass-store` with an isolated `GNUPGHOME`, unlocked once with the master password and locked on plugin cleanup or by button.
- **Ghostty config import** — discovery → parser → mapper → preview/apply REST for the system Ghostty config (settings are stored; they no longer feed a terminal renderer).

Requires a Paseo daemon with workspace terminals (>= 0.7.3) and Linux for the shipped tooling assumptions.

See `__doc.md` for the technical design and `PLAN.md` for the roadmap.
