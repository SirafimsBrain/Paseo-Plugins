import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeSettings } from "../../shared/settings";
import type { McpToolDefinition, ToolOutcome } from "../mcp-tools";
import { resolveVaultRoot } from "../paths";
import { readVaultNote } from "../vault";
import { writeRefusal } from "../write-gate";
import {
  CANVAS_BACKGROUND_STYLES,
  CANVAS_EDGE_ENDS,
  CANVAS_EDGE_SIDES,
  CANVAS_LAYOUTS,
  CANVAS_NODE_TYPES,
  NODE_DEFAULT_SIZE,
  canvasFromMarkdown,
  canvasToMarkdown,
  describeCanvas,
  layoutCanvas,
  newCanvasId,
  normalizeCanvasPath,
  placeNode,
  readCanvasAt,
  serializeCanvas,
  validateCanvas,
  writeCanvasAt,
  type CanvasEdge,
  type CanvasFile,
  type CanvasLayout,
  type CanvasNode,
  type CanvasNodeType,
} from "./model";

/**
 * `canvas_*` tool catalogue and dispatch.
 *
 * The surface follows the JSON Canvas tools the ecosystem settled on
 * (`@lifeng688/obsidian-canvas-mcp`, `obsidian-cli-mcp`, the `json-canvas`
 * skills): read, create, add a node, connect nodes, edit, remove, lay out, and
 * move between Markdown and canvas. The implementation is native — the format
 * is a small JSON document, so a dependency would only add supply-chain surface
 * to a plugin that must stay installable without one.
 *
 * Every write goes through the same two gates as the document tools: the vault
 * boundary (`resolveInsideVault`, symlinks included) and `readOnly` /
 * `maxWriteChars` (`writeRefusal`).
 */

export const CANVAS_CONTRACT_SENTENCE =
  "Reference tool for the user's Obsidian canvases (JSON Canvas 1.0). Use it only when the " +
  "user asks for a canvas, diagram, mind map, board or flow; it is not agent memory and not " +
  "project planning. Paths are relative to the configured Obsidian directory and end in " +
  "`.canvas`; a new node without coordinates is placed beside the existing ones.";

function canvasPlanned(specific: string): string {
  return `${specific.trim()} ${CANVAS_CONTRACT_SENTENCE}`;
}

function json(value: unknown): ToolOutcome {
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : JSON.stringify(record, null, 2);
  return { text, structuredContent: value };
}

function fail(message: string): ToolOutcome {
  return { text: message, isError: true, structuredContent: { error: message } };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function asIdList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return [];
}

function resolveRoot(settings: RuntimeSettings): { root: string } | { error: string } {
  const root = resolveVaultRoot(settings.vaultPath);
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      error:
        `The configured Obsidian directory '${settings.vaultPath || "(empty)"}' does not exist. ` +
        "Ask the user to point the plugin at a vault before using canvas tools.",
    };
  }
  return { root };
}

function openCanvas(
  settings: RuntimeSettings,
  rawPath: unknown,
): { root: string; relPath: string; canvas: CanvasFile; bytes: number } | { error: string } {
  const rootResult = resolveRoot(settings);
  if ("error" in rootResult) return rootResult;
  const named = normalizeCanvasPath(typeof rawPath === "string" ? rawPath : "");
  if ("error" in named) return named;
  const read = readCanvasAt(rootResult.root, named.path);
  if ("error" in read) return { error: read.error };
  return {
    root: rootResult.root,
    relPath: named.path,
    canvas: read.canvas,
    bytes: fs.statSync(read.absolute).size,
  };
}

function saveCanvas(
  settings: RuntimeSettings,
  root: string,
  relPath: string,
  canvas: CanvasFile,
): { bytes: number } | { error: string } {
  const refusal = writeRefusal(settings, serializeCanvas(canvas).length);
  if (refusal) return { error: refusal };
  return writeCanvasAt(root, relPath, canvas);
}

