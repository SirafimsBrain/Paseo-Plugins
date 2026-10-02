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
│   ├── knowledge-transfer.ts  # export/backup/import: VACUUM INTO snapshot and
│   │                          # raw-file-copy images, .mfkb/.mfb container,
│   │                          # zstd/gzip/brotli streaming, merge/replace/restore
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
└── tests/                     # vitest: 9 suites, 74 tests (incl. real-process stdio e2e)
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
- The schema version lives in `meta.schema_version` (currently `2`). Version 2 (0.3.2) backfills the project name into `memory_tags` for pre-existing rows (`INSERT OR IGNORE … SELECT id, substr(lower(trim(project)),1,64)`), so both access paths — the `project` column filter and the tag index — find the same memories. `create()`/`update()` derive the project tag through `effectiveTags()` from the start.
- Deletes keep a tombstone revision before removing the row; restores of deleted rows re-create the memory.
- Per-memory history is capped (default 50, setting range 10–200) trimming oldest revisions.
- `purge` refuses to run without at least one filter (tag/project/kind); a full wipe goes through the explicit `reset()` path only.

### Concurrency: parallel agent writers (fixed in 0.3.2)

WAL allows many readers but still only one writer at a time, and every agent process shares the file. Before 0.3.2 the database was opened with a zero busy timeout, so ordinary write contention between parallel agent workers surfaced as `database is locked` and the write was lost — measured: 10 concurrent writer processes, 8/10 succeeded (2 failed), and a 4-writer × 200-write soak lost ~32 % of all writes. The store now:

- opens the database with a 5 s busy timeout (both the `DatabaseSync` `timeout` option and `PRAGMA busy_timeout`), which waits out ordinary contention;
- runs every write operation (`create`/`update`/`delete`/`reset`) inside `withWriteRetry()`: a transient `database is locked` error is retried up to 3 attempts with exponential backoff (25 ms → 50 ms) before it surfaces to the caller as a readable MCP error (`isError` response / `{ok:false,error}` RPC).

Re-measured after the fix: 10/10 concurrent writer processes succeed, 10/10 rows land; the soak loses zero writes.

### Search semantics (rewritten in 0.3.2)

`search()` splits the raw query with `parseQuery()` and composes three layers (text AND filters):

1. **`key=value` pairs** — `project=`, `kind=`/`kinds=`, `tag=`/`tags=`, `agent=`/`agentid=`/`agent_id=` become structured filters and are removed from the text; values may be quoted. Unknown pairs (e.g. `severity=high`) contribute *both sides* as search terms instead of gluing into one token (the old code produced `severityhigh`, which could never match).
2. **Free text → `ftsQuery()`** — quoted phrases are kept verbatim; single terms are OR-joined (bm25 ranks the best matches first) after dropping ~120 English stop words and tokens shorter than two characters. Before 0.3.2 every token was AND-ed including function words, so a natural-language query like "the bug where login fails" matched nothing; it now returns the relevant memory. When nothing indexable remains (stop words/punctuation only), the search falls back to a `LIKE` scan of title and content.
3. **No free text** (empty query or pure `key=value` filters) — a plain structured listing ordered by `updated_at DESC`.

Structured filters from the query compose with the explicit `options` filters (deduplicated, `options` winning for `project`/`agentId`).

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

Remote hosts today provide reachability and the remote DB path; live cross-host query federation is roadmap (§12).

## 8. Export, import and backup of the knowledge base

**Status: design only.** The mechanics below were verified experimentally on this host against generated databases (20 000 memories for export, 30 000 memories with 60 % deleted for backup); the measured numbers are quoted inline. No code is wired up yet, so the plugin version is unchanged.

Purpose: move the shared memory from one machine to another (daemon reinstall, laptop → workstation, team hand-over), and keep restorable backups of the live file.

Three paths, one archive container:

| Path | Reads | Produces | Restorable as | Use |
| --- | --- | --- | --- | --- |
| **Export** | live DB via `VACUUM INTO` | logical snapshot archive | **merge** (safe) or replace | moving the knowledge base between machines |
| **Import** | archive | rows merged into the live DB | — | consuming an export, or merging a colleague's base |
| **Backup** | live DB via checkpoint + raw file copy | raw-image archive | **replace** only | fast local/off-machine safety copy of the exact file |

The distinction is deliberate: an export is a *logical* artifact (small, portable across plugin versions, mergeable), a backup is a *physical* artifact (byte-identical image of the file, cheap to take, restorable only as a whole and only on the same schema).

