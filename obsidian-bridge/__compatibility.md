# Obsidian Bridge — compatibility

Detailed compatibility notes. The main README keeps only the summary table row and links here.

## Verified (2026-11-14, 0.5.4)

| Component | Version | Notes |
| --- | --- | --- |
| Paseo | `0.15.4` | Installed from Git (`paseo plugin update`), plugin `running`; `npm ci` + `npm run bundle` run in the managed checkout. |
| Obsidian Local REST API with MCP | `5.5.2` (API route set of 5.x) | Live, not a fake server: `GET /` probe (`authenticated: true`), `POST /search/simple/?query=…&maxResults=…`, note JSON with `Accept: application/vnd.olrapi.note+json`, and four `POST /events/vault/<event>/` + SSE subscriptions held open by the plugin process. |
| Semantic search | `Xenova/multilingual-e5-small` q8 | Model cache in `$PASEO_HOME/plugins/obsidian-bridge/models` (130 MB); 1 684/1 684 chunks embedded, query embedding ready, `obsidian_diagnose` recall@5 = 1.0 lexical and hybrid. |
| MCP injection into agents | OpenCode provider | 0.4.3 saved the server via `agent.create.before`, but Paseo 0.15.4 refuses a saved MCP server on an OpenCode agent that shares the local OpenCode service (`Custom OpenCode MCP servers … require an isolated server`) and reports `supportsMcpServers: false`; attached tools are not surfaced by OpenCode either. 0.5.4 registers `mcp.obsidian-bridge` in OpenCode's (and Kilo's) own config file and stands both hooks down for such a provider. |
| OpenCode config | `~/.config/opencode/opencode.json`, `mcp[].type = "local"` | Live: the plugin writes and refreshes the entry on load, and a real OpenCode agent then sees `obsidian-bridge_obsidian_status` and the rest of the tools. |

## Verified (2026-11-13, 0.4.1)

