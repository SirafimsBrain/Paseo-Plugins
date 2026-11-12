# obsidian-bridge — research, decisions and design plan

Status: research and planning only. No plugin code exists yet. Version numbering starts with the first implementation.

Last updated: 2026-11-12 (owner decisions in §1, operating contract in §2).

---

## 1. Decisions taken

The owner answered the open questions from the first revision of this document:

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where is the vault? | **Local**, on this Linux machine, on the same host as the Paseo daemon. |
| 2 | Obsidian Sync subscription? | **No.** `obsidian-headless` / Headless Sync is out of scope. |
| 3 | May agents create notes freely? | **No.** Writes are append-only, and only to an **explicitly named** target document. |
| 4 | Local embedding model ~120 MB? | **Acceptable.** Local model is the default semantic backend. |
| 5 | Relationship to `memory-flash`? | **Independent tools, different jobs, different roles in an agent's life.** See §3. |
| 6 | When may an agent use the bridge? | **Only on an explicit instruction in the prompt.** See §2. |

Scope decisions from the same answers:

- Stage A targets a **local vault with the Obsidian application running** on the Paseo host.
- Stage B is a **fallback for a local vault with Obsidian closed**; its cost is assessed in §9 before it is built.
- Remote vaults (REST over the network, SSH tunnels, headless sync on servers) are **deferred indefinitely**.

---

## 2. Operating contract (must not drift while coding)

This section is the part most likely to be implemented wrongly, so it is stated as invariants. Any implementation choice
that violates one of these is a bug, not a preference.

1. **Availability is not initiative.** The tools are injected so that an agent *can* answer an explicit request. Nothing
   in the plugin makes an agent use them on its own. There is no ambient context, no automatic retrieval before a turn,
   no prompt preloading, no turn-end summarising, no automatic note writing.
2. **Every vault access is request-scoped.** A turn whose prompt does not ask about the knowledge base must not touch the
   vault at all — no reads, no searches, no writes, no "helpful" backlink lookup.
3. **The bridge is a reference for every agent in every workspace, not a per-project symbiote.** It carries no per-agent
   identity, no session state, no automatic project association. The project is a parameter of a call, never something
   inferred from `cwd` on its own.
4. **Writes require an explicitly named target.** The instruction names the document (or names a project inbox); the tool
   validates that target and appends to it. The plugin never chooses where knowledge goes, never creates a note the user
   did not ask for, never edits, moves, renames or deletes.
5. **`memory-flash` and `luck-planner` keep their current behaviour.** This plugin does not change their injection, does
   not read or write their data, does not re-route what belongs to them, and does not claim their content. Their skills and
   prompts stay as they are.
6. **No skill is installed or activated automatically.** Any `SKILL.md` the plugin ships is opt-in, passive, and repeats
   this contract. An agent without that skill still behaves correctly, because the contract lives in the tool
   descriptions, not in a skill file.
7. **Injection is cheap and inert.** `agent.open.before` adds a `mcpServers` entry (or native tool definitions) and
   nothing else: no env vars, no probing of Obsidian during session open, no filesystem scan, no cwd changes, no latency in
   the path that opens an agent. All vault work happens later, inside a tool call, on the plugin's own queue.
8. **Read-only is the default posture for planning flows.** Search/read/outline/list are always allowed when asked for;
   the write tool is separately switchable (`readOnly` per vault) and can be disabled without touching the read path.

The registry of "who owns what" follows from this and must be reflected in every tool description:

| Question the user asks | Owner |
| --- | --- |
| "What did we decide?", "how did we fix this?", "hand this to another agent" | `memory-flash` |
| "Plan this project", "what are the next tasks", goal/leaf bookkeeping | `luck-planner` |
| "Look in my Obsidian notes", "what does the document/plan/recommendation say", "find the source I should cite", "write this guide into Obsidian" | `obsidian-bridge` (only because it was asked for) |

---

## 3. Positioning: three different instruments

`memory-flash` is the most important plugin for the agents: it is where an AI agent accompanies its own working life.
`luck-planner` is the project planning tree that turns goals into coding tasks. `obsidian-bridge` is an external reference
library that any agent may consult or contribute to **when a human says so**.

