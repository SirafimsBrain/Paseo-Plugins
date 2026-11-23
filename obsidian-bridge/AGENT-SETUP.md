# Obsidian Bridge — agent setup (standalone MCP)

This document is written for an agent that has to connect the Obsidian Bridge MCP server, and for the user who
installed it. The installation directory contains this file; the server, its settings and its index are next to it.

`obsidian-bridge-install.sh` installed a stdio MCP server that answers questions about one local directory of Markdown
files. It has no dependency on Paseo: no daemon, no plugin host, no `~/.paseo` directory.

## Files in this installation

| Path | What it is |
| --- | --- |
| `dist/mcp-server.js` | The stdio MCP server. This is the only file a client launches. |
| `dist/embed-worker.js` | Short-lived embedding process, used only when semantic search is installed. |
| `settings.json` | The settings the server reads: `vaultPath`, directory roles, search limits. |
| `install.json` | Install metadata: version, git ref, install time, semantic stack present. **Do not edit.** |
| `data/vaults/<hash>/index.db` | The SQLite index of one vault (FTS5). Rebuildable with `obsidian_index`. |
| `data/models/` | Embedding model cache, when a model was downloaded. |
| `AGENT-SETUP.md` | This document. |
| `skills/<name>/SKILL.md` | The four Agent Skills, also copied into your skills root. |

The server resolves this directory from its own location (`dist/../install.json`), so a client only has to name the
entry point. `OBSIDIAN_BRIDGE_HOME` overrides it when the server is launched from somewhere else.

## Connect a client

Replace `/path/to/node` with `command -v node` and `/path/to/install` with this directory's absolute path.

```json
{
  "mcpServers": {
    "obsidian-bridge": {
      "command": "/path/to/node",
      "args": ["/path/to/install/dist/mcp-server.js"]
    }
  }
}
```

Claude Code (`~/.claude.json` or project `.mcp.json`), Codex (`~/.codex/config.toml`, `[mcp_servers.obsidian-bridge]`),
OpenCode, Cline and Kimi Code all accept this stdio shape; only the file that holds it differs. A client that only
supports remote servers needs a stdio-to-HTTP bridge, which this project does not ship.

Verify the connection: `initialize` must answer `serverInfo.name = "obsidian-bridge"`, and `tools/list` must return 31
tools, the first being `obsidian_directories`. A `tool obsidian_directories failed` answer that says the directory is not
configured means the client is connected and the vault is missing — see below.

## Point the server at a vault

One directory is configured, and it is the whole boundary: nothing above it is reachable, and a symlink cannot step
outside it. Three ways, in order of precedence:

1. `OBSIDIAN_VAULT_PATH` in the client's `env` block (highest priority).
2. `vaultPath` in `settings.json`.
3. The installer flag `--vault <path>` (writes option 2 for you).

```json
{
  "writtenBy": "obsidian-bridge",
  "values": {
    "vaultPath": "~/Obsidian/Main",
    "inboxDir": "Inbox",
    "outDir": "Documentation",
    "rawDir": "raw",
    "planRoot": "Projects",
    "semanticSearch": false
  }
}
```

`writtenBy` must stay `obsidian-bridge`: the server treats a file without that marker as somebody else's data and
ignores it as a whole, falling back to the environment and its defaults. The file is written `0600`, and a symlink,
another owner or a group-writable file is refused.

Absolute paths, `~`, `~/…` and paths relative to the home directory are accepted.

### Settings the server reads

| Key | Default | Meaning |
| --- | --- | --- |
| `vaultPath` | `""` | The one directory the server may touch. Empty closes every tool. |
| `inboxDir` / `outDir` / `rawDir` | `Inbox` / `Documentation` / `raw` | Vault-relative roles: incoming sources, authored documents, scratch. |
| `planRoot` | `Projects` | Root of the plan tree used by the `plan_*` tools. |
| `allowedExtensions` | `.md` | Extensions the read/edit tools accept. Indexing is Markdown-only. |
| `indexingEnabled` | `true` | Keep the index current and refresh it before a search. |
| `includeFolders` / `excludeGlobs` | `""` / `.obsidian/**, .trash/**, .git/**, .smart-env/**` | What belongs to the knowledge base. |
| `readOnly` | `false` | Refuse every write tool. |
| `maxResults`, `searchBudgetChars`, `snippetChars` | `10`, `8000`, `600` | Result shape. |
| `semanticSearch` | `true` | Use vectors when the vault has any. Without the embedding stack only lexical signals run. |
| `embeddingModel`, `embeddingDtype` | `Xenova/multilingual-e5-small`, `q8` | Model used for vectors. |

