# Obsidian Bridge — technical documentation

Internal design, verified behaviour and the roadmap of the `obsidian-bridge` plugin. User-facing description:
[README.md](./README.md). Research and decisions: [__research.md](./__research.md).

Version covered: **0.5.5**.

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
│   ├── attachments.ts       # composer attachment source + search RPC (0.4.0)
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
│   ├── indexer.ts           # watch + reconcile timer + enrichment lifecycle + status
│   ├── obsidian-api.ts      # optional Local REST API client: probe, fuzzy search, note JSON, open, SSE
│   ├── enrichment.ts        # enrichment lifecycle + fuzzy signal with failure cache
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
│   ├── workspace-panel.tsx  # compact tab: status, search, preview, open in Obsidian
│   ├── settings-screen.tsx  # every setting, validated in place
│   ├── use-host-typography.ts, web.ts
└── scripts/bundle-mcp-server.mjs
```

### Data flow

1. **Vault → index (plugin process).** `VaultIndexer` scans the vault at startup (only when `vaultPath` is set), watches it
   with a debounced `fs.watch`, and reconciles every `reconcileMinutes` for events a watcher can miss.
2. **Index → agent (agent process).** An agent spawns `dist/mcp-server.js`; each tool call opens the vault's SQLite file,
   answers, and closes it. Note bodies are re-read from disk, so a note is never quoted from a stale index.
3. **Index → UI (plugin process).** The screen, workspace tab, attachment picker and settings screen call plugin RPCs;
   only the plugin process touches the indexer.
4. **Optional Obsidian enrichment.** The plugin process probes the Local REST API once per configuration, follows vault
   events when it answers, and the MCP process adds Obsidian's fuzzy search to retrieval when it is reachable. No note text
   leaves the machine: the API is a loopback service in the same vault.
5. **Settings → MCP bundle.** The host owns the settings store; the plugin mirrors it to
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
| `embeddings` | chunk id, note path, model id, dimension, text hash, vector BLOB (0.3.0) |
| `meta` | schema version, tokenizer, last scan timestamp |

Deliberately no triggers: `upsertNote`/`deleteNote` maintain the FTS rows explicitly, which keeps the "delete everything for
this path, then reinsert" step atomic inside one transaction and avoids stale FTS entries after a rename.

Tokenizer: `unicode61 remove_diacritics 2`, or `porter unicode61 remove_diacritics 2` when `ftsStemming` is on. The choice
is recorded in `meta`; a change wipes the derived tables so the next scan rebuilds them (the tokenizer is baked into the
FTS schema).

### Incremental indexing and vectors

`notes.hash` is a SHA-1 of the whole file; `scanVault` re-parses only notes whose hash differs, even when `force` is set
(`force` only skips the mtime/size shortcut). Vectors are keyed by chunk id and every note write recreates its chunks, so
`upsertNote` snapshots the note's vectors by `text_hash` before deleting them and re-attaches each one to a new chunk with
byte-identical text. Editing one section therefore re-embeds only that section, plus anything the edit split or merged;
`chunksToEmbed` is exactly the set of chunks with no vector for the active model. A model change deletes the other
model's vectors in the worker before it embeds, and a note removed from the walk loses its chunks and vectors.

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

Each signal contributes `weight / (k + rank)`: ranks only, never raw BM25 or cosine values, so BM25's unbounded scale and
cosine's [-1, 1] are never calibrated against each other. A note can accumulate rank contributions from several of its
chunks. This is the same fusion `memory-flash` uses.

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

## 6. Injection (two hooks + provider config files)

A third, non-hook path covers providers Paseo cannot inject into: `server/opencode-mcp.ts` writes
`mcp.obsidian-bridge = {type: "local", command: [node, dist/mcp-server.js], enabled: true, timeout: 20000}` into
`~/.config/opencode/opencode.json` (and the Kilo equivalent, only when its config directory exists), preserving every
other key and refusing to rewrite a file that is not plain JSON. The entry is refreshed on load and on every settings
change, and removed when `registerOpencodeMcp` is off or the plugin stops. `agentConfigCoversProvider` then makes both
hooks stand down for that provider: a launch-only or saved duplicate is refused by Paseo's shared-service check.

- `server.addHook("agent.create.before")` — writes the stdio server into the new agent's **saved** `config.mcpServers`
  (`alwaysLoad: true`), gated by `injectIntoAgents`. This is the only hook whose change Paseo persists with the agent, and
  the only one that works for a provider whose session has not started yet.
- `server.addHook("agent.open.before")` — re-contributes the server on every later open (resume after the idle-runtime
  release, refresh, import) and falls back to attached tools where MCP is unavailable.

No turn, permission, workspace or worktree hooks are registered.

Decision table for `agent.open.before` (`server/session-open.ts`, unit-tested):

| Condition | Result |
| --- | --- |
| `injectIntoAgents` off | nothing |
| `purpose: "history"` | nothing |
| `reason: "create"` | nothing — `agent.create.before` already saved the server |
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

`shared/settings.ts` (`defineSettings`, host scope, version 4):

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
| `obsidianApiEnabled` | `false` | Optional Local REST API enrichment (fuzzy signal, authoritative backlinks, live events, open in app). |
| `obsidianApiUrl` | `https://127.0.0.1:27124` | Local REST API base URL. Self-signed TLS is accepted for loopback hosts only. |
| `obsidianApiKey` | `""` | Bearer token for that API. Mirrored in a `0600` settings file; never logged. |
| `injectIntoAgents` | `true` | Contribute MCP server or attached tools. |
| `registerOpencodeMcp` | `true` | Write an `obsidian-bridge` entry into the OpenCode and Kilo config files (only for a config directory that exists), and remove it again when the switch is off or the plugin stops. |

