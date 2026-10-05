# Memory Flash

Shared persistent memory for coding agents on [Paseo](https://paseo.sh/): a local MCP server backed by SQLite that every agent (Cline, OpenCode, Kilo, Qwen Code, Codex, …) can read and write, plus a full management surface inside Paseo.

Paseo orchestrates agents and passes prompts, but it does not provide durable shared memory between agents. Memory Flash closes that gap: decisions, procedures, handoffs, bugfix notes, working patterns and pitfalls are stored in one tagged, searchable database that all agents share — across agents, projects and sessions.

## What it does

- **Local MCP server (stdio)** — implements the MCP protocol (`initialize`, `tools/list`, `tools/call`) over JSON-RPC on stdin/stdout. Spawned by each agent process; all processes share one SQLite database in WAL mode.
- **Runs with the Paseo server** — the plugin lives inside the Paseo plugin host process, which also serves the management UI and injects the MCP server into agents.
- **MCP tools** — `memory_save`, `memory_search` (FTS5 full-text with snippets; natural-language queries, quoted phrases and `key=value` filters — `project=`, `kind=`, `tag=`, `agent=`), `memory_get`, `memory_update`, `memory_delete`, `memory_list_by_tag` (optional `kinds` filter, e.g. handoff+decision only), `memory_handoff`, `memory_stats`, `memory_diagnose`.
- **Measurable search quality (0.7.0)** — search is a number, not an opinion. `memory_diagnose` takes control queries together with the ids that answer them and reports recall@1/@5/@10/@50, plus — for every miss — whether the answer was **never retrieved** or only **ranked too low**. That single distinction decides the fix: a never-retrieved miss means the wording on disk does not match the question being asked, which no reordering can repair. Read-only: it writes nothing. `scripts/measure-search.mjs` runs the same comparison against a 5000-row synthetic corpus and fails if the shipped ranking is ever worse than the previous single-query bm25.
- **Fused retrieval (0.7.0)** — a text query ranks a pool of 50 rows and fuses several independent FTS5 views (full text, title-only, content-only, quoted phrase, short-document, strict AND) with Reciprocal Rank Fusion before cutting to the requested `limit`. Ranks are fused rather than bm25 scores, because scores are not comparable between different MATCH expressions. The full-text view carries the dominant weight so the fused order cannot drift far from the known-good ranking. No new dependency, no migration, no new index. See [ROADMAP.md](./ROADMAP.md).
- **Mandatory tagging** — every memory carries normalized lowercase tags: agent id, project name, topic, and a kind (`decision`, `procedure`, `handoff`, `bugfix`, `pattern`, `pitfall`, `reference`, `note`). The project name is indexed as a tag too, so both access paths — the project filter and the tag index — find the same memories. Tags are the cross-agent index; search composes text AND tags AND kind AND project.
- **Automatic MCP injection** — via the Paseo `agent.create` before-hook the MCP server is added to every agent created through Paseo (configurable, on by default). Agents from any provider connected to Paseo get the same memory without manual configuration.
- **Plugin updates never break a running agent (0.7.1)** — an agent keeps the MCP entry path it was given at creation and re-spawns it on every turn, while the daemon deletes the previous per-revision install directory on each update. The plugin therefore hands agents a **revision-independent entry** (`~/.paseo/plugins/memory-flash/mcp-server.js`, refreshed on every plugin load) instead of a path inside `<uuid>/checkout/`, and swaps it atomically. Without this, the first `paseo plugin update` after an agent was created made every subsequent turn fail with `MCP error -32000: Connection closed` while the memory server itself was perfectly healthy. Agents created before this version need to be recreated once.
- **Direct MCP registration for Cline, Cursor and Codex CLI** — these agents ignore stdio MCP servers delivered through the agent session and read them from their own config files (`~/.cline/data/settings/cline_mcp_settings.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`). The plugin registers the server there directly: per-agent Register/Re-register/Remove buttons, a *Register for all local agent configs* one-click button, preservation of every other server in each file, and atomic writes. The Cline status also runs a live spawn check (real MCP `initialize` handshake against the registered command) and warns when the registered command does not answer.
- **Agent skill** — a standard `SKILL.md` written as a *protocol*, not a description, because memory only pays off when every agent reads before it works and writes while it works. Read side: never start a non-trivial task with a single search (2–4 differently worded queries, filters varied, `memory_list_by_tag` and `memory_stats` to learn the base's real vocabulary), read the full memory with `memory_get` instead of trusting a snippet, and widen the query before concluding nothing is known. Write side: every bugfix (symptom, root cause, fix, verification), positive results as `pattern`, user corrections as `decision`, search-before-save so one fact yields one memory, and `memory_update` whenever functionality changes — all in English for cross-agent unification. Write side also fixes the *search index* half of a memory (0.7.0): the symptom is written the way a human reports it, the literal error string is pasted in, the file and symbol are named, and plain-language synonyms go into tags — because a measured failure was a *vocabulary gap* (a query sharing no words with the record), which no ranking system can bridge. Always a handoff at the end of a session. Installed with one click from the plugin settings into `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.qwen/skills`, `~/.cline/skills` and `~/.kilo/skills` (per-target Install/Update/Remove buttons + *Install into all agents*).
- **Management surface inside Paseo** (sidebar item + ⌘K) — browse and filter memories (kind chips, tag chips), full-text search with highlighted snippets, create/edit/delete with a live editor, per-memory revision history with one-click restore, statistics (totals, by kind/agent/project, top tags, database size).
- **Delegate maintenance to an agent** — the History & tasks tab composes a careful instruction (prefer update over delete, list before deleting, keep changes minimal) and sends it to a running agent picked from the live Paseo agent list; the agent then edits the database through its MCP tools.
- **Remote hosts** — register remote machines running the Paseo server over the standard Paseo SSH transport and check reachability (the remote memory database path is reported). TCP and relay transports are stubs reserved for future work.
- **Remote access over HTTP with API keys (0.5.0)** — the same MCP tools are also served over HTTP (Streamable HTTP: `POST http://<bind>:<port>/mcp`, JSON-RPC 2.0), so other machines can read and write the shared memory. Access is by API key only: a key is generated in the UI, shown **once**, and only its SHA-256 hash is stored; every request must carry `Authorization: Bearer <secret>`. Local agents keep using the stdio server and need no key. Keys can be scoped (`read` — search/read tools only, or `read_write` — the full tool set), can expire, and are deleted per machine in one click (the row is removed, so the label can be reused immediately). Failed authentications are rate-limited per IP, the `Authorization` header is never logged, and the memory host records the connecting client's UUID and host name (advisory identity headers) in its audit log. Bind defaults to `127.0.0.1`; use a Tailscale/LAN address for remote access. The endpoint lifecycle is debounced and serialised, so editing the bind address (including typing `0.0.0.0` character by character) restarts the socket exactly once on the final value, never leaves a stale listener on the previous port, and reports the interface that is really bound instead of the previous one. The companion [memory-flash-client](../memory-flash-client/README.md) plugin configures the other side.
- **Export, import and backup of the knowledge base (designed, not implemented yet)** — the design is documented in [__doc.md §8](./__doc.md).
  - *Export* — the database is snapshotted with `VACUUM INTO` (consistent, defragmented, no sidecars) and packed into a single `.mfkb` archive (header + manifest + SHA-256 + compressed payload). *Import* verifies the checksum and then merges rows into the live database inside a single transaction: ids are remapped, tags and revision history follow their memories, and the FTS5 index is updated by the existing triggers, so merging into a base that already has memories cannot collide.
  - *Backup* — takes a direct copy of `memory.db` itself (mandatory `wal_checkpoint(TRUNCATE)` first, otherwise committed rows still living in the WAL are silently lost) into a `.mfb` archive. It is the cheapest snapshot and keeps the exact physical image, so it can only be restored as a whole: the restore verifies checksum, `integrity_check` and schema version, refuses to run while any MCP server holds the file, keeps a `memory.db.pre-restore-<timestamp>` safety copy, and atomically swaps the file.
  - *Compression* — one shared choice for both paths: **Fast** `zstd -3` (~23× smaller, ms), **Balanced** `zstd -9` (~25×, recommended), **Maximum** `zstd -19` (~28×, seconds). Compression is streamed, so memory stays flat regardless of database size.
- **SQLite everywhere** — single-file database at `$PASEO_HOME/plugins/memory-flash/memory.db` (respects `PASEO_HOME`), WAL mode, FTS5 with porter/unicode61 tokenization, triggers keeping the index in sync, per-memory revision history, atomic settings/hosts files. Safe for parallel writers: a 5 s busy timeout plus automatic write retry, so concurrent agent processes no longer lose writes to `database is locked`.

## Remote access (HTTP + API key)

Memory Flash can serve the very same MCP tools over HTTP so that agents on other machines use the same memory database. The trust model is deliberately simple for a private network or a VPN: **the key is generated here and carried to the client by the user**, with no automatic enrollment and no OAuth.

1. On the memory host, open **Settings → Plugins → Memory Flash → Remote access (HTTP + API key)**.
2. Turn on **Serve MCP over HTTP** and pick the bind address and port (default `127.0.0.1:8787`). Keep it on loopback for local use, or on a Tailscale/LAN address for remote access. `0.0.0.0` (or `::`) is also accepted — it binds every interface, which is only safe behind a firewall or on a VPN; the status line below the inputs shows the interface that is really bound, while the copy block substitutes a concrete LAN/Wi-Fi address, because a wildcard cannot be dialled.
3. Press **Generate API key**, give it a name (`laptop-office`, `builder-2`), optionally a lifetime and a scope.
4. Copy the two lines the UI shows — the secret is displayed **exactly once** and cannot be recovered, only re-issued:

```text
URL:    http://100.64.0.2:8787/mcp
Header: Authorization: Bearer mf_live_…
```

5. Paste URL and secret on the remote machine. The easiest way is the companion [memory-flash-client](../memory-flash-client/README.md) plugin, which stores the key in a private file and injects the HTTP MCP server into every agent created through Paseo. Any other MCP client can use the two lines above directly.
6. If a machine is lost or the key must be rotated, press **Delete** on that key — the row is removed, the client is refused on its next request, and the name is immediately free for a replacement key. Other keys and the port are untouched. The name field keeps its value after generating, so replacing a key is a single click.

### Security notes

| Measure | Why |
| ------- | --- |
| Secret shown once in the UI | The plugin never persists the plaintext secret — only its SHA-256 hash lives in `api_keys` |
| Delete per key | A compromised host is cut off without affecting other machines, and the row leaves the database, so the label can be re-issued right away |
| Bind defaults to loopback | Remote access requires an explicit address (Tailscale/LAN) plus a firewall |
| `Authorization` never logged | Only key id, label, client identity and source IP appear in the log |
| 401 rate-limited per IP | Slows down key brute-forcing |
| Scoped keys | A `read` key can only reach `memory_search`, `memory_get`, `memory_list_by_tag` and `memory_stats` |

The secret is never written to git, agent prompts or agent logs, and it is never issued automatically over the network — a human presses **Generate**.

## Install

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:memory-flash
```

Requires Paseo ≥ 0.10.0 (verified against 0.10.3; uses the plugin SDK 0.10 settings screens and lifecycle hooks). Node ≥ 24 runs on the daemon host (built-in `node:sqlite` with FTS5).

After install: open **Settings → Plugins → Memory Flash** and press **Install into all agents** to place the skill where your agents look for it. The MCP server is injected into new agents automatically. For Cline, Cursor and Codex CLI, additionally press **Register for all local agent configs** (these agents do not pick up stdio MCP servers from the agent session — they need their own config entries, which the button writes for you). The Cline row also shows a live spawn check of the registered command.

The plugin is installed into the Paseo home and runs from there: `~/.paseo/plugins/memory-flash/<revision>/checkout/memory-flash`. The manifest `build` step (`paseo-plugin.json`, an argv array: `[["npm", "ci"], ["npm", "run", "bundle"]]`) is executed by the daemon in that directory on every install and every update: `npm ci` installs the dependencies, then `dist/mcp-server.js` is regenerated, so MCP-server changes reach agents without a manual rebundle. Both commands need registry access on the host. Updates: `paseo plugin update memory-flash`.

## Development

```bash
npm install
npm run bundle   # dist/mcp-server.js — standalone stdio server (esbuild)
npm test         # vitest: store, tools, protocol, skill/hosts, agent MCP registration, live spawn probe, e2e over stdio
npm run typecheck

node scripts/e2e-entry-resolution.mjs   # entry path across a simulated plugin update (real MCP handshake)
```

Working with an installed plugin:

```bash
paseo plugin logs memory-flash                 # includes the `[memory-flash] MCP injected: … (entry exists|MISSING)` diagnostic
paseo plugin disable memory-flash && paseo plugin enable memory-flash   # reload (`paseo plugin reload` currently fails manifest validation on the daemon side)
```

Storage layout on the daemon host:

```
$PASEO_HOME/plugins/memory-flash/
├── memory.db      # the shared memory (SQLite, WAL; -wal/-shm sidecars)
├── mcp-server.js  # symlink to the current build's stdio server — the path agents spawn (survives plugin updates)
├── exports/       # knowledge-base archives written by the export action (planned)
├── backups/       # raw-file backups written by the backup action (planned)
├── settings.json  # host-scoped plugin settings (written by the host)
└── hosts.json     # remote host registry
```

Skill folder (`SKILL.md`) is copied into each agent family's skills directory.

Technical details, design decisions, alternatives considered, limitations and the roadmap: see [__doc.md](./__doc.md).
