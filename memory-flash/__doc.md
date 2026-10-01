# Memory Flash — technical documentation

This file documents the internal design, verified compatibility, and the roadmap of the `memory-flash` plugin. User-facing description: [README.md](./README.md).

## 1. Purpose and scope

Memory Flash adds the missing durable shared-memory layer to Paseo: one tagged, full-text-searchable SQLite database that every coding agent connected to Paseo (Cline, OpenCode, Kilo, Qwen Code, Codex, …) reads and writes through an MCP server, plus a management surface, a skill for the agents, and a remote-host registry inside Paseo.

The design is modeled on the multi-agent memory pattern of [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) and [Beledarian/mcp-local-memory](https://github.com/Beledarian/mcp-local-memory) (tagged rows, hybrid search, agent attribution), re-implemented from scratch as a Paseo plugin with zero runtime npm dependencies (Node built-ins only).

## 2. Architecture

```
memory-flash/
├── index.server.ts            # plugin server: settings, agent.create MCP injection,
│                              # all RPC handlers, delegation prompt composition
├── index.client.tsx           # surface, sidebar item, ⌘K items, settings screen
├── shared/
│   ├── memories.ts            # zod schemas, RPC contracts (defineRpc), types
│   ├── settings.ts            # host-scoped settings definition (defineSettings)
│   └── host-fonts.ts          # host Appearance settings parsing (client-safe)
├── server/
│   ├── store.ts               # SQLite store: schema/migrations, FTS5, tags,
│   │                          # revision history, stats, purge/reset
│   ├── mcp-server.ts          # standalone stdio MCP server (JSON-RPC 2.0)
│   ├── mcp-tools.ts           # tool definitions + transport-independent dispatch
│   ├── mcp-launch.ts          # node + dist/mcp-server.js resolution (shared by
│   │                          # agent injection and direct registration)
│   ├── mcp-probe.ts           # live spawn check: MCP initialize handshake probe
│   ├── settings-file.ts       # settings.json reader for the spawned server process
│   ├── skill.ts               # SKILL.md content + multi-target installer
│   ├── agent-mcp-json.ts      # shared mcpServers JSON file handling (Cline, Cursor)
│   ├── cline-mcp.ts           # register/unregister in Cline's own MCP settings
│   ├── cursor-mcp.ts          # register/unregister in Cursor's ~/.cursor/mcp.json
│   ├── codex-mcp.ts           # register/unregister in Codex's ~/.codex/config.toml (TOML)
│   └── remote-hosts.ts        # hosts.json registry, paseo-ssh probe, stubs
├── client/
│   ├── memory-surface.tsx     # Memories / History & tasks / Remote hosts tabs
│   ├── settings-screen.tsx    # Settings → Plugins screen with skill install buttons
│   └── use-host-typography.ts # host font scale/family hook (copied from command-center)
├── scripts/
│   └── bundle-mcp-server.mjs  # esbuild → dist/mcp-server.js (standalone stdio server)
├── skill/                     # (reserved for extra skill assets; SKILL.md is generated)
└── tests/                     # vitest: 6 suites, 45 tests (incl. real-process stdio e2e)
```

### Data flow

1. **Agent → memory.** An agent process spawns `dist/mcp-server.js` as a stdio MCP server (either injected by the plugin into Paseo-created agents, or configured manually in the agent's own MCP settings). Every tool call validates through the same zod schemas and writes to `$PASEO_HOME/plugins/memory-flash/memory.db` (WAL) — SQLite file locking serializes concurrent writers from all agent processes.
2. **UI → memory.** The Paseo surface calls plugin RPCs; the plugin server holds its own `MemoryStore` handle to the same database file.
3. **UI → agent (delegation).** The surface composes a maintenance instruction, the server verifies the agent is open via `paseo.agents.list()` and sends the prompt through `paseo.agents.ref(id).send(...)`; the agent performs the edits through its MCP tools.

### Why the MCP server is a bundled separate process (not in-plugin)

Requirement 1 says the plugin runs with the Paseo server process — the plugin does. But the *MCP server* must be spawnable **by agent processes** (Cline/OpenCode/Kilo launch their own MCP subprocesses; the plugin process cannot host their stdio channels). The plugin therefore:

- registers itself with Paseo (settings, surface, hooks) in the plugin process;
- injects a stdio config pointing at `dist/mcp-server.js` into every agent it sees created;
- the injected server opens the same SQLite file the plugin process holds open.

One bundle, two consumers: the plugin process imports the store directly; agent processes run the bundle. This mirrors how mcp-memory-service is consumed (one server, many agent clients) while keeping the Paseo integration native.

### MCP protocol coverage

The stdio server implements the MCP 2024-11-05 baseline: `initialize` (protocol version, `tools` capability, `serverInfo`), `notifications/initialized`, `ping`, `tools/list`, `tools/call` (text content, `isError` flag), and `-32700/-32601` error responses. Newline-delimited JSON; stdout carries protocol messages only (logs go to stderr). Verified against a real spawn in the e2e test and manually against Paseo's own agent-MCP conventions (`/mcp/agents` route observed on the local daemon).

## 3. Storage design

### Schema (`memory.db`)

| Table | Purpose |
| --- | --- |
| `memories` | current rows: `kind`, `title`, `content`, `project`, `agent_id`, timestamps, `revision` counter |
| `memories_fts` | FTS5 external-content index over `title + content`, `tokenize='porter unicode61'`, kept in sync by AFTER INSERT/UPDATE/DELETE triggers (also correct for direct `UPDATE`s issued by future tooling) |
| `memory_tags` | normalized tags (lowercase, trimmed, deduped), PK `(memory_id, tag)`, indexed by tag |
| `memory_history` | per-revision audit trail: full row snapshot, `changed_by`, `change_kind` (`create`/`update`/`delete` tombstones) |
| `meta` | schema version marker |

- WAL journal mode + `synchronous = NORMAL`: concurrent readers (surface, many agent processes) never block on a writer.
- Deletes keep a tombstone revision before removing the row; restores of deleted rows re-create the memory.
- Per-memory history is capped (default 50, setting range 10–200) trimming oldest revisions.
- `purge` refuses to run without at least one filter (tag/project/kind); a full wipe goes through the explicit `reset()` path only.

### Kind taxonomy

`decision`, `procedure`, `handoff`, `bugfix`, `pattern`, `pitfall`, `reference`, `note` — the handoff-oriented vocabulary from the requirements, mapped 1:1 to the skill guidance ("one fact — one memory").

## 4. Paseo integration points (SDK 0.10.x)

- **`server.before("agent.create")`** — injects `config.mcpServers["memory-flash"] = { type: "stdio", command, args: [<dist/mcp-server.js>], alwaysLoad: true }` when the `injectIntoAgents` setting is on. The hook is `async` (the SDK awaits before-hooks) — it reads settings first and returns the mutated request, so the injection is guaranteed to be applied before the agent is created; a settings-read failure leaves agent creation untouched. A diagnostic line (`[memory-flash] MCP injected: <command> <args…>`) is printed to `paseo plugin logs memory-flash` on every injection. Both resolutions live in `server/mcp-launch.ts` and are shared with the Cline registration below, so every integration path launches the identical command.
- **Command resolution (`resolveNodeCommand`)** — the MCP server is spawned by the *agent* process, not the plugin host, and the plugin host binary is an Electron binary running with `ELECTRON_RUN_AS_NODE=1`, which agents do not inherit. The plugin therefore resolves a real Node.js binary: `process.execPath` when it already is `node`, then a sibling `node` binary, then a PATH scan (result is an absolute path so the agent's own PATH never matters), with plain `node` as the last resort. Verified on this machine: the injected command resolves to `~/.nvm/versions/node/v24.20.0/bin/node`.
- **Entry resolution (`resolveMcpEntry`)** — the plugin host bundles this module somewhere internal, so `__dirname` does not point at the plugin source directory (it can resolve to `$PASEO_HOME/plugins/memory-flash/`, the settings/data directory, which produced a `Connection closed` MCP error until fixed). The authoritative location of a directory plugin is `plugins.<id>.path` in `$PASEO_HOME/config.json`; `__dirname`/`import.meta.url` and `$PASEO_HOME/plugins/<id>` are fallbacks, first existing `mcp-server.js` wins.
- **`paseo-plugin.json` `build`** — optional build steps run by the daemon before the plugin loads. The schema is strict `string[][]` (each step is an argv array, `command[0]` + arguments), *not* an array of shell strings: `"build": [["npm", "run", "bundle"]]`. A flat `"build": ["npm run bundle"]` fails manifest validation (`expected array, received string` at `build[0]`) and the plugin shows as `failed`. The build step regenerates `dist/mcp-server.js` on every plugin load, so MCP-server source edits reach agents without a manual rebundle. Note: `paseo plugin reload <id>` currently errors with this same validation on the daemon side; `paseo plugin disable <id> && paseo plugin enable <id>` works as a reload.
- **`server.registerSettings`** — host-scoped settings (`injectIntoAgents`, `mcpServerName`, `defaultAgentId`, `historyPerMemory`), edited in Settings → Plugins → Memory Flash. The spawned MCP server cannot receive settings through the SDK and reads the host-written `settings.json` instead (`server/settings-file.ts` accepts both the host layout `{revision, values}` and a flat object; clamps out-of-range values).
- **`client.addSurface` / `addSidebarItem` / `addCommandCenterItem` / `addSettingsScreen`** — the management UI.
- **`paseo.agents.list()` / `agents.ref(id).send()`** — live agent picker for delegation and safe delivery (refuses archived/closed agents; readable error otherwise).
- **Host typography** — the surface and settings screen scale fonts by the host Appearance settings (`shared/host-fonts.ts`, same module as command-center) and apply the configured interface/mono font families; theme colors come from `PluginSurfaceProps.theme`, nothing hardcoded.

## 5. Skill (requirement 6)

`SKILL.md` follows the standard skills format (YAML frontmatter `name`/`description`, markdown body) observed on this machine across `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.qwen/skills`, `~/.cline/skills` and `~/.kilo/skills` — the same layout Paseo itself uses for its bundled skills.

Content covers: when to **read** (before starting a task, before fixing a bug, entering unfamiliar code), when to **write** (kind table: one fact — one memory), **mandatory recording rules** (every bugfix is saved with symptom/root cause/fix/verification — no exceptions; positive results that worked are saved as `pattern`; when functionality changes or a bugfix lands, existing memories describing the old behavior are updated via `memory_update` so the base never contradicts the code), the **English-language rule** (title, content and tags in English for cross-agent unification), **mandatory tagging rules** (project tag + topic tag, lowercase), end-of-session **handoff discipline**, and conservative **housekeeping** (prefer update over delete, list matches first, confirm scope). Installer: per-target Install/Update (re-install when content drifts, `upToDate` flag)/Remove, plus *Install into all agents*. Targets whose directory does not exist are still installable (created on demand) so the button works before the first launch of e.g. Codex.


## 6. Direct MCP registration for Cline, Cursor and Codex CLI (requirement 9)

These agents ignore stdio MCP servers delivered through an orchestrator's agent session and read them from their own global config files instead:

| Agent | Config file | Entry shape |
| ----- | ----------- | ----------- |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | `{ mcpServers: { <name>: { transport: { type, command, args } } } }` (the file its own UI manages; verified live: the ACP payload is accepted but no stdio server is ever spawned) |
| Cursor | `~/.cursor/mcp.json` | flat `{ mcpServers: { <name>: { command, args } } }` |
| Codex CLI | `~/.codex/config.toml` | TOML table `[mcp_servers.<name>]` with `command`/`args` keys |

- **JSON agents (Cline, Cursor)** share `server/agent-mcp-json.ts`: load → merge the `memory-flash` entry → atomic write (temp file + rename, same pattern as `hosts.json`). Only the entry shape differs (Cline nests under `transport`); callers provide `isEntry`/`fromEntry`/`toEntry` adapters. A corrupted (unparseable) file is never overwritten — register/unregister fail with a clear error instead.
- **Codex CLI** (`server/codex-mcp.ts`) edits the TOML as text: only the `[mcp_servers.memory-flash]` table (bare or quoted key) is replaced, everything else — other tables, keys, comments — is preserved byte-for-byte. Register appends the table when absent; unregister removes the table plus one separator blank line. This minimal parser covers flat `command`/`args` lines (single- or multi-line arrays); exotic TOML (inline tables, dotted keys inside the table) is not rewritten, only detected.
- `status()` per agent — `detected` (file or config dir exists), `installed` (entry/table present), `upToDate` (registered command/args match the current `mcpServerCommand()` from `mcp-launch.ts`, so a moved plugin directory shows as "outdated — re-register").
- `register*Mcp()` — merges the entry, preserving every other server (verified against configs that also carry `websearch`).
- `unregister*Mcp()` — removes only the `memory-flash` entry; a no-op (still `ok`) when nothing is registered.
- **Live spawn check** (`server/mcp-probe.ts`) — file status answers "is the entry present", not "does it work". The Cline status RPC additionally spawns the registered command exactly as the agent would, sends an MCP `initialize` request and waits for the JSON-RPC response (`withLiveSpawn`, 4 s budget). The Cline row in the settings screen shows a red warning when the registered command does not answer the handshake. Nothing is written to the database by the probe (the handshake alone calls no tool).
- **Register for all local agent configs** — one RPC (`memory-flash.agent-mcp-register-all`) and one settings button run all three registrations and report per-agent results, mirroring *Install into all agents* for the skill.

The settings screen shows one row per agent (path + state + live check) with Register/Re-register/Remove buttons next to the skill installers. The Cline write format was verified end-to-end against a live Cline agent: after registration Cline spawns the server as its own child process and `memory_stats` returns real JSON.


## 7. Remote hosts (requirement 8)

`hosts.json` stores connection definitions `{name, transport, host, port, user, enabled, status, lastError, checkedAt}`.

- **`paseo-ssh` (implemented)** — probes the remote through the standard Paseo CLI transport (`paseo --host ssh://[user@]host[:port] status --json`, 20 s timeout) and reports the remote memory database path (`~/.paseo/plugins/memory-flash/memory.db`). Authentication is whatever the user's SSH config provides — the same prerequisite the Paseo app itself has for remote daemons.
- **`tcp` / `relay` (stubs)** — stored and displayed, checks return `unsupported` without marking the host broken. The registry and status model are transport-agnostic so a real implementation only adds a `check*` branch (direct `ws://host:port` probe for TCP; relay pairing for Hub).

Remote hosts today provide reachability and the remote DB path; live cross-host query federation is roadmap (§10).

## 8. RPC surface

| Contract | Input | Output |
| --- | --- | --- |
| `memory-flash.list` | search options + `offset` | `{ memories, total }` |
| `memory-flash.search` | search options (query/tags/kinds/project/agent/limit) | `{ results: [{memory, score, snippet}] }` |
| `memory-flash.save` | `{ id?, input }` | `{ ok, id, error }` |
| `memory-flash.delete` | `{ id }` | `{ ok, error }` |
| `memory-flash.get` | `{ id }` | `{ memory, history }` |
| `memory-flash.restore` | `{ revisionId }` | `{ ok, id, error }` |
| `memory-flash.stats` | `{}` | totals, byKind/byAgent/byProject, topTags, dbSizeBytes |
| `memory-flash.tags` | `{}` | `{ tags: [{tag, count}] }` |
| `memory-flash.history-clear` | `{ olderThan? }` | `{ removed }` |
| `memory-flash.purge` | `{ tags?, project?, kind?, confirm:"DELETE" }` | `{ removed }` (throws without a filter) |
| `memory-flash.delegate` | `{ agentId, instruction, memoryIds? }` | `{ ok, error }` |
| `memory-flash.skill-targets` | `{}` | `{ targets }` |
| `memory-flash.skill-status` | `{}` | `{ targets: + installed, upToDate }` |
| `memory-flash.skill-install` | `{ targetId }` | `{ ok, path, error }` |
| `memory-flash.skill-uninstall` | `{ targetId }` | `{ ok, error }` |
| `memory-flash.skill-preview` | `{}` | `{ markdown }` |
| `memory-flash.cline-mcp-status` | `{}` | `{ path, detected, installed, upToDate, command, args, live }` (`live` = spawn probe result) |
| `memory-flash.cline-mcp-register` | `{}` | `{ ok, error }` |
| `memory-flash.cline-mcp-unregister` | `{}` | `{ ok, error }` |
| `memory-flash.cursor-mcp-status` / `-register` / `-unregister` | `{}` | same as Cline (no `live`) |
| `memory-flash.codex-mcp-status` / `-register` / `-unregister` | `{}` | same as Cline (no `live`) |
| `memory-flash.agent-mcp-register-all` | `{}` | `{ results: [{ agent, ok, error }] }` |
| `memory-flash.hosts` / `hosts-save` / `hosts-delete` / `hosts-check` | host CRUD | registry + probe results |

## 9. Compatibility

Verified on 2026-09-30 against Paseo `0.10.2` with `@getpaseo/plugin@0.10.1`:

- `npm run typecheck` — clean.
- `npm test` — 9 suites, 65 tests, all green, including an end-to-end test that spawns the bundled MCP server and speaks real JSON-RPC over stdio (handshake → tools/list → save → FTS search → file-on-disk assertions), dedicated registration suites for Cline, Cursor and Codex CLI (isolated `$HOME`: register/unregister/status, preservation of foreign servers and unrelated TOML content, quoted-key tables, corrupted-file refusal, stale-entry refresh) and a live-spawn probe suite (real `node -e` fake MCP server, immediate exit, timeout, missing command).
- Manual probe: `printf … | PASEO_HOME=… node dist/mcp-server.js` — `initialize`, `tools/list`, `tools/call` (save + search with snippet) all correct; tags normalized (`Paseo` → `paseo`).
- Node ≥ 24.20 required on the daemon host for built-in `node:sqlite` with FTS5 (verified FTS5 present in the runtime; porter/unicode61 tokenizer verified via search results).
- The bundle depends on nothing beyond Node built-ins, so agents' own Node runtimes can spawn it without `npm install`.
- Installed into the running daemon (`paseo plugin add` → `running`, `Plugin ready`, `npm run bundle` executed by the daemon build step). End-to-end: a real OpenCode agent created via `paseo run --provider opencode` accepted the injected MCP config (previously failed with `MCP error -32000: Connection closed` when the entry path resolved to the data directory) and the injection diagnostic confirmed the resolved entry. Plugin version 0.3.1 (0.1.x: core plugin; 0.2.0 added Cline MCP registration; 0.3.0 added Cursor + Codex CLI registration, the register-all button and the live spawn check; 0.3.1 strengthened the agent skill: mandatory bugfix recording, positive-result recording, knowledge-base updates on functionality change/bugfix, English-language rule).

### Provider verification matrix (2026-09-30, live daemon)

Each provider was verified by creating a real agent via `paseo run` and asking it to call `memory_stats`; "connected" means an `mcp-server.js` process with the agent's own process as parent was observed in `/proc`.

| Provider | Injection | MCP connected | Tool call verified | Notes |
| -------- | --------- | ------------- | ------------------ | ----- |
| OpenCode | `agent.create` hook → `opencode-agent.js` registers MCP before the first turn | yes | yes (registration error surfaced loudly pre-fix) | Fails fast with `MCP error -32000` if the entry path is wrong — this is how the `resolveMcpEntry` bug was found. |
| Qwen Code | ACP `session/new` → `toAcpMcpServers` | yes (server owned by `qwen-code/cli.js`) | yes — `mcp__memory-flash__memory_stats` returned real JSON | Qwen defers MCP tools behind `tool_search`; the model finds them on demand. Permission prompts appear via Paseo (`paseo permit allow`). |
| Kilo | ACP `session/new` | yes (server owned by `.kilo acp`) | connection only | Kilo's configured model requires sign-in (`You need to sign in to use this model`), so the model round-trip could not be completed; the MCP side is healthy. |
| Cline | ACP `session/new` — payload **accepted** but stdio server **never spawned** | via own config only | yes — after the plugin registered it in `~/.cline/data/settings/cline_mcp_settings.json` | Cline 3.0.66 validates ACP `mcpServers` (requires explicit `type`; `env` as `[{name,value}]` array) but does not connect stdio servers from the ACP session — remote http/sse only. The plugin's skill DOES work in Cline (`skills: memory-flash …`). Since 0.2.0 the plugin registers itself in Cline's own settings file via the **Register in Cline** button (`{transport:{type:"stdio",command,args}}`, other servers preserved, atomic write); Cline then spawns the server and returns real tool JSON. Registration was verified end-to-end against the live config (register → unregister → re-register, file byte-identical afterwards). |

ACP payload details (from `@getpaseo/server` `toAcpMcpServers`): stdio servers are sent as `{name, command, args, env:[{name,value}]}` **without** `type`; Cline's schema requires `type` — harmless today only because Cline ignores session stdio servers anyway.

Also verified: `paseo permit allow <agent> <req_id>` approves the MCP tool-call permission that ACP agents raise on first use.

## 10. Limitations and roadmap

Limitations:

- **One memory database per machine.** Remote hosts keep their own file; there is no replication or live federation yet (the registry and probe are the foundation).
- **No embeddings/vector search.** FTS5 (porter + unicode61) covers lexical recall well for code-adjacent memories; a vector column + local embedding model is the known upgrade path (sqlite-vec) and is deliberately deferred until a local embedding source is chosen.
- **Attribution is cooperative.** `agent_id`/`changed_by` are set from the MCP caller (or the default setting); MCP does not authenticate callers, so attribution is a convention, not an enforcement boundary.
- **Skill installation is filesystem-level.** It copies `SKILL.md` into well-known directories; agents that keep skills elsewhere need a manual path (visible in the settings screen status list).

Roadmap:

1. **Cross-host memory federation** — query fan-out to enabled `paseo-ssh` hosts over the Paseo CLI, merging results with host labels; write-through to a chosen host.
2. **Vector recall** — optional `sqlite-vec` table + local embeddings for semantic search alongside FTS5.
3. **Timeline surfacing** — post a plugin timeline item when a delegated agent finishes memory maintenance (`agent.turn_ended` hook + timeline renderer).
4. **Import/export** — JSONL export of the memory database for backup and machine migration.
5. **More transports** — real `tcp` and `relay` implementations behind the existing registry.