`README.md`'s "First run" is the only configuration entry point: a Paseo settings screen, no side-channel HTTP server.
That choice is deliberate (19 keys, all simple), and it matches `bunny-search`/`memory-flash`. The settings schema
version is 4: role directories and `maxWriteChars` came in 0.2.0 (`readOnly` defaults to `false` since the write tools
exist), 0.3.0 added the four semantic keys, and 0.4.0 added the three enrichment keys. If the setting
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
| 0.3.1, 0.3.2 (shipped) | Forced-scan fix and per-chunk vector reuse (an edit re-embeds only changed sections); secrets and encryption-at-rest documented in §12. |
| 0.4.0, 0.4.1 (shipped) | Optional Local REST API enrichment (fuzzy signal, authoritative link metadata, SSE vault events, "Open in Obsidian"), composer attachment source, workspace panel. |
| 0.4.3 (shipped) | Created agents receive the MCP server through `agent.create.before`, so a new OpenCode/Cline agent has the Obsidian tools on its first turn. |
| 0.4.4 (shipped) | `obsidian_status` reports the plugin's real vault-event subscription state instead of `events: false`. |
| 0.5.4, 0.5.5 (shipped) | OpenCode/Kilo config-file registration, so those agents get the tools where Paseo cannot inject a server. |
| 0.5.0 | Fallback hardening with Obsidian closed (conflict recovery, degraded status), per `__research.md` §7. |
| after 1.0 | Stronger local models (fp32 / larger multilingual encoders) and external RAG providers behind explicit settings; only when the Paseo/Node base genuinely cannot meet a requirement (`__research.md` §12.4). |

Embeddings and vectors were deliberately left out of 0.2.x: the design is documented in `__research.md` §4.3 and §12, and
the lexical + graph path proves its recall with `obsidian_diagnose`.

The 0.3.0 spike is done (`__research.md` §12). Measured on this vault (1 684 chunks): q8 e5-small loads in ~1.4 s,
embeds the whole vault in ~151 s (batch 1 is 3–4× faster than batching), query embedding is ~10 ms, a full cosine scan
is ~2.5 ms, and peak RSS is ~1.1 GB that `dispose()` does not return — so a full scan belongs in a short-lived child
process, not in the daemon, and the model cache must be moved out of the plugin checkout.

## 9. Verification

`npm test` (75 tests, 9 suites, ~0.8 s) plus `npm run typecheck` (`tsc -b`, three project references):

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
- `tests/semantic.test.ts` — vector storage round-trip and invalidation, reuse of unchanged chunks' vectors when a note
  is edited, semantic fusion finding a note with no lexical overlap, the injected provider path through `obsidian_search`/`obsidian_status`, graceful fallback when the model cannot
  load, per-call opt-out, `obsidian_diagnose` recall, and the 2 GB / 4 GB memory levels.
- `tests/enrichment.test.ts` — the Local REST API client against a fake loopback server: probe and version, rejected key,
  fuzzy search ranking, note JSON links/backlinks, open, SSE events, unreachable host; fuzzy fusion that surfaces a note
  with no lexical overlap, ignores paths outside the index, and degrades to lexical search when Obsidian is down.
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

## 11. Review passes (0.2.1, 0.3.1, 0.3.2, 0.4.1, 0.4.3, 0.4.4, 0.5.4, 0.5.5)

### 0.5.5

