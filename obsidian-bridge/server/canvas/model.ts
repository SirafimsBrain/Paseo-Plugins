import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isPlanSystemPath, resolveInsideVault } from "../vault";

/**
 * JSON Canvas 1.0 — the file format Obsidian's Canvas view reads and writes.
 *
 * Reimplemented here from the specification (https://jsoncanvas.org/spec/1.0)
 * rather than pulled from a package: the plugin ships as one bundle with no
 * runtime dependency beyond Node, and the format is small enough that a
 * dependency would add supply-chain surface without removing any work.
 *
 * The model is deliberately permissive on input: every field the spec does not
 * name is preserved on the node or edge object it came from, so an edit made by
 * a newer Obsidian or another plugin is not silently dropped when this server
 * rewrites the file. Validation is strict where the spec is (ids, types, the
 * four required integers, the endpoint ids of an edge) and reports the index of
 * the offending node, because a canvas is edited by a machine and a bare
 * "invalid" would cost a second round trip.
 */

export const CANVAS_EXTENSION = ".canvas";

export const CANVAS_NODE_TYPES = ["text", "file", "link", "group"] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

export const CANVAS_EDGE_SIDES = ["top", "right", "bottom", "left"] as const;
export type CanvasEdgeSide = (typeof CANVAS_EDGE_SIDES)[number];

export const CANVAS_EDGE_ENDS = ["none", "arrow"] as const;
export type CanvasEdgeEnd = (typeof CANVAS_EDGE_ENDS)[number];

export const CANVAS_BACKGROUND_STYLES = ["cover", "ratio", "repeat"] as const;

/** Sizes Obsidian itself creates when the user drops a node of each type. */
export const NODE_DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number }> = {
  text: { width: 250, height: 60 },
  file: { width: 400, height: 400 },
  link: { width: 400, height: 400 },
  group: { width: 600, height: 400 },
};

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  /** `text` nodes. */
  text?: string;
  /** `file` nodes. */
  file?: string;
  /** `file` nodes: a heading or block reference, always starting with `#`. */
  subpath?: string;
  /** `link` nodes. */
  url?: string;
  /** `group` nodes. */
  label?: string;
  background?: string;
  backgroundStyle?: string;
  /** Fields this model does not know, preserved verbatim. */
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasEdgeSide;
  toSide?: CanvasEdgeSide;
  fromEnd?: CanvasEdgeEnd;
  toEnd?: CanvasEdgeEnd;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface CanvasFile {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Unknown top-level keys, preserved on write. */
  extra: Record<string, unknown>;
}

export type CanvasParseResult = { canvas: CanvasFile } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A 16-character hex id, the shape Obsidian writes. */
export function newCanvasId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function validateNode(
  entry: unknown,
  index: number,
  seen: Set<string>,
): { node: CanvasNode } | { error: string } {
  if (!isRecord(entry)) return { error: `node ${index} is not an object.` };
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (id.length === 0) return { error: `node ${index} has no id.` };
  if (seen.has(id)) return { error: `node ${index} repeats the id '${id}'.` };
  seen.add(id);
  const type = entry.type;
  if (typeof type !== "string" || !(CANVAS_NODE_TYPES as readonly string[]).includes(type)) {
    return {
      error: `node ${index} ('${id}') has type '${String(type)}'; the JSON Canvas 1.0 types are ${CANVAS_NODE_TYPES.join(", ")}.`,
    };
  }
  for (const key of ["x", "y", "width", "height"] as const) {
    if (!isFiniteNumber(entry[key])) {
      return { error: `node ${index} ('${id}') needs a numeric '${key}'.` };
    }
  }
  if ((entry.width as number) <= 0 || (entry.height as number) <= 0) {
    return { error: `node ${index} ('${id}') needs a positive width and height.` };
  }
  if (entry.color !== undefined && typeof entry.color !== "string") {
    return { error: `node ${index} ('${id}') has a non-string color.` };
  }
  switch (type as CanvasNodeType) {
    case "text":
      if (typeof entry.text !== "string") {
        return { error: `text node ${index} ('${id}') needs a string 'text'.` };
      }
      break;
    case "file":
      if (typeof entry.file !== "string" || entry.file.trim().length === 0) {
        return { error: `file node ${index} ('${id}') needs a string 'file'.` };
      }
      if (entry.subpath !== undefined && (typeof entry.subpath !== "string" || !entry.subpath.startsWith("#"))) {
        return { error: `file node ${index} ('${id}') has a subpath that does not start with '#'.` };
      }
      break;
    case "link":
      if (typeof entry.url !== "string" || entry.url.trim().length === 0) {
        return { error: `link node ${index} ('${id}') needs a string 'url'.` };
      }
      break;
    case "group": {
      if (entry.label !== undefined && typeof entry.label !== "string") {
        return { error: `group node ${index} ('${id}') has a non-string label.` };
      }
      if (
        entry.backgroundStyle !== undefined &&
        (typeof entry.backgroundStyle !== "string" ||
          !(CANVAS_BACKGROUND_STYLES as readonly string[]).includes(entry.backgroundStyle))
      ) {
        return {
          error: `group node ${index} ('${id}') has backgroundStyle '${String(entry.backgroundStyle)}'; valid values are ${CANVAS_BACKGROUND_STYLES.join(", ")}.`,
        };
      }
      break;
    }
  }
  const node = { ...entry } as CanvasNode;
  node.id = id;
  node.x = Math.round(entry.x as number);
  node.y = Math.round(entry.y as number);
  node.width = Math.round(entry.width as number);
  node.height = Math.round(entry.height as number);
  return { node };
}

