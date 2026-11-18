# Obsidian Bridge — compatibility

Detailed compatibility notes. The main README keeps only the summary table row and links here.

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