- **0.5.4's settings version bump invalidated every stored document.** Raising `version` to 5 made the host report the
  existing document (version 4, without `registerOpencodeMcp`) as invalid, the plugin fell back to the mirrored file for
  runtime settings, and the registration gate read "off" — so the new entry was immediately removed again. The version
  stays at 4: a stored document without the new key validates to its schema default. The gate now also defaults to on
  when the store is unreadable, matching the schema, so a broken document cannot silently take the tools away.

### 0.5.4

- **An OpenCode agent never saw the Obsidian tools in Paseo 0.15.4.** Two host behaviours conspired: a saved MCP server on
  an OpenCode agent is refused when the shared OpenCode service is registered (`Custom OpenCode MCP servers … require an
  isolated server`), so the daemon reports `supportsMcpServers: false` and the launch-only contribution is skipped; and
  OpenCode does not surface Paseo's attached tools. The plugin now registers its server in the agents' own config files
  (`~/.config/opencode/opencode.json` → `mcp.obsidian-bridge`, same format for Kilo), the way `memory-flash` reaches the
  same agents. `agentConfigCoversProvider` makes the decision skip a launch-only contribution for a covered provider, and
  `agent.create.before` no longer saves a server for one either. Files: `server/opencode-mcp.ts` (new), `index.server.ts`,
  `server/session-open.ts`, `shared/settings.ts` (version 5), settings screen; tests: `tests/opencode-mcp.test.ts`
  (7 cases: create, foreign keys preserved, stale entry refreshed, selective removal, commented file untouched, absent
  file, foreign providers) and the `configCovered` cases in `tests/session-open.test.ts`.

### 0.4.4

- **`obsidian_status` reported `events: false` while four vault streams were open.** The event subscriptions belong to the
  plugin process; every agent spawns its own short-lived stdio MCP server, which has none, so the status builder filled
  those two fields with literals. `EnrichmentService` now publishes `{events, lastEventAt}` to
  `$PASEO_HOME/plugins/obsidian-bridge/enrichment-state.json` on every transition (probe, subscription, each vault event,
  stop), and the MCP status reads that record — still only when the probe answers, so a closed Obsidian never reports
  live events. Files: `server/enrichment-state.ts` (new), `server/enrichment.ts`, `server/indexer.ts`, `server/mcp-tools.ts`;
  tests: `tests/enrichment-state.test.ts` (round-trip, data-directory location, absent record, corrupt record).

### 0.4.3

- **Agents created in Paseo never received the Obsidian tools.** `agent.open.before` fires for a new agent before Paseo
  writes its record, so the saved-configuration lookup returned `missing` and the decision took the attached-tools
  branch; once 0.4.2 let that branch through, the capability probe on a not-yet-started agent answered `null`, which fell
  back to attached tools again. OpenCode and Cline surface only MCP servers, so a freshly created agent saw no
  `obsidian_*` tools at all, while resumed agents kept working. Creation now goes through `agent.create.before` and is
  saved in the agent's own `config.mcpServers`; `agent.open.before` skips `reason: "create"` instead of racing the saved
  entry, and keeps handling every later open, where it still cannot inject when the record is unreadable or the provider
  has no MCP support (attached tools are the fallback there). Same pattern as `memory-flash`, `bunny-search` and
  `luck-planner` in this repository. Tests: `leaves creation to the create hook instead of failing on the absent record`,
  `asks the daemon only when an MCP contribution is possible`.
- **Verified live** on a real installation (Paseo 0.15.4, vault `/home/sirafim/.obsidian/Main/Paseo`, 80 notes,
  1 684 chunks): Local REST API 5.5.2 probe, `POST /search/simple/`, note metadata and four SSE event streams all answer;
  semantic coverage 1 684/1 684; `obsidian_diagnose` recall@5 1.0 lexical and hybrid.

### 0.4.1

- **Event subscriptions now send an always-true JsonLogic filter.** An empty rule is not guaranteed to match, which could
  have produced a healthy subscription that filtered every vault event out.
- **No reconnect loop for permanent failures.** A rejected key or an API without event routes (401/403/404/405) is
  reported once instead of retried every five seconds; the filesystem watcher keeps working.
- **Enrichment self-heals.** A probe that fails because Obsidian is closed is retried every 60 s, so starting Obsidian
  after the plugin no longer requires re-saving the settings.

### 0.3.2

- **A one-line edit re-embedded the whole note.** Vectors were keyed by chunk id and every note write recreates its chunks,
  so all vectors of the edited note were dropped. `upsertNote` now snapshots them by `text_hash` and re-attaches the ones
  whose text is byte-identical; only the changed section (and any re-split neighbour) goes back into the queue. Test:
  editing one of two sections leaves one pending chunk and keeps the other's vector.
