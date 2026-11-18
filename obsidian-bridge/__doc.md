# Obsidian Bridge — technical documentation

Internal design, verified behaviour and the roadmap of the `obsidian-bridge` plugin. User-facing description:
[README.md](./README.md). Research and decisions: [__research.md](./__research.md).

Version covered: **0.17.11**.

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
│   ├── citations.ts         # `[[note#heading|title]]` text for the composer control (0.9.11)
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
│   ├── plan/
│   │   ├── paths.ts         # planning root + plan-relative path barrier (0.11.11)
│   │   ├── scope.ts         # `plan_scope`: availability, projects, limits (0.11.11)
│   │   ├── tools.ts         # `plan_*` catalogue and dispatch (0.11.11)
│   │   ├── model.ts         # kinds, statuses, transitions, key order (0.11.12)
│   │   ├── frontmatter.ts   # YAML read/write with key order preserved (0.11.12)
│   │   ├── sections.ts      # generated body sections, kept `## Заметки` (0.11.12)
│   │   ├── snapshot.ts      # `<slug>.v<v>.r<r>.md` names and snapshot frontmatter (0.11.12)
│   │   ├── read.ts          # `plan_read`: tree in memory, overview, node context, beeCycle (0.12.11)
│   │   ├── search.ts        # `plan_search`: index narrowed to planRoot + frontmatter filters (0.12.11)
│   │   ├── write.ts         # create/update/status/history, snapshots, journal (0.13.11)
│   │   ├── journal.ts       # append-only `_journal.md` lines (0.13.11)
│   │   ├── links.ts         # `plan_link`: leaf-to-leaf influences (0.14.11)
│   │   ├── incident.ts      # `plan_incident`: blocks/blocks_by in sync both ways (0.14.11)
│   │   ├── goal.ts          # `plan_goal`: create/update/propose (0.14.11)
│   │   ├── growth.ts        # `plan_growth`: progress record on a node or goal (0.14.11)
│   │   ├── ops.ts           # move/archive/approve: op markers, link rewriting (0.15.11)
│   │   ├── restore.ts       # `plan_restore`: snapshot becomes a new revision (0.15.11)
│   │   ├── validate.ts      # `plan_validate`: links, bodies, roots, cycles, operations (0.16.11)
│   │   └── import.ts        # `plan_import`: luck_tree_export → folders, links, YAML (0.16.11)
│   ├── mcp-tools.ts         # tool definitions, directory guide, dispatch
│   ├── mcp-server.ts        # standalone stdio MCP server (bundled to dist/mcp-server.js)
│   ├── mcp-launch.ts        # node + dist/mcp-server.js resolution
│   ├── mcp-stable.ts        # stable bundle copy + healing older saved entries (0.9.11)
│   ├── injection.ts         # per-agent injection marker in agent metadata (0.9.11)
│   ├── write-gate.ts        # shared readOnly/maxWriteChars refusal (0.13.11)
│   ├── settings-file.ts     # settings reader for the spawned server (file + env, no zod)
│   ├── settings-mirror.ts   # atomic write of the mirror file
│   ├── agent-record.ts      # best-effort read of an agent's saved mcpServers
│   ├── session-open.ts      # pure injection decision
│   └── agent-tools.ts       # attached fallback tools (defineAgentTool)
├── client/
│   ├── surface.tsx          # knowledge-base screen
│   ├── workspace-panel.tsx  # compact tab: status, search, preview, open in Obsidian
│   ├── composer-item.tsx    # "insert note links for this prompt" control (0.9.11)
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
| `chunks` | note path, ordinal, heading path, text, callout type (`SCHEMA_VERSION` 3, 0.10.11) |
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
`obsidian_edit`, `obsidian_write_document`, `obsidian_write_scratch`, `obsidian_append_inbox`, `obsidian_index`,
`obsidian_diagnose`, `obsidian_status`.

`obsidian_diagnose` measures recall@k over cases the caller supplies (`{query, expected_paths}`), for lexical and for
hybrid retrieval, so "semantic helps here" is a measurement rather than a claim. Without cases it reports vector
coverage and how to measure.

The MCP `initialize` instructions embed the resolved role map (`mcpInstructions(dirs)`), so an agent asked to write a
document is told which directory that document belongs to before it calls anything; they also carry the full tool index
(name + title, generated from `MCP_TOOLS`), because a client may render only a truncated catalogue (§11, 0.8.10).

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

### Editing an existing note (`server/edit.ts`, 0.6.7)

`obsidian_edit` is the deliberate exception to role-scoped writing: a note the user filed outside `inbox`/`out`/`raw`
(project folders, a moved document, the workspace itself) could be read but never changed, which made the bridge useless
for "append a line to this report". It takes `path`, `old_text`, `new_text` and:

- resolves the path with `resolveInsideVault` (no absolute paths, no `..`, no `.obsidian`) and additionally compares
  `realpath` of the note with `realpath` of the root, so a symlink pointing outside the directory is refused;
