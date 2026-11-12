# obsidian-bridge — research and design proposal

Status: research only. No plugin code exists yet. Version numbering starts when the first implementation lands.

Scope of the investigation:

1. What Obsidian actually exposes to external clients (local vault on disk, official CLI, Local REST API + built-in MCP, third-party MCP servers, headless sync, custom URI scheme).
2. What Paseo exposes to a plugin that wants to give agents vault access (MCP server injection, native agent tools, RPC, lifecycle hooks, host-scoped settings, UI contributions).
3. A recommended way to give Paseo agents access to a knowledge base, including indexing and retrieval (RAG), and the operational conventions that keep project folders clean.

---

## 1. Paseo side: what a plugin can build on

Paseo plugins are trusted, unsandboxed code with two runtimes: `index.client.tsx`/`client/` runs in the app,
`index.server.ts`/`server/` runs as a daemon subprocess (Node APIs, filesystem, network, credentials). `shared/`
holds Zod contracts. Source: <https://paseo.sh/docs/plugins/reference>.

The capabilities that matter for a vault bridge:

| Capability | API | Use for `obsidian-bridge` |
| --- | --- | --- |
| Inject an MCP server into every agent | `server.addHook("agent.open.before", …)`, `request.mcpServers` | Give every Paseo-created agent the vault tools. The map is launch-only, plugin-local, accumulates across that plugin's callbacks, and re-applies on every session open, including sessions resumed after the daemon restarted. |
| Native tools without MCP | `defineAgentTool({ name, description, input: z…, execute })` + the same hook, `request.tools` | Providers that do not support MCP still get vault tools, delivered through Paseo's own tool transport. `execute` runs in the plugin process — no subprocess needed. |
| Regex-name rule | tool names match `/^[a-z][a-z0-9_]*$/`, ≤ 64 chars, must not collide with Paseo tools or another plugin | Prefix everything with `obsidian_`. |
| Per-agent gating | `request.labels`, `request.provider`, `request.metadata`, `request.cwd` | Only inject into agents that opted in, or always inject but expose a read-only profile per provider. |
| Host-scoped settings | `server.registerSettings()` / `defineSettings` | Vault paths, REST base URL, API key, index policy, embedding provider. |
| Typed RPC | `defineRpc` in `shared/`, `server.handle` in `index.server.ts`, `useRpc` in the client | Search, reindex, index status, note preview, vault selection — the plugin process owns the index, the UI only renders. |
| UI | `addSurface` + `addSidebarItem`, `addWorkspacePanel`, `addCommandCenterItem`, `addComposerPill` | A vault browser/search panel, "Attach note" composer pill, "Reindex vault" ⌘K action, a status row showing index freshness. |
| Attachment source | `defineAttachmentSource` + a search RPC | Attach a note (full text snapshot) to a prompt without typing a path. |
| Lifecycle observation | `agent.turn.after`, `agent.close.after`, `workspace.create.after` | Optional: after a turn, offer/auto-write a durable note ("what we learned") instead of a project file. |
| Existing project conventions | `<plugin>/paseo-plugin.json`, `build` steps, `mcp.entry` | Bundled stdio MCP server, exactly like `memory-flash` / `bunny-search` / `luck-planner` do. |

Relevant plugin-API constraints learned from the docs:

- MCP injection is **launch-only** and re-runs on each `agent.open.before`, so settings changes reach existing agents after the next idle prompt; `paseo.agents.ref(id).reload()` forces it immediately.
- A provider without MCP support fails the session open if a plugin injects `mcpServers` for it — injection must be skipped or replaced by native tools per provider.
- Hook timeout is 30 s, hooks receive an abort `signal` — no long indexing work inside a hook.
- Plugins are installed from Git with a per-directory source string; the repo convention is `npm ci` + `npm run bundle` at install time and a standalone `dist/mcp-server.js` bundle registered under `mcp.entry`.

Environment checked on this machine (2026-11-12): Node `v24.20.0`, npm `12.0.2`, Python `3.13.5`, `sqlite3` CLI `3.46.1`,
Obsidian installed at `/opt/Obsidian/obsidian` (symlinked from `/usr/bin/obsidian`), no `ollama` in `PATH`.

---

## 2. Obsidian side: the available access surfaces

### 2.1 Direct filesystem access (vault on disk)

A vault is a folder of `.md` files plus attachments and a configuration directory (`.obsidian/`). Everything observable
in the app is derivable from the files: YAML frontmatter, `#tags` and `#nested/tags`, `[[wikilinks]]` with aliases and
`#heading`/`^block` targets, `![[embeds]]`, callouts, and inline Dataview-style fields (`key:: value`).

