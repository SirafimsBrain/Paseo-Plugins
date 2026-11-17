/**
 * Exact-fragment matching for `obsidian_edit`, with the two aids a language
 * model actually needs (0.10.11):
 *
 * - `ignore_whitespace`: compare after collapsing every whitespace run to one
 *   space, and map the match back to the original offsets, so an agent that
 *   re-wrapped a line still lands on the same span. The rule stays
 *   "exactly one occurrence" — a looser matcher that can pick a place is worse
 *   than a refusal.
 * - `suggestFragments`: when there is no match (or several), return the closest
 *   text **from this note** with its line number, so the caller can correct the
 *   fragment without re-reading the whole file.
 *
 * Nothing here writes anything; `edit.ts` owns the filesystem.
 */

export interface FragmentSuggestion {
  /** 1-based line number in the note. */
  line: number;
  /** The candidate text, single-line and truncated. */
  text: string;
  /** Token overlap with the requested fragment, 0–1. */
  score: number;
}

export type FragmentLookup =
  | {
      status: "found";
      start: number;
      end: number;
      /** The note uses CRLF and the fragment matched after conversion. */
      normalizedLineEndings: boolean;
      /** The match came from the whitespace-insensitive comparison. */
      ignoreWhitespace: boolean;
    }
  | { status: "not-found"; suggestions: FragmentSuggestion[] }
  | { status: "ambiguous"; occurrences: number; suggestions: FragmentSuggestion[] };

/** Longest suggestion text, so an error stays small. */
const SUGGESTION_CHARS = 240;

/** Minimum token overlap for a window to be offered as a suggestion. */
const SUGGESTION_THRESHOLD = 0.2;

/** Windows tried per fragment: its own line count, plus one line either side. */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Collapses each whitespace run to one space and records, for every output
 * character, the original offset it came from. `map` has one extra slot for the
 * end offset, so `map[out.length] === text.length`.
 */
export function normalizeWhitespace(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      const start = index;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      out += " ";
      map.push(start);
      continue;
    }
    out += char;
    map.push(index);
    index += 1;
  }
  map.push(text.length);
  return { text: out, map };
}

/** Every whitespace-insensitive occurrence, mapped back to original offsets. */
function whitespaceMatches(
  text: string,
  needle: string,
): Array<{ start: number; end: number }> {
  const haystack = normalizeWhitespace(text);
  const wanted = normalizeWhitespace(needle).text;
  if (wanted.length === 0) return [];
  const matches: Array<{ start: number; end: number }> = [];
  let index = haystack.text.indexOf(wanted);
  while (index !== -1) {
    const start = haystack.map[index] ?? 0;
    const endSlot = index + wanted.length;
    const end = endSlot < haystack.map.length ? (haystack.map[endSlot] ?? text.length) : text.length;
    matches.push({ start, end: Math.max(end, start + 1) });
    index = haystack.text.indexOf(wanted, index + wanted.length);
  }
  return matches;
}

/** Line number (1-based) of an offset. */
export function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function lineTextAt(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const end = text.indexOf("\n", offset);
  return text.slice(start, end === -1 ? text.length : end);
}

function tokensOf(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]{1,64}/gu)
      ?.filter((token) => token.length > 0) ?? [],
  );
}

/** Sørensen–Dice overlap of two token sets. */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, SUGGESTION_CHARS);
}

/**
 * The closest windows of the note to `needle`, best first.
 *
 * Token overlap over line windows — no dependency, no index, deterministic. A
 * window is the fragment's own line count, one line shorter and one longer, so a
 * re-wrapped paragraph and an extra blank line both still score.
 */