| Component | Version | Notes |
| --- | --- | --- |
| Paseo | `>= 0.15.0` | Uses `server.addHook("agent.open.before")`, `defineAgentTool`, `defineSettings`, `defineRpc`, `addScreen`, `addSidebarHeaderItem`, `addSettingsScreen`, `addCommandCenterItem`, `addWorkspacePanel`, `addAttachmentSource`. |
| Node.js (daemon host) | `v24.20.0` verified; `>= 22.5` required | `node:sqlite` with FTS5 is used directly; no native modules, no `sqlite-vec`, no `npm` dependency at runtime. |
| OS | Linux (primary) | Paths, `fs.watch(recursive)` and the bundled MCP server were exercised here. |
| Obsidian | installed at `/opt/Obsidian/obsidian` | **Not required.** 0.2.0 reads the vault from disk, so the app can be closed, absent from `PATH`, or a different version. No community plugin is required in the vault. |
| Vault | any directory of Markdown files | `.obsidian` is used only as a hint in the path check; it is never read. The version of the installed Obsidian app is irrelevant in 0.2.0. |
| MCP client | stdio, protocol `2024-11-05` | `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Verified with a real spawned process in `tests/mcp-server-e2e.test.ts`. |
| Obsidian Local REST API (optional) | 5.x API surface | Probe, fuzzy search, note JSON links/backlinks, `/open/`, and vault SSE streams. Exercised against a loopback fake server in `tests/enrichment.test.ts`; live verification against a real Obsidian instance is the next manual step (0.4.0). |

## Behaviour without the Obsidian application

Nothing in 0.2.0 depends on a running app:

| Capability | Obsidian running | Obsidian closed |
| --- | --- | --- |
| Scan, watch, reconcile | works | works |
| Search, read, outline, list, links | works | works |
| Append / create in `inbox`, `out`, `raw` | works | works |
| Semantic signal (e5-small q8, ONNX Runtime) | works (Node 24, Paseo/Electron 44) | untested |
| Short-lived embedding process | works, exits and returns ~1 GB | untested |
| Authoritative backlinks from Obsidian's own index | used when enrichment is on, index fallback otherwise | index only |
| Obsidian fuzzy-search signal | added to fusion (weight 0.6) | absent, search still works |
| Live vault events (SSE) | supplement the filesystem watcher | filesystem watcher only |
| "Open note in Obsidian" | works | reported as unavailable |

Enrichment through the Obsidian Local REST API plugin is optional and off by default. The bridge never requires the app:
when it is closed every capability above falls back to the disk index and status reports the reason.

## Known limitations

- **A native binary is now part of the plugin.** `onnxruntime-node` ships prebuilt N-API binaries for linux-x64 (and other
  platforms); npm 12's blocked install scripts are fine because the binaries are inside the tarball. This is still a
  platform-specific artifact, unlike the pure-Node FTS path.
- **First semantic run needs network.** The model (~118 MB for `q8`) is downloaded from Hugging Face into
  `$PASEO_HOME/plugins/obsidian-bridge/models` and cached there; every later run is offline.
- **RAM:** ~0.5 GB while the query model is loaded, ~1.1 GB peak for the embedding process. Inside 2 GB the plugin says
  nothing; 2–4 GB is a warning in the panel and in status; there is no hard limit, by product decision.
- **Vocabulary and language** are the model's; `Xenova/multilingual-e5-small` covers Russian and English, a monolingual
  model would not.

- **Append-only writes.** Documents can be created and appended, never edited in place, moved, renamed or deleted. The
  write boundary is the configured `vaultPath` plus the `inbox`/`out`/`raw` roles inside it.
- **Retrieval needs either vocabulary or the local model.** FTS + graph cover exact terms; a query with no shared
  vocabulary relies on the semantic signal, which needs the model download and a built vector index (or Obsidian's fuzzy
  signal when enrichment is on).
- **Obsidian's link graph is approximated.** Basename/alias resolution plus ambiguity detection covers ordinary
  `[[wikilink]]` use, but Obsidian's own resolution of duplicate basenames and block references may differ; ambiguous
  basenames are reported as unresolved rather than guessed.
- **Dataview, Canvas, bases and rendered content are not evaluated.** Only literal file content is indexed.
- **Large vaults.** Chunk BM25 and brute-force-free retrieval keep search fast, but the first scan is linear in note count;
  a very large vault is a one-off wait plus a reconcile every `reconcileMinutes`.
- **One vault.** A single `vaultPath` per plugin installation. A multi-vault registry is not implemented.
- **Enrichment needs a running Obsidian** and its Local REST API plugin. It is optional; without it the fuzzy signal, live
  events, authoritative link metadata and "Open in Obsidian" are simply absent. The API key sits in the mirrored settings
  file (`0600`), because the agent-side MCP process reads the same settings.
- **Attachment metadata.** Non-Markdown files are listed only if they appear as embed targets; binary content is not read.

## Platform plans

- **Linux** — primary target, verified.
- **macOS** — planned. `node:sqlite` and `fs.watch(recursive)` behave the same; the unresolved item is the MCP bundle's
  Node discovery on machines where only the desktop app ships a runtime.
- **Windows** — planned. Path handling already normalizes separators; `O_APPEND` semantics and the vault path format need
  verification before it is claimed as supported.

## Paseo API surface used

| API | Where | Minimum |
| --- | --- | --- |
| `server.registerSettings` | `index.server.ts` | 0.15.0 |
| `server.addHook("agent.open.before")` | `index.server.ts` | 0.15.0 |
| `defineAgentTool` | `server/agent-tools.ts` | 0.15.0 |
| `defineRpc` / `server.handle` | `shared/contracts.ts`, `index.server.ts` | 0.15.0 |
| `client.addScreen`, `addSidebarHeaderItem`, `addSettingsScreen`, `addCommandCenterItem` | `index.client.tsx` | 0.15.0 |
| `client.addWorkspacePanel`, `client.addAttachmentSource` | `index.client.tsx` | 0.15.0 |
| `useSettings`, `useRpc`, `SidebarRow`, settings UI primitives | `client/*` | 0.15.0 |