| | `memory-flash` | `obsidian-bridge` | `luck-planner` |
| --- | --- | --- | --- |
| Role in the agent's life | Symbiont — continuous, always on | Reference — on explicit request only | Planning scaffold for one project |
| Content | Facts, decisions, procedures, handoffs, pitfalls made *during* work | Human-authored documents, plans, recommendations, research, guides | Tech-stack root, trunks, branches, leaves, goals, incidents |
| Author | Agents write constantly, unattended | Humans; agents append only when told, to a named document | Agents, under the tree's rules |
| Storage | Its own SQLite with revisions | The user's vault — Markdown stays the source of truth | Its own SQLite tree |
| Write model | Create/update/revise/tag/restore | Explicit target, append only | Add/update leaves, statuses, audit trail |
| Read model | Search memory by tag/project/kind | Hybrid retrieval over notes/headings with citations, wikilink graph | Tree queries, dashboard |
| Activation | Automatic, every agent | Explicit instruction in the prompt | Automatic, per project |
| Failure if missing | The agent forgets what it learned | The agent plans from assumptions instead of the user's documents | Work loses structure and traceability |

Consequences for design, stated once and then applied:

- The bridge must **not** install a "always search the vault first" skill; that is `memory-flash`-style symbiosis.
- The bridge must **not** observe turns to capture knowledge; that belongs to `memory-flash` (and, for human-facing guides,
  to an explicit append).
- `luck-planner` planning that needs a source reads the vault *inside the same explicit request*, then records the note
  path as the leaf's source.

---

## 4. Paseo side: what the plugin builds on

Plugins are trusted, unsandboxed code with two runtimes: `index.client.tsx`/`client/` in the app,
`index.server.ts`/`server/` as a daemon subprocess (Node APIs, filesystem, network, credentials), and `shared/` for Zod
contracts. Source: <https://paseo.sh/docs/plugins/reference>.

| Capability | API | Use in `obsidian-bridge` |
| --- | --- | --- |
| Inject an MCP server into agents | `server.addHook("agent.open.before", …)`, `request.mcpServers` | Availability only (§2.7). Re-applied on each session open, including resume after a daemon restart. |
| Native tools without MCP | `defineAgentTool({ name, description, input: z…, execute })` in the same hook, `request.tools` | Same tools for providers without MCP support. |
| Naming rules | `/^[a-z][a-z0-9_]*$/`, ≤ 64 chars, no collision with Paseo or other plugins | Prefix `obsidian_`. |
| Host settings | `server.registerSettings()` / `defineSettings` | Vault path, include/exclude, `readOnly`, embedding provider, enrichment URL + token. |
| Typed RPC | `defineRpc` (shared) + `server.handle` + `useRpc` | Search, status, reindex, preview; the plugin process owns the index. |
| UI | `addSurface`+`addSidebarItem`, `addWorkspacePanel`, `addCommandCenterItem`, `addComposerPill` | Knowledge-base panel, attach-note pill, reindex action. |
| Attachment source | `defineAttachmentSource` + a search RPC | Attach a note as a text snapshot to a prompt — the most "explicit" form of use there is. |
| Packaging | `paseo-plugin.json` `build` + `mcp.entry`, one esbuild bundle | Same shape as `memory-flash`, `bunny-search`, `luck-planner`. |

Constraints that shape the design:

- MCP injection is launch-only and re-runs per session open; a settings change reaches an existing agent on its next idle
  prompt (`paseo.agents.ref(id).reload()` forces it). A provider without MCP support **fails the session open** if
  `mcpServers` is injected for it — injection must be skipped there and replaced by native tools.
- Hooks have a 30 s timeout and an abort `signal`; indexing must never be awaited from a hook (and per §2.7 must not be
  started from one either).
- MCP bundles cannot use the plugin API, so the bundle reads a mirrored `settings.json` (the `bunny-search` pattern: the
  host store is authoritative, the plugin mirrors it atomically on startup and on every change).

Environment verified on this machine: Node `v24.20.0`, npm `12.0.2`, `sqlite3` CLI `3.46.1`, Obsidian installed at
`/opt/Obsidian/obsidian` (symlinked from `/usr/bin/obsidian`), no `ollama` in `PATH`. The installed Obsidian version could
not be read from `/opt/Obsidian/resources/app/package.json`; it decides whether the official CLI (1.12.7+) exists, so
`obsidian_status` probes for it instead of assuming.

---

## 5. Obsidian access surfaces