- requires an existing regular file — it never creates a note (`create` stays the write tools' job);
- requires `old_text` to occur **exactly once**. Zero occurrences report "not found", several report the count and ask for
  more context: the tool never picks a place to edit. A CRLF note is retried with the fragment's line breaks converted,
  reported as `normalizedLineEndings: true`, so LF input from an agent still matches a Windows-written vault;
- rewrites only the matched span: everything else (frontmatter, other sections, untouched whitespace) is written back as
  read. Empty `new_text` deletes the fragment;
- is bounded by `readOnly`, `maxWriteChars` for both fragments and `MAX_NOTE_BYTES` (4 MiB) for the result;
- writes through a temp file and `renameSync`, after re-checking size and mtime against the initial read: if Obsidian saved
  the note meanwhile the edit is refused with "changed on disk while it was being edited" rather than overwriting the new
  content.

Since 0.10.11 a refusal is actionable: `suggestions` lists the closest text with line
numbers (or the occurrences of an ambiguous fragment), and `ignoreWhitespace` compares
after collapsing whitespace runs while keeping the exactly-once rule
(`server/fragment-match.ts`, §11).

Search reflects an edit once the plugin's indexer sees the file (the same path every other write takes); the MCP process
never writes the index itself.

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
change, and removed when `registerOpencodeMcp` is off (not on plugin shutdown — an update would otherwise take the
namespace away from a live OpenCode session). `agentConfigCoversProvider` then makes both
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
| `planRoot` | `Workspaces` | Vault-relative directory the `plan_*` tools are confined to (0.11.11). Resolved through `vaultPath`, so absolute paths, `..` and symlinks out of the vault are refused. Empty = planning not configured. |
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
| `installAgentSkill` | `true` | Install the four shipped skills (`obsidian-bridge`, `planning-create`, `planning-execute`, `planning-review`) into every agent skills directory that exists; verify and repair them on load, on a settings change and every five minutes; remove them when off. |
| `registerClineMcp` | `true` | Register the MCP server in `~/.cline/data/settings/cline_mcp_settings.json` (Cline ignores a stdio server from the session payload). |
| `registerOpencodeMcp` | `true` | Write an `obsidian-bridge` entry into the OpenCode and Kilo config files (only for a config directory that exists); keep it across plugin restarts and remove it when the switch is off. |

`README.md`'s "First run" is the only configuration entry point: a Paseo settings screen, no side-channel HTTP server.
That choice is deliberate (19 keys, all simple), and it matches `bunny-search`/`memory-flash`. The settings schema
version is 4: role directories and `maxWriteChars` came in 0.2.0 (`readOnly` defaults to `false` since the write tools
exist), 0.3.0 added the four semantic keys, and 0.4.0 added the three enrichment keys. 0.11.11 added `planRoot`:
a key with a default, so a stored document still validates and the schema version stays 4. If the setting
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
| 0.5.6 (shipped) | Read body in `structuredContent` (OpenCode showed none), and per-note fusion so a long export cannot outrank an exact match. |
| 0.5.7 (shipped) | Keep the config entry across plugin restarts, so an update no longer empties a live agent's tool namespace. |
| 0.6.7 (shipped) | `obsidian_edit`: exact-fragment edit of any existing note by vault path, outside the role writers. |
| 0.7.7 (shipped) | Agent skill shipped with the plugin and installed into existing agent skills directories. |
| 0.8.7 (shipped) | Cline MCP registration, enforced skill currency with repair, and a visible installation status in settings. |
| 0.8.8 (shipped) | Registrations are checked for an existing target and refreshed on the timer, so an update cannot leave a dead path. |
| 0.8.9 (shipped) | `migrate` hook on the settings definition, so a document from an older install opens instead of failing with "Settings version 2 requires a migration". |
| 0.8.10 (shipped) | The `initialize` instructions carry the full tool index, so a truncated tool catalogue cannot make an agent guess names. |
| 0.8.11 (shipped) | Paseo 0.16.0 compatibility pass: SDK pin `^0.16.0`, typecheck and 123 tests on SDK 0.16.0, live check on a 0.16.1 host, `agent.open.before` return contract confirmed; no code change. |
| 0.9.11 (shipped) | The four 0.16.0 recommendations: stable MCP bundle path with healing of older saved entries, live `status-stream` subscription in the panels, a composer control that inserts note citations, and a per-agent injection marker in agent metadata. |
| 0.10.11 (shipped) | Actionable `obsidian_edit` refusals (closest text with line numbers) and `ignore_whitespace`; callout types and Dataview inline fields; scan metrics in status; a quiet period before embedding; the Windows lock/`node.exe` half of the port audit. |
| next stage | **Obsidian Canvas** (§14): index `.canvas` node text and edges, teach the read path and the watcher the format, then a writing side so an agent can draw a canvas. Requirements and design are being collected; no code yet. |
| 0.5.0 | Fallback hardening with Obsidian closed (conflict recovery, degraded status), per `__research.md` §7. |
| after 1.0 | Stronger local models (fp32 / larger multilingual encoders) and external RAG providers behind explicit settings; only when the Paseo/Node base genuinely cannot meet a requirement (`__research.md` §12.4). |

Embeddings and vectors were deliberately left out of 0.2.x: the design is documented in `__research.md` §4.3 and §12, and
the lexical + graph path proves its recall with `obsidian_diagnose`.

The 0.3.0 spike is done (`__research.md` §12). Measured on this vault (1 684 chunks): q8 e5-small loads in ~1.4 s,
embeds the whole vault in ~151 s (batch 1 is 3–4× faster than batching), query embedding is ~10 ms, a full cosine scan
is ~2.5 ms, and peak RSS is ~1.1 GB that `dispose()` does not return — so a full scan belongs in a short-lived child
process, not in the daemon, and the model cache must be moved out of the plugin checkout.

## 9. Verification

`npm test` (119 tests, 14 suites, ~0.9 s) plus `npm run typecheck` (`tsc -b`, three project references):

- `tests/parse.test.ts` — frontmatter subset, tag/link extraction, heading chunking, oversized sections.
- `tests/store.test.ts` — FTS over English and Russian text, title ranking, backlinks, path/basename/alias resolution,
  unresolved links, deletion cleanup, graph neighbours.
- `tests/mcp-tools.test.ts` — the tool catalogue carries the explicit-use contract; search/filters/read/outline/list/
  status/index against a temporary vault; `obsidian_edit` on a role-less path, with `readOnly` and an escaping path refused;
  missing-vault message.
- `tests/edit.test.ts` — exact-fragment editing: role-less folder, multi-line and deletion, ambiguous/missing fragment,
  missing file, path and symlink escape, CRLF notes, no-op and size limits.
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
- Appends are confined to the `inbox`/`out`/`raw` roles. The one exception is `obsidian_edit`: an exact one-occurrence
  fragment replacement by vault path (0.6.7). No tool moves, renames or deletes a note, and `readOnly` switches every write
  off.
- Embedding model cache: `$PASEO_HOME/plugins/obsidian-bridge/models` (not inside the checkout, which `paseo plugin update`
  replaces). First semantic run needs network; afterwards it is offline.
- A full re-embedding runs in its own process (`dist/embed-worker.js`) and peaks around 1.1 GB for 1 684 chunks, which
  leaves with the process. The query model stays in the MCP process only while used and unloads after
  `embeddingIdleMinutes`.
- Memory policy: silence below 2 GB, a warning in the panel and in `obsidian_status` between 2 and 4 GB, and never a hard
  limit. A full reindex of a very large vault may be isolated in a transient `systemd --user` unit instead of the daemon.

## 11. Review passes (0.2.1, 0.3.1, 0.3.2, 0.4.1, 0.4.3, 0.4.4, 0.5.4, 0.5.5, 0.5.6, 0.5.7, 0.6.7, 0.7.7, 0.8.7, 0.8.8, 0.8.9, 0.8.10, 0.8.11, 0.9.11, 0.10.11, 0.11.11, 0.11.12, 0.12.11, 0.13.11, 0.14.11, 0.15.11, 0.16.11, 0.17.11)

### 0.17.11 — the three planning skills, and a skill list instead of one skill

Feature release (0.16.11 → 0.17.11), stage 8 of the migration. No new MCP tool: the change is what an agent is told, and
how many skill directories the plugin keeps current.

| Part | Behaviour |
| --- | --- |
| `skills/planning-create/SKILL.md` | the shape of a tree (root → one trunk level → branches → sub-branches → leaves), create in order, goals before work, `plan_import` instead of retyping, and the rule that only `plan_*` writes a plan file |
| `skills/planning-execute/SKILL.md` | the working loop: `plan_scope` → `plan_read` → `plan_set_status`/`plan_update_node`/`plan_growth`, `plan_link` and `plan_incident`, `plan_move_node`/`plan_archive_node` with `op_id`, `expected_revision` and `accept_external`, and a second agent's view of the same node |
| `skills/planning-review/SKILL.md` | plan against fact: `plan_history` and snapshot diffs, what a review must answer, growth as the fact and status as the summary, incidents and cycles, `plan_restore` as a content restore rather than a rollback |
| `server/agent-skill.ts` | `SKILL_DEFINITIONS` list (name + purpose), `resolveSkillSources()`, `skillStatuses()` one row per root per skill, install/verify/remove over the whole list, `SKILL_NAME` still pointing at `obsidian-bridge` |
| `CONTRACT_SENTENCE` and `mcpInstructions` | the `planRoot` boundary and the ban on `obsidian_edit`/`obsidian_write_*`/`shell`/`write`/`patch` against plan files now arrive with every tool description and with the `initialize` block, together with the names of the four skills |

Evidence: `npm run typecheck` exit 0; `npm test` **42 suites / 348 tests** pass. `agent-skill.test.ts` now checks that
every skill has Agent Skills frontmatter, names its tools and carries no machine-specific absolute path; that installing
a root writes four directories, that removing a root removes all four and spares another plugin's skill, that a drifted
`planning-execute` is the only thing repaired, and that the settings list has one row per skill per root.
`mcp-tools.test.ts` checks the `planRoot` boundary and the skill names in the `initialize` instructions. Linux stays the
primary target; macOS and Windows remain future work, as `__compatibility.md` records.

### 0.16.11 — integrity report and import from luck_tree_export

Feature release (0.15.11 → 0.16.11), stage 7 of the migration. The catalogue grows to 30 tools. Both new tools are about
the same fact: the plan is a directory of files, so the invariants a database would enforce have to be *checked*, and the
way in from the source plugin has to prove the graph before it writes anything.

| Tool / module | Behaviour |
| --- | --- |
| `plan_validate` | one report of every issue the file model can have: `unresolved_link` (every link field), `body_divergence`, `orphan`, `missing_root`/`multiple_roots`, `invalid_parent_kind`, `invalid_status`, `missing_counters`, `missing_id`/`duplicate_id`, `leaf_with_children`, `bee_cycle`, `unfinished_operation`, `not_a_plan` |
| `plan_import` | reads a `.json.zip` written by `luck_tree_export` (or the extracted `.json`), verifies it whole, rebuilds the hierarchy as folders and links, keeps every original id as `legacy_id`; `dry_run` defaults to true, `include_archived` defaults to true, a repeat answers `unchanged` |
| `server/plan/validate.ts` | tree walk, link resolution, body comparison, journal scan for `op:start` without `op:done`, cycle de-duplication, `project`/`limit` scoping |
| `server/plan/import.ts` | zip reader (central directory, stored + deflate), export validation, path assignment (`<project>/<slug>/<slug>.md`, leaves `<parent>/<slug>.md`), incident/goal/growth mapping, op markers |
| `resolvePlanRoot(settings, { allowMissing })` | the one boundary change: `plan_import` plans against a missing root and creates it only when it writes |

Evidence: `npm run typecheck` exit 0; `npm test` **42 suites / 344 tests** pass. `plan-validate.test.ts` breaks one
invariant per case on the real fixture (dangling link, orphan, non-plan file, hand-edited body, unfinished operation,
duplicate id, cycle reported once, `limit`/`truncated`, and a read that changes no bytes); `plan-import.test.ts` drives a
document built from the source plugin's own `exportDocumentSchema`, including a hand-built `.json.zip`, and checks the
rebuilt links, the incident's `blocks`/the leaf's `blocked_by`, the goal's `plan`/`materialized`, growth on its subject,
`legacy_id` idempotency and the read-only gate. Not done yet, by design: the SKILL files (stage 8).

### 0.15.11 — multi-file operations: move, archive, approve, restore

Feature release (0.14.11 → 0.15.11), stage 6 of the migration. The catalogue grows to 28 tools. An operation is a
resumable sequence rather than a transaction: `op:start <uuid>` in the project journal, the filesystem steps, the link
and structural rewrites through `commitNodeChange`, then `op:done <uuid>`.

| Tool / module | Behaviour |
| --- | --- |
| `plan_move_node` | renames the node's folder (or the leaf's file), rewrites `parent`/`children` inside the subtree and `influences`/`blocked_by`/`blocks`/`materialized` everywhere, carries the leaf's `__history` along and snapshots every changed file; the old parent loses the child, the new parent gains it |
| `plan_archive_node` | renames the folder into `<project>/_archive/<slug>`, sets `archived`, drops it from the parent's `children`; nothing is deleted and the history moves with it |
| `plan_approve_goal` | `proposed` → trunk named after the goal plus one leaf per `plan:` step linked back through `goal:`, with `materialized` set on the goal; refused when the approving agent created the goal, for a non-proposed goal and for a goal without steps |
| `plan_restore` | reads `__history/<slug>.v<v>.r<r>.md` and writes its content as `revision + 1` with `restored_from`, keeping the live relations and the line's version |
| `server/plan/ops.ts` | journal markers, `op_id` resumption, link rewriting, subtree rename, goal materialisation |
| `server/plan/restore.ts` | snapshot read, content-only restore, kind-change refusal |

