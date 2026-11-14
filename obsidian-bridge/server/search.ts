import type { SearchHit, SearchResult } from "../shared/contracts";
import { roleOfPath, type Role, type RoleDirs } from "./dirs";
import type { FuzzyHit } from "./obsidian-api";
import type { BridgeStore } from "./store";

/**
 * Retrieval over the index.
 *
 * Signals, each producing a ranked list, fused with Reciprocal Rank Fusion —
 * the pattern `memory-flash` already proved in this repository:
 *
 * 1. heading chunks (FTS5 BM25) — exact names, IDs, error strings,
 * 2. note titles and aliases (FTS5 BM25) — "the note called X",
 * 3. wikilink proximity — one-hop neighbours of the top lexical hits, which is
 *    the advantage a vault has over a folder of files,
 * 4. recency — the browse path for an empty query.
 *
 * RRF keeps the signals comparable without tuning scores against each other.
 */

export const RRF_K = 60;

const WEIGHT_CHUNKS = 1.0;
const WEIGHT_TITLES = 0.7;
const WEIGHT_GRAPH = 0.45;
const WEIGHT_RECENT = 0.25;
const WEIGHT_SEMANTIC = 0.9;
/** Obsidian's own fuzzy search: a note-level signal below chunk BM25. */
const WEIGHT_OBSIDIAN = 0.6;

/** Semantic candidates considered before fusing; the tail rarely changes the top. */
const SEMANTIC_CANDIDATES = 40;

export interface SearchOptions {
  query: string;
  limit?: number;
  folder?: string;
  tags?: string[];
  /** Restrict to one directory role (`workspace` = everything else). */
  scope?: Role | "all";
  budgetChars?: number;
  snippetChars?: number;
  /** Directory roles, so every hit can name the folder it came from. */
  dirs?: RoleDirs;
  /** Query vector + model whose vectors should join the fusion (0.3.0). */
  semantic?: { vector: Float32Array; modelId: string } | null;
  /** Ranked note paths from Obsidian's fuzzy search (0.4.0, optional). */
  fuzzy?: FuzzyHit[];
  /** Whether enrichment was requested, and why it produced nothing. */
  enrichment?: { enabled: boolean; error: string | null };
}

interface Candidate {
  path: string;
  heading: string;
  snippet: string;
  score: number;
}

