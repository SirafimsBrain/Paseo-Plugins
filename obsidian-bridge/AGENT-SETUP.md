# Obsidian Bridge — agent setup (standalone MCP)

This document is written for an agent that has to connect the Obsidian Bridge MCP server, and for the user who
installed it. The installation directory contains this file; the server, its settings and its index are next to it.

`obsidian-bridge-install.sh` installs a stdio MCP server that answers questions about one local directory of Markdown
files. It has no dependency on Paseo: no daemon, no plugin host, no `~/.paseo` directory.

## Files in this installation

| Path | What it is |
| --- | --- |
| `dist/mcp-server.js` | The stdio MCP server. This is the only file a client launches. |
| `settings.json` | The settings the server reads: `vaultPath`, directory roles, search limits. |
| `settings.example.json` | An empty settings document for a prebuilt archive; copy it to `settings.json` and set `vaultPath`. |
| `install.json` | Install metadata: version, git ref, install time, installed skills. **Do not edit.** |
| `installed-skills.txt` | The skills this installer copied into the skills root; `--uninstall` uses it. |
| `data/vaults/<hash>/index.db` | The SQLite index of one vault (FTS5). Rebuildable with `obsidian_index`. |
| `AGENT-SETUP.md` | This document. |
| `skills/<name>/SKILL.md` | The shipped Agent Skills; only the selected ones are copied into your skills root. |

