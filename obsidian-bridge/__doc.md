# Obsidian Bridge — technical documentation

Internal design, verified behaviour and the roadmap of the `obsidian-bridge` plugin. User-facing description:
[README.md](./README.md). Research and decisions: [__research.md](./__research.md).

Version covered: **0.3.0**.

## 1. Purpose and scope

Give Paseo agents read access to a human-authored Obsidian knowledge base — documents, plans, recommendations, research —
with note paths and headings as citations, without turning the vault into agent memory and without making an agent consult
it on its own.

The operating contract (`__research.md` §2) is the specification this implementation is judged against:

1. availability is not initiative — the tools are injected so an agent *can* answer a request;
2. every vault access is request-scoped — a turn that does not ask touches nothing;
3. the bridge is a reference for every agent and every workspace, with no per-agent identity or state;
4. writes need an explicitly named target and stay inside one of the configured roles;
5. `memory-flash` and `luck-planner` keep their current behaviour and data;
6. no skill is installed automatically; the contract lives in tool descriptions;
7. injection is cheap and inert — no probe, no scan, no env, no cwd change in the open path;
8. read-only is the default posture.

## 2. Architecture

```
obsidian-bridge/
├── index.server.ts          # settings, indexer lifecycle, inert agent.open.before hook, RPC handlers
├── index.client.tsx         # screen, sidebar item, settings screen, ⌘K items
├── shared/
│   ├── settings.ts          # defineSettings schema + runtime subset
│   ├── contracts.ts         # zod value types + plugin RPC contracts (defineRpc)
│   └── host-fonts.ts        # host Appearance settings parsing (client-safe, copied from memory-flash)
├── server/
│   ├── paths.ts             # $PASEO_HOME, plugin data dir, per-vault index path
│   ├── dirs.ts              # role map (workspace/inbox/out/raw), append-only writer
│   ├── memory.ts            # RSS policy: silent < 2 GB, warning 2–4 GB, never a limit
│   ├── embed/
│   │   ├── local.ts         # @huggingface/transformers provider (e5-small, q8, batch 1)
│   │   ├── query.ts         # lazy query model + idle unload, injectable for tests
│   │   └── job.ts           # spawns/tracks the short-lived embedding process
│   ├── embed-worker.ts      # child entry: writes vectors, exits, returns its memory
│   ├── parse.ts             # frontmatter, headings, chunking, tags, wikilinks, aliases
│   ├── vault.ts             # path safety, walking, include/exclude globs, note reading
│   ├── store.ts             # SQLite schema, FTS5, tags/links/aliases, link resolution, search SQL
│   ├── scan.ts              # one reconciliation pass (shared by indexer and the obsidian_index tool)
│   ├── search.ts            # RRF fusion and token-budgeted packing
│   ├── indexer.ts           # watch + reconcile timer + status (plugin process only)
│   ├── mcp-tools.ts         # tool definitions, directory guide, dispatch
│   ├── mcp-server.ts        # standalone stdio MCP server (bundled to dist/mcp-server.js)
│   ├── mcp-launch.ts        # node + dist/mcp-server.js resolution
│   ├── settings-file.ts     # settings reader for the spawned server (file + env, no zod)
│   ├── settings-mirror.ts   # atomic write of the mirror file
│   ├── agent-record.ts      # best-effort read of an agent's saved mcpServers
│   ├── session-open.ts      # pure injection decision
│   └── agent-tools.ts       # attached fallback tools (defineAgentTool)
├── client/
│   ├── surface.tsx          # knowledge-base screen
│   ├── settings-screen.tsx  # every setting, validated in place
│   ├── use-host-typography.ts, web.ts
└── scripts/bundle-mcp-server.mjs
```

### Data flow

1. **Vault → index (plugin process).** `VaultIndexer` scans the vault at startup (only when `vaultPath` is set), watches it
   with a debounced `fs.watch`, and reconciles every `reconcileMinutes` for events a watcher can miss.