Evidence: `npm run typecheck` exit 0; `npm test` **40 suites / 327 tests** pass, including a subtree move whose links
follow it, a resume after a rename that writes exactly one `op:done`, an archive that leaves search silent, the approval
gate (creator ≠ approver, user approval, second approval), and a restore that keeps relations while refusing a kind
change. Not done yet, by design: `plan_validate` and `plan_import` (stage 7) and the SKILL files (stage 8).

### 0.14.11 — links, incidents, goals and growth

Feature release (0.13.11 → 0.14.11), stage 5 of the migration. The catalogue grows to 24 tools; the four new ones write
relations rather than tree files, and all of them reuse the stage-4 write path.

| Tool / module | Behaviour |
| --- | --- |
| `plan_link` | creates, updates or removes one bee on the source's `influences:`; both ends must be leaves of the same project, a self-loop is refused, an illegal bee transition lists what is allowed, and `remove: true` drops the edge (a second removal is a no-op) |
| `plan_incident` | creates `<project>/_incidents/<slug>.md` or updates it, and keeps `blocks:`/`blocked_by:` in sync on both sides; only `open`/`investigating` block, so resolving an incident unblocks its leaves without rewriting them; a status change is refused with a pointer to `plan_set_status` |
| `plan_goal` | `create` (draft, steps with stable `s1…` ids), `update` (formal text, steps, notes, project) and `propose` (draft → proposed); approval stays with `plan_approve_goal` |
| `plan_growth` | upserts `growth:` on a node or goal: status, summary, progress 0–100 and steps; steps merge by title, `replace: true` starts over; an incident is refused as a subject |
| `server/plan/write.ts` | exports `loadWritableNode` (read + `expected_revision` + `accept_external`) and `commitNodeChange` (snapshot, counters, body, temp + rename), so every new write takes the same path |

Evidence: `npm run typecheck` exit 0; `npm test` **36 suites / 311 tests** pass, covering the edge read from both sides,
self-loop and cross-project refusals, incident create/attach/detach, `blocking: false` after `resolved`, the goal
draft → proposed flow with its snapshot, growth merge/replace, and the refusals that write nothing. Not done yet, by
design: multi-file operations (`plan_move_node`, `plan_archive_node`, `plan_approve_goal`, `plan_restore`), validation,
import and the SKILL files.

### 0.13.11 — writing a plan: create, update, status, history

Feature release (0.12.11 → 0.13.11), stage 4 of the migration. The catalogue grows to 20 tools; four of them write and
one reads history, and the document tools now use the same write gate.