### 5.1 Direct filesystem (vault on disk) — the base

A vault is a folder of `.md` files plus attachments and `.obsidian/`. Everything observable is derivable: YAML
frontmatter, `#tags`, `[[wikilinks]]`, `![[embeds]]`, callouts, inline `key:: value`.

- Always available, including when Obsidian is closed; microsecond reads; ordinary writes.
- No Obsidian link resolution, no block-ID resolution, no Dataview execution, no plugin metadata, nothing render-time.
- No ETags; `.obsidian/` must never be touched.

This is the only path that works headless and the cheapest path for indexing, so it is the base rather than a fallback.

### 5.2 Local REST API with built-in MCP (`coddingtonbear/obsidian-local-rest-api`)

- HTTPS `127.0.0.1:27124` (self-signed generated CA), optional plain HTTP `27123`. Bearer token; failed auth throttled.
- `/vault/{path}` CRUD, heading/block/frontmatter targeting, `/active/`, `/search/simple/` (fuzzy, scored snippets,
  `maxResults`), `/search/` (JsonLogic), `/tags/`, `/commands/`, `/open/{path}`, `/events/vault/{event}/` SSE, `/mcp/`.
- **Conditional writes**: `ETag` + `If-Match` → `412`; `If-None-Match: *` create-only. Note JSON carries `links`,
  `backlinks`, `unresolvedLinks`, `tags`, `stat`, `version`.
- `.obsidian/` refused with `403`.
- **Constraint: the app must be running.** Version split: 5.0.x needs Obsidian 1.13.1+, community directory pinned to
  4.1.7 — probe `GET /` (`versions`, `apiExtensions`, `listeningSince`) and adapt.

### 5.3 Official Obsidian CLI (1.12+)

`obsidian read|create|append|search|search:context|daily:append|files|…`, enabled in **Settings → General → Command line
interface**. Requires the running app; index-aware; one process per call; young and still changing.

### 5.4 Out of scope

Third-party MCP servers (REST wrappers inherit §5.2's constraint; filesystem ones duplicate this plugin's own index),
`obsidian-headless`/Headless Sync (needs a subscription the owner does not have), the `obsidian://` URI scheme (opens a
file, returns nothing), remote vaults and multi-vault registries.

---

## 6. Architecture, stage A (local vault, Obsidian running)

### 6.1 Shape

```
obsidian-bridge/
├── index.server.ts        # settings, agent.open.before injection (inert), RPC handlers, index lifecycle
├── index.client.tsx       # surface, sidebar item, ⌘K items, settings screen
├── shared/                # zod contracts: RPCs, settings, note/chunk/search types
├── server/
│   ├── vault.ts           # vault root, path safety, include/exclude, frontmatter parse
│   ├── parse.ts           # headings, tags, wikilinks/aliases/anchors, inline fields, chunking
│   ├── store.ts           # SQLite schema/migrations, FTS5, tags, links, embeddings, meta
│   ├── indexer.ts         # full scan, fs.watch + reconcile, queue, progress
│   ├── search.ts          # signals, RRF fusion, token-budgeted packing
│   ├── embed.ts           # local model (Transformers.js) in a worker thread + provider adapters
│   ├── write.ts           # explicit-target append, target validation, conflict handling
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
   manually). Every tool call reads the SQLite index and/or the vault files; nothing happens without a call (§2.2).
2. **Vault → index.** The plugin process watches the vault and keeps the index current; the bundle and the plugin open the
   same SQLite file in WAL mode (the multi-consumer pattern `memory-flash` uses).
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
indexing runs on a queue owned by the plugin process, started by the plugin lifecycle — never by an agent hook and never
by a tool call that was not asked for.

### 6.3 Retrieval

Signals, each ranking chunk ids, fused with Reciprocal Rank Fusion — the pattern already proven in `memory-flash`:

1. chunk BM25 (exact names, IDs, error strings, code),
2. title/alias/first-heading BM25,
3. structured filters applied before ranking (`project:`, `tags:`, `folder:`, `since:`),
4. vector similarity (0.3.0),
5. **graph proximity**: 1–2 hop wikilink expansion from the top lexical hits (one SQL join),
6. small recency/folder boost.

Output is packed into a token budget (default ~2 000): whole top chunks, then neighbouring chunks from the same note, each
hit carrying note path, heading path and backlink count, so an agent can cite `Projects/x/Research/y.md § Heading`. A
separate `obsidian_read` returns a full note or one section on demand — this is what a "quote me the plan" request lands on.

**Embeddings (0.3.0).** Local, in-process default: `@huggingface/transformers` with
`Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 d, 50+ languages, ~120 MB quantized, CPU, cached after first run) or
`Xenova/multilingual-e5-small` (needs `query:`/`passage:` prefixes). Optional dependency, loaded lazily in a worker thread;
absent model ⇒ lexical-only, stated in `obsidian_status`. A provider block (Ollama / LM Studio / OpenAI-compatible
`/v1/embeddings`) stays available but off by default.