- **Fusion audited against the linear-mixing failure.** `search.ts` already fuses ranks with RRF (`k = 60`) and never adds
  BM25 to cosine; the documentation now states that explicitly, together with why the weights exist.
- **Secrets are documented, not heuristically detected.** The indexer works on bytes on disk, so vault-side encryption
  (Inline Secret Block) already keeps plaintext out of the index; §12 records that contract and the owner's boundaries.

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

## 12. Secrets and privacy

The bridge indexes the vault **as it is on disk**. It has no key material, decrypts nothing, and sends no note text
anywhere: parsing, BM25, the ONNX model and the vectors are local, and `index.db` is a local file.

Hiding secrets is the vault owner's job. The recommended pattern is encryption in place, for example
[Inline Secret Block](https://github.com/vnrtmnv/obsidian-inline-secret-block): a ```` ```secret ```` fence is rewritten
on disk as ```` ```secret-lock ```` with an AES-256-GCM ciphertext body, and an inline `` `secret …` `` span becomes
`` `secret-lock <base64>` ``. Obsidian writes only the ciphertext into the `.md` file, so the bridge chunks, FTS-indexes
and embeds the ciphertext. The plaintext never enters the index, a snippet, an agent's context or a vector. To the parser
a `secret-lock` block is an ordinary fenced code block (fences are stripped only for tag/link extraction; chunk text keeps
them), which is why its base64 body appears as opaque text in a snippet.

Deliberately **not** implemented: secret detection, `private:`/`secret:` frontmatter redaction, and snippet masking. A
heuristic that misses one note is worse than a clear rule, and the owner already controls what is written to disk. A note
containing plaintext secrets is indexed like any other note.

Boundaries for notes that must not be indexed at all:

- keep them outside the directory available to Paseo (`vaultPath`),
- or outside `includeFolders`,
- or behind an `excludeGlobs` pattern (`Private/**, **/*.secret.md`).

The next scan deletes the rows of notes that no longer match, including their chunks and vectors.

Residual exposure belongs to the encryption plugin's threat model, not to the bridge: undo history, Obsidian File
Recovery, sync version history and filesystem backups can retain plaintext written before it was encrypted. A credential
that was ever synced in plaintext should be rotated.

## 13. Obsidian enrichment (0.4.0)

Optional, off by default, and never required for correctness. It uses the
[Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin in a running
Obsidian. When the app is closed or the key is wrong, every path falls back to the filesystem index and the status says
why.

| Feature | Endpoint | Used by |
| --- | --- | --- |
| Probe + version | `GET /` | indexer status, `obsidian_status`, settings "Test" |
| Fuzzy search signal | `POST /search/simple/?query=…&maxResults=…` | `obsidian_search`, panel search |
| Authoritative links | `GET /vault/{path}` with `Accept: application/vnd.olrapi.note+json` | `obsidian_outline`, panel preview |
| Open in app | `POST /open/{path}` | panel button (RPC) |
| Live vault events | `POST /events/vault/{create,modify,delete,rename}/` + SSE | indexer pending queue |

**Retrieval.** Obsidian returns note paths in its own ranking order. Each path that exists in the index contributes
`0.6 / (60 + rank)` to the same RRF map, i.e. a note-level signal below chunk BM25 (1.0) and semantic (0.9). Paths missing
from the index are dropped, so an excluded folder cannot leak back in. When the API fails, the fusion is exactly the
lexical + graph + semantic result and `structuredContent.enrichment` carries the reason.

**Failure policy.** Every call has a 1.5 s timeout. A search failure is cached per endpoint for 30 s, so a closed Obsidian
costs one timeout rather than one per agent query. The probe and event subscription run once per settings change, never in
`agent.open.before`.

**Events.** Each vault event is treated exactly like an `fs.watch` notification: the path (and `oldPath` on a rename) goes
into the same debounced pending queue, so targeted reindexing and vector reuse are unchanged. Streams reconnect with a 5 s
backoff; the filesystem watcher stays the primary mechanism.

**Credentials.** The URL and bearer token are host settings. The token is mirrored to the MCP settings file (mode `0600`),
never logged, and sent only to the configured URL. TLS verification is relaxed only for loopback hosts, because the plugin
generates its own CA; a non-loopback URL is validated normally.

**Paseo surface.** A workspace panel (`addWorkspacePanel`) offers status, search, preview and "Open in Obsidian"; an
attachment source (`defineAttachmentSource`) attaches one note to a prompt as a text snapshot (capped at 40 000 characters,
with an explicit truncation marker). Writes still go through the append-only filesystem tools; the REST API is never used
to modify notes.
