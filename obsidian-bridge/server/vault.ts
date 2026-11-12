import * as fs from "node:fs";
import * as path from "node:path";
import { parseNote, type ParsedNote } from "./parse";

/**
 * Vault filesystem helpers: path validation, bounded walking with the
 * include/exclude rules, and path-safe reads.
 *
 * Every read goes through `resolveInsideVault`, so a tool argument can never
 * escape the vault or reach Obsidian's configuration directory.
 */

/** Files larger than this are skipped: they are attachments, not notes. */
export const MAX_NOTE_BYTES = 4 * 1024 * 1024;

export interface VaultCheck {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isObsidianVault: boolean;
  markdownFiles: number;
  capped: boolean;
  sample: string[];
  error: string | null;
}

/** Splits a comma-separated setting into trimmed, non-empty entries. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Converts the small glob dialect used by the settings (`*`, `**`) to a regexp. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/** True when a vault-relative path matches any exclude glob. */
export function isExcluded(relPath: string, excludeGlobs: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  for (const glob of splitList(excludeGlobs)) {
    const candidate = glob.replace(/\\/g, "/");
    if (candidate.endsWith("/**")) {
      const prefix = candidate.slice(0, -3);
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
      continue;
    }
    if (globToRegExp(candidate).test(normalized)) return true;
  }
  return false;
}

/** True when a vault-relative path is inside one of the include folders. */
export function isIncluded(relPath: string, includeFolders: string): boolean {
  const folders = splitList(includeFolders).map((folder) =>
    folder.replace(/\\/g, "/").replace(/\/+$/, ""),
  );
  if (folders.length === 0) return true;
  const normalized = relPath.replace(/\\/g, "/");
  return folders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
}

export function isMarkdownPath(relPath: string): boolean {
  return /\.md$/i.test(relPath);
}

/**
 * Walks the vault and returns vault-relative Markdown paths that pass the
 * include/exclude rules. Bounded by `limit` so a misconfigured path cannot
 * hang a tool call.
 */
export function walkMarkdown(
  root: string,
  options: { includeFolders: string; excludeGlobs: string; limit?: number },
): { files: string[]; capped: boolean } {
  const files: string[] = [];
  const limit = options.limit ?? 200_000;
  const stack: string[] = [""];
  let capped = false;

  while (stack.length > 0) {
    const relDir = stack.pop() ?? "";
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isExcluded(`${rel}/`, options.excludeGlobs)) continue;
        stack.push(rel);
        continue;
      }
      if (!entry.isFile() || !isMarkdownPath(rel)) continue;
      if (!isIncluded(rel, options.includeFolders)) continue;
      if (isExcluded(rel, options.excludeGlobs)) continue;
      files.push(rel);
      if (files.length >= limit) {
        capped = true;
        return { files, capped };
      }
    }
  }

  files.sort();
  return { files, capped };
}

/** Validates a candidate vault path and reports what was found. */
export function checkVault(candidate: string, sampleLimit = 8): VaultCheck {
  const result: VaultCheck = {
    path: candidate,
    exists: false,
    isDirectory: false,
    isObsidianVault: false,
    markdownFiles: 0,
    capped: false,
    sample: [],
    error: null,
  };
  const resolved = path.resolve(candidate);
  try {
    const stat = fs.statSync(resolved);
    result.exists = true;
    result.isDirectory = stat.isDirectory();
    if (!result.isDirectory) {
      result.error = "The path is a file, not a directory.";
      return result;
    }
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause);
    return result;
  }

  try {
    result.isObsidianVault = fs
      .statSync(path.join(resolved, ".obsidian"))
      .isDirectory();
  } catch {
    result.isObsidianVault = false;
  }

  const walk = walkMarkdown(resolved, {
    includeFolders: "",
    excludeGlobs: ".obsidian/**, .trash/**, .git/**, .smart-env/**",
    limit: 5_000,
  });
  result.markdownFiles = walk.files.length;
  result.capped = walk.capped;
  result.sample = walk.files.slice(0, sampleLimit);
  return result;
}

/** Resolves a vault-relative path, refusing anything outside the vault. */
export function resolveInsideVault(root: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (normalized.length === 0) return null;
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, normalized);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  if (!target.startsWith(prefix)) return null;
  const rel = path.relative(rootResolved, target).replace(/\\/g, "/");
  if (rel === ".obsidian" || rel.startsWith(".obsidian/")) return null;
  return target;
}

export interface ReadNoteResult {
  path: string;
  text: string;
  parsed: ParsedNote;
  truncated: boolean;
}

/**
 * Reads and parses a vault note. `heading` selects one section (case-insensitive
 * match on the heading text) instead of the whole note.
 */
export function readVaultNote(
  root: string,
  relPath: string,
  options: { heading?: string; maxBytes?: number } = {},
): ReadNoteResult | { error: string } {
  const absolute = resolveInsideVault(root, relPath);
  if (!absolute) return { error: `Path '${relPath}' is outside the vault.` };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { error: `Note '${relPath}' does not exist.` };
  }
  if (!stat.isFile()) return { error: `'${relPath}' is not a file.` };
  const maxBytes = options.maxBytes ?? MAX_NOTE_BYTES;
  const truncated = stat.size > maxBytes;
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf-8");
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
  const parsed = parseNote(text.slice(0, maxBytes), relPath);

  const heading = options.heading?.trim();
  if (heading && heading.length > 0) {
    const section = sectionOf(parsed.body, heading);
    if (section === null) return { error: `Heading '${heading}' not found in '${relPath}'.` };
    return { path: relPath, text: section, parsed, truncated };
  }
  return { path: relPath, text: parsed.body, parsed, truncated };
}

/** Extracts the content under `heading` (including nested subsections). */
export function sectionOf(body: string, heading: string): string | null {
  const wanted = heading.trim().toLowerCase();
  const lines = body.split("\n");
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[index]);
    if (!match) continue;
    if (match[2].trim().toLowerCase() === wanted) {
      start = index;
      level = match[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index]);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}