**No `sqlite-vec`.** 20 000 notes ≈ 150 000 chunks × 384 d × 4 B ≈ 230 MB; pruning to ~2 000 lexical candidates and doing
brute-force cosine in JS is tens of milliseconds. Avoids `node:sqlite`'s blocked `loadExtension` on Node 22 and any
install-time compilation. Adding `sqlite-vec` later is a local change behind the same interface.

### 6.4 Writes: explicit target, append only

The write tools exist so an agent can do what a human asked for in words — "write this guide into my Obsidian project X" —
and nothing more.

- `obsidian_append_note` takes a **required** `target`: a vault-relative note path, or a project alias that resolves to
  `Projects/<slug>/Inbox.md`. No target, no write. There is no implicit "this project's inbox" derived from `cwd`.
- The tool validates the target inside the vault, rejects `.obsidian/`, rejects anything outside the configured write
  allowlist, and creates the note **only** when the caller passed an explicit `create: true` and the path matches the
  configured naming rules.
- Append is append-only: `## <ISO date> — <short title>` plus the body, then a blank line. Never rewrites, never reorders,
  never deletes. No patch, no move, no rename, no delete tool exists at all.
- Atomic append: open with `O_APPEND`, single write, `fsync`, then verify the marker is still present. If Obsidian saved a
  stale buffer over it, retry once, then return an explicit conflict result carrying the exact text — nothing is lost
  silently.
- Dedup: identical body hash within 24 h is reported as `duplicate` and skipped.
- Caps: `readOnly` per vault switches every write tool off; default 32 KiB per append, rejected above that with a pointer to
  split the note; no writes while the index is mid-rebuild.

### 6.5 Obsidian enrichment (optional, app running)

Never required for correctness, only for better answers:

- `obsidian_outline` prefers REST note JSON for authoritative `links`/`backlinks`/`unresolvedLinks`/`tags` and falls back
  to the parsed tables.
- `/search/simple/` or `obsidian search` results join the fusion as an extra signal, weighted below BM25.
- `/events/vault/{event}/` SSE triggers targeted reindex instead of a full reconcile.
- "Open note in Obsidian" in the panel uses `/open/{path}` or `obsidian open`.

A single `ObsidianEnrichment` adapter probes `GET /` lazily (on first use, cached, short timeout) and degrades to
`{ available: false, reason }`. It is never probed from `agent.open.before` (§2.7).

### 6.6 Agent-facing tools

| Tool | Purpose |
| --- | --- |
| `obsidian_search` | Hybrid search; filters `project`/`tags`/`folder`/`since`; `limit`, `budget`. Ranked chunks with path + heading path + snippet. |
| `obsidian_read` | Read a note, one heading subtree, or one frontmatter field. |
| `obsidian_outline` | Headings, block IDs, frontmatter keys, tags, links, backlinks, unresolved links. |
| `obsidian_list` | Notes/folders under a prefix with an optional frontmatter filter. |
| `obsidian_links` | Resolved links and backlinks for a note or a folder map. |
| `obsidian_append_note` | Append to an explicitly named note or project inbox (`create: true` required to create). |
| `obsidian_index` | Reindex a path or the whole vault; returns counts and duration. |
| `obsidian_status` | Vault, index freshness, embedding model, enrichment availability, `readOnly`, write allowlist. |
| `obsidian_diagnose` | Later (0.3.0): recall@k over a control query set, like `memory-flash`'s diagnostics. |

Every tool description carries the §2 contract in one sentence — "reference tool, call it only when the user asks about
their Obsidian notes" — because the description is the only thing an agent always sees. The same
operations are defined with `defineAgentTool` for providers without MCP.

### 6.7 Paseo UX

