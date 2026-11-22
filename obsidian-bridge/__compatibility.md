# Obsidian Bridge — compatibility

Detailed compatibility notes. The main README keeps only the summary table row and links here.

## Plugin 0.21.18 — Paseo 0.17.1 compatibility pass (2026-11-22)

Patch release (0.21.17 → 0.21.18). The [0.17.1 release notes](https://github.com/getpaseo/paseo/releases/tag/v0.17.1)
were reviewed change by change, the plugin was typechecked and tested against the current SDK, and every Paseo API call in
it was checked against the SDK's `@deprecated` markers. **No deprecated method or function is used, so nothing had to be
replaced.** The only change is the dev pin `@getpaseo/plugin ^0.16.0` → `^0.17.1` (resolved and verified on **0.17.3**,
the installed Paseo CLI); the host floor stays `>=0.15.0`, because the plugin uses no 0.17-only API. Tool catalogue,
settings schema version, MCP server and every tool input are unchanged.

### Deprecation audit (SDK 0.17.3)

| Deprecated API | State in the plugin |
| --- | --- |
| `server.before(name, …)` | not used — both hooks register through `server.addHook("agent.create.before")` / `("agent.open.before")` |
| `server.on(name, …)` with legacy event names (`agent.created`, `agent.session_open`, …) | not used — no event-style lifecycle registration at all |
| `client.addSurface` | not used — `client.addScreen` |
| `client.addSidebarItem` | not used — `client.addSidebarHeaderItem` with a `PluginSidebarItemProps` component |
| `client.openSurface` | not used — `openScreen({ screenId })` in the sidebar item and both Command Center entries |
| `PluginWorkspacePanelContribution.context` | not used — `addWorkspacePanel` passes no `context`, and the component does not read the deprecated `context` prop |
| `SettingsGroup` | not used — the settings screen imports `SettingsSection` |
| `@getpaseo/plugin/client/react-native` | not used — UI imports come from `@getpaseo/plugin/client/ui`; `react-native` primitives are imported from the `react-native` package itself |
| provider `options` / `settings` deprecations | not applicable — the plugin registers no provider |

### 0.17.1 changes and their impact here

| 0.17.1 change | Impact |
| --- | --- |
| **Plugin agent instructions** (`appendSystemPrompt` on `agent.open.before`, #9781) | not used yet; an additive opportunity — the plugin already decides on every open whether the agent actually gets the server |
| **`focusHost` navigation option** (#5574) | none — the plugin opens screens, not agents or workspaces, so there is no destination to focus |
| **Plugin control of worktree creation, removal and restoration** (#10278) | none — the plugin does not create or manage worktrees |
| Fixed plugin screens and settings failing to use plugin state hooks (#10049) | no code change; relevant only if the plugin adopts state. `PluginScreenProps` still has no `tab` in 0.17.3, so `useTabState` remains usable from a panel (`PluginWorkspacePanelProps.tab`), not from the screen or the settings screen |
| Fixed plugin agents failing to reopen after their provider closes the session (#10153), Antigravity approvals/history, provider updates and quota views | host-side fixes; the plugin's `agent.open.before` path benefits without a change |

The 0.16.0 contract this plugin relies on is unchanged: `agent.open.before` may still change only `env`, `tools` and
`mcpServers`, and the OpenCode shared-service guard around config-file registration is still required.

Evidence: `npm run typecheck` (three-project `tsc -b`) exit 0 against SDK **0.17.3**; `npm test` **47 suites / 414 tests**
pass, `pretest` rebuilt `dist/mcp-server.js`. **Not live-checked:** the Paseo daemon on this machine is not running
(`paseo plugin ls` answers "Daemon is not running"), so the plugin was not reloaded on a 0.17.1+ host in this pass and no
settings screen or tool was exercised in a running app. Linux remains the primary target; macOS and Windows remain
future work.

## Plugin 0.21.15 — fixes from the second live plan test (2026-11-20)

Patch release (0.21.14 → 0.21.15). A second full plan (71 live nodes) was written through the installed `plan_*` tools on
a real vault; the deviations below were reproduced in tests. No Paseo API change: SDK `@getpaseo/plugin ^0.16.0`, host
floor `>=0.15.0`, settings schema version 4, MCP catalogue and every existing tool input are unchanged. `plan_read`
additionally returns `notes`, and `plan_validate` gains the `growth_incomplete` rule.

| Finding | Behaviour after the fix |
| --- | --- |
| `plan_move_node` reported `ok: true, action: "resumed"` for a source that never existed, journaled `op:start`/`op:done` and bumped the destination revision | a missing source is refused with `is not a plan node` unless the same `op_id` already has an `op:start` marker; nothing is journaled and no revision moves. Passing a branching node's folder as `to` for a leaf now answers that `to` must be the new leaf file path |
| `plan_update_node` could not change only `## Заметки` | `notes` counts as a change on its own and appears in the "Nothing to update" hint |
| a snapshot did not keep `## Заметки`, so a restore mixed snapshot fields with live notes | snapshots store the notes section; `plan_restore` writes it back with the rest of the content |
| `plan_history` returned `count: 0` for a branching node's folder path | it uses the same resolver as `plan_read`/`plan_restore`; an unknown node is refused with suggestions instead of zero |
| `plan_validate` reported the plugin's own `_journal.md` as `not_a_plan`, attributed issues to `Projects` and let the project filter hide them | the journal is not a skipped document; `project` is the first folder under `planRoot`, so the filter keeps real issues. A `done` growth record with pending/in-progress steps is reported as `growth_incomplete` |
| `plan_read` ignored `project` in the overview and omitted notes; the overview hid approved goals | the overview honours `project` (an unknown project is an error) and lists `proposed` **and** `approved` goals; a node result carries `notes` |
| `plan_archive_node` left `parent`/`children`/`influences` inside the archived subtree pointing at live paths | every internal link is rewritten to the archived address; the archived root is marked `archived` in the same pass |
| influence edges cached the target's `version`/`revision` and went stale | new and updated edges carry no counters; `plan_read` reports the target's current counters, and legacy cached fields are dropped on update |
| search served paths of archived/renamed notes until a manual `obsidian_index` | a watcher event for a directory, a delete or a path in `_archive`/`__history` schedules a debounced reconciliation; the per-file flush drops a note that moved into a system folder |
| `plan_create_node` accepted `path: "<project>/<project>"` for a root and created a nested project | a root must be a single project folder (`<project>` → `<project>/<project>.md`) |

Evidence: `npm run typecheck` exit 0; `npm test` **46 suites / 397 tests** pass, including new cases for the phantom
move, a leaf's folder destination, notes-only updates, notes in snapshots/restore, folder-path history, the overview
filter and approved goals, `notes` in `plan_read`, archived internal links, the journal exclusion, project attribution,
`growth_incomplete` and the canonical root path. The indexer change is covered by the existing scan tests; the watcher
path itself is not exercised by an automated test. Not deployed and not exercised against a live Paseo daemon or
Obsidian application in this pass; Linux is the target platform, macOS and Windows remain future work.

## Plugin 0.21.14 — fixes from the live plan test (2026-11-19)

Patch release (0.21.13 → 0.21.14). A 57-document plan was written through `plan_*` on a real vault and its failures were
reproduced in tests. No Paseo API change: SDK `@getpaseo/plugin ^0.16.0`, host floor `>=0.15.0`, settings schema version
4, MCP catalogue and every tool input are unchanged.

| Finding | Behaviour after the fix |
| --- | --- |
| `plan_approve_goal` put leaves directly under a trunk | approval writes root → trunk → branch (`steps`) → leaves; `materialized` points at the trunk, and `plan_validate` no longer reports `invalid_parent_kind` after a normal approval |
| `plan_archive_node` moved the parent folder after a kind change | the archive path comes from the node's own slug (`<project>/_archive/<slug>/<slug>.md`); a node whose kind and folder disagree is refused before the rename, so siblings and their `__history` stay in the live tree; a leaf gets its own archive folder |
| a kind change left the file and tags at the old layout | a leaf ↔ branching change moves the file, its snapshots (rewriting `snapshot_of`) and every link to it (`parent`, `children`, `influences`, `blocked_by`, `blocks`, `materialized`, `goal`); `tags` follow `plan/<kind>`; `plan_validate` gains `layout_mismatch` and `kind_tag_mismatch` |
| `obsidian_read` lost nested frontmatter | YAML is parsed as a mapping (nested `brief`, `plan`, `influences` preserved); a rejected document falls back to the flat reader. `plan_read` returns `formal_text`, `plan`, `brief`, `payload`, `tags`, and a goal's `description` falls back to `formal_text` |
| `obsidian_outline` returned `links: []` for a fresh plan note | outgoing links fall back to the note's own parsed body while the index has not flushed it; a `404` from Obsidian's metadata cache for a just-created note is still reported as `enrichmentError`, but it no longer erases the links |
| `obsidian_index` failed with `UNIQUE constraint failed: embeddings.chunk_id` | carried vectors are deduplicated per model and upserted, so repeated chunk text in one note cannot insert two rows for one new chunk id |
| `plan_search` returned nodes with no lexical match | a hit that contains none of the query words is dropped and counted as `unmatched` |
| docs vs implementation | a snapshot is refused only when its `kind` differs from the live node's; `planning_available` means the directory resolves, an empty tree is `empty: true, reason: null` |

An archive still leaves incoming links dangling by design; `plan_validate` reports them as `unresolved_link`.

Evidence: `npm run typecheck` exit 0; `npm test` **46 suites / 386 tests** pass, including new cases for nested
frontmatter, the approval layout, kind-change migration, the archive layout refusal, both new validation rules, goal
fields in `plan_read` and the duplicate-chunk reindex. Not deployed and not exercised against a live Paseo daemon or
Obsidian application in this pass; symlink and layout behaviour was verified on Linux. macOS and Windows remain future
work.

## Plugin 0.21.13 — planning folder check and create in the settings screen (2026-11-19)

Feature release (0.20.13 → 0.21.13). No Paseo API change: SDK `@getpaseo/plugin ^0.16.0`, host floor `>=0.15.0`, settings
schema version 4, MCP catalogue and every tool input are unchanged. This is a UI + RPC addition only.

| Change | Behaviour |
| --- | --- |
| settings screen | "Planning directory" gains **Check folder** and **Create folder**, with the result shown in the section and cleared when the field changes |
| RPC `obsidian-bridge.plan-directory` | input `{ path?, create? }`, output `{ folder, absolute, exists, isDirectory, created, error }`; without `path` it uses the saved setting, with an empty setting it uses `Projects` |
| creation | `mkdir -p` for the configured folder only, and only on an explicit click; checking is read-only. The per-project subfolder stays the business of `plan_*` |
| boundary | `normalizeRoleDir` then `resolveInsideVault`, so `..`, absolute paths, `.obsidian` and a symlinked parent that leads out of the configured directory are refused before anything is created; an existing file in the folder's place is reported as such |

Evidence: `npm run typecheck` exit 0; `npm test` **46 suites / 379 tests** pass, including the new
`tests/plan-folder.test.ts`. Not deployed and not exercised against a live Paseo daemon in this pass — the two new
buttons were not clicked in a running app, and the screen was not viewed.

## Plugin 0.20.13 — the plugin enforces its own boundary (2026-11-19)

Feature release (0.19.13 → 0.20.13) from a permission audit of the tool surface. No Paseo API change: the SDK stays
`@getpaseo/plugin ^0.16.0` and the host floor `>=0.15.0`; the settings schema stays version 4, because every new key has a
default. The MCP catalogue, the attached tools and every tool input are unchanged — this release tightens behaviour.

| Change | Behaviour |
| --- | --- |
| setting `planRoot` | default is now `Projects` (was `Workspaces`); a stored value is kept, so nothing moves for an existing install |
| setting `allowedExtensions` | new, default `.md`. Read and edit tools accept only these extensions; add `.txt`, `.rst` if those files belong to the knowledge base |
| boundary of reads (`R1`) | `resolveInsideVault` also compares the `realpath` of the target (or its nearest existing ancestor) with the root's, so a symlinked note that points outside is refused |
| boundary of writes (`R2`) | the same resolver guards `appendToNote`, so a role directory that is a symlink out of the directory can no longer receive files |
| dot files and non-documents (`R3`) | `.env`, `.git/config`, `.obsidian/…` and extensionless files are never readable or editable, whatever the allowlist says; indexing remains Markdown-only |
| `obsidian_edit` (`R4`) | may rewrite an existing note anywhere below the configured directory and nowhere above it; the refusal states the boundary and that retrying through another path or tool is not the way forward |
| planning scope (`R8`) | the project folder is the Git root of `PASEO_AGENT_CWD` (then the last path segment), so `repo/backend` and its worktrees share `repo`; a workspace whose project cannot be named is refused instead of getting a private tree; the workspace-id fallback is gone |
| settings mirror (`R5`) | accepted only as plugin data: regular file, current user, not group/other writable, marked `writtenBy: "obsidian-bridge"`; otherwise ignored as a whole and defaults/env apply (an empty `vaultPath` is the closed state) |
| documentation | `__doc.md` §16 records the audit registry; R6/R7 (host-wide injection) and R9 (skill ownership) are recorded but not implemented; R10/R11/R12 and the import limits stay open |

Evidence: `npm run typecheck` exit 0; `npm test` **45 suites / 371 tests** pass, including the new
`tests/boundary.test.ts`. Not deployed and not exercised against a live Paseo daemon or Obsidian application in this pass;
symlink behaviour was verified on Linux (the primary target). macOS and Windows remain future work — the `realpath`
comparison is platform-neutral, the uid and mode checks of the mirror are skipped where `process.getuid` does not exist.

## Plugin 0.19.13 — project-scoped planning tree, workspace id in YAML (2026-11-18)

Patch release (0.19.12 → 0.19.13). 0.19.12 made the plugin create the planning directory and named the folder after the
Paseo **workspace**; the user clarified that all workspaces of one Paseo project are orchestrated together and must
share one planning tree. 0.19.13 corrects the folder to the **project** and records the calling workspace by id in the
plan YAML. No new tool, setting, SDK or host requirement.

| Change | Behaviour |
| --- | --- |
| project identity | `server/plan/project.ts` reads `PASEO_AGENT_CWD` for the project name (override: `OBSIDIAN_PROJECT_NAME`) and keeps `PASEO_WORKSPACE_ID` as the value written to YAML |
| directory creation | `resolvePlanRoot()` creates `<planRoot>/<project>` with `recursive: true`; `plan_scope` reports a fresh empty tree as `planning_available: true`, `empty: true`, `reason: null` |
| status side effects | `obsidian_status` uses `{ create: false }`, so reporting never changes the vault |
| `plan_*` boundary | paths are relative to the project folder; all workspaces of that project share it; `..`, absolute paths and sibling project names are refused; hierarchy and naming inside it remain free for the agent |
| plan YAML | `workspace_id` is written by `plan_create_node`, `commitNodeChange` and `plan_import`, ordered after `project_key` |
| `obsidian_*` | unchanged: may read another project's plans when the user's task requires it, never writes plan files |
| instructions | `PLAN_CONTRACT_SENTENCE`, `initialize`, the settings hint and the three planning skills describe the project tree and the YAML field |

Evidence: `npm run typecheck` exit 0; `npm test` **44 suites / 358 tests** pass. Not deployed and not exercised against a
live Paseo host in this pass; workspace/project identity is derived from the agent environment observed on this machine.
Linux remains the primary target; macOS and Windows remain future work.

## Plugin 0.18.12 — continuation for truncated results (2026-11-18)

Feature release (0.17.12 → 0.18.12). The SDK (`@getpaseo/plugin ^0.16.0`), host floor (`>=0.15.0`) and Node requirement
are unchanged. The MCP catalogue grows from 30 to 31 tools; the attached Paseo tool set grows from 8 to 9. Existing
tool inputs gain optional parameters only. The one breaking field rename is `plan_validate.truncated` (a count in older
releases): it is now a boolean and the count lives in `truncated_count`.

| Change | Behaviour |
| --- | --- |
| tool `obsidian_continue` | takes the `continuation` object from a `[TRUNCATED]` result verbatim, validates it, and re-runs the named target through the shared dispatcher; malformed objects, unknown targets and recursion are refused |
| `obsidian_search` | `offset` plus counters from `packHitsDetailed()` produce a continuation when hits were omitted by the budget or the page limit |
| `obsidian_read` | `char_offset`/`max_chars` windows for large notes, with the next window supplied as a continuation |
| `obsidian_list`, `plan_validate` | `offset` continuations for further pages of notes or integrity issues |
| both transports | `mcp-server.ts` and `agent-tools.ts` normalize the text channel so `[TRUNCATED]` and the exact next call reach clients that ignore `structuredContent` |
| skills | `CONTRACT_SENTENCE`, `initialize` and all four `SKILL.md` files teach the continuation protocol and forbid substituting file tools |

Evidence: `npm run typecheck` exit 0; `npm test` **43 suites / 354 tests** pass. Not deployed and not exercised against a
live Paseo host in this pass. Checking permission boundaries and detecting tools that escape them is a separate task.
Linux remains the primary target; macOS and Windows remain future work.

## Plugin 0.17.12 — agent-facing descriptions (2026-11-18)

Patch release (0.17.11 → 0.17.12). SDK, host floor and the 30-tool catalogue are unchanged; only descriptions change.

| Change | Behaviour |
| --- | --- |
| `initialize` block and `CONTRACT_SENTENCE` comment | project planning is attributed to the `plan_*` tools in this server, not to the retired planning plugin |
| `skills/obsidian-bridge/SKILL.md` | same wording in the read → cite → write skill |
| `skills/planning-create/SKILL.md` | frontmatter and the import section describe a legacy archive, without naming the retired plugin |
| `README.md` | introduction points planning to `plan_*`; the change is listed under "What it does" |

Evidence: `npm run typecheck` exit 0; `npm test` **42 suites / 348 tests** pass. `agent-skill.test.ts` now isolates
`PASEO_HOME` alongside `HOME`, so a daemon config pointing at an older installed checkout cannot supply stale skill text
during a repair assertion. No new tool, schema or host requirement. Linux remains the primary target; macOS and Windows
remain future work.

## Plugin 0.17.11 — four agent skills, three of them for planning (2026-11-18)

Feature release (0.16.11 → 0.17.11), stage 8 of the migration. The SDK, host floor and tool catalogue (30 tools) are
unchanged; the change is agent-facing documentation and the skill installer.

| Change | Behaviour |
| --- | --- |
| skills | `skills/planning-create`, `skills/planning-execute` and `skills/planning-review` join `skills/obsidian-bridge`; each has Agent Skills frontmatter naming its tools and no machine-specific absolute path |
| installer | `server/agent-skill.ts` installs, verifies and removes the whole list; `skillStatuses()` returns one row per root per skill; only roots that exist are written, unchanged copies are not rewritten |
| removal | turning `installAgentSkill` off removes all four directories and spares another plugin's skill |
| instructions | `CONTRACT_SENTENCE` and the `initialize` block state the `planRoot` boundary, the ban on `obsidian_edit`/`obsidian_write_*`/`shell`/`write`/`patch` against plan files, `plan_history` as the only snapshot reader, and the four skill names |

Evidence: `npm run typecheck` exit 0; `npm test` **42 suites / 348 tests** pass. Not deployed and not exercised against a
live Paseo host: the installer was driven over temporary HOME directories, and the instructions were read through
`mcpInstructions`. Linux is the primary target; macOS and Windows remain future work for the plugin as a whole.

## Plugin 0.16.11 — integrity report and import from luck_tree_export (2026-11-18)

Feature release (0.15.11 → 0.16.11), stage 7 of the migration. The SDK and host floor are unchanged; the MCP catalogue
grows from 28 to 30 tools. The only boundary change is `resolvePlanRoot(settings, { allowMissing })`, used by
`plan_import` alone: it may plan against a missing planning root and creates that root only when it writes.

| Change | Behaviour |
| --- | --- |
| tool `plan_validate` | `valid`, `issue_count`, `counts.byKind`, `issues[]`, `truncated`; `project` and `limit` scope the answer; never writes |
| tool `plan_import` | reads `.json.zip` / `.json`, validates the whole graph, rebuilds folders, links, incidents, goals and growth, keeps `legacy_id`; `dry_run` default true; refuses a non-empty different project |
| import of a real export | the `.json.zip` path is read through the zip central directory (stored and deflate entries), no new dependency; `content` accepts the JSON for a file kept outside the vault |
| incidents and goals | an export's bugs and goals keep their text and status; archived nodes are imported flagged (`include_archived: false` skips them with a warning); an attachment with a missing end is a warning, not a drop |

Evidence: `npm run typecheck` exit 0; `npm test` **42 suites / 344 tests** pass. The import fixture is built from the
source plugin's `exportDocumentSchema` (`luck-planner/shared/export.ts`); no export file from a live install exists on
this machine, so that is the one acceptance item still to confirm by hand. Not deployed and not exercised against a live
Paseo host: the tools were driven through `dispatchTool`, the same path the stdio server uses.

## Plugin 0.15.11 — multi-file operations: move, archive, approve, restore (2026-11-18)

Feature release (0.14.11 → 0.15.11), stage 6 of the migration. The SDK and host floor are unchanged; the MCP catalogue
grows from 24 to 28 tools. Existing plan files stay valid: incidents and goals in the fixture now carry `version: 1`,
which the schema always required.

| Change | Behaviour |
| --- | --- |
| tool `plan_move_node` | moves a folder or leaf, rewrites every link into it, snapshots each changed file; refuses a root, an occupied destination, a move inside itself and a missing new parent |
| tool `plan_archive_node` | moves the subtree to `<project>/_archive/<slug>`, sets `archived`, unlists it from the parent; nothing deleted, history preserved |
| tool `plan_approve_goal` | proposed goal → trunk plus one leaf per step; refuses a goal the same agent created, a non-proposed goal, an already materialised goal and an empty `plan:` |
| tool `plan_restore` | snapshot → `revision + 1` with `restored_from`; content only, relations kept, version never rolled back, kind changes refused |
| operation markers | `op:start <uuid>` / `op:done <uuid>` in `_journal.md`; `op_id` turns a retry into a resume, and a finished id answers `already_done` |
| fixture | incidents and goals carry `version: 1` like every other plan file |

Evidence: `npm run typecheck` exit 0; `npm test` **40 suites / 327 tests** pass. Not deployed and not exercised against a
live Paseo host; the tools were driven through `dispatchTool`, the same path the stdio server uses.

## Plugin 0.14.11 — links, incidents, goals and growth (2026-11-18)

Feature release (0.13.11 → 0.14.11), stage 5 of the migration. The SDK and host floor are unchanged; the MCP catalogue
grows from 20 to 24 tools. Existing plan files stay valid: no key, status or layout changed, and the new tools only write
fields the schema already defined.

| Change | Behaviour |
| --- | --- |
| tool `plan_link` | one bee per call: create/update/remove, leaf-to-leaf inside one project, self-loop refused, an illegal bee transition lists the allowed targets, `remove` on a missing edge is a no-op |
| tool `plan_incident` | create or update `<project>/_incidents/<slug>`; `blocks:`/`blocked_by:` written on both sides; only `open`/`investigating` block; status moves go through `plan_set_status` |
| tool `plan_goal` | `create`/`update`/`propose`; approval is not available here |
| tool `plan_growth` | upsert `growth:` (status, summary, progress 0–100, steps) on a node or goal; steps merge by title, `replace: true` starts over |
| shared write path | `loadWritableNode` and `commitNodeChange` are exported from `server/plan/write.ts`; every new write takes a snapshot first and bumps the revision once |
| journal | each new tool appends one line (`plan_link`, `plan_incident`, `plan_goal`, `plan_growth`) |

Evidence: `npm run typecheck` exit 0; `npm test` **36 suites / 311 tests** pass. Not deployed and not exercised against a
live Paseo host; the tools were driven through `dispatchTool`, the same path the stdio server uses.

## Plugin 0.13.11 — writing a plan: create, update, status, history (2026-11-18)

Feature release (0.12.11 → 0.13.11), stage 4 of the migration. The SDK and host floor are unchanged; the MCP catalogue
grows from 16 to 20 tools and the document write tools share the extracted write gate.

| Change | Behaviour |
| --- | --- |
| tool `plan_create_node` | node file at its layout path, `v1 r1`, parent `children` updated, journal line; refuses an existing file, an orphan or a forbidden child kind |
| tool `plan_update_node` | description/name/brief/payload/notes/kind; snapshot before write; revision +1 or version +1 with revision 1; `expected_revision`, `accept_external` |
| tool `plan_set_status` | one allowed transition (nodes, incidents, goals); illegal and same-status moves refuse; a user-set status needs `reason` |
| tool `plan_history` | list snapshots or read one by version/revision; the only reader of `__history` |
| snapshot rule | snapshots are taken before the write and are never rewritten; an existing snapshot for the same v/r is left alone |
| concurrency | atomic temp + rename with an mtime re-check; a manual edit newer than `updated` needs `accept_external: true` |
| journal | `<project>/_journal.md` receives `at · tool · node · v/r` lines; a journal failure is reported, never silent |

Evidence: `npm run typecheck` exit 0; `npm test` **33 suites / 289 tests** pass. Not deployed and not exercised against a
live Paseo host; the tools were driven through `dispatchTool`, the same path the stdio server uses.

## Plugin 0.12.11 — reading a plan: overview, node context, search (2026-11-18)

Feature release (0.11.12 → 0.12.11), stage 3 of the `luck-planner` migration. The SDK, host floor and every existing
setting/tool are unchanged; the MCP catalogue grows from 14 to 16 tools.

| Change | Behaviour |
| --- | --- |
| tool `plan_read` | without `path`: project overview (root, trunks, counts, open incidents, proposed goals); with `path`: node, ancestors, children, siblings, influences, reverse influences, blocking incidents, goal, growth, `beeCycle` |
| path forms | folder (`centurion/backend/auth`), file (`…/auth.md`) or project (`centurion`); unknown paths return `suggestions` |
| tool `plan_search` | vault index restricted to `planRoot`; `kind`/`status`/`project` filters from frontmatter; one row per note; empty index reported instead of an empty answer |
| boundary | `plan_read` and `plan_search` refuse `__history`/`_archive` and anything outside `planRoot`; search also re-checks the prefix after ranking |
| `beeCycle` | influence loops over `active`/`watching` edges, returned as plan-relative paths |

Evidence: `npm run typecheck` exit 0; `npm test` **30 suites / 262 tests** pass. Not deployed and not exercised against a
live Paseo host; both tools were driven through `dispatchTool`, which is the same path the stdio server uses.

## Plugin 0.11.12 — plan file format and snapshots (2026-11-18)

Patch release (0.11.11 → 0.11.12): internal migration stage 2, no tool or setting changed. The SDK, host floor and
tool catalogue stay as in 0.11.11.

| Change | Behaviour |
| --- | --- |
| dependency `yaml` (^2.9.1) | frontmatter parsed and written through one library instead of a hand-written parser; duplicate keys are an error |
| `server/plan/model.ts` | kinds, status dictionaries, `ALLOWED_CHILD_KINDS`, leaf transitions, snapshot reasons, canonical key order |
| `server/plan/frontmatter.ts` | parse/serialize a plan file, key order preserved, body untouched, unparsable files refused rather than rewritten |
| `server/plan/sections.ts` | `## Влияния`, `## Блокировки`, `## Дети`, `## Журнал` rendered from frontmatter, `## Заметки` kept, `—` for an empty section |
| `server/plan/snapshot.ts` | `<dir>/__history/<slug>.v<v>.r<r>.md`, snapshot frontmatter with the counters of the state being replaced, relation fields dropped |

Evidence: `npm run typecheck` exit 0; `npm test` **28 suites / 241 tests** pass. Nothing was deployed or checked against a
live Paseo host; the new module surface is not reachable from any tool yet.

## Plugin 0.11.11 — planning root and its boundary (2026-11-18)

Feature release (0.10.11 → 0.11.11), first stage of the `luck-planner` migration. No Paseo API change: the SDK stays
`@getpaseo/plugin ^0.16.0` and the floor `>=0.15.0`.

| Change | Behaviour |
| --- | --- |
| setting `planRoot` | vault-relative, default `Workspaces`; empty = planning not configured; `OBSIDIAN_PLAN_ROOT` overrides it for a standalone MCP process |
| setting schema | stays version 4 — a key with a default validates an older stored document, so no migration is required |
| `VaultStatus.plan` | `{ root, path, exists }` in `obsidian-bridge.status` and its stream; `plan` also appears in `obsidian_status` |
| tool `plan_scope` | 14th tool; answered without opening or creating the index; `planning_available: false` with `reason` `not_configured`/`invalid`/`missing`/`empty` |
| `__history` and `_archive` | never walked, watched, indexed, searched or listed; refused by `obsidian_read`, `obsidian_outline` and `obsidian_edit` |
| path boundary | a `plan_*` argument is vault-relative to `planRoot`; absolute paths, `..`, `.obsidian` and symlinks out of the root are refused |

Evidence: `npm run typecheck` exit 0; `npm test` **24 suites / 195 tests** pass. Nothing was deployed or verified against a
live Paseo host in this stage; the change is server-side plus one settings field.

Explicitly not built yet (by plan): reading and writing plan nodes, snapshots, links, goals, incidents, growth,
`plan_validate`, `plan_import`, the three planning skills and the dashboard.

## Plugin 0.10.11 — edit recovery, Obsidian formats, scan truth (2026-11-17)

Feature release (0.9.11 → 0.10.11), independent of the host version: no Paseo API
changed, the SDK stays `@getpaseo/plugin ^0.16.0` and the floor `>=0.15.0`.

| Change | Behaviour |
| --- | --- |
| `obsidian_edit` `ignore_whitespace` | matches a re-wrapped fragment; still exactly one occurrence |
| `obsidian_edit` refusals | `suggestions` with line numbers (closest text, or the places an ambiguous fragment occurs), in text and `structuredContent` |
| `chunks.callout` | callout type stored per chunk, shown on hits as `[!warning]`; `SCHEMA_VERSION` 3, `ALTER TABLE` migration, no forced reindex |
| `obsidian_outline.inlineFields` | Dataview `key:: value` pairs as fields |
| `VaultStatus.scan` / `lastFullScanAt` | what the last scan updated, skipped and could not read, its duration and the last full sync |
| embedding quiet period | 12 s after the last watched change, so a burst is one job; job progress pushes status |
| Windows lock retry, `node.exe` lookup | `rename` retried on `EPERM`/`EBUSY`/`EACCES` with a readable message; Node discovered as `node.exe` first on Windows |

Explicitly not built, by decision: Obsidian Canvas (declared the next stage, §14.1)
and link-graph visualization (deferred, §14.2).

Evidence: `npm run typecheck` exit 0; `npm test` **22 suites / 164 tests** pass. The
live host check for this release is the same plugin start path verified for 0.9.11.

## Plugin 0.9.11 — the 0.16.0 recommendations implemented (2026-11-17)

Feature release (0.8.11 → 0.9.11). It adopts four capabilities the same 0.16.0 SDK
already ships; the host floor stays `>=0.15.0` and the old surface is unchanged.

| Capability | Used for | Contract |
| --- | --- | --- |
| stable bundle copy + saved-entry healing | an injected/registered MCP path that survives `paseo plugin update` | `$PASEO_HOME/plugins/obsidian-bridge/mcp-server.js`, only this plugin's saved key touched |
| `defineSubscription` + `useSubscription` | live index status in the screen and the workspace tab | `obsidian-bridge.status-stream` (`{ at, status }`, full snapshot) |
| `addComposerItem` + `useComposer()` | *Insert Obsidian note links* control | host `Action`, `composer.insertText`, no vault write |
| hook `metadata` (`agent.create.before` result; `agent.open.before` through `setMetadata`) | per-agent `obsidian-bridge: { mode, reason, at }` marker; a recorded `mcp` mode skips the capability probe | own metadata key only |

Degradation on an older host is unchanged and safe: `addComposerItem`,
`useSubscription` and hook `metadata` simply do not exist before 0.16.0, so the
control and the stream never render and the panels keep their one-shot status
read; the stable copy works on every host.

Evidence: `npm run typecheck` exit 0; `npm test` **17 suites / 138 tests** pass
(new: `tests/mcp-stable.test.ts` 5, `tests/injection.test.ts` 8 including the
citation text, `tests/session-open.test.ts` 13). Not proven by this build on its
own: a live `addSubscription` push and a rendered composer control inside a real
daemon — both are host-rendered behaviour.

## Paseo 0.16.0 pass (2026-11-17, 0.8.11)

Patch release: a verified compatibility pass, no behaviour change, no new
functionality. `requirements.paseo` stays `>=0.15.0` because no 0.16.0-only API
is used; the dev pin moved from `^0.15.0` to `^0.16.0` so typecheck and tests run
against the current SDK.

| Check | Result |
| --- | --- |
| Release notes | [Paseo v0.16.0](https://github.com/getpaseo/paseo/releases/tag/v0.16.0) reviewed for plugin-facing changes |
| SDK | `@getpaseo/plugin` `0.16.0` installed for the pass (the range `^0.16.0` resolves to `0.16.1`, also typechecked) |
| `npm run typecheck` | exit 0 (three-project `tsc -b`) against SDK 0.16.0 |
| `npm test` | **15 suites / 123 tests pass**, `pretest` rebuilt `dist/mcp-server.js` |
| Live host | Paseo **0.16.1** on this machine, the installed 0.8.10 `running`: `[paseo] Plugin ready`, settings mirror written, agent skill verified over 8 roots, `session_open … (resume/interactive): skipped: the provider's config file already carries the server`, and no host error |
| Host errors | no `agent.open.before hooks can only change env, tools, and mcpServers`, no collision or refusal in the plugin log |

### 0.16.0 plugin changes and their impact here

| 0.16.0 change | Impact |
| --- | --- |
| **Breaking:** `agent.turn.after.timeline` removed (#9573) | none — the plugin registers only `agent.create.before` and `agent.open.before` |
| Hook payloads gain `metadata` and `background`; the `agent.open.before` result may change only `env`, `tools` and `mcpServers` | compliant — the hook returns either `request` unchanged or `{ ...request, tools, mcpServers }`; it never returns a changed `metadata`, which is the shape that failed `bunny-search` 0.7.5/`command-center` 0.13.2 on this host |
| Plugin RPCs with transform schemas fixed (#8550) | works in the plugin's favour — every RPC input uses `z.string().trim()`, a transform |
| OpenCode v2 session-scoped plugin tool discovery fixed (#9426) | works in the plugin's favour where the attached-tool fallback is used; the OpenCode/Kilo config-file registration remains the primary path |
| Plugin subscriptions, composer controls, sidebar views, badges, binary RPC payloads | not used; additive opportunities only (see §11, 0.8.11 recommendations) |
| Settings → Plugins opens a plugin's settings from a cog with a tab per screen | presentational; `addSettingsScreen` still registers one screen, no API change |

**The OpenCode shared-service guard is still required.** Paseo 0.16.x still
refuses an OpenCode agent whose config carries custom MCP servers when the local
OpenCode service is shared, so `agentConfigCoversProvider` and the config-file
registration stay exactly as they are.

### Not verified in this pass

- The MCP-injection branch of `agent.open.before` and of `agent.create.before` on
a live agent: the only live session open on this host took the config-covered
path (OpenCode). The decision matrix stays covered by `tests/session-open.test.ts`.
- Cline and Kilo live registration, and the Obsidian Local REST API enrichment
  (last verified live on 0.15.4, 2026-11-14).

## Verified (2026-11-14, 0.8.8)

| Component | Version | Notes |
| --- | --- | --- |
| Paseo | `0.15.4` | Installed from Git (`paseo plugin update`), plugin `running`; `npm ci` + `npm run bundle` run in the managed checkout. |
| Obsidian Local REST API with MCP | `5.5.2` (API route set of 5.x) | Live, not a fake server: `GET /` probe (`authenticated: true`), `POST /search/simple/?query=…&maxResults=…`, note JSON with `Accept: application/vnd.olrapi.note+json`, and four `POST /events/vault/<event>/` + SSE subscriptions held open by the plugin process. |
| Semantic search | `Xenova/multilingual-e5-small` q8 | Model cache in `$PASEO_HOME/plugins/obsidian-bridge/models` (130 MB); 1 684/1 684 chunks embedded, query embedding ready, `obsidian_diagnose` recall@5 = 1.0 lexical and hybrid. |
| MCP injection into agents | OpenCode provider | 0.4.3 saved the server via `agent.create.before`, but Paseo 0.15.4 refuses a saved MCP server on an OpenCode agent that shares the local OpenCode service (`Custom OpenCode MCP servers … require an isolated server`) and reports `supportsMcpServers: false`; attached tools are not surfaced by OpenCode either. 0.5.4 registers `mcp.obsidian-bridge` in OpenCode's (and Kilo's) own config file and stands both hooks down for such a provider. |
| Cline MCP registration | `~/.cline/data/settings/cline_mcp_settings.json` | Live: a Cline agent saw the skill and no `obsidian_*` tool before the entry existed; after registration the same agent answers `obsidian_status`. Cline connects only remote MCP servers from the session payload, so the file is the only working path. |
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

- **Agent skills.** Paseo 0.15.4 exposes no skill API, so the plugin's skill is installed as a file
  (`<skills-root>/obsidian-bridge/SKILL.md`) into roots that already exist: `~/.config/opencode/skills` (OpenCode 2.3.0),
  `~/.opencode/skills`, `~/.agents/skills` (Codex-style), `~/.claude/skills`. Skills are discovered at runtime start, so a
  running agent needs a restart. The official skills ([obsidianmd/obsidian-skills](https://github.com/obsidianmd/obsidian-skills))
  are the upstream reference for Bases, Canvas and the CLI and are not vendored.
- **Writes.** Documents are created and appended inside the `inbox`/`out`/`raw` roles; `obsidian_edit` (0.6.7) additionally
  replaces one exact fragment in an existing note anywhere under the configured `vaultPath`. Nothing is moved, renamed or
  deleted, `.obsidian` is never addressed, and a symlink leading outside the directory is refused.
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
