# Plan — plugins as stdio MCP servers for any agent

Status: **the memory-flash half is implemented in plugin 0.15.1** (daemon gate, Pi
support, skill wording). The generic pieces meant for the other plugins are planned
below, not written yet. Technical detail of what exists: [`__doc.md`](./__doc.md)
§6–§7; user-facing description: [`README.md`](./README.md).

## 1. Goal

Let a Paseo plugin serve its tools to *any* agent on the machine — inside Paseo or
not — through a standard stdio MCP server, while keeping one rule that makes the
model honest to the agent:

> A plugin's stdio MCP server belongs to Paseo. It serves only while the Paseo
> daemon or desktop app is running. When Paseo is stopped it answers exactly
> `Демон Paseo недоступен, MCP недоступен` and nothing else, so an agent spends no
> time or budget discovering that on its own.

Non-goals: publishing the servers to remote machines over stdio (that is the HTTP
path, `memory-flash` §"Remote access"), and serving memory while Paseo is down.

## 2. Where the design already is

| Piece | State |
| --- | --- |
| Bundled server | `dist/mcp-server.js`, esbuild, zero runtime deps, published at the revision-independent `$PASEO_HOME/plugins/<plugin>/mcp-server.js` (`server/mcp-launch.ts`) |
| Paseo-native delivery | `agent.create.before` writes `config.mcpServers`, `agent.open.before` re-contributes on resume/refresh |
| Agent-owned delivery | per-agent config writers: Cline, Cursor, Codex CLI, OpenCode, Kilo, Kimi Code CLI — and **Pi** since 0.15.1 |
| Skill | `SKILL.md` protocol installed into every known agent skills directory (9 targets since 0.15.1) |
| Availability contract | `server/daemon-gate.ts` + `server/mcp-unavailable.ts` (0.15.1) |

## 3. The availability contract (implemented in 0.15.1)

**Liveness, in order of preference**

1. `$PASEO_HOME/plugins/memory-flash/daemon-heartbeat.json`, rewritten every 15 s by
   the plugin server (which lives inside the daemon): `{pid, updatedAt, version}`.
   Fresh = timestamp at most 60 s old and the pid still alive.
2. `$PASEO_HOME/paseo.pid` — JSON `{pid, …}` or a bare pid; a live pid is enough.
   This covers the seconds after a daemon start and hosts where the plugin data
   directory is not writable.
3. `MEMORY_FLASH_DAEMON_GATE=off` disables the gate deliberately (tests, a headless
   setup). Never a silent default.

**Behaviour when the gate is closed** (`server/mcp-unavailable.ts`)

| Request | Answer |
| --- | --- |
| `initialize` | success, `instructions` = the unavailability sentence |
| `tools/list` | the real catalogue — an empty list makes an agent silently skip memory, a refused call carries the reason |
| `tools/call` | MCP `isError` result whose text is the sentence |
| stderr | the sentence plus the gate reason (diagnostics only) |
| database | never opened — no locks, no fresh `memory.db` behind an external agent |

The sentence: `Демон Paseo недоступен, MCP недоступен (Paseo daemon unavailable — MCP
unavailable). Start Paseo … and try again … do not retry in a loop, do not diagnose
the server, and do not read or edit the memory database directly.`

**Agent-facing counterpart:** the skill has a mandatory section for this answer —
do not retry, tell the user to start Paseo in one sentence, continue without memory,
and list the skipped searches/saves/handoff in the final answer. `memory_*` is
described as a *symbiont* of whatever agent is running: use it in the work, not only
when the user mentions memory.

## 4. Remaining work, by plugin

### Phase 1 — extract the contract (memory-flash → shared module)

`memory-flash` owns the reference implementation. To reuse it in other plugins
without cross-plugin imports, move `daemon-gate.ts`, `mcp-unavailable.ts` and the
launch-config helper into a copy-paste template documented in this file (the plugins
are installed as separate repositories/directories and never share `node_modules`).

- Rename the environment switch per plugin (`<PLUGIN>_DAEMON_GATE`), and the
  heartbeat file to `$PASEO_HOME/plugins/<plugin>/daemon-heartbeat.json`, so two
  plugins do not overwrite each other's signal.
- Keep `paseo.pid` as the shared second source; one daemon serves every plugin.
- Acceptance: identical unit tests (fresh/stale heartbeat, dead/live pid, disabled
  gate) in each plugin that adopts it.

### Phase 2 — bunny-search

- Gate its bundled `mcp-server.js` the same way; its tools (`web_search`) are just as
  Paseo-bound and the same message applies.