- **Sidebar surface "Knowledge base"**: index status/freshness, search box, note preview with backlinks, reindex button.
- **Composer pill / attachment source**: attach a note as a text snapshot — the most explicit way for a human to pull vault
  content into a prompt.
- **⌘K**: "Search knowledge base", "Reindex vault".
- **Settings screen**: vault path, include/exclude globs, write allowlist, `readOnly`, embedding provider/model, enrichment
  URL + token (host settings only, never logged, never sent to agents), probe result.
- **Optional `SKILL.md`**: opt-in, passive, repeats §2 and the ownership table; nothing is installed or enabled
  automatically, and no skill is needed for correct behaviour.

---

## 7. Stage B: local vault, Obsidian closed

### 7.1 What actually breaks when the app is not running

| Capability | With app | Without app |
| --- | --- | --- |
| Full-text + vector search over the index | works | **works** |
| Reading notes, outlines, links (parsed) | works | **works** (authoritative backlinks downgrade) |
| Indexing / watching | works | **works** |
| Append to an explicit target | works | **works** (filesystem path) |
| Obsidian fuzzy-search signal in fusion | works | silently absent |
| Authoritative backlinks/unresolved links | works | parsed approximation |
| "Open note in Obsidian" | works | disabled |

Stage B is not a second transport — everything that matters is already filesystem-based; only enrichment and conveniences
touch the app.

### 7.2 What stage B adds

1. A `transport` seam from day one: `readNote`, `readSection`, `outline`, `links`, `append`, `enrichment`. Stage A
   implements every method on the filesystem; the REST adapter overrides `outline`/`links`/`enrichment`/`append`
   (ETag-protected) when available.
2. Append conflict recovery: detect a stale-buffer overwrite (marker missing), retry once with backoff, then return the
   exact text plus a `conflict` flag; a panel action re-appends after human confirmation.
3. Health reporting: `obsidian_status` distinguishes "index live, enrichment down" from "vault unreachable"; the panel shows
   a muted "Obsidian not running — enriched features unavailable" row instead of an error.
4. Deferred reconcile: one bounded pass on first tool call after a gap.

Estimated size: ~250–350 LoC plus tests, **1.5–2 days**.

---

## 8. Is the no-app fallback worth building?

**Yes, but only because the base is already filesystem-first — and not before stage A works.** If Obsidian is meant to run
permanently, the temptation is to make REST the mandatory path; that is the expensive branch: an HTTP indexer plus probing,
retries, TLS and version negotiation, slower by orders of magnitude on a full scan, and search that dies with the GUI.
Filesystem indexing is *less* code and always available.

With the app closed, exactly two optional things degrade: the Obsidian fuzzy-search signal and authoritative backlinks.
Search, read, outline, list, indexing and append keep working.

Estimated share of the whole plugin (calendar days of focused work):

| Piece | Estimate |
| --- | --- |
| Index, parsing, chunking, store, watch/reconcile | 4–5 d |
| Lexical + graph retrieval, fusion, packing | 2–3 d |
| MCP bundle, inert injection, native tools, settings | 2–3 d |
| Explicit-target append + conflict handling | 1–1.5 d |
| Embeddings + hybrid + diagnose | 2–3 d |
| UI (panel, pill, settings, ⌘K) | 2–3 d |
| Stage B hardening (§7.2) | 1.5–2 d |
| Tests, docs, packaging, compatibility matrix | 3–4 d |
| **Total** | **~18–24 d**, of which the fallback is **~9 %** |

Two caveats: a "permanently running" app is a habit, not a guarantee (update, crash, OOM, reboot without autostart), and a
knowledge base an agent cannot cite from because a GUI is closed is a bad failure mode for a citation tool. Stage B also
buys **testability**: the index and retrieval are exercised in CI with no Obsidian at all, which stage A needs regardless.

What must *not* be built: a parallel HTTP-first implementation, an Obsidian-required search path, a remote vault registry
with tunnels, anything depending on an Obsidian Sync subscription.

---

## 9. Plan

### Stage A — local vault, Obsidian running