- **Availability**: always, including when Obsidian is closed.
- **Latency**: microseconds for reads; writes are ordinary filesystem writes.
- **What you get**: raw truth. **What you don't**: Obsidian's own link resolution, block IDs resolution, Dataview query
  execution, plugin-provided metadata, and anything rendered (e.g. rendered Dataview tables are not in the file).
- **Conflict handling**: no ETags. A write during an active edit in the app can be clobbered by Obsidian's next save.
  Mitigate with read-modify-write on short windows, mtime+hash comparison, and appending rather than rewriting.
- This is the **only** option that works without a GUI session and without a plugin installed inside Obsidian.

### 2.2 Official Obsidian CLI (1.12+)

`obsidian <command>` ships with the desktop app since 1.12.0 (standard in 1.12.4, native binary since 1.12.7).
Enabled in **Settings → General → Command line interface**; on Linux it links `~/.local/bin/obsidian` or
`/usr/local/bin/obsidian`. Command families: `read`, `create`, `append`, `prepend`, `move`, `rename`, `delete`, `files`,
`folders`, `open`, `search`, `search:context` (grep-style with line context), `daily*`, `tasks`, `random:read`,
`properties`, `diff`/`history*`, plus developer commands.

- **Availability**: the app must be running; a command launches it if it is not (that is not headless).
- **Value**: it is *index-aware* — search uses Obsidian's own index, which the filesystem does not have.
- **Cost**: one process per call (tens to hundreds of ms), output is human-oriented text, and the CLI surface is young
  and still changing. Fit for a fallback/enrichment path, not the hot path.

### 2.3 Local REST API community plugin (with built-in MCP)

`coddingtonbear/obsidian-local-rest-api` — the de-facto standard bridge: REST + a built-in Streamable HTTP MCP server,
both served from inside the running app.

Facts that shape the design:

- HTTPS on `127.0.0.1:27124` (self-signed, generated CA, download `…/obsidian-local-rest-api.crt`), optional plain HTTP on
  `27123`. Bearer token from **Settings → Local REST API**. Failed-auth throttling per source address.
- Endpoints: `/vault/{path}` (GET/PUT/PATCH/POST/DELETE, plus MOVE/COPY), heading/block/frontmatter targeting
  (`/vault/note.md/heading/My%20Section`), `/active/`, `/search/simple/` (Obsidian fuzzy search, scored snippets,
  `maxResults`, `maxMatchesPerFile`), `/search/` (JsonLogic over frontmatter/tags/path/content), `/tags/`,
  `/commands/` + `/commands/{id}/`, `/open/{path}`, `/events/vault/{event}/` (SSE subscriptions), and `/mcp/`.
- **Conditional writes are first class**: `ETag` + `If-Match` → `412` on concurrent change, `If-None-Match: *` for
  create-only. This is the answer to the filesystem conflict problem.
- The configuration directory (`.obsidian/`) is refused (403) — good, it keeps agents away from plugin code and settings.
- MCP tools: `vault_list`, `vault_read`, `vault_read_binary`, `vault_write`, `vault_append`, `vault_patch`,
  `vault_delete`, `vault_move`, `vault_copy`, `vault_get_document_map`, `active_file_get_path`, `search_query`,
  `search_simple`, `tag_list`, `command_list`, `command_execute`, `open_file`, plus signed-URL helpers.
- **Hard constraint**: the app must be open. Closing Obsidian kills both the REST API and its MCP server.
- Version notes: 5.0.x requires Obsidian 1.13.1 (Catalyst early access at the time of writing); community-directory users
  are pinned to 4.1.7. A client must therefore probe `GET /` and adapt (`apiExtensions`, plugin version).

### 2.4 Third-party MCP servers

Two families:

- **REST-backed** (`MarkusPfundstein/mcp-obsidian`, `cyanheads/obsidian-mcp-server`, `proofsh/obsidian-mcp`): wrap the
  Local REST API plugin. They add ergonomics (section/heading/frontmatter edits, folder-scoped permissions, read-only mode)
  but inherit every constraint of §2.3, plus their own runtime (Bun/Node 24, or `uvx` for the Python ones). Notably
  `cyanheads` defaults to the HTTP port for simplicity and switches markdown-patch versions by plugin version.
  `proofsh/obsidian-mcp` is archived with an explicit verdict: *"routing through a REST API plugin adds unnecessary
  complexity — vaults are markdown files on disk"*.
