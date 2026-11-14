import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_NOTE_BYTES, resolveInsideVault } from "./vault";

/**
 * Exact-fragment edit of an existing note, addressed by its vault path.
 *
 * The append-only writers in `dirs.ts` are confined to the inbox/out/raw roles.
 * A note the user filed anywhere else in the vault (or in a folder without a
 * role) could be read but never changed. This is the deliberate counterpart:
 *
 * - the path is resolved by `resolveInsideVault`, so `..`, absolute paths and
 *   the vault's own `.obsidian` directory are refused, and a symlink that leads
 *   outside the directory is refused too (`realpath` both sides);
 * - the note must already exist: this tool never creates anything;
 * - the fragment must occur **exactly once**; zero or several occurrences are an
 *   error rather than a guess, so a rewrite can never hit an unintended place;
 * - everything outside the fragment is written back byte for byte, so other
 *   sections, frontmatter and unrelated whitespace survive;
 * - the file is replaced atomically (temp file + rename) and only when it did not
 *   change between reading and writing, so a concurrent Obsidian save is not
 *   silently overwritten.
 */
export interface EditOutcome {
  path: string;
  bytesBefore: number;
  bytesAfter: number;
  charsBefore: number;
  charsAfter: number;
  /** The note uses CRLF and the fragment was matched after converting its line breaks. */
  normalizedLineEndings: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function insideRoot(realRoot: string, realTarget: string): boolean {
  const prefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  return realTarget === realRoot || realTarget.startsWith(prefix);
}

export function replaceInNote(input: {
  root: string;
  relPath: string;
  oldText: string;
  newText: string;
  maxWriteChars: number;
}): EditOutcome | { error: string } {
  const relPath = input.relPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (relPath.length === 0) return { error: "path is required." };
  const absolute = resolveInsideVault(input.root, relPath);
  if (!absolute) {
    return {
      error: `'${input.relPath}' is outside the configured directory (or inside .obsidian), so it cannot be edited.`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return {
      error: `Note '${relPath}' does not exist. This tool edits existing notes only; use a write tool to create one.`,
    };
  }
  if (!stat.isFile()) return { error: `'${relPath}' is not a file.` };
  if (stat.size > MAX_NOTE_BYTES) {
    return {
      error: `'${relPath}' is ${stat.size} bytes; the edit limit is ${MAX_NOTE_BYTES}. Split the note first.`,
    };
  }

  const oldText = input.oldText;
  if (oldText.length === 0) {
    return { error: "old_text is required: pass the exact fragment to replace." };
  }
  if (oldText.length > input.maxWriteChars) {
    return {
      error: `old_text is ${oldText.length} characters; the configured limit is ${input.maxWriteChars}.`,
    };
  }
  if (input.newText.length > input.maxWriteChars) {
    return {
      error: `new_text is ${input.newText.length} characters; the configured limit is ${input.maxWriteChars}.`,
    };
  }
  if (oldText === input.newText) {
    return { error: "old_text and new_text are identical; nothing to replace." };
  }

  // A symlinked note that points outside the directory must not be writable.
  try {
    const realRoot = fs.realpathSync(input.root);
    const realTarget = fs.realpathSync(absolute);
    if (!insideRoot(realRoot, realTarget)) {
      return { error: `'${relPath}' resolves outside the configured directory through a symlink.` };
    }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf-8");
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  let needle = oldText;
  let normalizedLineEndings = false;
  let count = countOccurrences(text, needle);
  if (count === 0 && text.includes("\r\n")) {
    // Obsidian on Windows writes CRLF; an agent usually passes LF.
    const crlf = oldText.replace(/\r?\n/g, "\r\n");
    const crlfCount = countOccurrences(text, crlf);
    if (crlfCount > 0) {
      needle = crlf;
      count = crlfCount;
      normalizedLineEndings = true;
    }
  }
  if (count === 0) {
    return {
      error:
        `The fragment was not found in '${relPath}'. Pass the exact text, including ` +
        "whitespace and line breaks, or read the note first.",
    };
  }
  if (count > 1) {
    return {
      error:
        `The fragment occurs ${count} times in '${relPath}'. Include surrounding context ` +
        "so it matches exactly once.",
    };
  }

  const replacement = normalizedLineEndings ? input.newText.replace(/\r?\n/g, "\r\n") : input.newText;
  const start = text.indexOf(needle);
  const next = `${text.slice(0, start)}${replacement}${text.slice(start + needle.length)}`;
  const bytesAfter = Buffer.byteLength(next);
  if (bytesAfter > MAX_NOTE_BYTES) {
    return {
      error: `The edited note would be ${bytesAfter} bytes; the limit is ${MAX_NOTE_BYTES}.`,
    };
  }

  const temp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    // Re-check before replacing: Obsidian may have saved the note meanwhile.
    const current = fs.statSync(absolute);
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
      return {
        error: `'${relPath}' changed on disk while it was being edited. Read it again and retry.`,
      };
    }
    fs.writeFileSync(temp, next, { encoding: "utf-8", mode: stat.mode & 0o777 });
    fs.renameSync(temp, absolute);
  } catch (cause) {
    fs.rmSync(temp, { force: true });
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  return {
    path: relPath,
    bytesBefore: stat.size,
    bytesAfter,
    charsBefore: text.length,
    charsAfter: next.length,
    normalizedLineEndings,
  };
}