**0.1.0 — index and read.**
Vault path in settings with include/exclude; full scan; parsing (frontmatter, headings, tags, wikilinks/aliases/anchors,
inline fields); chunking by headings; SQLite + FTS5 + tags + links; `fs.watch` + reconcile; tools `obsidian_search`
(lexical + graph + recency, RRF), `obsidian_read`, `obsidian_outline`, `obsidian_list`, `obsidian_links`, `obsidian_index`,
`obsidian_status`; **inert** MCP injection via `agent.open.before` (no probing, no scan, no env); native tools for non-MCP
providers; tool descriptions carrying the §2 contract. **Status: shipped in 0.1.0** (see [README.md](./README.md),
[__doc.md](./__doc.md)).
*Acceptance:* on this machine's real vault, 20 hand-picked control queries return the right note in the top 3; a full index
completes in seconds and stays current after an external edit; opening an agent adds no measurable latency and starts no
vault I/O; an agent in a new workspace can answer "what does my note X say" when asked.

**0.2.0 — explicit-target append.**
`obsidian_append_note` with a required target (path or project alias), `create: true` requirement, write allowlist,
`readOnly`, atomic append with marker verification, dedup, caps. *Acceptance:* the tool refuses a missing target and any
path outside the allowlist; two concurrent appends do not interleave; an append survives Obsidian having the note open;
no other write tool exists in `tools/list`.

**0.3.0 — semantic layer.**
Optional local model, worker-thread embedding, incremental embedding of changed chunks, vector signal in fusion,
`obsidian_diagnose` with recall@k over the control queries. *Acceptance:* recall improves measurably over lexical-only, or
the stage is documented as not worth its cost; lexical search keeps working with the model absent.

**0.4.0 — Paseo UI and Obsidian enrichment.**
Sidebar panel (status, search, preview, backlinks), attachment source, ⌘K items, settings screen; REST adapter for
authoritative backlinks/tags, fuzzy-search signal, SSE-driven reindex, "open in Obsidian". *Acceptance:* every enrichment
feature degrades to its filesystem equivalent with a one-line note, never an error.

### Stage B — local vault, Obsidian closed

**0.5.0 — fallback hardening.** Transport seam completed, append conflict recovery, deferred reconcile, status diagnostics,
documentation of what degrades. *Acceptance:* with Obsidian fully stopped, search/read/outline/list/append all work; the
panel states what is degraded; restarting Obsidian restores enrichment without a plugin reload.

**1.0.0 — release.** Consolidation, README, `__doc.md`, `__compatibility.md`, compatibility table entry.

Versioning per repository rules: patch digit for fixes and changes to existing behaviour, minor digit for new functionality,
major digit on an explicit "release", with an annotated `<plugin>@<version>` tag per bump.

---

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| The bridge drifts into a symbiote (auto search, auto write) | §2 as review checklist; tool descriptions state it; no turn hooks exist in the manifest; acceptance tests assert a quiet turn makes no vault I/O. |
| Agent writes outside the requested target | Required target, allowlist enforced in the handler (not the prompt), no create without `create: true`, no edit/move/delete tools. |
| Obsidian closed → enrichment gone | Base is filesystem; §7. |
| Obsidian saves a stale buffer over an appended note | Marker verification, one retry, explicit conflict result, reconcile-based recovery. |
| Token leakage (REST key) | Host settings only; never in plugin files, agent env, logs or tool output. |
| Index drift after edit bursts | Debounced watch + periodic mtime/size/hash reconcile; freshness in `obsidian_status` and the panel. |
| Embedding model change | `model id` + dim in `index_meta`; changing it marks vectors stale and rebuilds in the background. |
| Context flooding from big notes | Token-budgeted packing, chunk snippets by default, whole note only on explicit read. |
| Vault growth making brute-force vectors slow | Prune to lexical candidates; `sqlite-vec` behind the same interface past ~100 k notes. |
| Hook timeout during open | Injection only appends a config entry; indexing runs on the plugin's queue. |
| Enrichment probe hang | Lazy, short timeout, cached result, every enrichment call skippable. |

---

## 11. Remaining questions

1. Vault path (entered once in settings; nothing was scanned from disk in this research).
2. Is the project-alias convention `Projects/<repo-dir-name>/` acceptable for resolving an inbox when the user names a
   project, with manual overrides in settings?
3. Should the inbox template be a fixed default or reuse an existing note as a template?
4. Is Obsidian ≥ 1.12.7 installed (official CLI) and is the Local REST API plugin present, or does 0.4.0's enrichment stay
   unbuilt for now?
5. Default append cap of 32 KiB per call — sufficient?

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