export function searchIndex(store: BridgeStore, options: SearchOptions): SearchResult {
  const startedAt = Date.now();
  const query = options.query.trim();
  const limit = options.limit ?? 10;
  const snippetChars = options.snippetChars ?? 600;
  const budgetChars = options.budgetChars ?? 8000;
  const folder = options.folder?.trim() ?? "";
  const wantedTags = (options.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const scope = options.scope ?? "all";
  const dirs: RoleDirs = options.dirs ?? { workspace: "", inbox: null, out: null, raw: null };
  const signals: string[] = [];
  const scores = new Map<string, Candidate>();

  const add = (candidate: Candidate) => {
    const key = `${candidate.path}::${candidate.heading}`;
    const existing = scores.get(key);
    if (existing) {
      existing.score += candidate.score;
      if (candidate.snippet.length > existing.snippet.length) existing.snippet = candidate.snippet;
      return;
    }
    scores.set(key, { ...candidate });
  };

  if (query.length === 0) {
    signals.push("recent");
    store.recentNotes(limit * 2).forEach((note, index) => {
      const chunk = store.firstChunk(note.path);
      add({
        path: note.path,
        heading: chunk?.heading ?? "",
        snippet: (chunk?.text ?? "").slice(0, snippetChars),
        score: WEIGHT_RECENT / (RRF_K + index + 1),
      });
    });
  } else {
    // One rank per note: a long headingless file (a converted export, a raw
    // JSON dump) otherwise fills the chunk list with dozens of rows that all
    // fuse into one entry and outrank the small note that matches every word.
    const chunkRows = uniqueByPath(store.searchChunks(query, 60));
    if (chunkRows.length > 0) signals.push("chunks");
    chunkRows.forEach((row, index) => {
      add({
        path: row.path,
        heading: row.heading,
        snippet: row.text,
        score: WEIGHT_CHUNKS / (RRF_K + index + 1),
      });
    });

    const titleRows = store.searchTitles(query, 20);
    if (titleRows.length > 0) signals.push("titles");
    titleRows.forEach((row, index) => {
      const chunk = store.firstChunk(row.path);
      add({
        path: row.path,
        heading: chunk?.heading ?? "",
        snippet: chunk?.text ?? "",
        score: WEIGHT_TITLES / (RRF_K + index + 1),
      });
    });

    const seeds = [...new Set(chunkRows.slice(0, 5).map((row) => row.path))];
    const neighbours = store.graphNeighbours(seeds, 10);
    if (neighbours.length > 0) signals.push("graph");
    neighbours.forEach((neighbour, index) => {
      const chunk = store.firstChunk(neighbour.path);
      add({
        path: neighbour.path,
        heading: chunk?.heading ?? "",
        snippet: chunk?.text ?? "",
        score: WEIGHT_GRAPH / (RRF_K + index + 1),
      });
    });
  }

  if (options.semantic && options.semantic.vector.length > 0) {
    const embedded = store.embeddingsFor(options.semantic.modelId);
    if (embedded.length > 0) {
      signals.push("semantic");
      const vector = options.semantic.vector;
      const ranked = embedded
        .map((row) => ({ row, similarity: dotProduct(vector, row.vec) }))
        .sort((a, b) => b.similarity - a.similarity);
      const nearest: typeof ranked = [];
      const seen = new Set<string>();
      for (const entry of ranked) {
        if (seen.has(entry.row.path)) continue;
        seen.add(entry.row.path);
        nearest.push(entry);
        if (nearest.length === SEMANTIC_CANDIDATES) break;
      }
      nearest.forEach((entry, index) => {
        add({
          path: entry.row.path,
          heading: entry.row.heading,
          snippet: entry.row.text,
          score: WEIGHT_SEMANTIC / (RRF_K + index + 1),
        });
      });
    }
  }

  if (options.fuzzy && options.fuzzy.length > 0) {
    let added = false;
    options.fuzzy.forEach((hit, index) => {
      // Only indexed notes can be cited; an excluded path from Obsidian's
      // index must not leak into results.
      if (store.noteMeta(hit.path) === null) return;
      const chunk = store.firstChunk(hit.path);
      add({
        path: hit.path,
        heading: chunk?.heading ?? "",
        snippet: hit.snippet.length > 0 ? hit.snippet : (chunk?.text ?? ""),
        score: WEIGHT_OBSIDIAN / (RRF_K + index + 1),
      });
      added = true;
    });
    if (added) signals.push("obsidian");
  }

  let candidates = [...scores.values()];
  if (folder.length > 0) {
    candidates = candidates.filter(
      (candidate) => candidate.path === folder || candidate.path.startsWith(`${folder}/`),
    );
  }
  if (wantedTags.length > 0) {
    candidates = candidates.filter((candidate) => {
      const tags = store.tagsOf(candidate.path).map((tag) => tag.toLowerCase());
      return wantedTags.every((tag) => tags.includes(tag));
    });
  }
  if (scope !== "all") {
    candidates = candidates.filter((candidate) => roleOfPath(candidate.path, dirs) === scope);
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, limit);
  const backlinks = store.backlinkCounts(top.map((candidate) => candidate.path));

  const hits: SearchHit[] = top.map((candidate) => {
    const meta = store.noteMeta(candidate.path);
    return {
      path: candidate.path,
      title: meta?.title ?? candidate.path,
      heading: candidate.heading,
      snippet: candidate.snippet.replace(/\s+/g, " ").trim().slice(0, snippetChars),
      score: Number(candidate.score.toFixed(6)),
      backlinks: backlinks.get(candidate.path) ?? 0,
      role: roleOfPath(candidate.path, dirs),
    };
  });

  const note =
    hits.length === 0
      ? query.length === 0
        ? "The index is empty. Set the vault path in Settings → Plugins → Obsidian Bridge."
        : "No notes matched. Try fewer words, or drop the folder/tag filters."
      : null;

  return {
    query,
    hits,
    text: packHits(hits, budgetChars),
    tookMs: Date.now() - startedAt,
    signals,
    note,
    enrichment: {
      enabled: options.enrichment?.enabled ?? false,
      used: signals.includes("obsidian"),
      error: options.enrichment?.error ?? null,
    },
  };
}

/** Keeps the first (best-ranked) row per note path. */
function uniqueByPath<T extends { path: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.path)) return false;
    seen.add(row.path);
    return true;
  });
}

/** Dot product of two L2-normalised vectors, i.e. their cosine similarity. */
function dotProduct(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}

/** Packs hits into a bounded text block an agent can quote from. */
export function packHits(hits: SearchHit[], budgetChars: number): string {
  if (hits.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const [index, hit] of hits.entries()) {
    const location = hit.heading.length > 0 ? `${hit.path} § ${hit.heading}` : hit.path;
    const header = `[${index + 1}] ${location} (backlinks: ${hit.backlinks})`;
    const body = hit.snippet;
    const block = `${header}\n${body}\n`;
    if (used + block.length > budgetChars && lines.length > 0) break;
    lines.push(block);
    used += block.length;
  }
  while (used > budgetChars && lines.length > 0) {
    const last = lines.pop() ?? "";
    used -= last.length;
  }
  return lines.join("\n").trim();
}