/** Builds one node from tool input, defaulting the type-specific field. */
function buildNode(
  input: Record<string, unknown>,
  nodes: readonly CanvasNode[],
): { node: CanvasNode } | { error: string } {
  const type = (asString(input.type) ?? "text") as CanvasNodeType;
  if (!CANVAS_NODE_TYPES.includes(type)) {
    return { error: `type '${String(input.type)}' is not a canvas node type; use ${CANVAS_NODE_TYPES.join(", ")}.` };
  }
  const defaults = NODE_DEFAULT_SIZE[type];
  const width = asNumber(input.width) ?? defaults.width;
  const height = asNumber(input.height) ?? defaults.height;
  if (width <= 0 || height <= 0) return { error: "width and height must be positive." };
  const x = asNumber(input.x);
  const y = asNumber(input.y);
  const placed = x !== undefined && y !== undefined ? { x, y } : placeNode(nodes, width, height);

  const node: CanvasNode = {
    id: newCanvasId(),
    type,
    x: x ?? placed.x,
    y: y ?? placed.y,
    width,
    height,
  };
  const color = asString(input.color);
  if (color) node.color = color;
  if (type === "text") {
    const text = asString(input.text);
    if (text === undefined) return { error: "a text node needs `text`." };
    node.text = text;
  } else if (type === "file") {
    const file = asString(input.file);
    if (!file) return { error: "a file node needs `file`, a vault-relative path to the note or attachment." };
    node.file = file;
    const subpath = asString(input.subpath);
    if (subpath) node.subpath = subpath;
  } else if (type === "link") {
    const url = asString(input.url);
    if (!url) return { error: "a link node needs `url`." };
    node.url = url;
  } else {
    const label = asString(input.label);
    if (label) node.label = label;
    const background = asString(input.background);
    if (background) node.background = background;
    const backgroundStyle = asString(input.background_style);
    if (backgroundStyle) node.backgroundStyle = backgroundStyle;
  }

  const checked = validateCanvas({ nodes: [node], edges: [] });
  if ("error" in checked) return { error: checked.error };
  return { node: checked.canvas.nodes[0] };
}

function listCanvasFiles(root: string, limit: number): { files: string[]; capped: boolean } {
  const files: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (rel === "__history" || rel === "_archive" || rel.endsWith("/__history") || rel.endsWith("/_archive")) continue;
        stack.push(rel);
        continue;
      }
      if (!entry.isFile() || !rel.toLowerCase().endsWith(".canvas")) continue;
      files.push(rel);
      if (files.length >= limit) return { files: files.sort(), capped: true };
    }
  }
  return { files: files.sort(), capped: false };
}

