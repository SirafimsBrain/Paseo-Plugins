import { linkLabel } from "./model";

/**
 * Generated body sections.
 *
 * The body of a plan file is a **view** of its frontmatter, not a second source
 * of truth: `## Влияния`, `## Блокировки`, `## Дети` and `## Журнал` are
 * re-rendered on every write, and `## Заметки` is the one section the tools
 * carry through untouched. Two consequences matter:
 *
 * - the same frontmatter always renders the same body (so `plan_validate` can
 *   report a hand-edited body as a divergence instead of guessing);
 * - a reader in Obsidian sees links, which is what makes the tree browsable
 *   without the plugin.
 *
 * Every section is present even when empty (`—`), so a missing heading is a
 * real divergence rather than an empty section.
 */

export const GENERATED_SECTIONS = ["Влияния", "Блокировки", "Дети", "Журнал"] as const;
export const NOTES_HEADING = "Заметки";

const EMPTY = "—";

/** Content of one `## heading` section (case-insensitive), without nested children. */
export function sectionBody(body: string, heading: string): string | null {
  const wanted = heading.trim().toLowerCase();
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.*?)\s*#*\s*$/.exec(lines[index]);
    if (match && match[1].trim().toLowerCase() === wanted) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return null;
  const collected: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/.test(lines[index])) break;
    collected.push(lines[index]);
  }
  return collected.join("\n").trim();
}

/** The free-text section, preserved byte for byte by every generated write. */
export function extractNotes(body: string): string {
  return sectionBody(body, NOTES_HEADING) ?? "";
}

function asLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function renderInfluences(frontmatter: Record<string, unknown>): string {
  const rows = asRecords(frontmatter.influences).map((entry) => {
    const target = typeof entry.target === "string" ? entry.target.trim() : "";
    if (target.length === 0) return "";
    const parts = [target];
    if (typeof entry.status === "string" && entry.status.trim().length > 0) {
      parts.push(entry.status.trim());
    }
    if (typeof entry.impact === "string" && entry.impact.trim().length > 0) {
      parts.push(entry.impact.trim());
    }
    const version = typeof entry.version === "number" ? entry.version : null;
    const revision = typeof entry.revision === "number" ? entry.revision : null;
    if (version !== null && revision !== null) parts.push(`(v${version} r${revision})`);
    return `- ${parts.join(" — ")}`;
  });
  return rows.filter((row) => row.length > 0).join("\n");
}

function renderLinkList(value: unknown): string {
  return asLinks(value)
    .map((link) => `- ${link}`)
    .join("\n");
}

function renderJournal(frontmatter: Record<string, unknown>): string {
  const rows = Array.isArray(frontmatter.journal) ? frontmatter.journal : [];
  const lines: string[] = [];
  for (const entry of rows) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      lines.push(`- ${entry.trim()}`);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["at", "op", "result"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) parts.push(value.trim());
    }
    if (typeof record.actor === "string" && record.actor.trim().length > 0) {
      parts.push(`actor: ${record.actor.trim()}`);
    }
    if (parts.length > 0) lines.push(`- ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}

/** The generated body for one frontmatter, with the kept `## Заметки` text. */
export function renderPlanBody(
  frontmatter: Record<string, unknown>,
  existingBody: string,
): string {
  const notes = extractNotes(existingBody);
  const sections: Array<[string, string]> = [
    ["Влияния", renderInfluences(frontmatter)],
    ["Блокировки", renderLinkList(frontmatter.blocked_by)],
    ["Дети", renderLinkList(frontmatter.children)],
    [NOTES_HEADING, notes],
    ["Журнал", renderJournal(frontmatter)],
  ];
  return sections
    .map(([heading, content]) => `## ${heading}\n\n${content.length > 0 ? content : EMPTY}`)
    .join("\n\n");
}

/** Normalizes a body so formatting-only differences do not count as divergence. */
function normalizedBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `true` when the stored body is exactly what {@link renderPlanBody} would
 * write. Hand edits of a generated section are reported by `plan_validate`
 * (stage 7); a hand-edited `## Заметки` is not a divergence.
 */
export function bodyMatchesFrontmatter(document: {
  frontmatter: Record<string, unknown>;
  body: string;
}): boolean {
  return (
    normalizedBody(document.body) ===
    normalizedBody(renderPlanBody(document.frontmatter, document.body))
  );
}

/** Keys whose links are mirrored into the body, for the later diff report. */
export function linkedTargets(frontmatter: Record<string, unknown>): string[] {
  const targets = [
    ...asRecords(frontmatter.influences)
      .map((entry) => (typeof entry.target === "string" ? entry.target : ""))
      .filter((value) => value.length > 0),
    ...asLinks(frontmatter.blocked_by),
    ...asLinks(frontmatter.blocks),
    ...asLinks(frontmatter.children),
    ...(typeof frontmatter.parent === "string" ? [frontmatter.parent] : []),
  ];
  return [...new Set(targets.map(linkLabel))];
}