The server resolves this directory from its own location (`dist/../install.json`), so a client only has to name the
entry point. `OBSIDIAN_BRIDGE_HOME` overrides it when the server is launched from somewhere else; it accepts an
absolute path, `~`, `~/…` or a path relative to the home directory.

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
    "vaultPath": "~/.obsidian/Main/Paseo",
    "inboxDir": "Inbox",
    "outDir": "Documentation",
    "rawDir": "raw",
    "planRoot": "Projects",
    "semanticSearch": false
  }
}
```

`writtenBy` must stay `obsidian-bridge`: the server treats a file without that marker as somebody else's data and
ignores it as a whole, falling back to the environment and its defaults. The installer writes the file atomically with
mode `0600`; a symlink, another owner or a group-writable file is refused.

Absolute paths, `~`, `~/…` and paths relative to the home directory are accepted. The server reads `settings.json` on
every request, so an edit applies to the next tool call without restarting the MCP client.

### Settings the server reads

| Key | Default | Meaning |
| --- | --- | --- |
| `vaultPath` | `""` | The one directory the server may touch. Empty closes every tool. |
| `inboxDir` / `outDir` / `rawDir` | `Inbox` / `Documentation` / `raw` | Vault-relative roles: incoming sources, authored documents, scratch. |
| `planRoot` | `Projects` | Root of the plan tree used by the `plan_*` tools. |
| `allowedExtensions` | `.md` | Extensions the read/edit tools accept. Indexing is Markdown-only. |
| `indexingEnabled` | `true` | Keep the index current and refresh it before a search. |
| `includeFolders` / `excludeGlobs` | `""` / `.obsidian/**, .trash/**, .git/**, .smart-env/**` | What belongs to the knowledge base. |
| `ftsStemming` | `false` | Use the `porter` FTS5 stemmer instead of `unicode61`. |
| `reconcileMinutes` | `10` | Paseo plugin reconcile timer; unused by a standalone server. |
| `indexRefreshSeconds` | `15` | Minimum interval between automatic scans from `obsidian_search` (1–3600). |
| `readOnly` | `false` | Refuse every write tool. |
| `maxResults`, `searchBudgetChars`, `snippetChars` | `10`, `8000`, `600` | Result shape. |
| `maxWriteChars` | `200000` | Maximum body length for one written document. |
| `semanticSearch` | `false` in an installer-written file | Use vectors only when the vault already has them. Standalone installs do not build vectors. |
| `embeddingModel`, `embeddingDtype`, `embeddingIdleMinutes` | `Xenova/multilingual-e5-small`, `q8`, `10` | Query-side embedding settings, used only with existing vectors. |
| `obsidianApiEnabled`, `obsidianApiUrl`, `obsidianApiKey` | `false`, `https://127.0.0.1:27124`, `""` | Optional Local REST API enrichment. |

Every runtime key has an `OBSIDIAN_*` environment variable and the environment wins over the file:
`OBSIDIAN_VAULT_PATH`, `OBSIDIAN_INBOX_DIR`, `OBSIDIAN_OUT_DIR`, `OBSIDIAN_RAW_DIR`, `OBSIDIAN_PLAN_ROOT`,
`OBSIDIAN_ALLOWED_EXTENSIONS`, `OBSIDIAN_INCLUDE_FOLDERS`, `OBSIDIAN_EXCLUDE_GLOBS`, `OBSIDIAN_INDEXING_ENABLED`,
`OBSIDIAN_FTS_STEMMING`, `OBSIDIAN_RECONCILE_MINUTES`, `OBSIDIAN_INDEX_REFRESH_SECONDS`, `OBSIDIAN_MAX_RESULTS`,
`OBSIDIAN_SEARCH_BUDGET_CHARS`, `OBSIDIAN_SNIPPET_CHARS`, `OBSIDIAN_READ_ONLY`, `OBSIDIAN_MAX_WRITE_CHARS`,
`OBSIDIAN_SEMANTIC_SEARCH`, `OBSIDIAN_EMBEDDING_MODEL`, `OBSIDIAN_EMBEDDING_DTYPE`,
`OBSIDIAN_EMBEDDING_IDLE_MINUTES`, `OBSIDIAN_API_ENABLED`, `OBSIDIAN_API_URL`, `OBSIDIAN_API_KEY`.

## What the agent gets

31 tools, all described in `tools/list`. The ones an agent needs first:

| Tool | Purpose |
| --- | --- |
| `obsidian_directories` | The role map and whether writes are enabled. Answers without opening an index — use it to verify the configuration. |
| `obsidian_search` | Hybrid search over headings, titles, tags and (when vectors exist) vectors. Refreshes the index first. |
| `obsidian_read` | A whole note or one heading subtree. |
| `obsidian_outline` | Headings, frontmatter, tags, links, backlinks of one note. |
| `obsidian_index` | Rebuilds the index now. |
| `obsidian_status` | Counts, freshness, write state, vector coverage, memory. |
| `plan_*` | Planning tree under `planRoot`, with revisions, snapshots and one writer at a time. |

The contract is stated in the `initialize` instructions and repeated in every description: this is a reference library
for the user's notes, not an agent's memory, and writes are append-only inside the configured roles.

## Freshness

A standalone server has no plugin process watching the disk, so `obsidian_search` runs an incremental scan when the
last one is older than `indexRefreshSeconds` (default 15 seconds; only changed files are re-read) and reports what it
did:

```json
"index": { "lastScanAt": "2026-11-23T10:00:00.000Z", "scannedNow": true, "notes": 42, "hint": null }
```

When nothing matched, `hint` says whether the index is empty or the note is likely excluded. A note created a moment
ago is therefore visible without calling `obsidian_index`, which stays available for a forced rebuild. The Paseo plugin
does not run this scan: its watcher owns the index.

## Semantic search

Lexical search (FTS5, titles, tags and the wikilink graph) is always available and needs nothing beyond Node. The
standalone installation does not build embeddings: vectors are produced by the Paseo plugin, and a standalone vault
therefore has none. `obsidian_search` never loads a model for a query it cannot compare with anything, and reports
`semantic.used: false` with a note instead. `obsidian_status` shows the vector coverage.

There is no `--with-semantic` flag: it installed ~380 MB of runtime that a standalone installation had no job to use.
If you need semantic retrieval, use the Paseo plugin.

## Skills

The installer copies only the `obsidian-bridge` skill by default. The three planning skills are available with
`--with-planning-skills` and carry an `obsidian-` prefix, so they cannot overwrite a generic `planning-*` skill owned by
another plugin:

| Skill | Purpose |
| --- | --- |
| `obsidian-bridge` | Reading, citing and writing vault notes. |
| `obsidian-planning-create` | Growing a plan tree. |
| `obsidian-planning-execute` | Carrying a plan through the work. |
| `obsidian-planning-review` | Reviewing plan against fact. |

`--no-skills` skips the copy. `--uninstall` removes only the directories recorded in `installed-skills.txt` whose
`SKILL.md` carries the installer marker. The legacy generic `planning-*` directories from 0.23.x–0.24.x are left alone
unless `--force` is passed.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot find module 'node:sqlite'` or `No such built-in module` | Node older than 22.13 (or 23.4), or a build without SQLite. Install Node.js 22.13+ / 23.4+ (24 or 26 recommended). |
| `The Obsidian directory is not configured` | `vaultPath` is empty. Set it in `settings.json`, `--vault`, or `OBSIDIAN_VAULT_PATH`. |
| `Obsidian directory '…' is not a readable directory` | The path does not exist or is not a directory for this user. |
| Search returns the same old notes | `indexingEnabled` is `false`, or the files are outside `includeFolders` / inside `excludeGlobs`. `obsidian_status` shows the last scan time; `obsidian_index` forces a rebuild. |
| Writes answer "read-only" | `readOnly: true` in settings, or `OBSIDIAN_READ_ONLY=1`. |
| A plan write says another agent is writing | One writer per plan tree, ten-second wait. Re-read the node and repeat; nothing was written. |
| `data/vaults` grows | One SQLite file per configured directory, keyed by a hash of its path. Removing the directory's folder rebuilds it on the next search. |

## Update and uninstall

```bash
# Update to the current release described by main
curl -fsSL https://raw.githubusercontent.com/SirafimsBrain/Paseo-Plugins/main/obsidian-bridge/obsidian-bridge-install.sh \
  | bash

# Pin another release explicitly
curl -fsSL https://raw.githubusercontent.com/SirafimsBrain/Paseo-Plugins/main/obsidian-bridge/obsidian-bridge-install.sh \
  | bash -s -- --version 0.25.22

# Remove the installation and the skills it recorded
curl -fsSL https://raw.githubusercontent.com/SirafimsBrain/Paseo-Plugins/main/obsidian-bridge/obsidian-bridge-install.sh \
  | bash -s -- --uninstall
```

An update keeps `vaultPath` and `semanticSearch`; it writes `settings.json` atomically and leaves an unreadable or
foreign file as a timestamped backup. A planning-skill choice is sticky across updates. `--uninstall` refuses a
directory without `install.json` unless `--force` is passed, and removes only the installation and the marked skills it
recorded — never the vault.

`--dir`, `--no-skills`, `--with-planning-skills`, `--no-planning-skills`, `--skills-dir`, `--force` and `--dry-run` are
documented in `--help`. The installer requires Node 22.13+ (or 23.4+), `git` (or `curl` and `tar`), and `npm`; it builds
the bundle from source with `esbuild`, so no prebuilt binary is downloaded.

### Prebuilt archive

The GitHub Release also carries `obsidian-bridge-mcp-<version>.tar.gz`. Extract it into a new directory, then:

```bash
cp settings.example.json settings.json
chmod 600 settings.json
# edit vaultPath in settings.json
```

The archive does not copy skills into `~/.agents/skills`; use the installer, or copy `skills/obsidian-bridge` yourself.
`install.json` in the archive marks the directory as a standalone installation, so the client block needs no
`OBSIDIAN_BRIDGE_HOME`.

## Relationship to the Paseo plugin

The Paseo plugin (`paseo plugin add …:obsidian-bridge`) and this installation run the same `server/` sources and the same
bundler. The differences are the data root (`$PASEO_HOME/plugins/obsidian-bridge` versus this directory), the settings
surface (a Paseo settings screen versus `settings.json`), who keeps the index current (the plugin's watcher versus the
scan before a search), semantic embeddings (the plugin's embedding job versus none) and the absence of the Paseo-only
UI (panels, slash command, injection hooks). A vault indexed by one is not shared with the other; point both at the same
directory only if you want two indexes.