export const CANVAS_TOOLS: McpToolDefinition[] = [
  {
    name: "canvas_list",
    title: "List canvases",
    description: canvasPlanned(
      "Lists the `.canvas` files in the vault with their node and edge counts, so you can find the " +
        "board the user means before reading it. A file that does not parse is listed with its parse " +
        "error instead of being skipped.",
    ),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "canvas_read",
    title: "Read a canvas",
    description: canvasPlanned(
      "Reads one canvas and returns `nodes`, `edges` and a text summary (`id`, type, first line, " +
        "position, size). Read before editing: node and edge ids are what `canvas_add_edge`, " +
        "`canvas_update_node` and `canvas_remove` take. The text summary stops at `limit` nodes and " +
        "says so with `truncated`/`next_offset`; the structured `nodes` follow the same window.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canvas path relative to the configured directory." },
        offset: { type: "number", description: "First node to show in the text summary (default 0)." },
        limit: { type: "number", description: "Nodes in the text summary, 1–500 (default 200)." },
      },
      required: ["path"],
    },
  },
  {
    name: "canvas_create",
    title: "Create a canvas",
    description: canvasPlanned(
      "Creates a `.canvas` file, optionally with `nodes` and `edges` (JSON Canvas objects; ids are " +
        "generated when omitted). Refuses an existing file unless `overwrite: true`. The result " +
        "returns `path`, `nodes` and `edges` counts; add content with `canvas_add_node` and " +
        "`canvas_add_edge` rather than rewriting the file.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canvas path relative to the configured directory." },
        nodes: { type: "array", description: "Initial JSON Canvas nodes.", items: { type: "object" } },
        edges: { type: "array", description: "Initial JSON Canvas edges.", items: { type: "object" } },
        overwrite: { type: "boolean", description: "Replace an existing canvas (default false)." },
      },
      required: ["path"],
    },
  },
  {
    name: "canvas_add_node",
    title: "Add a canvas node",
    description: canvasPlanned(
      "Adds one node: a `text` card (`text`), a `file` card pointing at a note or attachment " +
        "(`file`, optional `subpath`), a `link` card (`url`) or a `group` frame (`label`). Without " +
        "`x`/`y` the node is placed beside the existing ones; `width`/`height` default to Obsidian's " +
        "own sizes and `color` takes `\"1\"`–`\"6\"` or a hex value. The result returns the new `id` and " +
        "`position`, which `canvas_add_edge` needs.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canvas to edit." },
        type: {
          type: "string",
          enum: [...CANVAS_NODE_TYPES],
          description: "Node type (default `text`).",
        },
        text: { type: "string", description: "Text node body (Markdown)." },
        file: { type: "string", description: "File node: vault-relative note or attachment path." },
        subpath: { type: "string", description: "File node: `#heading` or `#^block`." },
        url: { type: "string", description: "Link node URL." },
        label: { type: "string", description: "Group label." },
        background: { type: "string", description: "Group background image path." },
        background_style: {
          type: "string",
          enum: [...CANVAS_BACKGROUND_STYLES],
          description: "Group background rendering.",
        },
        x: { type: "number", description: "Left position in pixels; omit for automatic placement." },
        y: { type: "number", description: "Top position in pixels; omit for automatic placement." },
        width: { type: "number", description: "Width in pixels." },
        height: { type: "number", description: "Height in pixels." },
        color: { type: "string", description: "Canvas colour: \"1\"–\"6\" or \"#rrggbb\"." },
      },
      required: ["path"],
    },
  },
  {
    name: "canvas_add_edge",
    title: "Connect two canvas nodes",
    description: canvasPlanned(
      "Draws an edge between two existing nodes by id (`from` → `to`), with an optional `label`, " +
        "`from_side`/`to_side` (`top`|`right`|`bottom`|`left`) and `from_end`/`to_end` " +
        "(`none`|`arrow`). Both ids must exist. An identical edge is refused with its id unless " +
        "`allow_duplicate: true`, so a retry does not double the line.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canvas to edit." },
        from: { type: "string", description: "Source node id." },
        to: { type: "string", description: "Target node id." },
        label: { type: "string", description: "Edge label." },
        from_side: { type: "string", enum: [...CANVAS_EDGE_SIDES], description: "Side the edge leaves." },
        to_side: { type: "string", enum: [...CANVAS_EDGE_SIDES], description: "Side the edge enters." },
        from_end: { type: "string", enum: [...CANVAS_EDGE_ENDS], description: "Start endpoint shape." },
        to_end: { type: "string", enum: [...CANVAS_EDGE_ENDS], description: "End endpoint shape (Obsidian defaults to an arrow)." },
        color: { type: "string", description: "Canvas colour: \"1\"–\"6\" or \"#rrggbb\"." },
        allow_duplicate: { type: "boolean", description: "Allow a second identical edge (default false)." },
      },
      required: ["path", "from", "to"],
    },
  },
  {
    name: "canvas_update_node",
    title: "Edit a canvas node",
    description: canvasPlanned(
      "Changes one node by id: its text, label, colour, position or size. Only the fields you pass " +
        "change, and the result returns the stored node. Use it to correct a card or to move it out " +
        "of the way; `canvas_layout` moves everything at once.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canvas to edit." },
        id: { type: "string", description: "Node id from `canvas_read`." },
        text: { type: "string", description: "New text (text nodes)." },
        label: { type: "string", description: "New label (group nodes)." },
        color: { type: "string", description: "New colour; empty string clears it." },
        x: { type: "number", description: "New left position." },
        y: { type: "number", description: "New top position." },
        width: { type: "number", description: "New width." },
        height: { type: "number", description: "New height." },
      },
      required: ["path", "id"],
    },
  },
  {
    name: "canvas_remove",
    title: "Remove canvas nodes or edges",
    description: canvasPlanned(
      "Removes the nodes and/or edges you name by id, in one atomic write. Removing a node also " +
        "removes every edge attached to it, and the result lists those ids so nothing is lost " +
        "silently.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canvas to edit." },
        nodes: { type: "array", description: "Node ids to remove.", items: { type: "string" } },
        edges: { type: "array", description: "Edge ids to remove.", items: { type: "string" } },
      },
      required: ["path"],
    },
  },
  {
    name: "canvas_layout",
    title: "Lay out a canvas",
    description: canvasPlanned(
      "Repositions every node: `grid` (rows as wide as the widest card), `roadmap` (one left-to-right " +
        "row in edge order) or `hub` (first node in the centre, the rest on a ring). `spacing` is the " +
        "gap in pixels. Only positions change, so z-order, ids, text and edges are untouched.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canvas to lay out." },
        layout: { type: "string", enum: [...CANVAS_LAYOUTS], description: "Layout shape (default `grid`)." },
        spacing: { type: "number", description: "Gap between nodes in pixels (default 60)." },
      },
      required: ["path"],
    },
  },
  {
    name: "canvas_from_markdown",
    title: "Turn an outline into a canvas",
    description: canvasPlanned(
      "Builds a canvas from Markdown: every heading and every list item becomes a text node, each " +
        "item connected to the nearest shallower one, placed in depth columns. Pass `markdown` " +
        "directly, or `source` (a vault note path) to draw an existing outline. Refuses an existing " +
        "canvas unless `overwrite: true`; `layout` restyles the result afterwards.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Canvas to create." },
        markdown: { type: "string", description: "Markdown outline to convert." },
        source: { type: "string", description: "Vault note whose Markdown should be converted." },
        layout: { type: "string", enum: [...CANVAS_LAYOUTS], description: "Optional layout after conversion." },
        overwrite: { type: "boolean", description: "Replace an existing canvas (default false)." },
      },
      required: ["path"],
    },
  },
  {
    name: "canvas_to_markdown",
    title: "Export a canvas as an outline",
    description: canvasPlanned(
      "Returns the canvas as a Markdown bullet outline, parents before children, for a summary in a " +
        "note or a message. Read-only: it writes nothing. Cycle members and detached nodes are " +
        "appended rather than dropped.",
    ),
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Canvas to export." } },
      required: ["path"],
    },
  },
];

