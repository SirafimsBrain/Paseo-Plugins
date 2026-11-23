# Obsidian Bridge

A bridge from [Paseo](https://paseo.sh/) to a local [Obsidian](https://obsidian.md/) vault: coding agents can look up
documents, plans, recommendations and research in the vault, cite the note they took an answer from, and write the
document they were asked for into the right folder.

**It is a reference library, not an agent's memory.** The tools are available to every agent so that an agent *can* answer
a request, but nothing here makes an agent consult the vault on its own, and nothing is read or written unless the prompt
asks for it. An agent's own working memory belongs to [`memory-flash`](../memory-flash/README.md); project planning is
handled by the `plan_*` tools in this plugin.

Technical description, design decisions and the roadmap: [__doc.md](./__doc.md). Research that led to this design:
[__research.md](./__research.md).

## What it does (0.23.21)

- **The server also installs without Paseo (0.23.18).** `obsidian-bridge-install.sh` builds the same bundle into
  `~/.agents/obsidian-bridge-mcp`, with its own settings file, index and `AGENT-SETUP.md`, for an agent runtime that has
  no Paseo daemon. The design, the measurements behind it and the rejected alternatives are in
  [__doc.md §19](./__doc.md); usage is [below](#standalone-mcp-server-no-paseo).
- **The agent is told when the vault matters (0.22.18).** Every session open that leaves the agent with the vault tools also
  appends one short instruction — search before answering from memory, cite the note path, write only when asked — for that
  session only (Paseo 0.17 `appendSystemPrompt`). The text is a setting, `{server}` expands to the prefix the tools carry,
  and an empty value switches it off.
- **A note as a Paseo file tab (0.22.18).** `.md`/`.markdown` files open in a read-only Markdown panel with their path and
  line range; the workspace tab keeps its query and preview across tab switches, a workspace-row badge shows a running
  index or an index error, and `/obsidian <query>` opens the knowledge base with the search already run.
- **Paseo 0.17.1 compatibility pass (0.21.18).** Reviewed against the 0.17.1 release and typechecked on SDK 0.17.3: no
  deprecated plugin API is used (the plugin calls `addHook`, `addScreen`, `addSidebarHeaderItem`, `openScreen` and
  `SettingsSection`, not their deprecated predecessors), so nothing had to be replaced. The dev pin is
  `@getpaseo/plugin ^0.17.1`.
- **Indexes a directory from disk.** Notes, YAML frontmatter, tags, `[[wikilinks]]` and heading structure go into a local
  SQLite index with FTS5. Obsidian does not have to be running.
- **Hybrid search.** Full-text over heading chunks, fused (Reciprocal Rank Fusion) with title/alias matches, one-hop
  wikilink proximity and a local semantic signal, packed into a bounded answer with note paths, headings and the
  directory role.
- **Semantic search, in-process.** `@huggingface/transformers` runs a multilingual e5-small ONNX model inside Node — no
  Ollama, no Python, no Docker, no vector database. Vectors live in the same SQLite index and are built by a short-lived
  child process, so a full re-embedding does not pin gigabytes inside the daemon. Unchanged notes are never re-read
  into vectors, and an edited note only re-embeds the sections whose text changed.
- **Read tools.** `obsidian_search`, `obsidian_read` (whole note, one heading subtree or a character window),
  `obsidian_outline`, `obsidian_list`, `obsidian_links`, `obsidian_directories`, plus `obsidian_index`,
  `obsidian_diagnose` and `obsidian_status`. The workspace tab and the composer attachment picker use the same index.
- **Truncation has a next step (0.18.12).** When a tool cannot show everything it found, the result carries
  `[TRUNCATED]` and a `continuation` object. `obsidian_continue` re-runs exactly that call, so an agent never switches to
  file operations or guesses an offset. Search pages, note windows, note listings and integrity reports use it.
- **The plugin owns the planning hierarchy (0.19.12, corrected in 0.19.13 and 0.20.13).** It creates the planning
  directory (default `Projects`, used when the setting is empty) and a folder named after the current Paseo project —
  the root of its Git checkout, so a workspace opened in `repo/backend` shares the folder `repo`. All workspaces of that
  project share the tree; each plan file records the calling workspace by id in YAML (`workspace_id`). Scope is the
  project, never the workspace: a workspace whose project cannot be named is refused instead of being given a folder of
  its own. `plan_*` cannot reach another project, while `obsidian_*` may read its plans on an explicit task.
- **The planning folder can be checked and created from the settings screen (0.21.13).** Two actions next to
  "Planning directory" report whether `<directory>/<planning folder>` exists and create it with missing parents, so a
  typo is caught before the first `plan_*` call. Both are confined to the configured directory exactly like the tools;
  the per-project subfolder is still created by `plan_*` itself.
- **One writer at a time (0.21.17).** Every mutating `plan_*` call takes a write lock on its plan tree, the way
  SQLite allows one writer: a second agent waits up to ten seconds and is then told to repeat the call after reading the
  node again, instead of both read-modify-writing the same project. Lock directories live under the plugin's data
  directory, never in the vault, and a lock left by a crashed process is recovered by pid or age.
- **A restore puts text back, not lifecycle (0.21.17).** `plan_restore` keeps the live `status` and reports the
  snapshot's as `snapshot_status`; moving status stays `plan_set_status`. `plan_growth` names its new counters apart from
  the `previous` pair it replaced, and an identical `plan_link` repeat answers `action: "unchanged"` with
  `written: false` instead of an error.
- **The stable MCP copy follows the installed version (0.21.17).** After `paseo plugin update`, the next agent launch
  rewrites the stable bundle from the checkout, so agents stop starting the previous version while they wait for
  `paseo plugin reload`.
- **The plugin's boundary is enforced by the plugin (0.20.13).** The configured directory is the whole of what any tool
  may touch: paths above it, beside it and `.obsidian` are refused, and a symlink is resolved with `realpath` on both
  sides, so a symlinked note or role directory cannot step outside it. Reads and edits accept only the configured
  document extensions (`.md` by default) and never dot files, so a project checkout's `.env` or `.git/config` is not a
  note. `obsidian_edit` may change an existing note anywhere below the configured directory and nowhere above it; the
  refusal says exactly that, in words meant to end the attempt rather than invite a retry.
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
- **Exact-fragment edit of any existing note below the configured directory.** `obsidian_edit` takes a path, an `old_text` that must occur exactly
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
- **Actionable edit refusals (0.10.11).** When `obsidian_edit` cannot match a fragment, the refusal carries the
  closest text from that note with line numbers (or the places an ambiguous fragment occurs), so an agent corrects its
  fragment instead of re-reading the whole file. `ignore_whitespace: true` matches a re-wrapped or re-indented fragment,
  still under the exactly-once rule.
- **Callouts and Dataview fields (0.10.11).** Every chunk records the callout type it starts with (`> [!warning]` →
  `warning`), search hits show it (`[!warning]`) and the panels print it, and `obsidian_outline` returns Dataview inline
  fields (`key:: value`) as `inlineFields`.
- **Scan metrics and a quiet embedding period (0.10.11).** `obsidian_status` and the screen report the last scan (what it
  updated, skipped and could not read, and how long it took) and the time of the last full sync; embedding now waits for
  a short quiet period after watched-note changes, so a Git pull or a Syncthing burst becomes one job instead of several
  model loads.
- **Planning foundation (0.11.11).** A `planRoot` setting (default `Projects`) reserves a directory inside the vault
  for planning tools, and `plan_scope` reports whether that tree exists, what it holds and whether writes are enabled —
  without opening the index, creating a folder or touching a note. Planning never leaves that directory, and its
  `__history` (revision snapshots) and `_archive` (archived subtrees) are excluded from indexing, search and listings and
  refused by the reading tools, so history cannot mix with the live tree.
- **Reading a plan (0.12.11).** `plan_read` returns a project overview (root, trunks, counts, open incidents,
  proposed goals) or one node in context — ancestors, children, siblings, influences in both directions, blocking
  incidents, the goal and growth record, and `beeCycle` when influence edges close a loop. `plan_search` ranks plan
  documents with the same index the vault uses, but only inside the planning directory and with `kind`/`status`/`project`
  filters read from YAML frontmatter.
- **Writing a plan (0.13.11).** `plan_create_node` builds the tree (`version: 1`, `revision: 1`, the parent's `children`
  updated), `plan_update_node` changes description, brief, payload, notes or kind (revision +1, or version +1 with the
  revision reset to 1), `plan_set_status` performs one allowed lifecycle transition, and `plan_history` lists and reads
  the `__history` snapshots every write takes first. A stale `expected_revision`, a manual Obsidian edit, an illegal
  transition, or overriding a status the user set without a `reason` all refuse instead of overwriting, and every change
  appends one line to the project's `_journal.md`.
- **Links, incidents, goals and growth (0.14.11).** `plan_link` creates, updates and removes an influence between two
  leaves of one project (a self-loop and a cross-project edge are refused), `plan_incident` keeps `blocks:` and
  `blocked_by:` in sync on both sides while only `open`/`investigating` incidents block, `plan_goal` authors a goal
  (`create`, `update`, `propose`) for a human to approve, and `plan_growth` upserts the progress record of a node or
  goal, merging steps by title. Each write snapshots the previous state first and journals the change.
- **Agent-facing descriptions (0.17.12).** The tool contract, the `initialize` instructions and the shipped skills now
  point to this plugin's `plan_*` tools as the place for project planning; they no longer name the retired planning
  plugin. The behaviour of every tool is unchanged.
- **Four agent skills, three of them for planning (0.17.11).** `skills/planning-create`, `skills/planning-execute` and
  `skills/planning-review` teach an agent to grow a plan tree, carry it through the work and review plan against fact;
  `obsidian-bridge` keeps the read → cite → write workflow. `server/agent-skill.ts` installs, verifies and removes a
  list of skills instead of one, and the `initialize` instructions now state the `planRoot` boundary and forbid direct
  file operations on plan files.
- **Integrity and import (0.16.11).** `plan_validate` is the report a directory of Markdown files needs in place of
  foreign keys: a dangling link, a body that no longer matches its frontmatter, an orphan, a missing or doubled root, a
  leaf with children, an invalid status or parent kind, duplicate ids, an influence cycle, an `op:start` that never got
  its `op:done`, and a file inside the planning root that is not a plan. `plan_import` rebuilds a `luck_tree_export`
  `.json.zip` (or its extracted `.json`) as plan files — folders, links, incidents, goals and growth, with the original
  row id kept in `legacy_id` — dry-run by default and idempotent by `legacy_id`.
- **Multi-file operations (0.15.11, corrected in 0.21.14).** `plan_move_node` moves a subtree and rewrites every link
  into it (`parent`, `children`, `influences`, `blocked_by`, `blocks`, `materialized`), `plan_archive_node` moves a
  subtree into `_archive/` and unlists it without deleting anything, `plan_approve_goal` materialises a proposed goal
  into a trunk → branch → leaves (an agent cannot approve the goal it created), and `plan_restore` writes a snapshot
  back as a new revision.
  Every operation journals `op:start`/`op:done`, snapshots each file it changes, and repeating it with the same `op_id`
  resumes an interrupted run instead of duplicating it.
- **Hardened by two live plan tests (0.21.14, 0.21.15).** Approving a goal produces the layout the schema requires;
  archiving takes the node's own folder and refuses a node whose kind and path disagree; a kind change between a leaf
  and a branching node moves the file, its snapshots and every link to it; nested frontmatter (`brief`, `plan`) is read
  as written; `plan_search` drops graph-only neighbours that contain none of the query words; and reindexing a note
  with repeated chunk text no longer fails on a duplicate embedding. Since 0.21.15 `plan_move_node` refuses a missing
  source instead of reporting a phantom resumed move, `plan_update_node` can change `## Заметки` alone, snapshots keep
  the notes section, `plan_history` accepts a branching node's folder path, `plan_read` returns `notes`, honours its
  `project` filter and lists approved goals, `plan_archive_node` rewrites internal links inside the archived subtree,
  and the indexer reconciles renames, deletes and moves into `_archive` instead of serving dead paths.
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
frontmatter redaction: a heuristic that misses one note would be worse than a clear rule. Notes that must not be indexed at
all belong outside `vaultPath`/`includeFolders`, or under an `excludeGlobs` pattern (`**/secrets.md`, `**/*.key`,
`Private/**` — the same glob dialect as `*`/`**`); the next scan drops them from the index together with their chunks and
vectors. `excludeGlobs` is the plugin's only exclusion mechanism — there is no separate secret scanner to configure or
trust. Details: [__doc.md](./__doc.md) §12.

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

- Paseo `>= 0.17.0` (the agent instruction uses `appendSystemPrompt`, which older daemons reject); verified against the
  0.17.1 release (typecheck and tests on SDK 0.17.3) — see [__compatibility.md](./__compatibility.md).
- Node.js `>= 22.13` (the index uses the built-in `node:sqlite` with FTS5, which needs no flag from 22.13; verified on
  Node 24). The same floor applies to the standalone server.
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

## Standalone MCP server (no Paseo)

The same server installs on its own, for a runtime that has no Paseo daemon. `obsidian-bridge-install.sh` is the single
installation path: `curl` and `git clone` are only two ways to reach it, and both build from the same `server/` sources
with the same bundler, so a standalone installation cannot drift from the plugin.

```bash
curl -fsSL https://raw.githubusercontent.com/SirafimsBrain/Paseo-Plugins/main/obsidian-bridge/obsidian-bridge-install.sh \
  | bash -s -- --vault ~/Obsidian/Main
```

It installs into `~/.agents/obsidian-bridge-mcp` (or `--dir` / `OBSIDIAN_BRIDGE_HOME`) and leaves an installation an
agent can be pointed at without further instructions:

| File | Purpose |
| --- | --- |
| `dist/mcp-server.js` | The stdio server; the only file an MCP client launches. |
| `settings.json` | `vaultPath`, directory roles and search settings, in the same `writtenBy` format the plugin mirrors. |
| `install.json` | Version, git ref and install time. Also how the server recognises its own home. |
| `AGENT-SETUP.md` | The agent-facing document: client blocks, settings, the tool list, troubleshooting. |
| `data/` | Per-vault SQLite indexes and, with semantic search, the model cache. |

The installer prints the ready-to-paste `mcpServers` block, copies the four Agent Skills into `~/.agents/skills` unless
`--no-skills` is given, and runs on Node 22.13 or newer. `--dry-run`, `--ref`, `--version`, `--skills-dir` and
`--uninstall` are listed in `--help`.

What differs from the plugin, and why:

- **Data root.** The index, model cache and locks live under the installation instead of
  `$PASEO_HOME/plugins/obsidian-bridge`, so an install without Paseo never creates a `~/.paseo` directory.
- **Freshness.** No process watches the vault here, so `obsidian_search` runs an incremental scan when the last one is
  older than 15 seconds and reports `index: {lastScanAt, scannedNow, notes, hint}`. A note written a moment ago is
  visible without calling `obsidian_index`, and an empty result explains whether the index is empty or the note is
  likely excluded.
- **Semantic search is opt-in.** Lexical search (FTS5, titles, tags) needs nothing beyond Node. `--with-semantic`
  installs `@huggingface/transformers` and its ONNX runtime (~380 MB) and the default model (~118 MB) is downloaded on
  the first search. Without it, a query is never embedded: the answer says so instead of loading a model it cannot use.
- **Settings have no plugin screen.** `settings.json` is the whole surface, and every key also has an `OBSIDIAN_*`
  environment variable that wins over the file.

The Paseo plugin's hooks, screens, slash command and injection are Paseo-only and absent; the `server/` behaviour —
tools, boundaries, planning, write semantics — is identical.

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
- Read and edit tools accept only the extensions in **Document extensions** (default `.md`). Add `.txt`, `.rst` or
  another extension only if those files really belong to the knowledge base; dot files (`.env`, `.git/config`) and
  extensionless files stay unreadable whatever the allowlist says. Indexing itself remains Markdown-only.

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
| `obsidian_continue` | Re-runs the tool named in a `[TRUNCATED]` result with the exact `continuation` object. |

The MCP server is registered under the name `obsidian-bridge`. When a provider cannot take an MCP server, the plugin
attaches the equivalent `obsidian_bridge_*` tools instead. Planning tools resolve their root to
`<planRoot>/<paseo-project>`; an empty `planRoot` uses the default `Projects`, and the calling workspace id goes into
each plan file's YAML.

Every tool description states the rule the plugin is built around: use it only when the user explicitly asks about their
Obsidian notes, never as a place to record agent memory.

Since 0.21.16 each of the seventeen `plan_*` descriptions also answers the questions an agent has before its first call:
what the tool is for and when to use it, what to pass (path form, what must exist), what comes back (the field the next
call needs) and what to do next. The allowed lifecycle transitions are printed in the description instead of being
discovered by a refusal, and the MCP `initialize` instructions carry the planning workflow in order. The boundary those
tools share is stated last, so it no longer hides the sentence that tells the tools apart.

## Agent skill

The plugin ships four [Agent Skills](https://agentskills.io/specification) and installs all of them on load into the
skills directories that exist: `~/.agents/skills` first, then OpenCode, Cline, Kilo, Kimi, Qwen, Codex and Claude Code.

| Skill | For |
| --- | --- |
| [`obsidian-bridge`](./skills/obsidian-bridge/SKILL.md) | reading the vault, citing a heading, writing in the right role, the exact-fragment edit |
| [`planning-create`](./skills/planning-create/SKILL.md) | growing a plan tree: project, trunks, branches, first leaves, goals, import |
| [`planning-execute`](./skills/planning-execute/SKILL.md) | carrying a plan through the work: status, briefs, growth, links, incidents, moves |
| [`planning-review`](./skills/planning-review/SKILL.md) | plan against fact: snapshots, revisions, growth, integrity, restore |

Each lands as `<root>/<skill>/SKILL.md`. Unchanged copies are not rewritten; the switch in the settings screen removes
all four directories. A runtime that only scans skills at startup needs a restart to pick them up.

The official Obsidian skills are a separate upstream project, kept as the reference for the formats this plugin does not
cover — [github.com/obsidianmd/obsidian-skills](https://github.com/obsidianmd/obsidian-skills) (`obsidian-markdown`,
`obsidian-bases`, `json-canvas`, `obsidian-cli`, `knap`).

## Roadmap

| Stage | Work |
| --- | --- |
| Next | **Obsidian Canvas.** Index `.canvas` files (node text, note/file nodes, edges between them) so an agent can read
  and — once the writing side exists — draw a canvas instead of only reading Markdown. Design and requirements land in
  `__doc.md` §14 before any code; the parser, the read path and the watcher all have to learn the format. |
| Later | **Windows and macOS.** Path handling is already platform-neutral; the audit that remains is file locking on
  Windows (`rename` over a note held by Obsidian, retried and explained since 0.10.11), `node.exe` discovery (also
  0.10.11) and a verification pass on each platform. ONNX runs on CPU there; Metal/CoreML acceleration is not claimed. |
| Deferred | **Link-graph visualization.** An interactive graph of the vault's `[[wikilinks]]` in Paseo's screen is documented
  as a prospect in `__doc.md` §14 but deliberately not scheduled: the screen is a React Native surface with no SVG/DOM
  dependency, so it needs a bundled renderer, and the practical need (find isolated notes) is cheaper to serve from the
  index. |

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
