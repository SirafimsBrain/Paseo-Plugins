---
name: obsidian-canvas
description: Draw on an Obsidian canvas through the obsidian-bridge tools — create a board, add text/file/link/group nodes, connect them with labeled edges, lay it out, and turn Markdown outlines into canvases or back. Use when the user asks for a canvas, diagram, mind map, whiteboard, flow or board in their Obsidian vault.
---

<!-- installed-by: obsidian-bridge -->

# Obsidian Canvas Skill

A canvas is a **JSON Canvas 1.0** file (`.canvas`): one JSON object with `nodes` and `edges`. Obsidian
draws it directly; the bridge edits the same file, so nothing has to be open in Obsidian for the tools to
work, and the user sees the result the next time they open the board.

The canvas tools are for drawing, not for memory or planning: agent memory belongs to `memory-flash`,
project planning to the `plan_*` tools of this plugin. Use a canvas when the user asks for a picture — a
diagram, a mind map, a flow, a comparison board, a roadmap.

## The five calls you need

| Call | What it does |
| --- | --- |
| `canvas_create` | creates the `.canvas`; refuses an existing file unless `overwrite: true` |
| `canvas_add_node` | adds one card; returns its `id` and where it landed |
| `canvas_add_edge` | connects two ids (`from` → `to`), optional `label` |
| `canvas_read` | nodes, edges and a text summary — read before editing |
| `canvas_layout` | repositions everything: `grid`, `roadmap` or `hub` |

The rest: `canvas_list` (find a board), `canvas_update_node` (fix a card's text, colour or position),
`canvas_remove` (delete ids; attached edges go with a node), `canvas_from_markdown` (an outline becomes a
board), `canvas_to_markdown` (a board becomes an outline).

## Workflow

1. **Name the file the user named.** A canvas path is vault-relative and ends in `.canvas`; without a
   folder it is created at the vault root. Read it first when it exists — `canvas_read` is how you get
   node ids.
2. **Create, then grow.** `canvas_create` with the path, then `canvas_add_node` per card. Do not build a
   whole board by rewriting the file: one node per call keeps ids and positions honest and the result
   reports each one.
3. **Connect by id.** `canvas_add_edge` takes `from`/`to` — the ids `canvas_add_node` returned. Use
   `label` for the relationship ("blocks", "depends on", "next"); the label is what makes a board
   readable.
4. **Place deliberately, or not at all.** Omit `x`/`y` and the node is placed beside the existing ones —
   that is the right default. Pass coordinates when the shape matters (a row of phases, a grid of
   options). `canvas_layout` restyles a whole board at the end.
5. **Groups frame, they do not contain.** A `group` node is a rectangle with a label drawn at its
   coordinates; nodes inside it are simply placed on top. Add the group first, size it generously
   (`width`/`height`), and place its cards inside its rectangle.
6. **Report the path.** Tell the user which `.canvas` you wrote and how many nodes and edges it has.

## Node types

- `text` — Markdown body (`text`). This is the workhorse: a title card, a step, a comparison cell.
- `file` — a card that opens a vault note or attachment (`file`, optional `subpath: "#heading"`). Use it
  to point at real notes instead of copying their text onto the board.
- `link` — a card that opens a URL (`url`).
- `group` — a labelled frame (`label`), optionally with a background image.

Sizes default to Obsidian's own (text 250×60, file/link 400×400, group 600×400). Colours are the preset
numbers `"1"` red … `"6"` purple, or a `#rrggbb` value; use at most one or two on a board.

## Layouts

`canvas_layout` only moves nodes; ids, text, colours, edges and z-order stay as they are.

- `grid` — rows as wide as the widest card; the honest default for a set of options.
- `roadmap` — one left-to-right row in edge order; use for a sequence, a flow, a timeline.
- `hub` — the first node in the centre, the rest on a ring; use for "one idea, many aspects".

## Markdown both ways

`canvas_from_markdown` turns headings and list items into cards, each item connected to its parent, so an
existing outline or a note section becomes a board in one call (`source` names a vault note,
`markdown` takes the text directly). `canvas_to_markdown` returns the board as a bullet outline — use it
to summarise a canvas in a message or append the structure to a note with `obsidian_write_document`.

## Boundaries

- Paths are relative to the configured Obsidian directory and must end in `.canvas`; `..`, dot files,
  `__history` and `_archive` are refused. Nothing outside that directory is reachable.
- `readOnly` blocks every canvas write with the same message as the document tools; `maxWriteChars`
  applies to the serialized file. A refusal is the answer — do not look for another write path.
- A malformed canvas is reported with the index of the offending node or edge; fix that entry, not the
  whole file.
- Every write is atomic (temp file + rename) and preserves fields this plugin does not know, so a canvas
  edited by a newer Obsidian is not flattened by an edit here.
