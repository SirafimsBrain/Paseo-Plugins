# remote-control

Local-only remote control console for Paseo: groups and connections for SSH/RDP/VNC, a pass-backed secret vault, ghostty-based terminals and session management.

Current state (stage A3): loopback console HTTP server (`127.0.0.1`, per-instance token, `GET /health`, `/api/state`, `/api/events` SSE), WebSocket terminal bridge with an origin guard and echo mode (`/term`), the console web app with an in-page transport probe, an opener into the Paseo workspace browser, and a thin native panel.

The terminal transport decision (WebSocket, with SSE+POST as a documented stub) and its live evidence are recorded in `__doc.md` § Transport.

See `__doc.md` for the technical design and `PLAN.md` for the roadmap.