### 8.1 Representations

| Representation | What it is | Use |
| --- | --- | --- |
| **Snapshot DB** (transient) | `VACUUM INTO '<tmp>'` → a defragmented, sidecar-free, transactional copy of the live database | payload of an export |
| **Raw image** (transient) | `PRAGMA wal_checkpoint(TRUNCATE)` then `copyFileSync(memory.db, tmp)` → byte-identical image, freelist and all | payload of a backup |
| **Archive** (on disk) | header + manifest + compressed payload, `.mfkb` for export, `.mfb` for backup | what the user copies to another machine or files away |

`VACUUM INTO` is the right primitive for an export (verified): the output is a consistent snapshot taken inside a single transaction, deleted content is purged, no sidecar files exist afterwards. The temporary snapshot is written to the OS temp directory (never next to the live DB) and removed in a `finally` block. Interruption during `VACUUM INTO` can leave an incomplete temp file — harmless, since the live DB is untouched and the temp path is per-run.

For a backup the file itself is the unit, so the image is copied directly. The one non-obvious prerequisite is the checkpoint: **a naive copy of `memory.db` alone silently loses committed rows.** Verified on a database with `wal_autocheckpoint=0`: after committing 2 more rows (8 KiB of WAL), `copyFileSync` of the main file alone produced an image containing only the pre-WAL rows; copying `memory.db-wal` next to it recovered all of them. The backup flow therefore *always* checkpoints first and never copies sidecars — after a successful `TRUNCATE` checkpoint the WAL is empty and the main file is self-contained.

Import never runs an archive through `VACUUM INTO`; it decompresses to a temp file, opens it read-only, and reads from it.

### 8.2 Archive container format

Node has no tar/zip writer in the plugin's dependency budget (the plugin ships **zero runtime npm dependencies**, Node built-ins only), and brotli has no magic bytes at all, so format detection on import cannot rely on sniffing alone. The container is therefore a purpose-built single file:

```
offset  size  field
0       8     magic "MFKB1\0\0"   (export)  |  "MFBK1\0\0" (backup)
8       4     uint32 LE  headerLength
12      H     headerLength bytes of UTF-8 JSON manifest
12+H    …     compressed payload (raw zstd / gzip / brotli frame stream)
```

Two magics, one container: a backup is a raw image, an export is a logical snapshot, and mixing them up is the one mistake that loses data (merging a raw image would import freelist garbage; restoring an export as if it were a backup would silently lose freelist reuse, which is harmless but changes the physical layout). The reader validates the magic against the requested operation.

Manifest (JSON, forward-compatible — unknown keys are ignored by older readers):

```json
{
  "format": "memory-flash/knowledge-base",
  "formatVersion": 1,
  "variant": "snapshot",
  "createdAt": "2026-10-01T15:48:02.399Z",
  "pluginVersion": "0.4.0",
  "schemaVersion": "1",
  "codec": "zstd",
  "compressionLevel": 9,
  "uncompressedBytes": 29853696,
  "payloadSha256": "abf88437…",
  "counts": { "memories": 20000, "tags": 60000, "history": 20000 },
  "sourceHost": "workstation",
  "includes": ["memories", "memory_tags", "memory_history", "meta"]
}
```

For a backup, `variant` is `"raw-image"`, `includes` is omitted, and the manifest carries the extra fields `pageSize`, `sqliteVersion` and `checkpointedAt` (the backup is only self-contained because the checkpoint succeeded, so the timestamp of that checkpoint is recorded).

Design notes:

- **Single file, no tar.** One payload = one archive keeps the reader trivial (read header → stream the rest) and stream-friendly for multi-gigabyte databases. If settings/hosts ever need to travel with it, they become extra entries in `includes` and, if needed, a second payload block with its own length prefix.
- **`payloadSha256` is mandatory** and computed over the *uncompressed* payload while it is streamed, so corruption is detected before a single row is written into the live database. Import refuses a mismatch; restore refuses too.
- **`meta` rows `export_manifest` / `schema_version` are preserved** in exports, so an extracted snapshot is self-describing even when unpacked by hand (`zstd -d` + `sqlite3`). A backup carries no manifest row — it is a raw image and must not be modified.
- **Format sniffing on import**: `.mfkb` / `.mfb` → container; otherwise fall back to detecting gzip (`1f 8b`), zstd (`28 b5 2f fd`) or a raw SQLite header (`SQLite format 3`) so a hand-made archive or a plain `memory.db` still imports.