Every key also has an `OBSIDIAN_*` environment variable (`OBSIDIAN_INBOX_DIR`, `OBSIDIAN_MAX_RESULTS`,
`OBSIDIAN_SEMANTIC_SEARCH=0`, …), and the environment wins over the file.

## What the agent gets

31 tools, all described in `tools/list`. The ones an agent needs first:

| Tool | Purpose |
| --- | --- |
| `obsidian_directories` | The role map and whether writes are enabled. Answers without opening an index — use it to verify the configuration. |
| `obsidian_search` | Hybrid search over headings, titles, tags and (when embeddings exist) vectors. Refreshes the index first. |
| `obsidian_read` | A whole note or one heading subtree. |
| `obsidian_outline` | Headings, frontmatter, tags, links, backlinks of one note. |
| `obsidian_index` | Rebuilds the index now. |
| `obsidian_status` | Counts, freshness, write state, vector coverage, memory. |
| `plan_*` | Planning tree under `planRoot`, with revisions, snapshots and one writer at a time. |

The contract is stated in the `initialize` instructions and repeated in every description: this is a reference library
for the user's notes, not an agent's memory, and writes are append-only inside the configured roles.

## Freshness

A standalone server has no plugin process watching the disk, so `obsidian_search` runs an incremental scan when the
last one is older than 15 seconds (only changed files are re-read) and reports what it did:

```json
"index": { "lastScanAt": "2026-11-23T10:00:00.000Z", "scannedNow": true, "notes": 42, "hint": null }
```

When nothing matched, `hint` says whether the index is empty or the note is likely excluded. A note created a moment
ago is therefore visible without calling `obsidian_index`, which stays available for a forced rebuild.

## Semantic search

Lexical search (FTS5 + titles + tags) is always available and needs no model. Semantic search needs the optional stack:

```bash
curl -fsSL https://raw.githubusercontent.com/SirafimsBrain/Paseo-Plugins/main/obsidian-bridge/obsidian-bridge-install.sh \
  | bash -s -- --with-semantic
```

That installs `@huggingface/transformers` and its ONNX runtime (~380 MB on disk) into this directory. The first search
downloads the model (~118 MB for the default `q8` e5-small) into `data/models/` and then runs offline.

`obsidian_search` only embeds the query when the vault already has vectors. A vault installed without Paseo has no
process building them, so a standalone installation reports `semantic.used: false` with a note and answers from lexical
signals — expected, not an error.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot find module 'node:sqlite'` or `No such built-in module` | Node older than 22.13, or a build without SQLite. Install Node.js 22.13+ (24 or 26 recommended). |
| `The Obsidian directory is not configured` | `vaultPath` is empty. Set it in `settings.json`, `--vault`, or `OBSIDIAN_VAULT_PATH`. |
| `Obsidian directory '…' is not a readable directory` | The path does not exist or is not a directory for this user. |
| Search returns the same old notes | `indexingEnabled` is `false`, or the files are outside `includeFolders` / inside `excludeGlobs`. `obsidian_status` shows the last scan time; `obsidian_index` forces a rebuild. |
| Writes answer "read-only" | `readOnly: true` in settings, or `OBSIDIAN_READ_ONLY`. |
| A plan write says another agent is writing | One writer per plan tree, ten-second wait. Re-read the node and repeat; nothing was written. |
| `data/vaults` grows | One SQLite file per configured directory, keyed by a hash of its path. Removing the directory's folder rebuilds it on the next search. |

## Update and uninstall

```bash
# Update to the latest release
curl -fsSL https://raw.githubusercontent.com/SirafimsBrain/Paseo-Plugins/main/obsidian-bridge/obsidian-bridge-install.sh \
  | bash -s -- --version 0.23.21

# Remove the installation and its skills
curl -fsSL https://raw.githubusercontent.com/SirafimsBrain/Paseo-Plugins/main/obsidian-bridge/obsidian-bridge-install.sh \
  | bash -s -- --uninstall
```

`--dir`, `--no-skills`, `--skills-dir` and `--dry-run` are documented in `--help`. The installer requires Node 22.13+,
`git` (or `curl` and `tar`), and `npm`; it builds the bundle from source with `esbuild`, so no prebuilt binary is
downloaded. Uninstalling removes this directory — including the index and the model cache — and the four skill
directories; it never touches the vault.

## Relationship to the Paseo plugin

The Paseo plugin (`paseo plugin add …:obsidian-bridge`) and this installation run the same `server/` sources and the same
bundler. The differences are the data root (`$PASEO_HOME/plugins/obsidian-bridge` versus this directory), the settings
surface (a Paseo settings screen versus `settings.json`), who keeps the index current (the plugin's watcher versus the
scan before a search) and the absence of the Paseo-only UI (panels, slash command, injection hooks). A vault indexed by
one is not shared with the other; point both at the same directory only if you want two indexes.