2. **Index → agent (agent process).** An agent spawns `dist/mcp-server.js`; each tool call opens the vault's SQLite file,
   answers, and closes it. Note bodies are re-read from disk, so a note is never quoted from a stale index.
3. **Index → UI (plugin process).** The panel and the settings screen call plugin RPCs; only the plugin process touches the
   indexer.
4. **Settings → MCP bundle.** The host owns the settings store; the plugin mirrors it to
   `$PASEO_HOME/plugins/obsidian-bridge/settings.json` on startup and on every change (atomic temp file + rename), because
   the spawned server cannot use the plugin API.

### Why the index lives outside the vault

`$PASEO_HOME/plugins/obsidian-bridge/vaults/<vaultId>/index.db`, keyed by a 12-hex SHA-1 of the vault path. It never
pollutes the note tree, never syncs, survives plugin updates, and deleting it only costs a rescan.

## 3. Index

Schema (SQLite, WAL, `busy_timeout = 5000` so the plugin and agent processes can share the file):

| Table | Contents |
| --- | --- |
| `notes` | path, title, folder, mtime, size, hash, frontmatter JSON, word count, indexed_at |
| `chunks` | note path, ordinal, heading path, text |
| `chunks_fts` | FTS5 over chunk text + heading, `rowid` = `chunks.id` |
| `notes_fts` | FTS5 over title + aliases, `rowid` = `notes.rowid` |
| `tags` | (path, tag, source) |
| `aliases` | (path, alias) from `aliases:`/`alias:` |
| `links` | source, raw target, resolved target, alias, anchor, kind (`link`/`embed`) |
| `meta` | schema version, tokenizer, last scan timestamp |

Deliberately no triggers: `upsertNote`/`deleteNote` maintain the FTS rows explicitly, which keeps the "delete everything for
this path, then reinsert" step atomic inside one transaction and avoids stale FTS entries after a rename.

Tokenizer: `unicode61 remove_diacritics 2`, or `porter unicode61 remove_diacritics 2` when `ftsStemming` is on. The choice
is recorded in `meta`; a change wipes the derived tables so the next scan rebuilds them (the tokenizer is baked into the
FTS schema).

### Parsing (`server/parse.ts`)

- Frontmatter: a small YAML subset — scalars, `[a, b]` inline lists, `- item` block lists, quoted strings. That covers
  `title`, `tags`, `aliases`, `project`, `status`; anything more elaborate stays a raw string and is still served.