### 8.3 Three compression levels (user choice)

Both export and backup offer the **same three presets** — the choice is size vs. time and nothing else changes. All three keep the same decoder requirement (Node ≥ 22.15 has `node:zlib` zstd; the plugin already requires Node ≥ 24.20 for `node:sqlite`).

| Preset | Level | Export payload (28.5 MiB snapshot) | Backup payload (13.3 MiB raw image) | When to pick it |
| --- | --- | --- | --- | --- |
| **Fast** | `zstd -3` | **1.25 MiB** (23×), 49 ms | **0.42 MiB** (32×), 43 ms | default; interactive runs, big bases on slow disks |
| **Balanced** | `zstd -9` | **1.15 MiB** (25×), 229 ms | **0.38 MiB** (35×) | recommended default for backups and archives |
| **Maximum** | `zstd -19` | **1.01 MiB** (28×), 18.1 s | **0.36 MiB** (37×) | archival, transferring over a metered link |

Numbers measured on this host (Node 24.20.0, zstd 1.5.7) against a generated 20 000-memory database (28.6 MiB live / 28.5 MiB after `VACUUM INTO`) and a 30 000-memory database reduced to 6 000 rows, whose 13.34 MiB file still carried the deleted pages (4.42 MiB after `VACUUM INTO`). The ratio gains flatten hard above level 9, which is why "Maximum" is an explicit opt-in rather than the default. Brotli (`q11`) reaches 0.82 MiB on the snapshot but takes 18.7 s — better ratio, worse time, and no magic bytes; gzip stays available for interoperability (level 9 → 1.80 MiB, 15.8×, 489 ms) but is 15–20 % larger than zstd and is not offered as a preset.

Compression is **streamed**, never `readFileSync` + `compressSync`: `createReadStream → sha256 tap → createZstdCompress → createWriteStream`, which keeps memory flat regardless of database size (verified: 28.5 MiB round-trips byte-identically through the streaming pipeline in 440 ms; the backup path measures 43 ms end-to-end for copy + hash + `zstd -3`). Decompression mirrors it and enforces `maxOutputLength`, so a hostile or corrupt archive aborts with `ERR_BUFFER_TOO_LARGE` instead of exhausting memory (verified).

A counter-intuitive consequence worth knowing when choosing a preset: a **backup of a churned database compresses better than an export of the same data** (35× vs 26×) even though it is larger, because the raw image contains the long runs of deleted text that `VACUUM INTO` throws away.

### 8.4 Export flow

1. `PRAGMA wal_checkpoint(TRUNCATE)` — fold the WAL back into the main file so the snapshot is as small as possible (non-fatal if another process holds a read lock).
2. `VACUUM INTO` the temp snapshot.
3. Read `stats()` for `counts`, insert the manifest row into the snapshot's `meta` table (parameterized `INSERT OR REPLACE`, never string interpolation — JSON with quotes breaks literal SQL).
4. Stream: snapshot → sha256 → zstd(level) → `<target>.tmp` → `fsync` → `rename` to the final path (atomic; a failed export never leaves a half-written archive under the target name).
5. Report `path`, `bytes`, `uncompressedBytes`, `durationMs`, `memories` to the UI.

Target selection: there is no OS file dialog in the Paseo plugin SDK (verified against `@getpaseo/plugin@0.10.1` — the client API exposes only `openExternalUrl`, RPC, settings and UI primitives), so the settings screen uses a `SettingsInput` path field with a default of `$PASEO_HOME/plugins/memory-flash/exports/memory-<timestamp>.mfkb`, mirroring the existing "Purge by tag" text-input pattern. The directory is created on demand.

### 8.5 Import flow — merge is the safe default

**Mode `merge` (default).** Decompress + verify → open the archive read-only → `ATTACH` it to the live connection → in one `BEGIN IMMEDIATE` transaction copy rows and remap ids:

- `memories` are inserted **without their original ids** (`RETURNING id` per row builds an `old_id → new_id` map in a temp table), so a base that already contains memories with the same ids never collides — the imported rows simply get fresh ids. (Verified: local `#1` plus archived `#1`/`#2` import as `#2`/`#3`, with `memory_tags` and `memory_history` correctly re-pointed.)
- `memory_tags` and `memory_history` are re-inserted through that map (`INSERT OR IGNORE` for tags), so history follows the memories.
- The `AFTER INSERT` trigger on `memories` populates the FTS5 index — no separate rebuild step (verified: imported rows are immediately findable via `memories_fts MATCH`).
- `meta` is left untouched: schema version and settings markers of the live base win.
- A duplicate-suppression mode (`skipExisting`, keyed on `kind|title|content`) is available for merging a second backup into a machine that already has overlapping memories.

Atomicity: everything happens inside the single transaction, so a failure anywhere rolls back and leaves the live database untouched.

**Mode `replace`.** Copy the verified snapshot over `memory.db`. This mode is **unsafe while MCP servers are running** and the UI must say so. Measured behaviour when `memory.db` is overwritten under a second live SQLite connection: the open connection keeps reading its cached pages and its next write flushes the *old* content back over the new file — the imported data is silently lost and `integrity_check` still reports `ok`. Therefore `replace` is only offered when the plugin verifies no other process holds the file (`PRAGMA locking_mode=EXCLUSIVE` probe on a scratch connection, plus a check that no `mcp-server.js` child is alive); otherwise the RPC returns a readable error telling the user to close agents or use merge. If it does run, the plugin checkpoints, closes its own store, replaces the file, removes stale `-wal`/`-shm`, and reopens — agents must be restarted afterwards to pick up the new file.

`replace` also takes a safety copy first (`memory.db.pre-import-<timestamp>`), because it is the only destructive path.

### 8.6 Backup flow — direct file copy

The backup path skips `VACUUM INTO` entirely: it copies `memory.db` as-is, which is the cheapest possible snapshot (measured: 6 ms for 13.3 MiB vs 8 ms for `VACUUM INTO`, and no rewriting of pages) and preserves the exact physical image.

1. Open a short-lived connection and run `PRAGMA wal_checkpoint(TRUNCATE)` — **mandatory**, not an optimisation. A copy of the main file alone does not contain rows still living in the WAL (verified: committed rows were lost). If the checkpoint reports `SQLITE_BUSY` (another process is mid-write), the backup is retried with `busy_timeout` a few times and then aborted with a readable error rather than silently producing an incomplete image.
2. Verify the main file starts with `SQLite format 3` (16 bytes) before copying — a truncated or foreign file is rejected.
3. `copyFileSync(memory.db, tmp)` into the OS temp directory; the `-wal`/`-shm` sidecars are deliberately **not** copied, because after the successful checkpoint they carry no committed data. The temp image is deleted in a `finally` block.
4. Read the counts for the manifest from the **live** store (`stats()`) and record `pageSize`, `sqliteVersion`, `checkpointedAt`, `variant: "raw-image"`.
5. Stream: temp image → sha256 → zstd(preset) → `<target>.tmp` → `fsync` → `rename` to `<target>`. Same atomic-rename discipline as export, so a failed backup never destroys the previous one.
6. Report `path`, `bytes`, `uncompressedBytes`, `durationMs`, `memories` and the measured compression ratio.

Defaults: `$PASEO_HOME/plugins/memory-flash/backups/memory-<timestamp>.mfb`, preset **Balanced**. The UI exposes a *Backup now* button plus an optional retention setting (`keepLastBackups`, default 10 — the plugin prunes the oldest `.mfb` files in its own `backups/` directory after a successful write, never touching archives the user placed elsewhere).

Because the payload is a raw image, `includeHistory: false` and any row filtering are **not offered** for backups: pruning history means editing the image, which would break the "byte-identical" promise that makes a backup trustworthy. If a slim backup is wanted, that is an *export* (which supports `includeHistory: false`).

### 8.7 Backup restore flow

Restore is the inverse and is deliberately narrower than import:

1. Read the header; require magic `MFBK1\0\0` and `variant: "raw-image"` — an export archive (`.mfkb`) is rejected with a message pointing at the import path, and vice versa.
2. Decompress to a temp file (bounded by `maxOutputLength`), verify `payloadSha256`, then open the image and require `PRAGMA integrity_check` = `ok` **and** that the image contains the expected tables (`memories`, `memories_fts`, `memory_tags`, `memory_history`, `meta`) before anything is touched. The FTS index is part of the image, so no rebuild is needed (verified: a restored raw image answers `memories_fts MATCH` immediately, 4 286 hits).
3. Cross-check `schemaVersion` from the manifest against the live `meta.schema_version`; a mismatch is refused with a readable message (restoring a raw image from a different schema version is exactly how bases get corrupted).
4. Gate: `replace` semantics only — probe for other holders with a scratch connection using `PRAGMA locking_mode=EXCLUSIVE` + `BEGIN EXCLUSIVE` (verified: succeeds when nobody holds the file, refused while any other connection — idle or writing — is open), plus a liveness check for `mcp-server.js` children. If holders exist, abort with "close running agents or restore later"; there is no merge path for a raw image.
5. Safety copy: `memory.db.pre-restore-<timestamp>` (raw, uncompressed) next to the live file.
6. Swap: close the plugin's own store → remove stale `-wal`/`-shm` → `fsync` → `rename` the extracted image over `memory.db` → reopen the store. Verified end-to-end: after the swap the reopened database reads the restored rows and accepts new writes, `integrity_check` stays `ok`.
7. Tell the user in the response that running agents must be restarted to pick up the restored file.

### 8.8 RPC surface

| Contract | Input | Output |
| --- | --- | --- |
| `memory-flash.export` | `{ level: "fast"\|"balanced"\|"maximum", codec?: "zstd"\|"gzip"\|"brotli", targetPath?, includeHistory?: boolean }` | `{ ok, path, bytes, uncompressedBytes, memories, durationMs, error }` |
| `memory-flash.import` | `{ sourcePath, mode: "merge"\|"replace", onDuplicate?: "insert"\|"skip", confirm: "IMPORT" }` | `{ ok, imported, skipped, historyImported, mode, durationMs, error }` |
| `memory-flash.backup` | `{ level: "fast"\|"balanced"\|"maximum", codec?, targetPath? }` | `{ ok, path, bytes, uncompressedBytes, ratio, memories, checkpointedAt, durationMs, pruned: string[], error }` |
| `memory-flash.backup-restore` | `{ sourcePath, confirm: "RESTORE" }` | `{ ok, restored, previousFile, memories, requiresAgentRestart: true, durationMs, error }` |
| `memory-flash.archive-info` | `{ sourcePath }` | `{ ok, variant: "snapshot"\|"raw-image", format, codec, compressionLevel, createdAt, pluginVersion, counts, bytes, error }` — reads only the header; lets the UI preview any archive before importing or restoring |

Shared conventions: export and backup are non-destructive and atomic; import and backup-restore require a literal confirmation string (`"IMPORT"` / `"RESTORE"`, same guard style as `memory-flash.purge`); `archive-info` is read-only and works for both magics. Every failure path returns a readable `error` message rather than throwing a raw SQLite message. The three presets are the *same* enum for export and backup, so the settings screen can offer one shared picker.

### 8.9 Failure handling

- Missing/empty file, wrong magic, unknown `formatVersion` → readable error, nothing written.
- Operation/magic mismatch (restore of an `.mfkb`, import of an `.mfb`) → refused with a message naming the correct operation.
- `payloadSha256` mismatch → refuse (the archive is truncated or corrupted).
- Decompressed size above `maxOutputLength` → abort before writing anything.
- `integrity_check` on the extracted payload → must return `ok` before any merge or swap starts.
- **Backup:** `wal_checkpoint` reports `SQLITE_BUSY` after the retries → abort, no image written (a partial image is worse than none).
- **Backup:** the main file does not start with `SQLite format 3` → abort.
- **Restore:** another connection holds the file, or the manifest `schemaVersion` differs from the live one → refuse before the safety copy is even made.
- Disk full during export/backup → the `.tmp` file is removed; the previous archive at the target path stays intact.
- Interrupted import → single transaction rollback; live database unchanged.
- Interrupted restore → the rename is atomic, so `memory.db` is either the old file or the complete restored one; the `pre-restore` safety copy remains in place.

## 9. RPC surface

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
| `memory-flash.api-keys` | `{}` | `{ keys: [ApiKey] }` (no secrets, no hashes) |
| `memory-flash.api-key-generate` | `{ label, ttlDays?, scope? }` | `{ ok, id, secret, key, error }` — `secret` returned once |
| `memory-flash.api-key-revoke` | `{ id }` | `{ ok, error }` |
| `memory-flash.http-status` | `{}` | `{ enabled, listening, host, port, url, error, keyCount }` |
| `memory-flash.export` / `import` / `backup` / `backup-restore` / `archive-info` | see §8.8 | see §8.8 |

## 10. Compatibility

