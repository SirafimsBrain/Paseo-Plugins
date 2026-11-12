# obsidian-bridge — research, decisions and design plan

Status: research and planning only. No plugin code exists yet. Version numbering starts with the first implementation.

Last updated: 2026-11-12 (owner decisions on scope recorded in §1).

---

## 1. Decisions taken

The owner answered the open questions from the first revision of this document:

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where is the vault? | **Local**, on this Linux machine, on the same host as the Paseo daemon. |
| 2 | Obsidian Sync subscription? | **No.** `obsidian-headless` / Headless Sync is out of scope. |
| 3 | May agents create notes freely? | **No.** Agents may only **append to the project's inbox note**. |
| 4 | Local embedding model ~120 MB? | **Acceptable.** Local model is the default semantic backend. |
| 5 | Relationship to `memory-flash`? | **Independent tools, different jobs, no replacement.** See §3. |

Additional scope decisions from the same answer:

- Stage A of the implementation targets a **local vault with the Obsidian application running** on the same host as Paseo.
- Stage B is a **fallback for a local vault with Obsidian closed**; its cost is assessed in §8 before it is built.
- Remote vaults (REST over the network, SSH tunnels, headless sync on servers) are **deferred indefinitely** and kept only as
  documented future work.

---

## 2. Scope

`obsidian-bridge` is the bridge through which a Paseo agent **reads** the Obsidian knowledge base — documents, plans,
recommendations, prior research — and **cites the source** when it plans (for example into `luck-planner`), executes
project tasks, or writes a guide/instruction that has no place in the code repository.

In scope:

- giving agents retrieval over the vault with paths and headings as citations,
- a single narrow write path (append to the project's inbox note),
- an index and a retrieval engine owned by the plugin,
- Paseo-native operation: MCP injection, native tools, settings, UI.

Explicitly out of scope:

- remote vaults, VPN/SSH transports, multi-host vault registries,
- general note authoring, editing, moving or deleting by agents,
- replicating Obsidian features (Dataview execution, canvas, plugin metadata),
- replacing `memory-flash` or the `luck-planner` tree.

---

## 3. Positioning: `memory-flash` vs `obsidian-bridge`

These are two different instruments with different lifecycles, different write patterns and different consumers. They
must not be merged, and neither should silently take over the other's job.

| | `memory-flash` | `obsidian-bridge` |
| --- | --- | --- |
| What it is | A durable memory layer for agents | A bridge to a human-authored knowledge base |
| Content | Facts, decisions, procedures, handoffs, pitfalls produced *during* work | Documents, plans, recommendations, research, guides written for a human reader |
| Author | Agents write and rewrite it constantly | Humans author it; agents mostly read, and only append to an inbox |
| Storage | Its own SQLite database with revisions and history | The user's Obsidian vault — the source of truth stays a folder of Markdown |
| Write model | Create/update/revise/tag/restore | Append only, one inbox note per project |
| Read model | Search memory by tag/project/kind, recall@k diagnostics | Hybrid retrieval over notes and headings, with citations; graph of wikilinks |
| Lifetime | Scoped to a project and to agent sessions | Spans projects; survives any single project |
| Failure mode if missing | The agent forgets what it learned | The agent plans from its own assumptions instead of the user's documents |

Practical routing rule to encode in both agent skills:

- **"What did we decide / how did we fix this / hand this to another agent"** → `memory-flash`.
- **"What does the user's documentation say / what is the plan / find the source I must cite"** → `obsidian-bridge`.
- **Planning into `luck-planner`** → read the vault first through `obsidian-bridge`, then write tree nodes in `luck-planner`
  and record the note path as the source of a leaf.
- **New knowledge produced by work** → durable fact goes to `memory-flash`; a human-facing guide or instruction that does
  not belong in the repository goes to the vault inbox (append), and the human promotes it later.

---

## 4. Paseo side: what the plugin builds on

Plugins are trusted, unsandboxed code with two runtimes: `index.client.tsx`/`client/` in the app,
`index.server.ts`/`server/` as a daemon subprocess (Node APIs, filesystem, network, credentials), and `shared/` for Zod
contracts. Source: <https://paseo.sh/docs/plugins/reference>.

| Capability | API | Use in `obsidian-bridge` |
| --- | --- | --- |
| Inject an MCP server into agents | `server.addHook("agent.open.before", …)`, `request.mcpServers` | Vault tools in every Paseo-created agent; re-applied on each session open, including resume after a daemon restart. |
| Native tools without MCP | `defineAgentTool({ name, description, input: z…, execute })` in the same hook, `request.tools` | Providers without MCP support still get the vault tools; `execute` runs in the plugin process. |
| Naming rules | `/^[a-z][a-z0-9_]*$/`, ≤ 64 chars, no collision with Paseo or other plugins | Prefix `obsidian_`. |
| Gating | `request.labels`, `request.provider`, `request.metadata`, `request.cwd` | Label opt-out per agent; project resolution from `cwd`. |
| Host settings | `server.registerSettings()` / `defineSettings` | Vault path, inbox template, embedding provider, read-only switch, index policy. |
| Typed RPC | `defineRpc` (shared) + `server.handle` + `useRpc` | Search, status, reindex, note preview; the plugin process owns the index. |
| UI | `addSurface`+`addSidebarItem`, `addWorkspacePanel`, `addCommandCenterItem`, `addComposerPill` | Knowledge-base panel, attach-note pill, reindex action. |
| Attachment source | `defineAttachmentSource` + a search RPC | Attach a note as a text snapshot to a prompt. |
| Packaging | `paseo-plugin.json` `build` + `mcp.entry`, one esbuild bundle | Same shape as `memory-flash`, `bunny-search`, `luck-planner`. |

Constraints that shape the design:

- MCP injection is launch-only and re-runs per session open; a settings change reaches an existing agent on its next idle
  prompt (`paseo.agents.ref(id).reload()` forces it). A provider without MCP support **fails the session open** if
  `mcpServers` is injected for it — injection must be skipped there and replaced by native tools.
- Hooks have a 30 s timeout and an abort `signal`; indexing must never be awaited from a hook.
- MCP server bundles cannot use the plugin API, so the bundle reads a mirrored `settings.json` (the `bunny-search`
  pattern: host store is authoritative, the plugin mirrors it atomically on startup and on every change).

Environment verified on this machine: Node `v24.20.0`, npm `12.0.2`, `sqlite3` CLI `3.46.1`, Obsidian installed at
`/opt/Obsidian/obsidian` (symlinked from `/usr/bin/obsidian`), no `ollama` in `PATH`. The installed Obsidian version could
not be read from `/opt/Obsidian/resources/app/package.json`; it decides whether the official CLI (1.12.7+) exists, so
`obsidian_status` probes for it instead of assuming.

---

## 5. Obsidian side: the available access surfaces

### 5.1 Direct filesystem (vault on disk) — the base

A vault is a folder of `.md` files plus attachments and `.obsidian/`. Everything observable is derivable: YAML
frontmatter, `#tags`, `[[wikilinks]]`, `![[embeds]]`, callouts, inline `key:: value` fields.

- Always available, including when Obsidian is closed; microsecond reads; ordinary writes.
- No Obsidian link resolution, no block-ID resolution, no Dataview execution, no plugin metadata, nothing that only exists
  after rendering.
- No ETags; the `.obsidian/` configuration directory must never be touched.

This is the **only** path that works headless, and — crucially — it is also the cheapest path for indexing, which is why it
is the base rather than a fallback.

### 5.2 Local REST API with built-in MCP (`coddingtonbear/obsidian-local-rest-api`)

Runs inside the app; serves REST and a Streamable HTTP MCP server.

- HTTPS `127.0.0.1:27124` with a self-signed generated CA, optional plain HTTP `27123`. Bearer token; failed auth
  throttled per source address.
- `/vault/{path}` CRUD, heading/block/frontmatter targeting, `/active/`, `/search/simple/` (Obsidian fuzzy search, scored
  snippets, `maxResults`/`maxMatchesPerFile`), `/search/` (JsonLogic), `/tags/`, `/commands/`, `/open/{path}`,
  `/events/vault/{event}/` SSE, `/mcp/`.
- **Conditional writes**: `ETag` + `If-Match` → `412`; `If-None-Match: *` create-only. Note JSON carries `links`,
  `backlinks`, `unresolvedLinks`, `tags`, `stat`, `version` — i.e. the vault-wide graph Obsidian builds.
- `.obsidian/` refused with `403`. Good.
- **Constraint: the app must be running.** Closing Obsidian stops both REST and its MCP server.
- Version split: 5.0.x needs Obsidian 1.13.1+ (Catalyst early access at the time of writing), community directory is
  pinned to 4.1.7 — a client must probe `GET /` (`versions`, `apiExtensions`, `listeningSince`) and adapt.

### 5.3 Official Obsidian CLI (1.12+)

`obsidian read|create|append|search|search:context|daily:append|files|…`, enabled in **Settings → General → Command line
interface**, linked to `/usr/local/bin/obsidian` or `~/.local/bin/obsidian`.

- **Requires the running app** (a command launches it otherwise — not headless).
- Index-aware, and `search:context` is genuinely useful for citations.
- One process per call, human-oriented output, young and still changing.

### 5.4 Out of scope now

- Third-party MCP servers (REST wrappers inherit §5.2's constraint; filesystem ones duplicate what this plugin must own
  anyway — the index — and none is a Paseo plugin).
- `obsidian-headless` / Headless Sync: needs an Obsidian Sync subscription the owner does not have.
- `obsidian://` URI scheme: opens a file, returns nothing.
- Remote vaults, tunnels, multi-vault registries.

---

## 6. Architecture, stage A (local vault, Obsidian running)

### 6.1 Shape

```
obsidian-bridge/
├── index.server.ts        # settings, agent.open.before injection, RPC handlers, index lifecycle
├── index.client.tsx       # surface, sidebar item, ⌘K items, settings screen
├── shared/                # zod contracts: RPCs, settings, note/chunk/search types
├── server/
│   ├── vault.ts           # vault root resolution, path safety, include/exclude, frontmatter parse
│   ├── parse.ts           # headings, tags, wikilinks/aliases/anchors, inline fields, chunking
│   ├── store.ts           # SQLite schema/migrations, FTS5, tags, links, embeddings, meta
│   ├── indexer.ts         # full scan, fs.watch + reconcile, queue, progress
│   ├── search.ts          # signals, RRF fusion, token-budgeted packing
│   ├── embed.ts           # local model (Transformers.js) + optional provider adapters
│   ├── inbox.ts           # project → inbox note resolution, atomic append, dedup
│   ├── obsidian-rest.ts   # optional enrichment adapter (§6.5)
│   ├── mcp-server.ts      # standalone stdio MCP server (bundled)
│   ├── mcp-tools.ts       # tool definitions + transport-independent dispatch
│   └── mcp-launch.ts      # node + dist/mcp-server.js resolution for injection
├── client/                # panel, attach-note pill, settings screen
├── scripts/bundle-mcp-server.mjs
└── tests/
```

Data flow:

1. **Agent → vault.** An agent process spawns `dist/mcp-server.js` (injected via `agent.open.before`, or configured
   manually in the agent's own MCP config). Every tool call reads the SQLite index and/or the vault files directly.
2. **Vault → index.** The plugin process watches the vault and keeps the index current; the bundle and the plugin open the
   same SQLite file in WAL mode (the same multi-consumer pattern `memory-flash` uses).
3. **UI → plugin.** The panel calls RPCs; only the plugin process touches the store.

### 6.2 Index

`$PASEO_HOME/plugins/obsidian-bridge/vaults/<vaultId>/index.db` (SQLite, WAL). Outside the vault: no pollution, no sync,
survives plugin updates.

| Table | Contents |
| --- | --- |
| `notes` | path, title, mtime, size, hash, frontmatter JSON, word count, folder |
| `chunks` | note path, heading path, ordinal, text, token estimate |
| `chunks_fts` | FTS5 external content over text + heading path, `unicode61 remove_diacritics 2` (Russian + English; `porter` is English-only, so stemming is a per-vault option) |
| `tags` | note path, tag, inline vs frontmatter |
| `links` | source, raw target, resolved path or null, alias, `#heading`/`^block` anchor |
| `embeddings` | chunk id, model id, dim, vector BLOB |
| `index_meta` | schema version, model id, last scan, last reconcile |

Excluded: `.obsidian/`, `.trash/`, `.git/`, `.smart-env/`, plus a configurable exclude list.

Incremental: recursive `fs.watch` with a ~1.5–2 s debounce, plus a reconcile every 10 min comparing mtime+size and
falling back to hashing; renames are recovered by content hash so tags/links survive. Full rebuild is a ⌘K action. All
indexing runs on a queue in the plugin process, never inside a hook.

### 6.3 Retrieval

Signals, each ranking chunk ids, fused with Reciprocal Rank Fusion — the pattern already proven in `memory-flash`:

1. chunk BM25 (exact names, IDs, error strings, code),
2. title/alias/first-heading BM25,
3. structured filters applied before ranking (`project:`, `tags:`, `folder:`, `since:`),
4. vector similarity (stage 0.3.0),
5. **graph proximity**: 1–2 hop wikilink expansion from the top lexical hits (one SQL join) — the advantage a vault has
   over a folder of files,
6. small recency/folder boost.

Output is packed into a token budget (default ~2 000 tokens): whole top chunks, then neighbouring chunks from the same
note, each hit carrying note path, heading path, tags and backlink count, so an agent can cite
`Projects/x/Research/y.md § Heading`. A separate `obsidian_read` returns a full note or one section on demand.

**Embeddings (0.3.0).** Default is local, in-process: `@huggingface/transformers` with
`Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 d, 50+ languages, ~120 MB quantized, CPU, cached after first run) or
`Xenova/multilingual-e5-small` (needs `query:`/`passage:` prefixes). Installed as an optional dependency, loaded lazily in
a worker thread so embedding never blocks the plugin subprocess; if it is absent the plugin runs lexical-only and says so.
An optional provider block (Ollama / LM Studio / OpenAI-compatible `/v1/embeddings`) stays for future use, off by default.

**No `sqlite-vec`.** 20 000 notes ≈ 150 000 chunks × 384 d × 4 B ≈ 230 MB; pruning to ~2 000 lexical candidates and doing
brute-force cosine in JS is tens of milliseconds. This avoids `node:sqlite`'s blocked `loadExtension` on Node 22 and any
install-time compilation. Vectors live as a BLOB column in the same file; adding `sqlite-vec` later is a local change.

### 6.4 Writes: append to the project inbox, nothing else

Deliberately the smallest possible write surface:

- Resolve the project from the agent's `cwd` (`request.cwd` at open time, also accepted per call) to a vault project
  folder: configured mapping first, then a `Projects/<slug>/` convention with the slug taken from the repo directory name.
- Target: `Projects/<slug>/Inbox.md`. Created from a template (frontmatter + `## Inbox` heading) only if missing.
- Append is append-only: `## <ISO date> — <short title>` plus the body, then a blank line. Never rewrites, never reorders,
  never deletes.
- Atomic append: open with `O_APPEND`, single write, `fsync`, then a post-check that the file still contains our marker;
  if Obsidian saved a stale buffer over it, the tool retries once and, failing that, returns an explicit conflict error
  with the exact text to re-insert (nothing is lost silently).
- Dedup: identical body hashes within 24 h are skipped and reported as `duplicate`.
- Guard rails: `readOnly` switch per vault, size cap per append (default 32 KiB, reject with a pointer to split the note),
  and a hard refusal for any path outside the project's inbox.
- No tool exists for create/patch/move/delete. Promotion of inbox material into `Research/` stays a human action.

### 6.5 Obsidian enrichment (optional, app running)

Never required for correctness, only for better answers:

- `obsidian_outline` prefers REST note JSON for authoritative `links`/`backlinks`/`unresolvedLinks`/`tags` and falls back
  to the parsed tables when Obsidian is unreachable.
- `/search/simple/` or `obsidian search` results join the fusion as an extra signal, weighted below BM25.
- `/events/vault/{event}/` SSE can trigger targeted reindex instead of a full reconcile.
- "Open note in Obsidian" in the panel uses `/open/{path}` or `obsidian open`.

Transport handling: a single `ObsidianEnrichment` adapter that probes `GET /` on startup and on demand, caches the
`versions`/`apiExtensions` document, and degrades to `{ available: false, reason }` without throwing into tool results
beyond a one-line note.

### 6.6 Agent-facing tools

| Tool | Purpose |
| --- | --- |
| `obsidian_search` | Hybrid search; filters `project`/`tags`/`folder`/`since`; `limit`, `budget`. Returns ranked chunks with path + heading path + snippet. |
| `obsidian_read` | Read a note, one heading subtree, or one frontmatter field. |
| `obsidian_outline` | Headings, block IDs, frontmatter keys, tags, links, backlinks, unresolved links. |
| `obsidian_list` | Notes/folders under a prefix with an optional frontmatter filter. |
| `obsidian_links` | Resolved links and backlinks for a note or a folder map. |
| `obsidian_append_inbox` | Append to this project's inbox note only. |
| `obsidian_index` | Reindex a path or the whole vault; returns counts and duration. |
| `obsidian_status` | Vault, index freshness, embedding model, enrichment availability, read-only flag, inbox path. |
| `obsidian_diagnose` | Later (0.3.0): recall@k over a control query set, like `memory-flash`'s diagnostics. |

The same operations are defined with `defineAgentTool` and attached through `request.tools` for providers without MCP.

### 6.7 Paseo UX

- **Sidebar surface "Knowledge base"**: index status/freshness, search box over the same engine, note preview with
  backlinks, inbox size per project, reindex button.
- **Composer pill / attachment source**: attach a note as a text snapshot.
- **⌘K**: "Search knowledge base", "Reindex vault", "Open project inbox".
- **Settings screen**: vault path, include/exclude globs, read-only, inbox template, embedding provider/model, enrichment
  URL + token (stored in host settings, never logged, never sent to agents), probe result.
- **Agent skill** (`SKILL.md`, installable like `memory-flash`'s): when to search the vault, how to cite, what belongs in
  `memory-flash` versus the vault, and the append-only rule.

---

## 7. Stage B: local vault, Obsidian closed

### 7.1 What actually breaks when the app is not running

| Capability | With app | Without app |
| --- | --- | --- |
| Full-text + vector search over the index | works | **works** |
| Reading notes, outlines, links (parsed) | works | **works** (only authoritative backlinks downgrade) |
| Indexing / watching | works | **works** |
| Append to inbox | works | **works** (filesystem path) |
| Obsidian fuzzy-search signal in fusion | works | silently absent |
| Authoritative backlinks/unresolved links | works | parsed approximation |
| "Open note in Obsidian" | works | disabled |

So stage B is not a second transport. Everything that matters is already filesystem-based; only enrichment and UI
conveniences touch the app.

### 7.2 What stage B adds, concretely

1. A `transport` seam from day one: `readNote`, `readSection`, `outline`, `links`, `append`, `enrichment`. Stage A already
   implements every method on the filesystem; the REST adapter overrides `outline`/`links`/`enrichment`/`append`
   (ETag-protected) when available.
2. Conflict recovery for the append path: detect an Obsidian stale-buffer overwrite (marker missing after write), retry
   once with backoff, then return the exact text plus a `conflict` flag; on the next reconcile, re-append if the user
   confirms via a panel action.
3. Health reporting: `obsidian_status` distinguishes "index live, enrichment down" from "vault unreachable", and the panel
   shows a muted "Obsidian not running — enriched features unavailable" row instead of an error.
4. Deferred index refresh while the app was closed: one reconcile pass on first tool call after a gap, bounded in time.

Estimated size: ~250–350 LoC plus tests, i.e. **1.5–2 days**.

---

## 8. Is the no-app fallback worth building?

Short answer: **yes, but only because the base is already filesystem-first — and it should not be built before stage A
works.** The question of "extra complexity for a permanently running Obsidian" dissolves if the plugin never treats
Obsidian as a dependency:

- Indexing and reading from the vault folder is *not* extra code relative to indexing over HTTP; it is **less** code, has
  no TLS/token/probing, and is one to two orders of magnitude faster for a full scan. Making Obsidian the mandatory path
  would mean writing an HTTP indexer plus a retry/probe layer instead — more code, slower, and still unable to search when
  the app is closed.
- Everything the app is genuinely better at (authoritative link graph, fuzzy search, command palette, opening notes) is a
  small, isolated adapter. Its absence changes result *quality*, never correctness.
- The extra cost of the fallback is confined to (a) an interface, which stage A wants anyway for testability, (b) an
  append-conflict recovery loop, and (c) honest status reporting — §7.2.

Cost comparison as a share of the whole plugin (estimates, calendar days of focused work):

| Piece | Estimate |
| --- | --- |
| Index, parsing, chunking, store, watch/reconcile | 4–5 d |
| Lexical + graph retrieval, fusion, packing | 2–3 d |
| MCP bundle, injection, native tools, settings, skill | 2–3 d |
| Inbox append + conflict handling | 1–1.5 d |
| Embeddings + hybrid + diagnose | 2–3 d |
| UI (panel, pill, settings, ⌘K) | 2–3 d |
| Stage B hardening (§7.2) | 1.5–2 d |
| Tests, docs, packaging, compatibility matrix | 3–4 d |
| **Total** | **~18–24 d**, of which the fallback is **~9 %** |

Two caveats worth stating plainly:

- "Permanently running in the background" is a user habit, not a guarantee: an app update, a crash, an OOM kill, a
  logged-out session, or a machine reboot without autostart all break it. A knowledge base that an agent cannot cite from
  because a GUI is closed is a bad failure mode for a tool whose whole point is citations.
- The stage-B work also buys **testability**: the index and retrieval can be exercised in CI with no Obsidian at all,
  which stage A needs even if stage B is never shipped.

What should *not* be built: a parallel HTTP-first implementation, an Obsidian-required search path, an SSH-tunnel/remote
vault registry, or anything depending on the Obsidian Sync subscription. Those are the genuinely expensive "extra code".

---

## 9. Plan

### Stage A — local vault, Obsidian running

**0.1.0 — index and read.**
Vault path in settings with include/exclude; full scan; parsing (frontmatter, headings, tags, wikilinks/aliases/anchors,
inline fields); chunking by headings; SQLite + FTS5 + tags + links; `fs.watch` + reconcile; tools `obsidian_search`
(lexical + graph + recency, RRF), `obsidian_read`, `obsidian_outline`, `obsidian_list`, `obsidian_links`, `obsidian_index`,
`obsidian_status`; MCP injection via `agent.open.before` with label gating; native tools for non-MCP providers; `SKILL.md`.
*Acceptance:* on this machine's real vault, a query returns the right note in the top 3 for 20 hand-picked control
queries; index of a full vault completes in seconds and stays current after an external edit; an agent in a new workspace
can search and read without extra setup.

**0.2.0 — inbox append.**
Project resolution from `cwd`; `Projects/<slug>/Inbox.md` template; atomic append with marker verification, dedup, size
cap, `readOnly`; no other write tool exists. *Acceptance:* two concurrent appends do not interleave; an append made while
Obsidian has the note open survives; the tool refuses any target outside the inbox.

**0.3.0 — semantic layer.**
Optional local model, worker-thread embedding, incremental embedding of changed chunks, vector signal in fusion,
`obsidian_diagnose` with recall@k over the control queries. *Acceptance:* recall improves measurably over lexical-only on
the control set, or the stage is documented as not worth its cost; lexical search keeps working with the model absent.

**0.4.0 — Paseo UI and Obsidian enrichment.**
Sidebar panel (status, search, preview, backlinks, inbox size), attachment source, ⌘K items, settings screen; REST adapter
for authoritative backlinks/tags, fuzzy-search signal, SSE-driven reindex, "open in Obsidian". *Acceptance:* every
enrichment feature degrades to the filesystem equivalent with a one-line note, never an error.

### Stage B — local vault, Obsidian closed

**0.5.0 — fallback hardening.** Transport seam completed, append conflict recovery, deferred reconcile, status/diagnostics
distinction, documentation of what degrades. *Acceptance:* with Obsidian fully stopped, search/read/outline/list/append all
work; the panel states what is degraded; restarting Obsidian restores enrichment without a plugin reload.

**1.0.0 — release.** Consolidation, README, `__doc.md`, `__compatibility.md`, compatibility table entry.

Versioning per repository rules: patch digit for fixes and changes to existing behaviour, minor digit for new
functionality, major digit on an explicit "release", with an annotated `<plugin>@<version>` tag per bump.

---

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Obsidian closed → enrichment gone | Base is filesystem; §7. |
| Obsidian saves a stale buffer over an appended note | Marker verification, one retry, explicit conflict result, reconcile-based recovery; never silent loss. |
| Agent writes outside the inbox | Only one write tool exists; path allowlist enforced in the handler, not in the prompt. |
| Token leakage (REST key) | Host settings only; never in plugin files, agent env, logs or tool output. |
| Index drift after sync/edit bursts | Debounced watch + periodic mtime/size/hash reconcile; freshness in `obsidian_status` and the panel. |
| Embedding model change | `model id` + dim in `index_meta`; changing it marks vectors stale and rebuilds in the background. |
| Context flooding from big notes | Token-budgeted packing, chunk snippets by default, whole note only on explicit read. |
| Vault size growth making brute-force vectors slow | Prune to lexical candidates; `sqlite-vec` behind the same interface if the vault passes ~100 k notes. |
| Hook timeout during open | Indexing is queued in the plugin process; hooks only append a config entry. |
| Enrichment probe hang | Short timeout, cached probe result, all enrichment calls bounded and skippable. |

---

## 11. Remaining questions

1. Vault path (the owner has it locally; it must be entered once in settings — nothing was scanned from disk in this
   research).
2. Project → folder mapping: is the convention `Projects/<repo-dir-name>/` acceptable as the default, with manual overrides?
3. Should the inbox template be a fixed default or reuse an existing note as a template?
4. Is an Obsidian version ≥ 1.12.7 installed (official CLI availability) and is the Local REST API plugin already present,
   or is stage 0.4.0's enrichment optional indefinitely?
5. Default append cap of 32 KiB per call — sufficient, or should it be lower to force distilled notes?

---

## 12. Sources

- Paseo plugin reference — <https://paseo.sh/docs/plugins/reference.md>
- Paseo plugin hooks (MCP injection, agent tools, timeouts) — <https://paseo.sh/docs/plugins/hooks.md>
- Paseo MCP reference — <https://paseo.sh/docs/mcp>
- Local REST API with MCP — <https://github.com/coddingtonbear/obsidian-local-rest-api>;
  API docs <https://coddingtonbear.github.io/obsidian-local-rest-api/>
- Obsidian CLI — <https://obsidian.md/cli>, <https://help.obsidian.md/Extending+Obsidian/Obsidian+CLI>
- Obsidian Headless / Headless Sync (out of scope) — <https://obsidian.md/help/cli/headless>,
  <https://help.obsidian.md/sync/headless>
- Third-party MCP servers surveyed — <https://github.com/MarkusPfundstein/mcp-obsidian>,
  <https://github.com/cyanheads/obsidian-mcp-server>, <https://github.com/proofsh/obsidian-mcp>,
  <https://github.com/trsdn/obsidian-mcp>
- In-app semantic indexes surveyed — <https://smartconnections.app/>, <https://github.com/StepanchukYI/obsidian-semantic-search>
- `sqlite-vec` — <https://github.com/asg017/sqlite-vec>, <https://alexgarcia.xyz/sqlite-vec/installation.html>;
  `node:sqlite` extension-loading limitation — <https://github.com/openclaw/openclaw/issues/66977>