- Code fences are stripped before tag/link extraction, so `#notATag` inside a snippet never becomes a tag.
- Tags: frontmatter `tags`/`tag` plus inline `#tag`, normalized, purely numeric tags rejected (Obsidian does the same).
- Wikilinks: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target^block]]`, `![[embed]]`.
- Chunking: one chunk per heading section, with the heading path (`Top › Child`); sections over 1200 characters are split
  on blank lines, and a single oversized paragraph is hard-split. Citations therefore carry a heading, not just a file.

### Link resolution

`resolveLinks()` runs after every scan and after every watch batch. It builds three maps — exact path (with and without
`.md`), basename, alias — and resolves every `[[target]]` in one pass. Ambiguous basenames stay **unresolved** instead of
guessing, and `obsidian_links` reports them; a deleted note nulls the links that pointed at it.

## 4. Retrieval

`server/search.ts`, RRF with `k = 60`:

| Signal | Weight | Source |
| --- | --- | --- |
| Heading chunks | 1.0 | `chunks_fts` BM25 |
| Titles / aliases | 0.7 | `notes_fts` BM25 |
| Wikilink proximity | 0.45 | one-hop neighbours of the top 5 lexical hits |
| Recency | 0.25 | `notes` by mtime (empty-query browse path) |
| Semantic | 0.9 | cosine over the stored chunk vectors (0.3.0, optional) |

The semantic signal embeds the query in the same process that serves the tool (lazy, ~10 ms once the model is warm),
ranks every stored chunk of the active model by cosine similarity and contributes the top 40 to the same RRF map. It is
additive: with no vectors, semantic search off, or a model that fails to load, the list is exactly the lexical + graph
result and `structuredContent.semantic.error` says why.

Filters (`folder`, `tags`) are applied to the candidate set before truncation. The final list is packed into
`searchBudgetChars` (default 8000), each hit rendered as `[n] path § Heading (backlinks: k)` plus a snippet trimmed to
`snippetChars`. Hits whose text does not fit stop the packing, so an agent never receives a half-sentence.

`toFtsQuery` lowercases the query, keeps `\p{L}\p{N}_-` tokens, quotes each and joins with `OR`: recall first, ranking by
BM25 afterwards. An empty query lists recent notes — the "show me what I was working on" path.

## 5. Tools

Definitions in `server/mcp-tools.ts`, shared by the stdio server, the attached agent tools and the tests:

`obsidian_directories`, `obsidian_search`, `obsidian_read`, `obsidian_outline`, `obsidian_list`, `obsidian_links`,
`obsidian_write_document`, `obsidian_write_scratch`, `obsidian_append_inbox`, `obsidian_index`, `obsidian_diagnose`,
`obsidian_status`.

`obsidian_diagnose` measures recall@k over cases the caller supplies (`{query, expected_paths}`), for lexical and for
hybrid retrieval, so "semantic helps here" is a measurement rather than a claim. Without cases it reports vector
coverage and how to measure.

The MCP `initialize` instructions embed the resolved role map (`mcpInstructions(dirs)`), so an agent asked to write a
document is told which directory that document belongs to before it calls anything.

### Directory roles (`server/dirs.ts`)

`vaultPath` is the single directory the plugin may touch; it is either a vault root or a project directory inside one.
Three roles are vault-relative paths under it: `inboxDir` (incoming material), `outDir` (authored documents) and
`rawDir` (scratch). Normalization rejects absolute paths, `..` segments and `.obsidian`, so a role can never point above
the configured directory. `roleOfPath` matches the most specific role (raw → out → inbox → workspace), and every hit,
listing entry and status snapshot carries its role.

Read tool safety: every path goes through `resolveInsideVault`, which resolves paths lexically, refuses anything outside
the vault root, and refuses `.obsidian/` (plugin code and settings are not the agents' business). The `folder` argument of
`obsidian_list` and `obsidian_search` goes through the same `normalizeRoleDir` used for the role directories, so `..`, an
absolute path or `.obsidian` is refused instead of being used as a `LIKE` prefix. A path like `../../etc/passwd` returns an
explicit error, covered by tests.

### Write tools

`obsidian_write_document` (out), `obsidian_write_scratch` (raw) and `obsidian_append_inbox` (inbox) share one
implementation, `appendToNote`:

- `normalizeDocumentName` accepts a nested name (`guides/queues`), adds `.md`, and refuses absolute names, `..`
  segments, control characters, names over 200 characters and empty names **before** any path is built;
- an existing note is appended to (`## <date> — <title>` section); nothing is rewritten, moved or deleted;
- a missing note is created only with `create: true`, with `title`/`kind`/`created`/`source` frontmatter, using
  `flag: "wx"` (`O_EXCL`) so a note created concurrently by the user is appended to instead of overwritten;
- an identical body already present is reported as a duplicate and skipped;
- `readOnly` and `maxWriteChars` are enforced in the dispatcher, before any filesystem work;
- the append itself is one `O_APPEND` write, so concurrent appends cannot clobber each other's offset; the section is
  then read back from the file's tail, and if Obsidian replaced the file with a stale buffer in between, the append is
  repeated once. When it still cannot be confirmed, the tool returns an error instead of claiming success.

`obsidian_index` runs the same `scanVault` the indexer runs, so tool and background indexes cannot diverge.

### Attached agent tools

