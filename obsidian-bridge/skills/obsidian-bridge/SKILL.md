---
name: obsidian-bridge
description: Read and write the user's Obsidian vault through the obsidian-bridge tools — `obsidian_search` finds notes by meaning or title, `obsidian_read` reads a whole note or one heading, `obsidian_outline`/`obsidian_list`/`obsidian_links` inspect them, `obsidian_edit`/`obsidian_write_document`/`obsidian_write_scratch`/`obsidian_append_inbox` write Obsidian Flavored Markdown (frontmatter, wikilinks, callouts, tags, embeds). Use when the user asks about their Obsidian notes, documents, plans or research, or asks you to create, append to or edit a note in the vault.
---

# Obsidian Bridge Skill

The vault is a **reference library**, not your memory: nothing here is read or written unless the user
explicitly asks about their Obsidian documents or asks for a document. Agent memory belongs to
`memory-flash`; project planning belongs to `luck-planner`.

The bridge is a directory on disk plus a local index. Obsidian itself does not have to be running.

## Reading

1. **Find first, never guess a path.**
   `obsidian_search` takes `query` plus optional `folder`, `tags`, `scope` (`workspace` | `inbox` | `out` |
   `raw`), `limit`, `budget_chars`, `semantic`. Start without filters; add a filter only when the user
   named a folder or a tag. Hits come back with path, heading, directory role, backlinks and a snippet.
2. **Snippets are not the document.** For a short note call `obsidian_read` with `path`
   and quote from the returned body. Frontmatter, tags, headings and `truncated` come back as structured
   fields.
3. **Long documents: read a section.** Above roughly 20 KB read the outline first
   (`obsidian_outline`), then `obsidian_read` with the `heading` you need — a heading selects that
   subtree only. Reading a 100 KB report whole floods the context; a section does not. `truncated: true`
   means the file exceeded the 4 MiB read limit.
4. **Cite what you used**: the note path, and the heading when the answer came from one section.
5. Other read tools: `obsidian_list` (folder contents), `obsidian_links` (resolved links and backlinks,
   or the vault's unresolved links), `obsidian_directories` (the role map), `obsidian_status` (index
   counts and freshness), `obsidian_index` (rebuild after external changes).
6. When search looks wrong, `obsidian_diagnose` measures recall@k over cases you supply instead of
   guessing whether semantic search helps.
7. A hit may carry `callout` (the section answered from `> [!warning]`, `> [!tip]`, …), and
   `obsidian_outline` returns Dataview inline fields (`key:: value`) as `inlineFields` — read those
   as fields, not as prose.

## Writing

Call `obsidian_directories` first if you do not know the role map. Roles decide where a write is allowed:

| Role | Meaning | Use |
| --- | --- | --- |
| `out` | authored documents | guides, reports, recommendations the user asked for |
| `raw` | scratch | intermediate notes, alternatives, thinking on paper |
| `inbox` | incoming material | only when the user asks to add something to their source notes |
| `workspace` | everything else | **read-only for the append tools**; edit it with `obsidian_edit` |

- **New section in a document** — `obsidian_write_document` (`out`), `obsidian_write_scratch` (`raw`),
  `obsidian_append_inbox` (`inbox`). Each call appends a `## <date> — <title>` section, creating the note
  with `title`/`kind`/`created`/`source` frontmatter when it does not exist. An identical body is reported
  as a duplicate instead of being written twice.
- **Change an existing note anywhere** — `obsidian_edit` with `path`, `old_text`, `new_text`. This is the
  only tool that writes outside the three roles. `old_text` must occur **exactly once**: include enough
  surrounding text to make it unique, otherwise the tool refuses and tells you how many matches there are.
  A refusal is actionable: it lists `suggestions` — the closest text with line numbers (or the places an
  ambiguous fragment occurs) — so copy the exact wording from there instead of retyping from memory.
  When only wrapping or indentation differs, retry with `ignore_whitespace: true`; the exactly-once rule
  still applies. Everything outside the matched span is preserved byte for byte. An empty `new_text`
  deletes the fragment. It never creates a note.
