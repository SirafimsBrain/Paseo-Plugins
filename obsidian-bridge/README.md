# Obsidian Bridge

A bridge from [Paseo](https://paseo.sh/) to a local [Obsidian](https://obsidian.md/) vault: coding agents can look up
documents, plans, recommendations and research in the vault, cite the note they took an answer from, and write the
document they were asked for into the right folder.

**It is a reference library, not an agent's memory.** The tools are available to every agent so that an agent *can* answer
a request, but nothing here makes an agent consult the vault on its own, and nothing is read or written unless the prompt
asks for it. An agent's own working memory belongs to [`memory-flash`](../memory-flash/README.md); project planning
belongs to [`luck-planner`](../luck-planner/README.md).

Technical description, design decisions and the roadmap: [__doc.md](./__doc.md). Research that led to this design:
[__research.md](./__research.md).

## What it does (0.9.11)

- **Indexes a directory from disk.** Notes, YAML frontmatter, tags, `[[wikilinks]]` and heading structure go into a local
  SQLite index with FTS5. Obsidian does not have to be running.
- **Hybrid search.** Full-text over heading chunks, fused (Reciprocal Rank Fusion) with title/alias matches, one-hop
  wikilink proximity and a local semantic signal, packed into a bounded answer with note paths, headings and the
  directory role.
- **Semantic search, in-process.** `@huggingface/transformers` runs a multilingual e5-small ONNX model inside Node — no
  Ollama, no Python, no Docker, no vector database. Vectors live in the same SQLite index and are built by a short-lived
  child process, so a full re-embedding does not pin gigabytes inside the daemon. Unchanged notes are never re-read
  into vectors, and an edited note only re-embeds the sections whose text changed.
- **Read tools.** `obsidian_search`, `obsidian_read` (whole note or one heading subtree), `obsidian_outline`,
  `obsidian_list`, `obsidian_links`, `obsidian_directories`, plus `obsidian_index`, `obsidian_diagnose` and
  `obsidian_status`. The workspace tab and the composer attachment picker use the same index.
- **Append-only write tools.** `obsidian_write_document` (authored documents), `obsidian_write_scratch` (intermediate
  notes) and `obsidian_append_inbox` (add material to incoming sources). Every write names its note, appends a dated
  section, and never rewrites, moves or deletes anything.
- **An agent skill, shipped with the plugin.** `skills/obsidian-bridge/SKILL.md` teaches the read → cite workflow,
  where a write is allowed, the exact-fragment edit rule and the Obsidian Markdown vocabulary an agent actually needs.
  The plugin installs it into every skills directory that exists (`~/.agents/skills` first, then OpenCode, Cline, Kilo,
  Kimi, Qwen, Codex, Claude Code), verifies the copies on load, after a settings change and every five minutes, repairs
  anything that drifted, and removes them when the switch is off. The settings screen shows the state of every agent
  config entry and skill copy, so "is it installed correctly?" is a visible answer rather than a guess. The official Obsidian skills (Obsidian Flavored Markdown, Bases, JSON Canvas, Obsidian CLI) are a separate,
  upstream project — [obsidianmd/obsidian-skills](https://github.com/obsidianmd/obsidian-skills); this plugin ships its own
  skill so the workflow can be reviewed and versioned together with the tools it describes.
- **Exact-fragment edit of any existing note.** `obsidian_edit` takes a vault path, an `old_text` that must occur exactly
  once and its `new_text`: the one tool that can change a note outside the inbox/out/raw roles (a note the user filed in a
  project folder, a moved document). The rest of the file — frontmatter, other sections, whitespace — is written back byte
  for byte; the file is replaced atomically and only when it did not change while being read; a symlink leading outside the
  directory is refused, and nothing is ever created.
- **Directory roles.** One directory is available to Paseo; inside it four roles tell an agent where to work. Nothing above
  the configured directory can be addressed at all.
- **Inert injection.** The MCP server is saved into a new agent on `agent.create.before` and re-contributed on
  `agent.open.before` — no probing, no scanning, no latency in the path that opens an agent. Providers without MCP support
  get the same operations as native agent tools.
- **OpenCode, Kilo and Cline config registration.** Paseo 0.15.x refuses custom MCP servers on an OpenCode agent that shares the
  local OpenCode service, and OpenCode does not surface attached tools, so the plugin also writes an `obsidian-bridge`
  entry into the agents' own `opencode.json`/`kilo.jsonc` MCP config, and Cline never spawns a stdio server from the
  session payload, so its entry goes into `~/.cline/data/settings/cline_mcp_settings.json` (separate switch, on by
  default). The entries survive the idle-runtime release and plugin updates, and are removed when a switch is turned off.
- **Optional Obsidian enrichment.** With the Local REST API plugin, Obsidian's own fuzzy search joins retrieval, its
  metadata cache becomes the authoritative link source, vault events supplement the file watcher, and the panel can open
  a note in the app. Off or unavailable leaves everything else unchanged.
- **Composer attachment and workspace tab.** Attach a note to a prompt as a text snapshot from the composer's attachment
  picker, and search/preview the vault in a workspace tab beside agents and terminals.
- **Stable MCP path (0.9.11).** Every start publishes one copy of the bundled server at
  `$PASEO_HOME/plugins/obsidian-bridge/mcp-server.js` and injects/registers that path, so a `paseo plugin update`
  (which replaces the versioned checkout) no longer leaves already-created agents launching a file that is gone. The same
  start restores a missing bundle at the path such an agent still names, only inside the plugin's own directory.
- **Live status (0.9.11).** The screen and the workspace tab subscribe to `obsidian-bridge.status-stream` (Paseo 0.16.0
  `addSubscription`): the plugin pushes a complete snapshot on subscribe and after a scan, a watched-note flush, a
  reconcile or a settings change, so counts, freshness, semantic coverage and a finished reindex update without polling.
- **Citations from the composer (0.9.11).** An `Insert Obsidian note links` control searches the prompt you already typed
  and inserts one `[[note#heading|title]]` line per hit at the cursor — the lighter gesture next to attaching a whole note.
  Nothing is read or written in the vault, and the inserted links are ordinary editable text.
- **Per-agent injection marker (0.9.11).** Each hook records how an agent was provisioned
  (`obsidian-bridge: { mode: "mcp" | "tool" | "config" | "skipped", reason, at }`) in the daemon's agent `metadata`:
  via the create hook's result, and via `setMetadata` on later opens, because 0.16.0 lets `agent.open.before` change only
  `env`, `tools` and `mcpServers`. An agent whose marker says `mcp` also skips the capability probe on later opens.
- **Everything configured in Paseo.** Settings → Plugins → Obsidian Bridge. There is no separate HTTP configuration server.
- **Knowledge-base screen.** Status and index freshness, the role map, the same search engine the agents use, note preview
  with backlinks, and a reindex button.

## Directory roles

The plugin is given **one** directory it may touch at all — either a whole vault or a project directory inside one, for
example `~/.obsidian/Main/Paseo`. Agents cannot reach anything above it. Inside it three further roles are configured as
paths relative to that directory:

| Role | Default | What lives there | Agent behaviour |
| --- | --- | --- | --- |
| Directory available to Paseo | — | the project's working material | read everything inside; write only through the roles below |
| `inbox` | `Inbox` | converted documents, reference books, primary sources | read; append only when asked |
| `out` | `Documentation` | authored documents produced on request (guides, instructions, recommendations) | write here |
| `raw` | `raw` | clarifications, bugfix alternatives, intermediate notes that lose value after the work | write freely |

`obsidian_directories` returns this map (with the resolved absolute root, roles and whether writes are enabled), and the
same map is part of the MCP `initialize` instructions, so an agent asked to "write this into Obsidian" knows where the
document belongs. Every search hit and listing carries its role.

## Secrets

The bridge indexes the vault **as it is on disk** and never decrypts anything: parsing, search and the embedding model
are local, and no note text leaves the machine. Hiding secrets is the vault owner's responsibility. With an in-place
encryption plugin such as [Inline Secret Block](https://github.com/vnrtmnv/obsidian-inline-secret-block), a `secret`
fence is stored as `secret-lock` plus AES-256-GCM ciphertext, so the bridge chunks, indexes and embeds only ciphertext —
the plaintext never reaches the index, a snippet, an agent or a vector. There is deliberately no secret detection and no
frontmatter redaction: a heuristic that misses one note would be worse than a clear rule. Notes that must not be indexed
at all belong outside `vaultPath`/`includeFolders`, or under an `excludeGlobs` pattern; the next scan drops them from the
index together with their chunks and vectors. Details: [__doc.md](./__doc.md) §12.

## Obsidian enrichment (optional)

Everything works with Obsidian closed. If you want the extra signals, install the
[Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin, copy its API key
from **Settings → Local REST API with MCP**, and enable enrichment in the Paseo settings screen. It adds Obsidian's fuzzy
search as a lower-weighted retrieval signal, authoritative `links`/`backlinks` from Obsidian's metadata cache, live vault
events on top of the filesystem watcher, and **Open in Obsidian**. The default URL is `https://127.0.0.1:27124`; its
self-signed certificate is accepted only for loopback hosts. The key is stored locally (the mirrored settings file is
`0600`), never logged, and never sent anywhere except the configured URL. A closed app or a wrong key degrades search to
the normal lexical + graph + semantic path and is reported in the panel and `obsidian_status`.

## Requirements

- Paseo `>= 0.15.0`; verified against the 0.16.0 release (0.16.1 host) — see
  [__compatibility.md](./__compatibility.md).
- Node.js `>= 22.5` on the daemon host (the index uses the built-in `node:sqlite` with FTS5; verified on Node 24).
- Semantic search downloads a model once (~118 MB for the default q8 e5-small) into
  `$PASEO_HOME/plugins/obsidian-bridge/models`, then runs offline. ~0.5 GB RAM while the model is loaded; up to 2 GB is
  treated as normal, 2–4 GB shows a warning in the panel (never a hard limit).
- Optional: Obsidian running with the Local REST API with MCP plugin, for the fuzzy signal, authoritative backlinks,
  live events and "Open in Obsidian".
- A local directory of Markdown files. The Obsidian application itself is **not** required, and nothing needs to be
  installed into Obsidian.
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
2. Enter the path of the directory available to Paseo (a vault root, or a project directory inside one) and press
   **Check path**. Absolute paths, `~` and paths relative to your home directory all work (`~/.obsidian/Main/Paseo`,
   `.obsidian/Main/Paseo`). The check reports how many Markdown files it found.
3. Set the `Inbox`, `Documentation` and `raw` directories. Defaults match the layout above; clear one to disable that role.
4. Save. Saving a valid path starts the first scan — that is the only point at which the plugin touches the disk, and it is
   triggered by you, not by an agent.
5. Open **Obsidian Bridge** in the sidebar to see the index status, the role map and search the vault.

If the path is not configured, nothing is indexed and every tool answers with an instruction to configure it.

## Write semantics

- A write always names its note: there is no default document, and the inbox is never used as a fallback.
- Existing notes are **appended**: a `## <date> — <title>` section is added, the rest of the file is untouched.
- A missing note is created only when `create` is requested, with `title`, `kind` (role) and `created` frontmatter.
- An identical body already present in the document is reported as a duplicate and skipped.
- Documents larger than `maxWriteChars` (default 200 000 characters) are refused with a request to split them.
- The **Refuse writes** switch turns every write tool off without affecting reads.

## What agents get

| Tool | Purpose |
| --- | --- |
| `obsidian_directories` | The role map: which directory is for what, and whether writes are enabled. |
| `obsidian_search` | Hybrid search: query, optional `folder`, `tags`, `scope`, `limit`, `budget_chars`. |
| `obsidian_read` | A note or one heading subtree. |
| `obsidian_outline` | Headings, frontmatter keys, tags, links and backlinks of one note. |
| `obsidian_list` | Notes under a folder with size, modification time and role. |
| `obsidian_links` | Resolved links and backlinks of a note, or the vault's unresolved links. |
| `obsidian_edit` | Replace one exact fragment (`old_text` → `new_text`) in an existing note by vault path. |
| `obsidian_write_document` | Append an authored document in `out`. |
| `obsidian_write_scratch` | Append a scratch note in `raw`. |
| `obsidian_append_inbox` | Append to a note in `inbox`. |
| `obsidian_index` | Rebuilds the index from disk. |
| `obsidian_diagnose` | recall@k of lexical vs hybrid retrieval over cases you supply. |
| `obsidian_status` | Directory, role map, counts, freshness, write state, vector coverage, memory. |

The MCP server is registered under the name `obsidian-bridge`. When a provider cannot take an MCP server, the plugin
attaches the equivalent `obsidian_bridge_*` tools instead.

Every tool description states the rule the plugin is built around: use it only when the user explicitly asks about their
Obsidian notes, never as a place to record agent memory.

## Agent skill

The plugin ships its own [Agent Skills](https://agentskills.io/specification) skill at
[`skills/obsidian-bridge/SKILL.md`](./skills/obsidian-bridge/SKILL.md) and installs it on load into the skills directories
that exist: `~/.config/opencode/skills`, `~/.opencode/skills`, `~/.agents/skills`, `~/.claude/skills` (each as
`obsidian-bridge/SKILL.md`). Unchanged copies are not rewritten; the switch in the settings screen removes the directory.
A runtime that only scans skills at startup needs a restart to pick it up.

The official Obsidian skills are a separate upstream project, kept as the reference for the formats this plugin does not
cover — [github.com/obsidianmd/obsidian-skills](https://github.com/obsidianmd/obsidian-skills) (`obsidian-markdown`,
`obsidian-bases`, `json-canvas`, `obsidian-cli`, `knap`).

## Notes and limits

- Notes are read from disk, so the index is authoritative for search but a note's content is always re-read when opened.
- The index lives outside the directory, in `$PASEO_HOME/plugins/obsidian-bridge/vaults/<vault-id>/index.db`; it is never
  synced and can be deleted at any time (a scan rebuilds it).
- Semantic search needs the model download on its first run and keeps ~0.5 GB resident while loaded. Memory is a
  warning, not a limit: the plugin reports 2–4 GB in the panel and never refuses work because of it.
- Obsidian-side enrichment needs the app and its Local REST API plugin; without them the index, search, reads and writes
  behave exactly as before. See [__doc.md](./__doc.md) §13.
- Larger local models and external RAG providers are deliberate post-1.0 work: the project stays on the Paseo/Node base
  unless a requirement genuinely cannot be met there.
- Excluded from indexing: `.obsidian/`, `.trash/`, `.git/`, `.smart-env/` and anything matching your exclude globs. A
  note that stops matching is removed from the index together with its chunks and vectors.