export function suggestFragments(
  text: string,
  needle: string,
  limit: number = 3,
): FragmentSuggestion[] {
  const wanted = tokensOf(needle);
  if (wanted.size === 0) return [];
  const lines = text.split("\n");
  const needleLines = Math.max(1, needle.split("\n").length);
  const sizes = new Set([needleLines, Math.max(1, needleLines - 1), needleLines + 1]);
  const best = new Map<number, { suggestion: FragmentSuggestion; size: number }>();

  for (const size of sizes) {
    for (let start = 0; start + size <= lines.length; start += 1) {
      const windowText = lines.slice(start, start + size).join("\n");
      if (windowText.trim().length === 0) continue;
      const score = dice(tokensOf(windowText), wanted);
      if (score < SUGGESTION_THRESHOLD) continue;
      const line = start + 1;
      const existing = best.get(line);
      if (existing && existing.suggestion.score >= Number(score.toFixed(3))) continue;
      best.set(line, {
        suggestion: { line, text: collapse(windowText), score: Number(score.toFixed(3)) },
        size,
      });
    }
  }

  // Equal token overlap means the windows carry the same words: prefer the
  // tighter window, so the fragment's own line comes before a window that also
  // contains the blank line above it.
  return [...best.values()]
    .sort(
      (a, b) =>
        b.suggestion.score - a.suggestion.score ||
        a.size - b.size ||
        a.suggestion.line - b.suggestion.line,
    )
    .map((entry) => entry.suggestion)
    .slice(0, Math.max(1, limit));
}

/** The first `limit` places an ambiguous fragment occurs, with their lines. */
export function occurrenceSuggestions(
  text: string,
  needle: string,
  limit: number = 3,
): FragmentSuggestion[] {
  const found: FragmentSuggestion[] = [];
  let index = text.indexOf(needle);
  while (index !== -1 && found.length < limit) {
    found.push({
      line: lineNumberAt(text, index),
      text: collapse(lineTextAt(text, index)),
      score: 1,
    });
    index = text.indexOf(needle, index + needle.length);
  }
  return found;
}

/**
 * Finds the fragment in the note. Exact match first; on a CRLF note the
 * fragment's line breaks are converted; with `ignoreWhitespace` the comparison
 * collapses whitespace. Each step keeps the "exactly once" rule.
 */
export function findFragment(
  text: string,
  needle: string,
  options: { ignoreWhitespace?: boolean } = {},
): FragmentLookup {
  const exact = countOccurrences(text, needle);
  if (exact === 1) {
    const start = text.indexOf(needle);
    return {
      status: "found",
      start,
      end: start + needle.length,
      normalizedLineEndings: false,
      ignoreWhitespace: false,
    };
  }
  if (exact > 1) {
    return {
      status: "ambiguous",
      occurrences: exact,
      suggestions: occurrenceSuggestions(text, needle),
    };
  }

  if (text.includes("\r\n")) {
    const crlf = needle.replace(/\r?\n/g, "\r\n");
    const crlfCount = countOccurrences(text, crlf);
    if (crlfCount === 1) {
      const start = text.indexOf(crlf);
      return {
        status: "found",
        start,
        end: start + crlf.length,
        normalizedLineEndings: true,
        ignoreWhitespace: false,
      };
    }
    if (crlfCount > 1) {
      return {
        status: "ambiguous",
        occurrences: crlfCount,
        suggestions: occurrenceSuggestions(text, crlf),
      };
    }
  }

  if (options.ignoreWhitespace === true) {
    const matches = whitespaceMatches(text, needle);
    if (matches.length === 1) {
      return {
        status: "found",
        start: matches[0].start,
        end: matches[0].end,
        normalizedLineEndings: false,
        ignoreWhitespace: true,
      };
    }
    if (matches.length > 1) {
      // The looser comparison must not make a unique match out of several
      // places: the caller still has to disambiguate.
      return {
        status: "ambiguous",
        occurrences: matches.length,
        suggestions: matches.slice(0, 3).map((match) => ({
          line: lineNumberAt(text, match.start),
          text: collapse(lineTextAt(text, match.start)),
          score: 1,
        })),
      };
    }
  }

  return { status: "not-found", suggestions: suggestFragments(text, needle) };
}