- Nothing moves, renames or deletes a note, and `.obsidian/` is never addressable.
- `readOnly` (reported by `obsidian_directories`) switches every write off; `maxWriteChars` limits one
  body/fragment, and 4 MiB limits the whole note. Split large documents instead of pushing past a limit.
- After a write, say which note you touched. Search reflects the change once the plugin's indexer sees the
  file.

## Few-shot examples

**"What did we decide about the queue, and where is it written down?"**

1. `obsidian_search {"query": "queue decision", "budget_chars": 4000}`
2. Pick the hit whose path and heading answer the question. Long note? `obsidian_outline {"path": …}`
   first, then read one section.
3. `obsidian_read {"path": "Projects/orion/Plan.md", "heading": "Decision"}`
4. Answer and cite `Projects/orion/Plan.md § Decision`.

Do not `glob`, `grep`, guess a path, or read every hit: one search plus one read is the intended cost.

**"Append the timeout change to the risks section of the plan."**

1. `obsidian_outline {"path": "Projects/orion/Plan.md"}` to find the heading, then
   `obsidian_read {"path": …, "heading": "Risks"}` to get the current text.
2. `obsidian_edit {"path": …, "old_text": "<two or three exact lines>", "new_text": "<the new text>"}`.
3. If it refuses `not found`: the result's `suggestions` name the closest line — copy that wording.
   If only line wrapping differs: retry with `"ignore_whitespace": true`. If it reports several
   matches: add one neighbouring line from the suggestions to make the fragment unique.
   Never retype the fragment from memory and never rewrite the whole note.

**"Write the recommendation we just produced into Obsidian."**

1. `obsidian_directories {}` → the role map and whether writes are enabled.
2. `obsidian_write_document {"name": "guides/timeouts", "title": "Timeout policy", "body": …}` → the
   note lands in `out` and gains a dated section; no `create` flag is needed for a new document.
3. Report the note path. Search sees it after the indexer picks up the file.

**When Obsidian is closed** every read and write above still works — the index is on disk. Only the
Obsidian fuzzy signal, authoritative backlinks, live events and "Open in Obsidian" need the app.

## Obsidian Flavored Markdown

Standard Markdown is assumed; these are the Obsidian-specific parts that matter when writing:

```markdown
---
title: Note title
tags: [project, active]
aliases: [Short name]
---

[[Note]]                  wikilink — notes inside the vault
[[Note|Display text]]     with display text
[[Note#Heading]]          to a heading
[[#Heading]]              within this note
![[Note]]                 embed a whole note
![[image.png|300]]        embed with width
> [!tip] Optional title
> Callout body.
==highlight==  %%hidden comment%%  #tag  #nested/tag
$e^{i\pi}+1=0$            inline math;  $$ … $$ for a block
```

- Use `[[wikilinks]]` for notes inside the vault (renames are tracked by Obsidian) and `[text](url)`
  for external addresses only.
- In tables escape the alias pipe: `[[Note\|Alias]]`.
- `#1984` is not a tag (needs one non-digit); a space ends a tag.
- Keep the plugin's own shape when appending to a generated document: its `# Title` and
  `## <date> — <section>` headings are part of the contract.

## Boundaries

- Paths are resolved inside the configured directory. `..`, absolute paths, `.obsidian/` and symlinks
  leading outside are refused — do not try to work around a refusal; report it.
- A refused write (read-only, wrong role, ambiguous fragment, missing note) is information: relay the
  message and ask how to proceed.
- Write in the language of the user's request unless they ask otherwise.

## References

- The official Obsidian agent skills (Obsidian Flavored Markdown, Bases, JSON Canvas, CLI):
  <https://github.com/obsidianmd/obsidian-skills> — install it when the user works on Bases, Canvas files
  or wants Obsidian's CLI; this skill covers the bridge workflow and only the Markdown vocabulary needed
  for notes.
- Obsidian Flavored Markdown: <https://help.obsidian.md/obsidian-flavored-markdown>
