# Obsidian Bridge

A bridge from [Paseo](https://paseo.sh/) to a local [Obsidian](https://obsidian.md/) vault: coding agents can look up
documents, plans, recommendations and research in the vault and cite the note they took an answer from.

**It is a reference library, not an agent's memory.** The tools are available to every agent so that an agent *can* answer
a request, but nothing here makes an agent consult the vault on its own, and nothing is read or written unless the prompt
asks for it. An agent's own working memory belongs to [`memory-flash`](../memory-flash/README.md); project planning
belongs to [`luck-planner`](../luck-planner/README.md). Obsidian Bridge is for "what does my documentation say?" and "write
this guide into Obsidian" — nothing else.

Technical description, design decisions and the roadmap: [__doc.md](./__doc.md). Research that led to this design:
[__research.md](./__research.md).

## What it does (0.1.0)

- **Indexes the vault from disk.** Notes, YAML frontmatter, tags, `[[wikilinks]]` and heading structure go into a local
  SQLite index with FTS5. Obsidian does not have to be running, and the plugin never writes into the vault.
- **Hybrid search.** Full-text over heading chunks, fused (Reciprocal Rank Fusion) with title/alias matches and one-hop
  wikilink proximity, packed into a bounded answer with note paths and headings so an answer can be cited.
- **Read tools.** `obsidian_search`, `obsidian_read` (whole note or one heading subtree), `obsidian_outline`,
  `obsidian_list`, `obsidian_links`, plus `obsidian_index` and `obsidian_status`.
- **Inert injection.** The MCP server is contributed on `agent.open.before` — no probing, no scanning, no latency in the
  path that opens an agent. Providers without MCP support get the same three read operations as native agent tools.
- **Everything configured in Paseo.** Settings → Plugins → Obsidian Bridge: vault path (validated before use), include
  folders, exclude globs, FTS stemming, reconcile interval, search budgets and the injection switch. There is no separate
  HTTP configuration server.
- **Knowledge-base screen.** Status and index freshness, the same search engine the agents use, note preview with
  backlinks, and a reindex button.

Read-only by design in 0.1.0: no tool creates, edits, moves or deletes notes. A single append-only inbox path is planned
for 0.2.0.

## Requirements

- Paseo `>= 0.15.0`.
- Node.js `>= 22.5` on the daemon host (the index uses the built-in `node:sqlite` with FTS5; verified on Node 24).
- A local Obsidian vault — a directory of Markdown files. The Obsidian application itself is **not** required: the vault
  is read from disk. Nothing else needs to be installed into Obsidian.
- Linux is the primary target; macOS and Windows are future work ([__compatibility.md](./__compatibility.md)).

## Installation

The plugin directory is appended to the repository source with `:`:

```bash
paseo plugin add https://github.com/SirafimsBrain/Paseo-Plugins.git:obsidian-bridge
paseo plugin update obsidian-bridge
```

The install runs `npm ci` and `npm run bundle`, which builds the standalone stdio MCP server at `dist/mcp-server.js`.

## First run

1. Open **Settings → Plugins → Obsidian Bridge**.
2. Enter the absolute path of the vault (the directory that contains your notes and `.obsidian`) and press **Check path**.
   The check reports how many Markdown files it found and whether the directory looks like a vault.
3. Save. Saving a valid path starts the first scan — that is the only point at which the plugin touches the disk, and it
   is triggered by you, not by an agent.
4. Open **Obsidian Bridge** in the sidebar to see the index status and search the vault.

If the path is not configured, nothing is indexed and every tool answers with an instruction to configure it. There is no
built-in guess and no fallback to a home directory.

## What agents get

| Tool | Purpose |
| --- | --- |
| `obsidian_search` | Hybrid search: query, optional `folder`, `tags`, `limit`, `budget_chars`. Ranked snippets with note path and heading. |
| `obsidian_read` | A note, one heading subtree, or nothing else — no scanning. |
| `obsidian_outline` | Headings, frontmatter keys, tags, links and backlinks of one note. |
| `obsidian_list` | Notes under a folder with size and modification time. |
| `obsidian_links` | Resolved links and backlinks of a note, or the vault's unresolved links. |
| `obsidian_index` | Rebuilds the index from disk. |
| `obsidian_status` | Vault path, index counts, freshness, read-only state. |

The MCP server is registered under the name `obsidian-bridge`. When a provider cannot take an MCP server (or the agent's
saved configuration cannot be read), the plugin attaches `obsidian_bridge_search`, `obsidian_bridge_read` and
`obsidian_bridge_status` instead.

Every tool description states the rule the plugin is built around: use it only when the user explicitly asks about their
Obsidian notes, never as a place to record agent memory.

## Notes and limits

- Notes are read from disk, so the index is authoritative for search but a note's content is always re-read when opened.
- The index lives outside the vault, in `$PASEO_HOME/plugins/obsidian-bridge/vaults/<vault-id>/index.db`; it is never
  synced and can be deleted at any time (a scan rebuilds it).
- Semantic (embedding) search, the append-only inbox write path and Obsidian-side enrichment (the Local REST API plugin)
  are planned, not shipped. See [__doc.md](./__doc.md) §8.
- Excluded from indexing: `.obsidian/`, `.trash/`, `.git/`, `.smart-env/` and anything matching your exclude globs.