`obsidian_bridge_directories`, `obsidian_bridge_search`, `obsidian_bridge_read`,
`obsidian_bridge_write_document`, `obsidian_bridge_write_scratch`, `obsidian_bridge_append_inbox`,
`obsidian_bridge_diagnose`, `obsidian_bridge_status` — `defineAgentTool` definitions attached through `request.tools`
when the MCP server cannot be contributed. The prefix cannot collide with Paseo built-ins, another plugin, or this server's own MCP tool names.

## 6. Injection (the only hook)

`server.addHook("agent.open.before")` — nothing else is registered: no `agent.create.before`, no turn hooks, no
`agent.turn.after`, no permission hooks.

Decision table (`server/session-open.ts`, unit-tested):

| Condition | Result |
| --- | --- |
| `injectIntoAgents` off | nothing |
| `purpose: "history"` | nothing |
| Saved config already has `obsidian-bridge` | nothing (and no duplicate tool) |
| Provider has no MCP support | attached tools |
| Agent record missing/unreadable | attached tools |
| Provider capabilities unknown | attached tools |
| Otherwise | MCP server injection |

The daemon is consulted (`agents.ref(id).refresh()` for `capabilities.supportsMcpServers`) **only** when an MCP
contribution is still possible; every other branch is decided without a round trip. A saved-name collision would abort the
session open, which is why `server/agent-record.ts` reads the record the daemon persists.

Nothing in this hook touches the vault: no `fs` call, no Obsidian probe, no environment change. A test asserts the indexer
stays idle without a path; the hook itself only reads settings and the agent record.

## 7. Settings

`shared/settings.ts` (`defineSettings`, host scope, version 3):

| Key | Default | Meaning |
| --- | --- | --- |
| `vaultPath` | `""` | The one directory available to Paseo (a vault root or a project directory inside one). Absolute paths, `~` and paths relative to the home directory are accepted; `resolveVaultRoot` turns them into one absolute path for the plugin host and for the MCP server, whose working directories differ. Empty = not configured: no scan, tools explain how to configure. |
| `inboxDir` | `Inbox` | Vault-relative incoming-material role. Empty = role disabled. |
| `outDir` | `Documentation` | Vault-relative authored-documents role. |
| `rawDir` | `raw` | Vault-relative scratch role. |
| `indexingEnabled` | `true` | Pause indexing without clearing the path. |
| `includeFolders` | `""` | Comma-separated vault-relative folders. |
| `excludeGlobs` | `.obsidian/**, .trash/**, .git/**, .smart-env/**` | Comma-separated globs, `*`/`**` supported. |
| `ftsStemming` | `false` | `porter` tokenizer (English-only); changing it triggers a rebuild. |
| `reconcileMinutes` | `10` | Background reconcile interval. |
| `maxResults` | `10` | Default hit limit. |
| `searchBudgetChars` | `8000` | Packed answer budget. |
| `snippetChars` | `600` | Snippet length per hit. |
| `readOnly` | `false` | Refuse every write tool; reads unaffected. |
| `maxWriteChars` | `200000` | Cap for one written body. |
| `semanticSearch` | `true` | Local embedding signal in search. |
| `embeddingModel` | `Xenova/multilingual-e5-small` | Hugging Face repo with ONNX weights. |
| `embeddingDtype` | `q8` | ONNX dtype: `q8` ≈ 118 MB, `fp32` ≈ 470 MB. |
| `embeddingIdleMinutes` | `10` | Unload the query model after this idle time; `0` keeps it. |
| `injectIntoAgents` | `true` | Contribute MCP server or attached tools. |

`README.md`'s "First run" is the only configuration entry point: a Paseo settings screen, no side-channel HTTP server.
That choice is deliberate (19 keys, all simple), and it matches `bunny-search`/`memory-flash`. The settings schema
version is 3: role directories and `maxWriteChars` came in 0.2.0 (`readOnly` defaults to `false` since the write tools
exist), and 0.3.0 added the four semantic keys. If the setting
count grows past what a form can hold (per-vault registries, credentials, index diagnostics), a loopback panel like
`remote-control`'s console becomes the better home — the RPC layer already isolates that decision.

