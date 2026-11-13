# Obsidian Bridge — compatibility

Detailed compatibility notes. The main README keeps only the summary table row and links here.

## Verified (2026-11-13, 0.2.1)

| Component | Version | Notes |
| --- | --- | --- |
| Paseo | `>= 0.15.0` | Uses `server.addHook("agent.open.before")`, `defineAgentTool`, `defineSettings`, `defineRpc`, `addScreen`, `addSidebarHeaderItem`, `addSettingsScreen`, `addCommandCenterItem`. |
| Node.js (daemon host) | `v24.20.0` verified; `>= 22.5` required | `node:sqlite` with FTS5 is used directly; no native modules, no `sqlite-vec`, no `npm` dependency at runtime. |
| OS | Linux (primary) | Paths, `fs.watch(recursive)` and the bundled MCP server were exercised here. |
| Obsidian | installed at `/opt/Obsidian/obsidian` | **Not required.** 0.2.0 reads the vault from disk, so the app can be closed, absent from `PATH`, or a different version. No community plugin is required in the vault. |
| Vault | any directory of Markdown files | `.obsidian` is used only as a hint in the path check; it is never read. The version of the installed Obsidian app is irrelevant in 0.2.0. |
| MCP client | stdio, protocol `2024-11-05` | `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Verified with a real spawned process in `tests/mcp-server-e2e.test.ts`. |

## Behaviour without the Obsidian application

Nothing in 0.2.0 depends on a running app:

| Capability | Obsidian running | Obsidian closed |
| --- | --- | --- |
| Scan, watch, reconcile | works | works |
| Search, read, outline, list, links | works | works |
| Append / create in `inbox`, `out`, `raw` | works | works |
| Authoritative backlinks from Obsidian's own index | not used in 0.2.0 | not used in 0.2.0 |
| Obsidian fuzzy-search signal | not used in 0.2.0 | not used in 0.2.0 |
| "Open note in Obsidian" | not shipped | not shipped |

Enrichment through the Obsidian Local REST API plugin is planned for 0.4.0 and will always be optional.

## Known limitations

- **Append-only writes.** Documents can be created and appended, never edited in place, moved, renamed or deleted. The
  write boundary is the configured `vaultPath` plus the `inbox`/`out`/`raw` roles inside it.
- **Lexical + graph retrieval only.** No embeddings yet, so a query with no shared vocabulary with the note will miss.
  Paraphrase-heavy vaults benefit from vocabulary that appears in the notes themselves.
- **Obsidian's link graph is approximated.** Basename/alias resolution plus ambiguity detection covers ordinary
  `[[wikilink]]` use, but Obsidian's own resolution of duplicate basenames and block references may differ; ambiguous
  basenames are reported as unresolved rather than guessed.
- **Dataview, Canvas, bases and rendered content are not evaluated.** Only literal file content is indexed.
- **Large vaults.** Chunk BM25 and brute-force-free retrieval keep search fast, but the first scan is linear in note count;
  a very large vault is a one-off wait plus a reconcile every `reconcileMinutes`.
- **One vault.** A single `vaultPath` per plugin installation. A multi-vault registry is not implemented.
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
| `useSettings`, `useRpc`, `SidebarRow`, settings UI primitives | `client/*` | 0.15.0 |