| Tool / module | Behaviour |
| --- | --- |
| `plan_create_node` | one node file (`auth/auth.md`, a leaf in its parent's folder), `version: 1`/`revision: 1`, parent's `children` updated (its own revision bump and snapshot), journal line; refuses an existing file, an orphan and a child kind the parent forbids |
| `plan_update_node` | description, name, brief, payload, `## Заметки`, kind; snapshot first; revision +1, or version +1 and revision 1 on a kind change; `expected_revision` and `accept_external` gates |
| `plan_set_status` | one transition per call for nodes, incidents and goals; illegal and no-op moves refuse and list the allowed targets; a user-set status needs `reason`; snapshot `status_change` |
| `plan_history` | lists snapshots (version, revision, reason, time, actor) or reads one by `version`/`revision`; the only reader of `__history` |
| `server/write-gate.ts` | the `readOnly`/`maxWriteChars` refusal extracted from `mcp-tools.ts` and shared with the planning writes; `readOnly` is checked before the file is even read |
| `server/plan/journal.ts` | append-only `_journal.md`: `at · tool · [[node]] · v1 r4 → r5 · actor · status · reason` |

Evidence: `npm run typecheck` exit 0; `npm test` **33 suites / 289 tests** pass, covering v1 r1 creation with the parent
link and snapshot, the v1 r1 → snapshot v1 r1 → r2 update, the kind change to v2 r1, stale revision, external edit,
illegal/no-op transitions, the user-override reason rule, `readOnly` on every write, and history listing/reading. Not
done yet, by design: links, incidents, goals, growth, multi-file operations (`plan_move_node`, `plan_archive_node`,
`plan_restore`), validation and import.

### 0.12.11 — reading a plan: overview, node context, search

Feature release (0.11.12 → 0.12.11), stage 3 of the migration: the plan becomes readable. Two tools are added and the
catalogue grows to 16; no write exists yet.

| Tool / module | Behaviour |
| --- | --- |
| `plan_read` (no path) | project overview: every first-level project with its root node, its trunks, `counts.byKind`, open incidents (`open`/`investigating`) and proposed goals; non-plan files under the root are listed in `skipped` |
| `plan_read` (path) | node context: `node`, `parent`, `ancestors` (root → parent), `children` (frontmatter plus reverse `parent` edges), `siblings`, `influences`, `influencedBy` (the reverse edge Obsidian shows as a backlink), `blockedBy` with a `blocking` flag, `blocks`, `goal`, `growth`, `unresolved`, and `beeCycle` |
| path forms | `centurion`, `centurion/backend/auth`, `centurion/backend/auth/auth.md` all reach the node; an unknown path returns up to five `suggestions` |
| refusals | a path outside the root, `__history`/`_archive` (pointing at `plan_history`), or an unconfigured/missing root |
| `plan_search` | `searchIndex` over the vault index with `folder = planRoot`, then a hard prefix check, `__history`/`_archive` refusal, `kind`/`status`/`project` filters from frontmatter, one row per note, `limit` 1–50, and counts of `skipped` non-plan hits |

A cycle is reported, not forbidden: only `active`/`watching` influences count, so the answer is the list of plan paths
from the node back to itself. A resolved influence is a historical fact and cannot order work.

Evidence: `npm run typecheck` exit 0; `npm test` **30 suites / 262 tests** pass, including the A→B→C→A cycle, the
pair loop in the fixture, negative search cases (a note outside the root, a snapshot, an archived node, a non-plan file
inside the root) and the refusals. Not done yet, by design: writing nodes and snapshots (stage 4), links, goals,
incidents, growth, operations, validation and import.

### 0.11.12 — the plan file format and snapshots

Internal stage 2 of the migration, released as a patch because no tool changed behaviour: the modules it adds are the
ones `plan_read`, `plan_update_node` and `plan_history` will call.

| Module | Contents |
| --- | --- |
| `model.ts` | `PLAN_KINDS`, `NODE_KINDS`, `ALLOWED_CHILD_KINDS`, `LEAF_STATUSES` + `LEAF_TRANSITIONS`, bee/incident/goal/growth dictionaries, `BLOCKING_INCIDENT_STATUSES`, `SNAPSHOT_REASONS`, `PLAN_KEY_ORDER`, `linkLabel` — ported from `luck-planner shared/tree.ts` without adding a status |
| `frontmatter.ts` | `parsePlanDocument` / `serializePlanDocument` on the `yaml` package (new dependency); key order preserved, duplicate keys refused, a file that does not parse never rewritten |
| `sections.ts` | `renderPlanBody` writes `## Влияния`, `## Блокировки`, `## Дети`, `## Журнал` from frontmatter, keeps `## Заметки`, writes `—` for an empty section; `bodyMatchesFrontmatter` is the divergence check `plan_validate` will use |
| `snapshot.ts` | `snapshotFileName`/`parseSnapshotFileName`/`snapshotPathFor` (`<dir>/__history/<slug>.v<v>.r<r>.md`), `buildSnapshot` (state **before** the write, relation fields dropped), `isSnapshotFrontmatter` |

Evidence: `npm run typecheck` exit 0; `npm test` **28 suites / 241 tests** pass, including round-trip over every fixture
document (same keys, same order, same body), status-change round-trip and the snapshot-naming matrix. Nothing is wired
to a tool yet: `plan_scope` is still the only `plan_*` tool.

### 0.11.11 — the planning root and its boundary

Feature release (0.10.11 → 0.11.11), the first stage of the `luck-planner` migration (§15). It adds one setting,
one tool and one boundary, and changes nothing the document tools already answered.

| Change | Behaviour |
| --- | --- |
| `planRoot` setting | vault-relative, default `Workspaces`; mirrored to the MCP settings file and read from `OBSIDIAN_PLAN_ROOT` when set; shown in the settings screen and as `plan` in `obsidian_status` |
| `server/plan/paths.ts` | `resolvePlanRoot` (vault root → `normalizeRoleDir` → `resolveInsideVault` → `realpath` containment) and `resolvePlanPath` (same ladder for a plan-relative path, with the nearest existing ancestor resolved so a symlink out of the root is caught before a write) |
| `plan_scope` | `planning_available`, `reason` (`not_configured`/`invalid`/`missing`/`empty`), resolved root and path, project list, document count, `writesEnabled`, limits, and the hidden system directories; answered before the index is opened and never creates a directory |
| `__history` / `_archive` | skipped by `walkMarkdown` and by the watcher, so they never reach FTS, search, listings or counts; `obsidian_read`, `obsidian_outline` and `obsidian_edit` refuse a path inside them |

The refusals are the point: a snapshot is history, not a note. If it were indexed, every revision would compete with
the live node in search, and an agent could “fix” the past. The boundary is enforced in code, not in a skill.

Evidence: `npm run typecheck` exit 0; `npm test` **24 suites / 195 tests** pass, including `plan-paths`,
`plan-scope` and the new history/archive case in `indexer`. Not done at this stage, by design: reading a plan node,
writing one, snapshots, links, goals, incidents, growth, `plan_validate`, `plan_import`, the three planning skills and
the dashboard (§15).

### 0.10.11 — edit recovery, Obsidian formats, scan truth, port audit

Feature release (0.9.11 → 0.10.11). The scope was agreed after a review of proposed
improvements; the two items that were **not** built are recorded at the end.

#### Actionable `obsidian_edit` refusals (`server/fragment-match.ts`)

`fragment-match.ts` owns the matching rules and `edit.ts` only writes:

- exact match first; then the same fragment with the note's CRLF endings; then, with
  `ignore_whitespace: true`, a comparison where every whitespace run collapses to one
  space. Each step still requires **exactly one** occurrence, and the whitespace step
  maps normalized offsets back through an offset table, so it cannot drift into a
  neighbouring line;
- a miss returns `suggestions`: the closest windows of the note (token Sørensen–Dice,
  windows of the fragment's line count ±1, equal overlap prefers the tighter window),
  each with a 1-based line number. An ambiguous fragment returns the lines where it
  occurs. The MCP result carries the same data in `structuredContent` (0.5.6's lesson:
  some clients render only that);
- nothing is ever applied from a suggestion. A refusal is information.

#### Callout types and Dataview inline fields (`parse.ts`, `store.ts`)

- `extractCallout()` records the first `> [!type]` in a chunk; `chunks.callout` stores
  it (`SCHEMA_VERSION` 3) and `obsidian_search` renders ` [!warning]` in the packed
  answer with a `callout` field per hit. Existing indexes gain the column through
  `ALTER TABLE`; their rows stay NULL until each note is read again — no wipe and no
  forced reindex for a display-only field.
- `extractInlineFields()` collects `key:: value` and `[key with spaces]:: value` outside
  code fences; `obsidian_outline` returns them as `inlineFields`. They were already
  searchable as body text; this makes them readable as fields.
- Retrieval weights are unchanged: no callout boost was added, because it cannot be
  justified without a measurement (`obsidian_diagnose` is the tool for that).

#### Scan truth in status (`scan.ts`, `indexer.ts`)

`ScanOutcome` now reports `skipped` (over 4 MiB / not a regular file), `unreadable`
(permissions, I/O, a vanished file) and `full`. The indexer keeps the last outcome and
the last full-sync timestamp (also persisted as `last_full_scan_ms`), and `VaultStatus`
exposes both as `scan` and `lastFullScanAt`; the screen prints them. Before this, those
counts existed only in a log line.

#### One embedding job per burst (`indexer.ts`, `embed/job.ts`)

Watched-note flushes no longer call `ensureEmbeddings()` directly: they schedule it
`EMBEDDING_QUIET_MS` (12 s) after the last change, so a Git pull or a Syncthing burst
is embedded once. `EmbedJob` gained a change listener, and the indexer throttles it to a
status push every 750 ms — progress and completion now reach a subscribed panel.

#### Windows half of the port audit (`edit.ts`, `mcp-launch.ts`)

- `replaceFile()` retries `EPERM`/`EBUSY`/`EACCES` five times with a short sync pause
  (the edit path is synchronous by design) and then reports a lock-specific message
  naming Obsidian, a sync client and antivirus, instead of a raw errno.
- `nodeBinaryNames()` probes `node.exe` as well as `node` on Windows, and the PATH scan
  uses the same list.

Linux remains the primary platform; macOS and Windows are still "future work" — this is
the audit, not a support claim.

#### Not built (agreed)

- **Obsidian Canvas** is the declared next stage; requirements are being collected.
- **Link-graph visualization** is deferred: the screen is React Native with no
  SVG/DOM renderer (a bundled dependency and layout cost), and the useful half —
  isolated notes, hubs, unresolved links — is data the index already holds and can be
  surfaced as a cheap panel card first. Recorded in §14.

**Verification.** `npm run typecheck` exit 0; `npm test` **22 suites / 164 tests** pass,
including `fragment-match` (8), edit refusals and `ignore_whitespace` (4), callouts and
inline fields (8), scan metrics (2) and the Node binary names (2).

### 0.9.11 — the four 0.16.0 recommendations, implemented

Feature release (0.8.11 → 0.9.11, second digit +1, third preserved). Every item
uses a capability the 0.16.0 SDK already ships; nothing existing changed shape.

#### A stable MCP path, and healing of older saved entries (`server/mcp-stable.ts`)

The failure it closes: `agent.create.before` writes an absolute path into the
agent's *saved* configuration, and `paseo plugin update` replaces the versioned
checkout (`$PASEO_HOME/plugins/obsidian-bridge/<install-uuid>/checkout/…`), so an
agent created before the update keeps launching a file that no longer exists.
The open hook cannot repair it — the saved name collides, so it stands down.

- On every start `ensureStableEntry()` copies the installed
  `dist/mcp-server.js` to `$PASEO_HOME/plugins/obsidian-bridge/mcp-server.js`
  (the directory that already holds the settings mirror and the model cache), and
  `resolveMcpEntry()` prefers *that* path. Only a copy made by the current run is
  preferred, so a stale copy from an older version is never used.
- `healStaleSavedEntries()` walks `$PASEO_HOME/agents/*/*.json`, inspects only
  the `obsidian-bridge` entry, and restores the bundle at a missing path **only**
  when it lives under this plugin's directory; anything else is logged and left
  alone. Config-file registrations (OpenCode, Kilo, Cline) pick the stable path up
  by the existing refresh on load and on the five-minute timer.

Sketch of the single remaining gap: an agent whose saved entry names a checkout
path outside `$PASEO_HOME/plugins/obsidian-bridge/` is reported, not rewritten.

#### Live status stream (`obsidian-bridge.status-stream`)

- `defineSubscription` in `shared/contracts.ts`; the event is `{ at, status }`
  carrying the complete `VaultStatus`, so a missed event cannot leave a panel stale.
- `VaultIndexer.subscribeStatus()` publishes on `scanNow`, on a watched-note flush
  that changed something, on a reconcile, and on every `reconfigure` (which is
  what a settings change and the start-up scan call).
- The handler pushes once on subscribe and unsubscribes on `context.signal.abort`.
- The screen and the workspace tab use `useSubscription`; the one-shot `vaultStatus`
  read stays for the first paint and for a host older than 0.16.0.

#### Composer control: insert note links for the prompt

`client/composer-item.tsx` registers a host `Action` through
`client.addComposerItem`. It searches `useComposer().prompt` (capped at 512
characters) through the same `obsidian-bridge.search` RPC the panels use, and
inserts one `- [[path#heading|title]]` line per hit at the cursor through
`composer.insertText`. The exact link form lives in `shared/citations.ts` so it
is unit-tested without a React host. No hit is an error (the host shows it as a
toast); nothing is written to the vault.

#### Per-agent injection marker (`server/injection.ts`)

The marker `{ mode, reason, at }` is stored under the plugin's own metadata key,
`obsidian-bridge`:

| Hook | Where the marker goes | Modes it can write |
| --- | --- | --- |
| `agent.create.before` | the hook's returned `metadata`, persisted with the agent | `mcp`, `config`, `skipped` |
| `agent.open.before` | `paseo.agents.ref(id).setMetadata(…)`, fire-and-forget, only when the mode changed and never for `purpose: "history"` | `mcp`, `tool`, `config`, `skipped` |

The open hook must not return `metadata` — 0.16.0 allows only `env`, `tools` and
`mcpServers` there and fails the open otherwise (the `bunny-search` 0.7.5 bug). A
recorded `mcp` marker also suppresses the capability probe: the provider already
accepted a server for that agent, so the answer cannot have changed. Read-back is
fail-safe — a missing, foreign or malformed value claims nothing.

**Verification.** `npm run typecheck` (`tsc -b`, three projects) exit 0;
`npm test` **17 suites / 138 tests** pass, including new suites for the stable
copy and healing (5), the marker and citation text (8) and two new session-open
cases (marker `mcp` skips the probe; `tool`/`config` still probe). The live host
behaviour — a real `addSubscription` push and a rendered composer control — is
host-side and is exercised at runtime, not by this build.

### 0.8.11 — Paseo 0.16.0 compatibility pass

Documentation and pin only; no runtime code changed, so the patch version moved
0.8.10 → 0.8.11 (the SDK dev pin moved `^0.15.0` → `^0.16.0`, the floor stayed
`>=0.15.0`). Evidence and the change-by-change table live in
[`__compatibility.md`](./__compatibility.md); the short version:

- 0.16.0's one breaking change, the removal of `agent.turn.after.timeline`, is
  unused: the plugin registers `agent.create.before` and `agent.open.before` only.
- The 0.16.0 daemon allows `agent.open.before` to change only `env`, `tools` and
  `mcpServers`, and fails the open on anything else (that is what broke
  `bunny-search` 0.7.5 and `command-center` 0.13.2 in this repository). The hook
  here already returns `request` unchanged or `{ ...request, tools, mcpServers }`
  and never returns a changed `metadata`, so it complies without a change.
- 0.16.0's fix for plugin RPCs whose input/output schema uses a transform works in
  the plugin's favour: every RPC input uses `z.string().trim()`.
- The OpenCode shared-service restriction is unchanged, so the config-file
  registration path stays the primary one for OpenCode and Kilo.

The pass's open recommendations (not implemented):

1. **A stable MCP bundle path.** `agent.create.before` saves an absolute path into
   the agent's configuration, and a plugin update replaces the checkout, so an
   agent created before the update keeps launching a missing file while the open
   hook stands down because the saved name exists. `bunny-search` 0.7.6 solved
   the same failure with a copy under `$PASEO_HOME/plugins/<id>/`; the resolution
   here already lists that path last, nothing writes it.
2. **Subscriptions.** `addSubscription` (0.16.0) would replace the panels' polling
   with pushed status/scan-progress events, the same pattern `bunny-search` 0.7.5
   uses.
3. **A composer control.** The attachment source attaches a whole note; a composer
   action that inserts `[[note]]` or a citation at the cursor is the smaller,
   more precise gesture.
4. **A per-agent injection marker.** `agent.create.before` may return `metadata`;
   the open hook would have to write it through `setMetadata` instead of the
   result, which turns "which agents actually got the tools" into daemon data.

### 0.8.10

- **An agent spent a whole turn discovering tool names instead of asking the vault.** Measured on Paseo 0.15.4 with an
  OpenCode agent asked whether a named document existed: its catalogue showed `obsidian-bridge (13 tools, 2 shown)`, the
  skill was visible only as its description, and the agent tried `search`, then `obsidian_find_notes`, then listed MCP
  resources before it reached `obsidian_search` — the document was found in the end, but the cost defeats the plugin.
  The `initialize` instructions now carry the complete index (`Tools in this server (13):` plus one line per name with its
  title, generated from `MCP_TOOLS`), and state the shortcut explicitly: call `obsidian_search` with words from the
  title, then `obsidian_read` (or `obsidian_outline` first for a long note), and do not probe for names or fall back to
  `glob`/`grep`/`read`. The skill description in `SKILL.md` frontmatter now names the tools too, so a runtime that shows
  only the description still answers "what can I call?". Tests: `tests/mcp-tools.test.ts` (every `MCP_TOOLS` name and
  the count appear in the instructions).

### 0.8.9

- **The settings screen refused to open after the update: "Settings are invalid: Settings version 2 requires a migration".**
  Measured on a 0.4.1 → 0.8.8 update: the host store still held `{version: 2, values: …}` (written by the 0.3.x/0.2.x
  schema), the definition declares version 4, and `defineSettings` had no `migrate` hook — the host only falls back to the
  schema when the stored version matches, so it reported the document as invalid and no setting could be edited. The
  semantic (0.3.0) and enrichment (0.4.0) bumps were additive, which is why the version was never lowered again and the
  gap stayed invisible until an old install upgraded. `shared/settings.ts` now passes `migrate`, which keeps the stored
  values (the schema fills every key the older document never had) and lets the host persist the document at the current
  version — the repair therefore survives a restart. Tests: `tests/settings-migration.test.ts` (version 2 document keeps
  its values and gains the newer defaults, unknown keys are dropped, a non-object document falls back to defaults).

### 0.8.8

- **A registration written during `paseo plugin update` pointed at a replaced checkout.** Measured: Cline's entry named
  `…/obsidian-bridge/efa423e0…/checkout/…/dist/mcp-server.js`, a directory the update had already removed, so Cline failed
  to spawn the server and a real Cline agent reported `OBSIDIAN_TOOLS=no` while the same agent saw `memory-flash` tools.
  Two fixes: `upToDate` now also requires the registered script path to exist (a moved install shows as outdated instead of
  current), and the five-minute check re-runs `syncConfigRegistration()`, so a stale entry heals without the user opening
  settings. Registration is skipped when the entry is already current, so the periodic check does not rewrite config files.

### 0.8.7

- **A Cline agent had no Obsidian tools.** Measured with a real Cline agent on Paseo 0.15.4: it loaded the skill and
  answered `OBSIDIAN_TOOLS=no` — Cline accepts `mcpServers` in the session payload but only connects remote servers from
  it and spawns no stdio server. `server/cline-mcp.ts` writes the entry into Cline's own
  `~/.cline/data/settings/cline_mcp_settings.json` (`{ mcpServers: { "obsidian-bridge": { transport: { type: "stdio",
  command, args } } } }`), preserving other servers, refusing an unparseable file, and skipping a machine without
  `~/.cline`. `agentConfigCoversProvider("cline")` now reports the same coverage as OpenCode/Kilo, so no duplicate
  injection is attempted. New switch `registerClineMcp` (default on).
- **Skill currency is now enforced, not hoped for.** `verifyAgentSkill()` compares every installed copy with the checkout
  and rewrites what drifted; it runs on load, after a settings change and on a five-minute timer (`skillCheckTimer`,
  cleared on shutdown). The skill roots grew to the directories the installed agents actually read: `~/.agents/skills`
  (checked first), `~/.config/opencode/skills`, `~/.opencode/skills`, `~/.cline/skills`, `~/.kilo/skills`,
  `$KIMI_CODE_HOME/skills`, `~/.qwen/skills`, `~/.codex/skills`, `~/.claude/skills` — still only those that exist.
- **"Installed correctly" is visible.** New RPC `obsidian-bridge.agent-integration` and an *Installation* card in the
  settings screen list every agent config (detected / registered / outdated / error, with the path) and every skill copy
  (installed / current / stale / missing), with a *Check again* action.
- Tests: `tests/cline-mcp.test.ts` (6 cases: entry shape, foreign servers preserved, outdated entry reported, selective
  removal, Cline absent, unparseable file untouched) and three new `tests/agent-skill.test.ts` cases (repair of a
  hand-edited skill, root list incl. shared/Cline/Kilo with `~/.agents` first, per-root status rows).

### 0.7.7

- **Agents had tool schemas but no instructions on how to use a vault well.** Added the plugin's own Agent Skill,
  `skills/obsidian-bridge/SKILL.md` (frontmatter `name`/`description`, per the Agent Skills specification): the read →
  cite workflow, heading-scoped reads for long reports, where a write is allowed, the exactly-once `old_text` rule of
  `obsidian_edit`, the difference between appending a section and editing a note, and the Obsidian Flavored Markdown
  vocabulary (wikilinks, embeds, callouts, properties, tags, highlights, math, Mermaid, footnotes). Paseo 0.15.x has no
  skill API, so `server/agent-skill.ts` installs the file where the agent runtimes already look for one
  (`~/.config/opencode/skills`, `~/.opencode/skills`, `~/.agents/skills`, `~/.claude/skills`), touching only roots that
  exist, rewriting only when the content differs, and removing `obsidian-bridge/` when `installAgentSkill` is off. The MCP
  `initialize` instructions also point at the skill by name.
- **The official skills stay upstream.** `obsidianmd/obsidian-skills` is the reference for Obsidian Flavored Markdown,
  Bases, JSON Canvas and the Obsidian CLI; it is linked from the README, `__compatibility.md` and from the skill's own
  References section, but it is not vendored: the plugin's skill is the controllable one, versioned and reviewed in this
  repository, and it only restates the Markdown vocabulary an agent needs for the notes the bridge writes.
- Tests: `tests/agent-skill.test.ts` (7 cases: frontmatter of the shipped skill, source resolution, install only into
  existing roots, idempotent reinstall, stale replacement, removal that spares other skills, no-root case).

### 0.6.7

- **Notes outside the three roles could be read but never edited**, so a document the user moved into a project folder was
  untouchable: every write tool is role-scoped and append-only. Added `obsidian_edit` (`server/edit.ts`): exact-fragment
  replacement by vault path, exactly-one-occurrence rule, realpath symlink boundary, atomic replace guarded by size+mtime,
  CRLF-aware matching, `readOnly`/`maxWriteChars`/4 MiB limits. Tests: `tests/edit.test.ts` (10 cases: role-less folder,
  multi-line and deletion, ambiguity, missing fragment, missing file, path escape, symlink escape, CRLF, no-op/empty, size
  limit) plus the tool-level cases in `tests/mcp-tools.test.ts` (workspace role, `readOnly`, path above the vault).

### 0.5.7

- **A plugin update took the tools away from a running agent.** `paseo plugin update` stops the old plugin, whose cleanup
  removed the config entry; the live OpenCode session reloaded its config in that window and dropped the whole
  `obsidian-bridge` namespace mid-turn (`the obsidian-bridge namespace is no longer available`), with the new plugin
  re-registering a moment later. The entry now stays on shutdown and is removed only through the settings switch; a stale
  entry after an uninstall is the cheaper failure.

### 0.5.6

- **An OpenCode agent read a note and got no text.** `obsidian_read` put the body in the MCP text block only; OpenCode
  renders `structuredContent`, so the agent saw path, title, headings and `truncated: false` with nothing to read. The body
  is now also `content` in the structured result.
- **A long headingless file outranked the note that matched every word.** Chunk rows were fused one by one, so a converted
  export with dozens of matching chunks under a single empty heading summed dozens of RRF contributions into one entry
  (`0.196` against `0.05` for the real match). Chunks and semantic neighbours are now deduplicated per note before fusion,
  which also keeps one hit per note instead of several chunks of it. Measured on the vault: the moved test note went from
  rank 5 / miss to rank 1 for its own key phrases ("vncpasswd Remmina KRDC gvncviewer", "KRDC Vinagre gvncviewer").
  Tests: body-in-structuredContent case and the ranking case in `tests/mcp-tools.test.ts`.

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

## 14. Future work: Canvas next, link graph deferred

Both items came out of the improvement review recorded in §11; neither is scheduled
yet, and the difference between them is deliberate.

### 14.1 Obsidian Canvas — the next stage

`.canvas` is JSON: nodes (`text`, `file`, `link`, `group`) and the edges between them.
Today the vault walk only accepts `.md` (`isMarkdownPath`), so a canvas is invisible to
the index, to `obsidian_list` and to the watcher.

Planned shape, in dependency order:

1. **Parse.** A `server/canvas.ts` that turns a canvas into the same `ParsedNote` the
   Markdown parser produces — one chunk per text node (heading = node id or its first
   line), `file` nodes contributing links, group names as context. Malformed JSON must
   degrade to "not indexed, reported", never to a crash.
2. **Index.** `walkMarkdown` (renamed) accepts `.md` and `.canvas`; `notes` gains a kind
   column or infers it from the extension; link resolution treats a `file` node like a
   wikilink, so the graph works across both formats.
3. **Read.** `obsidian_read` on a `.canvas` returns a textual rendering (node list plus
   edges) and `obsidian_outline` lists nodes; `parseNote` must not be asked to parse
   JSON as Markdown.
4. **Watch and exclude.** The watcher filter, `includeFolders`/`excludeGlobs` and the
   attachment source all need the new extension; a canvas that stops matching leaves
   the index like any other note.
5. **Write (later).** Creating or editing a canvas is a separate design: JSON positions,
   node ids and Obsidian's own layout rules. That is where "an agent can draw" belongs,
   and it will not be part of the read-only index release.

### 14.2 Link-graph visualization — deferred

A visual graph of the vault's wikilinks would show how the agent sees the vault and
expose isolated notes. It is documented, not scheduled, for concrete reasons:

- the screen is a React Native surface (`View`/`ScrollView` in `client/surface.tsx`), so
  D3 in a DOM does not apply; a renderer (`react-native-svg` or similar) would have to
  be bundled and declared as a non-host dependency, and the layout itself has to be
  computed for every render;
- the useful question — "which notes will an agent never find?" — is already answered by
  data in the index (`links`, `unresolvedLinks`, `backlinks`). A small panel card
  (orphans, top hubs, unresolved count) delivers the insight at a fraction of the cost
  and without a dependency.

If visualization is picked up later, the cheap card comes first, and the graph only
after a concrete use case that the card does not serve.

## 15. Planning foundation (0.11.11)

The plugin is also becoming the home of project planning, taking over the core of the frozen `luck-planner` plugin.
Planning is a **directory inside the vault**, not a second plugin, a second MCP server or a second database:
`planRoot` (default `Workspaces`) is resolved against `vaultPath`, and the `plan_*` tools share this server, this
settings file, this index and this limit gate. Stage 1 delivers the boundary only; the plan model follows in later
stages (`plan_read`/`plan_search`, then writes and snapshots, links and goals, multi-file operations, validation and
import, the three skills, and only after that a dashboard).

### 15.1 The boundary

```
vaultPath/                      # the one directory available to Paseo
└── planRoot/                   # default: Workspaces
    ├── _index.md               # project registry (not a tree node)
    ├── _schema.md              # field and status schema
    └── <project>/
        ├── <project>.md        # root node: its folder is its children
        ├── _journal.md         # append-only operations log
        ├── _goals/, _incidents/
        ├── _archive/           # archived subtrees — never indexed
        └── <trunk>/<trunk>.md, <trunk>/<branch>/<branch>.md, …
            └── __history/      # revision snapshots — never indexed
```

A `plan_*` argument is a path **relative to `planRoot`**, so no tool accepts a vault path or an absolute path. Both
boundaries are applied in order (`server/plan/paths.ts`): `normalizeRoleDir` refuses absolute paths, `..`, control
characters and `.obsidian`; `resolveInsideVault` refuses anything above the vault; a `realpath` comparison against the
planning root refuses a symlink that leads out of it. For a file that does not exist yet, the nearest existing ancestor
is resolved, so a symlinked folder is caught before the write, not after.

### 15.2 `plan_scope`

The first call of every planning workflow answers a question that has no safe guess:

| Field | Meaning |
| --- | --- |
| `planning_available` | `true` only when the directory exists and holds at least one plan document |
| `reason` | `not_configured` (no `vaultPath` or empty `planRoot`), `invalid` (bad path/symlink), `missing`, `empty` |
| `root`, `path` | configured vault-relative folder and its resolved absolute path |
| `projects` | first-level folders that contain notes (`projectCount` is its size) |
| `documents` | Markdown files under the root, excluding `__history` and `_archive` |
| `registry`, `schema` | vault paths of `_index.md`/`_schema.md` when they exist |
| `writesEnabled` | `false` when no directory resolves or `readOnly` is on |
| `limits`, `systemDirs` | `maxWriteChars`, `maxNoteBytes`; the two hidden directories |

It never creates anything: a missing `Workspaces` is reported, not materialised, and the tool is answered before the
index is opened — so a scope check on a fresh install leaves no database behind.

### 15.3 Hidden history and archive

`__history` and `_archive` are skipped in `walkMarkdown` (which feeds the scan, the index, search, listings and the
counts) and in the file watcher, and `obsidian_read`, `obsidian_outline` and `obsidian_edit` refuse a path inside them.
A snapshot is a record of what a node was, not a note competing with it: indexing every revision would make search
return the same plan many times and would let an agent edit the past. They become reachable through `plan_history`
only, and `readOnly` still blocks every planning write (stage 4).

### 15.4 File format and snapshots (0.11.12)

Four modules turn the boundary into a file model, and nothing calls them from a tool yet.

- **`model.ts`** is the vocabulary, ported from `luck-planner shared/tree.ts` without inventing a status: node kinds,
  `ALLOWED_CHILD_KINDS`, the nine leaf statuses with their transition table (a no-op is not a transition), the incident,
  goal, bee and growth dictionaries, `BLOCKING_INCIDENT_STATUSES`, the seven snapshot reasons, the canonical key order
  and `linkLabel`.
- **`frontmatter.ts`** owns YAML. `parsePlanDocument` returns the mapping in document order or an actionable error (no
  frontmatter, broken YAML, a sequence instead of a mapping, duplicate keys); `serializePlanDocument` writes the same
  order back with `lineWidth: 0`, so a long description stays readable instead of collapsing into one escaped line.
  A file that does not parse is never rewritten: the writer must surface the error. `withKey` changes or deletes one key
  and keeps the rest untouched.
- **`sections.ts`** renders the body as a view of the frontmatter: `## Влияния` (target — status — impact — `(vN rM)`),
  `## Блокировки`, `## Дети`, `## Заметки` (carried through verbatim) and `## Журнал` (the `journal:` array). An empty
  section is `—`, so a missing heading is a divergence rather than an empty section, and `bodyMatchesFrontmatter` is the
  comparison `plan_validate` will report. Rendering is idempotent: rendering a rendered body changes nothing.
- **`snapshot.ts`** names and describes a snapshot: `<dir>/__history/<slug>.v<v>.r<r>.md`, counters of the state being
  **replaced**, `is_snapshot`/`snapshot_of`/`snapshot_reason`/`snapshot_op`, and the content fields (`name`,
  `description`, `brief`, `payload`, `plan`, `growth`, …). Relations (`parent`, `children`, `influences`, `blocked_by`,
  `blocks`, `goal`, `materialized`) and the per-file `journal` are dropped: a snapshot is a record of a document, not a
  stale copy of the graph.

The only new dependency is `yaml` (^2.9.1). It parses with the core schema, so timestamps stay the strings their author
wrote, and it refuses duplicate keys instead of silently keeping the last one — both are properties a hand-written parser
tends to get wrong.

### 15.5 Reading a plan (0.12.11)

`read.ts` builds the whole tree for one call: `walkMarkdown` under `planRoot` (which already skips `__history` and
`_archive`), `parsePlanDocument` per file, and a map keyed by vault path. A file without frontmatter, without a known
`kind`, or marked `is_snapshot` is counted in `skipped`, never treated as a node. Nothing is cached between calls: the
server is a short-lived child process, and a cache would only hide a hand edit made in Obsidian.

Without a `path` the answer is a project overview: each first-level project with its root node (the `kind: root`
document, else the parentless node), its trunks, `counts.byKind`, the incidents that block (`open`/`investigating`) and
the goals still `proposed`. With a `path` the answer is one node in context:

- `ancestors` walks `parent` links up to the root; `children` merges the frontmatter list with reverse `parent` edges,
  so a file added by hand still shows up under its parent;
- `influences` resolves `influences[].target`, and `influencedBy` is the same scan in reverse — the computed equivalent
  of the backlink Obsidian draws;
- `blockedBy` resolves `blocked_by` to incident documents and marks `blocking` only for `open`/`investigating`;
- `beeCycle` follows `active`/`watching` influences and returns the path from the node back to itself, or `null`. A loop
  is reported rather than rejected: a cycle has no honest execution order, and the plan owner decides what to cut;
- a path may name the folder (`centurion/backend/auth`), the file, or the project; a miss lists up to five real nodes.

`search.ts` is a thin wrapper on purpose. It opens the same `BridgeStore` index, calls `searchIndex` with
`folder = planRoot`, then re-checks every hit: prefix, no `_archive`/`__history`, parseable plan frontmatter. Filters run
on parsed YAML, not on text — asking for `status: done` must not return a node whose description says "done". A node hit
through several headings collapses to one row, `limit` is 1–50, and the answer reports how many hits were `filtered` by
frontmatter and how many were `skipped` because they are not plans.

### 15.6 Writing a plan (0.13.11)

`write.ts` owns the four write-shaped tools and one read-only one. The order inside every mutation is fixed, because the
file on disk is the only copy:

1. `readOnly` is checked before the file is even read (`server/write-gate.ts`, shared with the document tools);
2. the target is resolved by path — `planRoot` boundary, no `..`, no absolute path, no symlink out;
3. the file is read and the frontmatter parsed; a stale `expected_revision` refuses, and a file whose mtime is newer than
   its `updated` timestamp (a manual Obsidian edit) needs `accept_external: true`;
4. the previous state is snapshotted into `__history/` (`<slug>.v<v>.r<r>.md`); an existing snapshot for the same
   counters is left alone, never rewritten;
5. the new text goes through a temp file and `rename`, with size and mtime re-checked right before the rename;
6. one line is appended to the project journal — after the write, so the journal never claims a change that failed.

`plan_create_node` writes `v1 r1`, chooses the layout path (`auth/auth.md` for a node, `auth/session-store.md` for a
leaf), refuses a missing parent, an existing file and a child kind the parent does not allow, then appends its link to
the parent's `children` and bumps the parent's revision — with a snapshot of the parent taken first. Creating a node is
a two-file operation; if the second file fails, the answer says so and marks `partial: true` instead of pretending
atomicity (stage 6 adds the `op:start`/`op:done` journal markers for the operations that move files).

`plan_update_node` changes description, name, brief, payload, `## Заметки` or kind. Content changes raise `revision` by
one; a kind change raises `version` and resets `revision` to 1, and is refused when the parent would not accept the new
kind or when a child would no longer fit under it. `plan_set_status` performs exactly one transition from the tables in
`model.ts` (nodes, incidents, goals); the same-status move is not a transition, an illegal move lists what is allowed,
and a status last set by `user` can be overridden by an agent only with `reason`, which is stored as `status_reason` and
appears in the journal. `plan_history` is the read side: it lists `v/r/reason/time/actor` from the snapshot frontmatter,
or returns one snapshot's frontmatter and body. It never writes, so `readOnly` does not block it.

Journal lines look like
`2026-11-18T10:40:00Z · plan_set_status · [[Workspaces/centurion/backend/auth/session-store|session-store]] · v2 r4 → r5 · actor: codex · status: in_progress → blocked · reason: …`.
`_journal.md` is created with a `# Journal` heading on the first write and is only ever appended to.

### 15.7 Relations: links, incidents, goals and growth (0.14.11)

Relations are stored where the relation lives, not in a second table: an influence is an entry in the source's
`influences:`, a block is `blocks:` on the incident plus `blocked_by:` on the leaf, a goal is a file in `_goals/` with its
steps in `plan:`, and growth is a `growth:` object inside its subject.

`links.ts` writes the source only. The reverse direction is Obsidian's backlink, so the two halves cannot disagree, and a
cycle cannot be forbidden by the schema — it is computed by `plan_read` (`beeCycle`) instead. Both ends must be leaves of
the same project: an influence orders two pieces of work inside one plan, and a cross-project edge would claim a
dependency the tree cannot express. Updating an existing edge checks `canTransitionBee`, records the target's current
`v/r` in the entry, and bumps the source's revision with a `link_update` snapshot; removing an edge that does not exist
returns `removed: false` without writing, so a retry is safe.

`incident.ts` is the only writer of the two-sided block. Creating the incident writes the file first and then each leaf's
`blocked_by:`; attaching and detaching leaves on update does the same in reverse, and every touched file gets its own
snapshot. Only `open` and `investigating` are blocking (`BLOCKING_INCIDENT_STATUSES`), so `plan_set_status` to `resolved`
unblocks the leaves without touching them — the status is the single source of truth and the links stay as history. A
leaf from another project is refused before anything is written.

`goal.ts` covers authoring, not approval. `create` writes `status: draft` with steps normalised to `{id, title,
description?}` (ids `s1…sn` unless given, duplicates refused), `update` edits the formal text or the steps of a live goal,
and `propose` performs the one `draft → proposed` transition. A goal that is `cancelled` or `superseded` is not edited:
create a new one and keep the old history. `plan_approve_goal` (stage 6) is the only path from `proposed` to leaves, so
an agent cannot author and approve the same plan in one tool.

`growth.ts` upserts a single record: `status`, `summary`, `progress` 0–100, `steps`. Steps are keyed by title, so
recording the same step again updates its state instead of appending a duplicate, and `replace: true` is the explicit way
to start a new list. An incident is refused: a defect is resolved through its lifecycle, not described as progress.

### 15.8 Multi-file operations (0.15.11)

The filesystem has no transaction, so an operation is a **resumable sequence**, not an emulation of one:

1. `op:start <uuid>` in the project journal, with the tool name and the target;
2. every file that will be overwritten is snapshotted first (relation rewrites go through `commitNodeChange`, which takes
   its own snapshot);
3. the filesystem steps happen between the markers (rename a folder, create a branch and its leaves);
4. `op:done <uuid>` — written only once every step landed.

The id is caller-controlled (`op_id`), so a failed run can be repeated instead of guessed at. A move is resumable from two
states: the source is still in place (a normal retry), or it was already renamed and the destination is the only address
left (the mapping is rebuilt from it). `plan_archive_node` and `plan_approve_goal` accept an already moved folder or an
already created branch the same way; a completed id answers `already_done` without touching anything. A half-finished
operation is visible in the journal as an `op:start` without its `op:done`, which is exactly what `plan_validate`
(stage 7) will report.

A move rewrites what the tools themselves write: `parent`, `children`, `influences[].target`, `blocked_by`, `blocks` and
`materialized`, inside the moved subtree and everywhere else in the plan. Links are matched by their written target, so a
short `[[session-store]]` stays as it is (Obsidian still resolves it); links from `Documentation`/`Inbox` are untouched
and become `plan_validate`'s business. Archiving is deliberately narrower: the subtree leaves the tree, so its parent stops
listing it and incoming links stay as they were — a dangling link is a fact for the report, not something an archive
should invent. A move cannot change a root, an incident or a goal, and it cannot place a node inside itself.

Approval is the one place where a goal becomes work. The branch is a `trunk` under the project root (the only child kind a
root allows), each step is a leaf named after its title (`move-the-session-table`, falling back to the step id for a
non-latin title), and each leaf carries `goal:` back to the file. The gate is the source plugin's rule: an agent may
propose a goal but not approve the one it created — `actor` is compared with `created_by` — and the user approves either
in the panel or by passing `actor: "user"`.

A restore is not a rollback: the current state is snapshotted, the counters move forward, and only content travels back
(`name`, `description`, `brief`, `payload`, `plan`, `growth`, `severity`, `formal_text`, `status`, plus `## Заметки`).
Relations stay live on purpose, and a snapshot taken before a kind change is refused, because a kind change is a version
event and not a revision.

### 15.9 Integrity checks and import (0.16.11)

`plan_validate` exists because the plan has no schema engine at rest. It re-reads the tree and reports:

- `not_a_plan` — a Markdown file under the root whose frontmatter does not parse, that carries no plan `kind`, is a
  stored snapshot or is oversized;
- `unresolved_link` — a value in `parent`, `children`, `influences[].target`, `blocked_by`, `blocks`, `materialized`,
  `goal` or `project` that no document in the plan resolves to (a link into `_archive` is expected to land here);
- `body_divergence` — the body is not what the frontmatter renders, i.e. someone edited a generated section by hand;
- `orphan` — a tree node without a parent (or with a parent that does not exist), and an incident or goal without a
  `project`;
- `missing_root` / `multiple_roots` — per project, exactly one `kind: root` document;
- `invalid_parent_kind` / `invalid_status` / `leaf_with_children` — the schema rules, checked against the actual parent;
- `missing_counters` / `missing_id` / `duplicate_id` — identity and the snapshot naming contract;
- `bee_cycle` — the influence graph closes a loop, reported once per loop with the loop itself;
- `unfinished_operation` — the journal holds an `op:start <id>` with no `op:done <id>`.

Duplicates are reported because an id, not a file name, is what a link means. The answer carries `valid`, `issue_count`,
`counts.byKind`, `truncated` and a `project`/`limit` window; the call writes nothing.

`plan_import` is the way in from `luck-planner`. The archive is read without a dependency: the central directory is
parsed, the `.json` entry is inflated, and the envelope is checked by hand (`format`, `schemaVersion: 1`, one root,
existing parents, allowed parent→child kinds). A refused file names the failing field and leaves the disk untouched.

The path mapping is the plan's own layout, with the plan root supplied by the caller (`project`, defaulting to the export's
project key):

| Export row | Plan file |
| --- | --- |
| root | `<project>/<project>.md` |
| trunk / branch / subbranch | `<parent folder>/<slug>/<slug>.md` |
| leaf | `<parent folder>/<slug>.md` |
| bug + attachment | `<project>/_incidents/<slug>.md`, linked from each leaf's `blocked_by` and back through `blocks` |
| goal | `<project>/_goals/<slug>.md`, `plan:` steps kept, `materialized` linked to the approved branch |
| bee | `influences` on the source leaf, with the impact as `note` |
| growth record | `growth:` on its subject (node or goal) |

Every original row id is stored as `legacy_id`, which is what makes a second import of the same file answer `unchanged`
instead of duplicating the tree; a target project that holds a *different* tree is refused, never merged. Archived nodes
travel with their `archived` stamp unless `include_archived: false`, and a node that cannot be reached from the root or an
attachment whose end is missing becomes a warning rather than a silent drop. The write is bracketed by `op:start`/
`op:done` like the stage-6 operations, so a failed import is visible in the journal and can be repeated with `op_id`.

### 15.10 Skills and instructions (0.17.11)

The plugin teaches four workflows, each a real Agent Skills file reviewed with the code:

| Skill | Answers |
| --- | --- |
| `obsidian-bridge` | how to find a note, read one heading, write in the right role and edit an exact fragment |
| `planning-create` | how to grow a tree: one root, trunks, branches, leaves with briefs, goals, import |
| `planning-execute` | how to carry the plan through the work and keep its state honest |
| `planning-review` | how to compare plan with fact using snapshots, growth and `plan_validate` |

`server/agent-skill.ts` holds `SKILL_DEFINITIONS` (directory name plus a one-line purpose for the settings screen) and
works over that list everywhere: `resolveSkillSources()` finds each `skills/<name>/SKILL.md` in the checkout (configured
plugin path, then next to `__dirname`, then `$PASEO_HOME/plugins/obsidian-bridge`), `skillStatuses()` reports one row per
root per skill, `verifyAgentSkill()` repairs only the copies that differ, `installAgentSkill()` refuses when a source file
is missing, and `removeAgentSkill()` removes the four directories while leaving another plugin's skill alone. Only skills
roots that already exist are touched, and `SKILL_NAME` keeps pointing at `obsidian-bridge` for callers that predate the
list.

The `initialize` block carries the same boundary the tools enforce: `plan_*` paths are relative to `planRoot`, a plan file
is never created, edited, renamed or deleted with `obsidian_edit`, `obsidian_write_*`, `shell`, `write` or `patch`, and a
snapshot is read only through `plan_history`. That paragraph exists because a skill is an instruction and the boundary is
code — the skill explains the boundary, it cannot replace it.

No skill contains an absolute path: `planRoot` is configuration, so every example is relative (`centurion/backend/auth`)
and every root is resolved at runtime. Linux is the primary target; the skills contain no shell-specific step, so a
macOS/Windows agent follows the same instructions once the plugin is ported.