function validateEdge(
  entry: unknown,
  index: number,
  ids: Set<string>,
  seen: Set<string>,
): { edge: CanvasEdge } | { error: string } {
  if (!isRecord(entry)) return { error: `edge ${index} is not an object.` };
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (id.length === 0) return { error: `edge ${index} has no id.` };
  if (seen.has(id)) return { error: `edge ${index} repeats the id '${id}'.` };
  seen.add(id);
  for (const key of ["fromNode", "toNode"] as const) {
    const target = entry[key];
    if (typeof target !== "string" || target.trim().length === 0) {
      return { error: `edge ${index} ('${id}') needs a string '${key}'.` };
    }
    if (!ids.has(target)) {
      return { error: `edge ${index} ('${id}') points at node '${target}', which this canvas does not have.` };
    }
  }
  for (const key of ["fromSide", "toSide"] as const) {
    if (
      entry[key] !== undefined &&
      (typeof entry[key] !== "string" || !(CANVAS_EDGE_SIDES as readonly string[]).includes(entry[key] as string))
    ) {
      return { error: `edge ${index} ('${id}') has ${key} '${String(entry[key])}'; valid sides are ${CANVAS_EDGE_SIDES.join(", ")}.` };
    }
  }
  for (const key of ["fromEnd", "toEnd"] as const) {
    if (
      entry[key] !== undefined &&
      (typeof entry[key] !== "string" || !(CANVAS_EDGE_ENDS as readonly string[]).includes(entry[key] as string))
    ) {
      return { error: `edge ${index} ('${id}') has ${key} '${String(entry[key])}'; valid ends are ${CANVAS_EDGE_ENDS.join(", ")}.` };
    }
  }
  for (const key of ["color", "label"] as const) {
    if (entry[key] !== undefined && typeof entry[key] !== "string") {
      return { error: `edge ${index} ('${id}') has a non-string ${key}.` };
    }
  }
  return { edge: { ...entry } as CanvasEdge };
}

/** Validates a canvas document against JSON Canvas 1.0. */
export function validateCanvas(value: unknown): CanvasParseResult {
  if (!isRecord(value)) {
    return { error: "a canvas is a JSON object with optional `nodes` and `edges` arrays." };
  }
  const rawNodes = value.nodes ?? [];
  const rawEdges = value.edges ?? [];
  if (!Array.isArray(rawNodes)) return { error: "`nodes` must be an array." };
  if (!Array.isArray(rawEdges)) return { error: "`edges` must be an array." };

  const nodes: CanvasNode[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of rawNodes.entries()) {
    const checked = validateNode(entry, index, ids);
    if ("error" in checked) return checked;
    nodes.push(checked.node);
  }

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (const [index, entry] of rawEdges.entries()) {
    const checked = validateEdge(entry, index, ids, edgeIds);
    if ("error" in checked) return checked;
    edges.push(checked.edge);
  }

  const { nodes: _nodes, edges: _edges, ...extra } = value;
  return { canvas: { nodes, edges, extra } };
}

/** Parses canvas text; a JSON syntax error names the position. */
export function parseCanvasText(text: string): CanvasParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { error: `the file is not valid JSON (${message}).` };
  }
  return validateCanvas(value);
}

/**
 * Serializes with tab indentation and a trailing newline — what Obsidian writes,
 * so an edited canvas produces a one-line diff instead of a reformatted file.
 */
export function serializeCanvas(canvas: CanvasFile): string {
  return `${JSON.stringify({ ...canvas.extra, nodes: canvas.nodes, edges: canvas.edges }, null, "\t")}\n`;
}

export type CanvasPathResult = { path: string } | { error: string };

