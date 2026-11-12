import * as path from "node:path";

/**
 * Markdown/vault parsing.
 *
 * Everything here is derived from the file itself — no Obsidian process is
 * involved. That is what lets the index and the read path work with the app
 * closed (`__research.md` §7).
 */

/** One wikilink occurrence as written in a note. */
export interface ParsedLink {
  rawTarget: string;
  anchor: string | null;
  alias: string | null;
  kind: "link" | "embed";
}

export interface ParsedChunk {
  /** Heading path, `"Section › Subsection"`; `""` for the introduction. */
  heading: string;
  text: string;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  frontmatterRaw: string;
  body: string;
  title: string;
  headings: Array<{ level: number; text: string }>;
  tags: string[];
  aliases: string[];
  links: ParsedLink[];
  chunks: ParsedChunk[];
  wordCount: number;
}

/** Maximum characters in one chunk before it is split on paragraph boundaries. */
export const CHUNK_CHAR_LIMIT = 1200;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TAG = /(^|[\s([{,;:'"“])#([\p{L}\p{N}_/-]{1,64})/gu;
const WIKILINK = /(!?)\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/** Splits a note into frontmatter, its parsed keys and the body. */
export function splitFrontmatter(text: string): {
  raw: string;
  data: Record<string, unknown>;
  body: string;
} {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { raw: "", data: {}, body: normalized };
  const match = /\n---[ \t]*(\r?\n|$)/.exec(normalized.slice(3));
  if (!match || match.index === undefined) return { raw: "", data: {}, body: normalized };
  const raw = normalized.slice(3, 3 + match.index).replace(/^\r?\n/, "");
  // Drop the blank lines that separate the closing `---` from the body, so a
  // note's first line is its first real line.
  const body = normalized
    .slice(3 + match.index + match[0].length)
    .replace(/^(?:[ \t]*\r?\n)+/, "");
  return { raw, data: parseYamlSubset(raw), body };
}

/**
 * A deliberately small YAML subset: `key: value` scalars, `[a, b]` inline
 * lists, and `- item` block lists. That covers what Obsidian users put in
 * frontmatter for the fields this plugin indexes (title, tags, aliases,
 * project, status). Anything more elaborate is kept as a raw string.
 */
export function parseYamlSubset(raw: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let currentKey: string | null = null;
  let list: string[] | null = null;

  const flush = () => {
    if (currentKey && list) data[currentKey] = list;
    currentKey = null;
    list = null;
  };

  for (const line of lines) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentKey) {
      list ??= [];
      list.push(unquote(item[1].trim()));
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    flush();
    const key = pair[1];
    const value = pair[2].trim();
    if (value.length === 0) {
      // A key with no inline value starts a block list (or is empty).
      currentKey = key;
      list = null;
      continue;
    }
    data[key] = parseScalar(value);
  }
  flush();
  return data;
}

function parseScalar(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((entry) => unquote(entry.trim()))
      .filter((entry) => entry.length > 0);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return unquote(value);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Removes fenced code blocks so tags/links inside code are not indexed. */
export function stripCodeBlocks(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

export function extractHeadings(body: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING.exec(line);
    if (!match) continue;
    headings.push({ level: match[1].length, text: match[2].trim() });
  }
  return headings;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

/** Tags from frontmatter (`tags`, `tag`) and the body, normalized. */
export function extractTags(body: string, frontmatter: Record<string, unknown>): string[] {
  const tags = new Set<string>();
  const add = (raw: string) => {
    const tag = raw.trim().replace(/^#/, "").replace(/\/+$/, "");
    // Obsidian rejects purely numeric tags; matching it keeps noise out.
    if (tag.length === 0 || /^\d+$/.test(tag)) return;
    tags.add(tag.slice(0, 64));
  };
  for (const key of ["tags", "tag"]) {
    for (const entry of asStringArray(frontmatter[key])) add(entry);
  }
  const text = stripCodeBlocks(body);
  for (const match of text.matchAll(TAG)) add(match[2]);
  return [...tags];
}

export function extractLinks(body: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const text = stripCodeBlocks(body);
  for (const match of text.matchAll(WIKILINK)) {
    const rawTarget = match[2].trim();
    const anchor = match[3]?.trim() ?? null;
    const alias = match[4]?.trim() ?? null;
    if (rawTarget.length === 0 && anchor === null) continue;
    links.push({ rawTarget, anchor, alias, kind: match[1] === "!" ? "embed" : "link" });
  }
  return links;
}

/** Aliases that let `[[Some Alias]]` resolve to this note. */
export function extractAliases(frontmatter: Record<string, unknown>): string[] {
  return [...new Set([...asStringArray(frontmatter["aliases"]), ...asStringArray(frontmatter["alias"])])];
}

/**
 * Splits the body into chunks at headings (one chunk per section), keeping the
 * heading path so a result can cite `note.md § Section`. Oversized sections are
 * split on blank lines.
 */
export function chunkNote(body: string): ParsedChunk[] {
  const lines = body.split("\n");
  const sections: Array<{ stack: string[]; lines: string[] }> = [{ stack: [], lines: [] }];
  const stack: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = !inFence ? HEADING.exec(line) : null;
    if (match) {
      const level = match[1].length;
      stack.length = Math.max(0, Math.min(stack.length, level - 1));
      stack[level - 1] = match[2].trim();
      sections.push({ stack: stack.slice(0, level), lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }

  const chunks: ParsedChunk[] = [];
  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (text.length === 0) continue;
    const heading = section.stack.filter((entry) => entry !== undefined).join(" › ");
    for (const part of splitLongText(text)) {
      chunks.push({ heading, text: part });
    }
  }
  return chunks;
}

function splitLongText(text: string): string[] {
  if (text.length <= CHUNK_CHAR_LIMIT) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const parts: string[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.trim().length > 0) parts.push(buffer.trim());
    buffer = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_CHAR_LIMIT) {
      flush();
      for (let index = 0; index < paragraph.length; index += CHUNK_CHAR_LIMIT) {
        parts.push(paragraph.slice(index, index + CHUNK_CHAR_LIMIT));
      }
      continue;
    }
    if ((buffer + "\n\n" + paragraph).length > CHUNK_CHAR_LIMIT) flush();
    buffer = buffer.length === 0 ? paragraph : `${buffer}\n\n${paragraph}`;
  }
  flush();
  return parts.length > 0 ? parts : [text];
}

function titleOf(
  relPath: string,
  frontmatter: Record<string, unknown>,
  headings: Array<{ level: number; text: string }>,
): string {
  const fromFrontmatter = frontmatter["title"];
  if (typeof fromFrontmatter === "string" && fromFrontmatter.trim().length > 0) {
    return fromFrontmatter.trim();
  }
  const firstHeading = headings.find((heading) => heading.level === 1);
  if (firstHeading) return firstHeading.text;
  return path.basename(relPath).replace(/\.md$/i, "");
}

export function countWords(body: string): number {
  return body.split(/\s+/).filter((entry) => entry.length > 0).length;
}

/** Parses one note file into everything the index needs. */
export function parseNote(text: string, relPath: string): ParsedNote {
  const { raw, data, body } = splitFrontmatter(text);
  const headings = extractHeadings(body);
  return {
    frontmatter: data,
    frontmatterRaw: raw,
    body,
    title: titleOf(relPath, data, headings),
    headings,
    tags: extractTags(body, data),
    aliases: extractAliases(data),
    links: extractLinks(body),
    chunks: chunkNote(body),
    wordCount: countWords(body),
  };
}