The vault path is validated by the `obsidian-bridge.verify-vault` RPC before it is saved: exists, is a directory, carries
`.obsidian`, and a bounded walk (5000 files) reports how many Markdown files were found plus a sample. A path with zero
notes is reported as an error in the UI; the plugin still saves what the user typed, but indexing produces an empty index
and the panel says so.

## 8. Not shipped yet (roadmap)

| Version | Work |
| --- | --- |
| 0.2.0 (shipped) | Directory roles (workspace/inbox/out/raw) with the root as a hard boundary, append-only write tools to `out`/`raw`/`inbox`, role tags on hits and listings, `maxWriteChars`, `readOnly`. |
| 0.3.0 (shipped) | Optional local embeddings (`@huggingface/transformers`, multilingual e5-small q8), vectors in SQLite, semantic signal in fusion, `obsidian_diagnose` recall@k, memory policy in status. |
| 0.4.0 | Obsidian-side enrichment via the Local REST API plugin (authoritative backlinks, fuzzy-search signal, SSE-driven reindex, "open in Obsidian"), composer attachment source, workspace panel. |
| 0.5.0 | Fallback hardening with Obsidian closed (conflict recovery, degraded status), per `__research.md` §7. |
| after 1.0 | Stronger local models (fp32 / larger multilingual encoders) and external RAG providers behind explicit settings; only when the Paseo/Node base genuinely cannot meet a requirement (`__research.md` §12.4). |

Embeddings and vectors were deliberately left out of 0.2.x: the design is documented in `__research.md` §4.3 and §12, and
the lexical + graph path proves its recall with `obsidian_diagnose`.

The 0.3.0 spike is done (`__research.md` §12). Measured on this vault (1 684 chunks): q8 e5-small loads in ~1.4 s,
embeds the whole vault in ~151 s (batch 1 is 3–4× faster than batching), query embedding is ~10 ms, a full cosine scan
is ~2.5 ms, and peak RSS is ~1.1 GB that `dispose()` does not return — so a full scan belongs in a short-lived child
process, not in the daemon, and the model cache must be moved out of the plugin checkout.

## 9. Verification

`npm test` (64 tests, 8 suites, ~0.7 s) plus `npm run typecheck` (`tsc -b`, three project references):

- `tests/parse.test.ts` — frontmatter subset, tag/link extraction, heading chunking, oversized sections.
- `tests/store.test.ts` — FTS over English and Russian text, title ranking, backlinks, path/basename/alias resolution,
  unresolved links, deletion cleanup, graph neighbours.
- `tests/mcp-tools.test.ts` — the tool catalogue is read-only and carries the explicit-use contract; search/filters/read/
  outline/list/status/index against a temporary vault; path escape refused; missing-vault message.
- `tests/indexer.test.ts` — idle without a path, scan, changed/added/removed notes, bad path error, include folders.
- `tests/session-open.test.ts` — the injection decision matrix and probe conditions.
- `tests/directories.test.ts` — role normalization (absolute paths, `..`, `.obsidian`), most-specific role matching,
  document-name validation, append-only creation/appending, duplicate detection, `readOnly`/`maxWriteChars` refusal, role
  tags and `scope` filters, refused writes above the root, refused `folder` arguments that would leave the root, whole-
  segment folder matching, a required inbox `name`, and `resolveVaultRoot` for `~`/home-relative paths.
- `tests/semantic.test.ts` — vector storage round-trip and invalidation, semantic fusion finding a note with no lexical
  overlap, the injected provider path through `obsidian_search`/`obsidian_status`, graceful fallback when the model cannot
  load, per-call opt-out, `obsidian_diagnose` recall, and the 2 GB / 4 GB memory levels.
