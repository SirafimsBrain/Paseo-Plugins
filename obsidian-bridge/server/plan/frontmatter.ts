import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Frontmatter is the only machine-readable layer of a plan file.
 *
 * Reading and writing go through this module and nowhere else, so two rules
 * hold everywhere:
 *
 * 1. **Key order is preserved.** The document is parsed into a plain object and
 *    re-serialized from it; JavaScript keeps insertion order, so the file a
 *    reader sees after a one-field change has the same key order as before.
 *    New files use the canonical order (`orderPlanKeys`).
 * 2. **A file that does not parse is never rewritten.** `parsePlanDocument`
 *    returns an error with the YAML message; a writer receiving that error must
 *    report it and stop, not "repair" the file by overwriting it.
 *
 * YAML is parsed with the library's default (core) schema: timestamps stay the
 * strings the author wrote, `null` stays `null`, and duplicate keys are an
 * error rather than a silent last-one-wins.
 */

export interface PlanDocument {
  /** Parsed frontmatter, in document order. */
  frontmatter: Record<string, unknown>;
  /** Everything after the closing `---`, without the leading blank line. */
  body: string;
}

export type PlanDocumentResult = { document: PlanDocument } | { error: string };

const FRONTMATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

/** Parses a plan file; the error text is meant for an agent to act on. */
export function parsePlanDocument(text: string): PlanDocumentResult {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = FRONTMATTER.exec(normalized);
  if (!match) {
    return {
      error:
        "The file does not start with YAML frontmatter (`---` on the first line, `---` after " +
        "the last key). A planning file without frontmatter is not a plan; nothing was changed.",
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (cause) {
    return {
      error: `The frontmatter is not valid YAML: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Fix it by hand; the tools do not overwrite a file they cannot read.`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      error:
        "The frontmatter must be a YAML mapping of keys to values, not a list or a scalar. " +
        "Nothing was changed.",
    };
  }

  return {
    document: {
      frontmatter: parsed as Record<string, unknown>,
      body: normalized.slice(match[0].length).replace(/^\n+/, "").replace(/\s+$/, ""),
    },
  };
}

/** Serializes a document back to disk form, keeping the given key order. */
export function serializePlanDocument(document: PlanDocument): string {
  const yamlText = stringifyYaml(document.frontmatter, {
    lineWidth: 0,
    // Obsidian shows the file as written: a long description stays readable
    // instead of collapsing into one escaped line.
    blockQuote: "literal",
  }).trimEnd();
  const body = document.body.replace(/\r\n/g, "\n").trim();
  return `---\n${yamlText}\n---\n\n${body}\n`;
}

/**
 * Returns the document with one key replaced, keeping every other key (and the
 * order) untouched. `undefined` deletes the key.
 */
export function withKey(
  document: PlanDocument,
  key: string,
  value: unknown,
): PlanDocument {
  const frontmatter = { ...document.frontmatter };
  if (value === undefined) delete frontmatter[key];
  else frontmatter[key] = value;
  return { ...document, frontmatter };
}

/** Positive integer from frontmatter, or `null` when it is not one. */
export function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Non-empty string from frontmatter, or `null`. */
export function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