/** Runs one `canvas_*` tool. Returns `null` for a name this module does not own. */
export async function dispatchCanvasTool(
  name: string,
  input: Record<string, unknown>,
  settings: RuntimeSettings,
): Promise<ToolOutcome | null> {
  if (!name.startsWith("canvas_")) return null;

  switch (name) {
    case "canvas_list": {
      const rootResult = resolveRoot(settings);
      if ("error" in rootResult) return fail(rootResult.error);
      const listed = listCanvasFiles(rootResult.root, 500);
      const files = listed.files.map((relPath) => {
        const read = readCanvasAt(rootResult.root, relPath);
        if ("error" in read) {
          return { path: relPath, nodes: null, edges: null, parse_error: read.error };
        }
        return {
          path: relPath,
          nodes: read.canvas.nodes.length,
          edges: read.canvas.edges.length,
          parse_error: null,
        };
      });
      const text = [
        `${files.length} canvas file(s)${listed.capped ? " (the list stops at 500)" : ""}:`,
        ...files.map((file) =>
          file.parse_error ? `- ${file.path} — unreadable: ${file.parse_error}` : `- ${file.path} — ${file.nodes} node(s), ${file.edges} edge(s)`,
        ),
      ].join("\n");
      return json({ text, files, total: files.length, capped: listed.capped });
    }

    case "canvas_read": {
      const opened = openCanvas(settings, input.path);
      if ("error" in opened) return fail(opened.error);
      const offset = Math.max(0, asNumber(input.offset) ?? 0);
      const limit = Math.max(1, Math.min(500, asNumber(input.limit) ?? 200));
      const slice = opened.canvas.nodes.slice(offset, offset + limit);
      const truncated = offset + slice.length < opened.canvas.nodes.length;
      const windowCanvas: CanvasFile = { nodes: slice, edges: offset === 0 ? opened.canvas.edges : [], extra: {} };
      const summary = describeCanvas(opened.relPath, windowCanvas, {
        nodes: opened.canvas.nodes.length,
        edges: opened.canvas.edges.length,
      });
      const header = truncated
        ? `${summary}\n\nNodes ${offset}–${offset + slice.length - 1} shown; pass offset ${offset + slice.length} for the rest.`
        : summary;
      return json({
        text: header,
        path: opened.relPath,
        bytes: opened.bytes,
        nodes: slice,
        edges: offset === 0 ? opened.canvas.edges : [],
        node_count: opened.canvas.nodes.length,
        edge_count: opened.canvas.edges.length,
        offset,
        limit,
        truncated,
        next_offset: truncated ? offset + slice.length : null,
      });
    }

    case "canvas_create": {
      const rootResult = resolveRoot(settings);
      if ("error" in rootResult) return fail(rootResult.error);
      const named = normalizeCanvasPath(asString(input.path) ?? "");
      if ("error" in named) return fail(named.error);
      const absolute = path.join(rootResult.root, named.path);
      if (fs.existsSync(absolute) && input.overwrite !== true) {
        return fail(
          `'${named.path}' already exists. Read it with canvas_read and edit it, or pass overwrite: true to replace it.`,
        );
      }
      const nodesInput = Array.isArray(input.nodes) ? input.nodes : [];
      const edgesInput = Array.isArray(input.edges) ? input.edges : [];
      const nodes = nodesInput.map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>;
        return { ...record, id: typeof record.id === "string" && record.id.length > 0 ? record.id : newCanvasId() };
      });
      const edges = edgesInput.map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>;
        return { ...record, id: typeof record.id === "string" && record.id.length > 0 ? record.id : newCanvasId() };
      });
      const checked = validateCanvas({ nodes, edges });
      if ("error" in checked) return fail(checked.error);
      const saved = saveCanvas(settings, rootResult.root, named.path, checked.canvas);
      if ("error" in saved) return fail(saved.error);
      return json({
        text: `Created ${named.path} — ${checked.canvas.nodes.length} node(s), ${checked.canvas.edges.length} edge(s).`,
        path: named.path,
        nodes: checked.canvas.nodes.length,
        edges: checked.canvas.edges.length,
        bytes: saved.bytes,
        created: true,
      });
    }

    case "canvas_add_node": {
      const opened = openCanvas(settings, input.path);
      if ("error" in opened) return fail(opened.error);
      const built = buildNode(input, opened.canvas.nodes);
      if ("error" in built) return fail(built.error);
      const canvas: CanvasFile = {
        ...opened.canvas,
        nodes: [...opened.canvas.nodes, built.node],
      };
      const saved = saveCanvas(settings, opened.root, opened.relPath, canvas);
      if ("error" in saved) return fail(saved.error);
      return json({
        text: `Added ${built.node.type} node ${built.node.id} to ${opened.relPath} at (${built.node.x},${built.node.y}).`,
        path: opened.relPath,
        node: built.node,
        nodes: canvas.nodes.length,
        edges: canvas.edges.length,
      });
    }

    case "canvas_add_edge": {
      const opened = openCanvas(settings, input.path);
      if ("error" in opened) return fail(opened.error);
      const from = asString(input.from)?.trim() ?? "";
      const to = asString(input.to)?.trim() ?? "";
      if (from.length === 0 || to.length === 0) return fail("from and to are required: pass node ids from canvas_read.");
      const ids = new Set(opened.canvas.nodes.map((node) => node.id));
      for (const id of [from, to]) {
        if (!ids.has(id)) {
          return fail(
            `'${id}' is not a node of ${opened.relPath}. Use canvas_read to list ids, or canvas_add_node to create the node.`,
          );
        }
      }
      const label = asString(input.label);
      const duplicate = opened.canvas.edges.find(
        (edge) => edge.fromNode === from && edge.toNode === to && (edge.label ?? "") === (label ?? ""),
      );
      if (duplicate && input.allow_duplicate !== true) {
        return json({
          text: `An edge from ${from} to ${to} already exists (${duplicate.id}); nothing was written. Pass allow_duplicate: true to add a second one.`,
          path: opened.relPath,
          edge: duplicate,
          created: false,
          duplicate: true,
        });
      }
      const edge: CanvasEdge = { id: newCanvasId(), fromNode: from, toNode: to };
      if (label) edge.label = label;
      const fromSide = asString(input.from_side);
      const toSide = asString(input.to_side);
      const fromEnd = asString(input.from_end);
      const toEnd = asString(input.to_end);
      const color = asString(input.color);
      if (fromSide) edge.fromSide = fromSide as CanvasEdge["fromSide"];
      if (toSide) edge.toSide = toSide as CanvasEdge["toSide"];
      if (fromEnd) edge.fromEnd = fromEnd as CanvasEdge["fromEnd"];
      if (toEnd) edge.toEnd = toEnd as CanvasEdge["toEnd"];
      if (color) edge.color = color;
      const canvas: CanvasFile = { ...opened.canvas, edges: [...opened.canvas.edges, edge] };
      // Re-validate the document, not the wrapper: a `CanvasFile` carries its
      // unknown top-level keys in `extra`, and passing that object straight to
      // `validateCanvas` would store `extra` itself as an unknown key.
      const checked = validateCanvas({ nodes: canvas.nodes, edges: canvas.edges });
      if ("error" in checked) return fail(checked.error);
      checked.canvas.extra = canvas.extra;
      const saved = saveCanvas(settings, opened.root, opened.relPath, checked.canvas);
      if ("error" in saved) return fail(saved.error);
      return json({
        text: `Connected ${from} -> ${to} in ${opened.relPath} (edge ${edge.id}).`,
        path: opened.relPath,
        edge,
        created: true,
        nodes: checked.canvas.nodes.length,
        edges: checked.canvas.edges.length,
      });
    }

    case "canvas_update_node": {
      const opened = openCanvas(settings, input.path);
      if ("error" in opened) return fail(opened.error);
      const id = asString(input.id)?.trim() ?? "";
      const existing = opened.canvas.nodes.find((node) => node.id === id);
      if (!existing) {
        return fail(`'${id}' is not a node of ${opened.relPath}. Use canvas_read to list ids.`);
      }
      const updated: CanvasNode = { ...existing };
      let changed = false;
      const text = asString(input.text);
      const label = asString(input.label);
      const color = asString(input.color);
      if (text !== undefined) {
        updated.text = text;
        changed = true;
      }
      if (label !== undefined) {
        updated.label = label;
        changed = true;
      }
      if (color !== undefined) {
        if (color.length === 0) delete updated.color;
        else updated.color = color;
        changed = true;
      }
      for (const key of ["x", "y", "width", "height"] as const) {
        const value = asNumber(input[key]);
        if (value !== undefined) {
          updated[key] = value;
          changed = true;
        }
      }
      if (!changed) return fail("nothing to update: pass text, label, color, x, y, width or height.");
      const canvas: CanvasFile = {
        ...opened.canvas,
        nodes: opened.canvas.nodes.map((node) => (node.id === id ? updated : node)),
      };
      const checked = validateCanvas({ nodes: canvas.nodes, edges: canvas.edges });
      if ("error" in checked) return fail(checked.error);
      checked.canvas.extra = canvas.extra;
      const saved = saveCanvas(settings, opened.root, opened.relPath, checked.canvas);
      if ("error" in saved) return fail(saved.error);
      return json({
        text: `Updated node ${id} in ${opened.relPath}.`,
        path: opened.relPath,
        node: checked.canvas.nodes.find((node) => node.id === id) ?? updated,
        nodes: checked.canvas.nodes.length,
        edges: checked.canvas.edges.length,
      });
    }

    case "canvas_remove": {
      const opened = openCanvas(settings, input.path);
      if ("error" in opened) return fail(opened.error);
      const nodeIds = new Set(asIdList(input.nodes));
      const edgeIds = new Set(asIdList(input.edges));
      if (nodeIds.size === 0 && edgeIds.size === 0) {
        return fail("pass nodes and/or edges: the ids to remove, from canvas_read.");
      }
      const knownNodes = new Set(opened.canvas.nodes.map((node) => node.id));
      const unknownNodes = [...nodeIds].filter((id) => !knownNodes.has(id));
      if (unknownNodes.length > 0) {
        return fail(`these ids are not nodes of ${opened.relPath}: ${unknownNodes.join(", ")}`);
      }
      const cascaded = opened.canvas.edges
        .filter((edge) => nodeIds.has(edge.fromNode) || nodeIds.has(edge.toNode))
        .map((edge) => edge.id);
      const removedEdges = [...new Set([...edgeIds, ...cascaded])];
      const canvas: CanvasFile = {
        ...opened.canvas,
        nodes: opened.canvas.nodes.filter((node) => !nodeIds.has(node.id)),
        edges: opened.canvas.edges.filter((edge) => !removedEdges.includes(edge.id)),
      };
      const saved = saveCanvas(settings, opened.root, opened.relPath, canvas);
      if ("error" in saved) return fail(saved.error);
      return json({
        text:
          `Removed ${nodeIds.size} node(s) and ${removedEdges.length} edge(s) from ${opened.relPath}.` +
          (cascaded.length > 0 ? ` Edges removed with their node: ${cascaded.join(", ")}.` : ""),
        path: opened.relPath,
        removed_nodes: [...nodeIds],
        removed_edges: removedEdges,
        cascaded_edges: cascaded,
        nodes: canvas.nodes.length,
        edges: canvas.edges.length,
      });
    }

    case "canvas_layout": {
      const opened = openCanvas(settings, input.path);
      if ("error" in opened) return fail(opened.error);
      const layout = (asString(input.layout) ?? "grid") as CanvasLayout;
      if (!CANVAS_LAYOUTS.includes(layout)) {
        return fail(`layout '${String(input.layout)}' is not supported; use ${CANVAS_LAYOUTS.join(", ")}.`);
      }
      const spacing = asNumber(input.spacing) ?? 60;
      const canvas = layoutCanvas(opened.canvas, layout, spacing);
      const saved = saveCanvas(settings, opened.root, opened.relPath, canvas);
      if ("error" in saved) return fail(saved.error);
      return json({
        text: `Laid out ${opened.relPath} as ${layout} (${canvas.nodes.length} node(s), ${spacing}px gap).`,
        path: opened.relPath,
        layout,
        spacing,
        nodes: canvas.nodes.length,
        edges: canvas.edges.length,
      });
    }

    case "canvas_from_markdown": {
      const rootResult = resolveRoot(settings);
      if ("error" in rootResult) return fail(rootResult.error);
      const named = normalizeCanvasPath(asString(input.path) ?? "");
      if ("error" in named) return fail(named.error);
      const source = asString(input.source)?.trim() ?? "";
      let markdown = asString(input.markdown) ?? "";
      if (source.length > 0) {
        const note = readVaultNote(rootResult.root, source, { allowedExtensions: settings.allowedExtensions });
        if ("error" in note) return fail(note.error);
        markdown = note.text;
      }
      if (markdown.trim().length === 0) {
        return fail("pass markdown, or source with the vault path of a note to convert.");
      }
      const absolute = path.join(rootResult.root, named.path);
      if (fs.existsSync(absolute) && input.overwrite !== true) {
        return fail(`'${named.path}' already exists. Pass overwrite: true to replace it.`);
      }
      const built = canvasFromMarkdown(markdown);
      if (built.empty) {
        return fail("the Markdown has no heading and no list item, so the canvas would be empty.");
      }
      const layout = asString(input.layout);
      if (layout) {
        if (!CANVAS_LAYOUTS.includes(layout as CanvasLayout)) {
          return fail(`layout '${layout}' is not supported; use ${CANVAS_LAYOUTS.join(", ")}.`);
        }
        layoutCanvas(built.canvas, layout as CanvasLayout);
      }
      const saved = saveCanvas(settings, rootResult.root, named.path, built.canvas);
      if ("error" in saved) return fail(saved.error);
      return json({
        text: `Created ${named.path} from Markdown — ${built.canvas.nodes.length} node(s), ${built.canvas.edges.length} edge(s).`,
        path: named.path,
        nodes: built.canvas.nodes.length,
        edges: built.canvas.edges.length,
        bytes: saved.bytes,
        created: true,
      });
    }

    case "canvas_to_markdown": {
      const opened = openCanvas(settings, input.path);
      if ("error" in opened) return fail(opened.error);
      const markdown = canvasToMarkdown(opened.canvas);
      return json({
        text: markdown.length > 0 ? markdown : `${opened.relPath} has no nodes.`,
        path: opened.relPath,
        markdown,
        nodes: opened.canvas.nodes.length,
        edges: opened.canvas.edges.length,
      });
    }

    default:
      return fail(`Unknown canvas tool: ${name}`);
  }
}