- `tests/mcp-server-e2e.test.ts` — spawns the built `dist/mcp-server.js`, speaks JSON-RPC over stdio, indexes, searches,
  reads a heading, writes a document into `out`, and checks a path escape is refused.

Tests build their own temporary vault and `PASEO_HOME`; nothing touches a real vault, index or daemon home.

## 10. Operational notes

- Plugin logs: `paseo plugin logs obsidian-bridge`. The indexer logs scan/batch messages to stdout, the MCP server logs to
  stderr.
- A slow first scan is expected on a large vault (one read + parse per note, ~5 000 notes/second on a warm cache in local
  tests). Reindexing is safe at any time.
- `index.db` is disposable: delete it and run `obsidian_index` (or restart the plugin) to rebuild.
- Writes are append-only and confined to the `inbox`/`out`/`raw` roles. There is no tool that edits, moves, renames or
deletes a note, and `readOnly` switches every write off.
- Embedding model cache: `$PASEO_HOME/plugins/obsidian-bridge/models` (not inside the checkout, which `paseo plugin update`
  replaces). First semantic run needs network; afterwards it is offline.
- A full re-embedding runs in its own process (`dist/embed-worker.js`) and peaks around 1.1 GB for 1 684 chunks, which
  leaves with the process. The query model stays in the MCP process only while used and unloads after
  `embeddingIdleMinutes`.
- Memory policy: silence below 2 GB, a warning in the panel and in `obsidian_status` between 2 and 4 GB, and never a hard
  limit. A full reindex of a very large vault may be isolated in a transient `systemd --user` unit instead of the daemon.

## 11. Review passes (0.2.1, 0.3.1)

### 0.3.1

- **A forced scan wiped every vector.** `scanVault({force:true})` re-upserted every note, and `upsertNote` recreates the
  chunks, so the embeddings of unchanged notes were deleted — every plugin restart would re-embed the whole vault. The
  scan now compares the content hash and skips unchanged notes even when forced; `force` only bypasses the mtime/size
  shortcut. Regression test: a forced scan leaves the vector count and the embedding queue untouched.
- **`dist/` now carries `{"type":"module"}`.** Both bundles are ESM; without it Node auto-detected the module type and
  printed a warning into the plugin log on every embedding run.

### 0.2.1

A fresh read of the 0.2.0 code found one setup bug and one boundary gap, both fixed here; no new functionality, so the
patch version moved 0.2.0 → 0.2.1.

- **A relative `vaultPath` silently disabled indexing.** `path.resolve(".obsidian/Main/Paseo")` depended on the working
  directory of whichever process read it (plugin host or agent-spawned MCP server), so a perfectly reasonable value never
  reached the scan. All reads of the path now go through `resolveVaultRoot` (absolute, `~`, home-relative).
- **`folder` was not validated.** `obsidian_list` passed it straight into a `LIKE` prefix and `obsidian_search` even did a
  bare `startsWith(folder)`, so `Inbox` matched `Inbox-old/…` and `..` was accepted as a folder. Both now use
  `normalizeRoleDir` and whole-segment matching; escaping values are refused with an error.
- **Write path simplification.** Removed the duplicated size cap in `appendToNote` (one owner: the dispatcher), the
  `isWritableRole` helper that was always true, the unused `options` parameter of `openRuntime`, the dead `writeRoles`
  status field and the dead `directoryGuide` call in the status agent tool. `obsidian_directories` no longer opens (and
  therefore creates) the index database just to report configuration.
- **Race hardening.** Creation uses `O_EXCL` and falls back to appending when the note appeared concurrently; the append
  is one `O_APPEND` write followed by a read-back of the file tail, retried once and then reported instead of the previous
  size comparison that could not distinguish a stale-buffer overwrite.
- **`obsidian_append_inbox` requires `name`.** The inbox is the user's; there is no default `Inbox.md` to silently collect
  agent text.
