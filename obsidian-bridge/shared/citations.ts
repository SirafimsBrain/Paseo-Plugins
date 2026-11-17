/**
 * Citation text the composer control inserts (0.9.11).
 *
 * Kept out of the React component so the exact form — Obsidian's own
 * `[[note#heading|title]]` — is unit-testable without the host runtime.
 */

export interface CitationHit {
  path: string;
  heading: string;
  title: string;
}

/**
 * `[[path#heading|title]]`, with the `.md` suffix dropped the way Obsidian
 * writes links, the heading included only when the hit has one, and the title
 * as the link label.
 */
export function wikilinkFor(path: string, heading: string, title: string): string {
  const target = `${path.replace(/\.md$/i, "")}${heading.length > 0 ? `#${heading}` : ""}`;
  const label = title.trim().length > 0 ? title.trim() : target;
  return `[[${target}|${label}]]`;
}

/**
 * One list line per hit, wrapped in blank lines so it lands as its own block in
 * the draft. Returns `""` for no hits — the caller reports that instead of
 * inserting an empty block.
 */
export function citationBlock(hits: readonly CitationHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((hit) => `- ${wikilinkFor(hit.path, hit.heading, hit.title)}`);
  return `\n${lines.join("\n")}\n`;
}
