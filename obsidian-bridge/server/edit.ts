import * as fs from "node:fs";
import * as path from "node:path";
import { findFragment, type FragmentSuggestion } from "./fragment-match";
import {
  DEFAULT_DOCUMENT_EXTENSIONS,
  MAX_NOTE_BYTES,
  extensionRefusal,
  isAllowedDocumentPath,
  resolveInsideVault,
} from "./vault";

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
 * - the file must carry an allowed extension (`.md` by default) and must not be
 *   a dot entry, so a project checkout's `.env` or `.git/config` is not a note;
 * - the refusal is explicit about the boundary: this tool writes **anywhere
 *   below** the configured directory and **nowhere above it**, and it says so in
 *   words an agent cannot mistake for a retry hint;
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
  /** The match came from the whitespace-insensitive comparison. */
  ignoreWhitespace: boolean;
}

/**
 * A refused edit. `suggestions` is the actionable part: the closest text from
 * this note (or the places an ambiguous fragment occurs), with line numbers, so
 * the caller can correct the fragment without re-reading the file (0.10.11).
 */
export interface EditFailure {
  error: string;
  /** Number of exact occurrences, set for an ambiguous fragment. */
  occurrences?: number;
  suggestions?: FragmentSuggestion[];
}

/**
 * Synchronous pause without a dependency or an event-loop turn.
 *
 * The edit path is deliberately synchronous (read, verify, replace in one go), so
 * the retry below cannot await.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Renames `temp` over `target`, retrying the transient lock errors a Windows
 * editor, sync client or antivirus produces (0.10.11 port audit). On POSIX the
 * first attempt succeeds; anything that is not a lock error is rethrown at once.
 */
function replaceFile(temp: string, target: string, attempts: number = 5): void {
  let last: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(temp, target);
      return;
    } catch (cause) {
      last = cause;
      const code = (cause as NodeJS.ErrnoException).code ?? "";
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      sleepSync(20 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
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
  /** Extensions the tool accepts (`.md` by default). */
  allowedExtensions?: string;
  /** Compare after collapsing whitespace runs (0.10.11). Default off. */
  ignoreWhitespace?: boolean;
}): EditOutcome | EditFailure {
  const relPath = input.relPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (relPath.length === 0) return { error: "path is required." };
  const allowed = input.allowedExtensions ?? DEFAULT_DOCUMENT_EXTENSIONS;
  // Boundary first, format second: a path above the directory is an escape, not
  // a file of the wrong type, and the refusal has to say so.
  const absolute = resolveInsideVault(input.root, relPath);
  if (!absolute) {
    return {
      error:
        `Refused: '${input.relPath}' is not inside the configured Obsidian directory. This plugin ` +
        "writes only inside that one directory, at any depth below it. Everything above it — a " +
        "sibling folder, the home directory, /etc, another project — is out of bounds and is not " +
        "something you need to write: do not retry with '..', an absolute path, a symlink or a " +
        "file tool (`shell`, `write`, `patch`), and do not look for another copy of the note. If " +
        "the user means a note outside the configured directory, say so and ask whether they " +
        "want it moved or added there.",
    };
  }
  if (!isAllowedDocumentPath(relPath, allowed)) {
    return { error: extensionRefusal(relPath, allowed) };
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
      return {
        error:
          `Refused: '${relPath}' is a symlink that resolves outside the configured Obsidian ` +
          "directory, so writing it would write outside the plugin's boundary. That boundary is " +
          "the whole of what this plugin may touch: do not try the resolved path, a parent path " +
          "or a shell/editor instead. Ask the user to move the target inside the configured " +
          "directory if it belongs to the knowledge base.",
      };
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

  // Exact match first, then the note's line endings, then (opt-in) whitespace.
  // Every step keeps "exactly once": `fragment-match.ts` owns the rules, and a
  // refusal carries the closest text so the caller can fix its fragment.
  const found = findFragment(text, oldText, { ignoreWhitespace: input.ignoreWhitespace === true });
  if (found.status === "ambiguous") {
    return {
      error:
        `The fragment occurs ${found.occurrences} times in '${relPath}'. Include surrounding context ` +
        "so it matches exactly once.",
      occurrences: found.occurrences,
      suggestions: found.suggestions,
    };
  }
  if (found.status === "not-found") {
    const hint =
      input.ignoreWhitespace === true
        ? "Whitespace was already ignored for this match, so the text differs in more than spacing."
        : "Pass the exact text, including whitespace and line breaks, set ignore_whitespace: true " +
          "for a re-wrapped fragment, or read the note first.";
    return {
      error: `The fragment was not found in '${relPath}'. ${hint} Closest text is in suggestions.`,
      suggestions: found.suggestions,
    };
  }

  const normalizedLineEndings = found.normalizedLineEndings;
  const replacement = normalizedLineEndings ? input.newText.replace(/\r?\n/g, "\r\n") : input.newText;
  const next = `${text.slice(0, found.start)}${replacement}${text.slice(found.end)}`;
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
    replaceFile(temp, absolute);
  } catch (cause) {
    fs.rmSync(temp, { force: true });
    const code = (cause as NodeJS.ErrnoException).code ?? "";
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      return {
        error:
          `Could not replace '${relPath}': the file is locked by another program ` +
          "(Obsidian, a sync client, or antivirus). Close the note and retry.",
      };
    }
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  return {
    path: relPath,
    bytesBefore: stat.size,
    bytesAfter,
    charsBefore: text.length,
    charsAfter: next.length,
    normalizedLineEndings,
    ignoreWhitespace: found.ignoreWhitespace,
  };
}