- Agent registrations: Cline, Cursor, Codex, OpenCode, Kilo, Kimi, Pi (mirror the
  memory-flash writers; the JSON writers are already the same shape).
- Skill: add the gate section to `SKILL.md`.

### Phase 3 — obsidian-bridge

- Gate the bundled server; failure text is identical.
- The vault tools are read/write on the user's notes, so the unavailable path must
  never fall back to reading the index without Paseo.

### Phase 4 — memory-flash-client

- The client contributes **HTTP** servers owned by a remote memory host, not a stdio
  server, so the daemon gate does not apply to its transport. What is missing for
  external agents is a *registration*: Pi (and the other agents) accept streamable
  HTTP entries (`{url, headers}`), so a Pi/machine-level registration would let a
  terminal agent on this machine read the remote memory without Paseo.
- That is a feature with a credential question (the API key would live in the
  agent's own config). Decide first: reuse the existing `connections.json` secret at
  registration time (written to the agent config, protected by file mode) or a
  separate key per agent. **Not implemented in 0.8.0**; only the Pi **skill** target
  was added.
- Until then the skill states plainly that remote `memory_*` tools arrive through
  Paseo, and the gate sentence still applies to any local plugin server.

### Phase 5 — registration coverage

| Agent | Config | stdio | HTTP | State |
| --- | --- | --- | --- | --- |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | yes | yes | implemented |
| Cursor | `~/.cursor/mcp.json` | yes | — | implemented |
| Codex CLI | `~/.codex/config.toml` | yes | — | implemented |
| OpenCode | `~/.config/opencode/opencode.json[c]` | yes | — | implemented |
| Kilo | `~/.config/kilo/kilo.json[c]` | yes | — | implemented |
| Kimi Code CLI | `$KIMI_CODE_HOME/mcp.json` | yes | — | implemented |
| Pi | `$PI_CODING_AGENT_DIR/mcp.json` (`~/.pi/agent/mcp.json`) | yes | — | **implemented (0.15.1)** |
| Claude Code | `~/.claude.json` (`mcpServers`) | yes | yes | planned — file is large and shared with other state; needs a careful read-modify-write with backup |
| Qwen Code | `~/.qwen/settings.json` | — | — | planned — verify the MCP key before writing |

Skills already cover Claude Code, Qwen Code, Pi and `~/.agents/skills`; the missing
piece is the MCP registration for the two agents above.

### Phase 6 — status and repair in the UI

- The settings screen already shows per-agent path/state and re-registers on demand.
- Add a **"Paseo is stopped"** note next to the live check: a failed handshake during
  a closed gate is not a broken registration. The live probe should classify it
  (parse the `initialize` `instructions` / tool error text) instead of a red
  "live check failed".

## 5. Test matrix

| Case | Where |
| --- | --- |
| Gate: fresh heartbeat serves | `tests/daemon-gate.test.ts` |
| Gate: stale heartbeat / dead pid refuses | `tests/daemon-gate.test.ts` |
| Gate: PID fallback, `MEMORY_FLASH_DAEMON_GATE=off` | `tests/daemon-gate.test.ts` |
| Real process, gate open: save + search round-trip | `tests/mcp-server-e2e.test.ts` |
| Real process, gate closed: `initialize` instructions, `tools/call` `isError`, no DB created | `tests/mcp-server-e2e.test.ts` |
| Pi registration: default dir, `PI_CODING_AGENT_DIR`, foreign servers preserved, corrupted file refused | `tests/pi-mcp.test.ts` |
| Skill: 9 targets, Pi following `PI_CODING_AGENT_DIR`, gate sentence present | `tests/hosts-skill.test.ts` (and the client's `tests/skill.test.ts`) |

Not covered yet: a *live* run with Paseo stopped (spawn the server from Pi with the
desktop closed) — the e2e covers the protocol, not the real Pi handshake. Linux is
the target platform; macOS/Windows remain "future work" until verified.

## 6. Risks and open decisions

- **Daemon pid reuse**: `paseo.pid` can name a recycled pid. The heartbeat is the
  primary signal and expires; the pid file is only a start-up/edge fallback.
- **60 s staleness window** after an unclean daemon stop: a spawn in that window is
  served. Acceptable (the database tolerates it), and a clean shutdown removes the
  heartbeat immediately.
- **`MEMORY_FLASH_DAEMON_GATE=off`** is a deliberate escape hatch; document it, do
  not make it a default, and never set it from Paseo itself.
- **Per-plugin heartbeat names**: two plugins must not share a heartbeat file, or one
  could keep another's gate open after it stopped.