Verified on 2026-09-30 against Paseo `0.10.2` with `@getpaseo/plugin@0.10.1`:

- `npm run typecheck` — clean.
- `npm test` — 9 suites, 74 tests, all green, including an end-to-end test that spawns the bundled MCP server and speaks real JSON-RPC over stdio (handshake → tools/list → save → FTS search → file-on-disk assertions), dedicated registration suites for Cline, Cursor and Codex CLI (isolated `$HOME`: register/unregister/status, preservation of foreign servers and unrelated TOML content, quoted-key tables, corrupted-file refusal, stale-entry refresh) and a live-spawn probe suite (real `node -e` fake MCP server, immediate exit, timeout, missing command).
- Manual probe: `printf … | PASEO_HOME=… node dist/mcp-server.js` — `initialize`, `tools/list`, `tools/call` (save + search with snippet) all correct; tags normalized (`Paseo` → `paseo`).
- Node ≥ 24.20 required on the daemon host for built-in `node:sqlite` with FTS5 (verified FTS5 present in the runtime; porter/unicode61 tokenizer verified via search results).
- The bundle depends on nothing beyond Node built-ins, so agents' own Node runtimes can spawn it without `npm install`.
- Installed into the running daemon (`paseo plugin add` → `running`, `Plugin ready`, `npm run bundle` executed by the daemon build step). End-to-end: a real OpenCode agent created via `paseo run --provider opencode` accepted the injected MCP config (previously failed with `MCP error -32000: Connection closed` when the entry path resolved to the data directory) and the injection diagnostic confirmed the resolved entry. Plugin version 0.4.2 (0.1.x: core plugin; 0.2.0 added Cline MCP registration; 0.3.0 added Cursor + Codex CLI registration, the register-all button and the live spawn check; 0.3.1 strengthened the agent skill: mandatory bugfix recording, positive-result recording, knowledge-base updates on functionality change/bugfix, English-language rule; 0.3.2 fixed the three concurrency/search defects: `busy_timeout` + write retry so parallel agent writers no longer lose writes, natural-language/`key=value` search (stop words, OR-ranking, phrase and filter parsing), and the project name indexed as a tag with a schema-v2 backfill migration; 0.4.2 added the optional `kinds` filter to `memory_list_by_tag`, so a tag listing can be narrowed to selected kinds — handoff+decision — through a single tool).

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

## 11. Remote access over HTTP and API keys (0.5.0)

### 11.1 Scope and trust model

A machine running Memory Flash can act as a **memory host**: the same MCP tool set is additionally served over Streamable HTTP so that agents on other machines read and write the same `memory.db`. The credential is a per-machine API key.

The key is issued **on the memory host, by a human pressing Generate**, and carried to the client out of band (password manager, SSH, by hand). There is no network enrollment and no OAuth: automatic issuance would put the secret into an agent's context and its logs, which is exactly what this design avoids. Bind defaults to `127.0.0.1`; remote use is expected on a VPN (Tailscale), a LAN, or through an SSH tunnel.

### 11.2 Modules

| File | Responsibility |
| ---- | -------------- |
| `server/mcp-jsonrpc.ts` | Transport-agnostic MCP handling: `handleJsonRpcRequest(request, context, serverInfo, log)`. Both transports delegate here, so MCP semantics cannot drift between stdio and HTTP. Protocol version `2024-11-05`; tool failures are returned as MCP `isError` results, not JSON-RPC errors, so agents can read them. |
| `server/http-server.ts` | `McpHttpServer`: Node `http` server, auth middleware, per-IP 401 rate limit, body cap, scope enforcement, identity-header audit log. |
| `server/store.ts` | `api_keys` table plus `generateApiKey` / `authenticateApiKey` / `revokeApiKey` / `listApiKeys` / `activeKeyCount`. |
| `index.server.ts` | Starts/stops the endpoint from the `httpEnabled`/`httpHost`/`httpPort` settings and exposes the four RPCs. |

### 11.3 Endpoints

| Route | Auth | Behaviour |
| ----- | ---- | --------- |
| `POST /mcp` | required | One JSON-RPC 2.0 message per request (`initialize`, `ping`, `tools/list`, `tools/call`); notifications answer `202` with an empty body. |
| `GET /healthz` | none | `{"ok":true,"server":"memory-flash-mcp"}` — liveness for connection checks; reveals nothing about the store. |
| `GET`/`DELETE` `/mcp` | — | `405` (allowed for Streamable HTTP servers that offer no SSE stream). |
| anything else | — | `404`. |