/** Vault-relative `.canvas` path, normalized and refused outside the boundary. */
export function normalizeCanvasPath(raw: string): CanvasPathResult {
  const cleaned = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (cleaned.length === 0) return { error: "path is required." };
  const segments = cleaned.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { error: "path is required." };
  if (segments.some((segment) => segment === "..")) {
    return { error: `'${raw}' is outside the vault: '..' cannot be addressed.` };
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return {
      error: `'${raw}' is a dot file or inside a dot directory; canvases live with the notes, not in configuration.`,
    };
  }
  const fileName = segments[segments.length - 1];
  if (!fileName.toLowerCase().endsWith(CANVAS_EXTENSION)) segments[segments.length - 1] = `${fileName}${CANVAS_EXTENSION}`;
  const relPath = segments.join("/");
  if (isPlanSystemPath(relPath)) {
    return { error: `'${relPath}' is planning history or the archive; canvases are not written there.` };
  }
  return { path: relPath };
}

export type CanvasReadResult = { absolute: string; canvas: CanvasFile } | { error: string };

/** Reads and validates the canvas at a vault-relative path. */
export function readCanvasAt(root: string, relPath: string): CanvasReadResult {
  const absolute = resolveInsideVault(root, relPath);
  if (absolute === null) {
    return {
      error:
        `'${relPath}' is outside the vault — outside the configured directory, or leading outside it ` +
        "through a symlink. The plugin reads only what is inside that one directory.",
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf-8");
  } catch {
    return { error: `there is no canvas at '${relPath}'. Create it with canvas_create, or list them with canvas_list.` };
  }
  const parsed = parseCanvasText(text);
  if ("error" in parsed) return { error: `'${relPath}': ${parsed.error}` };
  return { absolute, canvas: parsed.canvas };
}

/** Writes atomically (temp file + rename), creating the folder when missing. */
export function writeCanvasAt(root: string, relPath: string, canvas: CanvasFile): { bytes: number } | { error: string } {
  const absolute = resolveInsideVault(root, relPath);
  if (absolute === null) {
    return { error: `'${relPath}' is outside the vault and cannot be written.` };
  }
  const body = serializeCanvas(canvas);
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.tmp`);
    fs.writeFileSync(temp, body, "utf-8");
    fs.renameSync(temp, absolute);
  } catch (cause) {
    return { error: `could not write '${relPath}': ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  return { bytes: Buffer.byteLength(body) };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when two node rectangles overlap; touching edges are not an overlap. */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * First free position on a coarse grid, scanning right then down. A node added
 * without coordinates lands beside the existing ones instead of on top of them.
 */
export function placeNode(nodes: readonly Rect[], width: number, height: number): { x: number; y: number } {
  const stepX = 320;
  const stepY = 220;
  for (let row = 0; row < 400; row += 1) {
    for (let column = 0; column < 40; column += 1) {
      const candidate: Rect = { x: column * stepX, y: row * stepY, width, height };
      if (!nodes.some((node) => intersects(candidate, node))) return { x: candidate.x, y: candidate.y };
    }
  }
  const lowest = nodes.reduce((max, node) => Math.max(max, node.y + node.height), 0);
  return { x: 0, y: lowest + 80 };
}

export type CanvasLayout = "grid" | "roadmap" | "hub";

export const CANVAS_LAYOUTS: readonly CanvasLayout[] = ["grid", "roadmap", "hub"];

/**
 * Repositions every node. Deliberately coarse: three shapes that read well in
 * Obsidian, not a graph-drawing engine.
 *
 * - `grid` — rows of equal height, columns as wide as the widest node,
 * - `roadmap` — one left-to-right row, ordered by the edge graph then insertion,
 * - `hub` — the first node in the centre, the rest on a ring around it.
 *
 * Array order is z-order, so it is left untouched: only `x`/`y` change.
 */
export function layoutCanvas(canvas: CanvasFile, layout: CanvasLayout, spacing = 60): CanvasFile {
  const gap = Math.max(20, Math.min(400, Math.round(spacing)));
  const nodes = canvas.nodes;
  if (nodes.length <= 1) return canvas;

  if (layout === "roadmap") {
    const order = graphOrder(nodes, canvas.edges);
    let x = 0;
    for (const node of order) {
      node.y = 0;
      node.x = x;
      x += node.width + gap;
    }
    return canvas;
  }

  if (layout === "hub") {
    const [center, ...rest] = nodes;
    center.x = 0;
    center.y = 0;
    const radius = Math.max(360, 90 * Math.ceil(rest.length / 2) + Math.max(center.width, center.height));
    rest.forEach((node, index) => {
      const angle = (2 * Math.PI * index) / Math.max(1, rest.length);
      node.x = Math.round(radius * Math.cos(angle));
      node.y = Math.round(radius * Math.sin(angle));
    });
    return canvas;
  }

  // grid
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const cellWidth = Math.max(...nodes.map((node) => node.width));
  const rowHeights: number[] = [];
  nodes.forEach((node, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, node.height);
    node.x = column * (cellWidth + gap);
    node.y = rowHeights.slice(0, row).reduce((sum, height) => sum + height + gap, 0);
  });
  return canvas;
}

/** Nodes ordered by the edge graph (sources first), insertion order inside a level. */
function graphOrder(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, number>();
  for (const node of nodes) incoming.set(node.id, 0);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.fromNode) || !byId.has(edge.toNode)) continue;
    outgoing.set(edge.fromNode, [...(outgoing.get(edge.fromNode) ?? []), edge.toNode]);
    incoming.set(edge.toNode, (incoming.get(edge.toNode) ?? 0) + 1);
  }
  const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  const ordered: CanvasNode[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  // Cycles leave nodes behind; keep them in file order rather than dropping them.
  for (const node of nodes) if (!seen.has(node.id)) ordered.push(node);
  return ordered;
}