- **Filesystem-backed** (`trsdn/obsidian-mcp`, `obra/knowledge-graph`, `obsidian-notes-rag`, `ncy08/obsidian-vault-search`,
  `sterben-enec/obsidian-semantic-memory`, `StepanchukYI/obsidian-semantic-search`): index the folder, expose search over
  MCP, no Obsidian process required. Several already implement hybrid BM25 + vector retrieval with `sqlite-vec`.

Conclusion: a generic third-party MCP server is a fine stopgap, but none of them is a Paseo plugin, none combines
"works when Obsidian is closed" with "writes that respect the app", and none follows this repository's conventions
(settings inside Paseo, agent gating, one bundle, RPC-driven UI).

### 2.5 Unavailable / niche routes

- **`obsidian://` URI scheme**: opens the app at a file; no read path, no search results back. Not usable for retrieval.
- **Obsidian Headless (`npm i -g obsidian-headless`, `ob login` / `ob sync`)**: open beta, requires an **Obsidian Sync**
  subscription, syncs a remote vault to a directory on a server without a GUI. It is not an API — but it is the cleanest
  way to get a vault onto a remote Paseo host (or CI), after which §2.1 applies. Note the vendor warning: do not run
  desktop Sync and Headless Sync on the same device.
- **Obsidian Publish / Sync HTTP APIs**: not documented for arbitrary content access. Out of scope.

---

## 3. Comparison for our use case

Criteria: (a) works with Obsidian closed, (b) read + write, (c) search quality, (d) works on a remote/headless Paseo host,
(e) setup cost, (f) conflict safety.

| Route | Closed app | Read/write | Search | Remote host | Setup | Conflicts |
| --- | --- | --- | --- | --- | --- | --- |
| Direct filesystem | yes | yes | own index needed | yes (if vault present) | none | mtime/hash only |
| Obsidian CLI 1.12+ | no (launches app) | yes | Obsidian index | no | enable in Settings | app-mediated |
| Local REST API + MCP | no | yes | Obsidian search + JsonLogic | yes, with tunnel/VPN | install plugin, copy token, trust CA | `ETag`/`If-Match` |
| Third-party MCP (REST) | no | yes | varies | yes | plugin + runtime | inherits REST |
| Third-party MCP (FS) | yes | yes | hybrid in some | yes | runtime + index | mtime only |
| Headless Sync | yes | read-mostly | none | yes | Sync subscription | one-sync-per-device |

Nothing on this list is sufficient alone. The right shape is a **layered transport** behind one plugin-owned interface,
with the index owned by the plugin rather than by Obsidian.

---

## 4. Recommendation

### 4.1 Layered transport, filesystem first

`obsidian-bridge` exposes one tool/RPC surface and three interchangeable backends, chosen per vault:

1. **`localfs` — default.** The vault path is readable on the daemon machine. Reads, writes, indexing, watching all go
   straight to disk. Works with Obsidian open or closed and on headless hosts.
2. **`rest` — remote Obsidian.** Base URL + bearer token for the Local REST API plugin. Used when the vault lives on
   another machine (laptop vault, server daemon), or when the user wants app-mediated writes with `ETag` protection.
   Prefer plain HTTP on loopback behind an SSH tunnel (`ssh -L 27123:127.0.0.1:27123 box`) over trusting a generated CA
   everywhere; that alone removes the certificate problem. Never bind the HTTP port to `0.0.0.0`.
3. **`cli` — optional enrichment.** If `obsidian` is on `PATH` and the app runs, `obsidian search`/`search:context`
   supplies Obsidian-index hits that are merged into the retrieval result. Degrades silently when unavailable.

`headless-sync` is documented as a deployment option rather than a transport: sync the vault to the daemon host with
`ob sync --continuous`, then use `localfs`.

Two rules that follow from the constraints above:

- **Never make a tool call depend on Obsidian running.** The index and all reads work offline; only `rest`/`cli` paths
  report a clear "Obsidian is not reachable" error with the fallback used instead.
- **Writes are write-through.** Local file first, then (if `rest` is configured for that vault) re-read via REST to confirm,
  or use REST directly when `If-Match` protection is wanted.

### 4.2 The plugin owns the index, not Obsidian