### 11.4 Key material

| Field | Meaning |
| ----- | ------- |
| `id` | public key id, `mfk_<base64url>` |
| `label` | human name for the machine |
| `key_hash` | SHA-256 hex of the secret — the only stored form |
| `prefix` | first 12 characters of the secret, so a key can be recognized in the UI |
| `created_at`, `expires_at` (`NULL` = never), `revoked_at` (`NULL` = active), `last_used_at` | lifecycle + audit |
| `scopes` | JSON array: `read` or `read_write` |

Secrets are `mf_live_` + 32 CSPRNG bytes in base64url (256-bit entropy). Generation returns the record *and* the secret; the RPC surfaces the secret exactly once, and nothing else ever holds it.

`authenticateApiKey(secret)` hashes the presented value, looks the row up, rejects revoked and expired rows, and refreshes `last_used_at`. Every failure mode collapses to `null`, so a caller cannot distinguish an unknown key from a revoked or expired one.

### 11.5 Request handling

1. Parse the `Bearer` token; reject `401` (or `429` after 10 failures from one IP within 60 s) with a short, generic body.
2. Log the audit line — key id, label, source IP and the client's identity headers — never the `Authorization` value.
3. Read the body with a 1 MiB cap; oversized bodies get `413`, malformed JSON a `-32700` parse error.
4. For a `read`-scoped key, reject `tools/call` to anything outside `READ_ONLY_TOOLS` (`memory_search`, `memory_get`, `memory_list_by_tag`, `memory_stats`) with `-32000`, and filter `tools/list` to the same set. The check happens **before** dispatch, so a read-only key cannot execute a write tool.
5. Dispatch through the shared `dispatchMcpTool`, so HTTP and stdio behaviour stay identical.

### 11.6 Client identity (advisory)

`memory-flash-client` announces itself with two headers: `X-Memory-Flash-Client-Id` (a stable UUID) and `X-Memory-Flash-Host`. They grant nothing — the API key is the sole credential — but the memory host writes them into its log so several clients can be told apart in the audit trail. Values are sanitized (printable ASCII only, length-capped) so a crafted header cannot forge log lines.

### 11.7 Settings and lifecycle

`httpEnabled` (default off), `httpHost` (default `127.0.0.1`), `httpPort` (default `8787`). The endpoint follows the settings: a host/port change restarts it, disabling stops it, and a start failure is reported through `memory-flash.http-status` instead of throwing. The `url` getter renders `127.0.0.1` when bound to `0.0.0.0`/`::`, so a wildcard bind is not copied into an MCP config verbatim. Local agents are unaffected: they keep using the stdio server with no key.

### 11.8 Tests

`tests/http-server.test.ts` (14 tests) starts the server on an ephemeral port and drives it with `fetch`: health, handshake, tool call, 401/429, method rules, body cap, scope enforcement, read-only `tools/list` filtering, identity-header sanitizing, wildcard-bind URL rendering. `tests/api-keys.test.ts` covers generation, hashing, revocation, expiry and the store's last-used bookkeeping.

## 12. Limitations and roadmap

Limitations:

- **One memory database per machine.** Remote hosts keep their own file; there is no replication or live federation yet (the registry and probe are the foundation).
- **No embeddings/vector search.** FTS5 (porter + unicode61) covers lexical recall well for code-adjacent memories; a vector column + local embedding model is the known upgrade path (sqlite-vec) and is deliberately deferred until a local embedding source is chosen.
- **Attribution is cooperative.** `agent_id`/`changed_by` are set from the MCP caller (or the default setting); MCP does not authenticate callers, so attribution is a convention, not an enforcement boundary.
- **Skill installation is filesystem-level.** It copies `SKILL.md` into well-known directories; agents that keep skills elsewhere need a manual path (visible in the settings screen status list).

Roadmap:

1. **Cross-host memory federation** — the HTTP transport and `memory-flash-client` already give every machine a connection to one memory host; what is still missing is fan-out across several hosts from a single client, merging results with host labels and a write-through target.
2. **Vector recall** — optional `sqlite-vec` table + local embeddings for semantic search alongside FTS5.
3. **Timeline surfacing** — post a plugin timeline item when a delegated agent finishes memory maintenance (`agent.turn_ended` hook + timeline renderer).
4. **More transports** — real `tcp` and `relay` implementations behind the existing registry.