/** First line of a node, for text output and Markdown export. */
export function nodeHeading(node: CanvasNode): string {
  const source =
    node.type === "text"
      ? (node.text ?? "")
      : node.type === "file"
        ? `${node.file ?? ""}${node.subpath ?? ""}`
        : node.type === "link"
          ? (node.url ?? "")
          : (node.label ?? "");
  const firstLine = source.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return firstLine.replace(/^#{1,6}\s+/, "");
}

/** Human- and agent-readable canvas summary; the text block of `canvas_read`. */
export function describeCanvas(
  relPath: string,
  canvas: CanvasFile,
  totals: { nodes: number; edges: number } = { nodes: canvas.nodes.length, edges: canvas.edges.length },
): string {
  const lines = [`${relPath} — ${totals.nodes} node(s), ${totals.edges} edge(s)`];
  for (const node of canvas.nodes) {
    const heading = nodeHeading(node);
    const label = node.type === "group" ? `group "${heading || "untitled"}"` : `${node.type} "${heading.slice(0, 80)}"`;
    lines.push(`  ${node.id} ${label} @ (${node.x},${node.y}) ${node.width}x${node.height}`);
  }
  for (const edge of canvas.edges) {
    const label = edge.label ? ` "${edge.label}"` : "";
    lines.push(`  ${edge.id} ${edge.fromNode} -> ${edge.toNode}${label}`);
  }
  return lines.join("\n");
}

export interface CanvasFromMarkdownResult {
  canvas: CanvasFile;
  /** True when the markdown had no heading and no list item. */
  empty: boolean;
}

/**
 * Builds a canvas from a Markdown outline: every heading and every list item
 * becomes a text node, an item is connected to the nearest shallower one.
 *
 * Position is derived from depth (columns) and order inside a depth (rows), so
 * the result is readable before any layout call; `canvas_layout` can restyle it.
 */
export function canvasFromMarkdown(markdown: string): CanvasFromMarkdownResult {
  const canvas: CanvasFile = { nodes: [], edges: [], extra: {} };
  const stack: Array<{ level: number; node: CanvasNode }> = [];
  const depthRows = new Map<number, number>();

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    const bullet = /^([ \t]*)[-*+]\s+(.*\S)\s*$/.exec(line);
    let level: number | null = null;
    let text = "";
    if (heading) {
      level = heading[1].length;
      text = heading[2].trim();
    } else if (bullet) {
      const indent = bullet[1].replace(/\t/g, "  ").length;
      level = 7 + Math.floor(indent / 2);
      text = bullet[2].trim();
    }
    if (level === null || text.length === 0) continue;

    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].node : null;
    const depth = stack.length;
    const row = depthRows.get(depth) ?? 0;
    depthRows.set(depth, row + 1);

    const node: CanvasNode = {
      id: newCanvasId(),
      type: "text",
      text: parent === null ? `# ${text}` : text,
      x: depth * 320,
      y: row * 140,
      width: 280,
      height: 80,
    };
    canvas.nodes.push(node);
    stack.push({ level, node });
    if (parent !== null) {
      canvas.edges.push({ id: newCanvasId(), fromNode: parent.id, toNode: node.id });
    }
  }

  return { canvas, empty: canvas.nodes.length === 0 };
}

/** Markdown outline of a canvas: a forest of bullets, children indented. */
export function canvasToMarkdown(canvas: CanvasFile): string {
  const children = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of canvas.edges) {
    children.set(edge.fromNode, [...(children.get(edge.fromNode) ?? []), edge.toNode]);
    incoming.add(edge.toNode);
  }
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const lines: string[] = [];
  const seen = new Set<string>();

  const walk = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    seen.add(id);
    const heading = nodeHeading(node) || node.id;
    lines.push(`${"  ".repeat(depth)}- ${heading}`);
    for (const child of children.get(id) ?? []) walk(child, depth + 1);
  };

  for (const node of canvas.nodes) {
    if (!incoming.has(node.id)) walk(node.id, 0);
  }
  // Cycles and detached groups: list whatever the forest walk did not reach.
  for (const node of canvas.nodes) walk(node.id, 0);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