Index location: `$PASEO_HOME/plugins/obsidian-bridge/vaults/<vaultId>/index.db` (SQLite, WAL), one database per vault.
Keeping it outside the vault matters: it does not pollute the user's note tree, does not sync, and survives plugin updates.
Excluded paths: `.obsidian/`, `.trash/`, `.smart-env/`, `.git/`, `.obsidian-bridge/`.

Schema sketch:

| Table | Contents |
| --- | --- |
| `notes` | path, title, mtime, size, content hash, frontmatter JSON, word count, folder |
| `chunks` | note path, heading path, ordinal, text, token estimate, char range |
| `chunks_fts` | FTS5 external-content index over `text` + heading path, `tokenize='unicode61 remove_diacritics 2'` (works for Russian and English; `porter` stemming is English-only, so it is a per-vault option) |
| `tags` | note path, tag (normalized), inline vs frontmatter |
| `links` | source path, target path (resolved or `null`), raw target, alias, heading/block anchor |
| `embeddings` (optional) | chunk id, model id, dimension, vector BLOB |
| `index_meta` | schema version, model id, last full scan, last reconcile |

Incremental indexing: `fs.watch` (recursive, with a debounce of ~1.5–2 s) plus a periodic reconcile (default every 10 min)
that compares `mtime`+`size` and falls back to hashing. Deletions and renames are detected on reconcile; renames are
recognized by content hash so tags/links survive. A full rebuild is a Command Center action. Indexing must never run
inside a hook callback (30 s limit) — it runs on its own queue in the plugin process.

### 4.3 Retrieval: hybrid lexical + optional semantic, fused with RRF

This is the part worth doing properly, and the repository already contains the pattern: `memory-flash` ranks a pool with
several independent FTS5 views and fuses them with Reciprocal Rank Fusion, and reports recall@k through a
`memory_diagnose` tool instead of assuming quality. Reuse that approach rather than inventing another one.

Signals, each producing a ranked list over chunk ids:

1. **Chunk BM25** over `chunks_fts` — the workhorse, exact for names, IDs, error strings, code.
2. **Title/alias BM25** — filename, `aliases:` frontmatter, and the first heading; catches "the note called X".
3. **Tag/frontmatter filter** — structured narrowing (`project: paseo`, `kind: research`, `status: active`) applied
   before ranking, not after.
4. **Vector similarity** — optional, over the same chunks.
5. **Graph proximity** — 1–2 hop wikilink expansion from top lexical hits; this is what makes an Obsidian vault better
   than a folder of files. Cheap: one SQL join.
6. **Recency / folder boost** — small additive weight, configurable per vault.

Fusion: RRF with per-signal weights, then a second stage that packs results into a token budget: whole top chunks, then
neighbouring chunks from the same note, and for each hit the note path, heading path, tags, and the backlink count. The
agent gets a compact, citable payload, not a dump. A separate tool returns the surrounding note on demand.

**Embeddings — concrete recommendation.** Two complementary options, both optional, neither required for v1:

- **Local, no external service**: `@huggingface/transformers` (Transformers.js) with `Xenova/multilingual-e5-small` or
  `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dims, 50+ languages, ~120 MB quantized on first run, CPU). Runs
  in-process in the plugin subprocess; no Ollama, no API key, no network after the model is cached. Downside: install-time
  size and a one-off download, so it ships as an opt-in `npm` extra rather than a hard dependency of the plugin bundle.
- **User-provided provider**: Ollama (`/api/embeddings`), LM Studio, or OpenAI-compatible `/v1/embeddings`. One settings
  block, model id recorded in `index_meta`, re-embed on model change.

**Do not require `sqlite-vec`.** For a personal vault the maths is small: 20 000 notes → ~150 000 chunks × 384 dims ×
4 bytes ≈ 230 MB of vectors; a brute-force cosine over that is ~60 M multiply-adds, i.e. tens of milliseconds in plain JS,
and it can be pruned to the top ~2 000 lexical candidates before the vector pass, which makes it negligible. This avoids
native extension loading entirely — worth avoiding, because `node:sqlite` in Node 22 blocks `loadExtension` (documented in
several 2026 bug reports) and `sqlite-vec` needs either prebuilt platform packages or a compile step at install time.
If the vault ever grows past ~100 k notes, adding `sqlite-vec` behind the same interface is a local change.

**Where the embeddings live**: as a BLOB column in the same SQLite file, model id in `index_meta`. Restoring or moving an
index stays a single-file operation, consistent with `memory-flash`'s storage philosophy.

### 4.4 What the agents get

One bundled stdio MCP server (`dist/mcp-server.js`, esbuild, `mcp.entry` in `paseo-plugin.json`), injected through
`agent.open.before`, plus the same operations as `defineAgentTool` definitions for providers without MCP support.

| Tool | Purpose |
| --- | --- |
| `obsidian_search` | Hybrid search: `query`, optional `project`/`tags`/`folder`/`since` filters, `limit`, `budget`. Returns ranked chunks with path + heading path + snippet + scores. |
| `obsidian_read` | Read a note, or one heading subtree / frontmatter field (`path`, `heading`, `frontmatter`). |
| `obsidian_outline` | Headings, block IDs, frontmatter keys, tags, links, backlinks of a note. |
| `obsidian_list` | List notes/folders under a prefix with optional frontmatter filter. |
| `obsidian_links` | Resolved links and backlinks; `unresolved` listing to catch typos in wikilinks. |
| `obsidian_create` | Create a note with frontmatter (refuses to overwrite unless `overwrite: true`). |
| `obsidian_append` | Append to a note or under a heading; the safe default for agent writes. |
| `obsidian_patch` | Targeted edit: frontmatter key, heading subtree, block — the REST-compatible instruction shape. |
| `obsidian_move` / `obsidian_delete` | Rename/move (link-preserving option) and delete (to `.trash/`, never hard delete). |
| `obsidian_index` | Reindex a path/vault; returns counts and duration. |
| `obsidian_status` | Vaults, transport health (filesystem readable? REST reachable? CLI present?), index freshness, model id. |

Every tool takes an optional `vault` argument; with a single configured vault it is inferred. Write tools are gated by a
per-vault `readOnly` flag and a folder allowlist, mirroring the folder-scoped permissions idea from
`cyanheads/obsidian-mcp-server`.

### 4.5 Paseo-side UX (only after the tools work)

- **Sidebar surface "Knowledge base"**: index status per vault, search box with the same hybrid engine, note preview,
  backlinks, "open in Obsidian" (`/open/{path}` via REST or `obsidian open`), reindex button.
- **Composer pill / attachment source**: attach a note to the current prompt as a full text snapshot.
- **⌘K items**: "Reindex vault", "Create project note", "Search knowledge base".
- **Settings screen**: vault registry (path, transport, read-only, include/exclude globs), embedding provider, token field
  (stored in host settings, never logged), CLI detection result, index size.
- **Agent skill** (`SKILL.md`, installable like `memory-flash`'s): teaches the write policy — where notes go, which
  frontmatter fields to set, when to append instead of create, when *not* to write at all.

### 4.6 Keeping project folders clean

The user's second goal ("move working notes and research out of project folders") is a convention problem more than a
technical one. Proposed convention, enforced by the skill and by the write tools' defaults:

- One top-level folder per project: `Projects/<project>/`, with `Projects/<project>/Inbox.md` as the append target and
  `Projects/<project>/Research/` for distilled notes.
- Frontmatter written by the tools: `project: <slug>`, `kind: research|decision|handoff|note|reference`,
  `status: inbox|active|done`, `created: <date>`, `agents: [<agentId>]`, `source: <repo or URL>`.
- Note naming: `YYYY-MM-DD <slug>.md` for chronological material, `Topic — subtopic.md` for reference material.
- Raw dumps go to `Inbox.md` or `Research/raw/` with a "promote to distilled note" step; the plugin reports inbox size so
  it does not silently rot.
- Nothing is written into a project repository by the bridge itself; the skill tells agents to search the vault first and
  only fall back to a project file when the artifact must live next to the code.

---

## 5. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Obsidian is closed → REST/MCP route down | Filesystem transport is the default; REST is a per-vault option; `obsidian_status` explains which path is active. |
| Two writers (user editing + agent) | Prefer append/patch; `If-Match` when on REST; local mtime+hash check, refuse and re-read on mismatch; deletes go to `.trash/`. |
| Self-signed CA on the REST port | Prefer plain HTTP on loopback over an SSH tunnel; document `--cacert` for the HTTPS case; never expose `27123`/`27124` beyond loopback/VPN. |
| Token leakage | Token lives in Paseo host settings only, never in the plugin's files, never logged, never in agent env, never in tool output. |
| Index drift after external sync | Periodic reconcile by mtime+size+hash; index freshness shown in the panel and in `obsidian_status`. |
| Embedding model churn | `model id` + dimension stored in `index_meta`; changing it marks the vector column stale and rebuilds in the background, lexical search keeps working meanwhile. |
| Hook timeout | Indexing is queued in the plugin process, never awaited from `agent.open.before`. |
| Big vault → context flooding | Token-budgeted output, `maxResults`, chunk-level snippets by default, whole note only on explicit `obsidian_read`. |
| Plugin version churn inside Obsidian (4.1.7 vs 5.0.x) | Probe `GET /` (`versions`, `apiExtensions`, `listeningSince`) and pick the request shape from the reported version; markdown-patch version negotiated the same way. |

---

## 6. Phased implementation

- **0.1.x — filesystem skeleton.** Vault registry in settings; indexer (notes/chunks/fts5/tags/links) with watch + reconcile;
  `obsidian_search` (lexical + graph + recency, RRF), `obsidian_read`, `obsidian_outline`, `obsidian_list`,
  `obsidian_status`; MCP injection with label gating; native tools for non-MCP providers; `SKILL.md`. No writes yet.
- **0.2.x — writes.** `obsidian_create`/`append`/`patch`/`move`/`delete` with frontmatter defaults, read-only mode,
  folder allowlist, conflict detection and `.trash/` semantics.
- **0.3.x — REST transport.** Second backend behind the same interface: token field, `GET /` probe, `If-Match` writes,
  SSE events feeding the index instead of/in addition to `fs.watch`, SSH-tunnel guidance.
- **0.4.x — UI.** Sidebar surface (status + search + preview), attachment source, ⌘K actions, settings screen.
- **0.5.x — semantic layer.** Optional embeddings (Transformers.js first, provider block second), brute-force cosine over
  the pruned candidate set, `obsidian_diagnose` reporting recall@k over a control query set, like `memory-flash`.
- **1.0.0 — release.** Consolidation, documentation, compatibility matrix.

Versioning follows the repository rules (patch for fixes/changes, minor for new functionality, major on "release"), with an
annotated tag `<plugin>@<version>` per bump.

---

## 7. Open questions for the owner

1. Where does the primary vault live — this Linux machine (a path readable by the daemon), or a laptop reachable over the
   network? This decides whether `localfs` or `rest` is the default, and whether Headless Sync is relevant.
2. Is an Obsidian Sync subscription available (needed for `obsidian-headless` on a remote host)?
3. Should agents be allowed to create new notes in the vault freely, or only append to a single inbox note per project
   until a human promotes the note?
4. Is a ~120 MB local embedding model acceptable as an opt-in download, or should semantic search use an
   already-running provider (Ollama/LM Studio/OpenAI-compatible endpoint)?
5. Which existing plugin should the vault replace or complement — `memory-flash` (agent memory) or the project folders
   themselves? If `memory-flash` stays, the bridge should link notes to memory ids rather than duplicate them.

---

## 8. Sources

- Paseo plugin reference — <https://paseo.sh/docs/plugins/reference.md>
- Paseo plugin hooks (MCP injection, agent tools) — <https://paseo.sh/docs/plugins/hooks.md>
- Paseo MCP reference (tool injection policy) — <https://paseo.sh/docs/mcp>
- Local REST API with MCP — <https://github.com/coddingtonbear/obsidian-local-rest-api>, API docs
  <https://coddingtonbear.github.io/obsidian-local-rest-api/>
- Obsidian CLI — <https://obsidian.md/cli>, <https://help.obsidian.md/Extending+Obsidian/Obsidian+CLI>
- Obsidian Headless / Headless Sync — <https://obsidian.md/help/cli/headless>, <https://help.obsidian.md/sync/headless>
- REST-backed MCP servers — <https://github.com/MarkusPfundstein/mcp-obsidian>,
  <https://github.com/cyanheads/obsidian-mcp-server>, archived fork with the "just use the files" verdict:
  <https://github.com/proofsh/obsidian-mcp>
- Filesystem/hybrid MCP servers — <https://github.com/trsdn/obsidian-mcp>, <https://github.com/obra/knowledge-graph>,
  <https://github.com/proofsh/obsidian-notes-rag>, <https://github.com/ncy08/obsidian-vault-search>,
  <https://github.com/sterben-enec/obsidian-semantic-memory>
- In-app semantic indexes — <https://smartconnections.app/>, <https://github.com/StepanchukYI/obsidian-semantic-search>,
  <https://github.com/GoBeromsu/obsidian-open-connections>
- `sqlite-vec` — <https://github.com/asg017/sqlite-vec>, <https://alexgarcia.xyz/sqlite-vec/installation.html>;
  `node:sqlite` extension-loading limitation — <https://github.com/openclaw/openclaw/issues/66977>
